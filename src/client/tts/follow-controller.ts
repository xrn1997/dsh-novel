/**
 * 跟读策略：播放推进是否带视口、读者何时接管、定位何时重新接上，以及「回阅读器」的一次性段落 target
 * 要不要先消费。**零 React / 零 DOM / 零 store 读取**——调用方交播放现场与 reveal / cancel 依赖，
 * 策略可在一张假表上单测。从视图搬出来：原先散在四个 ref、几段 effect 与一个拍点回调里，
 * 次序契约只活在注释；这里只保留「什么时候 reveal、用哪个 target、要不要写位置」三件事。
 */
import type { ReaderRevealTarget } from '../reader-session.js'
import { listenScopeOf } from './listen-scope.js'

/** 策略需要的播放现场：只认会话在、书对不对、当前章段；不读 store，也不认 TTS 类型。 */
export interface FollowLive {
  active: boolean
  bookKey: string | null
  chapterIndex: number
  paragraphIndex: number
}

/** 一次 reveal 的策略结果：`mode` = 显式顶对齐还是跟读翻页；`write` = 这一跳算不算阅读动作。 */
export interface FollowRevealOptions {
  mode: 'locate' | 'follow'
  write: boolean
  bottomInset: number
}

export interface FollowControllerDeps {
  /** 本书书键：只有现场是这本书时才跟随。 */
  bookKey: string
  /** 落位动作（生产是 `ReaderSession.reveal`；测试是记录器）。 */
  reveal(target: ReaderRevealTarget, opts: FollowRevealOptions): void
  /** 让位时撤销在途落位（生产是 `ReaderSession.cancelJump`）。 */
  cancel(): void
}

export interface FollowController {
  /** 播放推进 / 首拍：起播第一次与回阅读器把视口顶对齐到当前段；之后的推进只在翻页时顶对齐。 */
  onPlayback(live: FollowLive, bottomInset: number): void
  /** 读者按了「定位到正在念的段」：重新接上跟随，并顶对齐当前段。 */
  onLocate(live: FollowLive, bottomInset: number): void
  /** 读者手动滚动 / 目录 / 内链导航：让位，撤销在途落位。 */
  onUserIntent(): void
  /** 「回阅读器」的一次性 target：等下一次 playback 拍消费（不写 progress）。 */
  onRelocation(target: ReaderRevealTarget): void
  /** 听书会话开始 / 结束 / 换书：跟随回到默认开；会话不在时丢掉过期 relocation。 */
  onSessionChange(active: boolean): void
}

export function createFollowController(deps: FollowControllerDeps): FollowController {
  let following = true
  let relocation: ReaderRevealTarget | null = null
  /** 最近一次落位过的段：同一段不重复落；`null` = 下一次落位算起播/定位的显式顶对齐。 */
  let placed: ReaderRevealTarget | null = null

  const usable = (live: FollowLive): boolean => listenScopeOf(live, deps.bookKey).showing
  const same = (a: ReaderRevealTarget, b: ReaderRevealTarget): boolean =>
    a.index === b.index && a.paragraphIndex === b.paragraphIndex

  return {
    onPlayback(live, bottomInset) {
      // 会话不在 / 换了书：现场不是这本书，过期的 relocation 一并丢掉，别留到下一次起播。
      if (!usable(live)) {
        relocation = null
        placed = null
        return
      }
      if (!following) return
      const pending = relocation
      relocation = null
      if (pending !== null) {
        // 回阅读器：落到点击那一刻的段，且这一跳不写 progress（ADR-0094）。
        placed = pending
        deps.reveal(pending, { mode: 'locate', write: false, bottomInset })
        return
      }
      const target = { index: live.chapterIndex, paragraphIndex: live.paragraphIndex }
      if (placed !== null && same(placed, target)) return
      // 只有「同一章里的下一段」是自然播放推进，交给跟读翻页策略；起播首拍、跨章、回退、拖动滑杆
      // 这类跳转一律显式顶对齐——用户要知道自己跳到了哪一句。
      const sequential = placed !== null && placed.index === target.index
        && target.paragraphIndex === placed.paragraphIndex + 1
      placed = target
      deps.reveal(target, { mode: sequential ? 'follow' : 'locate', write: true, bottomInset })
    },

    onLocate(live, bottomInset) {
      if (!usable(live)) return
      following = true
      relocation = null
      const target = { index: live.chapterIndex, paragraphIndex: live.paragraphIndex }
      placed = target
      deps.reveal(target, { mode: 'locate', write: true, bottomInset })
    },

    onUserIntent() {
      following = false
      relocation = null
      placed = null
      deps.cancel()
    },

    onRelocation(target) {
      relocation = target
      following = true
      placed = null
    },

    onSessionChange(active) {
      following = true
      placed = null
      if (!active) relocation = null
    },
  }
}
