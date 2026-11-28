import { describe, expect, it } from 'vitest'
import { MoyuClock, MOYU_CLOCK_ANCHOR_MINUTES, formatMessageClock } from '../../src/client/moyu-clock.js'
import type { MoyuClockTranslate } from '../../src/client/moyu-clock.js'
import { zhTranslate } from '../../src/client/copy/index.js'

/** 文案表只走 copy 单点：这里直接用中文表，断言与 TZ 无关（时刻按本地钟构造）。 */
const t = zhTranslate as MoyuClockTranslate

const at = (month: number, day: number, hour: number, minute: number): number =>
  new Date(2026, month - 1, day, hour, minute).getTime()

describe('摸鱼假时钟与时刻上屏', () => {
  it('同日只出 HH:mm；更早的日子与更晚的日子都带日期（两个方向都要）', () => {
    const anchor = at(1, 15, 14, 30)
    expect(formatMessageClock(at(1, 15, 9, 5), anchor, t)).toBe('09:05')
    expect(formatMessageClock(at(1, 15, 23, 59), anchor, t)).toBe('23:59')
    expect(formatMessageClock(at(1, 14, 8, 0), anchor, t)).toBe('1月14日 08:00')
    expect(formatMessageClock(at(1, 16, 8, 0), anchor, t)).toBe('1月16日 08:00')
  })

  it('跨年带年份', () => {
    const anchor = at(1, 1, 9, 30)
    expect(formatMessageClock(new Date(2025, 11, 31, 22, 10).getTime(), anchor, t)).toBe('2025年12月31日 22:10')
  })

  it('假时钟首轮落 09:30，后续轮＝上轮时刻＋真实提交间隔', () => {
    const clock = new MoyuClock()
    const first = clock.mark(0, 1_000_000, 0)
    const hour = Math.floor(MOYU_CLOCK_ANCHOR_MINUTES / 60)
    const minute = MOYU_CLOCK_ANCHOR_MINUTES % 60
    const date = new Date(first.promptAt)
    expect(date.getHours()).toBe(hour)
    expect(date.getMinutes()).toBe(minute)
    const second = clock.mark(1, 1_000_000 + 90_000, 0)
    expect(second.promptAt).toBe(first.promptAt + 90_000)
    // 同一轮重复取不挪动时刻。
    expect(clock.mark(0, 9_999_999, 0).promptAt).toBe(first.promptAt)
  })
})