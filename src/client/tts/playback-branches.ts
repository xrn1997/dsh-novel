import type {
  BranchCapabilities, BranchHost, BranchStartOutcome, BytesListenOutput, DirectListenOutput,
  ListenBranches, OutputHandlers, PlaybackBranch, ResumeSegment, SegmentJob,
} from './output-contract.js'

/**
 * 两条出声分支的**策略实现**：介质适配器（`bytes-output.ts` / `direct-output.ts`）之上的那一层，
 * 回答这条分支的四个问题——准备这一段（合成回执 / 音色参数 / 静音另一条分支）、能提供什么
 * （能力声明）、静音另一条分支（起播先让它闭嘴）、重来的许可（回执续播 / 介质在途判据）。
 *
 * 为什么单独成层而不是塞进会话：这些判据若散在状态机里，每条分支的差异都会长在调用序列中间，
 * 「哪些步骤是分支差异」只活在注释里；加第三条声道要改状态机的多处方法。搬到分支之后，
 * 新声道 = 一个分支实现 + 一处注册，状态机一行不动。
 *
 * 会话**不**被替代：单元状态机、连败暂停、定时、位置落盘、两只 AbortController 仍住
 * `listen-session.ts`；回执缓存与取消管路也留在那里（`ADR-0081` / `ADR-0082` 的锚点不搬），
 * 分支只经 `BranchHost.receipt` 消费会话算好的回执。分支不读 store、不写盘、不推进段号。
 */

const BYTES_CAPABILITIES: BranchCapabilities = {
  segmentProgress: true,
  prefetch: true,
  receiptResume: true,
  selfHeal: true,
  voiceTable: 'engine',
}

const DIRECT_CAPABILITIES: BranchCapabilities = {
  segmentProgress: false,
  prefetch: false,
  receiptResume: false,
  selfHeal: false,
  voiceTable: 'platform',
}

/** 字节型分支：准备 = 求合成回执（缓存与代际归会话）+ 把键 / 补速 / 音量交给两槽适配器。 */
export class BytesBranch implements PlaybackBranch {
  readonly capabilities = BYTES_CAPABILITIES
  private readonly output: BytesListenOutput
  private readonly peer: () => PlaybackBranch

  constructor(output: BytesListenOutput, peer: () => PlaybackBranch) {
    this.output = output
    this.peer = peer
  }

  /** 字节型没有源级前置条件：合成请求成不成在逐段准备时说（失败半径是那一段）。 */
  ready(): true {
    return true
  }

  async start(
    job: SegmentJob, handlers: OutputHandlers, host: BranchHost,
  ): Promise<BranchStartOutcome> {
    // 取消不是失败（`ADR-0082` 决定 5）：这一发被作废时静默收口，别记成引擎连败。
    let receipt: Awaited<ReturnType<BranchHost['receipt']>>
    try {
      receipt = await host.receipt(job)
    } catch {
      return job.signal.aborted ? 'cancelled' : 'failed'
    }
    // 会话在回执落地后告诉我们「这一发已作废」（跳章 / 换参数 / 停止）——晚到的字节不交给介质。
    if (receipt === null) return 'cancelled'
    // 出字节的声音之前先让另一条分支闭嘴：从直出切回字节时它可能还在念。
    this.peer().pause()
    try {
      this.output.start(
        {
          key: receipt.key,
          // 音量在守卫后活读：合成在途的窗口里音量条还能动，入口快照会把用户刚拖到的值盖回去
          volume: host.voice().volume,
          playbackRate: receipt.playbackRate,
          resume: false,
        },
        handlers,
      )
    } catch {
      return 'failed'
    }
    // 「已交给介质」：字节型的 loading 使命到这一步结束（出声本身由介质的 start / fail 事件收口）。
    handlers.prepared?.()
    return 'started'
  }

  resume(seg: ResumeSegment, handlers: OutputHandlers): boolean {
    if (!this.output.holds(seg.key)) return false
    this.output.start(
      { key: seg.key, volume: seg.volume, playbackRate: seg.playbackRate, resume: true },
      handlers,
    )
    return true
  }

  /** 字节型的旧音频由起播时换槽接替，载入期间继续放（用户不会在一次跳章的等待里听见静音）。 */
  yieldForLoad(): void { /* 不打断在播音频 */ }

  pause(): void { this.output.pause() }

  stop(): void { this.output.stop() }

  release(): void { this.output.release() }

  setVolume(volume: number): void { this.output.setVolume(volume) }

  invalidate(): void { this.output.invalidate() }

  preload(key: string): void { this.output.preload(key) }

  dropPreload(): void { this.output.dropPreload() }

  /** 合成在途由会话的 `synthToken` 判，字节目的介质本身不占「在放」这一档。 */
  held(): boolean { return false }
}

/** 直出型分支：准备 = 过平台音色（源级闸门在 `ready`）、把 utterance 交给浏览器开口。 */
export class DirectBranch implements PlaybackBranch {
  readonly capabilities = DIRECT_CAPABILITIES
  private readonly output: DirectListenOutput
  private readonly awaitVoices: () => Promise<boolean>
  private readonly peer: () => PlaybackBranch
  /** 已交给平台、尚未收口的 utterance：`playing` 在 onstart 之前是假，重启判据得认这一格。 */
  private active = false

  constructor(
    output: DirectListenOutput,
    deps: { awaitVoices: () => Promise<boolean>; peer: () => PlaybackBranch },
  ) {
    this.output = output
    this.awaitVoices = deps.awaitVoices
    this.peer = deps.peer
  }

  /** 源级闸门：等平台把语音表交出来（Chromium 首读常为空，真表随 `voiceschanged` 迟到）。 */
  ready(): Promise<boolean> {
    return this.awaitVoices()
  }

  start(job: SegmentJob, handlers: OutputHandlers, host: BranchHost): BranchStartOutcome {
    // 换出声介质时另一条分支与自己的旧 utterance 都必须先闭嘴：两句叠音比一句不响更难解释。
    this.peer().pause()
    this.output.pause()
    this.active = false
    const { voice, rate, volume } = host.voice()
    // 先登记「已交给平台」再开口：介质可能在 start 里同步回 fail（准备期被拦），
    // 那一发 fail 已经把 active 置回 false——先置位后开口才不会把「已收口」覆盖成仍占着。
    this.active = true
    try {
      this.output.start(
        { text: job.text, voice, rate, volume },
        {
          start: () => { handlers.start?.() },
          done: () => { this.active = false; handlers.done() },
          fail: () => { this.active = false; handlers.fail() },
        },
      )
    } catch {
      this.active = false
      return 'failed'
    }
    return 'started'
  }

  /** 直出型没有回执续播：暂停就撤掉平台队列，继续时从本段开头重开口。 */
  resume(): boolean { return false }

  /** 章正文在途时旧 utterance 该当场让位：字节型还能继续放旧字节，直出型念的是上一章。 */
  yieldForLoad(): void {
    this.active = false
    this.output.pause()
  }

  pause(): void {
    this.active = false
    this.output.pause()
  }

  stop(): void {
    this.active = false
    this.output.stop()
  }

  release(): void {
    this.active = false
    this.output.release()
  }

  /** 直出型没有可调的活介质：utterance 的音量在开口时定死，改动从下一段起生效。 */
  setVolume(): void { /* 无活介质可落 */ }

  invalidate(): void { /* 没有槽键可作废 */ }

  preload(): void { /* 直出型不出字节，没有预载面 */ }

  dropPreload(): void { /* 同上 */ }

  held(): boolean { return this.active }
}

/** 两条分支的组：按模式取当前分支 + 两条介质一起停 / 一起释放。
 *  「静音另一条分支」由各分支起播时自己做（`start` 里先 `peer().pause()`），组这一层只管
 *  「两条都不该再响」时的收口——会话不需要知道另一边存在。 */
export function createListenBranches(
  outputs: { bytes: BytesListenOutput; direct: DirectListenOutput },
  awaitVoices: () => Promise<boolean>,
): ListenBranches {
  // 互相持有引用是为了起播时静音另一条分支；只被闭包引用，落到调用那一刻时两边都已就绪
  const bytes: BytesBranch = new BytesBranch(outputs.bytes, () => direct)
  const direct: DirectBranch = new DirectBranch(outputs.direct, {
    awaitVoices,
    peer: () => bytes,
  })
  return {
    branch: (mode) => (mode === 'direct' ? direct : bytes),
    held: () => direct.held() || bytes.held(),
    // 暂停必须收口到两条：切引擎的窗口里旧介质可能还在响（新分支要等回执才静音对侧）
    pauseAll: () => { bytes.pause(); direct.pause() },
    stopAll: () => { direct.stop(); bytes.stop() },
    releaseAll: () => { direct.release(); bytes.release() },
  }
}
