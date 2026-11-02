import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ReadingService } from '../../src/services/reading.js'
import { SourceRegistry } from '../../src/services/sources.js'
import { Shelf } from '../../src/services/shelf.js'
import { PageCache } from '../../src/services/cache.js'
import { createFetcher } from '../../src/services/fetcher.js'
import { CookieJar } from '../../src/services/cookies.js'
import { makeTempDir, trackService } from '../temp-dir.js'
import type { ApiEnvelope, SearchPlan } from '../../src/shared/wire.js'
import { NOVEL_API_PREFIX, paramOps, ROUTES, SEG } from '../../src/shared/wire.js'
import { matchRoute, PARAM_PATTERN_PATHS } from '../../src/api/routes.js'
import type { ParamRouteName } from '../../src/api/routes.js'
import { must } from '../support/fixture.js'
import { envelopeOf, errorOf, startServer } from './helpers.js'

/**
 * 路由契约测试。身份对齐（表与分发）已由派生匹配 + 穷尽 Record 在编译期保证（ADR-0051），
 * 这里不再当胶水，只做三件事：
 *  - matchRoute 单元：匹配判据本身（静态优先、变体次序、垃圾尾段不认）；
 *  - 全表烟雾：ROUTES / paramOps 逐条按**正确方法**打过去，落点判据「不是未知路由 404」；
 *  - 405 全表扫描与负对照（未知路由、错前缀、非法百分号、无本地部件、SEG 孤儿）。
 * 落点判据：响应不是「未知路由」404
 * （400/403/404-源不存在/405/503 都算落到了路由上）。
 */

/** 参数路由代表值（原始值——百分号编码归构造器）：烟雾、405 扫描与 ⑧ 模式对照共用一份。 */
const PARAM_SAMPLES: Record<ParamRouteName, string> = {
  sourceProbe: 'uuid-1', sourceEnabled: 'uuid-2', sourceAuth: 'uuid-3',
  sourceDelete: 'uuid-4', shelfPut: 'k-1', shelfDelete: 'k-2',
}

describe('matchRoute 单元', () => {
  it('① 静态路由逐条 (method, path 段) → hit 且名对', () => {
    for (const [name, target] of Object.entries(ROUTES)) {
      const m = matchRoute(target.method, target.path.split('/'))
      expect(m, target.path).toMatchObject({ kind: 'hit', route: name })
      if (m?.kind === 'hit') expect(m.params, target.path).toEqual([])
    }
  })

  it('② 6 条参数路由各一实例 → param-hit 且 params 保真（id/key 原值，不解码）', () => {
    const cases: Array<{ route: ParamRouteName; method: string; segs: string[]; params: string[] }> = [
      { route: 'sourceProbe', method: 'POST', segs: ['sources', 'uuid-1', 'probe'], params: ['uuid-1'] },
      { route: 'sourceEnabled', method: 'POST', segs: ['sources', 'uuid-2', 'enabled'], params: ['uuid-2'] },
      { route: 'sourceAuth', method: 'POST', segs: ['sources', 'uuid-3', 'auth'], params: ['uuid-3'] },
      { route: 'sourceDelete', method: 'DELETE', segs: ['sources', 'uuid-4'], params: ['uuid-4'] },
      { route: 'shelfPut', method: 'PUT', segs: ['shelf', 'book%3Akey'], params: ['book%3Akey'] },
      { route: 'shelfDelete', method: 'DELETE', segs: ['shelf', 'other%2Fkey'], params: ['other%2Fkey'] },
    ]
    for (const c of cases) {
      const m = matchRoute(c.method, c.segs)
      expect(m, c.route).toMatchObject({ kind: 'param-hit', route: c.route })
      if (m?.kind === 'param-hit') expect(m.params, c.route).toEqual(c.params)
    }
  })

  it('③ POST sources/import → 静态命中，不落参数表', () => {
    expect(matchRoute('POST', ['sources', 'import']))
      .toMatchObject({ kind: 'hit', route: 'sourcesImport' })
  })

  it('④ DELETE sources/import → method-mismatch（需 POST；静态优先于参数，不当成删源）', () => {
    expect(matchRoute('DELETE', ['sources', 'import']))
      .toEqual({ kind: 'method-mismatch', expectedMethod: 'POST', pathForMessage: 'sources/import' })
  })

  it('⑤ GET sources/xyz → method-mismatch（需 DELETE；此前落 404 未知路由，行为收紧点）', () => {
    expect(matchRoute('GET', ['sources', 'xyz']))
      .toEqual({ kind: 'method-mismatch', expectedMethod: 'DELETE', pathForMessage: 'sources/:id' })
  })

  it('⑥ 垃圾尾段 GET shelf/batch-delete/extra → null（404 未知路由；此前忽略尾段照接）', () => {
    expect(matchRoute('GET', ['shelf', 'batch-delete', 'extra'])).toBeNull()
  })

  it('⑦ shelf/:key 方法全不中 → 取先出现的变体（PUT）做 method-mismatch', () => {
    expect(matchRoute('POST', ['shelf', 'k']))
      .toEqual({ kind: 'method-mismatch', expectedMethod: 'PUT', pathForMessage: 'shelf/:key' })
  })

  it('⑧ PARAM_PATTERN_PATHS 与 paramOps.at(样本).path 逐条相等（两处模板无编译期绑定，漂移在这里现形）', () => {
    for (const [name, pattern] of Object.entries(PARAM_PATTERN_PATHS) as Array<[ParamRouteName, string]>) {
      expect(paramOps[name].at(PARAM_SAMPLES[name]).path, name).toBe(pattern.replace(/:\w+/, PARAM_SAMPLES[name]))
    }
  })
})

let svc: ReadingService, base: string, close: () => Promise<void>
beforeAll(async () => {
  const dir = await makeTempDir('novel-routes-')
  svc = trackService(await ReadingService.create({
    dir,
    fetchImpl: async () => new Response('<html></html>', { headers: { 'content-type': 'text/html; charset=utf-8' } }),
  }))
  ;({ base, close } = await startServer(svc))
})
afterAll(async () => { await svc.flush(); await close() })

async function call<T = unknown>(route: string, method: string, body?: unknown): Promise<{ status: number; json: ApiEnvelope<T> }> {
  // 无体时不建 body/headers 键：显式 `undefined` 在 fetch 的 init 上非法（载荷类形状按缺席表达）
  const r = await fetch(`${base}${NOVEL_API_PREFIX}${route === '' ? '' : `/${route}`}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  })
  return { status: r.status, json: await envelopeOf<T>(r) }
}

/** 落点判据：不是「未知路由」404 */
const landed = (res: { status: number; json: ApiEnvelope<unknown> }): boolean => {
  const error = res.json.error
  return !(res.status === 404 && error !== undefined && error.message.startsWith('未知路由'))
}

/** 烟雾调用：判据只到落点，故非流路由读完整信封；两条观察流（path 以 job-stream 段收尾）读到
 *  首帧就断流——不掐的话活连接挂到 afterAll，真 http.Server 的 close 永远等不到（整文件超时）。
 *  掐流后没有错误信封可读，故流的落点证据由首帧承担（`framed` 标记、载荷随 `json` 带回）：
 *  未知路由 404 是 JSON 信封、没有 data 行，落回通用 `landed` 判负。 */
async function smoke(target: { method: string; path: string }): Promise<{ status: number; json: ApiEnvelope<unknown>; framed: boolean }> {
  if (!target.path.endsWith(`/${SEG.jobStream}`)) {
    return { ...await call(target.path, target.method), framed: false }
  }
  const ac = new AbortController()
  const res = await fetch(`${base}${NOVEL_API_PREFIX}/${target.path}`, { method: target.method, signal: ac.signal })
  const status = res.status
  const first = await res.body?.getReader().read()    // 首帧到手（空库是 {job:null} 基线帧）
  ac.abort()                              // 断流：不留活连接给 afterAll
  const text = new TextDecoder().decode(first?.value)
  const frame = text.split(/\r?\n/).find((line) => line.startsWith('data: '))
  // 帧不是信封：这里只当未知 JSON 承载，用例对它仅做「带 job 键」的断言
  return frame === undefined
    ? { status, json: JSON.parse(text) as ApiEnvelope<unknown>, framed: false }    // 错误信封（小，首块即全）
    : { status, json: JSON.parse(frame.slice('data: '.length)) as ApiEnvelope<unknown>, framed: true }
}

/** 参数路由的代表实例目标（客户端视角：原始值过构造器，编码由构造器负责） */
const paramTarget = (name: ParamRouteName): { method: string; path: string } => ({
  method: paramOps[name].method,
  path: paramOps[name].path(PARAM_SAMPLES[name]),
})

describe('全表烟雾：正确方法 → 落点（非未知路由 404）', () => {
  it('静态路由逐条落点', async () => {
    for (const [name, target] of Object.entries(ROUTES)) {
      const res = await smoke(target)
      if (res.framed) {
        // 观察流掐流后没有错误信封：落点判据换成「首帧可解析且带 job 键」（未知路由 404 没有 data 行，落回 landed 判负）
        expect(res.status, `${name} ${target.path}`).toBe(200)
        expect(res.json, `${name} ${target.path}`).toHaveProperty('job')
      } else {
        expect(landed(res), `${name} ${target.method} /${target.path}`).toBe(true)
      }
    }
  })

  it('参数路由逐条落点（各一代表实例）', async () => {
    for (const name of Object.keys(paramOps) as ParamRouteName[]) {
      const target = paramTarget(name)
      const res = await smoke(target)
      expect(landed(res), `${name} ${target.method} ${target.path}`).toBe(true)
    }
  })

  it('health → 200 与信封', async () => {
    const res = await call<{ name: string; apiVersion: number }>(ROUTES.health.path, 'GET')
    expect(res.status).toBe(200)
    expect(res.json).toMatchObject({ ok: true, value: { name: 'dsh-novel', apiVersion: 1 } })
  })

  it('sources/batch-delete 未知 id → removed:0（未知 id 静默跳过，不是失败）', async () => {
    const bd = await call<{ removed: number }>(ROUTES.sourcesBatchDelete.path, 'POST', { ids: ['nope'] })
    expect(bd.status).toBe(200)
    expect(must(bd.json.value, 'removed').removed).toBe(0)
  })

  it('reading 面 query 齐全 → 落点（searchPlan 空参与集；book/toc/chapter/navigation 落在源不存在）', async () => {
    // 搜索参与计划：参与集唯一主人在服务端，空库 → 空参与集
    const plan = await call<SearchPlan>(ROUTES.searchPlan.path, 'GET')
    expect(plan.status).toBe(200)
    expect(plan.json.value).toEqual({ sourceIds: [] })

    for (const r of [ROUTES.book, ROUTES.toc, ROUTES.chapter, ROUTES.navigation]) {
      const q = `sourceId=x&url=${encodeURIComponent('https://x/b')}${r === ROUTES.chapter ? '&index=0' : ''}`
      const res = await call(`${r.path}?${q}`, 'GET')
      expect(landed(res)).toBe(true)                       // 落在源不存在（requireSourceUrl 通过后）
    }
  })

  it('参数路由源不存在 → 404「源不存在」；sourceDelete → removed:false', async () => {
    // probe / enabled 带不存在的 id → 落在「源不存在」404（不是未知路由）
    const cases: Array<[string, unknown]> = [
      [paramOps.sourceProbe.path('nope'), {}],
      [paramOps.sourceEnabled.path('nope'), { enabled: true }],
    ]
    for (const [route, body] of cases) {
      const res = await call(route, 'POST', body)
      expect(res.status, route).toBe(404)
      expect(must(res.json.error, '错误信封').message.startsWith('源不存在'), route).toBe(true)
    }
    const del = await call<{ removed: boolean }>(paramOps.sourceDelete.path('nope'), 'DELETE')
    expect(del.status).toBe(200)
    expect(del.json.value).toEqual({ removed: false })
  })

  it('auth 路由：垃圾 body {}/未知源 → 400（body 形状分派先于存在性——此前存在性预检先回 404，行为收紧钉）；合法 body + 未知源 → 404「源不存在」', async () => {
    const bad = await call(paramOps.sourceAuth.path('nope'), 'POST', {})
    expect(bad.status).toBe(400)
    expect(must(bad.json.error, '错误信封').message.startsWith('body 需为')).toBe(true)
    // 404 通道仍活：形状过了 readBodies.auth，门内 requireSource 接棒（SourceNotFoundError 经 classify）
    const gone = await call(paramOps.sourceAuth.path('nope'), 'POST', { runLogin: true })
    expect(gone.status).toBe(404)
    expect(must(gone.json.error, '错误信封').message.startsWith('源不存在')).toBe(true)
  })

  it('本地三读口参数齐全 → 404「本地产物不存在」（不是未知路由）', async () => {
    for (const r of [`${ROUTES.localDocument.path}?id=x&documentId=d0`, `${ROUTES.localResource.path}?id=x&resourceId=r0`, `${ROUTES.localWarnings.path}?id=x`]) {
      const res = await call(r, 'GET')
      expect(res.status, r).toBe(404)
      expect(landed(res), r).toBe(true)
    }
  })
})

/** 错方法恒取路由表之外的 PATCH——不从被测表自己派生（表里方法配错时，派生期望会跟着错）。 */
describe('已知路由错方法 → 405（全表扫描）', () => {
  it('静态路由逐条：错方法 → 405 MethodNotAllowed', async () => {
    for (const [name, target] of Object.entries(ROUTES)) {
      const res = await call(target.path, 'PATCH')
      expect(res.status, `${name} ${target.path}`).toBe(405)
      expect(must(res.json.error, '错误信封').code, `${name} ${target.path}`).toBe('MethodNotAllowed')
    }
  })

  it('参数路由逐条：代表实例错方法 → 405（路径认得、方法不对）', async () => {
    for (const name of Object.keys(paramOps) as ParamRouteName[]) {
      const target = paramTarget(name)
      const res = await call(target.path, 'PATCH')
      expect(res.status, `${name} ${target.path}`).toBe(405)
      expect(must(res.json.error, '错误信封').code, `${name} ${target.path}`).toBe('MethodNotAllowed')
    }
  })

  it('GET sources/xyz → 405 需 DELETE（行为收紧钉子：此前落 404 未知路由）', async () => {
    const res = await call(`${ROUTES.sources.path}/xyz`, 'GET')
    expect(res.status).toBe(405)
    expect(must(res.json.error, '错误信封').code).toBe('MethodNotAllowed')
    expect(must(res.json.error, '错误信封').message).toBe('方法不允许: GET（/novel-api/sources/:id 需 DELETE）')
  })
})

describe('负对照', () => {
  it('未知路由 / 错误前缀仍是 404', async () => {
    const unknown = await call('nope', 'GET')
    expect(unknown.status).toBe(404)
    expect(must(unknown.json.error, '错误信封').message.startsWith('未知路由')).toBe(true)
    expect((await fetch(`${base}/other/sources`)).status).toBe(404)
  })

  it('shelf key 非法百分号编码 → 400（此前 URIError 归 other → 500）', async () => {
    const d = await fetch(`${base}${NOVEL_API_PREFIX}/shelf/%E0%A4%A`, { method: 'DELETE' })
    expect(d.status).toBe(400)
    expect((await errorOf(d)).code).toBe('BadRequest')
  })

  it('local part 缺席（from() 不传 local）→ 503 Unavailable（判据归门面动词）', async () => {
    const dir = await makeTempDir('novel-routes-nolocal-')
    const jar = new CookieJar()
    const bare = trackService(await ReadingService.from({
      registry: await SourceRegistry.load(dir),
      shelf: await Shelf.load(dir),
      cache: new PageCache(dir),
      fetcher: createFetcher({ cookieJar: jar }),
      cookieJar: jar,
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
        expect((await errorOf(r)).code).toBe('Unavailable')
      }
    } finally {
      await c2()
    }
  })

  it('SEG 每一段都被某条路由使用（单一真相自洽：无孤儿段、无手抄段）', () => {
    const used = new Set<string>()
    for (const r of Object.values(ROUTES)) for (const s of r.segs) used.add(s)
    for (const op of Object.values(paramOps)) for (const s of op.path('x').split('/')) used.add(s)
    for (const [name, seg] of Object.entries(SEG)) {
      expect(used.has(seg), `SEG.${name}（${seg}）未被任何路由使用`).toBe(true)
    }
  })
})
