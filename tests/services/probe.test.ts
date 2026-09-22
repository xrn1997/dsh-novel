import { describe, expect, it } from 'vitest'
import { probeSource } from '../../src/services/probe.js'
import { createFetcher } from '../../src/services/fetcher.js'
import { normalizeSource } from '../../src/services/normalize.js'
import type { NovelSource } from '../../src/services/types.js'

const SEARCH_HTML = '<html><body><div class="b"><a href="/book/1/">斗罗大陆</a><span>唐家三少</span></div>' +
  '<div class="b"><a href="/book/2/">凡人修仙传</a><span>忘语</span></div></body></html>'

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

describe('probeSource（search 面）', () => {
  it('取到 ≥1 本书且书名非空 → ok', async () => {
    const f = createFetcher({ fetchImpl: async () => new Response(SEARCH_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } }) })
    const r = await probeSource(src(), f)
    expect(r.ok).toBe(true)
    expect(r.itemCount).toBe(2)
    expect(r.firstTitle).toBe('斗罗大陆')
  })
  it('书名规则以属性终端收尾 → 与搜索面同 usage，不误判坏源（2026-09 审查）', async () => {
    // 标题住在属性里：usage='value' 时链尾未知词是 HTML 属性名，usage='list'（缺省）时
    // 它是选择器——探针曾漏传该参数，于是搜索面读得出书名的源被报「首条书名为空」的 broken。
    const html = '<html><body><div class="b"><a href="/book/1/" title="斗罗大陆">进入</a></div></body></html>'
    const f = createFetcher({ fetchImpl: async () => new Response(html) })
    const r = await probeSource(src({ ruleBookName: 'tag.a@title' }), f)
    expect(r.ok).toBe(true)
    expect(r.firstTitle).toBe('斗罗大陆')
  })
  it('源带 checkKeyWord → 探针第一个打它（本库 31/158 源实证，固定词会误判坏源）', async () => {
    const seen: string[] = []
    const f = createFetcher({
      fetchImpl: (async (input: RequestInfo | URL) => {
        const u = decodeURIComponent(String(input))
        seen.push(u)
        return new Response(u.includes('q=勇者') ? SEARCH_HTML : '<html></html>',
          { headers: { 'content-type': 'text/html; charset=utf-8' } })
      }) as never,
    })
    const r = await probeSource(src({ ruleSearch: { checkKeyWord: '勇者' } }), f)
    expect(r.ok).toBe(true)
    expect(seen[0]).toContain('q=勇者')
  })

  it('checkKeyWord 含 http/::/++/-- → 按 legado 弃用，回固定词序列', async () => {
    const n = normalizeSource({
      bookSourceName: 'S', bookSourceUrl: 'https://s.com', searchUrl: 'https://s.com/q={{key}}',
      ruleBookList: '@css:.b', ruleBookName: 'tag.a@text', ruleContent: '@css:#c@text',
      ruleSearch: { checkKeyWord: 'https://s.com/book/1' },
    })
    expect(n.source!.rules.probeKeyword).toBeNull()
  })


  it('规则取不到条目 → broken 口径（RuleEvalError 语义：0 命中）', async () => {
    const f = createFetcher({ fetchImpl: async () => new Response('<html></html>') })
    const r = await probeSource(src({ ruleBookList: '@css:.nope' }), f)
    expect(r.ok).toBe(false)
    expect(r.error?.code).toBe('RuleEvalError')
    expect(r.error?.message).toMatch(/段/)
  })
  it('不支持的规则语法 → UnsupportedRuleError 如实透出（探针不冒充空结果）', async () => {
    const f = createFetcher({ fetchImpl: async () => new Response(SEARCH_HTML) })
    // 取真·构不成选择器的形态：`词.词`（如 weirdsyntax.x）自 2026-09-22 起按对面
    // ElementsSingle 的 else 分支交 CSS 求值，不再是解析期错误
    const r = await probeSource(src({ ruleBookName: 'weirdsyntax$.x@text' }), f)
    expect(r.ok).toBe(false)
    expect(r.error?.code).toBe('UnsupportedRuleError')
  })
  it('首词 0 命中 → 换词重试，任一命中即 verified（词被站点停用不误杀）', async () => {
    const seen: string[] = []
    const f = createFetcher({ fetchImpl: async (input) => {
      const url = String(input)
      seen.push(decodeURIComponent(url.split('q=')[1] ?? ''))
      // 「书」0 命中；「小说」有结果——模拟 aijjxs 站停用单字「书」的行为
      const html = url.includes(encodeURIComponent('书')) && !url.includes(encodeURIComponent('小说'))
        ? '<html></html>' : SEARCH_HTML
      return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })
    } })
    const r = await probeSource(src(), f)
    expect(r.ok).toBe(true)
    expect(r.firstTitle).toBe('斗罗大陆')
    expect(seen).toEqual(['书', '小说']) // 命中即止，不打第三词
  })
  it('全部关键词 0 命中 → broken，报错点名试过的词', async () => {
    const f = createFetcher({ fetchImpl: async () => new Response('<html></html>', { headers: { 'content-type': 'text/html; charset=utf-8' } }) })
    const r = await probeSource(src({ ruleBookList: '@css:.nope' }), f)
    expect(r.ok).toBe(false)
    expect(r.error?.message).toMatch(/「书」「小说」「的」均无结果/)
  })
  it('网络失败 → FetchError', async () => {
    const f = createFetcher({ fetchImpl: async () => new Response('', { status: 500 }) })
    const r = await probeSource(src(), f)
    expect(r.ok).toBe(false)
    expect(r.error?.code).toBe('FetchError')
  })
  it('searchUrl 缺失 → RuleMissing', async () => {
    const f = createFetcher({ fetchImpl: async () => new Response(SEARCH_HTML) })
    const r = await probeSource(src({ searchUrl: undefined }), f)
    expect(r.ok).toBe(false)
    expect(r.error?.code).toBe('RuleMissing')
  })
  it('探针认 searchTimeoutMs：挂起的抓取在限时内回 FetchError（不再只靠 fetcher 固定 15s）', async () => {
    const f = createFetcher({ fetchImpl: () => new Promise<Response>(() => { /* 永不返回 */ }) })
    const t0 = Date.now()
    const r = await probeSource(src(), f, { timeoutMs: 50 })
    expect(Date.now() - t0).toBeLessThan(1000)
    expect(r.ok).toBe(false)
    expect(r.error?.code).toBe('FetchError')
  })

  // 以下为钉死口径的补测
  it('ruleBookName 缺失 → RuleMissing（不进条目求值）', async () => {
    const f = createFetcher({ fetchImpl: async () => new Response(SEARCH_HTML) })
    const r = await probeSource(src({ ruleBookName: undefined }), f)
    expect(r.ok).toBe(false)
    expect(r.error?.code).toBe('RuleMissing')
  })
  it('首条书名为空 → RuleEvalError（首条书名为空）', async () => {
    const f = createFetcher({ fetchImpl: async () => new Response(SEARCH_HTML) })
    const r = await probeSource(src({ ruleBookName: '@css:.nope@text' }), f)
    expect(r.ok).toBe(false)
    expect(r.error?.code).toBe('RuleEvalError')
    expect(r.error?.message).toMatch(/首条书名/)
    expect(r.itemCount).toBe(2)
  })
  it('声明的 charset 解不出 → DecodeError', async () => {
    const f = createFetcher({ fetchImpl: async () => new Response(SEARCH_HTML, { headers: { 'content-type': 'text/html; charset=x-nope' } }) })
    const r = await probeSource(src(), f)
    expect(r.ok).toBe(false)
    expect(r.error?.code).toBe('DecodeError')
  })

  // ── legado 请求形态（官方文档钉死；真实源 300 条失败的根因）──────────
  it('相对 searchUrl 按 bookSourceUrl 解析成绝对 URL（此前直接喂 fetch 必炸）', async () => {
    let seen = ''
    const f = createFetcher({ fetchImpl: async (input) => {
      seen = String(input)
      return new Response(SEARCH_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } })
    } })
    const r = await probeSource(src({ searchUrl: '/search?q={{key}}' }), f)
    expect(seen).toBe('https://s.com/search?q=%E4%B9%A6')
    expect(r.ok).toBe(true)
  })
  it('POST 选项形态：真发 POST + body 插值 + 声明 charset 解码', async () => {
    let method = ''
    let body = ''
    const f = createFetcher({ fetchImpl: async (_input, init) => {
      method = init?.method ?? 'GET'
      body = String(init?.body ?? '')
      return new Response(SEARCH_HTML)   // 无 content-type——charset 声明覆盖解码
    } })
    const r = await probeSource(src({
      searchUrl: '/s.php,{"method":"POST","body":"s={{key}}&t=1","charset":"utf-8"}',
    }), f)
    expect(method).toBe('POST')
    expect(body).toBe('s=%E4%B9%A6&t=1')
    expect(r.ok).toBe(true)
  })
  it('选项 headers 并入请求（含源静态 header 合并语义在 fetcher 层——此处验证透传）', async () => {
    let headers: Record<string, string> | undefined
    const f = createFetcher({ fetchImpl: async (_input, init) => {
      headers = init?.headers as Record<string, string>
      return new Response(SEARCH_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } })
    } })
    await probeSource(src({ searchUrl: '/x,{"headers":{"Referer":"https://ref.com"}}' }), f)
    expect(headers?.Referer).toBe('https://ref.com')
  })
})
