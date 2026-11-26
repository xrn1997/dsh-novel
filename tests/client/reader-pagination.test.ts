import { describe, expect, it } from 'vitest'
import { MEASURES } from '../../src/client/prefs-ui.js'
import {
  classifyClickZone,
  computePageCount,
  computeSpreadLayout,
  DOUBLE_PAGE_COLUMN_SCALE,
  DOUBLE_PAGE_FORCE_MIN_WIDTH,
  DOUBLE_PAGE_GAP,
  DOUBLE_PAGE_MIN_WIDTH,
  firstParagraphInSpread,
  pageRangeOfSpread,
  ratioForSpread,
  SINGLE_PAGE_GAP,
  spreadForElementLeft,
  spreadForRatio,
} from '../../src/client/reader-pagination.js'

describe('reader-pagination', () => {
  it('switches between single-page and double-page spread at DOUBLE_PAGE_MIN_WIDTH', () => {
    const narrow = computeSpreadLayout(DOUBLE_PAGE_MIN_WIDTH - 1, 680)
    expect(narrow.columnsPerSpread).toBe(1)
    expect(narrow.columnGap).toBe(SINGLE_PAGE_GAP)
    expect(narrow.stride).toBe(narrow.columnWidth + narrow.columnGap)

    const wide = computeSpreadLayout(DOUBLE_PAGE_MIN_WIDTH + 200, 680)
    expect(wide.columnsPerSpread).toBe(2)
    expect(wide.columnGap).toBe(DOUBLE_PAGE_GAP)
    expect(wide.contentWidth).toBe(wide.columnWidth * 2 + wide.columnGap)
    expect(wide.stride).toBe((wide.columnWidth + wide.columnGap) * 2)
  })

  it('supports explicit single and double columnMode preferences with fixed pixel measures', () => {
    const forcedSingle = computeSpreadLayout(DOUBLE_PAGE_MIN_WIDTH + 300, 680, 'single')
    expect(forcedSingle.columnsPerSpread).toBe(1)
    expect(forcedSingle.columnWidth).toBe(680)

    const forcedDouble = computeSpreadLayout(DOUBLE_PAGE_FORCE_MIN_WIDTH + 40, 680, 'double')
    expect(forcedDouble.columnsPerSpread).toBe(2)

    const tooNarrowForDouble = computeSpreadLayout(DOUBLE_PAGE_FORCE_MIN_WIDTH - 10, 680, 'double')
    expect(tooNarrowForDouble.columnsPerSpread).toBe(1)
  })

  it('keeps all MEASURES tiers strictly increasing and decoupled from font size in single and double modes', () => {
    const singleWidths = MEASURES.map((m) => computeSpreadLayout(1600, m.px, 'single').columnWidth)
    expect(singleWidths).toEqual(MEASURES.map((m) => m.px))

    const doubleWidths = MEASURES.map((m) => computeSpreadLayout(1600, m.px, 'double').columnWidth)
    expect(doubleWidths).toEqual(MEASURES.map((m) => Math.round(m.px * DOUBLE_PAGE_COLUMN_SCALE)))
    for (let i = 1; i < doubleWidths.length; i++) {
      expect(doubleWidths[i]).toBeGreaterThan(doubleWidths[i - 1] ?? 0)
    }
  })

  it('computes column and spread counts accurately for single and double spreads', () => {
    // 1 column: width 400, gap 32 -> step 432
    expect(computePageCount(400, 400, 32, 1)).toEqual({ totalColumns: 1, totalSpreads: 1 })
    expect(computePageCount(400 * 3 + 32 * 2, 400, 32, 1)).toEqual({ totalColumns: 3, totalSpreads: 3 })
    // 2 columns per spread: 3 columns -> 2 spreads (last spread has 1 column on left)
    expect(computePageCount(400 * 3 + 64 * 2, 400, 64, 2)).toEqual({ totalColumns: 3, totalSpreads: 2 })
    // 4 columns -> 2 spreads
    expect(computePageCount(400 * 4 + 64 * 3, 400, 64, 2)).toEqual({ totalColumns: 4, totalSpreads: 2 })
  })

  it('maps between ratio and spread monotonically within bounds', () => {
    expect(spreadForRatio(0, 5)).toBe(0)
    expect(spreadForRatio(0.99, 5)).toBe(4)
    expect(spreadForRatio(1.5, 5)).toBe(4)
    expect(spreadForRatio(-0.2, 5)).toBe(0)

    for (let s = 0; s < 5; s++) {
      const r = ratioForSpread(s, 5)
      expect(r).toBeGreaterThanOrEqual(0)
      expect(r).toBeLessThan(1)
      expect(spreadForRatio(r, 5)).toBe(s)
    }
  })

  it('locates spread from element horizontal offset inside multi-column track', () => {
    expect(spreadForElementLeft(0, 900, 4)).toBe(0)
    expect(spreadForElementLeft(899, 900, 4)).toBe(1) // +4px tolerance snaps edge cleanly
    expect(spreadForElementLeft(1850, 900, 4)).toBe(2)
    expect(spreadForElementLeft(9999, 900, 4)).toBe(3)
  })

  it('classifies click zones into prev (left 30%), center (middle 40%), next (right 30%)', () => {
    expect(classifyClickZone(110, 100, 1000)).toBe('prev')
    expect(classifyClickZone(500, 100, 1000)).toBe('center')
    expect(classifyClickZone(950, 100, 1000)).toBe('next')
  })

  it('computes 1-based page ranges for single and double spreads including trailing odd page', () => {
    expect(pageRangeOfSpread(0, 1, 5)).toEqual({ from: 1, to: 1, total: 5 })
    expect(pageRangeOfSpread(0, 2, 5)).toEqual({ from: 1, to: 2, total: 5 })
    expect(pageRangeOfSpread(2, 2, 5)).toEqual({ from: 5, to: 5, total: 5 })
  })

  it('finds the first visible paragraph in the current spread for TTS reading probe', () => {
    const spans = [
      { paragraphIndex: 0, left: 0, right: 380 },
      { paragraphIndex: 1, left: 450, right: 820 },
      { paragraphIndex: 2, left: 932, right: 1320 },
      { paragraphIndex: 3, left: 1380, right: 1760 },
    ]
    // Spread 0: [0, 868] -> paragraph 0
    expect(firstParagraphInSpread(spans, 0, 932, 868)).toBe(0)
    // Spread 1: [932, 1800] -> paragraph 2
    expect(firstParagraphInSpread(spans, 1, 932, 868)).toBe(2)
    // A paragraph spanning across spread 0 into spread 1 is picked on spread 1
    const spanning = [
      { paragraphIndex: 0, left: 0, right: 380 },
      { paragraphIndex: 1, left: 450, right: 1100 },
      { paragraphIndex: 2, left: 1150, right: 1500 },
    ]
    expect(firstParagraphInSpread(spanning, 1, 932, 868)).toBe(1)
  })
})
