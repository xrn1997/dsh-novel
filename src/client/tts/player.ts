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
import { createListenBranches } from './playback-branches.js'
import { readerPresence } from './reader-presence.js'
import type {
  ListenPlatform, StartFromReadingPositionInput, StartListeningInput, TtsDefaults,
} from './listen-session.js'
import type { ReaderRevealTarget } from '../reader-session.js'

/**
 * 听书播放层的**生产外观**：平台真实现（api / 书架投影 / util 防抖 / 惰性全局面）+ 一个
 * `ListenSession` 单例 + 视图认识的那组同名导出。状态机与出声适配器住 `listen-session.ts`。
 *
 * 为什么平台在这：会话只经 `ListenPlatform` 缝触达外界，缝的生产实现必须**惰性**——`Audio` /
 * `speechSynthesis` 在调用时取、api 在调用时发，模块初始化时捕获会让测试的行为网全红。
 * 位置单轨与常驻生命周期见 `ADR-0072` / `ADR-0078`。
 */

export { TTS_MAX_CONSECUTIVE_FAILURES, TtsPlayerError } from './listen-session.js'
export type {
  TtsPlayerErrorCode, TtsPlayerState, TtsProgressState, StartListeningInput,
  StartFromReadingPositionInput, TtsDefaults,
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

/** 直出源「语音表准备好了吗」的等待预算。Chromium 冷启动首读常给空表，真表随 `voiceschanged`
 *  迟到；拿首读判「设备没有语音」会把异步加载误报成设备事实。 */
export const DIRECT_VOICES_WAIT_MS = 1500

/** 等平台把语音表交出来：现在有 → 立刻 true；否则订 `voiceschanged`，到点再读一次。
 *  返回 false = 这台设备**确实**没有可用的浏览器语音。 */
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
 * 浏览器音色表的唯一映射：`id` 取 `voiceURI`（匹配也只认它；`name` 可重名）。
 * 按 `voiceURI` 去重：界面选得中的必须就是实际命中的那一支（同名多语区 / 本地远端同 URI）。
 * 带上 `lang`：平台表横跨多种语言、名字常是厂商昵称，只给名字等于让用户盲选。
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

/** 平台音色表的现场：冷启动时 `getVoices()` 可能给空表，真表随 `voiceschanged` 才到。
 *  读数住 store，事件到了刷新，视图订阅它。 */
export const directVoicesStore = createStore<{ list: DirectVoice[] }>({ list: [] })

/** 平台事件面按本地窄镜像取：测试替身与缺席环境未必有 EventTarget，不让 lib.dom 替运行时作保。 */
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

let branches: ListenPlatform['branches'] | null = null

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
   * 本书的书架读数：**每次向服务端取**（存档真相在服务端）。不复用面板投影：那是挂载期快照，
   * 「听 → 停 → 再听」会退回本章 0 段。读失败如实抛，不折成 `null`——那会把网络错误伪装成
   * 「这本书不在架」。
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
  /** 本书的阅读器子树是否在场：在场时 progress 归阅读会话（ADR-0093），播放层只写 listen。 */
  readerPresent: (bookKey) => readerPresence.get().bookKeys.includes(bookKey),
  synthesize: (req, opts) => apiSend<SynthesisReceipt>(
    ROUTES.ttsSynthesize, bodies.ttsSynthesize(req), opts?.signal),
  get branches(): ListenPlatform['branches'] {
    // 会话构造时要读当前分支的能力初值，故首次访问时组装一次并复用（适配器构造不碰全局）。
    branches ??= createListenBranches(
      { bytes: new BytesOutput(audioFace), direct: new DirectOutput(directFace, after) },
      () => awaitDirectVoices(),
    )
    return branches
  },
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

/** 「从阅读位置起播」的唯一入口：位置来源链归会话，视图只交书身份与可选兜底。 */
export function startFromReadingPosition(p: StartFromReadingPositionInput): Promise<void> {
  return session.startFromReadingPosition(p)
}

export function requestReaderRelocation(
  sourceId: string, bookKey: string, chapterIndex: number, paragraphIndex: number,
): void {
  session.requestReaderRelocation(sourceId, bookKey, chapterIndex, paragraphIndex)
}

export function takeReaderRelocation(sourceId: string, bookKey: string): ReaderRevealTarget | null {
  return session.takeReaderRelocation(sourceId, bookKey)
}

/** 插件生命周期终点（热替换 / 停用 / 升级）：停声、放掉介质；只由接线层 fiber 清理调（`ADR-0072`）。 */
export function disposeTtsPlayer(): void { session.dispose() }

/** 测试用整份复位；生产只有 `disposeTtsPlayer` 一条终点（`ADR-0092`）。 */
export function resetTtsPlayerForTests(): void { session.resetForTests() }
