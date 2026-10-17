import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { createApiHandler } from './api/dispatch.js'
import { resolveConfig, type NovelConfig } from './config.js'
import { ensureUnhandledGuard } from './engine/js-sandbox.js'
import type { JobHost } from './services/import-job.js'
import { log, setLogSink } from './services/log.js'
import { readSystemProxy, resolveProxyUrl } from './services/proxy.js'
import { ReadingService } from './services/reading.js'
import { novelDir } from './services/storage.js'
import { NOVEL_API_PREFIX } from './shared/wire.js'
import { registerTools } from './tools/tools.js'

// 配置口径全部住在 config.js（类型 / schema / 缺省 / 值域一个缝）；入口只 re-export 门面符号，
// 让 cordis 装载期继续从这里拿到导出的 `Config`（tests/packaging-build.test.ts 钉 dts 含 apply 与 Config）。
export { Config, type NovelConfig, type ResolvedConfig } from './config.js'

/** 结构镜像：webServer/tools/jobs 的 declare module 增强来自未安装的宿主包——
 * 本仓库不装 dsh-host-webserver（peer，运行时由宿主提供），类型面按 d.ts 证据镜像最小形状。
 * 注意不能 extends Context（dsh-tools 已对 tools 做了更宽的增强，交叉会冲突）——独立形状 + 强转。
 * `jobs` = 宿主后台任务注册表（ctx.jobs）：只镜像我们用到的两成员（`start` 与下面的 `attachController`）。
 * `start` 交出的 spec 形状由 services/import-job.ts 的 `JobHostSpec` 唯一持有——宿主真名真形与
 * 输出拉模型（`readOutput`）的窄面镜像注释都在那里，本处不复述。
 * kind 是自由字符串（注册表按不透明命名空间处理，唯一判据非空，
 * 见 `dsh-jobs-local` 的 `invalid job kind: expected a non-empty string`）。 */
interface WebServerLike { register(route: { kind: 'prefix'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }): () => void }
interface ToolsRuntimeLike { register(tool: unknown): () => void }
interface JobsRuntimeLike extends JobHost {
  /** 准入闸：`start` 拒绝「没有已挂载 controller 服务该 owner」的工作。
   *  从本插件（非 scoped 上下文）挂的 controller 进 global layer，对所有 owner 有效
   *  （`dsh-jobs-local` 的 `servesOwner` 首行即查 global layer）。宿主自带的 `tool-jobs`
   *  在本机 web profile 里是 `disabled: true`，所以这一句必须由我们自己来。 */
  attachController(name: string): () => void
}
interface NovelContext { webServer: WebServerLike; tools: ToolsRuntimeLike; jobs: JobsRuntimeLike }

export const name = '@xrn1997/dsh-novel'
/** 挂载前必须就绪的服务：webserver 路由、工具注册表、宿主任务注册表
 *  （宿主 base 补丁以 id `jobs` 注册 `@deepseek-ai/dsh-jobs-local`，与 webServer 同一档硬依赖，
 *  缺了就该响亮失败；名字集合由 `tests/index.test.ts` 钉住） */
export const inject = ['webServer', 'tools', 'jobs']

/** 双重启用防御：bundles+插槽双启用时重复注册 /novel-api 会崩宿主进程（dsh-reader 验证过的坑）。
 * 语义钉死「当前有一份实例已注册」——dispose 复位，使 cordis 配置热替换（unload→load）后
 * 新实例可正常注册（dsh-reader 原模式无复位，HMR 场景会误拦）。 */
let applied = false

/** 缝送来的 args → 宿主 severity 方法能吃的形状。真签名核证（cordis 发布物 logger.d.ts）：
 *  每条级别方法是「printf 模板位打头（必填）+ 可选 rest」，整串变参展开接不进去；第二参不是
 *  meta 对象。模板位就取缝的第一条（前缀），其余按 rest 递；尾随的 Error 先成形为文本——宿主
 *  格式化器对对象一律 JSON 化，没成形的 Error 进 ring buffer 会塌成空壳，而本仓留痕几乎每条
 *  尾随一个 error。 */
function hostArgs(args: unknown[]): [unknown, ...unknown[]] {
  const [head, ...rest] = args
  const textOf = (v: unknown): unknown => (v instanceof Error ? (v.stack ?? v.message) : v)
  return [head, ...rest.map(textOf)]
}

/**
 * Cordis 插件入口：ReadingService 异步初始化，routes/tools 两 effect 等 ready 后注册。
 * ready 失败吞掉不炸整树（源数据损坏不值得整个 profile 起不来）——路由/工具不挂载，日志留痕。
 */
export function apply(ctx: Context, config?: NovelConfig): void {
  const resolved = resolveConfig(config)
  if (applied) {
    log.warn('duplicate apply ignored（插件被重复启用，已跳过注册——防重复路由崩溃）')
    return
  }
  const c = ctx as unknown as NovelContext

  // 运行时 adapter = console + ctx.logger 双腿复合：宿主的 ctx.logger 只进 ring buffer（要 stdout 得
  // 另挂 console exporter 插件），且缺省级别闸只放行 error/info、吞掉 warn/debug——只走那条腿会让
  // warn 级留痕进不了宿主面、又把本机 stdout 做暗。console 这条腿保本机可见性，不是冗余（info 腿走
  // stdout、warn/error 腿走 stderr，三级一律直传原样参数——Error 原样进 stderr 才保住栈形；成形只在
  // logger 腿，因为只有它要喂宿主的「format + rest」方法）。窄镜像（ADR 0020）只管没装的宿主包
  // webServer / tools / jobs；ctx.logger 是已 type-import 的官方 Context 成员，直接吃，不再镜像一遍。
  const named = ctx.logger('dsh-novel')
  setLogSink({
    info: (...a) => { console.log(...a); named.info(...hostArgs(a)) },
    warn: (...a) => { console.warn(...a); named.warn(...hostArgs(a)) },
    error: (...a) => { console.error(...a); named.error(...hostArgs(a)) },
  })
  // 模块级 sink 不能指向已卸载实例的 logger：卸载后晚到的留痕会把对象送进旧 ctx。
  // 复位也归组合根这一处（sink 是模块级单点）。
  ctx.effect(() => () => { setLogSink(console) }, 'dsh-novel: log sink')
  // 守卫放到 logger/sink 装好之后：ctx.logger 是宿主成员，旧代次缺失时 apply 会同步抛错；
  // 若先置 applied，抛错后没有 effect 可复位，后续重试会被 duplicate apply 挡死。
  applied = true

  /** 入口各注册共用的同一支时序舞——等 ready、被取消就收手、拆时调 disposer 并复位 applied——
   *  收成一个私有闭包：以前它在路由与工具两条 effect 里各抄一份，第四个注册还得再抄，
   *  时序口径因此散成多处（locality）。走不走这条缝只有一条分界：注册排在 ready 之后的才收进来；
   *  flush 与 unhandledRejection 守卫刻意留在外面——它们靠「注册得早 ⇒ 拆得晚」的次序成立，
   *  套上这层等 ready 的延迟就会让最后一笔写丢窗、让常驻防线迟到。 */
  const afterReady = (
    ready: Promise<{ service: ReadingService } | null>,
    attach: (r: { service: ReadingService }) => (() => void) | void,
    label: string,
  ): void => {
    let dispose: (() => void) | null = null
    let cancelled = false
    // 日志文案只吃去掉 `[dsh-novel] ` 前缀的短名：label 本身是 cordis 的诊断元数据（归它自己，不动），
    // 而前缀由日志缝缀一次——两处都带满名会让一条留痕长出三重标识。
    const logName = label.replace(/^dsh-novel: /, '')
    void ready.then((r) => {
      if (cancelled || r === null) return
      const d = attach(r)
      dispose = typeof d === 'function' ? d : null
    }).catch((e: unknown) => { log.error(`${logName} registration failed:`, e) })
    ctx.effect(() => () => { cancelled = true; applied = false; dispose?.() }, label)
  }

  // 沙箱 unhandledRejection 常驻防线：脚本在 vm realm 里**自建**又 fire-and-forget 的异步工作
  // （Promise 与宿主同一 isolate），其 rejection 会悬空冒到进程顶层。Node 20+ 默认把这类
  // unhandled rejection 当致命 → 整个 dsh 进程死（用户看到「请求失败 403/404」fatal），
  // 尤其在导入书源时（探针逐源跑 @js）。java.ajax 本身已不再产出 Promise（同步语义唯一，
  // 见 engine/js-sandbox.ts 的哨兵口径），但这条防线仍然必需。
  // 挂上后常驻至插件 dispose——早前「evalJs 期间挂、finally 摘」摘早了照样漏。
  // sink 也从这里递进去：防线幂等且先挂者定 sink，所以入口必须抢在第一次跑脚本之前挂，
  // 这条留痕才走得到日志缝（宿主日志面），而不是落在引擎的缺省 console 上。
  ctx.effect(() => {
    const detach = ensureUnhandledGuard({ warn: (...a) => log.warn(...a) })
    return () => { detach() }
  }, 'dsh-novel: unhandledRejection guard')

  // 宿主任务注册表的 controller：`start` 的准入闸要求「有已挂载 controller 服务该 owner」。
  // 本机 web profile 里宿主自带的 `tool-jobs` 是 `disabled: true`（宿主注释：注册表留在 host plane，
  // 搬走的只是模型侧控件），不挂这一句我们的 start 会被拒（报 "background jobs unavailable…"）。
  // 从本插件这种非 scoped 上下文挂载 → 进 global layer → 对所有 owner 有效（disposer 随 fiber 走）。
  ctx.effect(() => c.jobs.attachController('dsh-novel'), 'dsh-novel: job controller')

  // ready 失败吞掉不炸整树（源数据损坏不值得整个 profile 起不来）——收敛为 null，日志留痕一次；
  // 派生 then 链若不带 catch 会产生 unhandled rejection（实测钉死）。
  // LocalBooks 初始化失败同样不炸树——与 ReadingService 同口径 catch 语义，合并进同一 catch。
  const ready = (async () => {
    const dir = resolved.dataDir ?? novelDir()
    // 出站代理：Node 的 fetch（undici）不读系统代理，有代理才通的站点直连会被 302/重置
    // （实测笔趣阁）——用户配的 proxyUrl > 环境变量 > Windows 系统代理 > 直连，见 services/proxy.ts
    const proxyUrl = resolveProxyUrl({
      configProxy: resolved.proxyUrl,
      env: process.env,
      systemProxy: await readSystemProxy(),
    })
    // 启动提示走 info 而非 warn：一是它是信息不是异常，二是宿主缺省级别闸吞 warn、
    // 只放行 error/info——想让这条真进得了宿主日志面就得走 info（本机经 console 腿走 stdout）。
    if (proxyUrl !== null) log.info(`出站代理: ${proxyUrl}`)
    const service = await ReadingService.create({
      dir,
      searchTimeoutMs: resolved.searchTimeoutMs,
      searchParallel: resolved.searchParallel,
      jsTimeoutMs: resolved.jsTimeoutMs,
      cacheMaxBytes: resolved.cacheMaxBytes,
      localImportMaxBytes: resolved.localImportMaxBytes,
      proxyUrl,
      // 任务生命周期交宿主注册表（身份 `<kind>-N` / running→终态 / 取消入口）；
      // 本插件的 JobState 仍是计数与明细的唯一载体，单任务槽互斥也不变。
      jobHost: c.jobs,
    })
    return { service }
  })().catch((e: unknown) => {
    log.error('service init failed（路由/工具未挂载）:', e)
    return null
  })

  // 卸载时把防抖写落地：书架与源注册表的落盘都带防抖窗口（shelf = 100ms），
  // 宿主重启（SIGINT → fiber 卸载）会把窗口里的最后一条写丢掉——「刚读到的位置」正好死在
  // 窗口里（进度是高频写，退出那一刻往往就是最后一次）。注册得早 ⇒ 拆得晚。
  ctx.effect(() => {
    let service: ReadingService | null = null
    void ready.then((r) => { service = r?.service ?? null })
    return () => { if (service !== null) void service.flush() }
  }, 'dsh-novel: flush shelf on dispose')

  afterReady(ready, (r) => {
    const handler = createApiHandler(r.service, {
      exportDelayMs: resolved.exportDelayMs,
    })
    return c.webServer.register({
      kind: 'prefix',
      path: NOVEL_API_PREFIX,
      handler: async (req: IncomingMessage, res: ServerResponse) => { await handler(req, res) },
    })
  }, 'dsh-novel: /novel-api routes')

  afterReady(ready, (r) => registerTools({ tools: c.tools }, r.service), 'dsh-novel: agent tools')
}
