import { chapterContentToText, splitParagraphs } from '../../shared/chapter-text.js'
import { ROUTES, bodies, paramOps, queries } from '../../shared/wire.js'
import type {
  BookNavigation, ChapterContent, ShelfEntry, SynthesisReceipt,
} from '../../shared/wire.js'
import { apiGet, apiSend } from '../api.js'
import { patchPanelShelfProgress } from '../panel-shelf.js'
import { createStore } from '../store.js'
import { debounce } from '../util.js'
import { BytesOutput } from './bytes-output.js'
import type { AudioFace } from './bytes-output.js'
import { DirectOutput } from './direct-output.js'
import type { DirectSpeechFace } from './direct-output.js'
import { ListenSession } from './listen-session.js'
import type {
  ListenPlatform, StartListeningInput, TtsDefaults,
} from './listen-session.js'
import type { ReaderRestoreTarget } from '../reader-session.js'

/**
 * 听书播放层的**生产外观**：平台真实现（api / 书架投影 / wire 构造器 / util 防抖 / 惰性
 * 全局面）+ 一个 `ListenSession` 单例 + 视图认识的那组同名导出。状态机与出声适配器
 * 住 `client/tts/listen-session.ts`，本文件不持语义。
 *
 * 为什么平台在这：会话只经 `ListenPlatform` 缝触达外界，缝的生产实现必须是**惰性**的——
 * `Audio` / `speechSynthesis` 在调用时取、api 在调用时发，不在模块初始化时捕获（测试在
 * 导入后才 stub 全局与 mock api，初始化时捕获会让行为网全红）。
 *
 * 位置单轨与常驻生命周期的口径在会话侧注释与 `ADR-0072` / `ADR-0078`：模块级单例跨面板
 * 卸载存活；阅读进度是阅读与听书共用的消费位置，听书落盘在同一节拍里写 progress 与 listen。
 */

export { TTS_MAX_CONSECUTIVE_FAILURES, TtsPlayerError } from './listen-session.js'
export type {
  TtsPlayerErrorCode, TtsPlayerState, TtsProgressState, StartListeningInput, TtsDefaults,
} from './listen-session.js'

// ── 平台音色表（直出型的展示面）──────────────────────────────────────────────

/** 平台音色的一行：`lang` 是浏览器给的语区标签（`zh-CN` / `en-US` 这类），不是本仓编的字段。 */
export interface DirectVoice {
  id: string
  name: string
  lang: string
}

/** 浏览器语音平台读数：缺席（非浏览器环境 / 平台没实现）一律当「没有直出能力」。 */
function browserSpeech(): SpeechSynthesis | null {
  if (typeof globalThis.speechSynthesis === 'undefined') return null
  return globalThis.speechSynthesis
}

function browserSpeechVoices(): SpeechSynthesisVoice[] {
  // 平台读数会抛（权限策略 / 被禁用的环境）：读数失败按「此刻没有」处理，不把一次探测炸成起播失败。
  try {
    return browserSpeech()?.getVoices() ?? []
  } catch {
    return []
  }
}

/**
 * 直出源「语音表准备好了吗」的等待预算。**这不是随便挑的耐心值**：Chromium 的
 * `getVoices()` 在冷启动时**首次常给空表**，真表随 `voiceschanged` 迟到（本机实测：首读 0，
 * 事件后 6 支）。拿首读判「设备没有语音」会把一次异步加载误报成设备事实，用户看到的正是
 * 「当前设备没有可用的浏览器语音」——而稍等一拍就有一整张表。
 */
export const DIRECT_VOICES_WAIT_MS = 1500

/**
 * 等平台把语音表交出来：现在就有 → 立刻 true；否则订 `voiceschanged`，到点再读一次
 * （首读本身常是触发器；事件若在订阅前就发过，末尾的补读兜住）。
 * 返回 false = 这台设备**确实**没有可用的浏览器语音（或平台根本没有这个面）。
 */
export function awaitDirectVoices(): Promise<boolean> {
  const ready = (): boolean => browserSpeechVoices().length > 0
  if (ready()) return Promise.resolve(true)
  const speech = browserSpeech() as unknown as VoicesEvents | null
  if (speech === null) return Promise.resolve(false)
  return new Promise<boolean>((resolve) => {
    let settled = false
    let cancelTimer: (() => void) | null = null
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      cancelTimer?.()
      speech.removeEventListener?.('voiceschanged', onChanged)
      resolve(ok)
    }
    const onChanged = (): void => { finish(ready()) }
    // 先排死线再订阅：订阅方若同步回调，`finish` 里已有可取消的计时器。
    cancelTimer = after(DIRECT_VOICES_WAIT_MS, () => { finish(ready()) })
    speech.addEventListener?.('voiceschanged', onChanged)
    if (ready()) finish(true)
  })
}

/**
 * 浏览器音色表的唯一映射：`id` 取 `voiceURI`（匹配也只认它；`name` 可重名）。直出分支的音色匹配与
 * 听书面的音色行共用这一份，别处不再各写一次投影。
 *
 * 两件事在这份投影里就定掉，留给界面的是「读得懂的一张表」：
 * - **按 `voiceURI` 去重**：`voiceOf` 按 id 取第一支，同 id 的第二行（同名多语区，或本地 /
 *   远端各给一份同 URI）在界面上选得中、实际永远命中第一支——看得见的选项和用得上的
 *   对象不能是两回事。
 * - **带上 `lang`**：平台表里几十支音色横跨多种语言，名字又常常是厂商昵称，只给名字等于让用户
 *   盲选——挑中一支英文音色念中文，出声就是用户口中的「这家的音色坏了」。语区是这一行的
 *   身份的一半，不是装饰。
 */
export function browserTtsVoices(): DirectVoice[] {
  const seen = new Set<string>()
  const out: DirectVoice[] = []
  for (const voice of browserSpeechVoices()) {
    if (seen.has(voice.voiceURI)) continue
    seen.add(voice.voiceURI)
    out.push({ id: voice.voiceURI, name: voice.name, lang: voice.lang })
  }
  return out
}

/**
 * 平台音色表的现场（直出型）：平台冷启动时 `getVoices()` 可能给空表，真表随
 * `voiceschanged` 才到——只在渲染里同步量一次，音色那一行就会永远藏掉（空表 ≠ 没有这行）。
 * 读数住 store，事件到了刷新，视图订阅它。
 */
export const directVoicesStore = createStore<{ list: DirectVoice[] }>({ list: [] })

/** 平台事件面按本地窄镜像取：真 `SpeechSynthesis` 是 EventTarget，测试替身与缺席环境未必有，
 *  不让 lib.dom 的声明替运行时作保（同 `client/util.ts` 的 `ls`）。 */
interface VoicesEvents {
  addEventListener?: (type: 'voiceschanged', listener: () => void) => void
  removeEventListener?: (type: 'voiceschanged', listener: () => void) => void
}

/** 补一次量并订 `voiceschanged`，返回退订；没有直出能力时只补量，不炸。 */
export function watchDirectVoices(): () => void {
  directVoicesStore.set({ list: browserTtsVoices() })
  const speech = browserSpeech() as unknown as VoicesEvents | null
  if (speech === null) return () => { }
  const onChange = (): void => { directVoicesStore.set({ list: browserTtsVoices() }) }
  speech.addEventListener?.('voiceschanged', onChange)
  return () => { speech.removeEventListener?.('voiceschanged', onChange) }
}

// ── 平台缝的生产实现（惰性触达环境）──────────────────────────────────────────

/** 音频槽：`new Audio` 只在会话第一次出声 / 预载时发生，构造面本身不碰全局。 */
const audioFace: AudioFace = { create: () => new Audio() }

/** 直出面：音色、造句、开口、撤队与「还在念吗」都在调用时读全局。 */
const directFace: DirectSpeechFace = {
  voices: () => browserSpeechVoices(),
  newUtterance: (text, handlers) => {
    const utterance = new SpeechSynthesisUtterance(text)
    utterance.onstart = () => handlers.onStart()
    utterance.onend = () => handlers.onEnd()
    utterance.onerror = () => handlers.onError()
    return utterance
  },
  speak: (utterance) => {
    // 面回吐的正是上面造出来的那支真 utterance，这里只是把窄类型收窄回去交给平台
    browserSpeech()?.speak(utterance as SpeechSynthesisUtterance)
  },
  cancel: () => { browserSpeech()?.cancel() },
  speaking: () => browserSpeech()?.speaking ?? false,
  pending: () => browserSpeech()?.pending ?? false,
}

function after(ms: number, cb: () => void): () => void {
  const handle = setTimeout(cb, ms)
  return () => { clearTimeout(handle) }
}

function watchPageHide(cb: () => void): () => void {
  if (typeof window === 'undefined') return () => { }
  window.addEventListener('pagehide', cb)
  return () => { window.removeEventListener('pagehide', cb) }
}

let outputs: ListenPlatform['outputs'] | null = null

const prodListenPlatform: ListenPlatform = {
  fetchChapters: async (sourceId, bookKey) => {
    const nav = await apiGet<BookNavigation>(queries.navigation({ sourceId, url: bookKey }))
    return nav.chapters
  },
  fetchUnits: async (sourceId, bookKey, index) => {
    const content = await apiGet<ChapterContent>(queries.chapter({ sourceId, url: bookKey, index }))
    return splitParagraphs(chapterContentToText(content))
  },
  /**
   * 本书的书架读数：**每次向服务端取**（存档真相在服务端）。
   * 为什么不复用面板投影（`panelShelf`）：它是面板挂载期的快照，听书写入只落服务端——
   * 「听 → 停 → 再听」同一面板里再来一次时，投影里还是开工前那份（或缺 `listen`），
   * 续听会退回本章 0 段。读失败也如实抛给调用方，不折成 `null`——那会把网络错误伪装成
   * 「这本书不在架」，用户看到一句错误的诊断。
   */
  shelfEntryOf: async (bookKey) => {
    const list = await apiGet<ShelfEntry[]>(ROUTES.shelf.path)
    return list.find((b) => b.bookKey === bookKey) ?? null
  },
  saveListen: (bookKey, listen) => apiSend(paramOps.shelfPut.at(bookKey), bodies.shelfListen(listen)),
  /** 共用消费位置的写口：服务端落盘成功后把当前面板投影同步到新位置（可丢弃投影，真相仍在服务端）。 */
  saveProgress: async (bookKey, chapterIndex, offsetRatio) => {
    await apiSend(paramOps.shelfPut.at(bookKey), bodies.shelfProgress(chapterIndex, offsetRatio))
    patchPanelShelfProgress(bookKey, chapterIndex, offsetRatio)
  },
  synthesize: (req) => apiSend<SynthesisReceipt>(ROUTES.ttsSynthesize, bodies.ttsSynthesize(req)),
  get outputs(): ListenPlatform['outputs'] {
    // 惰性构造：两只适配器的构造面都不碰全局，第一次真正出声（或复位缝被调）才落生
    outputs ??= { bytes: new BytesOutput(audioFace), direct: new DirectOutput(directFace, after) }
    return outputs
  },
  awaitDirectVoices: () => awaitDirectVoices(),
  now: () => Date.now(),
  after,
  watchPageHide,
  debounce,
}

// ── 单例与同名导出外观（视图与既有测试的 import 一行不改）────────────────────

const session = new ListenSession(prodListenPlatform)

/** 模块级 store：视图经 `useStore(ttsPlayer)` 订阅；动作是裸函数（不挂在 store 上）。 */
export const ttsPlayer = session.state
export const ttsProgress = session.progress

export function startListening(p: StartListeningInput): Promise<void> {
  return session.startListening(p)
}

export function stopListening(): void { session.stopListening() }

export function pauseListening(): void { session.pauseListening() }

export function resumeListening(): void { session.resumeListening() }

export function skipParagraph(delta: 1 | -1): Promise<void> { return session.skipParagraph(delta) }

export function seekParagraph(index: number): void { session.seekParagraph(index) }

export function jumpToChapter(index: number): Promise<void> { return session.jumpToChapter(index) }

export function skipChapter(delta: 1 | -1): Promise<void> { return session.skipChapter(delta) }

export function setListenRate(rate: number): void { session.setListenRate(rate) }

export function setListenVolume(volume: number): void { session.setListenVolume(volume) }

export function setListenVoice(voice: string | null): void { session.setListenVoice(voice) }

export function setListenEngine(engineId: string): Promise<void> { return session.setListenEngine(engineId) }

export function setListenTimer(minutes: number | 'chapter' | null): void {
  session.setListenTimer(minutes)
}

export function setTtsDefaults(p: Partial<TtsDefaults>): void { session.setTtsDefaults(p) }

export async function playFromReadingPosition(): Promise<void> {
  await session.playFromReadingPosition()
}

export function requestReaderRelocation(
  sourceId: string, bookKey: string, chapterIndex: number, paragraphIndex: number,
): void {
  session.requestReaderRelocation(sourceId, bookKey, chapterIndex, paragraphIndex)
}

export function takeReaderRelocation(sourceId: string, bookKey: string): ReaderRestoreTarget | null {
  return session.takeReaderRelocation(sourceId, bookKey)
}

/** 测试用的整份复位：作废在途会话、清定时与降级窗、回缺省值。
 *  生产路径**不**调它——`ADR-0072` 定的就是会话跨面板卸载存活，面板卸载不是一条复位时机；
 *  `pagehide` 监听与 Audio 槽因此各只在本页生命周期内建一次。 */
export function resetTtsPlayer(): void { session.reset() }
