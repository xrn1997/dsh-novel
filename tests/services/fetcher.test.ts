import { describe, expect, it } from 'vitest'
import { createFetcher, decodeBody, headerOf } from '../../src/services/fetcher.js'
import { FetchError, DecodeError } from '../../src/services/errors.js'
import type { NovelSource } from '../../src/services/types.js'

function fakeFetch(handler: (url: string, init?: RequestInit) => { status?: number; body: BodyInit; headers?: Record<string, string> }) {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const { status = 200, body, headers = {} } = handler(String(input), init)
    return new Response(body, { status, headers })
  }
}

describe('fetchPage', () => {
  it('2xx 返回 raw/finalUrl/contentType', async () => {
    const f = createFetcher({ fetchImpl: fakeFetch(() => ({ body: '你好', headers: { 'content-type': 'text/html; charset=utf-8' } })) })
    const p = await f.fetchPage('https://a.com/x')
    expect(p.raw.toString('utf8')).toBe('你好')
    expect(p.charset).toBe('utf-8')
    expect(p.finalUrl).toBe('https://a.com/x')
  })
  it('非 2xx → FetchError 带 status', async () => {
    const f = createFetcher({ fetchImpl: fakeFetch(() => ({ status: 404, body: '' })) })
    await expect(f.fetchPage('https://a.com/404')).rejects.toMatchObject({ name: 'FetchError', status: 404, url: 'https://a.com/404' })
  })
  it('网络层异常 → FetchError', async () => {
    const f = createFetcher({ fetchImpl: async () => { throw new TypeError('fetch failed') } })
    await expect(f.fetchPage('https://a.com')).rejects.toBeInstanceOf(FetchError)
  })
  it('超时 → FetchError（永不 resolve 的假 fetch）', async () => {
    const f = createFetcher({ fetchImpl: () => new Promise(() => {}), timeoutMs: 20 })
    await expect(f.fetchPage('https://slow.com')).rejects.toBeInstanceOf(FetchError)
  })
  // Node 的 fetch（undici）不读系统代理：有代理才通的站点直连会被 302/重置（实测笔趣阁）
  it('proxyUrl → 出站带 undici dispatcher', async () => {
    let seen: Record<string, unknown> | undefined
    const f = createFetcher({
      proxyUrl: 'http://127.0.0.1:7897',
      fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        seen = init as unknown as Record<string, unknown>
        return new Response('ok', { status: 200 })
      }) as unknown as typeof globalThis.fetch,
    })
    await f.fetchPage('https://a.com/x')
    expect(seen?.dispatcher).toBeDefined()
  })
  it('无 proxyUrl → 不带 dispatcher（直连）', async () => {
    let seen: Record<string, unknown> | undefined
    const f = createFetcher({
      fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        seen = init as unknown as Record<string, unknown>
        return new Response('ok', { status: 200 })
      }) as unknown as typeof globalThis.fetch,
    })
    await f.fetchPage('https://a.com/x')
    expect(seen?.dispatcher).toBeUndefined()
  })
  // Node fetch 默认不带 User-Agent——站点 WAF 按 UA 过滤直接 403（实测 26 源；legado WebView 同理默认带）
  it('缺省带浏览器 UA/Accept 头；调用方声明的同名头优先', async () => {
    let seen: Record<string, unknown> | undefined
    const f = createFetcher({
      fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        seen = init as unknown as Record<string, unknown>
        return new Response('ok', { status: 200 })
      }) as unknown as typeof globalThis.fetch,
    })
    await f.fetchPage('https://a.com/x')
    const headers = seen?.headers as Record<string, string>
    expect(headers['User-Agent']).toContain('Mozilla/5.0')
    await f.fetchPage('https://a.com/x', { headers: { 'User-Agent': 'MyBot/1.0' } })
    const headers2 = (seen as { headers: Record<string, string> }).headers
    expect(headers2['User-Agent']).toBe('MyBot/1.0')
  })
})

describe('decodeBody 解码链', () => {
  const page = (buf: Buffer, contentType?: string) => ({
    raw: buf, finalUrl: 'https://a.com', contentType,
    charset: contentType?.match(/charset=([^;\s]+)/i)?.[1]?.toLowerCase(),
  })
  const gbkHello = Buffer.from([0xc4, 0xe3, 0xba, 0xc3]) // iconv gbk「你好」

  it('① Content-Type charset=gbk 生效', () => {
    expect(decodeBody(page(gbkHello, 'text/html; charset=GBK'))).toBe('你好')
  })
  it('② meta charset 嗅探生效（无 Content-Type）', () => {
    const html = Buffer.concat([Buffer.from('<html><head><meta charset="gbk"></head><body>'), gbkHello, Buffer.from('</body></html>')])
    expect(decodeBody(page(html))).toContain('你好')
  })
  it('③ 兜底 UTF-8', () => {
    expect(decodeBody(page(Buffer.from('普通文本'), undefined))).toBe('普通文本')
  })
  it('声明不存在的 charset → DecodeError，不拿乱码冒充', () => {
    expect(() => decodeBody(page(Buffer.from('x'), 'text/html; charset=not-a-charset'))).toThrow(DecodeError)
  })
  it('④ 声明 charset 覆盖（searchUrl 选项 charset 优先于 Content-Type/嗅探）', () => {
    expect(decodeBody(page(gbkHello, undefined), 'gbk')).toBe('你好')
    expect(decodeBody(page(gbkHello, 'text/html; charset=utf-8'), 'gbk')).toBe('你好')  // 覆盖错误的头
  })
  it('空串 charset 声明视为缺位（真实源 `charset=` 空值——此前必炸 DecodeError）', () => {
    // 声明缺位 → 嗅探链接管：meta charset=gbk 的页面照常解码，不再空串必炸
    const html = Buffer.concat([Buffer.from('<html><head><meta charset="gbk"></head><body>'), gbkHello, Buffer.from('</body></html>')])
    expect(decodeBody(page(html, undefined), '')).toContain('你好')
    expect(() => decodeBody(page(gbkHello, undefined), '')).not.toThrow()
  })
})

describe('headerOf', () => {
  const src = (over: Partial<NovelSource>): NovelSource => ({
    id: 'i', name: 'n', baseUrl: 'https://a.com', enabled: true, groups: [], type: 'text', raw: {},
    rules: { searchUrl: null, exploreUrl: null, ruleBookList: null, ruleBookName: null, ruleAuthor: null,
      ruleBookUrl: null, ruleCoverUrl: null, ruleIntro: null, ruleLastChapter: null, ruleTocUrl: null,
      ruleChapterList: null, ruleChapterName: null, ruleChapterUrl: null,
      ruleDetailName: null, ruleDetailAuthor: null, ruleDetailCoverUrl: null,
      ruleDetailIntro: null, ruleDetailLastChapter: null, ruleDetailInit: null,
      ruleContent: 'x', nextTocUrl: null, nextPageUrl: null,
      header: null, loginUrl: null, jsLib: null, headerRule: null },
    status: 'unverified', importedAt: 0, ...over,
  })
  it('auth.cookies 拼成 Cookie 头', () => {
    const h = headerOf(src({ auth: { cookies: { a: '1', b: '2' } } }))
    expect(h.Cookie).toBe('a=1; b=2')
  })
  it('静态 header 的 Cookie 与 auth 并存，auth 在后占优', () => {
    const s = src({ rules: { ...src({}).rules, header: { Cookie: 'a=0; c=9', Referer: 'https://r' } },
      auth: { cookies: { a: '1' } } })
    const h = headerOf(s)
    expect(h.Cookie).toBe('c=9; a=1')
    expect(h.Referer).toBe('https://r')
  })
})
