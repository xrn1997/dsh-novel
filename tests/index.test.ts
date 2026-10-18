import { describe, expect, it, vi } from 'vitest'
import { existsSync, promises as fs } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { Config, apply, inject, name } from '../src/index.js'
import { DEFAULT_TIMEOUT_MS } from '../src/services/fetcher.js'
import { log, setLogSink } from '../src/services/log.js'
import { ROUTES } from '../src/shared/wire.js'
import { makeTempDir } from './temp-dir.js'

function fakeCtx() {
  const calls: Array<{ kind: string; label?: string; route?: any; tool?: any }> = []
  const logs: Array<{ name: string; level: string; args: unknown[] }> = []
  /** 宿主日志服务面（官方 Context 成员，入口不再窄镜像它）：`ctx.logger(name)` 返回按级别的
   *  命名 logger，severity 方法收变参（宿主的 printf 口径是「format + rest」）。假面挂本仓
   *  日志缝用到的三级——info/warn/error。 */
  const namedLogger = (name: string) => ({
    info: (...args: unknown[]) => { logs.push({ name, level: 'info', args }) },
    warn: (...args: unknown[]) => { logs.push({ name, level: 'warn', args }) },
    error: (...args: unknown[]) => { logs.push({ name, level: 'error', args }) },
  })
  /** 宿主事件面（cordis 的 `ctx.on`）：`loader/volatile-update` 是配置热更的信号口，
   *  假面按事件名收 listener，`emit` 按名分发。disposer 必须真摘 handler——否则「dispose 后
   *  不再留痕」这条性质在假宿主上无从验证（旧假面返回 no-op，监听会活过卸载）。 */
  const handlers: Array<{ event: string; listener: (...args: any[]) => void }> = []
  const ctx = {
    logger: namedLogger,
    on: (event: string, listener: (...args: any[]) => void) => {
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
  return {
    ctx: ctx as any,
    calls,
    logs,
    emit: (event: string, ...args: any[]) => {
      for (const h of handlers) if (h.event === event) h.listener(...args)
    },
    disposeAll: () => { for (const d of disposers) d() },
  }
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
  it('身份与 Config（schemastery：默认值与值域都住 schema，外层 default({}) 兜 cordis 缺省行）', () => {
    expect(name).toBe('@xrn1997/dsh-novel')
    expect(inject).toEqual(['webServer', 'tools', 'jobs'])
    const cfg = Config({} as any) as any
    expect(cfg.searchTimeoutMs.get()).toBe(DEFAULT_TIMEOUT_MS)
    expect((Config(undefined as any) as any).searchTimeoutMs.get()).toBe(DEFAULT_TIMEOUT_MS)
    expect(Config({ dataDir: 'D:/x' } as any).dataDir).toBe('D:/x')
    expect(() => Config({ dataDir: 1 } as any)).toThrow()
  })
  it('配置值域校验：searchParallel ≤ 0 加载期响亮失败（否则批循环 i+=0 永久挂起）', () => {
    expect(() => apply(fakeCtx().ctx, { dataDir: 'D:/x', searchParallel: 0 })).toThrow(/配置非法/)
    expect(() => apply(fakeCtx().ctx, { dataDir: 'D:/x', searchParallel: -1 })).toThrow(/配置非法/)
    expect(() => apply(fakeCtx().ctx, { dataDir: 'D:/x', searchTimeoutMs: 0 })).toThrow(/配置非法/)
    expect(() => apply(fakeCtx().ctx, { dataDir: 'D:/x', jsTimeoutMs: 0 })).toThrow(/配置非法/)
  })
  it('apply：ready 后注册 prefix 路由 + 6 工具；disposer 摘干净', async () => {
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
      apply(ctx, { dataDir: dir })
      await waitFor(() => calls.filter((c) => c.kind === 'tool').length === 6)
      const shelf = calls.find((c) => c.kind === 'tool' && c.tool.name === 'dshnovel_shelf')!.tool
      // **冻结防抖窗口**再写入：定时器一旦被假造，100ms 那笔永远不会自己到点——此后文件只可能由
      // 「卸载即落盘」写出来。旧口径靠 wall-clock 判（6×10ms 压在 100ms 窗口内），负载下会抖：
      // 慢机器上窗口先到点，断言的就不是这条性质了。setImmediate 留给真实 I/O 轮询。
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
      await shelf.execute({ action: 'add', bookKey: 'k', title: '书', sourceId: 's' }, {})
      await shelf.execute({ action: 'save_progress', bookKey: 'k', chapterIndex: 7, offsetRatio: 0.5 }, {})
      disposeAll()                                   // 立刻卸载
      const file = path.join(dir, 'shelf.json')
      for (let i = 0; i < 2000 && !existsSync(file); i++) await new Promise((r) => setImmediate(r))
      expect(existsSync(file), '卸载后防抖窗口里的进度没有落盘（flush 未接线）').toBe(true)
      const onDisk = JSON.parse(await fs.readFile(file, 'utf8'))
      expect(onDisk[0].progress).toMatchObject({ chapterIndex: 7, offsetRatio: 0.5 })
    } finally {
      vi.useRealTimers()
      disposeAll()
    }
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
  it('loader/volatile-update：变更路径进日志', async () => {
    const dir = await makeTempDir('novel-volatile-')
    const { ctx, calls, logs, emit, disposeAll } = fakeCtx()
    try {
      apply(ctx, { dataDir: dir })
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
      apply(ctx, { dataDir: dir })
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
      apply(ctx, { dataDir: dir })
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
      apply(ctx, { dataDir: dir, proxyUrl: 'http://user:pass@127.0.0.1:9' })
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
      apply(ctx, { dataDir: dir })
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
    ;(bad.ctx as any).on = undefined
    expect(() => apply(bad.ctx, { dataDir: dir })).toThrow(/on is not a function/)
    const good = fakeCtx()
    try {
      apply(good.ctx, { dataDir: dir })
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

  /** 日志缝的运行时 adapter 是**双腿**：宿主 `ctx.logger` 只进 ring buffer 且默认级别吞 warn，
   *  只走那条腿本机 stdout 就看不见了。这条用例同时钉两件事——组合根真的装了 sink（漏装的话缝
   *  一路走缺省 console，其余用例照样全绿），以及两条腿收到的是同一条消息。 */
  it('apply：运行时 logger adapter 双腿装上了（console 与 ctx.logger 各收到一条）', async () => {
    const dir = await makeTempDir('novel-log-')
    const a = fakeCtx()
    const b = fakeCtx()
    const seen: unknown[][] = []
    const spy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { seen.push(args) })
    try {
      apply(a.ctx, { dataDir: dir })
      expect(seen, '装 adapter 这一步本身不该吭声').toEqual([])
      expect(a.logs, '装 adapter 这一步本身不该吭声').toEqual([])
      apply(b.ctx, { dataDir: dir })     // 第二次撞双重启用守卫 → 经缝发一条 warn
      expect(seen, 'console 腿没收到（stdout 变暗）').toHaveLength(1)
      expect(seen[0][0]).toBe('[dsh-novel]')
      expect(String(seen[0][1])).toContain('duplicate apply ignored')
      expect(a.logs).toHaveLength(1)
      expect(a.logs[0]).toMatchObject({ name: 'dsh-novel', level: 'warn' })
      expect(a.logs[0].args).toEqual(['[dsh-novel]', expect.stringContaining('duplicate apply ignored')])
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
      apply(a.ctx, { dataDir: dir })          // 组合根把双腿 adapter 装进模块级 sink
      log.error('x', err)                      // 经缝 → adapter.error 腿
      const shaped = a.logs.find((l) => l.level === 'error')
      expect(shaped, 'logger 腿没收到 error').toBeDefined()
      expect(shaped!.args[0]).toBe('[dsh-novel]')          // format 位是缝缀的前缀
      expect(shaped!.args[1]).toBe('x')
      expect(shaped!.args[2]).not.toBeInstanceOf(Error)    // 换回 `...a` 时这里红：Error 未成形
      expect(typeof shaped!.args[2], 'Error 应被转成形为文本').toBe('string')
      expect(String(shaped!.args[2])).toContain('boom')
      // console 腿收到同一条（前缀 + 消息本体 + **原样 Error**：成形只发生在 logger 腿）
      expect(seen).toHaveLength(1)
      expect(seen[0][0]).toBe('[dsh-novel]')
      expect(seen[0][1]).toBe('x')
      expect(seen[0][2]).toBe(err)
    } finally {
      spy.mockRestore()
      setLogSink(console)                      // 复位模块级 sink，别把这条 adapter 漏给后续用例
      a.disposeAll()
    }
  })

  it('dispose：日志 sink 复位到 console（模块级单点不指向已卸载实例）', async () => {
    const dir = await makeTempDir('novel-log-dispose-')
    const a = fakeCtx()
    apply(a.ctx, { dataDir: dir })
    a.disposeAll()
    const seen: unknown[][] = []
    const spy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { seen.push(args) })
    try {
      log.warn('after dispose')
      expect(seen).toHaveLength(1)
      expect(seen[0][0]).toBe('[dsh-novel]')
      expect(String(seen[0][1])).toBe('after dispose')
    } finally {
      spy.mockRestore()
    }
  })

  it('ready 后注册失败：经日志缝留痕，且不带重复的满名', async () => {
    const dir = await makeTempDir('novel-log-register-')
    const a = fakeCtx()
    ;(a.ctx as any).webServer.register = () => { throw new Error('register boom') }
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      apply(a.ctx, { dataDir: dir })
      await waitFor(() => a.logs.some((l) => l.level === 'error'))
      const hit = a.logs.find((l) => l.level === 'error')!
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
    ;(bad.ctx as any).logger = () => { throw new Error('no logger') }
    expect(() => apply(bad.ctx, { dataDir: dir })).toThrow(/no logger/)
    const good = fakeCtx()
    try {
      apply(good.ctx, { dataDir: dir })
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
