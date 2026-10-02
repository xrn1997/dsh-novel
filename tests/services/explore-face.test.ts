import { describe, expect, it } from 'vitest'
import { createFetcher } from '../../src/services/fetcher.js'
import { normalizeSource } from '../../src/services/normalize.js'
import { fetchKindPage } from '../../src/services/explore-face.js'
import type { NovelSource } from '../../src/services/types.js'

const LIST_HTML = '<html><body><div class="item"><h3><a href="/book/1">剑起长安</a></h3>' +
  '<p><a href="/zuozhe/a">青衫客</a><span>玄幻</span></p></div></body></html>'

/** 原生方言源：name+url 无 bookSourceName → 走 flattenNative */
function source(over: Record<string, unknown> = {}): NovelSource {
  const raw = {
    name: 'S', url: 'https://s.com',
    searchUrl: '/so/{{keyword}}/{{page}}',
    ruleSearch: { list: '.item', name: 'h3 a', author: 'p a', bookUrl: 'h3 a@href', coverUrl: 'img@src', kind: 'p span' },
    ruleBookInfo: { name: '.booktxt h1' },
    ruleToc: { list: '#list li', name: 'a', url: 'a@href' },
    ruleContent: { content: '.con' },
    ruleFind: { url: '/{{kind}}/{{page}}', kinds: [{ title: '玄幻', url: 'xuanhuan' }] },
    ...over,
  }
  const n = normalizeSource(raw)
  if (!n.ok) throw new Error(`桩源应能规范化：${JSON.stringify(n.missing)}`)
  return { id: 'i', status: 'unverified', importedAt: 0, ...n.source! } as NovelSource
}
const html = (text: string): Response => new Response(text, { headers: { 'content-type': 'text/html; charset=utf-8' } })

describe('explore-face：单源一次分类抓取', () => {
  it('{{kind}} 换成分类 slug，{{page}} 走首页裁页（地址是裸路径，不带 /1）', async () => {
    const seen: string[] = []
    const f = createFetcher({ fetchImpl: async (input) => { seen.push(String(input)); return html(LIST_HTML) } })
    const r = await fetchKindPage(source(), 'xuanhuan', f)
    expect(r.ok).toBe(true)
    expect(seen[0]).toBe('https://s.com/xuanhuan')
  })

  it('ruleExploreList 为空 → 回落通用搜索规则取条目', async () => {
    const f = createFetcher({ fetchImpl: async () => html(LIST_HTML) })
    const r = await fetchKindPage(source(), 'xuanhuan', f)
    if (!r.ok) throw new Error('应能取到条目')
    expect(r.hits).toHaveLength(1)
    expect(r.hits[0].title).toBe('剑起长安')
    expect(r.hits[0].author).toBe('青衫客')
    expect(r.hits[0].url).toBe('https://s.com/book/1')
  })

  // 这一条只钉列表规则那一侧（列表命中 0 → 空 List，不是 Miss）。它对「整套切换」没有区分力：
  // 列表规则一条都命中不了，书名规则无论来自哪一套都没跑过，逐字段回落在这里产出一模一样的结果。
  it('ruleExploreList 非空 → 整套用它（通用规则不参与）', async () => {
    const own = { ruleFind: { url: '/{{kind}}/{{page}}', kinds: [{ title: '玄幻', url: 'x' }], ruleSearch: { list: '.nothing', name: 'h3 a' } } }
    const f = createFetcher({ fetchImpl: async () => html(LIST_HTML) })
    const r = await fetchKindPage(source(own), 'x', f)
    if (!r.ok) throw new Error('应能取到条目')
    expect(r.hits).toEqual([])                    // .nothing 命中 0 → 空列表（不是 miss）
  })

  it('缺 ruleFind.url → RuleMissing（结果形态，不是异常）', async () => {
    const f = createFetcher({ fetchImpl: async () => html(LIST_HTML) })
    const r = await fetchKindPage(source({ ruleFind: { kinds: [{ title: '玄幻', url: 'x' }] } }), 'x', f)
    expect(r).toEqual({ ok: false, code: 'RuleMissing', message: expect.stringContaining('发现规则缺失') })
  })

  // 发现面的列表规则命中条目、书名规则却匹配不到：整套切换下这本书的标题读不出来，它是**空分类**
  // （解析到空集合 = 空 List），不是规则缺失。通用书名规则在页面里是命得中的——一旦书名那一侧
  // 单独回落通用规则，这里就会冒出一本标题取自另一套规则的书，所以本断言专治逐字段回落。
  it('发现面列表有命中而书名规则读不出 → 空数组，不回落通用书名规则', async () => {
    const own = { ruleFind: { url: '/{{kind}}/{{page}}', kinds: [{ title: '玄幻', url: 'x' }], ruleSearch: { list: '.item', name: '.nomatch' } } }
    const f = createFetcher({ fetchImpl: async () => html(LIST_HTML) })
    const r = await fetchKindPage(source(own), 'x', f)
    if (!r.ok) throw new Error('空分类是正常空结果，不该是失败形态')
    expect(r.hits).toEqual([])
  })

  // 发现面整套启用却缺书名规则：如实点名规则缺失，而不是造出没有标题的书目（对面会静默给 0 本）。
  // 逐字段回落在这里同样会红——它回落到通用书名规则，于是「规则缺失」变成了一次带条目的正常返回。
  it('发现面整套启用但缺书名规则 → RuleMissing（如实点名，不产出空书名条目）', async () => {
    const own = { ruleFind: { url: '/{{kind}}/{{page}}', kinds: [{ title: '玄幻', url: 'x' }], ruleSearch: { list: '.item' } } }
    const f = createFetcher({ fetchImpl: async () => html(LIST_HTML) })
    const r = await fetchKindPage(source(own), 'x', f)
    expect(r).toEqual({ ok: false, code: 'RuleMissing', message: expect.stringContaining('发现规则缺失') })
  })
})
