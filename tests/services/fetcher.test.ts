import { beforeEach, describe, expect, it, vi } from 'vitest'

// undici 的 ProxyAgent 会在构造时真的建连接池：测试里换成记账桩，
// 才量得到「同 URL 复用、换 URL 关旧、dispose 关当前」这三条生命周期。
const proxyAgents = vi.hoisted(() => [] as Array<{ url: string; closed: boolean }>)
vi.mock('undici', () => ({
  ProxyAgent: class {
    url: string
    closed = false
    constructor(url: string) {
      this.url = url
      proxyAgents.push(this)
    }
    close() {
      this.closed = true
      return Promise.resolve()
    }
  },
}))

import { createFetcher, decodeBody, effectiveUserAgent, headerOf } from '../../src/services/fetcher.js'
import { FetchError, DecodeError } from '../../src/services/errors.js'
import { CookieJar } from '../../src/services/cookies.js'
import type { NovelSource } from '../../src/services/types.js'

beforeEach(() => { proxyAgents.length = 0 })

function fakeFetch(handler: (url: string, init?: RequestInit) => { status?: number; body: BodyInit; headers?: Record<string, string> }) {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const { status = 200, body, headers = {} } = handler(String(input), init)
    return new Response(body, { status, headers })
  }
}

describe('retry option', () => {
  it('retries non-2xx up to the extra attempts and returns the success', async () => {
    let calls = 0
    const f = createFetcher({
      fetchImpl: fakeFetch(() => {
        calls++
        return { status: calls < 3 ? 500 : 200, body: 'ok' }
      }),
    })
    const p = await f.fetchPage('https://a.test/x', { retry: 2 })
    expect(calls).toBe(3)
    expect(p.status).toBe(200)
  })

  it('throws the last HTTP failure when retries are exhausted', async () => {
    let calls = 0
    const f = createFetcher({
      fetchImpl: fakeFetch(() => { calls++; return { status: 500, body: '' } }),
    })
    await expect(f.fetchPage('https://a.test/x', { retry: 1 })).rejects.toMatchObject({ name: 'FetchError', status: 500 })
    expect(calls).toBe(2)
  })

  it('does not retry connection-layer failures', async () => {
    let calls = 0
    const f = createFetcher({
      fetchImpl: async () => { calls++; throw new TypeError('fetch failed') },
    })
    await expect(f.fetchPage('https://a.test/x', { retry: 2 })).rejects.toBeInstanceOf(FetchError)
    expect(calls).toBe(1)
  })
})

describe('cookie jar', () => {
  it('absorbs Set-Cookie and sends it on the next request', async () => {
    const seen: Array<Record<string, string> | undefined> = []
    const jar = new CookieJar()
    const f = createFetcher({
      cookieJar: jar,
      fetchImpl: fakeFetch((_url, init) => {
        seen.push(init?.headers as Record<string, string> | undefined)
        return { body: 'ok', headers: { 'set-cookie': 'sid=1; Path=/' } }
      }),
    })
    await f.fetchPage('https://a.test/x')
    await f.fetchPage('https://a.test/y')
    expect(seen[1]?.Cookie).toBe('sid=1')
  })

  it('explicit Cookie header wins over the jar', async () => {
    let seen: Record<string, string> | undefined
    const jar = new CookieJar()
    jar.absorb('https://a.test/', ['sid=1; Path=/'])
    const f = createFetcher({
      cookieJar: jar,
      fetchImpl: fakeFetch((_url, init) => {
        seen = init?.headers as Record<string, string> | undefined
        return { body: 'ok' }
      }),
    })
    await f.fetchPage('https://a.test/x', { headers: { Cookie: 'manual=1' } })
    expect(seen?.Cookie).toBe('manual=1')
  })
})

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
  it('manual 姿态：带 redirect:manual 出站、非 2xx 不抛、响应头表可读（`java.head` 的探测面）', async () => {
    let seen: RequestInit | undefined
    const f = createFetcher({
      fetchImpl: fakeFetch((_url, init) => {
        seen = init
        return { status: 302, body: '', headers: { location: 'https://i.pximg.net/a.png', 'x-origin-url': 'https://alt/a.png' } }
      }),
    })
    const p = await f.fetchPage('https://a.com/img', { method: 'HEAD', manual: true })
    expect(seen?.redirect).toBe('manual')
    expect(p.status).toBe(302)
    expect(p.headers).toMatchObject({ location: 'https://i.pximg.net/a.png', 'x-origin-url': 'https://alt/a.png' })
    // 缺省姿态照旧炸：例外只在那一个调用点开（`ADR-0015` 的 manual 例外）
    await expect(f.fetchPage('https://a.com/img', { method: 'HEAD' })).rejects.toMatchObject({ name: 'FetchError', status: 302 })
    // 这条桩**证不了** undici 真把 3xx 的状态与头透出来（那是 Node 侧行为，本机以本地 302 服务实测过：
    // `type: basic`、status 302、location 可读，不是浏览器那种 opaqueredirect 空壳）。
    // 这里钉的是本仓自己的两件事：请求确实带 manual 出站、非 2xx 在 manual 下不折叠成错误。
  })
  it('noFollow 姿态：带 redirect:manual 出站、3xx 返回、>=400 仍抛（java.get 的 jsoup 口径）', async () => {
    let seen: RequestInit | undefined
    const f = createFetcher({
      fetchImpl: fakeFetch((_url, init) => {
        seen = init
        return { status: 302, body: '', headers: { location: '/next' } }
      }),
    })
    const p = await f.fetchPage('https://a.com/x', { noFollow: true })
    expect(seen?.redirect).toBe('manual')
    expect(p.status).toBe(302)
    const bad = createFetcher({ fetchImpl: fakeFetch(() => ({ status: 404, body: '' })) })
    await expect(bad.fetchPage('https://a.com/x', { noFollow: true }))
      .rejects.toMatchObject({ name: 'FetchError', status: 404 })
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
  it('proxyUrl getter：换 URL 建新 dispatcher 并关旧；dispose 关当前（同 URL 复用、dispose 后可重建）', async () => {
    let proxy: string | null = 'http://a:1'
    const f = createFetcher({
      proxyUrl: () => proxy,
      fetchImpl: fakeFetch(() => ({ body: 'ok' })) as unknown as typeof globalThis.fetch,
    })
    await f.fetchPage('https://a.com/1')
    expect(proxyAgents.at(-1)?.url).toBe('http://a:1')
    // 同 URL 不重建：proxyAgents 仍只有一份
    await f.fetchPage('https://a.com/1b')
    expect(proxyAgents).toHaveLength(1)
    proxy = 'http://b:2'
    await f.fetchPage('https://a.com/2')
    expect(proxyAgents.at(-1)?.url).toBe('http://b:2')
    expect(proxyAgents[0]?.closed).toBe(true)
    f.dispose?.()
    expect(proxyAgents.at(-1)?.closed).toBe(true)
    // dispose 之后调用方还在抓取：按当前 URL 重建，而不是复用已关闭的实例
    await f.fetchPage('https://a.com/3')
    expect(proxyAgents.at(-1)?.url).toBe('http://b:2')
    expect(proxyAgents.at(-1)?.closed).toBe(false)
  })
  it("proxyUrl 改为 'DIRECT' / 空串 → 直连并关旧 dispatcher", async () => {
    let proxy: string | null = 'http://a:1'
    const seen: Array<Record<string, unknown>> = []
    const f = createFetcher({
      proxyUrl: () => proxy,
      fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        seen.push(init as unknown as Record<string, unknown>)
        return new Response('ok', { status: 200 })
      }) as unknown as typeof globalThis.fetch,
    })
    await f.fetchPage('https://a.com/1')
    proxy = 'DIRECT'
    await f.fetchPage('https://a.com/2')
    expect(seen.at(-1)?.dispatcher).toBeUndefined()
    expect(proxyAgents[0]?.closed).toBe(true)
    proxy = ''
    await f.fetchPage('https://a.com/3')
    expect(seen.at(-1)?.dispatcher).toBeUndefined()
  })
  it('proxyUrl 坏地址 → FetchError（不是裸 TypeError）', async () => {
    const f = createFetcher({
      proxyUrl: 'ftp://127.0.0.1:21',
      fetchImpl: fakeFetch(() => ({ body: 'ok' })) as unknown as typeof globalThis.fetch,
    })
    await expect(f.fetchPage('https://a.com')).rejects.toMatchObject({ name: 'FetchError' })
  })
  it('坏地址每次都炸：失败不记账，第二次请求不许静默走直连', async () => {
    const f = createFetcher({
      proxyUrl: 'ftp://127.0.0.1:21',
      fetchImpl: fakeFetch(() => ({ body: 'ok' })) as unknown as typeof globalThis.fetch,
    })
    await expect(f.fetchPage('https://a.com/1')).rejects.toMatchObject({ name: 'FetchError' })
    await expect(f.fetchPage('https://a.com/2')).rejects.toMatchObject({ name: 'FetchError' })
  })
  it('proxyUrl 坏地址带 userinfo → 报错不含密码（脱敏）', async () => {
    const f = createFetcher({
      proxyUrl: 'http://user:s3cret@bad host',
      fetchImpl: fakeFetch(() => ({ body: 'ok' })) as unknown as typeof globalThis.fetch,
    })
    const err = await f.fetchPage('https://a.com').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(FetchError)
    expect((err as Error).message).not.toContain('s3cret')
    expect((err as Error).message).toContain('***@')
    expect((err as FetchError).url).not.toContain('s3cret')
  })
  it('proxyUrl 坏地址带斜杠密码（schema 可达）→ 报错文案与 url 字段都不含密码', async () => {
    // 配置页 schema 放行 `http://user:pa/ss@host`；这条只走到「坏地址」分支，
    // 两个回声面（message、FetchError.url）都必须只剩脱敏后的地址。
    const f = createFetcher({
      proxyUrl: 'http://user:pa/ss@host',
      fetchImpl: fakeFetch(() => ({ body: 'ok' })) as unknown as typeof globalThis.fetch,
    })
    const err = await f.fetchPage('https://a.com').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(FetchError)
    expect((err as Error).message).not.toContain('pa/ss')
    expect((err as Error).message).not.toContain('user:pa')
    expect((err as FetchError).url).not.toContain('pa/ss')
    expect((err as FetchError).url).not.toContain('user:pa')
  })
  it('裸 host:port 的 getter → 建 dispatcher 前补 http://（ProxyAgent 只认带 scheme 的 URL）', async () => {
    const f = createFetcher({
      proxyUrl: () => '127.0.0.1:7897',
      fetchImpl: fakeFetch(() => ({ body: 'ok' })) as unknown as typeof globalThis.fetch,
    })
    await f.fetchPage('https://a.com')
    expect(proxyAgents.at(-1)?.url).toBe('http://127.0.0.1:7897')
  })
  it("proxyUrl 为 ' direct '（带空白）→ 直连并关旧 dispatcher", async () => {
    let proxy: string | null = 'http://a:1'
    const seen: Array<Record<string, unknown>> = []
    const f = createFetcher({
      proxyUrl: () => proxy,
      fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        seen.push(init as unknown as Record<string, unknown>)
        return new Response('ok', { status: 200 })
      }) as unknown as typeof globalThis.fetch,
    })
    await f.fetchPage('https://a.com/1')
    expect(proxyAgents.at(-1)?.url).toBe('http://a:1')
    proxy = ' direct '
    await f.fetchPage('https://a.com/2')
    expect(seen.at(-1)?.dispatcher).toBeUndefined()
    expect(proxyAgents[0]?.closed).toBe(true)
  })
  it('A 活着 → B 坏 → 换回 A：坏地址不污染缓存，仍按 A 重建 dispatcher 而不是静默直连', async () => {
    let proxy = 'http://a:1'
    const seen: Array<Record<string, unknown>> = []
    const f = createFetcher({
      proxyUrl: () => proxy,
      fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        seen.push(init as unknown as Record<string, unknown>)
        return new Response('ok', { status: 200 })
      }) as unknown as typeof globalThis.fetch,
    })
    await f.fetchPage('https://a.com/1')
    proxy = 'ftp://127.0.0.1:21'
    await expect(f.fetchPage('https://a.com/2')).rejects.toMatchObject({ name: 'FetchError' })
    proxy = 'http://a:1'
    await f.fetchPage('https://a.com/3')
    expect(seen.at(-1)?.dispatcher).toBeDefined()
    expect(proxyAgents.at(-1)?.url).toBe('http://a:1')
    expect(proxyAgents.at(-1)?.closed).toBe(false)
  })
  // Node fetch 默认不带 User-Agent——站点 WAF 按 UA 过滤直接 403（真机实测有这种源；浏览器口径默认带）
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

  it('源声明**小写** user-agent 同样覆盖缺省 UA（头名不敏感；两键并存会合成畸形头）', async () => {
    // 裸 {...DEFAULT_HEADERS, ...init} 会让 User-Agent 与 user-agent 并存，undici 把它们并成一条
    // `"默认, 源"`（本机实测服务端收到的就是这串）——源声明的 UA 就此失效，比覆盖更坏。
    let seen: Record<string, unknown> | undefined
    const f = createFetcher({
      fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        seen = init as unknown as Record<string, unknown>
        return new Response('ok', { status: 200 })
      }) as unknown as typeof globalThis.fetch,
    })
    await f.fetchPage('https://a.com/x', { headers: { 'user-agent': 'SrcBot/1.0' } })
    const headers = (seen as { headers: Record<string, string> }).headers
    expect(headers['user-agent']).toBe('SrcBot/1.0')
    expect(Object.keys(headers).filter((k) => k.toLowerCase() === 'user-agent')).toHaveLength(1)
  })

  it('effectiveUserAgent 认小写声明（它的承诺是「我们真发出去的那条」）', () => {
    const src = (header: Record<string, string>) => ({ rules: { header }, auth: undefined }) as unknown as NovelSource
    expect(effectiveUserAgent(src({ 'user-agent': 'SrcBot/1.0' }))).toBe('SrcBot/1.0')
    expect(effectiveUserAgent(src({}))).toContain('Mozilla/5.0')
  })
})

describe('decodeBody 解码链', () => {
  const page = (buf: Buffer, contentType?: string) => ({
    raw: buf, finalUrl: 'https://a.com', contentType,
    charset: contentType?.match(/charset=([^;\s]+)/i)?.[1]?.toLowerCase(),
    status: 200, setCookie: [],
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
  it('replaced 页忽略调用方声明的 charset（loginCheckJs 的替换正文是 UTF-8）', () => {
    const replaced = { ...page(Buffer.from('替换正文', 'utf8')), charset: 'utf-8', replaced: true }
    expect(decodeBody(replaced, 'gbk')).toBe('替换正文')
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
    rules: { searchUrl: null, exploreUrl: null, probeKeyword: null, bookUrlPattern: null, ruleBookList: null, ruleBookName: null, ruleAuthor: null,
      ruleBookUrl: null, ruleCoverUrl: null, ruleIntro: null, ruleLastChapter: null, ruleKind: null, ruleWordCount: null, ruleTocUrl: null,
      ruleChapterList: null, ruleChapterName: null, ruleChapterUrl: null,
      ruleDetailName: null, ruleDetailAuthor: null, ruleDetailCoverUrl: null,
      ruleDetailIntro: null, ruleDetailLastChapter: null, ruleDetailKind: null, ruleDetailWordCount: null, ruleDetailInit: null,
      ruleExploreUrl: null, ruleExploreKinds: [],
      ruleExploreList: null, ruleExploreName: null, ruleExploreAuthor: null, ruleExploreBookUrl: null,
      ruleExploreCoverUrl: null, ruleExploreIntro: null, ruleExploreKind: null,
      ruleExploreLastChapter: null, ruleExploreWordCount: null,
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
