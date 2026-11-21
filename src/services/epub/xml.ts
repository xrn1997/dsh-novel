import { load } from 'cheerio'
import { decodeHTML, decodeHTMLAttribute, decodeHTMLStrict } from 'entities'
import iconv from 'iconv-lite'
import type { AnyNode, CDATA, Element, Text } from 'domhandler'
import { encodingKnown } from '../encoding.js'
import { EpubDocumentError, EpubResourceError, rejectBook } from './errors.js'

/**
 * EPUB 的**只读 XML 面**（包、导航、以及正文层的 XHTML/SVG 共用）：唯一解码入口、静态闸门 + 只读解析、
 * 带单文档预算的 DOM 走法，以及按本地名判定的 DOM 小工具。
 *
 * 为什么单独成层：正文层的文档转换要用**同一套** DOCTYPE/实体门与同一套深度/节点预算。门与预算一旦各抄
 * 一份，两处各改一半——「一半的实体门」等于留一条 XXE 通道，「一半的预算」等于没有预算。
 *
 * ① **解码只按字节事实**：BOM 优先于声明、声明优先于默认 UTF-8，非法字节一律抛（**没有 GBK 猜测链**）。
 * ② **只读解析**：解析前把 HTML 命名实体归一化为数字字符引用（带分号的按内建表、没写分号的按 HTML legacy
 *   表；正文与标签属性各按浏览器的 data / 属性状态读），再过静态闸门（DOCTYPE 带内部子集、实体声明、表外
 *   实体引用一律拒）；无内部子集的标准外部 DOCTYPE 原样留着（解析器忽略它，不会请求远端 DTD）。
 * ③ **单文档 DOM 预算按主语失败**：解码、闸门、解析与深度/节点超限都经唯一 `fail` 出口，按预算的 `subject`
 *   决定半径（包文档＝整本、正文＝那一页、SVG＝那张图，见 `ADR-0063`）。字节预算管不住结构炸弹：约一万层
 *   嵌套（远低于 8 MiB）就能让无预算递归吃穿调用栈抛 `RangeError`（宿主异常，会漏成 500）。
 */

/**
 * 单份 XML 文档的 DOM 预算 + 出错时的点名 + **这份文档是谁**。数字来自 `EpubLimits`（唯一主人，见 `archive.ts`），
 * 本模块不持有上限；`what` 是读者能去翻的书内位置，由调用方带上——只说「DOM 太深」无从知道是哪一份文档。
 * `subject` 决定读不出之后**归谁**（半径见 `ADR-0063`）。为什么在这里声明而不是在 catch 处判：同一套解码与
 * 预算服务三种文档，「谁的主语」在**构造预算的那一处**就定了——留给调用方各自 catch，半径就会由「哪一步被 try
 * 包住」决定（正文层解码失败落空页、预算失败却整本拒）。
 */
export interface XmlBudget {
  /** 出错时点名的书内位置（文档名 + 它是什么文档） */
  readonly what: string
  /** 这份文档归谁：决定读不出之后的半径 */
  readonly subject: XmlSubject
  /** 元素嵌套深度上限（第 depth + 1 层即报错） */
  readonly depth: number
  /** 结构节点（元素与 CDATA 容器）数上限 */
  readonly nodes: number
}

/** 一份被读的文档在书里的身份：包文档 / 正文文档 / SVG 资源 */
export type XmlSubject = 'package' | 'content' | 'resource'

/** 单文档 DOM 预算的数字部分：各层只传数字，点名与主语各自带上（避免标签串在两层各写一遍） */
export interface XmlLimits {
  readonly depth: number
  readonly nodes: number
}

/** 把预算数字、书内位置与主语配成一次遍历的预算对象 */
export function xmlBudget(what: string, limits: XmlLimits, subject: XmlSubject): XmlBudget {
  return { what, subject, depth: limits.depth, nodes: limits.nodes }
}

/**
 * 本层唯一的失败出口：按预算声明的主语给半径——包文档 → 整本拒（`rejectBook`）；正文 → 那一页留空；SVG → 该处不留。
 */
function fail(budget: XmlBudget, message: string): never {
  const text = `${budget.what}：${message}`
  if (budget.subject === 'content') throw new EpubDocumentError(text)
  if (budget.subject === 'resource') throw new EpubResourceError(text)
  rejectBook(text)
}

// ── 解码（唯一入口：包、导航、NCX、XHTML/SVG 都走它）─────────────────────────────

/**
 * XML 声明 / BOM 解码的**唯一入口**。顺序由 XML 规范定：BOM 优先于声明（字节层事实 vs 文本层自述），声明优先于
 * 默认 UTF-8。声明了别的编码就按它解（iconv-lite），**绝无 GBK 猜测链**——TXT 的 GBK 回退是给「不知道编码的
 * 纯文本」的启发式，套到声明明确的 XML 上只会把乱码冒充成正文。解不出合法字符就按预算主语失败：`Buffer.toString`
 * 会把非法字节静默换成 U+FFFD，那正是「坏数据冒充可读」。返回的字符串不含 BOM。
 */
export function decodeEpubXml(bytes: Buffer, budget: XmlBudget): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return decodeStrictUtf8(bytes.subarray(3), budget)
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return iconv.decode(bytes.subarray(2), 'utf16-le')
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return iconv.decode(bytes.subarray(2), 'utf16-be')
  const declared = declaredEncoding(bytes)
  if (declared === null || /^utf-?8$/i.test(declared)) return decodeStrictUtf8(bytes, budget)
  if (!encodingKnown(declared)) fail(budget, `XML 声明的编码不认识（不猜、不回退 GBK）：${declared}`)
  const text = iconv.decode(bytes, declared)
  // iconv 对非法字节给 U+FFFD：声明与字节不符时如实报错，不把替换字符当正文
  if (text.includes('\uFFFD')) fail(budget, `XML 文档按声明编码 ${declared} 解出非法字节（声明与内容不符）`)
  return text
}

function decodeStrictUtf8(bytes: Buffer, budget: XmlBudget): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    fail(budget, 'XML 文档不是合法的 UTF-8（不猜 GBK、不拿替换字符冒充正文）')
  }
}

/** 从字节开头认 XML 声明里的 encoding 取值；`<?xml-stylesheet` 这类 PI 不算（`xml` 后必须是空白或 `?`） */
function declaredEncoding(bytes: Buffer): string | null {
  const head = bytes.subarray(0, 1024).toString('latin1')
  const m = /<\?xml[\s?][^>]*?encoding\s*=\s*["']([^"']+)["']/.exec(head)
  const declared = m === null ? undefined : m[1]
  // 声明里切不出编码名与「没有声明」同路：交给后面的默认 UTF-8，不猜一个编码
  return declared === undefined ? null : declared.trim().toLowerCase()
}

// ── 只读解析 ───────────────────────────────────────────────────────────────────

/**
 * 只读解析：静态闸门 → cheerio 的 XML 模式（htmlparser2）→ 单文档预算检查。
 * 预算在解析出口对**整棵树**做一遍：为什么走法自己带预算了还要查——① 本层文档并不都会被完整遍历（OPF 只顺
 * manifest/spine 直系子元素读），只靠走法计数会漏掉没走到的深/宽分支；② 树形递归不止走法一处（navPoint/li、
 * 条目目标存在性），文档级检查把它们一并框在预算内。
 */
export function parseXml(text: string, budget: XmlBudget): Element {
  const normalized = normalizeHtmlNamedEntities(text, budget)
  scanXml(normalized, budget)
  const doc = load(normalized, { xml: true })
  const roots = (doc.root().get(0)?.children ?? []).filter(isElement)
  const root = roots[0]
  if (root === undefined) fail(budget, '不是可解析的 XML（没有根元素）')
  // 良构 XML 只有一个文档元素，而 xml 模式**不查良构**：多根时只取第一个就是把后面的内容静默丢掉（钉子见
  // tests/services/epub-documents.test.ts 的多根元素那组）。本仓不按半途结果读。
  if (roots.length > 1) {
    fail(budget, `有多个根元素（${roots.length} 个）：畸形 XML 不按半途结果读（只读第一个会静默丢掉后面的内容）`)
  }
  walkTree(roots, budget, NOOP)
  return root
}

/**
 * 把 HTML 命名实体归一化成数字字符引用。XML 只预定义 `amp/lt/gt/quot/apos`；实际 EPUB 常用 `&nbsp;`、`&hellip;`，
 * 而本层不解析 DTD。先转成 `&#x...;` 让 XML 解析器按数值引用统一解码——**不读 DTD、不请求远端、不做递归展开**。
 *
 * 两种写法分开解：**带分号**按内建表严格解；**没写分号**按 HTML legacy 表解，与浏览器同取最长匹配（`&notin`
 * 解成 `¬in`；`&hellip` 连 legacy 前缀都没有，原样留着）。表外带分号的引用不猜，由闸门点名拒绝。
 * **正文与标签分开用浏览器的两套读法**：正文走 data 状态，标签属性走属性状态——后者对无分号写法多一条保护：
 * 后接字母数字或 `=` 时不算引用，否则 `href="?p=1&sect=2"` 会被解成 `?p=1§=2`，链接被悄悄改写。
 * CDATA 与注释里的字样不是引用，整段原样保留；`&amp;nbsp;` 仍只解一层。
 */
function normalizeHtmlNamedEntities(text: string, budget: XmlBudget): string {
  if (!text.includes('&')) return text
  return rewriteSegments(text, budget, {
    plain: (segment) => normalizeEntitySegment(segment, decodeHTML),
    markup: (segment) => normalizeEntitySegment(segment, decodeHTMLAttribute),
  })
}

/** 一段正文或标签里把 HTML 表认得的命名实体转成数字字符引用；`decodeNoSemicolon`：正文按 data 状态、标签按属性状态。 */
function normalizeEntitySegment(segment: string, decodeNoSemicolon: (raw: string) => string): string {
  if (!segment.includes('&')) return segment
  return segment.replace(NAMED_ENTITY, (
    whole: string, name: string | undefined, semicolon: string | undefined, offset: number, source: string,
  ) => {
    if (name === undefined) return whole
    // 带分号且名字是 XML 预定义的：留给解析器（`&amp;` 一旦在这儿解回 `&`，下一轮就成了新引用的开头）
    if (semicolon === ';' && PREDEFINED_ENTITIES.has(name)) return whole
    if (semicolon === ';') {
      const decoded = decodeHTMLStrict(whole)
      return decoded === whole ? whole : numericRefsOf(decoded)
    }
    // 无分号：把后一个字符一并交给解码器——属性状态靠它判「后接字母数字或 `=` 时不算引用」；只交 `&name` 会失去这层保护。
    const probe = whole + source.charAt(offset + whole.length)
    if (decodeNoSemicolon(probe) === probe) return whole
    const decoded = decodeNoSemicolon(whole)
    return decoded === whole ? whole : numericRefsOf(decoded)
  })
}

/** 解出来的字符 → 数字字符引用（XML 不认 HTML 的名字，只认数值形式的字符引用） */
function numericRefsOf(text: string): string {
  let refs = ''
  for (const ch of text) {
    const codePoint = ch.codePointAt(0)
    if (codePoint !== undefined) refs += `&#x${codePoint.toString(16)};`
  }
  return refs
}

/** 三段落改写：`plain` 处理定界符之外的文本、`literal` 整段字面量、`markup` 整段标签（缺省原样返回）。 */
interface SegmentRewrite {
  readonly plain?: (segment: string) => string
  readonly literal?: (segment: string) => string
  readonly markup?: (segment: string) => string
}

/**
 * 把文档切成「正文 / 字面量 / 标签」三类片段再交出去改写。**这份定界符知识只在这里写一遍**：归一化要知道哪些
 * 字样不是引用、哪一段属于属性值，静态闸门要知道哪些不该扫；两处各写一套就会在「哪段算字面量」上分叉。
 * 未闭合的 `<![CDATA[` / `<!--` 当场抛：放过去只会让闸门把字面量里的字样当引用，报一条与事实相反的理由。
 * 标签按「引号里的 `>` 不算结束」切：先按 `>` 断开会把后半个标签当正文，属性值就会被按正文读法解实体。
 */
function rewriteSegments(text: string, budget: XmlBudget, edit: SegmentRewrite): string {
  const plain = edit.plain ?? identity
  const literal = edit.literal ?? identity
  const markup = edit.markup ?? identity
  const out: string[] = []
  let cursor = 0
  while (cursor < text.length) {
    const start = text.indexOf('<', cursor)
    if (start < 0) {
      out.push(plain(text.slice(cursor)))
      break
    }
    if (start > cursor) out.push(plain(text.slice(cursor, start)))
    const closer = literalCloseOf(text, start)
    if (closer !== null) {
      const end = text.indexOf(closer.close, start + closer.open.length)
      if (end < 0) fail(budget, `${closer.open} 没有闭合的 ${closer.close}（未闭合的字面量不是良构 XML）`)
      const stop = end + closer.close.length
      out.push(literal(text.slice(start, stop)))
      cursor = stop
      continue
    }
    const stop = tagEndOf(text, start)
    if (stop < 0) {
      // 没有 `>` 的尾部不是本层能判的标签：原样留在正文段里，畸形由解析器报
      out.push(plain(text.slice(start)))
      break
    }
    out.push(markup(text.slice(start, stop)))
    cursor = stop
  }
  return out.join('')
}

/** 这个 `<` 是否开了一段字面量；是则给出它的收口 */
function literalCloseOf(text: string, start: number): { readonly open: string; readonly close: string } | null {
  if (text.startsWith('<![CDATA[', start)) return { open: '<![CDATA[', close: ']]>' }
  if (text.startsWith('<!--', start)) return { open: '<!--', close: '-->' }
  return null
}

/** 标签段的结束位置（`>` 之后）；引号里的 `>` 不算，找不到 `>` 给 -1 */
function tagEndOf(text: string, start: number): number {
  let quote = ''
  for (let i = start + 1; i < text.length; i += 1) {
    const ch = text.charAt(i)
    if (quote !== '') {
      if (ch === quote) quote = ''
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (ch === '>') {
      return i + 1
    }
  }
  return -1
}

const identity = (s: string): string => s

/**
 * 只读解析的四条静态闸门（都在解析之前判）：
 * ① CDATA 段与**注释**先摘掉——里面的 `&x;` / `<!ENTITY` / `<!DOCTYPE` 是字面文本；字面量没闭合就地拒。
 * ② DOCTYPE 带内部子集 → 拒（实体声明与属性默认值都在里面）；③ 出现 `<!ENTITY` → 拒（XXE 与 billion-laughs 入口）；
 * ④ 归一化之后，除 XML 预定义实体与数值字符引用之外的实体引用 → 拒（内建 HTML 表之外的名字不猜、不静默丢）。
 * 命名空间：cheerio 的 XML 模式保留前缀原样，不做命名空间解析，所以本层一律按**本地名**判定（`opf:package`
 * 与 `package` 等价）——前缀是书写者的自由，绑定到哪个命名空间才是身份。
 */
function scanXml(text: string, budget: XmlBudget): void {
  const body = stripLiterals(text, budget)
  const doctype = body.indexOf('<!DOCTYPE')
  if (doctype >= 0) {
    const gt = body.indexOf('>', doctype)
    const bracket = body.indexOf('[', doctype)
    if (bracket >= 0 && (gt < 0 || bracket < gt)) fail(budget, 'DOCTYPE 带内部子集（实体声明与属性默认值本层不解析）')
  }
  if (body.includes('<!ENTITY')) fail(budget, '含实体声明（本层不解析 DTD 实体，也不做实体展开）')
  for (const m of body.matchAll(ENTITY_REF)) {
    const name = m[1]
    // 捕获必齐（正则只有一个分组）：缺了就是这条闸自己的判据坏了——照「宁炸不猜」抛，不静默放行未声明的引用。
    if (name === undefined) fail(budget, '实体闸判据失效（引用未解析出名字，正则分组变了？）')
    if (name.startsWith('#')) continue   // 数值字符引用：与 DTD 无关，XML 规范直接成立
    if (!PREDEFINED_ENTITIES.has(name)) fail(budget, `引用了不在内建 HTML 命名实体表里的实体 &${name};（本层不解析 DTD）`)
  }
}

/**
 * 摘掉 CDATA 段与注释。注释也必须摘：规范允许注释里出现任何文本，里面的 `&nbsp;` 不是引用——按引用判会把一份
 * 本来可读的书整本拒掉。定界符与「未闭合就拒」归 `rewriteSegments`，这里只管把字面量整段丢掉。
 */
function stripLiterals(text: string, budget: XmlBudget): string {
  return rewriteSegments(text, budget, { literal: () => '' })
}

const ENTITY_REF = /&([A-Za-z_][\w.-]*|#[0-9]+|#x[0-9A-Fa-f]+);/g
/** 命名实体引用：分号可有——没写分号的按 HTML legacy 表解。名字只收 ASCII 字母数字（HTML 实体名没有标点；
 *  收进 `.`/`-` 会把 `&copy.;` 吞成 `copy.`，查表失败后整本被拒，而浏览器读作 `©.;`）。 */
const NAMED_ENTITY = /&([A-Za-z][A-Za-z0-9]*)(;?)/g
const PREDEFINED_ENTITIES = new Set(['amp', 'lt', 'gt', 'quot', 'apos'])
const NOOP = (): void => {}

// ── 带预算的 DOM 走法 ──────────────────────────────────────────────────────────

/**
 * 元素树的一次深度优先走法：**深度与节点预算的唯一执行点**（`descendants`/`textOf`/解析出口都走它）。深度在
 * **进层之前**判、节点在访问时判，畸形文档按预算主语失败而不是等递归把栈吃穿。共用的只是 `domCounter` 那一份
 * 阈值与报错，「数哪些节点」随走法不同：本函数只数元素，`textOf` 另数 CDATA 容器（取文本必需的访问）。
 */
function walkTree(roots: readonly Element[], budget: XmlBudget, visit: (el: Element, depth: number) => void): void {
  const enter = domCounter(budget)
  const walk = (el: Element, depth: number): void => {
    enter(depth)
    visit(el, depth)
    for (const child of el.children) if (isElement(child)) walk(child, depth + 1)
  }
  for (const root of roots) walk(root, 1)
}

/** 单次走法的深度/节点计数（`walkTree` 与 `textOf` 共用，避免两处各写一份判据） */
function domCounter(budget: XmlBudget): (depth: number) => void {
  let nodes = 0
  return (depth: number): void => {
    if (depth > budget.depth) {
      fail(budget, `DOM 嵌套深度超过上限 ${budget.depth} 层（第 ${depth} 层）：畸形文档不按半途结果读`)
    }
    nodes += 1
    if (nodes > budget.nodes) {
      fail(budget, `DOM 节点数超过上限 ${budget.nodes} 个：畸形文档不按半途结果读`)
    }
  }
}

/** 后代里的全部 `local` 元素（文档序；**不含**入参自己，与本层既有语义一致） */
export function descendants(root: Element, local: string, budget: XmlBudget): Element[] {
  const out: Element[] = []
  walkTree([root], budget, (el) => {
    if (el !== root && localName(el.name) === local) out.push(el)
  })
  return out
}

export function firstDescendant(root: Element, local: string, budget: XmlBudget): Element | null {
  const list = descendants(root, local, budget)
  const first = list[0]
  return first === undefined ? null : first
}

/** 子树里的全部文本（文档序拼接）。CDATA 在 domhandler 里是**容器**节点，统一往 `children` 里走：内容按字面文本取，不再当实体/声明看（闸门也先摘 CDATA，两侧口径一致）。 */
export function textOf(node: { readonly children: AnyNode[] }, budget: XmlBudget): string {
  const enter = domCounter(budget)
  const out: string[] = []
  const walk = (n: { readonly children: AnyNode[] }, depth: number): void => {
    enter(depth)
    for (const child of n.children) {
      if (isTextNode(child)) out.push(child.data)
      else if (isCdataNode(child) || isElement(child)) walk(child, depth + 1)
    }
  }
  walk(node, 1)
  return out.join('')
}

// ── DOM 小工具（一律按本地名判定）──────────────────────────────────────────────

/** 元素名 / 属性名的本地名：丢掉命名空间前缀（`opf:item` → `item`） */
export function localName(name: string): string {
  const colon = name.lastIndexOf(':')
  return colon < 0 ? name : name.slice(colon + 1)
}

/** 节点类型码。domhandler 的节点类型是**字符串枚举**，枚举成员与字面量直接比会被判成跨枚举比较，故统一在字符串面上比（同 engine/xpath.ts）。与 `isTag` 不等价：`isTag` 还认 script/style，这里只认纯元素。 */
const nodeType = (n: AnyNode): string => n.type

/** 纯元素 / 文本节点 / CDATA 容器（判据见上面 nodeType：三者按节点类型码的字面量判定） */
export function isElement(node: AnyNode): node is Element {
  return nodeType(node) === 'tag'
}

export function isTextNode(node: AnyNode): node is Text {
  return nodeType(node) === 'text'
}

export function isCdataNode(node: AnyNode): node is CDATA {
  return nodeType(node) === 'cdata'
}

/** 直系子元素里 `local` 的那些（不递归：这一层只做一层判定，深走法归 `descendants`） */
export function childElements(parent: Element, local: string): Element[] {
  const out: Element[] = []
  for (const child of parent.children) if (isElement(child) && localName(child.name) === local) out.push(child)
  return out
}

export function firstChild(parent: Element, local: string): Element | null {
  const list = childElements(parent, local)
  const first = list[0]
  return first === undefined ? null : first
}

/** 属性按本地名取（`epub:type` 与 `type` 都算 `type`）：同名多写时取靠前那个 */
export function attrOf(el: Element, local: string): string | null {
  for (const [name, value] of Object.entries(el.attribs)) if (localName(name) === local) return value
  return null
}
