import { describe, expect, it } from 'vitest'
import {
  bookListEmpty, cityEmptyState, cityMeta, kindCountLabel, pageReadout, roundReadout, sheetKeyword,
} from '../../src/client/city-view-model.js'
import type { RoundShape } from '../../src/client/city-view-model.js'
import type { ExploreBook } from '../../src/shared/wire.js'

/** 分类页 view-model 钉子：卡片元信息 / 源行 / 跨源关键词 / 尾行读数 / 空态判据的唯一算式。
 *  客户端逻辑层测试口径：纯函数、零 React。浏览轴收成按源后，跨源读数（「N 源」「已 x / y 源」）
 *  在本层没有对象——删掉的那几条不复活。 */

const book = (over: Partial<ExploreBook> = {}): ExploreBook =>
  ({ name: '剑起长安', author: '青衫客', bookUrl: 'https://a/1',
    coverUrl: null, kind: null, lastChapter: null, intro: null, wordCount: null, ...over })

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

describe('按源的派生层', () => {
  it('源行右端只报「这个源自己声明了几类」：分组不进浏览面的源行', () => {
    expect(kindCountLabel(2)).toBe('2 类')
    expect(kindCountLabel(0)).toBe('0 类')
  })
  it('跨源关键词：有作者就带上（重名书大量存在），没有就只给书名——不猜、不补', () => {
    expect(sheetKeyword({ name: '半城风月', author: '沈念' })).toBe('半城风月 沈念')
    expect(sheetKeyword({ name: '半城风月', author: null })).toBe('半城风月')
  })
  it('尾行读数只说页与本数，不再说「N / M 源」', () => {
    expect(pageReadout(1, 12)).toBe('第 1 页 · 这一页 12 本')
    expect(pageReadout(3, 47)).toBe('第 3 页 · 累计 47 本')
  })
})

describe('cityEmptyState（空态分支的唯一判据：轴已从分类数换成可选源数）', () => {
  it('没有源提供分类入口 → 「no-sources」；有可选源但这一类零结果 → 「has-sources」（两态不折叠）', () => {
    expect(cityEmptyState(0)).toBe('no-sources')
    expect(cityEmptyState(3)).toBe('has-sources')
  })
})

/** 轮次判据的输入桩：只喂 `bookListEmpty`/`roundReadout` 读的那几个字段（RoundShape 结构子集）。 */
const rnd = (over: Partial<RoundShape> = {}): RoundShape =>
  ({ books: [], running: false, cancelled: false, page: 1, hasMore: false, ...over })

describe('bookListEmpty（空态按轮次的形状说话，不按书单数组空不空说话）', () => {
  it('跑完且没错误才配得上「这一类还没有书」', () => {
    expect(bookListEmpty(rnd(), null)).toEqual({
      title: '这一类还没有书',
      hint: '这个源在这一类没给出书——空结果不是失败，换个分类或换个源看看。',
    })
  })
  it('在途 / 停止 / 报错都沉默：三种未定态都不占位（有错误时由错误横幅说话，不叠一句空态）', () => {
    expect(bookListEmpty(rnd({ running: true }), null)).toBeNull()
    expect(bookListEmpty(rnd({ cancelled: true }), null)).toBeNull()
    expect(bookListEmpty(rnd(), '超时')).toBeNull()
  })
  it('有书就铺网格，不占位', () => {
    expect(bookListEmpty(rnd({ books: [book()] }), null)).toBeNull()
  })
})

describe('roundReadout（被停止 / 还在跑 / 本数读数，三条各说各的；抓失败归横幅）', () => {
  it('停止优先于进度：不许说得像一个走到了底的轮次', () => {
    expect(roundReadout(rnd({ cancelled: true, page: 2 }))).toBe('已停止')
  })
  it('还在跑而一页未回：说「正在启动」，此刻没有本数可报', () => {
    expect(roundReadout(rnd({ running: true }))).toBe('正在启动分类抓取…')
  })
  it('跑完有书：归本数读数（页码取快照给的，不由本地加）', () => {
    expect(roundReadout(rnd({ books: [book()] as never[], page: 2 }))).toBe('第 2 页 · 累计 1 本')
  })
  it('本层不再收 error：错误那句话归失败横幅说，尾行重复一遍就是同一事实两个家', () => {
    expect(roundReadout(rnd({ page: 2 }))).toBe('第 2 页 · 累计 0 本')
  })
})
