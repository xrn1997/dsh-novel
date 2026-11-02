import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ReadingService } from '../../src/services/reading.js'
import { queries, ROUTES } from '../../src/shared/wire.js'
import type {
  ApiEnvelope, BookDetail, BookNavigation, ChapterContent, ChapterEntry, SearchGroup, SearchJobSnapshot, ShelfBook, ShelfEntry, SourcePublic,
} from '../../src/shared/wire.js'
import { must, pick } from '../support/fixture.js'
import { makeTempDir, trackService } from '../temp-dir.js'
import { envelopeOf, errorOf, requestUrl, startServer, valueOf } from './helpers.js'

const BASE = 'https://s.com'
const SEARCH_HTML = '<html><body><div class="b"><a href="/book/1/">斗罗</a><span>唐家</span></div></body></html>'
const TOC_HTML = '<html><body><div class="b ch"><a href="/c/1.html">第一章</a></div><div class="b ch"><a href="/c/2.html">第二章</a></div><a class="tn" href="/toc2.html">下一页</a></body></html>'
const TOC2_HTML = '<html><body><div class="b ch"><a href="/c/3.html">第三章</a></div></body></html>'
const CONTENT1_HTML = '<html><body><div id="content">正文一<p></p><p>  第二段  </p><p></p><p></p><p>第三段</p></div><a class="np" href="/c/1p2.html">下页</a></body></html>'
const CONTENT1P2_HTML = '<html><body><div id="content">尾段</div></body></html>'

const rawSource = {
  bookSourceName: 'S', bookSourceUrl: BASE,
  searchUrl: `${BASE}/search?q={{key}}`,
  ruleBookList: '@css:.b', ruleBookName: 'tag.a@text', ruleAuthor: 'tag.span@text', ruleBookUrl: 'tag.a@href',
  ruleTocUrl: `${BASE}/book/1/`,
  ruleChapterName: 'tag.a@text', ruleChapterUrl: 'tag.a@href',
  ruleContent: '@css:#content@textNodes', nextTocUrl: 'tag.a.tn@href', nextPageUrl: 'tag.a.np@href',
}

let svc: ReadingService, base: string, close: () => Promise<void>
let tocFetches = 0
beforeAll(async () => {
  const dir = await makeTempDir('novel-apird-')
  const htmlOf = (u: string): string | null => {
    if (u.includes('/c/1.html')) return CONTENT1_HTML
    if (u.includes('/c/1p2.html')) return CONTENT1P2_HTML
    if (u.includes('/book/1/')) { tocFetches++; return TOC_HTML }
    if (u.includes('/toc2.html')) { tocFetches++; return TOC2_HTML }
    if (u.includes('/search')) return SEARCH_HTML
    return null
  }
  svc = trackService(await ReadingService.create({
    dir,
    fetchImpl: async (input: RequestInfo | URL) => {
      const body = htmlOf(requestUrl(input))
      return body === null
        ? new Response('', { status: 404 })
        : new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } })
    },
  }))
  await svc.importOne(rawSource)
  ;({ base, close } = await startServer(svc))
})
afterAll(async () => { await svc.flush(); await close() })

describe('reading/shelf 面', () => {
  it('GET /search 缺 keyword → 400；正常 → 分组', async () => {
    expect((await fetch(`${base}/novel-api/search?keyword=`)).status).toBe(400)
    const r = await fetch(`${base}/novel-api/search?keyword=${encodeURIComponent('斗罗')}`)
    const groups = await valueOf<SearchGroup[]>(r)
    expect(pick(pick(groups, 0).hits, 0)).toMatchObject({ title: '斗罗', author: '唐家' })
  })
  it('GET /book → BookDetail 字段齐全（Miss 字段 null 不报错）', async () => {
    const src = await valueOf<SourcePublic[]>(await fetch(`${base}/novel-api/sources`))
    const r = await fetch(`${base}/novel-api/book?sourceId=${pick(src, 0).id}&url=${encodeURIComponent(`${BASE}/book/1/`)}`)
    const detail = await valueOf<BookDetail>(r)
    expect(detail).toHaveProperty('intro')
    expect(detail.intro).toBeNull()          // 该源没写 ruleIntro → 如实 null
  })
  it('GET /toc 两页合并；refresh=1 绕缓存', async () => {
    const src = await valueOf<SourcePublic[]>(await fetch(`${base}/novel-api/sources`))
    const u = `${base}/novel-api/toc?sourceId=${pick(src, 0).id}&url=${encodeURIComponent(`${BASE}/book/1/`)}`
    const toc = await valueOf<ChapterEntry[]>(await fetch(u))
    expect(toc.map((c) => c.name)).toEqual(['第一章', '第二章', '第三章'])
    const before = tocFetches
    await fetch(`${u}&refresh=1`)
    expect(tocFetches).toBeGreaterThan(before)
  })
  it('GET /chapter 缺 index → 400；正常 → 显式 {kind:text,text} 图文契约；越界 → 404', async () => {
    const src = await valueOf<SourcePublic[]>(await fetch(`${base}/novel-api/sources`))
    const u = `${base}/novel-api/chapter?sourceId=${pick(src, 0).id}&url=${encodeURIComponent(`${BASE}/book/1/`)}`
    expect((await fetch(u)).status).toBe(400)
    const content = await valueOf<ChapterContent>(await fetch(`${u}&index=0`))
    // 单形态、不做旧/新自动猜测：正文一律是 ChapterContent（在线书恒文字支）
    expect(content).toEqual({ kind: 'text', text: '正文一\n第二段\n第三段\n尾段' })
    expect((await fetch(`${u}&index=99`)).status).toBe(404)
  })
  it('GET /navigation → chapters 线性 + items 平面派生树（在线书没有原生目录）', async () => {
    const src = await valueOf<SourcePublic[]>(await fetch(`${base}/novel-api/sources`))
    const r = await fetch(`${base}/novel-api/navigation?sourceId=${pick(src, 0).id}&url=${encodeURIComponent(`${BASE}/book/1/`)}`)
    const nav = await valueOf<BookNavigation>(r)
    expect(nav.chapters.map((c) => c.name)).toEqual(['第一章', '第二章', '第三章'])
    expect(nav.items.map((i) => [i.label, i.target])).toEqual([
      ['第一章', { kind: 'chapter', index: 0, anchorId: null }],
      ['第二章', { kind: 'chapter', index: 1, anchorId: null }],
      ['第三章', { kind: 'chapter', index: 2, anchorId: null }],
    ])
    expect(nav.items.every((i) => i.children.length === 0 && typeof i.id === 'string')).toBe(true)
  })
  it('shelf 三路由 + key 的 URI 编码往返', async () => {
    const bookKey = 'https://s.com/book/1/?a=1&b=2'
    const put = await fetch(`${base}/novel-api/shelf/${encodeURIComponent(bookKey)}`, {
      method: 'PUT', body: JSON.stringify({ sourceId: 's1', title: '斗罗大陆' }),
    })
    expect(await valueOf<ShelfBook>(put)).toMatchObject({ bookKey, title: '斗罗大陆' })
    const put2 = await fetch(`${base}/novel-api/shelf/${encodeURIComponent(bookKey)}`, {
      method: 'PUT', body: JSON.stringify({ progress: { chapterIndex: 2, offsetRatio: 0.33 } }),
    })
    expect((await valueOf<ShelfBook>(put2)).progress).toMatchObject({ chapterIndex: 2, offsetRatio: 0.33 })
    const list = await valueOf<ShelfEntry[]>(await fetch(`${base}/novel-api/shelf`))
    expect(list).toHaveLength(1)
    const del = await fetch(`${base}/novel-api/shelf/${encodeURIComponent(bookKey)}`, { method: 'DELETE' })
    expect((await valueOf<{ removed: boolean }>(del)).removed).toBe(true)
    expect(await valueOf<ShelfEntry[]>(await fetch(`${base}/novel-api/shelf`))).toHaveLength(0)
  })
  it('shelf PUT 无 title 且无 progress → 400（文案逐字点名三种出路）；书不在架 → 400', async () => {
    const empty = await fetch(`${base}/novel-api/shelf/${encodeURIComponent('k')}`, { method: 'PUT', body: '{}' })
    expect(empty.status).toBe(400)
    const error = await errorOf(empty)
    // 全文等值：这句是用户可见文案（PARAMS/BODY 常量展开后的成品），只钉片段时另两条出路改错字仍全绿
    expect(error.message).toBe('body 需带 title（加书）/ patch（打补丁）/ progress:{chapterIndex,offsetRatio}（更新进度）')
    expect((await fetch(`${base}/novel-api/shelf/${encodeURIComponent('k2')}`, {
      method: 'PUT', body: JSON.stringify({ progress: { chapterIndex: 1, offsetRatio: 0 } }),
    })).status).toBe(400)
  })
  it('shelf PUT 空 body → 400「body 需为 JSON 对象」（非对象 body 的传输闸，文案逐字）', async () => {
    const r = await fetch(`${base}/novel-api/shelf/${encodeURIComponent('k-empty')}`, { method: 'PUT' })
    expect(r.status).toBe(400)
    expect((await errorOf(r)).message).toBe('body 需为 JSON 对象')
  })
  it('title 非空即按加书分派：同场的 patch 不抢（400 来自加书值域门，不是三形态皆无）', async () => {
    const r = await fetch(`${base}/novel-api/shelf/${encodeURIComponent('k-title-wins')}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'T', patch: { kind: '玄幻' } }),
    })
    expect(r.status).toBe(400)
    expect((await errorOf(r)).message).toMatch(/加书需带非空 sourceId/)
  })
  it('加书缺/空 sourceId → 400（此前静默兜底成空串，写入 200、读取才炸）', async () => {
    for (const body of [{ title: 'T' }, { title: 'T', sourceId: '' }, { title: 'T', sourceId: 7 }]) {
      const r = await fetch(`${base}/novel-api/shelf/${encodeURIComponent(`k-${JSON.stringify(body)}`)}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      })
      expect(r.status, JSON.stringify(body)).toBe(400)
    }
  })
  it('progress 值域：Infinity/负数/非整数 → 400（此前写盘成 null）', async () => {
    const key = encodeURIComponent(`${BASE}/book/1/progress-dom`)
    await fetch(`${base}/novel-api/shelf/${key}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourceId: 's1', title: 'T' }),
    })
    // 用原始 JSON 文本：JSON.parse('1e999') === Infinity（JSON.stringify 会把它变成 null，测不到 isFinite）
    for (const p of [
      '{"chapterIndex":1,"offsetRatio":1e999}',
      '{"chapterIndex":-1,"offsetRatio":0}',
      '{"chapterIndex":1.5,"offsetRatio":0}',
      '{"chapterIndex":1,"offsetRatio":1.5}',
    ]) {
      const r = await fetch(`${base}/novel-api/shelf/${key}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: `{"progress":${p}}`,
      })
      expect(r.status, p).toBe(400)
    }
  })
  it('shelf PUT 识别 totalChapters', async () => {
    const src = await valueOf<SourcePublic[]>(await fetch(`${base}/novel-api/sources`))
    await fetch(`${base}/novel-api/shelf/${encodeURIComponent(`${BASE}/book/1/`)}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourceId: pick(src, 0).id, title: '斗罗', totalChapters: 88 }),
    })
    const shelf2 = await valueOf<ShelfEntry[]>(await fetch(`${base}/novel-api/shelf`))
    expect(shelf2.find((b) => b.title === '斗罗')?.totalChapters).toBe(88)
  })
  it('title-only PUT 再加架不抹 totalChapters（spread 不带键才保值）', async () => {
    const src = await valueOf<SourcePublic[]>(await fetch(`${base}/novel-api/sources`))
    const key = encodeURIComponent(`${BASE}/book/1/`)
    await fetch(`${base}/novel-api/shelf/${key}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourceId: pick(src, 0).id, title: '斗罗', totalChapters: 88 }),
    })
    // 二次 PUT 只带 title（ReaderView/卡片分支真实形态）→ 合并语义必须保住已有的 88
    await fetch(`${base}/novel-api/shelf/${key}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourceId: pick(src, 0).id, title: '斗罗' }),
    })
    const shelf3 = await valueOf<ShelfEntry[]>(await fetch(`${base}/novel-api/shelf`))
    expect(shelf3.find((b) => b.title === '斗罗')?.totalChapters).toBe(88)
  })
  it('回写 PUT {sourceId,title,totalChapters} 往返：sourceId+四兄弟元数据全保、totalChapters 更新', async () => {
    // 真实链路：详情页全量 PUT 加架 → ReaderView 首读回写（只带 sourceId/title/totalChapters）
    const src = await valueOf<SourcePublic[]>(await fetch(`${base}/novel-api/sources`))
    const key = encodeURIComponent(`${BASE}/book/1/rt`)
    await fetch(`${base}/novel-api/shelf/${key}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceId: pick(src, 0).id, title: '回写书', author: '作者甲', coverUrl: 'https://s.com/c.jpg',
        intro: '简介文', lastChapterName: '第9章',
      }),
    })
    // 回写体 = ReaderView 修复后的真形态（无 author/coverUrl/intro/lastChapterName 键）
    await fetch(`${base}/novel-api/shelf/${key}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourceId: pick(src, 0).id, title: '回写书', totalChapters: 66 }),
    })
    const shelf = await valueOf<ShelfEntry[]>(await fetch(`${base}/novel-api/shelf`))
    const b = shelf.find((x) => x.bookKey === `${BASE}/book/1/rt`)
    expect(b).toMatchObject({
      sourceId: pick(src, 0).id, author: '作者甲', coverUrl: 'https://s.com/c.jpg',
      intro: '简介文', lastChapterName: '第9章', totalChapters: 66,
    })
  })
  // ── patch 形态：ReaderView 回写只发 totalChapters 一个字段 ──────────────────
  it('PUT {patch:{totalChapters}} 单字段回写：其余元数据全保（bodies.shelfPatch → Shelf.update）', async () => {
    const src = await valueOf<SourcePublic[]>(await fetch(`${base}/novel-api/sources`))
    const key = encodeURIComponent(`${BASE}/book/1/patch`)
    await fetch(`${base}/novel-api/shelf/${key}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourceId: pick(src, 0).id, title: '补丁书', author: '作者乙', intro: '简介乙' }),
    })
    await fetch(`${base}/novel-api/shelf/${key}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ patch: { totalChapters: 99 } }),      // ReaderView 真形态：一个字段
    })
    const shelf = await valueOf<ShelfEntry[]>(await fetch(`${base}/novel-api/shelf`))
    expect(shelf.find((x) => x.bookKey === `${BASE}/book/1/patch`)).toMatchObject({
      title: '补丁书', author: '作者乙', intro: '简介乙', totalChapters: 99,
    })
  })
  it('PUT {patch} 对不在架的书 → 400（不静默造书）', async () => {
    const r = await fetch(`${base}/novel-api/shelf/${encodeURIComponent(`${BASE}/book/1/nopatch`)}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ patch: { totalChapters: 1 } }),
    })
    expect(r.status).toBe(400)
  })
  it('GET /book 缺参 → 400；未知 sourceId → 404', async () => {
    expect((await fetch(`${base}/novel-api/book?url=x`)).status).toBe(400)
    const r = await fetch(`${base}/novel-api/book?sourceId=nope&url=${encodeURIComponent(`${BASE}/book/1/`)}`)
    expect(r.status).toBe(404)
  })

  // ── 书架批量删除（多选：一次请求删一批 bookKey）─────────────────────────────
  const addBook = async (key: string, title = key): Promise<void> => {
    await fetch(`${base}/novel-api/shelf/${encodeURIComponent(key)}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourceId: 's1', title }),
    })
  }
  const shelfKeys = async (): Promise<string[]> => {
    const value = await valueOf<ShelfEntry[]>(await fetch(`${base}/novel-api/shelf`))
    return value.map((b) => b.bookKey)
  }
  const batchDelete = (body: unknown): Promise<Response> => fetch(`${base}/novel-api/shelf/batch-delete`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })

  it('POST /shelf/batch-delete：一趟删多本，返回实际命中数（未知键静默跳过）', async () => {
    await addBook(`${BASE}/bd/1`, '批一')
    await addBook(`${BASE}/bd/2`, '批二')
    await addBook(`${BASE}/bd/3`, '批三')
    const r = await batchDelete({ keys: [`${BASE}/bd/1`, `${BASE}/bd/2`, `${BASE}/bd/nope`] })
    expect(r.status).toBe(200)
    expect(await valueOf<{ removed: number }>(r)).toEqual({ removed: 2 })
    const left = await shelfKeys()
    expect(left).not.toContain(`${BASE}/bd/1`)
    expect(left).not.toContain(`${BASE}/bd/2`)
    expect(left).toContain(`${BASE}/bd/3`)          // 未点名的不动（本文件前序用例的书架条目也不动）
  })

  it('POST /shelf/batch-delete：body 非法（空/缺 keys/非字符串）→ 400；GET → 405', async () => {
    for (const body of [{}, { keys: [] }, { keys: [1] }, { keys: 'x' }]) {
      const r = await batchDelete(body)
      expect(r.status, JSON.stringify(body)).toBe(400)
      expect((await errorOf(r)).code, JSON.stringify(body)).toBe('BadRequest')
    }
    const wrongMethod = await fetch(`${base}/novel-api/shelf/batch-delete`)
    expect(wrongMethod.status).toBe(405)
  })

  it('GET /shelf：条目带来源投影 sourceName（源名读取时 join；join 不到为 null）', async () => {
    const src = await valueOf<SourcePublic[]>(await fetch(`${base}/novel-api/sources`))
    const key = `${BASE}/bd/with-source`
    await fetch(`${base}/novel-api/shelf/${encodeURIComponent(key)}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourceId: pick(src, 0).id, title: '带来源' }),
    })
    await addBook(`${BASE}/bd/orphan`, '孤儿来源')
    // 后者挂的 sourceId 不在注册表里（本文件前序 PUT 均用 's1' 这类假 id）
    const value = await valueOf<ShelfEntry[]>(await fetch(`${base}/novel-api/shelf`))
    const byKey = new Map(value.map((b) => [b.bookKey, b.sourceName] as const))
    expect(byKey.get(key)).toBe(pick(src, 0).name)
    expect(byKey.get(`${BASE}/bd/orphan`)).toBeNull()
  })
})

/**
 * 搜索后台任务的传输层：提交即由 Node 半跑完并持有整轮结果，读面带游标增量。
 * 这里只验路由的形状与判据（405/400/游标语义）；持有与替换的分期逻辑在
 * tests/services/search-job.test.ts 直测持有者。
 */
describe('search/job 面（后台搜索任务的提交与快照读取）', () => {
  const post = async (body: unknown): Promise<{ status: number; json: ApiEnvelope<{ jobId: string }> }> => {
    const r = await fetch(`${base}/novel-api/${ROUTES.searchJob.path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    return { status: r.status, json: await envelopeOf<{ jobId: string }>(r) }
  }
  const get = async (since?: number): Promise<SearchJobSnapshot> => {
    const r = await fetch(`${base}/novel-api/${queries.searchJobStatus(since)}`)
    expect(r.status).toBe(200)
    const { job } = await valueOf<{ job: SearchJobSnapshot | null }>(r)
    return must(job, '搜索任务快照')
  }
  /** 轮询到本轮收尾（在途 vs 终态的判据就是 phase，UI 也用这一个） */
  const apiSendOf = async (path: string): Promise<{ status: number; body: ApiEnvelope<{ cancelled: boolean }> }> => {
    const r = await fetch(`${base}/novel-api/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    return { status: r.status, body: await envelopeOf<{ cancelled: boolean }>(r) }
  }
  const settle = async (): Promise<SearchJobSnapshot> => {
    for (let i = 0; i < 500; i++) {
      const job = await get()
      if (job.phase !== 'running') return job
      await new Promise((r) => setTimeout(r, 5))
    }
    throw new Error('搜索任务未在限时内收尾')
  }

  it('方法守卫：提交只收 POST、快照只收 GET', async () => {
    expect((await fetch(`${base}/novel-api/${ROUTES.searchJob.path}`)).status).toBe(405)
    expect((await fetch(`${base}/novel-api/${ROUTES.searchJobStatus.path}`, { method: 'POST' })).status).toBe(405)
  })
  it('入参校验：缺/空白 keyword → 400；sourceIds 非 string[] → 400', async () => {
    for (const body of [{}, { keyword: '' }, { keyword: '   ' }, { keyword: 7 },
      { keyword: '斗罗', sourceIds: 's1' }, { keyword: '斗罗', sourceIds: [1] }]) {
      const r = await post(body)
      expect(r.status, JSON.stringify(body)).toBe(400)
      expect(must(r.json.error, '错误信封').code, JSON.stringify(body)).toBe('BadRequest')
    }
  })
  it('提交 → { jobId }；终态快照带整轮结果（total/done/added/next）', async () => {
    const { status, json } = await post({ keyword: '斗罗' })
    expect(status).toBe(200)
    expect(typeof must(json.value, 'jobId').jobId).toBe('string')
    const job = await settle()
    expect(job).toMatchObject({
      keyword: '斗罗', phase: 'done', total: 1, done: 1, next: 1,
    })
    expect(pick(pick(job.added, 0).hits, 0)).toMatchObject({ title: '斗罗', author: '唐家' })
  })
  it('游标：since=next → 零增量；since 超前 → 夹到末尾（不是 400）；since 非法 → 当作 0', async () => {
    expect((await get(1)).added).toEqual([])
    expect((await get(999)).added).toEqual([])
    expect((await get(999)).next).toBe(1)
    const r = await fetch(`${base}/novel-api/${ROUTES.searchJobStatus.path}?since=abc`)
    const { job } = await valueOf<{ job: SearchJobSnapshot | null }>(r)
    expect(must(job, '搜索任务快照').added).toHaveLength(1)
  })
  it('只留最近一轮：新提交后读面指向新一轮，上一轮结果不再可读', async () => {
    const { json } = await post({ keyword: '斗罗' })
    expect(must(json.value, 'jobId').jobId).toBeTruthy()
    const before = await settle()
    const again = await post({ keyword: 'tail' })
    expect(must(again.json.value, 'jobId').jobId).not.toBe(before.id)
    const after = await settle()
    expect(after.id).toBe(must(again.json.value, 'jobId').jobId)
    expect(after.keyword).toBe('tail')
  })

  /** SSE 是「不等下一拍」的加速器：帧体就是快照查询的那一份 `{ job }`，游标同一条。
   *  增量真的逐帧流出由 `tests/services/search-job.test.ts` 的 subscribe 钉；这里钉形状与关流。 */
  it('POST search/job-cancel → {cancelled}；取消不改读面形状（快照仍可整轮翻）', async () => {
    const { json } = await post({ keyword: '斗罗' })
    await settle()                                   // 假 fetch 秒回：本轮通常早已终态
    const r = await apiSendOf(ROUTES.searchJobCancel.path)
    expect(r.status).toBe(200)
    const cancelled = must(r.body.value, 'cancelled')
    expect(typeof cancelled.cancelled).toBe('boolean')      // true=真停在半路；false=空钮（本轮已收尾）
    expect(cancelled.cancelled).toBe(false)                 // settle() 已等到终态 → 只能是空钮
    const twice = await apiSendOf(ROUTES.searchJobCancel.path)
    expect(must(twice.body.value, 'cancelled').cancelled).toBe(false)             // 再点还是空钮，不会二次结算
    const after = await get(0)
    expect(after.id).toBe(must(json.value, 'jobId').jobId)               // 取消不许抹掉本轮结果
    expect(after.added.length).toBeGreaterThan(0)
  })

  it('SSE 流：每帧都是同一份快照、只含本轮、终帧后服务端关流', async () => {
    const { json } = await post({ keyword: '斗罗' })
    const jobId = must(json.value, 'jobId').jobId
    const res = await fetch(`${base}/novel-api/${queries.searchJobStream()}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    expect(res.headers.get('x-accel-buffering')).toBe('no')         // 经代理不许攒帧，否则「即时」变「整批迟到」
    const frames = await readSse(res)
    expect(frames.length).toBeGreaterThanOrEqual(1)
    expect(frames.every((f) => f.id === jobId)).toBe(true)   // 不许夹带上一轮的帧
    expect(pick(frames, frames.length - 1).phase).not.toBe('running')
    expect(res.body).not.toBeNull()                                  // readSse 读到 done = 服务端已 end

    const snap = await get(0)
    expect(pick(frames, frames.length - 1).added.map((g) => g.sourceId))
      .toEqual(snap.added.map((g) => g.sourceId))               // 推送与查询读数一字不差
  })

  it('SSE 的方法守卫与游标兜底（非法 since 当作 0，不炸）', async () => {
    expect((await fetch(`${base}/novel-api/${ROUTES.searchJobStream.path}`, { method: 'POST' })).status).toBe(405)
    const res = await fetch(`${base}/novel-api/${ROUTES.searchJobStream.path}?since=abc`)
    expect(res.status).toBe(200)
    const frames = await readSse(res)
    expect(pick(frames, 0).added.length).toBeGreaterThan(0)                // since 非法 → 全量首帧
  })
})

/** 把一条 SSE 响应读成帧数组，直到服务端关流（`done`）——不自己掐表，交给服务端判定结束 */
async function readSse(res: Response): Promise<SearchJobSnapshot[]> {
  const reader = must(res.body, 'SSE 响应体').getReader()
  const dec = new TextDecoder()
  const out: SearchJobSnapshot[] = []
  let buf = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let at = buf.indexOf('\n\n')
    while (at >= 0) {
      const chunk = buf.slice(0, at)
      buf = buf.slice(at + 2)
      const line = chunk.split('\n').find((l) => l.startsWith('data: '))
      if (line !== undefined) out.push((JSON.parse(line.slice(6)) as { job: SearchJobSnapshot }).job)
      at = buf.indexOf('\n\n')
    }
  }
  return out
}
