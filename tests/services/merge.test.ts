import { describe, expect, it } from 'vitest'
import { mergeBooks } from '../../src/services/merge.js'
import type { SearchGroup } from '../../src/shared/wire.js'

const hit = (over: Record<string, unknown> = {}) => ({
  title: '剑起长安', author: '青衫客', url: 'https://a.com/1', coverUrl: null,
  intro: null, lastChapterName: '第 412 章', kind: '玄幻', wordCount: null, ...over,
})
const group = (sourceId: string, hits: unknown[]): SearchGroup => ({
  sourceId, sourceName: sourceId, status: 'verified', hits: hits as never,
})

describe('跨源归并', () => {
  it('同一本（书名, 作者）合成一条，来源数即 origins 数', () => {
    const out = mergeBooks([group('A', [hit()]), group('B', [hit({ url: 'https://b.com/9' })])])
    expect(out).toHaveLength(1)
    expect(out[0].sourceCount).toBe(2)
    expect(out[0].origins.map((o) => o.sourceId)).toEqual(['A', 'B'])
    expect(out[0].origins[1].bookUrl).toBe('https://b.com/9')
  })

  it('同一源把同一本列两回，只算一个源——角标说的是「N 个源收录」，同源重复不是第二个源', () => {
    const out = mergeBooks([group('A', [hit(), hit({ url: 'https://a.com/2' })])])
    expect(out).toHaveLength(1)
    expect(out[0].sourceCount).toBe(1)
    expect(out[0].origins).toHaveLength(1)
  })

  it('去重不砍正常多源：同书来自 A、A、B → 两个源，A 只留这一页给的第一条入口', () => {
    const out = mergeBooks([
      group('A', [hit({ url: 'https://a.com/1' }), hit({ url: 'https://a.com/2' })]),
      group('B', [hit({ url: 'https://b.com/9' })]),
    ])
    expect(out).toHaveLength(1)
    expect(out[0].sourceCount).toBe(2)
    expect(out[0].origins.map((o) => o.sourceId)).toEqual(['A', 'B'])
    expect(out[0].origins[0].bookUrl).toBe('https://a.com/1')
  })

  it('作者为空**不归并**——重名书大量存在，合并等于把两本书焊成一本', () => {
    const out = mergeBooks([group('A', [hit({ author: null })]), group('B', [hit({ author: '' })])])
    expect(out).toHaveLength(2)
    expect(out.every((b) => b.sourceCount === 1)).toBe(true)
  })

  it('书名不同即不同书；书名做 trim 后比较', () => {
    const out = mergeBooks([group('A', [hit(), hit({ title: ' 剑起长安 ' }), hit({ title: '另一本' })])])
    expect(out).toHaveLength(2)
  })

  it('排序：来源数降序，同数保持首次出现序', () => {
    const out = mergeBooks([
      group('A', [hit({ title: '甲', author: 'x' }), hit({ title: '乙', author: 'y' })]),
      group('B', [hit({ title: '乙', author: 'y' })]),
    ])
    expect(out.map((b) => b.name)).toEqual(['乙', '甲'])
  })

  it('字段取首次出现那份，不合并成拼接串', () => {
    const out = mergeBooks([group('A', [hit({ intro: '第一份简介' })]), group('B', [hit({ intro: '第二份简介' })])])
    expect(out[0].intro).toBe('第一份简介')
  })
})
