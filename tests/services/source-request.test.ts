import { describe, expect, it, vi } from 'vitest'
import { engineContextOf } from '../../src/services/source-eval.js'
import { CookieJar } from '../../src/services/cookies.js'
import { createFetcher } from '../../src/services/fetcher.js'
import { normalizeSource } from '../../src/services/normalize.js'
import { RateLimiter } from '../../src/services/rate-limit.js'
import { assembleRequest } from '../../src/services/request.js'
import { createSourceRequest } from '../../src/services/source-request.js'
import type { NovelSource } from '../../src/services/types.js'

function src(over: Record<string, unknown> = {}): NovelSource {
  const raw = {
    bookSourceName: 'S', bookSourceUrl: 'https://s.com',
    searchUrl: 'https://s.com/search?q={{key}}',
    ruleBookList: '@css:.b', ruleBookName: 'tag.a@text', ruleBookUrl: 'tag.a@href',
    ruleContent: '@css:#c@text',
    ...over,
  }
  const n = normalizeSource(raw)
  if (!n.ok) throw new Error(`桩源应能规范化：${JSON.stringify(n.missing)}`)
  return { id: 'i', status: 'unverified', importedAt: 0, ...n.source! } as NovelSource
}

const html = (text: string): Response =>
  new Response(text, { headers: { 'content-type': 'text/html; charset=utf-8' } })

const webview = {
  fetch: vi.fn(async () => ({
    html: '', finalUrl: 'https://s.com/', status: 200, headers: {}, cookies: [],
  })),
}

describe('SourceRequest', () => {
  it('fetchText / fetchPage 走基础 fetcher，返回落点与正文', async () => {
    const seen: string[] = []
    const fetcher = createFetcher({ fetchImpl: async (input) => { seen.push(String(input)); return html('ok') } })
    const sr = createSourceRequest({
      fetcher, webview, cookieJar: new CookieJar(), jsTimeoutMs: () => 1000,
    })
    const s = src()
    const plan = assembleRequest('https://s.com/x', {}, s.baseUrl)
    await expect(sr.fetchText(s, plan)).resolves.toEqual({ text: 'ok', landedUrl: 'https://s.com/x' })
    await expect(sr.fetchPage(s, plan)).resolves.toMatchObject({
      url: 'https://s.com/x', requestedUrl: 'https://s.com/x', body: 'ok',
    })
    expect(seen).toEqual(['https://s.com/x', 'https://s.com/x'])
  })

  it('webview 分支也过限速', async () => {
    let now = 0
    const sleeps: number[] = []
    const limiter = new RateLimiter({ limit: 1, intervalMs: 50 }, {
      now: () => now,
      sleep: async (ms) => { sleeps.push(ms); now += ms },
    })
    const webviewFetch = vi.fn(async () => ({
      html: 'w', finalUrl: 'https://s.com/w', status: 200, headers: {}, cookies: [],
    }))
    const sr = createSourceRequest({
      fetcher: createFetcher({ fetchImpl: async () => html('h') }),
      webview: { fetch: webviewFetch },
      cookieJar: new CookieJar(),
      jsTimeoutMs: () => 1000,
      rateLimiterFor: () => limiter,
    })
    const s = src()
    const plan = { ...assembleRequest('https://s.com/w', {}, s.baseUrl), webView: true }
    await sr.fetchText(s, plan)
    await sr.fetchText(s, plan)
    expect(webviewFetch).toHaveBeenCalledTimes(2)
    expect(sleeps).toEqual([50])
  })

  it('loginCheckJs 吃 live jsTimeoutMs（脚本死循环按预算熔断）', async () => {
    const sr = createSourceRequest({
      fetcher: createFetcher({ fetchImpl: async () => html('first') }),
      webview,
      cookieJar: new CookieJar(),
      jsTimeoutMs: () => 120,
    })
    const s = src({ loginCheckJs: 'while(true){}' })
    await expect(sr.fetchText(s, assembleRequest('https://s.com/x', {}, s.baseUrl)))
      .rejects.toThrow(/脚本超时/)
  }, 10_000)

  it('loginCheck 重试仍过限速 adapter，且不再递归 loginCheck', async () => {
    const urls: string[] = []
    const fetcher = createFetcher({
      fetchImpl: async (input) => {
        urls.push(String(input))
        return html(String(input).endsWith('/next') ? 'next' : 'first')
      },
    })
    const sr = createSourceRequest({
      fetcher, webview, cookieJar: new CookieJar(), jsTimeoutMs: () => 1000,
    })
    const s = src({ loginCheckJs: "return 'https://s.com/next'" })
    const plan = assembleRequest('https://s.com/x', {}, s.baseUrl)
    await expect(sr.fetchText(s, plan)).resolves.toMatchObject({ text: 'next' })
    expect(urls).toEqual(['https://s.com/x', 'https://s.com/next'])
  })

  it('静态头与计划头合并后进入请求', async () => {
    let headers: Record<string, string> | undefined
    const fetcher = createFetcher({
      fetchImpl: async (_input, init) => { headers = init?.headers as Record<string, string>; return html('ok') },
    })
    const sr = createSourceRequest({
      fetcher, webview, cookieJar: new CookieJar(), jsTimeoutMs: () => 1000,
    })
    const s = src({ header: '{"X-Source":"1"}' })
    const plan = { ...assembleRequest('https://s.com/x', {}, s.baseUrl), headers: { 'X-Plan': '2' } }
    await sr.fetchText(s, plan)
    expect(headers).toMatchObject({ 'X-Source': '1', 'X-Plan': '2' })
  })

  it('webview 分支不跑 loginCheck', async () => {
    const webviewFetch = vi.fn(async () => ({
      html: 'w', finalUrl: 'https://s.com/w', status: 200, headers: {}, cookies: [],
    }))
    const fetchImpl = vi.fn(async () => html('http'))
    const sr = createSourceRequest({
      fetcher: createFetcher({ fetchImpl }),
      webview: { fetch: webviewFetch },
      cookieJar: new CookieJar(),
      jsTimeoutMs: () => 1000,
    })
    const s = src({ loginCheckJs: "return 'https://s.com/next'" })
    const plan = { ...assembleRequest('https://s.com/w', {}, s.baseUrl), webView: true }
    await sr.fetchText(s, plan)
    expect(webviewFetch).toHaveBeenCalledTimes(1)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('webview 的源级 User-Agent 走 userAgent 选项，不塞 extraHTTPHeaders', async () => {
    let seen: { userAgent?: string; headers?: Record<string, string> } | undefined
    const webviewFetch = vi.fn(async (_url: string, opts: { userAgent?: string; headers?: Record<string, string> } = {}) => {
      seen = opts
      return { html: 'w', finalUrl: 'https://s.com/w', status: 200, headers: {}, cookies: [] }
    })
    const sr = createSourceRequest({
      fetcher: createFetcher({ fetchImpl: async () => html('h') }),
      webview: { fetch: webviewFetch } as never,
      cookieJar: new CookieJar(),
      jsTimeoutMs: () => 1000,
    })
    const s = src({ header: '{"User-Agent":"UA-SRC","X-A":"1"}' })
    const plan = { ...assembleRequest('https://s.com/w', {}, s.baseUrl), webView: true }
    await sr.fetchText(s, plan)
    expect(seen?.userAgent).toBe('UA-SRC')
    expect(seen?.headers?.['X-A']).toBe('1')
    expect(Object.keys(seen?.headers ?? {}).some((k) => k.toLowerCase() === 'user-agent')).toBe(false)
  })

  it('webview cookie 桥保留 secure/expires，并回灌 HTTP jar', async () => {
    const expires = Date.now() + 60_000
    const webviewFetch = vi.fn(async () => ({
      html: 'w', finalUrl: 'https://s.com/w', status: 200, headers: {},
      cookies: [{ name: 'sid', value: '1', domain: 's.com', path: '/', expires, secure: true }],
    }))
    const jar = new CookieJar()
    const sr = createSourceRequest({
      fetcher: createFetcher({ fetchImpl: async () => html('h') }),
      webview: { fetch: webviewFetch } as never,
      cookieJar: jar,
      jsTimeoutMs: () => 1000,
    })
    const s = src()
    await sr.fetchText(s, { ...assembleRequest('https://s.com/w', {}, s.baseUrl), webView: true })
    expect(jar.headerFor('https://s.com/x')).toContain('sid=1')
    expect(jar.headerFor('http://s.com/x')).toBe('')       // Secure 不能经 http 发出
    const entry = jar.entries().find((e) => e.name === 'sid')!
    expect(entry.secure).toBe(true)
    expect(entry.expires).toBeGreaterThan(Date.now())
  })

  it('webview 回灌按 cookie 自己的域落，不拿最终 URL 的 host 冒充', async () => {
    const webviewFetch = vi.fn(async () => ({
      html: 'w', finalUrl: 'https://s.com/w', status: 200, headers: {},
      cookies: [{ name: 'sid', value: '1', domain: 'other.test', path: '/' }],
    }))
    const jar = new CookieJar()
    const sr = createSourceRequest({
      fetcher: createFetcher({ fetchImpl: async () => html('h') }),
      webview: { fetch: webviewFetch } as never,
      cookieJar: jar,
      jsTimeoutMs: () => 1000,
    })
    const s = src()
    await sr.fetchText(s, { ...assembleRequest('https://s.com/w', {}, s.baseUrl), webView: true })
    expect(jar.headerFor('https://other.test/x')).toContain('sid=1')
    expect(jar.headerFor('https://s.com/x')).toBe('')
  })

  it('webview 带非 GET 方法点名抛错（不静默当 GET）', async () => {
    const sr = createSourceRequest({
      fetcher: createFetcher({ fetchImpl: async () => html('h') }),
      webview: { fetch: async () => ({ html: 'w', finalUrl: 'https://s.com/w', status: 200, headers: {}, cookies: [] }) },
      cookieJar: new CookieJar(),
      jsTimeoutMs: () => 1000,
    })
    const s = src()
    const plan = { ...assembleRequest('https://s.com/w', {}, s.baseUrl), webView: true, method: 'POST' as const }
    await expect(sr.fetchText(s, plan)).rejects.toThrow(/webView 只支持 GET/)
  })

  it('引擎面 @webjs / java.webView 也过同一条源级限速', async () => {
    let now = 0
    const sleeps: number[] = []
    const limiter = new RateLimiter({ limit: 1, intervalMs: 50 }, {
      now: () => now, sleep: async (ms) => { sleeps.push(ms); now += ms },
    })
    let seenCookies: Array<{ name: string; value: string; domain?: string }> | undefined
    const webviewFetch = vi.fn(async (_url: string, opts: { cookies?: Array<{ name: string; value: string; domain?: string }> } = {}) => {
      seenCookies = opts.cookies
      return { html: 'w', finalUrl: 'https://s.com/', status: 200, headers: {}, cookies: [] }
    })
    const jar = new CookieJar()
    jar.absorb('https://s.com', ['sid=1'])
    jar.absorb('https://s.com', ['dom=1; Domain=.s.com; Path=/'])
    const sr = createSourceRequest({
      fetcher: createFetcher({ fetchImpl: async () => html('h') }),
      webview: { fetch: webviewFetch } as never,
      cookieJar: jar,
      jsTimeoutMs: () => 1000,
      rateLimiterFor: () => limiter,
    })
    const s = src()
    const ctx = engineContextOf(sr.fetcherFor(s), s, { baseUrl: s.baseUrl })
    await ctx.evalWebJs('return 1', 'https://s.com/')
    await ctx.webView('https://s.com/')
    expect(webviewFetch).toHaveBeenCalledTimes(2)
    expect(seenCookies).toContainEqual(expect.objectContaining({ name: 'sid', value: '1', domain: 's.com' }))
    expect(seenCookies).toContainEqual(expect.objectContaining({ name: 'dom', value: '1', domain: '.s.com' }))
    expect(sleeps).toEqual([50])
  })

  it('HTTP 分支也过限速', async () => {
    let now = 0
    const sleeps: number[] = []
    const limiter = new RateLimiter({ limit: 1, intervalMs: 50 }, {
      now: () => now, sleep: async (ms) => { sleeps.push(ms); now += ms },
    })
    const sr = createSourceRequest({
      fetcher: createFetcher({ fetchImpl: async () => html('ok') }),
      webview, cookieJar: new CookieJar(), jsTimeoutMs: () => 1000, rateLimiterFor: () => limiter,
    })
    const s = src()
    const plan = assembleRequest('https://s.com/x', {}, s.baseUrl)
    await sr.fetchText(s, plan)
    await sr.fetchText(s, plan)
    expect(sleeps).toEqual([50])
  })

  it('源规则改了 concurrentRate 就换新桶，不沿用旧速率', async () => {
    const sr = createSourceRequest({
      fetcher: createFetcher({ fetchImpl: async () => html('ok') }),
      webview, cookieJar: new CookieJar(), jsTimeoutMs: () => 1000,
    })
    const s1 = src({ concurrentRate: '1/2000' })
    await sr.fetchText(s1, assembleRequest('https://s.com/x', {}, s1.baseUrl))
    // 同一 id 的新源对象（SourceRegistry.replace 的形状）：旧桶若只按 id 命中，这里会等 2s
    const s2 = { ...s1, raw: { ...(s1.raw as Record<string, unknown>), concurrentRate: '' } }
    const started = Date.now()
    await sr.fetchText(s2, assembleRequest('https://s.com/x', {}, s2.baseUrl))
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('loginCheckJs 能看到 403 正文：脚本替换后按成功返回', async () => {
    const fetcher = createFetcher({
      fetchImpl: async () => new Response('<html>challenge</html>', {
        status: 403, headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
    })
    const sr = createSourceRequest({
      fetcher, webview, cookieJar: new CookieJar(), jsTimeoutMs: () => 1000,
    })
    const s = src({
      loginCheckJs: 'return new Packages.io.legado.app.help.http.StrResponse("https://s.com/x", "ok")',
    })
    await expect(sr.fetchText(s, assembleRequest('https://s.com/x', {}, s.baseUrl)))
      .resolves.toMatchObject({ text: 'ok' })
  })

  it('没有 loginCheck 的 403 仍按守门错误抛', async () => {
    const fetcher = createFetcher({
      fetchImpl: async () => new Response('no', { status: 403 }),
    })
    const sr = createSourceRequest({
      fetcher, webview, cookieJar: new CookieJar(), jsTimeoutMs: () => 1000,
    })
    const s = src()
    await expect(sr.fetchText(s, assembleRequest('https://s.com/x', {}, s.baseUrl)))
      .rejects.toThrow(/请求失败 403/)
  })

  it('loginCheck 返回 URL：403 页先被看到，重试 200 成功', async () => {
    let n = 0
    const fetcher = createFetcher({
      fetchImpl: async () => {
        n += 1
        return n === 1
          ? new Response('challenge', { status: 403 })
          : html('next')
      },
    })
    const sr = createSourceRequest({
      fetcher, webview, cookieJar: new CookieJar(), jsTimeoutMs: () => 1000,
    })
    const s = src({ loginCheckJs: "return 'https://s.com/next'" })
    await expect(sr.fetchText(s, assembleRequest('https://s.com/x', {}, s.baseUrl)))
      .resolves.toMatchObject({ text: 'next' })
  })

  it('loginCheck + manual HEAD：4xx 不补抛（HEAD 探测语义不变）', async () => {
    const fetcher = createFetcher({
      fetchImpl: async () => new Response('', { status: 404 }),
    })
    const sr = createSourceRequest({
      fetcher, webview, cookieJar: new CookieJar(), jsTimeoutMs: () => 1000,
    })
    const s = src({ loginCheckJs: 'return result' })
    const page = await sr.fetcherFor(s).fetchPage('https://s.com/x', { manual: true })
    expect(page.status).toBe(404)
  })

  it('headerRule 内的 java.ajax 不递归求值头规则', async () => {
    const seen: string[] = []
    const fetcher = createFetcher({
      fetchImpl: async (input) => {
        const url = String(input)
        seen.push(url)
        if (url.endsWith('/h')) {
          return new Response('{"X-Dyn":"1"}', { headers: { 'content-type': 'application/json' } })
        }
        return html('ok')
      },
    })
    const sr = createSourceRequest({ fetcher, webview, cookieJar: new CookieJar(), jsTimeoutMs: () => 1000 })
    const s = src({ header: `@js:java.ajax('https://s.com/h')` })
    const plan = assembleRequest('https://s.com/x', {}, s.baseUrl)
    await sr.fetchText(s, plan)
    expect(seen.filter((u) => u.endsWith('/h'))).toHaveLength(1)
    expect(seen).toContain('https://s.com/x')
  })

  it('headerRule 脚本出站回到本缝：过限速且头规则只求值一次', async () => {
    let now = 0
    const sleeps: number[] = []
    const limiter = new RateLimiter({ limit: 1, intervalMs: 50 }, {
      now: () => now, sleep: async (ms) => { sleeps.push(ms); now += ms },
    })
    const seen: string[] = []
    const fetcher = createFetcher({
      fetchImpl: async (input) => {
        const url = String(input)
        seen.push(url)
        if (url.endsWith('/h')) {
          return new Response('{"X-Dyn":"1"}', { headers: { 'content-type': 'application/json' } })
        }
        return html('ok')
      },
    })
    const sr = createSourceRequest({
      fetcher, webview, cookieJar: new CookieJar(), jsTimeoutMs: () => 1000, rateLimiterFor: () => limiter,
    })
    const s = src({ header: `@js:java.ajax('https://s.com/h')` })
    const plan = assembleRequest('https://s.com/x', {}, s.baseUrl)
    await sr.fetchText(s, plan)
    // 头规则出站与主请求各占一次配额：头规则若绕过本缝，这个数会掉成 0
    expect(sleeps).toEqual([50])
    // 头规则只求值一次：它自己的 java.ajax 不许回头再触发头规则
    expect(seen.filter((u) => u.endsWith('/h'))).toHaveLength(1)
    expect(seen).toContain('https://s.com/x')
  })

  it('fetcherFor 作脚本出站口：头规则只求值一次（引擎惰性 provider + 本缝）', async () => {
    const seen: string[] = []
    const fetcher = createFetcher({
      fetchImpl: async (input) => {
        const url = String(input)
        seen.push(url)
        if (url.endsWith('/h')) {
          return new Response('{"X-Dyn":"1"}', { headers: { 'content-type': 'application/json' } })
        }
        return html('ok')
      },
    })
    const sr = createSourceRequest({ fetcher, webview, cookieJar: new CookieJar(), jsTimeoutMs: () => 1000 })
    const s = src({ header: `@js:java.ajax('https://s.com/h')` })
    // Task 2 的接线同形：脚本侧经 engineContextOf 的惰性 provider 求头，出站走本缝
    const ctx = engineContextOf(sr.fetcherFor(s), s, { baseUrl: s.baseUrl })
    await expect(ctx.fetch('https://s.com/x')).resolves.toMatchObject({ body: 'ok' })
    expect(seen.filter((u) => u.endsWith('/h'))).toHaveLength(1)
    expect(seen).toContain('https://s.com/x')
  })

  it('loginCheck 重试也过限速', async () => {
    let now = 0
    const sleeps: number[] = []
    const limiter = new RateLimiter({ limit: 1, intervalMs: 50 }, {
      now: () => now, sleep: async (ms) => { sleeps.push(ms); now += ms },
    })
    const fetcher = createFetcher({
      fetchImpl: async (input) => html(String(input).endsWith('/next') ? 'next' : 'first'),
    })
    const sr = createSourceRequest({
      fetcher, webview, cookieJar: new CookieJar(), jsTimeoutMs: () => 1000, rateLimiterFor: () => limiter,
    })
    const s = src({ loginCheckJs: "return 'https://s.com/next'" })
    const plan = assembleRequest('https://s.com/x', {}, s.baseUrl)
    await sr.fetchText(s, plan)
    expect(sleeps).toEqual([50])
  })

  it('webview 不按声明 charset 二次解码', async () => {
    const webviewFetch = vi.fn(async () => ({
      html: '中文', finalUrl: 'https://s.com/w', status: 200, headers: {}, cookies: [],
    }))
    const sr = createSourceRequest({
      fetcher: createFetcher({ fetchImpl: async () => html('http') }),
      webview: { fetch: webviewFetch }, cookieJar: new CookieJar(), jsTimeoutMs: () => 1000,
    })
    const s = src()
    const plan = { ...assembleRequest('https://s.com/w', {}, s.baseUrl), webView: true, charset: 'gbk' }
    await expect(sr.fetchText(s, plan)).resolves.toMatchObject({ text: '中文' })
  })

  it('webview cookie 与 jar 双向桥接', async () => {
    const jar = new CookieJar()
    jar.absorb('https://s.com/', ['a=1; Path=/'])
    const webviewFetch = vi.fn(async (_url: string, opts?: { cookies?: unknown }) => {
      expect(opts?.cookies).toEqual([{ name: 'a', value: '1', domain: 's.com', path: '/' }])
      return {
        html: 'w', finalUrl: 'https://s.com/w', status: 200, headers: {},
        cookies: [{ name: 'b', value: '2', domain: 's.com', path: '/' }],
      }
    })
    const sr = createSourceRequest({
      fetcher: createFetcher({ fetchImpl: async () => html('http') }),
      webview: { fetch: webviewFetch }, cookieJar: jar, jsTimeoutMs: () => 1000,
    })
    const s = src()
    const plan = { ...assembleRequest('https://s.com/w', {}, s.baseUrl), webView: true }
    await sr.fetchText(s, plan)
    expect(jar.headerFor('https://s.com/')).toContain('b=2')
  })

  it('fetcherFor 保留基础 fetcher 的 dispose 能力位（与旧源级外观同面）', () => {
    const dispose = vi.fn()
    const fetcher = { ...createFetcher({ fetchImpl: async () => html('ok') }), dispose }
    const sr = createSourceRequest({
      fetcher, webview, cookieJar: new CookieJar(), jsTimeoutMs: () => 1000,
    })
    sr.fetcherFor(src()).dispose?.()
    expect(dispose).toHaveBeenCalledTimes(1)
  })
})
