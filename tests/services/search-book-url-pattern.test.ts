import { describe, expect, it } from 'vitest'
import { createFetcher } from '../../src/services/fetcher.js'
import { fetchSearchPage } from '../../src/services/search-face.js'
import { probeSource } from '../../src/services/probe.js'
import { ReadingService } from '../../src/services/reading.js'
import { PageCache } from '../../src/services/cache.js'
import { Shelf } from '../../src/services/shelf.js'
import { SourceRegistry } from '../../src/services/sources.js'
import { normalizeSource } from '../../src/services/normalize.js'
import { makeTempDir, trackService } from '../temp-dir.js'
import type { NovelSource } from '../../src/services/types.js'

/**
 * bookUrlPattern 嗅探（对面 `model/webBook/BookList.kt`：`analyzeBookList` 命中 pattern 即按详情页
 * 解析并 return、`collections.isEmpty()` 且**未声明 pattern** 时回落详情、`getInfoItem` 取字段与定
 * URL）。Kotlin `String.matches(Regex)` 是**整串**匹配——JS 侧必须锚定，不能裸 `RegExp.test`。
 */

const BASE = 'https://s.com'
const LIST_BODY = '<html><body><div class="b"><a href="/book/1/">斗罗</a></div>' +
  '<div class="b"><a href="/book/2/">凡人</a></div></body></html>'
const DETAIL_BODY = '<html><body><h1 id="bt">剑来</h1><div id="au">烽火戏诸侯</div>' +
  '<div id="intro">简介</div><a id="cv" href="/img/jl.jpg">封面</a><a id="cc" href="/c/9.html">第9章 山前</a></body></html>'

function src(over: Record<string, unknown> = {}): NovelSource {
  const raw = {
    bookSourceName: 'S', bookSourceUrl: BASE,
    searchUrl: `${BASE}/search?q={{key}}`,
    ruleBookList: '@css:.b', ruleBookName: 'tag.a@text', ruleBookUrl: 'tag.a@href',
    ruleDetailName: '@css:#bt@text', ruleDetailAuthor: '@css:#au@text',
    ruleDetailCoverUrl: '@css:#cv@href', ruleDetailIntro: '@css:#intro@text',
    ruleDetailLastChapter: '@css:#cc@text',
    ruleContent: '@css:#content@textNodes', ...over,
  }
  const n = normalizeSource(raw)
  return { id: 'i', status: 'unverified', importedAt: 0, ...n.source! } as NovelSource
}

const htmlPage = (text: string, finalUrl?: string): Response => finalUrl === undefined
  ? new Response(text, { headers: { 'content-type': 'text/html; charset=utf-8' } })
  : {
    ok: true, status: 200, url: finalUrl,
    headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
    arrayBuffer: async () => new TextEncoder().encode(text).buffer,
  } as unknown as Response

async function captureWarn(run: () => Promise<void>): Promise<string[]> {
  const warns: string[] = []
  const orig = console.warn
  console.warn = (...a: unknown[]): void => { warns.push(a.join(' ')) }
  try { await run() } finally { console.warn = orig }
  return warns
}

describe('fetchSearchPage 的 bookUrlPattern 判定', () => {
  it('落地地址整串命中 pattern → info 形态（via pattern），列表规则不参与（对面命中即 return）', async () => {
    const f = createFetcher({ fetchImpl: async () => htmlPage(DETAIL_BODY) })
    const r = await fetchSearchPage(src({
      searchUrl: `${BASE}/book/123/`, bookUrlPattern: 'https://s\\.com/book/\\d+/',
    }), '书', f)
    expect(r.ok && r.shape).toBe('info')
    if (!r.ok || r.shape !== 'info') return
    expect(r.via).toBe('pattern')
    expect(r.body).toBe(DETAIL_BODY)
  })
  it('部分命中不算命中（Kotlin matches = 整串；缺尾锚不许当成详情页）', async () => {
    const f = createFetcher({ fetchImpl: async () => htmlPage(LIST_BODY) })
    const r = await fetchSearchPage(src({ bookUrlPattern: 'https://s\\.com/search' }), '书', f)
    expect(r.ok && r.shape).toBe('list')
    if (!r.ok || r.shape !== 'list') return
    expect(r.items).toHaveLength(2)
  })
  it('命中判定用**落地地址**（重定向后的 res.url，与对面 baseUrl=res.url 同口径）', async () => {
    const f = createFetcher({ fetchImpl: async () => htmlPage(DETAIL_BODY, `${BASE}/book/123/`) })
    const r = await fetchSearchPage(src({ bookUrlPattern: 'https://s\\.com/book/\\d+/' }), '书', f)
    expect(r.ok && r.shape).toBe('info')
  })
  it('列表 0 条 + 无 pattern → info 回落（via empty-list，对面「列表为空,按详情页解析」）', async () => {
    const f = createFetcher({ fetchImpl: async () => htmlPage('<html><body>无结果</body></html>') })
    const r = await fetchSearchPage(src(), '书', f)
    expect(r.ok && r.shape).toBe('info')
    if (!r.ok || r.shape !== 'info') return
    expect(r.via).toBe('empty-list')
  })
  it('列表 0 条 + pattern 未命中 → 仍 0 条，不再回落详情页（对面守卫是 bookUrlPattern.isNullOrEmpty）', async () => {
    const f = createFetcher({ fetchImpl: async () => htmlPage('<html><body>无结果</body></html>') })
    const r = await fetchSearchPage(src({ bookUrlPattern: 'https://s\\.com/x/\\d+' }), '书', f)
    expect(r.ok && r.shape).toBe('list')
    if (!r.ok || r.shape !== 'list') return
    expect(r.items).toEqual([])
  })
  it('缺 ruleBookList 不再是 RuleMissing（对面 getElements("") = 空列表 → 详情回落）', async () => {
    const f = createFetcher({ fetchImpl: async () => htmlPage(DETAIL_BODY) })
    const r = await fetchSearchPage(src({
      searchUrl: `${BASE}/book/123/`, ruleBookList: undefined, bookUrlPattern: undefined,
    }), '书', f)
    expect(r.ok && r.shape).toBe('info')
  })
  it('缺 ruleBookList 且 pattern 未命中 → 也不是 RuleMissing：list 形态 0 条', async () => {
    const f = createFetcher({ fetchImpl: async () => htmlPage(DETAIL_BODY) })
    const r = await fetchSearchPage(src({
      searchUrl: `${BASE}/book/123/`, ruleBookList: undefined, bookUrlPattern: 'https://x\\.y/z',
    }), '书', f)
    expect(r.ok && r.shape).toBe('list')
    if (!r.ok || r.shape !== 'list') return
    expect(r.items).toEqual([])
  })
  it('未声明 ruleBookInfo.name（平铺方言）→ 不开详情形态：嗅探命中也只 0 条，不拿搜索规则造假书目', async () => {
    const f = createFetcher({ fetchImpl: async () => htmlPage(DETAIL_BODY) })
    const r = await fetchSearchPage(src({
      searchUrl: `${BASE}/book/123/`, bookUrlPattern: 'https://s\\.com/book/\\d+/', ruleDetailName: undefined,
    }), '书', f)
    expect(r.ok && r.shape).toBe('list')
    if (!r.ok || r.shape !== 'list') return
    expect(r.items).toEqual([])
  })
  it('pattern 不是合法正则 → warn 点名 + 按未声明处理（列表照旧，不静默也不炸搜索）', async () => {
    const f = createFetcher({ fetchImpl: async () => htmlPage(LIST_BODY) })
    const warns = await captureWarn(async () => {
      const r = await fetchSearchPage(src({ bookUrlPattern: '([unclosed' }), '书', f)
      expect(r.ok && r.shape).toBe('list')
    })
    expect(warns.join('\n')).toMatch(/bookUrlPattern/)
  })
  it('info 的 bookUrl：未重定向 = 代入后的模板**含 `,{option}`**（对面 ruleUrl）', async () => {
    const f = createFetcher({ fetchImpl: async () => htmlPage(DETAIL_BODY) })
    const r = await fetchSearchPage(src({
      searchUrl: `${BASE}/search?q={{key}},{"method":"POST","body":"s=1"}`,
      bookUrlPattern: 'https://s\\.com/search\\?q=.+',
    }), '书', f)
    expect(r.ok && r.shape).toBe('info')
    if (!r.ok || r.shape !== 'info') return
    expect(r.bookUrl).toBe(`${BASE}/search?q=%E4%B9%A6,{"method":"POST","body":"s=1"}`)
  })
  it('info 的 bookUrl：重定向 = 落地地址（对面 isRedirect 分支）', async () => {
    const f = createFetcher({ fetchImpl: async () => htmlPage(DETAIL_BODY, `${BASE}/book/123/`) })
    const r = await fetchSearchPage(src({ bookUrlPattern: 'https://s\\.com/book/\\d+/' }), '书', f)
    expect(r.ok && r.shape).toBe('info')
    if (!r.ok || r.shape !== 'info') return
    expect(r.bookUrl).toBe(`${BASE}/book/123/`)
  })
})

describe('探针的 info 形态（与聚合搜索同一详情实现）', () => {
  it('嗅探命中 → 书名按 ruleDetailName 判，源 verified', async () => {
    const f = createFetcher({ fetchImpl: async () => htmlPage(DETAIL_BODY) })
    const r = await probeSource(src({
      searchUrl: `${BASE}/book/123/`, bookUrlPattern: 'https://s\\.com/book/\\d+/',
    }), f)
    expect(r).toMatchObject({ ok: true, itemCount: 1, firstTitle: '剑来' })
  })
  it('空列表回落出的 info **不算 verified**：那是「这个词零命中」，照旧换词重试到判坏', async () => {
    const f = createFetcher({ fetchImpl: async () => htmlPage(DETAIL_BODY) })
    const r = await probeSource(src({
      searchUrl: `${BASE}/book/123/`, ruleBookList: undefined,
    }), f)
    expect(r.ok).toBe(false)
    expect(r.error?.message).toMatch(/0 命中/)
  })
})

// ── 门面级：info 形态怎么变成一条书目 ────────────────────────────────

async function makeSvc(raw: Record<string, unknown>, finalUrlOf: (url: string) => string | null = () => null): Promise<{ svc: ReadingService; id: string }> {
  const dir = await makeTempDir('novel-rd-')
  const registry = trackService(await SourceRegistry.load(dir))
  const shelf = trackService(await Shelf.load(dir))
  const impl = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input)
    const body = /\/search|\/book\/123/.test(url) ? DETAIL_BODY : LIST_BODY
    return htmlPage(body, finalUrlOf(url) ?? undefined)
  }
  const svc = trackService(await ReadingService.from({
    registry, shelf, cache: new PageCache(dir),
    fetcher: createFetcher({ fetchImpl: impl as never }),
  }))
  await svc.importOne(raw)
  return { svc, id: registry.list()[0].id }
}

const PATTERN_SRC = {
  bookSourceName: 'S', bookSourceUrl: BASE,
  searchUrl: `${BASE}/book/123/`, bookUrlPattern: 'https://s\\.com/book/\\d+/',
  ruleBookList: '@css:.b', ruleBookName: 'tag.a@text', ruleBookUrl: 'tag.a@href',
  ruleDetailName: '@css:#bt@text', ruleDetailAuthor: '@css:#au@text',
  ruleDetailCoverUrl: '@css:#cv@href', ruleDetailIntro: '@css:#intro@text',
  ruleDetailLastChapter: '@css:#cc@text',
  ruleContent: '@css:#content@textNodes',
}

describe('searchOne 的 info 形态命中（对面 getInfoItem）', () => {
  it('一条命中：字段走 ruleDetail*（不是搜索条目规则），封面按落地地址绝对化', async () => {
    const { svc, id } = await makeSvc(PATTERN_SRC)
    const groups = await svc.search('书', { sourceIds: [id] })
    expect(groups[0].error).toBeUndefined()
    expect(groups[0].hits).toHaveLength(1)
    const hit = groups[0].hits[0]
    expect(hit.title).toBe('剑来')
    expect(hit.author).toBe('烽火戏诸侯')
    expect(hit.intro).toContain('简介')
    expect(hit.lastChapterName).toBe('第9章 山前')
    expect(hit.coverUrl).toBe(`${BASE}/img/jl.jpg`)
    expect(hit.url).toBe(`${BASE}/book/123/`)
  })
  it('未重定向 → 书地址带 `,{option}`（对面 getAbsoluteURL(url, ruleUrl)：POST 源的选项即身份）', async () => {
    const { svc, id } = await makeSvc({
      ...PATTERN_SRC,
      searchUrl: `${BASE}/book/123/?q={{key}},{"method":"POST","body":"s=1"}`,
      bookUrlPattern: 'https://s\\.com/book/\\d+/\\?q=.+',
    })
    const groups = await svc.search('书', { sourceIds: [id] })
    expect(groups[0].hits[0].url).toBe(`${BASE}/book/123/?q=%E4%B9%A6,{"method":"POST","body":"s=1"}`)
  })
  it('详情书名为空 → 0 命中（对面 book.name.isNotBlank() 才收），不报错', async () => {
    const { svc, id } = await makeSvc({ ...PATTERN_SRC, ruleDetailName: '@css:#nosuch@text' })
    const groups = await svc.search('书', { sourceIds: [id] })
    expect(groups[0].error).toBeUndefined()
    expect(groups[0].hits).toEqual([])
  })
  it('重定向命中 → URL 用落地地址（搜索地址本身不是可重访的详情页）', async () => {
    const { svc, id } = await makeSvc(
      { ...PATTERN_SRC, searchUrl: `${BASE}/search?q={{key}}` },
      (u) => (/\/search/.test(u) ? `${BASE}/book/123/` : null),
    )
    const groups = await svc.search('书', { sourceIds: [id] })
    expect(groups[0].hits).toHaveLength(1)
    expect(groups[0].hits[0].title).toBe('剑来')
    expect(groups[0].hits[0].url).toBe(`${BASE}/book/123/`)
  })
  it('回落遇上 init 零命中 → 0 命中而不是搜索错误（对面 setContent(null) 后就没书目；把空结果升级成整源失败是第 19 批真机抓回的回退）', async () => {
    const { svc, id } = await makeSvc({
      ...PATTERN_SRC,
      searchUrl: `${BASE}/search?q={{key}}`, bookUrlPattern: undefined,
      ruleBookList: '@css:.nosuch', ruleDetailInit: '@css:#no-such-node@html',
    })
    const groups = await svc.search('书', { sourceIds: [id] })
    expect(groups[0].error).toBeUndefined()
    expect(groups[0].hits).toEqual([])
  })
})
