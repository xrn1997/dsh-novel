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
})
