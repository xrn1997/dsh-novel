import { describe, expect, it } from 'vitest'
import { createFetcher, fetchTextPage } from '../../src/services/fetcher.js'
import { fetchSearchPage, searchErrorCodeOf } from '../../src/services/search-face.js'
import { normalizeSource } from '../../src/services/normalize.js'
import { DecodeError, FetchError } from '../../src/services/errors.js'
import { RuleEvalError } from '../../src/engine/index.js'
import type { NovelSource } from '../../src/services/types.js'

/** 搜索面：探针与聚合搜索共用的请求语义 */

const SEARCH_HTML = '<html><body><div class="b"><a href="/book/1/">斗罗大陆</a><span>唐家三少</span></div>' +
  '<div class="b"><a href="/book/2/">凡人修仙传</a></div></body></html>'

function src(over: Record<string, unknown> = {}): NovelSource {
  const raw = {
    bookSourceName: 'S', bookSourceUrl: 'https://s.com',
    searchUrl: 'https://s.com/search?q={{key}}',
    ruleBookList: '@css:.b', ruleBookName: 'tag.a@text', ruleBookUrl: 'tag.a@href',
    ruleContent: '@css:#c@text', ...over,
  }
  const n = normalizeSource(raw)
  return { id: 'i', status: 'unverified', importedAt: 0, auth: undefined, ...n.source! } as NovelSource
}
const html = (text: string): Response => new Response(text, { headers: { 'content-type': 'text/html; charset=utf-8' } })

describe('fetchSearchPage', () => {
  it('条目提取：ok 结果含 items 与 landedUrl（合成 Response 无重定向 → 回落请求址）', async () => {
    const f = createFetcher({ fetchImpl: async () => html(SEARCH_HTML) })
    const r = await fetchSearchPage(src(), '书', f)
    expect(r.ok).toBe(true)
    if (!r.ok || r.shape !== 'list') return
    expect(r.items).toHaveLength(2)
    expect(r.landedUrl).toBe('https://s.com/search?q=%E4%B9%A6')
  })
  it('规则缺失 → ok:false RuleMissing（点名缺失字段）', async () => {
    const f = createFetcher({ fetchImpl: async () => html(SEARCH_HTML) })
    const r = await fetchSearchPage(src({ searchUrl: undefined }), '书', f)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('RuleMissing')
    expect(r.message).toMatch(/searchUrl/)
  })
  it('timeoutMs 生效：挂起的抓取在限时内抛 FetchError', async () => {
    const f = createFetcher({ fetchImpl: () => new Promise<Response>(() => { /* 永不返回 */ }) })
    const t0 = Date.now()
    await expect(fetchSearchPage(src(), '书', f, 50)).rejects.toMatchObject({ name: 'FetchError' })
    expect(Date.now() - t0).toBeLessThan(1000)
  })
  it('POST 选项透传：method/body 插值/headers（probe.test 同款断言口径）', async () => {
    let method = ''; let body = ''; let headers: Record<string, string> | undefined
    const f = createFetcher({ fetchImpl: async (_input, init) => {
      method = init?.method ?? 'GET'
      body = String(init?.body ?? '')
      headers = init?.headers as Record<string, string>
      return html(SEARCH_HTML)
    } })
    const r = await fetchSearchPage(src({
      searchUrl: '/s.php,{"method":"POST","body":"s={{key}}&t=1","headers":{"Referer":"https://ref.com"}}',
    }), '书', f)
    expect(method).toBe('POST')
    expect(body).toBe('s=%E4%B9%A6&t=1')
    expect(headers?.Referer).toBe('https://ref.com')
    expect(r.ok).toBe(true)
  })
})

describe('fetchTextPage（抓取+解码+落地地址单点；超时归 fetcher）', () => {
  it('解码 + 读回落地地址（redirect 后 = finalUrl）', async () => {
    const landed = { ok: true, status: 200, url: 'https://landed.example/x', headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }), arrayBuffer: async () => new TextEncoder().encode('<html>hi</html>').buffer } as unknown as Response
    const f = createFetcher({ fetchImpl: async () => landed })
    const { text, landedUrl } = await fetchTextPage(f, 'https://s.com/a', { headers: {} })
    expect(text).toContain('hi')
    expect(landedUrl).toBe('https://landed.example/x')
  })
  it('按次超时覆盖（原 fetchTimed 的二次竞速已消亡：超时/abort 只有 fetcher 一份）', async () => {
    const f = createFetcher({ fetchImpl: () => new Promise<Response>(() => { /* 永不返回 */ }) })
    await expect(fetchTextPage(f, 'https://slow.example/a', { headers: {}, timeoutMs: 20 }))
      .rejects.toThrowError(/请求超时 20ms/)
  })
})

describe('searchErrorCodeOf（分类单点）', () => {
  it('引擎三类 → e.name；Fetch/Decode → e.name；其余 → Error', () => {
    expect(searchErrorCodeOf(new RuleEvalError('x', { facet: 'search', segmentIndex: 0, segmentRaw: 'r', hits: 0 }))).toBe('RuleEvalError')
    expect(searchErrorCodeOf(new FetchError('x', { url: 'u' }))).toBe('FetchError')
    expect(searchErrorCodeOf(new DecodeError('x', { url: 'u', charset: 'c' }))).toBe('DecodeError')
    expect(searchErrorCodeOf(new Error('x'))).toBe('Error')
  })
})
