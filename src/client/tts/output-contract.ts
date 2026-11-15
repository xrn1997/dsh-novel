/**
 * 两条出声分支与会话之间的**输出契约**：会话只认这几件（起一段、停、释放、音量，字节型另有
 * 预载面），Audio / Speech 的其余 API 是出声层与平台之间的事。
 *
 * 实现住 `bytes-output.ts`（Audio 两槽预载）与 `direct-output.ts`（Speech 的 utterance 生命周期）；
 * 本文件只有类型，零运行时依赖——两条分支的实现与消费方都引这一份，不在各自文件里抄第二份。
 */

/** 出声层向会话回报的四件事：只报事实，token / 代际守卫在会话侧。 */
export interface OutputHandlers {
  /** 这一段真开口了（字节型活槽 onplaying / `play()` 承诺落地，直出型 onstart）：记段、清连败。 */
  start?: () => void
  /** 这一段播完（字节型 ended / 直出型 onend）：推进。 */
  done: () => void
  /** 这一段没成（起播被拦、平台报错、开口兜底落空）：留痕跳过。 */
  fail: () => void
  /** 字节型计时读数（活槽才投）。 */
  progress?: (position: number, duration: number) => void
}

/** 字节型起一段：缓存键 + 音量 + **播放倍率**（回执报的那一格：引擎没做到的那一截由这里补）；
 *  `resume` = 原地续播（不重置播放头，暂停续上就靠它）。倍率随段走：换段与续播都要重设，
 *  留在元素上的旧值会让下一段悄悄用上一段的速度念。 */
export interface BytesSegment { key: string; volume: number; playbackRate: number; resume: boolean }

/** 直出型起一段：文本与语音参数（音色 id 是引擎自己的取值，不跨引擎互通）。 */
export interface DirectSegment { text: string; voice: string | null; rate: number; volume: number }

/** 两条出声分支共用的会话面：起一段、停、释放、音量——会话需要的就这几件，
 *  Audio / Speech 的其余 API 不进这张表（它们是出声层与平台之间的事）。 */
export interface ListenOutput<S> {
  start(seg: S, handlers: OutputHandlers): void
  /** 停当前段但保留现场（字节型暂停可原地续，直出型撤掉平台队列）。 */
  pause(): void
  /** 停并松开介质（字节型摘掉缓冲，直出型同 pause + 撤开口兜底）。 */
  stop(): void
  /** 整份释放（字节型连槽一起丢，供复位缝用）。 */
  release(): void
  /** 音量落到活介质。 */
  setVolume(volume: number): void
}

/** 字节型在共用面上多四件：预载接槽、预载作废、活槽验键（预取与原地续播要问它），
 *  以及**失效重来**——缓存条目被 prune / 读口瞬时 404 后，旧槽按同一个键不会重设 `src`，
 *  一个已经 errored 的元素再 `play()` 只会再拒；自愈前必须先把槽键与预载记录清掉。 */
export interface BytesListenOutput extends ListenOutput<BytesSegment> {
  preload(key: string): void
  dropPreload(): void
  holds(key: string): boolean
  invalidate(): void
}

export type DirectListenOutput = ListenOutput<DirectSegment>