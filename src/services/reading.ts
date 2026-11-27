import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { resolveConfig, type ResolvedConfig } from '../config.js'
import { detailFieldsOf, detailReadOf, firstValue, hitsOfContexts } from './bridge.js'
import { PageCache } from './cache.js'
import { exploreEpoch } from './cache-epoch.js'
import { chapterContentToText, PLAY_UNIT_MAX } from '../shared/chapter-text.js'
import { BookNotOnShelfError, InvalidRequestError, SourceNotFoundError, TtsEnginesDegradedError, TtsNotMountedError, redactOutboundError } from './errors.js'
import { createFetcher, decodeBody, type FetcherOptions } from './fetcher.js'
import { CookieJar } from './cookies.js'
import { BookContent } from './book-content.js'
import { WebViewRuntime } from './webview.js'
import { createFileSourceSession } from './source-session.js'
import type { FetchedPage, Fetcher } from './fetcher.js'
import { log } from './log.js'
import { KindCache } from './explore-cache.js'
import { ExploreJobs } from './explore-job.js'
import { deriveExploreSources, fetchExploreGroup } from './explore.js'
import { exportBook } from './export.js'
import { SourceJobs } from './import-job.js'
import { SearchJobs } from './search-job.js'
import type { JobHost } from './job-holder.js'
import type { ImportFile, JobState } from './import-job.js'
import { SourceIntake } from './intake.js'
import { LOCAL_SOURCE_ID, LocalBooks } from './localbooks.js'
import type { LocalResource } from './localbooks.js'
import { LocalLifecycle } from './local-lifecycle.js'
import type { NormalizeIssue } from './normalize.js'
import { OnlineReading } from './online-reading.js'
import { exploreParticipates, participates, aiParticipates } from './participation.js'
import { CorruptJsonError, writeFileAtomic } from './storage.js'
import { applyProbeResult, probeSource } from './probe.js'
import type { ProbeOutcome, ProbeResult } from './probe.js'
import { fetchSearchPage, searchErrorCodeOf } from './search-face.js'
import type { SearchFaceResult } from './search-face.js'
import { Shelf } from './shelf.js'
import { createSourceEval } from './source-eval.js'
import { createSourceRequest, fetchSourceText } from './source-request.js'
import type { SourceRequest } from './source-request.js'
import { loginUiOf, SourceRegistry } from './sources.js'
import { searchGroupBaseOf, TTS_RATE, TTS_VOLUME } from '../shared/wire.js'
import { TtsAudioCache } from './tts-cache.js'
import type { AudioResource } from './tts-cache.js'
import { TtsEngineRegistry } from './tts-engines.js'
import { TtsService } from './tts.js'
import type { NormalizedSpeechSynthesis } from './tts.js'
import type { NovelSource, SourceAuth } from './types.js'
import type { ValueSource } from './value-source.js'

// ── 公开类型（冻结：HTTP 面 / 工具面 / UI 只准用这套）──────────────────
// 值形状定义在 wire 契约（src/shared/wire.ts）；此处 re-export 保持既有 import 路径，改形状去 shared。
export type { SearchHit, SearchGroup, ChapterEntry, BookDetail, SearchJobSnapshot, ExploreSources, ExploreSnapshot } from '../shared/wire.js'
/** 本地资源读口（含流/MIME 的 Node 内部形状）：api 层从本模块取用，不去 localbooks 抄第二处 */
export type { LocalResource } from './localbooks.js'
import { parseCookieString } from '../shared/cookies.js'
import type {
  BookDetail, BookNavigation, ChapterContent, ExploreSources, ExploreSnapshot, TtsEngineImportReceipt, RemoveReceipt, ListenState, LocalImportResponse, LocalImportWarning,
  SearchGroup, SearchHit, SearchPlan, SearchJobSnapshot, ChapterEntry, ShelfBook, ShelfEntry, ShelfMetaPatch, SourcePublic,
  SynthesisReceipt, SynthesisRequest, TtsEngineInput, TtsEnginePublic, TtsSourcesView,
  BatchRemoved, CancelReceipt, JobStarted, LoginActionReceipt,
} from '../shared/wire.js'

export interface ReadingServiceOptions {
  dir: string                       // novel 根目录（测试注入 mkdtemp）
  /** 活配置读数面（production 由组合根给）：缺省走 `resolveConfig(undefined)`，直装缝不另造缺省表。 */
  config?: ResolvedConfig
  fetchImpl?: typeof globalThis.fetch
  tocMaxPages?: number              // 默认 200
  contentMaxPages?: number          // 默认 50
  /** 出站代理（Node 的 fetch 不读系统代理）；null/缺省 = 直连。getter 形态供配置页热改，读值时机归 fetcher。 */
  proxyUrl?: ValueSource<string | null>
  /** 宿主 `ctx.jobs` 窄面：任务身份与生命周期交它（见 job-holder.ts 的 JobHost），缺省不登记 */
  jobHost?: JobHost
  /** 听书面的外部读数：cordis `speechSynthesis` 的活 getter（每次用到时重查——服务可能动态卸装）。缺省 = 恒缺席。 */
  tts?: { speechSynthesis?: () => NormalizedSpeechSynthesis | undefined }
}

/** 订阅文本的大小上限（5 MiB）：订阅是「应当很小」的读口，超大响应按失败处理而不是吃满内存。 */
const TTS_SUBSCRIPTION_MAX_BYTES = 5 * 1024 * 1024

/** 降级原因的上屏版：错误信封里带数据根绝对路径，503 文案只留文件名与「损坏」；备份与日志各自留痕。 */
function degradedTtsEnginesReason(e: unknown): string {
  if (e instanceof CorruptJsonError) {
    return `朗读引擎注册表损坏（${path.basename(e.file)}），已拒绝按空结果继续并备份原文件`
  }
  return e instanceof Error ? e.message : String(e)
}

/** 听书面的装配产物：合成服务与引擎注册表成对交付（注册表的 flush/CRUD 归门面，合成服务只读）。
 *  `create` 用同一个出站 fetcher 构造两者——proxyUrl / UA / cookie jar 缝只此一条。
 *  注册表读不出时仍是这对部件，只是注册表带 `degradedReason`（空表 + 原因），只降订阅那一格。 */
export interface TtsParts {
  service: TtsService
  engines: TtsEngineRegistry
}
export interface ImportOutcome {
  sourceId: string | null; name: string; ok: boolean
  missing: NormalizeIssue[]; warnings: NormalizeIssue[]
  probe: ProbeResult | null
  /** 按址去重命中（intake 入库规则，矩阵行 `k-import-dedup`）：同 baseUrl 已有可用源则保留已有条目、
   *  未新增，sourceId 给可用的那条（同步与任务两条路都必须去重，否则可重复入库）。 */
  dupSkipped?: boolean
}

/** run-login 的 outcome 判别联合：两条失败结局是**值**不是异常——路由翻成 400 / 422，文案主人在路由层。 */
export type LoginOutcome =
  | { kind: 'manual'; loginUrl: string }   // URL 形态：不执行沙箱，回传 UI 开新 tab + cookie 录入
  | { kind: 'authed' }                     // JS 形态且产出登录态（已落盘 setAuth + persist）
  | { kind: 'no-login-url' }               // 未声明 loginUrl（路由翻 400「该源未声明 loginUrl」）
  | { kind: 'empty-output' }               // 脚本未 return 或为空产出（路由翻 422 LoginFailed）

/** runLogin 两条自卫 Error 的私有类型（未声明 loginUrl / URL 形态进沙箱）：前置判别已吸收，正常路径到不了。
 *  用类型而不是消息串认领——`login()` 精确包成 `no-login-url`，沙箱自身的超时/脚本抛错不在此列。 */
class LoginScriptAbsentError extends Error {}

/** 一次导出的执行计划：区间两端（1 基含端）与段内章数由门面裁好，`stream` 是 `exportBook` 组装的实际流。
 *  路由拿这三个数写响应头、再逐块搬流——头必须仍先于**首块**写出，故区间在拿到流之前就得定案。 */
export type ExportPlan = {
  from: number
  to: number
  totalInRange: number
  stream: AsyncGenerator<string>
}

/** 范围导出的 outcome 判别联合：两条失败结局是**值**不是异常——路由翻成 422 EmptyToc / BadRange。
 *  `bad-range` 带**裁剪后**的两个数：路由文案模板原样用它们，裁剪只在门内发生一次。 */
export type ExportOutcome =
  | { kind: 'empty-toc' }
  | { kind: 'bad-range'; from: number; to: number }
  | { kind: 'plan'; plan: ExportPlan }

/** 一次点名解析出来的那一**条**分类入口：执行体要的三样（打哪个源、拿什么地址、按哪份代际存快照）。
 *  `pickEntry` 交出它、`runExplorePage` 收下它，两处各写一遍匿名形状就是让这条契约没有名字。 */
interface ExploreEntry {
  source: NovelSource
  kindUrl: string
  epoch: string
}

// ── 服务实现 ────────────────────────────────────────────────────────────

/** `searchParallel` 的值域尺（唯一住址）：非正整数会让批循环 `i += n` 永不终止，一律炸。
 *  ref 快路径整份跳过 schema，故读数口每轮再过这一把；一轮只取一个值，避免 `i += n` 与
 *  `slice(i, i + n)` 用不同步长导致批次重叠或漏行。 */
function requireParallelStep(n: number): number {
  if (!Number.isInteger(n) || n < 1) throw new RangeError(`searchParallel 必须为正整数，收到 ${String(n)}`)
  return n
}

/**
 * 阅读链路门面：HTTP API / agent 工具 / UI 三个面的**唯一**业务入口。
 * 规则求值全部经引擎；抓取全部经守门 fetcher；缓存/书架/注册表在其上编排。
 * 在线目录与正文的管线归 `OnlineReading`，本地/在线分流与正文文字规约归 `BookContent`（本文件只委托跨面动词）。
 * 搜索/发现/书架/导入/登录/详情仍住这里（边界见 `ADR-0047`）。
 */
export class ReadingService {
  /** 活配置读数面：所有可热改字段在使用时读当前值——装配期抄快照会让配置页的改动等到重启；dataDir 启动期定址。 */
  private readonly live: ResolvedConfig
  private readonly registry: SourceRegistry
  private readonly shelf: Shelf
  /** 基础 fetcher 只留给 dispose / sourceSession；脚本出站与抓取一律走 sourceRequest */
  private readonly fetcher: Fetcher
  /** 一次出站抓取的唯一装配点（动态头 → 限速 → webview/HTTP → loginCheck） */
  private readonly sourceRequest: SourceRequest
  /** 书内容读面：目录 / 导航 / 正文的本地与在线分流与文字规约都在这条缝里 */
  private readonly content: BookContent
  private readonly jobs: SourceJobs
  /** 聚合搜索的后台持有者（读任务，与写的 `jobs` 分槽——见 services/search-job.ts 的理由） */
  private readonly searchJobs: SearchJobs
  /** 分类浏览的后台持有者（与 `searchJobs` 同一档：读任务，与写的 `jobs` 分槽——理由同 services/explore-job.ts） */
  private readonly exploreJobs: ExploreJobs
  /** 逐源分类快照：**一份实例**服务全部轮次与全部调用方，否则「重复进同一分类」永远打站点 */
  private readonly exploreCache: KindCache
  /** 本地书生命周期（副本 ⇄ 架位的联合不变量）：门面构造期持有，外部三面拿不到 */
  private readonly localBooks: LocalLifecycle
  private readonly webview: WebViewRuntime
  /** 听书面部件（合成服务 + 引擎注册表）：`from()` 直装缝可缺席（缺席 = 全部听书动词 503）；`create()` 恒给。
   *  缺席 ≠ 降级，两条半径各有各的闸（见 `from` 的 `tts` 参数）。 */
  private readonly tts: TtsParts | null

  private constructor(
    live: ResolvedConfig,
    registry: SourceRegistry,
    shelf: Shelf,
    fetcher: Fetcher,
    sourceRequest: SourceRequest,
    content: BookContent,
    jobs: SourceJobs,
    searchJobs: SearchJobs,
    exploreJobs: ExploreJobs,
    exploreCache: KindCache,
    localBooks: LocalLifecycle,
    webview: WebViewRuntime,
    tts: TtsParts | null,
  ) {
    this.live = live
    this.registry = registry
    this.shelf = shelf
    this.fetcher = fetcher
    this.sourceRequest = sourceRequest
    this.content = content
    this.jobs = jobs
    this.searchJobs = searchJobs
    this.exploreJobs = exploreJobs
    this.exploreCache = exploreCache
    this.localBooks = localBooks
    this.webview = webview
    this.tts = tts
  }

  /** 本地书导入上限（传输层流式计数与本地书 domain 上限同一读数口——每次读活配置当前值） */
  get localImportMaxBytes(): number { return this.live.localImportMaxBytes }

  /** 关掉出站 dispatcher（代理连接池）；卸载时组合根调用，之后再抓取会按当前 proxyUrl 重建。 */
  dispose(): void {
    this.fetcher.dispose?.()
    this.fetcher.sourceSession?.flush?.()
    void this.webview.dispose()
  }

  /**
   * 生产快捷方式：建目录 + 从磁盘装配部件，再交 from() 总装；本地书也在装配期持有（联合不变量归 local-lifecycle）。
   */
  static async create(opts: ReadingServiceOptions): Promise<ReadingService> {
    // 主动建数据目录：保证存在 + 快速失败（dir 指向文件时 mkdir 抛错——ready 拒绝，入口层零注册）
    await fs.mkdir(opts.dir, { recursive: true })
    const live = opts.config ?? resolveConfig(undefined)
    const cookieJar = new CookieJar()
    const deviceId = await readDeviceId(opts.dir)
    const sourceSession = createFileSourceSession(opts.dir)
    // HTTP cookie 按域/路径共享一张表；脚本侧 source cookie 仍按源隔离。运行期字段随构造进 fetcher。
    const fetcher = createFetcherWith(opts.fetchImpl, opts.proxyUrl, cookieJar, { deviceId, sourceSession })
    // 听书面：引擎注册表从数据根加载（`tts-engines.json`，缺文件 = 空表），与合成服务共用同一个出站
    // fetcher。段音频缓存上限读活配置（`ttsCacheMaxBytes`）；js 预算与搜索/探针同一耐心源。
    // 注册表读不出时换**降级注册表**（空表 + 原因），只关订阅那一格：内置引擎 / 浏览器直出 / 已缓存
    // 音频都不读它（失败半径 = 判据的主语，`ADR-0077`）。readJson 已备份 `.bak` 并留过 error，这里记后果。
    let engines: TtsEngineRegistry
    try {
      engines = await TtsEngineRegistry.load(opts.dir)
    } catch (e) {
      log.error('朗读引擎注册表加载失败（只降订阅那一格：订阅动词 503 带原因，内置 / 直出 / 缓存照常）：', e)
      engines = TtsEngineRegistry.degraded(opts.dir, degradedTtsEnginesReason(e))
    }
    const tts: TtsParts = {
      engines,
      service: new TtsService({
        cache: new TtsAudioCache(path.join(opts.dir, 'cache', 'tts'), () => live.ttsCacheMaxBytes),
        engines,
        fetcher,
        jsTimeoutMs: () => live.jsTimeoutMs,
        speechSynthesis: opts.tts?.speechSynthesis ?? (() => undefined),
      }),
    }
    const service = await ReadingService.from({
      fetcher,
      cookieJar,
      registry: await SourceRegistry.load(opts.dir),
      shelf: await Shelf.load(opts.dir),
      cache: new PageCache(opts.dir, () => live.cacheMaxBytes),
      local: await LocalBooks.create(opts.dir, { maxImportBytes: () => live.localImportMaxBytes }),
      config: live,
      tts,
      // 可选项按需建键：显式 `undefined` 与「没有这个键」在装配面上是两件事（后者才落回缺省）
      ...(opts.jobHost === undefined ? {} : { jobHost: opts.jobHost }),
      ...(opts.tocMaxPages === undefined ? {} : { tocMaxPages: opts.tocMaxPages }),
      ...(opts.contentMaxPages === undefined ? {} : { contentMaxPages: opts.contentMaxPages }),
      ...(opts.proxyUrl === undefined ? {} : { proxyUrl: opts.proxyUrl }),
    })
    await service.localBooks.backfillChapterCounts()
    return service
  }

  /**
   * 组合根注入面：接受已建好的部件直接总装——测试可换内存 registry adapter / 确定性 fetcher。
   * **启动补数不在这里**：本地书 `totalChapters` 补数归 `create` 那一轮（`backfillChapterCounts`）。
   * **只读注入物**：jar 必须是构造方给 fetcher 的同一实例（不一致当场炸）；后台任务面在此接线，
   * 探针与搜索共用同一 fetcher 出口与 timeoutMs。部件总装后即 private，外部只经门面动词。
   * 配置只有 `config` 一条：给了就每次用时读当前值，没给就按 `resolveConfig(undefined)` 的缺省。
   */
  // eslint-disable-next-line @typescript-eslint/require-await -- 装配全程同步；async 是契约：构造失败必须以 rejection 交付，不能同步抛。
  static async from(parts: {
    registry: SourceRegistry
    shelf: Shelf
    cache: PageCache
    fetcher: Fetcher
    local?: LocalBooks
    /** 宿主 `ctx.jobs` 的窄面（见 job-holder.ts 的 JobHost）；缺省即不登记，任务语义不变 */
    jobHost?: JobHost
    /** 活配置读数面（production 由组合根给）：缺省走 `resolveConfig(undefined)` */
    config?: ResolvedConfig
    tocMaxPages?: number
    contentMaxPages?: number
    /** 真浏览器 WebView 的出站代理值源（与 fetcher 同口径） */
    proxyUrl?: ValueSource<string | null>
    /** HTTP/浏览器共享 cookie jar（必填；fetcher 带 jar 时必须是同一实例） */
    cookieJar: CookieJar
    /** 听书面部件（`create` 构造；测试可直装）。缺席或 null = 听书相关动词落 503 Unavailable（直装缝的
     *  缺席）；注册表损坏的降级由 `create` 处理，不落到这里（缺席 ≠ 降级）。 */
    tts?: TtsParts | null
  }): Promise<ReadingService> {
    const live = parts.config ?? resolveConfig(undefined)
    // 装配期先过一遍：组合根直装的非法值要在启动时就炸，不留到第一次搜索才挂起
    requireParallelStep(live.searchParallel)
    // 同一张 jar 要同时服务 HTTP 与脚本面——两处各持一张会让脚本读到的 cookie 与发出去的不是一份。
    if (parts.fetcher.cookieJar !== undefined && parts.fetcher.cookieJar !== parts.cookieJar) {
      throw new Error('fetcher.cookieJar 与 parts.cookieJar 不是同一张表——装配必须显式给同一实例')
    }
    const cookieJar = parts.cookieJar
    const webview = new WebViewRuntime(parts.proxyUrl === undefined ? {} : { proxyUrl: parts.proxyUrl })
    // 与基础 fetcher 同一张 jar（见上）
    const sourceRequest = createSourceRequest({
      fetcher: parts.fetcher, webview, cookieJar, jsTimeoutMs: () => live.jsTimeoutMs,
    })
    // 在线目录/正文管线：源查找、书架镜像、文件缓存与源求值都从注入部件现取；页数上限是装配期读数，
    // js 预算则每建一次求值面从 `live` 现读，热改对下一次求值即生效。
    const online = new OnlineReading({
      sourceOf: (id) => parts.registry.get(id),
      shelf: parts.shelf,
      cache: parts.cache,
      request: sourceRequest,
      sourceEvalFor: (s) => createSourceEval(sourceRequest.fetcherFor(s), s, { jsTimeoutMs: live.jsTimeoutMs }),
      tocMaxPages: parts.tocMaxPages ?? 200,
      contentMaxPages: parts.contentMaxPages ?? 50,
    })
    const content = new BookContent({ local: parts.local ?? null, online })
    return new ReadingService(
      live,
      parts.registry, parts.shelf, parts.fetcher, sourceRequest, content,
      new SourceJobs({
        registry: parts.registry,
        probe: (s) => probeSource(s, sourceRequest, { timeoutMs: live.searchTimeoutMs, jsTimeoutMs: live.jsTimeoutMs }),
        ...(parts.jobHost === undefined ? {} : { host: parts.jobHost }),
      }),
      new SearchJobs(parts.jobHost === undefined ? {} : { host: parts.jobHost }),
      new ExploreJobs(parts.jobHost === undefined ? {} : { host: parts.jobHost }),
      new KindCache(),
      new LocalLifecycle({ copies: parts.local ?? null, shelf: parts.shelf }),
      webview,
      parts.tts ?? null,
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
   *  **不探针**——验证归 jobs 批量验证任务或 probe 路由/工具；status 恒 unverified，probe 恒 null。 */
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
   *  超时与 js 预算必须与搜索同源（`searchTimeoutMs`/`jsTimeoutMs`），否则同一源两处探针拿回两个 verdict。
   *  交 `ProbeOutcome`：verdict→status 的判定在门内只算一次，HTTP 面只写 `result`、工具面只投影 `status`。 */
  async probe(id: string, opts?: { signal?: AbortSignal }): Promise<ProbeOutcome> {
    const s = this.requireSource(id)
    const r = await probeSource(s, this.sourceRequest, {
      timeoutMs: this.live.searchTimeoutMs, jsTimeoutMs: this.live.jsTimeoutMs, ...(opts?.signal === undefined ? {} : { signal: opts.signal }),
    })
    // 取消不该把「跑了一半的探针」写成源的终态：那一半是被我们掐掉的，不是站点给的结论。
    // probeSource 的 catch 已先查取消并抛出；这里再查一次，保证写终态前信号仍然有效。
    opts?.signal?.throwIfAborted()
    return await applyProbeResult(this.registry, id, r)
  }

  // ── 写侧动词：变更知识归门面，HTTP 面不再手写 edit 配方 ────────────────────

  /** 书源对外投影列表（凭据红线：raw/rules/auth 不出服务层——调用方不必知道 toPublic） */
  listPublicSources(): SourcePublic[] {
    return this.registry.list().map((s) => this.registry.toPublic(s))
  }

  /** 单源启停：未知 id → 抛 SourceNotFoundError（路由面经 classify 拿 404，工具面不再预检）。 */
  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const found = await this.registry.edit((tx) => tx.setEnabled(id, enabled))
    if (!found) throw new SourceNotFoundError(id)
  }

  /** 启停批量：未知 id 静默跳过、重复 id 幂等；返回找到并写入的条数（含已在目标态的幂等重写——
   *  不是「实际变更数」）；一次 edit 一次合并落盘。 */
  async setEnabledMany(ids: string[], enabled: boolean): Promise<number> {
    return this.registry.edit((tx) => {
      let n = 0
      for (const id of new Set(ids)) if (tx.setEnabled(id, enabled)) n++
      return n
    })
  }

  /** 单源 AI 搜索标记：与启停同一条存在性语义（未知 id 抛 SourceNotFoundError） */
  async setAiSearch(id: string, aiSearch: boolean): Promise<void> {
    const found = await this.registry.edit((tx) => tx.setAiSearch(id, aiSearch))
    if (!found) throw new SourceNotFoundError(id)
  }

  /** 批量 AI 搜索标记：未知 id 静默跳过、重复 id 幂等；返回找到并写入的条数（同一口径见 setEnabledMany）。 */
  async setAiSearchMany(ids: string[], aiSearch: boolean): Promise<number> {
    return this.registry.edit((tx) => {
      let n = 0
      for (const id of new Set(ids)) if (tx.setAiSearch(id, aiSearch)) n++
      return n
    })
  }

  /** 删单源；不存在 → false。**缺席在本动词是幂等成功**（与更新路径把缺席翻成错误相对）。
   *  源级状态按脚本侧键（baseUrl）清理，不是 registry id。 */
  async removeSource(id: string): Promise<boolean> {
    const key = this.registry.get(id)?.baseUrl
    const removed = await this.registry.edit((tx) => tx.remove(id))
    if (removed && key !== undefined) this.fetcher.sourceSession?.forget?.(key)
    return removed
  }

  /** 批量删源；返回实际删除数 */
  async removeSources(ids: string[]): Promise<number> {
    const keys = new Set(ids.map((id) => this.registry.get(id)?.baseUrl).filter((k): k is string => k !== undefined))
    const n = await this.registry.edit((tx) => tx.removeAll(ids))
    for (const key of keys) this.fetcher.sourceSession?.forget?.(key)
    return n
  }

  /** cookie 录入（auth 路由的录入形态）：acquiredAt 由门面盖章——调用方不再手拼 SourceAuth */
  async saveAuth(
    id: string,
    cookies: Record<string, string>,
    headers?: Record<string, string>,
    loginInfo?: Record<string, string>,
  ): Promise<void> {
    this.requireSource(id)
    const auth: SourceAuth = {
      cookies, acquiredAt: Date.now(),
      ...(headers === undefined ? {} : { headers }),
      ...(loginInfo === undefined ? {} : { loginInfo }),
    }
    await this.registry.edit((tx) => tx.setAuth(id, auth))
  }

  /** loginUi 表单录入：只更新 loginInfo，保留既有 cookie/header（不拿空 cookie 覆盖登录态）。 */
  async saveLoginInfo(id: string, loginInfo: Record<string, string>): Promise<void> {
    const s = this.requireSource(id)
    const prev = s.auth
    const auth: SourceAuth = {
      cookies: prev?.cookies ?? {},
      ...(prev?.headers === undefined ? {} : { headers: prev.headers }),
      loginInfo,
      acquiredAt: Date.now(),
    }
    await this.registry.edit((tx) => tx.setAuth(id, auth))
  }

  /** loginUrl JS 形态：沙箱执行取 cookie 串 → 解析 k=v; → setAuth + persist。
   *  空产出（脚本没 return，或只写 `cookie.setCookie` 垫片又不读回）**不算登录**：返回 null 且不写 auth
   *  （落空 auth 会把 hasAuth 点亮成「已登录」而零凭据）。URL 形态由调用侧分流。
   *  两条自卫 Error 走 `LoginScriptAbsentError`，`login()` 把它包成 `no-login-url`。 */
  private async runLogin(id: string): Promise<SourceAuth | null> {
    const s = this.requireSource(id)
    const loginUrl = s.rules.loginUrl
    if (loginUrl === null) throw new LoginScriptAbsentError(`源「${s.name}」未声明 loginUrl`)
    if (/^https?:\/\//i.test(loginUrl)) throw new LoginScriptAbsentError(`源「${s.name}」的登录地址是 URL，不是 JS 登录脚本`)
    // 与按钮动作共用同一条前缀剥离：`<js>…</js>` 不能再套一个 `@js:`（会变成语法错）
    const v = await createSourceEval(this.sourceRequest.fetcherFor(s), s, { jsTimeoutMs: this.live.jsTimeoutMs })
      .evaluate('@js:' + stripLoginPrefix(loginUrl), { baseUrl: s.baseUrl })
    // 宽松 `k=v;` 串的解析规则跨半只有一份（`shared/cookies.ts`），登录脚本与手工粘贴走同一语法。
    const cookies = parseCookieString(firstValue(v, 'rule') ?? '')
    if (Object.keys(cookies).length === 0) return null   // 空产出：不写登录态（如实 → UI 仍显示未登录）
    // loginInfo / headers 是表单与手工录入的伴生态：JS 登录只产出 cookie，不能把刚存的那两格抹掉
    const prev = s.auth
    const auth: SourceAuth = {
      cookies,
      ...(prev?.headers === undefined ? {} : { headers: prev.headers }),
      ...(prev?.loginInfo === undefined ? {} : { loginInfo: prev.loginInfo }),
      acquiredAt: Date.now(),
    }
    await this.registry.edit((tx) => tx.setAuth(id, auth))
    return auth
  }

  /** `loginUi` 行的按钮动作：绝对 URL 回传给 UI 打开；其余把 loginUrl 脚本拼在 action 前执行，
   *  `result` 绑定当前 loginInfo 的 Map。按钮按名字查服务端源数据，客户端不持脚本。 */
  async runLoginAction(id: string, name: string): Promise<LoginActionReceipt> {
    const s = this.requireSource(id)
    const row = (loginUiOf(s.raw) ?? []).find((r) => r.type === 'button' && r.name === name)
    if (row === undefined || row.type !== 'button') {
      throw new InvalidRequestError(`源「${s.name}」没有名为「${name}」的登录按钮`)
    }
    const action = row.action.trim()
    if (/^https?:\/\//i.test(action)) return { mode: 'external', url: action }
    const loginUrl = s.rules.loginUrl
    const loginJs = loginUrl === null || /^https?:\/\//i.test(loginUrl) ? '' : stripLoginPrefix(loginUrl)
    const code = loginJs === '' ? action : `${loginJs}\n${action}`
    await createSourceEval(this.sourceRequest.fetcherFor(s), s, { jsTimeoutMs: this.live.jsTimeoutMs })
      .runScript(code, {
        baseUrl: s.baseUrl,
        facet: 'rule',
        resultMap: s.auth?.loginInfo ?? {},
        loc: { segmentIndex: 0, segmentRaw: action },
        scriptForm: true,
      })
    return { mode: 'script' }
  }

  /** 登录计划（`login()` 的判别构件）：URL 形态 → manual（回传 UI 开新 tab），JS 形态 → js，未声明 → null。
   *  dispatch 不读 rules、不直调本构件（只认 login() 的 outcome）。 */
  private loginPlan(id: string): { mode: 'manual'; loginUrl: string } | { mode: 'js' } | null {
    const s = this.requireSource(id)
    const loginUrl = s.rules.loginUrl
    if (loginUrl === null) return null
    return /^https?:\/\//i.test(loginUrl) ? { mode: 'manual', loginUrl } : { mode: 'js' }
  }

  /** run-login 深动词（auth 路由只做它的 outcome→HTTP 翻译）：requireSource → loginPlan 判别 → JS 形态才
   *  执行 runLogin。两条失败结局是值不是异常：未声明 → no-login-url（400）、空产出 → empty-output（422）。
   *  manual 形态不碰沙箱。 */
  async login(id: string): Promise<LoginOutcome> {
    const plan = this.loginPlan(id)
    if (plan === null) return { kind: 'no-login-url' }
    if (plan.mode === 'manual') return { kind: 'manual', loginUrl: plan.loginUrl }
    let auth: SourceAuth | null
    try {
      auth = await this.runLogin(id)
    } catch (e) {
      if (e instanceof LoginScriptAbsentError) return { kind: 'no-login-url' }
      throw e                              // 沙箱自身的失败（超时/脚本抛错/FetchError）照旧走 classify
    }
    return auth === null ? { kind: 'empty-output' } : { kind: 'authed' }
  }

  // ── 门面动词：部件收 private，dispatch/tools 只经动词 ──────────────────────

  // ── 书架动词 ──

  /** 书架读取面：落盘条目 + **来源投影**（sourceName），按**最近阅读**排序。
   *  排序键是进度自己的 `updatedAt`（每次存进度刷新；新书 = 加入时刻），同刻按加入时间、再按 bookKey。
   *  源名在这里实时 join 注册表——落盘快照会在源改名 / 同址替换复用 id 后陈旧；join 不到 = 源已删 → null。 */
  shelfList(): ShelfEntry[] {
    return this.shelf.list()
      .map((b) => ({ ...b, sourceName: this.sourceNameOf(b.sourceId) }))
      .sort((a, b) =>
        b.progress.updatedAt - a.progress.updatedAt
        || b.addedAt - a.addedAt
        || (a.bookKey < b.bookKey ? -1 : a.bookKey > b.bookKey ? 1 : 0))
  }

  /** 来源投影的唯一算式：本地书恒 null（本地身份归 LOCAL_SOURCE_ID 判别，不查注册表）；
   *  注册表里没有该 id（源被删/从未存在）→ null。 */
  private sourceNameOf(sourceId: string): string | null {
    if (sourceId === LOCAL_SOURCE_ID) return null
    return this.registry.get(sourceId)?.name ?? null
  }

  /** 加书（title 形态）：字段判别归 pickShelfMeta，此处只管「入架」语义。
   *  title / sourceId 必填非空；值域门在这里而不是路由——HTTP 面与工具面共用本动词，门长在路由只护一半。 */
  shelfAdd(bookKey: string, meta: ShelfMetaPatch & { title: string }): ShelfBook {
    const sourceId = meta.sourceId
    if (typeof sourceId !== 'string' || sourceId === '') {
      throw new InvalidRequestError('加书需带非空 sourceId')
    }
    if (meta.title === '') throw new InvalidRequestError('加书需带非空 title')
    return this.shelf.add({ ...meta, bookKey, sourceId, title: meta.title })
  }

  /** 打补丁（patch 形态）：返回更新后的条目；书架里没有这本书 → 抛 `BookNotOnShelfError`（不含静默造书）。 */
  shelfPatch(bookKey: string, patch: ShelfMetaPatch): ShelfBook {
    const patched = this.shelf.update(bookKey, patch)
    if (patched === null) throw new BookNotOnShelfError(bookKey)
    return patched
  }

  /** 存进度（progress 形态）：返回更新后的条目；书架里没有这本书 → 抛 `BookNotOnShelfError`
   *  （HTTP 面翻成 400 与可行动文案，工具面原样上抛）。值域门在这里：Infinity 会被 `JSON.stringify`
   *  落盘成 null 静默损坏。存在性判断只住 `Shelf.updateProgress` 的返回值，不预检、不在写后重读。 */
  shelfSaveProgress(bookKey: string, chapterIndex: number, offsetRatio: number): ShelfBook {
    if (!Number.isInteger(chapterIndex) || chapterIndex < 0
      || !Number.isFinite(offsetRatio) || offsetRatio < 0 || offsetRatio > 1) {
      throw new InvalidRequestError('progress.chapterIndex 需为非负整数、offsetRatio 需为 [0,1] 有限数')
    }
    const saved = this.shelf.updateProgress(bookKey, chapterIndex, offsetRatio)
    if (saved === null) throw new BookNotOnShelfError(bookKey)
    return saved
  }

  /** 存听书位置（listen 形态）：缺席同 `shelfSaveProgress` 是错误。
   *  值域门在这里：Infinity / 越界档位一旦落盘，下一次起播会照单全收。
   *  **本动词只写 listen 细节轨**：共用的消费位置由播放层在同一落盘节拍里经 `shelfSaveProgress` 另写一笔。 */
  shelfSaveListen(bookKey: string, p: ListenState): ShelfBook {
    if (!Number.isInteger(p.chapterIndex) || p.chapterIndex < 0
      || !Number.isInteger(p.paragraphIndex) || p.paragraphIndex < 0
      || !Number.isFinite(p.rate) || p.rate < TTS_RATE.min || p.rate > TTS_RATE.max
      || !Number.isFinite(p.volume) || p.volume < TTS_VOLUME.min || p.volume > TTS_VOLUME.max
      || (p.engineId !== null && (typeof p.engineId !== 'string' || p.engineId.trim() === ''))
      || (p.voice !== null && typeof p.voice !== 'string')) {
      throw new InvalidRequestError(
        'listen.chapterIndex/paragraphIndex 需为非负整数、rate 需在语速档内、volume 需在音量档内（有限数）、engineId 需为非空白 string|null、voice 需为 string|null',
      )
    }
    const saved = this.shelf.updateListen(bookKey, p)
    if (saved === null) throw new BookNotOnShelfError(bookKey)
    return saved
  }

  /** 删书：副本连删与「先副本、后架位」的顺序归本地书生命周期，门面只委托——三条删入口共用同一条顺序。 */
  async removeBook(bookKey: string): Promise<RemoveReceipt> {
    return this.localBooks.removeBook(bookKey)
  }

  /** 批量删书：与单删同一条顺序（副本先删、失败则整批架位保留可重试），未知键静默跳过、返回实际删除数。 */
  async removeBooks(bookKeys: readonly string[]): Promise<BatchRemoved> {
    return this.localBooks.removeBooks(bookKeys)
  }

  // ── 任务动词 ──

  /** 提交导入任务（运行中互斥由单任务槽裁决——JobRunningError 上抛，路由映射 409） */
  startImportJob(files: ImportFile[]): JobStarted {
    return this.jobs.startImport(files)
  }

  /** 提交批量验证任务 */
  startBatchProbeJob(ids: string[]): JobStarted {
    return this.jobs.startBatchProbe(ids)
  }

  /** 当前/最近任务态（结果保留到下一个任务开始） */
  jobStatus(): JobState | null {
    return this.jobs.status()
  }

  // ── 本地书动词 ──

  /** 本地导入（TXT / EPUB 按**内容**分流）+ 自动上架：导入即落架与入架失败的回收归本地书生命周期，
   *  门面只委托并回显 wire 的 `LocalImportResponse`。 */
  async localImport(bytes: Buffer, name: string): Promise<LocalImportResponse> {
    return this.localBooks.importBook(bytes, name)
  }

  /** 补充文档（脚注/附录）图文正文：本地 EPUB 专有（「文档」这一层只有它有） */
  getLocalSupplement(bookKey: string, documentId: string): Promise<ChapterContent> {
    return this.localBooks.getSupplement(bookKey, documentId)
  }

  /** 本地资源读口（流/MIME/字节数；磁盘路径不出服务层） */
  getLocalResource(bookKey: string, resourceId: string): Promise<LocalResource> {
    return this.localBooks.getResource(bookKey, resourceId)
  }

  /** 本地导入告警（阅读器按需重看导入说明）：非 EPUB 恒空数组 */
  getLocalImportWarnings(bookKey: string): Promise<LocalImportWarning[]> {
    return this.localBooks.getImportWarnings(bookKey)
  }

  /** 删本地书：文件 + 书架条目一并删（任一命中即 removed；与单删同一条「先副本、后架位」顺序） */
  async removeLocalBook(id: string): Promise<RemoveReceipt> {
    return this.localBooks.removeLocalBook(id)
  }

  // ── 听书 ─────────────────────────────────────────────────────────────

  /** 引擎源清单 + 宿主朗读服务健康（播放器的引擎选择面与管理面同读这一份）：
   *  行形状是 `TtsSourceInfo`——插件自有源不投展示名（标签归客户端文案单点）。 */
  ttsSourcesView(): TtsSourcesView {
    return this.requireTts().service.sourcesView()
  }

  /** 段合成：缓存命中即回执；未命中按引擎分流，单段失败只抛给调用方（不吞、不给空音频）。
   *  `opts.signal` = 调用方的取消位，原样下传。值域门住门面：这里判的是业务事实——一段 = 一个播放
   *  单元（`PLAY_UNIT_MAX`，按 code point），语速必须落在播放层实际可选的档里。 */
  async ttsSynthesize(p: SynthesisRequest, opts?: { signal?: AbortSignal }): Promise<SynthesisReceipt> {
    if (!Number.isFinite(p.rate) || p.rate < TTS_RATE.min || p.rate > TTS_RATE.max) {
      throw new InvalidRequestError(`朗读语速需为 ${TTS_RATE.min}–${TTS_RATE.max} 之间的有限数`)
    }
    if (p.text.trim() === '') throw new InvalidRequestError('朗读文本不能为空')
    // 与切分侧同一把尺（`shared/chapter-text.ts` 的 `PLAY_UNIT_MAX` 按 code point 计），否则边界上一边过一边不过。
    if (Array.from(p.text).length > PLAY_UNIT_MAX) {
      throw new InvalidRequestError(`朗读文本超过单段上限 ${PLAY_UNIT_MAX} 字（播放单元按段切分）`)
    }
    return this.requireTts().service.synthesize(p, opts)
  }

  /** 音频读口：未知/非法 key → null（路由在发头前落 404，不是空音频） */
  async ttsOpenAudio(key: string): Promise<AudioResource | null> {
    return this.requireTts().service.openAudio(key)
  }

  /** 引擎订阅清单（管理面）：公共投影已剥凭据——导出 JSON 由 client 用这份数据自组 */
  ttsEngineList(): TtsEnginePublic[] {
    return this.requireEngines().list()
  }

  /** 引擎订阅导入（粘贴的 JSON 文本）：坏条逐条剪除、回执留痕（失败半径 = 该条） */
  ttsEngineImport(json: string): TtsEngineImportReceipt {
    return this.requireEngines().importJson(json)
  }

  /** 引擎订阅导入（URL 支）：经**同一个出站 fetcher** 拉订阅文本再走同一份解析。
   *  解码走 `decodeBody`，不硬解 UTF-8（GBK 订阅会带着乱码引擎名与 URL「导入成功」，比报错更难发现）。
   *  先过闸再发请求；请求失败是 FetchError（502），响应不是 JSON 由 importJson 落 400。
   *  失败原话里的订阅地址经 `redactOutboundError` 摘掉——签名 token 不该进错误信封与日志。 */
  async ttsEngineImportFromUrl(url: string): Promise<TtsEngineImportReceipt> {
    const engines = this.requireEngines()
    let page: FetchedPage
    try {
      page = await this.fetcher.fetchPage(url, { maxBytes: TTS_SUBSCRIPTION_MAX_BYTES })
    } catch (e) {
      throw redactOutboundError(e, url)
    }
    let text: string
    try {
      text = decodeBody(page)
    } catch (e) {
      // 解码失败原话嵌的是**落地地址**（重定向后的那一跳），同样可能带订阅 token
      throw redactOutboundError(e, page.finalUrl)
    }
    return engines.importJson(text)
  }

  /** 引擎新增/更新（PUT tts/engines/:id）：id 是身份；值域（非空 name/url）由注册表再判一次 */
  ttsEnginePut(id: string, input: TtsEngineInput): TtsEnginePublic {
    return this.requireEngines().put(id, input)
  }

  /** 删引擎：未知 id 静默 `removed:false`（与删源同口径，不把「没有这条」报成错误） */
  ttsEngineRemove(id: string): RemoveReceipt {
    return { removed: this.requireEngines().remove(id) }
  }

  /** 听书面**缺席**（直装缝 `from` 不带部件）的落点与本地书同档：503 Unavailable，不影响阅读面。
   *  缺席 ≠ 降级：部件在场而注册表坏是另一条半径，由 `requireEngines` 按降级态判，这里不认那件事。 */
  private requireTts(): TtsParts {
    if (this.tts === null) throw new TtsNotMountedError()
    return this.tts
  }

  /** 订阅动词的闸：判据只有注册表的 `degradedReason` 一处。降级时五个订阅动词抛具名错误（classify → 503）；
   *  源清单 / 段合成 / 音频读口不过这道闸——它们不读订阅数据。 */
  private requireEngines(): TtsEngineRegistry {
    const { engines } = this.requireTts()
    const reason = engines.degradedReason
    if (reason !== undefined) throw new TtsEnginesDegradedError(reason)
    return engines
  }

  // ── 搜索 ─────────────────────────────────────────────────────────────

  /** 聚合搜索的**唯一实现**。`onGroup` 是增量出口：单源求值完成即按完成序交付，返回值仍按参搜源序。
   *  sourceIds 缺省**或空数组**都视为「未限定」= 搜全部启用源（零分组空结果会冒充成功）。 */
  private async searchProgressive(keyword: string, opts?: {
    sourceIds?: string[]
    onGroup?: (group: SearchGroup, index: number) => void
    /** 协作式停止：置位后**不再开新的源**（在途的不撤回）。搜索做成后台任务时的取消出口。 */
    shouldStop?: () => boolean
    /** 调用方取消：与 shouldStop 同义但更强——在途请求也随之中止（工具面的 exec.signal）。 */
    signal?: AbortSignal
  }): Promise<SearchGroup[]> {
    const want = opts?.sourceIds
    const signal = opts?.signal
    signal?.throwIfAborted()      // 已取消的调用一条源都不问
    const sources = this.registry.list().filter((s) =>
      participates(s) && (want === undefined || want.length === 0 || want.includes(s.id)))
    // new Array 是**稀疏**的：按完成序回填，中途停止会留洞——类型照实写，收尾 filter 才是洞的唯一出口
    const groups = new Array<SearchGroup | undefined>(sources.length)
    const step = requireParallelStep(this.live.searchParallel)
    for (let i = 0; i < sources.length; i += step) {
      if (opts?.shouldStop?.() === true || signal?.aborted === true) break
      const batch = sources.slice(i, i + step)
      await Promise.all(batch.map(async (s, j) => {
        if (opts?.shouldStop?.() === true || signal?.aborted === true) return   // 收手：该源不发了，结果里也就没有它
        const index = i + j
        const group = await this.searchOne(s, keyword, signal)
        groups[index] = group
        opts?.onGroup?.(group, index)
      }))
    }
    // 取消（signal）与「用户停 UI 搜索」（shouldStop）不同：后者保留已搜到的命中，前者在工具面必须**抛**。
    signal?.throwIfAborted()
    return groups.filter((g): g is SearchGroup => g !== undefined)
  }

  /** 一次性收齐全部命中：`searchProgressive` 的薄壳。**批循环只此一处**——
   *  搜索后台化的正确动作是给上面那份加消费方，不是再写第二个循环。 */
  search(keyword: string, opts?: { sourceIds?: string[]; signal?: AbortSignal }): Promise<SearchGroup[]> {
    return this.searchProgressive(keyword, opts)
  }

  /** AI 工具面的聚合搜索：只问 `aiParticipates` 的源（已启用 ∧ 文本 ∧ 用户标记 AI 搜索），`sourceIds` 只
   *  在这个集合内**收窄**。空集合（显式 `[]` 也算）不发请求、也不交给 `searchProgressive`——后者把空
   *  sourceIds 读作「未限定」（UI 面约定），落回全量会把「用户没选 AI 源」改写成「搜了所有源」
   *  （`ADR-0097` 决定 3）。`eligible` 是本轮候选源数；轮级读数由调用方从 groups 汇总。 */
  async searchForAi(
    keyword: string, opts?: { sourceIds?: string[]; signal?: AbortSignal },
  ): Promise<{ eligible: number; groups: SearchGroup[] }> {
    opts?.signal?.throwIfAborted()
    const plan = this.registry.list().filter((s) => aiParticipates(s)).map((s) => s.id)
    const want = opts?.sourceIds
    // 空数组不折「没点名」：want 传了就是一次收窄请求，收窄到空就是零请求（eligible 0）
    const ids = want === undefined ? plan : plan.filter((id) => want.includes(id))
    if (ids.length === 0) return { eligible: 0, groups: [] }
    const groups = await this.searchProgressive(keyword, {
      sourceIds: ids,
      ...(opts?.signal === undefined ? {} : { signal: opts.signal }),
    })
    return { eligible: ids.length, groups }
  }

  /** 搜索参与计划：**参与者 id 清单**这条投影的唯一主人——客户端分批/进度按此走。
   *  谓词不在本文件：「谁参搜」的判据单点是 `services/participation.ts` 的 `participates`。 */
  searchPlan(): SearchPlan {
    return { sourceIds: this.registry.list().filter((s) => participates(s)).map((s) => s.id) }
  }

  /** 提交一轮**后台**搜索：参与集判定与 `total` 同源；运行体是**同一份** `searchProgressive`，只是换个消费方。
   *  结果由 `SearchJobs` 持有，切界面 / 切 tab 都不影响它跑完。 */
  startSearchJob(keyword: string, opts?: { sourceIds?: string[] }): JobStarted {
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

  /** 停止本轮搜索：只停「还要去搜的源」，已搜出的命中留在读面；在途的最多 `searchParallel` 条不撤回，回来照旧计入。
   *  返回 false = 本轮早已收尾（不是错误）。 */
  cancelSearchJob(): CancelReceipt { return { cancelled: this.searchJobs.cancel('用户停止了搜索') } }

  /** 搜索任务读面：`since` = 客户端已收到的组数（完成序游标）；null = 无任务或已过保留期 */
  searchJobSnapshot(since = 0): SearchJobSnapshot | null { return this.searchJobs.snapshot(since) }

  /** 搜索任务的「变了」信号口（SSE 路由用它拉增量；信号不带数据，游标归每条连接）。返回退订口。 */
  subscribeSearchJob(listener: () => void): () => void { return this.searchJobs.signal.subscribe(listener) }

  // ── 分类浏览（书城）──────────────────────────────────────────────────

  /** 发现面的**按源**清单（本地派生，**零网络请求**）：书城左栏两级的同一份材料。
   *  参与集判据与 `searchPlan` 同源（`exploreParticipates` = 启停 invariant + 声明了分类入口）。
   *  派生本身归 `explore.ts` 的 `deriveExploreSources`（纯函数），本方法只套 wire 信封。 */
  exploreSources(): ExploreSources {
    return { sources: deriveExploreSources(this.registry.list()) }
  }

  /** 提交一轮分类浏览：**一个源、一个类、从第 1 页起**。点名不在可选集里的源一律抛错而不是给空轮次
   *  （空轮次会被读成「这一类没有书」）。抛 `InvalidRequestError`：值域判据归门面，HTTP 面经
   *  `errors.classify` 映射成 400。命中进程内快照即零请求。 */
  startExploreJob(sourceId: string, kind: string): JobStarted {
    const entry = this.pickEntry(sourceId, kind)
    if (entry === null) throw new InvalidRequestError(`该源没有可用的分类入口：${sourceId} · ${kind}`)
    return this.exploreJobs.start(sourceId, kind, (emit, _shouldStop, page) => this.runExplorePage(entry, page, emit))
  }

  /** 续下一页（**同一轮**，不换 id）。页码由持有者算（`ExploreJobRun` 的页码位），本层不再按快照页号 +1：
   *  失败的一页没占到，按它 +1 等于把失败页消费掉、永不再打。没得发就如实 null，路由回 409。
   *  判据只有 `hasMore` 一条（在途时它自己就是 false），再判一次就是给同一条读数立第二个主人。
   *  **入口解析不出（源刚被删 / 类改名）也按「没得发」走 null**，不跟 `startExploreJob` 共用抛错：
   *  那是用户点名点不到，这里是轮次仍在界面上的下一页——拿注册表变动算用户操作失误，还会让红错误盖掉已有书单。 */
  loadMoreExploreJob(): JobStarted | null {
    const snap = this.exploreJobs.snapshot()
    if (snap === null || !snap.hasMore) return null
    const entry = this.pickEntry(snap.sourceId, snap.kind)
    if (entry === null) return null
    return this.exploreJobs.advance(snap.kind, (emit, _shouldStop, page) => this.runExplorePage(entry, page, emit))
  }

  /** 源与类都要现查：入口地址与代际在这里一次算好交给执行体。「点不到」的三种情形合成一条判据
   *  （参与判据仍归 `exploreParticipates` 一处）。拿不到就返回 null、**不在此替调用方定后果**：
   *  提交时点不到是用户点名失败（抛，落 400），续页时点不到是没得可加载（null，落 409）。
   *  代际用 `exploreEpoch` 而非 `rulesEpoch`：后者把 ruleExplore* 一族全归 'none'，作者改了发现规则
   *  而入口地址不动时，陈旧书目会一直撑到 TTL 结束。 */
  private pickEntry(sourceId: string, kind: string): ExploreEntry | null {
    const s = this.registry.list().find((x) => x.id === sourceId)
    const hit = s?.rules.ruleExploreKinds.find((k) => k.title === kind)
    if (s === undefined || hit === undefined || !exploreParticipates(s)) return null
    return { source: s, kindUrl: hit.url, epoch: exploreEpoch(s.rules, s.baseUrl) }
  }

  /** 一轮里的一页：交给执行体的东西全部现成；运行器契约的 `shouldStop` 在这里用不上——取消归持有者。 */
  private async runExplorePage(
    entry: ExploreEntry, page: number, emit: (g: SearchGroup) => void,
  ): Promise<void> {
    emit(await fetchExploreGroup(entry.source, entry.kindUrl, this.sourceRequest, {
      timeoutMs: this.live.searchTimeoutMs, jsTimeoutMs: this.live.jsTimeoutMs, page,
      cache: this.exploreCache, epoch: entry.epoch,
    }))
  }

  /** 分类轮次读面：**全量**快照（跨页累积住服务端持有者）；null = 从未提交过或已过保留期。 */
  exploreJobSnapshot(): ExploreSnapshot | null { return this.exploreJobs.snapshot() }

  /** 分类轮次的「变了」信号口（SSE 路由用它拉全量帧；信号不带数据）。返回退订口。 */
  subscribeExploreJob(listener: () => void): () => void { return this.exploreJobs.signal.subscribe(listener) }

  private async searchOne(s: NovelSource, keyword: string, signal?: AbortSignal): Promise<SearchGroup> {
    // 源状态失败原因按需建键：SearchGroup 是跨半载荷，走 `src/shared/wire.ts` 的「缺席即不建键」口径
    const base = searchGroupBaseOf(s)
    try {
      // 请求语义全走搜索面（search-face.ts，与探针同一实现）：模板解析/组装/超时/解码/列表求值
      const page = await fetchSearchPage(s, keyword, this.sourceRequest, {
        timeoutMs: this.live.searchTimeoutMs, jsTimeoutMs: this.live.jsTimeoutMs,
        ...(signal === undefined ? {} : { signal }),
      })
      if (!page.ok) {
        return { ...base, error: { code: 'RuleMissing', message: page.message } }
      }
      if (page.shape === 'info') {
        // 整段响应就是详情页（搜索结果即详情页的形态）：按详情规则展开成**一条**书目
        const hit = await this.infoHitOf(s, page)
        return { ...base, hits: hit === null ? [] : [hit] }
      }
      const hits = await hitsOfContexts(s, 'search', page.subEval, page.contexts, page.landedUrl)
      return { ...base, hits }
    } catch (e) {
      // 取消不是「这一源搜失败了」：不写进结果集——把被掐掉的一轮当成完整事实，比报错更坏
      if (signal?.aborted === true) throw signal.reason ?? e
      return { ...base, error: { code: searchErrorCodeOf(e), message: errorMessageOf(e) } }
    }
  }

  /** 搜索面 info 形态的一条书目：字段走 bridge.detailFieldsOf，求值基准是落地地址，书地址用面算好的 bookUrl。
   *  书名为空 → null：只有书名非空才收这一条，「0 命中」是**结果**不是失败。 */
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
    // `book` 变量：详情面规则常见 `book.bookUrl`/`book.origin` 引用，且跨规则可见——给这次 getDetail
    // 一张共享 vars 表，init 的 `@put` 写进去，随后的字段规则与 tocUrl 模板才读得到（不跨门面共享）。
    const shelfBook = this.shelf.get(url)
    const subEval = createSourceEval(this.sourceRequest.fetcherFor(s), s, { jsTimeoutMs: this.live.jsTimeoutMs })
      .subEval({
        vars: {},
        book: { bookUrl: url, origin: s.baseUrl, ...(shelfBook === undefined ? {} : { shelfBook }) },
      })
    const html = await fetchSourceText(this.sourceRequest, s, url)
    // 七字段与 tocUrl 共用**一次** init 求值：字段段是 bridge.detailFieldsFromContext，整次读取的单点是
    // bridge.detailReadOf；搜索面 info 形态与探针仍走 detailFieldsOf——那条路不付 tocUrl 求值。
    const read = await detailReadOf(s, subEval, html, url)
    return { ...read.fields, tocUrl: read.tocUrl }
  }

  // ── 目录 ─────────────────────────────────────────────────────────────

  /** 目录：本地与在线的分流归 `BookContent`（缓存优先、在途去重、翻页闸与错误语义都在那条缝里）。 */
  async getToc(sourceId: string, bookUrl: string, opts?: { refresh?: boolean }): Promise<ChapterEntry[]> {
    return this.content.toc(sourceId, bookUrl, opts)
  }

  /** 目录导航：`chapters` 是线性阅读序列（与 getToc 同一份），`items` 是展示用树。
   *  本地书读持久化导航，其他书按目录派生平面导航——派生单点是 wire 的 `planarNavigation`，门面只委托。 */
  async getNavigation(sourceId: string, bookUrl: string): Promise<BookNavigation> {
    return this.content.navigation(sourceId, bookUrl)
  }

  // ── 正文 ─────────────────────────────────────────────────────────────

  /** 章节正文（**文字面**）：经**唯一**投影 `chapterContentToText`（TXT 与在线文本同过一条行规约，幂等）。 */
  async getChapter(sourceId: string, bookKey: string, chIndex: number, opts?: { refresh?: boolean }): Promise<string> {
    return chapterContentToText(await this.getChapterContent(sourceId, bookKey, chIndex, opts))
  }

  /**
   * 章节正文（**图文面**）：本地 EPUB 返回规范化图文树（按需读该章文档 JSON），本地 TXT 与在线书返回文字章。
   * 本地/在线分流与文字规约归 `BookContent`，门面只委托；文字面仍经唯一投影 `chapterContentToText`。
   */
  getChapterContent(sourceId: string, bookKey: string, chIndex: number, opts?: { refresh?: boolean }): Promise<ChapterContent> {
    return this.content.chapterContent(sourceId, bookKey, chIndex, opts)
  }

  /** 一章的**文字面读**（`dshnovel_read` 的深动词）：目录取一次，章名与正文成对交回。
   *  「目录 → 正文 → 章名」的编排归 `BookContent.readChapter`；门面只委托（`ADR-0047`）。 */
  async readChapter(sourceId: string, bookKey: string, chapterIndex: number): Promise<{ name: string; text: string }> {
    return this.content.readChapter(sourceId, bookKey, chapterIndex)
  }

  // ── 导出 ─────────────────────────────────────────────────────────────

  /** 范围导出的**深动词**：一次目录读数定案——空目录、裁剪后的区间、以及由 `exportBook` 组装的实际流。
   *  缺省全本、越界裁剪与裁剪后倒置是同一判据（`ADR-0052`；`ADR-0036` 的导出条款随此窄翻案）。
   *  两条失败结局交回值，路由翻成 422；门内不写头、不碰状态码、不读配置。
   *  `exportBook` 自己的越界即抛仍是前置校验。`ExportPlan` / `ExportOutcome` 同住本文件：只由本动词产出。 */
  async exportRange(sourceId: string, bookUrl: string, from: number | null, to: number | null,
    opts: { title: string; delayMs: number; signal: AbortSignal },
  ): Promise<ExportOutcome> {
    const toc = await this.getToc(sourceId, bookUrl)
    if (toc.length === 0) return { kind: 'empty-toc' }
    const clip = (n: number): number => Math.min(Math.max(n, 1), toc.length)
    const start = clip(from ?? 1)
    const end = clip(to ?? toc.length)
    if (start > end) return { kind: 'bad-range', from: start, to: end }
    return {
      kind: 'plan',
      plan: {
        from: start,
        to: end,
        totalInRange: end - start + 1,
        stream: exportBook(
          { getToc: (s, b) => this.getToc(s, b), getChapter: (s, b, i) => this.getChapter(s, b, i) },
          sourceId, bookUrl,
          { title: opts.title, delayMs: opts.delayMs, from: start, to: end, signal: opts.signal },
        ),
      },
    }
  }

  /** 收尾落盘：书架（防抖进度）+ 注册表（合并写）+ 听书引擎注册表（防抖合并写）+ 源状态
   *  （求值边界外的脏标记）一并等齐 */
  async flush(): Promise<void> {
    this.fetcher.sourceSession?.flush?.()
    await Promise.all([
      this.shelf.flush(),
      this.registry.flush(),
      ...(this.tts === null ? [] : [this.tts.engines.flush()]),
    ])
  }

  // ── 内部 ─────────────────────────────────────────────────────────────

  private requireSource(id: string): NovelSource {
    const s = this.registry.get(id)
    if (s === undefined) throw new SourceNotFoundError(id)
    return s
  }

}

// ── 模块级助手 ─────────────────────────────────────────────────────────

/** 登录按钮动作前拼的 loginUrl 脚本：剥离规则前缀；URL 形态不拼（那是给浏览器打开的地址，不是脚本体）。 */
function stripLoginPrefix(raw: string): string {
  const t = raw.trim()
  if (/^@js:/i.test(t)) return t.slice(4)
  const m = /^<js>([\s\S]*)<\/js>$/i.exec(t)
  const body = m === null ? undefined : m[1]
  // 切不出块体与「本来就不是块形态」同路：原文交给沙箱，不补一个空脚本
  return body === undefined ? t : body
}

/** 数据根级设备 ID：首次生成、此后稳定复用（androidId 的替代，不用随机值每轮冒充设备） */
async function readDeviceId(dir: string): Promise<string> {
  const file = path.join(dir, 'device-id')
  try {
    const v = (await fs.readFile(file, 'utf8')).trim()
    if (v !== '') return v
  } catch (e) {
    // 只有「缺文件」是首次；权限/IO 错误不许当成首次并覆盖原设备 ID（身份会悄悄换掉）
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
  const id = randomUUID()
  await writeFileAtomic(file, id)
  return id
}

function createFetcherWith(
  fetchImpl?: typeof globalThis.fetch,
  proxyUrl?: ValueSource<string | null>,
  cookieJar?: CookieJar,
  runtime?: Pick<FetcherOptions, 'deviceId' | 'sourceSession'>,
): Fetcher {
  return createFetcher({
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
    ...(proxyUrl === undefined ? {} : { proxyUrl }),
    ...(cookieJar === undefined ? {} : { cookieJar }),
    ...runtime,
  })
}

function errorMessageOf(e: unknown): string {
  if (!(e instanceof Error)) return String(e)
  const nl = e.message.indexOf('\n')
  return nl < 0 ? e.message : e.message.slice(0, nl)
}
