import type { Cheerio } from 'cheerio'
import type { AnyNode } from 'domhandler'

export type Facet = 'search' | 'detail' | 'toc' | 'content' | 'explore' | 'rule'

/** 取值用途（CONTEXT.md「取值用途」）：同一条规则串在「取值」与「列表选择」两种用途下，
 *  链尾未知词的语义不同——取值用途（value）把链尾未知提取指令当 **HTML 属性名**，
 *  列表用途（list）把链尾未知选择器按 **CSS** 求值。
 *  调用方（服务层）按规则用途显式声明；缺省 'list'（与旧口径同）。 */
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
  vars?: Record<string, string>
  /** 变量链的 **source 层**（跨门面调用、按源隔离；由 js-sandbox 从 SourceSession 接线）。
   *  读序 chapter→book→ruleData→source，每级空串继续下找。
   *  本仓 `vars` = 本次调用的 ruleData/chapter 层，`sourceVar` = source 层的只读访问器；
   *  chapter/book 两层要持久化宿主，未接 → 矩阵 `a-var-scope-chain` 仍记开口。 */
  sourceVar?: (key: string) => string | undefined
  /** 引擎出站口（`java.ajax` / `java.connect` 用）。`finalUrl` = 跟随重定向后的落地地址
   *  （实现见 `services/engine-fetch.ts`）；缺席时桥按请求地址兜底（假的 fetch 桩不必带）。 */
  fetch?: (url: string) => Promise<{ body: string; contentType?: string; finalUrl?: string }>
  /** 本仓**实际出站**的 User-Agent（惰性取，源规则可覆盖）。给"我们真发出去的那条 UA"
   *  是**近似**而非等价：本仓没有 WebView 的默认 UA 可取，未接线时桥点名抛错而不编一个值
   *  （矩阵 `h-java-webview-ua`）。 */
  userAgent?: () => string
  /** 二进制抓取（`java.downloadFile` 用）：与 fetch 同请求语义但返回**原始字节**——
   *  经字符集解码链的字符串会损坏 PNG 等二进制（密钥图提取实证）。缺省缺席 → 下载类方法如实报错。 */
  fetchRaw?: (url: string) => Promise<Uint8Array>
  /** `java.post(url, body, headers)` 的出站口（实现在
   *  `services/engine-fetch.ts` 的 engineFetchPost——**同一个守门 fetcher**，不开第二出口）。 */
  fetchPost?: (url: string, body: string, headers?: Record<string, string>) => Promise<{
    url: string; body: string; contentType?: string; statusCode: number; cookies: Record<string, string>
  }>
  jsTimeoutMs?: number
  /** 源级 jsLib：全局 JS 函数库——先于每段 @js 代码在同上下文执行（函数定义全局可见） */
  jsLib?: string
  /** 脚本可见的 `book` 变量（书籍身份：bookUrl/name/author…）——目录/正文面由服务层注入 */
  book?: Record<string, unknown>
  /** 脚本可见的 `chapter` 变量（章节身份：title/index/url/baseUrl）——正文面由服务层注入 */
  chapter?: Record<string, unknown>
}

export const DEFAULT_JS_TIMEOUT_MS = 2000

// ── parseRule 产物 AST ────────────────────────────────────────────────

export type IndexSpec =
  | { kind: 'all' }
  | { kind: 'index'; value: number }
  // 方括号索引区间（`[a:b[:c]]` 形态）：**闭区间**（含两端），
  // step 缺省按方向自动（from>to → -1）；负数从尾数。
  // `[-1:0]` = 整表倒序（`tag.div[-1:0]` 可在任意位置让列表反向）
  | { kind: 'range'; from: number; to: number; step?: number }
  // 多条目并集：点号/冒号形态 `.0:2` 与方括号形态 `[0,2]` 都收成它——
  // `.`/`:`/`!` 与 `[a,b]` 两条路都是**逐个数字累进**集合，冒号不是区间符。
  // 取位按**插入序** ⇒ **写入序**，去重靠 Set、越界静默丢弃。
  | { kind: 'multi'; entries: IndexSpec[] }

export type Segment =
  | { kind: 'default'; mode: string; arg: string | null; index: IndexSpec | null; exclude?: number[] }
  // css 段位置后缀（隐式 CSS 回落 `a.0`/`.odd.0`——选择器 + 取第 n 个；
  // @css: 显式形态无位置后缀概念，恒 null）
  | { kind: 'css'; selector: string; exclude?: number[]; index?: IndexSpec | null }
  | { kind: 'jsonpath'; path: string }
  | { kind: 'xpath'; path: string }
  | { kind: 'allinone'; pattern: string; flags: string }
  | { kind: 'js'; code: string; form: 'at-js' | 'inline' }
  | { kind: 'put'; pairsRaw: string }
  | { kind: 'getvar'; name: string }
  // 模板字面段（CONTEXT.md「模板字面段」）：URL/文本模板——`{{expr}}`（JS 或规则递归）与
  // `{$.path}`（单括号 JSONPath 内嵌）插值后整段产出 Value（整段字面返回 + 插值语义）
  | { kind: 'literal'; raw: string }

/** raws 与 segments 一一对应，供错误定位 */
export interface Branch { segments: Segment[]; raws: string[] }

export interface ReplaceStep { pattern: string; flags: string; replacement: string }

export interface ParsedRule {
  branches: Branch[]
  /** 解析时的用途（列表 / 取值两条路径的身份）——js 段的 `result`
   *  绑定形态按它决定：列表用途下前段零命中仍是空元素集，取值用途下仍是字符串 */
  usage: RuleUsage
  /** || → 'first'；&& → 'and'；%% → 'zip'；无连接符 → 'first' */
  combinator: 'first' | 'and' | 'zip'
  reverse: boolean
  /** 求值层消费 */
  replaces: ReplaceStep[]
  onlyOne: boolean
}
