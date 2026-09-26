import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ReadingService } from '../../src/services/reading.js'
import { SourceRegistry } from '../../src/services/sources.js'
import { Shelf } from '../../src/services/shelf.js'
import { PageCache } from '../../src/services/cache.js'
import { createFetcher } from '../../src/services/fetcher.js'
import { startServer } from './helpers.js'
import { makeTempDir, trackService } from '../temp-dir.js'
import { NOVEL_API_PREFIX, paramRoutes, ROUTES, SEG } from '../../src/shared/wire.js'

/**
 * 路由契约测试：
 * ROUTES/SEG 是路由字面量的唯一真相——每条常量必须真实落到 dispatch 的 if-链上，
 * 与某次重构是否记得改匹配无关。落点判据：响应不是「未知路由」404
 * （400/403/404-源不存在/405/503 都算落到了路由上）。
 */

let svc: ReadingService, base: string, close: () => Promise<void>
beforeAll(async () => {
  const dir = await makeTempDir('novel-routes-')
  svc = trackService(await ReadingService.create({
    dir,
    fetchImpl: (async () => new Response('<html></html>', { headers: { 'content-type': 'text/html; charset=utf-8' } })) as never,
  }))
  ;({ base, close } = await startServer(svc))
})
afterAll(async () => { await svc.flush(); await close() })

async function call(route: string, method: string, body?: unknown): Promise<{ status: number; json: any }> {
  const r = await fetch(`${base}${NOVEL_API_PREFIX}${route === '' ? '' : `/${route}`}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: r.status, json: await r.json() as any }
}

/** 落点判据：不是「未知路由」404 */
const landed = (res: { status: number; json: any }): boolean =>
  !(res.status === 404 && typeof res.json?.error?.message === 'string' && res.json.error.message.startsWith('未知路由'))

/** 任务槽驱动：轮询到上一个任务收尾（单任务槽互斥——不等会 409） */
async function pollJobDone(): Promise<void> {
  for (let i = 0; i < 500; i++) {
    const { json } = await call(ROUTES.sourcesJobStatus.path, 'GET')
    if (json.value.job === null || json.value.job.phase !== 'running') return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error('任务未在限时内收尾')
}

describe('路由契约：ROUTES → 真实 dispatch 落点', () => {
  it('健康检查（ROUTES.health）', async () => {
    const res = await call(ROUTES.health.path, 'GET')
    expect(res.status).toBe(200)
    expect(res.json).toMatchObject({ ok: true, value: { name: 'dsh-novel', apiVersion: 1 } })
  })

  it('sources 面静态路由逐条落点', async () => {
    expect((await call(ROUTES.sources.path, 'GET')).status).toBe(200)

    const imp = await call(ROUTES.sourcesImport.path, 'POST', { files: [{ name: 'a.json', text: '[]' }] })
    expect(imp.status).toBe(200)
    await pollJobDone()

    expect((await call(ROUTES.sourcesJobStatus.path, 'GET')).status).toBe(200)

    const bp = await call(ROUTES.sourcesBatchProbe.path, 'POST', { ids: ['missing-id'] })
    expect(bp.status).toBe(200)
    await pollJobDone()

    // 空 ids → 400：落在 body 校验上（未知路由才是 404-未知路由）
    const be = await call(ROUTES.sourcesBatchEnabled.path, 'POST', { ids: [], enabled: true })
    expect(be.status).toBe(400)
    expect(landed(be)).toBe(true)

    const bd = await call(ROUTES.sourcesBatchDelete.path, 'POST', { ids: ['nope'] })
    expect(bd.status).toBe(200)
    expect(bd.json.value.removed).toBe(0)
  })

  it('已知 POST-only 子路由用错方法 → 405（此前 404-未知路由）', async () => {
    for (const r of [ROUTES.sourcesImport, ROUTES.sourcesBatchProbe, ROUTES.sourcesBatchEnabled, ROUTES.sourcesBatchDelete, ROUTES.shelfBatchDelete, ROUTES.localImport, ROUTES.searchJob, ROUTES.searchJobCancel]) {
      const res = await call(r.path, 'GET')
      expect(res.status, r.path).toBe(405)
      expect(res.json.error.code, r.path).toBe('MethodNotAllowed')
    }
    for (const r of [ROUTES.sourcesJobStatus, ROUTES.searchJobStatus]) {
      expect((await call(r.path, 'POST')).status, r.path).toBe(405)
    }
  })

  it('shelf key 非法百分号编码 → 400（此前 URIError 归 other → 500）', async () => {
    const d = await fetch(`${base}${NOVEL_API_PREFIX}/shelf/%E0%A4%A`, { method: 'DELETE' })
    expect(d.status).toBe(400)
    expect((await d.json() as any).error.code).toBe('BadRequest')
  })

  it('reading / shelf / export / local 面落点', async () => {
    const s = await call(`${ROUTES.search.path}?keyword=k`, 'GET')
    expect(s.status).toBe(200)
    expect(s.json.value).toEqual([])                       // 空库：零源零组

    // 搜索参与计划：空库 → 空参与集
    const plan = await call(ROUTES.searchPlan.path, 'GET')
    expect(plan.status).toBe(200)
    expect(plan.json.value).toEqual({ sourceIds: [] })

    // 后台搜索任务：空库提交 → total 0，读面即刻终态（提交/读取都零源可用）
    const sj = await call(ROUTES.searchJob.path, 'POST', { keyword: 'k' })
    expect(sj.status).toBe(200)
    const snap = await call(ROUTES.searchJobStatus.path, 'GET')
    expect(snap.status).toBe(200)
    expect(snap.json.value.job).toMatchObject({ keyword: 'k', total: 0, next: 0 })

    for (const r of [ROUTES.book, ROUTES.toc, ROUTES.chapter, ROUTES.navigation]) {
      const q = `sourceId=x&url=${encodeURIComponent('https://x/b')}${r === ROUTES.chapter ? '&index=0' : ''}`
      const res = await call(`${r.path}?${q}`, 'GET')
      expect(landed(res)).toBe(true)                       // 落在源不存在（requireSourceUrl 通过后）
    }

    expect((await call(ROUTES.shelf.path, 'GET')).status).toBe(200)

    const shelfPut = await call(paramRoutes.shelfKey('k'), 'PUT', {})
    expect(shelfPut.status).toBe(400)
    expect(landed(shelfPut)).toBe(true)

    const exp = await call(`${ROUTES.exportBook.path}?title=t`, 'GET')
    expect(exp.status).toBe(400)                           // requireSourceUrl
    expect(landed(exp)).toBe(true)

    // local 两路由：local part 缺席 → 503（落点判据迁至「无 local 部件」专测——create() 现恒挂本地书面）
    const li = await call(`${ROUTES.localImport.path}?name=a.txt`, 'POST')
    expect(landed(li)).toBe(true)
    const ld = await call(`${ROUTES.local.path}?id=x`, 'DELETE')
    expect(landed(ld)).toBe(true)

    // 本地三读口：参数齐全但书不存在 → 落在「本地产物不存在」404（不是未知路由）
    for (const r of [`${ROUTES.localDocument.path}?id=x&documentId=d0`, `${ROUTES.localResource.path}?id=x&resourceId=r0`, `${ROUTES.localWarnings.path}?id=x`]) {
      const res = await call(r, 'GET')
      expect(res.status, r).toBe(404)
      expect(landed(res), r).toBe(true)
    }
  })

  it('local part 缺席（from() 不传 local）→ 503 Unavailable（判据归门面动词）', async () => {
    const dir = await makeTempDir('novel-routes-nolocal-')
    const bare = trackService(await ReadingService.from({
      registry: await SourceRegistry.load(dir),
      shelf: await Shelf.load(dir),
      cache: new PageCache(dir),
      fetcher: createFetcher({}),
    }))
    const { base: b2, close: c2 } = await startServer(bare)
    try {
      for (const [route, method] of [
        [`${ROUTES.localImport.path}?name=a.txt`, 'POST'], [`${ROUTES.local.path}?id=x`, 'DELETE'],
        [`${ROUTES.localDocument.path}?id=x&documentId=d0`, 'GET'],
        [`${ROUTES.localResource.path}?id=x&resourceId=r0`, 'GET'],
        [`${ROUTES.localWarnings.path}?id=x`, 'GET'],
      ] as const) {
        const r = await fetch(`${b2}${NOVEL_API_PREFIX}/${route}`, { method })
        expect(r.status, route).toBe(503)
        expect((await r.json() as any).error.code).toBe('Unavailable')
      }
    } finally {
      await c2()
    }
  })

  it('参数路由落点（段位匹配）', async () => {
    // probe / enabled / auth 带不存在的 id → 落在「源不存在」404（不是未知路由）
    const cases: Array<[string, unknown]> = [
      [paramRoutes.sourceProbe('nope'), {}],
      [paramRoutes.sourceEnabled('nope'), { enabled: true }],
      [paramRoutes.sourceAuth('nope'), {}],
    ]
    for (const [route, body] of cases) {
      const res = await call(route, 'POST', body)
      expect(res.status, route).toBe(404)
      expect(res.json.error.message.startsWith('源不存在'), route).toBe(true)
    }
    const del = await call(paramRoutes.sourceDelete('nope'), 'DELETE')
    expect(del.status).toBe(200)
    expect(del.json.value).toEqual({ removed: false })
  })

  it('负对照：未知路由 / 错误前缀仍是 404', async () => {
    const unknown = await call('nope', 'GET')
    expect(unknown.status).toBe(404)
    expect(unknown.json.error.message.startsWith('未知路由')).toBe(true)
    expect((await fetch(`${base}/other/sources`)).status).toBe(404)
  })

  it('SEG 每一段都被某条路由使用（单一真相自洽：无孤儿段、无手抄段）', () => {
    const used = new Set<string>()
    for (const r of Object.values(ROUTES)) for (const s of r.segs) used.add(s)
    for (const f of Object.values(paramRoutes)) for (const s of f('x').split('/')) used.add(s)
    for (const [name, seg] of Object.entries(SEG)) {
      expect(used.has(seg), `SEG.${name}（${seg}）未被任何路由使用`).toBe(true)
    }
  })
})
