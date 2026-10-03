import { describe, expect, it } from 'vitest'
import {
  bookListEmpty, cityEmptyKind, cityMeta, cityProgress, failureSummary, roundReadout, sourceCountLabel,
} from '../../src/client/city-view-model.js'
import type { RoundShape } from '../../src/client/city-view-model.js'
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
    // 措辞只说「这一页没回来」：同一张清单里也住着「已累积、只是这一页失败」的源，说成「没响应」就是诬告
    expect(failureSummary(f)).toBe('2 个源这一页没回来')
    expect(failureSummary([])).toBe('')
  })
})

describe('cityEmptyKind（空态分支的唯一判据）', () => {
  it('没源提供分类 → 说「还没有书源提供分类浏览」；有分类但这一类零结果 → 不说这句话', () => {
    expect(cityEmptyKind(0)).toBe('no-kinds')
    expect(cityEmptyKind(3)).toBe('has-kinds')
  })
})

/** 轮次判据的输入桩：只喂 `bookListEmpty`/`roundReadout` 读的那几个字段 */
const rnd = (over: Partial<RoundShape> = {}): RoundShape =>
  ({ total: 3, done: 3, books: [], running: false, cancelled: false, ...over })

describe('bookListEmpty（空态按轮次的形状说话，不按书单数组空不空说话）', () => {
  it('干净跑完且这一轮有源参与 → 唯一配得上「这一类还没有书」的一态', () => {
    expect(bookListEmpty(rnd(), 0, null)?.title).toBe('这一类还没有书')
    expect(bookListEmpty(rnd(), 0, null)?.hint).toContain('3 个源都答完了')
  })
  it('有源这一页没回来 → 说法改口：不许把「没回来」读成「没有货」', () => {
    // 与失败条同一套词（「这一页没回来」）：同一条清单在相邻两处各叫一个名字，读起来就像两份事实
    expect(bookListEmpty(rnd(), 2, null)?.hint).toContain('这一页没回来')
    expect(bookListEmpty(rnd(), 2, null)?.hint).not.toContain('都答完了')
  })
  it('四种未定态一律不占位（沉默比假结论诚实）：在跑 / 被停止 / 零源 / 报错的一轮', () => {
    expect(bookListEmpty(rnd({ running: true }), 0, null)).toBeNull()
    expect(bookListEmpty(rnd({ cancelled: true }), 0, null)).toBeNull()
    expect(bookListEmpty(rnd({ total: 0 }), 0, null)).toBeNull()
    expect(bookListEmpty(rnd(), 0, '分类结果读取失败：网络')).toBeNull()
  })
  it('有书就铺网格，不占位', () => {
    expect(bookListEmpty(rnd({ books: [book()] }), 0, null)).toBeNull()
  })
})

describe('roundReadout（被动读数：停止不是完成，零源的一轮也不留空白）', () => {
  it('在跑：源数还没数出来时说「正在启动」，之后给进度', () => {
    expect(roundReadout(rnd({ running: true, total: 0, done: 0 }))).toBe('正在启动分类抓取…')
    expect(roundReadout(rnd({ running: true, total: 4, done: 1 }))).toBe('已 1 / 4 源')
  })
  it('被停止优先于进度文案——不许说得像一个走到了底的轮次', () => {
    expect(roundReadout(rnd({ cancelled: true, total: 2, done: 1 }))).toBe('已停止')
  })
  it('零源的一轮仍是一轮：如实说「没有源参与」，不是空读数', () => {
    expect(roundReadout(rnd({ total: 0, done: 0 }))).toBe('这一轮没有源参与')
  })
})
