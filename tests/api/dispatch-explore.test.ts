import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ReadingService } from '../../src/services/reading.js'
import { PARAMS, ROUTES } from '../../src/shared/wire.js'
import { startServer } from './helpers.js'
import { makeTempDir, trackService } from '../temp-dir.js'

const NATIVE = {
  name: 'S', url: 'https://s.com',
  searchUrl: '/so/{{keyword}}/{{page}}',
  ruleSearch: { list: '.item', name: 'h3 a', author: 'p a', bookUrl: 'h3 a@href' },
  ruleBookInfo: { name: '.booktxt h1' },
  ruleToc: { list: '#list li', name: 'a', url: 'a@href' },
  ruleContent: { content: '.con' },
  ruleFind: { url: '/{{kind}}/{{page}}', kinds: [{ title: '玄幻', url: 'xuanhuan' }] },
}
const LIST_HTML = '<html><body><div class="item"><h3><a href="/book/1">剑起长安</a></h3>' +
  '<p><a href="/zuozhe/a">青衫客</a></p></div></body></html>'

let svc: ReadingService, base: string, close: () => Promise<void>, sourceId: string
beforeAll(async () => {
  const dir = await makeTempDir('novel-api-explore-')
  svc = trackService(await ReadingService.create({
    dir,
    fetchImpl: (async () => new Response(LIST_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } })) as never,
  }))
  await svc.importOne(NATIVE)
  sourceId = svc.listPublicSources()[0].id
  ;({ base, close } = await startServer(svc))
})
afterAll(async () => { await svc.flush(); await close() })

/** 提交一轮（body 一次带齐两个点名：哪个源、哪一类）——浏览轴是「先选源、逛它自己的分类」 */
function submit(): Promise<Response> {
  return postList({ [PARAMS.sourceId]: sourceId, [PARAMS.kind]: '玄幻' })
}
/** 提交一轮的 body 构造口：缺字段那两条要少带一个名，故与 submit 分开 */
function postList(body: Record<string, unknown>): Promise<Response> {
  return fetch(`${base}/novel-api/${ROUTES.exploreList.path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
}
/** 少点一个名：400 必须说出缺的是哪一个字段，只回「参数不对」等于让调用方猜 */
async function expectBadRequestOn(r: Response, field: string): Promise<void> {
  expect(r.status).toBe(400)
  const err = (await r.json() as any).error
  expect(err.code).toBe('BadRequest')
  expect(err.message).toContain(field)
}

describe('书城发现面', () => {
  /** **不提交任何轮次**（只问「还有没有更多」）：为下面的入场态用例保住「还没有任何一轮」这个前提 */
  it('POST explore/list/more 没有可续的轮次 → 409（如实说没有更多，不假装又开了一轮）', async () => {
    const r = await fetch(`${base}/novel-api/${ROUTES.exploreListMore.path}`, { method: 'POST' })
    expect(r.status).toBe(409)
    const body = await r.json() as any
    expect(body.ok).toBe(false)
    expect(body.error.code).toBe('Conflict')
  })

  /** 排在提交类用例之前：入场态（从未提交过 → 首帧是空档、流继续等）只在「还没有任何一轮」时成立，
   *  而 svc 在本块内共用、终态快照还会保留一段。 */
  it('SSE 流：未提交时首帧是空档且流继续等，提交后终帧给出整轮并关流', async () => {
    const res = await fetch(`${base}/novel-api/${ROUTES.exploreListStream.path}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    expect(res.headers.get('x-accel-buffering')).toBe('no')      // 经代理不许攒帧，否则「即时」变「整批迟到」
    const sse = openStream(res)
    try {
      expect(await sse.next()).toEqual({ job: null })            // 还没提交过：正常入场态，不是错误
      const pending = sse.next()                                 // 挂一次读：服务端若在这里关流，它会立刻以读完收尾
      let settled = false
      void pending.then(() => { settled = true })
      for (let i = 0; i < 20 && !settled; i++) await new Promise((r) => setTimeout(r, 5))
      expect(settled).toBe(false)                                // 流在等：不关、也不拿空帧刷屏

      const submitted = await submit()
      const { value } = await submitted.json() as any
      expect(typeof value.jobId).toBe('string')
      let terminal = await pending
      for (let i = 0; i < 50 && terminal !== null && terminal.job.phase === 'running'; i++) terminal = await sse.next()
      expect(terminal).not.toBeNull()                            // 有终帧；提前关流会在这一条上露出来
      expect(terminal!.job.id).toBe(value.jobId)                 // 帧归属本轮：不夹带上一次提交
      expect(terminal!.job.phase).toBe('done')
      expect(terminal!.job.sourceId).toBe(sourceId)              // 单源一轮：帧里带着点名的那个源
      expect(terminal!.job.books.map((b: any) => b.name)).toContain('剑起长安')
      // 「关流」要有上界：真没收尾时给一句明确断言，而不是把整个用例拖成超时（超时还会连带挂住 afterAll）
      const closed = await Promise.race([sse.next(), new Promise((r) => setTimeout(() => r('还在等'), 2000))])
      expect(closed).toBeNull()
    } finally { await sse.cancel() }
  })

  it('GET explore/kinds → 按源分组的分类清单，且只给标题不给入口地址', async () => {
    const r = await fetch(`${base}/novel-api/${ROUTES.exploreKinds.path}`)
    expect(r.status).toBe(200)
    const { value } = await r.json() as any
    expect(value).toMatchObject({ sources: [{ id: sourceId, name: 'S', kinds: ['玄幻'] }] })
    expect(JSON.stringify(value)).not.toContain('xuanhuan')      // 入口地址（原生档是 slug）不外泄到跨半契约
  })

  it('POST explore/list 缺 body.sourceId → 400 且点名缺的是哪一个字段', async () => {
    await expectBadRequestOn(await postList({ [PARAMS.kind]: '玄幻' }), PARAMS.sourceId)
  })

  it('POST explore/list 缺 body.kind → 400（形状判据仍归路由，源点名不接管它）', async () => {
    await expectBadRequestOn(await postList({ [PARAMS.sourceId]: sourceId }), PARAMS.kind)
  })

  // 点不到入口（源不存在 / 没声明这一类 / 不进城）是**值域**判据，主人在门面；路由不复制它，
  // 只把抛出的错误经同一份映射落成状态码。
  it('POST explore/list 点名点不到的源 → 400（门面的抛错经同一份映射落成状态码）', async () => {
    const r = await postList({ [PARAMS.sourceId]: 'nope', [PARAMS.kind]: '玄幻' })
    expect(r.status).toBe(400)
    const err = (await r.json() as any).error
    expect(err.code).toBe('BadRequest')
    expect(err.message).toContain('nope')                       // 消息带上点名的源，报错即可定位
  })

  it('POST explore/list → jobId；job-status 给出这一源这一类的书单', async () => {
    const r = await submit()
    const { value } = await r.json() as any
    expect(typeof value.jobId).toBe('string')
    let job: any = null
    for (let i = 0; i < 100 && job?.phase === undefined; i++) {
      await new Promise((res) => setTimeout(res, 5))
      const s = await fetch(`${base}/novel-api/${ROUTES.exploreListStatus.path}`)
      job = (await s.json() as any).value.job
      if (job?.phase !== 'running') break
    }
    expect(job.phase).toBe('done')
    expect(job.sourceId).toBe(sourceId)
    expect(job.kind).toBe('玄幻')
    expect(job.books.map((b: any) => b.name)).toEqual(['剑起长安'])
  })

  it('POST explore/list/more：同一轮续第 2 页（jobId 不变）；源到底后再点 → 409', async () => {
    const r = await submit()
    const { value } = await r.json() as any
    const first = await settle()
    expect(first.id).toBe(value.jobId)
    expect(first.page).toBe(1)
    expect(first.hasMore).toBe(true)                                  // 第 1 页带回新书：按钮该在

    const more = await fetch(`${base}/novel-api/${ROUTES.exploreListMore.path}`, { method: 'POST' })
    expect(more.status).toBe(200)
    expect((await more.json() as any).value.jobId).toBe(value.jobId)  // **同一轮**：不换 id（客户端整帧替换照旧）

    const second = await settle()
    expect(second.page).toBe(2)
    expect(second.hasMore).toBe(false)                                // 这一页回来的还是那本书 → 零新增 ⇒ 到底
    expect(second.books.map((b: any) => b.name)).toEqual(['剑起长安'])  // 去重：同一批书没被重复摊出

    const again = await fetch(`${base}/novel-api/${ROUTES.exploreListMore.path}`, { method: 'POST' })
    expect(again.status).toBe(409)
    expect((await again.json() as any).error.code).toBe('Conflict')
  })
})

/** 「在途」是竞态，靠运气碰不到——这条自带一道拦在取数前的闸，把「第 2 页那一批在途」的窗口钉死。
 *  读数正是 hasMore 的两侧：在途时它是 false，于是「再点一次」回 409（而不是走进续页的在途守卫抛错
 *  变 500）；闸开、本轮收尾后按钮按真实「到底了没有」恢复。 */
describe('书城续页：一批在途时再点 → 409（不是 500）', () => {
  it('第 2 页在途时 POST more 回 409 Conflict；放行收尾后照旧按到底判据给读数', async () => {
    let gate: Promise<void> | null = null
    let open: () => void = () => {}
    const dir = await makeTempDir('novel-api-explore-inflight-')
    const s = trackService(await ReadingService.create({
      dir,
      fetchImpl: (async () => {
        if (gate !== null) await gate                    // 闸住：制造「第 2 页还在途」的窗口
        return new Response(LIST_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } })
      }) as never,
    }))
    await s.importOne(NATIVE)
    const id = s.listPublicSources()[0].id
    const { base: b, close: c } = await startServer(s)
    try {
      await fetch(`${b}/novel-api/${ROUTES.exploreList.path}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ [PARAMS.sourceId]: id, [PARAMS.kind]: '玄幻' }),
      })
      expect((await settleAt(b)).hasMore).toBe(true)     // 第 1 页带回新书：还能再点

      gate = new Promise<void>((res) => { open = res })  // 此后的取数一律停在闸前
      const more = await fetch(`${b}/novel-api/${ROUTES.exploreListMore.path}`, { method: 'POST' })
      expect(more.status).toBe(200)                      // 第 2 页那一批已起跑、却在途

      const again = await fetch(`${b}/novel-api/${ROUTES.exploreListMore.path}`, { method: 'POST' })
      expect(again.status).toBe(409)                     // 「在途」不是说「你点了错的东西」：只说现在没得可加载
      expect((await again.json() as any).error.code).toBe('Conflict')

      open(); gate = null
      expect((await settleAt(b)).hasMore).toBe(false)    // 这一页还是那本书 ⇒ 零新增 ⇒ 到底
    } finally { await c() }
  })
})

/** 轮询到**当前**这轮收手（`running` 之外即终态）：续页会把同一轮重新点亮，故不带 id 断言，
 *  只等「不再是 running」——与 `tests/explore-settle.ts` 的 `settleExploreRound` 同一条策略
 *  （那边等手上的服务对象，这边只能等 HTTP 回包）。 */
async function settle(): Promise<any> {
  return settleAt(base)
}

/** 同上，但 base 由调用方给：本文件除公共 svc 外还有一条自带闸门的服务。 */
async function settleAt(baseUrl: string): Promise<any> {
  for (let i = 0; i < 200; i++) {
    const s = await fetch(`${baseUrl}/novel-api/${ROUTES.exploreListStatus.path}`)
    const job = (await s.json() as any).value.job
    if (job !== null && job !== undefined && job.phase !== 'running') return job
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error('分类轮次未在限时内收尾')
}

/** 逐帧读 SSE（`\n\n` 分隔）：`next()` 在服务端关流后给 null——「读到读完」本身就是「服务端已关流」的读数。
 *  `tests/api/dispatch-reading.test.ts` 那份是一次读到底；这里要分开看入场态，故按帧给。 */
function openStream(res: Response): { next: () => Promise<{ job: any } | null>; cancel: () => Promise<void> } {
  const reader = res.body!.getReader()
  const dec = new TextDecoder()
  let buf = ''
  return {
    async next(): Promise<{ job: any } | null> {
      for (;;) {
        const at = buf.indexOf('\n\n')
        if (at >= 0) {
          const line = buf.slice(0, at).split('\n').find((l) => l.startsWith('data: '))
          buf = buf.slice(at + 2)
          if (line === undefined) continue
          return JSON.parse(line.slice(6))
        }
        const { value, done } = await reader.read()
        if (done) return null
        buf += dec.decode(value, { stream: true })
      }
    },
    cancel: () => reader.cancel(),
  }
}
