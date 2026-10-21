import { describe, expect, it } from 'vitest'
import { applyLoginCheck } from '../../src/services/login-check.js'
import { decodeBody } from '../../src/services/fetcher.js'
import type { FetchedPage, Fetcher } from '../../src/services/fetcher.js'
import type { NovelSource } from '../../src/services/types.js'

const page = (over: Partial<FetchedPage> = {}): FetchedPage => ({
  raw: Buffer.from('BODY'),
  finalUrl: 'https://a.test/x',
  contentType: 'text/plain',
  charset: 'utf-8',
  status: 200,
  setCookie: [],
  headers: { 'x-a': '1' },
  ...over,
})

const source = (loginCheckJs: string): NovelSource => ({
  id: 's', name: 's', baseUrl: 'https://a.test', enabled: true, groups: [], type: 'text',
  raw: { loginCheckJs },
  rules: { header: {}, jsLib: null, headerRule: null } as never,
  status: 'verified', importedAt: 0,
})

const fakeFetcher = (seen: string[]): Fetcher => ({
  fetchPage: async (url) => {
    seen.push(url)
    return page({ raw: Buffer.from('REFETCHED'), finalUrl: url })
  },
})

describe('loginCheckJs', () => {
  it('binds result as a ResponseHost and keeps the page when the script returns it', async () => {
    const seen: string[] = []
    const out = await applyLoginCheck(
      fakeFetcher(seen), source('if (result.code() !== 200) throw new Error("bad"); result;'), page(),
    )
    expect(out.raw.toString()).toBe('BODY')
    expect(seen).toEqual([])
  })

  it('result.cookies() exposes Set-Cookie pairs from the page', async () => {
    const out = await applyLoginCheck(
      fakeFetcher([]),
      source('if (result.cookies().get("sid") !== "abc") throw new Error("missing cookie"); result;'),
      page({ setCookie: ['sid=abc; Path=/', 'theme=dark; Path=/'] }),
    )
    expect(out.raw.toString()).toBe('BODY')
  })

  it('refetches once when the script returns a URL string', async () => {
    const seen: string[] = []
    const out = await applyLoginCheck(
      fakeFetcher(seen), source('return "https://b.test/y"'), page(),
    )
    expect(seen).toEqual(['https://b.test/y'])
    expect(out.raw.toString()).toBe('REFETCHED')
    expect(out.finalUrl).toBe('https://b.test/y')
  })

  it('resolves a relative retry URL against the landed page', async () => {
    const seen: string[] = []
    const out = await applyLoginCheck(fakeFetcher(seen), source('return "/login"'), page())
    expect(seen).toEqual(['https://a.test/login'])
    expect(out.finalUrl).toBe('https://a.test/login')
  })

  it('header-only replacement keeps the original bytes and charset', async () => {
    const out = await applyLoginCheck(
      fakeFetcher([]),
      source('return { __host: "response", __data: Object.assign({}, result.__data, { headers: { "x-new": "1" } }) }'),
      page({ charset: 'gbk' }),
    )
    expect(out.raw.toString()).toBe('BODY')
    expect(out.charset).toBe('gbk')
    expect(out.replaced).toBeUndefined()
    expect(out.headers).toMatchObject({ 'x-new': '1' })
  })

  it('accepts a retry descriptor {url, method, headers, body}', async () => {
    const seen: Array<{ url: string; init?: Parameters<Fetcher['fetchPage']>[1] }> = []
    const fetcher: Fetcher = {
      fetchPage: async (url, init) => {
        seen.push({ url, init })
        return page({ raw: Buffer.from('REFETCHED'), finalUrl: url })
      },
    }
    const out = await applyLoginCheck(
      fetcher,
      source('return { url: "/login", method: "POST", headers: { "X-A": "1" }, body: "b" }'),
      page(),
    )
    expect(out.finalUrl).toBe('https://a.test/login')
    expect(seen[0]!.url).toBe('https://a.test/login')
    expect(seen[0]!.init).toMatchObject({ method: 'POST', body: 'b', headers: { 'X-A': '1' } })
  })

  it('decodes the original page with the URL option charset (no Content-Type charset)', async () => {
    const raw = Buffer.from([0xd6, 0xd0, 0xce, 0xc4])   // GBK「中文」
    const out = await applyLoginCheck(
      fakeFetcher([]),
      source('if (result.body() !== "中文") throw new Error("bad decode"); result;'),
      page({ raw, charset: undefined, contentType: 'text/html' }),
      { declaredCharset: 'gbk' },
    )
    expect(out.raw).toEqual(raw)
  })

  it('marks a replacement as UTF-8 so a declared GBK charset cannot mojibake it', async () => {
    const seen: string[] = []
    const out = await applyLoginCheck(
      fakeFetcher(seen),
      source('return new Packages.io.legado.app.help.http.StrResponse(result.url(), "替换正文")'),
      page({ charset: 'gbk' }),
    )
    expect(out.replaced).toBe(true)
    expect(out.charset).toBe('utf-8')
    // 调用方仍带计划的 GBK 声明；replaced 必须让它失效
    expect(decodeBody(out, 'gbk')).toBe('替换正文')
  })

  it('keeps the page when the script returns nothing', async () => {
    const seen: string[] = []
    const out = await applyLoginCheck(fakeFetcher(seen), source('if (result.body() === "BODY") { var x = 1 }'), page())
    expect(out.raw.toString()).toBe('BODY')
    expect(seen).toEqual([])
  })

  it('accepts a Packages StrResponse as the replacement response', async () => {
    const seen: string[] = []
    const out = await applyLoginCheck(
      fakeFetcher(seen),
      source('return new Packages.io.legado.app.help.http.StrResponse(result.url(), "DECRYPTED")'),
      page(),
    )
    expect(seen).toEqual([])
    expect(out.raw.toString()).toBe('DECRYPTED')
    expect(out.finalUrl).toBe('https://a.test/x')
    expect(out.status).toBe(200)
  })
})
