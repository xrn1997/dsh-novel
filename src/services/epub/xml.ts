import { load } from 'cheerio'
import { decodeHTML, decodeHTMLAttribute, decodeHTMLStrict } from 'entities'
import iconv from 'iconv-lite'
import type { AnyNode, CDATA, Element, Text } from 'domhandler'
import { encodingKnown } from '../encoding.js'
import { EpubImportError } from './errors.js'

/**
 * EPUB 的**只读 XML 面**（包、导航、以及正文层的 XHTML/SVG 共用）：唯一解码入口、静态闸门 +
 * 只读解析、带单文档预算的 DOM 走法，以及按本地名判定的 DOM 小工具。
 *
 * 为什么单独成一层，而不是留在包层：正文层的文档转换要用**同一套** DOCTYPE/实体门与同一套
 * 深度/节点预算。门与预算一旦各抄一份，两处就会各改一半——而「一半的实体门」等于留一条 XXE 通道，
 * 「一半的预算」等于没有预算（本仓对「只改一半」的警戒就是这么来的）。
 *
 * 三条口径（改动这一层先读它们）：
 *
 * ① **解码只按字节事实**：BOM 优先于声明、声明优先于默认 UTF-8，非法字节一律抛（**没有 GBK 猜测链**）。
 * ② **只读解析**：解析前先把 HTML 命名实体归一化为数字字符引用（带分号的按内建表、没写分号的按
 *    HTML 的 legacy 表；正文与标签属性各按浏览器的 data / 属性状态读——都不解析 DTD、不请求远端），
 *    再过静态闸门（DOCTYPE 带内部子集、实体声明、表外实体引用一律拒）；
 *    无内部子集的标准外部 DOCTYPE 原样留着——解析器忽略它，也就不存在请求远端 DTD 的动作。
 * ③ **单文档 DOM 预算**：深度与结构节点数超限即抛 `EpubImportError`，而不是递归到栈溢出。
 *    字节预算管不住「结构炸弹」：约一万层嵌套（远低于 8 MiB）就足以让无预算的递归吃穿调用栈抛
 *    `RangeError`——那是宿主异常，服务层按类分流时会把它漏成 500。
 */

/**
 * 单份 XML 文档的 DOM 预算 + 出错时的点名。
 *
 * 数字来自 `EpubLimits`（**唯一主人**，见 `archive.ts`），本模块不持有任何上限值；`what` 是读者
 * 能去翻的书内位置（`OPF 包文档 OEBPS/content.opf` 这类），由调用方带上——只说「DOM 太深」
 * 无从知道是哪一份文档，畸形文档的报错也就没法定位。
 */
export interface XmlBudget {
  /** 出错时点名的书内位置（文档名 + 它是什么文档） */
  readonly what: string
  /** 元素嵌套深度上限（第 depth + 1 层即报错） */
  readonly depth: number
  /** 结构节点（元素与 CDATA 容器）数上限 */
  readonly nodes: number
}

/** 单文档 DOM 预算的数字部分：各层只传数字，点名各自带上（避免标签串在两层各写一遍） */
export interface XmlLimits {
  readonly depth: number
  readonly nodes: number
}

/** 把预算数字与书内位置配成一次遍历的预算对象 */
export function xmlBudget(what: string, limits: XmlLimits): XmlBudget {
  return { what, depth: limits.depth, nodes: limits.nodes }
}

// ── 解码（唯一入口：包、导航、NCX、XHTML/SVG 都走它）─────────────────────────────

/**
 * XML 声明 / BOM 解码的**唯一入口**。
 *
 * 顺序是 XML 规范定的：BOM 优先于声明（BOM 是字节层的事实，声明是文本层的自述），声明又优先于
 * 「默认 UTF-8」。声明了别的编码就按它解（iconv-lite），**绝无 GBK 猜测链**——TXT 的 GBK 回退是
 * 为「不知道编码的纯文本」准备的启发式，套到声明明确的 XML 上只会把乱码冒充成正文。
 * 解不出合法字符就抛：`Buffer.toString('utf8')` 会把非法字节静默换成 U+FFFD，那正是本仓最忌的
 * 「坏数据冒充可读」。返回的字符串不含 BOM。
 */
export function decodeEpubXml(bytes: Buffer): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return decodeStrictUtf8(bytes.subarray(3))
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return iconv.decode(bytes.subarray(2), 'utf16-le')
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return iconv.decode(bytes.subarray(2), 'utf16-be')
  const declared = declaredEncoding(bytes)
  if (declared === null || /^utf-?8$/i.test(declared)) return decodeStrictUtf8(bytes)
  if (!encodingKnown(declared)) throw new EpubImportError(`XML 声明的编码不认识（不猜、不回退 GBK）：${declared}`)
  const text = iconv.decode(bytes, declared)
  // iconv 对非法字节给 U+FFFD：声明与字节不符时如实报错，不把替换字符当正文
  if (text.includes('\uFFFD')) throw new EpubImportError(`XML 文档按声明编码 ${declared} 解出非法字节（声明与内容不符）`)
  return text
}

function decodeStrictUtf8(bytes: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new EpubImportError('XML 文档不是合法的 UTF-8（不猜 GBK、不拿替换字符冒充正文）')
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
 *
 * 预算在解析出口对**整棵树**（含多根片段的每一根）做一遍深度/节点计数：结构合规的文档才允许被
 * 后续走法消费。为什么走法自己带预算了还要在这里查一遍——两件事：
 * ① 本层的文档并不都会被完整遍历（OPF 只顺着 manifest/spine 的直系子元素读），只靠走法自己的计数
 *    会漏掉「从没被走到」的深/宽分支；
 * ② 树形递归不止走法一处（目录树的 navPoint/li 递归、条目目标的存在性递归），文档级检查把它们
 *    一并框在预算内，不必每处再各配一套计数。
 */
export function parseXml(text: string, budget: XmlBudget): Element {
  const normalized = normalizeHtmlNamedEntities(text, budget.what)
  scanXml(normalized, budget.what)
  const doc = load(normalized, { xml: true })
  const roots = (doc.root().get(0)?.children ?? []).filter(isElement)
  const root = roots[0]
  if (root === undefined) throw new EpubImportError(`${budget.what} 不是可解析的 XML（没有根元素）`)
  // 良构 XML 只有一个文档元素，而这里的解析面（`load` 的 xml 模式）**不查良构**，多根时它把每根都交出来，
  // 只取第一个就是把后面的内容静默丢掉（两份 <html> 拼接的文件只留下前半——钉子见
  // `tests/services/epub-documents.test.ts` 的多根元素那一组）。本仓不按半途结果读。
  if (roots.length > 1) {
    throw new EpubImportError(
      `${budget.what} 有多个根元素（${roots.length} 个）：畸形 XML 不按半途结果读（只读第一个会静默丢掉后面的内容）`,
    )
  }
  walkTree(roots, budget, NOOP)
  return root
}

/**
 * 把 HTML 命名实体归一化成数字字符引用。
 *
 * XML 只预定义 `amp/lt/gt/quot/apos`；实际 EPUB 常用 `&nbsp;`、`&hellip;` 这类 HTML 命名实体，
 * 而本层不解析 DTD。这里先把它们转成 `&#x...;`，让 XML 解析器按数值引用统一解码
 * ——**不读 DTD、不请求远端、不做递归展开**，安全面与静态闸门不变。
 *
 * 两种写法分开解：**带分号**的按内建表严格解（`&hellip;` 这种靠 DTD 才成立的名字也认得）；
 * **没写分号**的按 HTML 的 legacy 表解——`&nbsp` 与 `&nbsp;` 同解，且与浏览器同取最长匹配
 * （`&notin` 解成 `¬in`；`&hellip` 连 legacy 前缀都没有，原样留着）。取「浏览器怎么读就怎么读」
 * 是因为这一层的读者正是渲染这本书的浏览器；表外且带分号的引用不猜，由闸门点名拒绝。
 *
 * **正文与标签分开用浏览器的两套读法**：正文走 HTML 的 data 状态，标签（属性值）走属性状态——
 * 后者对无分号写法多一条保护：后接字母数字或 `=` 时不算引用。少了这条，`href="?p=1&sect=2"`
 * 会被解成 `?p=1§=2`（浏览器不会），链接就这样被悄悄改写。
 *
 * CDATA 与注释里的字样不是引用，整段原样保留；`&amp;nbsp;` 仍只解一层（`&amp;` 保持预定义实体，
 * 后面的 `nbsp;` 是字面文本）。
 */
function normalizeHtmlNamedEntities(text: string, what: string): string {
  if (!text.includes('&')) return text
  return rewriteSegments(text, what, {
    plain: (segment) => normalizeEntitySegment(segment, decodeHTML),
    markup: (segment) => normalizeEntitySegment(segment, decodeHTMLAttribute),
  })
}

/** 一段正文或标签里把 HTML 表认得的命名实体转成数字字符引用；`decodeNoSemicolon` 是无分号写法
 *  用的那套读法：正文按 data 状态、标签按属性状态（见 `normalizeHtmlNamedEntities`）。 */
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
    // 无分号：把后一个字符一并交给解码器——属性状态靠它判「后接字母数字或 `=` 时不算引用」。
    // 只把 `&name` 这一截交进去，解码器看见的是串尾，保护规则就失效了。
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

/** 三段落改写：`plain` 处理定界符之外的文本，`literal` 处理整段字面量，`markup` 处理整段标签
 *  （含尖括号；缺省都原样返回） */
interface SegmentRewrite {
  readonly plain?: (segment: string) => string
  readonly literal?: (segment: string) => string
  readonly markup?: (segment: string) => string
}

/**
 * 把文档切成「正文 / 字面量 / 标签」三类片段再交出去改写。
 *
 * **这份定界符知识只在这里写一遍**：归一化要知道哪些字样不是引用、哪一段属于属性值，静态闸门要知道
 * 哪些不该扫；两处各写一套就会在「哪段算字面量」上分叉，而分叉的那一半必然是误判。
 *
 * 未闭合的 `<![CDATA[` / `<!--` 当场抛：它不是良构 XML，放过去只会让闸门把字面量里的字样当引用，
 * 报出一条与事实相反的理由（`&nbsp;` 明明在内建表里）。边界只能靠猜的东西不猜。
 * 标签按「引号里的 `>` 不算结束」切：XML 的属性值允许出现裸 `>`，先按 `>` 断开就会把后半个标签
 * 当正文——那半截里的属性值会被按正文的读法解实体。
 */
function rewriteSegments(text: string, what: string, edit: SegmentRewrite): string {
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
      if (end < 0) throw new EpubImportError(`${what}：${closer.open} 没有闭合的 ${closer.close}（未闭合的字面量不是良构 XML）`)
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
 * 只读解析的四条静态闸门（都在解析之前判，静态文本层面）：
 * ① CDATA 段与**注释**先摘掉——里面的 `&x;` / `<!ENTITY` / `<!DOCTYPE` 是字面文本，不是声明也不是引用；
 *    字面量没闭合就地拒（它的边界只能猜，而边界猜错就是内容错）；
 * ② DOCTYPE 带内部子集 → 拒（实体声明与属性默认值都在里面，本层一律不认）；
 * ③ 出现 `<!ENTITY` → 拒（外部实体是 XXE 的入口，实体展开是 billion-laughs 的入口）；
 * ④ 归一化之后，除 XML 预定义实体与数值字符引用之外的实体引用 → 拒（内建 HTML 表之外的名字，
 *    本层不解析 DTD，认不出它就如实报错，不猜也不静默丢掉）。
 *
 * 命名空间：cheerio 的 XML 模式保留前缀原样，不做命名空间解析，所以本层一律按**本地名**判定
 * （`opf:package` 与 `package` 等价）——前缀是书写者的自由，绑定到哪个命名空间才是身份。
 */
function scanXml(text: string, what: string): void {
  const body = stripLiterals(text, what)
  const doctype = body.indexOf('<!DOCTYPE')
  if (doctype >= 0) {
    const gt = body.indexOf('>', doctype)
    const bracket = body.indexOf('[', doctype)
    if (bracket >= 0 && (gt < 0 || bracket < gt)) throw new EpubImportError(`${what}：DOCTYPE 带内部子集（实体声明与属性默认值本层不解析）`)
  }
  if (body.includes('<!ENTITY')) throw new EpubImportError(`${what}：含实体声明（本层不解析 DTD 实体，也不做实体展开）`)
  for (const m of body.matchAll(ENTITY_REF)) {
    const name = m[1]
    // 捕获必齐（正则只有一个分组）：缺了就是这条闸自己的判据坏了——照「宁炸不猜」抛，
    // 不按「非内建实体」拒整本，也不能静默放行未声明的引用。
    if (name === undefined) throw new EpubImportError(`${what}：实体闸判据失效（引用未解析出名字，正则分组变了？）`)
    if (name.startsWith('#')) continue   // 数值字符引用：与 DTD 无关，XML 规范直接成立
    if (!PREDEFINED_ENTITIES.has(name)) throw new EpubImportError(`${what}：引用了不在内建 HTML 命名实体表里的实体 &${name};（本层不解析 DTD）`)
  }
}

/**
 * 摘掉 CDATA 段与注释。注释也必须摘：XML 规范允许注释里出现任何文本，`<!-- 删掉的段落 &nbsp; -->`
 * 里的 `&nbsp;` 不是实体引用——按引用判会把一份本来可读的书整本拒掉。
 * 定界符与「未闭合就拒」的判定全归 `rewriteSegments`，这里只管把字面量整段丢掉。
 */
function stripLiterals(text: string, what: string): string {
  return rewriteSegments(text, what, { literal: () => '' })
}

const ENTITY_REF = /&([A-Za-z_][\w.-]*|#[0-9]+|#x[0-9A-Fa-f]+);/g
/** 命名实体引用：分号可有——没写分号的形态按 HTML 的 legacy 表解（见 `normalizeEntitySegment`）。
 *  名字只收 ASCII 字母数字：HTML 的实体名没有标点；收进 `.`/`-` 会把 `&copy.;` 吞成 `copy.`，
 *  查表失败后整本被闸门拒掉，而浏览器读作 `©.;`。 */
const NAMED_ENTITY = /&([A-Za-z][A-Za-z0-9]*)(;?)/g
const PREDEFINED_ENTITIES = new Set(['amp', 'lt', 'gt', 'quot', 'apos'])
const NOOP = (): void => {}

// ── 带预算的 DOM 走法 ──────────────────────────────────────────────────────────

/**
 * 元素树的一次深度优先走法：**深度与节点预算的唯一执行点**（`descendants`/`textOf`/解析出口都走它）。
 *
 * 深度在**进层之前**判、节点在访问时判，所以畸形文档在这里拿到 `EpubImportError`，而不是等递归
 * 把栈吃穿。**共用的只是 `domCounter` 那一份阈值与报错**，「数哪些节点」随走法不同：本函数只数
 * 元素（文本挂在元素上，元素数已把结构规模钉住），`textOf` 另把 CDATA 容器也数一次——那是它取文本
 * 必需的访问（CDATA 是容器不是文本）。两者不冲突：CDATA 容器不能互相嵌套、深度由元素驱动，
 * 所以同一条预算在两处都框得住同一份文档。
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
      throw new EpubImportError(`${budget.what} 的 DOM 嵌套深度超过上限 ${budget.depth} 层（第 ${depth} 层）：畸形文档不按半途结果读`)
    }
    nodes += 1
    if (nodes > budget.nodes) {
      throw new EpubImportError(`${budget.what} 的 DOM 节点数超过上限 ${budget.nodes} 个：畸形文档不按半途结果读`)
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

/**
 * 子树里的全部文本（按文档序拼接）。CDATA 在 domhandler 里是**容器**节点（文本挂在它的子节点上），
 * 所以统一往 `children` 里走：CDATA 里的内容按字面文本取，不再当实体/声明看
 * （静态闸门也先把 CDATA 段摘掉再扫，两侧口径一致）。
 */
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

/** 节点类型码。domhandler 的节点类型是**字符串枚举**（运行时取值就是 `'tag'` / `'text'` 这些字面量），
 *  枚举成员与字面量直接比会被判成跨枚举比较，故统一在字符串面上比较（同 engine/xpath.ts 的 nodeType）。
 *  与 domhandler 的 `isTag` 不等价：`isTag` 还认 script/style，而这里只认纯元素。 */
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
