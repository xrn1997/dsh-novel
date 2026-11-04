import { describe, expect, it, vi } from 'vitest'
import { existsSync, promises as fs } from 'node:fs'
import http from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import { Config, apply, inject, name } from '../src/index.js'
import type { NovelConfig } from '../src/index.js'
import { DEFAULT_TIMEOUT_MS } from '../src/services/fetcher.js'
import { log, setLogSink } from '../src/services/log.js'
import { ROUTES } from '../src/shared/wire.js'
import { must } from './support/fixture.js'
import { makeTempDir } from './temp-dir.js'

/** 宿主面的窄镜像（只覆盖组合根取用的成员）：真形状由 cordis 的 `Context` 与三个 declare module
 *  增强持有，本仓不装那几个包——假面在**位置**上顶替它，成员形状在此声明一次。 */
interface FakeRoute { kind: 'prefix'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }
interface FakeTool { name: string; execute(args: unknown, exec: never): Promise<unknown> }
interface FakeLogger { info(...args: unknown[]): void; warn(...args: unknown[]): void; error(...args: unknown[]): void }
interface FakeCtx {
  /** 缺成员的两条腿按可缺席建模：tests 里要故意拔掉它们验「响亮失败且不锁死 applied」 */
  logger?: ((name: string) => FakeLogger) | undefined
  on?: ((event: string, listener: (...args: unknown[]) => void) => () => boolean) | undefined
  effect: (fn: () => () => void, label?: string) => void
  webServer: { register(route: FakeRoute): () => void }
  tools: { register(tool: FakeTool): () => void }
  jobs: { attachController(name: string): () => void; start(spec: { kind: string }): string }
}

/** 一次宿主调用：kind 是判别键，载荷跟着 kind 走（filter 之后读到的就是那一支的形状） */
type Recorded =
  | { kind: 'off'; label?: string }
  | { kind: 'off-route' | 'off-tool' | 'off-attach' }
  | { kind: 'attach'; label: string }
  | { kind: 'route'; route: FakeRoute }
  | { kind: 'tool'; tool: FakeTool }
  | { kind: 'job-start'; route: { kind: string } }

/** 判别键收窄：find/filter 的谓词显式写成类型守卫，取到的就是那一支的形状 */
type CallOf<K extends Recorded['kind']> = Extract<Recorded, { kind: K }>
const isAttach = (c: Recorded): c is CallOf<'attach'> => c.kind === 'attach'
const isRoute = (c: Recorded): c is CallOf<'route'> => c.kind === 'route'
const isTool = (c: Recorded): c is CallOf<'tool'> => c.kind === 'tool'
const isJobStart = (c: Recorded): c is CallOf<'job-start'> => c.kind === 'job-start'

/** 落盘读数：`shelf.json` 的首项 progress 位（形状不符就抛，不静默断言过） */
function firstProgressOf(json: unknown): unknown {
  if (!Array.isArray(json)) throw new Error('shelf.json 顶层不是数组')
  const first: unknown = json[0]
  if (typeof first !== 'object' || first === null || !('progress' in first)) throw new Error('shelf.json 首项缺 progress')
  return first.progress
}

/** 状态读口的 job 位：null = 没有在跑的任务（`value.job` 的契约形状） */
function jobOf(body: unknown): { phase?: unknown } | null {
  if (typeof body !== 'object' || body === null || !('value' in body)) throw new Error(`状态读口不是 { value }：${JSON.stringify(body)}`)
  const value = body.value
  if (typeof value !== 'object' || value === null || !('job' in value)) throw new Error('状态读口缺 value.job')
  const job = value.job
  if (job === null) return null
  if (typeof job !== 'object') throw new Error('状态读口的 job 既不是 null 也不是对象')
  return job
}

/** 装进组合根：cordis 的 `Context` 是宿主的完整面，假面按位置顶替（窄镜像口径，同 ADR-0020） */
function mount(ctx: FakeCtx, config?: NovelConfig): void { apply(ctx as never, config) }

function fakeCtx() {
  const calls: Recorded[] = []
  const logs: Array<{ name: string; level: string; args: unknown[] }> = []
  /** 宿主日志服务面（官方 Context 成员，入口不再窄镜像它）：`ctx.logger(name)` 返回按级别的
   *  命名 logger，severity 方法收变参（宿主的 printf 口径是「format + rest」）。假面挂本仓
   *  日志缝用到的三级——info/warn/error。 */
  const namedLogger = (name: string): FakeLogger => ({
    info: (...args: unknown[]) => { logs.push({ name, level: 'info', args }) },
    warn: (...args: unknown[]) => { logs.push({ name, level: 'warn', args }) },
    error: (...args: unknown[]) => { logs.push({ name, level: 'error', args }) },
  })
  /** 宿主事件面（cordis 的 `ctx.on`）：`loader/volatile-update` 是配置热更的信号口，
   *  假面按事件名收 listener，`emit` 按名分发。disposer 必须真摘 handler——否则「dispose 后
   *  不再留痕」这条性质在假宿主上无从验证（disposer 若返 no-op，监听就会活过卸载）。 */
  const handlers: Array<{ event: string; listener: (...args: unknown[]) => void }> = []
  const ctx: FakeCtx = {
    logger: namedLogger,
    on: (event: string, listener: (...args: unknown[]) => void) => {
      const entry = { event, listener }
      handlers.push(entry)
      return () => {
        const i = handlers.indexOf(entry)
        if (i !== -1) handlers.splice(i, 1)
        return true
      }
    },
    effect: (fn: () => (() => void), label?: string) => {
      const d = fn()
      // 无标签时不建这个键（缺席与「值是 undefined」在记录里是两件事）
      calls.push(label === undefined ? { kind: 'off' } : { kind: 'off', label })
      disposers.push(() => { d() })
    },
    webServer: {
      register: (route: FakeRoute) => { calls.push({ kind: 'route', route }); return () => calls.push({ kind: 'off-route' }) },
    },
    tools: {
      register: (tool: FakeTool) => { calls.push({ kind: 'tool', tool }); return () => calls.push({ kind: 'off-tool' }) },
    },
    /** 宿主 ctx.jobs 的假面：本入口只碰 attachController（准入闸）与 start（由 SourceJobs 经
     *  ReadingService 调，走同一个 host 对象，故这里也记下以便钉「任务登记到了宿主」）。 */
    jobs: {
      attachController: (n: string) => { calls.push({ kind: 'attach', label: n }); return () => calls.push({ kind: 'off-attach' }) },
      start: (spec: { kind: string }) => { calls.push({ kind: 'job-start', route: spec }); return `${spec.kind}-1` },
    },
  }
  const disposers: Array<() => void> = []
  return {
    ctx,
    calls,
    logs,
    emit: (event: string, ...args: unknown[]) => {
      for (const h of handlers) if (h.event === event) h.listener(...args)
    },
    disposeAll: () => { for (const d of disposers) d() },
  }
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))

/** 断言过长度的取项：取不到即本用例自身失效——响亮抛，不用 ?. 把缺席读成 undefined */
function mustAt<T>(items: readonly T[], i: number): T {
  const v = items[i]
  if (v === undefined) throw new Error(`第 ${i} 项缺席（前面的长度断言已失效）`)
  return v
}

/** `Config` 调用结果的一格：库的输出面是 `Dict`（索引签名 any），这里按 unknown 判形收窄 */
function fieldOf(cfg: unknown, field: string): unknown {
  return typeof cfg === 'object' && cfg !== null ? (cfg as Record<string, unknown>)[field] : undefined
}

interface RefLike { get(): unknown }

/** 一格 volatile 字段的读数：不是 ref 就说明 schema 掉档，响亮抛 */
function isRef(value: unknown): value is RefLike {
  return typeof value === 'object' && value !== null && 'get' in value && typeof value.get === 'function'
}
function refOf(cfg: unknown, field: string): unknown {
  const value = fieldOf(cfg, field)
  if (!isRef(value)) throw new Error(`Config.${field} 不是 volatile ref`)
  return value.get()
}

/** 轮询等到条件成立，而不是硬等一个固定时长：全套并发跑时，异步 init 有可能超过
 *  固定窗口——断言先抛会让用例里的 disposeAll 不执行，模块级 applied 守卫永久置位，
 *  同文件后续用例被 "duplicate apply ignored" 级联带崩。
 *  等不到的用例仍会如常失败，只是不再污染同文件的其他用例。 */
async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!cond() && Date.now() < deadline) await tick()
}

describe('Cordis 插件入口', () => {
  // 注：@deepseek-ai/schemastery 的 schema 实例是可调用的（Config(data)），无 .parse 方法——
  // 调用形态按库实际 API 适配。
  it('身份与 Config（schemastery：默认值与值域都住 schema，外层 default({}) 兜 cordis 缺省行）', () => {
    expect(name).toBe('@xrn1997/dsh-novel')
    expect(inject).toEqual(['webServer', 'tools', 'jobs'])
    // `Config` 的调用结果在 schemastery 里是 `Dict`（索引签名 any）：按 ref / 纯值判形读一次
    const cfg = Config({})
    expect(refOf(cfg, 'searchTimeoutMs')).toBe(DEFAULT_TIMEOUT_MS)
    expect(refOf(Config(undefined), 'searchTimeoutMs')).toBe(DEFAULT_TIMEOUT_MS)
    expect(fieldOf(Config({ dataDir: 'D:/x' }), 'dataDir')).toBe('D:/x')
    expect(() => Config({ dataDir: 1 })).toThrow()
  })
  it('配置值域校验：searchParallel ≤ 0 加载期响亮失败（否则批循环 i+=0 永久挂起）', () => {
    expect(() => mount(fakeCtx().ctx, { dataDir: 'D:/x', searchParallel: 0 })).toThrow(/配置非法/)
    expect(() => mount(fakeCtx().ctx, { dataDir: 'D:/x', searchParallel: -1 })).toThrow(/配置非法/)
    expect(() => mount(fakeCtx().ctx, { dataDir: 'D:/x', searchTimeoutMs: 0 })).toThrow(/配置非法/)
    expect(() => mount(fakeCtx().ctx, { dataDir: 'D:/x', jsTimeoutMs: 0 })).toThrow(/配置非法/)
  })
  it('apply：ready 后注册 prefix 路由 + 6 工具；disposer 摘干净', async () => {
    const dir = await makeTempDir('novel-entry-')
    const { ctx, calls, disposeAll } = fakeCtx()
    try {
      mount(ctx, { dataDir: dir })
      // 任务准入闸：`start` 拒绝「没有已挂载 controller 服务该 owner」的工作，而宿主自带的
      // tool-jobs 在本机 web profile 里是 disabled → controller 必须由本插件自己挂。
      expect(calls.filter(isAttach).map((c) => c.label)).toEqual(['dsh-novel'])
      await waitFor(() => calls.some((c) => c.kind === 'route'))
      const routes = calls.filter(isRoute)
      expect(routes).toHaveLength(1)
      const route = mustAt(routes, 0)
      expect(route.route).toMatchObject({ kind: 'prefix', path: '/novel-api' })
      expect(typeof route.route.handler).toBe('function')
      await waitFor(() => calls.filter((c) => c.kind === 'tool').length === 6)
      expect(calls.filter((c) => c.kind === 'tool')).toHaveLength(6)
      disposeAll()
      expect(calls.filter((c) => c.kind === 'off-route')).toHaveLength(1)
      expect(calls.filter((c) => c.kind === 'off-tool')).toHaveLength(6)
      expect(calls.some((c) => c.kind === 'off-attach')).toBe(true)   // controller 随 fiber 摘掉
    } finally { disposeAll() }        // 断言失败也要复位 applied 守卫，别污染后续用例（目录归 setup.ts 登记簿）
  })
  it('dispose：书架防抖写落地（宿主重启前的最后一条进度不许丢在窗口里）', async () => {
    const dir = await makeTempDir('novel-flush-')
    const { ctx, calls, disposeAll } = fakeCtx()
    try {
      mount(ctx, { dataDir: dir })
      await waitFor(() => calls.filter((c) => c.kind === 'tool').length === 6)
      const shelf = must(calls.find((c): c is CallOf<'tool'> => isTool(c) && c.tool.name === 'dshnovel_shelf'), 'dshnovel_shelf 工具').tool
      // **冻结防抖窗口**再写入：定时器一旦被假造，100ms 那笔永远不会自己到点——此后文件只可能由
      // 「卸载即落盘」写出来。旧口径靠 wall-clock 判（6×10ms 压在 100ms 窗口内），负载下会抖：
      // 慢机器上窗口先到点，断言的就不是这条性质了。setImmediate 留给真实 I/O 轮询。
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
      // 工具体只从 exec.signal 取取消位（可选链，同 tests/tools）：按位置交一份最小面即可
      await shelf.execute({ action: 'add', bookKey: 'k', title: '书', sourceId: 's' }, {} as never)
      await shelf.execute({ action: 'save_progress', bookKey: 'k', chapterIndex: 7, offsetRatio: 0.5 }, {} as never)
      disposeAll()                                   // 立刻卸载
      const file = path.join(dir, 'shelf.json')
      for (let i = 0; i < 2000 && !existsSync(file); i++) await new Promise((r) => setImmediate(r))
      expect(existsSync(file), '卸载后防抖窗口里的进度没有落盘（flush 未接线）').toBe(true)
      const onDisk: unknown = JSON.parse(await fs.readFile(file, 'utf8'))
      expect(firstProgressOf(onDisk)).toMatchObject({ chapterIndex: 7, offsetRatio: 0.5 })
    } finally {
      vi.useRealTimers()
      disposeAll()
    }
  })
  it('ready 前 disposer：不注册也不漏', async () => {
    const dir = await makeTempDir('novel-entry2-')
    const { ctx, calls, disposeAll } = fakeCtx()
    mount(ctx, { dataDir: dir })
    disposeAll()                       // ready 未到就卸载
    await tick(200)                    // 等过 ready 窗口，确认之后也不会补注册
    expect(calls.filter((c) => c.kind === 'route')).toHaveLength(0)
    expect(calls.filter((c) => c.kind === 'tool')).toHaveLength(0)
  })
  it('loader/volatile-update：变更路径进日志', async () => {
    const dir = await makeTempDir('novel-volatile-')
    const { ctx, calls, logs, emit, disposeAll } = fakeCtx()
    try {
      mount(ctx, { dataDir: dir })
      await waitFor(() => calls.some((c) => c.kind === 'route'))
      emit('loader/volatile-update', [['searchParallel']])
      await waitFor(() => logs.some((l) => l.args.some((a) => String(a).includes('配置热更: searchParallel'))), 1500)
      expect(
        logs.some((l) => l.args.some((a) => String(a).includes('配置热更: searchParallel'))),
        '变更路径没有进日志（volatile 热更在配置页上是静默的）',
      ).toBe(true)
    } finally {
      disposeAll()
    }
  })
  /** 现行 Loader 的载荷是顶层 `string[][]`（0.2.1-rc.2 实测）。这两条钉的是跨版本硬化：
   *  旧代次 / 异形载荷上监听器只许留下可读痕迹，不许把宿主的配置保存派发带崩。 */
  it('loader/volatile-update：字符串载荷不抛、照常留痕', async () => {
    const dir = await makeTempDir('novel-volatile-str-')
    const { ctx, calls, logs, emit, disposeAll } = fakeCtx()
    try {
      mount(ctx, { dataDir: dir })
      await waitFor(() => calls.some((c) => c.kind === 'route'))
      expect(() => emit('loader/volatile-update', 'searchParallel')).not.toThrow()
      const hit = () => logs.some((l) => l.args.some((a) => String(a).includes('配置热更: searchParallel')))
      await waitFor(hit, 1500)
      expect(hit(), '字符串载荷没有进日志').toBe(true)
    } finally {
      disposeAll()
    }
  })
  it('loader/volatile-update：混合/嵌套载荷不抛，逐段可读且代理仍会重算', async () => {
    const dir = await makeTempDir('novel-volatile-mixed-')
    const { ctx, calls, logs, emit, disposeAll } = fakeCtx()
    const proxyLines = () => logs.filter((l) => l.args.some((a) => String(a).includes('出站代理:')))
    try {
      mount(ctx, { dataDir: dir })
      await waitFor(() => calls.some((c) => c.kind === 'route'))
      const before = proxyLines().length
      expect(() => emit('loader/volatile-update', [['searchParallel'], 'proxyUrl', ['a', 'b'], 42])).not.toThrow()
      const changedLine = () =>
        logs.some((l) => l.args.some((a) => String(a) === '配置热更: searchParallel, proxyUrl, a.b, 42'))
      await waitFor(changedLine, 1500)
      expect(changedLine(), '混合载荷的路径没有逐段留痕').toBe(true)
      await waitFor(() => proxyLines().length > before, 1500)
      expect(proxyLines().length, '字符串形态的顶层 proxyUrl 没触发热更重算').toBe(before + 1)
    } finally {
      disposeAll()
    }
  })
  it('代理留痕脱敏：初始与 volatile 热更都不回显 userinfo 密码', async () => {
    const dir = await makeTempDir('novel-proxy-log-')
    const { ctx, calls, logs, emit, disposeAll } = fakeCtx()
    const proxyLines = () => logs.filter((l) => l.args.some((a) => String(a).includes('出站代理:')))
    try {
      mount(ctx, { dataDir: dir, proxyUrl: 'http://user:pass@127.0.0.1:9' })
      await waitFor(() => calls.some((c) => c.kind === 'route'))
      await waitFor(() => proxyLines().length >= 1)
      emit('loader/volatile-update', [['proxyUrl']])
      await waitFor(() => proxyLines().length >= 2, 1500)
      expect(proxyLines().length, '初始与热更各应留一条代理日志').toBeGreaterThanOrEqual(2)
      for (const l of proxyLines()) {
        expect(l.args.some((a) => String(a).includes('pass')), '代理日志漏出 userinfo 密码').toBe(false)
        expect(l.args.some((a) => String(a).includes('***@127.0.0.1:9'))).toBe(true)
      }
    } finally {
      disposeAll()
    }
  })
  it('dispose：volatile 监听随 effect 摘除（卸载后 emit 不再留痕）', async () => {
    const dir = await makeTempDir('novel-volatile-off-')
    const { ctx, calls, logs, emit, disposeAll } = fakeCtx()
    try {
      mount(ctx, { dataDir: dir })
      await waitFor(() => calls.some((c) => c.kind === 'route'))
      emit('loader/volatile-update', [['searchParallel']])
      await waitFor(() => logs.some((l) => l.args.some((a) => String(a).includes('配置热更: searchParallel'))), 1500)
      disposeAll()
      // sink 随卸载复位回 console：残留的监听会走 console.info 而不是假宿主 logger，故盯那一腿。
      const seen: string[] = []
      const spy = vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => { seen.push(args.map(String).join(' ')) })
      try {
        emit('loader/volatile-update', [['searchParallel']])
      } finally {
        spy.mockRestore()
      }
      expect(
        seen.filter((line) => line.includes('配置热更')),
        '卸载后 on 的 disposer 没摘 handler，监听仍在留痕',
      ).toEqual([])
    } finally {
      disposeAll()
    }
  })
  it('ctx.on 缺失时 apply 抛错但不锁死 applied（监听注册排在守卫置位之前）', async () => {
    const dir = await makeTempDir('novel-volatile-no-on-')
    const bad = fakeCtx()
    bad.ctx.on = undefined
    expect(() => mount(bad.ctx, { dataDir: dir })).toThrow(/on is not a function/)
    const good = fakeCtx()
    try {
      mount(good.ctx, { dataDir: dir })
      await waitFor(() => good.calls.some((c) => c.kind === 'route'))
      expect(good.calls.filter((c) => c.kind === 'route')).toHaveLength(1)
    } finally {
      good.disposeAll()
    }
  })
  it('初始化失败（dataDir 指向文件）：不炸、零注册', async () => {
    // mkdtemp 建目录再换成文件：Date.now() 命名在同一毫秒内会撞已存在路径（writeFile EEXIST）
    const dir = await makeTempDir('novel-entry3-')
    await fs.rmdir(dir)
    const file = dir
    await fs.writeFile(file, 'not a dir', 'utf8')
    const { ctx, calls, disposeAll } = fakeCtx()
    try {
      mount(ctx, { dataDir: file })
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
      mount(a.ctx, { dataDir: dir })
      await waitFor(() => a.calls.some((x) => x.kind === 'route'))
      expect(a.calls.filter((x) => x.kind === 'route')).toHaveLength(1)
      const b = fakeCtx()
      mount(b.ctx, { dataDir: dir })            // 双启用（bundles+插槽）
      await tick(150)
      expect(b.calls.filter((x) => x.kind === 'route')).toHaveLength(0)   // 被防御拦下
      a.disposeAll()
      await tick()
      mount(c.ctx, { dataDir: dir })            // HMR：旧实例已卸载
      await waitFor(() => c.calls.some((x) => x.kind === 'route'))
      expect(c.calls.filter((x) => x.kind === 'route')).toHaveLength(1)   // 标志已复位，可注册
    } finally {
      a.disposeAll()
      c.disposeAll()
    }
  })

  /** 日志缝的运行时 adapter 是**双腿**：宿主 `ctx.logger` 只进 ring buffer 且默认级别吞 warn，
   *  只走那条腿本机 stdout 就看不见了。这条用例同时钉两件事——组合根真的装了 sink（漏装的话缝
   *  一路走缺省 console，其余用例照样全绿），以及两条腿收到的是同一条消息。 */
  it('apply：运行时 logger adapter 双腿装上了（console 与 ctx.logger 各收到一条）', async () => {
    const dir = await makeTempDir('novel-log-')
    const a = fakeCtx()
    const b = fakeCtx()
    const seen: unknown[][] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { seen.push(args) })
    try {
      mount(a.ctx, { dataDir: dir })
      expect(seen, '装 adapter 这一步本身不该吭声').toEqual([])
      expect(a.logs, '装 adapter 这一步本身不该吭声').toEqual([])
      mount(b.ctx, { dataDir: dir })     // 第二次撞双重启用守卫 → 经缝发一条 error（warn 会被宿主级别闸吞掉）
      expect(seen, 'console 腿没收到（stdout 变暗）').toHaveLength(1)
      const errorArgs = mustAt(seen, 0)
      expect(errorArgs[0]).toBe('[dsh-novel]')
      expect(String(errorArgs[1])).toContain('duplicate apply ignored')
      expect(a.logs).toHaveLength(1)
      const errorLog = mustAt(a.logs, 0)
      expect(errorLog).toMatchObject({ name: 'dsh-novel', level: 'error' })
      expect(errorLog.args).toEqual(['[dsh-novel]', expect.stringContaining('duplicate apply ignored')])
    } finally {
      spy.mockRestore()
      a.disposeAll()
      b.disposeAll()
    }
  })

  /** `named.error` 腿 + `hostArgs()` 成形层的钉子：缝把前缀当首参、消息本体与尾随 Error 按 rest 递，
   *  组合根的 adapter 用 `hostArgs(a)` 成形后才喂得进宿主的「format + rest」severity 方法。假面的
   *  severity 签名是 `(...args: unknown[])`、不塌缩 Error，所以只有这条能验出「Error 已转成形」——
   *  有人把 `hostArgs(a)` 换回 `...a`，logger 腿收到的仍是 Error 实例（真机上会塌成 `{}`），这里就红。 */
  it('apply：log.error 尾随的 Error 在 logger 腿被 hostArgs 成形为文本', async () => {
    const dir = await makeTempDir('novel-log-error-')
    const a = fakeCtx()
    const seen: unknown[][] = []
    const err = new Error('boom')
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { seen.push(args) })
    try {
      mount(a.ctx, { dataDir: dir })          // 组合根把双腿 adapter 装进模块级 sink
      log.error('x', err)                      // 经缝 → adapter.error 腿
      const shaped = must(a.logs.find((l) => l.level === 'error'), 'logger 腿没收到 error')
      expect(shaped.args[0]).toBe('[dsh-novel]')          // format 位是缝缀的前缀
      expect(shaped.args[1]).toBe('x')
      expect(shaped.args[2]).not.toBeInstanceOf(Error)    // 换回 `...a` 时这里红：Error 未成形
      expect(typeof shaped.args[2], 'Error 应被转成形为文本').toBe('string')
      expect(String(shaped.args[2])).toContain('boom')
      // console 腿收到同一条（前缀 + 消息本体 + **原样 Error**：成形只发生在 logger 腿）
      expect(seen).toHaveLength(1)
      const errorArgs = mustAt(seen, 0)
      expect(errorArgs[0]).toBe('[dsh-novel]')
      expect(errorArgs[1]).toBe('x')
      expect(errorArgs[2]).toBe(err)
    } finally {
      spy.mockRestore()
      setLogSink(console)                      // 复位模块级 sink，别把这条 adapter 漏给后续用例
      a.disposeAll()
    }
  })

  it('dispose：日志 sink 复位到 console（模块级单点不指向已卸载实例）', async () => {
    const dir = await makeTempDir('novel-log-dispose-')
    const a = fakeCtx()
    mount(a.ctx, { dataDir: dir })
    a.disposeAll()
    const seen: unknown[][] = []
    const spy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { seen.push(args) })
    try {
      log.warn('after dispose')
      expect(seen).toHaveLength(1)
      const warnArgs = mustAt(seen, 0)
      expect(warnArgs[0]).toBe('[dsh-novel]')
      expect(String(warnArgs[1])).toBe('after dispose')
    } finally {
      spy.mockRestore()
    }
  })

  it('ready 后注册失败：经日志缝留痕，且不带重复的满名', async () => {
    const dir = await makeTempDir('novel-log-register-')
    const a = fakeCtx()
    a.ctx.webServer.register = () => { throw new Error('register boom') }
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      mount(a.ctx, { dataDir: dir })
      await waitFor(() => a.logs.some((l) => l.level === 'error'))
      const hit = must(a.logs.find((l) => l.level === 'error'), 'logger 腿的 error 留痕')
      expect(String(hit.args[1])).toContain('/novel-api routes registration failed')
      expect(String(hit.args[1])).not.toContain('dsh-novel: /novel-api routes')
      expect(hit.args[2]).not.toBeInstanceOf(Error)     // logger 腿同样过 hostArgs 成形
    } finally {
      spy.mockRestore()
      a.disposeAll()
    }
  })

  it('ctx.logger 缺失时 apply 抛错但不锁死 applied（下一次 apply 仍能注册）', async () => {
    const dir = await makeTempDir('novel-log-nologger-')
    const bad = fakeCtx()
    bad.ctx.logger = () => { throw new Error('no logger') }
    expect(() => mount(bad.ctx, { dataDir: dir })).toThrow(/no logger/)
    const good = fakeCtx()
    try {
      mount(good.ctx, { dataDir: dir })
      await waitFor(() => good.calls.some((c) => c.kind === 'route'))
      expect(good.calls.filter((c) => c.kind === 'route')).toHaveLength(1)
    } finally {
      good.disposeAll()
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
      mount(ctx, { dataDir: dir })
      await waitFor(() => calls.some((c) => c.kind === 'route'))
      const handler = must(calls.find(isRoute), '/novel-api 路由注册').route.handler
      const srv = http.createServer((req, res) => {
        void Promise.resolve(handler(req, res)).catch(() => { /* handler 内部已兜底 */ })
      })
      server = srv
      await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
      const address = srv.address()
      if (address === null || typeof address === 'string') throw new Error('测试服务器没有取到监听地址')
      const base = `http://127.0.0.1:${address.port}/novel-api/`
      const post = async (path: string, body: unknown): Promise<void> => {
        const r = await fetch(base + path, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
        })
        expect(r.status, path).toBe(200)
      }
      /** 两个写任务共用一槽：不等上一条收尾，下一条就是 409 */
      const settleWrite = async (): Promise<void> => {
        for (let i = 0; i < 500; i++) {
          const j = jobOf(await (await fetch(base + ROUTES.sourcesJobStatus.path)).json())
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

      expect(calls.filter(isJobStart).map((c) => c.route.kind))
        .toEqual(['novel-import', 'novel-probe', 'novel-search'])
    } finally {
      if (server !== null) {
        const srv = server
        await new Promise<void>((r) => { srv.close(() => r()) })
      }
      disposeAll()
    }
  })
})
