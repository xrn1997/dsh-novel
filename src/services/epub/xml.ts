import { load } from 'cheerio'
import iconv from 'iconv-lite'
import type { AnyNode, Element } from 'domhandler'
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
 * ② **只读解析**：解析前过静态闸门（DOCTYPE 带内部子集、实体声明、未声明的实体引用一律拒）；
 *    无内部子集的标准外部 DOCTYPE 原样留着——解析器忽略它，也就不存在请求远端 DTD 的动作。
 * ③ **单文档 DOM 预算**：深度与结构节点数超限即抛 `EpubImportError`，而不是递归到栈溢出。
 *    字节预算管不住「结构炸弹」：实测约一万层嵌套（108 KB，远低于 8 MiB）就足以让无预算的递归走法
 *    吃穿调用栈抛 `RangeError`——那是宿主异常，不是本子树的异常类，服务层按类分流时会把它漏成 500。
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
  if (!iconv.encodingExists(declared)) throw new EpubImportError(`XML 声明的编码不认识（不猜、不回退 GBK）：${declared}`)
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
  return m === null ? null : m[1].trim().toLowerCase()
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
  scanXml(text, budget.what)
  const doc = load(text, { xml: true })
  const roots = (doc.root().get(0)?.children ?? []).filter(isElement)
  if (roots.length === 0) throw new EpubImportError(`${budget.what} 不是可解析的 XML（没有根元素）`)
  // 良构 XML 只有一个文档元素。解析器（htmlparser2 的 xml 模式）**不查良构**，多根时它把每根都交出来，
  // 只取第一个就是把后面的内容静默丢掉（实测：两份 <html> 拼接的文件只留下前半）。本仓不按半途结果读。
  if (roots.length > 1) {
    throw new EpubImportError(
      `${budget.what} 有多个根元素（${roots.length} 个）：畸形 XML 不按半途结果读（只读第一个会静默丢掉后面的内容）`,
    )
  }
  walkTree(roots, budget, NOOP)
  return roots[0]
}

/**
 * 只读解析的四条静态闸门（都在解析之前判，静态文本层面）：
 * ① CDATA 段与**注释**先摘掉——里面的 `&x;` / `<!ENTITY` / `<!DOCTYPE` 是字面文本，不是声明也不是引用；
 * ② DOCTYPE 带内部子集 → 拒（实体声明与属性默认值都在里面，本层一律不认）；
 * ③ 出现 `<!ENTITY` → 拒（外部实体是 XXE 的入口，实体展开是 billion-laughs 的入口）；
 * ④ 除 XML 预定义实体与数值字符引用之外的实体引用 → 拒（`&nbsp;` 这类要靠 DTD 才成立，
 *    本层不解析 DTD，认不出它就如实报错，不猜也不静默丢掉）。
 *
 * 命名空间：cheerio 的 XML 模式保留前缀原样，不做命名空间解析，所以本层一律按**本地名**判定
 * （`opf:package` 与 `package` 等价）——前缀是书写者的自由，绑定到哪个命名空间才是身份。
 */
function scanXml(text: string, what: string): void {
  const body = stripLiterals(text)
  const doctype = body.indexOf('<!DOCTYPE')
  if (doctype >= 0) {
    const gt = body.indexOf('>', doctype)
    const bracket = body.indexOf('[', doctype)
    if (bracket >= 0 && (gt < 0 || bracket < gt)) throw new EpubImportError(`${what}：DOCTYPE 带内部子集（实体声明与属性默认值本层不解析）`)
  }
  if (body.includes('<!ENTITY')) throw new EpubImportError(`${what}：含实体声明（本层不解析 DTD 实体，也不做实体展开）`)
  for (const m of body.matchAll(ENTITY_REF)) {
    const name = m[1]
    if (name.startsWith('#')) continue   // 数值字符引用：与 DTD 无关，XML 规范直接成立
    if (!PREDEFINED_ENTITIES.has(name)) throw new EpubImportError(`${what}：引用了未声明的实体 &${name};（本层不解析 DTD）`)
  }
}

/**
 * 摘掉 CDATA 段与注释。注释也必须摘：XML 规范允许注释里出现任何文本，`<!-- 删掉的段落 &nbsp; -->`
 * 里的 `&nbsp;` 不是实体引用——按引用判会把一份本来可读的书整本拒掉（实测）。未闭合的 `<!--`
 * 正则匹配不到，原样留给闸门：认不出就不猜。
 */
function stripLiterals(text: string): string {
  return text.replace(PRE, '').replace(COMMENT, '')
}

const PRE = /<!\[CDATA\[[\s\S]*?\]\]>/g
const COMMENT = /<!--[\s\S]*?-->/g
const ENTITY_REF = /&([A-Za-z_][\w.-]*|#[0-9]+|#x[0-9A-Fa-f]+);/g
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
  return list.length === 0 ? null : list[0]
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
      if (child.type === 'text') out.push(child.data)
      else if (child.type === 'cdata' || isElement(child)) walk(child, depth + 1)
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

export function isElement(node: AnyNode): node is Element {
  return node.type === 'tag'
}

/** 直系子元素里 `local` 的那些（不递归：这一层只做一层判定，深走法归 `descendants`） */
export function childElements(parent: Element, local: string): Element[] {
  const out: Element[] = []
  for (const child of parent.children) if (isElement(child) && localName(child.name) === local) out.push(child)
  return out
}

export function firstChild(parent: Element, local: string): Element | null {
  const list = childElements(parent, local)
  return list.length === 0 ? null : list[0]
}

/** 属性按本地名取（`epub:type` 与 `type` 都算 `type`）：同名多写时取靠前那个 */
export function attrOf(el: Element, local: string): string | null {
  for (const [name, value] of Object.entries(el.attribs)) if (localName(name) === local) return value
  return null
}
