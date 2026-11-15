import { describe, expect, it } from 'vitest'
import { zhTranslate } from '../../src/client/copy/index.js'
import {
  chapterProgressOf, lineOf, miniSegmentLabel, rateLabel, segmentLabel, timerReadout,
} from '../../src/client/tts/listen-readout.js'
import type { TtsPlayerState } from '../../src/client/tts/player.js'
import type { TtsProgressState } from '../../src/client/tts/player.js'

/**
 * 听书上屏读数的纯函数钉子：换算只此一处，四个表面（听书条 / 迷你条 / 边栏 / 设置面）都取成品。
 *
 * 输入是整份 `TtsPlayerState`（编译期证结构子集可吃全量状态），时刻一律注入 `now`——
 * 倒计时读数因此不等墙钟，同一状态换一个时刻就能钉住读数怎么走。
 */

function state(patch: Partial<TtsPlayerState> = {}): TtsPlayerState {
  return {
    active: true,
    bookKey: 'k1',
    sourceId: 's1',
    title: '书一',
    chapterIndex: 0,
    chapterName: '第一章',
    paragraphCount: 10,
    paragraphIndex: 0,
    paragraphText: '',
    playing: true,
    engineId: 'builtin:demo',
    voice: null,
    rate: 1,
    volume: 1,
    timerEndAt: null,
    timerChoice: null,
    mode: 'bytes',
    loading: false,
    chapterLoading: false,
    failedParagraphs: [],
    consecutiveFailures: 0,
    chapterNames: ['第一章'],
    ...patch,
  }
}

function progress(position: number, duration: number): TtsProgressState {
  return { position, duration }
}

describe('段读数：1 基换算与空章', () => {
  it('段号从 1 起，两个表面各取自己的键', () => {
    const st = state({ paragraphIndex: 2, paragraphCount: 10 })
    expect(segmentLabel(st, zhTranslate)).toBe('第 3 / 10 段')
    expect(miniSegmentLabel(st, zhTranslate)).toBe('3/10')
  })

  it('空章：两个表面都回「本章没有可朗读的段落」', () => {
    const st = state({ paragraphCount: 0, paragraphIndex: 0 })
    expect(segmentLabel(st, zhTranslate)).toBe('本章没有可朗读的段落')
    expect(miniSegmentLabel(st, zhTranslate)).toBe('本章没有可朗读的段落')
  })
})

describe('定时读数：档位、倒计时门与注入时刻', () => {
  const T0 = 1_000_000

  it('没定 → 「定时」，不倒计时', () => {
    expect(timerReadout(state(), zhTranslate, T0)).toEqual({ label: '定时', counting: false })
  })

  it('本章档不倒计时：timerEndAt 在场也只摆档位名', () => {
    const st = state({ timerChoice: 'chapter', timerEndAt: T0 + 90_000 })
    expect(timerReadout(st, zhTranslate, T0)).toEqual({ label: '本章结束', counting: false })
  })

  it('分钟档在走表 → 倒计时，秒数经 formatClock 落成 m:ss', () => {
    const st = state({ timerChoice: 15, timerEndAt: T0 + 90_000 })
    expect(timerReadout(st, zhTranslate, T0)).toEqual({ label: '1:30', counting: true })
    expect(timerReadout(st, zhTranslate, T0 + 85_000)).toEqual({ label: '0:05', counting: true })
  })

  it('now 注入前后读数跟着走：走完那一刻夹到 0:00，不显负数', () => {
    const endAt = T0 + 60_000
    const st = state({ timerChoice: 30, timerEndAt: endAt })
    expect(timerReadout(st, zhTranslate, T0).label).toBe('1:00')
    expect(timerReadout(st, zhTranslate, T0 + 30_000).label).toBe('0:30')
    expect(timerReadout(st, zhTranslate, endAt + 1_000)).toEqual({ label: '0:00', counting: true })
  })

  it('分钟档没在走表（endAt 缺席）→ 档位名，不当倒计时', () => {
    const st = state({ timerChoice: 15, timerEndAt: null })
    expect(timerReadout(st, zhTranslate, T0)).toEqual({ label: '15 分', counting: false })
  })
})

describe('章内进度算式：条与浮窗共用同一 value', () => {
  it('duration 0（直出型的恒零现场）→ ratio 0，value 就是段号', () => {
    const st = state({ paragraphIndex: 3, paragraphCount: 10 })
    const got = chapterProgressOf(st, progress(0, 0), zhTranslate)
    expect(got.ratio).toBe(0)
    expect(got.value).toBe(3)
    expect(got.pct).toBeCloseTo(0.3)
    expect(got.readout, 'readout 与段读数同一把尺').toBe('第 4 / 10 段')
  })

  it('段内比例夹进 [0,1]：position 超过 duration 也只到 1', () => {
    const st = state({ paragraphIndex: 3, paragraphCount: 10 })
    const got = chapterProgressOf(st, progress(20, 10), zhTranslate)
    expect(got.ratio).toBe(1)
    expect(got.value).toBe(4)
  })

  it('value 越界夹回 count：段号超界也不出本章', () => {
    const over = chapterProgressOf(state({ paragraphIndex: 99, paragraphCount: 10 }), progress(0, 0), zhTranslate)
    expect(over.value).toBe(10)
    expect(over.pct, '夹取后 pct 不超过 1').toBe(1)
    const last = chapterProgressOf(state({ paragraphIndex: 9, paragraphCount: 10 }), progress(10, 10), zhTranslate)
    expect(last.value).toBe(10)
    expect(last.pct).toBe(1)
  })

  it('空章 → pct 0（不是 NaN），readout 是空章句', () => {
    const st = state({ paragraphCount: 0, paragraphIndex: 0 })
    const got = chapterProgressOf(st, progress(5, 10), zhTranslate)
    expect(got.pct).toBe(0)
    expect(got.value).toBe(0)
    expect(got.readout).toBe('本章没有可朗读的段落')
  })
})

describe('语速读数与当前句', () => {
  it('语速照字典的 {rate}x', () => {
    expect(rateLabel(state({ rate: 1.5 }), zhTranslate)).toBe('1.5x')
    expect(rateLabel(state({ rate: 1 }), zhTranslate)).toBe('1x')
  })

  it('当前句空串语义一处判：空串回 null，有句回原文', () => {
    expect(lineOf(state({ paragraphText: '风起了。' }))).toBe('风起了。')
    expect(lineOf(state({ paragraphText: '' }))).toBeNull()
  })
})
