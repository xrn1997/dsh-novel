import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ReadingService } from '../../src/services/reading.js'
import { startServer } from './helpers.js'
import { makeTempDir, trackService } from '../temp-dir.js'

const rawSource = {
  bookSourceName: 'S', bookSourceUrl: 'https://s.com',
  searchUrl: 'https://s.com/search?q={{key}}',
  ruleBookList: '@css:.b', ruleBookName: 'tag.a@text',
  ruleContent: '@css:#c@text',
}
const SEARCH_HTML = '<html><body><div class="b"><a href="/book/1/">斗罗</a></div></body></html>'

let svc: ReadingService, base: string, close: () => Promise<void>
beforeAll(async () => {
  const dir = await makeTempDir('novel-api-')
  svc = trackService(await ReadingService.create({
    dir,
    fetchImpl: (async () => new Response(SEARCH_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } })) as any,
  }))
  ;({ base, close } = await startServer(svc))
})
afterAll(async () => { await svc.flush(); await close() })

/** 提交导入 → 轮询 job-status 至收尾 → 返回 JobState（新任务面的统一驱动方式，UI 同款） */
async function importAndDone(files: Array<{ name: string; text: string }>): Promise<any> {
  const r = await fetch(`${base}/novel-api/sources/import`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ files }),
  })
  expect(r.status).toBe(200)
  return pollDone(base)
}
async function pollDone(b: string): Promise<any> {
  for (let i = 0; i < 500; i++) {
    const { value } = await (await fetch(`${b}/novel-api/sources/job-status`)).json() as any
    if (value.job !== null && value.job.phase !== 'running') return value.job
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error('job 未在限时内收尾')
}

describe('sources 面（后台任务版）', () => {
  it('POST /sources/import → jobId；轮询 job-status 至 done；GET /sources 可见且新源 unverified（不探针钉死）', async () => {
    const r1 = await fetch(`${base}/novel-api/sources/import`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ files: [{ name: 'a.json', text: JSON.stringify([rawSource, { bad: 1 }]) }] }),
    })
    expect(r1.status).toBe(200)
    const { value: started } = await r1.json() as any
    expect(started.jobId).toBeTypeOf('string')
    const job = await pollDone(base)
    expect(job).toMatchObject({ id: started.jobId, kind: 'import', phase: 'done' })
    expect(job.counts).toMatchObject({ ok: 1, failed: 1 })

    const { value: list } = await (await fetch(`${base}/novel-api/sources`)).json() as any
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ name: 'S', status: 'unverified', hasHeader: false, hasAuth: false })
    expect(list[0]).not.toHaveProperty('raw')
    expect(list[0]).not.toHaveProperty('auth')
  })
  it('job done 后结果保留：再查 job-status 仍拿到同一份汇总（重开 UI 可恢复）', async () => {
    const { value } = await (await fetch(`${base}/novel-api/sources/job-status`)).json() as any
    expect(value.job).toMatchObject({ kind: 'import', phase: 'done' })
    expect(value.job.counts.ok).toBe(1)
  })
  it('坏文件点名：fileErrors 有记录，好文件照常导入', async () => {
    const job = await importAndDone([
      { name: 'bad.json', text: 'not json' },
      { name: 'good.json', text: JSON.stringify({ ...rawSource, bookSourceName: 'S2', bookSourceUrl: 'https://s2.com' }) },
    ])
    expect(job.fileErrors).toEqual([{ file: 'bad.json', error: 'JSON 解析失败' }])
    expect(job.counts.ok).toBe(1)
  })
  it('POST /sources/:id/probe → ProbeResult 并落状态', async () => {
    const { value: list } = await (await fetch(`${base}/novel-api/sources`)).json() as any
    const r = await fetch(`${base}/novel-api/sources/${list[0].id}/probe`, { method: 'POST' })
    const { value: probe } = await r.json() as any
    expect(probe).toMatchObject({ ok: true, itemCount: 1, firstTitle: '斗罗' })
    const { value: after } = await (await fetch(`${base}/novel-api/sources`)).json() as any
    expect(after.find((s: any) => s.id === list[0].id).status).toBe('verified')
  })
  it('POST /sources/batch-probe：ids 校验 400 + 正常收尾状态翻转 verified', async () => {
    expect((await fetch(`${base}/novel-api/sources/batch-probe`, { method: 'POST' })).status).toBe(400)
    expect((await fetch(`${base}/novel-api/sources/batch-probe`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: [] }),
    })).status).toBe(400)
    const { value: list } = await (await fetch(`${base}/novel-api/sources`)).json() as any
    const unprobed = list.filter((s: any) => s.status !== 'verified').map((s: any) => s.id)
    if (unprobed.length > 0) {
      const r = await fetch(`${base}/novel-api/sources/batch-probe`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: unprobed }),
      })
      expect(r.status).toBe(200)
      const job = await pollDone(base)
      expect(job.kind).toBe('batch-probe')
      expect(job.counts.ok).toBe(unprobed.length)
      const { value: after } = await (await fetch(`${base}/novel-api/sources`)).json() as any
      expect(after.every((s: any) => s.status === 'verified')).toBe(true)
    }
  })
  it('运行中再提交 → 409 JobRunning（gated 探针把任务钉在 running）', async () => {
    let release = (): void => {}
    const gate = new Promise<void>((r) => { release = r })
    const dir = await makeTempDir('novel-api-')
    const svc2 = trackService(await ReadingService.create({
      dir,
      fetchImpl: (async () => { await gate; return new Response(SEARCH_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } }) }) as any,
    }))
    const s2 = await startServer(svc2)
    try {
      // 先种一个源（导入不探针，秒收）；再用 gated 探针把 batch-probe 钉在 running
      await fetch(`${s2.base}/novel-api/sources/import`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ files: [{ name: 'a.json', text: JSON.stringify(rawSource) }] }),
      })
      await pollDone(s2.base)
      const { value: list } = await (await fetch(`${s2.base}/novel-api/sources`)).json() as any
      await fetch(`${s2.base}/novel-api/sources/batch-probe`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: [list[0].id] }),
      })
      const r = await fetch(`${s2.base}/novel-api/sources/import`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ files: [{ name: 'b.json', text: '{}' }] }),
      })
      expect(r.status).toBe(409)
      expect((await r.json() as any).error.code).toBe('JobRunning')
    } finally { release(); await svc2.flush(); await s2.close() }
  })
  it('POST /sources（旧同步路由）→ 405（已移除，指向新任务面）', async () => {
    const r = await fetch(`${base}/novel-api/sources`, { method: 'POST', body: '[]' })
    expect(r.status).toBe(405)
    expect((await r.json() as any).error.message).toContain('sources/import')
  })
  it('import body 校验：空 files / 缺 name|text → 400', async () => {
    const post = (body: unknown) => fetch(`${base}/novel-api/sources/import`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    expect((await post({ files: [] })).status).toBe(400)
    expect((await post({ files: [{ name: 'a' }] })).status).toBe(400)
    expect((await post(null)).status).toBe(400)
  })
  it('POST /sources/:id/enabled：置位翻转 + GET 可见 + persist；未知 id 404；非法 body 400', async () => {
    const { value: list } = await (await fetch(`${base}/novel-api/sources`)).json() as any
    const id = list[0].id
    const r = await fetch(`${base}/novel-api/sources/${id}/enabled`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }),
    })
    expect(r.status).toBe(200)
    expect((await r.json() as any).value).toEqual({ enabled: false })
    const { value: after } = await (await fetch(`${base}/novel-api/sources`)).json() as any
    expect(after.find((s: any) => s.id === id).enabled).toBe(false)
    // 持久化：服务重启（重 load）后仍停用——registry.persist 已在路由内
    expect((await fetch(`${base}/novel-api/sources/${id}/enabled`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true }),
    })).status).toBe(200)
    expect((await fetch(`${base}/novel-api/sources/fake-uuid/enabled`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }),
    })).status).toBe(404)
    expect((await fetch(`${base}/novel-api/sources/${id}/enabled`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nope: 1 }),
    })).status).toBe(400)
  })
  it('POST /sources/batch-enabled：批量启停 + 未知跳过 + 重复幂等 + 空/非法 400', async () => {
    const seed = await importAndDone([{ name: 'be.json', text: JSON.stringify([
      { ...rawSource, bookSourceName: 'BE1', bookSourceUrl: 'https://be1.com' },
      { ...rawSource, bookSourceName: 'BE2', bookSourceUrl: 'https://be2.com' },
    ]) }])
    expect(seed.counts.ok).toBe(2)
    const { value: list } = await (await fetch(`${base}/novel-api/sources`)).json() as any
    const ids = list.filter((s: any) => s.name.startsWith('BE')).map((s: any) => s.id)
    const r = await fetch(`${base}/novel-api/sources/batch-enabled`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [...ids, 'fake-uuid', ids[0]], enabled: false }),   // 未知跳过 + 重复幂等
    })
    expect(r.status).toBe(200)
    expect((await r.json() as any).value.updated).toBe(2)
    const { value: after } = await (await fetch(`${base}/novel-api/sources`)).json() as any
    expect(after.filter((s: any) => s.name.startsWith('BE')).every((s: any) => s.enabled === false)).toBe(true)
    expect((await fetch(`${base}/novel-api/sources/batch-enabled`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: [], enabled: true }),
    })).status).toBe(400)
    expect((await fetch(`${base}/novel-api/sources/batch-enabled`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids, enabled: 'yes' }),
    })).status).toBe(400)
  })
  it('大包（>1MB，真实 legado 多源导出量级）→ 200 不 413', async () => {
    // 真实用户文件 4.8MB（多源导出包的量级）；默认 1MB 上限会把最大流量的包挡在门外
    const big = { ...rawSource, bookSourceName: 'Big', bookSourceUrl: 'https://big.com', bookSourceComment: 'x'.repeat(2 * 1024 * 1024) }
    const job = await importAndDone([{ name: 'big.json', text: JSON.stringify([big]) }])
    expect(job.counts.ok).toBe(1)
  })
  it('POST /sources/batch-delete：多 id + 未知 id + 重复 id → 实删计数；空/非法 → 400', async () => {
    const { value: list } = await (await fetch(`${base}/novel-api/sources`)).json() as any
    const [x, y] = list.map((s: any) => s.id)
    const r = await fetch(`${base}/novel-api/sources/batch-delete`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [x, 'fake-uuid', x, y] }),       // 未知跳过 + 重复幂等
    })
    expect(r.status).toBe(200)
    expect((await r.json() as any).value.removed).toBe(Math.min(2, list.length))
    expect((await fetch(`${base}/novel-api/sources/batch-delete`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: [] }),
    })).status).toBe(400)
    expect((await fetch(`${base}/novel-api/sources/batch-delete`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: [1] }),
    })).status).toBe(400)
  })
  it('POST /sources/:id/auth 录入形态 → hasAuth 位翻转，凭据不外泄', async () => {
    const { value: list } = await (await fetch(`${base}/novel-api/sources`)).json() as any
    if (list.length === 0) return                                    // 前序批量删空则跳过（auth 语义在 sources.test 有专测）
    const r = await fetch(`${base}/novel-api/sources/${list[0].id}/auth`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cookies: { token: 'SECRET' } }),
    })
    expect((await r.json() as any).value).toEqual({ auth: true })
    const { value: after } = await (await fetch(`${base}/novel-api/sources`)).json() as any
    expect(after[0]).toMatchObject({ hasAuth: true, authExpired: false })
    expect(JSON.stringify(after)).not.toContain('SECRET')
    await fetch(`${base}/novel-api/sources/${list[0].id}`, { method: 'DELETE' })
  })
  it('未知路由 → 404 NotFound；方法不对 → 405', async () => {
    const r1 = await fetch(`${base}/novel-api/nope`)
    expect(r1.status).toBe(404)
    expect((await r1.json() as any).error.code).toBe('NotFound')
    const r2 = await fetch(`${base}/novel-api/sources`, { method: 'PUT' })
    expect(r2.status).toBe(405)
  })
})
