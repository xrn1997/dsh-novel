import type { AnyNode, Element } from 'domhandler'
import type { ContentNode, ContentTag, LinkRole, ReadingTarget } from '../../shared/wire.js'
import { FindingLog, WARN_ACTIVE_ATTR, WARN_CSS_ATTR, WARN_INLINE_SVG, WARN_REMOVED, type FindingEntry } from './findings.js'
import { attrOf, firstDescendant, isCdataNode, isElement, isTextNode, localName, textOf, type XmlBudget } from './xml.js'

/**
 * 正文文档层：一份 XHTML → 白名单图文树，以及文档内的**锚点/链接映射**。
 *
 * ① **两遍走**（调用方编排）：`scanXhtml` 只建映射（原书 id → opaque 锚点 ID、链接），`convertXhtml` 才铸节点、
 *   绑目标；锚点 ID 在第一遍铸好，两遍之间不依赖「遍历顺序一致」这种脆弱约定。
 * ② **原书属性不上树**：只有 `id`（转 opaque 锚点 ID）、表格 rowSpan/colSpan、ol start、li value 进节点；
 *   `class`/`title`/`data-*` 静默丢弃，**事件属性与 style 剥除并记告警**。
 * ③ **可见内容不许静默消失**：白名单元素照转，未知元素保留子内容（带锚点的另包一层 span 留住它），
 *   活动/交互元素连子树剥除但**必须记告警**。**正文内联 SVG 是「剥离 + 告警」不是报错**（资源侧 SVG 另说）；
 *   **唯一例外**：内联 SVG 是该文档**唯一**内容时本层不判，交回 `svgOnly` 候选让编排层裁决（真书通常是
 *   EPUB3 整页封面，按空章节拒会把标准写法整本杀掉）。落不下那张图时该页按**空页**处理；独立 SVG
 *   **资源**仍走白名单重建，白名单外的可见元素报错点名资源（见 `resources.ts`）。
 * ④ **被剥离子树里的锚点是一份事实，不是「没有这个锚点」**：`scanXhtml` 记进 `strippedAnchors`（不是
 *   `anchors`），绑定期据此把目标**降级**（导航跳到文档开头、内链降级成纯文本）并记痕，而不是报「不存在」。
 *   拼写错、从未存在的 id 同样按该条降级，两种缺失只差动作句。**第三格**：锚点在源里也在树上，但承载它的是
 *   body——`documentAnchor` 记它，等价于「无片段」，不降级也不该拒。三格少一格就会把真书写法读成坏书。
 */

/** 图片绑定结果：资源 ID 与**显示**宽高（EXIF 旋转已由资源层折算） */
export interface ImageBinding {
  readonly resourceId: string
  readonly width: number
  readonly height: number
}

/**
 * 文档内的使用面（第一遍扫描的产物）。`anchors` 的键是原书 id、值是 opaque 锚点 ID——它同时就是承载节点的
 * 节点 ID，因为富文本树里没有第二张「锚点表」：客户端只能按节点 ID 定位（wire 的 `ReadingTarget.anchorId`）。
 * `strippedAnchors` 与 `anchors` 分开：这些名字在被剥离的子树里，没有可落位置所以不铸 ID，但「源里出现过」
 * 是绑定期说对动作句的判据（两种缺失都降级，差别只在痕说什么；折叠成一件会把剥掉的东西报成书里指错名字）。
 * `images` / `links` 都是**原始 href**（未按文档目录解释）：调用方须在转换前解析/验证完，转换期只查表。
 */
export interface XhtmlScan {
  readonly anchors: ReadonlyMap<string, string>
  readonly strippedAnchors: ReadonlySet<string>
  /**
   * 挂在 `<body>` 上的 `id`（一份文档最多一个）：它**不是** `anchors` 里的一条——树上没有 body 节点，铸 ID 会指向
   * 不存在的位置。它等价于 wire 的 `anchorId = null`（这一页的开头），不降级也不拒（口径见注④末段）。
   */
  readonly documentAnchor: string | null
  /** 撞过名的锚点名（承载者取文档序第一个，这里只留「撞过」这份事实给编排层留痕） */
  readonly duplicates: readonly string[]
  readonly links: readonly string[]
  readonly images: readonly string[]
}

/**
 * 连子树剥除的元素：活动内容（脚本/内嵌框/对象/表单/音视频/画布）与文档级装载指令（`style`/`link`/`meta`/`base`）。
 * 这些都不是正文，剥除即内容不损失，但要记告警。
 */
const REMOVED_ELEMENTS: ReadonlySet<string> = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'applet', 'form', 'input', 'button', 'select',
  'textarea', 'option', 'optgroup', 'video', 'audio', 'source', 'track', 'canvas', 'template',
  'noscript', 'param', 'base', 'link', 'meta', 'frame', 'frameset', 'area',
])

/** 「正文里的 <img> 没有 src」的稳定标识：这一处不表达，但要看得到它为什么不在 */
const WARN_IMG_NO_SRC = 'epub-img-without-src'

/** wire 元素白名单的本地名集合（唯一字面量来源在 wire 的 ContentTag；这里只做成员判定） */
const CONTENT_TAGS: ReadonlySet<string> = new Set<ContentTag>([
  'p', 'div', 'span', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'strong', 'em', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code',
  'sup', 'sub', 'table', 'caption', 'thead', 'tbody', 'tfoot',
  'tr', 'th', 'td',
])

/** 标签规范化：`b`/`i` 有语义等价物，结构容器统一成 `div`（保住块边界，不带原书语义与样式）。
 *  `s`/`strike` **不在这里**：映射成强调是凭空发明语义——它按未知元素走「保留子内容」。 */
const TAG_ALIASES: ReadonlyMap<string, ContentTag> = new Map<string, ContentTag>([
  ['b', 'strong'], ['i', 'em'],
  ['section', 'div'], ['article', 'div'], ['header', 'div'], ['footer', 'div'], ['main', 'div'],
  ['aside', 'div'], ['nav', 'div'], ['figure', 'div'], ['figcaption', 'div'], ['address', 'div'], ['center', 'div'],
])

function contentTag(local: string): ContentTag | null {
  const alias = TAG_ALIASES.get(local)
  if (alias !== undefined) return alias
  return CONTENT_TAGS.has(local) ? (local as ContentTag) : null
}

interface Ctx {
  readonly budget: XmlBudget
  readonly anchors: ReadonlyMap<string, string>
  readonly resolveLink: (href: string) => ReadingTarget | null
  readonly resolveImage: (src: string, alt: string) => ImageBinding | null
  readonly nextNodeId: () => string
  readonly warnings: FindingLog
  /** 已认领的锚点名：撞名时只有文档序第一个承载者拿到那个 ID（见 `anchorIdOf`） */
  readonly claimedAnchors: Set<string>
  /** 本份文档剥离过的内联 SVG 数：只在「剥完什么都不剩」时用来给出精确原因 */
  readonly inlineSvg: { stripped: number }
}

export interface XhtmlConvertOptions {
  readonly budget: XmlBudget
  readonly anchors: ReadonlyMap<string, string>
  /** 内部链接绑定：返回目标；null = 保留文字、取消可点击性（调用方已记告警）；抛错 = 必须拒绝。链接角色由本层按 `epub:type` 判定，不进这个口。 */
  readonly resolveLink: (href: string) => ReadingTarget | null
  /** 图片绑定：返回资源与显示宽高；`null` = 这张图读不出，该处不表达（调用方已点名）。抛错只留给「我们自己的清点漏了」。 */
  readonly resolveImage: (src: string, alt: string) => ImageBinding | null
  /** 节点 ID 铸造（导入期唯一，跨文档不重复）；锚点 ID 已在扫描期铸好、不在这里取号 */
  readonly nextNodeId: () => string
}

/**
 * 整页只有一棵内联 SVG 时交回的候选（真书的封面/图形页是 EPUB3 推荐写法）。**本层不判它落不落得下**：
 * 里面那张图是不是书内可加载资源只有编排层知道（`import.ts` 配 `soleRasterHref`），这里给的是候选。
 */
export interface SvgOnlyPage {
  readonly element: Element
  /**
   * 被这棵树顶替掉的容器（body → svg 路径上）各自承载的锚点 ID，外层在前。为什么要带出去：包着 SVG 的
   * `div` 是普通容器，它们的锚点已铸成 ID；整页被一张图顶替后这些容器不在树上了，不带出去就会绑到**树上
   * 不存在的 ID**。编排层拿这份清单在那张图上逐层包容器，身份这才有着落。
   */
  readonly carriedAnchors: readonly string[]
}

export interface ConvertedXhtml {
  readonly nodes: ContentNode[]
  /** 文档标题（head 的 title；缺则 null）——无目录时章名的兜底来源 */
  readonly title: string | null
  /** 整页只有一棵内联 SVG 时的候选（含它顶替掉的容器锚点），否则 null */
  readonly svgOnly: SvgOnlyPage | null
  /**
   * 这份文档读不读得出正文：`false` 时编排层留空页并点名（整本判据见 `import.ts`）。它是**可见性**判据，
   * 不是「树是否为空」：读不出时 `nodes` 仍保留结构，否则扫描期铸出的锚点 ID 在树上没有落点，目标会静默退到章首。
   */
  readonly readable: boolean
  /** 本层交出的事实清单（半径已按 `FINDING_RADII` 定好，后果由编排层落）：可变的那本账只住编排层 */
  readonly findings: readonly FindingEntry[]
}

/** 「这一份文档读不出任何正文」的稳定标识：一份文档的事实，不是整本书的事实（后果见 `import.ts`）；编排层也说同一句话，故导出。 */
export const WARN_EMPTY_DOC = 'epub-empty-document'
/** 两种不可读原因各说各话：只剩空白/被剥除的活动内容，与整页就是一棵矢量图（后者导出给编排层，两处各写一遍会分叉）。 */
const EMPTY_BLANK_ACTION = '文档里没有可显示的正文（body 为空、内容全是被剥除的活动元素，或只剩空白）'
export const EMPTY_SVG_ONLY_ACTION = '文档唯一的内容是内联 SVG（剥离后没有别的正文；本插件只支持独立的 SVG 图片资源）'

/**
 * 第一遍：建锚点映射与链接集合。遍历与转换**同一处起点**（body 的子节点）与**同一条剥除规则**：body 自己的
 * 锚点**不进 `anchors`**（body 不是树上节点），另记成 `documentAnchor`；被剥除子树里的链接/图片不算，
 * 锚点名另收进 `strippedAnchors`——它不是可落的位置，但「存在过」是绑定期说「随剥离消失」的事实依据（注④）。
 */
export function scanXhtml(root: Element, budget: XmlBudget, nextAnchorId: () => string): XhtmlScan {
  const anchors = new Map<string, string>()
  const strippedAnchors = new Set<string>()
  const duplicates: string[] = []
  const seenDuplicates = new Set<string>()
  const links: string[] = []
  const images: string[] = []
  const body = firstDescendant(root, 'body', budget)
  const walk = (parent: { readonly children: AnyNode[] }): void => {
    for (const child of parent.children) {
      if (!isElement(child)) continue
      const name = localName(child.name)
      if (REMOVED_ELEMENTS.has(name) || name === 'svg') {
        // 这棵子树在转换期整棵剥离：里面的锚点只记名字（不铸 ID、不进重复闸门）——内容不在树上，撞名无歧义
        collectStrippedAnchors(child, strippedAnchors)
        continue
      }
      const names = anchorNamesOf(child)
      if (names.length > 0) {
        // 撞名不是歧义：树上承载它的是**文档序第一个**，后来的同名元素照样读出来；这里记下撞过的名字，由编排层留痕
        const fresh = names.filter((n) => !anchors.has(n))
        // 成员判定用 Set：文档可以有十万个互不相同的 id，`includes` 会把这里拖成 O(n²)
        for (const dupName of names) {
          if (!anchors.has(dupName) || seenDuplicates.has(dupName)) continue
          seenDuplicates.add(dupName)
          duplicates.push(dupName)
        }
        if (fresh.length > 0) {
          // 同一元素上的 id 与 name 是同一个落点：铸一个锚点 ID（各铸一个会让其中一个指向不存在的节点）
          const minted = nextAnchorId()
          for (const anchorName of fresh) anchors.set(anchorName, minted)
        }
      }
      // 撞名的元素照样要收它的链接与图片：这里只是不再铸锚点，它仍是正文里真实的一处引用
      if (name === 'a') {
        const href = attrOf(child, 'href')
        if (href !== null && href.trim() !== '') links.push(href.trim())
      }
      if (name === 'img') {
        const src = attrOf(child, 'src')
        // 缺 src 的 img 留到转换期报错（扫描只做「用到了什么」的清点）
        if (src !== null && src.trim() !== '') images.push(src.trim())
      }
      walk(child)
    }
  }
  if (body === null) return { anchors, strippedAnchors, documentAnchor: null, duplicates, links, images }
  // body 自己的 `id`（只认 id：body 上没有 `<a name>`）不进锚点表也不进剥离名单——内容整页在树上，只是容器不是节点
  const bodyId = attrOf(body, 'id')
  walk(body)
  return { anchors, strippedAnchors, documentAnchor: bodyId === null || bodyId === '' ? null : bodyId, duplicates, links, images }
}

/** 收一棵**将被整棵剥离**的子树里的锚点名（口径见注④：只留事实，不留可落的位置） */
function collectStrippedAnchors(el: Element, out: Set<string>): void {
  for (const name of anchorNamesOf(el)) out.add(name)
  for (const child of el.children) {
    if (isElement(child)) collectStrippedAnchors(child, out)
  }
}

/**
 * 元素声明的锚点名（一个元素可能同时有两个）：`id` 是通用写法，`<a name="x">` 是 EPUB2 命名锚点——只认 id
 * 会把这类书整本拒掉（锚点最终都重映射成 opaque ID，安全面没有差别）。**只认 `a` 的 `name`**：别的元素上的
 * `name` 另有含义（表单控件名、`meta name=…`），当锚点是凭空发明。
 */
function anchorNamesOf(el: Element): string[] {
  const names: string[] = []
  const id = attrOf(el, 'id')
  if (id !== null && id !== '') names.push(id)
  if (localName(el.name) === 'a') {
    const name = attrOf(el, 'name')
    if (name !== null && name !== '' && !names.includes(name)) names.push(name)
  }
  return names
}

/**
 * 第二遍：把文档转成白名单图文树。读不出任何正文（body 缺失，或 body 空/内容全被剥除/只剩空白）**不抛错**：
 * 交回 `readable: false` 加一条 `document/fatal` 痕，后果由编排层定（留空页，见 `import.ts`）。「一份文档没有
 * 正文」不是「这本书读不出」，但判据不松：空白与空壳容器都不算内容（`hasVisibleContent`）。
 * 读不出时**结构树照留**：树里的锚点 ID 是扫描期铸给目录与内链的落点，丢掉树就等于让它们绑到不存在的节点。
 * body 缺失与整页 SVG 两条仍交空树：前者没有树，后者落点由 `svgOnly.carriedAnchors` 承接。
 */
export function convertXhtml(root: Element, opts: XhtmlConvertOptions): ConvertedXhtml {
  // 本层的账自己记、自己交回清单：可变的那本账只住编排层（口径见 `findings.ts`）
  const warnings = new FindingLog()
  const title = documentTitle(root, opts.budget)
  const body = firstDescendant(root, 'body', opts.budget)
  if (body === null) {
    warnings.add('blankDocument', WARN_EMPTY_DOC, opts.budget.what, '不是可读的 XHTML（没有 body）')
    return { nodes: [], title, svgOnly: null, readable: false, findings: warnings.entries() }
  }
  const inlineSvg = { stripped: 0 }
  const ctx: Ctx = {
    budget: opts.budget,
    anchors: opts.anchors,
    resolveLink: opts.resolveLink,
    resolveImage: opts.resolveImage,
    nextNodeId: opts.nextNodeId,
    warnings,
    claimedAnchors: new Set(),
    inlineSvg,
  }
  const nodes = convertChildren(body.children, ctx)
  if (hasVisibleContent(nodes)) {
    warnStrippedInlineSvg(ctx)
    return { nodes, title, svgOnly: null, readable: true, findings: warnings.entries() }
  }
  // 剥完什么都不剩：先分清「整页就是一棵图」与「真的空」——前者交回候选让编排层裁决（理由见头注③）。
  const svgOnly = soleInlineSvg(body)
  if (svgOnly !== null) {
    return {
      nodes: [], title, readable: true, findings: warnings.entries(),
      svgOnly: { element: svgOnly, carriedAnchors: droppedAnchorIds(body, svgOnly, ctx) },
    }
  }
  warnStrippedInlineSvg(ctx)
  warnings.add('blankDocument', WARN_EMPTY_DOC, opts.budget.what,
    inlineSvg.stripped > 0 ? EMPTY_SVG_ONLY_ACTION : EMPTY_BLANK_ACTION)
  return { nodes, title, svgOnly: null, readable: false, findings: warnings.entries() }
}

/**
 * 内联 SVG 的剥离告警**延后到这里**发：整页就是一棵图的文档要么变成一张图、要么留空页，先发就成了自相矛盾的两句
 * 说明。逐棵 `add` 保留合并语义（同类多处 → 「N 处」计数）。
 */
function warnStrippedInlineSvg(ctx: Ctx): void {
  for (let i = 0; i < ctx.inlineSvg.stripped; i += 1) {
    ctx.warnings.add('elementRemoved', WARN_INLINE_SVG, ctx.budget.what, '移除了内联 SVG（本插件只支持独立的 SVG 图片资源，装饰性矢量不渲染）', '<svg>')
  }
}

/**
 * 这份 body 里「非被剥除内容」是否恰好只剩一棵内联 SVG（容器与空白不算内容）。遍历与 `convertChildren` 用
 * **同一条剥除规则**（`REMOVED_ELEMENTS` 整棵跳过、`svg` 整棵算一处），两套判据会分裂成「这边说有、那边说没」。
 */
function soleInlineSvg(body: Element): Element | null {
  const found: Element[] = []
  const walk = (parent: { readonly children: AnyNode[] }): void => {
    for (const child of parent.children) {
      if (!isElement(child)) continue
      const name = localName(child.name)
      if (REMOVED_ELEMENTS.has(name)) continue
      if (name === 'svg') { found.push(child); continue }
      walk(child)
    }
  }
  walk(body)
  const only = found.length === 1 ? found[0] : undefined
  return only === undefined ? null : only
}

/**
 * body → 目标元素这条路径上各容器承载的锚点 ID（外层在前）。与 `soleInlineSvg` 同一处起点与同一条遍历：
 * 整页 SVG 被一张图顶替后，路径上那些容器不在树上了，它们的锚点必须有新落点。`ctx.anchors` 里查不到的
 * 名字（例如 svg 自己的 id——扫描期进了 `strippedAnchors`）不算。
 */
function droppedAnchorIds(body: Element, target: Element, ctx: Ctx): string[] {
  const path: Element[] = []
  const walk = (el: Element): boolean => {
    if (el === target) return true
    for (const child of el.children) {
      if (!isElement(child)) continue
      path.push(child)
      if (walk(child)) return true
      path.pop()
    }
    return false
  }
  if (!walk(body)) return []
  const ids: string[] = []
  for (const el of path) {
    const id = mappedAnchorIdOf(el, ctx)
    if (id !== null && !ids.includes(id)) ids.push(id)
  }
  return ids
}

/**
 * 有没有可显示的内容：**递归**判到底，不看容器本身存在与否。空白文本不算（假成功）；空壳容器不算
 * （`<p><svg/></p>` 剥掉 SVG 后渲染出空）；孤立的换行/分隔线不算。图算内容——纯插图文档是合法的。
 */
function hasVisibleContent(nodes: readonly ContentNode[]): boolean {
  return nodes.some((n) => {
    switch (n.kind) {
      case 'text': return n.text.trim() !== ''
      case 'image': return true
      case 'element':
      case 'link': return hasVisibleContent(n.children)
      case 'break':
      case 'rule': return false
    }
  })
}

/** 文档标题（head 的 title；空/缺则 null）。单独导出给第一遍：章名要在扫描期拿到，
 *  不该为了一个标题在转换期再解析一次。 */
export function documentTitle(root: Element, budget: XmlBudget): string | null {
  const title = firstDescendant(root, 'title', budget)
  return title === null ? null : textOf(title, budget).trim() || null
}

/** 逐子节点转换：文本/CDATA 保字面、注释不进树、元素按下面那张表分流。一个元素可能展开成多个节点，
 *  **逐项追加**而不是 `push(...nodes)`：大容器的子内容展平传参会撞参数上限抛裸 `RangeError`（会漏成 500）。 */
function convertChildren(children: readonly AnyNode[], ctx: Ctx): ContentNode[] {
  const out: ContentNode[] = []
  for (const child of children) {
    if (isTextNode(child)) out.push({ kind: 'text', text: child.data })
    else if (isCdataNode(child)) out.push({ kind: 'text', text: textOf(child, ctx.budget) })
    else if (isElement(child)) {
      for (const node of convertElement(child, ctx)) out.push(node)
    }
  }
  return out
}

function convertElement(el: Element, ctx: Ctx): ContentNode[] {
  const name = localName(el.name)
  // 内联 SVG 是可见图形：连子树剥除（口径见头注③）；告警由 `warnStrippedInlineSvg` 统一发，这里只记数。
  if (name === 'svg') {
    ctx.inlineSvg.stripped += 1
    return []
  }
  if (REMOVED_ELEMENTS.has(name)) {
    ctx.warnings.add('elementRemoved', WARN_REMOVED, ctx.budget.what, '移除了活动内容（不执行书内脚本，不加载书内样式/表单/音视频）', name)
    return []
  }
  warnUnsafeAttributes(el, ctx)
  const anchorId = anchorIdOf(el, ctx)
  if (name === 'br') return [{ kind: 'break', id: anchorId ?? ctx.nextNodeId() }]
  if (name === 'hr') return [{ kind: 'rule', id: anchorId ?? ctx.nextNodeId() }]
  if (name === 'img') return imageNode(el, anchorId, ctx)
  if (name === 'a') return linkOrHoist(el, anchorId, ctx)
  const tag = contentTag(name)
  if (tag === null) {
    // 未知元素：保留子内容（不是「看不懂就丢掉」）；带 id 的另包一层 span，否则它的锚点就没了
    const children = convertChildren(el.children, ctx)
    return anchorId === null ? children : [elementNode('span', anchorId, children, el)]
  }
  return [elementNode(tag, anchorId ?? ctx.nextNodeId(), convertChildren(el.children, ctx), el)]
}

/** 结构容器节点（div，四类结构参数恒 null）。元素节点的形状（含「只留明确字段」）只写在这里：`elementNode` 在其上加 tag 与结构参数。 */
export function containerNode(id: string, children: ContentNode[]): Extract<ContentNode, { kind: 'element' }> {
  return {
    kind: 'element', id, tag: 'div', children,
    rowSpan: null, colSpan: null, start: null, value: null,
  }
}

/** 元素节点只带明确字段：rowSpan/colSpan 只对单元格、start 只对 ol、value 只对 li，其余恒 null */
function elementNode(tag: ContentTag, id: string, children: ContentNode[], el: Element): Extract<ContentNode, { kind: 'element' }> {
  const cell = tag === 'th' || tag === 'td'
  return {
    ...containerNode(id, children),
    tag,
    rowSpan: cell ? positiveInt(attrCi(el, 'rowspan')) : null,
    colSpan: cell ? positiveInt(attrCi(el, 'colspan')) : null,
    start: tag === 'ol' ? intAttr(attrCi(el, 'start')) : null,
    value: tag === 'li' ? intAttr(attrCi(el, 'value')) : null,
  }
}

function linkOrHoist(el: Element, anchorId: string | null, ctx: Ctx): ContentNode[] {
  const href = attrOf(el, 'href')
  const children = convertChildren(el.children, ctx)
  const hoist = (): ContentNode[] => (anchorId === null ? children : [elementNode('span', anchorId, children, el)])
  if (href === null || href.trim() === '') return hoist()
  const target = ctx.resolveLink(href.trim())
  if (target === null) return hoist()
  return [{ kind: 'link', id: anchorId ?? ctx.nextNodeId(), target, role: linkRole(el), children }]
}

/** 链接角色：从 `epub:type` 读（脚注引用 / 反向链接），其余普通。`LinkRole` 住 `shared/wire.ts`，铸造方与消费方共用一份。 */
function linkRole(el: Element): LinkRole {
  const type = attrOf(el, 'type')
  if (type !== null) {
    const kinds = type.split(/\s+/)
    if (kinds.includes('noteref')) return 'noteref'
    if (kinds.includes('backlink')) return 'backlink'
  }
  return 'normal'
}

function imageNode(el: Element, anchorId: string | null, ctx: Ctx): ContentNode[] {
  const alt = attrOf(el, 'alt') ?? ''
  const src = attrOf(el, 'src')
  if (src === null || src.trim() === '') {
    // 指向哪都不知道：这一处表达不出来，但它不是「这本书读不出」——留痕并按缺席处理
    ctx.warnings.add('elementDropped', WARN_IMG_NO_SRC, ctx.budget.what, '正文里的 <img> 没有 src（指向哪里无从知道，这一处不表达）', '<img>')
    return droppedImage(anchorId, alt)
  }
  const binding = ctx.resolveImage(src.trim(), alt)
  if (binding === null) return droppedImage(anchorId, alt)
  return [{
    kind: 'image', id: anchorId ?? ctx.nextNodeId(), resourceId: binding.resourceId,
    alt, width: binding.width, height: binding.height,
  }]
}

/**
 * 一张读不出的图能留下的东西：**说明文字**（alt 是内容，不是装饰）与**这个元素承载的锚点位置**——锚点必须
 * 有落点，不留空容器的话，指向这一处的目录条目会绑到不存在的节点。
 */
function droppedImage(anchorId: string | null, alt: string): ContentNode[] {
  const text: ContentNode[] = alt.trim() === '' ? [] : [{ kind: 'text', text: alt }]
  return anchorId === null ? text : [containerNode(anchorId, text)]
}

/** 原书锚点名 → 扫描期铸好的锚点 ID（纯查询，不认领）：`droppedAnchorIds` 要在转换之后重查同一处 */
function mappedAnchorIdOf(el: Element, ctx: Ctx): string | null {
  for (const name of anchorNamesOf(el)) {
    const hit = ctx.anchors.get(name)
    if (hit !== undefined) return hit
  }
  return null
}

/**
 * 转换期取这个元素承载的锚点 ID；**不在映射里**（含空值）或名字已被文档序更早的元素认领 = 不承载锚点。
 * 为什么要认领：撞名时扫描期只铸一个 ID，后出现的同名元素照样查得到；若它也把那个 ID 当自己的节点 ID，
 * 树上就有两个同 ID 节点（目录落位与进度断点在两处之间挑错）。承载者是文档序第一个，后来的同名元素用新
 * 铸的普通节点 ID 照常读出。
 */
function anchorIdOf(el: Element, ctx: Ctx): string | null {
  const names = anchorNamesOf(el)
  for (const name of names) {
    const hit = ctx.anchors.get(name)
    if (hit === undefined || ctx.claimedAnchors.has(name)) continue
    // 同一元素上的多个名字共享一个锚点 ID：一起认领，后面的同名元素不再拿它
    for (const other of names) if (ctx.anchors.get(other) === hit) ctx.claimedAnchors.add(other)
    return hit
  }
  return null
}

/** 事件属性与 style 属性：剥除并记告警（前者是活动内容，后者是出版方 CSS） */
function warnUnsafeAttributes(el: Element, ctx: Ctx): void {
  for (const name of Object.keys(el.attribs)) {
    if (/^on/i.test(name)) {
      ctx.warnings.add('elementRemoved', WARN_ACTIVE_ATTR, ctx.budget.what, '移除了事件属性（不执行书内脚本）', name.toLowerCase())
      continue
    }
    if (name.toLowerCase() === 'style') {
      ctx.warnings.add('elementRemoved', WARN_CSS_ATTR, ctx.budget.what, '移除了 style 属性（本插件不加载出版方 CSS）', `<${localName(el.name)}>`)
    }
  }
}

/** 属性按本地名取（大小写不敏感：XHTML 该是小写，但坏书里两种写法都有） */
function attrCi(el: Element, local: string): string | null {
  const lower = local.toLowerCase()
  for (const [name, value] of Object.entries(el.attribs)) {
    if (localName(name).toLowerCase() === lower) return value
  }
  return null
}

/** 合法整数（可负：HTML 的 li value 允许）；坏值按缺席处理，不猜成别的数 */
function intAttr(raw: string | null): number | null {
  if (raw === null) return null
  const trimmed = raw.trim()
  if (!/^-?\d+$/.test(trimmed)) return null
  const n = Number.parseInt(trimmed, 10)
  return Number.isSafeInteger(n) ? n : null
}

/** 表格跨度只认正整数：`0` 在 HTML 里是「跨到本节末尾」的古怪写法，本仓不表达它（按缺席） */
function positiveInt(raw: string | null): number | null {
  const n = intAttr(raw)
  return n !== null && n >= 1 ? n : null
}
