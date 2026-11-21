/**
 * 听书范围：播放层现状里「这次听的是不是这本书」的唯一投影。听书条挂载、pill 的启停、
 * 跟读可用性与跟读高亮原先各自拼「active + 书键 + 章段」，这里收成一只纯函数；视图侧的
 * 订阅包装住 `use-listen-scope.ts`。
 *
 * 「可暂停」的判据只住 `listen-readout.ts` 的 `isPlayBusy`：视图面把它的成品读数交进来，
 * 纯函数只做「本次会话」的合取。策略面（`follow-controller`）只问 `showing`，不关心可暂停性，
 * 因此 `playBusy` 缺席时按不在忙算——本模块不读 React / store，也不认识播放层。
 */

/** 范围判据吃的最小现场：会话在不在、听的是哪本书、念到哪；视图面另交可暂停读数。 */
export interface ListenScopeLive {
  active: boolean
  bookKey: string | null
  chapterIndex?: number
  paragraphIndex?: number
  /** `isPlayBusy` 的成品读数；缺席 = 调用方不关心可暂停性（策略面）。 */
  playBusy?: boolean
}

/** 一只 scope 答完阅读器需要的全部「本次会话」问题；非本次会话的章段号一律 -1。 */
export interface ListenScope {
  /** 本次会话就是这本书：听书条挂载与「从阅读位置起播」的闸门。 */
  showing: boolean
  /** 播放层有没有活会话（与阅读器开着哪本书无关）。 */
  active: boolean
  /** 本次会话此刻按下去是暂停（在放 ∨ 准备中）。 */
  busy: boolean
  /** 正在念的章；非本次会话 → -1，调用点不必再叠一层 `showing` 判断。 */
  chapterIndex: number
  /** 正在念的段；非本次会话 → -1。 */
  paragraphIndex: number
}

/** 范围投影的唯一算式：合取与段号归零只在这里。 */
export function listenScopeOf(live: ListenScopeLive, bookKey: string): ListenScope {
  const showing = live.active && live.bookKey === bookKey
  return {
    showing,
    active: live.active,
    busy: showing && live.playBusy === true,
    chapterIndex: showing ? live.chapterIndex ?? -1 : -1,
    paragraphIndex: showing ? live.paragraphIndex ?? -1 : -1,
  }
}
