import type { Cheerio } from 'cheerio'
import type { AnyNode } from 'domhandler'
import type { SourceSession } from './session.js'

export type Facet = 'search' | 'detail' | 'toc' | 'content' | 'explore' | 'rule'

/** 取值用途：同一条规则串在两种用途下链尾未知词语义不同——value 当 **HTML 属性名**，list 按 **CSS** 求值。
 *  调用方显式声明；缺省 'list'。 */
export type RuleUsage = 'value' | 'list'

export type EngineValue =
  | { kind: 'miss'; detail: string }
  | { kind: 'value'; text: string }
  | { kind: 'list'; items: string[] }
  | { kind: 'nodes'; nodes: Cheerio<AnyNode> }
  | { kind: 'matches'; rows: string[][] }
export interface SegmentLoc { segmentIndex: number; segmentRaw: string }

export interface EvalContext {
  html?: string
  json?: unknown
  baseUrl?: string
  source?: string
  /** 源实体字段 `bookSourceComment`：输入里有把**解密脚本**存在这里、用插值读 `source.bookSourceComment` 再
   *  执行的形态，漏掉时脚本拿到 undefined、静默不映射。 */
  sourceComment?: string
  sourceName?: string
  vars?: Record<string, string>
  /** 变量链的 **source 层**（跨门面调用、按源隔离；由沙箱从 `SourceSession` 接线）。读序
   *  chapter→book→ruleData→source，每级空串继续下找。chapter/book 两层要持久化宿主，未接 → 矩阵
   *  `a-var-scope-chain` 仍记开口。 */
  sourceVar?: (key: string) => string | undefined
  /** `finalUrl` = 跟随重定向后的落地地址 */
  fetch?: (url: string, headers?: Record<string, string>) => Promise<{ body: string; contentType?: string; finalUrl?: string }>
  /** 本仓**实际出站**的 User-Agent（惰性取，源规则可覆盖）——对浏览器内核 UA 是**近似**；未接线时桥点名
   *  抛错而不编一个值（矩阵 `h-java-webview-ua`）。 */
  userAgent?: () => string
  /** 二进制抓取（`java.downloadFile`）：返回**原始字节**——经字符集解码链的字符串会损坏 PNG。 */
  fetchRaw?: (url: string) => Promise<Uint8Array>
  /** `java.post` 的出站口（`services/engine-fetch.ts` 的 engineFetchPost——**同一个守门 fetcher**）。 */
  fetchPost?: (url: string, body: string, headers?: Record<string, string>) => Promise<{
    url: string; body: string; contentType?: string; charset?: string; statusCode: number
    headers: Record<string, string>; cookies: Record<string, string>
  }>
  /** `java.head` 的出站口：HEAD + **不跟重定向**（脚本读 `res.headers()["location"]` 取直链）。 */
  fetchHead?: (url: string, headers?: Record<string, string>) => Promise<{
    url: string; statusCode: number; headers: Record<string, string>; cookies?: Record<string, string>
  }>
  /** `java.get(url, headers)` 的出站口：GET + **不跟重定向**，返回 `Connection.Response` 数据面。 */
  fetchGet?: (url: string, headers?: Record<string, string>) => Promise<{
    url: string; body: string; contentType?: string; charset?: string; statusCode: number
    headers: Record<string, string>; cookies: Record<string, string>
  }>
  /** `java.net.URL.openConnection` 的出站口：跟重定向、可 GET/POST，走同一个守门 fetcher，不开裸 socket。 */
  fetchConn?: (req: {
    url: string; method?: string; headers?: Record<string, string>; body?: string
  }) => Promise<{
    url: string; statusCode: number; headers: Record<string, string>; cookies: Record<string, string>; body: Uint8Array
  }>
  jsTimeoutMs?: number
  /** 源级 jsLib：全局 JS 函数库——先于每段 @js 代码在同上下文执行（函数定义全局可见） */
  jsLib?: string
  /** 脚本可见的 `book` 变量（书籍身份：bookUrl/name/author…）——目录/正文面由服务层注入 */
  book?: Record<string, unknown>
  /** 脚本可见的 `chapter` 变量（章节身份：title/index/url/baseUrl）——正文面由服务层注入 */
  chapter?: Record<string, unknown>
  /** 登录面投影：source.getLoginInfoMap() 的条目；服务层未接线时缺省空表。 */
  loginInfo?: Record<string, string>
  /** 登录面投影：source.getLoginHeader() 的原始串；缺省空串。 */
  loginHeader?: string
  /** `@webjs:` 规则段：在真浏览器里执行代码并返回字符串（服务层经 WebViewRuntime 接线）。 */
  evalWebJs?: (code: string, baseUrl?: string) => Promise<string>
  /** 宿主设备 ID（androidId 的稳定替代；数据根 device-id 文件生成一次） */
  deviceId?: string
  /** `java.webView(url)`：真浏览器取渲染后 HTML（同步桥，worker SAB） */
  webView?: (url: string) => Promise<string>
  /** 源级状态会话（源变量/cookie 垫片/cache）；服务层可注入落盘实现。 */
  session?: SourceSession
  /** HTTP cookie jar 的脚本读口（`Packages…CookieManager` / `CookieStore`）——与请求自动回带同一张表。 */
  httpCookies?: {
    headerFor(url: string): string
    setCookie(url: string, raw: string): void
    removeSessionCookies(): void
  }
  /** AllInOne 行上下文（**只有**「按整页正则列出的条目」那条链路会带）：字段规则文本里的 `$n` 按本行取值
   *  （`$0` = 整段），在 parseRule 之前绑定。非 AllInOne 的条目没有行 → 缺席，规则原样解析。 */
  regexRow?: string[]
}

/** 脚本预算缺省（`EvalContext.jsTimeoutMs` 缺席时的回退）：与服务缺省 `DEFAULT_JS_BUDGET_MS` 同值，
 *  对齐由 tests/services/defaults.test.ts 钉住。 */
export const DEFAULT_JS_TIMEOUT_MS = 15_000

// ── parseRule 产物 AST ────────────────────────────────────────────────

export type IndexSpec =
  | { kind: 'all' }
  | { kind: 'index'; value: number }
  // 方括号索引区间（`[a:b[:c]]`）：**闭区间**，step 缺省按方向自动（from>to → -1）；负数从尾数。
  // `[-1:0]` = 整表倒序（`tag.div[-1:0]` 可在任意位置让列表反向）
  | { kind: 'range'; from: number; to: number; step?: number }
  // 多条目并集：点号/冒号形态 `.0:2` 与方括号形态 `[0,2]` 都收成它——两条路都是**逐个数字累进**集合，
  // 冒号不是区间符。取位按**插入序**，去重靠 Set、越界静默丢弃。
  | { kind: 'multi'; entries: IndexSpec[] }

export type Segment =
  | { kind: 'default'; mode: string; arg: string | null; index: IndexSpec | null; exclude?: number[] }
  // css 段位置后缀（隐式 CSS 回落 `a.0`/`.odd.0`——选择器 + 取第 n 个；@css: 显式形态恒 null）
  | { kind: 'css'; selector: string; exclude?: number[]; index?: IndexSpec | null }
  | { kind: 'jsonpath'; path: string }
  | { kind: 'xpath'; path: string }
  | { kind: 'allinone'; pattern: string; flags: string }
  | { kind: 'js'; code: string; form: 'at-js' | 'inline' }
  | { kind: 'put'; pairsRaw: string }
  | { kind: 'getvar'; name: string }
  // 模板字面段：URL/文本模板——`{{expr}}` 与 `{$.path}` 插值后整段产出 Value
  | { kind: 'literal'; raw: string }
  // AllInOne 行模板段（矩阵 a-allinone-group-zero）：整支是「行组引用模板」——值 = 用当前行把 `$n` 绑好后
  // 的原文（`$0` = 整段），**不再按规则解析**；没有行时给原文。
  | { kind: 'regexRow'; raw: string }

/** raws 与 segments 一一对应，供错误定位 */
export interface Branch { segments: Segment[]; raws: string[] }

export interface ReplaceStep { pattern: string; flags: string; replacement: string }

export interface ParsedRule {
  branches: Branch[]
  /** 解析时的用途——js 段的 `result` 绑定形态按它决定（列表用途下前段零命中仍是空元素集） */
  usage: RuleUsage
  /** || → 'first'；&& → 'and'；%% → 'zip'；无连接符 → 'first' */
  combinator: 'first' | 'and' | 'zip'
  reverse: boolean
  replaces: ReplaceStep[]
  onlyOne: boolean
}
