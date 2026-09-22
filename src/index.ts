import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { createApiHandler } from './api/dispatch.js'
import { ensureUnhandledGuard } from './engine/js-sandbox.js'
import type { JobHost } from './services/import-job.js'
import { readSystemProxy, resolveProxyUrl } from './services/proxy.js'
import { ReadingService } from './services/reading.js'
import { novelDir } from './services/storage.js'
import { NOVEL_API_PREFIX } from './shared/wire.js'
import { registerTools } from './tools/tools.js'

/** 结构镜像（docs/reference/dsh-plugin-api.md 策略）：webServer/tools/jobs 的 declare module 增强来自未安装的宿主包——
 * 本仓库不装 dsh-host-webserver（peer，运行时由宿主提供），类型面按 d.ts 证据镜像最小形状。
 * 注意不能 extends Context（dsh-tools 已对 tools 做了更宽的增强，交叉会冲突）——独立形状 + 强转。
 * `jobs` = 宿主后台任务注册表（ctx.jobs）：只镜像我们用到的两成员，且 `start` 的形状与
 * services/import-job.ts 的 JobHost 对齐（kind 是自由字符串——注册表按不透明命名空间处理，
 * 唯一判据非空，见 `dsh-jobs-local` 的 `invalid job kind: expected a non-empty string`）。 */
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
 *  （docs/reference/dsh-plugin-api.md 证据 2b 同构；`jobs` 由 `dsh-base/cordis.patch.yml`
 *  的 `id: jobs → @deepseek-ai/dsh-jobs-local` 常带，与 webServer 同一档硬依赖，缺了就该响亮失败） */
export const inject = ['webServer', 'tools', 'jobs']

/** 插件配置（官方 config 页规范形态：schemastery Standard Schema）。
 * .default({}) 防御：cordis 的 resolveConfig 在 patch 行没写 config: 时传的是 undefined，
 * 裸 object schema 会判 invalid 而炸掉整棵插件树——.default 兜住缺省行并归一为 {}。
 * 全字段 optional + 外层 .default({})：schemastery 的 inner-default 与 outer-default
 * 组合在 undefined 输入下的填充语义随版本有歧义——一律由 apply 侧 coalesce DEFAULTS，
 * schema 只负责类型校验（非法值加载期响亮失败）。
 * 注：本包 schema 无 .optional() 方法——object 的字段天然是可选的（缺省键/undefined 直接放行）。 */
export interface NovelConfig {
  dataDir?: string
  searchTimeoutMs?: number
  searchParallel?: number
  /** js 沙箱预算（vm 同步闸与异步总时长共用；引擎缺省 2000ms 只作回退）。
   *  缺省 15000：legado Rhino 无硬超时，真实源的多请求目录脚本（java.ajax×2 + md5 签名，
   *  txs12 源实测）2s 预算必炸——探针 verified 只证明搜索面，正文链路靠这个预算放行。 */
  jsTimeoutMs?: number
  cacheMaxBytes?: number
  exportDelayMs?: number
  localImportMaxBytes?: number
  /** 出站代理：'direct' = 强制直连；'http://host:port' = 显式；缺省 = 环境变量 → Windows 系统代理 → 直连 */
  proxyUrl?: string
}
export const Config = Schema.object({
  dataDir: Schema.string(),
  searchTimeoutMs: Schema.number(),
  searchParallel: Schema.number(),
  jsTimeoutMs: Schema.number(),
  cacheMaxBytes: Schema.number(),
  exportDelayMs: Schema.number(),
  localImportMaxBytes: Schema.number(),
  proxyUrl: Schema.string(),
  // 空对象缺省：ObjectT 静态要求全字段（库的类型偏严），运行时缺省由 apply 侧 coalesce DEFAULTS
}).default({} as any)

/** 无硬编码可调参数原则的缺省面——cordis.yml 可覆盖每一项 */
const DEFAULTS = {
  searchTimeoutMs: 15_000,
  searchParallel: 5,
  jsTimeoutMs: 15_000,
  cacheMaxBytes: 200 * 1024 * 1024,
  exportDelayMs: 300,
  localImportMaxBytes: 50 * 1024 * 1024,
}

/** 双重启用防御：bundles+插槽双启用时重复注册 /novel-api 会崩 dsh web（dsh-reader 验证过的坑）。
 * 语义钉死「当前有一份实例已注册」——dispose 复位，使 cordis 配置热替换（unload→load）后
 * 新实例可正常注册（dsh-reader 原模式无复位，HMR 场景会误拦）。 */
let applied = false

/** 配置**值域**校验（schema 只管类型）：searchParallel ≤ 0 会让聚合搜索批循环 `i += 0` 永不终止
 *  （`await Promise.all([])` 只让出微任务、定时器饿死 → 请求/工具调用永久挂起）。
 *  非法值在此加载期响亮失败——不静默夹紧（那是「猜」）。 */
function assertConfig(c: NovelConfig): void {
  const check = (key: keyof NovelConfig, v: number | undefined, ok: boolean): void => {
    if (v !== undefined && !ok) throw new Error(`[dsh-novel] 配置 ${key} 非法：${String(v)}（见 README 配置表）`)
  }
  check('searchParallel', c.searchParallel, Number.isInteger(c.searchParallel) && (c.searchParallel ?? 0) >= 1)
  check('searchTimeoutMs', c.searchTimeoutMs, (c.searchTimeoutMs ?? 0) > 0)
  check('jsTimeoutMs', c.jsTimeoutMs, (c.jsTimeoutMs ?? 0) > 0)
  check('cacheMaxBytes', c.cacheMaxBytes, (c.cacheMaxBytes ?? 0) >= 0)
  check('exportDelayMs', c.exportDelayMs, (c.exportDelayMs ?? 0) >= 0)
  check('localImportMaxBytes', c.localImportMaxBytes, (c.localImportMaxBytes ?? 0) > 0)
}

/**
 * Cordis 插件入口：ReadingService 异步初始化，routes/tools 两 effect 等 ready 后注册。
 * ready 失败吞掉不炸整树（源数据损坏不值得整个 profile 起不来）——路由/工具不挂载，日志留痕。
 */
export function apply(ctx: Context, config?: NovelConfig): void {
  assertConfig(config ?? {})
  if (applied) {
    console.warn('[dsh-novel] duplicate apply ignored（插件被重复启用，已跳过注册——防重复路由崩溃）')
    return
  }
  applied = true
  const c = ctx as unknown as NovelContext

  // 沙箱 unhandledRejection 常驻防线：脚本在 vm realm 里**自建**又 fire-and-forget 的异步工作
  // （Promise 与宿主同一 isolate），其 rejection 会悬空冒到进程顶层。Node 20+ 默认把这类
  // unhandled rejection 当致命 → 整个 dsh 进程死（用户看到「请求失败 403/404」fatal），
  // 尤其在导入书源时（探针逐源跑 @js）。java.ajax 本身已不再产出 Promise（同步语义唯一，
  // 见 engine/js-sandbox.ts 的哨兵口径），但这条防线仍然必需。
  // 挂上后常驻至插件 dispose——早前「evalJs 期间挂、finally 摘」摘早了照样漏。
  ctx.effect(() => {
    const detach = ensureUnhandledGuard()
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
    const dir = config?.dataDir ?? novelDir()
    // 出站代理：Node 的 fetch（undici）不读系统代理，有代理才通的站点直连会被 302/重置
    // （实测笔趣阁）——config.proxyUrl > 环境变量 > Windows 系统代理 > 直连，见 services/proxy.ts
    const proxyUrl = resolveProxyUrl({
      configProxy: config?.proxyUrl,
      env: process.env,
      systemProxy: await readSystemProxy(),
    })
    if (proxyUrl !== null) console.log(`[dsh-novel] 出站代理: ${proxyUrl}`)
    const service = await ReadingService.create({
      dir,
      searchTimeoutMs: config?.searchTimeoutMs ?? DEFAULTS.searchTimeoutMs,
      searchParallel: config?.searchParallel ?? DEFAULTS.searchParallel,
      jsTimeoutMs: config?.jsTimeoutMs ?? DEFAULTS.jsTimeoutMs,
      cacheMaxBytes: config?.cacheMaxBytes ?? DEFAULTS.cacheMaxBytes,
      localImportMaxBytes: config?.localImportMaxBytes ?? DEFAULTS.localImportMaxBytes,
      proxyUrl,
      // 任务生命周期交宿主注册表（身份 `<kind>-N` / running→终态 / 取消入口）；
      // 本插件的 JobState 仍是计数与明细的唯一载体，单任务槽互斥也不变。
      jobHost: c.jobs,
    })
    return { service }
  })().catch((e: unknown) => {
    console.error('[dsh-novel] service init failed（路由/工具未挂载）:', e)
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

  ctx.effect(() => {
    let dispose: (() => void) | null = null
    let cancelled = false
    void ready.then((r) => {
      if (cancelled || r === null) return
      const handler = createApiHandler(r.service, {
        exportDelayMs: config?.exportDelayMs ?? DEFAULTS.exportDelayMs,
      })
      dispose = c.webServer.register({
        kind: 'prefix',
        path: NOVEL_API_PREFIX,
        handler: async (req: IncomingMessage, res: ServerResponse) => { await handler(req, res) },
      })
    }).catch((e: unknown) => { console.error('[dsh-novel] route registration failed:', e) })
    return () => { cancelled = true; applied = false; dispose?.() }
  }, 'dsh-novel: /novel-api routes')

  ctx.effect(() => {
    let disposeTools: (() => void) | null = null
    let cancelled = false
    void ready.then((r) => {
      if (cancelled || r === null) return
      disposeTools = registerTools({ tools: c.tools }, r.service)
    }).catch((e: unknown) => { console.error('[dsh-novel] tools registration failed:', e) })
    return () => { cancelled = true; applied = false; disposeTools?.() }
  }, 'dsh-novel: agent tools')
}
