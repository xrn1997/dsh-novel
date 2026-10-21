import { describe, expect, it } from 'vitest'
import { evalJsonPath } from '../../src/engine/jsonpath.js'
import { UnsupportedRuleError } from '../../src/engine/errors.js'

const L = { segmentIndex: 0, segmentRaw: '$' }

describe('JSONPath 子集', () => {
  const data = { title: '凡人修仙传', info: { Datas: [{ n: '一' }, { n: '二' }] }, chapters: ['c1', 'c2', 'c3'] }

  it('点路径与标量 → Value', () => {
    expect(evalJsonPath('$.title', data, L, 'search')).toEqual({ kind: 'value', text: '凡人修仙传' })
  })

  it('下标与切片（半开区间，含负数从尾数）', () => {
    expect(evalJsonPath('$.chapters[0]', data, L, 'toc')).toEqual({ kind: 'value', text: 'c1' })
    expect(evalJsonPath('$.chapters[-1]', data, L, 'toc')).toEqual({ kind: 'value', text: 'c3' })
    expect(evalJsonPath('$.chapters[1:3]', data, L, 'toc')).toEqual({ kind: 'list', items: ['c2', 'c3'] })
    expect(evalJsonPath('$.chapters[-2:]', data, L, 'toc')).toEqual({ kind: 'list', items: ['c2', 'c3'] })
    expect(evalJsonPath('$.chapters[-2:-1]', data, L, 'toc')).toEqual({ kind: 'list', items: ['c2'] })
    expect(evalJsonPath('$.chapters[*]', data, L, 'toc')).toEqual({ kind: 'list', items: ['c1', 'c2', 'c3'] })
    // 取位失败 → Miss（与选择段 reducePicked 同口径）：切片裁空 / 下标越界（含负越界）
    expect(evalJsonPath('$.chapters[5:9]', data, L, 'toc').kind).toBe('miss')
    expect(evalJsonPath('$.chapters[9]', data, L, 'toc').kind).toBe('miss')
    expect(evalJsonPath('$.chapters[-9]', data, L, 'toc').kind).toBe('miss')
    // 对通配/切片打在非数组上 → 零命中 Miss
    expect(evalJsonPath('$.title[*]', data, L, 'toc').kind).toBe('miss')
  })

  it('数组对象元素 JSON.stringify', () => {
    expect(evalJsonPath('$.info.Datas', data, L, 'search')).toEqual({
      kind: 'list',
      items: ['{"n":"一"}', '{"n":"二"}'],
    })
  })

  it('递归下降 $..n 按序收集', () => {
    expect(evalJsonPath('$..n', data, L, 'search')).toEqual({ kind: 'list', items: ['一', '二'] })
  })

  it('零命中 → Miss；空数组 → 空 list', () => {
    expect(evalJsonPath('$.nope', data, L, 'search').kind).toBe('miss')
    expect(evalJsonPath('$.emptyArr', { emptyArr: [] }, L, 'search')).toEqual({ kind: 'list', items: [] })
  })

  it('取到 null → Miss', () => {
    expect(evalJsonPath('$.title', { title: null }, L, 'search').kind).toBe('miss')
  })

  it('过滤器与脚本表达式 → UnsupportedRuleError', () => {
    expect(() => evalJsonPath('$.chapters[?(@.length>1)]', data, L, 'toc')).toThrow(UnsupportedRuleError)
    expect(() => evalJsonPath('$.chapters[(@.length-1)]', data, L, 'toc')).toThrow(UnsupportedRuleError)
  })

  it('@ / & 特殊符号 → UnsupportedRuleError', () => {
    expect(() => evalJsonPath('@.title', data, L, 'search')).toThrow(UnsupportedRuleError)
    expect(() => evalJsonPath('$.chapters.&', data, L, 'toc')).toThrow(UnsupportedRuleError)
  })

  it('真实源形态：无点下标与尾通配（冗余点 .[*]）', () => {
    expect(
      evalJsonPath('$.chapterInfo.chapters.[*]', { chapterInfo: { chapters: ['x'] } }, L, 'toc'),
    ).toEqual({ kind: 'list', items: ['x'] }) // 允许 `.[*]` 的冗余点
  })

  it('属性通配 .*（真实源 $.data.* / $.comics.*——对象取全部值、数组取全部元素）', () => {
    expect(evalJsonPath('$.data.*', { data: { a: 'x', b: 'y' } }, L, 'search'))
      .toEqual({ kind: 'list', items: ['x', 'y'] })
    expect(evalJsonPath('$.comics.*', { comics: ['c1', 'c2'] }, L, 'search'))
      .toEqual({ kind: 'list', items: ['c1', 'c2'] })
    // 零命中（data 缺失）→ Miss，不误产
    expect(evalJsonPath('$.data.*', { other: 1 }, L, 'search').kind).toBe('miss')
  })

  it('裸 $ → 数据本身', () => {
    expect(evalJsonPath('$', 'plain', L, 'search')).toEqual({ kind: 'value', text: 'plain' })
    expect(evalJsonPath('$', ['a', 'b'], L, 'search')).toEqual({ kind: 'list', items: ['a', 'b'] })
  })

  it('裸路径按 $ 根归一（JSON 模式的有意放宽）', () => {
    expect(evalJsonPath('data[*]', { data: ['a', 'b'] }, L, 'search'))
      .toEqual({ kind: 'list', items: ['a', 'b'] })
    expect(evalJsonPath('.data[*]', { data: ['a'] }, L, 'search'))
      .toEqual({ kind: 'list', items: ['a'] })
    // 前导点只补 `$`：补成 `$..data[*]` 会把根相对路径变成递归下降
    expect(evalJsonPath('.data[*]', { nested: { data: ['WRONG'] }, data: ['RIGHT'] }, L, 'search'))
      .toEqual({ kind: 'list', items: ['RIGHT'] })
    expect(evalJsonPath('data.name', { data: { name: 'A' } }, L, 'search'))
      .toEqual({ kind: 'value', text: 'A' })
  })
})
