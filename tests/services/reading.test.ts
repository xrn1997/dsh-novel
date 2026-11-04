import { describe, expect, it, vi } from 'vitest'
import { promises as fsPromises } from 'node:fs'
import path from 'node:path'
import type { Readable } from 'node:stream'
import { ReadingService } from '../../src/services/reading.js'
import type { SourceSession } from '../../src/engine/index.js'
import { detailContextOf } from '../../src/services/bridge.js'
import type { SubRuleEval } from '../../src/services/bridge.js'
import { chapterContentToText } from '../../src/services/chapter-content.js'
import { LOCAL_SOURCE_ID, LocalArtifactNotFoundError, LocalBooks } from '../../src/services/localbooks.js'
import { IMAGE_SAMPLES, makeEpubFixture } from '../fixtures/epub.js'
import { settleSearchJob } from '../explore-settle.js'
import { makeTempDir, trackService } from '../temp-dir.js'
import { createFetcher } from '../../src/services/fetcher.js'
import { CookieJar } from '../../src/services/cookies.js'
import { PageCache } from '../../src/services/cache.js'
import { Shelf } from '../../src/services/shelf.js'
import { SourceRegistry } from '../../src/services/sources.js'
import { ChapterNotFoundError, SourceNotFoundError } from '../../src/services/errors.js'
import { must, pick } from '../support/fixture.js'
import { requestUrlOf } from '../support/fetch-input.js'

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer))
  return Buffer.concat(chunks)
}

const BASE = 'https://s.com'
const SEARCH_HTML = (q: string) => `<html><body><div class="b"><a href="/book/1/">${q}·斗罗</a><span>唐家</span></div></body></html>`
// fixture 形态由三条形状约束钉出：①目录条目 class 必须命中 ruleBookList（@css:.b，搜索与目录共用）；
// ②getChapter 用例的路由必须同时服务目录页（getChapter 依赖 getToc）；③正文 div 的 id 必须与规则
// 选择器 #content 一致（对不上必零命中）。
const TOC_HTML = `<html><body><div class="b ch"><a href="/c/1.html">第一章</a></div><div class="b ch"><a href="/c/2.html">第二章</a></div><a class="tn" href="/toc2.html">下一页</a></body></html>`
const TOC2_HTML = `<html><body><div class="b ch"><a href="/c/3.html">第三章</a></div></body></html>`
const CONTENT1_HTML = `<html><body><div id="content">正文一<p></p><p>  第二段  </p><p></p><p></p><p>第三段</p></div><a class="np" href="/c/1p2.html">下页</a></body></html>`
const CONTENT1P2_HTML = `<html><body><div id="content">尾段</div></body></html>`

function route(
  htmlOf: (url: string) => string | null,
  onFetch?: (url: string, headers: Record<string, string>) => void,
) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    onFetch?.(requestUrlOf(input), (init?.headers ?? {}) as Record<string, string>)
    const body = htmlOf(requestUrlOf(input))
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
// mkdir 把 setup.ts 刚删掉的临时目录又建回来（ENOTEMPTY、目录复活）。测试自持 registry，
// 故在此收口——registry 与 shelf 各 trackService 一次（见 temp-dir.ts），删目录前先等写落地。
async function makeService(
  htmlOf: (url: string) => string | null,
  opts?: {
    /** 额外源字段（默认只导 rawSource）：四面 seam 用例用它挂静态 header */
    over?: Record<string, unknown>
    /** 每次出站的观测口（URL + 合并后的请求头） */
    onFetch?: (url: string, headers: Record<string, string>) => void
    /** 源级状态会话（删源清理用例观察 forget 的调用） */
    sourceSession?: SourceSession
  },
): Promise<{ svc: ReadingService; registry: SourceRegistry; dir: string }> {
  const dir = await makeTempDir('novel-rd-')
  const registry = trackService(await SourceRegistry.load(dir))
  const shelf = trackService(await Shelf.load(dir))
  const jar = new CookieJar()
  const fetcher = createFetcher({
    fetchImpl: route(htmlOf, opts?.onFetch),
    cookieJar: jar,
    ...(opts?.sourceSession === undefined ? {} : { sourceSession: opts.sourceSession }),
  })
  const svc = trackService(await ReadingService.from({
    registry, shelf, cache: new PageCache(dir), fetcher, cookieJar: jar,
  }))
  await svc.importOne({ ...rawSource, ...opts?.over })
  return { svc, registry, dir }
}

describe('ReadingService', () => {
  // ── 写侧动词：变更只由门面动词落，dispatch 不自己拼写侧配方 ──────────────────
  describe('写侧动词', () => {
    it('setEnabled / setEnabledMany：单改与批改（未知 id 静默跳过、重复 id 幂等——批改与单改是两份契约）', async () => {
      const { svc, registry } = await makeService(() => null)
      const a = pick(registry.list(), 0)
      const bRaw = { ...rawSource, bookSourceName: 'B', bookSourceUrl: 'https://b2.com' }
      const b = must((await svc.importOne(bRaw)).sourceId, '导入回执的 sourceId')
      // 单源启停：成功即返回（无 bool 回执）；未知 id 抛 SourceNotFoundError——
      // 「源不存在」的存在性判据只在门面一处，两个投影面各自按错误类型分类。
      await expect(svc.setEnabled(a.id, false)).resolves.toBeUndefined()
      expect(registry.list().find((s) => s.id === a.id)?.enabled).toBe(false)
      // setEnabledMany 是另一份契约：未知 id 静默跳过、重复 id 幂等
      expect(await svc.setEnabledMany([a.id, b, b, 'nope'], true)).toBe(2)   // 重复 b 计一次、nope 跳过
      expect(must(registry.get(a.id), 'registry 里查到的那一条').enabled).toBe(true)
      await expect(svc.setEnabled('nope', true)).rejects.toBeInstanceOf(SourceNotFoundError)
    })
    it('removeSource / removeSources：单删与批删；不存在 → false/0', async () => {
      const { svc, registry } = await makeService(() => null)
      const a = pick(registry.list(), 0)
      const b = must((await svc.importOne({ ...rawSource, bookSourceName: 'B', bookSourceUrl: 'https://b3.com' })).sourceId, '导入回执的 sourceId')
      expect(await svc.removeSources([a.id, b, 'nope'])).toBe(2)
      expect(registry.list()).toHaveLength(0)
      expect(await svc.removeSource('nope')).toBe(false)
      expect(await svc.removeSources(['nope'])).toBe(0)
    })
    it('removeSource / removeSources 清源级状态（按 baseUrl 键，不是 registry id）', async () => {
      const forgotten: string[] = []
      const session: SourceSession = {
        cookieJar: () => new Map<string, string>(),
        sourceVars: () => new Map<string, string>(),
        peekSourceVars: () => undefined,
        sourceString: () => '',
        setSourceString: () => {},
        cacheStore: () => new Map<string, string>(),
        forget: (key) => { forgotten.push(key) },
      }
      const { svc, registry } = await makeService(() => null, { sourceSession: session })
      const a = pick(registry.list(), 0)
      const b = must((await svc.importOne({ ...rawSource, bookSourceName: 'B', bookSourceUrl: 'https://b3.com' })).sourceId, '导入回执的 sourceId')
      const keys = [must(registry.get(a.id), 'registry 里查到的那一条').baseUrl, must(registry.get(b), 'registry 里查到的那一条').baseUrl]
      expect(await svc.removeSources([b, 'nope'])).toBe(1)
      expect(forgotten).toEqual([keys[1]])
      expect(await svc.removeSource(a.id)).toBe(true)
      expect(forgotten).toEqual([keys[1], keys[0]])
    })
    it('saveAuth：cookie 录入带 acquiredAt（SourceAuth 的组装知识只住门面）', async () => {
      const { svc, registry } = await makeService(() => null)
      const a = pick(registry.list(), 0)
      const before = Date.now()
      await svc.saveAuth(a.id, { cookie: 'k=v' }, { 'X-Token': 't' })
      const auth = must(must(registry.get(a.id), 'registry 里查到的那一条').auth, '登录态')
      expect(auth.cookies).toEqual({ cookie: 'k=v' })
      expect(auth.headers).toEqual({ 'X-Token': 't' })
      expect(auth.acquiredAt).toBeGreaterThanOrEqual(before)
      await svc.saveAuth(a.id, { cookie: 'k2=v2' })
      expect(must(must(registry.get(a.id), 'registry 里查到的那一条').auth, '登录态').headers).toBeUndefined()    // 不带 headers → 无该键
    })
    it('saveLoginInfo：只更新 loginInfo，保留既有 cookie/header', async () => {
      const { svc, registry } = await makeService(() => null)
      const a = pick(registry.list(), 0)
      await svc.saveAuth(a.id, { cookie: 'k=v' }, { 'X-Token': 't' })
      const before = Date.now()
      await svc.saveLoginInfo(a.id, { user: 'u' })
      const auth = must(must(registry.get(a.id), 'registry 里查到的那一条').auth, '登录态')
      expect(auth.cookies).toEqual({ cookie: 'k=v' })
      expect(auth.headers).toEqual({ 'X-Token': 't' })
      expect(auth.loginInfo).toEqual({ user: 'u' })
      expect(auth.acquiredAt).toBeGreaterThanOrEqual(before)
    })
    it('listPublicSources：凭据红线投影（全量 NovelSource 不出服务层，raw/rules/auth 一律不带）', async () => {
      const { svc } = await makeService(() => null)
      const list = svc.listPublicSources()
      expect(list).toHaveLength(1)
      const only = pick(list, 0)
      expect(only).toMatchObject({ name: 'S' })
      expect('raw' in only).toBe(false)
      expect('rules' in only).toBe(false)
      expect('auth' in only).toBe(false)
    })
    it('searchPlan：参与集唯一主人（启停 invariant 只在服务端判定，投影面直接吃这个集合）', async () => {
      const { svc, registry } = await makeService(() => null)
      const a = pick(registry.list(), 0)
      const b = must((await svc.importOne({ ...rawSource, bookSourceName: 'B', bookSourceUrl: 'https://b-plan.com' })).sourceId, '导入回执的 sourceId')
      expect(svc.searchPlan().sourceIds.sort()).toEqual([a.id, b].sort())   // 两个启用源全参搜
      await svc.setEnabled(a.id, false)
      expect(svc.searchPlan().sourceIds).toEqual([b])                        // 停用即出参与集
    })
  it('searchPlan/聚合搜索参与集：非文本源不参搜（当前仅支持小说文本面；源留库不删不改启用态）', async () => {
    const { svc, registry } = await makeService((u) => (u.includes('/search') ? SEARCH_HTML('斗罗') : null))
    const a = pick(registry.list(), 0)
    const bId = must((await svc.importOne({ ...rawSource, bookSourceName: '漫画源', bookSourceUrl: 'https://manga.example.com' })).sourceId, '导入回执的 sourceId')
    expect(svc.searchPlan().sourceIds.sort()).toEqual([a.id, bId].sort())    // 文本源照旧参搜
    const b = must(registry.list().find((s) => s.id === bId), 'registry.list() 里 find 命中的那一项')
    await registry.edit(() => { b.type = 'image' })                         // 模拟存量非文本源（intake 拒非文本入库，只能注册表侧造）
    expect(svc.searchPlan().sourceIds).toEqual([a.id])                       // 参与集唯一判定 excludes 非文本
    await registry.edit(() => { b.type = 'unknown' })                        // 表外编码同档：读不懂不等于文本
    expect(svc.searchPlan().sourceIds).toEqual([a.id])
    const groups = await svc.search('斗罗')
    expect(groups.map((g) => g.sourceId)).toEqual([a.id])
  })
  })

  it('search 命中并分组；broken 单源失败不拖垮他源', async () => {
    const { svc } = await makeService((u) =>
      u.includes('/search') ? SEARCH_HTML('斗罗') : null)
    const groups = await svc.search('斗罗')
    expect(groups).toHaveLength(1)
    const group = pick(groups, 0)
    expect(group.error).toBeUndefined()
    expect(pick(group.hits, 0)).toMatchObject({ title: '斗罗·斗罗', url: `${BASE}/book/1/` })

    // 造一个会失败的源
    const raw2 = { ...rawSource, bookSourceName: 'B', bookSourceUrl: 'https://b.com', searchUrl: 'https://b.com/s?q={{key}}' }
    await svc.importOne(raw2)
    const g2 = await svc.search('斗罗')
    expect(g2).toHaveLength(2)
    const bad = must(g2.find((g) => g.sourceName === 'B'), 'g2 里 find 命中的那一项')
    expect(bad.error?.code).toBe('FetchError')
    expect(bad.hits).toEqual([])
  })

  it('URL 位取值取 list 首项：条目里多个 <a> 时取首项，不拼成多行串', async () => {
    // 这类条目的形状 = 封面链 + 标题链 + 最新章节链，
    // `tag.a@href` 命中 2..n 个不同 href。URL 位一律取 `list[0]`——值规约若在这里 `join('\n')`，
    // `absUrl` 的换行守卫（`/[\t\n\r]/` 即 null）会**整条书目丢地址**：不报错，而是「搜到了却打不开」，
    // 症状与「列表规则零命中」混成一类。矩阵行 `b-url-value-first-item`；
    // join 只用于非 URL 取值：URL 里不可能有换行。
    const MULTI_A = (q: string): string => '<html><body><div class="b">'
      + '<a href="/book/1/"><img src="/1.jpg"></a>'
      + `<h3><a href="/book/1/">${q}·斗罗</a></h3>`
      + '<a href="/book/1/9.html">最新章节</a></div></body></html>'
    const { svc } = await makeService((u) => (u.includes('/search') ? MULTI_A('斗罗') : null))
    await svc.importOne({ ...rawSource, ruleBookName: 'h3@text' })
    const g = must((await svc.search('斗罗')).find((x) => x.sourceName === 'S'), '(await svc.search(\'斗罗\')) 里 find 命中的那一项')
    expect(g.error).toBeUndefined()
    expect(pick(g.hits, 0)).toMatchObject({ title: '斗罗·斗罗', url: `${BASE}/book/1/` })
  })

  it('源实体字段 `bookSourceComment` 脚本可见（解密脚本存书源注释的形态）', async () => {
    // 书源脚本里的 `source` 就是整个源实体 → `source.bookSourceComment` 必须可读：不投影该字段时
    // 脚本拿到 undefined（静默不映射、不报错）；这份输入就有把解密插值藏在 ruleContent.replaceRegex 的写法。
    // 用请求 URL 做观测点：把注释拼进 searchUrl。
    let seen = ''
    const { svc } = await makeService((u) => {
      if (u.includes('/search')) { seen = u; return SEARCH_HTML('斗罗') }
      return null
    })
    await svc.importOne({
      ...rawSource, bookSourceName: '带注释', bookSourceUrl: 'https://cmt.example.com',
      searchUrl: "@js:'https://cmt.example.com/search?q='+key+'&c='+source.bookSourceComment",
      bookSourceComment: 'COMMENTMARK',
    })
    const g = must((await svc.search('斗罗')).find((x) => x.sourceName === '带注释'), '(await svc.search(\'斗罗\')) 里 find 命中的那一项')
    expect(g.error).toBeUndefined()
    expect(seen).toContain('c=COMMENTMARK')
  })
  it('辅助字段的坏规则只丢该字段；裸奔项仍整组报错', async () => {
    // 辅助字段（intro / coverUrl / lastChapter / kind / wordCount）各包 try/catch，
    // name / author / bookUrl 裸奔——一条坏辅助规则不许带走整页书目。边界两侧都要钉：
    // 只钉「吞」会放行「什么都吞」，只钉「抛」会把读得出的源判死。
    const { svc } = await makeService((u) => (u.includes('/search') ? SEARCH_HTML('斗罗') : null))
    await svc.importOne({
      ...rawSource, bookSourceName: '坏简介', bookSourceUrl: 'https://bad-intro.example.com',
      searchUrl: 'https://bad-intro.example.com/search?q={{key}}',
      ruleIntro: '0',            // 无 @ 无 $ 的单段：本仓解析期抛 UnsupportedRuleError
      ruleCoverUrl: '0', ruleLastChapter: '0',
    })
    const soft = must((await svc.search('斗罗')).find((g) => g.sourceName === '坏简介'), '(await svc.search(\'斗罗\')) 里 find 命中的那一项')
    expect(soft.error, '书目在场、这三个字段空：不许把整组判死').toBeUndefined()
    expect(pick(soft.hits, 0)).toMatchObject({ title: '斗罗·斗罗', intro: null, coverUrl: null, lastChapterName: null })

    await svc.importOne({
      ...rawSource, bookSourceName: '坏作者', bookSourceUrl: 'https://bad-author.example.com',
      searchUrl: 'https://bad-author.example.com/search?q={{key}}', ruleAuthor: '0',
    })
    const hard = must((await svc.search('斗罗')).find((g) => g.sourceName === '坏作者'), '(await svc.search(\'斗罗\')) 里 find 命中的那一项')
    expect(hard.error?.code).toBeDefined()        // 作者裸奔：宁炸不猜的口径不变
    expect(hard.hits).toEqual([])
  })

  it('search sourceIds 为空数组 = 未限定（搜全部启用源），与工具描述一致', async () => {
    const { svc } = await makeService((u) => (u.includes('/search') ? SEARCH_HTML('斗罗') : null))
    // 空数组 = 未限定（搜全部启用源），不是「搜零个源」的零分组空结果
    const groups = await svc.search('斗罗', { sourceIds: [] })
    expect(groups).toHaveLength(1)
    expect(pick(pick(groups, 0).hits, 0)).toMatchObject({ title: '斗罗·斗罗' })
  })

  it('重定向：搜索按落地地址解析相对链接（浏览器语义，与目录/正文同口径）', async () => {
    const dir = await makeTempDir('novel-rd-')
    const landedHtml = '<html><body><div class="b"><a href="book/1/">斗罗</a><span>唐家</span></div></body></html>'
    const fetchImpl = async (): Promise<Response> => ({
      ok: true, status: 200, url: 'https://s.com/landed/search',                       // 模拟被 302 到 /landed/
      headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
      arrayBuffer: async () => new TextEncoder().encode(landedHtml).buffer,
    } as unknown as Response)
    const svc = trackService(await ReadingService.create({ dir, fetchImpl: fetchImpl }))
    await svc.importOne(rawSource)
    const groups = await svc.search('斗罗')
    // 解析基准是 302 落地地址；拿请求地址当基准会少掉 /landed/ 前缀
    expect(pick(pick(groups, 0).hits, 0).url).toBe('https://s.com/landed/book/1/')
  })

  it('getToc 两页跟 nextTocUrl 翻页闸合并，二次命中缓存零网络', async () => {
    let tocFetches = 0
    const { svc, registry } = await makeService((u) => {
      if (u.includes('/book/1/')) { tocFetches++; return TOC_HTML }
      if (u.includes('/toc2.html')) { tocFetches++; return TOC2_HTML }
      return u.includes('/search') ? SEARCH_HTML('x') : null
    })
    const src = pick(registry.list(), 0)
    const toc = await svc.getToc(src.id, `${BASE}/book/1/`)
    expect(toc.map((c) => c.name)).toEqual(['第一章', '第二章', '第三章'])
    expect(pick(toc, 2).url).toBe(`${BASE}/c/3.html`)
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
    const src = pick(registry.list(), 0)
    const text = await svc.getChapter(src.id, `${BASE}/book/1/`, 0)
    expect(text).toBe('正文一\n第二段\n第三段\n尾段') // textNodes 逐文本节点分行；多页 join('\n')
    const before = contentFetches
    await svc.getChapter(src.id, `${BASE}/book/1/`, 0)
    expect(contentFetches).toBe(before) // 缓存命中

    await expect(svc.getChapter(src.id, `${BASE}/book/1/`, 99)).rejects.toThrowError(/目录中没有第 99 章/)
    // 类型化失败：越界与源不存在都是类型化错误——API 层按 instanceof 映射 404
    await expect(svc.getChapter(src.id, `${BASE}/book/1/`, 99)).rejects.toBeInstanceOf(ChapterNotFoundError)
    await expect(svc.getChapter('nope', `${BASE}/book/1/`, 0)).rejects.toBeInstanceOf(SourceNotFoundError)
  })

  it('未知源的目录读以 rejection 交回 SourceNotFoundError（getToc 的 promise 契约没有同步 throw 漏口）', async () => {
    const { svc } = await makeService(() => null)
    await expect(svc.getToc('nope', `${BASE}/book/1/`)).rejects.toBeInstanceOf(SourceNotFoundError)
  })

  it('from()：组合根注入面——部件直装即业务可用（create 只是生产快捷方式）', async () => {
    const dir = await makeTempDir('novel-rd-')
    const registry = trackService(await SourceRegistry.load(dir))
    const shelf = trackService(await Shelf.load(dir))
    const cache = new PageCache(dir)
    const jar = new CookieJar()
    const fetcher = createFetcher({
      fetchImpl: route((u) => (u.includes('/search') ? SEARCH_HTML('斗罗') : null)),
      cookieJar: jar,
    })
    const svc = trackService(await ReadingService.from({ registry, shelf, cache, fetcher, cookieJar: jar }))
    // 引擎能力归源请求缝的 sourceRequest.fetcherFor；from() 不回写注入的基础 fetcher
    expect(fetcher.webview).toBeUndefined()
    await svc.importOne(rawSource)
    const groups = await svc.search('斗罗')
    const group = pick(groups, 0)
    expect(group.error).toBeUndefined()
    expect(pick(group.hits, 0).title).toContain('斗罗')
    // 注入的 registry 与门面持有同一实例（部件收 private 后以行为证成：部件直改可见于门面读口）
    await registry.edit((tx) => tx.setEnabled(pick(registry.list(), 0).id, false))
    expect(pick(registry.list(), 0).enabled).toBe(false)
  })

  it('静态头进入搜索/详情/目录/正文四面出站请求（源请求缝是唯一装配点）', async () => {
    const seen: { url: string; headers: Record<string, string> }[] = []
    const { svc, registry } = await makeService((u) => {
      if (u.includes('/search')) return SEARCH_HTML('斗罗')
      if (u.includes('/book/1/')) return TOC_HTML
      if (u.includes('/toc2.html')) return TOC2_HTML
      if (u.includes('/c/1.html')) return CONTENT1_HTML
      if (u.includes('/c/1p2.html')) return CONTENT1P2_HTML
      return null
    }, {
      over: { header: '{"X-Dyn":"1"}' },
      onFetch: (url, headers) => seen.push({ url, headers }),
    })
    const src = pick(registry.list(), 0)
    const groups = await svc.search('斗罗')
    expect(pick(groups, 0).error).toBeUndefined()
    await svc.getDetail(src.id, `${BASE}/book/1/`)
    expect((await svc.getToc(src.id, `${BASE}/book/1/`)).map((c) => c.name))
      .toEqual(['第一章', '第二章', '第三章'])
    expect(await svc.getChapter(src.id, `${BASE}/book/1/`, 0)).toContain('正文一')
    // 四面各至少一次出站：先钉「面真的跑了」，免得空 seen 让下一条断言空转
    for (const marker of ['/search', '/book/1/', '/toc2.html', '/c/1.html']) {
      expect(seen.some((r) => r.url.includes(marker)), `缺 ${marker} 面的出站`).toBe(true)
    }
    // 任何一面绕回基础 fetcher（不经 initFor）→ 该面请求丢静态头，整组红
    for (const r of seen) expect(r.headers['X-Dyn'], r.url).toBe('1')
  })

  it('from() 不替调用方造 jar：fetcher 与 parts 的 jar 不是同一张就当场炸', async () => {
    const dir = await makeTempDir('novel-rd-')
    const registry = trackService(await SourceRegistry.load(dir))
    const shelf = trackService(await Shelf.load(dir))
    const jarA = new CookieJar()
    const fetcher = createFetcher({ fetchImpl: (async () => new Response('')), cookieJar: jarA })
    await expect(ReadingService.from({
      registry, shelf, cache: new PageCache(dir), fetcher, cookieJar: new CookieJar(),
    })).rejects.toThrow(/同一张/)
  })

  it('from() 不写回：没带 jar 的 fetcher 装配后仍然没有 jar', async () => {
    const dir = await makeTempDir('novel-rd-')
    const registry = trackService(await SourceRegistry.load(dir))
    const shelf = trackService(await Shelf.load(dir))
    const fetcher = createFetcher({ fetchImpl: (async () => new Response('')) })
    const jar = new CookieJar()
    trackService(await ReadingService.from({ registry, shelf, cache: new PageCache(dir), fetcher, cookieJar: jar }))
    expect(fetcher.cookieJar).toBeUndefined()
  })

  it('from()：同一张 cookie jar 在构造时交给 fetcher 与源请求缝（脚本读到的就是请求层那张表）', async () => {
    const dir = await makeTempDir('novel-rd-')
    const registry = trackService(await SourceRegistry.load(dir))
    const shelf = trackService(await Shelf.load(dir))
    const jar = new CookieJar()
    jar.absorb(`${BASE}/`, ['sid=1; Path=/'])
    const fetcher = createFetcher({
      fetchImpl: route((u) => (u.includes('/search') ? SEARCH_HTML('斗罗') : null)),
      cookieJar: jar,
    })
    const svc = trackService(await ReadingService.from({
      registry, shelf, cache: new PageCache(dir), fetcher, cookieJar: jar,
    }))
    expect(fetcher.cookieJar).toBe(jar)
    await svc.importOne({
      ...rawSource,
      ruleBookName: `@js:Packages.android.webkit.CookieManager.getInstance().getCookie('${BASE}/')`,
    })
    const groups = await svc.search('斗罗')
    // 源请求缝的 fetcherFor 暴露的是同一张 jar；两处各持一张时这里会 Miss（书名空 → 无书目）
    expect(pick(pick(groups, 0).hits, 0).title).toBe('sid=1')
  })

  it('importSource 数组逐条：坏条目不连坐，导入不探针（验证归批量验证）', async () => {
    const dir = await makeTempDir('novel-rd-')
    const registry = trackService(await SourceRegistry.load(dir))
    const shelf = trackService(await Shelf.load(dir))
    const jar = new CookieJar()
    const svc = trackService(await ReadingService.from({
      registry,
      shelf,
      cache: new PageCache(dir),
      fetcher: createFetcher({
        fetchImpl: route((u) => u.includes('/search') ? SEARCH_HTML('x') : null),
        cookieJar: jar,
      }),
      cookieJar: jar,
    }))
    const out = await svc.importSource([
      rawSource,
      { ...rawSource, bookSourceName: '坏源', bookSourceUrl: 'https://bad.com', searchUrl: undefined },
      { notASource: true },
    ])
    expect(out).toHaveLength(3)
    const first = pick(out, 0)
    const second = pick(out, 1)
    const third = pick(out, 2)
    expect(first.ok).toBe(true)
    expect(first.probe).toBeNull()                        // 导入不含探针（钉死）
    expect(second.ok).toBe(true)                           // 坏源也导入成功（缺搜索规则不影响入库）
    expect(second.probe).toBeNull()
    expect(third.ok).toBe(false)                          // 缺必填
    expect(registry.list()).toHaveLength(2)
    expect(registry.list().every((s) => s.status === 'unverified')).toBe(true)
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
    const src = must(registry.list().at(-1), 'registry.list() 的最后一项')   // makeService 已导过 rawSource，取最后导入的
    const detail = await svc.getDetail(src.id, `${BASE}/book/1/`)
    expect(detail.title).toBe('详情标题')   // 走 ruleDetailName
  })

  it('详情面脚本读得到书架镜像字段（详情 intro 拿 `{{book.name}}` 拼串的形态）', async () => {
    // 书源脚本里的 `book` 是书目镜像：详情面脚本常拿它拼模板（`{{book.name}}`/`{{book.author}}`/
    // `{{book.kind}}`），还把 `book.kind` 当 kind 规则的**首选值**（`book.kind || get(…)`）。
    // 详情/目录两面的 book 镜像同样带 name/author/kind——缺了这些读法全是静默空。
    const { svc, registry } = await makeService((u) => (u === `${BASE}/book/1/` ? '<html><body><h1>详情标题</h1></body></html>' : null))
    await svc.importOne({
      ...rawSource, bookSourceName: '带镜像', bookSourceUrl: 'https://mirror.example.com',
      searchUrl: undefined, ruleDetailName: 'tag.h1@text',
      ruleDetailIntro: '书名：{{book.name}}｜标签：{{book.kind}}',
    })
    const src = must(registry.list().at(-1), 'registry.list() 的最后一项')
    svc.shelfAdd(`${BASE}/book/1/`, { sourceId: src.id, title: '镜像书名', kind: '都市' })
    const detail = await svc.getDetail(src.id, `${BASE}/book/1/`)
    expect(detail.intro).toBe('书名：镜像书名｜标签：都市')
  })
  it('相对 searchUrl 按 baseUrl 解析 + POST 选项形态真发 POST（searchOne 与 probe 同口径）', async () => {
    const methods: string[] = []
    const svc = trackService(await ReadingService.create({
      dir: await makeTempDir('novel-rd-'),
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        methods.push(init?.method ?? 'GET')
        const u = requestUrlOf(input)
        return new Response(u.includes('/search') ? SEARCH_HTML('斗罗') : '', { headers: { 'content-type': 'text/html; charset=utf-8' } })
      }),
    }))
    await svc.importOne({
      ...rawSource,
      searchUrl: '/search.php,{"method":"POST","body":"key={{key}}"}',   // 相对 + POST
    })
    const groups = await svc.search('斗罗')
    expect(methods).not.toContain('GET')                        // 探针与搜索全部走 POST
    expect(pick(groups, 0).error).toBeUndefined()
    expect(pick(groups, 0).hits).toHaveLength(1)
  })
})

// ── 书 URL 承载请求选项（`url,{option}` 随身份存取——URL 字符串即请求规格）────────
// 口径：URL 字符串即请求规格，命中/书架/抓取全程不剥离，抓取时由 assembleRequest
// 单点解释。API 源的 ruleBookUrl 是 `端点,{"method":"POST",…}` 形态，剥掉选项会让 bookKey 只剩
// 裸端点、POST body 里的 id 永久丢失，全链路 405。
describe('书 URL 承载请求选项（,{option} 随身份存取）', () => {
  const OPT = ',{"method":"POST","body":"app=x&book_id=42"}'
  const API_BOOK = `https://api.example.com/fiction/book/getDetail${OPT}`
  const API_RAW = {
    ...rawSource,
    bookSourceName: 'API源', bookSourceUrl: 'https://api.example.com',
    searchUrl: 'https://api.example.com/search?q={{key}}',
    ruleBookList: '@css:.b', ruleBookName: 'tag.a@text', ruleAuthor: 'tag.span@text', ruleBookUrl: 'tag.a@href',
    ruleDetailName: '$.name', ruleDetailAuthor: '$.author',
    ruleTocUrl: undefined, ruleChapterName: 'tag.a@text', ruleChapterUrl: 'tag.a@href',
    ruleContent: '@css:#content@textNodes', nextTocUrl: undefined, nextPageUrl: undefined,
  }
  // href 属性里的双引号须实体编码（cheerio 解析时还原）
  const SEARCH_HTML_OPT = `<html><body><div class="b"><a href="${API_BOOK.replace(/"/g, '&quot;')}">斗破苍穹</a><span>天蚕土豆</span></div></body></html>`

  it('搜索命中 url 保留 ,{option} 后缀——bookKey 即请求规格，不剥离', async () => {
    const { svc } = await makeService((u) => (u.includes('/search') ? SEARCH_HTML_OPT : null))
    await svc.importOne(API_RAW)
    const groups = await svc.search('斗破')
    const g = must(groups.find((x) => x.sourceName === 'API源'), 'groups 里 find 命中的那一项')
    expect(g.error).toBeUndefined()
    expect(pick(g.hits, 0).url).toBe(API_BOOK)   // URL 即请求规格：选项不剥离，book_id 随 body 一起保住
  })

  it('getDetail 按 bookKey 的 ,{option} 真发 POST 并带 body（选项串留在 URL 上会得站点错）', async () => {
    const calls: Array<{ url: string; method: string; body?: string }> = []
    const dir = await makeTempDir('novel-rd-')
    const registry = trackService(await SourceRegistry.load(dir))
    const shelf = trackService(await Shelf.load(dir))
    const jar = new CookieJar()
    const svc = trackService(await ReadingService.from({
      registry,
      shelf,
      cache: new PageCache(dir),
      fetcher: createFetcher({
        cookieJar: jar,
        fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
          const u = requestUrlOf(input)
          calls.push({ url: u, method: init?.method ?? 'GET', ...(typeof init?.body === 'string' ? { body: init.body } : {}) })
          if (u.includes('/search')) {
            return new Response(SEARCH_HTML_OPT, { headers: { 'content-type': 'text/html; charset=utf-8' } })
          }
          if (u === 'https://api.example.com/fiction/book/getDetail') {
            return new Response(JSON.stringify({ name: '斗破苍穹', author: '天蚕土豆' }),
              { headers: { 'content-type': 'application/json' } })
          }
          return new Response('', { status: 404 })
        }),
      }),
      cookieJar: jar,
    }))
    await svc.importOne(API_RAW)
    const src = must(registry.list().find((s) => s.name === 'API源'), 'registry.list() 里 find 命中的那一项')
    const d = await svc.getDetail(src.id, API_BOOK)
    expect(calls.some((c) =>
      c.url === 'https://api.example.com/fiction/book/getDetail' && c.method === 'POST' && c.body === 'app=x&book_id=42',
    )).toBe(true)   // 抓取解释选项：URL 剥选项、method/body 按选项发
    expect(d.title).toBe('斗破苍穹')
    expect(d.author).toBe('天蚕土豆')
  })
})

// ── 详情上下文 ruleBookInfo.init + tocUrl 模板过引擎插值 ────────
// 口径：详情规则依赖 init 换上下文、tocUrl 是带 `{{$.resourceID}}` 的模板。
// init 先求值，其结果**替换**后续详情规则的求值上下文；URL 模板按该上下文过规则引擎插值——
// 未插值的模板会把目录打到字面地址（0 章）。
// init 非空但零命中 → RuleEvalError 点名 ruleDetailInit（宁炸不猜：静默降级会把「规则与站点不符」
// 伪装成「源什么都没有」）。
describe('详情上下文 ruleDetailInit + tocUrl 模板插值', () => {
  const DETAIL_URL = 'https://qb.example.com/book/1100468914'
  const TOC_URL = 'https://qb.example.com/qbread/api/book/all-chapter?bookId=1100468914'
  const CH1_URL = 'https://qb.example.com/c/1.html'
  const QQ_RAW = {
    bookSourceName: '正版源', bookSourceUrl: 'https://qb.example.com',
    searchUrl: 'https://qb.example.com/s?k={{key}}',
    ruleBookList: '@css:.b', ruleBookName: 'tag.a@text', ruleAuthor: 'tag.span@text', ruleBookUrl: 'tag.a@href',
    ruleBookInfo: {
      init: '$.data.bookInfo',
      name: '$.resourceName', author: '$.author', intro: '$.summary',
      tocUrl: 'https://qb.example.com/qbread/api/book/all-chapter?bookId={{$.resourceID}}',
    },
    ruleToc: {
      chapterList: '$.rows', chapterName: '$.serialName',
      chapterUrl: 'https://qb.example.com/c/{{$.serialID}}.html',
    },
    ruleContent: '@css:#content@textNodes',
  }
  const SEARCH_QQ = `<html><body><div class="b"><a href="${DETAIL_URL}">斗破苍穹</a><span>天蚕土豆</span></div></body></html>`

  async function makeQq(detailBody: string): Promise<{
    svc: ReadingService; registry: SourceRegistry; calls: string[]
  }> {
    const calls: string[] = []
    const dir = await makeTempDir('novel-rd-')
    const registry = trackService(await SourceRegistry.load(dir))
    const shelf = trackService(await Shelf.load(dir))
    const jar = new CookieJar()
    const svc = trackService(await ReadingService.from({
      registry,
      shelf,
      cache: new PageCache(dir),
      fetcher: createFetcher({
        cookieJar: jar,
        fetchImpl: (async (input: RequestInfo | URL) => {
          const u = requestUrlOf(input)
          calls.push(u)
          const json = (body: string) => new Response(body, { headers: { 'content-type': 'application/json' } })
          if (u.includes('/s?')) return new Response(SEARCH_QQ, { headers: { 'content-type': 'text/html; charset=utf-8' } })
          if (u === DETAIL_URL) return json(detailBody)
          if (u === TOC_URL) return json(JSON.stringify({ rows: [{ serialID: 1, serialName: '第1章 陨落的天才' }] }))
          if (u === CH1_URL) {
            return new Response('<html><body><div id="content">斗之力，三段！</div></body></html>',
              { headers: { 'content-type': 'text/html; charset=utf-8' } })
          }
          return new Response('', { status: 404 })
        }),
      }),
      cookieJar: jar,
    }))
    await svc.importOne(QQ_RAW)
    return { svc, registry, calls }
  }

  const DETAIL_JSON = JSON.stringify({
    ret: 0,
    data: { bookInfo: { resourceID: '1100468914', resourceName: '斗破苍穹', author: '天蚕土豆', summary: '斗气世界简介' } },
  })

  it('getDetail 经 ruleBookInfo.init 换上下文：$.resourceName/$.author/$.summary 在 init 子 JSON 上命中', async () => {
    const { svc, registry } = await makeQq(DETAIL_JSON)
    const src = must(registry.list().find((s) => s.name === '正版源'), 'registry.list() 里 find 命中的那一项')
    const d = await svc.getDetail(src.id, DETAIL_URL)
    expect(d.title).toBe('斗破苍穹')
    expect(d.author).toBe('天蚕土豆')
    expect(d.intro).toBe('斗气世界简介')
  })

  // init 多求一次的代价不是多算一次纯路径：js 形态 init 的第二次求值会**再打一次站点**。
  // 这里用 `java.ajax` 当计数器——计数就是真实出站请求数，不是内部调用次数：init 每被求值一次就多打一次。
  // 各处只求一次 init，这个源上就只该有一次 /init-hit——这条钉的是单次。
  it('getDetail 只求一次 init：js 形态 init 不双打站点（tocUrl 复用同一份上下文）', async () => {
    const initHits: string[] = []
    const DETAIL = 'https://once.example.com/book/9'
    const dir = await makeTempDir('novel-rd-')
    const registry = trackService(await SourceRegistry.load(dir))
    const shelf = trackService(await Shelf.load(dir))
    const jar = new CookieJar()
    const svc = trackService(await ReadingService.from({
      registry, shelf, cache: new PageCache(dir),
      fetcher: createFetcher({
        cookieJar: jar,
        fetchImpl: (async (input: RequestInfo | URL) => {
          const u = requestUrlOf(input)
          if (u === 'https://once.example.com/init-hit') {
            initHits.push(u)
            return new Response('ok')
          }
          if (u === DETAIL) {
            return new Response('<html><body>详情页</body></html>', { headers: { 'content-type': 'text/html; charset=utf-8' } })
          }
          return new Response('', { status: 404 })
        }),
      }),
      cookieJar: jar,
    }))
    await svc.importOne({
      bookSourceName: '单次 init 源', bookSourceUrl: 'https://once.example.com',
      ruleContent: '$.text',
      ruleBookInfo: {
        init: '@js:java.ajax("https://once.example.com/init-hit"); JSON.stringify({ name: "单次", author: "甲", slug: "one" })',
        name: '$.name', author: '$.author',
        tocUrl: 'https://once.example.com/toc?b={{$.slug}}',
      },
      ruleToc: { chapterList: '$.rows', chapterName: '$.n', chapterUrl: '$.u' },
    })
    const src = must(registry.list().find((s) => s.name === '单次 init 源'), 'registry.list() 里 find 命中的那一项')
    const d = await svc.getDetail(src.id, DETAIL)
    expect(d).toMatchObject({ title: '单次', author: '甲', tocUrl: 'https://once.example.com/toc?b=one' })
    expect(initHits).toHaveLength(1)
  })

  // 这一族的写法是：ruleBookInfo.init 是**纯 @put**（只设变量），详情面每条规则都是
  // `@get:{k}`——三件事必须同时成立：init 不换根、vars 在这次 getDetail 内共享、`@get:{}` 花括号形态认。
  const META_URL = 'https://meta.example.com/book/77'
  const META_PAGE = `<html><head>
    <meta property="og:novel:book_name" content="武动乾坤">
    <meta property="og:novel:author" content="天蚕土豆">
    <meta property="og:description" content="少年林动，一夜蜕变">
    <meta property="og:novel:latest_chapter_name" content="第1章 蜕变">
  </head><body><div id="all-chapter"><a href="/c/1.html">第1章 蜕变</a></div></body></html>`
  const META_RAW = {
    bookSourceName: '元信息源', bookSourceUrl: 'https://meta.example.com',
    searchUrl: 'https://meta.example.com/s?q={{key}}',
    ruleBookList: '@css:.r', ruleBookName: 'tag.a@text', ruleBookUrl: 'tag.a@href',
    ruleBookInfo: {
      init: '@put:{n:"[property$=book_name]@content", a:"[property$=author]@content",'
        + ' i:"[property$=description]@content", l:"[property$=latest_chapter_name]@content"}',
      name: '@get:{n}', author: '@get:{a}', intro: '@get:{i}', lastChapter: '@get:{l}',
    },
    ruleToc: { chapterList: '#all-chapter a', chapterName: 'text', chapterUrl: 'href' },
    ruleContent: '@css:#all-chapter@html',
  }

  async function makeMeta(): Promise<{ svc: ReadingService; registry: SourceRegistry }> {
    const dir = await makeTempDir('novel-rd-')
    const registry = trackService(await SourceRegistry.load(dir))
    const shelf = trackService(await Shelf.load(dir))
    const jar = new CookieJar()
    const svc = trackService(await ReadingService.from({
      registry, shelf, cache: new PageCache(dir),
      fetcher: createFetcher({
        cookieJar: jar,
        fetchImpl: (async (input: RequestInfo | URL) => {
          const u = requestUrlOf(input)
          if (u === META_URL || u === 'https://meta.example.com/book/77') {
            return new Response(META_PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } })
          }
          return new Response('', { status: 404 })
        }),
      }),
      cookieJar: jar,
    }))
    await svc.importOne(META_RAW)
    return { svc, registry }
  }

  it('纯 @put 的 ruleDetailInit：只设变量、不换根——详情四字段经 @get:{k} 全部取到', async () => {
    const { svc, registry } = await makeMeta()
    const src = must(registry.list().find((s) => s.name === '元信息源'), 'registry.list() 里 find 命中的那一项')
    const d = await svc.getDetail(src.id, META_URL)
    expect(d).toMatchObject({
      title: '武动乾坤', author: '天蚕土豆', intro: '少年林动，一夜蜕变', lastChapterName: '第1章 蜕变',
    })
  })

  it('ruleDetailInit 非空但零命中 → RuleEvalError 点名 ruleDetailInit（宁炸：不拿整页冒充上下文）', async () => {
    const { svc, registry } = await makeQq(JSON.stringify({ ret: 0, data: {} }))   // init 路径不存在
    const src = must(registry.list().find((s) => s.name === '正版源'), 'registry.list() 里 find 命中的那一项')
    await expect(svc.getDetail(src.id, DETAIL_URL)).rejects.toThrowError(/ruleDetailInit/)
  })

  it('存量数据兼容：detailContextOf(undefined) 按缺规则直通——老 sources.json 无 ruleDetailInit 键不炸', async () => {
    const neverEval: SubRuleEval = async () => { throw new Error('缺规则不应求值') }
    await expect(detailContextOf(undefined as never, '<html><body/></html>', 'https://s.com', neverEval))
      .resolves.toEqual({ html: '<html><body/></html>' })
  })
})

// ── js 沙箱预算走配置出口（jsTimeoutMs）──────────────────────────────────────────
// 为什么要有这条配置：目录 @js 脚本要多次 java.ajax 往返再加签名才出得来结果，预算写死得太小就会把
// 这类脚本一律判成「脚本超时」。口径：沙箱预算走插件配置 jsTimeoutMs（缺省值住 src/config.ts 的配置面），
// 经 ReadingService → bridge → EvalContext 透传（引擎零改动）；搜索面/探针同口径。
describe('js 沙箱预算走配置出口（jsTimeoutMs）', () => {
  const slowJs = (ms: number, url: string): string =>
    `@js: var t = Date.now(); while (Date.now() - t < ${ms}) {}; '${url}'`

  async function makeJsService(opts: {
    jsTimeoutMs?: number
    ruleTocUrl?: string
    searchUrl?: string
  }): Promise<{ svc: ReadingService; registry: SourceRegistry }> {
    const dir = await makeTempDir('novel-rd-')
    const registry = trackService(await SourceRegistry.load(dir))
    const shelf = trackService(await Shelf.load(dir))
    const jar = new CookieJar()
    const svc = trackService(await ReadingService.from({
      registry,
      shelf,
      cache: new PageCache(dir),
      fetcher: createFetcher({
        cookieJar: jar,
        fetchImpl: (async (input: RequestInfo | URL) => {
          const u = requestUrlOf(input)
          if (u.includes('/s?')) {
            return new Response('<html><body><div class="b"><a href="/book/1/">斗罗</a><span>唐家</span></div></body></html>',
              { headers: { 'content-type': 'text/html; charset=utf-8' } })
          }
          if (u === 'https://js.example.com/toc') {
            return new Response('<html><body><div class="ch"><a href="/c/1.html">第一章</a></div></body></html>',
              { headers: { 'content-type': 'text/html; charset=utf-8' } })
          }
          if (u === 'https://js.example.com/book/1') {
            return new Response('<html><body>详情页</body></html>',
              { headers: { 'content-type': 'text/html; charset=utf-8' } })
          }
          return new Response('', { status: 404 })
        }),
      }),
      cookieJar: jar,
      ...(opts.jsTimeoutMs === undefined ? {} : { jsTimeoutMs: opts.jsTimeoutMs }),
    }))
    await svc.importOne({
      bookSourceName: 'JS源', bookSourceUrl: 'https://js.example.com',
      searchUrl: opts.searchUrl ?? 'https://js.example.com/s?q={{key}}',
      ruleBookList: '@css:.b', ruleBookName: 'tag.a@text', ruleAuthor: 'tag.span@text', ruleBookUrl: 'tag.a@href',
      ...(opts.ruleTocUrl === undefined ? {} : { ruleTocUrl: opts.ruleTocUrl }),
      ruleChapterList: '@css:.ch', ruleChapterName: 'tag.a@text', ruleChapterUrl: 'tag.a@href',
      ruleContent: '@css:#content@textNodes',
    })
    return { svc, registry }
  }

  it('小预算（jsTimeoutMs:300）下 >300ms 的目录脚本 → JsSandboxError 点名「脚本超时（>300ms）」', async () => {
    const { svc, registry } = await makeJsService({
      jsTimeoutMs: 300,
      ruleTocUrl: slowJs(800, 'https://js.example.com/toc'),
    })
    const src = must(registry.list().find((s) => s.name === 'JS源'), 'registry.list() 里 find 命中的那一项')
    await expect(svc.getToc(src.id, 'https://js.example.com/book/1'))
      .rejects.toThrowError(/脚本超时（>300ms）/)
  })

  it('缺省预算放行多请求长耗时目录脚本（本用例的脚本跑过 2s 仍照常出目录）', async () => {
    const { svc, registry } = await makeJsService({
      ruleTocUrl: slowJs(2400, 'https://js.example.com/toc'),
    })
    const src = must(registry.list().find((s) => s.name === 'JS源'), 'registry.list() 里 find 命中的那一项')
    const toc = await svc.getToc(src.id, 'https://js.example.com/book/1')
    expect(toc.map((c) => c.name)).toEqual(['第一章'])
  }, 20_000)

  it('搜索面同口径：searchUrl @js 脚本吃同一个 jsTimeoutMs 预算', async () => {
    const { svc } = await makeJsService({
      jsTimeoutMs: 300,
      searchUrl: `@js: var t = Date.now(); while (Date.now() - t < 800) {}; 'https://js.example.com/s?q=' + key`,
    })
    const groups = await svc.search('斗罗')
    expect(pick(groups, 0).error?.code).toBe('JsSandboxError')
    expect(pick(groups, 0).error?.message).toMatch(/脚本超时（>300ms）/)
  })

  // 回归钉子：搜索面与探针面同口径——门面 probe 漏传 jsTimeoutMs 会让同一个源在导入期探针与
  // 门面探针拿回两个 verdict。
  it('探针面同口径：门面 probe 的 @js 脚本也吃 jsTimeoutMs（漏传即落回引擎 2s）', async () => {
    const { svc, registry } = await makeJsService({
      jsTimeoutMs: 300,
      searchUrl: `@js: var t = Date.now(); while (Date.now() - t < 800) {}; 'https://js.example.com/s?q=' + key`,
    })
    const src = must(registry.list().find((s) => s.name === 'JS源'), 'registry.list() 里 find 命中的那一项')
    const r = await svc.probe(src.id)
    expect(r.ok).toBe(false)
    expect(r.error?.code).toBe('JsSandboxError')
    expect(r.error?.message).toMatch(/脚本超时（>300ms）/)
  })
})

describe('同步导入走 intake 入库规则（同步口与任务口共用同一去重主人，同址不重复入库）', () => {
  // 组合根 seam：测试自持 registry 部件（setStatus 播种是测试关注点，不为它开门面洞）
  const mk = async (): Promise<{ svc: ReadingService; registry: SourceRegistry }> => {
    const dir = await makeTempDir('novel-rd-')
    const registry = await SourceRegistry.load(dir)
    const jar = new CookieJar()
    const svc = trackService(await ReadingService.from({
      registry,
      shelf: await Shelf.load(dir),
      cache: new PageCache(dir),
      fetcher: createFetcher({ fetchImpl: route(() => null), cookieJar: jar }),
      cookieJar: jar,
    }))
    return { svc, registry }
  }

  it('importOne 同址二次导入（已有 verified）：dupSkipped=true，库不增，sourceId=已有可用条目', async () => {
    const { svc, registry } = await mk()
    const first = await svc.importOne(rawSource)
    await registry.edit((tx) => tx.setStatus(must(first.sourceId, 'first 的 sourceId'), 'verified', undefined, 1))
    const second = await svc.importOne({ ...rawSource, bookSourceName: 'S 改名重导' })
    expect(second).toMatchObject({ ok: true, dupSkipped: true, sourceId: first.sourceId })
    expect(registry.list()).toHaveLength(1)
    expect(pick(registry.list(), 0).name).toBe('S')             // 已有可用者优先保留（入库规则）
  })

  it('同址已有 unverified → replaced（复用 id）——与任务路径同口径', async () => {
    const { svc, registry } = await mk()
    const first = await svc.importOne(rawSource)
    const second = await svc.importOne({ ...rawSource, bookSourceName: 'S2', bookSourceUrl: `${BASE}/` })
    expect(second.ok).toBe(true)
    expect(registry.list()).toHaveLength(1)
    expect(pick(registry.list(), 0)).toMatchObject({ id: first.sourceId, name: 'S2' })
  })

  it('importSource 数组批内同址 → 留首条，后者 dupSkipped（批=一个 intake 实例）', async () => {
    const { svc, registry } = await mk()
    const out = await svc.importSource([
      rawSource,
      { ...rawSource, bookSourceName: 'S 重复' },
    ])
    expect(out.map((o) => o.ok)).toEqual([true, true])
    expect(pick(out, 1).dupSkipped).toBe(true)
    expect(registry.list()).toHaveLength(1)
    expect(pick(registry.list(), 0).name).toBe('S')
  })
})

describe('求值上下文组装单点（runLogin/tocUrl 共用这一份上下文，jsLib 不得缺席）', () => {
  // 登录用例走公开动词 login()（runLogin 是门内私有）；cookie 落盘经 registry 组合根 seam 佐证
  const mk = async (): Promise<{ svc: ReadingService; registry: SourceRegistry }> => {
    const { svc, registry } = await makeService(() => null)
    return { svc, registry }
  }

  it('runLogin：@js 登录上下文带 jsLib（另拼一份手拼上下文会在登录那一刻炸 not defined）', async () => {
    const { svc, registry } = await mk()
    const out = await svc.importOne({
      ...rawSource, bookSourceUrl: 'https://login.com',
      loginUrl: 'return buildCookie()',   // runLogin 统一加 @js: 前缀;evaluate 路径是函数体形态,完成值需显式 return
      jsLib: 'function buildCookie() { return "sid=abc; uid=7" }',
    })
    expect(await svc.login(must(out.sourceId, 'out 的 sourceId'))).toEqual({ kind: 'authed' })   // 门面出口是 outcome，不是登录态对象
    expect(registry.get(must(out.sourceId, 'out 的 sourceId'))?.auth?.cookies).toEqual({ sid: 'abc', uid: '7' })
  })

  it('runLogin 认 <js>…</js> 登录脚本（两形态直接识别，不做前缀套嵌）', async () => {
    const { svc, registry } = await mk()
    const out = await svc.importOne({
      ...rawSource, bookSourceUrl: 'https://login-js-tag.com',
      loginUrl: '<js>return "sid=tag"</js>',
    })
    expect(await svc.login(must(out.sourceId, 'out 的 sourceId'))).toEqual({ kind: 'authed' })
    expect(registry.get(must(out.sourceId, 'out 的 sourceId'))?.auth?.cookies).toEqual({ sid: 'tag' })
  })

  it('runLogin 写 cookie 时保留已保存的 loginInfo / headers', async () => {
    const { svc, registry } = await mk()
    const out = await svc.importOne({
      ...rawSource, bookSourceUrl: 'https://login-keep.com',
      loginUrl: 'return "sid=abc"',
    })
    await svc.saveAuth(must(out.sourceId, 'out 的 sourceId'), {}, { 'X-Auth': '1' }, { user: 'alice' })
    expect(await svc.login(must(out.sourceId, 'out 的 sourceId'))).toEqual({ kind: 'authed' })
    const auth = registry.get(must(out.sourceId, 'out 的 sourceId'))?.auth
    expect(auth?.cookies).toEqual({ sid: 'abc' })
    expect(auth?.headers).toEqual({ 'X-Auth': '1' })
    expect(auth?.loginInfo).toEqual({ user: 'alice' })
  })

  it('runLogin 空产出 → null 且不写登录态（不伪造 hasAuth）', async () => {
    const { svc, registry } = await mk()
    const out = await svc.importOne({
      ...rawSource, bookSourceUrl: 'https://login-empty.com',
      loginUrl: 'return ""',
    })
    expect(await svc.login(must(out.sourceId, 'out 的 sourceId'))).toEqual({ kind: 'empty-output' })   // 空产出如实给 kind；翻 422 的翻译在 authRoute
    expect(registry.get(must(out.sourceId, 'out 的 sourceId'))?.auth).toBeUndefined()
    expect(svc.listPublicSources().find((s) => s.id === must(out.sourceId, 'out 的 sourceId'))?.hasAuth).toBe(false)
  })

  it('runLoginAction：外链回传；JS 动作以 loginInfo 为 result 执行', async () => {
    const { svc } = await mk()
    const out = await svc.importOne({
      ...rawSource, bookSourceUrl: 'https://login-action.com',
      loginUi: JSON.stringify([
        { name: '打开', type: 'button', action: 'https://login.example/x' },
        { name: '执行', type: 'button', action: 'throw new Error("user=" + result.get("user"))' },
      ]),
    })
    expect(await svc.runLoginAction(must(out.sourceId, 'out 的 sourceId'), '打开')).toEqual({ mode: 'external', url: 'https://login.example/x' })
    await svc.saveLoginInfo(must(out.sourceId, 'out 的 sourceId'), { user: 'alice' })
    await expect(svc.runLoginAction(must(out.sourceId, 'out 的 sourceId'), '执行')).rejects.toThrow('user=alice')
  })

  it('tocUrl 规则求值同走完整上下文（jsLib 可见；裸上下文连 source/fetch 都拿不到）', async () => {
    const svc = trackService(await ReadingService.create({
      dir: await makeTempDir('novel-rd-'),
      fetchImpl: route((u) => (u.includes('/book/1/') ? '<html><body><h1>详情</h1></body></html>' : null)),
    }))
    const out = await svc.importOne({
      ...rawSource, bookSourceUrl: 'https://tocjs.com',
      ruleTocUrl: '@js: return libToc()',
      jsLib: 'function libToc() { return "https://toc.example.com/list" }',
    })
    const detail = await svc.getDetail(must(out.sourceId, 'out 的 sourceId'), 'https://tocjs.com/book/1/')
    expect(detail.tocUrl).toBe('https://toc.example.com/list')
  })
})

describe('login(id) outcome（门内串 requireSource→形态判别→执行；authRoute 只翻译）', () => {
  const mk = async (): Promise<{ svc: ReadingService; registry: SourceRegistry }> => makeService(() => null)

  it('login js 形态产出 cookie → {kind:"authed"} 且 auth 落盘', async () => {
    const { svc, registry } = await mk()
    const out = await svc.importOne({
      ...rawSource, bookSourceUrl: 'https://login-a.com', loginUrl: 'return "sid=abc; uid=7"',
    })
    expect(await svc.login(must(out.sourceId, 'out 的 sourceId'))).toEqual({ kind: 'authed' })
    const auth = registry.get(must(out.sourceId, 'out 的 sourceId'))?.auth
    expect(auth?.cookies).toEqual({ sid: 'abc', uid: '7' })
    expect(auth?.acquiredAt).toBeTypeOf('number')
  })

  it('login js 形态空产出 → {kind:"empty-output"} 且不写登录态', async () => {
    const { svc, registry } = await mk()
    const out = await svc.importOne({
      ...rawSource, bookSourceUrl: 'https://login-b.com', loginUrl: 'return ""',
    })
    expect(await svc.login(must(out.sourceId, 'out 的 sourceId'))).toEqual({ kind: 'empty-output' })
    expect(registry.get(must(out.sourceId, 'out 的 sourceId'))?.auth).toBeUndefined()
  })

  it('login 未声明 loginUrl → {kind:"no-login-url"}（路由翻 400，不是 500）', async () => {
    const { svc } = await mk()
    const out = await svc.importOne({ ...rawSource, bookSourceUrl: 'https://login-c.com' })
    expect(await svc.login(must(out.sourceId, 'out 的 sourceId'))).toEqual({ kind: 'no-login-url' })
  })

  it('login 未知 id → 抛 SourceNotFoundError（存在性判据在门内 requireSource，路由只 classify，404 由错误类型直接拿到）', async () => {
    const { svc } = await mk()
    await expect(svc.login('nope')).rejects.toBeInstanceOf(SourceNotFoundError)
  })

  it('login manual 形态 → {kind:"manual", loginUrl} 且不执行沙箱（URL 形态进沙箱必炸或落空产出——两种都到不了 manual）', async () => {
    const { svc, registry } = await mk()
    const out = await svc.importOne({
      ...rawSource, bookSourceUrl: 'https://login-d.com', loginUrl: 'https://login.com/x',
    })
    expect(await svc.login(must(out.sourceId, 'out 的 sourceId'))).toEqual({ kind: 'manual', loginUrl: 'https://login.com/x' })
    expect(registry.get(must(out.sourceId, 'out 的 sourceId'))?.auth).toBeUndefined()   // 不执行也不写登录态
    expect(svc.listPublicSources().find((s) => s.id === must(out.sourceId, 'out 的 sourceId'))?.hasAuth).toBe(false)
  })
})

describe('exportRange outcome（区间判据归门面：缺省、裁剪与两条失败结局都是值）', () => {
  // 5 章目录：倒置用例必须选一个**裁剪后仍倒置**的区间（from=4 / to=2），否则测到的是裁剪不是倒置
  const TOC5_HTML = `<html><body>${[1, 2, 3, 4, 5]
    .map((n) => `<div class="b ch"><a href="/c/${n}.html">第${n}章</a></div>`)
    .join('')}</body></html>`
  const BOOK = `${BASE}/book/1/`
  const signal = (): AbortSignal => new AbortController().signal
  const serviceOf = async (tocHtml: string) => makeService((u) => {
    if (u.includes('/book/1/')) return tocHtml
    const m = /\/c\/(\d+)\.html$/.exec(u)
    if (m !== null) return `<html><body><div id="content">第${m[1]}章正文</div></body></html>`
    return u.includes('/search') ? SEARCH_HTML('x') : null
  })

  it('正常范围 → plan：from/to/totalInRange 保形，流与 exportBook 同形（BOM 开头 + 《书名》· 章名）', async () => {
    const { svc, registry } = await serviceOf(TOC5_HTML)
    const out = await svc.exportRange(pick(registry.list(), 0).id, BOOK, 2, 4, { title: '测试书', delayMs: 1, signal: signal() })
    if (out.kind !== 'plan') throw new Error(`期望 plan，收到 ${out.kind}`)
    expect([out.plan.from, out.plan.to, out.plan.totalInRange]).toEqual([2, 4, 3])
    const chunks: string[] = []
    for await (const chunk of out.plan.stream) chunks.push(chunk)
    expect(chunks[0]).toBe('\uFEFF')                       // BOM 是首包：导出文件在常见桌面文本编辑器里不被当乱码
    const text = chunks.join('')
    expect(text.match(/《测试书》· 第\d章/g)).toHaveLength(3)
    expect(text).toContain('《测试书》· 第2章\n\n第2章正文')
    expect(text).not.toContain('《测试书》· 第1章')
    expect(text).not.toContain('《测试书》· 第5章')
  })

  it('空目录 → {kind:"empty-toc"}（路由翻 422 EmptyToc）', async () => {
    const { svc, registry } = await serviceOf('<html><body><p>无章节</p></body></html>')
    expect(await svc.exportRange(pick(registry.list(), 0).id, BOOK, null, null, { title: 't', delayMs: 1, signal: signal() }))
      .toEqual({ kind: 'empty-toc' })
  })

  it('裁剪后倒置 → {kind:"bad-range", from, to}（交回裁剪后的数，路由拿去做 422 文案）', async () => {
    const { svc, registry } = await serviceOf(TOC5_HTML)
    expect(await svc.exportRange(pick(registry.list(), 0).id, BOOK, 4, 2, { title: 't', delayMs: 1, signal: signal() }))
      .toEqual({ kind: 'bad-range', from: 4, to: 2 })
    // 9 越界裁到 5 后仍倒置：结局必须带裁剪后的数——4/2 那次裁剪是恒等，抓不到把原始数交回调用的回归
    expect(await svc.exportRange(pick(registry.list(), 0).id, BOOK, 9, 2, { title: 't', delayMs: 1, signal: signal() }))
      .toEqual({ kind: 'bad-range', from: 5, to: 2 })
  })

  it('越界与缺席都裁进 [1, 目录长]：from=-5&to=99 → 1..5；两端缺席 → 全本', async () => {
    const { svc, registry } = await serviceOf(TOC5_HTML)
    const id = pick(registry.list(), 0).id
    const clipped = await svc.exportRange(id, BOOK, -5, 99, { title: 't', delayMs: 1, signal: signal() })
    if (clipped.kind !== 'plan') throw new Error(`期望 plan，收到 ${clipped.kind}`)
    expect([clipped.plan.from, clipped.plan.to, clipped.plan.totalInRange]).toEqual([1, 5, 5])
    const whole = await svc.exportRange(id, BOOK, null, null, { title: 't', delayMs: 1, signal: signal() })
    if (whole.kind !== 'plan') throw new Error(`期望 plan，收到 ${whole.kind}`)
    expect([whole.plan.from, whole.plan.to, whole.plan.totalInRange]).toEqual([1, 5, 5])
  })
})

describe('门面 probe 与搜索同耐心', () => {
  it('probe 认 searchTimeoutMs：挂起抓取在限时内回 FetchError，不落回 fetcher 固定 15s', async () => {
    const svc = trackService(await ReadingService.create({
      dir: await makeTempDir('novel-rd-'),
      searchTimeoutMs: 50,
      fetchImpl: (() => new Promise<Response>(() => { /* 永不返回 */ })),
    }))
    const out = await svc.importOne({ ...rawSource })
    const t0 = Date.now()
    const r = await svc.probe(must(out.sourceId, 'out 的 sourceId'))
    expect(Date.now() - t0).toBeLessThan(1500)
    expect(r.ok).toBe(false)
    expect(r.error?.code).toBe('FetchError')
  })
})

describe('门面直测（invariant 与 loginPlan 在门面上直接可测，不必穿 HTTP）', () => {
  const mk = async (): Promise<ReadingService> => trackService(await ReadingService.create({
    dir: await makeTempDir('novel-rd-'),
    fetchImpl: route(() => null),
  }))

  it('login() 三分支（URL / JS / 未声明）→ manual / authed / no-login-url；不存在 → SourceNotFoundError', async () => {
    const svc = await mk()
    const manual = await svc.importOne({ ...rawSource, bookSourceUrl: 'https://m.com', loginUrl: 'https://login.com/x' })
    const js = await svc.importOne({ ...rawSource, bookSourceUrl: 'https://j.com', loginUrl: 'return "a=1"' })
    const none = await svc.importOne({ ...rawSource, bookSourceUrl: 'https://n.com' })
    // loginPlan 是门内判别构件（三分支语义不变）；门面出口经 login() 给出 outcome——
    // 未声明登录 URL 即 kind:"no-login-url"（400 的翻译在 authRoute），SourceNotFoundError 原样穿门
    expect(await svc.login(must(manual.sourceId, 'manual 的 sourceId'))).toEqual({ kind: 'manual', loginUrl: 'https://login.com/x' })
    expect(await svc.login(must(js.sourceId, 'js 的 sourceId'))).toEqual({ kind: 'authed' })
    expect(await svc.login(must(none.sourceId, 'none 的 sourceId'))).toEqual({ kind: 'no-login-url' })
    await expect(svc.login('nope')).rejects.toThrow(/源不存在/)
  })

  it('localImport 自动上架 + removeBook 防孤儿文件（两 invariant 门面直测）', async () => {
    const svc = await mk()
    const book = await svc.localImport(Buffer.from('第1章 A\n内容', 'utf8'), 'x.txt')
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

  it('removeBooks：批量删书沿用「本地书连带删副本」invariant，未知键静默跳过', async () => {
    const svc = await mk()
    const local = await svc.localImport(Buffer.from('第1章 A\n内容', 'utf8'), 'x.txt')
    svc.shelfAdd('k1', { sourceId: 's', title: 'T1' })
    svc.shelfAdd('k2', { sourceId: 's', title: 'T2' })
    expect(await svc.removeBooks(['k1', 'k2', local.bookKey, 'nope'])).toEqual({ removed: 3 })
    expect(svc.shelfList()).toHaveLength(0)
    // 防孤儿：本地副本随条目一起清掉——再删一次本地书 id 返回 removed:false（文件已不在）
    expect((await svc.removeLocalBook(local.bookKey)).removed).toBe(false)
  })

  it('shelfList 按最近阅读排序：刚存过进度的书排到最前', async () => {
    const svc = await mk()
    const clock = vi.spyOn(Date, 'now')
    try {
      clock.mockReturnValue(100); svc.shelfAdd('a', { sourceId: 's', title: 'A' })
      clock.mockReturnValue(200); svc.shelfAdd('b', { sourceId: 's', title: 'B' })
      clock.mockReturnValue(300); svc.shelfAdd('c', { sourceId: 's', title: 'C' })
      clock.mockReturnValue(400); svc.shelfSaveProgress('b', 1, 0)
      expect(svc.shelfList().map((b) => b.bookKey)).toEqual(['b', 'c', 'a'])
    } finally {
      clock.mockRestore()
    }
  })

  it('shelfList 来源投影：源名实时 join——源删了投影跟着变 null，本地书恒 null', async () => {
    const svc = await mk()
    const src = await svc.importOne(rawSource)                       // bookSourceName: 'S'
    svc.shelfAdd('k1', { sourceId: must(src.sourceId, 'src 的 sourceId'), title: 'T' })
    svc.shelfAdd('k2', { sourceId: 'no-such-source', title: 'U' })   // 已被删的源
    const local = await svc.localImport(Buffer.from('第1章 A\n内容', 'utf8'), 'x.txt')
    const nameOf = (k: string): string | null | undefined => svc.shelfList().find((b) => b.bookKey === k)?.sourceName
    expect(nameOf('k1')).toBe('S')
    expect(nameOf('k2')).toBeNull()
    expect(nameOf(local.bookKey)).toBeNull()
    // 实时 join 不是快照：源一删，同一本书读面投影即刻变 null
    await svc.removeSource(must(src.sourceId, 'src 的 sourceId'))
    expect(nameOf('k1')).toBeNull()
  })
})

describe('本地 EPUB 门面：导入回执、图文读取、导航与资源', () => {
  const mk = async (): Promise<{ svc: ReadingService; dir: string }> => {
    const dir = await makeTempDir('novel-rde-')
    return { svc: trackService(await ReadingService.create({ dir, fetchImpl: route(() => null) })), dir }
  }

  it('XHTML 命名实体按内建表解码：&nbsp; 不再让整本导入失败', async () => {
    const { svc } = await mk()
    const book = await svc.localImport(makeEpubFixture('epub-html-entities'), '实体.epub')
    expect(book.chapterCount).toBe(2)
    const text = await svc.getChapter('__local__', book.bookKey, 1)
    expect(text).toContain('甲 乙…©')
    expect(text).not.toContain('&nbsp;')
  })

  it('图文读取与现有文字读取共用内容', async () => {
    const { svc } = await mk()
    const book = await svc.localImport(makeEpubFixture('epub3-rich'), '样本.epub')
    const content = await svc.getChapterContent('__local__', book.bookKey, 0)
    expect(content.kind).toBe('rich')
    expect(await svc.getChapter('__local__', book.bookKey, 0))
      .toBe(chapterContentToText(content))
    // 文字面不泄露存储身份：投影里没有 local:<uuid>、没有资源 ID、没有磁盘路径
    const text = await svc.getChapter('__local__', book.bookKey, 0)
    expect(text).not.toContain('local:')
    expect(text).not.toContain('r0')
  })

  it('导入回执是 LocalImportResponse：书目字段走既有 SHELF_META，encoding 不伪称整本', async () => {
    const { svc } = await mk()
    const book = await svc.localImport(makeEpubFixture('epub3-rich'), '样本.epub')
    expect(book).toMatchObject({
      sourceId: '__local__', title: '图文样本', author: '样本作者',
      totalChapters: 2, chapterCount: 2, format: 'epub', encoding: null, warnings: [],
    })
    expect(book.coverUrl).toBe(`/novel-api/local/resource?id=${encodeURIComponent(book.bookKey)}&resourceId=r0`)
    // 入架那条与回执同源（同一份书目字段），不是两套元数据
    expect(svc.shelfList().find((b) => b.bookKey === book.bookKey)).toMatchObject({ author: '样本作者', totalChapters: 2 })
  })

  it('TXT 回执：encoding 如实回显，总章数由 chapterCount 投影进书架', async () => {
    const { svc } = await mk()
    const book = await svc.localImport(Buffer.from('第1章 A\n内容', 'utf8'), 'x.txt')
    expect(book).toMatchObject({ format: 'txt', encoding: 'utf-8', chapterCount: 1, totalChapters: 1, warnings: [] })
    expect(svc.shelfList().find((b) => b.bookKey === book.bookKey)?.totalChapters).toBe(1)
  })

  it('既有条目缺 totalChapters：启动时按本地 meta 补一次，已有值与失效副本都不动', async () => {
    const dir = await makeTempDir('novel-backfill-')
    const local = await LocalBooks.create(dir)
    const old = await local.import(Buffer.from('第1章 A\n内容\n第2章 B\n尾', 'utf8'), 'old.txt')
    const fresh = await local.import(Buffer.from('第1章 C\n内容', 'utf8'), 'fresh.txt')
    const row = (bookKey: string, title: string, totalChapters?: number): Record<string, unknown> => ({
      sourceId: LOCAL_SOURCE_ID, bookKey, title,
      ...(totalChapters === undefined ? {} : { totalChapters }),
      progress: { chapterIndex: 0, offsetRatio: 0, updatedAt: 1 }, addedAt: 1,
    })
    // 旧版本的落盘形态：缺字段的旧条目要补；已补过的不许覆盖；副本已删的补不了就跳过
    await fsPromises.writeFile(path.join(dir, 'shelf.json'), JSON.stringify([
      row(old.bookKey, old.title),
      row(fresh.bookKey, fresh.title, 99),
      row('local:gone', '副本已删'),
    ]))
    const svc = trackService(await ReadingService.create({ dir, fetchImpl: route(() => null) }))
    const books = svc.shelfList()
    expect(books.find((b) => b.bookKey === old.bookKey)?.totalChapters).toBe(2)
    expect(books.find((b) => b.bookKey === fresh.bookKey)?.totalChapters).toBe(99)
    expect(books.find((b) => b.bookKey === 'local:gone')?.totalChapters).toBeUndefined()
    // 补数要落到 shelf.json：界面读的是落盘那份，只改内存等于下次启动再补一遍
    await svc.flush()
    const persisted = JSON.parse(await fsPromises.readFile(path.join(dir, 'shelf.json'), 'utf8')) as Array<{
      bookKey: string
      totalChapters?: number
    }>
    expect(persisted.find((b) => b.bookKey === old.bookKey)?.totalChapters).toBe(2)
    expect(persisted.find((b) => b.bookKey === 'local:gone')?.totalChapters).toBeUndefined()
  })

  it('getNavigation：EPUB 给原生目录树；TXT 由线性序列派生平面导航（toc 旧响应不动）', async () => {
    const { svc } = await mk()
    const epub = await svc.localImport(makeEpubFixture('epub3-rich'), '样本.epub')
    const nav = await svc.getNavigation('__local__', epub.bookKey)
    expect(nav.chapters.map((c) => c.name)).toEqual(['第一章', '第二章'])
    expect(nav.items.map((i) => i.label)).toEqual(['第一卷'])
    expect(await svc.getToc('__local__', epub.bookKey)).toEqual(nav.chapters)   // toc 仍是线性列表

    const txt = await svc.localImport(Buffer.from('第1章 A\n内容\n第2章 B\n尾', 'utf8'), 'y.txt')
    expect(await svc.getNavigation('__local__', txt.bookKey)).toEqual({
      chapters: [{ name: '第1章 A', url: `${txt.bookKey}#0` }, { name: '第2章 B', url: `${txt.bookKey}#1` }],
      items: [
        { id: 't0', label: '第1章 A', target: { kind: 'chapter', index: 0, anchorId: null }, children: [] },
        { id: 't1', label: '第2章 B', target: { kind: 'chapter', index: 1, anchorId: null }, children: [] },
      ],
    })
  })

  it('getLocalSupplement / getLocalResource / getLocalImportWarnings：补充文档、验证过的 MIME 与流、告警', async () => {
    const { svc } = await mk()
    const book = await svc.localImport(makeEpubFixture('epub3-rich'), '样本.epub')
    expect(chapterContentToText(await svc.getLocalSupplement(book.bookKey, 'd2'))).toContain('脚注一')
    const res = await svc.getLocalResource(book.bookKey, 'r0')
    expect(res.mediaType).toBe('image/png')
    expect(res.bytes).toBe(IMAGE_SAMPLES.png.length)
    expect((await streamToBuffer(res.stream)).equals(IMAGE_SAMPLES.png)).toBe(true)
    expect(await svc.getLocalImportWarnings(book.bookKey)).toEqual([])
    await expect(svc.getLocalResource(book.bookKey, 'nope')).rejects.toBeInstanceOf(LocalArtifactNotFoundError)
  })

  it('removeBook / removeBooks：EPUB 整棵目录（documents+resources+原文）随书架条目一起走', async () => {
    const { svc, dir } = await mk()
    const a = await svc.localImport(makeEpubFixture('epub3-rich'), 'a.epub')
    const b = await svc.localImport(makeEpubFixture('epub2-basic'), 'b.epub')
    expect(await svc.removeBook(a.bookKey)).toEqual({ removed: true })
    expect((await fsPromises.readdir(path.join(dir, 'local'))).sort())
      .toEqual([b.bookKey.slice(6), `${b.bookKey.slice(6)}.json`])
    expect(await svc.removeBooks([b.bookKey, 'nope'])).toEqual({ removed: 1 })
    expect(await fsPromises.readdir(path.join(dir, 'local'))).toEqual([])
  })

  it('本地副本删失败：架位保留可重试（单删与批删共用「先副本、后架位」这一条顺序）', async () => {
    const { svc } = await mk()
    const a = await svc.localImport(makeEpubFixture('epub3-rich'), 'a.epub')
    const b = await svc.localImport(makeEpubFixture('epub2-basic'), 'b.epub')
    const realRm = fsPromises.rm
    // 只拦「本地书目录」那一次 rm：`.json` / `.txt` / staging 与 shelf.json 的落盘都不匹配这条形状
    const spy = vi.spyOn(fsPromises, 'rm').mockImplementation(async (p, o) => {
      if (/[\\/]local[\\/][0-9a-f-]{36}$/.test(String(p))) throw new Error('模拟副本删失败')
      return realRm(p, o)
    })
    try {
      // 反过来（先移架位再删副本）就是没有架位的磁盘孤儿：这里三条入口都必须把架位留住
      await expect(svc.removeBook(a.bookKey)).rejects.toThrow(/副本删失败/)
      expect(svc.shelfList().some((x) => x.bookKey === a.bookKey)).toBe(true)
      await expect(svc.removeBooks([b.bookKey])).rejects.toThrow(/副本删失败/)
      expect(svc.shelfList().some((x) => x.bookKey === b.bookKey)).toBe(true)
      await expect(svc.removeLocalBook(a.bookKey)).rejects.toThrow(/副本删失败/)
      expect(svc.shelfList().some((x) => x.bookKey === a.bookKey)).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })

  it('提交标记写失败：本次 UUID 落盘物回收、不造书架条目、既有书照读', async () => {
    const { svc, dir } = await mk()
    const keep = await svc.localImport(Buffer.from('第1章 A\n内容', 'utf8'), '既有.txt')
    const shelfBefore = svc.shelfList().length
    const realRename = fsPromises.rename
    // 只拦「EPUB 顶层元数据」那一次 rename（shelf.json 与 staging→最终目录都不匹配这条形状）
    const spy = vi.spyOn(fsPromises, 'rename').mockImplementation(async (from, to) => {
      if (/[\\/]local[\\/][0-9a-f-]{36}\.json$/.test(String(to))) throw new Error('模拟提交标记写失败')
      return realRename(from, to)
    })
    try {
      await expect(svc.localImport(makeEpubFixture('epub3-rich'), '样本.epub')).rejects.toThrow('模拟提交标记写失败')
    } finally {
      spy.mockRestore()
    }
    expect(svc.shelfList()).toHaveLength(shelfBefore)
    // 刚发布的目录与元数据（含原子写的临时残留）都回收了：只剩既有那本的 TXT 两件
    const id = keep.bookKey.slice('local:'.length)
    expect((await fsPromises.readdir(path.join(dir, 'local'))).sort()).toEqual([`${id}.json`, `${id}.txt`])
    expect(await svc.getChapter('__local__', keep.bookKey, 0)).toBe('内容')
  })
})

describe('后台搜索任务：增量出口只此一处（不许出现第二个批循环）', () => {
  it('单源完成即可见（快的先出，不等慢的）；一次性读面仍按参搜源序，与任务同集', async () => {
    const dir = await makeTempDir('novel-sp-')
    const registry = trackService(await SourceRegistry.load(dir))
    const shelf = trackService(await Shelf.load(dir))
    let arm = false                                   // 探针也走搜索 URL：只在搜索阶段才拖慢
    let releaseSlow: () => void = () => {}
    const slow = new Promise<void>((r) => { releaseSlow = r })
    const plain = route(() => SEARCH_HTML('斗罗'))
    const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
      const u = requestUrlOf(input)
      if (arm && u.includes('b-late.com')) await slow
      return plain(u)
    }
    const jar = new CookieJar()
    const svc = trackService(await ReadingService.from({
      registry, shelf, cache: new PageCache(dir),
      fetcher: createFetcher({ fetchImpl: fetchImpl, cookieJar: jar }),
      cookieJar: jar,
    }))
    await svc.importOne(rawSource)
    await svc.importOne({ ...rawSource, bookSourceName: 'B', bookSourceUrl: 'https://b-late.com', searchUrl: 'https://b-late.com/search?q={{key}}' })
    const order = registry.list().map((s) => s.name)                 // ['S','B']＝参搜源序
    arm = true
    svc.startSearchJob('斗罗')
    await new Promise((r) => setTimeout(r, 30))
    expect(must(svc.searchJobSnapshot(0), '搜索轮次快照').added.map((g) => g.sourceName)).toEqual(['S'])   // 增量：慢源未回，快源已交付
    releaseSlow()
    await settleSearchJob(svc)
    const snap = must(svc.searchJobSnapshot(0), '搜索轮次快照')
    expect(snap.phase).toBe('done')
    expect(snap.added.map((g) => g.sourceName).sort()).toEqual(order.slice().sort())  // 两条都收齐
    // 一次性读面与后台任务同集（同一份批循环的两个消费方）；返回序 = 参搜源序
    const oneShot = await svc.search('斗罗')
    expect(oneShot.map((g) => g.sourceName)).toEqual(order)
    expect(oneShot.map((g) => g.sourceName).sort()).toEqual(snap.added.map((g) => g.sourceName).sort())
  })

  it('后台任务与一次性 search 收齐同一批源', async () => {
    const { svc } = await makeService((u) => (u.includes('/search') ? SEARCH_HTML('斗罗') : null))
    svc.startSearchJob('斗罗')
    await settleSearchJob(svc)
    const snap = must(svc.searchJobSnapshot(0), '搜索轮次快照')
    expect(snap.phase).toBe('done')
    expect((await svc.search('斗罗')).map((g) => g.sourceName).sort())
      .toEqual(snap.added.map((g) => g.sourceName).sort())
  })
})
