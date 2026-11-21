import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { createApiHandler } from './api/dispatch.js'
import { resolveConfig, type NovelConfig } from './config.js'
import { acquireRejectionGuard } from './engine/rejection-guard.js'
import type { JobHost } from './services/job-holder.js'
import { log, setLogSink } from './services/log.js'
import { readSystemProxy, redactProxyUrl, resolveProxyUrl } from './services/proxy.js'
import { ReadingService } from './services/reading.js'
import { novelDir } from './services/storage.js'
import { normalizeSpeechSynthesis } from './services/tts-cordis.js'
import { NOVEL_API_PREFIX } from './shared/wire.js'
import { registerTools } from './tools/tools.js'

// 配置口径全住 config.js；入口只 re-export 门面符号，cordis 装载期仍从这里取 `Config`（tests/packaging-build.test.ts 钉 dts）。
export { Config, type NovelConfig, type ResolvedConfig } from './config.js'

/** 结构镜像：webServer / tools / jobs 的 module 增强来自未安装的宿主包（完整签名以宿主发布物为准）；
 *  不能 extends Context——dsh-tools 已对 tools 做更宽增强，会冲突。`jobs` 只镜像 `start` 与 `attachController`；
 *  `start` 的 spec 形状归 `services/job-holder.ts` 的 `JobHostSpec`。kind 一律非空、带 `novel-` 前缀。
 */
interface WebServerLike { register(route: { kind: 'prefix'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }): () => void }
interface ToolsRuntimeLike { register(tool: unknown): () => void }
interface JobsRuntimeLike extends JobHost {
  /** 准入闸：`start` 要求有已挂载 controller 服务该 owner；非 scoped 上下文挂的 controller 进 global layer，
   *  对所有 owner 有效——所以这句必须由我们挂。 */
  attachController(name: string): () => void
}
interface NovelContext { webServer: WebServerLike; tools: ToolsRuntimeLike; jobs: JobsRuntimeLike }

export const name = '@xrn1997/dsh-novel'
/** 挂载前必须就绪的服务；名字集合由 `tests/index.test.ts` 钉住（宿主 base 补丁以 `jobs` 注册任务注册表，
 *  与 webServer 同档硬依赖）。 */
export const inject = ['webServer', 'tools', 'jobs']

/** 双重启用防御：双启用时重复注册 /novel-api 会崩宿主进程。语义是「当前有一份实例已注册」——dispose 复位，
 *  热替换与 HMR 后新实例仍能注册。只拦注册，不接管配置；第二份 config 不生效，所以留痕必须是 error
 *  （宿主缺省闸只放行 error/info，warn 看不见）。 */
let applied = false

/** 缝送来的 args → 宿主 severity 方法的形状：模板位打头 + rest，第二参不是 meta 对象；尾随 Error 先成形为
 *  文本（宿主格式化器对对象一律 JSON 化，Error 会塌成空壳）。 */
function hostArgs(args: unknown[]): [unknown, ...unknown[]] {
  const [head, ...rest] = args
  const logArg = (v: unknown): unknown => (v instanceof Error ? (v.stack ?? v.message) : v)
  return [head, ...rest.map(logArg)]
}

/** `loader/volatile-update` 载荷：宿主给顶层路径段数组，会捕获监听器错误、不中断配置保存。异形载荷只许
 *  留可读痕迹，不许升级成故障；只有顶层单段 `proxyUrl` 才重算代理。最外层兜底吞掉连字符串化都会抛的极端载荷。 */
function readVolatilePaths(payload: unknown): { text: string; proxyUrl: boolean } {
  try {
    const entries = Array.isArray(payload) ? payload : [payload]
    const parts: string[] = []
    let proxyUrl = false
    for (const entry of entries) {
      if (Array.isArray(entry)) {
        parts.push(entry.join('.'))
        if (entry.length === 1 && entry[0] === 'proxyUrl') proxyUrl = true
      } else {
        const text = String(entry)
        parts.push(text)
        if (text === 'proxyUrl') proxyUrl = true
      }
    }
    return { text: parts.join(', '), proxyUrl }
  } catch {
    return { text: '(不可读的变更路径)', proxyUrl: false }
  }
}

/**
 * Cordis 插件入口：ReadingService 异步初始化，routes/tools 两 effect 等 ready 后注册；
 * ready 失败不炸整树，路由/工具不挂载并留痕。
 */
export function apply(ctx: Context, config?: NovelConfig): void {
  const resolved = resolveConfig(config)
  if (applied) {
    // 这是配置错（同一插件被两个入口启用）且第二份 config 被丢弃；措辞点名后果与出口，否则用户不知道哪份生效。
    log.error('duplicate apply ignored：本插件已被另一份实例注册，本次不注册路由/工具且配置不生效（请停用重复的入口后重启宿主）')
    return
  }
  const c = ctx as unknown as NovelContext

  // 日志 = console + ctx.logger 双腿：ctx.logger 只进 ring buffer 且缺省闸吞 warn/debug，只走它会让 warn 进不了
  // 宿主面、本机 stdout 也暗。console 腿保本机可见性；Error 原样进 stderr 才保住栈形，logger 腿才成形。
  // 窄镜像（ADR-0020）只管没装的宿主包，ctx.logger 直接吃。
  const named = ctx.logger('dsh-novel')
  setLogSink({
    info: (...a) => { console.log(...a); named.info(...hostArgs(a)) },
    warn: (...a) => { console.warn(...a); named.warn(...hostArgs(a)) },
    error: (...a) => { console.error(...a); named.error(...hostArgs(a)) },
  })
  // sink 是模块级单点：不能指向已卸载实例的 logger，复位也归组合根这一处。
  ctx.effect(() => () => { setLogSink(console) }, 'dsh-novel: log sink')

  // volatile 热更只留痕、不重建（消费方用时读当前值）；代理需重算一次，因为 fallback 启动期只取一次。
  // 日志过 redactProxyUrl：地址可能带 userinfo 密码。
  let proxyFor: (() => string | null) | null = null
  // 载荷照 unknown 收：事件面形状不由本仓钉死，按窄镜像硬吃会把观测变成运行期 throw。
  const events = ctx as unknown as {
    on(event: 'loader/volatile-update', listener: (payload: unknown) => void): () => boolean
  }
  ctx.effect(() => {
    const off = events.on('loader/volatile-update', (payload) => {
      const changed = readVolatilePaths(payload)
      log.info(`配置热更: ${changed.text}`)
      if (proxyFor !== null && changed.proxyUrl) {
        const next = proxyFor()
        log.info(`出站代理: ${next === null ? '(直连)' : redactProxyUrl(next)}`)
      }
    })
    return () => { off() }
  }, 'dsh-novel: volatile config log')

  // 守卫放到宿主成员同步调用与 volatile 监听装好之后：apply 同步抛错时还没有 effect 可复位 applied，重试会被挡死。
  applied = true

  /** 各注册共用的时序：等 ready、取消就收手、拆时调 disposer 并复位 applied。只有排在 ready 之后的注册才收进来；
   *  flush 与 rejection 守卫留在外面——它们靠「注册得早 ⇒ 拆得晚」的次序成立。 */
  const afterReady = (
    ready: Promise<{ service: ReadingService } | null>,
    attach: (r: { service: ReadingService }) => (() => void) | null,
    label: string,
  ): void => {
    let dispose: (() => void) | null = null
    let cancelled = false
    // 日志文案用去掉 `[dsh-novel] ` 前缀的短名：label 是 cordis 诊断元数据，前缀由日志缝缀一次。
    const logName = label.replace(/^dsh-novel: /, '')
    void ready.then((r) => {
      if (cancelled || r === null) return
      const d = attach(r)
      dispose = typeof d === 'function' ? d : null
    }).catch((e: unknown) => { log.error(`${logName} registration failed:`, e) })
    ctx.effect(() => () => { cancelled = true; applied = false; dispose?.() }, label)
  }

  // 沙箱 unhandledRejection 常驻防线：vm realm 里自建又 fire-and-forget 的 rejection 会冒到进程顶层，Node 默认致命。
  // 探针逐源跑 @js 时尤其危险；java.ajax 走同步语义不产 rejection，但脚本自建 Promise 照样会。
  // 挂上后常驻至 dispose（只挂跑脚本那段会漏掉迟到 rejection）；sink 由这里递入，留痕走日志缝。
  // 边界见 `rejection-guard.ts` / `ADR-0059`。
  ctx.effect(() => {
    const detach = acquireRejectionGuard({ warn: (...a) => log.warn(...a), error: (...a) => log.error(...a) })
    return () => { detach() }
  }, 'dsh-novel: unhandledRejection guard')

  // 宿主任务注册表 controller：start 的准入闸要求有已挂载 controller 服务该 owner，不挂这句我们的 start 会被拒。
  // 非 scoped 上下文 → global layer，对所有 owner 有效。
  ctx.effect(() => c.jobs.attachController('dsh-novel'), 'dsh-novel: job controller')

  // ready 失败收敛为 null、日志留痕，不炸整树；派生 then 链必须带 catch，否则往进程顶层丢 unhandled rejection。
  // LocalBooks 初始化失败同样收进这条 catch。
  const ready = (async () => {
    const dir = resolved.dataDir ?? novelDir()
    // undici 不读系统代理，有代理才通的站点直连会被重置；fallback（环境变量 > Windows 系统代理）启动期只取一次，
    // 显式配置覆盖它。优先级见 `resolveProxyUrl`。
    const fallbackProxy = resolveProxyUrl({ env: process.env, systemProxy: await readSystemProxy() })
    const proxyUrl = (): string | null => {
      const explicit = resolved.proxyUrl?.trim()
      return explicit === undefined || explicit === ''
        ? fallbackProxy
        : resolveProxyUrl({ configProxy: explicit, env: {}, systemProxy: null })
    }
    proxyFor = proxyUrl
    // 走 info：这是信息不是异常，且宿主缺省闸只放行 error/info（本机经 console 腿走 stdout）。
    const initialProxy = proxyUrl()
    if (initialProxy !== null) log.info(`出站代理: ${redactProxyUrl(initialProxy)}`)
    const service = await ReadingService.create({
      dir,
      config: resolved,
      // 代理走独立的 proxyUrl 源而非 config.proxyUrl：只传 config 的直装调用方不该因此被接上网关。
      proxyUrl,
      // 任务生命周期交宿主注册表；本仓 JobState 仍是计数与明细的唯一载体，单任务槽互斥不变。
      jobHost: c.jobs,
      // 听书面：`ctx.get` 每次用时重查（社区服务可选、可能中途卸装——缺席即除名 / TTS_ENGINE_MISSING）。
      // 适配器类型只 type-only import（运行时零依赖）；合成服务与注册表由 create 用同一个 fetcher 装配。
      tts: {
        speechSynthesis: () => {
          const service = ctx.get('speechSynthesis')
          return service ? normalizeSpeechSynthesis(service) : undefined
        },
      },
    })
    return { service }
  })().catch((e: unknown) => {
    log.error('service init failed（路由/工具未挂载）:', e)
    return null
  })

  // 卸载时把防抖写落地：宿主重启（SIGINT → fiber 卸载）会丢掉窗口里的最后一条写，而进度是高频写。
  // 注册得早 ⇒ 拆得晚。顺手关掉出站 dispatcher（代理连接池不该活过插件实例）。
  ctx.effect(() => {
    let service: ReadingService | null = null
    void ready.then((r) => { service = r?.service ?? null })
    return () => {
      if (service !== null) {
        void service.flush().catch((e: unknown) => { log.error('卸载前落盘失败：', e) })
        service.dispose()
      }
    }
  }, 'dsh-novel: flush shelf + close fetcher')

  afterReady(ready, (r) => {
    const handler = createApiHandler(r.service, {
      exportDelayMs: () => resolved.exportDelayMs,
      // 本机别名名单走启动期快照（非活值）；fence 判据在 api/wire.ts。没配就不建这个键——契约面只认缺席。
      ...(resolved.apiAllowHosts === undefined ? {} : { allowHosts: resolved.apiAllowHosts }),
    })
    return c.webServer.register({
      kind: 'prefix',
      path: NOVEL_API_PREFIX,
      handler: async (req: IncomingMessage, res: ServerResponse) => { await handler(req, res) },
    })
  }, 'dsh-novel: /novel-api routes')

  afterReady(ready, (r) => registerTools({ tools: c.tools }, r.service), 'dsh-novel: agent tools')
}
