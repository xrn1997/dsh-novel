/** 书源状态与内容形态：定义在 wire 契约（src/shared/wire.ts）——持久化与对外返回共用一份。
 *  此处 re-export 保持既有 import 路径可用。 */
export type { SourceStatus, SourceContentKind, ShelfBook, ShelfProgress } from '../shared/wire.js'
import type { SourceStatus, SourceContentKind } from '../shared/wire.js'

/** 登录态挂载点（服务层只做数据位；loginUrl JS 执行与 cookie 录入归 HTTP 面 / UI） */
export interface SourceAuth {
  cookies: Record<string, string>
  headers?: Record<string, string>
  acquiredAt?: number
  expired?: boolean
}

/** 书源 JSON 的驼峰字段 → 内部规则集规范化后的形态；缺一律 null（「源没这条信息」≠「没解出来」）。
 * 搜索上下文（ruleBookList/ruleBookName/…）与详情上下文（ruleDetail*）分列——
 * 两上下文规则不同，混用会把搜索条目规则套到详情页造垃圾标题；
 * 平铺方言无 ruleDetail* 时详情面回退共用字段（原 v1 行为）。 */
export interface NormalizedRules {
  searchUrl: string | null; exploreUrl: string | null
  /** 源级分类页 URL 模板，含 `{{kind}}`（替换成入口自带的地址）与 `{{page}}`：原生方言由
   *  `ruleFind.url` 落位，平铺 raw 顶层写同名键也直通这一格——所以**这一格有没有值不由方言决定**。
   *  它与「入口自带地址」谁优先、首页裁不裁页，主人是 `explore-face.fetchKindPage`（裁决见
   *  `docs/adr/0027`），这里不复述判据。 */
  ruleExploreUrl: string | null
  /** 分类入口（顶层一层；`children` 本期不做，见 normalize 的告警）：原生 `ruleFind.kinds`、
   *  legado `exploreUrl` 解出的条目、平铺 raw 自带那一格，三处共用这一个形状；地址语义按方言不同，
   *  「这次用哪份模板」归 `explore-face.fetchKindPage`。 */
  ruleExploreKinds: Array<{ title: string; url: string }>
  /** 发现面条目的九个字段（原生 `ruleFind.ruleSearch` 与 legado `ruleExplore` 落的是同一批模型键）：
   *  **整套**覆盖通用搜索规则（对面语义是
   *  `if (findRule.ruleSearch.list.isNotEmpty())` 才用它）——所以判据只看 `ruleExploreList` 是否非空，
   *  别逐字段回落：那会把「对面本该用通用规则」的源读成半套。 */
  ruleExploreList: string | null; ruleExploreName: string | null
  ruleExploreAuthor: string | null; ruleExploreBookUrl: string | null
  ruleExploreCoverUrl: string | null; ruleExploreIntro: string | null
  ruleExploreKind: string | null; ruleExploreLastChapter: string | null
  ruleExploreWordCount: string | null
  /** 校验/探针关键词（`ruleSearch.checkKeyWord`）：探针的第一个关键词——固定词序列
   *  在「只搜得到自家书名」的站上是误判源（现量按 `DSH_PARSE_CENSUS=1` 的 `probeKeyword` 行
   *  重数，别抄任何转录的读数）。含 `http`/`::`/`++`/`--` 的值直接弃用（那些串与调试输入
   *  语法冲突），回落到通用词。唯一消费者 `services/probe.ts`。 */
  probeKeyword: string | null
  ruleBookList: string | null; ruleBookName: string | null; ruleAuthor: string | null
  ruleBookUrl: string | null; ruleCoverUrl: string | null; ruleIntro: string | null
  ruleLastChapter: string | null; ruleTocUrl: string | null
  /** 条目级分类/字数（ruleSearch.kind / wordCount） */
  ruleKind: string | null; ruleWordCount: string | null
  /** 详情页嗅探（顶层 `bookUrlPattern`，不在 rules 里）：搜索的**落地地址**整串命中它即
   *  「这条 URL 就是详情页」——此时**先**把整段响应按详情规则展开成一条书目，列表规则不参与；
   *  未声明时列表为空才有同款回落（回落即按详情页解析，见 `services/search-face.ts`）。
   *  唯一消费者 `services/search-face.ts`（判定）＋ `services/reading.ts`（info 形态展开）。 */
  bookUrlPattern: string | null
  /** 目录列表选择器（对象方言 ruleToc.chapterList；平铺方言缺 → 目录面回退 ruleBookList） */
  ruleChapterList: string | null
  ruleChapterName: string | null; ruleChapterUrl: string | null
  /** 详情页上下文（对象方言 ruleBookInfo.*；缺 → 详情面回退同名共用字段） */
  ruleDetailName: string | null; ruleDetailAuthor: string | null
  ruleDetailCoverUrl: string | null; ruleDetailIntro: string | null
  ruleDetailLastChapter: string | null
  ruleDetailKind: string | null; ruleDetailWordCount: string | null
  /** 详情初始化规则（对象方言 ruleBookInfo.init）：先求值，结果**替换**
   *  后续详情规则的求值上下文（JSON 换根进 ctx.json）——正版 API 形态的 `$.data.bookInfo`
   *  全靠它；tocUrl 模板 `{{$.…}}` 同在换根后的上下文上插值（bridge.detailContextOf 唯一实现） */
  ruleDetailInit: string | null
  ruleContent: string | null
  nextTocUrl: string | null; nextPageUrl: string | null
  header: Record<string, string> | null; loginUrl: string | null
  /** 动态请求头规则（`header` 字段的 `@js:`/`<js>` 形态）：与 header 互斥同源
   *  （同一 raw.header 字段二选一），请求前经沙箱求值得到 JSON 头表（源的 device-id/
   *  Authorization 全靠它，静态形态 4004）。唯一求值点 `services/bridge.ts` 的 resolveHeaders；
   *  存量由 SourceRegistry.load 按 raw 重推。 */
  headerRule: string | null
  /** jsLib：源级全局 JS 函数库（函数定义拼在每段 @js 代码前执行——
   *  真实源 urlUserFavorite/host/qmSearchUrl 等函数定义在此，缺它整段 js 必炸 not defined） */
  jsLib: string | null
}

/** 规范化后的书源全量（含 raw 原文与 auth——只落盘，不进对外返回值） */
export interface NovelSource {
  id: string; name: string; baseUrl: string; enabled: boolean; groups: string[]
  type: SourceContentKind
  raw: unknown; rules: NormalizedRules; auth?: SourceAuth
  status: SourceStatus; statusDetail?: string
  importedAt: number; lastProbedAt?: number
}

/** 书架条目：ShelfBook 定义在 wire 契约（src/shared/wire.ts），上方 re-export。
 *  归属说明：它是 shelf.json 持久化形状，也是 wire 形状——两者同构，唯一定义归 shared。 */
