import { describe, expect, it } from 'vitest'
import { searchSummarySegments } from '../../src/client/copy/search-summary.js'
import { enTranslate, zhTranslate } from '../../src/client/copy/index.js'

const joined = (segs: Array<{ text: string }>): string => segs.map((s) => s.text).join('')
const base = { searched: 3, hits: 5, merged: 2, answered: 3, relevant: 4, failed: 1, stopped: false }

describe('搜索收口整句', () => {
  it('ZH：每个子句都在，顺序由字典给', () => {
    expect(joined(searchSummarySegments(zhTranslate, base))).toBe(
      '本轮搜过 3 家 · 命中 5 条 · 并成 2 本（来自 3 家，其中相关 4 条、其余折叠可展开） · 1 家未响应')
  })
  it('ZH：relevant 不折时整句仍成立；failed=0 仍要报；stopped 前置', () => {
    expect(joined(searchSummarySegments(zhTranslate, { ...base, relevant: 5, failed: 0, stopped: true }))).toBe(
      '已停止 · 本轮搜过 3 家 · 命中 5 条 · 并成 2 本（来自 3 家） · 0 家未响应')
  })
  it('ZH：failed=2 报两家', () => {
    expect(joined(searchSummarySegments(zhTranslate, { ...base, failed: 2 }))).toContain(' · 2 家未响应')
  })
  it('EN：单复数与子句顺序由字典给（failed=0 仍报）', () => {
    expect(joined(searchSummarySegments(enTranslate, { searched: 1, hits: 1, merged: 1, answered: 1, relevant: 1, failed: 0, stopped: false }))).toBe(
      'This round searched 1 source · 1 hit · merged into 1 book (from 1 source) · 0 sources did not respond')
  })
  it('EN：多个计数与 relevant 子句', () => {
    expect(joined(searchSummarySegments(enTranslate, { searched: 3, hits: 5, merged: 2, answered: 3, relevant: 4, failed: 0, stopped: false }))).toBe(
      'This round searched 3 sources · 5 hits · merged into 2 books (from 3 sources, 4 relevant hits, the rest folded but expandable) · 0 sources did not respond')
  })
  it('EN：failed 单复数', () => {
    expect(joined(searchSummarySegments(enTranslate, { ...base, searched: 3, hits: 5, merged: 2, answered: 3, relevant: 4, failed: 1, stopped: false }))).toContain(' · 1 source did not respond')
    expect(joined(searchSummarySegments(enTranslate, { ...base, searched: 3, hits: 5, merged: 2, answered: 3, relevant: 4, failed: 2, stopped: false }))).toContain(' · 2 sources did not respond')
  })
  it('加粗边界与旧 UI 一致：只加粗数字（searched/hits/merged/failed），answered 不加粗', () => {
    const segs = searchSummarySegments(zhTranslate, base)
    expect(segs.filter((s) => s.emphasis).map((s) => s.text)).toEqual(['3', '5', '2', '1'])
  })
})
