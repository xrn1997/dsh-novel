import { BROWSER_TTS_ENGINE_ID, TTS_DEFAULTS, TTS_RATE, TTS_VOLUME } from '../../shared/wire.js'
import type {
  ChapterEntry, ListenState, ShelfEntry, SynthesisReceipt, SynthesisRequest,
} from '../../shared/wire.js'
import type { ReaderRevealTarget } from '../reader-session.js'
import { createStore } from '../store.js'
import type { Store } from '../store.js'
import type {
  BranchCapabilities, BranchHost, BranchMode, ListenBranches, OutputHandlers, PlaybackBranch,
} from './output-contract.js'
import { estimateParagraphIndex, paragraphRatio } from '../progress.js'
import { readingProbeNow } from './reading-position.js'

/**
 * 听书播放会话（字节型 + 浏览器直出型）：状态机与可变现场全在这里，外界只经 `ListenPlatform`
 * 平台缝进来（网络、书架、落盘、合成、时钟、宿主事件、出声输出都是注入的）。生产外观住
 * `client/tts/player.ts`；两支适配器住 `bytes-output.ts` / `direct-output.ts`，与会话之间只有
 * `output-contract.ts` 的输出契约。
 *
 * 位置单轨：`ShelfProgress`（章 + 章内比例）是阅读与听书共用的消费位置，同一落盘节拍里
 * `saveProgress` 写章 + 比例、`saveListen` 写听书细节（段号 + 播放参数）。listen 不替代
 * progress：书架、最近阅读排序与阅读器恢复点都读 progress。「回阅读器」走 restore（只站定不写）。
 *
 * 播放单元 = 章正文投影切出的段，与导出 / AI 读数同一份投影；两种模式共用状态机、位置落盘
 * 与失败径，「这一段怎么出声」的策略住 `playback-branches.ts` 的两条分支。
 *
 * 失败半径 = 那一段：单段失败只跳过，连续 `TTS_MAX_CONSECUTIVE_FAILURES` 段失败才暂停并公布
 * 停因（`halt`）；任何真开口的段清零连败。连败是整个会话的读数，换章不清零。
 *
 * 本会话不持可见文案：错误经 `TtsPlayerError` 的 `code` 交给调用方取词典（文案归 `client/copy`）。
 */

/** 连续失败到这条线就暂停：留给用户一个「引擎/网络坏了」的可见停顿，而不是静默跳过整章。 */
export const TTS_MAX_CONSECUTIVE_FAILURES = 5

/** 起播失败码：码是契约，译文由调用方按 code 映射。
 *  `TTS_NO_VOICES` = 直出源等过语音表仍无可用音色；`TTS_CHAPTER_LOAD` = 手动跳章 / 跳段跨章时
 *  章正文拉不到（自动推进的同种失败由 `finishChapter` 收口成暂停）。 */
export type TtsPlayerErrorCode =
  | 'TTS_CHAPTERS_EMPTY'
  | 'TTS_NO_VOICES'
  | 'TTS_CHAPTER_LOAD'

/** 跳章载入结局：`moved` 也含空章；失败与「被更新的导航作废」不许折成同一个值。 */
type MoveOutcome = 'moved' | 'out-of-range' | 'superseded' | 'failed'

/** 起播的正常数据面失败（目录为空等）：`message` 只放码本身，绝不承载界面人话。 */
export class TtsPlayerError extends Error {
  readonly code: TtsPlayerErrorCode

  constructor(code: TtsPlayerErrorCode) {
    super(code)
    this.name = new.target.name
    this.code = code
  }
}

/** 位置落盘防抖窗口（与阅读进度同一档）；pause/stop/pagehide 立即 flush。 */
const POSITION_SAVE_DEBOUNCE_MS = 2000

/** 语速滑杆「按新参数重取当前段」的防抖窗口：状态与回执清理即时，重取等手停下再发——
 *  原生 range 逐档 change，逐档重合成会把一次拖动打成十几次上游请求。导出给测试引。 */
export const PARAMS_RESTART_DEBOUNCE_MS = 250

/** 同章预取窗口：当前段之后 2 段。 */
const PREFETCH_AHEAD = 2

/** 距章尾不足这么多段 = 「进入末 3 段」，开始预取下一章开头。 */
const PREFETCH_LAST_PARAGRAPHS = 3

/** 会话停在上屏的原因（播放层独知的成品事实）：表面读它，不拿计数与阈值对比；
 *  阈值判据只在 `segmentFailed` 一处。 */
export interface ListenHalt {
  reason: 'consecutive-failures'
  failures: number
}

export interface TtsPlayerState {
  active: boolean
  bookKey: string | null
  sourceId: string | null
  title: string
  chapterIndex: number
  paragraphCount: number
  paragraphIndex: number
  /** 当前播放单元的原文：视图的「段读数 + 预览」直接读它，界面不在第二处重算切分。 */
  paragraphText: string
  playing: boolean
  engineId: string
  voice: string | null
  rate: number
  volume: number
  timerEndAt: number | null
  /** 定时的档位：`timerEndAt` 只答「什么时候到」；界面重挂载要摆回原档位（会话跨面板卸载存活，`ADR-0072`）。 */
  timerChoice: number | 'chapter' | null
  mode: 'bytes' | 'direct'
  /** 这段出声在准备中（合成在途 / 等平台开口）：与 `playing` 分开，让「按下去是暂停」在加载窗口也成立。
   *  字节型到「已交给介质」为止，直出型到平台真开口为止——差别住各自分支。 */
  loading: boolean
  /** 会话为什么停在上屏：null = 没因失败停。控制面据此给那行读数；真开口后清零。 */
  halt: ListenHalt | null
  consecutiveFailures: number
  segmentProgress: boolean
  voiceTable: 'platform' | 'engine'
  chapterNames: string[]
}

/** 当前播放单元的出声进度（秒）：字节型由活槽推进，直出型恒 `{0, 0}`。
 *  **独立于主状态一只 store**：timeupdate 约每秒四发，不能让整棵阅读器跟着每帧重渲。 */
export interface TtsProgressState { position: number; duration: number }

/** 引擎标识 → 出声模式：直出型只有浏览器本地语音一条，其余都归字节型。 */
function modeOf(engineId: string): 'bytes' | 'direct' {
  return engineId === BROWSER_TTS_ENGINE_ID ? 'direct' : 'bytes'
}

function initialState(capabilities: BranchCapabilities): TtsPlayerState {
  return {
    active: false,
    bookKey: null,
    sourceId: null,
    title: '',
    chapterIndex: 0,
    paragraphCount: 0,
    paragraphIndex: 0,
    paragraphText: '',
    playing: false,
    engineId: TTS_DEFAULTS.engineId,
    voice: null,
    rate: TTS_DEFAULTS.rate,
    volume: TTS_DEFAULTS.volume,
    timerEndAt: null,
    timerChoice: null,
    mode: modeOf(TTS_DEFAULTS.engineId),
    loading: false,
    halt: null,
    consecutiveFailures: 0,
    segmentProgress: capabilities.segmentProgress,
    voiceTable: capabilities.voiceTable,
    chapterNames: [],
  }
}

export interface StartListeningInput {
  sourceId: string
  bookKey: string
  title: string
  /** 显式起播章段（选区 / 调用方已解析的探针）；`resume: 'archive'` 时只是存档缺席的兜底。 */
  chapterIndex?: number
  paragraphIndex?: number
  /** 没有显式章段 / 探针时的章兜底（阅读器当前章）；排在书架 progress 之前。 */
  fallbackChapter?: number
  /** 没有显式段号时，允许用本书书架 progress 的比例估算段号（只认同一章）。 */
  fallbackToShelfParagraph?: boolean
  /**
   * 位置来源：`'archive'` = 有服务端 listen 存档就从存档章段续听（缺席才用传入位置）；
   * `'position'`（缺省）= 用传入位置——阅读器 pill 跟随眼前位置，旧存档不把进度拽回去。
   */
  resume?: 'archive' | 'position'
  engineId?: string
  voice?: string | null
  rate?: number
  volume?: number
}

/** 「从阅读位置起播」的输入：位置来源链归会话，调用方只交书身份与可选兜底。 */
export interface StartFromReadingPositionInput {
  sourceId: string
  bookKey: string
  title: string
  fallbackChapter?: number
  /** 显式目标（选区）：给了就不再读探针。 */
  target?: { chapterIndex: number; paragraphIndex: number }
}

/** 回退链用的活动缺省：served 值经 `setTtsDefaults` 推进来，内容在 wire 的 `TTS_DEFAULTS`。 */
export interface TtsDefaults {
  engineId: string
  rate: number
  volume: number
  prefetchParagraphs: number
}

// ── 平台缝（构造注入；会话代码不自建任何环境）────────────────────────────────

/** 防抖件的形状（与 `client/util.ts` 的 `debounce` 一致）：生产平台直接用它，测试平台用
 *  注入的时钟自己搭一盘——落盘窗口因此不等墙钟。 */
export type Debounced<A extends unknown[]> = ((...args: A) => void) & { flush(): void; cancel(): void }



/** 会话的全部外界接触面：内容、书架、落盘、合成、出声输出、直出能力读数、时钟与宿主面。 */
export interface ListenPlatform {
  fetchChapters(sourceId: string, bookKey: string): Promise<ChapterEntry[]>
  fetchUnits(sourceId: string, bookKey: string, index: number): Promise<string[]>
  shelfEntryOf(bookKey: string): Promise<ShelfEntry | null>
  /** 听书细节轨（段号 + 播放参数）：只写 `ShelfBook.listen`。 */
  saveListen(bookKey: string, listen: ListenState): Promise<void>
  /** 共用的消费位置（章 + 章内比例，写 `ShelfBook.progress`）：与 `saveListen` 同一节拍，各自尽力而为。 */
  saveProgress(bookKey: string, chapterIndex: number, offsetRatio: number): Promise<void>
  /** 本书阅读器子树是否在场：在场时 progress 归阅读会话（`ADR-0093`），播放层只写 listen。 */
  readerPresent?(bookKey: string): boolean
  /** opts.signal = 这一发合成所属的取消位：跳段只落当前段那一只（同章预取照跑），
   *  停止 / 换书 / 换参数落整趟。 */
  synthesize(req: SynthesisRequest, opts?: { signal?: AbortSignal }): Promise<SynthesisReceipt>
  /** 两条出声分支（策略面）：会话只问分支怎么起这一段 / 能提供什么 / 谁该闭嘴。 */
  branches: ListenBranches
  now(): number
  /** 排一个延时，返回取消。定时、开口兜底都走它——会话里不出现裸 `setTimeout`。 */
  after(ms: number, cb: () => void): () => void
  /** 关页前 flush 位置，返回解除。没有宿主面时给一个空解除。 */
  watchPageHide(cb: () => void): () => void
  debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): Debounced<A>
}

// ── 会话状态机 ───────────────────────────────────────────────────────────────

interface ReceiptEntry { paramsKey: string; key: string; playbackRate: number }

type TimerState = { kind: 'at'; at: number; cancel: () => void } | { kind: 'chapter' }

/** 一次听书会话的瞬时现场：换书/停止即整体作废（store 里的读数是另一份，互不回写）。 */
interface PlayerRun {
  sourceId: string
  bookKey: string
  title: string
  chapters: ChapterEntry[]
  units: string[]
  receipts: Map<number, ReceiptEntry>
  prefetched: Set<number>
  /** 已因「回执在、字节读不出」重合成过一次的段号（每段一次） */
  retried: Set<number>
  nextPrefetched: Set<number>
  /** 章节载入代际：迟到的正文只服务它出发时的那一趟 */
  loadSeq: number
  /** 播放代际：pause/参数变更/跳段都会抬它，迟到的合成结果据此丢弃 */
  playSeq: number
  timer: TimerState | null
  /** 本趟在途请求共用的取消位：作废时整只换掉。预取链挂在**这一只**上，
   *  换参数 / 换章 / 停止都该把整章的暖缓存一起作废。 */
  abort: AbortController
  /** 当前段自己的取消位：跳段 / 章内滑杆只作废「没人再听的那一发」，同章预取不受牵连。 */
  segAbort: AbortController
  /** 字节型：当前段合成请求的 playSeq 身份（无在途 = null）；只认 `loading` 会把章正文加载误当成合成在途。 */
  synthToken: number | null
}

/** 「回阅读器」的交接现场（一次性、按书键）：取走即空，两键不匹配既不消费也不应用。 */
interface PendingRelocation {
  sourceId: string
  bookKey: string
  target: ReaderRevealTarget
}

/** 听书会话：`ListenPlatform` 构造注入，全部可变现场都是实例字段——多实例互不串场，
 *  测试造一副假平台就能整只驱动。 */
export class ListenSession {
  /** 上屏读数的主 store：视图经 `player.ts` 的 `ttsPlayer` 订阅。 */
  readonly state: Store<TtsPlayerState>
  readonly progress: Store<TtsProgressState>

  private readonly platform: ListenPlatform
  private current: PlayerRun | null = null
  /** 起始代际：并发 `startListening` 只有最后起飞的那一趟算数 */
  private runSeq = 0
  private unwatchPageHide: (() => void) | null = null
  private readonly positionSave: Debounced<[]>
  /** 按新参数重取当前段的防抖（语速滑杆逐档触发时只发最后一发；暂停/停止/跳转都取消） */
  private readonly paramsRestart: Debounced<[]>
  private defaults: TtsDefaults = { ...TTS_DEFAULTS }
  private pendingRelocation: PendingRelocation | null = null
  /** 章正文（段域）载入在途：`paragraphIndex` / `paragraphCount` 还是上一章的读数，跳段与滑杆照它走会念错章。
   *  它是协调事实（不是渲染读数），不进 store；与 `loading` 分开：本段合成在途时跳段是安全的。 */
  private chapterLoading = false

  constructor(platform: ListenPlatform) {
    this.platform = platform
    const branch = platform.branches.branch(modeOf(TTS_DEFAULTS.engineId))
    this.state = createStore<TtsPlayerState>(initialState(branch.capabilities))
    this.progress = createStore<TtsProgressState>({ position: 0, duration: 0 })
    this.positionSave = platform.debounce(() => { void this.writePosition() }, POSITION_SAVE_DEBOUNCE_MS)
    this.paramsRestart = platform.debounce(() => { this.restartForParams() }, PARAMS_RESTART_DEBOUNCE_MS)
  }

  /** 当前模式那条分支的策略实现（唯一一次模式分流：状态机只负责说「现在走哪条」）。 */
  private branchOf(mode: BranchMode): PlaybackBranch {
    return this.platform.branches.branch(mode)
  }

  private capabilitiesOf(mode: BranchMode): BranchCapabilities {
    return this.branchOf(mode).capabilities
  }

  // ── 起播 / 换书 ─────────────────────────────────────────────────────────────

/**
 * 开始听一本书：拉目录 → clamp 存档 → 拉正文切段 → 起播指定段。已在放另一本时**取到数据之后**
 * 才停旧会话（flush 旧书位置）；失败会 reject，单段合成失败不会（走跳过径）。
 */
  async startListening(p: StartListeningInput): Promise<void> {
    await this.startSession(p)
  }

  private async startSession(p: StartListeningInput): Promise<void> {
    // 取数在停旧会话**之前**：旧会话继续放着，一次网络抖动不该放大成「声音全没」。
    const gen = ++this.runSeq
    this.ensurePagehide()

    const [chapters, entry] = await Promise.all([
      this.platform.fetchChapters(p.sourceId, p.bookKey),
      this.platform.shelfEntryOf(p.bookKey),
    ])
    if (gen !== this.runSeq) return
    if (chapters.length === 0) throw new TtsPlayerError('TTS_CHAPTERS_EMPTY')
    const stored = entry?.listen ?? null
    const archive = p.resume === 'archive' ? stored : null
    const chapterIndex = clampIndex(
      archive?.chapterIndex ?? p.chapterIndex ?? p.fallbackChapter ?? entry?.progress.chapterIndex ?? 0,
      chapters.length - 1,
    )
    const units = await this.platform.fetchUnits(p.sourceId, p.bookKey, chapterIndex)
    if (gen !== this.runSeq) return
    const shelfParagraph = p.fallbackToShelfParagraph === true
      && entry !== null && entry.progress.chapterIndex === chapterIndex
      ? estimateParagraphIndex(entry.progress.offsetRatio, units.length)
      : 0
    const paragraphIndex = units.length === 0
      ? 0
      : clampIndex(archive?.paragraphIndex ?? p.paragraphIndex ?? shelfParagraph, units.length - 1)

    const engineId = p.engineId ?? stored?.engineId ?? this.defaults.engineId
    // 音色 id 只对存它的那个引擎有效：显式换了引擎又没给音色时，不把存档里的旧 id 带过去。
    const voice = p.voice !== undefined
      ? p.voice
      : (stored !== null && (p.engineId === undefined || p.engineId === stored.engineId)
          ? stored.voice ?? null
          : null)
    const rate = p.rate ?? stored?.rate ?? this.defaults.rate
    const volume = p.volume ?? stored?.volume ?? this.defaults.volume
    const mode = modeOf(engineId)
    const branch = this.branchOf(mode)
    // 源级闸门（直出型等语音表，字节型同步可过）：等不到才报「设备没有语音」；在停旧会话之前。
    const gate = branch.ready()
    if (gate !== true) {
      const voicesReady = await gate
      // 等待窗口里有更新的起播 / 停止：这一发已作废，不许拿设备事实抛假错误，也不许停新会话。
      if (gen !== this.runSeq) return
      if (!voicesReady) throw new TtsPlayerError('TTS_NO_VOICES')
    }
    // 数据到手才停旧会话：stop 会 flush 旧书位置并抬 `runSeq`，此后没有可被打断的 await。
    if (this.state.get().active) this.stopListening()
    this.paramsRestart.cancel()

    const run: PlayerRun = {
      sourceId: p.sourceId,
      bookKey: p.bookKey,
      title: p.title,
      chapters,
      units,
      receipts: new Map(),
      retried: new Set(),
      prefetched: new Set(),
      nextPrefetched: new Set(),
      loadSeq: 0,
      playSeq: 0,
      timer: null,
      synthToken: null,
      abort: new AbortController(),
      segAbort: new AbortController(),
    }
    this.current = run
    this.chapterLoading = false
    this.state.set({
      active: true,
      bookKey: p.bookKey,
      sourceId: p.sourceId,
      title: p.title,
      chapterIndex,
      paragraphCount: units.length,
      paragraphIndex,
      paragraphText: units[paragraphIndex] ?? '',
      playing: false,
      engineId,
      voice,
      rate,
      volume,
      timerEndAt: null,
      timerChoice: null,
      mode,
      loading: units.length > 0,
      halt: null,
      consecutiveFailures: 0,
      segmentProgress: branch.capabilities.segmentProgress,
      voiceTable: branch.capabilities.voiceTable,
      chapterNames: chapters.map((chapter_) => chapter_.name),
    })
    this.schedulePositionSave()
    if (units.length > 0) await this.playCurrent(run)
    else this.state.set({ loading: false })
  }

  /** 停止听书：flush 当前位置、清定时、复位播放面（用户选的引擎/音色/语速/音量留着）。 */
  stopListening(): void {
    const st = this.state.get()
    if (!st.active && this.current === null) return
    this.runSeq += 1
    this.paramsRestart.cancel()
    this.positionSave.flush()
    const run = this.current
    if (run !== null) {
      run.playSeq += 1
      this.clearRunTimer(run)
      this.cancelInFlight(run)
    }
    this.current = null
    this.chapterLoading = false
    this.platform.branches.stopAll()
    this.progress.set({ position: 0, duration: 0 })
    const mode = modeOf(st.engineId)
    this.state.set({
      ...initialState(this.capabilitiesOf(mode)),
      engineId: st.engineId,
      voice: st.voice,
      rate: st.rate,
      volume: st.volume,
      mode,
    })
  }

  /**
   * 插件生命周期终点（热替换 / 停用 / 升级）：位置先落盘再停声，介质一起放掉。
   * 与 `stopListening` 的分别：那条是用户的停止，会话与模块都还在；本方法之后模块本身作废。
   * 常驻播放层跨**面板**卸载存活（`ADR-0072`），不跨**插件**卸载：旧会话还响着就是两路叠音。
   */
  dispose(): void {
    // `stopListening` 在「还没有活会话」时早退、不抬代际；先自己抬一次，迟到的 `startSession`
    // 才会在每道 `gen !== runSeq` 上退场，否则卸载终点之后长出一路没人能停的声音（`ADR-0092`）。
    this.runSeq += 1
    // 停止里已 flush 位置并停声；先把这一笔冲出去，别让最后两秒的进度跟着模块一起作废
    this.stopListening()
    // 读数不是「介质已停」的证明：卸载是终点，两条分支的介质一律放掉
    this.teardownOutputs()
  }

  /** 介质与宿主挂钩的整份收尾：两条分支连槽放掉、摘 `pagehide`、清两份防抖（dispose 与测试复位共用）。 */
  private teardownOutputs(): void {
    this.platform.branches.releaseAll()
    this.unwatchPageHide?.()
    this.unwatchPageHide = null
    this.positionSave.cancel()
    this.paramsRestart.cancel()
  }

  /** 暂停：立即 flush 位置（不等防抖窗口），保留当前段现场供 resume 续上。 */
  pauseListening(): void {
    const st = this.state.get()
    if (!st.active) return
    const run = this.current
    if (run !== null) {
      run.playSeq += 1
      // 暂停住分支：字节型停元素保留现场，直出型撤平台队列（本层播放单位是整段，半句续播与段号对不上）。
      // 收口到**两条**分支：切引擎窗口里旧介质可能还在响。
      this.platform.branches.pauseAll()
    }
    // 立刻让「暂停」可见（`loading` 一并落下）；章正文在途时 `resume` 由 `chapterLoading` 挡住。
    this.state.set({ playing: false, loading: false })
    this.paramsRestart.cancel()
    this.positionSave.flush()
  }

  /** 继续：有回执续播能力的分支先试原地续上同一段字节，其余重新起播当前段。
   *  `loading` 与 `chapterLoading` 期间不接：准备期 / 章正文在途时段域与介质现场还没定。 */
  resumeListening(): void {
    const st = this.state.get()
    const run = this.current
    if (!st.active || run === null || st.playing || st.loading || this.chapterLoading) return
    this.ensurePagehide()
    const branch = this.branchOf(st.mode)
    if (branch.capabilities.receiptResume) {
      const cached = run.receipts.get(st.paragraphIndex)
      const entry = cached !== undefined && cached.paramsKey === this.paramsKeyOf(st) ? cached : null
      if (entry !== null) {
        try {
          const resumed = branch.resume(
            {
              key: entry.key,
              volume: clampNumber(st.volume, TTS_VOLUME.min, TTS_VOLUME.max, TTS_DEFAULTS.volume),
              // 续播的是同一段字节：补速取回执那一格，不取此刻的语速滑杆（引擎换了口径也照旧）
              playbackRate: entry.playbackRate,
            },
            this.segmentHandlers(run, run.playSeq),
          )
          if (resumed) {
            this.state.set({ loading: false })
            return
          }
        } catch {
          this.segmentFailed(run)
          return
        }
      }
    }
    void this.playCurrent(run)
  }

  // ── 段间推进 / 跳段 / 跳章 ──────────────────────────────────────────────────

  /** 同章内前后跳一段；边界上跨章（空章没有可跳的段，也按跳章处理）。
   *  **章正文载入在途**不接（段域还是上一章）；本段合成在途可以跳（`playSeq` 抬升会作废那一发）。
   *  返回的 Promise 只在跨章载入失败时拒绝（`TTS_CHAPTER_LOAD`）。 */
  async skipParagraph(delta: 1 | -1): Promise<void> {
    const run = this.current
    const st = this.state.get()
    if (run === null || !st.active || this.chapterLoading) return
    if (st.paragraphCount === 0) {
      await this.skipChapter(delta)
      return
    }
    const target = st.paragraphIndex + delta
    if (target >= 0 && target < st.paragraphCount) {
      this.seekParagraph(target)
      return
    }
    if (delta === 1) await this.skipChapter(1)
    else await this.moveChapter(run, st.chapterIndex - 1, 'manual', 'last')
  }

  /** 章内滑杆的落点：夹紧到本章段域并起播，与跳段同一条径（落盘、代际抬升、重取当前段）。
   *  **章正文载入在途**不接；本段合成在途可以接。 */
  seekParagraph(index: number): void {
    const run = this.current
    const st = this.state.get()
    if (run === null || !st.active || this.chapterLoading || st.paragraphCount === 0) return
    const target = clampIndex(index, st.paragraphCount - 1)
    if (target === st.paragraphIndex) return
    // 跳走之后没人再听的那一发要停在上游（`ADR-0082`）：只掐当前段那一发，同章预取仍归整趟 run。
    this.cancelCurrentSegment(run)
    run.playSeq += 1
    this.state.set({ paragraphIndex: target, paragraphText: run.units[target] ?? '' })
    this.schedulePositionSave()
    void this.playCurrent(run)
  }

  /** 起播章选择面的落点：换到指定章并从首段起播；选中当前章时回到本章首段。载入失败上抛 `TTS_CHAPTER_LOAD`。 */
  async jumpToChapter(index: number): Promise<void> {
    const run = this.current
    const st = this.state.get()
    if (run === null || !st.active || run.chapters.length === 0) return
    const target = clampIndex(index, run.chapters.length - 1)
    if (target === st.chapterIndex) {
      this.seekParagraph(0)
      return
    }
    await this.moveChapter(run, target, 'manual', 'first')
  }

  /** 前后跳一章（越界什么都不做）；载入失败按手动导航上抛 `TTS_CHAPTER_LOAD`，由界面翻人话。 */
  async skipChapter(delta: 1 | -1): Promise<void> {
    const run = this.current
    if (run === null || !this.state.get().active) return
    await this.moveChapter(run, this.state.get().chapterIndex + delta, 'manual', 'first')
  }

  private async moveChapter(
    run: PlayerRun, target: number, cause: 'auto' | 'manual', paragraph: 'first' | 'last',
  ): Promise<MoveOutcome> {
    if (target < 0 || target >= run.chapters.length) return 'out-of-range'
    // 手跳章 = 用户主动离开「本章」：本章定时随之作废（自动推到章尾才是它该响的时刻）
    if (cause === 'manual' && run.timer?.kind === 'chapter') this.clearRunTimer(run)
    const loadToken = ++run.loadSeq
    run.playSeq += 1
    const resumeToken = run.playSeq
    // 换章决定落下，在途合成（本章预取）当场掐掉；正在放的那一段字节不受影响，由起播换槽接替。
    this.cancelInFlight(run)
    // 旧声音让不让位归分支：直出型当场撤队，字节型载入期间继续放（用户不会在等待里听见静音）。
    this.branchOf(this.state.get().mode).yieldForLoad()
    this.chapterLoading = true
    this.state.set({ loading: true, playing: false })
    try {
      const units = await this.platform.fetchUnits(run.sourceId, run.bookKey, target)
      if (this.current !== run || loadToken !== run.loadSeq) return 'superseded'
      run.units = units
      run.receipts.clear()
      run.retried.clear()
      run.prefetched.clear()
      this.branchOf(this.state.get().mode).dropPreload()
      const index = paragraph === 'last' && units.length > 0 ? units.length - 1 : 0
      // 逐段失败留痕随章归零，连败计数不动：死引擎必须跨章累计到阈值才暂停，否则会空走到书末。
      this.chapterLoading = false
      this.state.set({
        chapterIndex: target,
        paragraphCount: units.length,
        paragraphIndex: index,
        paragraphText: units[index] ?? '',
        loading: false,
      })
      this.schedulePositionSave()
      // 载入期间用户按了暂停 / 跳段（playSeq 被抬过）就不再自动起播——新章停在段首等 resume。
      const stillCurrent = this.current === run && run.playSeq === resumeToken
      if (units.length > 0) {
        if (stillCurrent) await this.playCurrent(run)
        return 'moved'
      }
      // 空章没有「播完」事件，自动推进会连续跨过；但载入期间被暂停 / 跳段就必须停住，回 superseded 交 finishChapter 收口。
      return stillCurrent ? 'moved' : 'superseded'
    } catch {
      // 在途那一发已被更新的导航作废就别翻掉新章的 loading，也别把陈旧失败当成「自动推进到头」。
      if (this.current !== run || loadToken !== run.loadSeq) return 'superseded'
      // 旧音频必须当场闭嘴：`playSeq` 已抬，旧槽事件全部作废；直出型已在入口让位过。
      this.branchOf(this.state.get().mode).pause()
      this.chapterLoading = false
      this.state.set({ loading: false, playing: false })
      // 手动导航的失败交回调用方（界面翻人话）；自动推进由 finishChapter 收口成暂停。
      if (cause === 'manual') throw new TtsPlayerError('TTS_CHAPTER_LOAD')
      return 'failed'
    }
  }

  /** 段播完（出声层的 ended / onend）→ 下一段；章尾按定时与下一章是否可载收口。 */
  private advance(run: PlayerRun): void {
    const st = this.state.get()
    if (st.paragraphIndex + 1 < st.paragraphCount) {
      const next = st.paragraphIndex + 1
      this.state.set({ paragraphIndex: next, paragraphText: run.units[next] ?? '' })
      this.schedulePositionSave()
      void this.playCurrent(run)
      return
    }
    void this.finishChapter(run)
  }

  /** 章播完 → 下一章；空章没有「播完」事件，自动推进时连续跨过直到可读章或书末（手动跳章不受影响）。 */
  private async finishChapter(run: PlayerRun): Promise<void> {
    if (run.timer?.kind === 'chapter') {
      this.clearRunTimer(run)
      this.pauseListening()
      return
    }
    let target = this.state.get().chapterIndex + 1
    while (target < run.chapters.length) {
      const loadBefore = run.loadSeq
      const outcome = await this.moveChapter(run, target, 'auto', 'first')
      if (outcome !== 'moved') {
        // 被更新的手动导航作废时不替用户暂停；其余结局只有本轮 moveChapter 仍是最新一发才收口。
        if (outcome !== 'superseded' && this.current === run && run.loadSeq === loadBefore + 1) {
          this.pauseListening()
        }
        return
      }
      if (this.state.get().paragraphCount > 0) return
      target = this.state.get().chapterIndex + 1
    }
    if (this.current === run) this.pauseListening()
  }

  // ── 播放一段（准备与出声都经分支：合成 → 缓存键 / utterance 直出）──────────────

  private async playCurrent(run: PlayerRun): Promise<void> {
    // 这一发本身就是「按当前参数起播」：取消排队的同义重取，免得它两拍后打断新段。
    this.paramsRestart.cancel()
    const token = ++run.playSeq
    const st = this.state.get()
    const index = st.paragraphIndex
    const text = run.units[index]
    if (text === undefined) {
      // 空段：读数写「不在放」之前先把声音收掉，别让旧介质替一个没有的段继续响。
      this.platform.branches.pauseAll()
      this.state.set({ loading: false, playing: false })
      return
    }
    const branch = this.branchOf(st.mode)
    this.state.set({ loading: true, paragraphText: text })
    this.schedulePositionSave()
    // 换段即归零（直出 / 字节同口径）：读数只认活槽计时，不等合成落地才清。
    this.progress.set({ position: 0, duration: 0 })
    // 参数变更要按「本段合成在途」判，不能只看 `loading`（章正文载入也写这一格）。
    run.synthToken = token
    const handlers = this.segmentHandlers(run, token)
    const host: BranchHost = {
      // 回执只在「这一发仍是当前播放」时交回：旧章段号写进新章 receipts 会命中旧字节、念错章。
      receipt: async (job) => {
        const entry = await this.receiptFor(run, job.index, job.text, job.signal,
          () => this.current === run && token === run.playSeq)
        return this.current === run && token === run.playSeq
          ? { key: entry.key, playbackRate: entry.playbackRate }
          : null
      },
      // 音量在准备之后活读：合成在途的窗口里音量条还能动，入口快照会把用户刚拖到的值盖回去
      voice: () => {
        const s = this.state.get()
        return {
          voice: s.voice,
          rate: s.rate,
          volume: clampNumber(s.volume, TTS_VOLUME.min, TTS_VOLUME.max, TTS_DEFAULTS.volume),
        }
      },
    }
    try {
      const outcome = await branch.start({ index, text, signal: run.segAbort.signal }, handlers, host)
      if (outcome === 'failed') {
        if (this.current === run && token === run.playSeq) this.segmentFailed(run)
        return
      }
      // `cancelled` = 这一发已被更新的动作作废（跳章 / 换参数 / 停止）：静默收口，不记账。
      if (outcome !== 'started' || this.current !== run || token !== run.playSeq) return
      if (branch.capabilities.prefetch) this.prefetchAround(run)
    } catch {
      if (this.current !== run || token !== run.playSeq) return
      this.segmentFailed(run)
    } finally {
      // 参数变更会另起一发（它已经占了这个位）；只有仍是自己那一发时才清空。
      if (run.synthToken === token) run.synthToken = null
    }
  }

  /** 一段的出声回调：两条分支共用同一套事实语义，token 守卫在这里。
   *  `prepared` = 准备期结束（字节型交给介质时调）；`start` = 真开口（记在放、连败清零、停因消失）；
   *  `done` = 这一段播完就推进（不看 `playing`：平台可能吞掉开口事件直接回 onend）；
   *  `fail` = 介质没成（分支能自愈先自愈一次，否则走段失败）。旧介质的迟到事件按 token 拦下。 */
  private segmentHandlers(run: PlayerRun, token: number): OutputHandlers {
    const alive = (): boolean => this.current === run && token === run.playSeq
    return {
      prepared: () => {
        if (!alive()) return
        this.state.set({ loading: false })
      },
      start: () => {
        if (!alive()) return
        // 真开口才算这一段在放：连败从这一刻清零（起播只是发起加载，不是成功）。
        this.state.set({ playing: true, loading: false, consecutiveFailures: 0, halt: null })
        this.schedulePositionSave()
      },
      done: () => {
        if (!alive()) return
        this.advance(run)
      },
      fail: () => {
        if (!alive()) return
        const branch = this.branchOf(this.state.get().mode)
        // 回执已发、字节未取之间缓存条目被 prune 是可能的（读口回 404）：能自愈的分支每段重来一次
        // （删旧回执、作废介质现场、重新合成）；第二次仍失败才走段失败径，免得坏音频无限重来。
        if (branch.capabilities.selfHeal) {
          const failedAt = this.state.get().paragraphIndex
          if (!run.retried.has(failedAt)) {
            run.retried.add(failedAt)
            run.receipts.delete(failedAt)
            branch.invalidate()
            void this.playCurrent(run)
            return
          }
        }
        this.segmentFailed(run)
      },
      progress: (position, duration) => {
        if (!alive()) return
        this.progress.set({ position, duration })
      },
    }
  }

  /** 单段失败：连败计数，未到线跳过继续，到线暂停并公布停因（`halt`）——阈值判据只此一处。 */
  private segmentFailed(run: PlayerRun): void {
    const st = this.state.get()
    const consecutive = st.consecutiveFailures + 1
    const stopped = consecutive >= TTS_MAX_CONSECUTIVE_FAILURES
    // 先抬 playSeq 再收口（与暂停、换章同一手法）：直出介质被 pause 会补发 canceled
    // 事件，抬过之后它落在旧发上作废。切引擎窗口里旧介质可能还在念，两条一起闭嘴再记账。
    run.playSeq += 1
    this.platform.branches.pauseAll()
    this.state.set({
      consecutiveFailures: consecutive,
      playing: false,
      loading: false,
      ...(stopped ? { halt: { reason: 'consecutive-failures' as const, failures: consecutive } } : {}),
    })
    if (stopped) {
      this.pauseListening()
      return
    }
    this.advance(run)
  }

  // ── 预取（fire-and-forget 暖缓存）───────────────────────────────────────────

  /** 每次起播后预热同章后 2 段；进末 3 段再预热下一章开头 N 段（N 读活动缺省快照）。 */
  private prefetchAround(run: PlayerRun): void {
    const st = this.state.get()
    for (let ahead = 1; ahead <= PREFETCH_AHEAD; ahead += 1) {
      const index = st.paragraphIndex + ahead
      if (index < st.paragraphCount) this.prefetchParagraph(run, index)
    }
    if (st.paragraphIndex >= st.paragraphCount - PREFETCH_LAST_PARAGRAPHS) {
      this.prefetchNextChapter(run)
    }
  }

  /** 预取在途守卫：run 换了、loadSeq 作废了、章挪了，在途结果一律丢弃（`stillHere` 的三份判据只在这造）。 */
  private stillHereGuard(run: PlayerRun): () => boolean {
    const token = run.loadSeq
    const chapter = this.state.get().chapterIndex
    return (): boolean =>
      this.current === run && run.loadSeq === token && this.state.get().chapterIndex === chapter
  }

  private prefetchParagraph(run: PlayerRun, index: number): void {
    const branch = this.branchOf(this.state.get().mode)
    // 分支没有预取面：在途的预取链到此为止（直出不出字节，合成请求会拿浏览器引擎 id 打空）。
    if (!branch.capabilities.prefetch) return
    if (run.prefetched.has(index)) return
    const text = run.units[index]
    if (text === undefined) return
    run.prefetched.add(index)
    const stillHere = this.stillHereGuard(run)
    const signal = run.abort.signal
    void this.receiptFor(run, index, text, signal, stillHere).then((receipt) => {
      // 切走分支后在途的字节预取到此为止：别再建 / 下载一个用不上的 Audio。
      if (!stillHere() || !this.branchOf(this.state.get().mode).capabilities.prefetch) return
      if (index === this.state.get().paragraphIndex + 1) branch.preload(receipt.key)
    }).catch(() => undefined)
  }

  /** 下一章开头 N 段：只发合成请求暖缓存（不取回执、不预载 Audio——跨章还要先载正文）。 */
  private prefetchNextChapter(run: PlayerRun): void {
    // 分支没有预取面：字节预取链到此为止（直出不出字节，合成请求会拿浏览器引擎 id 打空）。
    if (!this.branchOf(this.state.get().mode).capabilities.prefetch) return
    const count = this.defaults.prefetchParagraphs
    const target = this.state.get().chapterIndex + 1
    if (count <= 0 || target >= run.chapters.length || run.nextPrefetched.has(target)) return
    run.nextPrefetched.add(target)
    const stillHere = this.stillHereGuard(run)
    const signal = run.abort.signal
    // 取消位是**异步**变的：用函数读——直接在循环里读 `signal.aborted`，TS 会按第一次守卫把它窄化成恒假。
    const cancelled = (): boolean => signal.aborted
    void (async (): Promise<void> => {
      const units = await this.platform.fetchUnits(run.sourceId, run.bookKey, target)
      // 切走分支不该把这一章记成「已预取」：切回字节后它还要重来一次暖缓存。
      if (!stillHere() || !this.branchOf(this.state.get().mode).capabilities.prefetch || cancelled()) {
        run.nextPrefetched.delete(target)
        return
      }
      for (const text of units.slice(0, count)) {
        if (!stillHere() || !this.branchOf(this.state.get().mode).capabilities.prefetch || cancelled()) {
          run.nextPrefetched.delete(target)
          return
        }
        await this.platform.synthesize(this.synthesisRequest(text), { signal }).catch(() => undefined)
      }
    })().catch(() => undefined)
  }

  // ── 播放参数（按书记忆：随下一笔位置落盘写回 listen）──────────────────────────

  setListenRate(rate: number): void {
    this.state.set({ rate: clampNumber(rate, TTS_RATE.min, TTS_RATE.max, this.state.get().rate) })
    // 滑杆是逐档 change：状态即时、回执即时清，重取当前段等手停下来（见 PARAMS_RESTART_DEBOUNCE_MS）。
    this.synthesisParamsChanged(true)
  }

  setListenVolume(volume: number): void {
    const st = this.state.get()
    const next = clampNumber(volume, TTS_VOLUME.min, TTS_VOLUME.max, st.volume)
    this.state.set({ volume: next })
    // 音量落到当前分支的活介质；直出型没有可调的活介质（改动从下一段起生效，分支自己消化）。
    this.branchOf(st.mode).setVolume(next)
    this.schedulePositionSave()
  }

  setListenVoice(voice: string | null): void {
    this.state.set({ voice })
    this.synthesisParamsChanged()
  }

  /**
   * 换朗读源。音色 id 不跨引擎互通：换源时清掉本书记住的旧 id，不把上一家的 id 送进新引擎。
   * **换到直出源要先等语音表**（Chromium 首读常是空表，当场拒会把「还在加载」误报成「设备没有语音」）；
   * 等不到才按 `TTS_NO_VOICES` 拒——与 `startSession` 同一条判据、同一个半径。
   */
  async setListenEngine(engineId: string): Promise<void> {
    const st = this.state.get()
    const mode = modeOf(engineId)
    const branch = this.branchOf(mode)
    if (engineId !== st.engineId) {
      const gate = branch.ready()
      if (gate !== true && !(await gate)) throw new TtsPlayerError('TTS_NO_VOICES')
    }
    // 等待窗口里会话可能已经变了：按落地时现场收口；换了书则整笔作废（切源是点给这本书的参数）。
    const latest = this.state.get()
    if (latest.bookKey !== st.bookKey) return
    this.state.set({
      engineId,
      mode,
      segmentProgress: branch.capabilities.segmentProgress,
      voiceTable: branch.capabilities.voiceTable,
      ...(latest.engineId === engineId ? {} : { voice: null }),
    })
    this.synthesisParamsChanged()
  }

  /** 引擎/音色/语速变了：旧回执与预载作废；正在放就按新参数重取当前段（`deferred` 走防抖，别逐档打断）。 */
  private synthesisParamsChanged(deferred = false): void {
    const run = this.current
    if (run !== null) {
      run.receipts.clear()
      run.prefetched.clear()
      this.branchOf(this.state.get().mode).dropPreload()
      // 旧参数的那几发（含预取）再也不会被这一趟用上：掐掉，别让它继续花上游的合成
      this.cancelInFlight(run)
    }
    this.schedulePositionSave()
    if (run === null || !this.shouldRestart(run)) return
    if (deferred) {
      this.paramsRestart()
      return
    }
    this.paramsRestart.cancel()
    this.restartForParams()
  }

  /** 「现在重取当前段」的判据：在放、当前分支还占着介质，或本段合成在途（章正文在途除外）。 */
  private shouldRestart(run: PlayerRun): boolean {
    const st = this.state.get()
    // 直出型在 `onstart` 之前 playing 还是假，但 utterance 已进平台队列，`held()` 补上这一段。
    // 字节型合成在途时 playing 也还是假：`synthToken` 在且 loading 而**不是**章正文在途，同样要重取。
    const synthInFlight = run.synthToken !== null && st.loading && !this.chapterLoading
    return st.playing || this.platform.branches.held() || synthInFlight
  }

  /** 按新参数重取当前段：判据与 `playCurrent` 同一份现场，判决已过期（暂停/停止）就不动。 */
  private restartForParams(): void {
    const run = this.current
    if (run === null || !this.state.get().active || !this.shouldRestart(run)) return
    run.playSeq += 1
    void this.playCurrent(run)
  }

  /** 定时：`minutes` 后暂停；`'chapter'` = 本章末尾暂停；null = 取消。会话级，不落盘。 */
  setListenTimer(minutes: number | 'chapter' | null): void {
    const run = this.current
    if (run === null || !this.state.get().active) return
    // 校验先于清空：非法档位不该顺手取消一个已定好的定时（只有 null 与合法正数是走得到的形状）。
    if (minutes !== null && minutes !== 'chapter' && (!Number.isFinite(minutes) || minutes <= 0)) return
    this.clearRunTimer(run)
    if (minutes === null) return
    if (minutes === 'chapter') {
      run.timer = { kind: 'chapter' }
      this.state.set({ timerEndAt: null, timerChoice: 'chapter' })
      return
    }
    this.armTimer(run, minutes, this.platform.now() + minutes * 60_000)
  }

  /** 按**到点时刻**挂定时（换起播点后复位共用）：已过期当场收口，不从「现在」重新充满——换起播点不是重定一次时。 */
  private armTimer(run: PlayerRun, choice: number, at: number): void {
    this.clearRunTimer(run)
    const remaining = at - this.platform.now()
    if (remaining <= 0) {
      this.pauseListening()
      return
    }
    const cancel = this.platform.after(remaining, () => { this.expireTimer(run) })
    run.timer = { kind: 'at', at, cancel }
    this.state.set({ timerEndAt: at, timerChoice: choice })
  }

  private expireTimer(run: PlayerRun): void {
    if (this.current !== run) return
    this.clearRunTimer(run)
    this.pauseListening()
  }

  private clearRunTimer(run: PlayerRun): void {
    if (run.timer?.kind === 'at') run.timer.cancel()
    run.timer = null
    if (this.current === run) this.state.set({ timerEndAt: null, timerChoice: null })
  }

  /** served 缺省（宿主设置面读到的有效值）推进来的地方；缺席时用 wire 的 `TTS_DEFAULTS`。 */
  setTtsDefaults(p: Partial<TtsDefaults>): void {
    if (p.engineId !== undefined) this.defaults.engineId = p.engineId
    if (p.rate !== undefined) this.defaults.rate = p.rate
    if (p.volume !== undefined) this.defaults.volume = p.volume
    if (p.prefetchParagraphs !== undefined) this.defaults.prefetchParagraphs = p.prefetchParagraphs
    if (!this.state.get().active) {
      const mode = modeOf(this.defaults.engineId)
      const capabilities = this.capabilitiesOf(mode)
      this.state.set({
        engineId: this.defaults.engineId,
        rate: this.defaults.rate,
        volume: this.defaults.volume,
        mode,
        segmentProgress: capabilities.segmentProgress,
        voiceTable: capabilities.voiceTable,
      })
    }
  }

  // ── 从阅读位置起播 ──────────────────────────────────────────────────────────

  /** 在**当前这本书**的会话里换到阅读位置起播：位置解析与起播管线都归 `startFromReadingPosition`。 */
  async playFromReadingPosition(): Promise<void> {
    const st = this.state.get()
    if (st.bookKey === null || st.sourceId === null) return
    await this.startFromReadingPosition({
      sourceId: st.sourceId, bookKey: st.bookKey, title: st.title,
    })
  }

  /** 「从阅读位置起播」的唯一解析链：显式目标 → 实时探针 → 当前章 → 书架 progress；解析结果交给同一条取数管线。 */
  async startFromReadingPosition(p: StartFromReadingPositionInput): Promise<void> {
    const st = this.state.get()
    const activeSame = st.active && st.bookKey === p.bookKey && st.sourceId === p.sourceId
    const timerChoice = activeSame ? st.timerChoice : null
    const timerEndAt = activeSame ? st.timerEndAt : null
    let target = p.target ?? null
    if (target === null) {
      const probe = readingProbeNow()
      if (probe !== null) {
        try { target = probe() } catch { target = null }
      }
    }
    const base: StartListeningInput = {
      sourceId: p.sourceId,
      bookKey: p.bookKey,
      title: p.title,
      resume: 'position',
      ...(activeSame
        ? { engineId: st.engineId, voice: st.voice, rate: st.rate, volume: st.volume }
        : {}),
      ...(target !== null
        ? { chapterIndex: target.chapterIndex, paragraphIndex: target.paragraphIndex }
        : {
            ...(activeSame ? { fallbackChapter: st.chapterIndex } : (p.fallbackChapter === undefined ? {} : { fallbackChapter: p.fallbackChapter })),
            fallbackToShelfParagraph: true,
          }),
    }
    await this.startListening(base)
    if (!this.stillOn(p.bookKey)) return
    if (timerChoice !== null) {
      if (timerChoice === 'chapter' || timerEndAt === null) this.setListenTimer(timerChoice)
      else this.restoreTimerAt(timerChoice, timerEndAt)
    }
  }

  /** 会话重建后的定时复位（`startFromReadingPosition` 专用）：只认到点时刻，不重算时长。 */
  private restoreTimerAt(choice: number, endAt: number): void {
    const run = this.current
    if (run === null || !this.state.get().active) return
    this.armTimer(run, choice, endAt)
  }

  private stillOn(bookKey: string): boolean {
    const st = this.state.get()
    return st.active && st.bookKey === bookKey
  }

  // ── 回阅读器（一次性重定位现场）────────────────────────────────────────────

  /**
   * 「回阅读器」的交接现场：迷你条记下当前听书位置并切到阅读器；阅读器**开书时**取走它，
   * 当 ReaderSession 的恢复目标（`open` 的第三参）。
   *
   * 为什么不是跳章：`requestJump`/`settleJump` 会把「读到第 N 章」立即写进存档，把定位动作记成
   * 一次阅读；恢复路径（cause `restore`）只站定不写。现场一次性、**按书键**：取走即空。
   * target 直接是章 + 段号（`ADR-0094`）：阅读器按 `[data-pidx]` 找块，段高不等时比例换算不是视觉落点。
   * 两键不匹配既**不消费也不应用**——现场留给它真正的主人，别的书照常回自己的存档 progress。
   */
  requestReaderRelocation(
    sourceId: string, bookKey: string, chapterIndex: number, paragraphIndex: number,
  ): void {
    this.pendingRelocation = {
      sourceId,
      bookKey,
      target: { index: chapterIndex, paragraphIndex },
    }
  }

  /** 阅读器开书时按书键取走现场：两键都匹配才返回并清空；不匹配/没有现场返回 null（不消费）。 */
  takeReaderRelocation(sourceId: string, bookKey: string): ReaderRevealTarget | null {
    const pending = this.pendingRelocation
    if (pending === null || pending.sourceId !== sourceId || pending.bookKey !== bookKey) return null
    this.pendingRelocation = null
    return pending.target
  }

  // ── 位置落盘（只写 listen 支）───────────────────────────────────────────────

  private schedulePositionSave(): void {
    if (!this.state.get().active) return
    this.positionSave()
  }

  /** 位置落盘的唯一出口：同一节拍写 listen 与 progress 两笔；两笔各自尽力而为，一笔失败不拖住另一笔。 */
  private async writePosition(): Promise<void> {
    const st = this.state.get()
    if (!st.active || st.bookKey === null) return
    const offsetRatio = paragraphRatio(st.paragraphIndex, st.paragraphCount)
    const listenSave = this.platform.saveListen(st.bookKey, {
      chapterIndex: st.chapterIndex,
      paragraphIndex: st.paragraphIndex,
      engineId: st.engineId,
      voice: st.voice,
      rate: st.rate,
      volume: st.volume,
    }).catch(() => undefined)
    // 阅读器子树在场 → progress 归阅读会话（按真实视口 / 精确段写）；播放层再写只会与它抢字段（ADR-0093）。
    let readerOwns = false
    try {
      readerOwns = this.platform.readerPresent?.(st.bookKey) === true
    } catch { /* 在场读数失败按不在场处理：宁可多写一笔 progress，也不让听书落盘整条断掉 */ }
    if (readerOwns) {
      await listenSave
      return
    }
    await Promise.all([
      listenSave,
      this.platform.saveProgress(st.bookKey, st.chapterIndex, offsetRatio).catch(() => undefined),
    ])
  }

  private ensurePagehide(): void {
    if (this.unwatchPageHide !== null) return
    this.unwatchPageHide = this.platform.watchPageHide(() => { this.positionSave.flush() })
  }

  /** 测试用整份复位（生产路径不调：面板卸载不是复位时机，见 `ADR-0072`；插件卸载走 `dispose`）。 */
  resetForTests(): void {
    this.runSeq += 1
    this.pendingRelocation = null
    const run = this.current
    if (run !== null) {
      run.playSeq += 1
      this.clearRunTimer(run)
      this.cancelInFlight(run)
    }
    this.current = null
    this.chapterLoading = false
    this.teardownOutputs()
    this.defaults = { ...TTS_DEFAULTS }
    this.progress.set({ position: 0, duration: 0 })
    this.state.set(initialState(this.capabilitiesOf(modeOf(TTS_DEFAULTS.engineId))))
  }

  // ── 内部小件 ────────────────────────────────────────────────────────────────

  private paramsKeyOf(st: TtsPlayerState): string {
    return JSON.stringify([st.engineId, st.voice, st.rate])
  }

  /** 作废本趟在途的合成请求并换新取消位：停止 / 复位、换参数、换章时按。**暂停不在其列**——
   *  续播要接的正是那一发。跳段只走 `cancelCurrentSegment`，预取不受牵连。 */
  private cancelInFlight(run: PlayerRun): void {
    run.abort.abort()
    run.abort = new AbortController()
    run.segAbort.abort()
    run.segAbort = new AbortController()
  }

  /** 作废当前段那一发（跳段 / 章内滑杆）：没人再听的是这一段，同章预取不能连坐。 */
  private cancelCurrentSegment(run: PlayerRun): void {
    run.segAbort.abort()
    run.segAbort = new AbortController()
  }

  private synthesisRequest(text: string): SynthesisRequest {
    const st = this.state.get()
    return {
      engineId: st.engineId,
      text,
      rate: st.rate,
      ...(st.voice === null ? {} : { voice: st.voice }),
    }
  }

  /** 取一段的回执（主播放径与预取共用）；`signal` 是调用方出发时那一只（中途换参数已换新的）。 */
  private async receiptFor(
    run: PlayerRun, index: number, text: string, signal: AbortSignal,
    stillValid: () => boolean = () => true,
  ): Promise<ReceiptEntry> {
    const st = this.state.get()
    const paramsKey = this.paramsKeyOf(st)
    const cached = run.receipts.get(index)
    if (cached !== undefined && cached.paramsKey === paramsKey) return cached
    const receipt = await this.platform.synthesize(this.synthesisRequest(text), { signal })
    const entry: ReceiptEntry = { paramsKey, key: receipt.key, playbackRate: receipt.playbackRate }
    // 预取 fire-and-forget：请求在途时可能已跳章，旧章段号不能写进新章 receipts。
    if (stillValid()) run.receipts.set(index, entry)
    return entry
  }
}

function clampIndex(value: number, max: number): number {
  if (max < 0) return 0
  const integer = Number.isFinite(value) ? Math.trunc(value) : 0
  return Math.min(Math.max(0, integer), max)
}

function clampNumber(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}
