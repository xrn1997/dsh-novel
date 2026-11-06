import type { AnyNode, Element } from 'domhandler'
import type { ContentNode, ContentTag, LinkRole, ReadingTarget } from '../../shared/wire.js'
import { FindingLog, WARN_ACTIVE_ATTR, WARN_CSS_ATTR, WARN_INLINE_SVG, WARN_REMOVED, type FindingEntry } from './findings.js'
import { attrOf, firstDescendant, isCdataNode, isElement, isTextNode, localName, textOf, type XmlBudget } from './xml.js'

/**
 * 正文文档层：一份 XHTML → 白名单图文树，以及文档内的**锚点/链接映射**。
 *
 * 三条口径（改这一层先读它们）：
 *
 * ① **两遍走**（调用方编排）：第一遍 `scanXhtml` 只建映射——原书 id → opaque 锚点 ID，以及文档里
 *    引用到的链接；第二遍 `convertXhtml` 才铸节点、绑目标。锚点 ID 在第一遍铸好、第二遍按原 id
 *    查表，所以两遍之间不依赖「遍历顺序必须一致」这种脆弱约定。
 * ② **原书属性不上树**：只有 `id`（转成 opaque 锚点 ID）、表格的 rowSpan/colSpan、ol 的 start、
 *    li 的 value 进节点；`class`/`title`/`data-*` 这类与渲染无关的属性静默丢掉，**事件属性与 style
 *    属性丢掉并记告警**（前者是活动内容，后者是出版方 CSS）。
 * ③ **可见内容不许静默消失**：白名单元素照转，未知元素保留子内容（带锚点的另包一层 span 以留住
 *    锚点），活动/交互元素连子树剥除但**必须记告警**。
 *    **正文内联 SVG 是「剥离 + 告警」，不是报错**（设计里的 SVG 条款讲的是交给浏览器的**资源**；
 *    拒整本与同层装饰性失败极不对称）——代价如实记：这类文档丢掉内联矢量图形（有告警点名，不是
 *    静默丢）。**唯一例外**：内联 SVG 是该文档**唯一**内容时本层**不判**，交回 `svgOnly` 候选让
 *    编排层裁决——真书这一页通常是 EPUB3 推荐的整页封面，按空章节拒会把标准写法当坏书整本杀掉；
 *    裁决口径与真书反例见 `import.ts`；落不下那张图时这一页按**空页**处理（`EMPTY_SVG_ONLY_ACTION`），
 *    不再是整本拒绝。
 *    独立 SVG **资源**仍走白名单重建，白名单外的可见元素（`foreignObject`/`use`/嵌套 `image`…）
 *    报错点名资源（见 `resources.ts`）。
 * ④ **被剥离子树里的锚点是一份事实，不是「没有这个锚点」**：`scanXhtml` 把它们记进 `strippedAnchors`
 *    （不是 `anchors`——那段内容不在树上，落不到）。绑定期据此把目标**降级**（导航跳到文档开头、
 *    正文内链降级成纯文本）并记告警，而不是把它报成「锚点不存在」——是**我们自己**剥掉了承载它的
 *    图形，动作句因此说得出是哪一种（降级口径与告警码见 `import.ts`）。反过来，拼写错、指向从未存在
 *    的 id 同样**按该条**降级：目录落该页开头、正文链接取消可点击性（文字照留），各留一条痕——两种
 *    缺失唯一的差别是动作句。「宁炸不猜」针对的是「我们读不懂」，整本拒收只留给书级事实（见 `ADR-0061`）。
 *    **同一族还有第三格**：锚点在源里存在、也在树上（整页正文都在），只是承载它的是 body 这个容器
 *    ——`documentAnchor` 记的就是这件事，它等价于「无片段」（落点=该页开头），既不必降级也不该拒。
 *    三格少一格，就会把真书写法读成坏书。
 */

/** 图片绑定结果：资源 ID 与**显示**宽高（EXIF 旋转已由资源层折算） */
export interface ImageBinding {
  readonly resourceId: string
  readonly width: number
  readonly height: number
}

/**
 * 文档内的使用面（第一遍扫描的产物）。
 *
 * `anchors` 的键是原书 id、值是 opaque 锚点 ID——它同时就是承载该锚点的那个节点的节点 ID，
 * 因为富文本树里没有第二张「锚点表」：客户端只能按节点 ID 定位（wire 的 `ReadingTarget.anchorId`）。
 *
 * `strippedAnchors` 是与 `anchors` **分开的一份事实**：这些名字在被剥离的子树里，内容不在树上、
 * 没有可落的位置所以不铸 ID，但「源里出现过这个锚点」是绑定期**说对动作句**的判据——两种缺失
 * 都按该条降级，区别只在痕说的是「随剥离消失」还是「文档里不存在」（口径见文件头注④）；折叠成
 * 一件，一层装饰剥掉的东西就会被报成书里指错了名字。
 *
 * `images` 与 `links` 都是**原始 href**（还没按文档目录解释）：调用方要在转换之前把它们全部
 * 解析/验证完（图片尤其：转换是同步遍历，读盘与验证必须在之前做完），转换期只查表。
 */
export interface XhtmlScan {
  readonly anchors: ReadonlyMap<string, string>
  readonly strippedAnchors: ReadonlySet<string>
  /**
   * 挂在 `<body>` 上的那个 `id`（一份文档最多一个）：它**不是** `anchors` 里的一条——
   * 树上没有 body 这个节点，铸出的 ID 会指向不存在的位置。它是第三种事实：源里确实有这个
   * 锚点，而它的语义就是「这一页的开头」，与 wire 里 `anchorId = null` 等价（口径见注④ 末段）。
   */
  readonly documentAnchor: string | null
  /** 撞过名的锚点名（承载者取文档序第一个，这里只留「撞过」这份事实给编排层留痕） */
  readonly duplicates: readonly string[]
  readonly links: readonly string[]
  readonly images: readonly string[]
}

/**
 * 连子树剥除的元素：活动内容（脚本/内嵌框/对象/表单/音视频/画布）与文档级装载指令
 * （`style`/`link`/`meta`/`base`）。这些都**不是正文**，剥除即内容不损失，但要记告警。
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

/** 标签规范化：`b`/`i` 有语义等价物，结构容器统一成 `div`（保住块边界，不带原书的语义与样式）。
 *  `s`/`strike`（删除线）**不在这里**：设计只要求 `b/i → strong/em` 与结构容器 → `div`，把删除线映射成
 *  强调是凭空发明语义——它按未知元素走「保留子内容」。 */
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
  /** 内部链接绑定：返回目标；返回 null = 保留文字、取消可点击性（调用方已记告警）；抛错 = 必须拒绝。
   *  角色（普通/脚注引用/反向链接）由本层按 `epub:type` 判定，不进这个口——绑定只关心「去哪」 */
  readonly resolveLink: (href: string) => ReadingTarget | null
  /** 图片绑定：返回资源与显示宽高；`null` = 这张图读不出，该处不表达（调用方已点名资源与原因）。
   *  抛错只留给「我们自己的清点漏了」那种内部一致性问题。 */
  readonly resolveImage: (src: string, alt: string) => ImageBinding | null
  /** 节点 ID 铸造（导入期唯一，跨文档不重复）；锚点 ID 已在扫描期铸好、不在这里取号 */
  readonly nextNodeId: () => string
}

/**
 * 整页只有一棵内联 SVG 时交回的候选（真书的封面/图形页是 EPUB3 推荐写法）。
 *
 * **本层不判它落不落得下**：里面那张图是不是书内可加载资源，只有认识归档与 manifest 的编排层
 * 知道（`import.ts` 拿它配 `soleRasterHref`）。所以这里给的是候选，不是裁决。
 */
export interface SvgOnlyPage {
  readonly element: Element
  /**
   * 被这棵树顶替掉的容器（body → svg 这条路径上）各自承载的锚点 ID，外层在前。
   *
   * 为什么要带出去：包着 SVG 的 `div` 是普通容器，它的锚点在 `anchors` 里已铸成 ID；整页被一张图
   * 顶替后这些容器不在树上了，不带出去就会绑到**树上不存在的 ID**（落位退化成章首、目录量不到）。
   * 编排层拿这份清单在那张图上逐层包容器，身份这才有着落。
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
   * 这份文档读不读得出正文：`false` 时编排层留空页并点名，整本判据见 `import.ts`。
   * 它是**可见性**判据，不是「树是否为空」：读不出时 `nodes` 仍保留转换出的结构（可能只有
   * 空容器或空白文本），否则扫描期铸出的锚点 ID 在树上就没有落点，绑过去的目标会静默退到章首。
   */
  readonly readable: boolean
  /** 本层交出的事实清单（半径已按 `FINDING_RADII` 定好，后果由编排层落）：可变的那本账只住编排层 */
  readonly findings: readonly FindingEntry[]
}

/** 「这一份文档读不出任何正文」的稳定标识：一份文档的事实，不是整本书的事实（后果见 `import.ts`）
 *  编排层也要说同一句话（整页 SVG 落不下那张图那种），所以导出 */
export const WARN_EMPTY_DOC = 'epub-empty-document'
/** 两种不可读的原因，各说各的话：只剩空白/被剥除的活动内容，与整页就是一棵矢量图。
 *  后者是**导出**的：整页 SVG 落不下那张图时由编排层说同一句话（两处各写一遍就会分叉）。 */
const EMPTY_BLANK_ACTION = '文档里没有可显示的正文（body 为空、内容全是被剥除的活动元素，或只剩空白）'
export const EMPTY_SVG_ONLY_ACTION = '文档唯一的内容是内联 SVG（剥离后没有别的正文；本插件只支持独立的 SVG 图片资源）'

/**
 * 第一遍：建锚点映射与链接集合。
 *
 * 遍历与转换**同一处起点**（body 的子节点）与**同一条剥除规则**：body 自己的锚点**不进 `anchors`**
 * （body 不是树上的节点，给它铸 ID 就是指向一个不存在的位置），而是另记成 `documentAnchor`；
 * 被剥除子树里的**链接/图片**不算（那段内容
 * 不在树上，内联 SVG 与活动元素都在此列）；被剥除子树里的**锚点名**另收进 `strippedAnchors`——
 * 它不是可落的位置，但「这个锚点存在过」是绑定期说得出「随剥离消失」而不是「文档里不存在」所依据
 * 的事实（口径见注④）。
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
        // 这棵子树在转换期整棵剥离：里面的锚点只记名字（不铸 ID、不进重复闸门）——内容不在树上，
        // 撞名没有歧义可言，但目标绑定期要靠这份名单把「我们自己剥掉的锚点」与「从没有过的锚点」分开
        collectStrippedAnchors(child, strippedAnchors)
        continue
      }
      const names = anchorNamesOf(child)
      if (names.length > 0) {
        // 撞名不是歧义，是有确定答案的事实：树上承载它的是**文档序第一个**，后来的同名元素
        // 照样作为正文读出来。这里记下撞过的名字（不铸新号、不改写已赢的那个），由编排层留痕。
        const fresh = names.filter((n) => !anchors.has(n))
        // 成员判定用 Set：文档可以有十万个互不相同的 id，`includes` 会把这里拖成 O(n²)
        for (const dupName of names) {
          if (!anchors.has(dupName) || seenDuplicates.has(dupName)) continue
          seenDuplicates.add(dupName)
          duplicates.push(dupName)
        }
        if (fresh.length > 0) {
          // 同一元素上的 id 与 name 是同一个落点：铸一个锚点 ID，两个名字都指它
          // （各铸一个会让其中一个名字指向树上不存在的节点）
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
  // body 自己的 `id`（只认 id：body 上没有 `<a name>` 这种 EPUB2 命名锚点写法）不进锚点表，
  // 也不进被剥离名单——那段内容整页都在树上，只是容器本身不是节点。它是文档级锚点（见 XhtmlScan）
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
 * 元素声明的锚点名（一个元素可能同时有两个）：`id` 是通用写法，`<a name="x">` 是 EPUB2/HTML 时代的
 * 命名锚点——本计划把 EPUB2 列为支持范围，只认 `id` 会把这类书整本拒掉（锚点最终都重映射成
 * opaque ID，安全面没有差别）。**只认 `a` 的 `name`**：别的元素上的 `name` 另有含义（表单控件名、
 * `meta name=…`），把它当锚点是凭空发明。
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
 * 第二遍：把文档转成白名单图文树。
 *
 * 读不出任何正文（body 缺失，或 body 空/内容被全部剥除/只剩空白）**不抛错**：本层交回
 * `readable: false` 加一条 `document/fatal` 的痕，由编排层决定后果（留空页，见 `import.ts`）。
 * 「一份文档没有正文」不是「这本书读不出」——把前者执行成后者，一份空白版权页就能挡在门外一整本。
 * 但判据本身不松：空白不算内容、空壳容器不算内容（`hasVisibleContent`），冒充有正文仍然不许。
 *
 * 读不出时**结构树照留**（`nodes` 不清空）：空白是可见性判据，不是树的形状。树里那些锚点 ID
 * 是扫描期铸给目录与内链的落点，丢掉树就等于让它们绑到不存在的节点（阅读面只能退到章首）。
 * body 缺失与整页 SVG 两条仍交空树：前者根本没有树，后者路径上的落点由 `svgOnly.carriedAnchors` 承接。
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
  // 剥完什么都不剩：先分清「整页就是一棵图」与「真的空」——前者交回候选让编排层裁决
  // （理由与真书反例见文件头注③，裁决在 import.ts）。
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
 * 内联 SVG 的剥离告警**延后到这里**发（不在 `convertElement` 里逐棵发）：整页就是一棵图的那种
 * 文档要么变成一张图、要么留空页，两种都不是「丢了装饰」——先发就成了自相矛盾的两句说明。
 * 逐棵 `add` 保留原来的合并语义（同类多处 → 「N 处」计数）。
 */
function warnStrippedInlineSvg(ctx: Ctx): void {
  for (let i = 0; i < ctx.inlineSvg.stripped; i += 1) {
    ctx.warnings.add('elementRemoved', WARN_INLINE_SVG, ctx.budget.what, '移除了内联 SVG（本插件只支持独立的 SVG 图片资源，装饰性矢量不渲染）', '<svg>')
  }
}

/**
 * 这份 body 里「非被剥除内容」是否恰好只剩一棵内联 SVG（容器与空白不算内容）。
 *
 * 遍历与 `convertChildren` 用**同一条剥除规则**（`REMOVED_ELEMENTS` 整棵跳过、`svg` 整棵算一处），
 * 两条路各走一套就会出现「这边说有候选、那边说没内容」的分裂判据。
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
 * body → 目标元素这条路径上各容器承载的锚点 ID（外层在前）。
 *
 * 与 `soleInlineSvg` 同一处起点（body）与同一条遍历：整页 SVG 被一张图顶替后，路径上那些容器
 * 都不在树上了，它们承载过的锚点必须有新落点（见 `SvgOnlyPage.carriedAnchors`）。
 * `ctx.anchors` 里查不到的名字（例如 svg 自己的 id——它在扫描期进了 `strippedAnchors`）不算。
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
 * 有没有可显示的内容：**递归**判到底，不看容器本身存在与否。
 *
 * 空白文本不算（一份只剩空白的「章节」与空章节一样是假成功）；空壳容器不算（`<p><svg/></p>`
 * 剥掉 SVG 后渲染出空，只看一层会让它冒充成功）；孤立的换行/分隔线不算（它只渲染一条空隙，
 * 没有可读的字）。图算内容——纯插图文档是合法的（整页扫描的書）。
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

/**
 * 文档标题（head 的 title；空/缺则 null）。
 * 单独导出是给第一遍用的：章名要在扫描期就拿得到（阅读序列的 label 来自它），
 * 不该为了一个标题在转换期再解析一次。
 */
export function documentTitle(root: Element, budget: XmlBudget): string | null {
  const title = firstDescendant(root, 'title', budget)
  return title === null ? null : textOf(title, budget).trim() || null
}

/** 逐子节点转换：文本/CDATA 保字面、注释不进树、元素按下面那张表分流。
 *  一个元素可能展开成多个节点，**逐项追加**而不是 `push(...nodes)`：大容器的子内容展平传参会撞
 *  JavaScript 参数上限，抛裸 `RangeError`——宿主异常，服务层按类分出会漏成 500。 */
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
  // 内联 SVG 是可见图形：连子树剥除（口径见文件头注③）。告警由 `warnStrippedInlineSvg` 在
  // 「这份文档到底变成了什么」定下来之后统一发，这里只记数。
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

/** 结构容器节点（div，四类结构参数恒 null）。元素节点的形状（含「只留明确字段」那条口径）
 *  只写在这里：`elementNode` 在它的基础上加 tag 与结构参数，编排层用它承接被顶替容器的锚点身份。 */
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

/** 链接角色：从 `epub:type` 读（脚注引用 / 反向链接），其余为普通链接。
 *  取值集合的主人不在这里——`LinkRole` 住 `shared/wire.ts`，铸造方与消费方共用一份。 */
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
 * 一张读不出的图能留下的东西：**说明文字**（alt 是内容，不是装饰）与**这个元素承载的锚点位置**。
 * 锚点必须有落点——绑定期已经把它算成树上的位置，这里不给它留一个空容器，指向这一处的目录条目就会
 * 绑到一个不存在的节点（`SvgOnlyPage.carriedAnchors` 警告过的同一件事）。
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
 *
 * 为什么要认领：撞名时扫描期只铸了一个 ID，而映射是「名字 → ID」的，后出现的同名元素照样查得到它。
 * 若它也把那个 ID 当自己的节点 ID，树上就会出现两个同 ID 节点——目录落位与进度断点都会在两处之间
 * 挑错一个。承载者是文档序第一个（与 `scanXhtml` 的 `duplicates` 同一口径），后来的同名元素照常
 * 作为正文读出来，只是拿一个新铸的普通节点 ID。
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
