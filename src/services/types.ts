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

/** legado 驼峰 → 内部规则集规范化后的形态；缺一律 null（「源没这条信息」≠「没解出来」）。
 * 搜索上下文（ruleBookList/ruleBookName/…）与详情上下文（ruleDetail*）分列——
 * 对象方言两上下文规则实测 508/541 不同，混用会把搜索条目规则套到详情页造垃圾标题；
 * 平铺方言无 ruleDetail* 时详情面回退共用字段（原 v1 行为）。 */
export interface NormalizedRules {
  searchUrl: string | null; exploreUrl: string | null
  ruleBookList: string | null; ruleBookName: string | null; ruleAuthor: string | null
  ruleBookUrl: string | null; ruleCoverUrl: string | null; ruleIntro: string | null
  ruleLastChapter: string | null; ruleTocUrl: string | null
  /** 目录列表选择器（对象方言 ruleToc.chapterList；平铺方言缺 → 目录面回退 ruleBookList） */
  ruleChapterList: string | null
  ruleChapterName: string | null; ruleChapterUrl: string | null
  /** 详情页上下文（对象方言 ruleBookInfo.*；缺 → 详情面回退同名共用字段） */
  ruleDetailName: string | null; ruleDetailAuthor: string | null
  ruleDetailCoverUrl: string | null; ruleDetailIntro: string | null
  ruleDetailLastChapter: string | null
  /** 详情初始化规则（对象方言 ruleBookInfo.init，legado BookInfo 口径）：先求值，结果**替换**
   *  后续详情规则的求值上下文（JSON 换根进 ctx.json）——QQ 类正版 API 源的 `$.data.bookInfo`
   *  全靠它；tocUrl 模板 `{{$.…}}` 同在换根后的上下文上插值（reading.detailContextOf 唯一实现） */
  ruleDetailInit: string | null
  ruleContent: string | null
  nextTocUrl: string | null; nextPageUrl: string | null
  header: Record<string, string> | null; loginUrl: string | null
  /** 动态请求头规则（legado `header` 字段的 `@js:`/`<js>` 形态——BaseSource.getHeaderMap 的
   *  evalJS 口径）：与 header 互斥同源（同一 raw.header 字段二选一），请求前经沙箱求值得到
   *  JSON 头表（顶点小说的 device-id/Authorization 全靠它，静态形态 4004）。唯一求值点
   *  `services/bridge.ts` 的 resolveHeaders；存量由 SourceRegistry.load 按 raw 重推。 */
  headerRule: string | null
  /** legado jsLib：源级全局 JS 函数库（函数定义拼在每段 @js 代码前执行——
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
