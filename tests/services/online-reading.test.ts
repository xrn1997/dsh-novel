import { describe, expect, it } from 'vitest'
import { promises as fsPromises } from 'node:fs'
import path from 'node:path'
import { OnlineReading } from '../../src/services/online-reading.js'
import { PageCache } from '../../src/services/cache.js'
import { Shelf } from '../../src/services/shelf.js'
import { normalizeSource } from '../../src/services/normalize.js'
import { createSourceEval } from '../../src/services/source-eval.js'
import { ChapterNotFoundError, RuleMissingError, SourceNotFoundError } from '../../src/services/errors.js'
import { makeTempDir } from '../temp-dir.js'
import type { NovelSource } from '../../src/services/types.js'
import type { NormalizedRules } from '../../src/services/types.js'
import type { SourceRequest } from '../../src/services/source-request.js'
import type { Page } from '../../src/services/bridge.js'

/**
 * 在线阅读管线的接缝测试：只拼 `OnlineReading` 需要的五件部件（源查找 / 书架 / 文件缓存 /
 * 源请求 / 源求值），用假 `SourceRequest` 驱动页面，不起 HTTP 门面服务。
 * 门面一侧的委托与书内容读面冒烟住 `tests/services/reading.test.ts` 与 `tests/services/book-content.test.ts`。
 */

const BASE = 'https://s.com'
const BOOK = `${BASE}/book/1/`
const raw = {
  bookSourceName: 'S', bookSourceUrl: BASE,
  searchUrl: `${BASE}/search?q={{key}}`,
  ruleBookList: '@css:.b', ruleBookName: 'tag.a@text', ruleAuthor: 'tag.span@text', ruleBookUrl: 'tag.a@href',
  ruleTocUrl: BOOK, ruleChapterName: 'tag.a@text', ruleChapterUrl: 'tag.a@href',
  ruleContent: '@css:#content@textNodes', nextTocUrl: 'tag.a.tn@href', nextPageUrl: 'tag.a.np@href',
}
const tocHtml = `<html><body><div class="b ch"><a href="/c/1.html">第一章</a></div><a class="tn" href="/toc2.html">下一页</a></body></html>`
const toc2Html = `<html><body><div class="b ch"><a href="/c/3.html">第三章</a></div></body></html>`
const chapterHtml = `<html><body><div id="content">正文一<p></p><p>第二段</p></div><a class="np" href="/c/1p2.html">下页</a></body></html>`
const chapter2Html = `<html><body><div id="content">尾段</div></body></html>`
const CONTENT1_HTML = `<html><body><div id="content">正文一<p></p><p>  第二段  </p><p></p><p></p><p>第三段</p></div><a class="np" href="/c/1p2.html">下页</a></body></html>`
// 正文容器在但零文本（站点整站 302/改版后的典型形态：选择器命中却没有正文）
const EMPTY_CONTENT_HTML = `<html><body><div id="content"></div></body></html>`

type HtmlOf = (url: string) => string | null

function pageOf(url: string, body: string): Page {
  return { url, requestedUrl: url, body }
}

const defaultHtml: HtmlOf = (url) => {
  if (url.endsWith('/toc2.html')) return toc2Html
  if (url.endsWith('/book/1/')) return tocHtml
  if (url.endsWith('/c/1p2.html')) return chapter2Html
  if (url.endsWith('/c/1.html')) return chapterHtml
  return null
}

interface Rig {
  online: OnlineReading
  dir: string
  cache: PageCache
  shelf: Shelf
  fetches: string[]
  source(): NovelSource
  replace(over?: Record<string, unknown>): void
  /** 直接改规范化后的规则（normalizeSource 对缺 ruleContent 的 raw 会整条拒收，缺规则用例走这一口） */
  patchRules(patch: Partial<NormalizedRules>): void
  setHtml(fn: HtmlOf): void
  setBeforeFetch(fn?: (url: string) => Promise<void> | void): void
}

/** 五件部件的最小组合：假 `SourceRequest`（可换页路由 / 可门控）+ 真 `PageCache` / `Shelf`。
 *  `sourceOf` 持一个可替换的源对象（代际用例按同一 id 换规则，与注册表替换同形）。 */
async function makeRig(opts: {
  over?: Record<string, unknown>
  htmlOf?: HtmlOf
  jsTimeoutMs?: number
  tocMaxPages?: number
  contentMaxPages?: number
} = {}): Promise<Rig> {
  const dir = await makeTempDir('online-reading-')
  const shelf = await Shelf.load(dir)
  const cache = new PageCache(dir)
  const toSource = (over?: Record<string, unknown>): NovelSource => ({
    ...normalizeSource({ ...raw, ...over }).source!, id: 'i', status: 'unverified', importedAt: 0,
  })
  let source = toSource(opts.over)
  let htmlOf = opts.htmlOf ?? defaultHtml
  let beforeFetch: ((url: string) => Promise<void> | void) | undefined
  const fetches: string[] = []
  const request: SourceRequest = {
    fetcherFor: () => ({ fetchPage: async () => { throw new Error('no raw fetch') } }),
    fetchText: async (_s, plan) => {
      // 先取页再门控：页内容代表「请求到达站点那一刻」的响应，不随后来的门控/换规则漂移
      const text = htmlOf(plan.url) ?? ''
      fetches.push(plan.url)
      await beforeFetch?.(plan.url)
      return { text, landedUrl: plan.url }
    },
    fetchPage: async (_s, plan) => {
      const body = htmlOf(plan.url) ?? ''
      fetches.push(plan.url)
      await beforeFetch?.(plan.url)
      return pageOf(plan.url, body)
    },
  }
  const online = new OnlineReading({
    sourceOf: (id) => (id === source.id ? source : undefined),
    shelf, cache, request,
    sourceEvalFor: (s) => createSourceEval(request.fetcherFor(s), s, { jsTimeoutMs: opts.jsTimeoutMs ?? 1000 }),
    tocMaxPages: opts.tocMaxPages ?? 10,
    contentMaxPages: opts.contentMaxPages ?? 10,
  })
  return {
    online, dir, cache, shelf, fetches,
    source: () => source,
    replace: (over) => { source = toSource(over) },
    patchRules: (patch) => { source = { ...source, rules: { ...source.rules, ...patch } } },
    setHtml: (fn) => { htmlOf = fn },
    setBeforeFetch: (fn) => { beforeFetch = fn },
  }
}

describe('OnlineReading', () => {
  it('follows the toc next link and caches the result', async () => {
    const rig = await makeRig()
    const toc = await rig.online.toc('i', BOOK)
    expect(toc.map((c) => c.name)).toEqual(['第一章', '第三章'])
    const fetched = rig.fetches.length
    const again = await rig.online.toc('i', BOOK)
    expect(again).toEqual(toc)
    expect(rig.fetches).toHaveLength(fetched) // 缓存命中零网络
  })

  it('concatenates content pages and stops at the chapter boundary', async () => {
    const rig = await makeRig()
    const text = await rig.online.chapterText('i', BOOK, 0)
    expect(text).toBe('正文一\n第二段\n尾段')
  })

  it('rejects a chapter index outside the toc', async () => {
    const rig = await makeRig()
    // 越界是类型化失败：断言错误类与业务原文（消息是中文，不靠类名匹配）
    const err = await rig.online.chapterText('i', BOOK, 99).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ChapterNotFoundError)
    expect((err as Error).message).toBe('目录中没有第 99 章（共 2 章）')
  })

  it('rejects an unknown source through the promise contract', async () => {
    const rig = await makeRig()
    await expect(rig.online.toc('nope', BOOK)).rejects.toBeInstanceOf(SourceNotFoundError)
    await expect(rig.online.chapterText('nope', BOOK, 0)).rejects.toBeInstanceOf(SourceNotFoundError)
  })

  it('tocMaxPages / contentMaxPages come from parts, not from module literals', async () => {
    const tocRig = await makeRig({ tocMaxPages: 1 })
    expect((await tocRig.online.toc('i', BOOK)).map((c) => c.name)).toEqual(['第一章'])
    const contentRig = await makeRig({ contentMaxPages: 1 })
    expect(await contentRig.online.chapterText('i', BOOK, 0)).toBe('正文一\n第二段')
  })

  it('坏目录缓存读作 miss：下一次 toc 重抓并重写，不把整本书钉成 500', async () => {
    const rig = await makeRig()
    await rig.online.toc('i', BOOK)
    const tocDir = path.join(rig.dir, 'cache', 'toc')
    const [file] = await fsPromises.readdir(tocDir)
    await fsPromises.writeFile(path.join(tocDir, file!), '{not json', 'utf8')
    const toc = await rig.online.toc('i', BOOK)
    expect(toc.map((c) => c.name)).toEqual(['第一章', '第三章'])
  })

  it('ruleContent.subContent：拼页之后按末页上下文追加子正文', async () => {
    const rig = await makeRig({
      over: {
        ruleContent: '@css:#content@text',
        ruleContentSubContent: '@css:.sub@text',
        nextPageUrl: 'tag.a.np@href',
      },
      htmlOf: (u) => {
        if (u.includes('/c/1.html')) return '<html><body><div id="content">正文一</div><a class="np" href="/c/1p2.html">下页</a></body></html>'
        if (u.includes('/c/1p2.html')) return '<html><body><div id="content">尾段</div><div class="sub">歌词</div></body></html>'
        return defaultHtml(u)
      },
    })
    expect(await rig.online.chapterText('i', BOOK, 0)).toBe('正文一\n尾段\n歌词')
  })

  it('ruleContent.subContent：http 开头的子正文先取回再追加', async () => {
    const rig = await makeRig({
      over: {
        ruleContent: '@css:#content@text',
        ruleContentSubContent: `@js:"${BASE}/lyric.html"`,
        nextPageUrl: undefined,
      },
      htmlOf: (u) => {
        if (u.includes('/c/1.html')) return '<html><body><div id="content">正文一</div></body></html>'
        if (u.includes('/lyric.html')) return '<html><body><p>歌词</p></body></html>'
        return defaultHtml(u)
      },
    })
    expect(await rig.online.chapterText('i', BOOK, 0)).toBe('正文一\n歌词')
  })

  it('缺目录规则 → RuleMissingError（点名 facet 与规则名）', async () => {
    const rig = await makeRig({
      over: { ruleChapterName: undefined, ruleChapterUrl: undefined, ruleTocUrl: undefined },
      htmlOf: () => null,
    })
    const err = await rig.online.toc('i', BOOK).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RuleMissingError)
    expect((err as RuleMissingError).facet).toBe('toc')
    expect((err as RuleMissingError).rule).toContain('ruleChapterList')
  })

  it('缺正文规则 → RuleMissingError（点名 content）', async () => {
    const rig = await makeRig()
    rig.patchRules({ ruleContent: null })
    const err = await rig.online.chapterText('i', BOOK, 0).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RuleMissingError)
    expect((err as RuleMissingError).facet).toBe('content')
    expect((err as RuleMissingError).rule).toBe('ruleContent')
  })

  it('ruleChapterList 存在时目录用它（搜索列表与目录列表不同选择器）', async () => {
    const rig = await makeRig({ over: { ruleBookList: '@css:.sl', ruleChapterList: '@css:.ch' } })
    const toc = await rig.online.toc('i', BOOK)
    expect(toc.map((c) => c.name)).toEqual(['第一章', '第三章'])
  })

  it('ruleToc 标记落 ChapterEntry（isVip/isVolume/isPay/updateTime；上游 isTrue 口径）', async () => {
    const rig = await makeRig({
      over: {
        ruleChapterIsVip: '@js:result.includes("第一章") ? "1" : "0"',
        ruleChapterIsVolume: '@js:result.includes("第一章") ? "yes" : "no"',
        ruleChapterIsPay: '@js:result.includes("第一章") ? "VIP" : "false"',
        ruleChapterUpdateTime: '@js:"2026-10-20"',
      },
    })
    const toc = await rig.online.toc('i', BOOK)
    expect(toc[0]).toMatchObject({ isVip: true, isVolume: true, isPay: true, updateTime: '2026-10-20' })
    expect(toc[1].isVip).toBeUndefined()
    expect(toc[1].isVolume).toBeUndefined()
    expect(toc[1].isPay).toBeUndefined()
  })

  it('整本取不到章节 URL → 如实抛错，不产出全指目录页的假目录', async () => {
    const noHref = '<html><body><div class="b ch"><a>第一章</a></div><div class="b ch"><a>第二章</a></div></body></html>'
    const rig = await makeRig({ htmlOf: (u) => (u.includes('/book/1/') ? noHref : null) })
    await expect(rig.online.toc('i', BOOK)).rejects.toThrow(/ruleChapterUrl/)
  })

  it('只有个别章取不到 URL → 仍逐章回退目录页（不许把 legado 对齐改回整条丢弃）', async () => {
    const mixed = '<html><body><div class="b ch"><a href="/c/1.html">第一章</a></div><div class="b ch"><a>第二章</a></div></body></html>'
    const rig = await makeRig({ htmlOf: (u) => (u.includes('/book/1/') ? mixed : null) })
    const toc = await rig.online.toc('i', BOOK)
    expect(toc.map((c) => c.name)).toEqual(['第一章', '第二章'])
    expect(toc[0].url).toBe(`${BASE}/c/1.html`)
    expect(toc[1].url).toBe(BOOK) // 缺链接的那章回退目录页地址，不丢条目
  })

  it('@html 正文转纯文本（@html 源收的是 HTML 片段——标签不许打给读者）', async () => {
    const rig = await makeRig({
      over: { ruleContent: '@css:#content@html' },
      htmlOf: (u) => {
        if (u.includes('/c/1.html')) return CONTENT1_HTML
        if (u.includes('/c/1p2.html')) return chapter2Html
        return defaultHtml(u)
      },
    })
    const text = await rig.online.chapterText('i', BOOK, 0)
    expect(text).toBe('正文一\n第二段\n第三段\n尾段') // 块级边界换行；多页 join('\n')
    expect(text).not.toContain('<') // 标签一个都不留
  })

  it('正文零命中 → 段级报错（带落点）且不写缓存——修复前静默写 0 字节缓存，全书空到无感', async () => {
    let serveReal = false
    const rig = await makeRig({
      htmlOf: (u) => {
        if (u.includes('/c/1.html')) return serveReal ? CONTENT1_HTML : EMPTY_CONTENT_HTML
        if (u.includes('/c/1p2.html')) return chapter2Html
        return defaultHtml(u)
      },
    })
    await expect(rig.online.chapterText('i', BOOK, 0)).rejects
      .toThrowError(/正文规则零命中.*ruleContent: @css:#content@textNodes.*落点 https:\/\/s\.com\/c\/1\.html/)
    serveReal = true
    // 零命中没有把空正文写进缓存，也没有污染 —— 站点恢复后立刻抓到真内容
    expect(await rig.online.chapterText('i', BOOK, 0)).toBe('正文一\n第二段\n第三段\n尾段')
  })

  /**
   * 「空正文必炸」的适用面是**首屏**，不是跟进链上的每一页。
   * 真机形状：笔趣阁最后一章的「下一章」链接指向书详情页（那页没有正文容器），跟进落到它——
   * 回归钉子：续页的空态不许抛——一抛就把整章作废，三页正文（前两页有字）全读不出。
   * 对面那侧只在**整章拼完仍为空**才抛
   * ContentEmptyException，续页取不出只是不再追加、跟进自然收手。
   */
  it('续页取不出正文 → 停止跟进并保留首屏，不连坐整章（两种空态同判）', async () => {
    for (const laterPage of [
      EMPTY_CONTENT_HTML,                                                   // 容器在、零文本
      '<html><body><p>改版后的页面，没有正文容器</p></body></html>',           // 容器不在 = Miss
    ]) {
      const rig = await makeRig({
        htmlOf: (u) => {
          if (u.includes('/c/1.html')) return CONTENT1_HTML
          if (u.includes('/c/1p2.html')) return laterPage
          return defaultHtml(u)
        },
      })
      expect(await rig.online.chapterText('i', BOOK, 0)).toBe('正文一\n第二段\n第三段')
    }
  })

  // ── 缓存有效性：代际随规则走、槽位随章名走 ─────────────────────────────

  it('同 id 换规则后默认读取即新目录：代际随规则走，不要求用户手动刷新', async () => {
    const PAGE = '<div class="old"><a href="/c/1.html">旧目录</a></div><div class="new"><a href="/c/2.html">新目录</a></div>'
    const bookKey = `${BASE}/book`
    const rig = await makeRig({
      over: { ruleTocUrl: undefined, ruleBookList: '@css:.old' },
      htmlOf: () => PAGE,
    })
    expect((await rig.online.toc('i', bookKey))[0]?.name).toBe('旧目录')
    rig.replace({ ruleTocUrl: undefined, ruleBookList: '@css:.new' })
    expect((await rig.online.toc('i', bookKey))[0]?.name).toBe('新目录')
  })

  it('同 id 换正文规则后默认读取即新正文：正文代际端到端随 ruleContent 走', async () => {
    // 单页同时充当目录页与正文页：两个可区分容器 .v1 / .v2，让两版 ruleContent 取出不同文本
    const PAGE = '<div class="b ch"><a href="/c/1.html">第一章</a></div><div class="v1">正文旧规则</div><div class="v2">正文新规则</div>'
    const bookKey = `${BASE}/book`
    const rig = await makeRig({
      over: { ruleTocUrl: undefined, ruleContent: '@css:.v1@text' },
      htmlOf: () => PAGE,
    })
    expect(await rig.online.chapterText('i', bookKey, 0)).toContain('正文旧规则')
    // 只改 ruleContent（'content' 影响面）→ 正文代际变 → 槽位变 → 不带 refresh 也读不到旧正文
    rig.replace({ ruleTocUrl: undefined, ruleContent: '@css:.v2@text' })
    expect(await rig.online.chapterText('i', bookKey, 0)).toContain('正文新规则')
  })

  it('目录刷新导致章序变化：按章序的正文缓存不串配（正文键含章名）', async () => {
    let tocRows = '<div class="b ch"><a href="/c/1.html">第一章</a></div><div class="b ch"><a href="/c/2.html">第二章</a></div>'
    const bookKey = `${BASE}/book`
    const rig = await makeRig({
      over: { ruleTocUrl: undefined },
      htmlOf: (url) => {
        if (url.endsWith('/c/1.html')) return '<html><body><div id="content">正文一</div></body></html>'
        if (url.endsWith('/c/2.html')) return '<html><body><div id="content">正文二</div></body></html>'
        return `<html><body>${tocRows}</body></html>`
      },
    })
    expect(await rig.online.chapterText('i', bookKey, 0)).toContain('正文一')
    // 站点把顺序换了（规则没变）：刷新目录后第 0 章已是「第二章」
    tocRows = '<div class="b ch"><a href="/c/2.html">第二章</a></div><div class="b ch"><a href="/c/1.html">第一章</a></div>'
    await rig.online.toc('i', bookKey, { refresh: true })
    expect(await rig.online.chapterText('i', bookKey, 0)).toContain('正文二')
  })

  it('目录并发：refresh 不被先到的非 refresh 并掉', async () => {
    let served = 0
    let calls = 0
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    let firstStarted!: () => void
    const started = new Promise<void>((r) => { firstStarted = r })
    const rig = await makeRig({
      htmlOf: (url) => {
        if (!url.endsWith('/book/1/')) return null
        served += 1
        const name = served === 1 ? '第一章' : '第二章'
        return `<html><body><div class="b"><a href="/c/${served}.html">${name}</a></div></body></html>`
      },
    })
    // 先到的非 refresh 读取要先过缓存读 I/O 才出站，refresh 却直接出站——等它真出站再发 refresh。
    rig.setBeforeFetch(async (url) => {
      if (!url.endsWith('/book/1/')) return
      calls += 1
      if (calls === 1) {
        firstStarted()
        await gate
      }
    })
    const p1 = rig.online.toc('i', BOOK)
    await started
    const p2 = rig.online.toc('i', BOOK, { refresh: true })
    release()
    const [a, b] = await Promise.all([p1, p2])
    expect(calls).toBe(2)
    expect(a[0]?.name).toBe('第一章')
    expect(b[0]?.name).toBe('第二章')
  })

  it('目录并发：换代际后的新读不 join 旧代际的在途（旧读仍按自己的代际交结果）', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    let firstStarted!: () => void
    const started = new Promise<void>((r) => { firstStarted = r })
    const rig = await makeRig({
      htmlOf: (url) => {
        if (url.endsWith('/book/1/')) return '<html><body><div class="b"><a href="/c/old.html">旧代章节</a></div></body></html>'
        if (url.endsWith('/book/2/')) return '<html><body><div class="b"><a href="/c/new.html">新代章节</a></div></body></html>'
        return null
      },
    })
    rig.setBeforeFetch(async (url) => {
      if (!url.endsWith('/book/1/')) return
      firstStarted()
      await gate
    })
    const p1 = rig.online.toc('i', BOOK)
    await started
    // 同 baseUrl 换规则 → 同一 source id（既有裁决）——身份没变，只有代际变
    rig.replace({ ruleTocUrl: `${BASE}/book/2/` })
    const p2 = rig.online.toc('i', BOOK)
    release()
    const [oldRead, newRead] = await Promise.all([p1, p2])
    expect(oldRead[0]?.url).toBe(`${BASE}/c/old.html`)     // 旧在途按起飞代际交自己的结果
    expect(newRead[0]?.url).toBe(`${BASE}/c/new.html`)     // 新读另起一发，不拿旧代际的章节
    expect(rig.fetches.filter((u) => u === `${BASE}/book/1/`)).toHaveLength(1)
    expect(rig.fetches.filter((u) => u === `${BASE}/book/2/`)).toHaveLength(1)
  })

  it('目录并发：同一身份并发只抓一次，两个读拿到同一份章节（在途去重）', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    let firstStarted!: () => void
    const started = new Promise<void>((r) => { firstStarted = r })
    const rig = await makeRig({
      htmlOf: (url) => (url.endsWith('/book/1/')
        ? '<html><body><div class="b"><a href="/c/1.html">第一章</a></div></body></html>'
        : null),
    })
    rig.setBeforeFetch(async (url) => {
      if (!url.endsWith('/book/1/')) return
      firstStarted()
      await gate
    })
    const p1 = rig.online.toc('i', BOOK)
    await started
    const p2 = rig.online.toc('i', BOOK)
    release()
    const [a, b] = await Promise.all([p1, p2])
    expect(rig.fetches.filter((u) => u === `${BASE}/book/1/`), '同一身份并发只该抓一次').toHaveLength(1)
    expect(a).toEqual(b)
    expect(a[0]?.url).toBe(`${BASE}/c/1.html`)
  })

  it('换目录规则而章名一字不变：正文代际仍跟着走，不端旧地址抓来的正文', async () => {
    // 两版目录页各列一条**同名**章节，但地址不同：旧地址 /wrong.html、新地址 /c/1.html。
    // 章名不变 ⇒ 槽位（代际 + 章名）的章名那一半挡不住，只有代际能挡。
    const bookKey = `${BASE}/book`
    const rig = await makeRig({
      over: { ruleTocUrl: undefined },
      htmlOf: (url) => {
        if (url.endsWith('/wrong.html')) return '<div id="content">正文旧地址</div>'
        if (url.endsWith('/c/1.html')) return '<div id="content">正文新地址</div>'
        if (url.endsWith('/toc2')) return '<div class="b ch"><a href="/c/1.html">第一章</a></div>'
        return '<div class="b ch"><a href="/wrong.html">第一章</a></div>'
      },
    })
    expect(await rig.online.chapterText('i', bookKey, 0)).toContain('正文旧地址')
    rig.replace({ ruleTocUrl: `${BASE}/toc2` })
    expect((await rig.online.toc('i', bookKey))[0]?.name).toBe('第一章')   // 章名确实没变
    expect(await rig.online.chapterText('i', bookKey, 0)).toContain('正文新地址')
  })

  // ── tocUrl 与详情上下文 ───────────────────────────────────────────────

  const DETAIL_URL = 'https://qb.example.com/book/1100468914'
  const TOC_URL = 'https://qb.example.com/qbread/api/book/all-chapter?bookId=1100468914'
  const DETAIL_JSON = JSON.stringify({
    ret: 0,
    data: { bookInfo: { resourceID: '1100468914', resourceName: '斗破苍穹', author: '天蚕土豆', summary: '斗气世界简介' } },
  })
  const QQ_OVER = {
    bookSourceName: '正版源', bookSourceUrl: 'https://qb.example.com',
    ruleTocUrl: undefined, ruleChapterList: undefined, ruleChapterName: undefined, ruleChapterUrl: undefined,
    nextTocUrl: undefined,
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
    nextPageUrl: undefined,
  }

  it('tocUrl 模板 {{$.resourceID}} 过引擎按 init 上下文插值：目录请求打到真实 bookId 地址', async () => {
    const rig = await makeRig({
      over: QQ_OVER,
      htmlOf: (url) => {
        if (url === DETAIL_URL) return DETAIL_JSON
        if (url === TOC_URL) return JSON.stringify({ rows: [{ serialID: 1, serialName: '第1章 陨落的天才' }] })
        return null
      },
    })
    const toc = await rig.online.toc('i', DETAIL_URL)
    expect(rig.fetches).toContain(TOC_URL)                  // 插值出真实 bookId，不是字面 {{$.resourceID}}
    expect(toc).toHaveLength(1)
    expect(toc[0]).toMatchObject({ name: '第1章 陨落的天才', url: 'https://qb.example.com/c/1.html' })
  })

  it('纯 @put 的 init 之后目录仍在原详情页上求值（换根会把目录打成空）', async () => {
    const META_URL = 'https://meta.example.com/book/77'
    const META_PAGE = `<html><head>
      <meta property="og:novel:book_name" content="武动乾坤">
    </head><body><div id="all-chapter"><a href="/c/1.html">第1章 蜕变</a></div></body></html>`
    const rig = await makeRig({
      over: {
        ruleTocUrl: undefined, ruleChapterList: undefined, ruleChapterName: undefined, ruleChapterUrl: undefined,
        nextTocUrl: undefined,
        ruleBookInfo: { init: '@put:{n:"[property$=book_name]@content"}' },
        ruleToc: { chapterList: '#all-chapter a', chapterName: 'text', chapterUrl: 'href' },
      },
      htmlOf: (url) => (url === META_URL ? META_PAGE : null),
    })
    const toc = await rig.online.toc('i', META_URL)
    expect(toc).toHaveLength(1)
    expect(toc[0]).toMatchObject({ name: '第1章 蜕变', url: 'https://meta.example.com/c/1.html' })
  })
})
