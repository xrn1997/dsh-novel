import { describe, expect, it } from 'vitest'
import { ReadingService } from '../../src/services/reading.js'
import { makeTempDir, trackService } from '../temp-dir.js'
import { createFetcher } from '../../src/services/fetcher.js'
import { PageCache } from '../../src/services/cache.js'
import { Shelf } from '../../src/services/shelf.js'
import { SourceRegistry } from '../../src/services/sources.js'
import { ChapterNotFoundError, RuleMissingError, SourceNotFoundError } from '../../src/services/errors.js'

const BASE = 'https://s.com'
const SEARCH_HTML = (q: string) => `<html><body><div class="b"><a href="/book/1/">${q}·斗罗</a><span>唐家</span></div></body></html>`
// fixture 订正（内联执行时发现三处缺陷）：①目录条目 class 必须命中 ruleBookList
// （@css:.b）——legado 口径搜索与目录共用 ruleBookList，章节 div 用 "b ch" 双类；
// ②getChapter 用例的路由必须同时服务目录页（getChapter 依赖 getToc）；
// ③正文 div 的 id 必须与规则选择器 #content 一致（div id="c" 对 #content，必零命中）。
const TOC_HTML = `<html><body><div class="b ch"><a href="/c/1.html">第一章</a></div><div class="b ch"><a href="/c/2.html">第二章</a></div><a class="tn" href="/toc2.html">下一页</a></body></html>`
const TOC2_HTML = `<html><body><div class="b ch"><a href="/c/3.html">第三章</a></div></body></html>`
const CONTENT1_HTML = `<html><body><div id="content">正文一<p></p><p>  第二段  </p><p></p><p></p><p>第三段</p></div><a class="np" href="/c/1p2.html">下页</a></body></html>`
const CONTENT1P2_HTML = `<html><body><div id="content">尾段</div></body></html>`
// 正文容器在但零文本（站点整站 302/改版后的典型形态：选择器命中却没有正文）
const EMPTY_CONTENT_HTML = `<html><body><div id="content"></div></body></html>`

function route(htmlOf: (url: string) => string | null) {
  return async (input: RequestInfo | URL): Promise<Response> => {
    const body = htmlOf(String(input))
    return body === null ? new Response('', { status: 404 }) : new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } })
  }
}

const rawSource = {
  bookSourceName: 'S', bookSourceUrl: BASE,
  searchUrl: `${BASE}/search?q={{key}}`,
  ruleBookList: '@css:.b', ruleBookName: 'tag.a@text', ruleAuthor: 'tag.span@text', ruleBookUrl: 'tag.a@href',
  ruleTocUrl: `${BASE}/book/1/`,
  ruleChapterName: 'tag.a@text', ruleChapterUrl: 'tag.a@href',
  ruleContent: '@css:#content@textNodes', nextTocUrl: 'tag.a.tn@href', nextPageUrl: 'tag.a.np@href',
}

// 组合根 seam：测试自持 registry 部件——listSources/getSource 已从门面删除
// （全量 NovelSource 投影出服务层破凭据红线），断言走 registry 部件，不为测试开门面洞。
// flush 归此 seam：SourceRegistry 的 100ms 尾沿防抖写会在文件 teardown 之后才触发，
// mkdir 把 setup.ts 刚删掉的临时目录又建回来（实测 ENOTEMPTY/复活）。测试自持 registry，
// 故在此收口——registry 与 shelf 各 trackService 一次（见 temp-dir.ts），删目录前先等写落地。
async function makeService(htmlOf: (url: string) => string | null): Promise<{ svc: ReadingService; registry: SourceRegistry }> {
  const dir = await makeTempDir('novel-rd-')
  const registry = trackService(await SourceRegistry.load(dir))
  const shelf = trackService(await Shelf.load(dir))
  const svc = trackService(await ReadingService.from({
    registry,
    shelf,
    cache: new PageCache(dir),
    fetcher: createFetcher({ fetchImpl: route(htmlOf) as never }),
  }))
  await svc.importOne(rawSource) // 探针会真打一次搜索——route 覆盖
  return { svc, registry }
}

describe('ReadingService', () => {
  // ── 写侧动词：变更归门面，dispatch 不再手写 registry.edit 配方 ──────────────────
  describe('写侧动词', () => {
    it('setEnabled / setEnabledMany：单改与批改（未知 id 静默跳过、重复 id 幂等——旧 dispatch 配方语义原样入门面）', async () => {
      const { svc, registry } = await makeService(() => null)
      const [a] = registry.list()
      const bRaw = { ...rawSource, bookSourceName: 'B', bookSourceUrl: 'https://b2.com' }
      const b = (await svc.importOne(bRaw)).sourceId!
      expect(await svc.setEnabled(a.id, false)).toBe(true)
      expect(registry.get(a.id)!.enabled).toBe(false)
      expect(await svc.setEnabledMany([a.id, b, b, 'nope'], true)).toBe(2)   // 重复 b 计一次、nope 跳过
      expect(registry.get(a.id)!.enabled).toBe(true)
      expect(await svc.setEnabled('nope', true)).toBe(false)
    })
    it('removeSource / removeSources：单删与批删；不存在 → false/0', async () => {
      const { svc, registry } = await makeService(() => null)
      const [a] = registry.list()
      const b = (await svc.importOne({ ...rawSource, bookSourceName: 'B', bookSourceUrl: 'https://b3.com' })).sourceId!
      expect(await svc.removeSources([a.id, b, 'nope'])).toBe(2)
      expect(registry.list()).toHaveLength(0)
      expect(await svc.removeSource('nope')).toBe(false)
      expect(await svc.removeSources(['nope'])).toBe(0)
    })
    it('saveAuth：cookie 录入带 acquiredAt（旧 dispatch 手拼 SourceAuth 的知识归门面）', async () => {
      const { svc, registry } = await makeService(() => null)
      const [a] = registry.list()
      const before = Date.now()
      await svc.saveAuth(a.id, { cookie: 'k=v' }, { 'X-Token': 't' })
      const auth = registry.get(a.id)!.auth!
      expect(auth.cookies).toEqual({ cookie: 'k=v' })
      expect(auth.headers).toEqual({ 'X-Token': 't' })
      expect(auth.acquiredAt).toBeGreaterThanOrEqual(before)
      await svc.saveAuth(a.id, { cookie: 'k2=v2' })
      expect(registry.get(a.id)!.auth!.headers).toBeUndefined()    // 不带 headers → 无该键
    })
    it('listPublicSources：凭据红线投影（registry.list().map(toPublic) 的调用方知识入门面）', async () => {
      const { svc, registry } = await makeService(() => null)
      const list = svc.listPublicSources()
      expect(list).toHaveLength(1)
      expect(list[0]).toMatchObject({ name: 'S' })
      expect('raw' in list[0]).toBe(false)
      expect('rules' in list[0]).toBe(false)
      expect('auth' in list[0]).toBe(false)
    })
    it('searchPlan：参与集唯一主人（启停 invariant 在服务端——客户端不再自行重推导）', async () => {
      const { svc, registry } = await makeService(() => null)
      const [a] = registry.list()
      const b = (await svc.importOne({ ...rawSource, bookSourceName: 'B', bookSourceUrl: 'https://b-plan.com' })).sourceId!
      expect(svc.searchPlan().sourceIds.sort()).toEqual([a.id, b].sort())   // 两个启用源全参搜
      await svc.setEnabled(a.id, false)
      expect(svc.searchPlan().sourceIds).toEqual([b])                        // 停用即出参与集
    })
  })

  it('search 命中并分组；broken 单源失败不拖垮他源', async () => {
    const { svc, registry } = await makeService((u) =>
      u.includes('/search') ? SEARCH_HTML('斗罗') : null)
    const groups = await svc.search('斗罗')
    expect(groups).toHaveLength(1)
    expect(groups[0].error).toBeUndefined()
    expect(groups[0].hits[0]).toMatchObject({ title: '斗罗·斗罗', url: `${BASE}/book/1/` })

    // 造一个会失败的源
    const raw2 = { ...rawSource, bookSourceName: 'B', bookSourceUrl: 'https://b.com', searchUrl: 'https://b.com/s?q={{key}}' }
    await svc.importOne(raw2)
    const g2 = await svc.search('斗罗')
    expect(g2).toHaveLength(2)
    const bad = g2.find((g) => g.sourceName === 'B')!
    expect(bad.error?.code).toBe('FetchError')
    expect(bad.hits).toEqual([])
  })

  it('search sourceIds 为空数组 = 未限定（搜全部启用源），与工具描述一致', async () => {
    const { svc } = await makeService((u) => (u.includes('/search') ? SEARCH_HTML('斗罗') : null))
    // 此前空数组 → 「搜零个源」零分组空结果（`!opts?.sourceIds` 对 [] 为 false）
    const groups = await svc.search('斗罗', { sourceIds: [] })
    expect(groups).toHaveLength(1)
    expect(groups[0].hits[0]).toMatchObject({ title: '斗罗·斗罗' })
  })

  it('重定向：搜索按落地地址解析相对链接（浏览器语义，与目录/正文同口径）', async () => {
    const dir = await makeTempDir('novel-rd-')
    const landedHtml = '<html><body><div class="b"><a href="book/1/">斗罗</a><span>唐家</span></div></body></html>'
    const fetchImpl = async (): Promise<Response> => ({
      ok: true, status: 200, url: 'https://s.com/landed/search',                       // 模拟被 302 到 /landed/
      headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
      arrayBuffer: async () => new TextEncoder().encode(landedHtml).buffer,
    } as unknown as Response)
    const svc = trackService(await ReadingService.create({ dir, fetchImpl: fetchImpl as never }))
    await svc.importOne(rawSource)
    const groups = await svc.search('斗罗')
    // 按落地址 → /landed/book/1/；按请求地址（旧行为）→ /book/1/
    expect(groups[0].hits[0].url).toBe('https://s.com/landed/book/1/')
  })

  it('getToc 两页跟 nextTocUrl 翻页闸合并，二次命中缓存零网络', async () => {
    let tocFetches = 0
    const { svc, registry } = await makeService((u) => {
      if (u.includes('/book/1/')) { tocFetches++; return TOC_HTML }
      if (u.includes('/toc2.html')) { tocFetches++; return TOC2_HTML }
      return u.includes('/search') ? SEARCH_HTML('x') : null
    })
    const src = registry.list()[0]
    const toc = await svc.getToc(src.id, `${BASE}/book/1/`)
    expect(toc.map((c) => c.name)).toEqual(['第一章', '第二章', '第三章'])
    expect(toc[2].url).toBe(`${BASE}/c/3.html`)
    const before = tocFetches
    await svc.getToc(src.id, `${BASE}/book/1/`)
    expect(tocFetches).toBe(before) // 缓存命中
  })

  it('getChapter 多页串接 + 正文规约；Miss 抛 RuleEvalError', async () => {
    let contentFetches = 0
    const { svc, registry } = await makeService((u) => {
      if (u.includes('/c/1.html')) { contentFetches++; return CONTENT1_HTML }
      if (u.includes('/c/1p2.html')) { contentFetches++; return CONTENT1P2_HTML }
      if (u.includes('/book/1/')) return TOC_HTML
      if (u.includes('/toc2.html')) return TOC2_HTML
      return u.includes('/search') ? SEARCH_HTML('x') : null
    })
    const src = registry.list()[0]
    const text = await svc.getChapter(src.id, `${BASE}/book/1/`, 0)
    expect(text).toBe('正文一\n第二段\n第三段\n尾段') // textNodes 逐文本节点分行；多页 join('\n')
    const before = contentFetches
    await svc.getChapter(src.id, `${BASE}/book/1/`, 0)
    expect(contentFetches).toBe(before) // 缓存命中

    await expect(svc.getChapter(src.id, `${BASE}/book/1/`, 99)).rejects.toThrowError(/目录中没有第 99 章/)
    // 类型化失败：越界与源不存在都不再是裸 Error——API 层按 instanceof 映射 404
    await expect(svc.getChapter(src.id, `${BASE}/book/1/`, 99)).rejects.toBeInstanceOf(ChapterNotFoundError)
    await expect(svc.getChapter('nope', `${BASE}/book/1/`, 0)).rejects.toBeInstanceOf(SourceNotFoundError)
  })

  it('缺目录/正文规则 → RuleMissingError（点名 facet 与规则名；API 层映射 422）', async () => {
    const { svc, registry } = await makeService((u) => (u.includes('/search') ? SEARCH_HTML('x') : null))
    // 只导搜索三件套：目录与正文规则全缺
    await svc.importOne({
      bookSourceName: 'NoToc', bookSourceUrl: 'https://n.com',
      searchUrl: 'https://n.com/s?q={{key}}', ruleBookList: '@css:.b', ruleBookName: 'tag.a@text',
      ruleContent: '@css:#content@text',
    })
    const n = registry.list().find((s) => s.name === 'NoToc')!
    const tocErr = await svc.getToc(n.id, 'https://n.com/book/1/').catch((e: unknown) => e)
    expect(tocErr).toBeInstanceOf(RuleMissingError)
    expect((tocErr as RuleMissingError).facet).toBe('toc')
    expect((tocErr as RuleMissingError).rule).toContain('ruleChapterList')
  })

  it('from()：组合根注入面——部件直装即业务可用（create 只是生产快捷方式）', async () => {
    const dir = await makeTempDir('novel-rd-')
    const registry = trackService(await SourceRegistry.load(dir))
    const shelf = trackService(await Shelf.load(dir))
    const cache = new PageCache(dir)
    const fetcher = createFetcher({ fetchImpl: route((u) => (u.includes('/search') ? SEARCH_HTML('斗罗') : null)) as never })
    const svc = trackService(await ReadingService.from({ registry, shelf, cache, fetcher }))
    await svc.importOne(rawSource)
    const groups = await svc.search('斗罗')
    expect(groups[0].error).toBeUndefined()
    expect(groups[0].hits[0].title).toContain('斗罗')
    // 注入的 registry 与门面持有同一实例（部件收 private 后以行为证成：部件直改可见于门面读口）
    await registry.edit((tx) => tx.setEnabled(registry.list()[0].id, false))
    expect(registry.list()[0].enabled).toBe(false)
  })

  it('getChapter：@html 正文转纯文本（@html 源收的是 HTML 片段——标签不许打给读者）', async () => {
    const { svc, registry } = await makeService((u) => {
      if (u.includes('/c/1.html')) return CONTENT1_HTML
      if (u.includes('/c/1p2.html')) return CONTENT1P2_HTML
      if (u.includes('/book/1/')) return TOC_HTML
      if (u.includes('/toc2.html')) return TOC2_HTML
      return u.includes('/search') ? SEARCH_HTML('x') : null
    })
    // 与 rawSource 同站同目录，只有正文规则换成 @html（久久小说网 #view_content_txt@html 同款形态）
    await svc.importOne({ ...rawSource, bookSourceName: 'H', bookSourceUrl: 'https://h.com', ruleContent: '@css:#content@html' })
    const h = registry.list().find((s) => s.name === 'H')!
    const text = await svc.getChapter(h.id, `${BASE}/book/1/`, 0)
    expect(text).toBe('正文一\n第二段\n第三段\n尾段')   // 块级边界换行；多页 join('\n')
    expect(text).not.toContain('<')                    // 标签一个都不留
  })

  it('getChapter：正文零命中 → 段级报错（带落点）且不写缓存——修复前静默写 0 字节缓存，全书空到无感', async () => {
    let serveReal = false
    const { svc, registry } = await makeService((u) => {
      if (u.includes('/c/1.html')) return serveReal ? CONTENT1_HTML : EMPTY_CONTENT_HTML
      if (u.includes('/c/1p2.html')) return CONTENT1P2_HTML
      if (u.includes('/book/1/')) return TOC_HTML
      if (u.includes('/toc2.html')) return TOC2_HTML
      return u.includes('/search') ? SEARCH_HTML('x') : null
    })
    const src = registry.list()[0]
    await expect(svc.getChapter(src.id, `${BASE}/book/1/`, 0)).rejects.toThrowError(/正文规则零命中.*ruleContent: @css:#content@textNodes.*落点 https:\/\/s\.com\/c\/1\.html/)
    serveReal = true
    // 零命中没有把空正文写进缓存，也没有污染 —— 站点恢复后立刻抓到真内容
    expect(await svc.getChapter(src.id, `${BASE}/book/1/`, 0)).toBe('正文一\n第二段\n第三段\n尾段')
  })

  it('importSource 数组逐条：坏条目不连坐，导入不探针（验证归批量验证）', async () => {
    const dir = await makeTempDir('novel-rd-')
    const registry = trackService(await SourceRegistry.load(dir))
    const shelf = trackService(await Shelf.load(dir))
    const svc = trackService(await ReadingService.from({
      registry,
      shelf,
      cache: new PageCache(dir),
      fetcher: createFetcher({ fetchImpl: route((u) => u.includes('/search') ? SEARCH_HTML('x') : null) as never }),
    }))
    const out = await svc.importSource([
      rawSource,
      { ...rawSource, bookSourceName: '坏源', bookSourceUrl: 'https://bad.com', searchUrl: undefined },
      { notASource: true },
    ])
    expect(out).toHaveLength(3)
    expect(out[0].ok).toBe(true)
    expect(out[0].probe).toBeNull()                        // 导入不含探针（钉死）
    expect(out[1].ok).toBe(true)                           // 坏源也导入成功（缺搜索规则不影响入库）
    expect(out[1].probe).toBeNull()
    expect(out[2].ok).toBe(false)                          // 缺必填
    expect(registry.list()).toHaveLength(2)
    expect(registry.list().every((s) => s.status === 'unverified')).toBe(true)
  })

  it('ruleChapterList 存在时目录用它（搜索列表与目录列表不同选择器）', async () => {
    const { svc, registry } = await makeService((u) => {
      if (u.includes('/book/1/')) return TOC_HTML
      if (u.includes('/toc2.html')) return TOC2_HTML
      return u.includes('/search') ? SEARCH_HTML('x') : null
    })
    // 目录列表选择器改成 .ch（ruleBookList 的 .b 在目录页也能命中——若误用 ruleBookList 会把
    // 章节 div 当列表项，章名仍取到但测试目的在语义：目录面必须走 ruleChapterList）
    await svc.importOne({
      ...rawSource,
      ruleBookList: '@css:.sl',          // 搜索面专用（本 fixture 搜索页无 .sl，仅验证目录不走它）
      ruleChapterList: '@css:.ch',
      searchUrl: undefined,              // 探针 RuleMissing 不阻塞导入
    })
    const src = registry.list().at(-1)!   // makeService 已导过 rawSource，取最后导入的
    const toc = await svc.getToc(src.id, `${BASE}/book/1/`)
    expect(toc.map((c) => c.name)).toEqual(['第一章', '第二章', '第三章'])
  })

  it('整本取不到章节 URL → 如实抛错，不产出全指目录页的假目录（2026-09 审查）', async () => {
    // 逐章回退（legado BookChapterList「未获取到url,使用baseUrl替代」）保留，但「每一条都
    // 回退」不是缺个别链接，而是 ruleChapterUrl 整体失效——静默产出 200 条指向目录页的
    // toc 等于拿合法形状冒充成功（本仓镜像的宁炸不猜）。
    const noHref = '<html><body><div class="b ch"><a>第一章</a></div><div class="b ch"><a>第二章</a></div></body></html>'
    const { svc, registry } = await makeService((u) => (u.includes('/book/1/') ? noHref : null))
    await expect(svc.getToc(registry.list().at(-1)!.id, `${BASE}/book/1/`)).rejects.toThrow(/ruleChapterUrl/)
  })

  it('只有个别章取不到 URL → 仍逐章回退目录页（不许把 legado 对齐改回整条丢弃）', async () => {
    const mixed = '<html><body><div class="b ch"><a href="/c/1.html">第一章</a></div><div class="b ch"><a>第二章</a></div></body></html>'
    const { svc, registry } = await makeService((u) => (u.includes('/book/1/') ? mixed : null))
    const toc = await svc.getToc(registry.list().at(-1)!.id, `${BASE}/book/1/`)
    expect(toc.map((c) => c.name)).toEqual(['第一章', '第二章'])
    expect(toc[0].url).toBe(`${BASE}/c/1.html`)
    expect(toc[1].url).toBe(`${BASE}/book/1/`)   // 缺链接的那章回退目录页地址，不丢条目
  })

  it('详情面优先 ruleDetail*（搜索/详情两上下文规则不同），缺时回退共用字段', async () => {
    const { svc, registry } = await makeService((u) => {
      if (u === `${BASE}/book/1/`) return '<html><body><h1>详情标题</h1><div class="b"><a href="/book/1/">搜索标题</a></div></body></html>'
      return u.includes('/search') ? SEARCH_HTML('搜索标题') : null
    })
    await svc.importOne({
      ...rawSource,
      ruleBookName: 'tag.a@text',           // 搜索上下文：任何 a 都命中（详情页 h1 之外还有 a 时会取错）
      ruleDetailName: 'tag.h1@text',        // 详情上下文：h1
      searchUrl: undefined,
    })
    const src = registry.list().at(-1)!   // makeService 已导过 rawSource，取最后导入的
    const detail = await svc.getDetail(src.id, `${BASE}/book/1/`)
    expect(detail.title).toBe('详情标题')   // 走 ruleDetailName
  })

  it('相对 searchUrl 按 baseUrl 解析 + POST 选项形态真发 POST（searchOne 与 probe 同口径）', async () => {
    const methods: string[] = []
    const svc = trackService(await ReadingService.create({
      dir: await makeTempDir('novel-rd-'),
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        methods.push(init?.method ?? 'GET')
        const u = String(input)
        return new Response(u.includes('/search') ? SEARCH_HTML('斗罗') : '', { headers: { 'content-type': 'text/html; charset=utf-8' } })
      }) as any,
    }))
    await svc.importOne({
      ...rawSource,
      searchUrl: '/search.php,{"method":"POST","body":"key={{key}}"}',   // 相对 + POST
    })
    const groups = await svc.search('斗罗')
    expect(methods).not.toContain('GET')                        // 探针与搜索全部走 POST
    expect(groups[0].error).toBeUndefined()
    expect(groups[0].hits).toHaveLength(1)
  })
})

describe('同步导入走 intake 入库规则（此前工具面导入无去重，同址可重复入库）', () => {
  // 组合根 seam：测试自持 registry 部件（setStatus 播种是测试关注点，不为它开门面洞）
  const mk = async (): Promise<{ svc: ReadingService; registry: SourceRegistry }> => {
    const dir = await makeTempDir('novel-rd-')
    const registry = await SourceRegistry.load(dir)
    const svc = trackService(await ReadingService.from({
      registry,
      shelf: await Shelf.load(dir),
      cache: new PageCache(dir),
      fetcher: createFetcher({ fetchImpl: route(() => null) as never }),
    }))
    return { svc, registry }
  }

  it('importOne 同址二次导入（已有 verified）：dupSkipped=true，库不增，sourceId=已有可用条目', async () => {
    const { svc, registry } = await mk()
    const first = await svc.importOne(rawSource)
    await registry.edit((tx) => tx.setStatus(first.sourceId!, 'verified', undefined, 1))
    const second = await svc.importOne({ ...rawSource, bookSourceName: 'S 改名重导' })
    expect(second).toMatchObject({ ok: true, dupSkipped: true, sourceId: first.sourceId })
    expect(registry.list()).toHaveLength(1)
    expect(registry.list()[0].name).toBe('S')             // 已有可用者优先保留（入库规则）
  })

  it('同址已有 unverified → replaced（复用 id）——与任务路径同口径', async () => {
    const { svc, registry } = await mk()
    const first = await svc.importOne(rawSource)
    const second = await svc.importOne({ ...rawSource, bookSourceName: 'S2', bookSourceUrl: `${BASE}/` })
    expect(second.ok).toBe(true)
    expect(registry.list()).toHaveLength(1)
    expect(registry.list()[0]).toMatchObject({ id: first.sourceId, name: 'S2' })
  })

  it('importSource 数组批内同址 → 留首条，后者 dupSkipped（批=一个 intake 实例）', async () => {
    const { svc, registry } = await mk()
    const out = await svc.importSource([
      rawSource,
      { ...rawSource, bookSourceName: 'S 重复' },
    ])
    expect(out.map((o) => o.ok)).toEqual([true, true])
    expect(out[1].dupSkipped).toBe(true)
    expect(registry.list()).toHaveLength(1)
    expect(registry.list()[0].name).toBe('S')
  })
})

describe('求值上下文组装单点（runLogin/tocUrl 此前漏 jsLib，潜伏期最长的一处）', () => {
  const mk = async (): Promise<ReadingService> => trackService(await ReadingService.create({
    dir: await makeTempDir('novel-rd-'),
    fetchImpl: route(() => null) as any,
  }))

  it('runLogin：@js 登录上下文带 jsLib（此前手拼上下文漏 jsLib——jsLib 函数只在登录那一刻炸 not defined）', async () => {
    const svc = await mk()
    const out = await svc.importOne({
      ...rawSource, bookSourceUrl: 'https://login.com',
      loginUrl: 'return buildCookie()',   // runLogin 统一加 @js: 前缀;evaluate 路径是函数体形态,完成值需显式 return
      jsLib: 'function buildCookie() { return "sid=abc; uid=7" }',
    })
    const auth = await svc.runLogin(out.sourceId!)
    expect(auth?.cookies).toEqual({ sid: 'abc', uid: '7' })
  })

  it('runLogin 空产出 → null 且不写登录态（不伪造 hasAuth）', async () => {
    const svc = await mk()
    const out = await svc.importOne({
      ...rawSource, bookSourceUrl: 'https://login-empty.com',
      loginUrl: 'return ""',
    })
    expect(await svc.runLogin(out.sourceId!)).toBe(null)
    expect(svc.listPublicSources().find((s) => s.id === out.sourceId!)?.hasAuth).toBe(false)
  })

  it('tocUrl 规则求值同走完整上下文（jsLib 可见——此前裸 {html,baseUrl} 连 source/fetch 都没有）', async () => {
    const svc = trackService(await ReadingService.create({
      dir: await makeTempDir('novel-rd-'),
      fetchImpl: route((u) => (u.includes('/book/1/') ? '<html><body><h1>详情</h1></body></html>' : null)) as any,
    }))
    const out = await svc.importOne({
      ...rawSource, bookSourceUrl: 'https://tocjs.com',
      ruleTocUrl: '@js: return libToc()',
      jsLib: 'function libToc() { return "https://toc.example.com/list" }',
    })
    const detail = await svc.getDetail(out.sourceId!, 'https://tocjs.com/book/1/')
    expect(detail.tocUrl).toBe('https://toc.example.com/list')
  })
})

describe('门面 probe 与搜索同耐心', () => {
  it('probe 认 searchTimeoutMs：挂起抓取在限时内回 FetchError，不落回 fetcher 固定 15s', async () => {
    const svc = trackService(await ReadingService.create({
      dir: await makeTempDir('novel-rd-'),
      searchTimeoutMs: 50,
      fetchImpl: (() => new Promise<Response>(() => { /* 永不返回 */ })) as never,
    }))
    const out = await svc.importOne({ ...rawSource })
    const t0 = Date.now()
    const r = await svc.probe(out.sourceId!)
    expect(Date.now() - t0).toBeLessThan(1500)
    expect(r.ok).toBe(false)
    expect(r.error?.code).toBe('FetchError')
  })
})

describe('门面直测（invariant 与 loginPlan 不再只穿 HTTP 测）', () => {
  const mk = async (): Promise<ReadingService> => trackService(await ReadingService.create({
    dir: await makeTempDir('novel-rd-'),
    fetchImpl: route(() => null) as any,
  }))

  it('loginPlan 三分支：URL 形态→manual（回传 loginUrl）；JS 形态→js；未声明→null；不存在→SourceNotFoundError', async () => {
    const svc = await mk()
    const manual = await svc.importOne({ ...rawSource, bookSourceUrl: 'https://m.com', loginUrl: 'https://login.com/x' })
    const js = await svc.importOne({ ...rawSource, bookSourceUrl: 'https://j.com', loginUrl: 'return "a=1"' })
    const none = await svc.importOne({ ...rawSource, bookSourceUrl: 'https://n.com' })
    expect(svc.loginPlan(manual.sourceId!)).toEqual({ mode: 'manual', loginUrl: 'https://login.com/x' })
    expect(svc.loginPlan(js.sourceId!)).toEqual({ mode: 'js' })
    expect(svc.loginPlan(none.sourceId!)).toBe(null)
    expect(() => svc.loginPlan('nope')).toThrow(/源不存在/)
  })

  it('localImport 自动上架 + removeBook 防孤儿文件（两 invariant 门面直测）', async () => {
    const svc = await mk()
    const { book } = await svc.localImport(Buffer.from('第1章 A\n内容', 'utf8'), 'x.txt')
    expect(book.sourceId).toBe('__local__')
    expect(svc.shelfList().some((b) => b.bookKey === book.bookKey)).toBe(true)
    await svc.removeBook(book.bookKey)
    expect(svc.shelfList().some((b) => b.bookKey === book.bookKey)).toBe(false)
    // 防孤儿：删书即删本地文件——再删一次本地书 id 返回 removed:false（文件已随书架条目清掉）
    expect((await svc.removeLocalBook(book.bookKey)).removed).toBe(false)
  })

  it('shelfSaveProgress：不在架 → null（不静默造书）；在架 → 返回更新后条目', async () => {
    const svc = await mk()
    expect(svc.shelfSaveProgress('nope', 1, 0.5)).toBe(null)
    svc.shelfAdd('k1', { sourceId: 's', title: 'T' })
    const saved = svc.shelfSaveProgress('k1', 2, 0.25)
    expect(saved?.progress).toMatchObject({ chapterIndex: 2, offsetRatio: 0.25 })
  })
})

describe('searchProgressive：给唯一实现加增量出口（不许出现第二个批循环）', () => {
  it('单源完成即回调（快的先出，不等慢的）；返回值仍按参搜源序，与 search() 同值', async () => {
    const dir = await makeTempDir('novel-sp-')
    const registry = trackService(await SourceRegistry.load(dir))
    const shelf = trackService(await Shelf.load(dir))
    let arm = false                                   // 探针也走搜索 URL：只在搜索阶段才拖慢
    let releaseSlow: () => void = () => {}
    const slow = new Promise<void>((r) => { releaseSlow = r })
    const plain = route(() => SEARCH_HTML('斗罗'))
    const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
      const u = String(input)
      if (arm && u.includes('b-late.com')) await slow
      return plain(u)
    }
    const svc = trackService(await ReadingService.from({
      registry, shelf, cache: new PageCache(dir),
      fetcher: createFetcher({ fetchImpl: fetchImpl as never }),
    }))
    await svc.importOne(rawSource)
    await svc.importOne({ ...rawSource, bookSourceName: 'B', bookSourceUrl: 'https://b-late.com', searchUrl: 'https://b-late.com/search?q={{key}}' })
    const order = registry.list().map((s) => s.name)                 // ['S','B']＝参搜源序
    arm = true
    const seen: string[] = []
    const running = svc.searchProgressive('斗罗', { onGroup: (g) => { seen.push(g.sourceName) } })
    await new Promise((r) => setTimeout(r, 30))
    expect(seen).toEqual(['S'])                                      // 增量：慢源未回，快源已交付
    releaseSlow()
    const groups = await running
    expect(seen.slice().sort()).toEqual(order.slice().sort())         // 两条都回调过
    expect(groups.map((g) => g.sourceName)).toEqual(order)            // 返回序 = 参搜源序（不是完成序）
    expect(await svc.search('斗罗')).toEqual(groups)                  // 防漂移：薄壳与 progressive 同值
  })

  it('无回调时 searchProgressive 与 search 完全等价（既有调用方零改动）', async () => {
    const { svc } = await makeService((u) => (u.includes('/search') ? SEARCH_HTML('斗罗') : null))
    expect(await svc.searchProgressive('斗罗')).toEqual(await svc.search('斗罗'))
  })
})
