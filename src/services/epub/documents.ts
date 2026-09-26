import type { AnyNode, Element } from 'domhandler'
import type { ContentNode, ContentTag, ReadingTarget } from '../../shared/wire.js'
import { EpubImportError } from './errors.js'
import type { EpubWarningLog } from './warnings.js'
import { WARN_ACTIVE_ATTR, WARN_CSS_ATTR, WARN_INLINE_SVG, WARN_REMOVED } from './warnings.js'
import { attrOf, firstDescendant, isElement, localName, textOf, type XmlBudget } from './xml.js'

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
 * ③ **可见内容不许静默消失**：认得出的白名单元素照转，未知元素保留子内容（带锚点的另包一层 span
 *    以留住锚点），活动/交互元素连子树剥除但**必须记告警**。
 *    **正文内联 SVG 是「剥离 + 告警」，不是报错**：设计里的 SVG 条款讲的是交给浏览器的 `image/svg+xml`
 *    **资源**；正文里的一层花饰/首字下沉若按「拒整本」处理，与同层其它装饰性失败（style 属性、
 *    未知容器）极不对称，也与「纯图片阅读单元是有效正文」之外的一切「不静默」口径不符。
 *    代价如实记：这些文档会丢掉内联矢量图形（有告警点名文档与处数，不是静默丢）。
 *    **唯一例外**：内联 SVG 是该文档**唯一**内容（剥离后没有别的可见节点）时，本层**不判**——
 *    交回 `svgOnly` 候选让编排层裁决。真书里这一页通常是 EPUB3 推荐的整页封面（一层 div 包一棵
 *    SVG，SVG 里只有一张 `<image>` 指向书内那张封面图），它**有内容**，按空章节拒掉会把标准写法
 *    当坏书整本杀掉（2026-09-26 真书反例：Gutenberg #7337 图像版）。裁决口径与那条拒绝的原话
 *    （`svgOnlyPageReason`）在 `import.ts`：图落得下就导成单图章节并留降级说明，落不下仍拒整本。
 *    独立 SVG **资源**仍走白名单重建，白名单外的
 *    可见元素（`foreignObject`/`use`/嵌套 `image`…）报错点名资源（见 `resources.ts`）。
 * ④ **被剥离子树里的锚点是一份事实，不是「没有这个锚点」**：`scanXhtml` 把它们记进 `strippedAnchors`
 *    （不是 `anchors`——那段内容不在树上，落不到）。绑定期据此把目标**降级**（导航跳到文档开头、
 *    正文内链降级成纯文本）并记告警，而不是按「锚点不存在」拒整本：锚点确实在源文档里，是**我们
 *    自己**剥掉了承载它的图形，事实清楚（降级口径与告警码见 `import.ts`）。反过来，拼写错、指向
 *    从未存在的 id 仍然是坏书——「宁炸不猜」针对的是「我们读不懂/没有这个目标」。
 */

/** 链接角色：从 `epub:type` 读（脚注引用 / 反向链接），其余为普通链接 */
export type LinkRole = 'normal' | 'noteref' | 'backlink'

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
 * `strippedAnchors` 是与 `anchors` **分开的一份事实**：这些名字在被剥离的子树里（内联 SVG、活动
 * 内容），那段内容不在树上、没有可落的位置，所以不铸 ID；但「这个锚点曾经存在」正是绑定期区分
 * 两种失败所依据的判据——「锚点从未存在」（坏书，拒整本）与「锚点存在过、是本插件自己剥掉了承载
 * 它的图形」（降级 + 告警，见 `import.ts` 口径②）。两件事折叠成一件事就会让一层装饰杀掉整本书。
 *
 * `images` 与 `links` 都是**原始 href**（还没按文档目录解释）：调用方要在转换之前把它们全部
 * 解析/验证完（图片尤其：转换是同步遍历，读盘与验证必须在之前做完），转换期只查表。
 */
export interface XhtmlScan {
  readonly anchors: ReadonlyMap<string, string>
  readonly strippedAnchors: ReadonlySet<string>
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
  readonly resolveImage: (src: string, alt: string) => ImageBinding
  readonly nextNodeId: () => string
  readonly warnings: EpubWarningLog
  /** 本份文档剥离过的内联 SVG 数：只在「剥完什么都不剩」时用来给出精确原因 */
  readonly inlineSvg: { stripped: number }
}

export interface XhtmlConvertOptions {
  readonly budget: XmlBudget
  readonly anchors: ReadonlyMap<string, string>
  /** 内部链接绑定：返回目标；返回 null = 保留文字、取消可点击性（调用方已记告警）；抛错 = 必须拒绝。
   *  角色（普通/脚注引用/反向链接）由本层按 `epub:type` 判定，不进这个口——绑定只关心「去哪」 */
  readonly resolveLink: (href: string) => ReadingTarget | null
  /** 图片绑定：返回资源与显示宽高；远程/损坏资源在这里抛错（点名资源） */
  readonly resolveImage: (src: string, alt: string) => ImageBinding
  /** 节点 ID 铸造（导入期唯一，跨文档不重复）；锚点 ID 已在扫描期铸好、不在这里取号 */
  readonly nextNodeId: () => string
  readonly warnings: EpubWarningLog
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
   * 为什么要带出去：扫描期已把这些容器的锚点铸成 ID（`scanXhtml` 只对**被整棵剥除**的子树里的锚点
   * 另走 `strippedAnchors`；一层包着 SVG 的 `div` 是普通容器，它的锚点在 `anchors` 里），于是目录与
   * 正文里指向 `#cover` 这类锚点的目标会绑到一个**树上不存在的 ID**——落位退化成章首、目录当前项
   * 也量不到。编排层拿这份清单在替代出来的那张图上逐层包容器，身份这才有着落（实测：只有图片节点、
   * 锚点悬空）。
   */
  readonly carriedAnchors: readonly string[]
}

export interface ConvertedXhtml {
  readonly nodes: ContentNode[]
  /** 文档标题（head 的 title；缺则 null）——无目录时章名的兜底来源 */
  readonly title: string | null
  /** 整页只有一棵内联 SVG 时的候选（含它顶替掉的容器锚点），否则 null */
  readonly svgOnly: SvgOnlyPage | null
}

/** 「文档唯一内容是内联 SVG」那条拒绝的原话（单点：文档层与编排层两处都要说同一句话） */
export function svgOnlyPageReason(what: string): string {
  return `${what}：文档唯一的内容是内联 SVG（剥离后没有别的正文；本插件只支持独立的 SVG 图片资源）`
}

/**
 * 第一遍：建锚点映射与链接集合。
 *
 * 遍历与转换**同一处起点**（body 的子节点）与**同一条剥除规则**：body 自己的锚点不算
 * （body 不是树上的节点，目录指过去没有可落的位置），被剥除子树里的**链接/图片**不算（那段内容
 * 不在树上，内联 SVG 与活动元素都在此列）；被剥除子树里的**锚点名**另收进 `strippedAnchors`——
 * 它不是可落的位置，但「这个锚点存在过」是绑定期把目标降级而不是拒整本所依据的事实（口径见注④）。
 */
export function scanXhtml(root: Element, budget: XmlBudget, nextAnchorId: () => string): XhtmlScan {
  const anchors = new Map<string, string>()
  const strippedAnchors = new Set<string>()
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
        // 重复锚点即拒：同一份文档里同一个名字指两处，目标就有歧义（不许猜哪一个才算）
        for (const anchorName of names) {
          if (anchors.has(anchorName)) {
            throw new EpubImportError(`${budget.what}：文档里有重复锚点（锚点目标会有歧义）：${anchorName}`)
          }
        }
        // 同一元素上的 id 与 name 是同一个落点：铸一个锚点 ID，两个名字都指它
        // （各铸一个会让其中一个名字指向树上不存在的节点）
        const minted = nextAnchorId()
        for (const anchorName of names) anchors.set(anchorName, minted)
      }
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
  if (body !== null) walk(body)
  return { anchors, strippedAnchors, links, images }
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
 * 没有可显示内容（body 缺失，或 body 空/内容被全部剥除/只剩空白）即失败：一份读不出任何正文的
 * 「章节」留在书里比导入失败更坏——它会以空章节的样子冒充成功。
 */
export function convertXhtml(root: Element, opts: XhtmlConvertOptions): ConvertedXhtml {
  const body = firstDescendant(root, 'body', opts.budget)
  if (body === null) throw new EpubImportError(`${opts.budget.what}：不是可读的 XHTML（没有 body）`)
  const inlineSvg = { stripped: 0 }
  const ctx: Ctx = {
    budget: opts.budget,
    anchors: opts.anchors,
    resolveLink: opts.resolveLink,
    resolveImage: opts.resolveImage,
    nextNodeId: opts.nextNodeId,
    warnings: opts.warnings,
    inlineSvg,
  }
  const nodes = convertChildren(body.children, ctx)
  const title = documentTitle(root, opts.budget)
  if (hasVisibleContent(nodes)) {
    warnStrippedInlineSvg(ctx)
    return { nodes, title, svgOnly: null }
  }
  // 剥完什么都不剩：先分清「整页就是一棵图」与「真的空」。前者交回候选让编排层裁决——真书里
  // 这一页是 EPUB3 推荐的封面写法（一层 div 包一棵 SVG，SVG 里一张 `<image>` 指向书内封面图），
  // 按空章节拒掉会把整本正常书杀掉（2026-09-26 真书反例）。
  const svgOnly = soleInlineSvg(body)
  if (svgOnly !== null) return { nodes: [], title, svgOnly: { element: svgOnly, carriedAnchors: droppedAnchorIds(body, svgOnly, ctx) } }
  warnStrippedInlineSvg(ctx)
  throw new EpubImportError(inlineSvg.stripped > 0
    ? svgOnlyPageReason(opts.budget.what)
    : `${opts.budget.what}：文档里没有可显示的正文（body 为空，或内容全是被剥除的活动元素/空白）`)
}

/**
 * 内联 SVG 的剥离告警**延后到这里**发（不在 `convertElement` 里逐棵发）：整页就是一棵图的那种
 * 文档要么变成一张图、要么整本被拒，两种都不是「丢了装饰」——先发就成了自相矛盾的两句说明。
 * 逐棵 `add` 保留原来的合并语义（同类多处 → 「N 处」计数）。
 */
function warnStrippedInlineSvg(ctx: Ctx): void {
  for (let i = 0; i < ctx.inlineSvg.stripped; i += 1) {
    ctx.warnings.add(WARN_INLINE_SVG, ctx.budget.what, '移除了内联 SVG（本插件只支持独立的 SVG 图片资源，装饰性矢量不渲染）', '<svg>')
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
  return found.length === 1 ? found[0] : null
}

/**
 * body → 目标元素这条路径上各容器承载的锚点 ID（外层在前）。
 *
 * 与 `soleInlineSvg` 同一处起点（body）与同一条遍历：整页 SVG 被一张图顶替后，路径上那些容器
 * 都不在树上了，它们原先承载的锚点必须有新落点（见 `SvgOnlyPage.carriedAnchors`）。
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
    const id = anchorIdOf(el, ctx)
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
 *  一个元素可能展开成多个节点，**逐项追加**而不是 `push(...nodes)`：未知容器的子内容会被上提成
 *  一个很大的数组（实测一棵七万项的 `<dl>` 完全在节点预算内），展平传参就会撞 JavaScript 的参数
 *  上限，抛出一个裸 `RangeError`——那是宿主异常，服务层按类分流时会把它漏成 500。 */
function convertChildren(children: readonly AnyNode[], ctx: Ctx): ContentNode[] {
  const out: ContentNode[] = []
  for (const child of children) {
    if (child.type === 'text') out.push({ kind: 'text', text: child.data })
    else if (child.type === 'cdata') out.push({ kind: 'text', text: textOf(child, ctx.budget) })
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
    ctx.warnings.add(WARN_REMOVED, ctx.budget.what, '移除了活动内容（不执行书内脚本，不加载书内样式/表单/音视频）', name)
    return []
  }
  warnUnsafeAttributes(el, ctx)
  const anchorId = anchorIdOf(el, ctx)
  if (name === 'br') return [{ kind: 'break', id: anchorId ?? ctx.nextNodeId() }]
  if (name === 'hr') return [{ kind: 'rule', id: anchorId ?? ctx.nextNodeId() }]
  if (name === 'img') return [imageNode(el, anchorId, ctx)]
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

function linkRole(el: Element): LinkRole {
  const type = attrOf(el, 'type')
  if (type !== null) {
    const kinds = type.split(/\s+/)
    if (kinds.includes('noteref')) return 'noteref'
    if (kinds.includes('backlink')) return 'backlink'
  }
  return 'normal'
}

function imageNode(el: Element, anchorId: string | null, ctx: Ctx): ContentNode {
  const src = attrOf(el, 'src')
  if (src === null || src.trim() === '') {
    throw new EpubImportError(`${ctx.budget.what}：正文里的 <img> 没有 src（图片指向哪里无从知道，不静默丢）`)
  }
  const alt = attrOf(el, 'alt') ?? ''
  const binding = ctx.resolveImage(src.trim(), alt)
  return {
    kind: 'image', id: anchorId ?? ctx.nextNodeId(), resourceId: binding.resourceId,
    alt, width: binding.width, height: binding.height,
  }
}

/** 原书锚点名（`id` 或 `<a name>`）→ 扫描期铸好的锚点 ID；不在映射里（含空值）= 这个元素不承载锚点 */
function anchorIdOf(el: Element, ctx: Ctx): string | null {
  for (const name of anchorNamesOf(el)) {
    const hit = ctx.anchors.get(name)
    if (hit !== undefined) return hit
  }
  return null
}

/** 事件属性与 style 属性：剥除并记告警（前者是活动内容，后者是出版方 CSS） */
function warnUnsafeAttributes(el: Element, ctx: Ctx): void {
  for (const name of Object.keys(el.attribs)) {
    if (/^on/i.test(name)) {
      ctx.warnings.add(WARN_ACTIVE_ATTR, ctx.budget.what, '移除了事件属性（不执行书内脚本）', name.toLowerCase())
      continue
    }
    if (name.toLowerCase() === 'style') {
      ctx.warnings.add(WARN_CSS_ATTR, ctx.budget.what, '移除了 style 属性（本插件不加载出版方 CSS）', `<${localName(el.name)}>`)
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
