import { promises as fs } from 'node:fs'
import path from 'node:path'
import { evaluate, RuleEvalError } from '../engine/index.js'
import type { Facet } from '../engine/index.js'
import { absUrl, auxFieldOf, detailContextOf, detailFieldsOf, engineContextOf, extractItems, fieldOf, firstValue, kindFieldOf, makeSubEval, resolveHeaders, wordCountFieldOf } from './bridge.js'
import type { Page, SubRuleEval } from './bridge.js'
import { PageCache } from './cache.js'
import { contentSlot, rulesEpoch } from './cache-epoch.js'
import { chapterContentToText } from './chapter-content.js'
import { contentToText, formatIntro } from './content.js'
import { ChapterNotFoundError, InvalidRequestError, LocalNotMountedError, RuleMissingError, SourceNotFoundError } from './errors.js'
import { createFetcher, decodeBody, fetchTextPage } from './fetcher.js'
import type { Fetcher } from './fetcher.js'
import { SourceJobs } from './import-job.js'
import { SearchJobs } from './search-job.js'
import type { JobHost } from './import-job.js'
import type { ImportFile, JobState } from './import-job.js'
import { SourceIntake } from './intake.js'
import { isLocalBookKey, LOCAL_SOURCE_ID, LocalBooks } from './localbooks.js'
import type { LocalResource } from './localbooks.js'
import type { NormalizeIssue } from './normalize.js'
import { followPages } from './pagination.js'
import type { FollowResult } from './pagination.js'
import { probeSource } from './probe.js'
import type { ProbeResult } from './probe.js'
import { absUrlKeepOption, assembleRequest, canonUrl, fetchInitOf, stripUrlOption } from './request.js'
import { fetchSearchPage, searchErrorCodeOf } from './search-face.js'
import type { SearchFaceResult } from './search-face.js'
import { Shelf } from './shelf.js'
import { SourceRegistry } from './sources.js'
import type { NovelSource, SourceAuth } from './types.js'

// ── 公开类型（冻结：HTTP 面 / 工具面 / UI 只准用这套）──────────────────
// 值形状定义在 wire 契约（src/shared/wire.ts）——
// 此处 re-export 保持既有 import 路径可用；改形状请去 shared，别在这里加第二份。
export type { SearchHit, SearchGroup, ChapterEntry, BookDetail, SearchJobSnapshot } from '../shared/wire.js'
/** 本地资源读口（含流/MIME 的 Node 内部形状）：api 层从本模块取用，不去 localbooks 抄第二处 */
export type { LocalResource } from './localbooks.js'
import { planarNavigation } from '../shared/wire.js'
import type {
  BookDetail, BookNavigation, ChapterContent, LocalImportResponse, LocalImportWarning, SearchGroup, SearchHit,
  SearchPlan, SearchJobSnapshot, ChapterEntry, ShelfBook, ShelfEntry, ShelfMetaPatch, SourcePublic,
} from '../shared/wire.js'
export interface ReadingServiceOptions {
  dir: string                       // novel 根目录（测试注入 mkdtemp）
  fetchImpl?: typeof globalThis.fetch
  searchParallel?: number           // 默认 5
  searchTimeoutMs?: number          // 默认 15000
  /** js 沙箱预算（透传 EvalContext.jsTimeoutMs；缺省 15000——引擎 2000 只作回退）：
   *  legado Rhino 无硬超时，多请求目录脚本（java.ajax×2 + md5，txs12 源实测）2s 必炸 */
  jsTimeoutMs?: number
  tocMaxPages?: number              // 默认 200
  contentMaxPages?: number          // 默认 50
  cacheMaxBytes?: number            // 默认 200MB
  /** 本地文件导入上限（TXT / EPUB 共用：传输层流式计数与本地书 domain 上限同一配置值；默认 50MB） */
  localImportMaxBytes?: number
  /** 出站代理（见 proxy.ts：Node 的 fetch 不读系统代理）；null/缺省 = 直连 */
  proxyUrl?: string | null
  /** 宿主 `ctx.jobs` 窄面：任务身份与生命周期交它（见 import-job.ts 的 JobHost），缺省不登记 */
  jobHost?: JobHost
}
export interface ImportOutcome {
  sourceId: string | null; name: string; ok: boolean
  missing: NormalizeIssue[]; warnings: NormalizeIssue[]
  probe: ProbeResult | null
  /** 按址去重命中（intake 入库规则）：同 baseUrl 已有可用源，保留已有条目未新增——
   *  sourceId 给可用的那条。此前同步导入无去重（规则只在任务路径），同一地址可重复入库。 */
  dupSkipped?: boolean
}

// ── 服务实现 ────────────────────────────────────────────────────────────

/**
 * 阅读链路门面：HTTP API / agent 工具 / UI 三个面的**唯一**业务入口。
 * 规则求值全部经引擎；抓取全部经守门 fetcher；缓存/书架/注册表在其上编排。
 */
export class ReadingService {
  private readonly tocInflight = new Map<string, Promise<ChapterEntry[]>>()
  private constructor(
    private readonly cfg: { searchParallel: number; tocMaxPages: number; contentMaxPages: number },
    private readonly searchTimeoutMs: number,
    /** js 沙箱预算（engineContextOf/求值上下文组装时带上——引擎 `ctx.jsTimeoutMs ?? DEFAULT` 消费） */
    private readonly jsTimeoutMs: number,
    /** 本地书导入上限（传输层流式计数与本地书 domain 上限同一配置值——index 只传一次） */
    readonly localImportMaxBytes: number,
    private readonly registry: SourceRegistry,
    private readonly shelf: Shelf,
    private readonly cache: PageCache,
    private readonly fetcher: Fetcher,
    private readonly jobs: SourceJobs,
    /** 聚合搜索的后台持有者（读任务，与写的 `jobs` 分槽——见 services/search-job.ts 的理由） */
    private readonly searchJobs: SearchJobs,
    private readonly local: LocalBooks | null,
  ) {}

  /**
   * 生产快捷方式：建目录 + 从磁盘装配部件，再交 from() 总装。
   * 业务类不再被迫知道目录与加载细节——组合根与业务自此可分（server 侧）。
   * 本地书面：LocalBooks 也在此装配——「删书不留孤儿文件」invariant 归门面。
   */
  static async create(opts: ReadingServiceOptions): Promise<ReadingService> {
    // 主动建数据目录：保证存在 + 快速失败（dir 指向文件时 mkdir 抛错——ready 拒绝，入口层零注册）
    await fs.mkdir(opts.dir, { recursive: true })
    const localImportMaxBytes = opts.localImportMaxBytes ?? 50 * 1024 * 1024
    return ReadingService.from({
      fetcher: createFetcherWith(opts.fetchImpl, opts.proxyUrl),
      registry: await SourceRegistry.load(opts.dir),
      shelf: await Shelf.load(opts.dir),
      cache: new PageCache(opts.dir, opts.cacheMaxBytes),
      local: await LocalBooks.create(opts.dir, { maxImportBytes: localImportMaxBytes }),
      localImportMaxBytes,
      searchParallel: opts.searchParallel,
      jobHost: opts.jobHost,
      tocMaxPages: opts.tocMaxPages,
      contentMaxPages: opts.contentMaxPages,
      searchTimeoutMs: opts.searchTimeoutMs,
      jsTimeoutMs: opts.jsTimeoutMs,
    })
  }

  /**
   * 组合根注入面：接受已建好的部件（registry/shelf/cache/fetcher/local）直接总装——
   * 测试可换内存 registry adapter / 确定性 fetcher，而不必每次 mkdtemp + importOne。
   * 后台任务面在此接线：导入/批量验证的探针口径与 search/probe 同一
   * fetcher 出口；timeoutMs 同源（探针与搜索对同一站点用同一耐心值）。
   * 部件（registry/shelf/jobs/local）总装后即 private——外部只经门面动词。
   */
  static async from(parts: {
    registry: SourceRegistry
    shelf: Shelf
    cache: PageCache
    fetcher: Fetcher
    local?: LocalBooks
    /** 宿主 `ctx.jobs` 的窄面（见 import-job.ts 的 JobHost）；缺省即不登记，任务语义不变 */
    jobHost?: JobHost
    localImportMaxBytes?: number
    searchParallel?: number
    tocMaxPages?: number
    contentMaxPages?: number
    searchTimeoutMs?: number
    jsTimeoutMs?: number
  }): Promise<ReadingService> {
    const searchTimeoutMs = parts.searchTimeoutMs ?? 15000
    const jsTimeoutMs = parts.jsTimeoutMs ?? 15000
    // searchParallel ≤ 0 → 批循环 `i += 0` 永不终止（组合根直装也必须炸，不能挂起）
    const searchParallel = parts.searchParallel ?? 5
    if (!Number.isInteger(searchParallel) || searchParallel < 1) {
      throw new RangeError(`searchParallel 必须为正整数，收到 ${String(searchParallel)}`)
    }
    return new ReadingService(
      {
        searchParallel,
        tocMaxPages: parts.tocMaxPages ?? 200,
        contentMaxPages: parts.contentMaxPages ?? 50,
      },
      searchTimeoutMs,
      jsTimeoutMs,
      parts.localImportMaxBytes ?? 50 * 1024 * 1024,
      parts.registry, parts.shelf, parts.cache, parts.fetcher,
      new SourceJobs({
        registry: parts.registry,
        probe: (s) => probeSource(s, parts.fetcher, { timeoutMs: searchTimeoutMs, jsTimeoutMs }),
        ...(parts.jobHost === undefined ? {} : { host: parts.jobHost }),
      }),
      new SearchJobs(parts.jobHost === undefined ? {} : { host: parts.jobHost }),
      parts.local ?? null,
    )
  }

  // ── 导入与探针 ───────────────────────────────────────────────────────

  /** 对象或数组 → 逐条导入（数组项独立 try/catch，单条炸不拖垮整批）。
   *  一批一个 SourceIntake 实例——批内留首条与后台任务同口径（入库规则唯一实现归 intake）。 */
  async importSource(raw: unknown): Promise<ImportOutcome[]> {
    const items = Array.isArray(raw) ? raw : [raw]
    const intake = new SourceIntake(this.registry)
    const out: ImportOutcome[] = []
    for (const item of items) {
      try {
        out.push(await this.projectIntake(intake, item))
      } catch (e) {
        out.push({
          sourceId: null, name: '(未命名)', ok: false,
          missing: [{ field: '(异常)', message: String(e) }], warnings: [], probe: null,
        })
      }
    }
    return out
  }

  /** 单对象：交 SourceIntake 入库（normalize → 按址去重 → add/replace；与任务路径同一实现）。
   *  **不探针**——验证归 jobs 批量验证任务（UI）或 probe 路由/工具（单点）；
   *  status 恒 unverified，probe 字段恒 null。 */
  async importOne(raw: unknown): Promise<ImportOutcome> {
    return this.projectIntake(new SourceIntake(this.registry), raw)
  }

  /** IntakeDecision → ImportOutcome 投影（呈现映射，不再各自判去重） */
  private async projectIntake(intake: SourceIntake, raw: unknown): Promise<ImportOutcome> {
    const d = await intake.intake(raw)
    switch (d.kind) {
      case 'failed':
        return { sourceId: null, name: d.name, ok: false, missing: d.missing, warnings: d.warnings, probe: null }
      case 'skipped':
        return {
          sourceId: d.existing?.id ?? null, name: d.name, ok: true, dupSkipped: true,
          missing: [], warnings: d.warnings, probe: null,
        }
      case 'added':
      case 'replaced':
        return { sourceId: d.source.id, name: d.source.name, ok: true, missing: [], warnings: d.warnings, probe: null }
    }
  }

  /** 探针已有源（API/tools 的 probe 路由/工具用）：与 importOne 的探针段同口径。
   *  超时与 js 预算都必须与搜索同耐心（`searchTimeoutMs` / `jsTimeoutMs` 两个单点）——
   *  两者都曾在这条门面上漏传：fetcher 侧落回固定 15s、js 侧落回引擎 2s，于是同一个源
   *  在导入期探针（带预算）与门面探针（不带）拿回两个 verdict。 */
  async probe(id: string): Promise<ProbeResult> {
    const s = this.requireSource(id)
    const r = await probeSource(s, this.fetcher, { timeoutMs: this.searchTimeoutMs, jsTimeoutMs: this.jsTimeoutMs })
    await this.registry.edit((tx) => tx.setStatus(id, r.ok ? 'verified' : 'broken', r.error?.message, r.probedAt))
    return r
  }

  // ── 写侧动词：变更知识归门面，HTTP 面不再手写 edit 配方 ────────────────────

  /** 书源对外投影列表（凭据红线：raw/rules/auth 不出服务层——调用方不必知道 toPublic） */
  listPublicSources(): SourcePublic[] {
    return this.registry.list().map((s) => this.registry.toPublic(s))
  }

  /** 启停单源；不存在 → false */
  async setEnabled(id: string, enabled: boolean): Promise<boolean> {
    return this.registry.edit((tx) => tx.setEnabled(id, enabled))
  }

  /** 启停批量：未知 id 静默跳过、重复 id 幂等；返回实际变更数（一次 edit 一次合并落盘） */
  async setEnabledMany(ids: string[], enabled: boolean): Promise<number> {
    return this.registry.edit((tx) => {
      let n = 0
      for (const id of new Set(ids)) if (tx.setEnabled(id, enabled)) n++
      return n
    })
  }

  /** 删单源；不存在 → false */
  async removeSource(id: string): Promise<boolean> {
    return this.registry.edit((tx) => tx.remove(id))
  }

  /** 批量删源；返回实际删除数 */
  async removeSources(ids: string[]): Promise<number> {
    return this.registry.edit((tx) => tx.removeAll(ids))
  }

  /** cookie 录入（auth 路由的录入形态）：acquiredAt 由门面盖章——调用方不再手拼 SourceAuth */
  async saveAuth(id: string, cookies: Record<string, string>, headers?: Record<string, string>): Promise<void> {
    this.requireSource(id)
    const auth: SourceAuth = { cookies, acquiredAt: Date.now(), ...(headers === undefined ? {} : { headers }) }
    await this.registry.edit((tx) => tx.setAuth(id, auth))
  }

  /** loginUrl JS 形态：沙箱执行取 cookie 串 → 解析 k=v; → setAuth + persist。
   *  空产出（脚本没 return 出 cookie，或只用 cookie.setCookie 垫片——该 jar 从不回读）**不算登录**：
   *  返回 null 且不写 auth。此前仍构造空 SourceAuth 落库 → `hasAuth: !!s.auth` 变 true、
   *  UI 显示「已登录」而零凭据（状态位如实）。
   * URL 形态由调用侧分流（不在此处理——开新 tab + cookie 录入，不注入 WebView）。 */
  async runLogin(id: string): Promise<SourceAuth | null> {
    const s = this.requireSource(id)
    const loginUrl = s.rules.loginUrl
    if (loginUrl === null) throw new Error(`源「${s.name}」未声明 loginUrl`)
    const v = await evaluate('@js:' + loginUrl, engineContextOf(this.fetcher, s, { baseUrl: s.baseUrl, jsTimeoutMs: this.jsTimeoutMs }), 'rule')
    const text = firstValue(v, 'rule') ?? ''
    const cookies: Record<string, string> = {}
    for (const seg of text.split(';')) {
      const t = seg.trim()
      if (t === '') continue
      const eq = t.indexOf('=')
      if (eq > 0) cookies[t.slice(0, eq).trim()] = t.slice(eq + 1).trim()  // 无 = 的段跳过，不炸
    }
    if (Object.keys(cookies).length === 0) return null   // 空产出：不写登录态（如实 → UI 仍显示未登录）
    const auth: SourceAuth = { cookies, acquiredAt: Date.now() }
    await this.registry.edit((tx) => tx.setAuth(id, auth))
    return auth
  }

  /** 登录计划：loginUrl 形态判别归门面——URL 形态 → manual（回传 UI 开新 tab），
   *  JS 形态 → 沙箱执行 runLogin；未声明 loginUrl → null（路由映射 400）。dispatch 不再读 rules。 */
  loginPlan(id: string): { mode: 'manual'; loginUrl: string } | { mode: 'js' } | null {
    const s = this.requireSource(id)
    const loginUrl = s.rules.loginUrl
    if (loginUrl === null) return null
    return /^https?:\/\//i.test(loginUrl) ? { mode: 'manual', loginUrl } : { mode: 'js' }
  }

  // ── 门面动词：部件收 private，dispatch/tools 只经动词 ──────────────────────

  /** 源存在性判别：listSources/getSource 删除——全量 NovelSource 投影
   *  （含 raw/rules/auth）出服务层破凭据红线，而生产唯一用途只是存在性判别；
   *  测试经组合根自持 registry 部件（from），不为断言开门面洞。 */
  hasSource(id: string): boolean {
    return this.registry.get(id) !== undefined
  }

  // ── 书架动词 ──

  /** 书架读取面：落盘条目 + **来源投影**（sourceName）。
   *  源名在这里实时 join 注册表（与 SearchGroup.sourceName 同一口径）——落盘快照会在源改名 /
   *  同址替换复用 id 后陈旧（intake 复用旧 id，见按址去重）。join 不到 = 源已被删 → null。 */
  shelfList(): ShelfEntry[] {
    return this.shelf.list().map((b) => ({ ...b, sourceName: this.sourceNameOf(b.sourceId) }))
  }

  /** 来源投影的唯一算式：本地书恒 null（本地身份归 LOCAL_SOURCE_ID 判别，不查注册表）；
   *  注册表里没有该 id（源被删/从未存在）→ null。 */
  private sourceNameOf(sourceId: string): string | null {
    if (sourceId === LOCAL_SOURCE_ID) return null
    return this.registry.get(sourceId)?.name ?? null
  }

  /** 加书（title 形态）：字段判别归 pickShelfMeta，此处只管「入架」语义。
   *  title / sourceId 必填非空——曾用 `meta.sourceId ?? ''` 静默兜底：缺源/型错的加书返回 200 落
   *  一条永远读不了的书（`getToc('') → SourceNotFoundError`），写入静默、读取才炸。
   *  值域门住在这里而不是路由：本动词 HTTP 面与 agent 工具面共用，门长在路由只护了一半。 */
  shelfAdd(bookKey: string, meta: ShelfMetaPatch & { title: string }): ShelfBook {
    const sourceId = meta.sourceId
    if (typeof sourceId !== 'string' || sourceId === '') {
      throw new InvalidRequestError('加书需带非空 sourceId')
    }
    if (meta.title === '') throw new InvalidRequestError('加书需带非空 title')
    return this.shelf.add({ ...meta, bookKey, sourceId, title: meta.title })
  }

  /** 打补丁（patch 形态）：不在架 → null（路由映射 400——不静默造书） */
  shelfPatch(bookKey: string, patch: ShelfMetaPatch): ShelfBook | null {
    return this.shelf.update(bookKey, patch)
  }

  /** 存进度（progress 形态）：不在架 → null（路由映射 400）；返回更新后的条目。
   *  值域门住在这里（同 shelfAdd）：`JSON.parse('1e999')` = Infinity 会一路落盘成 null
   *  （`JSON.stringify(Infinity) === 'null'`）——静默数据损坏，只护 HTTP 面护不住工具面。 */
  shelfSaveProgress(bookKey: string, chapterIndex: number, offsetRatio: number): ShelfBook | null {
    if (!Number.isInteger(chapterIndex) || chapterIndex < 0
      || !Number.isFinite(offsetRatio) || offsetRatio < 0 || offsetRatio > 1) {
      throw new InvalidRequestError('progress.chapterIndex 需为非负整数、offsetRatio 需为 [0,1] 有限数')
    }
    if (this.shelf.get(bookKey) === undefined) return null
    this.shelf.updateProgress(bookKey, chapterIndex, offsetRatio)
    return this.shelf.get(bookKey) ?? null
  }

  /** 删书：本地书连带删文件（防孤儿 invariant 归门面——此前住 dispatch 路由分支） */
  async removeBook(bookKey: string): Promise<{ removed: boolean }> {
    const removed = this.shelf.remove(bookKey)
    if (removed && isLocalBookKey(bookKey) && this.local !== null) await this.local.remove(bookKey)
    return { removed }
  }

  /** 批量删书（书架多选）：与逐本 removeBook 同一条 invariant——本地书副本连删**只对真在架的键**做
   *  （故取 removeMany 的返回条目而不是把请求键全过一遍：幽灵键不该去动磁盘）。
   *  未知键静默跳过、重复键幂等，返回实际删除数（与批路由同口径）。 */
  async removeBooks(bookKeys: readonly string[]): Promise<{ removed: number }> {
    const gone = this.shelf.removeMany(bookKeys)
    if (this.local !== null) {
      for (const b of gone) {
        if (isLocalBookKey(b.bookKey)) await this.local.remove(b.bookKey)
      }
    }
    return { removed: gone.length }
  }

  // ── 任务动词 ──

  /** 提交导入任务（运行中互斥由单任务槽裁决——JobRunningError 上抛，路由映射 409） */
  startImportJob(files: ImportFile[]): { jobId: string } {
    return this.jobs.startImport(files)
  }

  /** 提交批量验证任务 */
  startBatchProbeJob(ids: string[]): { jobId: string } {
    return this.jobs.startBatchProbe(ids)
  }

  /** 当前/最近任务态（结果保留到下一个任务开始） */
  jobStatus(): JobState | null {
    return this.jobs.status()
  }

  // ── 本地书动词 ──

  /** 本地导入（TXT / EPUB 按**内容**分流）+ 自动上架，返回 wire 的 `LocalImportResponse`
   *  （dispatch 直接回显，不再逐字段拼装）。书目字段（作者/封面/总章数）走既有 SHELF_META 字段集；
   *  本地格式不新增可 patch 字段。 */
  async localImport(bytes: Buffer, name: string): Promise<LocalImportResponse> {
    const imported = await this.requireLocal().import(bytes, name)
    let book: ShelfBook
    try {
      book = this.shelf.add({
        sourceId: LOCAL_SOURCE_ID, bookKey: imported.bookKey, title: imported.title, ...imported.book,
      })
    } catch (e) {
      // 发布已成功、入架却失败：不回滚就会留一份「长得像书但没人认识」的副本（EPUB 是一整棵目录）
      await this.requireLocal().remove(imported.bookKey)
      throw e
    }
    return {
      ...book,
      chapterCount: imported.chapterCount,
      format: imported.format,
      encoding: imported.encoding,
      warnings: imported.warnings,
    }
  }

  /** 本地书目录（bookKey 即本地书 id）——私有：分流归 getToc，路由层不再持 LOCAL 知识 */
  private localToc(bookKey: string): Promise<ChapterEntry[]> {
    return this.requireLocal().getToc(bookKey)
  }

  /** 补充文档（脚注/附录）图文正文：本地 EPUB 专有（「文档」这一层只有它有） */
  getLocalSupplement(bookKey: string, documentId: string): Promise<ChapterContent> {
    return this.requireLocal().getSupplement(bookKey, documentId)
  }

  /** 本地资源读口（流/MIME/字节数；磁盘路径不出服务层） */
  getLocalResource(bookKey: string, resourceId: string): Promise<LocalResource> {
    return this.requireLocal().getResource(bookKey, resourceId)
  }

  /** 本地导入告警（阅读器按需重看导入说明）：非 EPUB 恒空数组 */
  getLocalImportWarnings(bookKey: string): Promise<LocalImportWarning[]> {
    return this.requireLocal().getImportWarnings(bookKey)
  }

  /** 删本地书：文件 + 书架条目一并删（任一命中即 removed） */
  async removeLocalBook(id: string): Promise<{ removed: boolean }> {
    const localRemoved = await this.requireLocal().remove(id)
    const shelfRemoved = this.shelf.remove(id)
    return { removed: localRemoved || shelfRemoved }
  }

  private requireLocal(): LocalBooks {
    if (this.local === null) throw new LocalNotMountedError()
    return this.local
  }

  // ── 搜索 ─────────────────────────────────────────────────────────────

  /** 聚合搜索的**唯一实现**。`onGroup` 是增量出口：单源求值完成即按完成序交付，
   *  返回值仍按参搜源序——HTTP 面与工具面的既有形状一字不改，而后台任务/将来做任务的
   *  那一路可以边跑边被看见（浏览器半原先自持的分批循环只为拿这个增量，随之后退）。
   *  sourceIds 缺省**或空数组**都视为「未限定」= 搜全部启用源（工具描述承诺「缺省搜全部启用源」；
   *  此前空数组静默变成「搜零个源」——`!opts?.sourceIds` 对 [] 为 false，零分组空结果）。 */
  async searchProgressive(keyword: string, opts?: {
    sourceIds?: string[]
    onGroup?: (group: SearchGroup, index: number) => void
    /** 协作式停止：置位后**不再开新的源**（在途的不撤回）。搜索做成后台任务时的取消出口。 */
    shouldStop?: () => boolean
  }): Promise<SearchGroup[]> {
    const want = opts?.sourceIds
    const sources = this.registry.list().filter((s) =>
      ReadingService.participates(s) && (want === undefined || want.length === 0 || want.includes(s.id)))
    const groups: SearchGroup[] = new Array(sources.length)
    for (let i = 0; i < sources.length; i += this.cfg.searchParallel) {
      if (opts?.shouldStop?.() === true) break
      const batch = sources.slice(i, i + this.cfg.searchParallel)
      await Promise.all(batch.map(async (s, j) => {
        if (opts?.shouldStop?.() === true) return         // 收手：该源不发了，结果里也就没有它
        const index = i + j
        const group = await this.searchOne(s, keyword)
        groups[index] = group
        opts?.onGroup?.(group, index)
      }))
    }
    // 停止时数组可能有洞（filter 天然跳过洞位）；未停止时无洞，与旧行为逐字相同
    return groups.filter((g): g is SearchGroup => g !== undefined)
  }

  /** 一次性收齐全部命中：`searchProgressive` 的薄壳。**批循环只此一处**——
   *  搜索后台化的正确动作是给上面那份加消费方，不是再写第二个循环。 */
  search(keyword: string, opts?: { sourceIds?: string[] }): Promise<SearchGroup[]> {
    return this.searchProgressive(keyword, opts)
  }

  /** 聚合搜索参与集判定（**唯一**实现）：启用 ∧ 文本源。本插件当前仅支持小说文本面
   *  （wire `SourceContentKind` 注释同口径）；将来支持其他媒介时**只在此扩参与集**，
   *  不许散落第二处判别（用户拍板 2026-09：「未来未必不支持其他类型，现在只支持小说」）。
   *  非文本源留库、不删、不改启用态——只是不参搜（漫画/短剧书不再混进文字书架）。 */
  private static participates(s: NovelSource): boolean {
    return s.enabled && s.type === 'text'
  }

  /** 搜索参与计划：search 的参与集判定的唯一主人——客户端分批/进度按此走，
   *  「哪些源参搜」（启停 ∧ 内容形态 invariant）不再在 wire 两侧各定义一份。 */
  searchPlan(): SearchPlan {
    return { sourceIds: this.registry.list().filter((s) => ReadingService.participates(s)).map((s) => s.id) }
  }

  /** 提交一轮**后台**搜索：参与集判定与 `total` 同源（都是 searchPlan 那一条启停 invariant），
   *  运行体是**同一份** `searchProgressive`——批循环只此一处，这里只是换了个消费方。
   *  结果由 `SearchJobs` 持有，所以切界面 / 切 tab 都不影响它跑完。 */
  startSearchJob(keyword: string, opts?: { sourceIds?: string[] }): { jobId: string } {
    const want = opts?.sourceIds
    const plan = this.searchPlan().sourceIds                 // 参与集单主人：启停 invariant 不在此抄第二份
    const ids = want === undefined || want.length === 0 ? plan : plan.filter((id) => want.includes(id))
    return this.searchJobs.start(keyword, ids.length,
      (emit, shouldStop) => this.searchProgressive(keyword, {
        sourceIds: ids,
        onGroup: (g): void => { emit(g) },
        shouldStop,
      }))
  }

  /** 停止本轮搜索：只停「还要去搜的源」，已搜出的命中留在读面（保留期照旧）。返回 false = 本轮早已收尾
   *  （点了个空钮），不是错误；在途的最多 `searchParallel` 条不撤回，回来照旧计入。 */
  cancelSearchJob(): { cancelled: boolean } { return { cancelled: this.searchJobs.cancel('用户停止了搜索') } }

  /** 搜索任务读面：`since` = 客户端已收到的组数（完成序游标）；null = 无任务或已过保留期 */
  searchJobSnapshot(since = 0): SearchJobSnapshot | null { return this.searchJobs.snapshot(since) }

  /** 搜索任务的「变了」信号口（SSE 路由用它拉增量；信号不带数据，游标归每条连接）。返回退订口。 */
  subscribeSearchJob(listener: () => void): () => void { return this.searchJobs.subscribe(listener) }

  private async searchOne(s: NovelSource, keyword: string): Promise<SearchGroup> {
    const base = {
      sourceId: s.id, sourceName: s.name, status: s.status,
      statusDetail: s.statusDetail, hits: [] as SearchHit[],
    }
    try {
      // 请求语义全走搜索面（search-face.ts，与探针同一实现）：模板解析/组装/超时/解码/列表求值
      const page = await fetchSearchPage(s, keyword, this.fetcher, this.searchTimeoutMs, this.jsTimeoutMs)
      if (!page.ok) {
        return { ...base, error: { code: 'RuleMissing', message: page.message } }
      }
      if (page.shape === 'info') {
        // 整段响应就是详情页（对面 BookList.getInfoItem）：按详情规则展开成**一条**书目
        const hit = await this.infoHitOf(s, page)
        return { ...base, hits: hit === null ? [] : [hit] }
      }
      const hits: SearchHit[] = []
      for (const item of page.items) {
        // 求值与相对链接基准 = 落地地址（浏览器语义，与目录/正文面同口径——重定向站点不再错位）
        const ctx = { html: item, baseUrl: page.landedUrl }
        // ruleBookName 的非空保障在搜索面（缺规则整体 RuleMissing，不降级 `?? ''`——空串规则返回整页文本会造垃圾标题）
        const title = firstValue(await page.subEval(s.rules.ruleBookName ?? '', ctx, 'search', 'value'), 'search')
        if (title === null || title.trim() === '') continue // 书名非空才算书目
        const [author, href, cover, intro, last, kind, wordCount] = await Promise.all([
          // 作者/书地址 = 对面的裸奔项（不吞：空书名才丢条目，作者与 URL 照原口径）
          fieldOf(page.subEval, s.rules.ruleAuthor, ctx, 'search'),
          fieldOf(page.subEval, s.rules.ruleBookUrl, ctx, 'search'),
          // 下面五项在对面各包 try/catch：坏规则只丢该字段，不带走整页书目（bridge.metaFieldOf）
          auxFieldOf(page.subEval, s.rules.ruleCoverUrl, ctx, 'search'),
          auxFieldOf(page.subEval, s.rules.ruleIntro, ctx, 'search'),
          auxFieldOf(page.subEval, s.rules.ruleLastChapter, ctx, 'search'),
          // 分类/字数：同上，另注意 kind 是多值逗号串、wordCount 在解析层就格式化
          kindFieldOf(page.subEval, s.rules.ruleKind, ctx, 'search'),
          wordCountFieldOf(page.subEval, s.rules.ruleWordCount, ctx, 'search'),
        ])
        hits.push({
          title, author,
          // 书 URL 保留 `,{option}` 后缀落库（legado 口径：URL 即请求规格——米读类 POST API 源的
          // book_id 藏在选项 body 里，剥掉即身份残废；与章节 URL「保留选项」同源，见 request.absUrlKeepOption）
          url: href === null ? null : absUrlKeepOption(href, page.landedUrl),
          coverUrl: cover === null ? null : absUrl(cover, page.landedUrl),
          // 简介是**展示文本**：对面 BookList 走 HtmlFormatter.format(...).take(5000)（搜索面
          // **不认**渲染指令前缀，那是详情面的事）。Miss 仍是 null，不折成空串。
          intro: intro === null ? null : formatIntro(intro),
          lastChapterName: last,
          kind, wordCount,
        })
      }
      return { ...base, hits }
    } catch (e) {
      return { ...base, error: { code: searchErrorCodeOf(e), message: errorMessageOf(e) } }
    }
  }

  /** 搜索面 info 形态的一条书目：字段走 bridge.detailFieldsOf（与 getDetail 同一份实现，
   *  含 init 换根——对面 BookList.getInfoItem 调的就是同一个 analyzeBookInfo），求值基准是
   *  落地地址（对面 setBaseUrl(res.url)），书地址用面算好的 bookUrl。
   *  书名为空 → null：对面 `book.name.isNotBlank()` 才收这一条，「0 命中」是**结果**不是失败。 */
  private async infoHitOf(
    s: NovelSource, page: Extract<SearchFaceResult, { ok: true; shape: 'info' }>,
  ): Promise<SearchHit | null> {
    const f = await detailFieldsOf(s, page.subEval, page.body, page.landedUrl, { onEmptyInit: 'no-book' })
    if (f === null || f.title === null || f.title.trim() === '') return null
    return {
      title: f.title, author: f.author, url: page.bookUrl,
      coverUrl: f.coverUrl, intro: f.intro, lastChapterName: f.lastChapterName,
      kind: f.kind, wordCount: f.wordCount,
    }
  }

  // ── 详情 ─────────────────────────────────────────────────────────────

  async getDetail(sourceId: string, url: string): Promise<BookDetail> {
    const s = this.requireSource(sourceId)
    // 引擎上下文（相对链接解析/字段求值）用剥选项的地址；抓取用全串——选项由 assembleRequest 解释
    const base = stripUrlOption(url)
    // legado `book` 变量：详情面规则常见 `book.bookUrl`/`book.origin` 引用（脚本/模板段）
    // legado 的变量住在 chapter/book/ruleData 上，跨规则可见——这里给这次 getDetail 一张
    // 共享 vars 表：init 的 `@put:{n:"[property$=book_name]@content"}` 写进去，
    // 随后的 `@get:{n}` 字段规则与 tocUrl 模板才读得到（各次调用新建，不跨门面共享）。
    const subEval = makeSubEval(this.fetcher, s, {
      vars: {}, book: { bookUrl: url, origin: s.baseUrl }, jsTimeoutMs: this.jsTimeoutMs,
    })
    const html = await this.fetchText(s, url)
    const { rules } = s
    // 详情五字段（init 换根 + ruleDetail* 优先、平铺回退 + 简介详情面口径）单点在
    // bridge.detailFieldsOf：对面 BookList.getInfoItem 调的就是同一个 analyzeBookInfo，
    // 搜索面的 info 形态（bookUrlPattern 嗅探）与本方法共用，不各写一份回落链。
    // 已知重复：下面 tocUrlOf 会再算一次同样的 init（它收的是规则原文 + 惰性 html，形态与这里不同）。
    // 刻意不为它改签名：init 绝大多数是纯 JSONPath（`$.data.bookInfo` 一类，不触网），代价是一次求值；
    // 而 tocUrlOf 的两个调用点里只有一侧手里已有 html，硬并要把惰性 provider 换成可空入参——
    // 那换来的是签名变宽与「谁负责 html」易主，不是少一次 CPU。真源若用 js 形态的 init 会双打站点，
    // 届时按那个源来改，而不是现在为假想情况加一层缓存。
    const fields = await detailFieldsOf(s, subEval, html, base)
    const tocUrl = await tocUrlOf(s.rules.ruleTocUrl, rules.ruleDetailInit, url, async () => html, subEval)
    return { ...fields, tocUrl }
  }

  // ── 目录 ─────────────────────────────────────────────────────────────

  /** 目录：缓存优先（refresh 跳过）+ in-flight 去重（同书并发只拉一次）+ 翻页闸跟进。
   *  本地书分流在门面内：sourceId=__local__ 走本地书面——
   *  dispatch 不再持 LOCAL 分流知识，localToc/localChapter 收为私有 */
  getToc(sourceId: string, bookUrl: string, opts?: { refresh?: boolean }): Promise<ChapterEntry[]> {
    if (sourceId === LOCAL_SOURCE_ID) return this.localToc(bookUrl)
    const key = `${sourceId}|${bookUrl}`
    const inflight = this.tocInflight.get(key)
    if (inflight !== undefined) return inflight
    const p = this.getTocInner(sourceId, bookUrl, opts)
      .finally(() => { this.tocInflight.delete(key) })
    this.tocInflight.set(key, p)
    return p
  }

  /** 目录导航：`chapters` 是线性阅读序列（与 getToc 同一份），`items` 是展示用树。
   *  本地书读持久化导航（EPUB 原生 nav/NCX；TXT 由线性序列派生），其他书按 getToc 派生平面导航——
   *  派生单点在 wire 的 `planarNavigation`，不在这里另造一棵树，也不在客户端重推导。 */
  async getNavigation(sourceId: string, bookUrl: string): Promise<BookNavigation> {
    if (sourceId === LOCAL_SOURCE_ID) return this.requireLocal().getNavigation(bookUrl)
    const chapters = await this.getToc(sourceId, bookUrl)
    return { chapters, items: planarNavigation(chapters) }
  }

  private async getTocInner(sourceId: string, bookUrl: string, opts?: { refresh?: boolean }): Promise<ChapterEntry[]> {
    const s = this.requireSource(sourceId)
    // 代际在取到源之后算一次，读与写共用同一个值：在途请求写的就是它起飞时的代际，
    // 换规则后的读永远看不见（这就是「旧在途写回」不需要取消通道的原因）
    const epoch = rulesEpoch(s.rules, s.baseUrl, 'toc')
    if (opts?.refresh !== true) {
      const cached = await this.cache.getToc(sourceId, bookUrl, epoch)
      if (cached !== null) return JSON.parse(cached) as ChapterEntry[]
    }
    // 订正：目录三规则任一缺失不得降级 `?? ''`——空串规则返回整页文本，宁炸不猜
    // 列表选择器：ruleChapterList（对象方言 ruleToc.chapterList——实测 631/637 与搜索列表不同）；
    // 平铺方言缺它时回退 ruleBookList（legado 平铺口径：搜索/目录共用列表规则）
    const { ruleChapterName, ruleChapterUrl } = s.rules
    const listRule = s.rules.ruleChapterList ?? s.rules.ruleBookList
    if (listRule === null || ruleChapterName === null || ruleChapterUrl === null) {
      throw new RuleMissingError('toc', 'ruleChapterList/ruleBookList',
        `源「${s.name}」缺目录规则（ruleChapterList/ruleBookList 之一 + ruleChapterName/ruleChapterUrl）——无法构建目录`)
    }
    // legado `book` 变量：目录规则常见 `book.bookUrl`（36小说网 chapterUrl）与 `book.origin`
    // （努努书坊 ruleTocUrl `{{book.origin}}/e/...`——源站点域名即注册表 baseUrl）
    const subEval = makeSubEval(this.fetcher, s, { book: { bookUrl, origin: s.baseUrl, tocUrl: bookUrl }, jsTimeoutMs: this.jsTimeoutMs })
    const tocUrl = await tocUrlOf(s.rules.ruleTocUrl, s.rules.ruleDetailInit, bookUrl,
      () => this.fetchText(s, bookUrl), subEval)
    const extract = async (page: Page): Promise<ChapterEntry[]> => {
      const listV = await subEval(listRule, { html: page.body, json: page.json, baseUrl: page.url }, 'toc', 'list')
      const out: ChapterEntry[] = []
      let fellBack = 0
      for (const item of extractItems(listV)) {
        const ctx = { html: item, baseUrl: page.url }
        const name = firstValue(await subEval(ruleChapterName, ctx, 'toc', 'value'), 'toc')
        const href = firstValue(await subEval(ruleChapterUrl, ctx, 'toc', 'value'), 'toc')
        // 章节 URL 常带 `,{"webView":true}` 等选项后缀（legado 嗅探语义）——**保留后缀落库**，
        // 抓取时由 fetchPage → assembleRequest 解释（POST/charset/headers 选项不再被丢弃）；
        // URL 取不到时 legado 回退目录页地址（BookChapterList「未获取到url,使用baseUrl替代」）——
        // 不再整条丢弃（此前「url null → 跳过」把整站目录清成 0 章）
        const missing = href === null || href.trim() === ''
        const url = href !== null && href.trim() !== '' ? absUrlKeepOption(href, page.url) : page.url
        if (name !== null && url !== null) {
          if (missing) fellBack++
          out.push({ name, url })
        }
      }
      // 逐章回退服务的是「个别条目缺链接」；**每一条都回退**就不是缺链接，而是 ruleChapterUrl
      // 整体失效——静默产出 N 条指向目录页自身的 toc 等于拿合法形状冒充成功（本仓镜像的
      // 宁炸不猜），且正文面每次都在目录页上求值，读者只看到「点开没内容」。
      if (out.length > 0 && fellBack === out.length) {
        throw new RuleEvalError(
          `目录 URL 规则未取到任何章节地址（段 ruleChapterUrl: ${ruleChapterUrl}；${out.length} 条全部回退目录页 ${page.url}）`,
          { facet: 'toc', segmentIndex: 0, segmentRaw: ruleChapterUrl, hits: 0 },
        )
      }
      return out
    }
    const result = await this.followOrSingle(
      tocUrl,
      (u) => this.fetchPage(s, u),
      extract,
      s.rules.nextTocUrl,          // null → 短路单页（open item ③ 钉死）
      (c) => c.url,
      this.cfg.tocMaxPages,
      'toc',
      subEval,
    )
    const chapters = result.items
    await this.cache.setToc(sourceId, bookUrl, epoch, JSON.stringify(chapters))
    return chapters
  }

  // ── 正文 ─────────────────────────────────────────────────────────────

  /** 章节正文（**文字面**）：现有 AI 工具 / TXT 导出 / 阅读器的文字出口——经**唯一**投影
   *  `chapterContentToText`（TXT 与在线文本逐字通过，幂等），不写第二份文字实现。 */
  async getChapter(sourceId: string, bookKey: string, chIndex: number, opts?: { refresh?: boolean }): Promise<string> {
    return chapterContentToText(await this.getChapterContent(sourceId, bookKey, chIndex, opts))
  }

  /**
   * 章节正文（**图文面**）：本地 EPUB 返回规范化图文树（按需读该章的文档 JSON），
   * 本地 TXT 与在线书返回文字章。
   *
   * 在线那条**仍走既有私有文本路径** `onlineChapterText`：不在这里第二次规范化，也不让两者互调
   * （互调 = 递归 + 双份归一，正文会按调用方向被处理两遍）。本地书的分流也归门面：
   * dispatch 与工具面都不持 LOCAL 知识。
   */
  getChapterContent(sourceId: string, bookKey: string, chIndex: number, opts?: { refresh?: boolean }): Promise<ChapterContent> {
    if (sourceId === LOCAL_SOURCE_ID) return this.requireLocal().getChapterContent(bookKey, chIndex)
    return this.onlineChapterText(sourceId, bookKey, chIndex, opts).then((text) => ({ kind: 'text', text }))
  }

  /** 在线正文的**唯一文本路径**（既有实现，签名外的一切行为未变）：缓存优先（refresh 跳过）；
   *  目录缺章报错；多页串接；Miss 抛 RuleEvalError 不吞。本地书不走这里。 */
  private async onlineChapterText(sourceId: string, bookKey: string, chIndex: number, opts?: { refresh?: boolean }): Promise<string> {
    const s = this.requireSource(sourceId)
    const epoch = rulesEpoch(s.rules, s.baseUrl, 'content')
    // 目录上移到缓存读取之前：正文槽位含章名（挡章序位移串配，见 cache-epoch.contentSlot）。
    // 如实记代价：目录缓存命中时是一次文件读 + JSON.parse；目录缺失（首次 / 被 prune 淘汰）时
    // 会真发一次目录抓取——热正文缓存不再能单独服务一章。这是「槽位含章名」的必然代价，
    // 不是可以优化掉的疏忽（章名只存在于目录里）。
    const toc = await this.getToc(sourceId, bookKey)
    // 双边守卫：负数曾绕过单边 `>= toc.length` → toc[-1].name TypeError → 500。
    // HTTP 面有 /^\d+$/，工具面 chapterIndex 无下限——守卫必须盖住两面的入口。
    if (chIndex < 0 || chIndex >= toc.length) throw new ChapterNotFoundError(chIndex, toc.length)
    const target = toc[chIndex]
    const slot = contentSlot(epoch, target.name)
    if (opts?.refresh !== true) {
      const cached = await this.cache.getContent(sourceId, bookKey, chIndex, slot)
      if (cached !== null) {
        // 代际只覆盖规则、不覆盖代码版本：升级后仍会读到旧提取代码写下的条目（如 @html 源的
        // 带标签正文）——出边界再收一次口（contentToText 幂等），旧条目照样无害。
        const text = contentToText(cached)
        // 空正文一律当未命中：修复前「站点跳转落地页零命中」会被静默写成 0 字节缓存（笔趣阁 27 章全空），
        // 旧条目也就地失效重取，不再永远吐空
        if (text.trim() !== '') return text
      }
    }
    const ruleContent = s.rules.ruleContent
    if (ruleContent === null) {
      // 订正：正文规则缺失不得降级 `?? ''`
      throw new RuleMissingError('content', 'ruleContent', `源「${s.name}」缺正文规则 ruleContent`)
    }
    // legado 变量注入：`book`（bookUrl/name…——36小说网 ruleChapterUrl 用 book.bookUrl.replace）
    // 与 `chapter`（title/index/url——正文脚本 `chapter.title` 广泛使用）
    const shelfBook = this.shelf.get(bookKey)
    const subEval = makeSubEval(this.fetcher, s, {
      book: {
        bookUrl: bookKey,
        origin: s.baseUrl,
        tocUrl: bookKey,
        ...(shelfBook?.title === undefined ? {} : { name: shelfBook.title }),
        ...(shelfBook?.author === undefined ? {} : { author: shelfBook.author }),
      },
      chapter: { title: target.name, index: chIndex, url: target.url, baseUrl: target.url },
      jsTimeoutMs: this.jsTimeoutMs,
    })
    const extract = async (page: Page): Promise<string[]> => {
      const v = await subEval(ruleContent, { html: page.body, json: page.json, baseUrl: page.url }, 'content', 'value')
      const text = firstValue(v, 'content')
      if (text === null) {
        throw new RuleEvalError('正文规则没取到内容', {
          facet: 'content', segmentIndex: 0, segmentRaw: ruleContent, hits: 0,
        })
      }
      // 正文契约是纯文本：@html 类规则收回来的是 HTML 片段（久久小说网 #view_content_txt@html
      // 实测 21 个 <p> 原样打给读者）——先转纯文本，再走行规约
      const plain = normalizeChapterText(contentToText(text))
      if (plain.trim() === '') {
        // 零命中不得静默：空正文曾被当正常结果写进缓存——站点整站 302 到 google 的落地页里
        // 恰好有元素命中 .con 但无文本，27 章 0 字节缓存、用户只看到「不出正文」。
        // 报错带上规则与落点（请求地址 + 实际落地地址，两者不同即说明被跳转走了）。
        const landed = page.requestedUrl === undefined || page.requestedUrl === page.url
          ? page.url
          : `${page.requestedUrl} → ${page.url}`
        throw new RuleEvalError(`正文规则零命中（段 ruleContent: ${ruleContent}；页面落点 ${landed}）`, {
          facet: 'content', segmentIndex: 0, segmentRaw: ruleContent, hits: 0,
        })
      }
      return [plain]
    }
    const result = await this.followOrSingle(
      target.url,
      (u) => this.fetchPage(s, u),
      extract,
      s.rules.nextPageUrl,         // null → 短路单页（open item ③ 钉死）
      (text) => text,              // 整页文本做 key：重复页触发回环闸
      this.cfg.contentMaxPages,
      'content',
      subEval,
      {
        // 串章闸（legado 口径）：候选「下一页」== 目录里其他章节 URL → 到底。
        // 目录知识是正判据——路径启发式会把 `?id=..&cid=..&page=2` 这类非页码键分页误判成串章
        // （「一章只解析出一页」的根因之一）；启发式仅在无目录知识时兜底（见 pagination.ts）
        stopUrls: new Set(toc.map((c) => canonUrl(c.url)).filter((u) => u !== canonUrl(target.url))),
      },
    )
    const text = result.items.join('\n')
    await this.cache.setContent(sourceId, bookKey, chIndex, slot, text)
    return text
  }

  /** 收尾落盘：书架（防抖进度）+ 注册表（合并写）一并等齐 */
  async flush(): Promise<void> { await Promise.all([this.shelf.flush(), this.registry.flush()]) }

  // ── 内部 ─────────────────────────────────────────────────────────────

  /**
   * next 规则短路：null → 单页提取（无翻页发现能力，直接 end）；
   * 非 null → 走翻页闸 followPages。followPages 收到的 nextRule 永远非空。
   */
  private async followOrSingle<T>(
    startUrl: string,
    fetchPage: (url: string) => Promise<Page>,
    extract: (page: Page) => Promise<T[]>,
    nextRule: string | null,
    keyOf: (item: T) => string,
    maxPages: number,
    facet: Facet,
    subEval: SubRuleEval,
    followOpts?: { sameChapterBase?: string; stopUrls?: Set<string> },
  ): Promise<FollowResult<T>> {
    if (nextRule === null) {
      const page = await fetchPage(startUrl)
      return { items: await extract(page), pages: 1, stoppedBy: 'end' }
    }
    return followPages(startUrl, fetchPage, extract, nextRule, keyOf, { maxPages, ...followOpts }, facet, subEval)
  }

  private requireSource(id: string): NovelSource {
    const s = this.registry.get(id)
    if (s === undefined) throw new SourceNotFoundError(id)
    return s
  }

  /** 抓取一页：URL 可带 `,{option}` 选项后缀（章节/下一页/目录 URL 的 legado 嗅探语义）——
   *  选项语义走 assembleRequest 单点（POST method/body、charset、headers 全在此解释），
   *  charset 声明进解码链（优先级最高）。webView 选项不支持——按普通请求照常尝试（如实）。 */
  private async fetchPage(s: NovelSource, url: string): Promise<Page> {
    const plan = assembleRequest(url, {}, s.baseUrl)
    const page = await this.fetcher.fetchPage(plan.url, fetchInitOf(plan, await resolveHeaders(this.fetcher, s, { jsTimeoutMs: this.jsTimeoutMs })))
    // url = 落地地址（相对链接基准，浏览器语义）；requestedUrl 仅诊断用（被跳转走时报错点名）
    return { url: page.finalUrl, requestedUrl: plan.url, body: decodeBody(page, plan.charset) }
  }

  /** fetchText：抓取 + 解码 + 超时——请求语义经 assembleRequest 单点：URL 可带 `,{option}`，
   *  书 URL / 详情页 / tocUrl 回退都可能是 POST 型 API 端点（method/body/charset/headers 全在选项里），
   *  此前 fetchTextPage 裸抓带选项的 URL——真实源表现为米读类 getDetail 405（选项里的 book_id 才是身份）。 */
  private async fetchText(s: NovelSource, url: string, timeoutMs?: number): Promise<string> {
    const plan = assembleRequest(url, {}, s.baseUrl)
    const { text } = await fetchTextPage(this.fetcher, plan.url,
      { ...fetchInitOf(plan, await resolveHeaders(this.fetcher, s, { jsTimeoutMs: this.jsTimeoutMs })), ...(timeoutMs === undefined ? {} : { timeoutMs }) }, plan.charset)
    return text
  }
}

// ── 纯函数助手（独立导出供测试/复用）──────────────────────────────────

/** tocUrl 解析（钉死）：null→bookUrl **全串**（回退即「目录在本书地址上」——抓取仍按选项发请求）；
 *  纯静态 URL（URL 形态且无插值段）→字面绝对化，不抓详情页（引擎对裸词解析期必炸的边界仍在）；
 *  其余（带 `{{$.…}}` 插值段的 URL 模板与一切规则形态）→ 按**详情上下文**过规则引擎求值
 *  （legado model/webBook/BookInfo.kt `analyzeRule.getString(infoRule.tocUrl, isUrl=true)` 口径——init 换根后
 *  `{{$.resourceID}}` 这类嵌套字段才有解；此前 `interpolateUrl(空 vars)` 把插值段原样留下，
 *  目录请求打到字面 `{{…}}` 残地址 → 0 章，QQ 源实测）。引擎 literal 口径：任一插值段 Miss →
 *  整段 Miss → 回退 bookUrl（门面明确失败，不发残 URL）。解析 base 剥 `,{option}`
 *  （选项不属于链接解析域）。求值走调用方的 subEval（完整上下文单点——jsLib/vars/fetch/source 全可见）。 */
export async function tocUrlOf(
  ruleTocUrl: string | null, ruleDetailInit: string | null,
  bookUrl: string, detailHtml: () => Promise<string | null>, subEval: SubRuleEval,
): Promise<string> {
  const base = stripUrlOption(bookUrl)
  if (ruleTocUrl === null) return bookUrl
  const urlShaped = /^(https?:)?\/\//i.test(ruleTocUrl) || ruleTocUrl.startsWith('/')
  if (urlShaped && !ruleTocUrl.includes('{')) {
    // 走到这里必无插值段（`{` 判过），interpolateUrl 恒等 → 直接绝对化
    return absUrl(ruleTocUrl, base) ?? bookUrl
  }
  const html = await detailHtml()
  if (html === null) return bookUrl
  const dctx = await detailContextOf(ruleDetailInit, html, base, subEval)
  const v = await subEval(ruleTocUrl, { html: dctx.html, json: dctx.json, baseUrl: base }, 'detail', 'value')
  const href = firstValue(v, 'detail')
  // 绝对化**只作用在 URL 部分**，`,{option}` 原样接回（对面 BookChapter.getAbsoluteURL 同款口径，
  // 与搜索结果 bookUrl、章节 URL 同一层处理）。先 absUrl 等于让 `new URL()` 先碰选项串：它吃掉
  // 换行、把 `{` 百分号编码，`,{` 形状一坏，抓取层的 URL_OPTION_SPLIT 就再也切不到
  // （悦读小说 / 新小书亭 两条 POST 型 tocUrl 实证：一路退化成把整串当路径发出去）。
  if (href === null) return bookUrl
  return absUrlKeepOption(href, base) ?? bookUrl
}

/** 正文规约：逐行 trim → 去首尾空行 → 相邻空行折叠一个 */
export function normalizeChapterText(raw: string): string {
  const lines = raw.split('\n').map((l) => l.trim())
  while (lines.length > 0 && lines[0] === '') lines.shift()
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  const out: string[] = []
  for (const l of lines) {
    if (l === '' && out[out.length - 1] === '') continue
    out.push(l)
  }
  return out.join('\n')
}

// ── 模块级助手 ─────────────────────────────────────────────────────────

function createFetcherWith(fetchImpl?: typeof globalThis.fetch, proxyUrl?: string | null): Fetcher {
  return createFetcher({
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
    ...(proxyUrl === undefined || proxyUrl === null ? {} : { proxyUrl }),
  })
}

function errorMessageOf(e: unknown): string {
  return e instanceof Error ? e.message.split('\n')[0] : String(e)
}
