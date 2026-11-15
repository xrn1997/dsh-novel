import type { DirectListenOutput, DirectSegment, OutputHandlers } from './output-contract.js'

/**
 * 直出型出声适配器：一支 utterance 的生命周期与开口兜底都住这里。
 *
 * 开口兜底：有的平台上 `cancel()` 与紧随其后的 `speak()` 同帧相遇时，可能整支吞掉
 * ——`onstart` / `onend` / `onerror` 一个都不来。没有事件就没有任何收口：`loading` 永远是真的，
 * 而 `resumeListening` 与 `chapterLoading`/`loading` 两道闸会把用户困在「只剩停止」，
 * 看起来就是「换了个声音之后听书坏了」。到点问平台一句「还在念吗」：答否就按平台侧中断走
 * 既有的失败径（留痕、跳过、连败到线才停），答是就等它的事件——慢不等于没开口。
 *
 * `PlatformVoice` / `PlatformUtterance` / `DirectSpeechFace` 是 SpeechSynthesis 的**窄镜像**：
 * 只收会话真正消费的那一面，生产面（懒取全局、造真 utterance）住 `player.ts`。
 */

/** 直出能力的平台面（窄镜像）：会话与出声层只用这几件，不让 lib.dom 的声明替运行时作保。 */
export interface PlatformVoice { readonly voiceURI: string }

export interface PlatformUtterance {
  voice: PlatformVoice | null
  rate: number
  volume: number
}

/** 一支 utterance 的三条事件面：由平台面接好（真平台的事件签名比这宽），出声层只看回调。 */
export interface DirectUtteranceHandlers {
  onStart(): void
  onEnd(): void
  onError(): void
}

export interface DirectSpeechFace {
  /** 平台音色表（缺席环境回空表 = 没有直出能力）。 */
  voices(): readonly PlatformVoice[]
  newUtterance(text: string, handlers: DirectUtteranceHandlers): PlatformUtterance
  speak(utterance: PlatformUtterance): void
  cancel(): void
  /** 平台自报读数：开口兜底问的就是这两个（慢 ≠ 没开口）。 */
  speaking(): boolean
  pending(): boolean
}

/** 直出型开口兜底的时限（毫秒）：正常开口在几百毫秒内落地，两秒还没有任何事件、平台又自报
 *  没在念，就是这支 utterance 被吞了——按一次平台侧中断收口，比把会话永久挂在加载中好。 */
const DIRECT_START_TIMEOUT_MS = 2000

export class DirectOutput implements DirectListenOutput {
  private readonly face: DirectSpeechFace
  private readonly after: (ms: number, cb: () => void) => () => void
  /** 在途 utterance 的身份：换段 / 撤回都抬它，迟到的事件与开口兜底死在这道守卫上。 */
  private seq = 0
  private watchCancel: (() => void) | null = null

  constructor(face: DirectSpeechFace, after: (ms: number, cb: () => void) => () => void) {
    this.face = face
    this.after = after
  }

  start(seg: DirectSegment, handlers: OutputHandlers): void {
    const seq = ++this.seq
    const utterance = this.face.newUtterance(seg.text, {
      onStart: () => {
        if (this.seq !== seq) return
        this.settleWatch()
        handlers.start?.()
      },
      onEnd: () => {
        if (this.seq !== seq) return
        this.settleWatch()
        handlers.done()
      },
      onError: () => {
        if (this.seq !== seq) return
        this.settleWatch()
        handlers.fail()
      },
    })
    const voices = this.face.voices()
    utterance.voice = seg.voice === null
      ? null
      : voices.find((voice) => voice.voiceURI === seg.voice) ?? null
    utterance.rate = seg.rate
    utterance.volume = seg.volume
    this.face.speak(utterance)
    this.settleWatch()
    this.armWatch(seq, handlers)
  }

  /** 撤掉在播段：取消平台队列是唯一手段（暂停为什么不用平台的 pause 见会话侧注释）。 */
  pause(): void {
    this.face.cancel()
  }

  stop(): void {
    this.face.cancel()
    this.settleWatch()
  }

  release(): void {
    this.face.cancel()
    this.settleWatch()
  }

  /** 直出型没有可调的活介质：utterance 的音量在开口时定死，改动从下一段起生效。 */
  setVolume(): void { /* 无活介质可落 */ }

  /** 开口兜底定时器：`onstart` / `onend` / `onerror` 任一落地即撤；换段那一发自己会撤掉旧的那枚。 */
  private armWatch(seq: number, handlers: OutputHandlers): void {
    this.watchCancel = this.after(DIRECT_START_TIMEOUT_MS, () => {
      this.watchCancel = null
      if (this.seq !== seq) return
      if (this.face.speaking() || this.face.pending()) return
      handlers.fail()
    })
  }

  private settleWatch(): void {
    this.watchCancel?.()
    this.watchCancel = null
  }
}