/**
 * 摸鱼假时钟（M1/M5 的量纲来源）：**屏幕上出现的时刻只从这里出，绝不用系统真钟**。
 *
 * 为什么造一只假钟：摸鱼模式的伪装在「工作时段的会话记录」上，一旦尾注 / 用户行时间戳照抄
 * `Date.now()`，凌晨三点开书就会把「正在摸鱼」写在脸上。所以时刻是一条**假时间线**：
 * 首轮固定落在当天 09:30（工作日开工点），此后每轮＝上轮时刻＋**真实阅读间隔**（相邻两轮
 * 提交之间实际过去了多久——那正是伪装里「读上一轮输出」的时间）。真实间隔被记进假时间线，
 * 真实时刻本身不上屏。
 *
 * 系统时钟只在**取一次锚日**时被读：日期段（跨日才带日期）要「当天」是哪天。时刻段永不读表。
 * 跨日判定按假时间线自己的 24h 进位（累计阅读超过一天才带日期），与真实日期无关。
 */

/** 锚时刻：09:30（以分钟计，自假日零点起算）。 */
export const MOYU_CLOCK_ANCHOR_MINUTES = 9 * 60 + 30

const MINUTE_MS = 60_000
const DAY_MS = 24 * 60 * MINUTE_MS

/** 一轮的假时刻：提示（用户气泡）与消息（轮尾尾注）各一枚。 */
export interface MoyuTurnClockMark {
  /** 假时间线上的用户提示时刻（epoch ms 形态，只用于格式化）。 */
  promptAt: number
  /** 假时间线上的助手消息时刻＝提示时刻＋该轮揭示耗时。 */
  messageAt: number
}

/** 日期模板的取词面（宿主 clock.md / clock.ymd 同两句式）。 */
export type MoyuClockTranslate = (
  key: 'reader.moyu.clock.md' | 'reader.moyu.clock.ymd',
  params?: Record<string, string | number>,
) => string

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function dayStart(at: number): number {
  const day = new Date(at)
  day.setHours(0, 0, 0, 0)
  return day.getTime()
}

/**
 * 消息时刻上屏（宿主 message-chrome `formatMessageClock` 的句式，唯一实现）：同日只出 `HH:mm`，
 * 跨日才带日期（`{m}月{d}日` 模板）；年份不同带年（`{y}年{m}月{d}日`）。镜像轮（真值时刻）与假时间线
 * 共用这一份句式，各自带自己的锚点。
 */
export function formatMessageClock(at: number, anchorAt: number, t: MoyuClockTranslate): string {
  const anchorDay = dayStart(anchorAt)
  const d = new Date(at)
  const clock = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  // 只省「锚日当天」的日期：比锚日更早的时刻（镜像轮跨日回溯）同样要带日期。
  if (at >= anchorDay && at < anchorDay + DAY_MS) return clock
  const anchorYear = new Date(anchorDay).getFullYear()
  const params = { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() }
  return `${t(d.getFullYear() === anchorYear ? 'reader.moyu.clock.md' : 'reader.moyu.clock.ymd', params)} ${clock}`
}

/**
 * 假时钟唯一实现：按轮登记真实提交间隔，产出假时刻。
 * 「真实间隔」由调用方注入（`Date.now()` 的差），本类自己不读表——读表点只在视图登记那一下。
 */
export class MoyuClock {
  /** 锚日零点（真实日期，只取一次）；null＝还没有第一轮。 */
  private anchorDay: number | null = null
  /** 上一轮登记时的真实时刻（算「真实阅读间隔」用）。 */
  private lastRealSubmit: number | null = null
  /** 上一轮登记出的假提示时刻（每轮＝上轮时刻＋真实阅读间隔）。 */
  private lastPromptAt: number | null = null
  /** 每轮各自的假提示时刻：登记一次就钉住，之后补登更晚的轮次不挪动已有轮。 */
  private readonly prompts = new Map<number, number>()

  /** 取（或建）一轮的假时刻；同一轮重复取只登记一次，提示时刻不随重渲染 / 补轮挪动。 */
  mark(turn: number, realNow: number, revealMs: number): MoyuTurnClockMark {
    let promptAt = this.prompts.get(turn)
    if (promptAt === undefined) {
      let anchorDay = this.anchorDay
      if (anchorDay === null) {
        const day = new Date(realNow)
        day.setHours(0, 0, 0, 0)
        anchorDay = day.getTime()
        this.anchorDay = anchorDay
      }
      const gap = this.lastRealSubmit === null ? 0 : Math.max(0, realNow - this.lastRealSubmit)
      this.lastRealSubmit = realNow
      promptAt = this.lastPromptAt === null
        ? anchorDay + MOYU_CLOCK_ANCHOR_MINUTES * MINUTE_MS
        : this.lastPromptAt + gap
      this.lastPromptAt = promptAt
      this.prompts.set(turn, promptAt)
    }
    return { promptAt, messageAt: promptAt + Math.max(0, revealMs) }
  }

  /**
   * 时刻上屏：句式归 `formatMessageClock`（本类只提供假时间线的锚日）。
   */
  format(at: number, t: MoyuClockTranslate): string {
    return formatMessageClock(at, this.anchorDay ?? at, t)
  }
}
