import { describe, expect, it } from 'vitest'
import { cityEmptyKind, cityMeta, cityProgress, failureSummary, sourceCountLabel } from '../../src/client/city-view-model.js'
import type { ExploreBook, ExploreFailure } from '../../src/shared/wire.js'

/** 分类页 view-model 钉子：卡片元信息 / 角标 / 进度 / 失败摘要 / 空态判据的唯一算式。
 *  客户端逻辑层测试口径：纯函数、零 React。 */

const book = (over: Partial<ExploreBook> = {}): ExploreBook =>
  ({ name: '剑起长安', author: '青衫客', sourceCount: 1, origins: [], ...over })

describe('cityMeta（卡片元信息：缺字段就不显示）', () => {
  it('齐全时按 作者 · 分类 · 字数 拼', () => {
    expect(cityMeta(book({ kind: '玄幻', wordCount: '92.4 万字' }))).toBe('青衫客 · 玄幻 · 92.4 万字')
  })
  it('作者为空 → 只给后面的；一个都没有 → 空串（调用方整行不渲染）', () => {
    expect(cityMeta(book({ author: null, kind: '玄幻' }))).toBe('玄幻')
    expect(cityMeta(book({ author: null }))).toBe('')
  })
  it('缺中间段不留空位（不出现「 · 」双分隔符）', () => {
    expect(cityMeta(book({ kind: undefined, wordCount: '92.4 万字' }))).toBe('青衫客 · 92.4 万字')
  })
})

describe('sourceCountLabel / cityProgress / failureSummary', () => {
  it('来源角标只在多源时才值得说数量', () => {
    expect(sourceCountLabel(3)).toBe('3 源')
    expect(sourceCountLabel(1)).toBe('1 源')
  })
  it('进度文案：已 x / y 源；total 为 0 时不说谎（不写 0/0）', () => {
    expect(cityProgress(4, 6)).toBe('已 4 / 6 源')
    expect(cityProgress(0, 0)).toBe('')
  })
  it('失败条摘要只说数量，点名留给展开（逛时源不可见的例外只到这里）', () => {
    const f: ExploreFailure[] = [
      { sourceId: 'a', sourceName: '顶点', code: 'FetchError', message: '超时' },
      { sourceId: 'b', sourceName: '书友阁', code: 'RuleMissing', message: '缺书名规则' },
    ]
    expect(failureSummary(f)).toBe('2 个源没响应')
    expect(failureSummary([])).toBe('')
  })
})

describe('cityEmptyKind（空态分支的唯一判据）', () => {
  it('没源提供分类 → 说「还没有书源提供分类浏览」；有分类但这一类零结果 → 不说这句话', () => {
    expect(cityEmptyKind(0)).toBe('no-kinds')
    expect(cityEmptyKind(3)).toBe('has-kinds')
  })
})
