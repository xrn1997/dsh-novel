import { describe, expect, it } from 'vitest'
import { mergeBooks } from '../../src/shared/merge-by-book.js'
import type { SearchGroup, SearchHit } from '../../src/shared/wire.js'

/**
 * 归并面的钉子。夹具的分工要读得出：同不同键由「规范化后的书名＋作者」说了算，所以
 * 「该并的一本书」两条样本必须**作者也一致**（只差装饰写法），而「该分两本」正靠作者不同——
 * 一侧作者缺席也算不同（那是两本书，不是一本书缺了作者那一栏）。
 * 档位（exact／contains）由判据给，样本标题里带不带本轮关键词就是档的所在——
 * 不含关键词的写法（如「都市至尊医仙」）落 suspect，会被 `kept` 那道闸整个挡在视图外。
 * 「几家」数的是去重后的源而 `sources` 留每一行，所以凡主张 N 家的夹具都得真给到 N 个不同的源。
 */

const hit = (title: string, over: Partial<SearchHit> = {}): SearchHit => ({
  title, author: null, url: `https://x/${title}`, coverUrl: null, intro: null, lastChapterName: null, kind: null, wordCount: null, ...over,
})
const group = (sourceId: string, hits: SearchHit[]): SearchGroup =>
  ({ sourceId, sourceName: `源${sourceId}`, status: 'verified', hits })

const KW = '冰魔女的契约'

describe('mergeBooks：归并键与输入范围', () => {
  it('同键跨源归并成一本，sources 按到达序累积', () => {
    const r = mergeBooks(KW, [group('a', [hit('冰魔女的契约', { author: '狐不妖' })]), group('b', [hit('《冰魔女的契约》', { author: '狐不妖' })])])
    expect(r.total).toBe(1)
    expect(r.books[0].sources.map((s) => s.sourceId)).toEqual(['a', 'b'])
    expect(r.books[0].sourceCount).toBe(2)
  })

  it('书名或作者规范化后不同即两本（重名书大量存在）', () => {
    const r = mergeBooks(KW, [group('a', [hit('冰魔女的契约', { author: '甲' })]), group('b', [hit('冰魔女的契约', { author: '乙' })])])
    expect(r.total).toBe(2)
  })

  it('作者缺席不是通配：同书名下一本没作者、一本有作者就是两本', () => {
    // 把缺席读成「这一栏随便配」是假合并最常走的那条路：它会把别家的书并进来还顶上空栏
    const r = mergeBooks(KW, [group('a', [hit('冰魔女的契约')]), group('b', [hit('冰魔女的契约', { author: '狐不妖' })])])
    expect(r.total).toBe(2)
    expect(r.books.map((b) => b.author)).toEqual([null, '狐不妖'])
  })

  it('作者缺席照旧参与归并（对面同键含空作者）', () => {
    const r = mergeBooks(KW, [group('a', [hit('冰魔女的契约')]), group('b', [hit('冰魔女的契约')])])
    expect(r.total).toBe(1)
  })

  it('suspect 不参与归并：两百家源的推荐位被归并就是成堆假书', () => {
    const r = mergeBooks(KW, [group('a', [hit('都市至尊医仙')]), group('b', [hit('都市至尊医仙')])])
    expect(r.total).toBe(0)
    expect(r.books).toEqual([])
  })

  it('一家撞两条：sources 留两行、家数仍是一家（行与家是两条读数）', () => {
    // `searchOne` 不做源内去重，同一家把装饰写法与裸写法各给一条是常态。把行数当家数，一是那一栏
    // 会报出没有答话的家，二是这一家在序里压过两家真答话的源。
    const r = mergeBooks(KW, [group('a', [hit('冰魔女的契约', { author: '狐不妖' }), hit('《冰魔女的契约》', { author: '狐不妖' })])])
    expect(r.total).toBe(1)
    expect(r.books[0].sources.length).toBe(2)
    expect(r.books[0].sourceCount).toBe(1)
  })

  it('带 error 的组整个跳过（失败源是排查轴，不是一本空书）', () => {
    // 两条轴分开钉：本轮失败（error）与源的历史状态（status）互不蕴含，这里给 verified 的源
    // 挂上本轮超时——闸只认 error，认 status 的写法在这一条上就把失败源的书放进了视图
    const failed: SearchGroup = { sourceId: 'z', sourceName: '坏源', status: 'verified', hits: [hit('冰魔女的契约')], error: { code: 'FetchError', message: '超时' } }
    expect(mergeBooks(KW, [failed]).total).toBe(0)
  })

  it('未验证的新源照旧进视图（闸不是状态筛：按 status 筛会悄悄清空整轮）', () => {
    // `importOne` 不探针，新导入的源恒 unverified（见 services/reading.ts 的 importOne），
    // 而在探针对象上 verified 只证搜索面——按状态筛等于把几乎每一本真书丢掉还全程绿灯
    const fresh: SearchGroup = { sourceId: 'n', sourceName: '新源', status: 'unverified', hits: [hit('冰魔女的契约', { author: '狐不妖' })] }
    const r = mergeBooks(KW, [fresh])
    expect(r.total).toBe(1)
    expect(r.books[0].sourceCount).toBe(1)
  })
})

describe('mergeBooks：序与上限', () => {
  it('档序优先，同档按家数降序，再同按首个源到达序', () => {
    const r = mergeBooks(KW, [
      group('a', [hit('冰魔女的契约', { author: '甲' })]),                // exact / 1 家
      group('b', [hit('冰魔女的契约外传')]),                              // contains / 1 家（书名含关键词而不等于它）
      group('c', [hit('冰魔女的契约', { author: '乙' })]),                 // exact / 与 d 各一家凑成 2 家（最后到达却该排第一）
      group('d', [hit('《冰魔女的契约》', { author: '乙' })]),              // exact / 同键，并入 c 那一本
    ])
    expect(r.books.map((b) => `${b.title}|${b.sourceCount}`)).toEqual(['冰魔女的契约|2', '冰魔女的契约|1', '冰魔女的契约外传|1'])
    expect(r.books.map((b) => b.relevance)).toEqual(['exact', 'exact', 'contains'])
  })

  it('档序压在家数之上：两家的 contains 排不过一家的 exact', () => {
    // 两个子句的**优先级**只有这一条钉得住：夹具故意让低档那本行数与家数都更高，
    // 把家数子句挪到档序之前就会把它顶到首位（其余夹具两子句同向，换序照样绿）
    const r = mergeBooks(KW, [
      group('a', [hit('冰魔女的契约正传')]),                               // contains / 1 家
      group('b', [hit('《冰魔女的契约正传》')]),                            // contains / 并入上一本，凑成 2 家
      group('c', [hit('冰魔女的契约', { author: '甲' })]),                 // exact / 1 家，最后到达
    ])
    expect(r.books.map((b) => `${b.title}|${b.relevance}|${b.sourceCount}`)).toEqual(['冰魔女的契约|exact|1', '冰魔女的契约正传|contains|2'])
  })

  it('同档那一子句数的是家不是行：一家两条压不过两家各一条', () => {
    // 两本书的行数刻意做成一样（各 2 行）：家数若按行数算就是平手 ⇒ 落到到达序 ⇒ 先到那本赢；
    // 按去重源算才分得出胜负 ⇒ 两家那本在前
    const r = mergeBooks(KW, [
      group('a', [hit('冰魔女的契约', { author: '甲' }), hit('《冰魔女的契约》', { author: '甲' })]),
      group('b', [hit('冰魔女的契约', { author: '乙' })]),
      group('c', [hit('『冰魔女的契约』', { author: '乙' })]),
    ])
    expect(r.books.map((b) => `${b.author}|${b.sourceCount}|${b.sources.length}`)).toEqual(['乙|2|2', '甲|1|2'])
  })

  it('上限截的是默认视图，不是账目：total 仍是全量本数', () => {
    const many = [1, 2, 3].map((i) => group(`s${i}`, [hit(`冰魔女的契约${i}`)]))
    const r = mergeBooks(KW, many, 2)
    expect(r.books.length).toBe(2)
    expect(r.total).toBe(3)
  })

  it('截的是排完序的前 M 本，不是先到达的前 M 本', () => {
    const r = mergeBooks(KW, [
      group('a', [hit('冰魔女的契约一')]),                       // contains / 1 家，先到
      group('b', [hit('冰魔女的契约二')]),                       // contains / 1 家
      group('c', [hit('冰魔女的契约', { author: '乙' })]),        // exact / 与 d 各一家凑成 2 家，最后到达
      group('d', [hit('《冰魔女的契约》', { author: '乙' })]),     // exact / 同键，并入 c 那一本
    ], 2)
    expect(r.books.map((b) => `${b.title}|${b.sourceCount}`)).toEqual(['冰魔女的契约|2', '冰魔女的契约一|1'])
    expect(r.total).toBe(3)
  })

  it('缺省上限就是 SEARCH_BOOKS_CAP 那一个主人', async () => {
    const { SEARCH_BOOKS_CAP } = await import('../../src/shared/wire.js')
    expect(SEARCH_BOOKS_CAP).toBe(200)
    const many = Array.from({ length: SEARCH_BOOKS_CAP + 1 }, (_, i) => group(`s${i}`, [hit(`冰魔女的契约${i}`)]))
    const r = mergeBooks(KW, many)
    expect(r.books.length).toBe(SEARCH_BOOKS_CAP)
    expect(r.total).toBe(SEARCH_BOOKS_CAP + 1)
  })
})

describe('mergeBooks：书行那两个名字', () => {
  it('取首个到达源的原样，不做众数或投票', () => {
    // 两家投「干净写法」一票、首家仍赢：投票与众数都在这一条的射程里（作者尾随空格同理）
    const r = mergeBooks(KW, [
      group('a', [hit('『冰魔女的契约』', { author: '狐不妖 ' })]),
      group('b', [hit('冰魔女的契约', { author: '狐不妖' })]),
      group('c', [hit('冰魔女的契约', { author: '狐不妖' })]),
    ])
    expect(r.total).toBe(1)
    expect(r.books[0].title).toBe('『冰魔女的契约』')
    expect(r.books[0].author).toBe('狐不妖 ')
    expect(r.books[0].relevance).toBe('exact')
  })

  it('sources 各条带着自己那一家的名字与地址（归并只收视图，不夺走任何一条的动作）', () => {
    const r = mergeBooks(KW, [group('a', [hit('冰魔女的契约', { author: '狐不妖' })]), group('b', [hit('《冰魔女的契约》', { author: ' 狐不妖' })])])
    expect(r.books[0].sources.map((s) => `${s.sourceName}|${s.title}|${s.author}`)).toEqual(['源a|冰魔女的契约|狐不妖', '源b|《冰魔女的契约》| 狐不妖'])
    expect(r.books[0].sources.map((s) => s.url)).toEqual(['https://x/冰魔女的契约', 'https://x/《冰魔女的契约》'])
  })
})
