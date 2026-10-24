import { describe, expect, it } from 'vitest'
import { createSourceEval, engineContextOf, resolveHeaders } from '../../src/services/source-eval.js'
import { normalizeSource } from '../../src/services/normalize.js'
import type { Fetcher } from '../../src/services/fetcher.js'
import type { NovelSource } from '../../src/services/types.js'
import type { ShelfBook } from '../../src/shared/wire.js'

/**
 * 源求值缝自己的账：`book` 镜像的逐面字段集、动态头与静态头的次序、登录面投影的优先级。
 * 能力位覆盖**不在这里列名单**——`tests/engine/js-protocol.test.ts` 那条闸从协议表现造一份
 * `engineContextOf` 上下文、逐个 `d.ctx.*` 验供得出，名单由协议表派生；这里再抄一份硬编码清单
 * 就是第二份会腐烂的分母。
 */

const raw = {
  bookSourceName: 'S', bookSourceUrl: 'https://a.com', ruleContent: 'id.c@text',
  header: '{"X-Static":"1"}',
}
// normalizeSource 只产出源主体；id/status/importedAt 是注册表侧字段，测试补上即可（与 source-request.test 同形）
const source: NovelSource = { id: 'i', status: 'unverified', importedAt: 0, ...normalizeSource(raw).source! }
// 本文件的断言都不触网（脚本只读 book / 头表 / 登录位）；可选能力位归那条能力位闸验
const fetcher: Fetcher = { fetchPage: async () => { throw new Error('不应触网') } }
// 阅读那条路递给镜像的架位实体：给一条真的，不靠 cast 蒙过字段集
const shelfBook: ShelfBook = {
  sourceId: 'i', bookKey: 'u', title: '书名', author: '作者',
  progress: { chapterIndex: 3, offsetRatio: 0.5, updatedAt: 0 }, addedAt: 0,
}

/** 脚本眼里的 `book`：同一位构造器，按调用方给的身份/架位形状出不同的字段集。 */
const bookOf = async (ev: ReturnType<typeof createSourceEval>, ctx: { tocUrl?: string; shelfBook?: ShelfBook } = {}) => {
  const subEval = ev.subEval({ book: { bookUrl: 'u', origin: 'https://a.com', ...ctx } })
  const value = await subEval('@js:JSON.stringify(book)', { baseUrl: 'https://a.com' }, 'detail', 'value')
  return value.kind === 'value' ? JSON.parse(value.text) as Record<string, unknown> : null
}

describe('SourceEval: one seam for source script evaluation', () => {
  it('without a shelf book, the book mirror keeps the search-face field set', async () => {
    const ev = createSourceEval(fetcher, source)
    expect(await bookOf(ev)).toEqual({ bookUrl: 'u', origin: 'https://a.com' })
  })

  it('with a shelf book, the same builder adds the reading-face fields', async () => {
    const ev = createSourceEval(fetcher, source)
    expect(await bookOf(ev, { shelfBook })).toEqual({
      bookUrl: 'u', origin: 'https://a.com', name: '书名', author: '作者',
    })
  })

  it('the toc/content face adds tocUrl, the detail face does not（逐面字段集仍由调用方给）', async () => {
    const ev = createSourceEval(fetcher, source)
    expect(await bookOf(ev, { tocUrl: 'https://a.com/toc' })).toEqual({
      bookUrl: 'u', origin: 'https://a.com', tocUrl: 'https://a.com/toc',
    })
  })

  it('headers() keeps static headers and dynamic-rule precedence', async () => {
    const dynamic = { ...source, rules: { ...source.rules, headerRule: '@js:JSON.stringify({"X-Dev":"d1"})' } }
    const ev = createSourceEval(fetcher, dynamic)
    const h = await ev.headers()
    expect(h['X-Static']).toBe('1')
    expect(h['X-Dev']).toBe('d1')
  })

  it('头规则脚本的六个出站口都用静态头，且不递归回头规则（出站数 = 脚本调用数）', async () => {
    // 不递归只能从**出站次数**上观测：脚本三次调用若回头发起头规则求值，每轮会多出三发。
    // 三条调用走三条**不同**的出口：ajax（fetch）、post（fetchPost）、双参 get（fetchGet）——
    // 只观测 ajax 时另外两条出口用不用静态头、会不会递归，一条断言都管不到。
    const seen: { method: string; url: string; headers: Record<string, string> }[] = []
    const f: Fetcher = {
      fetchPage: async (url, init) => {
        seen.push({ method: init?.method ?? 'GET', url, headers: init?.headers ?? {} })
        return {
          raw: Buffer.from(''), finalUrl: url, contentType: 'text/plain', charset: 'utf-8',
          status: 200, setCookie: [],
        }
      },
    }
    // header 与 headerRule 手工并存：normalize 的同一 raw.header 二选一产不出这一形态，但只有
    // 并存才观测得到「头规则脚本出站时带的是静态表，不是动态头」；本用例要的就是这一眼。
    const s = {
      ...source,
      rules: {
        ...source.rules,
        header: { 'X-Static': 'on' },
        headerRule: '@js: java.ajax("https://m.example.com/ping");'
          + ' java.post("https://m.example.com/post", "a=1");'
          + ' java.get("https://m.example.com/get", {});'
          + ' return JSON.stringify({ "X-Dyn": "1" })',
      },
      raw: { header: JSON.stringify({ 'X-Static': 'on' }) },
    } satisfies NovelSource
    const out = await resolveHeaders(f, s)
    expect(out['X-Dyn']).toBe('1')
    expect(out['X-Static']).toBe('on')
    // 三发恰是脚本的三次调用：任何多出来的一发都是递归（头规则被自身请求重新求值）
    expect(seen).toHaveLength(3)
    expect(seen.map((r) => [r.method, r.url])).toEqual([
      ['GET', 'https://m.example.com/ping'],
      ['POST', 'https://m.example.com/post'],
      ['GET', 'https://m.example.com/get'],
    ])
    for (const r of seen) expect(r.headers['X-Static']).toBe('on')   // 每条出口都是静态头打底
  })

  it('登录面投影：调用方给的排在源 auth 之前，过期 auth 一概不供出', () => {
    const authed = { ...source, auth: { cookies: {}, loginInfo: { u: 'auth' }, headers: { Cookie: 'c=1' } } }
    const ctxOf = (opts: Parameters<typeof engineContextOf>[2] = { baseUrl: source.baseUrl }) =>
      engineContextOf(fetcher, authed, opts)
    // 只有源 auth 时供出它那份
    expect(ctxOf().loginInfo).toEqual({ u: 'auth' })
    expect(ctxOf().loginHeader).toBe('{"Cookie":"c=1"}')
    // 登录面板这次填的赢（表单录入优先于历史 auth）
    expect(ctxOf({ baseUrl: source.baseUrl, loginInfo: { u: 'form' }, loginHeader: '{"X-Form":"1"}' }).loginInfo).toEqual({ u: 'form' })
    expect(ctxOf({ baseUrl: source.baseUrl, loginInfo: { u: 'form' }, loginHeader: '{"X-Form":"1"}' }).loginHeader).toBe('{"X-Form":"1"}')
    // 过期：两个键整个缺席——空串与「没这回事」不许折叠
    const expired = { ...source, auth: { cookies: {}, expired: true, loginInfo: { u: 'auth' }, headers: { Cookie: 'c=1' } } }
    const ctx = engineContextOf(fetcher, expired, { baseUrl: source.baseUrl })
    expect(Object.hasOwn(ctx, 'loginInfo')).toBe(false)
    expect(Object.hasOwn(ctx, 'loginHeader')).toBe(false)
    // 空 headers 不算一份登录头（`{}` 供出去就是让脚本以为有）
    const bare = { ...source, auth: { cookies: {}, headers: {} } }
    expect(Object.hasOwn(engineContextOf(fetcher, bare, { baseUrl: source.baseUrl }), 'loginHeader')).toBe(false)
  })
})
