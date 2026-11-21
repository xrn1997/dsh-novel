/**
 * 两条出声分支与会话之间的**输出契约**：介质面（起一段、停、释放、音量，字节型另有预载面）
 * 加**分支策略面**（能提供什么、怎么准备一段、怎么静音另一条、何时可续 / 可让位）。
 *
 * 为什么策略也住契约：起播前要做什么、能提供什么、换介质时谁闭嘴，都是分支自己的事；
 * 留在状态机里，加第三条声道就要改状态机多处方法，而「哪些步骤是分支差异」只活在注释里。
 * 实现住 `bytes-output.ts` / `direct-output.ts` 与 `playback-branches.ts`；本文件只有类型。
 */

import type { SynthesisReceipt } from '../../shared/wire.js'

/** 出声的两条分支（引擎分流的两种出声形态）。 */
export type BranchMode = 'bytes' | 'direct'

/** 音色表来源：平台语音表（直出型）或引擎源声明的音色表（字节型）。 */
export type VoiceTable = 'platform' | 'engine'

/** 一条分支**能提供什么**：状态机与上屏读数按能力决定要不要走分支特化的路，不拿模式猜。 */
export interface BranchCapabilities {
  /** 有段内计时介质（字节型的活 Audio 槽）：false = 段进度恒零，视图画静态轨道。 */
  segmentProgress: boolean
  /** 有预取面：同章后段 / 下一章开头的暖缓存由会话按这一格决定发不发。 */
  prefetch: boolean
  /** 暂停续播能原地接回同一段字节（回执续播）；false = 续播从本段开头重开口。 */
  receiptResume: boolean
  /** 介质读坏时能自愈一次（音频缓存条目被 prune）：分支清掉出声现场，会话重新取回执。 */
  selfHeal: boolean
  voiceTable: VoiceTable
}

/** 起播一段的材料：会话按当前段读出，分支只消费，不推进状态机。 */
export interface SegmentJob {
  /** 段号：分支只用来认「这一段」（推进与落盘归会话）。 */
  index: number
  text: string
  /** 这一发的取消位（`ADR-0082`）：作废后分支不再往下走，且不记成段失败。 */
  signal: AbortSignal
}

/** 原地续播的材料（回执续播能力）：同一段字节接着放，不重新合成。 */
export interface ResumeSegment {
  key: string
  volume: number
  /** 回执报的补速：续播的是同一段字节，倍率取回执那一格，不取此刻的语速滑杆。 */
  playbackRate: number
}

/** 起一段的结局：真交出去了 / 被取消 / 准备阶段没成（会话据此走失败径或静默收口）。 */
export type BranchStartOutcome = 'started' | 'cancelled' | 'failed'

/** 分支起播时要向会话借的现场（缓存的回执与代际守卫归会话，`ADR-0081` / `ADR-0082`）。 */
export interface BranchHost {
  /** 取当前参数下的回执：null = 这一发已作废（迟到 / 被取消），分支别再往下走。 */
  receipt(job: SegmentJob): Promise<SynthesisReceipt | null>
  /** 本段的声音参数；音量必须活读（合成在途里音量条还能动，入口快照会把它盖回去）。 */
  voice(): { voice: string | null; rate: number; volume: number }
}

/** 出声层向会话回报的四件事：只报事实，token / 代际守卫在会话侧。 */
export interface OutputHandlers {
  /** 这一段真开口了（字节型活槽 onplaying / `play()` 承诺落地，直出型 onstart）：记段、清连败。 */
  start?: () => void
  /** 这一段**已交给介质**、准备期的 loading 到此结束。字节型的 loading 只等合成与起播交出
   *  （之后是介质的出声事件），直出型要等平台开口（它不调这一格，由 `start` 收口）——
   *  两套 loading 生命周期的差别住各自的出声层，不在会话里按模式分。 */
  prepared?: () => void
  /** 这一段播完（字节型 ended / 直出型 onend）：推进。 */
  done: () => void
  /** 这一段没成（起播被拦、平台报错、开口兜底落空）：留痕跳过。 */
  fail: () => void
  progress?: (position: number, duration: number) => void
}

/** 字节型起一段：缓存键 + 音量 + **播放倍率**（回执报的那一格：引擎没做到的那一截由这里补）；
 *  `resume` = 原地续播（不重置播放头，暂停续上就靠它）。倍率随段走：换段与续播都要重设，
 *  留在元素上的旧值会让下一段悄悄用上一段的速度念。 */
export interface BytesSegment { key: string; volume: number; playbackRate: number; resume: boolean }

/** 直出型起一段：文本与语音参数（音色 id 是引擎自己的取值，不跨引擎互通）。 */
export interface DirectSegment { text: string; voice: string | null; rate: number; volume: number }

/** 两条分支共用的会话面：起一段、停、释放、音量——Audio / Speech 的其余 API 不进这张表。 */
export interface ListenOutput<S> {
  start(seg: S, handlers: OutputHandlers): void
  /** 停当前段但保留现场（字节型暂停可原地续，直出型撤掉平台队列）。 */
  pause(): void
  /** 停并松开介质（字节型摘掉缓冲，直出型同 pause + 撤开口兜底）。 */
  stop(): void
  release(): void
  /** 音量落到活介质。 */
  setVolume(volume: number): void
}

/** 字节型在共用面上多四件：预载接槽、预载作废、活槽验键，以及**失效重来**——缓存条目被 prune
 *  后旧槽按同一个键不会重设 `src`，已经 errored 的元素再 `play()` 只会再拒。 */
export interface BytesListenOutput extends ListenOutput<BytesSegment> {
  preload(key: string): void
  dropPreload(): void
  holds(key: string): boolean
  invalidate(): void
}

export type DirectListenOutput = ListenOutput<DirectSegment>

/**
 * 一条出声分支：介质之外，这条分支的**起播策略**也住实现里。会话只问四件事——准备这一段
 * （`start`）、能提供什么（`capabilities`）、静音另一条分支、重来的许可（`resume` / `held`）。
 * 硬边界：分支**不**推进状态机、不落盘、不读会话 store；它只把介质事件翻成 `OutputHandlers`。
 */
export interface PlaybackBranch {
  readonly capabilities: BranchCapabilities
  /** 源级闸门：true = 立刻可用；Promise = 要等平台交能力（直出型等语音表），解出 false = 此刻不可用。 */
  ready(): true | Promise<boolean>
  /** 起一段：自己静音另一条分支、过音色、求合成、交介质。准备期没成用结局回报；介质失败走 `handlers.fail`。 */
  start(
    job: SegmentJob, handlers: OutputHandlers, host: BranchHost,
  ): BranchStartOutcome | Promise<BranchStartOutcome>
  /** 原地续播：接上返回 true；没有回执续播能力或字节不在介质里返回 false（会话重新起播这一段）。 */
  resume(seg: ResumeSegment, handlers: OutputHandlers): boolean
  /** 换章载入在途：旧声音该让位就让位（字节型继续放着等起播换槽，直出型当场撤队）。 */
  yieldForLoad(): void
  /** 暂停当前段（保留现场）。 */
  pause(): void
  /** 停并松开介质。 */
  stop(): void
  /** 整份释放（复位缝用）。 */
  release(): void
  /** 音量落到活介质。 */
  setVolume(volume: number): void
  /** 介质读坏时清掉出声现场（字节型：两只槽的键与预载记录作废；无槽分支什么也不做）。 */
  invalidate(): void
  /** 接一段预载（字节型：另一只槽挂上下一段的音频 URL；无预取分支什么也不做）。 */
  preload(key: string): void
  /** 作废预载记录（换章 / 换参数：预载的那一段不再是「下一段」）。 */
  dropPreload(): void
  /** 这条分支此刻是否占着介质（已交 utterance 等）：参数变更要不要重取当前段的一支判据。 */
  held(): boolean
}

/** 两条分支的组：会话按模式取当前分支；「一起停 / 一起释放」是这一层的知识。 */
export interface ListenBranches {
  branch(mode: BranchMode): PlaybackBranch
  /** 任一条分支是否还占着介质：判据不能只看新分支（切走后旧分支可能还念着半段）。 */
  held(): boolean
  /** 会话暂停：两条介质一起暂停。只暂停当前分支会漏掉切引擎窗口里还在响的旧介质。 */
  pauseAll(): void
  stopAll(): void
  releaseAll(): void
}
