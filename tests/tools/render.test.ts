import { describe, expect, it } from 'vitest'
import {
  renderImport, renderRead, renderSearch, renderShelfBook, renderShelfList, renderShelfRemove,
  renderSourceList, renderSourceProbe, renderSourceRemove, renderSourceToggle, renderToc,
} from '../../src/tools/render.js'
import type { ShelfItem } from '../../src/tools/shelf-item.js'

const shelfItem = (over: Partial<ShelfItem> = {}): ShelfItem => ({
  sourceId: 's1', bookKey: 'k1', title: '斗罗', progress: { chapterIndex: 2, offsetRatio: 0.5, updatedAt: 1 },
  addedAt: 1, ...over,
})

describe('renderSearch（工具面搜索文案）', () => {
  it('摘要恒在、缺作者不印幽灵、未答话逐家点名、截断如实', () => {
    const text = renderSearch({
      books: [
        { title: '斗罗', author: '唐家', sourceCount: 2, sources: [{ sourceName: 'A', url: 'https://a/1' }, { sourceName: 'B', url: 'https://b/1' }] },
        { title: '斗罗外传', sourceCount: 1, sources: [{ sourceName: 'A', url: 'https://a/2' }] },
      ],
      failed: [{ sourceName: 'C', code: 'FetchError' }],
      searched: 3, answered: 2, filtered: 1,
      truncated: '本轮共 9 本，只返回前 2 本',
    })
    expect(text).toContain('2 本（跑了 3 家、答话 2 家、滤去 1 条不相关）')
    expect(text).toContain('《斗罗》 / 唐家 · 2 家源')
    expect(text).toContain('《斗罗外传》 · 1 家源')
    expect(text).not.toContain('undefined')
    expect(text).toContain('1 家未答话：C：FetchError')
    expect(text).toContain('本轮共 9 本，只返回前 2 本')
  })

  it('空结果只留摘要行；一家超 3 行按行数省略', () => {
    const empty = renderSearch({ books: [], failed: [], searched: 0, answered: 0, filtered: 0 })
    expect(empty).toBe('0 本（跑了 0 家、答话 0 家、滤去 0 条不相关）：')
    const wide = renderSearch({
      books: [{
        title: '甲', sourceCount: 1,
        sources: ['A', 'B', 'C', 'D'].map((n) => ({ sourceName: n, url: `https://${n}/1` })),
      }],
      failed: [], searched: 1, answered: 1, filtered: 0,
    })
    expect(wide).toContain('A(https://A/1)；B(https://B/1)；C(https://C/1)…')
  })
})

describe('renderRead / renderToc（截断口径）', () => {
  it('正文超 2000 字截断并标注规范值含全文', () => {
    const short = renderRead({ bookKey: 'k', chapterIndex: 0, chapterName: '一', text: '甲' })
    expect(short).toBe('《k》第 0 章（一）共 1 字：\n甲')
    const long = renderRead({ bookKey: 'k', chapterIndex: 1, chapterName: '二', text: '甲'.repeat(2001) })
    expect(long).toContain('…（截断，规范值含全文）')
  })

  it('目录只印前 10 章，超过时标注', () => {
    const chapters = Array.from({ length: 12 }, (_, i) => ({ chapterIndex: i, name: `第${i}章` }))
    const text = renderToc({ bookKey: 'k', total: 12, chapters })
    expect(text).toContain('[9] 第9章')
    expect(text).not.toContain('[10] 第10章')
    expect(text).toContain('…（截断，规范值含全部）')
  })
})

describe('renderShelf（列表 / 单本 / 移除）', () => {
  it('空架是一句结论；非空逐本给进度', () => {
    expect(renderShelfList({ books: [] })).toBe('书架是空的。')
    expect(renderShelfList({ books: [shelfItem({ author: '唐家' })] }))
      .toBe('《斗罗》 / 唐家 读到第 2 章（50%）')
  })
  it('加书 / 存进度 / 移除回执', () => {
    expect(renderShelfBook('add', { book: shelfItem() })).toBe('已加书：《斗罗》')
    expect(renderShelfBook('save_progress', { book: shelfItem() })).toBe('已存进度：《斗罗》读到第 2 章')
    expect(renderShelfRemove({ removed: true })).toBe('已移出书架（removed=true）')
  })
  it('规范值缺块时炸，不编「书目缺失」式回执', () => {
    expect(() => renderShelfList({})).toThrow(/缺少 books/)
    expect(() => renderShelfBook('add', {})).toThrow(/缺少 book/)
    expect(() => renderShelfRemove({})).toThrow(/缺少 removed/)
  })
})

describe('renderSource（列表 / 探针 / 启停 / 删除）', () => {
  const sources = [
    { sourceId: 's1', name: 'A', baseUrl: 'https://a', enabled: true, type: 'text', status: 'verified' },
    { sourceId: 's2', name: 'B', baseUrl: 'https://b', enabled: false, type: 'text', status: 'broken', statusDetail: 'x' },
  ]
  it('列表报启用数与逐源状态', () => {
    expect(renderSourceList({ sources })).toBe('共 2 个源（启用 1）：A（verified）；B（broken，已停用）')
  })
  it('探针成功/失败', () => {
    expect(renderSourceProbe({ ok: true, itemCount: 3, firstTitle: '斗罗' })).toBe('源可用：命中 3 条，首条「斗罗」')
    expect(renderSourceProbe({ ok: false, error: { code: 'FetchError', message: '超时' } })).toBe('源不可用：FetchError 超时')
  })
  it('启停与删除', () => {
    expect(renderSourceToggle({ enabled: true, sourceId: 's1' })).toBe('已启用源 s1')
    expect(renderSourceToggle({ enabled: false, sourceId: 's1' })).toBe('已停用源 s1')
    expect(renderSourceRemove({ sourceId: 's1', removed: true })).toBe('已删除源 s1（removed=true）')
  })
  it('规范值缺块时炸，不打印 undefined', () => {
    expect(() => renderSourceList({})).toThrow(/缺少 sources/)
    expect(() => renderSourceProbe({})).toThrow(/缺少 ok/)
    expect(() => renderSourceProbe({ ok: false })).toThrow(/缺少 error/)
    expect(() => renderSourceToggle({})).toThrow(/缺少 enabled\/sourceId/)
    expect(() => renderSourceRemove({})).toThrow(/缺少 sourceId\/removed/)
    expect(() => renderImport({})).toThrow(/缺少 outcomes/)
  })
})

describe('renderImport（逐条导入回执）', () => {
  it('失败点名缺什么、去重命中说明保留、成功标注未验证', () => {
    const text = renderImport({
      outcomes: [
        { name: '坏源', ok: false, missing: [{ field: 'bookSourceUrl', message: '缺字段' }, { field: 'searchUrl', message: '缺字段' }] },
        { name: '旧源', ok: true, dupSkipped: true },
        { name: '新源', ok: true },
      ],
    })
    expect(text).toContain('✗ 坏源：缺 bookSourceUrl、searchUrl')
    expect(text).toContain('↷ 旧源：同址已有可用源')
    expect(text).toContain('✓ 新源（已导入，未验证')
  })
})
