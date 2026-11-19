import { vi } from 'vitest'

/**
 * 浏览器出声面替身的唯一住址：`Audio` / `SpeechSynthesisUtterance` / `speechSynthesis`
 * 三条平台面只演播放层消费的那一面，两条分支的行为网共用——别在用例里再各造一份形状略异的
 * 替身：形状漂移没有编译信号，只会变成假红 / 假绿（判据同 `fake-host.ts`）。
 */

export class FakeAudio {
  static instances: FakeAudio[] = []

  /** 介质永远起不来（`play()` 一律拒绝）：演「每一段音频都没开口」的机器。 */
  static playFails = false

  static reset(): void {
    FakeAudio.instances = []
    FakeAudio.playFails = false
  }

  private srcValue = ''
  /** 赋过 `src` 的序列：预载 404 之后，下一次起播必须重新赋一次 `src`——同键不重设就会对着
   *  一个 errored 元素再 `play()`，浏览器只会再拒。 */
  readonly srcSets: string[] = []
  volume = 1
  preload = ''
  paused = true
  currentTime = 0
  duration = 0
  /** `fireError()` 之后介质进入错误态：不重新赋 `src` 的 `play()` 会拒绝（真浏览器同此）。 */
  errored = false
  onended: (() => void) | null = null
  onerror: (() => void) | null = null
  onplaying: (() => void) | null = null
  ontimeupdate: (() => void) | null = null
  onloadedmetadata: (() => void) | null = null

  constructor() { FakeAudio.instances.push(this) }

  get src(): string { return this.srcValue }

  set src(value: string) {
    this.srcValue = value
    this.srcSets.push(value)
    this.errored = false
  }

  play = vi.fn(async () => {
    if (FakeAudio.playFails || this.errored) throw new Error('media error')
    this.paused = false
    this.onplaying?.()
  })

  pause = vi.fn(() => { this.paused = true })

  /** 停播时播放层会摘 `src` 松开缓冲（`removeAttribute` + `load` 那一对，不是赋空串） */
  removeAttribute = vi.fn()

  load = vi.fn()

  /** 像真介质那样播到末尾：置暂停并补发 `ended`。 */
  fireEnded(): void {
    this.paused = true
    this.onended?.()
  }

  /** 像真介质那样读坏：置错误态并补发 `error`（之后 `play()` 会拒绝，直到重新赋 `src`）。 */
  fireError(): void {
    this.paused = true
    this.errored = true
    this.onerror?.()
  }
}

export class FakeVoice {
  readonly voiceURI: string
  readonly name: string
  /** 真平台每支音色都带语区（`zh-CN` / `en-US` 这类）：音色行的可读性靠它，替身不演就量不到。 */
  readonly lang: string

  constructor(voiceURI: string, name: string, lang = 'zh-CN') {
    this.voiceURI = voiceURI
    this.name = name
    this.lang = lang
  }
}

export class FakeUtterance {
  static instances: FakeUtterance[] = []

  static reset(): void { FakeUtterance.instances = [] }

  readonly text: string
  voice: FakeVoice | null = null
  rate = 1
  volume = 1
  onstart: (() => void) | null = null
  onend: (() => void) | null = null
  onerror: ((event: { error: string }) => void) | null = null

  constructor(text: string) {
    this.text = text
    FakeUtterance.instances.push(this)
  }
}

export interface FakeSpeechOptions {
  /** 开口即补发 utterance 的 `onstart`：真平台的开口是异步事件，缺省替身把它留给定用
   *  例自己拨（验准备期窗口时需要「还没开口」的那一格）；不需要拨窗的用例用这一档。 */
  autoStart?: boolean
}

export class FakeSpeechSynthesis {
  voices: FakeVoice[] = []
  active: FakeUtterance | null = null
  /** 真平台的自报读数：开口兜底问的就是这两个（慢 ≠ 没开口）。 */
  speaking = false
  pending = false
  /** 交给平台的 utterance 清单（按开口顺序）：验证「谁开口」不必反推 `active`。 */
  readonly spoken: FakeUtterance[] = []
  cancelCount = 0
  private readonly autoStart: boolean
  private readonly voicesChanged = new Set<() => void>()

  constructor(options: FakeSpeechOptions = {}) {
    this.autoStart = options.autoStart ?? false
  }

  getVoices = vi.fn((): FakeVoice[] => this.voices)

  speak = vi.fn((utterance: FakeUtterance): void => {
    this.active = utterance
    this.spoken.push(utterance)
    this.speaking = true
    if (this.autoStart) utterance.onstart?.()
  })

  /** `cancel` 像真平台那样给在播 utterance 补一发 `canceled` 错误：自撤的补发事件靠播放代际作废。 */
  cancel = vi.fn((): void => {
    this.cancelCount += 1
    const active = this.active
    this.active = null
    this.speaking = false
    active?.onerror?.({ error: 'canceled' })
  })

  addEventListener = vi.fn((type: string, listener: () => void): void => {
    if (type === 'voiceschanged') this.voicesChanged.add(listener)
  })

  removeEventListener = vi.fn((type: string, listener: () => void): void => {
    if (type === 'voiceschanged') this.voicesChanged.delete(listener)
  })

  /** 像真平台那样广播「语音表变了」：等待中的 `awaitDirectVoices` 靠这一发收口。 */
  emitVoicesChanged(): void {
    for (const listener of [...this.voicesChanged]) listener()
  }
}