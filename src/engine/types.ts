import type { Cheerio } from 'cheerio'
import type { AnyNode } from 'domhandler'

export type Facet = 'search' | 'detail' | 'toc' | 'content' | 'explore' | 'rule'

/** 取值用途（CONTEXT.md「取值用途」）：同一条规则串在「取值」与「列表选择」两种用途下，
 *  链尾未知词的语义不同——legado getString（value）把链尾未知提取指令当 **HTML 属性名**，
 *  getElements（list）把链尾未知选择器按 **CSS** 求值（AnalyzeByJSoup.getResultLast else 分支 vs
 *  ElementsSingle else 分支）。调用方（服务层）按规则用途显式声明；缺省 'list'（与旧口径同）。 */
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
  fetch?: (url: string) => Promise<{ body: string; contentType?: string }>
  /** 二进制抓取（`java.downloadFile` 用）：与 fetch 同请求语义但返回**原始字节**——
   *  经字符集解码链的字符串会损坏 PNG 等二进制（密钥图提取实证）。缺省缺席 → 下载类方法如实报错。 */
  fetchRaw?: (url: string) => Promise<Uint8Array>
  jsTimeoutMs?: number
  /** legado jsLib：源级全局 JS 函数库——先于每段 @js 代码在同上下文执行（函数定义全局可见） */
  jsLib?: string
  /** legado `book` 变量（脚本可见的书籍身份：bookUrl/name/author…）——目录/正文面由服务层注入 */
  book?: Record<string, unknown>
  /** legado `chapter` 变量（脚本可见的章节身份：title/index/url/baseUrl）——正文面由服务层注入 */
  chapter?: Record<string, unknown>
}

export const DEFAULT_JS_TIMEOUT_MS = 2000

// ── parseRule 产物 AST ────────────────────────────────────────────────

export type IndexSpec =
  | { kind: 'all' }
  | { kind: 'index'; value: number }
  | { kind: 'slice'; from: number | null; to: number | null }
  // 方括号索引区间（legado ElementsSingle `[a:b[:c]]` 形态）：**闭区间**（含两端，与 `.` 点号
  // 半开切片不同口径——legado bracket 语义），step 缺省按方向自动（from>to → -1）；负数从尾数。
  // `[-1:0]` = 整表倒序（legado 文档「特殊用法 tag.div[-1:0] 可在任意地方让列表反向」）
  | { kind: 'range'; from: number; to: number; step?: number }

export type Segment =
  | { kind: 'default'; mode: string; arg: string | null; index: IndexSpec | null; exclude?: number[] }
  // css 段位置后缀（隐式 CSS 回落 `a.0`/`.odd.0`——legado 语义：选择器 + 取第 n 个；
  // @css: 显式形态无位置后缀概念，恒 null）
  | { kind: 'css'; selector: string; exclude?: number[]; index?: IndexSpec | null }
  | { kind: 'jsonpath'; path: string }
  | { kind: 'xpath'; path: string }
  | { kind: 'allinone'; pattern: string; flags: string }
  | { kind: 'js'; code: string; form: 'at-js' | 'inline' | 'tail' }
  | { kind: 'put'; pairsRaw: string }
  | { kind: 'getvar'; name: string }
  // 模板字面段（CONTEXT.md「模板字面段」）：URL/文本模板——`{{expr}}`（JS 或规则递归）与
  // `{$.path}`（单括号 JSONPath 内嵌）插值后整段产出 Value（legado SourceRule 的
  // `else -> rule` 字面返回 + makeUpRule 插值语义）
  | { kind: 'literal'; raw: string }

/** raws 与 segments 一一对应，供错误定位 */
export interface Branch { segments: Segment[]; raws: string[] }

export interface ReplaceStep { pattern: string; flags: string; replacement: string }

export interface ParsedRule {
  branches: Branch[]
  /** || → 'first'；&& → 'and'；%% → 'zip'；无连接符 → 'first' */
  combinator: 'first' | 'and' | 'zip'
  reverse: boolean
  /** 求值层消费 */
  replaces: ReplaceStep[]
  onlyOne: boolean
}
