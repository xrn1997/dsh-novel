/**
 * 听书上屏读数的唯一换算处：段读数、定时读数、章内进度算式、语速读数、当前句取值。
 *
 * 为什么单独成模块：同一份会话状态（播放层的 `ttsPlayer` + 段进度 `ttsProgress`）被阅读器
 * 听书条、迷你条胶囊、展开边栏与设置面四个表面各自解释——段号 1 基换算写过四遍、定时两面
 * 各说各话（条显档位、浮窗显倒计时）、章内进度两套公式。换算只住这里，表面只取成品；
 * 表面要改读数形状时改这里，不许在表面重算。
 *
 * 零 React、零 store 读取、不读墙钟：倒计时的时刻由调用方注入 `now`，测试换一个时刻就能钉住
 * 读数怎么走，不用等真秒。状态以**结构子集**入参（见 `ListenReadoutState`）——刻意不 import
 * `player.ts`：读数是播放层之外的表面也要取的叶子，把播放层的 store 拖进依赖图会让任何取
 * 读数的文件连带背上整台状态机。
 */

import type { Translate } from '../copy/index.js'
import { formatClock } from '../util.js'

/** 读数吃的会话状态面：字段与 `TtsPlayerState` 逐一同构的子集，调用点直接递整份 store 状态。
 *  播放层改字段时这里的可赋值性当场红——子集视图不是抄本，是那张状态表的一个切面。 */
export interface ListenReadoutState {
  paragraphCount: number
  paragraphIndex: number
  paragraphText: string
  rate: number
  timerChoice: number | 'chapter' | null
  timerEndAt: number | null
}

/** 段进度现场（`ttsProgress` 的形状）：当前播放单元已出声的秒数与总秒数。 */
export interface ListenReadoutProgress {
  position: number
  duration: number
}

/** 段读数：1 基 n/total；空章回「没有可朗读的段落」，不摆 0/0。 */
export function segmentLabel(st: ListenReadoutState, t: Translate): string {
  return st.paragraphCount === 0
    ? t('tts.emptyChapter')
    : t('tts.segment', { n: st.paragraphIndex + 1, total: st.paragraphCount })
}

/** 迷你面上的紧凑段读数（`n/total`）；空章同 `segmentLabel`，不摆 0/0。 */
export function miniSegmentLabel(st: ListenReadoutState, t: Translate): string {
  return st.paragraphCount === 0
    ? t('tts.emptyChapter')
    : t('tts.mini.seg', { n: st.paragraphIndex + 1, total: st.paragraphCount })
}

export interface TimerReadout {
  label: string
  /** 分钟档正在走表：只有这一档摆倒计时（本章档摆档位名、没定摆「定时」）。 */
  counting: boolean
}

/** 定时读数：档位与倒计时同一份答案，两个表面（听书条 / 迷你条）共用。
 *  `now` 由调用方注入——本模块不读墙钟，倒计时的每秒节拍是各表面自己的呈现驱动。 */
export function timerReadout(st: ListenReadoutState, t: Translate, now: number): TimerReadout {
  // 计时门：只有分钟档且落了到点时刻才走表。本章档没有到点时刻（它由章末事件收口），
  // 摆倒计时会造出一个不存在的剩余时间。
  const counting = st.timerChoice !== null && st.timerChoice !== 'chapter' && st.timerEndAt !== null
  const label = st.timerChoice === null
    ? t('tts.timer')
    : st.timerChoice === 'chapter'
      ? t('tts.timer.chapter')
      : counting && st.timerEndAt !== null
        ? formatClock(Math.max(0, (st.timerEndAt - now) / 1000))
        : t('tts.timer.minutes', { n: st.timerChoice })
  return { label, counting }
}

export interface ChapterProgress {
  /** 本章段数（0 = 空章） */
  count: number
  /** 段内比例，夹进 [0,1]；直出型没有计时介质，恒 0 */
  ratio: number
  /** 段号 + 段内比例的连续位置，夹回 [0, count]——两个控件吃同一个 value */
  value: number
  /** value 占本章的比例 [0,1]；空章为 0（不是 NaN） */
  pct: number
  /** 段读数（与 `segmentLabel` 同一把尺），给滑杆的 title / aria 用 */
  readout: string
}

/** 章内进度算式：听书条的段粒度滑杆（`value` 取整到段）与浮窗的连续填充（`pct`）共用这一份，
 * 「同一 value 的两种控件形态」。拖动即跳段的映射归各控件自己，这里只算读数。 */
export function chapterProgressOf(
  st: ListenReadoutState, progress: ListenReadoutProgress, t: Translate,
): ChapterProgress {
  const count = st.paragraphCount
  const ratio = progress.duration > 0
    ? Math.min(1, progress.position / progress.duration)
    : 0
  const value = Math.min(count, st.paragraphIndex + ratio)
  const pct = count > 0 ? value / count : 0
  return { count, ratio, value, pct, readout: segmentLabel(st, t) }
}

/** 语速读数：`{rate}x`。 */
export function rateLabel(st: ListenReadoutState, t: Translate): string {
  return t('tts.rateValue', { rate: st.rate })
}

/** 当前句：空串语义只此一处判——空串回 null（没有当前句），渲染点据此不出这一行。 */
export function lineOf(st: ListenReadoutState): string | null {
  return st.paragraphText === '' ? null : st.paragraphText
}
