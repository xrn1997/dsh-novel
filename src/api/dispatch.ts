import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ReadingService } from '../services/reading.js'
import { DEFAULT_EXPORT_DELAY_MS } from '../services/export.js'
import { SVG_MEDIA_TYPE } from '../services/epub/resources.js'
import { log } from '../services/log.js'
import { formatByteLimit } from '../services/size.js'
import { readValue, type ValueSource } from '../services/value-source.js'
import { ApiError, fenceAllowlist, fenceDenialOf, readCappedBody, readJsonBody, writeError, writeOk } from './wire.js'
import type { FenceDenial } from './wire.js'
import { BODY, NOVEL_API_PREFIX, PARAMS, readBodies } from '../shared/wire.js'
import { BodyShapeError } from '../shared/wire.js'
import { matchRoute } from './routes.js'
import type { ParamRouteName, RouteName } from './routes.js'

/** 「书不在架上」文案单点（shelfPut 两形态共用这一句） */
const NOT_ON_SHELF = '书不在架上，先带 title 调用加入'

/** SSE 响应头单点（搜索面与发现面两条流共用）。`x-accel-buffering` 那句为什么只写过一份：
 *  攒帧的代价是「即时」变成「整批迟到」，而这条性质对两条流同等成立，抄第二遍时最容易丢的就是它。 */
const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
}

/** 一条作业观察流的机械，搜索面与发现面共用（头那一份住 `SSE_HEADERS`）：写头 → 每次「变了」补一帧
 *  → 帧到了终态就自己退订并关流 → 关页/断连也退订。
 *  「取哪一份快照、它到没到终态」交给 `frame`：游标推进这种只有某一面试得到的副作用留在调用方自己的
 *  闭包里，机械不认识 job 的形状——两面各自的口径（搜索带游标、发现整帧替换）因此各说各的，不并进来。
 *  不抽这一处的话，「终态必须自己关流」与「断连必须退订」两条纪律各写一遍，漏改任一条都只表现为
 *  某一条流占着连接不放——那种缺陷从代码上看不出来。 */
function openJobStream(res: ServerResponse, subscribe: (notify: () => void) => () => void,
  frame: () => { job: unknown; done: boolean },
): void {
  res.writeHead(200, SSE_HEADERS)
  let off: (() => void) | null = null
  const pump = (): void => {
    if (res.writableEnded || res.destroyed) return
    const f = frame()
    res.write(`data: ${JSON.stringify({ job: f.job })}\n\n`)
    if (f.done) { off?.(); res.end() }
  }
  off = subscribe(pump)
  res.on('close', () => { off?.() })                 // 关页/断连即退订：不给死连接攒帧，也不让监听器长驻持有者
  pump()                                            // 首帧（可能是 `{job:null}`：还没提交过，流继续等）
}

/** 路由级可调参数。
 * 本地书面已归门面：LocalBooks 部件与导入上限都在 ReadingService，
 * 此处只剩传输层关注点（导出节流）。`exportDelayMs` 收 getter 形态：配置页热改后
 * 下一次导出即用新值，但**一次导出只读一次**——导出中途换节奏会让同一份文件前后快慢不一。 */
export interface ApiHandlerOptions {
  exportDelayMs?: ValueSource<number>
  /** 同源 fence 的本机名单追加项（配置 `apiAllowHosts`）。启动期读一次就定：它是一条安全边界，
   *  不做热更——「运行中随时让掉一个名字」的口子比它要防的东西更危险。 */
  allowHosts?: readonly string[]
}

/** 403 回显 Host 的长度上限：拒绝理由给别人看，不该被一个超长头撑成整屏。 */
const HOST_ECHO_MAX = 120

/** 403 要说得可行动：只写「非受信来源」的人分不清自己是网络位置不对还是 Host 不对，
 *  而后者是他自己能配的（判据本身住 `api/wire.ts` 的 `fenceDenialOf`，这里只翻措辞）。 */
function fenceDenialMessage(denial: FenceDenial, host: string | undefined): string {
  if (denial === 'remote') return '非受信来源：请求不是从本机 loopback 发来的'
  if (denial === 'host') {
    const shown = host === undefined
      ? '(缺失)'
      : host.length > HOST_ECHO_MAX ? `${host.slice(0, HOST_ECHO_MAX)}…` : host
    return `非受信来源：Host「${shown}」不在本机名单（localhost / 127.0.0.1 / [::1]）里。`
      + '用自定义域名打开宿主面板时，把那个域名加进配置 apiAllowHosts 并重启插件'
  }
  return '非受信来源：Origin / Referer 与本服务不同源'
}

/**
 * `/novel-api` 前缀路由的内部分发（一条 prefix 路由 + 此处理器）。
 * 不依赖 Cordis——纯构造器，测试用真 http.Server 承载（tests/api/helpers.ts）。
 */
export function createApiHandler(service: ReadingService, opts: ApiHandlerOptions = {}) {
  // 名单是静态配置：构造期归一一次，逐请求只查表（`fenceDenialOf` 仍是唯一判据）
  const allowHosts = fenceAllowlist(opts.allowHosts)
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const denial = fenceDenialOf(req, { allowHosts })
      if (denial !== null) {
        throw new ApiError(fenceDenialMessage(denial, req.headers.host), 403, 'Forbidden')
      }
      const url = new URL(req.url ?? '/', 'http://dsh.internal')
      if (!url.pathname.startsWith(NOVEL_API_PREFIX)) {
        throw new ApiError(url.pathname, 404, 'NotFound')
      }
      const rest = url.pathname.slice(NOVEL_API_PREFIX.length) || '/'
      const segs = rest.split('/').filter(Boolean)
      await route(service, opts, req.method ?? 'GET', segs, url, req, res)
    } catch (e) {
      // body 形状判据住在 wire 契约（两半共读那一份），落成状态码是传输关注点——在这里翻一次，
      // 不在每个读口各写一遍 try/catch
      writeError(res, e instanceof BodyShapeError ? new ApiError(e.message, 400, 'BadRequest') : e)
    }
  }
}

/** 一条 handler 的入参：匹配器给的 `params` 是路径里 `:` 段的原值（百分号未解码），
 *  解码归各自 handler（见 shelfPut 两形态）。 */
type HandlerCtx = {
  service: ReadingService
  opts: ApiHandlerOptions
  url: URL
  req: IncomingMessage
  res: ServerResponse
  params: readonly string[]
}

/** 30 条静态路由的穷尽分发表：键集由 `RouteName` 逼，漏接/多接都是 tsc 红；
 *  臂体是原路由分支的原样搬移（传输机械一字未动）。 */
const HANDLERS: { [K in RouteName]: (ctx: HandlerCtx) => Promise<void> } = {
  health: async ({ res }) => {
    // 健康检查（GET /novel-api）
    writeOk(res, { name: 'dsh-novel', apiVersion: 1 })
  },
  sources: async ({ res, service }) => {
    // 同步 POST 导入已移除——导入走 sources/import 后台任务（错方法由匹配器落 405）
    writeOk(res, service.listPublicSources())
  },
  sourcesImport: async ({ req, res, service }) => {
    // 真实多源导出常见数 MB 级——上限 32MB，默认 1MB 会把最大流量的包挡在门外
    const body = await readJsonBody<Record<string, unknown> | null>(req, null, 32 * 1024 * 1024)
    writeOk(res, service.startImportJob(readBodies.import(body).files))
  },
  sourcesJobStatus: async ({ res, service }) => {
    // 任务结束后结果保留到下一个任务开始——关设置/刷新页面后重挂载即可恢复展示
    writeOk(res, { job: service.jobStatus() })
  },
  sourcesBatchProbe: async ({ req, res, service }) => {
    const body = await readJsonBody<Record<string, unknown> | null>(req, null)
    writeOk(res, service.startBatchProbeJob(readBodies.ids(body)))
  },
  sourcesBatchEnabled: async ({ req, res, service }) => {
    const body = await readJsonBody<Record<string, unknown> | null>(req, null)
    const { ids, enabled } = readBodies.batchEnabled(body)
    // 未知 id 静默跳过、重复 id 幂等；一次 edit 一次合并落盘——配方知识归门面动词
    const updated = await service.setEnabledMany(ids, enabled)
    writeOk(res, { updated })
  },
  sourcesBatchDelete: async ({ req, res, service }) => {
    // 批量删除：门面动词（一次 edit 合并落盘），替代逐删逐写的 N 次全量重写
    const body = await readJsonBody<Record<string, unknown> | null>(req, null)
    const removed = await service.removeSources(readBodies.ids(body))
    writeOk(res, { removed })
  },
  search: async ({ url, res, service }) => {
    // 「关键词去空白后非空才算在场」这一把尺在两条入口上是同一把：body 那侧住 `readBodies.searchJob`，
    // query 这侧走 requireQuery（它同时是「缺 query 参数 X」这句措辞的唯一家）
    const [keyword] = requireQuery(url, PARAMS.keyword)
    const ids = url.searchParams.get(PARAMS.sourceIds)?.split(',').filter(Boolean)
    writeOk(res, await service.search(keyword, ids === undefined ? undefined : { sourceIds: ids }))
  },
  // ── reading 面（query 驱动， GET）────────────────────────────────────
  searchPlan: async ({ res, service }) => {
    // 搜索参与计划：参与集唯一主人在服务端——客户端分批/进度按此走
    writeOk(res, service.searchPlan())
  },
  searchJob: async ({ req, res, service }) => {
    // 提交即由 Node 半跑完并持有整轮结果——浏览器半只负责看，切界面不再作废在途搜索
    const body = await readJsonBody<Record<string, unknown> | null>(req, null)
    const { keyword, sourceIds } = readBodies.searchJob(body)
    writeOk(res, service.startSearchJob(keyword, sourceIds === undefined ? undefined : { sourceIds }))
  },
  searchJobCancel: async ({ res, service }) => {
    // 停止 ≠ 放弃：本轮立即进终态（不再开新的源），已搜出的分组仍留在读面可翻
    writeOk(res, service.cancelSearchJob())
  },
  searchJobStream: async ({ url, res, service }) => {
    // 进度推送的加速器（SSE）：首帧 = 带 `since` 的同一份快照（baseline），此后每次状态变化补一帧，
    // 终态即关流。断线重连 = 重起一条并带已收到的游标——「推送不 replay、显式 query 才是真相」这
    // 条口径由推送与轮询两通道共用同一游标兑现（since 语义与游标兜底由 tests/api/dispatch-reading.test.ts 钉住），
    // 客户端的合并代码因此只有一份。
    const raw = Number(url.searchParams.get(PARAMS.since) ?? '0')
    let cursor = Number.isInteger(raw) && raw > 0 ? raw : 0
    // 游标只在这一面推进（发现面没有游标这回事）：它是 `frame` 闭包里的私有状态，机械不认识
    openJobStream(res, (notify) => service.subscribeSearchJob(notify), () => {
      const job = service.searchJobSnapshot(cursor)
      if (job !== null) cursor = job.next
      return { job, done: job !== null && job.phase !== 'running' }
    })
  },
  searchJobStatus: async ({ url, res, service }) => {
    const since = Number(url.searchParams.get(PARAMS.since) ?? '0')
    writeOk(res, { job: service.searchJobSnapshot(Number.isInteger(since) && since > 0 ? since : 0) })
  },
  // ── 书城发现面（按源列出的分类入口：清单 / 分类书单）──────────────────
  exploreKinds: async ({ res, service }) => {
    // 清单是本地派生（按源列出各自声明的分类入口标题，主人 `services/explore.ts` 的
    // `deriveExploreSources`），零网络请求——参与集判据归门面。
    // **只出标题、不出入口地址**：两方言的地址语义不同，那份差异不外泄到跨半契约（`ExploreSources`）
    writeOk(res, service.exploreSources())
  },
  exploreList: async ({ req, res, service }) => {
    // 分类轮次复用搜索那套「提交 + 快照 + SSE」的读面形状：提交即由 Node 半跑完并持有整轮。
    // **浏览轴是「先点名一个源、逛它自己的分类」**（`ADR-0028`）：两个点名都进 body，
    // 缺任何一个都是路由自检的 body 形状判据（400 BadRequest 点名缺哪个）；点了个不存在的源
    // 则由门面的值域判据抛错，经同一份映射落成同一个状态码——路由不复制那份判据。
    const body = await readJsonBody<Record<string, unknown> | null>(req, null)
    const { sourceId, kind } = readBodies.exploreList(body)
    writeOk(res, service.startExploreJob(sourceId, kind))
  },
  exploreListMore: async ({ res, service }) => {
    // 续页：同一轮再要一页。门面说「没得发」就是**没有更多**——回 409 而不是静默成功，
    // 客户端据此把按钮收掉；假装又加载了一轮是拿假事实喂 UI。
    const r = service.loadMoreExploreJob()
    if (r === null) throw new ApiError('没有更多了', 409, 'Conflict')
    writeOk(res, r)
  },
  exploreListStatus: async ({ res, service }) => {
    // 全量快照（跨页累积住在服务端持有者，整帧替换才读得出「这一轮到此刻」——见 ExploreSnapshot）
    writeOk(res, { job: service.exploreJobSnapshot() })
  },
  exploreListStream: async ({ res, service }) => {
    // 与 search 流同一份形状：每帧都是同一份快照，终态即关流。但**这一条流的订阅者不认帧的 id**：
    // 发现面整帧替换（CONTEXT「整帧替换」、`client/explore-job.ts` 的 `apply`），search 面才按 id 验身份。
    openJobStream(res, (notify) => service.subscribeExploreJob(notify), () => {
      const job = service.exploreJobSnapshot()
      return { job, done: job !== null && job.phase !== 'running' }
    })
  },
  book: async ({ url, res, service }) => {
    const { sourceId, url: bookUrl } = requireSourceUrl(url)
    writeOk(res, await service.getDetail(sourceId, bookUrl))
  },
  toc: async ({ url, res, service }) => {
    const { sourceId, url: bookUrl } = requireSourceUrl(url)
    // 本地书分流归书内容读面：__local__ 不查注册表，路由层零 LOCAL 知识
    writeOk(res, await service.getToc(sourceId, bookUrl, { refresh: url.searchParams.get(PARAMS.refresh) === '1' }))
  },
  navigation: async ({ url, res, service }) => {
    const { sourceId, url: bookUrl } = requireSourceUrl(url)
    // 目录树读面：chapters 线性 + items 展示树（EPUB 原生目录；其他书由 toc 派生平面导航）
    writeOk(res, await service.getNavigation(sourceId, bookUrl))
  },
  chapter: async ({ url, res, service }) => {
    const { sourceId, url: bookUrl } = requireSourceUrl(url)
    const indexRaw = url.searchParams.get(PARAMS.index)
    if (indexRaw === null || !/^\d+$/.test(indexRaw)) {
      throw new ApiError(`缺或非法 query 参数 ${PARAMS.index}（需非负整数）`, 400, 'BadRequest')
    }
    // 正文一律是 ChapterContent（文字支 / 图文支由来源与服务层决定，不做旧新双形态兼容）
    writeOk(res, await service.getChapterContent(sourceId, bookUrl, Number(indexRaw), { refresh: url.searchParams.get(PARAMS.refresh) === '1' }))
  },
  // ── shelf 面 ────────────────────────────────────────────────────────
  shelf: async ({ res, service }) => {
    writeOk(res, service.shelfList())
  },
  shelfBatchDelete: async ({ req, res, service }) => {
    // 书架批量删除（多选）：一趟删一批。本地书副本连删的 invariant 归门面 removeBooks——
    // 与单删 removeBook 同一条，路由只做 body 校验与信封。bookKey 走 JSON body，不必编码。
    const body = await readJsonBody<Record<string, unknown> | null>(req, null)
    writeOk(res, await service.removeBooks(readBodies.keys(body)))
  },
  // ── 章节范围导出（流式，from/to 缺席 = 全本）──────────────────────────
  exportBook: async ({ opts, res, service, url }) => {
    const { sourceId, url: bookUrl } = requireSourceUrl(url)
    const title = url.searchParams.get(PARAMS.title)?.trim() || '未命名'
    // 范围参数（1 基含端）：非整数 = 400（先于目录抓取，快速失败）；缺席原样交门面，由它套「全本」缺省
    const parseEdge = (name: string): number | null => {
      const raw = url.searchParams.get(name)
      if (raw === null || raw.trim() === '') return null
      const n = Number(raw)
      if (!Number.isInteger(n)) throw new ApiError(`缺或非法 query 参数 ${name}（需整数）`, 400, 'BadRequest')
      return n
    }
    // 节流值一次导出只读一次（配置页热改只管下一次）：换节奏会让同一份文件前后快慢不一
    const from = parseEdge(PARAMS.from)
    const to = parseEdge(PARAMS.to)
    const delayMs = opts.exportDelayMs === undefined
      ? DEFAULT_EXPORT_DELAY_MS
      : readValue(opts.exportDelayMs)
    const ctrl = new AbortController()
    res.on('close', () => ctrl.abort())                    // 浏览器关页/取消 → 停止后续章节
    // 区间判据（全本缺省 / 越界裁剪 / 倒置）与「目录为空」全归门面 exportRange；本层只翻 outcome
    // 并做传输机械——toc 抓取失败也由它在写头前抛出，错误信封因此仍走正常错误路径（502）
    const out = await service.exportRange(sourceId, bookUrl, from, to, { title, delayMs, signal: ctrl.signal })
    if (out.kind === 'empty-toc') throw new ApiError('目录为空，无内容可导出', 422, 'EmptyToc')
    if (out.kind === 'bad-range') throw new ApiError(`导出范围非法：from(${out.from}) > to(${out.to})`, 422, 'BadRange')
    const { plan } = out
    res.writeHead(200, {
      'content-type': 'text/plain; charset=utf-8',
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(title)}.txt`,
      'x-novel-total-chapters': String(plan.totalInRange),   // 本次范围章数（非全书章数）
      'x-novel-range': `${plan.from}-${plan.to}`,
    })
    try {
      for await (const chunk of plan.stream) {
        if (res.writableEnded) break
        if (!res.write(chunk)) {
          // 背压：等 drain 前先查死连接——destroyed 的响应不会再发 'drain'，挂等会吞掉断连取消
          if (res.destroyed || res.writableEnded) break
          await new Promise<void>((r) => res.once('drain', r))
        }
      }
    } catch (e) {
      // 200 头已发：不能再走 writeError（二次 writeHead → ERR_HTTP_HEADERS_SENT），就地补中断标记
      if (!res.headersSent) throw e
      try {
        if (!res.writableEnded) res.write(`\n[导出中断：${e instanceof Error ? e.message : String(e)}]\n`)
      } catch { /* socket 已死，放弃补写 */ }
    }
    if (!res.writableEnded) res.end()
  },
  // ── 本地书（TXT / EPUB）面 ────────────────────────────────────────────
  local: async ({ res, service, url }) => {
    // 注：id 在 query（DELETE /novel-api/local?id=…，测试钉死），不是路径段——路径段里出现 'id' 不匹配任何表项
    const [id] = requireQuery(url, PARAMS.id)
    writeOk(res, await service.removeLocalBook(id))
  },
  localImport: async ({ req, res, service, url }) => {
    const [name] = requireQuery(url, PARAMS.name)
    const max = service.localImportMaxBytes
    // 流读与上限判据归 readCappedBody（与 JSON 信封体同一份实现），本处只给措辞
    const bytes = await readCappedBody(req, max, (m) => `文件超过 ${formatByteLimit(m)} 上限`)
    // 分流（TXT/EPUB 按内容）、发布与自动上架全归门面；回执就是 wire 的 LocalImportResponse
    writeOk(res, await service.localImport(bytes, name))
  },
  localDocument: async ({ res, service, url }) => {
    // 补充文档（脚注/附录）的图文正文：`id=bookKey` + `documentId`
    const [id, documentId] = requireQuery(url, PARAMS.id, PARAMS.documentId)
    writeOk(res, await service.getLocalSupplement(id, documentId))
  },
  localResource: async ({ res, service, url }) => {
    const [id, resourceId] = requireQuery(url, PARAMS.id, PARAMS.resourceId)
    // 资源读口只认不透明 ID（查资源表 → 打开文件）：查不到/文件不在都在**发头之前**抛（404）
    const resource = await service.getLocalResource(id, resourceId)
    res.writeHead(200, resourceHeaders(resource.mediaType, resource.bytes))
    const { stream } = resource
    // 断连即销毁本条流、流上出错即断连（头已发补不了错误信封，但错误必须留痕，不能吞成静默
    // 断连）。监听挂上后**立刻补查已断连**：上面 await（查资源表 + 打开文件）期间客户端可能
    // 已断开、'close' 不会再来，而这条流源自 FileHandle——没人销毁会挂到 GC，Node 把
    // 「GC 期关闭 FileHandle」当未捕获错误抛（表现为测试收尾时红）。
    res.on('close', () => stream.destroy())
    if (res.destroyed) stream.destroy()
    stream.on('error', (e: unknown) => {
      log.error(`本地资源流出错（${resourceId}，响应头已发，只能断连）:`, e)
      res.destroy()
    })
    res.on('error', (e: unknown) => {
      log.error(`本地资源响应出错（${resourceId}）:`, e)
      stream.destroy()
    })
    stream.pipe(res)
  },
  localWarnings: async ({ res, service, url }) => {
    // 导入说明按需查看（不随每次取章重复携带）
    const [id] = requireQuery(url, PARAMS.id)
    writeOk(res, await service.getLocalImportWarnings(id))
  },
}

/** 6 条参数路由的穷尽分发表（键集由 `ParamRouteName` 逼）：`params` 里是 `:` 段的原值。 */
const PARAM_HANDLERS: { [K in ParamRouteName]: (ctx: HandlerCtx) => Promise<void> } = {
  sourceProbe: async ({ res, service, params }) => {
    const [id] = params
    writeOk(res, await service.probe(id))
  },
  sourceEnabled: async ({ req, res, service, params }) => {
    const [id] = params
    // 单源启停：停用 = 不参与聚合搜索，试跑/验证不受影响
    const body = await readJsonBody<Record<string, unknown> | null>(req, null)
    const enabled = readBodies.enabled(body)
    // 未知 id 由门面抛 SourceNotFoundError；classify 的表把它投影成 404 NotFound，
    // 路由层不再自带第二份判据。
    await service.setEnabled(id, enabled)
    writeOk(res, { enabled })
  },
  sourceAuth: async ({ req, res, service, params }) => {
    const [id] = params
    await authRoute(service, id, req, res)
  },
  sourceDelete: async ({ res, service, params }) => {
    const [id] = params
    const removed = await service.removeSource(id)
    writeOk(res, { removed })
  },
  shelfPut: async ({ req, res, service, params }) => {
    const [key] = params
    await shelfPut(service, decodeSegKey(key), req, res)
  },
  shelfDelete: async ({ res, service, params }) => {
    // 本地书连带删文件（防孤儿 invariant）已归门面 removeBook——路由只剩键解码与信封
    const [key] = params
    writeOk(res, await service.removeBook(decodeSegKey(key)))
  },
}

/** 匹配 → 查表：fence 之后只做三件事——问匹配器（机械住 `routes.ts`）、查分发表、调 handler。
 *  405/404 的信封落点也在这里（状态码是传输关注点，matcher 只回结论）。 */
async function route(
  service: ReadingService, opts: ApiHandlerOptions, method: string, segs: string[], url: URL,
  req: IncomingMessage, res: ServerResponse,
): Promise<void> {
  const matched = matchRoute(method, segs)
  if (matched === null) throw unknownRoute(method, segs)
  if (matched.kind === 'method-mismatch') throw methodMismatchError(method, matched.expectedMethod, matched.pathForMessage)
  const handler = matched.kind === 'hit' ? HANDLERS[matched.route] : PARAM_HANDLERS[matched.route]
  await handler({ service, opts, url, req, res, params: matched.params })
}

/** 路径段百分号解码：非法编码（decodeURIComponent 抛 URIError）→ 400；不要归到 'other'，那会变 500 */
function decodeSegKey(raw: string): string {
  try { return decodeURIComponent(raw) } catch { throw new ApiError('路径含非法百分号编码', 400, 'BadRequest') }
}

/** book/toc/chapter 共用：sourceId 与 url 必填（参数名归 wire 契约 PARAMS） */
function requireSourceUrl(url: URL): { sourceId: string; url: string } {
  const [sourceId, bookUrl] = requireQuery(url, PARAMS.sourceId, PARAMS.url)
  return { sourceId, url: bookUrl }
}

/** 必填 query 参数的唯一尺与唯一措辞处：按序取、trim 后非空才算在场，缺席点名缺哪一个。 */
function requireQuery(url: URL, ...names: string[]): string[] {
  return names.map((name) => {
    const v = url.searchParams.get(name)?.trim() ?? ''
    if (v === '') throw new ApiError(`缺 query 参数 ${name}`, 400, 'BadRequest')
    return v
  })
}

/**
 * 本地资源响应头（安全口径单点）：MIME 用导入期的**验证结果**、禁嗅探、同源 CORP、私有缓存。
 * 独立 SVG 额外附强 CSP：书内 SVG 是重建过的静态文本，仍按「不可信文档」对待——一旦作为文档被
 * 直接打开，默认全部禁掉（`sandbox` 连带禁脚本/表单/插件），不给它任何同源能力。
 * 不在这里拼路径、不设 content-disposition：资源口只服务 `<img>`，不提供原文下载。
 */
function resourceHeaders(mediaType: string, bytes: number): Record<string, string> {
  return {
    'content-type': mediaType,
    'content-length': String(bytes),
    'x-content-type-options': 'nosniff',
    'cross-origin-resource-policy': 'same-origin',
    'cache-control': 'private, max-age=3600',
    ...(mediaType === SVG_MEDIA_TYPE ? { 'content-security-policy': "default-src 'none'; sandbox" } : {}),
  }
}

/** PUT /shelf/:key：body 的字段集类型判别住 wire 的 `readBodies.shelfPut`；**形态分派**
 *  （含 title 非空才加书、三形态皆无 → 400）住本臂——「调用方要的是哪个动作」是传输关注点
 *  （`ADR-0036` 第①条）。合并语义 null/undefined 保值单点住在 `Shelf`。 */
async function shelfPut(
  service: ReadingService, bookKey: string, req: IncomingMessage, res: ServerResponse,
): Promise<void> {
  const body = await readJsonBody<Record<string, unknown> | null>(req, null)
  if (body === null || typeof body !== 'object') throw new ApiError('body 需为 JSON 对象', 400, 'BadRequest')
  // 读口只交事实；值域门（能不能进架、进度取值范围）归门面动词：同一条判断要同时护 HTTP 面与
  // agent 工具面。三形态按 title → patch → progress 的顺位分派。
  const fields = readBodies.shelfPut(body)
  const title = fields.meta.title
  if (typeof title === 'string' && title !== '') {
    writeOk(res, service.shelfAdd(bookKey, { ...fields.meta, title }))
    return
  }
  if (fields.patch !== null) {
    const patched = service.shelfPatch(bookKey, fields.patch)
    if (patched === null) throw new ApiError(NOT_ON_SHELF, 400, 'BadRequest')
    writeOk(res, patched)
    return
  }
  if (fields.progress !== null) {
    const saved = service.shelfSaveProgress(bookKey, fields.progress.chapterIndex, fields.progress.offsetRatio)
    if (saved === null) throw new ApiError(NOT_ON_SHELF, 400, 'BadRequest')
    writeOk(res, saved)
    return
  }
  throw new ApiError(`body 需带 ${PARAMS.title}（加书）/ ${BODY.patch}（打补丁）/ ${BODY.progress}:{${BODY.chapterIndex},${BODY.offsetRatio}}（更新进度）`, 400, 'BadRequest')
}

/** auth 路由：run-login 交门面深动词 `login` 后只做 outcome→HTTP 翻译（loginUrl 形态判别在门内，
 *  dispatch 不读 rules.loginUrl）；loginAction 按按钮名跑动作；否则 cookie / loginInfo 录入。
 *  不再预检存在性（ADR-0036 既定边界）：body 形状分派先于存在性——未知源 + 垃圾 body 报 400，
 *  形状过了 readBodies.auth 才轮到门内 requireSource 的 404。body 读取（含 1 MB 上限）同样先于
 *  存在性：未知源 + 超大 body 报 413，与 404→400 是同一条优先级翻转。 */
async function authRoute(service: ReadingService, id: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody<Record<string, unknown> | null>(req, null)
  const want = readBodies.auth(body)

  if (want.mode === 'run-login') {
    const out = await service.login(id)   // 源不存在 → SourceNotFoundError（writeError 经 classify 映射 404）
    if (out.kind === 'manual') {
      // URL 形态：不执行，回传给 UI 开新 tab + cookie 录入（不注入 WebView）
      writeOk(res, { mode: 'manual', loginUrl: out.loginUrl })
      return
    }
    if (out.kind === 'no-login-url') throw new ApiError('该源未声明 loginUrl', 400, 'BadRequest')
    if (out.kind === 'empty-output') throw new ApiError('loginUrl 未产出 cookie（脚本未 return 或为空）——登录未生效，未写入登录态', 422, 'LoginFailed')
    writeOk(res, { auth: true })   // authed：JS 执行且产出登录态（已落盘）
    return
  }

  if (want.mode === 'login-action') {
    writeOk(res, await service.runLoginAction(id, want.name))
    return
  }

  if (want.mode === 'login-info') {
    await service.saveLoginInfo(id, want.loginInfo)
    writeOk(res, { auth: true })
    return
  }

  // cookie 录入归门面动词（acquiredAt 盖章在门面——dispatch 不再手拼 SourceAuth）
  await service.saveAuth(id, want.cookies, want.headers, want.loginInfo)
  writeOk(res, { auth: true })
}

/** 「方法不允许」405 的唯一措辞处：路径认得、方法不对（匹配器的 method-mismatch 出口）。
 *  路径拼上 `NOVEL_API_PREFIX`：调用方拿到的是可直接照改的完整路径——health 的表内 path 是空串，
 *  拼出来正好是 `/novel-api` 自己（前缀不带尾斜杠，非空路径要自己补分隔）。 */
function methodMismatchError(method: string, expected: string, path: string): ApiError {
  const at = path === '' ? NOVEL_API_PREFIX : `${NOVEL_API_PREFIX}/${path}`
  return new ApiError(`方法不允许: ${method}（${at} 需 ${expected}）`, 405, 'MethodNotAllowed')
}

/** 「未知路由」404 的唯一措辞处：匹配器没认出的路径都由这一句承接。
 *  `tests/api/routes.test.ts` 的**落点判据**就是这句前缀（`startsWith('未知路由')`）——
 *  措辞在这句之外再写一份，漏改的那份会让「路由没接住」被读成「测试找不到证据」。 */
function unknownRoute(method: string, segs: string[]): ApiError {
  return new ApiError(`未知路由: ${method} ${NOVEL_API_PREFIX}/${segs.join('/')}`, 404, 'NotFound')
}

/** 任务互斥（409）与本地书面（400/413/503）的错误→HTTP 投影已全数收进分类表
 *  口径两分法（见 api/wire）：domain 错误走 classify+STATUS_OF；
 *  路由自检错误走 ApiError（自带 status）。本文件不再 inline writeJson 硬编状态码。 */

/** 这三处「看着像业务判据」的东西，各自的归属是定过的，别当违规清理：
 *  ① `shelfPut` / `authRoute` 按 body 形状分派到哪个门面动词——这一层仍住路由：它们由
 *    `PARAM_HANDLERS` 里 shelfPut / sourceAuth 两个 handler 接进来，分派本身是「调用方要的是
 *    哪个动作」，传输关注点；**值域**判据（能不能进架、进度取值范围、登录脚本的形态与执行）全在
 *    门面（`ADR-0019` 那条同一件事；run-login 的判别与执行收在门面 `login()` 的 outcome 里，
 *    本层只翻状态码与文案）。body 的*字段集与形态*判据不在这里重复：它住 `shared/wire.ts` 的
 *    `readBodies`；本层只留一道传输闸——非 JSON 对象 body（含空 body）在交给读口前即 400。
 *    存在性判据同归门面（门内 requireSource 抛 SourceNotFoundError）——故形状分派先于存在性：
 *    未知源 + 垃圾 body 报 400（`ADR-0036` 既定边界）。
 *  ② 导出区间的裁剪与两条 422 不在这层：主人是门面 `services/reading.ts` 的 `exportRange`
 *    （`ADR-0052`）——缺省全本、越界裁剪与裁剪后倒置是同一件事的三面，判据属于导出动作；
 *    本层只留参数**形态**校验（parseEdge 的 400）、写头与流式机械。`services/export.ts` 的头注
 *    记的是它「拿到越界区间即抛」的前置校验，防的是绕过门面的未来调用方，不是第二份策略。
 *  ③ 流式面（导出 / 两条观察流）自己写响应头：它们不套 JSON 信封，是信封的两个有意豁免者。 */
