/** 书源状态与内容形态：定义在 wire 契约（src/shared/wire.ts）；此处 re-export 保持既有 import 路径可用。 */
export type { SourceStatus, SourceContentKind, ShelfBook, ShelfProgress } from '../shared/wire.js'
import type { SourceStatus, SourceContentKind, TtsVoice } from '../shared/wire.js'

/** 登录态挂载点（服务层只做数据位；loginUrl JS 执行与 cookie 录入归 HTTP 面 / UI） */
export interface SourceAuth {
  cookies: Record<string, string>
  headers?: Record<string, string>
  /** loginUi / getLoginInfoMap 的键值（用户名、token 等）；脚本经 source.getLoginInfoMap() 读。 */
  loginInfo?: Record<string, string>
  acquiredAt?: number
  expired?: boolean
}

/** 书源 JSON 的驼峰字段 → 内部规则集；缺一律 null（「源没这条信息」≠「没解出来」）。搜索上下文与详情上下文分列——混用会把搜索
 *  条目规则套到详情页造垃圾标题；平铺方言无 ruleDetail* 时详情面回退共用字段。 */
export interface NormalizedRules {
  searchUrl: string | null; exploreUrl: string | null
/** 源级分类页 URL 模板，含 `{{kind}}` 与 `{{page}}`：原生方言由 `ruleFind.url` 落位，平铺 raw 顶层同名键也直通这一格——这一格有没有值
 *  不由方言决定。它与「入口自带地址」谁优先、首页裁不裁页，归 `explore-face.fetchKindPage`（`ADR-0027`）。 */
  ruleExploreUrl: string | null
/** 分类入口（顶层一层；`children` 不接）。原生 `ruleFind.kinds`、legado `exploreUrl` 解出的条目、平铺 raw 自带那一格共用这一个形状；
 *  「这次用哪份模板」归 `explore-face.fetchKindPage`。 */
  ruleExploreKinds: Array<{ title: string; url: string }>
/** 发现面条目的九个字段：**整套**覆盖通用搜索规则，且只在它的列表规则非空时启用整档——判据只看 `ruleExploreList` 是否非空，别逐字段
 *  回落（那会把「本该用通用规则」的源读成半套）。 */
  ruleExploreList: string | null; ruleExploreName: string | null
  ruleExploreAuthor: string | null; ruleExploreBookUrl: string | null
  ruleExploreCoverUrl: string | null; ruleExploreIntro: string | null
  ruleExploreKind: string | null; ruleExploreLastChapter: string | null
  ruleExploreWordCount: string | null
/** 校验/探针关键词：探针的第一个关键词——固定词序列在「只搜得到自家书名」的站上是误判源（现量按 `DSH_PARSE_CENSUS` 重数）。含
 *  `http`/`::`/`++`/`--` 的值直接弃用，回落到通用词。唯一消费者 `services/probe.ts`。 */
  probeKeyword: string | null
  ruleBookList: string | null; ruleBookName: string | null; ruleAuthor: string | null
  ruleBookUrl: string | null; ruleCoverUrl: string | null; ruleIntro: string | null
  ruleLastChapter: string | null; ruleTocUrl: string | null
  /** 条目级分类/字数（ruleSearch.kind / wordCount） */
  ruleKind: string | null; ruleWordCount: string | null
/** 详情页嗅探（顶层 `bookUrlPattern`）：搜索的**落地地址**整串命中它即「这条 URL 就是详情页」——此时**先**把整段响应按详情规则展开，
 *  列表规则不参与；未声明时列表为空才有同款回落。消费者 `search-face.ts`（判定）与 `reading.ts`（info 形态展开）。 */
  bookUrlPattern: string | null
  /** 目录列表选择器（对象方言 ruleToc.chapterList；平铺方言缺 → 目录面回退 ruleBookList） */
  ruleChapterList: string | null
  ruleChapterName: string | null; ruleChapterUrl: string | null
/** 目录章标记规则（对象方言 ruleToc.isVip/isVolume/isPay/updateTime）；布尔位按 `online-reading.isTrueRuleValue` 折。可选：存量
 *  NormalizedRules 字面量与旧源不必带这几格。 */
  ruleChapterIsVip?: string | null
  ruleChapterIsVolume?: string | null
  ruleChapterIsPay?: string | null
  ruleChapterUpdateTime?: string | null
  /** 详情页上下文（对象方言 ruleBookInfo.*；缺 → 详情面回退同名共用字段） */
  ruleDetailName: string | null; ruleDetailAuthor: string | null
  ruleDetailCoverUrl: string | null; ruleDetailIntro: string | null
  ruleDetailLastChapter: string | null
  ruleDetailKind: string | null; ruleDetailWordCount: string | null
/** 详情初始化规则：先求值，结果**替换**后续详情规则的求值上下文（JSON 换根进 ctx.json）——正版 API 形态的 `$.data.bookInfo` 全靠它；
 *  tocUrl 模板 `{{$.…}}` 同在换根后的上下文上插值（bridge.detailContextOf 唯一实现）。 */
  ruleDetailInit: string | null
  ruleContent: string | null
  /** 正文扩展字段（对象方言 ruleContent.title/subContent）；可选，旧源不必带 */
  ruleContentSubContent?: string | null
  nextTocUrl: string | null; nextPageUrl: string | null
  header: Record<string, string> | null; loginUrl: string | null
/** 动态请求头规则（`header` 的 `@js:`/`<js>` 形态）：与 header 互斥同源，请求前经沙箱求值得到 JSON 头表（device-id/Authorization 全靠它）。
 *  唯一求值点 `source-eval.ts` 的 resolveHeaders；存量由 SourceRegistry.load 按 raw 重推。 */
  headerRule: string | null
/** jsLib：源级全局 JS 函数库（函数定义拼在每段 @js 代码前执行——脚本里的 urlUserFavorite/host 等定义在此，缺它整段 js 必炸 not defined）。 */
  jsLib: string | null
}

/** 规范化后的书源全量（含 raw 原文与 auth——只落盘，不进对外返回值） */
export interface NovelSource {
  id: string; name: string; baseUrl: string; enabled: boolean; groups: string[]
/** 是否参与 AI 搜索工具的聚合搜索（与 `enabled` 正交）。用户偏好而非书源格式字段：导入缺省 false，重导入保留原值；类型上可选是承认
 *  「盘上旧条目还没过 load 迁移」——读侧一律按 `=== true`，写侧恒写布尔。 */
  aiSearch?: boolean
  type: SourceContentKind
  raw: unknown; rules: NormalizedRules; auth?: SourceAuth
  status: SourceStatus; statusDetail?: string
  importedAt: number; lastProbedAt?: number
}

/** 朗读引擎（legado HttpTTS 订阅条目）：`tts-engines.json` 的落盘形状；缺省字段不建键。`auth` 只落盘：对外投影是 wire 的 `TtsEnginePublic`
 *  （剥 auth、只给 hasAuth），写入口是可编辑子集 `TtsEngineInput`（不含 id / lastUpdateTime）。 */
export interface HttpTtsEngine {
  id: string
  name: string
  url: string
  contentType?: string
  header?: string
  jsLib?: string
  /** 源声明的音色表：订阅条携带（导入 / put 可整组替换），内置源没有；`toPublic` 原样投影，不算凭据。 */
  voices?: TtsVoice[]
  auth?: SourceAuth
  lastUpdateTime?: number
}

/** 书架条目：ShelfBook 定义在 wire 契约；它是 shelf.json 持久化形状也是 wire 形状——唯一定义归 shared。 */
