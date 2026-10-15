import { describe, expect, it } from 'vitest'
import { RANKED, RELEVANCE_RANK, normalizeRelevance, partitionByRelevance, relevanceOf } from '../../src/shared/relevance.js'
import type { SearchHit } from '../../src/shared/wire.js'

/** 只给判据吃得到的三件：其余字段与本判据无关（多余键会让用例误以为它们在案） */
const hit = (title: string, over: Partial<SearchHit> = {}): SearchHit => ({
  title, author: null, url: null, coverUrl: null, intro: null, lastChapterName: null, kind: null, wordCount: null, ...over,
})

describe('normalizeRelevance：书名号与全半角是同一件事', () => {
  it.each([
    ['《冰魔女的契约》', '冰魔女的契约'],
    ['『冰魔女的契约』', '冰魔女的契约'],
    ['冰魔女 的 契约', '冰魔女的契约'],
    ['Ｂｅｔａ', 'beta'],
    ['冰魔女的契约', '冰魔女的契约'],
  ])('%s → %s', (raw, want) => { expect(normalizeRelevance(raw)).toBe(want) })

  it('null 与空串不折叠：两者都归空串（Miss 与空集合的分工在取值面，这里只比字符串）', () => {
    expect(normalizeRelevance(null)).toBe('')
    expect(normalizeRelevance('')).toBe('')
  })
})

describe('relevanceOf：三档判据', () => {
  it('书名整串等于关键词 → exact（书名号两边都剥，所以带号的关键词也走到这一档）', () => {
    expect(relevanceOf('《冰魔女的契约》', hit('冰魔女的契约'))).toBe('exact')
    expect(relevanceOf('冰魔女的契约', hit('《冰魔女的契约》'))).toBe('exact')
  })

  it('作者整串等于关键词 → exact', () => {
    expect(relevanceOf('狐不妖', hit('别的书', { author: '狐不妖' }))).toBe('exact')
  })

  it('书名／作者／分类任一含关键词 → contains', () => {
    expect(relevanceOf('冰魔女', hit('冰魔女的契约'))).toBe('contains')
    expect(relevanceOf('冰魔女的契约', hit('小冰魔女的契约'))).toBe('contains')   // 蹭名的假阳：判据固有代价
    expect(relevanceOf('狐不', hit('某书', { author: '狐不妖' }))).toBe('contains')
    expect(relevanceOf('玄幻', hit('某书', { kind: '玄幻,完结' }))).toBe('contains')
  })

  it('关键词是「书名 作者」时，任一 token 被书名含即 contains（书城浮层 sheetKeyword 的形态）', () => {
    expect(relevanceOf('冰魔女的契约 狐不妖', hit('冰魔女的契约', { author: '佚名' }))).toBe('contains')
    expect(relevanceOf('冰魔女的契约 狐不妖', hit('狐不妖传', { author: null }))).toBe('contains')
  })

  it('三者都不含 → suspect', () => {
    expect(relevanceOf('冰魔女的契约', hit('都市至尊医仙', { author: '佚名' }))).toBe('suspect')
    expect(relevanceOf('冰魔女的契约', hit('冰魔女契约'))).toBe('suspect')   // 少一个「的」：暂不预设去虚字放行
  })

  it('空关键词＝没有这一维：一律 contains，绝不判 suspect', () => {
    expect(relevanceOf('', hit('任何东西'))).toBe('contains')
    expect(relevanceOf('《》', hit('任何东西'))).toBe('contains')
    expect(relevanceOf('   ', hit('任何东西'))).toBe('contains')
  })
})

describe('partitionByRelevance：默认视野与序', () => {
  // 站点序与档序刻意相反：唯一的 exact 摆在一条 contains 之后；同档两条按站点序是下部在前，
  // 而任何按书名的升序 tie-break（Unicode 或拼音）都会把上部挪到前面。这样删掉排序、或把排序换成按书名，
  // 都会红——后续任务直接照 kept 的现下序渲染，档序在这里没钉就等于把假设写成没人看的默契。
  const hits = [
    hit('冰魔女的契约 下部'), hit('完全无关甲'), hit('冰魔女的契约'), hit('冰魔女的契约 上部'), hit('完全无关乙'),
  ]
  const p = partitionByRelevance('冰魔女的契约', hits)

  it('suspect 只挪走、不丢弃：条数对得上账', () => {
    expect(p.kept.length + p.suspect.length).toBe(hits.length)
    expect(p.suspect.map((m) => m.hit.title)).toEqual(['完全无关甲', '完全无关乙'])
  })

  it('kept 内 exact 在前、contains 在后，同档保持站点原序（稳定）', () => {
    expect(p.kept.map((m) => `${m.hit.title}/${m.relevance}`)).toEqual([
      '冰魔女的契约/exact', '冰魔女的契约 下部/contains', '冰魔女的契约 上部/contains',
    ])
  })

  it('零命中是一趟空数组，不是 null（与取值规约同一条口径）', () => {
    expect(partitionByRelevance('冰魔女的契约', []).kept).toEqual([])
    expect(partitionByRelevance('冰魔女的契约', []).suspect).toEqual([])
  })

  it('空关键词时没有东西被挪走', () => {
    const all = partitionByRelevance('', hits)
    expect(all.suspect).toEqual([])
    expect(all.kept.length).toBe(hits.length)
  })

  it('RELEVANCE_RANK 与 RANKED 是三档唯一的序读数（排序与反查都读它们，别处不许再写一份）', () => {
    expect(RELEVANCE_RANK.exact).toBeLessThan(RELEVANCE_RANK.contains)
    expect(RELEVANCE_RANK.contains).toBeLessThan(RELEVANCE_RANK.suspect)
    expect(RANKED.map((r) => RELEVANCE_RANK[r])).toEqual([0, 1, 2])
  })
})
