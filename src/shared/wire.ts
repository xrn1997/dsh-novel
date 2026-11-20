/**
 * 跨半 wire 契约：
 * /novel-api 规范 JSON 的值形状、路由名、错误信封——Node 半与浏览器半之间的唯一真相。
 *
 * 两条硬约束（构建期事实，不是偏好）：
 *  ① tsdown 的 client 纯度门拦 Node 内建与平台模块表外的 @deepseek-ai/* 值 import——本文件
 *     两者都不涉及，且**禁引任何运行时依赖**（client 半会把整个文件 inline 进 bundle）；
 *  ② type-only 依赖可引（构建期擦除）。
 *
 * 可空口径：wire 上空值字段一律 `| null`，不写 `?:`（JSON 里 null 是在场的值）。
 * 时间戳/状态细节这类「可能整键缺席」的字段保持 `?:`，构造侧按需建键：`exactOptionalPropertyTypes`
 *  不收 `undefined` 占位，写 `k: undefined` 与不建这个键在类型面是两件事（档位与理由见 `ADR-0053`）。
 * 工具面（src/tools/）的缺键投影（lossless-JSON 约束）是其自身职责，与此口径不冲突。
 */

// ── 身份与状态枚举（sources.json 持久化与 wire 共用；services/types.ts 反向 re-export）────

/** 书源状态：未验证 / 探针通过 / 探针判坏 */
export type SourceStatus = 'unverified' | 'verified' | 'broken'

/** 书源内容形态（书源格式的 bookSourceType：0/-1/缺省=文本，**1=音频，2=图片，3=文件**）。
 *  `unknown` = **编码读不懂**（不是认得的整数值），不是第五种媒介而是「这本文源不规范」：
 *  读不懂不等于文本，一律不进参与集（按文本处理会让误标的短剧/漫画源混进聚合搜索）。
 *  它也不写 `status`：探针按搜索面重判，这类源的搜索面恰恰是好的，用状态承载会被下一次重验洗白。
 *  本插件当前只支持文本源：导入预检点名拒绝非文本与未知；参与集 = enabled ∧ type==='text'
 *  （判定单点在 services/participation.ts 的 participates 谓词）；存量误标由 SourceRegistry.load 按 raw 重推收敛。 */
export type SourceContentKind = 'text' | 'image' | 'audio' | 'file' | 'unknown'

/** 探针失败原因：引擎三类 + 抓取两类 + 规则缺失；'Error' 为兜底（出现即分类漏了） */
export type ProbeErrorCode =
  | 'UnsupportedRuleError' | 'RuleEvalError' | 'JsSandboxError'
  | 'FetchError' | 'DecodeError' | 'RuleMissing' | 'Error'

/** 本地书（TXT / EPUB 两支，按内容分流）的保留
 *  源 id——跨半契约常量的**唯一主人**：
 *  client 半与测试直接 import 本处；服务半（src/services/localbooks.ts）也 import 后 re-export，
 *  第二份声明因此不在服务半出现（服务半不受 client 纯度门禁约束，可直接引 shared）。改名只需改这一行。 */
export const LOCAL_SOURCE_ID = '__local__'

// ── 书源面 ──────────────────────────────────────────────────────────────

/** 书源对外投影（SourceRegistry.toPublic 产出）：绝不含 raw / rules / auth——
 *  凭据与原文只落盘，不出现在对外返回值。 */
export interface SourcePublic {
  id: string
  name: string
  baseUrl: string
  enabled: boolean
  /** 是否参与 AI 搜索工具的聚合搜索；与 `enabled` 正交（停用 ⇔ 两种搜索都不参与） */
  aiSearch: boolean
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
  /** 源是否声明了 loginUrl（派生自 `rules.loginUrl !== null`，与门面 `loginPlan` 同一判据）。
   *  给 UI 分支用：把「有没有」投影出来，UI 不必靠错误文案猜（服务端 400 是给 API 调用方的）。 */
  hasLoginUrl: boolean
  /** loginUi 里可渲染的行（text/password/button；@js: 与 webView 形态不投影，UI 回退 cookie 录入）。 */
  loginUi?: LoginUiField[]
}

export interface LoginUiText {
  /** 同时是 loginInfo 的键与界面标签（书源格式里 `loginUi` 每一行的 `name` 字段） */
  name: string
  type: 'text' | 'password'
  default?: string
}

export interface LoginUiButton {
  /** 按钮标签；动作由服务端按 `loginUi` 里同名的那一行查，客户端只回传名字、不持脚本 */
  name: string
  type: 'button'
}

export type LoginUiField = LoginUiText | LoginUiButton

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

/** 一条命中与本轮关键词的关系（判据的唯一实现见 `shared/relevance.ts`）。
 *  `suspect`＝不进默认视野的档、不删（不是「坏数据」也不是「已丢弃」）；空关键词时这一维不生效。
 *  「为什么折叠而不丢弃、空串为何不参与比较」的裁决只住 `ADR-0032`，这里不复述。 */
export type Relevance = 'exact' | 'contains' | 'suspect'

/** 搜索命中条目：可空即 `null`，不是缺键 */
export interface SearchHit {
  title: string
  author: string | null
  url: string | null
  coverUrl: string | null
  intro: string | null
  lastChapterName: string | null
  /** 分类（书源格式的 `ruleSearch.kind`）：原样字符串，不猜成数组 */
  kind: string | null
  /** 字数（书源格式的 `ruleSearch.wordCount`）：取到什么串就给什么，「x.x万字」那层格式化
   *  属 App 展示轴（矩阵 `e-word-count-format` 记不适用） */
  wordCount: string | null
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

/** 一本书在**一个源**上的那一条：字段取「这一家把它叫作什么」的原样，不归一、不投票。
 *  两边名字都看得见是既有口径（书籍详情浮层那条），归并只收成一行，不改写任何一家的写法。 */
export interface MergedSource {
  sourceId: string
  sourceName: string
  title: string
  author: string | null
  url: string | null
}

/** 按书视图的一行：同一 `(书名, 作者)` 规范化键下的若干条命中。
 *  它是**呈现层派生**，不落盘、不进 `SHELF_META`（架位口径住 `services/shelf.ts` 的 `Shelf`），
 *  「一本书挂多源并搬进度」另有一篇待裁的 ADR，别在这里提前把它焊进类型面。 */
export interface MergedBook {
  title: string
  author: string | null
  /** 只会是 `exact`/`contains`：suspect 不进归并（裁决见 `ADR-0033`） */
  relevance: 'exact' | 'contains'
  sources: MergedSource[]
  sourceCount: number
}

/** 按书默认视图的本数上限（超限那一行如实报总数——与每源命中截断同一族读数） */
export const SEARCH_BOOKS_CAP = 200

/** 聚合搜索后台任务的**读面快照**（跨半契约形状；服务端如何持有整轮结果属服务层，不上 wire）。
 *  为什么是「服务端持有 + 显式快照查询」：浏览器半自持在途循环会切走即丢结果；读面还须
 *  提供 baseline、cursor 或显式 query（SEG.jobStream 首帧 = 带 since 的 baseline 快照）
 *  ——`added`/`next` 就是那个 cursor。`phase` 与 `JobState` 同一套词汇：「还在跑吗」判据只此一种。 */
export interface SearchJobSnapshot {
  id: string
  keyword: string
  phase: 'running' | 'done' | 'failed'
  /** 用户主动「停止」（`phase='failed'` 而**不是失败**）：UI 据此不报红条，已搜出的命中保留。
   *  判据要上契约——靠 `error` 中文文案判是把 UI 语义寄在一条会变的字符串上。 */
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

/** 发现面的**按源**清单：每个「有分类入口」的源，连它自己声明的分类标题。
 *  **只给标题、不给入口地址**——两方言的地址语义不同（原生方言给的是填进源级模板 `{{kind}}` 的 slug，
 *  legado 方言的 `url` 本身就是那一类的完整模板），所以这份差异只住服务端一侧，不外泄到跨半契约。
 *  路由名仍是 `explore/kinds`：它给的就是分类入口清单，只是按源分组了。
 *  不做「跨源精确同名并集 + 每条计数」——那条轴会把左栏撑成各站自造词的长列表，
 *  且绝大多数词条只挂一个源，见 `ADR-0028`。
 *  源行上的 `groups` 与 `status` **只是展示标签与状态角标，不是浏览轴**：同一篇 ADR 刚把「分组→源
 *  两级」列为被否决做法，这一面逛的轴是「点名一个源」，不是「按分组逛」——别让这两个字段躺在
 *  契约里被读成分组又变回了一级轴。 */
export interface ExploreSources {
  sources: Array<{ id: string; name: string; groups: string[]; status: SourceStatus; kinds: string[] }>
}

/** 一本书：**某个源的某个分类下的一条**。浏览面不跨源——跨源聚合字段（来源清单、源计数）
 *  在单源形状下恒为「1 条 / 1 源」，是谎言字段，本形状不带它们。跨源视野由详情浮层那一次
 *  手动聚合搜索承担（主人 `client/search-job.ts`，不是这里）。
 *  `author` 为空的条目照旧合法（重名书大量存在，而**类型面与落盘这一侧从不按书名合并任何东西**——
 *  搜索面那一层按规范化 `(书名, 作者)` 归并的是呈现层投影，不落盘、不改这里的字段与架位，
 *  见 `MergedBook` 与 `ADR-0033`）。
 *  **与 `SearchHit` 同字段集而三处异名（`name`/`bookUrl`/`lastChapter`）是刻意的两份语义**：
 *  这一张是浏览轴上「一家给的一条」，那一张是聚合搜索里「多家撞来的命中」——把它们并成一张，
 *  「一条命中就是一本书」与「同一本在几个源上」这两种判断就会在类型面上重新长在一起。
 *  谁该转成谁有两处说得上，各管一面：浏览器半是详情浮层那两个映射器（`client/views/CityBookSheet.tsx`
 *  的 `ownRow` / `hitRow`），Node 半是快照写侧的投影（`services/explore-job.ts` 的 `booksOf`）。 */
export interface ExploreBook {
  name: string
  author: string | null
  /** 该源上的书地址；`null` = 这个源没给入口，读与架两个动作都不给按钮 */
  bookUrl: string | null
  coverUrl: string | null
  kind: string | null
  lastChapter: string | null
  intro: string | null
  wordCount: string | null
}

/** 单源分类轮次的读面快照。
 *  **仍是全量快照、仍整帧替换**：跨页累积住在服务端持有者（`services/explore-job.ts`），
 *  客户端不持有任何要跟着翻页对齐的东西。
 *  本形状不带 `total`/`done`/`failures`：`total` 在单源下恒为 1，是常数；`done`/`failures`
 *  是「一轮打多个源」的读数。单源的失败只有一条泳道，由 `error` 承载——**它不是 `phase` 的替身**：
 *  执行体从不抛错，抓取失败是以带 `error` 的组交回来的，所以「这一页没问到」必须落在 `error` 上，
 *  否则它会与「这一类真的没货」折成同一帧（写它的责任在 `services/explore-job.ts` 的 `absorb`）。 */
export interface ExploreSnapshot {
  id: string
  sourceId: string
  sourceName: string
  kind: string
  phase: 'running' | 'done' | 'failed'
  /** 这一轮被取消（`phase='failed'` 而非失败）：UI 据此不报红条。发现面只有宿主侧取消可达 */
  cancelled: boolean
  /** 这一轮**占到**第几页：第 1 页由提交带来，此后只有成功并入的那一页才占号——失败或被停止的一批
   *  不算，于是下一次续页打回的是同一页（写主 `services/explore-job.ts` 的 `Held.page`） */
  page: number
  /** 还能不能再点一次「加载更多」：**此刻**可以点——有一批在途时为 false（客户端显加载态用的是
   *  自己的 `round.running`，把在途那一段排除出去不丢信息）。于是服务端的 409 只剩一个意思。
   *  **它不是 `phase` 的另一半**：一页跑完就是 `done`，而 `hasMore` 只说「现在能不能点」。 */
  hasMore: boolean
  books: ExploreBook[]
  startedAt: number
  finishedAt?: number
  error?: string
}

/** 每源命中上限（后台搜索任务的持有截断；站点侧搜索面本就只取首页） */
export const SEARCH_HITS_CAP_PER_SOURCE = 50

/** 一轮搜索结果的保留期（结束后过此时点读作「无任务」，不伪装成「搜了没命中」） */
export const SEARCH_JOB_RETENTION_MS = 30 * 60 * 1000

export interface ChapterEntry {
  name: string; url: string
  isVip?: boolean; isVolume?: boolean; isPay?: boolean; updateTime?: string
}

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
  /** 与 SearchHit 同源的两个字段（详情规则缺席时回退搜索规则，与 name/author/coverUrl 同一条回落链） */
  kind: string | null
  wordCount: string | null
}

// ── 书架面 ──────────────────────────────────────────────────────────────

/** type 别名而非 interface：工具输出 schema 会把它推断进 Record<string, JsonValue>，
 *  interface 无隐式 index signature 会在这里炸——别改回 interface。 */
export type ShelfProgress = { chapterIndex: number; offsetRatio: number; updatedAt: number }

/** 按书听书位置（`ShelfBook.listen` 的值）：听书自己的细节轨——段号 + 播放参数。
 *  **章 + 章内比例**的共用位置住 `progress`：播放层在同一个落盘节拍里写两笔，书架卡片、
 *  最近阅读排序与开书恢复都只认 `progress`；`listen` 只服务听书的精确续听与按书记住的参数。
 *  `engineId` / `voice` 为 null = 这本书没显式选过，回退到全局缺省。
 *  type 别名而非 interface：理由同 `ShelfProgress`（schema 推断需要隐式 index signature）。 */
export type ListenState = {
  chapterIndex: number
  paragraphIndex: number
  engineId: string | null
  voice: string | null
  rate: number
  volume: number
}

/** 书架条目：元数据 + 阅读进度 + 按书听书位置 */
export interface ShelfBook {
  sourceId: string
  bookKey: string
  title: string
  author?: string
  coverUrl?: string
  intro?: string
  lastChapterName?: string
  kind?: string
  wordCount?: string
  /** 全书章数（可选——旧数据无此字段；首页进度条用） */
  totalChapters?: number
  progress: ShelfProgress
  /** 听书位置（可选——从未听过这本书）。系统状态字段，不是书目元数据：不进 `SHELF_META`。 */
  listen?: ListenState
  addedAt: number
}

/** 书目元数据字段集（唯一主人）：9 个元数据字段的「名称 × wire 类型判别」只准活在这张表 +
 *  pickShelfMeta 里。数值位的**落盘归一化**（非负整数）不在这里——它是落盘侧的口径，归
 *  `services/shelf.ts` 的 `Shelf.applyPatch`（客户端 body 只交形状，服务端唯一权威在落地前归一）。
 *  消费方三面：Shelf.applyPatch（保值覆盖遍历表）、`bodies.shelfAdd` / `bodies.shelfPatch`（客户端 body
 *  构造——只走 pick，不列字段位）、dispatch.shelfPut（未知 JSON body → 类型判别过的字段事实）。
 *  **加一个书目字段 = 改这张表**：客户端三个入架口交进来的是整条命中或一份 meta，不是逐字段的抄本，
 *  所以新字段不会「表里有、body 里没有」。
 *  bookKey（身份）/ progress、addedAt（系统字段）不属于元数据写口，不进表；
 *  来源投影（sourceName，见 ShelfEntry）也不进——它不可 patch、不落盘。 */
export const SHELF_META = {
  sourceId: 'string',
  title: 'string',
  author: 'string',
  coverUrl: 'string',
  intro: 'string',
  lastChapterName: 'string',
  kind: 'string',
  wordCount: 'string',
  totalChapters: 'number',
} as const

export type ShelfMetaField = keyof typeof SHELF_META

/** 书架**读取面**条目：落盘的 ShelfBook + 来源投影 sourceName。
 *  来源投影 = 服务端 list 时拿 sourceId join 出来的源名：源已删 → null（UI 灰字），本地书恒 null。
 *  它不是书目字段：不可 patch、绝不进 shelf.json——所以刻意不进 SHELF_META。加书那刻快照源名是
 *  **被否决的方案**：源改名 / 同址替换复用 id 后名字会陈旧。 */
export type ShelfEntry = ShelfBook & { sourceName: string | null }

/** 书目元数据 patch：null/undefined 键 = 保值（Shelf.update 的 interface 语义，见 shelf.ts） */
export type ShelfMetaPatch = { [K in ShelfMetaField]?: ShelfBook[K] | null }

/** 任意 JSON 值 → 合法元数据字段（**类型判别单点**）：
 *  类型不符 / null / undefined / 未知键一律缺席；数值位只过 `typeof === 'number' && Number.isFinite`
 *  （NaN / Infinity 缺席），**不夹紧**——数值归一化（非负整数）归 `services/shelf.ts` 的 `Shelf`。
 *  空串保留——「title 非空才加书」的形态分派归 `api/dispatch.ts` 的 shelfPut 臂。 */
export function pickShelfMeta(raw: Record<string, unknown>): ShelfMetaPatch {
  const out: Record<string, string | number> = {}
  for (const [k, kind] of Object.entries(SHELF_META)) {
    const v = raw[k]
    if (v === undefined || v === null) continue
    if (kind === 'string' && typeof v === 'string') out[k] = v
    else if (kind === 'number' && typeof v === 'number' && Number.isFinite(v)) out[k] = v
  }
  return out
}

// ── 听书面（朗读引擎订阅注册表；落盘 tts-engines.json）──────────────────────

/** 音色表的一行：`id` 是发得出去的音色身份（换引擎不通用），`name` 是上屏的显示名。
 *  订阅条携带、源能力带入；界面只认这条形状，别处不再各写一份 `{ id, name }`。 */
export interface TtsVoice {
  id: string
  name: string
}

/** 朗读引擎对外投影（`TtsEngineRegistry.list` 产出）：**绝不含 auth**——凭据只落盘，
 *  不出现在对外返回值，只给 `hasAuth` 一个布尔位（这一半与 `SourcePublic` 同口径）。
 *  `header` / `jsLib` 等文本位与书源相反、原样外发：它们是订阅本体的内容，编辑表单与导出
 *  都要回读（`SourcePublic` 那边只给 hasHeader 布尔位）。因此把密钥写在 `header` 里的订阅，
 *  投影与导出都带着它——本机读口，不是新的外泄面，但确实不是「剥凭据」。
 *  实体 `HttpTtsEngine`（落盘形状，含 auth）住 services/types.ts；两向相等由
 *  `services/tts-engines.ts` 的编译期断言钉住（wire 不能 type-import services，layering 门）。 */
export interface TtsEnginePublic {
  id: string
  name: string
  url: string
  contentType?: string
  /** 静态请求头（legado HttpTTS 的 `header` 字段）：订阅内容的一部分，随投影外发 */
  header?: string
  jsLib?: string
  /** 源声明的音色表（订阅数据或源能力带入；内置没有——端点不读音色参数）：
   *  在场 = 该源有可选音色列表，缺席 = 界面不渲染音色行。 */
  voices?: TtsVoice[]
  /** 最近一次变更时刻：由注册表在 put / 导入时盖章，不来自 wire */
  lastUpdateTime?: number
  hasAuth: boolean
}

/** 朗读引擎的写入口（put 的可编辑字段集）：id 不在其中——它是身份 / 路径参数，
 *  导入条自带的那一格由注册表收口（见 `TtsEngineRegistry.importJson`）。
 *  `auth` 是**只写凭据槽**（= SourceAuth 的 cookies/headers/loginInfo 三键）：投影永远读不回来。
 *  三态：缺席 = 保留盘上凭据（改元数据不该抹掉登录态）；非空 = 覆盖；显式空凭据（空 cookies
 *  且 headers / loginInfo 缺席或为空）= 删掉 auth。落位判据住 `services/tts-engines.ts` 的 `authOf`。 */
export interface TtsEngineInput {
  name: string
  url: string
  contentType?: string
  header?: string
  jsLib?: string
  auth?: { cookies: Record<string, string>; headers?: Record<string, string>; loginInfo?: Record<string, string> }
  /** 音色表是**订阅数据**：导入条携带、put 可整组替换。缺席 = 保留盘上那份（改名不该抹掉源声明的
   *  音色），显式数组（含空数组）= 整组替换 / 清掉——与 `auth` 的「缺席=保留」同族，
   *  区别于可编辑文本位的「整体替换」。 */
  voices?: TtsVoice[]
}

/** 朗读引擎可编辑的纯文本位：只收合成链**真的会读**的三格（contentType 参与响应判定，
 *  header / jsLib 参与请求求值）。legado HttpTTS 的其余字段（loginUrl / loginUi /
 *  loginCheckJs / concurrentRate / enabledCookieJar）本仓没有对应能力，不导入、不落盘、
 *  不摆不会生效的控件——「源没这条信息」比假开关诚实。 */
export const TTS_ENGINE_TEXT_FIELDS = [
  'contentType',
  'header',
  'jsLib',
] as const
export type TtsEngineTextField = (typeof TTS_ENGINE_TEXT_FIELDS)[number]

/** 引擎导入回执：added / updated 按 id 是否已在表里分；failed 是**逐条剪除**的留痕——
 *  index 是被剪条在导入 JSON 数组里的下标（单对象导入即 0），message 带段级定位。
 *  坏条只剪自己，其余照进（失败半径 = 该条）。 */
export interface TtsEngineImportReceipt {
  added: number
  updated: number
  failed: { index: number; message: string }[]
}

/** 删引擎回执：未知 id 静默 `removed:false`（与删源同口径，不把「没有这条」报成错误）。
 *  值形状住 wire：门面与浏览器半不各写一份 `{ removed: boolean }` 的手抄本。 */
export interface TtsEngineRemoveReceipt {
  removed: boolean
}

// ── 听书面（段合成与引擎源清单）──────────────────────────────────────────
// 一段正文 → 音频字节的合成请求/回执，与引擎源清单的行形状：路由面与浏览器播放层共用。
// 全部是类型（零运行时依赖）——wire 被 inline 进 client bundle。

/** 听书全局缺省的**唯一字面量主人**（跨半共享）：Node 半的配置表与 served 读数、浏览器半的
 *  播放层回退链都引这里。配置面只覆盖用户改过的值，播放器在「无显式、无本书存档」时落到这份
 *  缺省；两半各写一份 `'builtin:baidu'` 之类的字面量，改缺省就会只改到一边（见 `tests/config.test.ts`
 *  与 `tests/client/tts-player.test.ts` 的缺省对齐）。缓存容量缺省不在此列：它属于音频缓存，
 *  主人是 Node 半的 `tts-cache.ts`（浏览器半不直接持有容量）。 */
export const TTS_DEFAULTS = {
  engineId: 'builtin:baidu',
  rate: 1,
  volume: 0.8,
  prefetchParagraphs: 10,
} as const

/** 听书语速 / 音量的值域：`min`/`max` 由配置 schema、门面值域闸、播放层夹取与界面滑杆共读
 *  （两半各写一份 `[0.5, 3]` 就会在某一处改口径时静默漂移）。`step` 只服务**界面滑杆**的落点：
 *  配置页那两个文本位按「一位小数」档校验（0.1），不消费滑杆步长——两档别混成一份口径。 */
export const TTS_RATE = { min: 0.5, max: 3, step: 0.1 } as const
export const TTS_VOLUME = { min: 0, max: 1, step: 0.05 } as const

/** 浏览器直出源的**身份字面量主人**（跨半共享）：它不产字节、不经合成服务，Node 半只把这一行
 *  列进源清单，浏览器半据它切直出分支。身份是契约值，两半不各写一份字面量。 */
export const BROWSER_TTS_ENGINE_ID = 'browser:local'

/** 宿主语音服务源的**身份字面量主人**（跨半共享）：它不是注册表引擎，id 由合成面钉死。 */
export const CORDIS_TTS_ENGINE_ID = 'cordis:speechSynthesis'

/**
 * 朗读源的保留 id：`builtin:` 前缀（内置表）+ 上面两枚。合成面按这些身份分流，注册表只是
 * 订阅资产的住处——收下同名 id 就会在源清单里多出一行「此刻可用、每次合成必
 * `TTS_ENGINE_MISSING`」的幽灵源（清单承诺「列出的源都在此刻可用」），内置同名 id 还会让同一行
 * 出现两次。判据只住这一处：写入口（`put`）、导入（逐条剪除）与落盘读口共用它，浏览器半不再抄一份。
 */
export const TTS_RESERVED_ID_PREFIX = 'builtin:'

export function isReservedTtsEngineId(id: string): boolean {
  return id.startsWith(TTS_RESERVED_ID_PREFIX)
    || id === CORDIS_TTS_ENGINE_ID
    || id === BROWSER_TTS_ENGINE_ID
}

/** 一段合成的请求：`text` 是一个播放单元（切分归 shared/chapter-text 的 splitParagraphs），
 *  `rate` 是播放语速倍率；`voice` 缺省 = 该源不用音色（不是「用默认音色」这一档的替身——
 *  缺省音色由源自己决定，wire 不编一个音色 id）。 */
export interface SynthesisRequest {
  engineId: string
  text: string
  rate: number
  voice?: string
}

/** 合成回执：音频已落缓存，浏览器拿 `key` 去音频读口取字节。响应类型的事实来源是音频
 *  读口按缓存侧车报出的 content-type——回执不重复一份没有读者的副本。
 *  `playbackRate` = **拿到这段字节后，播放端还要乘的语速倍率**（1 = 引擎已按用户要的语速念过）。
 *  它是这条链唯一的诚实读数：用户滑杆上的倍率是「请求」，字节里掺了多少由引擎的能力决定——
 *  服务端念不到的那一截必须由播放端补，否则屏上写着 1.5x、耳朵里是 1.0x。
 *  值随字节一起进缓存侧车：命中路径不许拿「此刻的引擎能力」重算（引擎换了口径，旧字节仍是旧那份）。 */
export interface SynthesisReceipt {
  key: string
  playbackRate: number
}

/** 宿主朗读服务此刻的健康读数——专为「这一行为什么不在清单里」而设：源清单只列可用源，
 *  缺席与不可用因此在清单里是同一个空，而管理面要把两者分开摆（未安装 / 未就绪是两件事，
 *  修法完全不同）。`reason` 是服务方给的稳定原因码，原样带过不翻译也不编造。 */
export type HostSpeechHealth =
  | { state: 'absent' }
  | { state: 'not-ready'; reason?: string }
  | { state: 'ready' }

/** 源清单那一条路由的完整值：清单 + 宿主服务健康。同一份能力读数算出来，不分两次问——
 *  两次快照之间引擎换了口径，清单与健康就会各说一套。 */
export interface TtsSourcesView {
  sources: TtsSourceInfo[]
  hostSpeech: HostSpeechHealth
}

/** 引擎源清单的一行（`TtsService.sources` 产出）。清单只列**此刻可用**的源：不可用/缺席
 *  的源不出现在清单里，而不是灰着造禁用态（客户端给「宿主服务未安装」补的那一行是本地
 *  展示，不属于本契约）。
 *  `name` 只属于订阅数据：`kind: 'http'`（注册表订阅引擎）带订阅自己的名字，它是权威展示名；
 *  内置 / cordis / 浏览器是插件自有源，服务端不投展示名（`name` 缺席），浏览器半按 `kind` / `id`
 *  从客户端文案单点取词——插件写的标签不落服务端，否则英文 locale 会露出中文。
 *  `voices` 缺席 = 该源没有音色列表（UI 不渲染音色行）。源清单只在有表时带这一格：生产侧没有
 *  「有能力但零音色」的来路（注册表把空表与缺席同义折叠），空数组不是这份契约的第二档。
 *  源的能力限制由客户端文案按 `kind` 取词（如直出型没有缓存与预取），服务端不投自由文本说明。 */
export interface TtsSourceInfo {
  id: string
  name?: string
  kind: 'builtin' | 'http' | 'cordis' | 'browser'
  voices?: TtsVoice[]
}

// ── 本地图文面（EPUB 导入；身份锚在保留源 id LOCAL_SOURCE_ID）──────────────────────
// 图文正文、目录导航与导入回执的唯一跨半形状：Node 半（导入/读取）与浏览器半（阅读器/书架）
// 消费同一份，别处不得私造平行版本。

/** 图文树的元素白名单（唯一字面量来源）：原书的 b/i 与结构容器在导入期已规范为
 *  strong/em/div——客户端按白名单映射，认不出的标签在导入期就已被拒绝或降级，不在这里兜底 */
export type ContentTag =
  | 'p' | 'div' | 'span' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
  | 'strong' | 'em' | 'ul' | 'ol' | 'li' | 'blockquote' | 'pre' | 'code'
  | 'sup' | 'sub' | 'table' | 'caption' | 'thead' | 'tbody' | 'tfoot'
  | 'tr' | 'th' | 'td'

/** 阅读目标：主序列章（章号 + 可空章内锚点）或补充文档（文档 ID + 可空锚点）。
 *  为什么分成两支而不是「章号可空 + 文档 ID 可空」：补充文档（脚注/附录）不在阅读流里、
 *  不计正文章数，是可打开但不参与连续阅读的另一类东西；合成一支会把「书里第几章」
 *  变成到处可空推断的字段。锚点 null = 该目标指向整章/整份文档。 */
export type ReadingTarget =
  | { kind: 'chapter'; index: number; anchorId: string | null }
  | { kind: 'supplement'; documentId: string; anchorId: string | null }

/** 补充文档目标（supplement 分支）：注释面板与阅读场景共用的窄类型。
 *  主序列目标在类型上就进不来——面板只认补充文档。 */
export type SupplementTarget = Extract<ReadingTarget, { kind: 'supplement' }>

/** 图文节点：六类，带稳定节点 ID 的是白名单元素、图片、链接、换行与分隔线。
 *  **不携带任意属性字典**——只按种类保留明确字段：`start` 只对 ol 生效、`value` 只对 li、
 *  `rowSpan`/`colSpan` 只对单元格，其余位置恒 `null`（null = 无该属性，不输出 DOM 属性）。
 *  不设通用 attributes 袋是安全边界：原书未净化属性一旦上 wire 就有被客户端展开进 DOM 的机会。
 *  `id` 是导入期生成的 opaque 稳定串，不是原书 ID（原锚点另经映射表转成本仓 ID）。 */
/** 内部链接角色（normal 交叉引用 / noteref 脚注引用 / backlink 返回链接）。
 *  刻意**具名**而不是把字面量埋在 link 变体里：铸造方（EPUB 文档层按 `epub:type` 判）与消费方
 *  （阅读会话 / 视图）都要引它——两处各抄一份字面量，加一个角色时就只改到一边，另一边静默窄化。 */
export type LinkRole = 'normal' | 'noteref' | 'backlink'

export type ContentNode =
  | { kind: 'text'; text: string }
  | {
      kind: 'element'; id: string; tag: ContentTag; children: ContentNode[]
      rowSpan: number | null; colSpan: number | null; start: number | null; value: number | null
    }
  | { kind: 'image'; id: string; resourceId: string; alt: string; width: number; height: number }
  | {
      kind: 'link'; id: string; target: ReadingTarget
      role: LinkRole; children: ContentNode[]
    }
  | { kind: 'break'; id: string }
  | { kind: 'rule'; id: string }

/** 章节正文：文字面是纯文本章（TXT / 在线书 / 存量缓存），图文面是导入期规范化后的树。
 *  两形态不做自动猜测，由来源与服务层显式决定，客户端按 kind 分支。
 *  rich **不另存一份文字**：文字面是 `chapterContentToText` 的投影，第二份文本字段一旦落盘
 *  就会与树分叉（同一本书导出、AI 工具与阅读器读到不同正文）。 */
export type ChapterContent =
  | { kind: 'text'; text: string }
  | { kind: 'rich'; documentId: string; nodes: ContentNode[] }

/** 目录条目：`target` 为 null **只**用于有子节点的分组标题（例如只有卷名的卷）。
 *  叶条目指向「阅读单元 + 文档内锚点」——EPUB 目录条目数可多于阅读单元数，
 *  同一 XHTML 的多个锚点是各自跳转的条目，不复制成多章。 */
export interface NavigationItem {
  id: string
  label: string
  target: ReadingTarget | null
  children: NavigationItem[]
}

/** 目录读面两列表：`chapters` 是线性阅读序列（原有 toc 口径，进度/逐章 API/导出范围按它），
 *  `items` 是展示用树。两者不是一一对应（见 NavigationItem）——界面与导入说明都不得
 *  宣称目录叶条数与章数相等。 */
export interface BookNavigation {
  chapters: ChapterEntry[]
  items: NavigationItem[]
}

/** 线性目录 → 平面导航树（**唯一实现**）：没有原生目录的书（本地 TXT、在线源）由线性序列派生，
 *  逐章一个叶、无分组层级。`id` 是稳定 opaque 串（`t<章号>`），客户端只当列表 key 用；
 *  有原生目录的书（EPUB）不走这里——它的树是导入期从 nav/NCX 建出来并持久化的。 */
export function planarNavigation(chapters: ChapterEntry[]): NavigationItem[] {
  return chapters.map((c, i) => ({
    id: `t${i}`,
    label: c.name,
    target: { kind: 'chapter', index: i, anchorId: null },
    children: [],
  }))
}

/** 导入告警：`resource` 是书内逻辑名（离书即无意义），不含主机绝对路径与磁盘布局 */
export interface LocalImportWarning {
  code: string
  message: string
  resource: string | null
}

/** 本地导入回执：`ShelfBook` + 章数/格式/编码/告警。
 *  `encoding` 为 null = 不适用（EPUB 各文档可能各自编码，不伪称整本 UTF-8）。 */
export type LocalImportResponse = ShelfBook & {
  chapterCount: number
  format: 'txt' | 'epub'
  encoding: string | null
  warnings: LocalImportWarning[]
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
  /** AI 搜索属主的批量写口（与启停批量分开：两件事各有自己的 body 字段与回执） */
  batchAiSearch: 'batch-ai-search',
  batchDelete: 'batch-delete',
  probe: 'probe',
  auth: 'auth',
  enabled: 'enabled',
  aiSearch: 'ai-search',
  search: 'search',
  plan: 'plan',
  job: 'job',
  jobCancel: 'job-cancel',
  jobStream: 'job-stream',
  /** 发现面（各源声明的分类入口，两方言都认）：按源的入口清单 / 分类书单 / 分类轮次的任务读面 */
  explore: 'explore',
  kinds: 'kinds',
  list: 'list',
  /** 续页端（`explore/list/more`）：`explore/list` 已经是「提交新一轮」的写口，
   *  续页要有自己的一段才不与它同形、同形即歧义 */
  more: 'more',
  book: 'book',
  toc: 'toc',
  chapter: 'chapter',
  /** 目录导航读面（`chapters` 线性 + `items` 展示树）——与 toc 分开：toc 的响应形状原地不动、不受这一端影响 */
  navigation: 'navigation',
  shelf: 'shelf',
  export: 'export',
  local: 'local',
  /** 本地 EPUB 的三条读口（都带 `id=bookKey`）：补充文档 / 资源流 / 导入说明 */
  document: 'document',
  resource: 'resource',
  warnings: 'warnings',
  /** 听书面：源清单 / 段合成 / 引擎订阅（导入与按 id 的写口）/ 音频读口 */
  tts: 'tts',
  synthesize: 'synthesize',
  engines: 'engines',
  audio: 'audio',
} as const

/** HTTP 方法：路由身份的第二条腿。与 path 同源，别再散到 dispatch 与客户端调用点两处。 */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE'
/** 写方法：写口只接受这三种；GET 只能走 apiGet / SSE，类型面直接挡住。 */
export type WriteMethod = Exclude<HttpMethod, 'GET'>

/** 路由身份：方法与路径绑成一个目标。写口只收这一份，不再让调用方分别传 method 与 path
 *  （两参形式允许配错，且会让每个路由点各自重述一遍路径与参数的身份）。路径/参数的匹配机械
 *  归 `src/api/routes.ts` 的 `matchRoute`，方法不符的 405 由 `api/dispatch.ts` 的
 *  `methodMismatchError` 单点承接——两边都不逐路由重述。 */
export interface RouteTarget<M extends HttpMethod = HttpMethod> { method: M; path: string }
/** 双形态路由：`path` 是 `segs` 的 join 投影——api 侧匹配器收**请求**切出的段（同为 segs 形态），
 *  join 后拿这份 `path` 当等值比对的键；表里那份 `segs` 不进匹配（消费者只有结构自洽校验），
 *  把它当第二份权威是错的。method（写路由的身份）用字面量泛型保留：写口拿 `ROUTES.x` 时
 *  tsc 能挡住「把 GET 路由交给 apiSend」。 */
export interface Route<M extends HttpMethod = HttpMethod> extends RouteTarget<M> { segs: string[] }
export function route<M extends HttpMethod>(method: M, ...segs: string[]): Route<M> {
  return { method, path: segs.join('/'), segs }
}

/** 静态路由表（无参数的部分；参数操作见 paramOps）——路由总数由
 *  tests/shared/wire-builders.test.ts 钉死，不要在这里手写一个会腐烂的计数。
 *  方法随行：客户端写口取 `ROUTES.x.method`，api 侧匹配器 `matchRoute` 读同一份。 */
export const ROUTES = {
  health: route('GET'),
  sources: route('GET', SEG.sources),
  sourcesImport: route('POST', SEG.sources, SEG.import),
  sourcesJobStatus: route('GET', SEG.sources, SEG.jobStatus),
  sourcesBatchProbe: route('POST', SEG.sources, SEG.batchProbe),
  sourcesBatchEnabled: route('POST', SEG.sources, SEG.batchEnabled),
  /** AI 搜索属主的批量写口：`{ ids, aiSearch }` */
  sourcesBatchAiSearch: route('POST', SEG.sources, SEG.batchAiSearch),
  sourcesBatchDelete: route('POST', SEG.sources, SEG.batchDelete),
  search: route('GET', SEG.search),
  /** 搜索参与计划：本次聚合搜索的真实参与者 ids——参与集的唯一主人在服务端，
   *  客户端不再为进度条自行重推导「哪些源参搜」（启停 invariant 单一定义） */
  searchPlan: route('GET', SEG.search, SEG.plan),
  /** 聚合搜索后台任务：提交即由 Node 半跑完并持有结果（离开界面不影响它），读用 searchJobStatus，
   *  要「不等下一拍就看到」就用 searchJobStream（同一份快照的 SSE 推送，首帧是 baseline） */
  searchJob: route('POST', SEG.search, SEG.job),
  searchJobStatus: route('GET', SEG.search, SEG.jobStatus),
  searchJobStream: route('GET', SEG.search, SEG.jobStream),
  /** 停止本轮聚合搜索：只停「还要去搜的源」，已搜出的命中一律保留（读面照旧可读） */
  searchJobCancel: route('POST', SEG.search, SEG.jobCancel),
  /** 按源列出的分类入口清单（本地派生，零网络请求，只出标题） */
  exploreKinds: route('GET', SEG.explore, SEG.kinds),
  /** 提交一轮分类抓取 */
  exploreList: route('POST', SEG.explore, SEG.list),
  /** 续页：把**当前这一轮**再打一页（同一轮 id，客户端整帧替换的读模型不因此换脸）；
   *  没有源还能再要一页时回 409——「加载更多」钮据此收掉，而不是假装又开了一轮 */
  exploreListMore: route('POST', SEG.explore, SEG.list, SEG.more),
  /** 分类轮次的全量快照（无游标——快照形状见 ExploreSnapshot 的注释） */
  exploreListStatus: route('GET', SEG.explore, SEG.list, SEG.jobStatus),
  /** 分类轮次的状态信号流（SSE，每帧一份全量快照） */
  exploreListStream: route('GET', SEG.explore, SEG.list, SEG.jobStream),
  book: route('GET', SEG.book),
  toc: route('GET', SEG.toc),
  chapter: route('GET', SEG.chapter),
  /** 目录导航：`chapters` 线性（与 toc 响应同形）+ `items` 展示树（EPUB 原生 nav/NCX，
   *  其他书由 toc 派生）——沿用 toc 的 sourceId+url 入参 */
  navigation: route('GET', SEG.navigation),
  shelf: route('GET', SEG.shelf),
  /** 书架批量删除（多选）：body `{ keys: string[] }`（keys = bookKey，走 JSON body 故无需编码）；
   *  一趟删一批，替代客户端循环 N 次 DELETE shelf/:key——本地书连带删副本的 invariant 同单删一条 */
  shelfBatchDelete: route('POST', SEG.shelf, SEG.batchDelete),
  exportBook: route('GET', SEG.export),
  localImport: route('POST', SEG.local, SEG.import),
  local: route('DELETE', SEG.local),
  /** 补充文档（脚注/附录）的图文正文：`id=bookKey` + `documentId` */
  localDocument: route('GET', SEG.local, SEG.document),
  /** 本地资源（插图/封面）：`id=bookKey` + `resourceId`；只认不透明 ID，不接收路径 */
  localResource: route('GET', SEG.local, SEG.resource),
  /** 导入说明（告警）：`id=bookKey`——按需查看，不随每次取章重复携带 */
  localWarnings: route('GET', SEG.local, SEG.warnings),
  // ── 听书面 ──────────────────────────────────────────────────────────
  /** 引擎源清单（内置 / 浏览器直出 / 注册表订阅 / cordis 仅在场）：播放器的引擎选择面。
   *  行形状是 `TtsSourceInfo`（`services/tts.ts` 的 `sources()`），不是引擎实体的投影。 */
  ttsSources: route('GET', SEG.tts, SEG.sources),
  /** 段合成：回执带缓存键（`SynthesisReceipt`），字节另走 ttsAudio 读口 */
  ttsSynthesize: route('POST', SEG.tts, SEG.synthesize),
  /** 引擎订阅清单（管理面）：公共投影已剥凭据——导出 JSON 由 client 用这份数据自组，
   *  **不设后端导出路由**（导出是呈现动作，不是新事实）。 */
  ttsEngines: route('GET', SEG.tts, SEG.engines),
  /** 引擎订阅导入：body 恰带 `json` 或 `url` 之一（url 支经组合根同一 fetcher 拉取） */
  ttsEnginesImport: route('POST', SEG.tts, SEG.engines, SEG.import),
  /** 音频读口：query 键 `key`（照 localResource 的 query 先例——key 是 32 位 hex，不走路径段）。
   *  未知/过期 key 在发头前 404，不是空音频。 */
  ttsAudio: route('GET', SEG.tts, SEG.audio),
} as const

/** 参数操作：方法与路径构造同住一行。`at(...)` 把两者绑成一个目标，客户端写口不再手写方法。
 *  id 为注册表 uuid（无需编码）；bookKey 是 URL / local:<uuid>，必须编码。 */
export interface ParamOperation<A extends unknown[], M extends WriteMethod = WriteMethod> {
  readonly method: M
  path(...args: A): string
  at(...args: A): RouteTarget<M>
}

function paramOp<M extends WriteMethod, A extends unknown[]>(
  method: M, path: (...args: A) => string,
): ParamOperation<A, M> {
  return { method, path, at: (...args) => ({ method, path: path(...args) }) }
}

const shelfKeyPath = (bookKey: string): string => `${ROUTES.shelf.path}/${encodeURIComponent(bookKey)}`

/** 引擎 id 含 `:`（`http:<uuid>`），进路径段必须编码——与 `shelfKeyPath` 同口径。
 *  静态 `tts/engines/import` 先于本模式匹配（`matchRoute` 判据③），故导入不会被读成「改/删一条引擎」。 */
const ttsEnginePath = (id: string): string =>
  `${ROUTES.ttsEngines.path}/${encodeURIComponent(id)}`

export const paramOps = {
  sourceProbe: paramOp('POST', (id: string) => `${ROUTES.sources.path}/${id}/${SEG.probe}`),
  sourceEnabled: paramOp('POST', (id: string) => `${ROUTES.sources.path}/${id}/${SEG.enabled}`),
  sourceAiSearch: paramOp('POST', (id: string) => `${ROUTES.sources.path}/${id}/${SEG.aiSearch}`),
  sourceAuth: paramOp('POST', (id: string) => `${ROUTES.sources.path}/${id}/${SEG.auth}`),
  sourceDelete: paramOp('DELETE', (id: string) => `${ROUTES.sources.path}/${id}`),
  shelfPut: paramOp('PUT', shelfKeyPath),
  shelfDelete: paramOp('DELETE', shelfKeyPath),
  /** 朗读引擎的新增/更新（PUT，id 是身份）与删除（未知 id 静默 removed:false） */
  ttsEnginePut: paramOp('PUT', ttsEnginePath),
  ttsEngineDelete: paramOp('DELETE', ttsEnginePath),
} as const

// ── query 参数名与构造器 ───────────────────────────────────────────────
// 参数名若散在 dispatch 与四个 client 文件里各写一份，改名无处编译报错；
// 不要手拼 `shelf/${...}` 绕过 paramOps（会活漂移）。构造器把「参数名 + 字段取舍」
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
  /** 本地三种读口（document/resource/warnings）在 query 里带的第二个参数——`id` 一律是 bookKey
   *  （与既有 `DELETE local?id=` 同参数名；本地读口不用路径段，bookKey 里的 `:`/`/` 不必编码成段） */
  documentId: 'documentId',
  resourceId: 'resourceId',
  /** 分类名（发现面：左栏选中项，精确同名匹配） */
  kind: 'kind',
  /** 合成音频读口的缓存键（合成回执的 `key`；32 位 hex，照本地读口用 query 不走路径段） */
  key: 'key',
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

/** book/toc/chapter/export 的共用入参（bookKey 在 wire 上叫 `url`——它是对外契约的 query 键名，
 *  别为对齐本地叫法去改它） */
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
  /** 目录导航树：与 toc 同一入参（sourceId+url）——本地书与在线书同一构造器 */
  navigation: (p: SourceUrlParams): string =>
    `${ROUTES.navigation.path}?${encodeQuery({ [PARAMS.sourceId]: p.sourceId, [PARAMS.url]: p.url })}`,
  exportBook: (p: SourceUrlParams & { title?: string; from?: number; to?: number }): string =>
    `${ROUTES.exportBook.path}?${encodeQuery({ [PARAMS.sourceId]: p.sourceId, [PARAMS.url]: p.url, [PARAMS.title]: p.title, [PARAMS.from]: p.from, [PARAMS.to]: p.to })}`,
  localImport: (p: { name: string }): string =>
    `${ROUTES.localImport.path}?${encodeQuery({ [PARAMS.name]: p.name })}`,
  localDelete: (p: { id: string }): string =>
    `${ROUTES.local.path}?${encodeQuery({ [PARAMS.id]: p.id })}`,
  /** 本地三条读口：`id` 一律是 bookKey（本地书身份），第二个参数各自归 PARAMS 单点 */
  localDocument: (p: { id: string; documentId: string }): string =>
    `${ROUTES.localDocument.path}?${encodeQuery({ [PARAMS.id]: p.id, [PARAMS.documentId]: p.documentId })}`,
  localResource: (p: { id: string; resourceId: string }): string =>
    `${ROUTES.localResource.path}?${encodeQuery({ [PARAMS.id]: p.id, [PARAMS.resourceId]: p.resourceId })}`,
  localWarnings: (p: { id: string }): string =>
    `${ROUTES.localWarnings.path}?${encodeQuery({ [PARAMS.id]: p.id })}`,
  /** 合成音频读口：`key` 是合成回执里那枚缓存键（不透明串，编码后当查询参数） */
  ttsAudio: (p: { key: string }): string =>
    `${ROUTES.ttsAudio.path}?${encodeQuery({ [PARAMS.key]: p.key })}`,
} as const

/**
 * 本地资源（插图 / 封面）的**唯一 URL 构造器**：`/novel-api` 前缀 + 资源读口的路径与 query。
 * 服务端（导入回执的封面 URL）与客户端（正文插图 src）都必须走这里——各拼一份，前缀或参数名
 * 一改就分叉。`resourceId` 是不透明 ID，经 `encodeQuery` 编码后当查询参数：书内字符串拼不出
 * 第二个参数、也换不来协议（与「资源 ID 不进磁盘路径」同一条安全面）。
 */
export function resourceUrl(bookKey: string, resourceId: string): string {
  return `${NOVEL_API_PREFIX}/${queries.localResource({ id: bookKey, resourceId })}`
}

/**
 * 合成音频的**唯一 URL 构造器**：`/novel-api` 前缀 + 音频读口的路径与 query（与 `resourceUrl`
 * 同形——一个给 `<img src>`、一个给 `audio.src`，两半都不手拼前缀）。`key` 是合成回执里的不透明
 * 缓存键，经 `encodeQuery` 编码后当查询参数：拼不出第二个参数、也换不来协议（与本地资源同一安全面）。
 */
export function ttsAudioUrl(key: string): string {
  return `${NOVEL_API_PREFIX}/${queries.ttsAudio({ key })}`
}

// ── 写路由的 body：字段名、构造器、读口同源 ────────────────────────────
// 所有写路由的键名都必须有主人：若浏览器半手写、Node 半逐一手读，改名不会有什么变红——
// 「wire 单点」这条硬约束承诺的正是 body 构造器与读口成对。两者同住这里，因为答的是同一件事
// （「这个 body 该长什么样」），分家就会立刻生成两份抄本。
// 本文件被 inline 进 client bundle，故以下全部零运行时依赖（纯函数 + 本地错误类）。

/** 引擎文本位的 body 键名（值 = 键名本身）：与 `TTS_ENGINE_TEXT_FIELDS` 同源，不另抄七行。 */
const TTS_ENGINE_TEXT_BODY = Object.fromEntries(
  TTS_ENGINE_TEXT_FIELDS.map((field) => [field, field] as const),
) as { readonly [K in TtsEngineTextField]: K }

/** body 字段名（只列 query 那侧没有的词）。与 `PARAMS` 撞上的业务名词（`keyword` / `sourceIds` /
 *  `sourceId` / `kind` / `name` / `title`）**沿用 `PARAMS`**，不在这里再造第二个字面量：body 与
 *  query 是两条轴，同一个业务名词在两轴上同名是语义一致，不是巧合。 */
export const BODY = {
  ...TTS_ENGINE_TEXT_BODY,
  files: 'files',
  text: 'text',
  ids: 'ids',
  keys: 'keys',
  enabled: 'enabled',
  aiSearch: 'aiSearch',
  patch: 'patch',
  progress: 'progress',
  chapterIndex: 'chapterIndex',
  offsetRatio: 'offsetRatio',
  /** 听书细节轨（`ShelfBook.listen` 的写口）：段号 + 播放参数；章 + 比例的共用位置不在这里 */
  listen: 'listen',
  paragraphIndex: 'paragraphIndex',
  engineId: 'engineId',
  voice: 'voice',
  rate: 'rate',
  volume: 'volume',
  runLogin: 'runLogin',
  loginAction: 'loginAction',
  cookies: 'cookies',
  headers: 'headers',
  loginInfo: 'loginInfo',
  /** 引擎订阅导入的两条来路（恰一）：粘贴的 JSON 文本 / 拉取订阅的 URL。
   *  URL 这一位沿用 `PARAMS.url`（同一业务名词不造第二个字面量）。 */
  json: 'json',
  /** 引擎音色表（订阅数据）：put 可整组替换，缺席 = 保留盘上那份 */
  voices: 'voices',
  /** 只写凭据槽（`TtsEngineInput.auth` = cookies/headers/loginInfo 三键）：投影永远读不回来 */
  auth: 'auth',
} as const

/** body 形状不符（缺字段、类型错、空数组）。消息文本就是给终端用户看的那句 400 说明——
 *  「路由自检错误」这一类，由 `api/dispatch.ts` 落成 `ApiError(…, 400, 'BadRequest')`：
 *  判据住这里，状态码归传输层（口径两分法见 `ADR-0016`）。 */
export class BodyShapeError extends Error {}

function bodyBad(message: string): never {
  throw new BodyShapeError(message)
}

/** 非空 string[] 的读法（批路由共用一条尺；字段名只进消息不进判据） */
function readIdList(body: Record<string, unknown> | null, field: string): string[] {
  const v = body?.[field]
  if (!Array.isArray(v) || v.length === 0 || !v.every((x) => typeof x === 'string')) {
    bodyBad(`body 需为非空 { ${field}: string[] }`)
  }
  return v
}

/** 必填串位（去空白后非空才算在场）：缺席/非串/全空白同值 → 点名缺哪个字段 */
function readRequiredText(body: Record<string, unknown> | null, field: string): string {
  const v = body?.[field]
  const t = typeof v === 'string' ? v.trim() : ''
  if (t === '') bodyBad(`缺 body 字段 ${field}`)
  return t
}

/** 可选串位：缺席原样缺席（不补空串——wire 可空口径里「没有这一项」不是 `''`）；
 *  在场但不是串 → 400 点名。返回原值不 trim（读口只判形状，规整归消费方）。 */
function readOptionalText(body: Record<string, unknown> | null, field: string): string | undefined {
  const v = body?.[field]
  if (v === undefined) return undefined
  if (typeof v !== 'string') bodyBad(`body.${field} 需为 string`)
  return v
}

/** 一条导入文件：`name` = 上传文件的名字（粘贴那一路给一个标签），坏文件由导入任务在 `fileErrors`
 *  里点名它；`text` = 该文件的原文，解析归服务端 */
export interface ImportFileBody { name: string; text: string }

/** 写路由 body 的构造器（浏览器半唯一出口）与读口（Node 半唯一入口）。
 *  **成对读**：每个 shape 一条 `bodies.x` 与一条 `readBodies.x`，`readBodies.x(bodies.x(v))`
 *  必须原样给回 `v`（`tests/shared/wire-builders.test.ts` 逐条钉这一条）——这条 round-trip 就是
 *  「两半各写一遍键名迟早分叉」的闸。 */
export const bodies = {
  import: (files: ImportFileBody[]): Record<string, unknown> => ({ [BODY.files]: files }),
  ids: (ids: string[]): Record<string, unknown> => ({ [BODY.ids]: ids }),
  keys: (keys: string[]): Record<string, unknown> => ({ [BODY.keys]: keys }),
  enabled: (enabled: boolean): Record<string, unknown> => ({ [BODY.enabled]: enabled }),
  aiSearch: (aiSearch: boolean): Record<string, unknown> => ({ [BODY.aiSearch]: aiSearch }),
  batchEnabled: (ids: string[], enabled: boolean): Record<string, unknown> =>
    ({ [BODY.ids]: ids, [BODY.enabled]: enabled }),
  batchAiSearch: (ids: string[], aiSearch: boolean): Record<string, unknown> =>
    ({ [BODY.ids]: ids, [BODY.aiSearch]: aiSearch }),
  searchJob: (keyword: string, sourceIds?: string[]): Record<string, unknown> =>
    ({ [PARAMS.keyword]: keyword, ...(sourceIds === undefined ? {} : { [PARAMS.sourceIds]: sourceIds }) }),
  exploreList: (sourceId: string, kind: string): Record<string, unknown> =>
    ({ [PARAMS.sourceId]: sourceId, [PARAMS.kind]: kind }),
  runLogin: (): Record<string, unknown> => ({ [BODY.runLogin]: true }),
  loginAction: (name: string): Record<string, unknown> => ({ [BODY.loginAction]: name }),
  authCookies: (
    cookies: Record<string, string>,
    headers?: Record<string, string>,
    loginInfo?: Record<string, string>,
  ): Record<string, unknown> => ({
    [BODY.cookies]: cookies,
    ...(headers === undefined ? {} : { [BODY.headers]: headers }),
    ...(loginInfo === undefined ? {} : { [BODY.loginInfo]: loginInfo }),
  }),
  authLoginInfo: (loginInfo: Record<string, string>): Record<string, unknown> =>
    ({ [BODY.loginInfo]: loginInfo }),
  /** ① title 形态=加书。**字段集只由 `SHELF_META` 决定**：这里不再逐字段列一遍可选位，
   *  调用方把手上那条命中（`SearchHit`、浮层行）连同 `sourceId` 交进来即可——认不出的键
   *  （`url` / `sourceName` / 浮层补的 `listed`）由 `pickShelfMeta` 整键丢，命中里没值的位缺键。
   *  入参形状与门面动词 `shelfAdd(bookKey, meta)` 同一张表的两端；null/undefined 一律缺键
   *  （`{...existing, ...input}` 下 `: undefined` 会抹掉已有元数据）。sourceId/title 必填后写：
   *  pick 的运行时值无 null，断言只剥类型面的可空。 */
  shelfAdd: (sourceId: string, meta: ShelfMetaPatch & { title: string }):
    { sourceId: string; title: string } & Record<string, string | number> => {
    const picked = pickShelfMeta({ ...meta, sourceId }) as Record<string, string | number>
    return { ...picked, sourceId, title: meta.title }
  },
  /** ② progress 形态=更新进度（值域门归门面动词、缺席抛 `BookNotOnShelfError`；400 与文案
   *  归 `api/dispatch.ts` 的 `shelfUpdate`，这里只管形状） */
  shelfProgress: (chapterIndex: number, offsetRatio: number): Record<string, unknown> =>
    ({ [BODY.progress]: { [BODY.chapterIndex]: chapterIndex, [BODY.offsetRatio]: offsetRatio } }),
  /** ③ listen 形态=存听书位置（单对象入参：六个字段同属一条位置记录，摊成位置参数只会让
   *  调用点在两处各排一遍序）。值域门归门面动词 `shelfSaveListen`（缺席抛
   *  `BookNotOnShelfError`），400 与文案归 `api/dispatch.ts` 的 `shelfUpdate`；
   *  构造器只写契约里的六个键。 */
  shelfListen: (p: ListenState): Record<string, unknown> =>
    ({ [BODY.listen]: {
      [BODY.chapterIndex]: p.chapterIndex,
      [BODY.paragraphIndex]: p.paragraphIndex,
      [BODY.engineId]: p.engineId,
      [BODY.voice]: p.voice,
      [BODY.rate]: p.rate,
      [BODY.volume]: p.volume,
    } }),
  /** ④ patch 形态=对在架书打补丁：字段缺省/null 一律不出现在 body（缺席键保值——ReaderView 回写
   *  totalChapters 只发一个字段，不必再重发 sourceId+title）。取舍同走 `pickShelfMeta` 单点 */
  shelfPatch: (p: ShelfMetaPatch): Record<string, unknown> =>
    ({ [BODY.patch]: pickShelfMeta(p) }),
  /** ⑤ 段合成（听书面）：一段正文 + 引擎/音色/语速。`voice` 缺席 = 该源不用音色
   *  （不编一个「默认音色」的替身；缺省音色由源自己决定） */
  ttsSynthesize: (p: SynthesisRequest): Record<string, unknown> => ({
    [BODY.engineId]: p.engineId,
    [BODY.text]: p.text,
    [BODY.rate]: p.rate,
    ...(p.voice === undefined ? {} : { [BODY.voice]: p.voice }),
  }),
  /** ⑥ 引擎订阅导入：两条来路（粘贴 JSON / 拉取 URL）恰写一位；「恰一」的裁决归读口，
   *  构造器只落位在场的那一位（两参对象是调用点唯一形状，摊成位置参数只会让调用点自行约定顺序） */
  ttsEnginesImport: (p: { json?: string; url?: string }): Record<string, unknown> => ({
    ...(p.json === undefined ? {} : { [BODY.json]: p.json }),
    ...(p.url === undefined ? {} : { [PARAMS.url]: p.url }),
  }),
  /** ⑦ 引擎新增/更新（`PUT tts/engines/:id` 的 body）：可编辑字段集原样落位。id 不在 body 里
   *  （它是身份/路径参数）；`lastUpdateTime` / hasAuth 这类注册表盖章的位也不进写口；
   *  `auth` 是只写凭据槽——投影永远读不回来。三个文本位按 `TTS_ENGINE_TEXT_FIELDS` 派生
   *  （表加字段 = 构造器自动带上，没有手抄本可漏）；`voices` 在场才带。 */
  ttsEnginePut: (p: TtsEngineInput): Record<string, unknown> => ({
    [PARAMS.name]: p.name,
    [PARAMS.url]: p.url,
    ...Object.fromEntries(
      TTS_ENGINE_TEXT_FIELDS
        .filter((field) => p[field] !== undefined)
        .map((field) => [BODY[field], p[field]] as const),
    ),
    ...(p.voices === undefined ? {} : { [BODY.voices]: p.voices }),
    ...(p.auth === undefined ? {} : { [BODY.auth]: {
      [BODY.cookies]: p.auth.cookies,
      ...(p.auth.headers === undefined ? {} : { [BODY.headers]: p.auth.headers }),
      ...(p.auth.loginInfo === undefined ? {} : { [BODY.loginInfo]: p.auth.loginInfo }),
    } }),
  }),
} as const

/** 编译期绑定：表里每位都必须是 `TtsEngineInput` 的键——加表而写入口（构造器的入参）没接 =
 *  tsc 红（派生处的 `p[field]` 踩同一道缝；断言把它写成显式契约，换掉派生也还在）。 */
type Assert<T extends true> = T
export type _PutTextFieldsBindInput = Assert<TtsEngineTextField extends keyof TtsEngineInput ? true : false>

/** 反向：可编辑位只有表里这三格（身份 `name`/`url`、只写凭据 `auth`、音色表 `voices` 各归各）。
 *  给写入口加一个非文本可编辑位而构造器/读口没接，写入会静默丢字段且编译期无声——这一向堵住它。 */
export type _PutTextFieldsCoverInput = Assert<
  Exclude<keyof TtsEngineInput, 'name' | 'url' | 'auth' | 'voices'> extends TtsEngineTextField ? true : false
>

/** 对象位（cookie/header 表）：非对象、null、数组一律不算在场。
 *  值必须是字符串：混进对象/数字会原样进 SourceAuth，最后被 fetch 的 WebIDL 强转成
 *  `"[object Object]"` 之类的垃圾出站头——形状错在边界处报，不在请求线上发作。 */
function readRecordField(body: Record<string, unknown>, field: string): Record<string, string> | undefined {
  const v = body[field]
  if (v === undefined) return undefined
  if (typeof v !== 'object' || v === null || Array.isArray(v)
    || !Object.values(v).every((x) => typeof x === 'string')) bodyBad(`body 需为 { ${BODY.cookies}: Record<string,string>, ${BODY.headers}?: Record<string,string> }`)
  return v as Record<string, string>
}

/** 音色表的形状判据（**单点**：引擎写口 body 与订阅导入条共用，别处不再各抄一份）：
 *  数组且逐项 `{ id, name }` 两格非空串才在场；形状不符 = **该键缺席**（不猜——认不出的表按
 *  「源没这条信息」处理，坏表整键不带）；空数组是合法值 = 整组清掉，照收。
 *  在场时逐项**只投影 `id` / `name` 两格**：订阅数据可能带 legado 的额外键（如 `lang`），
 *  原样落盘会让持久化形状长出本仓不消费的字段，配置卡与导出也跟着回显它们。
 *  **PUT 写口另加一道**：`readBodies.ttsEnginePut` 对「在场但形状不符」落 400——它面对的是用户
 *  刚提交的数据，静默丢键会让人以为存上了；导入面对外部数据，才按条剪除。两把尺各有主语。 */
export function readTtsVoices(value: unknown): TtsVoice[] | undefined {
  if (value === undefined) return undefined
  const itemOk = (x: unknown): boolean =>
    typeof x === 'object' && x !== null && !Array.isArray(x)
    && typeof (x as { id?: unknown }).id === 'string' && (x as { id: string }).id.trim() !== ''
    && typeof (x as { name?: unknown }).name === 'string' && (x as { name: string }).name.trim() !== ''
  if (!Array.isArray(value) || !value.every(itemOk)) return undefined
  return (value as TtsVoice[]).map((voice) => ({ id: voice.id, name: voice.name }))
}

/** `PUT shelf/:key` body 的**字段事实**（不裁决形态）：四个构造器（四形态）产出的东西都能拆成
 *  这四个事实位，读口只做字段集类型判别。
 *  - `meta` = 顶层认得出的书目元数据（title 可以是空串——空标题是事实，不是缺席）；
 *  - `patch` = body.patch 是对象才非 null；
 *  - `progress` = 两个键都是 number 才非 null（值域归门面动词）；
 *  - `listen` = 六个键类型对才非 null（可空位必须是在场的 `string | null`，值域归门面动词）。
 *  四形态的优先级（title 非空 → patch → progress → listen）与「皆无 → 400」是派发，归
 *  `src/api/dispatch.ts` 的 shelfPut 臂（传输关注点，见 `ADR-0036`）。 */
export interface ShelfPutFields {
  meta: ShelfMetaPatch
  patch: ShelfMetaPatch | null
  progress: { chapterIndex: number; offsetRatio: number } | null
  listen: ListenState | null
}

export const readBodies = {
  /** 导入任务：`{ files: [{ name, text }] }`（全本多源导出是大包，上限归路由的读体） */
  import: (body: Record<string, unknown> | null): { files: ImportFileBody[] } => {
    const files = body?.[BODY.files]
    if (!Array.isArray(files) || files.length === 0
      || !files.every((f) => f !== null && typeof f === 'object'
        && typeof (f as Record<string, unknown>)[PARAMS.name] === 'string'
        && typeof (f as Record<string, unknown>)[BODY.text] === 'string')) {
      bodyBad(`body 需为非空 { ${BODY.files}: [{ ${PARAMS.name}, ${BODY.text} }] }`)
    }
    return { files: files as ImportFileBody[] }
  },
  /** 书源批路由的键集（id） */
  ids: (body: Record<string, unknown> | null): string[] => readIdList(body, BODY.ids),
  /** 书架批路由的键集（bookKey，与源 id 不同名，故字段名也不同） */
  keys: (body: Record<string, unknown> | null): string[] => readIdList(body, BODY.keys),
  /** 单源启停 */
  enabled: (body: Record<string, unknown> | null): boolean => {
    const v = body?.[BODY.enabled]
    if (typeof v !== 'boolean') bodyBad(`body 需为 { ${BODY.enabled}: boolean }`)
    return v
  },
  /** 单源 AI 搜索标记 */
  aiSearch: (body: Record<string, unknown> | null): boolean => {
    const v = body?.[BODY.aiSearch]
    if (typeof v !== 'boolean') bodyBad(`body 需为 { ${BODY.aiSearch}: boolean }`)
    return v
  },
  /** 批量启停：键集 + 目标状态 */
  batchEnabled: (body: Record<string, unknown> | null): { ids: string[]; enabled: boolean } => {
    const ids = readIdList(body, BODY.ids)
    const enabled = body?.[BODY.enabled]
    if (typeof enabled !== 'boolean') bodyBad(`body 需为非空 { ${BODY.ids}: string[], ${BODY.enabled}: boolean }`)
    return { ids, enabled }
  },
  /** 批量 AI 搜索标记：键集 + 目标状态 */
  batchAiSearch: (body: Record<string, unknown> | null): { ids: string[]; aiSearch: boolean } => {
    const ids = readIdList(body, BODY.ids)
    const aiSearch = body?.[BODY.aiSearch]
    if (typeof aiSearch !== 'boolean') bodyBad(`body 需为非空 { ${BODY.ids}: string[], ${BODY.aiSearch}: boolean }`)
    return { ids, aiSearch }
  },
  /** 聚合搜索提交：关键词必填，点名源可选（空数组按「没点名」走全参与集，不是「搜零家」） */
  searchJob: (body: Record<string, unknown> | null): { keyword: string; sourceIds?: string[] } => {
    const keyword = readRequiredText(body, PARAMS.keyword)
    const raw = body?.[PARAMS.sourceIds]
    if (raw !== undefined && (!Array.isArray(raw) || !raw.every((x) => typeof x === 'string'))) {
      bodyBad(`body.${PARAMS.sourceIds} 需为 string[]`)
    }
    return { keyword, ...(raw === undefined ? {} : { sourceIds: raw }) }
  },
  /** 分类轮次提交：两个点名都在 body 里（浏览轴是「先点名一个源、逛它自己的分类」，`ADR-0028`） */
  exploreList: (body: Record<string, unknown> | null): { sourceId: string; kind: string } => ({
    sourceId: readRequiredText(body, PARAMS.sourceId),
    kind: readRequiredText(body, PARAMS.kind),
  }),
  /** 登录面形态：`runLogin: true` 走源自己声明的登录规则；`loginAction: 行名` 跑按钮动作；
   *  否则按 cookie / loginInfo 录入。判别只到形状层——「这源有没有声明登录入口、是 URL 还是 JS」归门面。 */
  auth: (body: Record<string, unknown> | null):
    | { mode: 'run-login' }
    | { mode: 'login-action'; name: string }
    | { mode: 'cookies'; cookies: Record<string, string>; headers?: Record<string, string>; loginInfo?: Record<string, string> }
    | { mode: 'login-info'; loginInfo: Record<string, string> } => {
    if (body?.[BODY.runLogin] === true) return { mode: 'run-login' }
    const b = body ?? {}
    const loginAction = b[BODY.loginAction]
    if (loginAction !== undefined) {
      if (typeof loginAction !== 'string' || loginAction.trim() === '') bodyBad(`body.${BODY.loginAction} 需为非空 string`)
      return { mode: 'login-action', name: loginAction }
    }
    const cookies = readRecordField(b, BODY.cookies)
    const loginInfo = readRecordField(b, BODY.loginInfo)
    if (cookies === undefined && loginInfo !== undefined) return { mode: 'login-info', loginInfo }
    if (cookies === undefined) bodyBad(`body 需为 { ${BODY.runLogin}: true } | { ${BODY.loginAction}: string } | { ${BODY.loginInfo}: Record<string,string> } | { ${BODY.cookies}: Record<string,string>, ${BODY.headers}?: Record<string,string>, ${BODY.loginInfo}?: Record<string,string> }`)
    const headers = readRecordField(b, BODY.headers)
    return {
      mode: 'cookies', cookies,
      ...(headers === undefined ? {} : { headers }),
      ...(loginInfo === undefined ? {} : { loginInfo }),
    }
  },
  /** 书架 PUT 的**字段事实**读口：只做字段集类型判别（meta / patch 形状 / progress 两键都是数 /
   *  listen 六键类型对），不裁决形态——「非空 title 才算加书、四形态皆无 → 400」是分派，
   *  归 `api/dispatch.ts` 的 shelfPut 臂。全空 body 回空事实（不是抛错）：读口交事实，传输层决定报什么。 */
  shelfPut: (body: Record<string, unknown> | null): ShelfPutFields => {
    const b = body ?? {}
    const patch = b[BODY.patch]
    const progress = b[BODY.progress]
    const p = progress !== null && typeof progress === 'object' ? progress as Record<string, unknown> : null
    const listen = b[BODY.listen]
    const l = listen !== null && typeof listen === 'object' ? listen as Record<string, unknown> : null
    // 可空位（引擎 / 音色）必须是在场的 `string | null`：wire 可空口径里 null 是在场的值，
    // 缺键不是 null——形状不完整回 null 事实，由 dispatch 落成 400，不替调用方猜一个 null。
    const nullableText = (v: unknown): v is string | null => v === null || typeof v === 'string'
    return {
      meta: pickShelfMeta(b),
      patch: patch !== null && typeof patch === 'object' ? pickShelfMeta(patch as Record<string, unknown>) : null,
      progress: p !== null && typeof p[BODY.chapterIndex] === 'number' && typeof p[BODY.offsetRatio] === 'number'
        ? { chapterIndex: p[BODY.chapterIndex] as number, offsetRatio: p[BODY.offsetRatio] as number }
        : null,
      listen: l !== null
        && typeof l[BODY.chapterIndex] === 'number'
        && typeof l[BODY.paragraphIndex] === 'number'
        && typeof l[BODY.rate] === 'number'
        && typeof l[BODY.volume] === 'number'
        && nullableText(l[BODY.engineId])
        && nullableText(l[BODY.voice])
        ? {
            chapterIndex: l[BODY.chapterIndex] as number,
            paragraphIndex: l[BODY.paragraphIndex] as number,
            engineId: l[BODY.engineId] as string | null,
            voice: l[BODY.voice] as string | null,
            rate: l[BODY.rate] as number,
            volume: l[BODY.volume] as number,
          }
        : null,
    }
  },
  /** 段合成：三必填位（engineId/text/rate）+ 可选音色。`rate` 只过「有限数」——范围是播放侧
   *  与引擎的事（值域门长在这条读口上只护 HTTP 面，工具/播放层仍可绕过）。 */
  ttsSynthesize: (body: Record<string, unknown> | null): SynthesisRequest => {
    const engineId = readRequiredText(body, BODY.engineId)
    const text = readRequiredText(body, BODY.text)
    const rate = body?.[BODY.rate]
    if (typeof rate !== 'number' || !Number.isFinite(rate)) bodyBad(`body.${BODY.rate} 需为有限 number`)
    const voice = readOptionalText(body, BODY.voice)
    return { engineId, text, rate, ...(voice === undefined ? {} : { voice }) }
  },
  /** 引擎订阅导入：恰带一条来路。两条都给是「调用方没说清要哪份」，一条都没有是无事可做——
   *  两种都不替它挑一个（URL 支必须是 http(s)：file:/data: 不是订阅）。 */
  ttsEnginesImport: (body: Record<string, unknown> | null): { json: string } | { url: string } => {
    const json = readOptionalText(body, BODY.json)
    const url = readOptionalText(body, PARAMS.url)
    if ((json === undefined) === (url === undefined)) bodyBad(`body 需恰带 ${BODY.json} 或 ${PARAMS.url} 之一`)
    if (json !== undefined) {
      if (json.trim() === '') bodyBad(`body.${BODY.json} 需为非空 string`)
      return { json }
    }
    if (url === undefined || !/^https?:\/\//i.test(url.trim())) bodyBad(`body.${PARAMS.url} 需为 http(s) 地址`)
    return { url }
  },
  /** 引擎新增/更新的 body：name/url 必填非空（注册表在值域上还会再判一次——它护工具面直装），
   *  其余可编辑位只判类型；`auth` 三键与登录面同一把尺（cookies 必须有，headers/loginInfo 可选）；
   *  `voices` 形状不符 = 该键缺席（与导入条同宽严，不替调用方猜一个表）。 */
  ttsEnginePut: (body: Record<string, unknown> | null): TtsEngineInput => {
    const b = body ?? {}
    const name = readOptionalText(b, PARAMS.name)
    if (name === undefined || name.trim() === '') bodyBad(`缺 body 字段 ${PARAMS.name}`)
    const url = readOptionalText(b, PARAMS.url)
    if (url === undefined || url.trim() === '') bodyBad(`缺 body 字段 ${PARAMS.url}`)
    const authRaw = b[BODY.auth]
    let auth: TtsEngineInput['auth']
    if (authRaw !== undefined) {
      if (typeof authRaw !== 'object' || authRaw === null || Array.isArray(authRaw)) {
        bodyBad(`body.${BODY.auth} 需为 { ${BODY.cookies}: Record<string,string> }`)
      }
      const a = authRaw as Record<string, unknown>
      const cookies = readRecordField(a, BODY.cookies)
      if (cookies === undefined) bodyBad(`body.${BODY.auth}.${BODY.cookies} 需为 Record<string,string>`)
      const headers = readRecordField(a, BODY.headers)
      const loginInfo = readRecordField(a, BODY.loginInfo)
      auth = { cookies, ...(headers === undefined ? {} : { headers }), ...(loginInfo === undefined ? {} : { loginInfo }) }
    }
    const textFields: Partial<Record<TtsEngineTextField, string>> = {}
    for (const field of TTS_ENGINE_TEXT_FIELDS) {
      const value = readOptionalText(b, BODY[field])
      if (value !== undefined) textFields[field] = value
    }
    const voicesRaw = b[BODY.voices]
    const voices = readTtsVoices(voicesRaw)
    // 在场但认不出 = 用户这次提交的表是坏的：写口不许静默丢（导入面才按「坏表整键不带」剪）。
    if (voicesRaw !== undefined && voices === undefined) {
      bodyBad(`body.${BODY.voices} 需为 [{ id: string, name: string }]（两格都非空）`)
    }
    return {
      name, url,
      ...textFields,
      ...(voices === undefined ? {} : { voices }),
      ...(auth === undefined ? {} : { auth }),
    }
  },
} as const
