import { describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { Config, apply, inject, name } from '../src/index.js'
import { ROUTES } from '../src/shared/wire.js'
import { makeTempDir } from './temp-dir.js'

function fakeCtx() {
  const calls: Array<{ kind: string; label?: string; route?: any; tool?: any }> = []
  const ctx = {
    effect: (fn: () => (() => void), label?: string) => {
      const d = fn()
      calls.push({ kind: 'off', label })
      disposers.push(() => { d() })
    },
    webServer: {
      register: (route: any) => { calls.push({ kind: 'route', route }); return () => calls.push({ kind: 'off-route' }) },
    },
    tools: {
      register: (tool: any) => { calls.push({ kind: 'tool', tool }); return () => calls.push({ kind: 'off-tool', tool }) },
    },
    /** 宿主 ctx.jobs 的假面：本入口只碰 attachController（准入闸）与 start（由 SourceJobs 经
     *  ReadingService 调，走同一个 host 对象，故这里也记下以便钉「任务登记到了宿主」）。 */
    jobs: {
      attachController: (n: string) => { calls.push({ kind: 'attach', label: n }); return () => calls.push({ kind: 'off-attach' }) },
      start: (spec: any) => { calls.push({ kind: 'job-start', route: spec }); return `${spec.kind}-1` },
    },
  }
  const disposers: Array<() => void> = []
  return { ctx: ctx as any, calls, disposeAll: () => { for (const d of disposers) d() } }
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))

/** 轮询等到条件成立，而不是硬等一个固定时长：全套 49 个文件并发跑时，异步 init 有可能超过
 *  固定窗口——断言先抛会让用例里的 disposeAll 不执行，模块级 applied 守卫永久置位，
 *  同文件后续用例被 "duplicate apply ignored" 级联带崩（实测：单跑该文件全绿、全套红 2 个）。
 *  等不到的用例仍会如常失败，只是不再污染同文件的其他用例。 */
async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!cond() && Date.now() < deadline) await tick()
}

describe('Cordis 插件入口', () => {
  // 注：@deepseek-ai/schemastery 的 schema 实例是可调用的（Config(data)），无 .parse 方法——
  // 调用形态按库实际 API 适配。
  it('身份与 Config（schemastery：全 optional + 外层 default({})）', () => {
    expect(name).toBe('@xrn1997/dsh-novel')
    expect(inject).toEqual(['webServer', 'tools', 'jobs'])
    expect(Config({})).toEqual({})
    expect(Config({ dataDir: 'D:/x' })).toEqual({ dataDir: 'D:/x' })
    expect(Config({ exportDelayMs: 500 })).toEqual({ exportDelayMs: 500 })
    expect(Config({ jsTimeoutMs: 30000 })).toEqual({ jsTimeoutMs: 30000 })   // js 沙箱预算出口（③）
    expect(() => Config({ dataDir: 1 } as any)).toThrow()       // 类型错在加载期响亮
    expect(Config(undefined as any)).toEqual({})                // .default({}) 防御：cordis 缺省 config 行
  })
  it('配置值域校验：searchParallel ≤ 0 加载期响亮失败（否则批循环 i+=0 永久挂起）', () => {
    expect(() => apply(fakeCtx().ctx, { dataDir: 'D:/x', searchParallel: 0 })).toThrow(/searchParallel/)
    expect(() => apply(fakeCtx().ctx, { dataDir: 'D:/x', searchParallel: -1 })).toThrow(/searchParallel/)
    expect(() => apply(fakeCtx().ctx, { dataDir: 'D:/x', searchTimeoutMs: 0 })).toThrow(/searchTimeoutMs/)
    expect(() => apply(fakeCtx().ctx, { dataDir: 'D:/x', jsTimeoutMs: 0 })).toThrow(/jsTimeoutMs/)
  })
  it('apply：ready 后注册 prefix 路由 + 5 工具；disposer 摘干净', async () => {
    const dir = await makeTempDir('novel-entry-')
    const { ctx, calls, disposeAll } = fakeCtx()
    try {
      apply(ctx, { dataDir: dir })
      // 任务准入闸：`start` 拒绝「没有已挂载 controller 服务该 owner」的工作，而宿主自带的
      // tool-jobs 在本机 web profile 里是 disabled → controller 必须由本插件自己挂。
      expect(calls.filter((c) => c.kind === 'attach').map((c) => c.label)).toEqual(['dsh-novel'])
      await waitFor(() => calls.some((c) => c.kind === 'route'))
      const routes = calls.filter((c) => c.kind === 'route')
      expect(routes).toHaveLength(1)
      expect(routes[0].route).toMatchObject({ kind: 'prefix', path: '/novel-api' })
      expect(typeof routes[0].route.handler).toBe('function')
      await waitFor(() => calls.filter((c) => c.kind === 'tool').length === 5)
      expect(calls.filter((c) => c.kind === 'tool')).toHaveLength(5)
      disposeAll()
      expect(calls.filter((c) => c.kind === 'off-route')).toHaveLength(1)
      expect(calls.filter((c) => c.kind === 'off-tool')).toHaveLength(5)
      expect(calls.some((c) => c.kind === 'off-attach')).toBe(true)   // controller 随 fiber 摘掉
    } finally { disposeAll() }        // 断言失败也要复位 applied 守卫，别污染后续用例（目录归 setup.ts 登记簿）
  })
  it('ready 前 disposer：不注册也不漏', async () => {
    const dir = await makeTempDir('novel-entry2-')
    const { ctx, calls, disposeAll } = fakeCtx()
    apply(ctx, { dataDir: dir })
    disposeAll()                       // ready 未到就卸载
    await tick(200)                    // 等过 ready 窗口，确认之后也不会补注册
    expect(calls.filter((c) => c.kind === 'route')).toHaveLength(0)
    expect(calls.filter((c) => c.kind === 'tool')).toHaveLength(0)
  })
  it('初始化失败（dataDir 指向文件）：不炸、零注册', async () => {
    // mkdtemp 建目录再换成文件：Date.now() 命名在同一毫秒内会撞已存在路径（writeFile EEXIST）
    const dir = await makeTempDir('novel-entry3-')
    await fs.rmdir(dir)
    const file = dir
    await fs.writeFile(file, 'not a dir', 'utf8')
    const { ctx, calls, disposeAll } = fakeCtx()
    try {
      apply(ctx, { dataDir: file })
      await tick(200)
      expect(calls.filter((c) => c.kind === 'route')).toHaveLength(0)
      expect(calls.filter((c) => c.kind === 'tool')).toHaveLength(0)
    } finally {
      disposeAll()
    }
  })
  it('双重启用防御：第二次 apply 零注册；dispose 后可再注册（HMR 复位）', async () => {
    const dir = await makeTempDir('novel-entry4-')
    const a = fakeCtx()
    const c = fakeCtx()
    try {
      apply(a.ctx, { dataDir: dir })
      await waitFor(() => a.calls.some((x) => x.kind === 'route'))
      expect(a.calls.filter((x) => x.kind === 'route')).toHaveLength(1)
      const b = fakeCtx()
      apply(b.ctx, { dataDir: dir })            // 双启用（bundles+插槽）
      await tick(150)
      expect(b.calls.filter((x) => x.kind === 'route')).toHaveLength(0)   // 被防御拦下
      a.disposeAll()
      await tick()
      apply(c.ctx, { dataDir: dir })            // HMR：旧实例已卸载
      await waitFor(() => c.calls.some((x) => x.kind === 'route'))
      expect(c.calls.filter((x) => x.kind === 'route')).toHaveLength(1)   // 标志已复位，可注册
    } finally {
      a.disposeAll()
      c.disposeAll()
    }
  })

  /** 目标①的落点钉子：三种 kind 都要真的抵达宿主 `ctx.jobs`。
   *  走的是**组合根**——`apply` → `ReadingService.create({ jobHost: c.jobs })` → `from()` →
   *  `SourceJobs` / `SearchJobs` 各持 host。这条链上任何一跳丢了参数，其余测试仍然全绿
   *  （`search-job`/`import-job` 的单测直构持有者、门面测试不传 host），而真机上没有一条任务
   *  会出现在宿主注册表里。故这里用假宿主 + 真 http 口端到端钉一次。 */
  it('apply：novel-import / novel-probe / novel-search 三类任务都登记给宿主 ctx.jobs', async () => {
    const dir = await makeTempDir('novel-entry-jobs-')
    const { ctx, calls, disposeAll } = fakeCtx()
    let server: http.Server | null = null
    try {
      apply(ctx, { dataDir: dir })
      await waitFor(() => calls.some((c) => c.kind === 'route'))
      const handler = calls.find((c) => c.kind === 'route')!.route.handler as
        (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>
      server = http.createServer((req, res) => { void handler(req, res).catch(() => { /* handler 内部已兜底 */ }) })
      await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/novel-api/`
      const post = async (path: string, body: unknown): Promise<void> => {
        const r = await fetch(base + path, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
        })
        expect(r.status, path).toBe(200)
      }
      /** 两个写任务共用一槽：不等上一条收尾，下一条就是 409 */
      const settleWrite = async (): Promise<void> => {
        for (let i = 0; i < 500; i++) {
          const j = ((await (await fetch(base + ROUTES.sourcesJobStatus.path)).json() as any).value.job)
          if (j === null || j.phase !== 'running') return
          await tick(5)
        }
        throw new Error('写任务未在限时内收尾')
      }

      await post(ROUTES.sourcesImport.path, { files: [{ name: 'a.json', text: '[]' }] })
      await settleWrite()
      await post(ROUTES.sourcesBatchProbe.path, { ids: ['nope'] })
      await settleWrite()
      await post(ROUTES.searchJob.path, { keyword: '斗罗' })       // 空库：零源零请求，不碰外网

      expect(calls.filter((c) => c.kind === 'job-start').map((c) => c.route.kind))
        .toEqual(['novel-import', 'novel-probe', 'novel-search'])
    } finally {
      if (server !== null) await new Promise<void>((r) => { server!.close(() => r()) })
      disposeAll()
    }
  })
})
