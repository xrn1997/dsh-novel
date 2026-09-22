import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ReadingService } from '../services/reading.js'
import { exportBook } from '../services/export.js'
import { SourceNotFoundError } from '../services/errors.js'
import { ApiError, isTrustedRequest, readJsonBody, writeError, writeOk } from './wire.js'
import { NOVEL_API_PREFIX, PARAMS, paramRoutes, pickShelfMeta, ROUTES, SEG } from '../shared/wire.js'

/** 「书不在架上」文案单点（此前 shelfPut 两形态逐字两份） */
const NOT_ON_SHELF = '书不在架上，先带 title 调用加入'

/** 非空 string[] body 校验单点（批路由同口径的手写块收口）；字段名是唯一变量（ids / keys） */
function requireStringList(body: Record<string, unknown> | null, field: string): string[] {
  const v = body?.[field]
  if (!Array.isArray(v) || v.length === 0 || !v.every((x) => typeof x === 'string')) {
    throw new ApiError(`body 需为非空 { ${field}: string[] }`, 400, 'BadRequest')
  }
  return v as string[]
}

/** 源批路由的键集（书源 id） */
function requireIds(body: Record<string, unknown> | null): string[] {
  return requireStringList(body, 'ids')
}

/** 书架批路由的键集（bookKey——不是源 id，字段名也就不同名） */
function requireKeys(body: Record<string, unknown> | null): string[] {
  return requireStringList(body, 'keys')
}

/** 路由级可调参数。
 * 本地书面已归门面：LocalBooks 部件与导入上限都在 ReadingService，
 * 此处只剩传输层关注点（导出节流）。 */
export interface ApiHandlerOptions {
  exportDelayMs?: number
}

/**
 * `/novel-api` 前缀路由的内部分发（一条 prefix 路由 + 此处理器）。
 * 不依赖 Cordis——纯构造器，测试用真 http.Server 承载（tests/api/helpers.ts）。
 */
export function createApiHandler(service: ReadingService, opts: ApiHandlerOptions = {}) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      if (!isTrustedRequest(req)) {
        throw new ApiError('非受信来源', 403, 'Forbidden')
      }
      const url = new URL(req.url ?? '/', 'http://dsh.internal')
      if (!url.pathname.startsWith(NOVEL_API_PREFIX)) {
        throw new ApiError(url.pathname, 404, 'NotFound')
      }
      const rest = url.pathname.slice(NOVEL_API_PREFIX.length) || '/'
      const segs = rest.split('/').filter(Boolean)
      await route(service, opts, req.method ?? 'GET', segs, url, req, res)
    } catch (e) {
      writeError(res, e)
    }
  }
}

async function route(
  service: ReadingService, opts: ApiHandlerOptions, method: string, segs: string[], url: URL,
  req: IncomingMessage, res: ServerResponse,
): Promise<void> {
  const [a, b, c] = segs

  // 健康检查（GET /novel-api）
  if (segs.length === 0) {
    guard(method, 'GET', 'sources 面之外仅 GET / 健康检查')
    writeOk(res, { name: 'dsh-novel', apiVersion: 1 })
    return
  }

  if (a === SEG.sources) {
    if (b === undefined) {
      if (method === 'GET') {
        writeOk(res, service.listPublicSources())
        return
      }
      // 同步 POST 导入已移除——导入走 sources/import 后台任务
      throw new ApiError(`方法不允许: ${method} ${NOVEL_API_PREFIX}/sources（导入走 POST /sources/import）`, 405, 'MethodNotAllowed')
    }
    if (b === SEG.import) {
      guard(method, 'POST', ROUTES.sourcesImport.path)
      // 真实 legado 多源导出常见数 MB（实测用户文件 4.8MB/642 源）——上限 32MB，默认 1MB 会把最大流量的包挡在门外
      const body = await readJsonBody<{ files?: unknown } | null>(req, null, 32 * 1024 * 1024)
      const files = body?.files
      if (!Array.isArray(files) || files.length === 0
        || !files.every((f) => f !== null && typeof f === 'object'
          && typeof (f as { name?: unknown }).name === 'string' && typeof (f as { text?: unknown }).text === 'string')) {
        throw new ApiError('body 需为非空 { files: [{ name, text }] }', 400, 'BadRequest')
      }
      writeOk(res, service.startImportJob(files as Array<{ name: string; text: string }>))
      return
    }
    if (b === SEG.jobStatus) {
      // 任务结束后结果保留到下一个任务开始——关设置/刷新页面后重挂载即可恢复展示
      guard(method, 'GET', ROUTES.sourcesJobStatus.path)
      writeOk(res, { job: service.jobStatus() })
      return
    }
    if (b === SEG.batchProbe) {
      guard(method, 'POST', ROUTES.sourcesBatchProbe.path)
      const body = await readJsonBody<Record<string, unknown> | null>(req, null)
      writeOk(res, service.startBatchProbeJob(requireIds(body)))
      return
    }
    if (c === SEG.probe) {
      guard(method, 'POST', paramRoutes.sourceProbe(b))
      writeOk(res, await service.probe(b))
      return
    }
    if (c === SEG.auth) {
      guard(method, 'POST', paramRoutes.sourceAuth(b))
      await authRoute(service, b, req, res)
      return
    }
    if (c === SEG.enabled) {
      // 单源启停：停用 = 不参与聚合搜索，试跑/验证不受影响
      guard(method, 'POST', paramRoutes.sourceEnabled(b))
      const body = await readJsonBody<Record<string, unknown> | null>(req, null)
      const enabled = body?.enabled
      if (typeof enabled !== 'boolean') {
        throw new ApiError('body 需为 { enabled: boolean }', 400, 'BadRequest')
      }
      const found = await service.setEnabled(b, enabled)
      if (!found) {
        // 错误词汇单主人：「源不存在」全走 SourceNotFoundError → 分类表投影 404 NotFound
        throw new SourceNotFoundError(b)
      }
      writeOk(res, { enabled })
      return
    }
    if (b === SEG.batchEnabled) {
      guard(method, 'POST', ROUTES.sourcesBatchEnabled.path)
      const body = await readJsonBody<Record<string, unknown> | null>(req, null)
      const ids = body?.ids
      const enabled = body?.enabled
      if (!Array.isArray(ids) || ids.length === 0 || !ids.every((x) => typeof x === 'string') || typeof enabled !== 'boolean') {
        throw new ApiError('body 需为非空 { ids: string[], enabled: boolean }', 400, 'BadRequest')
      }
      // 未知 id 静默跳过、重复 id 幂等；一次 edit 一次合并落盘——配方知识归门面动词
      const updated = await service.setEnabledMany(ids as string[], enabled)
      writeOk(res, { updated })
      return
    }
    if (b === SEG.batchDelete) {
      // 批量删除：门面动词（一次 edit 合并落盘），替代逐删逐写的 N 次全量重写
      guard(method, 'POST', ROUTES.sourcesBatchDelete.path)
      const body = await readJsonBody<Record<string, unknown> | null>(req, null)
      const removed = await service.removeSources(requireIds(body))
      writeOk(res, { removed })
      return
    }
    if (c === undefined && method === 'DELETE') {
      const removed = await service.removeSource(b)
      writeOk(res, { removed })
      return
    }
    throw new ApiError(`未知路由: ${method} ${NOVEL_API_PREFIX}/${segs.join('/')}`, 404, 'NotFound')
  }

  // ── reading 面（query 驱动， GET）────────────────────────────────────
  if (a === SEG.search && b === SEG.plan) {
    // 搜索参与计划：参与集唯一主人在服务端——客户端分批/进度按此走
    guard(method, 'GET', ROUTES.searchPlan.path)
    writeOk(res, service.searchPlan())
    return
  }
  if (a === SEG.search && b === SEG.job) {
    // 提交即由 Node 半跑完并持有整轮结果——浏览器半只负责看，切界面不再作废在途搜索
    guard(method, 'POST', ROUTES.searchJob.path)
    const body = await readJsonBody<{ keyword?: unknown; sourceIds?: unknown } | null>(req, null)
    const keyword = typeof body?.keyword === 'string' ? body.keyword.trim() : ''
    if (keyword === '') throw new ApiError(`缺 body 字段 ${PARAMS.keyword}`, 400, 'BadRequest')
    const raw = body?.sourceIds
    if (raw !== undefined && (!Array.isArray(raw) || !raw.every((x) => typeof x === 'string'))) {
      throw new ApiError(`body.${PARAMS.sourceIds} 需为 string[]`, 400, 'BadRequest')
    }
    writeOk(res, service.startSearchJob(keyword, raw === undefined ? undefined : { sourceIds: raw as string[] }))
    return
  }
  if (a === SEG.search && b === SEG.jobCancel) {
    // 停止 ≠ 放弃：本轮立即进终态（不再开新的源），已搜出的分组仍留在读面可翻
    guard(method, 'POST', ROUTES.searchJobCancel.path)
    writeOk(res, service.cancelSearchJob())
    return
  }
  if (a === SEG.search && b === SEG.jobStream) {
    // 进度推送的加速器（SSE）：首帧 = 带 `since` 的同一份快照（baseline），此后每次状态变化补一帧，
    // 终态即关流。断线重连 = 重新起一条并带上已收到的游标——「推送不 replay、显式 query 才是真相」
    // 这条官方口径（`docs/reference/dsh-plugin-api.md` §9）由两个通道共用同一游标来兑现，
    // 所以推送在或不在、快或慢，客户端的合并代码是同一份。
    guard(method, 'GET', ROUTES.searchJobStream.path)
    const raw = Number(url.searchParams.get(PARAMS.since) ?? '0')
    let cursor = Number.isInteger(raw) && raw > 0 ? raw : 0
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',          // 经代理不许攒帧：攒了就不是「即时」，而是「整批迟到」
    })
    let off: (() => void) | null = null
    const pump = (): void => {
      if (res.writableEnded || res.destroyed) return
      const job = service.searchJobSnapshot(cursor)
      if (job !== null) cursor = job.next
      res.write(`data: ${JSON.stringify({ job })}\n\n`)
      if (job !== null && job.phase !== 'running') { off?.(); res.end() }
    }
    off = service.subscribeSearchJob(pump)
    res.on('close', () => { off?.() })    // 关页/断连即退订：不给死连接攒帧，也不让监听器长驻持有者
    pump()                                // 首帧（可能是 `{job:null}`：还没提交过，流继续等）
    return
  }
  if (a === SEG.search && b === SEG.jobStatus) {
    guard(method, 'GET', ROUTES.searchJobStatus.path)
    const since = Number(url.searchParams.get(PARAMS.since) ?? '0')
    writeOk(res, { job: service.searchJobSnapshot(Number.isInteger(since) && since > 0 ? since : 0) })
    return
  }
  if (a === SEG.search && b === undefined) {
    guard(method, 'GET', ROUTES.search.path)
    const keyword = url.searchParams.get(PARAMS.keyword)?.trim() ?? ''
    if (keyword === '') throw new ApiError(`缺 query 参数 ${PARAMS.keyword}`, 400, 'BadRequest')
    const ids = url.searchParams.get(PARAMS.sourceIds)?.split(',').filter(Boolean)
    writeOk(res, await service.search(keyword, ids === undefined ? undefined : { sourceIds: ids }))
    return
  }
  if (a === SEG.book && b === undefined) {
    guard(method, 'GET', ROUTES.book.path)
    const { sourceId, url: bookUrl } = requireSourceUrl(url)
    writeOk(res, await service.getDetail(sourceId, bookUrl))
    return
  }
  if (a === SEG.toc && b === undefined) {
    guard(method, 'GET', ROUTES.toc.path)
    const { sourceId, url: bookUrl } = requireSourceUrl(url)
    // 本地书分流归门面：__local__ 不查注册表，路由层零 LOCAL 知识
    writeOk(res, await service.getToc(sourceId, bookUrl, { refresh: url.searchParams.get(PARAMS.refresh) === '1' }))
    return
  }
  if (a === SEG.chapter && b === undefined) {
    guard(method, 'GET', ROUTES.chapter.path)
    const { sourceId, url: bookUrl } = requireSourceUrl(url)
    const indexRaw = url.searchParams.get(PARAMS.index)
    if (indexRaw === null || !/^\d+$/.test(indexRaw)) {
      throw new ApiError(`缺或非法 query 参数 ${PARAMS.index}（需非负整数）`, 400, 'BadRequest')
    }
    writeOk(res, await service.getChapter(sourceId, bookUrl, Number(indexRaw), { refresh: url.searchParams.get(PARAMS.refresh) === '1' }))
    return
  }

  // ── shelf 面 ────────────────────────────────────────────────────────
  if (a === SEG.shelf) {
    if (b === SEG.batchDelete) {
      // 书架批量删除（多选）：一趟删一批。本地书副本连删的 invariant 归门面 removeBooks——
      // 与单删 removeBook 同一条，路由只做 body 校验与信封。bookKey 走 JSON body，不必编码。
      guard(method, 'POST', ROUTES.shelfBatchDelete.path)
      const body = await readJsonBody<Record<string, unknown> | null>(req, null)
      writeOk(res, await service.removeBooks(requireKeys(body)))
      return
    }
    if (b === undefined && method === 'GET') {
      writeOk(res, service.shelfList())
      return
    }
    if (b !== undefined && method === 'PUT') {
      await shelfPut(service, decodeSegKey(b), req, res)
      return
    }
    if (b !== undefined && method === 'DELETE') {
      // 本地书连带删文件（防孤儿 invariant）已归门面 removeBook——路由只剩键解码与信封
      writeOk(res, await service.removeBook(decodeSegKey(b)))
      return
    }
    throw new ApiError(`方法不允许: ${method} ${NOVEL_API_PREFIX}/shelf${b === undefined ? '' : '/:key'}`, 405, 'MethodNotAllowed')
  }

  // ── 章节范围导出（流式，from/to 缺席 = 全本）──────────────────────────
  if (a === SEG.export) {
    guard(method, 'GET', ROUTES.exportBook.path)
    const { sourceId, url: bookUrl } = requireSourceUrl(url)
    const title = url.searchParams.get(PARAMS.title)?.trim() || '未命名'
    // 范围参数（1 基含端）：非整数 = 400（先于目录抓取，快速失败）；缺席 = 全本默认
    const parseEdge = (name: string): number | null => {
      const raw = url.searchParams.get(name)
      if (raw === null || raw.trim() === '') return null
      const n = Number(raw)
      if (!Number.isInteger(n)) throw new ApiError(`缺或非法 query 参数 ${name}（需整数）`, 400, 'BadRequest')
      return n
    }
    const fromRaw = parseEdge(PARAMS.from) ?? 1
    const toRaw = parseEdge(PARAMS.to)
    // 首包前拿 toc：空目录走错误信封；同时喂 X-Novel-Total-Chapters。
    // exportBook 每章都会触发一次 getToc（getChapter 的正文槽位含章名，须先读目录，见 cache-epoch.contentSlot）——
    // 目录已进 PageCache，这些调用全部命中缓存，零网络流量。
    const toc = await service.getToc(sourceId, bookUrl)
    if (toc.length === 0) throw new ApiError('目录为空，无内容可导出', 422, 'EmptyToc')
    // 越界裁剪到 [1, 目录长]；裁剪后倒置 → 422。**范围判据的这一处即单点**：exportBook 只
    // 接受裁好的 from/to（它另有一条越界即抛的前置校验，防的是未来新调用方，不是第二份策略）。
    const clip = (n: number): number => Math.min(Math.max(n, 1), toc.length)
    const from = clip(fromRaw)
    const to = toRaw === null ? toc.length : clip(toRaw)
    if (from > to) throw new ApiError(`导出范围非法：from(${from}) > to(${to})`, 422, 'BadRange')
    const ctrl = new AbortController()
    res.on('close', () => ctrl.abort())                    // 浏览器关页/取消 → 停止后续章节
    res.writeHead(200, {
      'content-type': 'text/plain; charset=utf-8',
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(title)}.txt`,
      'x-novel-total-chapters': String(to - from + 1),      // 本次范围章数（非全书章数）
      'x-novel-range': `${from}-${to}`,
    })
    const gen = exportBook(
      {
        getToc: (s, b) => service.getToc(s, b),
        getChapter: (s, b, i) => service.getChapter(s, b, i),
      },
      sourceId, bookUrl,
      { title, delayMs: opts.exportDelayMs ?? 300, from, to, signal: ctrl.signal },
    )
    try {
      for await (const chunk of gen) {
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
    return
  }

  // ── 本地 TXT 书 ───────────────────────────────────────────────────────
  if (a === SEG.local) {
    if (b === SEG.import) {
      guard(method, 'POST', ROUTES.localImport.path)
      const name = url.searchParams.get(PARAMS.name)?.trim() ?? ''
      if (name === '') throw new ApiError('缺 query 参数 name（文件名）', 400, 'BadRequest')
      const max = service.localImportMaxBytes
      const chunks: Buffer[] = []
      let size = 0
      let over = false
      for await (const chunk of req) {
        size += (chunk as Buffer).length
        if (size > max) { over = true; break }             // 流式计数，不整buf再查
        chunks.push(chunk as Buffer)
      }
      if (over) throw new ApiError(`文件超过 ${Math.round(max / 1024 / 1024)}MB 上限`, 413, 'PayloadTooLarge')
      // ingest + 自动上架归门面动词——路由只做流读与信封
      const imported = await service.localImport(Buffer.concat(chunks), name)
      writeOk(res, { ...imported.book, chapterCount: imported.chapterCount, encoding: imported.encoding })
      return
    }
    // 注：id 在 query（DELETE /novel-api/local?id=…，测试钉死），不是路径段——b === 'id' 不匹配任何 segs
    if (b === undefined) {
      guard(method, 'DELETE', ROUTES.local.path)
      const id = url.searchParams.get(PARAMS.id) ?? ''
      writeOk(res, await service.removeLocalBook(id))
      return
    }
    throw new ApiError(`未知路由: ${method} ${NOVEL_API_PREFIX}/${segs.join('/')}`, 404, 'NotFound')
  }

  throw new ApiError(`未知路由: ${method} ${NOVEL_API_PREFIX}/${segs.join('/')}`, 404, 'NotFound')
}

/** 路径段百分号解码：非法编码（decodeURIComponent 抛 URIError）→ 400（此前归 'other' → 500） */
function decodeSegKey(raw: string): string {
  try { return decodeURIComponent(raw) } catch { throw new ApiError('路径含非法百分号编码', 400, 'BadRequest') }
}

/** book/toc/chapter 共用：sourceId 与 url 必填校验（参数名归 wire 契约 PARAMS） */
function requireSourceUrl(url: URL): { sourceId: string; url: string } {
  const sourceId = url.searchParams.get(PARAMS.sourceId)
  const bookUrl = url.searchParams.get(PARAMS.url)
  if (sourceId === null || sourceId === '' || bookUrl === null || bookUrl === '') {
    throw new ApiError(`缺 query 参数 ${PARAMS.sourceId} / ${PARAMS.url}`, 400, 'BadRequest')
  }
  return { sourceId, url: bookUrl }
}

/** PUT /shelf/:key：body 带 title → 加书；带 patch → 在架书打补丁（不在架 400）；
 *  带 progress → 更新进度（不在架 400）；三者皆无 400。
 *  合并语义（null/undefined 保值）单点住在 Shelf（add=patch 语义 / update=patch 写口）——
 *  此前的「四兄弟条件展开」在这里消亡：类型校验后的缺席键直接透传，保值是 Shelf 的 interface。 */
async function shelfPut(
  service: ReadingService, bookKey: string, req: IncomingMessage, res: ServerResponse,
): Promise<void> {
  const body = await readJsonBody<Record<string, unknown> | null>(req, null)
  if (body === null || typeof body !== 'object') throw new ApiError('body 需为 JSON 对象', 400, 'BadRequest')
  // 字段判别/归一化全走 pickShelfMeta；入架/补丁/进度语义与其**值域门**都归门面动词
  // （门住门面而不是这里：同一条判断要同时护 HTTP 面与 agent 工具面）
  const meta = pickShelfMeta(body)
  if (typeof meta.title === 'string' && meta.title !== '') {
    writeOk(res, service.shelfAdd(bookKey, { ...meta, title: meta.title }))
    return
  }
  if (body.patch !== undefined && typeof body.patch === 'object' && body.patch !== null) {
    const patched = service.shelfPatch(bookKey, pickShelfMeta(body.patch as Record<string, unknown>))
    if (patched === null) throw new ApiError(NOT_ON_SHELF, 400, 'BadRequest')
    writeOk(res, patched)
    return
  }
  const progress = body.progress as { chapterIndex?: unknown; offsetRatio?: unknown } | undefined
  if (progress !== undefined && typeof progress === 'object'
    && typeof progress.chapterIndex === 'number' && typeof progress.offsetRatio === 'number') {
    const saved = service.shelfSaveProgress(bookKey, progress.chapterIndex, progress.offsetRatio)
    if (saved === null) {
      throw new ApiError(NOT_ON_SHELF, 400, 'BadRequest')
    }
    writeOk(res, saved)
    return
  }
  throw new ApiError('body 需带 title（加书）/ patch（打补丁）/ progress:{chapterIndex,offsetRatio}（更新进度）', 400, 'BadRequest')
}

/** auth 路由两形态：runLogin（URL → manual 分流；JS → 沙箱执行）；否则 cookie 录入。
 *  loginUrl 形态判别归门面 loginPlan——dispatch 不再读 rules.loginUrl。 */
async function authRoute(service: ReadingService, id: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  // 存在性先于 body 形态判别（既有 wire 口径：不存在的 id 恒 404，不先报 400）
  if (!service.hasSource(id)) throw new SourceNotFoundError(id)
  const body = await readJsonBody<Record<string, unknown> | null>(req, null)

  if (body !== null && typeof body === 'object' && body.runLogin === true) {
    const plan = service.loginPlan(id)   // 源不存在 → SourceNotFoundError（writeError 映射 404）
    if (plan === null) throw new ApiError('该源未声明 loginUrl', 400, 'BadRequest')
    if (plan.mode === 'manual') {
      // URL 形态：不执行，回传给 UI 开新 tab + cookie 录入（不注入 WebView）
      writeOk(res, { mode: 'manual', loginUrl: plan.loginUrl })
      return
    }
    const auth = await service.runLogin(id)   // JS 形态：沙箱执行 → setAuth + persist
    if (auth === null) throw new ApiError('loginUrl 未产出 cookie（脚本未 return 或为空）——登录未生效，未写入登录态', 422, 'LoginFailed')
    writeOk(res, { auth: true })
    return
  }

  const cookies = (body as Record<string, unknown> | null)?.cookies
  if (typeof cookies !== 'object' || cookies === null || Array.isArray(cookies)) {
    throw new ApiError('body 需为 { cookies: Record<string,string>, headers?: Record<string,string> }', 400, 'BadRequest')
  }
  const headers = (body as Record<string, unknown>).headers
  // cookie 录入归门面动词（acquiredAt 盖章在门面——dispatch 不再手拼 SourceAuth）
  await service.saveAuth(id,
    cookies as Record<string, string>,
    typeof headers === 'object' && headers !== null && !Array.isArray(headers)
      ? headers as Record<string, string> : undefined)
  writeOk(res, { auth: true })
}

function guard(method: string, want: string, what: string): void {
  if (method !== want) throw new ApiError(`方法不允许: ${method}（${what} 需 ${want}）`, 405, 'MethodNotAllowed')
}

/** 任务互斥（409）与本地书面（400/413/503）的错误→HTTP 投影已全数收进分类表
 *  口径两分法（见 api/wire）：domain 错误走 classify+STATUS_OF；
 *  路由自检错误走 ApiError（自带 status）。本文件不再 inline writeJson 硬编状态码。 */
