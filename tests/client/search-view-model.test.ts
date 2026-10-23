import { describe, expect, it } from 'vitest'
import type { SearchGroup, SearchHit } from '../../src/shared/wire.js'
import {
  addAllReceipt, bookRowKey, bookRows, deriveRound, isSeatLanded, newlyLandedSeats, rowId, rowKeys,
  rowMeta, shelfSeats, shortAuthor,
} from '../../src/client/search-view-model.js'
import type { RowRef } from '../../src/client/search-view-model.js'

/**
 * 搜索结果页派生的钉子（判据的「为什么」住 `CONTEXT.md` 的单位律词条与 `docs/adr/0032` / `0033`，
 * 这里只钉算式本身）。这批算式此前是 `SearchView` 的模块私有函数，只能在整页 jsdom 里间接触达——
 * 抽到本层后，单位律、行身份与逐源回读各自有一条不用起 DOM 的钉子。
 */

function hit(partial: Partial<SearchHit> & { title: string }): SearchHit {
  return {
    author: null, url: null, coverUrl: null, intro: null,
    lastChapterName: null, kind: null, wordCount: null, ...partial,
  }
}

function group(sourceId: string, hits: SearchHit[], extra: Partial<SearchGroup> = {}): SearchGroup {
  return { sourceId, sourceName: sourceId, status: 'unverified', hits, ...extra }
}

describe('轮级读数：条／本／家三条读数绝不折叠', () => {
  const view = deriveRound({
    keyword: '斗罗',
    groups: [
      group('s1', [hit({ title: '斗罗1', url: 'u1' }), hit({ title: '斗罗1', url: 'u2' })]),
      group('s2', [hit({ title: '与关键词无关', url: 'u3' })]),
      group('s3', [], { error: { code: 'ECONNRESET', message: '站点不可达' } }),
    ],
  })
  const s = view.summary

  it('searched 数的是真回来的组数，不是本轮计划家数', () => {
    expect(s.searched).toBe(3)
  })
  it('hits 数条（一行一条）、answered 数答话的家、failed 数带 error 的组', () => {
    expect(s.hits).toBe(3)
    expect(s.answered).toBe(2)
    expect(s.failed).toBe(1)
  })
  it('answered 数答话的家（答零条也算）；found 是历史误名', () => {
    const onlyEmpty = deriveRound({ keyword: 'x', groups: [group('s9', [])] }).summary
    expect(onlyEmpty).toEqual({ searched: 1, answered: 1, failed: 0, hits: 0, kept: 0, suspect: 0 })
  })
  it('kept 只汇总分区结果，不在此写第二份判据（收口与组头因此对得上）', () => {
    expect(s.kept).toBe(2)                     // s2 那一条被判 suspect，移出默认视野
    expect(s.kept).toBeLessThan(s.hits)        // 两个数不一致 → 收口行必须并报
  })
})

describe('行身份：(源, 地址) 只喂 React key 与元数据回读；架位按地址单键', () => {
  it('同身份重复才垫位次（一家给同一地址两种写法是既有形状，整行列号会随旁行挪位串状态）', () => {
    const rows: RowRef[] = [
      { sourceId: 's1', hit: hit({ title: 'a', url: 'u1' }) },
      { sourceId: 's1', hit: hit({ title: 'a', url: 'u1' }) },
      { sourceId: 's1', hit: hit({ title: 'a', url: 'u2' }) },
    ]
    const keys = rowKeys(rows)
    expect(keys[0]).toBe(rowId('s1', 'u1'))
    expect(keys[1]).toBe(`${rowId('s1', 'u1')}#1`)
    expect(new Set(keys).size).toBe(3)
  })
  it('地址在 key 里：换一轮同一源同一位置给了新地址，就是新行（不许顶用上一行的「已在书架」）', () => {
    const before = rowKeys([{ sourceId: 's1', hit: hit({ title: 'a', url: 'u1' }) }])
    const after = rowKeys([{ sourceId: 's1', hit: hit({ title: 'a', url: 'u9' }) }])
    expect(before[0]).not.toBe(after[0])
  })
  it('rowMeta：同址两行取第一条的元数据（同一地址的封面本就是一份）', () => {
    const meta = rowMeta([group('s1', [
      hit({ title: '甲', url: 'u1', coverUrl: 'c-first' }),
      hit({ title: '甲', url: 'u1', coverUrl: 'c-second' }),
    ])])
    expect(meta.get(rowId('s1', 'u1'))?.coverUrl).toBe('c-first')
    expect(meta.size).toBe(1)
  })
})

describe('按书轴：行 key 认名字对、逐源行回读命中', () => {
  const view = deriveRound({
    keyword: '斗罗',
    groups: [
      group('s1', [hit({ title: '斗罗大陆', author: '唐家三少', url: 'u1', coverUrl: 'c1', lastChapterName: '第 1 章' })]),
      group('s2', [hit({ title: '斗罗大陆', author: '唐家三少', url: 'u2' })], { statusDetail: 'ok' }),
    ],
  })
  const book = view.merged.books[0]

  it('bookRowKey 认 (书名, 作者)，不认它排在第几（同档按家数重排不许把展开态串到别的书上）', () => {
    const same = { ...book, sources: [...book.sources].reverse() }
    expect(bookRowKey(book)).toBe(bookRowKey(same))
    expect(bookRowKey({ ...book, title: '别的书' })).not.toBe(bookRowKey(book))
  })
  it('bookRows：名字用归并带来的那一份，其余从本轮命中回读；回读不到给 null，不发明缺键', () => {
    const rows = bookRows(book, rowMeta([
      group('s1', [hit({ title: '斗罗大陆', author: '唐家三少', url: 'u1', coverUrl: 'c1', lastChapterName: '第 1 章' })]),
      group('s2', [hit({ title: '斗罗大陆', author: '唐家三少', url: 'u2' })], { statusDetail: 'ok' }),
    ]))
    expect(rows).toHaveLength(2)
    expect(rows[1].hit.coverUrl).toBeNull()          // s2 那条命中没有封面
    expect(rows[0].hit.coverUrl).toBe('c1')
    expect(Object.keys(rows[1].hit).sort()).toEqual(
      ['author', 'coverUrl', 'intro', 'kind', 'lastChapterName', 'title', 'url', 'wordCount'],
    )
  })
})

describe('shortAuthor：只在逗号处切，收的是行宽不是信息', () => {
  it('逗号级名单只留前两位', () => {
    expect(shortAuthor('甲，乙，丙，丁')).toBe('甲，乙 等')
  })
  it('两位与一位都原样给回', () => {
    expect(shortAuthor('甲，乙')).toBe('甲，乙')
    expect(shortAuthor('唐家三少')).toBe('唐家三少')
  })
  it('空格分隔的角色表切不出「第二位」，整串交给 CSS 省略号', () => {
    expect(shortAuthor('萧炎：锦鲤 药老：北炎')).toBe('萧炎：锦鲤 药老：北炎')
  })
})

describe('deriveRound 预计算行身份与架位', () => {
  it('groups carry kept/suspect rows and keys', () => {
    const view = deriveRound({
      keyword: '斗罗',
      groups: [group('s1', [hit({ title: '斗罗1', url: 'u1' }), hit({ title: '无关', url: 'u2' })])],
    })
    expect(view.groupViews[0].keptRows.map((r) => r.hit.url)).toEqual(['u1'])
    expect(view.groupViews[0].keptKeys).toEqual([rowId('s1', 'u1')])
    expect(view.groupViews[0].suspectRows.map((r) => r.hit.url)).toEqual(['u2'])
    expect(view.groupViews[0].suspectKeys).toEqual([rowId('s1', 'u2')])
  })

  it('books carry rows, keys and the seat set', () => {
    const view = deriveRound({
      keyword: '斗罗',
      groups: [
        group('s1', [hit({ title: '斗罗大陆', author: '唐家三少', url: 'u1' })]),
        group('s2', [hit({ title: '斗罗大陆', author: '唐家三少', url: 'u2' })]),
      ],
    })
    expect(view.bookViews[0].rows.map((r) => r.hit.url)).toEqual(['u1', 'u2'])
    expect(view.bookViews[0].keys).toEqual(view.bookViews[0].rows.map((r) => rowId(r.sourceId, r.hit.url)))
    expect([...view.bookViews[0].seats]).toEqual(['u1', 'u2'])
  })
})

describe('架位：凭地址认，数架位不数 PUT', () => {
  const ok = { ok: true, bookKey: 'u1' } as const
  const bad = { ok: false, error: new Error('只读') } as const
  const rows: RowRef[] = [
    { sourceId: 's1', hit: hit({ title: 'a', url: 'u1' }) },
    { sourceId: 's2', hit: hit({ title: 'a', url: 'u1' }) },   // 跨源同址 = 一行一 PUT，但只有一个架位
    { sourceId: 's1', hit: hit({ title: 'a', url: null }) },   // 没地址的那条进不了架
  ]
  it('shelfSeats 只数有地址的行，且跨源同址也折叠成一个架位', () => {
    expect([...shelfSeats(rows)]).toEqual(['u1'])
  })
  it('newlyLandedSeats 按地址去重成功回执（两发幂等 PUT 只报「已加 1 个架位」）', () => {
    expect(newlyLandedSeats(rows.slice(0, 2), [ok, ok])).toEqual(['u1'])
  })
  it('失败的行不进回执，也不冒充「新落架」', () => {
    expect(newlyLandedSeats(rows.slice(0, 2), [bad, ok])).toEqual(['u1'])
  })
  it('addAllReceipt 一次给 newly / stillMissing / noAddress', () => {
    expect(addAllReceipt({ rows, landed: new Set(), todo: rows.slice(0, 2), outcomes: [bad, ok] }))
      .toEqual({ newly: ['u1'], stillMissing: 0, noAddress: 1 })
    expect(addAllReceipt({ rows, landed: new Set(), todo: rows.slice(0, 2), outcomes: [bad, bad] }))
      .toEqual({ newly: [], stillMissing: 1, noAddress: 1 })
  })
  it('入架态按地址认：源不同但地址相同算已落；无地址永远未落', () => {
    expect(isSeatLanded(new Set(['u1']), hit({ title: 'a', url: 'u1' }))).toBe(true)
    expect(isSeatLanded(new Set(['u1']), hit({ title: 'a', url: null }))).toBe(false)
  })
})
