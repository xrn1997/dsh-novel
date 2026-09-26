import type { CSSProperties, ReactNode } from 'react'
import { Fragment, createElement, useState } from 'react'
import { resourceUrl } from '../../shared/wire.js'
import type { ChapterContent, ContentNode, ContentTag, LinkRole, ReadingTarget } from './types.js'

/**
 * 图文正文渲染器：EPUB 白名单树的**唯一呈现实现**（文字章原样过，图文章按白名单显式映射）。
 *
 * 三条硬边界（不是风格偏好）：
 *  ① **没有 HTML 注入入口**：书内文本一律当 React 子节点（自动转义），不碰 dangerouslySetInnerHTML，
 *     也不把任何书内字符串写进 style/onError/src 这类危险位置；
 *  ② **属性逐个明确赋值**：wire 的节点不带通用 attributes 袋，这里也不展开外部对象——
 *     展开一次，未净化的原书属性就有了进 DOM 的路；
 *  ③ **链接不是 `<a>`**：raw href 会把书内 URL 变成可点击导航（外站/协议）。内部跳转一律走
 *     `onNavigate(ReadingTarget, role)`，由上层（阅读会话 / 注释面板）决定去哪个阅读单元。
 *
 * 呈现只管结构：颜色与字号一律**继承容器**——同一组件在两处渲染（阅读流是纸张色 + 阅读设置字号，
 * 注释面板是控制器层 token），组件自己钉色必然在另一处不可读。视觉规则住 `styles.tsx`。
 */

/** 链接角色（normal | noteref | backlink）的住址在 types.ts 的再导出桶——它从 wire 的 link 节点派生，
 *  这里只是它的消费方；此处再导出一次，是为了让既有的 `from './ChapterBody.js'` 引用继续可用。 */
export type { LinkRole }

/** 白名单标签 → DOM 元素名。恒等映射不是冗余：`Record<ContentTag, …>` 让白名单漏一个即编译红。
 *
 *  查表**先过 `Object.hasOwn`**：落盘文档是本分支别处已按不可信输入加固过的东西
 *  （`services/localbooks.ts` 的 `getResource`/`readDocument` 只认自有键），而这里原先直接
 *  `TAG_OF[node.tag]` 会走原型链——被篡改的 `tag: 'constructor'` 取到的是函数而不是元素名，
 *  `createElement` 抛错把整个阅读器打崩。`Object.hasOwn` 之后「认不出的标签」走的仍是
 *  下面那条保留子内容的降级路（与白名单外的标签同一个出口）。 */
const TAG_OF: Record<ContentTag, string> = {
  p: 'p', div: 'div', span: 'span', h1: 'h1', h2: 'h2', h3: 'h3', h4: 'h4', h5: 'h5', h6: 'h6',
  strong: 'strong', em: 'em', ul: 'ul', ol: 'ol', li: 'li', blockquote: 'blockquote',
  pre: 'pre', code: 'code', sup: 'sup', sub: 'sub', table: 'table', caption: 'caption',
  thead: 'thead', tbody: 'tbody', tfoot: 'tfoot', tr: 'tr', th: 'th', td: 'td',
}

/** 渲染上下文：书身份（图片 URL 与 DOM id 都要它）、文档 ID（DOM id 组合）、跳转回调，
 *  以及**是否落在链接里**——链接渲染成 `<button>`，而 button 的内容模型只收短语级元素。 */
interface Ctx {
  bookKey: string
  documentId: string
  onNavigate: (target: ReadingTarget, role: LinkRole) => void
  inLink: boolean
}

/** `<button>` 允许直接容纳的白名单标签（短语级）。集合外的都是流级元素：XHTML 的 `<a>` 允许它们
 *  做子节点（源书合法），HTML 不允许——浏览器会替我们重排 DOM，节点位置就不由渲染说了算。
 *  链接上下文里这些标签降级成 span，块状观感由样式层的 `.novel-ref-part` 用 CSS 拿回。 */
const PHRASING_TAGS: ReadonlySet<ContentTag> = new Set(['span', 'strong', 'em', 'code', 'sup', 'sub'])

/** 正文节点的 DOM id = 书身份 + 文档 ID + 节点 ID（设计口径）：宿主 DOM 里也常有自己的 id，
 *  只写裸锚点会撞。**查找不靠这个 id**（外部 id 不进选择器），`data-novel-node` 才是钩子。
 *  非 [A-Za-z0-9_-] 一律折成 -：id 属性里出现空白就是非法值（bookKey 是 URL，什么字符都可能有）。 */
function domNodeId(ctx: Ctx, nodeId: string): string {
  return ['novel', ctx.bookKey, ctx.documentId, nodeId].map((p) => p.replace(/[^\w-]+/g, '-')).join('--')
}

/** 节点 key：文本节点按序号（它们没有 id），其余按节点 id——同一批兄弟里两类前缀不同，不会撞 */
const keyOf = (node: ContentNode, index: number): string => (node.kind === 'text' ? `t${index}` : `#${node.id}`)

/**
 * 链接内容里有块级内容吗（插图 / 分隔线 / 非短语级元素）。
 *
 * 有的话链接自己必须是**块级容器**（`.novel-ref-block`）：`<button>` 缺省按内容收缩包裹，于是
 * 里面那个 `width: 100%` 的插图框解析成 auto——图还没解码时没有内在尺寸，框塌成 0（实测链接里的
 * 600×900 图在到手前量到 0×0、到手后跳到 600×900，后文位移近一屏，「图片延迟不改变恢复位置」失效）。
 * XHTML5 的 `<a>` 是透明内容模型——含块内容的链接在渲染上本来就是块级，这里只是把它显式化。
 */
function hasBlockChild(children: readonly ContentNode[]): boolean {
  return children.some((n) => n.kind === 'image' || n.kind === 'rule'
    || (n.kind === 'element' && !PHRASING_TAGS.has(n.tag)))
}

function renderNode(node: ContentNode, index: number, ctx: Ctx): ReactNode {
  switch (node.kind) {
    case 'text':
      return node.text                                     // 原样当子节点（React 转义；不解析 HTML）
    case 'break':
      return <br key={keyOf(node, index)} id={domNodeId(ctx, node.id)} data-novel-node={node.id} />
    case 'rule':
      // 分隔线是流级元素：在链接里降级成 span（样式层用 .novel-ref-rule 画回那条线）
      return ctx.inLink
        ? <span key={keyOf(node, index)} className="novel-ref-part novel-ref-rule" id={domNodeId(ctx, node.id)} data-novel-node={node.id} />
        : <hr key={keyOf(node, index)} id={domNodeId(ctx, node.id)} data-novel-node={node.id} />
    case 'image':
      return <Figure key={keyOf(node, index)} node={node} ctx={ctx} />
    case 'link':
      return (
        <button
          key={keyOf(node, index)}
          type="button"
          className={hasBlockChild(node.children) ? 'novel-ref novel-ref-block' : 'novel-ref'}
          id={domNodeId(ctx, node.id)}
          data-novel-node={node.id}
          data-novel-role={node.role}
          onClick={() => ctx.onNavigate(node.target, node.role)}
        >
          {node.children.map((child, i) => renderNode(child, i, { ...ctx, inLink: true }))}
        </button>
      )
    case 'element':
      return <ElementNode key={keyOf(node, index)} node={node} ctx={ctx} />
  }
}

/** 白名单元素：只按种类带字段（rowSpan/colSpan 只对单元格、start 只对 ol、value 只对 li），
 *  其余位置即便载荷带了值也不落地——客户端不发明属性。 */
function ElementNode({ node, ctx }: {
  node: Extract<ContentNode, { kind: 'element' }>
  ctx: Ctx
}): ReactNode {
  // 只认自有键：原型链上的名字（'constructor' 这类）不是白名单标签，取到非元素名会打崩渲染
  const known: string | undefined = Object.hasOwn(TAG_OF, node.tag) ? TAG_OF[node.tag] : undefined
  const children = node.children.map((child, i) => renderNode(child, i, ctx))
  if (known === undefined) {
    // 认不出的标签不发明元素：保留子内容（宁可少一层容器，不可多一个白名单外的标签）
    return <Fragment>{children}</Fragment>
  }
  // 链接（`<button>`）里的块级子节点降级成 span——非法嵌套不是「浏览器会帮我们收拾」：
  // 它会重排 DOM，节点位置与 `data-novel-node` 的落点就不再由渲染决定。
  const downgrade = ctx.inLink && !PHRASING_TAGS.has(node.tag)
  const tag = downgrade ? 'span' : known
  const cell = !downgrade && (node.tag === 'td' || node.tag === 'th')
  const attrs: {
    id: string; 'data-novel-node': string; className?: string
    rowSpan?: number; colSpan?: number; start?: number; value?: number
  } = {
    id: domNodeId(ctx, node.id),
    'data-novel-node': node.id,
  }
  if (downgrade) attrs.className = 'novel-ref-part'
  if (cell && node.rowSpan !== null) attrs.rowSpan = node.rowSpan
  if (cell && node.colSpan !== null) attrs.colSpan = node.colSpan
  if (!downgrade && node.tag === 'ol' && node.start !== null) attrs.start = node.start
  if (!downgrade && node.tag === 'li' && node.value !== null) attrs.value = node.value
  const el = createElement(tag, attrs, ...children)
  // 宽表套一层滚动容器（宽度归容器，滚动归样式层）：表格本体不缩，宿主不被撑宽。
  // 链接里的表已被降级，不再套 div（那正是要 avoid 的非法嵌套）。
  return node.tag === 'table' && !downgrade ? <div className="novel-table-wrap">{el}</div> : el
}

/** 插图：显示框由**可信宽高**提前占位（值槽 --novel-fig-ratio），加载完成或失败都不收缩框。
 *  失败时给出可见说明而不是留一个破图图标——「空着」与「加载失败」不是同一件事。 */
function Figure({ node, ctx }: {
  node: Extract<ContentNode, { kind: 'image' }>
  ctx: Ctx
}): ReactNode {
  const [failed, setFailed] = useState(false)
  // 宽高比只在**可信宽高**（有限且为正）时落地：NaN / Infinity 会拼出一份浏览器认不出的
  // aspect-ratio（框塌成 0 或整条规则被丢弃），占位反而失效——宁可退回样式层的兜底比值。
  const sized = Number.isFinite(node.width) && Number.isFinite(node.height) && node.width > 0 && node.height > 0
  const ratio = sized ? `${node.width} / ${node.height}` : undefined
  return (
    <span
      className="novel-fig"
      id={domNodeId(ctx, node.id)}
      data-novel-node={node.id}
      data-resource-id={node.resourceId}
      style={ratio === undefined ? undefined : ({ '--novel-fig-ratio': ratio } as CSSProperties)}
    >
      {failed
        ? (
          <span className="novel-fig-fail" role="img"
            aria-label={node.alt === '' ? '图片加载失败' : `图片加载失败：${node.alt}`}>
            图片加载失败
          </span>
        )
        : (
          <img
            alt={node.alt}
            src={resourceUrl(ctx.bookKey, node.resourceId)}
            loading="lazy"
            onError={() => setFailed(true)}
          />
        )}
    </span>
  )
}

/**
 * 章节正文：`kind:'text'` 逐行成段（切分与现阅读器一字不差——换模型不换读感）；
 * `kind:'rich'` 走上面的白名单映射。两形态都由来源显式决定，不做猜测。
 */
export function ChapterBody({ content, bookKey, onNavigate }: {
  content: ChapterContent
  bookKey: string
  /** 内部跳转：目标 + 链接角色（normal | noteref | backlink）。去哪儿由上层决定 */
  onNavigate: (target: ReadingTarget, role: LinkRole) => void
}): ReactNode {
  const ctx: Ctx = { bookKey, documentId: content.kind === 'rich' ? content.documentId : '', onNavigate, inLink: false }
  return (
    <div className="novel-body">
      {content.kind === 'text'
        ? content.text.split('\n').map((para, i) => <p key={i}>{para}</p>)
        : content.nodes.map((node, i) => renderNode(node, i, ctx))}
    </div>
  )
}
