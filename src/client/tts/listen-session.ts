import { BROWSER_TTS_ENGINE_ID, TTS_DEFAULTS, TTS_RATE, TTS_VOLUME } from '../../shared/wire.js'
import type {
  ChapterEntry, ListenState, ShelfEntry, SynthesisReceipt, SynthesisRequest,
} from '../../shared/wire.js'
import type { ReaderRestoreTarget } from '../reader-session.js'
import { createStore } from '../store.js'
import type { Store } from '../store.js'
import type {
  BranchCapabilities, BranchHost, BranchMode, ListenBranches, OutputHandlers, PlaybackBranch,
} from './output-contract.js'
import { estimateParagraphIndex, paragraphRatio, readingProbeNow } from './reading-position.js'

/**
 * 听书播放会话（字节型 + 浏览器直出型）：状态机与全部可变现场住这里，外界一律经
 * `ListenPlatform` 平台缝进来——网络、书架投影、落盘、合成、时钟、宿主事件、出声输出
 * 都是注入的，本文件不 `new Audio`、不摸 `speechSynthesis`、不碰 `window` / `setTimeout`。
 * 生产外观（平台实现、单例与视图认识的那组导出）住 `client/tts/player.ts`；两支出声适配器
 * 住 `client/tts/bytes-output.ts` / `direct-output.ts`，它们与会话之间只有 `output-contract.ts`
 * 那张输出契约。
 *
 * 位置单轨：阅读进度（`ShelfProgress` 的章 + 章内比例）是阅读与听书共用的消费位置，本会话在
 * 同一个落盘节拍里写两笔——`platform.saveProgress` 写章 + 由段号换算的比例，
 * `platform.saveListen` 写听书细节（段号 + 播放参数）。listen 不替代 progress：书架卡片、
 * 最近阅读排序与下次开阅读器的恢复点都读 progress；段号只服务听书自己的精确续听。
 * 「回阅读器」重定位仍走 restore（只站定不写），那条路不是一次阅读动作。
 *
 * 播放单元 = 章正文投影切出的段（`platform.fetchUnits` 给的就是切好的单元）：切段只动边界
 * 不动字，与导出 / AI 读数同一份正文投影。两种模式共用同一个状态机、同一份位置落盘与同一条
 * 失败径；**「这一段怎么出声」的策略住两条分支自己的实现**（`playback-branches.ts` 的
 * `BytesBranch` / `DirectBranch`）：准备这一段（字节型求合成回执、交两槽介质；直出型过音色闸、
 * 交 utterance）、能提供什么（段内计时 / 预取 / 回执续播 / 介质自愈）、静音另一条分支、重来的许可。
 * 会话只按 `modeOf` 分流取分支，不再在状态机的多个方法里查模式。
 *
 * 失败半径 = 那一段：单段合成失败或 utterance 报错只跳过，连续
 * `TTS_MAX_CONSECUTIVE_FAILURES` 段失败才暂停并公布停因（`halt`）；任何**真开口**的段都把连败
 * 计数清零（起播只是发起加载，404 / 解码失败 / 自动播放被拒都发生在之后，清零不能提前到那一步）。
 * 连败是**整个会话**的读数，换章不清零（章正文拉取成功不等于出声成功）：否则死引擎每到章界就
 * 从零数起，会一章一章走到书末才停。引擎中途缺席（cordis 服务被卸载 → `TTS_ENGINE_MISSING`）
 * 与上游错误走同一条失败径——播放层不认识错误码，只认识「这一次没成」。
 *
 * 本会话不持可见文案：状态是给视图读的结构化读数，错误不上屏（要说话的地方归 `client/copy`）。
 * 起播的正常数据面失败抛 `TtsPlayerError`，调用方按 `code` 取词典，`message` 不是人话。
 */

/** 连续失败到这条线就暂停：留给用户一个「引擎/网络坏了」的可见停顿，而不是静默跳过整章。 */
export const TTS_MAX_CONSECUTIVE_FAILURES = 5

/** 起播失败码：码是契约，译文由调用方按 code 映射（本模块不持可见文案）。
 *  `TTS_NO_VOICES` = 直出源等过平台的语音表（Chromium 首读可能为空）之后仍没有可用音色
 *  （含平台没有语音能力），不假装能放；
 *  `TTS_NOT_ON_SHELF` = 没进架的书没有阅读进度可换算，「从阅读位置起播」要说清为什么没动；
 *  `TTS_CHAPTER_LOAD` = 用户点名的跳章 / 跳段跨章时章正文拉不到。它只从**手动导航**抛：
 *  自动推进的同一失败由 `finishChapter` 收口成暂停，用户按下的导航则要有人告诉他为什么没动。
 *  与「单段失败」不是一回事——那一段失败只影响那一段，章正文失败是整章没到手。 */
export type TtsPlayerErrorCode =
  | 'TTS_CHAPTERS_EMPTY'
  | 'TTS_NO_VOICES'
  | 'TTS_NOT_ON_SHELF'
  | 'TTS_CHAPTER_LOAD'

/** 跳章的载入结局：`moved` 也含空章（章正文到货但没有可朗读段，由调用方按段落数决定下一步）。
 *  手动导航与自动推进共用这一份结局，失败与「被更新的导航作废」不许折成同一个值。 */
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

/** 语速滑杆的「按新参数重取当前段」防抖窗口：状态与回执清理即时，重取等手停下来再发——
 *  原生 range 每拖一档就发一次 change，逐档重合成会把一次拖动打成十几次上游请求。
 *  导出给测试引（别在用例里抄一份字面量：改窗口时那份副本不会跟着变）。 */
export const PARAMS_RESTART_DEBOUNCE_MS = 250

/** 同章预取窗口：当前段之后 2 段。 */
const PREFETCH_AHEAD = 2

/** 距章尾不足这么多段 = 「进入末 3 段」，开始预取下一章开头。 */
const PREFETCH_LAST_PARAGRAPHS = 3

/** 会话停在上屏的**原因**（播放层独知的成品事实）：表面读它，不拿计数与阈值对比。
 *  阈值判据只在播放层（`segmentFailed`）一处，次数随停因一起公布——上屏只需要「为什么停 +
 *  连续几段」，不需要自己再与阈值比一遍。 */
export interface ListenHalt {
  reason: 'consecutive-failures'
  /** 触发停的那一刻的连败次数（上屏读数用）。 */
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
  /** 当前播放单元的原文：视图的「段读数 + 预览」直接读它。播放层是切分（`splitParagraphs`）
   *  的唯一主人，界面不在第二处重算同一份投影。 */
  paragraphText: string
  playing: boolean
  engineId: string
  voice: string | null
  rate: number
  volume: number
  timerEndAt: number | null
  /** 定时的**档位**（分钟数 / 'chapter' / null = 没定）：`timerEndAt` 只答「什么时候到」，
   *  答不出「用户定的是哪一档」，而界面重挂载时必须把档位摆回原样——会话跨面板卸载存活
   *  （`ADR-0072`），档位若只活在组件里，回来就是一张说「关闭」的假脸。 */
  timerChoice: number | 'chapter' | null
  mode: 'bytes' | 'direct'
  /** 这段出声**在准备中**（合成在途 / 等平台开口）：与 `playing` 分开是为了让「按下去是暂停」
   *  判据（`playing ∨ loading`）在加载窗口里也成立。字节型的 loading 到「已交给介质」为止，
   *  直出型到平台真开口为止——两套生命周期的差别住各自分支，不在这里按模式分。 */
  loading: boolean
  /** 会话为什么停在上屏：null = 没因失败停（用户暂停 / 定时到点 / 播完都不算）。
   *  控制面据此给「连续 N 段播放失败，已暂停」那行读数；真开口后清零，这一格自然回 null。 */
  halt: ListenHalt | null
  consecutiveFailures: number
  /** 当前分支有没有段内计时介质：false = 段进度（`progress`）恒零，浮窗进度环画静态轨道。 */
  segmentProgress: boolean
  /** 当前引擎该露哪张音色表：平台表（直出型）或引擎源声明（字节型）。 */
  voiceTable: 'platform' | 'engine'
  /** 本会话的章名清单（起播章选择面的选项）；随会话建立一次，章间推进不改它。 */
  chapterNames: string[]
}

/** 当前播放单元的出声进度（秒）：字节型由活槽的 timeupdate / loadedmetadata 推进，
 *  直出型没有计时介质，恒 `{0, 0}`（duration 0 = 不知道，视图据此不渲染时间面）。
 *  **独立于主状态一只 store**：timeupdate 约每秒四发，进主 store 会让订阅主 store 的
 *  整棵阅读器跟着每帧重渲；只有滑杆与段内进度线订阅这一只。 */
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
  /** 起播位置；`resume: 'archive'` 时只是「本书没有存档」的兜底。 */
  chapterIndex?: number
  paragraphIndex?: number
  /**
   * 位置来源：`'archive'` = 本书有服务端 listen 存档就从存档章段续听（存档缺席/读不到才用
   * chapterIndex/paragraphIndex）；`'position'`（缺省）= 用传入位置。阅读器 pill 用 position 档：
   * 起播跟随读者眼下看得见的位置，旧存档不把阅读进度拽回去；archive 档留给显式的「从上次听到处续听」。
   */
  resume?: 'archive' | 'position'
  engineId?: string
  voice?: string | null
  rate?: number
  volume?: number
}

/** 回退链用的活动缺省：served 值经 `setTtsDefaults` 推进来，内容在 wire 的 `TTS_DEFAULTS`。
 *  导出给接入层的读数映射（`config-page.ts` 的 `ttsDefaultsFromSettings`）钉形状用。 */
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
  /** 共用的消费位置：章 + 章内比例，写 `ShelfBook.progress`。与 `saveListen` 同一个落盘节拍，
   *  两笔各自尽力而为——一笔失败不该把另一笔拖住。 */
  saveProgress(bookKey: string, chapterIndex: number, offsetRatio: number): Promise<void>
  /** opts.signal = 这一发合成所属的取消位：跳段只落当前段那一只（同章预取照跑），
   *  停止 / 换书 / 换参数把整趟的（含预取）一起落下去。 */
  synthesize(req: SynthesisRequest, opts?: { signal?: AbortSignal }): Promise<SynthesisReceipt>
  /** 两条出声分支（策略面）：会话只问分支怎么起这一段 / 能提供什么 / 谁该闭嘴，
   *  不直接摸 Audio 与 Speech。生产面在 `player.ts` 组装（适配器 + 浏览器平台面）。 */
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
  /** 本章每段的合成回执（按段号缓存；引擎/音色/语速一变即清） */
  receipts: Map<number, ReceiptEntry>
  /** 本章已发过预取请求的段号（防每推进一段就重发同两条） */
  prefetched: Set<number>
  /** 已经因「回执在、字节读不出」重合成过一次的段号（每段一次，防坏音频无限重试） */
  retried: Set<number>
  /** 已预取过开头的章号（同一章不因来回进入而反复请求） */
  nextPrefetched: Set<number>
  /** 章节载入代际：迟到的正文只服务它出发时的那一趟 */
  loadSeq: number
  /** 播放代际：pause/参数变更/跳段都会抬它，迟到的合成结果据此丢弃 */
  playSeq: number
  timer: TimerState | null
  /** 本趟在途请求共用的取消位：作废时整只换掉（一只 signal 落定就回不来），新请求拿新的一半。
   *  预取链挂在**这一只**上：换参数 / 换章 / 停止都该把整章的暖缓存一起作废。 */
  abort: AbortController
  /** 当前段自己的取消位：跳段 / 章内滑杆只作废「没人再听的那一发」，同章预取不受牵连。
   *  换参数 / 换章 / 停止走 `cancelInFlight`，两只一起换（见那里的注释）。 */
  segAbort: AbortController
  /** 字节型：当前段合成请求的 playSeq 身份（无在途请求 = null）。参数变更时据此判断
   *  「加载中的这一段也要按新参数重取」——只认 `loading` 会把章正文加载误当成合成在途。 */
  synthToken: number | null
}

interface StartSeed {
  chapters: ChapterEntry[]
  chapterIndex: number
  units: string[]
}

/** 「回阅读器」的交接现场（一次性、按书键）：取走即空，两键不匹配既不消费也不应用。 */
interface PendingRelocation {
  sourceId: string
  bookKey: string
  target: ReaderRestoreTarget
}

/**
 * 听书会话：`ListenPlatform` 构造注入，全部可变现场（当前 run、代际、定时、连败、
 * 一次性重定位、活动缺省、两只 store）都是实例字段——多个实例互不串场，测试造一副
 * 假平台就能整只驱动，不必 stub 全局或 mock 网络模块。
 */
export class ListenSession {
  /** 上屏读数的主 store：视图经 `player.ts` 的 `ttsPlayer` 订阅。 */
  readonly state: Store<TtsPlayerState>
  /** 段进度独立一只 store（高频 timeupdate 不进主 store，见 `TtsProgressState` 注释）。 */
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
  /** 章正文（段域）载入在途：`paragraphIndex` / `paragraphCount` 还是**上一章**的读数，
   *  跳段与滑杆落点照它走会念错章。它是协调事实（不是渲染读数），所以不进 store：视图只看得见
   *  它推出来的 `loading` / 守卫结果。与 `loading` 分开：本段合成在途时跳段是安全的。 */
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

  /** 当前分支的能力声明（上屏读数与状态机都读它，不拿模式猜）。 */
  private capabilitiesOf(mode: BranchMode): BranchCapabilities {
    return this.branchOf(mode).capabilities
  }

  // ── 起播 / 换书 ─────────────────────────────────────────────────────────────

  /**
   * 开始听一本书：拉目录 → clamp 存档 → 拉正文切段 → 起播指定段。
   * 已在放另一本时**取到数据之后**才停旧会话（flush 旧书位置）——旧会话在取数窗口里照常放着；
   * 双书并放不在本仓的语义里，切换最终仍是单会话。
   * 失败（目录/正文拉不到、空目录）会 reject；单段合成失败不会（它走跳过径）。
   */
  async startListening(p: StartListeningInput): Promise<void> {
    await this.startSession(p)
  }

  private async startSession(p: StartListeningInput, seed?: StartSeed): Promise<void> {
    // 取数在停旧会话**之前**：旧会话继续放着，一次网络抖动不该把「按了按钮」放大成「声音全没」
    // （`playFromReadingPosition` 早就是这个次序；这里是两条起播入口共用的底层，别再各排一套）。
    const gen = ++this.runSeq
    this.ensurePagehide()

    let chapters: ChapterEntry[]
    let chapterIndex: number
    let units: string[]
    let stored: ListenState | null = null
    if (seed !== undefined) {
      chapters = seed.chapters
      chapterIndex = seed.chapterIndex
      units = seed.units
    } else {
      const [nav, entry] = await Promise.all([
        this.platform.fetchChapters(p.sourceId, p.bookKey),
        this.platform.shelfEntryOf(p.bookKey),
      ])
      if (gen !== this.runSeq) return
      chapters = nav
      stored = entry?.listen ?? null
      if (chapters.length === 0) throw new TtsPlayerError('TTS_CHAPTERS_EMPTY')
      const archive = p.resume === 'archive' ? stored : null
      chapterIndex = clampIndex(archive?.chapterIndex ?? p.chapterIndex ?? 0, chapters.length - 1)
      units = await this.platform.fetchUnits(p.sourceId, p.bookKey, chapterIndex)
      if (gen !== this.runSeq) return
    }
    if (chapters.length === 0) throw new TtsPlayerError('TTS_CHAPTERS_EMPTY')
    chapterIndex = clampIndex(chapterIndex, chapters.length - 1)
    const archive = p.resume === 'archive' ? stored : null
    const paragraphIndex = units.length === 0
      ? 0
      : clampIndex(archive?.paragraphIndex ?? p.paragraphIndex ?? 0, units.length - 1)

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
    // 源级闸门（直出型等平台把语音表交出来；字节型同步可过）：等不到才报「设备没有语音」。
    // 这一步在停旧会话之前：等不到时旧会话照常放着，不拿一次设备探测把正在放的声音停掉。
    const gate = branch.ready()
    if (gate !== true) {
      const voicesReady = await gate
      // 等待窗口里有更新的起播 / 停止：这一发已经作废，既不许拿设备事实去抛假错误
      // （`TTS_NO_VOICES` 会把「换书成功」演成失败），也不许把新会话停掉。
      if (gen !== this.runSeq) return
      if (!voicesReady) throw new TtsPlayerError('TTS_NO_VOICES')
    }
    // 数据到手才停旧会话：stop 会 flush 旧书位置并抬 `runSeq`，此后没有可被打断的 await。
    // 失败（目录/正文拉不到）在上面就抛了，旧会话原样继续放着。
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
   * 插件生命周期终点（客户端热替换 / 停用 / 升级）：把这一趟的声音与介质一起收掉。
   *
   * 与 `stopListening` 的分别：那条是**用户**的停止，会话与模块都还在，下一拍还能起播；本方法
   * 之后模块本身作废。常驻播放层跨**面板**卸载存活（`ADR-0072`），但不跨**插件**卸载——控制面
   * （听书条 / 浮窗的槽位注册）随 fiber 撤走，留下的声音没人暂停得了；而宿主热替换会把模块图
   * 重新 import 成**第二个**单例，旧会话还响着就是两路叠音。故收口不靠读数自证干净（读数说
   * 「不在放」也照样放介质），位置先落盘再停声。
   */
  dispose(): void {
    // `stopListening` 在「还没有活会话」时早退（起播取数 / 等语音表在途正是这一格），不抬代际；
    // 先自己抬一次，迟到的 `startSession` 才会在每道 `gen !== runSeq` 上退场——否则数据回来后
    // 它照常建 run、起播，卸载终点之后长出一路没人能停的声音（`ADR-0092`）。
    this.runSeq += 1
    // 停止里已 flush 位置并停声；先把这一笔冲出去，别让最后两秒的进度跟着模块一起作废
    this.stopListening()
    // 读数不是「介质已停」的证明：卸载是终点，两条分支的介质一律放掉
    this.teardownOutputs()
  }

  /** 介质与宿主挂钩的整份收尾：两条分支连槽放掉、摘 `pagehide`、清两份防抖。
   *  `dispose` 与测试复位（`resetForTests`）共用；位置与读数各由调用方处置——`dispose` 经
   *  `stopListening` 先 flush，测试复位直接作废回缺省，两条终点的差别只在那一截。 */
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
      // 暂停这条动作住分支：字节型停元素保留现场，直出型撤平台队列（它把队列表在句中途，
      // 而本层的播放单位是整段，续播会从半句接上、与 `paragraphIndex` 对不上）。
      // 收口到**两条**分支：切引擎的窗口里旧介质可能还在响，只暂停当前分支会留下「屏幕说暂停、
      // 旧声音还在念」。
      this.platform.branches.pauseAll()
    }
    // 立刻让「暂停」可见（`loading` 一并落下）：章正文在途时 `resume` 由 `chapterLoading`
    // 那道守卫挡住，不会拿旧章的段域续播；载入落地时 `stillCurrent` 已为假，停在新章段首
    // 等下一次 resume。两件事各由各的标志守，不靠把 `loading` 留浓来兼职。
    this.state.set({ playing: false, loading: false })
    this.paramsRestart.cancel()
    this.positionSave.flush()
  }

  /** 继续：有回执续播能力的分支先试原地续上同一段字节；其余（或回执不在）重新起播当前段。
   *  `loading` 期间不接——准备期里段域/介质现场还没定，照它续播会把旧现场接回来；
   *  本段合成在途时本就由会话自己在落地后起播，不必再收一次 resume。
   *  `chapterLoading` 与 `loading` 是两件事：章正文在途连「当前段」都还是上一章的。 */
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

  /** 同章内前后跳一段；在边界上跨章（向后到上一章末段，向前到下一章首段）。
   *  空章没有可跳的段：向前 / 向后都按跳章处理，别让「下一段」在这类章里按了没反应。
   *  **章正文载入在途**不接（`chapterLoading`）：那时段域还是上一章的读数，照它跳会念错章；
   *  本段合成在途则可以跳——`playSeq` 抬升会作废在途那一发，不该把按钮按成没反应。
   *  返回的 Promise 只在**跨章载入失败**时拒绝（`TTS_CHAPTER_LOAD`），同章内移动是同步落地的。 */
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

  /** 章内滑杆的落点：跳到任意段（夹紧到本章段域）并起播。与跳段同一条径——
   *  位置落盘、代际抬升、重取当前段都由它走，滑杆不另造第二套推进语义。
   *  **章正文载入在途**不接（`chapterLoading`）：那时 `paragraphCount` 还是上一章的读数；
   *  本段合成在途可以接，抬 `playSeq` 就把在途那一发作废（与跳段同一判据）。 */
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

  /** 起播章选择面的落点：换到指定章并从首段起播；选中的就是当前章时回到本章首段。
   *  载入失败按手动导航的失败半径上抛（`TTS_CHAPTER_LOAD`），不留在「停在旧章假装在放」。 */
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

  /** 前后跳一章（越界什么都不做；载入失败停住，不把播放面留在假装在放的样子）。
   *  失败按手动导航上抛 `TTS_CHAPTER_LOAD`，由界面翻人话——按了没反应是本仓最忌的空结果冒充失败。 */
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
    // 换章的决定一落下，在途的合成（本章剩余段的预取）就已经没人要了：当场掐掉，别等正文到货。
    // 正在放的那一段字节不受影响——字节型的旧音频由起播时换槽接替。
    this.cancelInFlight(run)
    // 旧声音让不让位是分支自己的事：直出型当场撤队（旧 utterance 不该继续念上一章），
    // 字节型的旧音频由起播时换槽接替（载入期间继续放，用户不会在一次跳章的等待里听见静音）。
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
      // 逐段失败的留痕随章归零，连败计数不动：章正文拉得到不等于合成能成，死引擎的失败串
      // 必须跨章累计到阈值才暂停，否则它会一章一章地空走到书末。
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
      // 空章没有「播完」事件，自动推进会连续跨过它们；但载入期间被暂停 / 跳段就必须就此停住，
      // 否则下一可读章会用新的 resumeToken 把那次暂停吞掉、自己起播（回 superseded 让 finishChapter 收口）。
      return stillCurrent ? 'moved' : 'superseded'
    } catch {
      // 与成功路径同一道闸：在途那一发已被更新的导航作废（用户又跳了章）就别翻掉新章的 loading，
      // 也别让 finishChapter 把这次陈旧失败当成「自动推进到头」而暂停掉用户的手动导航。
      if (this.current !== run || loadToken !== run.loadSeq) return 'superseded'
      // 旧音频必须当场闭嘴：`playSeq` 已抬，旧槽的 ended / timeupdate 全部作废，
      // 留着它只会变成「界面说暂停、耳朵里还在念上一章」；直出型已在入口让位过。
      this.branchOf(this.state.get().mode).pause()
      this.chapterLoading = false
      this.state.set({ loading: false, playing: false })
      // 手动导航的失败要有人告诉用户：自动推进由 finishChapter 收口成暂停，用户按下的
      // 跳章 / 起播章则把原因交回调用方（界面翻人话），不留在按了没反应。
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

  /** 章播完 → 下一章。空章（只有图 / 分隔符，无可朗读单元）没有「播完」事件：自动推进时
   *  连续跨过它们，直到找到可读章或到书末——否则播放会停在一个永远不会自己结束的章上。
   *  手动跳章不受影响（用户点名看哪一章就停在哪一章，那是他自己的导航）。 */
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
        // 被更新的手动导航作废时不替用户暂停他刚发起的那一章；其余结局（到头 / 自动载入失败）
        // 只有「本轮 moveChapter 仍是最新一发」才按自动推进到头收口。
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
    // 这一发本身就是「按当前参数起播」：把还在排队的同义重取取消，免得它两拍后打断新段。
    this.paramsRestart.cancel()
    const token = ++run.playSeq
    const st = this.state.get()
    const index = st.paragraphIndex
    const text = run.units[index]
    if (text === undefined) {
      // 空段死路同一条判据：读数写「不在放」之前先把声音收掉，别让旧介质替一个没有的段继续响。
      this.platform.branches.pauseAll()
      this.state.set({ loading: false, playing: false })
      return
    }
    const branch = this.branchOf(st.mode)
    this.state.set({ loading: true, paragraphText: text })
    this.schedulePositionSave()
    // 换段即归零（直出 / 字节同口径）：字节型合成在途的窗口里也不能把上一段的段内比例投到
    // 新段上——读数只认活槽计时，段一换旧比例就作废，不等合成落地才清。
    this.progress.set({ position: 0, duration: 0 })
    // 参数变更要按「本段合成在途」判，不能只看 `loading`（章正文载入也写这一格）。
    run.synthToken = token
    const handlers = this.segmentHandlers(run, token)
    const host: BranchHost = {
      // 回执只在「这一发仍是当前播放」时交回：合成在途时用户可能已跳章，旧章段号写进新章
      // 的 receipts 会让同号段命中旧字节、念错章（与预取同一道守卫）。
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

  /** 一段的出声回调：两条分支共用**同一套**事实语义，token 守卫在这里。
   *  - `prepared`：准备期结束（字节型交给介质时调；直出型不调，等 `start`）；
   *  - `start`：真开口 → 段记成在放、连败清零、停因消失；
   *  - `done`：这一段播完就推进（不看 `playing`：有的平台会吞掉开口事件、直接回 onend，
   *    按 `playing` 拦下会把会话永远挂在 loading 上）；
   *  - `fail`：介质没成 → 分支能自愈就先自愈一次，否则走段失败。
   *  跳段 / 换参数时旧介质还会响一小会儿，它的 ended / timeupdate 若不被拦下，会按**新**段号
   *  推进或把旧段的时间投到新段的读数上。暂停 / 续播会换发新的 handlers 并带上当前 token。 */
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
        // 「回执已发出、字节还没取」之间缓存条目被 prune 掉是可能的（读口对坏/缺条目回 404）：
        // 能自愈的分支每段重来一次——删掉旧回执、把介质的出声现场作废（同键不会重设 src，
        // 一个已 errored 的元素再 play 只会再拒），重新合成再起一段。键按内容寻址，重合成不会漂；
        // 第二次仍失败才落回「这一段跳过」的失败径，免得坏音频把同一段无限重来。
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

  /** 单段失败（合成失败 / 起播失败 / 介质读坏）：连败计数，未到线就跳过该段继续；
   *  到线则暂停并**公布停因**（`halt`）——阈值判据只此一处，上屏面不再拿计数对比阈值。 */
  private segmentFailed(run: PlayerRun): void {
    const st = this.state.get()
    const consecutive = st.consecutiveFailures + 1
    const stopped = consecutive >= TTS_MAX_CONSECUTIVE_FAILURES
    // 失败收口：这一段起播失败（合成落空 / 介质没开口）后读数写「不在放」，而切引擎窗口里旧介质
    // 可能还在念——先让两条都闭嘴再记账，别留「屏幕说停、耳朵里还在念」（与 pauseListening 同判据）。
    // 先抬 playSeq 再收口（与暂停、换章同一手法）：直出介质被 pause 会补发 canceled 事件，
    // 抬过之后它落在旧发上作废，不许再进一次失败径。
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

  /** 预取在途守卫：链回现场先问这一轮还站不站得住——run 换了、loadSeq 作废了、章挪了，
   *  在途结果一律丢弃（`stillHere` 的三份判据是同一件事，只在这造）。 */
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
    // 取消位是**异步**变的（用户随时按停止）：用函数读而不是直接读字段——直接在循环里读
    // `signal.aborted`，TS 会按第一次守卫的结论把它窄化成「恒假」，第二道守卫就成了死代码。
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
   * 换朗读源。音色 id 是引擎自己的取值，不跨引擎互通（同出声层的音色判据）：换源时把本书记住的
   * 旧 id 清掉，界面与请求都回到「该源缺省音色」，不把上一家的 id 送进新引擎。
   *
   * **换到直出源要先等语音表**（`awaitDirectVoices`）：Chromium 的 `getVoices()` 冷启动首读常是
   * 空表，拿它当场拒就把「还在加载」误报成「设备没有语音」。等不到才按 `TTS_NO_VOICES` 拒——
   * 与 `startSession` 同一条判据、同一个半径：源级的事实按源级报，不留给逐段尝试。
   */
  async setListenEngine(engineId: string): Promise<void> {
    const st = this.state.get()
    const mode = modeOf(engineId)
    const branch = this.branchOf(mode)
    if (engineId !== st.engineId) {
      // 换到这条分支前的源级闸门（直出型等语音表；字节型同步可过）。等不到才按源级事实拒。
      const gate = branch.ready()
      if (gate !== true && !(await gate)) throw new TtsPlayerError('TTS_NO_VOICES')
    }
    // 等待窗口里会话可能已经变了（暂停 / 换了别的源 / 停下）：按**落地时**的现场收口。
    // 换了书则整笔作废：切源是「点给这本书的参数」，落到另一本的会话上就是凭一次等待改掉别人的源。
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

  /** 引擎/音色/语速变了：旧回执与预载全部作废；正在放就按新模式/新参数重取当前段。
   *  `deferred` = 滑杆这类高频入口：状态与作废即时，重取走防抖，别逐档打断播放。 */
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
    // 直出型在 `onstart` 之前 playing 还是假，但 utterance 已进平台队列：只看 playing 会把
    // 旧声音留在队列里，与刚改的引擎/参数并存。`held()` 补上这一段（分支自己的现场）。
    // 字节型的合成请求在途时 playing 也还是假：`synthToken` 在且会话 loading 而**不是**章正文
    // 在途，说明这一段正在取音频，同样要按新参数重取（`chapterLoading` 是两者的分界）。
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

  /** 按**到点时刻**挂定时（`setListenTimer` 与「换起播点后复位」共用）：已过期就当场收口，
   *  不从「现在」重新充满——换起播点不是重定一次时。 */
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

  /**
   * 在**当前这本书**的会话里换到阅读位置起播：阅读器探针在场且量得到就用它；
   * 否则用书架投影的阅读进度按 `estimateParagraphIndex` 换成段号。
   * 这里只读位置；会话自己的落盘节拍负责把新起播点写回共用的 progress。
   */
  async playFromReadingPosition(): Promise<void> {
    const st = this.state.get()
    if (!st.active || st.bookKey === null || st.sourceId === null) return
    const bookKey = st.bookKey
    const sourceId = st.sourceId
    const timerChoice = st.timerChoice
    const timerEndAt = st.timerEndAt
    const base: StartListeningInput = {
      sourceId,
      bookKey,
      title: st.title,
      chapterIndex: st.chapterIndex,
      paragraphIndex: st.paragraphIndex,
      engineId: st.engineId,
      voice: st.voice,
      rate: st.rate,
      volume: st.volume,
    }
    const probe = readingProbeNow()
    let probeAt: { chapterIndex: number; paragraphIndex: number } | null = null
    if (probe !== null) {
      try { probeAt = probe() } catch { probeAt = null }
    }
    // 起播点两个来源：阅读器探针（此刻看得见的段），或书架上的阅读进度换算（探针缺席——阅读器
    // 不在场或量不到）。换算只读位置，写回归本会话正常的落盘节拍。
    type StartAt =
      | { from: 'probe'; chapterIndex: number; paragraphIndex: number }
      | { from: 'reading'; chapterIndex: number; offsetRatio: number }
    let at: StartAt
    if (probeAt !== null) {
      at = { from: 'probe', ...probeAt }
    } else {
      const entry = await this.platform.shelfEntryOf(bookKey)
      if (!this.stillOn(bookKey)) return
      // 「没进架」与「目录为空」是事实，必须说话——静默 return 就成了「按了按钮界面一动不动」，
      // 正是本仓最忌的空结果冒充做过事。
      if (entry === null) throw new TtsPlayerError('TTS_NOT_ON_SHELF')
      at = {
        from: 'reading',
        chapterIndex: entry.progress.chapterIndex,
        offsetRatio: entry.progress.offsetRatio,
      }
    }
    // 目录与段落**先取到手再换会话**（`startSession` 的底层次序与此一致）：取不到时旧会话照常
    // 放着，错误照抛——一次网络抖动不该放大成「按了按钮声音全没」。
    const chapters = await this.platform.fetchChapters(sourceId, bookKey)
    if (!this.stillOn(bookKey)) return
    if (chapters.length === 0) throw new TtsPlayerError('TTS_CHAPTERS_EMPTY')
    const chapterIndex = clampIndex(at.chapterIndex, chapters.length - 1)
    const units = await this.platform.fetchUnits(sourceId, bookKey, chapterIndex)
    if (!this.stillOn(bookKey)) return
    const paragraphIndex = at.from === 'probe'
      ? at.paragraphIndex
      : estimateParagraphIndex(at.offsetRatio, units.length)
    await this.startSession({ ...base, chapterIndex, paragraphIndex }, { chapters, chapterIndex, units })
    // 起播在途被更晚的起播取代（或用户停了）：这一发不再有权复位别人的定时。
    if (!this.stillOn(bookKey)) return
    // 定时是会话级的现场，同一本书换起播点不该顺手抹掉它；分钟档要按**原到点时刻**复位，
    // 否则「已听 5 分钟的 15 分钟定时」会重新充满（换起播点不是重定一次时）。
    if (timerChoice !== null) {
      if (timerChoice === 'chapter' || timerEndAt === null) this.setListenTimer(timerChoice)
      else this.restoreTimerAt(timerChoice, timerEndAt)
    }
  }

  /** 会话重建后的定时复位（`playFromReadingPosition` 专用）：只认到点时刻，不重算时长。 */
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
   * 为什么不是跳章：`requestJump`/`settleJump` 会把「读到第 N 章」立即写进存档——那会把一次
   * 定位动作记成一次阅读；恢复路径（cause `restore`）只站定不写，正好避开这笔幽灵写。
   *
   * 现场是**一次性的**，且**按书键**：取走即空，第二次开书回存档 progress；段号 → 比例用当前会话
   * 该章的播放单元数（`paragraphCount`）两端对齐换算，只求落回那一段附近（段高不齐，不假装像素锚点）。
   *
   * 为什么必须带 `{sourceId, bookKey}`：听书会跨书常驻，而阅读器只按「谁先打开」取现场。听书的
   * 那本若是迟迟没人开，下一本**别的**书开门就会落到别人的章段上（没写进度，但错页）。这里把交接
   * 现场记成「给哪本书的」，取用要求两键同时匹配；不匹配既**不消费也不应用**——现场留给它真正的
   * 主人，别的书照常回自己的存档 progress。
   */
  requestReaderRelocation(
    sourceId: string, bookKey: string, chapterIndex: number, paragraphIndex: number,
  ): void {
    this.pendingRelocation = {
      sourceId,
      bookKey,
      target: {
        chapterIndex,
        offsetRatio: paragraphRatio(paragraphIndex, this.state.get().paragraphCount),
      },
    }
  }

  /** 阅读器开书时按书键取走现场：两键都匹配才返回并清空；不匹配/没有现场返回 null（不消费）。 */
  takeReaderRelocation(sourceId: string, bookKey: string): ReaderRestoreTarget | null {
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

  /** 位置落盘的唯一出口：同一个节拍写两笔——listen（段号 + 播放参数）与 progress（章 + 比例）。
   *  两笔都是尽力而为：一笔失败不打断播放，也不拖住另一笔；下一笔位置会各自再试。 */
  private async writePosition(): Promise<void> {
    const st = this.state.get()
    if (!st.active || st.bookKey === null) return
    const offsetRatio = paragraphRatio(st.paragraphIndex, st.paragraphCount)
    await Promise.all([
      this.platform.saveListen(st.bookKey, {
        chapterIndex: st.chapterIndex,
        paragraphIndex: st.paragraphIndex,
        engineId: st.engineId,
        voice: st.voice,
        rate: st.rate,
        volume: st.volume,
      }).catch(() => undefined),
      this.platform.saveProgress(st.bookKey, st.chapterIndex, offsetRatio).catch(() => undefined),
    ])
  }

  private ensurePagehide(): void {
    if (this.unwatchPageHide !== null) return
    this.unwatchPageHide = this.platform.watchPageHide(() => { this.positionSave.flush() })
  }

  /** 测试用的整份复位：作废在途会话、清定时与降级窗、回缺省值。
   *  生产路径**不**调它——面板卸载不是复位时机（`ADR-0072`：会话跨面板卸载存活），插件卸载走
   *  `dispose`。 */
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

  /** 作废本趟在途的合成请求，并换上一只新的取消位。
   *  只在「这些请求的结果再也不会被这一趟用到」时按：停止 / 复位、换参数（旧参数的字节作废）、
   *  换章（上一章的预取作废）。**暂停不在其列**——续播要接的正是那一发，掐掉它等于把
   *  「暂停一下」变成「整段重合成」。整趟作废连同当前段那一只一起换（跳段只走
   *  `cancelCurrentSegment`，预取不受牵连）。 */
  private cancelInFlight(run: PlayerRun): void {
    run.abort.abort()
    run.abort = new AbortController()
    run.segAbort.abort()
    run.segAbort = new AbortController()
  }

  /** 作废当前段那一发（跳段 / 章内滑杆）：没人再听的是**这一段**，同章预取暖的是接下来还要放的
   *  段，不能连坐。换到新的段后主播放径拿新的一半，旧的那一发作废在上游。 */
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

  /** 取一段的回执（主播放径与预取共用）。`signal` 是调用方出发时那一只（主播放径给当前段的
   *  `segAbort`、预取给整趟的 `abort`；都不是字段的当前值——中途换参数已经换成新的了），
   *  它随请求下传，作废时那一发跟着停。 */
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
    // 预取是 fire-and-forget：请求在途时用户可能已跳章，旧章的段号不能写进新章的
    // receipts（同号段会被当成新章的回执直接起播）。
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
