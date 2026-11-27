import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Readable } from 'node:stream'
import type { ReadingService } from '../services/reading.js'
import { DEFAULT_EXPORT_DELAY_MS } from '../services/export.js'
import { BookNotOnShelfError } from '../services/errors.js'
import { SVG_MEDIA_TYPE } from '../services/epub/resources.js'
import { log } from '../services/log.js'
import { formatByteLimit } from '../services/size.js'
import { readValue, type ValueSource } from '../services/value-source.js'
import { ApiError, fenceAllowlist, fenceDenialOf, readCappedBody, readJsonBody, writeError, writeOk } from './wire.js'
import type { FenceDenial } from './wire.js'
import { BODY, NOVEL_API_PREFIX, PARAMS, readBodies } from '../shared/wire.js'
import { BodyShapeError } from '../shared/wire.js'
import type {
  AiSearchReceipt, AuthSavedReceipt, BatchRemoved, BatchUpdated, EnabledReceipt, ExploreSnapshot,
  HealthReport, JobEnvelope, JobState, RemoveReceipt, RunLoginReceipt, SearchJobSnapshot,
} from '../shared/wire.js'
import { matchRoute } from './routes.js'
import type { ParamRouteName, RouteName } from './routes.js'

/** 「书不在架上」文案单点（shelfPut 的更新形态共用这一句） */
const NOT_ON_SHELF = '书不在架上，先带 title 调用加入'

/** 书不在架（`BookNotOnShelfError`）→ 400 与可行动文案；三种更新形态共用，服务层不带 HTTP 措辞。 */
function shelfUpdate<T>(apply: () => T): T {
  try {
    return apply()
  } catch (e) {
    if (e instanceof BookNotOnShelfError) throw new ApiError(NOT_ON_SHELF, 400, 'BadRequest')
    throw e
  }
}

/** SSE 响应头单点（搜索与发现两条流共用）；`x-accel-buffering` 的「攒帧 = 整批迟到」对两条流同等成立。 */
const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
}

/** 作业观察流机械（搜索与发现共用）：写头 → 变化补帧 → 终态自动退订关流 → 断连退订。
 *  取哪份快照、到没到终态交给 `frame`（游标等副作用留调用方）；两条纪律各写一遍就会漏改，表现为连接不放。
 */
function openJobStream<Job>(res: ServerResponse, subscribe: (notify: () => void) => () => void,
  frame: () => JobEnvelope<Job> & { done: boolean },
): void {
  res.writeHead(200, SSE_HEADERS)
  let off: (() => void) | null = null
  const pump = (): void => {
    if (res.writableEnded || res.destroyed) return
    const f = frame()
    res.write(`data: ${JSON.stringify({ job: f.job } satisfies JobEnvelope<Job>)}\n\n`)
    // `?.` 承重：`subscribe(pump)` 可能在返回退订函数前同步调一次 pump，那时 `off` 还没赋值。
    if (f.done) { off?.(); res.end() }
  }
  off = subscribe(pump)
  res.on('close', () => { off() })                 // 关页/断连即退订：不给死连接攒帧，也不让监听器长驻持有者
  pump()                                            // 首帧（可能是 `{job:null}`：还没提交过，流继续等）
}

/** 路由级可调参数。本地书面归门面，此处只剩传输关注点。`exportDelayMs` 收 getter：热改后下一次导出生效，
 *  但一次导出只读一次——中途换节奏会让同一份文件前后快慢不一。 */
export interface ApiHandlerOptions {
  exportDelayMs?: ValueSource<number>
  /** 同源 fence 的本机名单追加项（`apiAllowHosts`）：启动期读一次就定，不做热更——运行中让掉一个名字的口子更危险。 */
  allowHosts?: readonly string[]
}

/** 403 回显 Host 的长度上限：拒绝理由给别人看，不该被一个超长头撑成整屏。 */
const HOST_ECHO_MAX = 120

/** 403 要可行动：说清是网络位置还是 Host 不对（判据住 `api/wire.ts` 的 `fenceDenialOf`，这里只翻措辞）。 */
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

/** `/novel-api` 前缀路由的内部分发；纯构造器，不依赖 Cordis（测试用真 http.Server 承载）。 */
export function createApiHandler(service: ReadingService, opts: ApiHandlerOptions = {}) {
  // 名单静态配置：构造期归一一次，逐请求查表（`fenceDenialOf` 仍是唯一判据）
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
      // body 形状判据住 wire 契约，落状态码是传输关注点——在这里翻一次，不在每个读口写 try/catch
      writeError(res, e instanceof BodyShapeError ? new ApiError(e.message, 400, 'BadRequest') : e)
    }
  }
}

/** handler 入参：`params` 是 `:` 段原值（百分号未解码），解码归各 handler。 */
type HandlerCtx = {
  service: ReadingService
  opts: ApiHandlerOptions
  url: URL
  req: IncomingMessage
  res: ServerResponse
  params: readonly string[]
}

/** 35 条静态路由的穷尽分发表：漏接/多接 tsc 红；传输机械已下沉（`pipeBinary` / `openJobStream`），
 *  臂体只留分流与错误落点。臂体可回 Promise，分派点一律 await。 */
const HANDLERS: { [K in RouteName]: (ctx: HandlerCtx) => void | Promise<void> } = {
  health: ({ res }) => {
    writeOk(res, { name: 'dsh-novel', apiVersion: 1 } satisfies HealthReport)
  },
  sources: ({ res, service }) => {
    // 导入只走 sources/import 后台任务，本路由是 GET 列表（错方法由匹配器落 405）
    writeOk(res, service.listPublicSources())
  },
  sourcesImport: async ({ req, res, service }) => {
    // 全本多源导出是大包：读体上限必须显式放宽，缺省值会把最大的包拒在门外
    const body = await readJsonBody<Record<string, unknown> | null>(req, null, 32 * 1024 * 1024)
    writeOk(res, service.startImportJob(readBodies.import(body).files))
  },
  sourcesJobStatus: ({ res, service }) => {
    // 任务结束后结果保留到下一个任务开始——关设置/刷新页面后重挂载即可恢复展示
    writeOk(res, { job: service.jobStatus() } satisfies JobEnvelope<JobState>)
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
    writeOk(res, { updated } satisfies BatchUpdated)
  },
  sourcesBatchAiSearch: async ({ req, res, service }) => {
    const body = await readJsonBody<Record<string, unknown> | null>(req, null)
    const { ids, aiSearch } = readBodies.batchAiSearch(body)
    const updated = await service.setAiSearchMany(ids, aiSearch)
    writeOk(res, { updated } satisfies BatchUpdated)
  },
  sourcesBatchDelete: async ({ req, res, service }) => {
    // 批量删除：门面动词（一次 edit 合并落盘），替代逐删逐写的 N 次全量重写
    const body = await readJsonBody<Record<string, unknown> | null>(req, null)
    const removed = await service.removeSources(readBodies.ids(body))
    writeOk(res, { removed } satisfies BatchRemoved)
  },
  search: async ({ url, res, service }) => {
    // 「关键词去空白后非空」两条入口同一把尺：body 侧 `readBodies.searchJob`，query 侧 `requireQuery`（措辞唯一家）。
    const keyword = requireQuery(url, PARAMS.keyword)
    const ids = url.searchParams.get(PARAMS.sourceIds)?.split(',').filter(Boolean)
    writeOk(res, await service.search(keyword, ids === undefined ? undefined : { sourceIds: ids }))
  },
  // ── reading 面（query 驱动， GET）────────────────────────────────────
  searchPlan: ({ res, service }) => {
    // 搜索参与计划：参与集唯一主人在服务端——客户端分批/进度按此走
    writeOk(res, service.searchPlan())
  },
  searchJob: async ({ req, res, service }) => {
    // 提交即由 Node 半跑完并持有整轮结果——浏览器半只负责看，切界面不再作废在途搜索
    const body = await readJsonBody<Record<string, unknown> | null>(req, null)
    const { keyword, sourceIds } = readBodies.searchJob(body)
    writeOk(res, service.startSearchJob(keyword, sourceIds === undefined ? undefined : { sourceIds }))
  },
  searchJobCancel: ({ res, service }) => {
    // 停止 ≠ 放弃：本轮立即进终态（不再开新的源），已搜出的分组仍留在读面可翻
    writeOk(res, service.cancelSearchJob())
  },
  searchJobStream: ({ url, res, service }) => {
    // SSE 加速器：首帧 = 带 `since` 的基线快照，此后每次状态变化补一帧，终态关流；断线重连带已收到的游标重起。
    // 推送不 replay、显式 query 才是真相（since 语义与兜底由 dispatch-reading 测试钉住），客户端合并代码只有一份。
    const raw = Number(url.searchParams.get(PARAMS.since) ?? '0')
    let cursor = Number.isInteger(raw) && raw > 0 ? raw : 0
    // 游标只在这一面推进：它是 `frame` 闭包私有状态，机械不认识。
    openJobStream<SearchJobSnapshot>(res, (notify) => service.subscribeSearchJob(notify), () => {
      const job = service.searchJobSnapshot(cursor)
      if (job !== null) cursor = job.next
      return { job, done: job !== null && job.phase !== 'running' }
    })
  },
  searchJobStatus: ({ url, res, service }) => {
    const since = Number(url.searchParams.get(PARAMS.since) ?? '0')
    writeOk(res, { job: service.searchJobSnapshot(Number.isInteger(since) && since > 0 ? since : 0) } satisfies JobEnvelope<SearchJobSnapshot>)
  },
  // ── 书城发现面（按源列出的分类入口：清单 / 分类书单）──────────────────
  exploreKinds: ({ res, service }) => {
    // 清单本地派生（主人 `services/explore.ts` 的 `deriveExploreSources`），零网络请求。
    // 只出标题、不出入口地址：两方言地址语义不同，不外泄到跨半契约。
    writeOk(res, service.exploreSources())
  },
  exploreList: async ({ req, res, service }) => {
    // 分类轮次复用搜索的「提交 + 快照 + SSE」读面。浏览轴是「先点名一个源、逛它自己的分类」（`ADR-0028`）：
    // 缺 body 字段 = 400，源不存在由门面判据抛错。
    const body = await readJsonBody<Record<string, unknown> | null>(req, null)
    const { sourceId, kind } = readBodies.exploreList(body)
    writeOk(res, service.startExploreJob(sourceId, kind))
  },
  exploreListMore: ({ res, service }) => {
    // 续页：同一轮再要一页。门面说没得发就是没有更多——409 而不是静默成功，客户端据此收按钮。
    const r = service.loadMoreExploreJob()
    if (r === null) throw new ApiError('没有更多了', 409, 'Conflict')
    writeOk(res, r)
  },
  exploreListStatus: ({ res, service }) => {
    // 全量快照（跨页累积住服务端，整帧替换才读得出「这一轮到此刻」）
    writeOk(res, { job: service.exploreJobSnapshot() } satisfies JobEnvelope<ExploreSnapshot>)
  },
  exploreListStream: ({ res, service }) => {
    // 与 search 流同形：每帧同一份快照，终态关流；但发现面整帧替换、不认帧的 id，search 面才按 id 验身份。
    openJobStream<ExploreSnapshot>(res, (notify) => service.subscribeExploreJob(notify), () => {
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
    // 正文一律是 ChapterContent（文字支 / 图文支由来源与服务层决定，单一形态、不设形态协商）
    writeOk(res, await service.getChapterContent(sourceId, bookUrl, Number(indexRaw), { refresh: url.searchParams.get(PARAMS.refresh) === '1' }))
  },
  // ── shelf 面 ────────────────────────────────────────────────────────
  shelf: ({ res, service }) => {
    writeOk(res, service.shelfList())
  },
  shelfBatchDelete: async ({ req, res, service }) => {
    // 书架批量删除：一趟删一批；本地书副本 invariant 归门面 `removeBooks`，路由只做 body 校验与信封。
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
    // 区间判据与「目录为空」归门面 `exportRange`；本层只翻 outcome 并做传输机械（toc 失败也在写头前抛，走 502 信封）。
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
          if (res.destroyed) break
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
    // id 在 query（测试钉死），不是路径段——路径段里出现 'id' 不匹配任何表项
    const id = requireQuery(url, PARAMS.id)
    writeOk(res, await service.removeLocalBook(id))
  },
  localImport: async ({ req, res, service, url }) => {
    const name = requireQuery(url, PARAMS.name)
    const max = service.localImportMaxBytes
    // 流读与上限归 `readCappedBody`；超限是配置边界，报错要点名可调项。
    const bytes = await readCappedBody(req, max,
      (m) => `文件超过 ${formatByteLimit(m)} 上限：可在插件设置的「本地文件导入上限」（localImportMaxBytes）调大`)
    // 分流（TXT/EPUB 按内容）、发布与自动上架全归门面；回执就是 wire 的 LocalImportResponse
    writeOk(res, await service.localImport(bytes, name))
  },
  localDocument: async ({ res, service, url }) => {
    const id = requireQuery(url, PARAMS.id)
    const documentId = requireQuery(url, PARAMS.documentId)
    writeOk(res, await service.getLocalSupplement(id, documentId))
  },
  localResource: async ({ res, service, url }) => {
    const id = requireQuery(url, PARAMS.id)
    const resourceId = requireQuery(url, PARAMS.resourceId)
    // 资源读口只认不透明 ID（查资源表 → 打开文件）：查不到/文件不在都在**发头之前**抛（404）
    const resource = await service.getLocalResource(id, resourceId)
    pipeBinary(res, resource, `本地资源（${resourceId}）`)
  },
  localWarnings: async ({ res, service, url }) => {
    // 导入说明按需查看（不随每次取章重复携带）
    const id = requireQuery(url, PARAMS.id)
    writeOk(res, await service.getLocalImportWarnings(id))
  },
  // ── 听书面（引擎源 / 段合成 / 音频读口 / 引擎订阅）──────────────────────
  ttsSources: ({ res, service }) => {
    // 引擎源清单 + 宿主服务健康；展示名只属于订阅数据，「为什么不在」由 hostSpeech 回答。
    writeOk(res, service.ttsSourcesView())
  },
  ttsSynthesize: async ({ req, res, service }) => {
    // 段合成：回执带缓存键（字节另走 ttsAudio）；失败经 classify 落 400/502/503，不泄漏堆栈
    const body = await readJsonBody<Record<string, unknown> | null>(req, null)
    const p = readBodies.ttsSynthesize(body)
    // 断连即取消（跳段/停止/关页都不该让上游念完计费）；监听挂上后立刻补查已断连——读 body 期间可能已走（同 `pipeBinary`）。
    const ctrl = new AbortController()
    const gone = (): void => { ctrl.abort() }
    res.on('close', gone)
    if (res.destroyed) ctrl.abort()
    try {
      const receipt = await service.ttsSynthesize(p, { signal: ctrl.signal })
      // 回执与写响应之间还有窗口：客户端可能已走，写已关闭响应会抛 WriteAfterEnd；断连那发不用写，也不进错误径。
      if (ctrl.signal.aborted) return
      writeOk(res, receipt)
    } catch (e) {
      // 调用方已走：没有读者，错误信封无处可写（作废不是故障）
      if (ctrl.signal.aborted) return
      throw e
    } finally {
      res.off('close', gone)
    }
  },
  ttsEngines: ({ res, service }) => {
    // 引擎订阅清单（公共投影已剥凭据）——导出 JSON 由 client 用这份数据自组，没有后端导出路由
    writeOk(res, service.ttsEngineList())
  },
  ttsEnginesImport: async ({ req, res, service }) => {
    // 两条来路恰一（形状判据住 readBodies）；URL 支经门面同一个出站 fetcher 拉取
    const body = await readJsonBody<Record<string, unknown> | null>(req, null)
    const want = readBodies.ttsEnginesImport(body)
    writeOk(res, 'json' in want ? service.ttsEngineImport(want.json) : await service.ttsEngineImportFromUrl(want.url))
  },
  ttsAudio: async ({ res, service, url }) => {
    const key = requireQuery(url, PARAMS.key)
    // 未知/非法 key 在**发头之前**落 404（不是空音频，也不是二进制头）
    const audio = await service.ttsOpenAudio(key)
    if (audio === null) throw new ApiError('音频不存在或已过期', 404, 'NotFound')
    pipeBinary(res, audio, `合成音频（${key}）`)
  },
}

/** 8 条参数路由的穷尽分发表（键集由 `ParamRouteName` 逼）：`params` 里是 `:` 段的原值。 */
const PARAM_HANDLERS: { [K in ParamRouteName]: (ctx: HandlerCtx) => void | Promise<void> } = {
  sourceProbe: async ({ res, service, params }) => {
    // 门面交 outcome（wire 读数 + 已写回的 status）：HTTP 面只写 result，状态不重复推导/透出
    writeOk(res, (await service.probe(paramOf(params))).result)
  },
  sourceEnabled: async ({ req, res, service, params }) => {
    // 单源启停：停用 = 不参与聚合搜索，试跑/验证不受影响
    const body = await readJsonBody<Record<string, unknown> | null>(req, null)
    const enabled = readBodies.enabled(body)
    // 未知 id 由门面抛 SourceNotFoundError，经 classify 投影成 404；路由不自带第二份判据。
    await service.setEnabled(paramOf(params), enabled)
    writeOk(res, { enabled } satisfies EnabledReceipt)
  },
  sourceAiSearch: async ({ req, res, service, params }) => {
    // 单源 AI 搜索标记：只影响 AI 工具面的参与集（界面搜索仍看启停）
    const body = await readJsonBody<Record<string, unknown> | null>(req, null)
    const aiSearch = readBodies.aiSearch(body)
    await service.setAiSearch(paramOf(params), aiSearch)
    writeOk(res, { aiSearch } satisfies AiSearchReceipt)
  },
  sourceAuth: async ({ req, res, service, params }) => {
    await authRoute(service, paramOf(params), req, res)
  },
  sourceDelete: async ({ res, service, params }) => {
    const removed = await service.removeSource(paramOf(params))
    writeOk(res, { removed } satisfies RemoveReceipt)
  },
  shelfPut: async ({ req, res, service, params }) => {
    await shelfPut(service, decodeSegKey(paramOf(params)), req, res)
  },
  shelfDelete: async ({ res, service, params }) => {
    // 本地书连带删文件（防孤儿 invariant）归门面 removeBook——路由只剩键解码与信封
    writeOk(res, await service.removeBook(decodeSegKey(paramOf(params))))
  },
  ttsEnginePut: async ({ req, res, service, params }) => {
    // 引擎 id 含 `:`：构造器编码成段，这里解码（非法百分号 → 400，不归 500）
    const id = decodeSegKey(paramOf(params))
    const body = await readJsonBody<Record<string, unknown> | null>(req, null)
    writeOk(res, service.ttsEnginePut(id, readBodies.ttsEnginePut(body)))
  },
  ttsEngineDelete: ({ res, service, params }) => {
    writeOk(res, service.ttsEngineRemove(decodeSegKey(paramOf(params))))
  },
}

/** 匹配 → 查表：问匹配器（`routes.ts`）、查分发表、调 handler；405/404 信封落点也在这里。 */
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
  const sourceId = requireQuery(url, PARAMS.sourceId)
  const bookUrl = requireQuery(url, PARAMS.url)
  return { sourceId, url: bookUrl }
}

/** 必填 query 的唯一尺与措辞：trim 后非空才算在场，缺席点名缺哪一个。 */
function requireQuery(url: URL, name: string): string {
  const v = url.searchParams.get(name)?.trim() ?? ''
  if (v === '') throw new ApiError(`缺 query 参数 ${name}`, 400, 'BadRequest')
  return v
}

/** `:` 段取值：表内每模式只有一个 `:` 段、匹配器按段数判等，首项必在界内；判空只让编译器跟上，落空 = 匹配器契约已破（404 家族）。 */
function paramOf(params: readonly string[]): string {
  const [only] = params
  if (only === undefined) throw new ApiError('路径参数缺失', 404, 'NotFound')
  return only
}

/**
 * 二进制响应头（安全口径单点）：MIME 用已验证事实、禁嗅探、同源 CORP、私有缓存。本地 SVG 额外附强 CSP：
 * 书内 SVG 按不可信文档对待，`sandbox` 连带禁脚本/表单/插件。
 * `accept-ranges: none` 把「不支持分段」写成明话；将来补 Range 改这一处与读流器。
 * 不拼路径、不设 content-disposition：两个读口只服务 `<img>` / `<audio>`，不提供原文下载。
 */
function resourceHeaders(mediaType: string, bytes: number): Record<string, string> {
  return {
    'content-type': mediaType,
    'content-length': String(bytes),
    'accept-ranges': 'none',
    'x-content-type-options': 'nosniff',
    'cross-origin-resource-policy': 'same-origin',
    'cache-control': 'private, max-age=3600',
    ...(mediaType === SVG_MEDIA_TYPE ? { 'content-security-policy': "default-src 'none'; sandbox" } : {}),
  }
}

/** 二进制传输机械（本地资源与合成音频共用）：调用方已拿到资源并在发头前抛过 404。断连即销毁流，
 *  流出错即断连（头已发补不了信封，但错误必须留痕）。挂监听后立刻补查断连：await 期间客户端可能已走，
 *  FileHandle 没人销毁会挂到 GC，Node 当未捕获错误抛。 */
function pipeBinary(
  res: ServerResponse,
  resource: { mediaType: string; bytes: number; stream: Readable },
  label: string,
): void {
  res.writeHead(200, resourceHeaders(resource.mediaType, resource.bytes))
  const { stream } = resource
  res.on('close', () => stream.destroy())
  if (res.destroyed) stream.destroy()
  stream.on('error', (e: unknown) => {
    log.error(`${label}流出错（响应头已发，只能断连）:`, e)
    res.destroy()
  })
  res.on('error', (e: unknown) => {
    log.error(`${label}响应出错:`, e)
    stream.destroy()
  })
  stream.pipe(res)
}

/** PUT /shelf/:key：字段集判别住 `readBodies.shelfPut`，形态分派（title 非空才加书、四形态皆无 → 400）是本臂的
 *  传输关注点（`ADR-0036`）。更新动词缺席各自抛 `BookNotOnShelfError`，三个分支共用 `shelfUpdate` 翻成 400；不预检。
 */
async function shelfPut(
  service: ReadingService, bookKey: string, req: IncomingMessage, res: ServerResponse,
): Promise<void> {
  const body = await readJsonBody<Record<string, unknown> | null>(req, null)
  if (body === null || typeof body !== 'object') throw new ApiError('body 需为 JSON 对象', 400, 'BadRequest')
  // 读口只交事实；值域门归门面（同时护 HTTP 面与工具面）。四形态按 title → patch → progress → listen 分派。
  const fields = readBodies.shelfPut(body)
  const title = fields.meta.title
  if (typeof title === 'string' && title !== '') {
    writeOk(res, service.shelfAdd(bookKey, { ...fields.meta, title }))
    return
  }
  if (fields.patch !== null) {
    const { patch } = fields
    writeOk(res, shelfUpdate(() => service.shelfPatch(bookKey, patch)))
    return
  }
  if (fields.progress !== null) {
    const { progress } = fields
    writeOk(res, shelfUpdate(() => service.shelfSaveProgress(bookKey, progress.chapterIndex, progress.offsetRatio)))
    return
  }
  if (fields.listen !== null) {
    const { listen } = fields
    writeOk(res, shelfUpdate(() => service.shelfSaveListen(bookKey, listen)))
    return
  }
  throw new ApiError(`body 需带 ${PARAMS.title}（加书）/ ${BODY.patch}（打补丁）/ ${BODY.progress}:{${BODY.chapterIndex},${BODY.offsetRatio}}（更新进度）/ ${BODY.listen}:{${BODY.chapterIndex},${BODY.paragraphIndex},${BODY.engineId},${BODY.voice},${BODY.rate},${BODY.volume}}（存听书位置）`, 400, 'BadRequest')
}

/** auth 路由：run-login 交门面 `login` 后只翻 outcome（loginUrl 判别在门内）；loginAction 按按钮名跑动作；
 *  否则 cookie / loginInfo 录入。body 形状分派先于存在性（未知源 + 垃圾 body 报 400），body 读取也先于存在性
 *  （未知源 + 超大 body 报 413）。 */
async function authRoute(service: ReadingService, id: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody<Record<string, unknown> | null>(req, null)
  const want = readBodies.auth(body)

  if (want.mode === 'run-login') {
    const out = await service.login(id)   // 源不存在 → SourceNotFoundError（writeError 经 classify 映射 404）
    if (out.kind === 'manual') {
      // URL 形态：不执行，回传给 UI 开新 tab + cookie 录入（不注入 WebView）
      writeOk(res, { mode: 'manual', loginUrl: out.loginUrl } satisfies RunLoginReceipt)
      return
    }
    if (out.kind === 'no-login-url') throw new ApiError('该源未声明 loginUrl', 400, 'BadRequest')
    if (out.kind === 'empty-output') throw new ApiError('loginUrl 未产出 cookie（脚本未 return 或为空）——登录未生效，未写入登录态', 422, 'LoginFailed')
    writeOk(res, { auth: true } satisfies AuthSavedReceipt)   // authed：JS 执行且产出登录态（已落盘）
    return
  }

  if (want.mode === 'login-action') {
    writeOk(res, await service.runLoginAction(id, want.name))
    return
  }

  if (want.mode === 'login-info') {
    await service.saveLoginInfo(id, want.loginInfo)
    writeOk(res, { auth: true } satisfies AuthSavedReceipt)
    return
  }

  // cookie 录入归门面动词（acquiredAt 盖章在门面——dispatch 不再手拼 SourceAuth）
  await service.saveAuth(id, want.cookies, want.headers, want.loginInfo)
  writeOk(res, { auth: true } satisfies AuthSavedReceipt)
}

/** 405 唯一措辞：路径认得、方法不对。路径拼上前缀，调用方拿到可直接照改的完整路径
 *  （health 的空 path 拼出 `/novel-api` 自己）。 */
function methodMismatchError(method: string, expected: string, path: string): ApiError {
  const at = path === '' ? NOVEL_API_PREFIX : `${NOVEL_API_PREFIX}/${path}`
  return new ApiError(`方法不允许: ${method}（${at} 需 ${expected}）`, 405, 'MethodNotAllowed')
}

/** 404 唯一措辞：匹配器没认出的路径都由这句承接；`tests/api/routes.test.ts` 以「未知路由」前缀为落点判据，别处不再写。 */
function unknownRoute(method: string, segs: string[]): ApiError {
  return new ApiError(`未知路由: ${method} ${NOVEL_API_PREFIX}/${segs.join('/')}`, 404, 'NotFound')
}

/** 错误 → HTTP 投影全在分类表（两分法见 api/wire）：domain 走 classify + STATUS_OF，路由自检走 ApiError；
 *  本文件不 inline writeJson 硬编状态码。 */

/**
 * 三处「像业务判据」的归属是定过的，别当违规清理：
 * ① shelfPut / authRoute 按 body 形状分派动词：分派是传输关注点；值域与存在性全在门面（`ADR-0019` / `ADR-0036`）。
 * ② 导出区间裁剪与两条 422 归门面 `exportRange`（`ADR-0052`）；本层只留参数形态校验与流式机械。
 * ③ 流式面（导出 / 两条观察流）自己写响应头：不套 JSON 信封，是信封的两个有意豁免者。
 */
