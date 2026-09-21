/**
 * 跨半 wire 契约（现状真相与口径：docs/design/services.md 的「wire 契约」节）：
 * /novel-api 规范 JSON 的值形状、路由名、错误信封——Node 半与浏览器半之间的唯一真相。
 *
 * 两条硬约束（构建期事实，不是偏好）：
 *  ① tsdown 的 client 纯度门拦 Node 内建与平台模块表外的 @deepseek-ai/* 值 import——本文件
 *     两者都不涉及，且**禁引任何运行时依赖**（client 半会把整个文件 inline 进 bundle）；
 *  ② type-only 依赖可引（构建期擦除）。
 *
 * 可空口径：wire 上空值字段一律 `| null`，不写 `?:`（JSON 里 null 是在场的值）。
 * 时间戳/状态细节这类「可能整键缺席」的字段保持 `?:`——JSON.stringify 会丢 undefined 键。
 * 工具面（src/tools/）的缺键投影（lossless-JSON 约束）是其自身职责，与此口径不冲突。
 */

// ── 身份与状态枚举（sources.json 持久化与 wire 共用；services/types.ts 反向 re-export）────

/** 书源状态：未验证 / 探针通过 / 探针判坏 */
export type SourceStatus = 'unverified' | 'verified' | 'broken'

/** 书源内容形态（legado bookSourceType：0/-1/缺省=文本，**1=音频，2=图片，3=文件**——
 *  真值锚点 legado-with-MD3 `constant/BookSourceType.kt`；此前本仓注释与映射把 1/2 读反）。
 *  `unknown` = **编码读不懂**（不是 legado 认得的整数值），不是第五种媒介而是「这本文源不规范」：
 *  读不懂不等于文本，一律不进参与集（2026-09 裁定，推翻此前「warning 后按文本处理」——
 *  误标 text 的短剧/漫画源一直混进聚合搜索与文字书架）。它也不写 `status`：探针按搜索面
 *  重判 verified/broken，而这类源的搜索面恰恰是好的，用状态承载会被下一次重验洗白。
 *  本插件当前只支持文本源：导入预检点名拒绝非文本与未知；聚合搜索参与集 = enabled ∧ type==='text'
 *  （判定单点在 reading 的 participates 谓词）；存量误标由 SourceRegistry.load 按 raw 重推收敛。 */
export type SourceContentKind = 'text' | 'image' | 'audio' | 'file' | 'unknown'

/** 探针失败原因：引擎三类 + 抓取两类 + 规则缺失；'Error' 为兜底（出现即分类漏了） */
export type ProbeErrorCode =
  | 'UnsupportedRuleError' | 'RuleEvalError' | 'JsSandboxError'
  | 'FetchError' | 'DecodeError' | 'RuleMissing' | 'Error'

/** 本地书（本地 TXT 导入）的保留源 id——跨半契约常量的**唯一主人**：
 *  client 半与测试直接 import 本处；服务半（src/services/localbooks.ts）也 import 后 re-export，
 *  不再自带第二份声明（服务半不受 client 纯度门禁约束，可直接引 shared）。改名只需改这一行。 */
export const LOCAL_SOURCE_ID = '__local__'

// ── 书源面 ──────────────────────────────────────────────────────────────

/** 书源对外投影（SourceRegistry.toPublic 产出）：绝不含 raw / rules / auth——
 *  凭据与原文只落盘，不出现在对外返回值。 */
export interface SourcePublic {
  id: string
  name: string
  baseUrl: string
  enabled: boolean
  groups: string[]
  /** 内容形态（legado bookSourceType）：非文本源在本插件属异常 */
  type: SourceContentKind
  status: SourceStatus
  statusDetail?: string
  importedAt: number
  lastProbedAt?: number
  hasHeader: boolean
  hasAuth: boolean
  authExpired: boolean
}

/** 探针结论（search 面）：verified/broken 口径 + 段级原因透出 */
export interface ProbeResult {
  ok: boolean
  itemCount: number
  firstTitle: string | null
  error?: { code: ProbeErrorCode; message: string }
  probedAt: number
}

/** 后台任务明细条目（failed/warning/dup/replaced） */
export interface JobIssue {
  name: string
  kind: 'failed' | 'warning' | 'dup' | 'replaced'
  detail: string
}

/** 后台任务状态（单任务槽：运行中互斥、结果保留到下一任务开始；任务态只在内存） */
export interface JobState {
  id: string
  kind: 'import' | 'batch-probe'
  phase: 'running' | 'done' | 'failed'
  total: number
  done: number
  counts: { ok: number; failed: number; dupSkipped: number; replaced: number }
  /** 明细截断 200 条（计数字段不受影响） */
  issues: JobIssue[]
  fileErrors: Array<{ file: string; error: string }>
  startedAt: number
  finishedAt?: number
  error?: string
}

// ── 阅读面 ──────────────────────────────────────────────────────────────

/** 搜索命中条目：可空即 `null`，不是缺键 */
export interface SearchHit {
  title: string
  author: string | null
  url: string | null
  coverUrl: string | null
  intro: string | null
  lastChapterName: string | null
}

/** 逐源搜索分组：单源失败只写 error，不拖垮整批 */
export interface SearchGroup {
  sourceId: string
  sourceName: string
  status: SourceStatus
  statusDetail?: string
  hits: SearchHit[]
  error?: { code: string; message: string }
}

/** 聚合搜索后台任务的**读面快照**（跨半契约形状；服务端如何持有整轮结果属服务层，不上 wire）。
 *  为什么是「服务端持有 + 显式快照查询」：中央呈现座位一次只渲染一个面板（`main` keyed 槽；
 *  此前 `conversation.view`），浏览器半自持在途循环 ⇒ 切走即丢结果（实测：卸载后剩余批次还
 * 发完、重挂载整轮重打）。
 *  官方另要求「需要可靠恢复的 stateful domain 必须提供 baseline、cursor 或显式 query」
 *  （`docs/reference/dsh-plugin-api.md` §9）——`added`/`next` 就是那个 cursor。
 *  `phase` 与 `JobState` 同一套词汇：UI 的「还在跑吗」判据（`phase !== 'running'`）只此一种。 */
export interface SearchJobSnapshot {
  id: string
  keyword: string
  phase: 'running' | 'done' | 'failed'
  /** 用户主动「停止」（`phase='failed'` 而**不是失败**）：UI 据此不报红条、文案说「已停止」，
   *  已搜出的命中一律保留。为什么不靠 `error` 文案判：那是把 UI 语义寄在一条中文串上，
   *  且刷新后重读同一轮还得再猜一次——判据要上契约。 */
  cancelled: boolean
  /** 本轮真实参搜源数（searchPlan 说了算，与「批数」无关） */
  total: number
  /** 已完成的源数（= 服务端已累积的组数，完成序） */
  done: number
  /** `since` 之后的增量分组（谁先搜完谁先可见）；客户端把 `next` 当作下次的 `since` */
  added: SearchGroup[]
  next: number
  startedAt: number
  finishedAt?: number
  error?: string
}

/** 每源命中上限（后台搜索任务的持有截断；站点侧搜索面本就只取首页） */
export const SEARCH_HITS_CAP_PER_SOURCE = 50

/** 一轮搜索结果的保留期（结束后过此时点读作「无任务」，不伪装成「搜了没命中」） */
export const SEARCH_JOB_RETENTION_MS = 30 * 60 * 1000

export interface ChapterEntry { name: string; url: string }

/** 搜索参与计划：本次聚合搜索的真实参与者——参与集唯一主人在服务端，
 *  客户端分批/进度条按此走，不再自行重推导启停 invariant。 */
export interface SearchPlan { sourceIds: string[] }

/** 书籍详情：字段缺失是 `null`（「源没这条信息」≠「没解出来」），不是缺键 */
export interface BookDetail {
  title: string | null
  author: string | null
  coverUrl: string | null
  intro: string | null
  lastChapterName: string | null
  tocUrl: string | null
}

// ── 书架面 ──────────────────────────────────────────────────────────────

/** type 别名而非 interface：工具输出 schema 会把它推断进 Record<string, JsonValue>，
 *  interface 无隐式 index signature 会在这里炸（实测）——别改回 interface。 */
export type ShelfProgress = { chapterIndex: number; offsetRatio: number; updatedAt: number }

/** 书架条目：元数据 + 阅读进度 */
export interface ShelfBook {
  sourceId: string
  bookKey: string
  title: string
  author?: string
  coverUrl?: string
  intro?: string
  lastChapterName?: string
  /** 全书章数（可选——旧数据无此字段；首页进度条用） */
  totalChapters?: number
  progress: ShelfProgress
  addedAt: number
}

/** 书目元数据字段集（唯一主人）：7 个元数据字段的
 *  「名称 × wire 类型判别 × 归一化」只准活在这张表 + pickShelfMeta 里。
 *  消费方三面：Shelf.applyPatch（保值覆盖遍历表）、shelfBody（客户端 body 构造）、
 *  dispatch.shelfPut（未知 JSON body → 归一化字段）。加一个书目字段 = 改这张表。
 *  bookKey（身份）/ progress、addedAt（系统字段）不属于元数据写口，不进表；
 *  来源投影（sourceName，见 ShelfEntry）也不进——它不可 patch、不落盘。 */
export const SHELF_META = {
  sourceId: 'string',
  title: 'string',
  author: 'string',
  coverUrl: 'string',
  intro: 'string',
  lastChapterName: 'string',
  totalChapters: 'number',
} as const

export type ShelfMetaField = keyof typeof SHELF_META

/** 书架**读取面**条目：落盘的 ShelfBook + 来源投影 sourceName。
 *  来源投影 = 服务端 list 时拿 sourceId 去书源注册表 join 出来的源名（与 SearchGroup.sourceName 同一口径）：
 *  源已被删 → null（UI 灰字「来源已删除」），本地书恒 null（本地身份归 LOCAL_SOURCE_ID 判别）。
 *  它不是书目字段：不可 patch、绝不进 shelf.json——所以刻意不进 SHELF_META（进表 = 变成可写元数据）。
 *  加书那刻快照源名是**被否决的方案**：源改名/同址替换复用 id 后名字会陈旧（intake 复用旧 id 见 services.md）。 */
export type ShelfEntry = ShelfBook & { sourceName: string | null }

/** 书目元数据 patch：null/undefined 键 = 保值（Shelf.update 的 interface 语义，见 shelf.ts） */
export type ShelfMetaPatch = { [K in ShelfMetaField]?: ShelfBook[K] | null }

/** 任意 JSON 值 → 合法元数据字段（类型判别与归一化的唯一实现）：
 *  类型不符 / null / undefined / 未知键一律缺席；totalChapters 取 Math.max(0, Math.floor)，非有限数缺席。
 *  空串保留——「title 非空才加书」的分叉判别归调用方（shelfPut）。 */
export function pickShelfMeta(raw: Record<string, unknown>): ShelfMetaPatch {
  const out: Record<string, string | number> = {}
  for (const [k, kind] of Object.entries(SHELF_META)) {
    const v = raw[k]
    if (v === undefined || v === null) continue
    if (kind === 'string' && typeof v === 'string') out[k] = v
    else if (kind === 'number' && typeof v === 'number' && Number.isFinite(v)) out[k] = Math.max(0, Math.floor(v))
  }
  return out as ShelfMetaPatch
}

// ── 信封与错误 ──────────────────────────────────────────────────────────

/** 统一失败信封的 error 载荷（引擎错误带段级定位 segment） */
export interface ApiErrorBody {
  code: string
  message: string
  segment?: { facet: string; segmentIndex: number; segmentRaw: string }
}

/** 统一信封：成功 `{ ok: true, value }`；失败 `{ ok: false, error }` */
export interface ApiEnvelope<T> {
  ok: boolean
  value?: T
  error?: ApiErrorBody
}

// ── 路由（单一字面量来源）───────────────────────────────────────────────

/** /novel-api 前缀（双半代码级契约，一字不差） */
export const NOVEL_API_PREFIX = '/novel-api'

/** 路由段字面量：dispatch 的段匹配只准从这里取（client 不消费） */
export const SEG = {
  sources: 'sources',
  import: 'import',
  jobStatus: 'job-status',
  batchProbe: 'batch-probe',
  batchEnabled: 'batch-enabled',
  batchDelete: 'batch-delete',
  probe: 'probe',
  auth: 'auth',
  enabled: 'enabled',
  search: 'search',
  plan: 'plan',
  job: 'job',
  jobCancel: 'job-cancel',
  jobStream: 'job-stream',
  book: 'book',
  toc: 'toc',
  chapter: 'chapter',
  shelf: 'shelf',
  export: 'export',
  local: 'local',
} as const

/** 双形态路由：path（客户端 fetch 用）与 segs（服务端段匹配/一致性测试用），同一构造保证一致 */
export interface Route { path: string; segs: string[] }
export function route(...segs: string[]): Route { return { path: segs.join('/'), segs } }

/** 静态路由表（无参数的部分，共 21 条；另有 5 条参数路由见 paramRoutes）——
 *  路由总数由 tests/shared/wire-builders.test.ts 钉死（此前的「17 条路由」注释既烂又无测试）。 */
export const ROUTES = {
  health: route(),
  sources: route(SEG.sources),
  sourcesImport: route(SEG.sources, SEG.import),
  sourcesJobStatus: route(SEG.sources, SEG.jobStatus),
  sourcesBatchProbe: route(SEG.sources, SEG.batchProbe),
  sourcesBatchEnabled: route(SEG.sources, SEG.batchEnabled),
  sourcesBatchDelete: route(SEG.sources, SEG.batchDelete),
  search: route(SEG.search),
  /** 搜索参与计划：本次聚合搜索的真实参与者 ids——参与集的唯一主人在服务端，
   *  客户端不再为进度条自行重推导「哪些源参搜」（启停 invariant 单一定义） */
  searchPlan: route(SEG.search, SEG.plan),
  /** 聚合搜索后台任务：提交即由 Node 半跑完并持有结果（离开界面不影响它），读用 searchJobStatus，
   *  要「不等下一拍就看到」就用 searchJobStream（同一份快照的 SSE 推送，首帧是 baseline） */
  searchJob: route(SEG.search, SEG.job),
  searchJobStatus: route(SEG.search, SEG.jobStatus),
  searchJobStream: route(SEG.search, SEG.jobStream),
  /** 停止本轮聚合搜索：只停「还要去搜的源」，已搜出的命中一律保留（读面照旧可读） */
  searchJobCancel: route(SEG.search, SEG.jobCancel),
  book: route(SEG.book),
  toc: route(SEG.toc),
  chapter: route(SEG.chapter),
  shelf: route(SEG.shelf),
  /** 书架批量删除（多选）：body `{ keys: string[] }`（keys = bookKey，走 JSON body 故无需编码）；
   *  一趟删一批，替代客户端循环 N 次 DELETE shelf/:key——本地书连带删副本的 invariant 同单删一条 */
  shelfBatchDelete: route(SEG.shelf, SEG.batchDelete),
  exportBook: route(SEG.export),
  localImport: route(SEG.local, SEG.import),
  local: route(SEG.local),
} as const

/** 参数路由（客户端填参；服务端按 SEG 段位匹配）。id 为注册表 uuid（无需编码）；
 *  bookKey 是 URL / local:<uuid>，必须编码。 */
export const paramRoutes = {
  sourceProbe: (id: string): string => `${ROUTES.sources.path}/${id}/${SEG.probe}`,
  sourceEnabled: (id: string): string => `${ROUTES.sources.path}/${id}/${SEG.enabled}`,
  sourceAuth: (id: string): string => `${ROUTES.sources.path}/${id}/${SEG.auth}`,
  sourceDelete: (id: string): string => `${ROUTES.sources.path}/${id}`,
  shelfKey: (bookKey: string): string => `${ROUTES.shelf.path}/${encodeURIComponent(bookKey)}`,
} as const

// ── query 参数名与构造器 ───────────────────────────────────────────────
// 此前参数名散在 dispatch 与四个 client 文件里各写一份，改名无处编译报错；
// SearchView 曾手拼 `shelf/${...}` 绕过 paramRoutes（活漂移）。构造器把「参数名 + 字段取舍」
// 收进契约：client 半 inline 本文件，故保持零运行时依赖（下面全是纯函数/常量）。

/** query 参数名的唯一字面量来源：dispatch 的读取与构造器的写入同源 */
export const PARAMS = {
  sourceId: 'sourceId',
  url: 'url',
  index: 'index',
  keyword: 'keyword',
  sourceIds: 'sourceIds',
  name: 'name',
  id: 'id',
  title: 'title',
  refresh: 'refresh',
  /** 导出范围（1 基含端章号）：缺席 = 全本（向后兼容零参数旧链接） */
  from: 'from',
  to: 'to',
  /** 搜索任务快照的增量游标：只回 `groups[since..]`（完成序累积，见 SearchJobState） */
  since: 'since',
} as const

/** query 序列化：编码 + 去 undefined/null（null = 键缺席，与 wire 可空口径一致） */
export function encodeQuery(params: Record<string, string | number | boolean | null | undefined>): string {
  const parts: string[] = []
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
  }
  return parts.join('&')
}

/** book/toc/chapter/export 的共用入参（bookKey 在 wire 上叫 url——历史口径，别改名） */
export interface SourceUrlParams { sourceId: string; url: string }

/** `?since=` 的拼接单点（快照查询与 SSE 流共用同一游标口径） */
function withSince(path: string, since?: number): string {
  return `${path}${since === undefined ? '' : `?${encodeQuery({ [PARAMS.since]: since })}`}`
}

/** 带 query 的路径构造器（`path?query`，不含 /novel-api 前缀——前缀归 api.ts 单点） */
export const queries = {
  search: (p: { keyword: string; sourceIds?: string[] }): string =>
    `${ROUTES.search.path}?${encodeQuery({ [PARAMS.keyword]: p.keyword, [PARAMS.sourceIds]: p.sourceIds?.join(',') })}`,
  /** 搜索任务快照：`since` = 客户端已收到的组数（完成序累积），服务端只回 `groups[since..]`；
   *  缺省 = 全量（首帧/重连用，官方口径要求 stateful domain 必须有显式 query 兜底）。 */
  searchJobStatus: (since?: number): string => withSince(ROUTES.searchJobStatus.path, since),
  /** 搜索任务的 SSE 流（同一份快照的推送版）：`since` 是首帧的游标——首帧就是 baseline，
   *  断线重连后重新带上它即可补回错过的增量（官方明写 notification 不 replay）。 */
  searchJobStream: (since?: number): string => withSince(ROUTES.searchJobStream.path, since),
  book: (p: SourceUrlParams): string =>
    `${ROUTES.book.path}?${encodeQuery({ [PARAMS.sourceId]: p.sourceId, [PARAMS.url]: p.url })}`,
  toc: (p: SourceUrlParams & { refresh?: boolean }): string =>
    `${ROUTES.toc.path}?${encodeQuery({ [PARAMS.sourceId]: p.sourceId, [PARAMS.url]: p.url, [PARAMS.refresh]: p.refresh === true ? '1' : undefined })}`,
  chapter: (p: SourceUrlParams & { index: number; refresh?: boolean }): string =>
    `${ROUTES.chapter.path}?${encodeQuery({ [PARAMS.sourceId]: p.sourceId, [PARAMS.url]: p.url, [PARAMS.index]: p.index, [PARAMS.refresh]: p.refresh === true ? '1' : undefined })}`,
  exportBook: (p: SourceUrlParams & { title?: string; from?: number; to?: number }): string =>
    `${ROUTES.exportBook.path}?${encodeQuery({ [PARAMS.sourceId]: p.sourceId, [PARAMS.url]: p.url, [PARAMS.title]: p.title, [PARAMS.from]: p.from, [PARAMS.to]: p.to })}`,
  localImport: (p: { name: string }): string =>
    `${ROUTES.localImport.path}?${encodeQuery({ [PARAMS.name]: p.name })}`,
  localDelete: (p: { id: string }): string =>
    `${ROUTES.local.path}?${encodeQuery({ [PARAMS.id]: p.id })}`,
} as const

/**
 * `PUT shelf/:key` 的 body 构造器（三种形态）：
 * ① title 形态=加书（元数据字段带值才发——服务端 Shelf.add 已是 patch 语义，null/undefined 保值，
 *    构造器只做形状整理，不再是「防抹值」的唯一防线）；
 * ② progress 形态=更新进度（不在架 400，dispatch.shelfPut 单点判定）；
 * ③ patch 形态=对在架书打补丁（缺席键保值——ReaderView 回写 totalChapters 只发一个字段，
 *    不必再重发 sourceId+title）。
 */
export const shelfBody = {
  addBook: (b: {
    sourceId: string; title: string
    author?: string | null; coverUrl?: string | null; intro?: string | null
    lastChapterName?: string | null; totalChapters?: number | null
  }): { sourceId: string; title: string } & Record<string, string | number> => {
    // 字段取舍走 pickShelfMeta 单点：null/undefined 缺席、totalChapters 客户端即归一化；
    // sourceId/title 必填后写，保证取值恒为入参本值（pick 的运行时值无 null——断言只剥类型面的可空）
    const meta = pickShelfMeta(b) as Record<string, string | number>
    return { ...meta, sourceId: b.sourceId, title: b.title }
  },
  progress: (chapterIndex: number, offsetRatio: number): { progress: { chapterIndex: number; offsetRatio: number } } =>
    ({ progress: { chapterIndex, offsetRatio } }),
  /** patch 形态：字段缺省/null 一律不出现在 body（与服务端 Shelf.update 的保值语义双保险）。
   *  取舍同走 pickShelfMeta 单点 */
  patch: (p: ShelfMetaPatch): { patch: Record<string, string | number> } =>
    ({ patch: pickShelfMeta(p) as Record<string, string | number> }),
} as const
