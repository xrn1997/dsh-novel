import { describe, expect, it } from 'vitest'
import { resolveHeaders } from '../../src/services/bridge.js'
import { headerOf, effectiveUserAgent } from '../../src/services/fetcher.js'
import type { Fetcher } from '../../src/services/fetcher.js'
import { normalizeSource, rawHeaderRule } from '../../src/services/normalize.js'
import type { NovelSource } from '../../src/services/types.js'

/**
 * 动态请求头（headerRule）回归钉子：
 * `@js:`/`<js>` header 规则经沙箱求值得 JSON 头表；求值失败 → warn 回退静态头（不炸请求）。
 * 真机实证：顶点小说（device-id/Authorization 全在 @js 规则里）此前被 normalize 当坏 JSON 丢弃
 * → 请求 4004 → ruleDetailInit `$.data` 空 → 详情/目录全链路失败。
 */

const mkSource = (over: Partial<NovelSource> = {}): NovelSource => ({
  id: 'i', name: '顶点小说', baseUrl: 'https://a.com', enabled: true, groups: [], type: 'text', raw: {},
  rules: {
    searchUrl: null, exploreUrl: null, probeKeyword: null, bookUrlPattern: null, ruleBookList: null, ruleBookName: null, ruleAuthor: null,
    ruleBookUrl: null, ruleCoverUrl: null, ruleIntro: null, ruleLastChapter: null, ruleKind: null, ruleWordCount: null, ruleTocUrl: null,
    ruleChapterList: null, ruleChapterName: null, ruleChapterUrl: null,
    ruleDetailName: null, ruleDetailAuthor: null, ruleDetailCoverUrl: null,
    ruleDetailIntro: null, ruleDetailLastChapter: null, ruleDetailKind: null, ruleDetailWordCount: null, ruleDetailInit: null,
    ruleContent: 'x', nextTocUrl: null, nextPageUrl: null, header: null, loginUrl: null, jsLib: null,
    headerRule: null,
  },
  status: 'unverified', importedAt: 0, ...over,
})
// 探针仅需占位：下面的 header 规则不发网络请求
const fetcher: Fetcher = { fetchPage: async () => { throw new Error('不应触网') } }

describe('normalize：header 单字段两形态', () => {
  const base = {
    bookSourceName: 'X', bookSourceUrl: 'https://a.com', ruleContent: 'id.c@text',
  }
  it('@js: 规则形态 → headerRule 保留、header 为 null、**不再报「非法 JSON」警告**', () => {
    const rule = '@js:\nvar uid=java.randomUUID();\nJSON.stringify({"X-Device": String(uid)})'
    const r = normalizeSource({ ...base, header: rule })
    expect(r.ok).toBe(true)
    expect(r.source!.rules.headerRule).toBe(rule)
    expect(r.source!.rules.header).toBeNull()
    expect(r.warnings.some((w) => w.field === 'header')).toBe(false)
  })
  it('<js>…</js> 规则形态同样识别（legado getHeaderMap 双前缀）', () => {
    const rule = '<js>JSON.stringify({"A":"b"})</js>'
    const r = normalizeSource({ ...base, header: rule })
    expect(r.source!.rules.headerRule).toBe(rule)
    expect(r.source!.rules.header).toBeNull()
  })
  it('静态 JSON 形态：header 解析、headerRule 为 null（互斥同源）', () => {
    const r = normalizeSource({ ...base, header: '{"User-Agent":"UA"}' })
    expect(r.source!.rules.header).toEqual({ 'User-Agent': 'UA' })
    expect(r.source!.rules.headerRule).toBeNull()
  })
  it('非规则的坏 JSON → 仍报警告（老口径不动）', () => {
    const r = normalizeSource({ ...base, header: '{bad json' })
    expect(r.source!.rules.header).toBeNull()
    expect(r.source!.rules.headerRule).toBeNull()
    expect(r.warnings.some((w) => w.field === 'header')).toBe(true)
  })
  it('rawHeaderRule：raw 版判别（load 存量重推通道）——非对象返回 undefined（别动存量）', () => {
    expect(rawHeaderRule({ header: '@js:1' })).toBe('@js:1')
    expect(rawHeaderRule({ header: '{"A":"b"}' })).toBeNull()
    expect(rawHeaderRule(null)).toBeUndefined()
    expect(rawHeaderRule('not-an-object')).toBeUndefined()
  })
})

describe('resolveHeaders（legado getHeaderMap 口径）', () => {
  it('无规则 → 静态头直答（含 auth/cookie 合并）', async () => {
    const s = mkSource({ rules: { ...mkSource().rules, header: { Referer: 'https://r' } }, auth: { cookies: { a: '1' } } })
    const h = await resolveHeaders(fetcher, s)
    expect(h).toEqual(headerOf(s))
    expect(h.Referer).toBe('https://r')
    expect(h.Cookie).toBe('a=1')
  })
  it('@js 规则求值 → JSON 头表生效，auth 在后占优（与静态形态同序）', async () => {
    const s = mkSource({
      rules: {
        ...mkSource().rules,
        headerRule: '@js:JSON.stringify({"X-Device":"dev-1","X-Shared":"from-rule"})',
      },
      auth: { headers: { 'X-Shared': 'from-auth' }, cookies: { sid: 's' } },
    })
    const h = await resolveHeaders(fetcher, s)
    expect(h['X-Device']).toBe('dev-1')
    expect(h['X-Shared']).toBe('from-auth') // auth 在后占优
    expect(h.Cookie).toBe('sid=s')
  })
  it('randomUUID 逐次求值 → device id 每请求刷新（legado 每请求 getHeaderMap 口径）', async () => {
    const s = mkSource({
      rules: { ...mkSource().rules, headerRule: '@js:JSON.stringify({"D": java.randomUUID()})' },
    })
    const a = await resolveHeaders(fetcher, s)
    const b = await resolveHeaders(fetcher, s)
    expect(a.D).not.toBe(b.D)
    expect(String(a.D)).toMatch(/^[0-9a-f-]{36}$/)
  })
  it('规则求值抛错 → warn 后回退静态头（不炸请求，legado try/catch 口径）', async () => {
    const s = mkSource({ rules: { ...mkSource().rules, headerRule: '@js:null.boom', header: { 'X-Fallback': '1' } } })
    const warn = console.warn
    const captured: unknown[] = []
    console.warn = (...a: unknown[]) => { captured.push(a.join(' ')) }
    try {
      const h = await resolveHeaders(fetcher, s)
      expect(h['X-Fallback']).toBe('1')
      expect(captured.some((m) => String(m).includes('动态头规则求值失败'))).toBe(true)
    } finally { console.warn = warn }
  })
  it('产物不是合法 JSON 对象 → 同样回退 + warn', async () => {
    const s = mkSource({ rules: { ...mkSource().rules, headerRule: '@js:"not-json-object"' } })
    const warn = console.warn
    console.warn = () => {}
    try {
      const h = await resolveHeaders(fetcher, s)
      expect(h).toEqual(headerOf(s))
    } finally { console.warn = warn }
  })
})

describe('effectiveUserAgent（java.getWebViewUA 的取值口径）', () => {
  it('源静态头里的 User-Agent 优先；没覆盖时回落缺省 UA（与 fetch 实际发的一致）', () => {
    expect(effectiveUserAgent(mkSource())).toMatch(/^Mozilla\/5\.0/)
    const s = mkSource({ rules: { ...mkSource().rules, header: { 'User-Agent': 'UA-from-source' } } as NovelSource['rules'] })
    expect(effectiveUserAgent(s)).toBe('UA-from-source')
  })
})
