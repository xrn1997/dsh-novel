import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { ResolvedConfig } from '../config.js'
import { detailFieldsOf, detailReadOf, firstValue, hitFieldsOf } from './bridge.js'
import { DEFAULT_CACHE_MAX_BYTES, PageCache } from './cache.js'
import { exploreEpoch } from './cache-epoch.js'
import { chapterContentToText } from './chapter-content.js'
import { InvalidRequestError, LocalNotMountedError, SourceNotFoundError } from './errors.js'
import { createFetcher, DEFAULT_TIMEOUT_MS, type FetcherOptions } from './fetcher.js'
import { CookieJar } from './cookies.js'
import { BookContent } from './book-content.js'
import { WebViewRuntime } from './webview.js'
import { createFileSourceSession } from './source-session.js'
import type { Fetcher } from './fetcher.js'
import { KindCache } from './explore-cache.js'
import { ExploreJobs } from './explore-job.js'
import { deriveExploreSources, fetchExploreGroup } from './explore.js'
import { DEFAULT_EXPORT_DELAY_MS } from './export.js'
import { SourceJobs } from './import-job.js'
import { SearchJobs } from './search-job.js'
import type { JobHost } from './job-holder.js'
import type { ImportFile, JobState } from './import-job.js'
import { SourceIntake } from './intake.js'
import { DEFAULT_MAX_IMPORT_BYTES, isLocalBookKey, LOCAL_SOURCE_ID, LocalBooks } from './localbooks.js'
import type { LocalResource } from './localbooks.js'
import type { NormalizeIssue } from './normalize.js'
import { OnlineReading } from './online-reading.js'
import { exploreParticipates, participates } from './participation.js'
import { writeFileAtomic } from './storage.js'
import { applyProbeResult, probeSource } from './probe.js'
import type { ProbeResult } from './probe.js'
import { fetchSearchPage, searchErrorCodeOf } from './search-face.js'
import type { SearchFaceResult } from './search-face.js'
import { Shelf } from './shelf.js'
import { createSourceEval } from './source-eval.js'
import { createSourceRequest, fetchSourceText } from './source-request.js'
import type { SourceRequest } from './source-request.js'
import { loginUiOf, SourceRegistry } from './sources.js'
import type { NovelSource, SourceAuth } from './types.js'
import type { ValueSource } from './value-source.js'

// ── 公开类型（冻结：HTTP 面 / 工具面 / UI 只准用这套）──────────────────
// 值形状定义在 wire 契约（src/shared/wire.ts）——
// 此处 re-export 保持既有 import 路径可用；改形状请去 shared，别在这里加第二份。
export type { SearchHit, SearchGroup, ChapterEntry, BookDetail, SearchJobSnapshot, ExploreSources, ExploreSnapshot } from '../shared/wire.js'
/** 本地资源读口（含流/MIME 的 Node 内部形状）：api 层从本模块取用，不去 localbooks 抄第二处 */
export type { LocalResource } from './localbooks.js'
import { parseCookieString } from '../shared/cookies.js'
import type {
  BookDetail, BookNavigation, ChapterContent, ExploreSources, ExploreSnapshot, LocalImportResponse, LocalImportWarning,
  SearchGroup, SearchHit, SearchPlan, SearchJobSnapshot, ChapterEntry, ShelfBook, ShelfEntry, ShelfMetaPatch, SourcePublic,
} from '../shared/wire.js'
/** 聚合搜索并发（缺省 5）与 js 沙箱预算（缺省 15s）：**这两个数的唯一主人**——缺省装配处
 *  `src/config.ts` 的 schema `.default()` 与本文件 `from()` 回退都引这里，别处不再写字面量。15s 而非引擎 2s：多请求目录脚本 2s 必炸；
 *  名字带「预算」以别于引擎 `DEFAULT_JS_TIMEOUT_MS`，两层各有默认，同名会让按名 import 落错主人。 */
export const DEFAULT_SEARCH_PARALLEL = 5
export const DEFAULT_JS_BUDGET_MS = 15_000

export interface ReadingServiceOptions {
  dir: string                       // novel 根目录（测试注入 mkdtemp）
  /** 组合根交给服务的活配置读数面：给了就每次使用时读当前值（配置页热改即生效），
   *  逐字段值只作直装缝的回退 */
  config?: ResolvedConfig
  fetchImpl?: typeof globalThis.fetch
  searchParallel?: number           // 默认 5
  searchTimeoutMs?: number          // 默认 15000
  /** js 沙箱预算（透传 EvalContext.jsTimeoutMs；缺省 15000——理由见 DEFAULT_JS_BUDGET_MS） */
  jsTimeoutMs?: number
  tocMaxPages?: number              // 默认 200
  contentMaxPages?: number          // 默认 50
  cacheMaxBytes?: number            // 默认 200MB
  /** 本地文件导入上限（TXT / EPUB 共用：传输层流式计数与本地书 domain 上限同一配置值；默认 50MB） */
  localImportMaxBytes?: number
  /** 出站代理（见 proxy.ts：Node 的 fetch 不读系统代理）；null/缺省 = 直连。
   *  getter 形态供配置页热改——服务原样交给 fetcher，读值时机归它。 */
  proxyUrl?: ValueSource<string | null>
  /** 宿主 `ctx.jobs` 窄面：任务身份与生命周期交它（见 job-holder.ts 的 JobHost），缺省不登记 */
  jobHost?: JobHost
}
export interface ImportOutcome {
  sourceId: string | null; name: string; ok: boolean
  missing: NormalizeIssue[]; warnings: NormalizeIssue[]
  probe: ProbeResult | null
  /** 按址去重命中（intake 入库规则，矩阵行 `k-import-dedup`）：同 baseUrl 已有可用源则保留已有条目、
   *  未新增，sourceId 给可用的那条（同步与任务两条路都必须去重，否则可重复入库）。 */
  dupSkipped?: boolean
}

/** 一次点名解析出来的那一**条**分类入口：执行体要的三样（打哪个源、拿什么地址、按哪份代际存快照）。
 *  `pickEntry` 交出它、`runExplorePage` 收下它，两处各写一遍匿名形状就是让这条契约没有名字。
 *  不叫 `ExploreTarget`：那枚名字属于跨源编排那一层（一轮打多家），它随浏览轴一起撤了（`docs/adr/0028`）。 */
interface ExploreEntry {
  source: NovelSource
  kindUrl: string
  epoch: string
}

// ── 服务实现 ────────────────────────────────────────────────────────────

/** `searchParallel` 的值域尺（唯一住址）：非正整数会让批循环 `i += n` 永不终止——挂死而非报错，
 *  所以一律炸。装配期挡不住配置页后来的改动，故读数口每轮再过一次；一轮只取一个值，两次读之间
 *  翻页会让 `i += n` 与 `slice(i, i + n)` 用不同步长，批次就会重叠或漏行。 */
function requireParallelStep(n: number): number {
  if (!Number.isInteger(n) || n < 1) throw new RangeError(`searchParallel 必须为正整数，收到 ${String(n)}`)
  return n
}

/** 服务的直装缝：把逐字段值装成 ResolvedConfig 形状。不能调 resolveConfig——config.ts 已 import
 *  本文件的 DEFAULT_*，反向运行期依赖会成环；ResolvedConfig 只做 type-only import。
 *  `exportDelayMs` 不是服务的旋钮（HTTP 导出面自己读组合根给的值），这里给缺省只为满足读数面的形状；
 *  proxyUrl / dataDir 不在这里出现——它们是可选格，代理读数归 fetcher 自己的复用/关闭语义
 *  （由 createFetcherWith 单独传入），数据目录归组合根。 */
function staticLiveConfig(parts: {
  searchTimeoutMs?: number
  searchParallel?: number
  jsTimeoutMs?: number
  cacheMaxBytes?: number
  localImportMaxBytes?: number
}): ResolvedConfig {
  return {
    get searchTimeoutMs() { return parts.searchTimeoutMs ?? DEFAULT_TIMEOUT_MS },
    get searchParallel() { return parts.searchParallel ?? DEFAULT_SEARCH_PARALLEL },
    get jsTimeoutMs() { return parts.jsTimeoutMs ?? DEFAULT_JS_BUDGET_MS },
    get cacheMaxBytes() { return parts.cacheMaxBytes ?? DEFAULT_CACHE_MAX_BYTES },
    get exportDelayMs() { return DEFAULT_EXPORT_DELAY_MS },
    get localImportMaxBytes() { return parts.localImportMaxBytes ?? DEFAULT_MAX_IMPORT_BYTES },
  }
}

/**
 * 阅读链路门面：HTTP API / agent 工具 / UI 三个面的**唯一**业务入口。
 * 规则求值全部经引擎；抓取全部经守门 fetcher；缓存/书架/注册表在其上编排。
 * 在线目录与正文的管线归 `OnlineReading`，本地/在线分流与正文文字规约归 `BookContent`
 * （本文件只委托跨面动词），
 * 搜索/发现/书架/导入/登录/详情仍住这里（边界见 `docs/adr/0047`）。
 */
export class ReadingService {
  private constructor(
    /** 活配置读数面：所有可热改字段在使用时读当前值——装配期抄快照会让配置页的改动等到重启。
     *  dataDir 不在其中（启动期定址）。 */
    private readonly live: ResolvedConfig,
    private readonly registry: SourceRegistry,
    private readonly shelf: Shelf,
    /** 基础 fetcher 只留给 dispose / sourceSession；脚本出站与抓取一律走 sourceRequest */
    private readonly fetcher: Fetcher,
    /** 一次出站抓取的唯一装配点（动态头 → 限速 → webview/HTTP → loginCheck） */
    private readonly sourceRequest: SourceRequest,
    /** 书内容读面：目录 / 导航 / 正文的本地与在线分流与文字规约都在这条缝里 */
    private readonly content: BookContent,
    private readonly jobs: SourceJobs,
    /** 聚合搜索的后台持有者（读任务，与写的 `jobs` 分槽——见 services/search-job.ts 的理由） */
    private readonly searchJobs: SearchJobs,
    /** 分类浏览的后台持有者（与 `searchJobs` 同一档：读任务，与写的 `jobs` 分槽——理由同 services/explore-job.ts） */
    private readonly exploreJobs: ExploreJobs,
    /** 逐源分类快照：**一份实例**服务全部轮次与全部调用方，否则「重复进同一分类」永远打站点 */
    private readonly exploreCache: KindCache,
    private readonly local: LocalBooks | null,
    private readonly webview: WebViewRuntime,
  ) {}

  /** 本地书导入上限（传输层流式计数与本地书 domain 上限同一读数口——每次读活配置当前值） */
  get localImportMaxBytes(): number { return this.live.localImportMaxBytes }

  /** 关掉出站 dispatcher（代理连接池）；卸载时组合根调用，之后再抓取会按当前 proxyUrl 重建。 */
  dispose(): void {
    this.fetcher.dispose?.()
    this.fetcher.sourceSession?.flush?.()
    void this.webview.dispose()
  }

  /**
   * 生产快捷方式：建目录 + 从磁盘装配部件，再交 from() 总装。
   * 业务类不再被迫知道目录与加载细节——组合根与业务自此可分（server 侧）。
   * 本地书面：LocalBooks 也在此装配——「删书不留孤儿文件」invariant 归门面。
   */
  static async create(opts: ReadingServiceOptions): Promise<ReadingService> {
    // 主动建数据目录：保证存在 + 快速失败（dir 指向文件时 mkdir 抛错——ready 拒绝，入口层零注册）
    await fs.mkdir(opts.dir, { recursive: true })
    const live = opts.config ?? staticLiveConfig(opts)
    const cookieJar = new CookieJar()
    const deviceId = await readDeviceId(opts.dir)
    const sourceSession = createFileSourceSession(opts.dir)
    return ReadingService.from({
      // HTTP cookie 按域共享（与上游 CookieStore 同粒度）；脚本侧 source cookie 仍按源隔离。
      // 运行期字段（deviceId / sourceSession）随构造进 fetcher——门面不再往注入物上写回。
      fetcher: createFetcherWith(opts.fetchImpl, opts.proxyUrl, cookieJar, { deviceId, sourceSession }),
      cookieJar,
      registry: await SourceRegistry.load(opts.dir),
      shelf: await Shelf.load(opts.dir),
      cache: new PageCache(opts.dir, () => live.cacheMaxBytes),
      local: await LocalBooks.create(opts.dir, { maxImportBytes: () => live.localImportMaxBytes }),
      config: live,
      jobHost: opts.jobHost,
      tocMaxPages: opts.tocMaxPages,
      contentMaxPages: opts.contentMaxPages,
      proxyUrl: opts.proxyUrl,
    })
  }

  /**
   * 组合根注入面：接受已建好的部件（registry/shelf/cache/fetcher/local）直接总装——
   * 测试可换内存 registry adapter / 确定性 fetcher，而不必每次 mkdtemp + importOne。
   * **只读注入物**：jar 必须是构造方给 fetcher 的同一实例（不一致当场炸，门面不挑一张、
   * 不补写回）；deviceId / sourceSession 这类运行期字段也只由构造方带进 fetcher。
   * 后台任务面在此接线：导入/批量验证的探针口径与 search/probe 同一
   * fetcher 出口；timeoutMs 同源（探针与搜索对同一站点用同一耐心值）。
   * 部件（registry/shelf/jobs/local）总装后即 private——外部只经门面动词。
   * 逐字段数值是直装缝：给了 `config` 就全按它读（逐字段值让位于活配置），
   * 没有才把逐字段值装成一份静态读数——配置页的改动只走 `config` 那条路生效。
   */
  static async from(parts: {
    registry: SourceRegistry
    shelf: Shelf
    cache: PageCache
    fetcher: Fetcher
    local?: LocalBooks
    /** 宿主 `ctx.jobs` 的窄面（见 job-holder.ts 的 JobHost）；缺省即不登记，任务语义不变 */
    jobHost?: JobHost
    config?: ResolvedConfig
    localImportMaxBytes?: number
    searchParallel?: number
    tocMaxPages?: number
    contentMaxPages?: number
    searchTimeoutMs?: number
    jsTimeoutMs?: number
    /** 真浏览器 WebView 的出站代理值源（与 fetcher 同口径） */
    proxyUrl?: ValueSource<string | null>
    /** HTTP/浏览器共享 cookie jar（必填；fetcher 带 jar 时必须是同一实例） */
    cookieJar: CookieJar
  }): Promise<ReadingService> {
    const live = parts.config ?? staticLiveConfig(parts)
    // 装配期先过一遍：组合根直装的非法值要在启动时就炸，不留到第一次搜索才挂起
    requireParallelStep(live.searchParallel)
    // 同一张 jar 要同时服务 HTTP（自动回带/落库）与脚本面（CookieManager/CookieStore）——
    // 两处各持一张会让脚本读到的 cookie 与请求发出去的不是一份；装配只认调用方显式给的同一实例。
    if (parts.fetcher.cookieJar !== undefined && parts.fetcher.cookieJar !== parts.cookieJar) {
      throw new Error('fetcher.cookieJar 与 parts.cookieJar 不是同一张表——装配必须显式给同一实例')
    }
    const cookieJar = parts.cookieJar
    const webview = new WebViewRuntime(parts.proxyUrl === undefined ? {} : { proxyUrl: parts.proxyUrl })
    // 与基础 fetcher **同一张 jar**：两处各持一张会让脚本读到的 cookie 与请求发出去的不是一份
    const sourceRequest = createSourceRequest({
      fetcher: parts.fetcher, webview, cookieJar, jsTimeoutMs: () => live.jsTimeoutMs,
    })
    // 在线目录/正文管线：源查找、书架镜像、文件缓存与源求值都从组合根注入的部件现取；
    // 页数上限是装配期读数（不是配置页字段，不受热改约束）；js 预算相反——`sourceEvalFor`
    // 每建一次求值面都从 `live` 现读一次，热改对下一次求值即生效。
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
      parts.local ?? null,
      webview,
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
   *  超时与 js 预算必须与搜索同耐心（`searchTimeoutMs`/`jsTimeoutMs` 两个单点）——漏传会让
   *  同一源在导入期与门面两处探针拿回两个 verdict。 */
  async probe(id: string): Promise<ProbeResult> {
    const s = this.requireSource(id)
    const r = await probeSource(s, this.sourceRequest, { timeoutMs: this.live.searchTimeoutMs, jsTimeoutMs: this.live.jsTimeoutMs })
    await applyProbeResult(this.registry, id, r)
    return r
  }

  // ── 写侧动词：变更知识归门面，HTTP 面不再手写 edit 配方 ────────────────────

  /** 书源对外投影列表（凭据红线：raw/rules/auth 不出服务层——调用方不必知道 toPublic） */
  listPublicSources(): SourcePublic[] {
    return this.registry.list().map((s) => this.registry.toPublic(s))
  }

  /** 单源启停：未知 id → 抛 SourceNotFoundError（「源不存在」只在门面断言一次；
   *  路由面由 classify 免费拿 404，工具面不再先 hasSource 预检——bool 回执的语义不自明）。 */
  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const found = await this.registry.edit((tx) => tx.setEnabled(id, enabled))
    if (!found) throw new SourceNotFoundError(id)
  }

  /** 启停批量：未知 id 静默跳过、重复 id 幂等；返回实际变更数（一次 edit 一次合并落盘） */
  async setEnabledMany(ids: string[], enabled: boolean): Promise<number> {
    return this.registry.edit((tx) => {
      let n = 0
      for (const id of new Set(ids)) if (tx.setEnabled(id, enabled)) n++
      return n
    })
  }

  /** 删单源；不存在 → false。源级状态按脚本侧键（baseUrl）清理，不是 registry id。 */
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
   *  空产出（脚本没 return 出 cookie，或只写 `cookie.setCookie` 垫片又不读回——那张垫片是按源键值表，
   *  与 HTTP jar 不是一张；HTTP 响应的 `Set-Cookie` 现由 fetcher 自动落 jar，口径见矩阵 `b-cookie-jar`）
   *  **不算登录**：
   *  返回 null 且不写 auth（落空 auth 会把 hasAuth 点亮成「已登录」而零凭据）。
   * URL 形态由调用侧分流（不在此处理——开新 tab + cookie 录入，不注入 WebView）。 */
  async runLogin(id: string): Promise<SourceAuth | null> {
    const s = this.requireSource(id)
    const loginUrl = s.rules.loginUrl
    if (loginUrl === null) throw new Error(`源「${s.name}」未声明 loginUrl`)
    if (/^https?:\/\//i.test(loginUrl)) throw new Error(`源「${s.name}」的登录地址是 URL，不是 JS 登录脚本`)
    // 与按钮动作共用同一条前缀剥离：`<js>…</js>` 不能再套一个 `@js:`（会变成语法错）
    const v = await createSourceEval(this.sourceRequest.fetcherFor(s), s, { jsTimeoutMs: this.live.jsTimeoutMs })
      .evaluate('@js:' + stripLoginPrefix(loginUrl), { baseUrl: s.baseUrl })
    // 宽松 `k=v;` 串的解析规则跨半只有一份（`shared/cookies.ts`）：登录脚本产出的串与用户在
    // 登录面板手工粘进去的串走同一条语法，两处各写一遍就是给这条语法两个主人。
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

  /** RowUi button action：绝对 URL 回传给 UI 打开；其余按上游把 loginUrl 脚本拼在 action 前执行，
   *  `result` 绑定当前 loginInfo 的 Map。按钮按名字查服务端源数据，客户端不持脚本。 */
  async runLoginAction(id: string, name: string): Promise<{ mode: 'external'; url: string } | { mode: 'script' }> {
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

  /** 书架读取面：落盘条目 + **来源投影**（sourceName），按**最近阅读**排序。
   *  排序键是进度自己的 `updatedAt`（每次存进度刷新；新书 = 加入时刻），
   *  同刻按加入时间、再按 bookKey 定序，保证 API / 工具 / 书架三面读到的顺序一致。
   *  源名在这里实时 join 注册表（与 SearchGroup.sourceName 同一口径）——落盘快照会在源改名 /
   *  同址替换复用 id 后陈旧（intake 复用旧 id，见按址去重）。join 不到 = 源已被删 → null。 */
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
   *  title / sourceId 必填非空（静默兜底 `?? ''` 会造出写入 200、读取才炸的死书）；
   *  值域门在这里而不是路由——HTTP 面与工具面共用本动词，门长在路由只护一半。 */
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
   *  值域门在这里（同 shelfAdd）：Infinity 会被 `JSON.stringify` 落盘成 null 静默损坏，
   *  只护 HTTP 面护不住工具面。 */
  shelfSaveProgress(bookKey: string, chapterIndex: number, offsetRatio: number): ShelfBook | null {
    if (!Number.isInteger(chapterIndex) || chapterIndex < 0
      || !Number.isFinite(offsetRatio) || offsetRatio < 0 || offsetRatio > 1) {
      throw new InvalidRequestError('progress.chapterIndex 需为非负整数、offsetRatio 需为 [0,1] 有限数')
    }
    if (this.shelf.get(bookKey) === undefined) return null
    this.shelf.updateProgress(bookKey, chapterIndex, offsetRatio)
    return this.shelf.get(bookKey) ?? null
  }

  /** 删本地副本：只对真在架的本地键做（`localEvenIfOffShelf` 只给 `removeLocalBook`——
   *  它点名的是磁盘上的本地书，即使不在架也要清副本），返回实际删掉的副本数。
   *  单删、批删与本地删共用这一处顺序与判据：文件删失败即抛出，调用方保留架位可重试。 */
  private async removeLocalCopies(keys: Iterable<string>, localEvenIfOffShelf: boolean): Promise<number> {
    if (this.local === null) return 0
    let removed = 0
    for (const key of new Set(keys)) {
      if (!isLocalBookKey(key)) continue
      if (!localEvenIfOffShelf && this.shelf.get(key) === undefined) continue
      if (await this.local.remove(key)) removed += 1
    }
    return removed
  }

  /** 删一本：先删本地副本，再移架位（单删、本地删与批删三条入口共用同一顺序）。
   *  文件删失败时架位保留，用户可重试；反过来会留下没有架位的磁盘孤儿。 */
  private async removeShelfAndLocal(bookKey: string, localEvenIfOffShelf: boolean): Promise<boolean> {
    const localRemoved = await this.removeLocalCopies([bookKey], localEvenIfOffShelf) > 0
    const shelfRemoved = this.shelf.remove(bookKey)
    return shelfRemoved || localRemoved
  }

  /** 删书：本地书连带删文件（防孤儿 invariant 归门面；副本先删，失败则架位保留可重试） */
  async removeBook(bookKey: string): Promise<{ removed: boolean }> {
    return { removed: await this.removeShelfAndLocal(bookKey, false) }
  }

  /** 批量删书（书架多选）：与单删共用 `removeLocalCopies`——本地书副本连删**只对真在架的键**做
   *  （幽灵键不该去动磁盘），且副本先删：删失败即抛出、架位整批保留可重试，反过来会留下
   *  没有架位的磁盘孤儿。未知键静默跳过、重复键幂等，返回实际删除数（与批路由同口径）。 */
  async removeBooks(bookKeys: readonly string[]): Promise<{ removed: number }> {
    await this.removeLocalCopies(bookKeys, false)
    return { removed: this.shelf.removeMany(bookKeys).length }
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

  /** 删本地书：文件 + 书架条目一并删（任一命中即 removed；与单删同一条「先副本、后架位」顺序） */
  async removeLocalBook(id: string): Promise<{ removed: boolean }> {
    this.requireLocal()
    return { removed: await this.removeShelfAndLocal(id, true) }
  }

  private requireLocal(): LocalBooks {
    if (this.local === null) throw new LocalNotMountedError()
    return this.local
  }

  // ── 搜索 ─────────────────────────────────────────────────────────────

  /** 聚合搜索的**唯一实现**。`onGroup` 是增量出口：单源求值完成即按完成序交付，
   *  返回值仍按参搜源序——HTTP 面与工具面的既有形状一字不改，而后台任务/将来做任务的
   *  那一路可以边跑边被看见（浏览器半不再自持分批循环，只消费这个增量）。
   *  sourceIds 缺省**或空数组**都视为「未限定」= 搜全部启用源（不要把空数组当「搜零个源」，
   *  零分组空结果会冒充成功）。 */
  private async searchProgressive(keyword: string, opts?: {
    sourceIds?: string[]
    onGroup?: (group: SearchGroup, index: number) => void
    /** 协作式停止：置位后**不再开新的源**（在途的不撤回）。搜索做成后台任务时的取消出口。 */
    shouldStop?: () => boolean
  }): Promise<SearchGroup[]> {
    const want = opts?.sourceIds
    const sources = this.registry.list().filter((s) =>
      participates(s) && (want === undefined || want.length === 0 || want.includes(s.id)))
    const groups: SearchGroup[] = new Array(sources.length)
    const step = requireParallelStep(this.live.searchParallel)
    for (let i = 0; i < sources.length; i += step) {
      if (opts?.shouldStop?.() === true) break
      const batch = sources.slice(i, i + step)
      await Promise.all(batch.map(async (s, j) => {
        if (opts?.shouldStop?.() === true) return         // 收手：该源不发了，结果里也就没有它
        const index = i + j
        const group = await this.searchOne(s, keyword)
        groups[index] = group
        opts?.onGroup?.(group, index)
      }))
    }
    // 停止时数组可能有洞（filter 天然跳过洞位）；未停止时无洞
    return groups.filter((g): g is SearchGroup => g !== undefined)
  }

  /** 一次性收齐全部命中：`searchProgressive` 的薄壳。**批循环只此一处**——
   *  搜索后台化的正确动作是给上面那份加消费方，不是再写第二个循环。 */
  search(keyword: string, opts?: { sourceIds?: string[] }): Promise<SearchGroup[]> {
    return this.searchProgressive(keyword, opts)
  }

  /** 搜索参与计划：**参与者 id 清单**这条投影的唯一主人——客户端分批/进度按此走，
   *  「哪些源参搜」不再在 wire 两侧各定义一份。
   *  谓词不在本文件：「谁参搜」的**判据**单点是 `services/participation.ts` 的 `participates`。 */
  searchPlan(): SearchPlan {
    return { sourceIds: this.registry.list().filter((s) => participates(s)).map((s) => s.id) }
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
  subscribeSearchJob(listener: () => void): () => void { return this.searchJobs.signal.subscribe(listener) }

  // ── 分类浏览（书城）──────────────────────────────────────────────────

  /** 发现面的**按源**清单（本地派生，**零网络请求**）：书城左栏两级的同一份材料。
   *  参与集判据与 `searchPlan` 同源——`exploreParticipates` 就是那条启停 invariant 再加一条
   *  「声明了分类入口」，故清单与参搜集合不会各说一套。
   *  派生本身归 `explore.ts` 的 `deriveExploreSources`（吃名册吐数组的纯函数）：本方法只往上套一层
   *  wire 信封。两个名字各指一层，读调用点的人不必现场分辨问的是哪一层。 */
  exploreSources(): ExploreSources {
    return { sources: deriveExploreSources(this.registry.list()) }
  }

  /** 提交一轮分类浏览：**一个源、一个类、从第 1 页起**。
   *  点名不在可选集里的源（源不存在 / 没声明这一类 / 不进城）一律抛错而不是给一个空轮次——
   *  空轮次会被读成「这一类没有书」，那是把「没点名成功」冒充成事实；用户主动点名的东西点不到，
   *  就该响亮地告诉他点不到。抛 `InvalidRequestError` 而不是路由层的错误类：值域判据归门面
   *  （架构硬约束「services 不 import api」），HTTP 面经 `errors.classify` 映射成与路由自检
   *  同一份的 400 BadRequest 信封。
   *  命中进程内快照即零请求（重复进同一类不打站点是那份快照存在的全部理由）。 */
  startExploreJob(sourceId: string, kind: string): { jobId: string } {
    const entry = this.pickEntry(sourceId, kind)
    if (entry === null) throw new InvalidRequestError(`该源没有可用的分类入口：${sourceId} · ${kind}`)
    return this.exploreJobs.start(sourceId, kind, (emit, _shouldStop, page) => this.runExplorePage(entry, page, emit))
  }

  /** 续下一页（**同一轮**，不换 id）。要打第几页由持有者算（`ExploreJobRun` 的页码位），本层不再按
   *  快照页号 +1：那个数是「已占到第几页」，失败的一页没占到，按它 +1 就等于把失败页消费掉、永不再打。
   *  没得发就如实 null，不做无效请求——
   *  路由据此回 409，客户端据此把「加载更多」收掉，而不是假装又加载了一轮。
   *
   *  判据只有 `hasMore` 一条：它已经是服务端「**此刻**能不能点」的唯一读数（在途那一段它自己就是
   *  false），这里再判一次在途就是给同一条读数立第二个主人——两份判据迟早会一边说能、一边说不能。
   *
   *  **入口解析不出（源刚被删 / 那一类改了名）也按「没得发」走 null**，不跟 `startExploreJob` 共用
   *  那条抛错：那边是用户主动点名一个点不到的东西，这边是**轮次还显示在界面上**、用户点的是这一轮的
   *  下一页——「没得可加载」与「你点了个不存在的东西」是两件事，把前者报成后者等于拿注册表的变动
   *  算成用户的操作失误，还顺手让一条红错误盖掉那一轮已经读得到的书单。轮次本身不受影响。 */
  loadMoreExploreJob(): { jobId: string } | null {
    const snap = this.exploreJobs.snapshot()
    if (snap === null || !snap.hasMore) return null
    const entry = this.pickEntry(snap.sourceId, snap.kind)
    if (entry === null) return null
    return this.exploreJobs.advance(snap.kind, (emit, _shouldStop, page) => this.runExplorePage(entry, page, emit))
  }

  /** 源与类都要现查：注册表是唯一的源清单，入口地址与代际在这里一次算好交给执行体。
   *  「点不到」的三种情形（源不在清单 / 该源没声明这一类 / 该源不进城）**合成一条判据**：
   *  参与判据仍归 `exploreParticipates` 一处，本函数不复制它的启停规则，只是把「拿不到入口」
   *  与「这个源不该被点名」落成同一个读数。
   *
   *  拿不到就返回 null、**不在这里替调用方定后果**：同一个「点不到」在两个调用方那里是两种事实——
   *  提交时点不到是用户点名失败（抛，落成 400），续页时点不到是没得可加载（null，落成 409）。
   *  判据单点在这里，选哪种后果归那两个门面方法各自说清。
   *
   *  代际用 `exploreEpoch` 而非 `rulesEpoch`：后者按「一个字段变更作废哪些**引擎面**（目录/正文）的
   *  文件缓存」归类，ruleExplore* 一族在那张表里全归 'none'——拿它当快照键，作者改了发现规则而
   *  入口地址不动时，陈旧书目会一直撑到 TTL 结束。两份指纹同一个主人、各按自己的消费路径收字段。 */
  private pickEntry(sourceId: string, kind: string): ExploreEntry | null {
    const s = this.registry.list().find((x) => x.id === sourceId)
    const hit = s?.rules.ruleExploreKinds.find((k) => k.title === kind)
    if (s === undefined || hit === undefined || !exploreParticipates(s)) return null
    return { source: s, kindUrl: hit.url, epoch: exploreEpoch(s.rules, s.baseUrl) }
  }

  /** 一轮里的一页：交给执行体的东西全部现成（入口地址、代际、页码），本层不再推导。
   *  运行器契约的第二个参数 `shouldStop`（协作式取消）在这里用不上——单源一次就完，
   *  取消仍由持有者的代际点穴承担。 */
  private async runExplorePage(
    entry: ExploreEntry, page: number, emit: (g: SearchGroup) => void,
  ): Promise<void> {
    emit(await fetchExploreGroup(entry.source, entry.kindUrl, this.sourceRequest, {
      timeoutMs: this.live.searchTimeoutMs, jsTimeoutMs: this.live.jsTimeoutMs, page,
      cache: this.exploreCache, epoch: entry.epoch,
    }))
  }

  /** 分类轮次读面：**全量**快照（跨页累积住在服务端持有者，增量模型装不下——见 services/explore-job.ts）。
   *  null = 从未提交过，或结束后过了保留期。 */
  exploreJobSnapshot(): ExploreSnapshot | null { return this.exploreJobs.snapshot() }

  /** 分类轮次的「变了」信号口（SSE 路由用它拉全量帧；信号不带数据）。返回退订口。 */
  subscribeExploreJob(listener: () => void): () => void { return this.exploreJobs.signal.subscribe(listener) }

  private async searchOne(s: NovelSource, keyword: string): Promise<SearchGroup> {
    const base = {
      sourceId: s.id, sourceName: s.name, status: s.status,
      statusDetail: s.statusDetail, hits: [] as SearchHit[],
    }
    try {
      // 请求语义全走搜索面（search-face.ts，与探针同一实现）：模板解析/组装/超时/解码/列表求值
      const page = await fetchSearchPage(s, keyword, this.sourceRequest, this.live.searchTimeoutMs, this.live.jsTimeoutMs)
      if (!page.ok) {
        return { ...base, error: { code: 'RuleMissing', message: page.message } }
      }
      if (page.shape === 'info') {
        // 整段响应就是详情页（搜索结果即详情页的形态）：按详情规则展开成**一条**书目
        const hit = await this.infoHitOf(s, page)
        return { ...base, hits: hit === null ? [] : [hit] }
      }
      const hits: SearchHit[] = []
      // 求值与相对链接基准 = 落地地址（浏览器语义，与目录/正文面同口径——重定向站点不再错位）；
      // 上下文由搜索面按条目产出（AllInOne 条目带行，字段规则的 `$n` 在引擎入口绑定）
      // ruleBookName 的非空保障在搜索面（缺规则整体 RuleMissing，不降级 `?? ''`——空串规则返回
      // 整页文本会造垃圾标题），这一格只为 `hitFieldsOf` 的 name 恒非空契约而写
      const R = {
        name: s.rules.ruleBookName ?? '', author: s.rules.ruleAuthor, url: s.rules.ruleBookUrl,
        cover: s.rules.ruleCoverUrl, intro: s.rules.ruleIntro, last: s.rules.ruleLastChapter,
        kind: s.rules.ruleKind, wordCount: s.rules.ruleWordCount,
      }
      for (const ctx of page.contexts) {
        // 档位与槽序的单点在 bridge.hitFieldsOf（书名非空才算书目 / 裸奔项 / 坏规则只丢该字段）；
        // 这里的 try/catch 才是「整组归错码」的主人
        const hit = await hitFieldsOf(R, page.subEval, ctx, page.landedUrl)
        if (hit !== null) hits.push(hit)
      }
      return { ...base, hits }
    } catch (e) {
      return { ...base, error: { code: searchErrorCodeOf(e), message: errorMessageOf(e) } }
    }
  }

  /** 搜索面 info 形态的一条书目：字段走 bridge.detailFieldsOf（与 getDetail 的字段段共用
   *  bridge.detailFieldsFromContext，含 init 换根），求值基准是落地地址（重定向后按落地地址解析相对链接），
   *  书地址用面算好的 bookUrl。
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
    // `book` 变量：详情面规则常见 `book.bookUrl`/`book.origin` 引用（脚本/模板段），
    // 且跨规则可见（`book`/`chapter` 绑定与 vars 表随求值上下文传递）——这里给这次 getDetail
    // 一张共享 vars 表：init 的 `@put:{n:"[property$=book_name]@content"}` 写进去，
    // 随后的 `@get:{n}` 字段规则与 tocUrl 模板才读得到（各次调用新建，不跨门面共享）。
    const shelfBook = this.shelf.get(url)
    const subEval = createSourceEval(this.sourceRequest.fetcherFor(s), s, { jsTimeoutMs: this.live.jsTimeoutMs })
      .subEval({
        vars: {},
        book: { bookUrl: url, origin: s.baseUrl, ...(shelfBook === undefined ? {} : { shelfBook }) },
      })
    const html = await fetchSourceText(this.sourceRequest, s, url)
    // 七字段与 tocUrl 共用**一次** init 求值：字段段是 bridge.detailFieldsFromContext（detailFieldsOf
    // 与 detailReadOf 共用的那一份回落链与档位），整次读取的单点是 bridge.detailReadOf；搜索面
    // info 形态与探针仍走 detailFieldsOf——那条路只要字段，不付 tocUrl 求值。
    const read = await detailReadOf(s, subEval, html, url)
    return { ...read.fields, tocUrl: read.tocUrl }
  }

  // ── 目录 ─────────────────────────────────────────────────────────────

  /** 目录：本地与在线的分流归 `BookContent`（缓存优先、在途去重、翻页闸与错误语义都在那条缝里）。 */
  async getToc(sourceId: string, bookUrl: string, opts?: { refresh?: boolean }): Promise<ChapterEntry[]> {
    return this.content.toc(sourceId, bookUrl, opts)
  }

  /** 目录导航：`chapters` 是线性阅读序列（与 getToc 同一份），`items` 是展示用树。
   *  本地书读持久化导航（EPUB 原生 nav/NCX；TXT 由线性序列派生），其他书按目录派生平面导航——
   *  派生单点是 wire 的 `planarNavigation`（消费点 `services/book-content.ts`），门面只委托。 */
  async getNavigation(sourceId: string, bookUrl: string): Promise<BookNavigation> {
    return this.content.navigation(sourceId, bookUrl)
  }

  // ── 正文 ─────────────────────────────────────────────────────────────

  /** 章节正文（**文字面**）：现有 AI 工具 / TXT 导出 / 阅读器的文字出口——经**唯一**投影
   *  `chapterContentToText`（TXT 与在线文本同过一条行规约，幂等），不写第二份文字实现。 */
  async getChapter(sourceId: string, bookKey: string, chIndex: number, opts?: { refresh?: boolean }): Promise<string> {
    return chapterContentToText(await this.getChapterContent(sourceId, bookKey, chIndex, opts))
  }

  /**
   * 章节正文（**图文面**）：本地 EPUB 返回规范化图文树（按需读该章的文档 JSON），
   * 本地 TXT 与在线书返回文字章。
   *
   * 本地/在线分流与正文文字规约归 `BookContent`（`services/book-content.ts`），门面只委托；
   * dispatch 与工具面都不持 LOCAL 知识。文字面（`getChapter`）仍经唯一投影
   * `chapterContentToText`——text 分支再过一次行规约，幂等。
   */
  getChapterContent(sourceId: string, bookKey: string, chIndex: number, opts?: { refresh?: boolean }): Promise<ChapterContent> {
    return this.content.chapterContent(sourceId, bookKey, chIndex, opts)
  }

  /** 收尾落盘：书架（防抖进度）+ 注册表（合并写）一并等齐 */
  async flush(): Promise<void> { await Promise.all([this.shelf.flush(), this.registry.flush()]) }

  // ── 内部 ─────────────────────────────────────────────────────────────

  private requireSource(id: string): NovelSource {
    const s = this.registry.get(id)
    if (s === undefined) throw new SourceNotFoundError(id)
    return s
  }

}

// ── 模块级助手 ─────────────────────────────────────────────────────────

/** 登录按钮动作前拼的 loginUrl 脚本：剥离规则前缀；URL 形态不拼（上游 getLoginJs 只给 JS 形态）。 */
function stripLoginPrefix(raw: string): string {
  const t = raw.trim()
  if (/^@js:/i.test(t)) return t.slice(4)
  const m = /^<js>([\s\S]*)<\/js>$/i.exec(t)
  return m === null ? t : m[1]
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
  return e instanceof Error ? e.message.split('\n')[0] : String(e)
}
