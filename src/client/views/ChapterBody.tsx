import type { CSSProperties, ReactNode } from 'react'
import { Fragment, createElement, useMemo, useState } from 'react'
import { chapterContentLines, playUnitStarts, playUnitStartsByNode } from '../../shared/chapter-text.js'
import { resourceUrl } from '../../shared/wire.js'
import { useCopy } from '../copy/index.js'
import { paragraphSlotOf } from '../tts/reading-position.js'
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
 * 注释面板是控制器层 token），组件自己钉色必然在另一处不可读。视觉规则住 `styles/reader.ts`。
 */

/** 白名单标签 → DOM 元素名。恒等映射不是冗余：`Record<ContentTag, …>` 让白名单漏一个即编译红。
 *
 *  查表**先过 `Object.hasOwn`**：直接 `TAG_OF[node.tag]` 会走原型链——被篡改的
 *  `tag: 'constructor'` 取到函数而不是元素名，`createElement` 抛错把整个阅读器打崩。
 *  之后「认不出的标签」走保留子内容的降级路（与白名单外的标签同一个出口）。 */
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
  /** 富文本块节点的起始段号（`playUnitStartsByNode` 从共享行清单挑行）；文字章不用这张表。 */
  pids: ReadonlyMap<string, number>
  /** 跟读高亮命中的**块身份**（null = 本章不在听 / 没命中）：不可朗读块与它后面第一块可能共享
   *  起段号，按段号值比会一次点亮多块；命中判据与文字章共用「取最后一个 ≤ 段号的格」。 */
  liveNode: string | null
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
 * 有的话链接自己必须是**块级容器**（`.novel-ref-block`）：`<button>` 缺省按内容收缩包裹，里面
 * `width: 100%` 的插图框会解析成 auto——图未解码时框塌成 0，到手后后文位移（钉子见
 * `tests/client/chapter-body.test.tsx`），「图片延迟不改变恢复位置」失效。XHTML5 的 `<a>` 是透明内容模型，含块内容的链接本来就是块级，这里显式化。
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
  if (known === undefined) {
    // 认不出的标签不发明元素：保留子内容（宁可少一层容器，不可多一个白名单外的标签）
    return <Fragment>{node.children.map((child, i) => renderNode(child, i, ctx))}</Fragment>
  }
  // 链接（`<button>`）里的块级子节点降级成 span——非法嵌套不是「浏览器会帮我们收拾」：
  // 它会重排 DOM，节点位置与 `data-novel-node` 的落点就不再由渲染决定。
  const downgrade = ctx.inLink && !PHRASING_TAGS.has(node.tag)
  // 段号只给**起行**的块元素（判据在共享行清单里）；降级成 span 的块不再是块，不带段号
  const paragraph = downgrade ? undefined : ctx.pids.get(node.id)
  const live = paragraph !== undefined && ctx.liveNode !== null && node.id === ctx.liveNode
  const children = node.children.map((child, i) => renderNode(child, i, ctx))
  const tag = downgrade ? 'span' : known
  const cell = !downgrade && (node.tag === 'td' || node.tag === 'th')
  const attrs: {
    id: string; 'data-novel-node': string; className?: string; 'data-pidx'?: string
    rowSpan?: number; colSpan?: number; start?: number; value?: number
  } = {
    id: domNodeId(ctx, node.id),
    'data-novel-node': node.id,
  }
  if (paragraph !== undefined) attrs['data-pidx'] = String(paragraph)
  if (downgrade) attrs.className = 'novel-ref-part'
  else if (live) attrs.className = 'novel-tts-live'
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
  const t = useCopy()
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
            aria-label={node.alt === '' ? t('reader.imageFailed') : t('reader.imageFailedAlt', { alt: node.alt })}>
            {t('reader.imageFailed')}
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

const NO_PARAGRAPH_IDS: ReadonlyMap<string, number> = new Map()

/**
 * 章节正文：`kind:'text'` 逐行成段（切分与现阅读器一字不差——换模型不换读感）；
 * `kind:'rich'` 走上面的白名单映射。两形态都由来源显式决定，不做猜测。
 *
 * 起行的正文块带 `data-pidx`（0 基段号，= 该块起始行之前的播放单元数）：阅读探针与「从本段听」
 * 都按它把 DOM 几何换成听书位置。文字章逐行折算；图文章按 `shared/chapter-text` 的行清单折算——
 * 两种形态的段号都与播放层 `splitParagraphs(chapterContentToText(content))` 同一口径。
 * 选区与「从本段听」浮钮**不在本组件**：它们属于阅读器一份（`views/listen-from-selection.ts`），
 * 本组件只往 DOM 上写段号与章身份，连续滚动下不再每章各挂一套 document 监听。
 * `listenParagraph` 给定时（本书本章正在听）把命中的正文块标成跟读高亮：只标记、不写位置；
 * 视口跟随归阅读器（`ADR-0091`），高亮本身不滚也不改布局。
 */
export function ChapterBody({ content, bookKey, onNavigate, paragraphBase = 0, listenParagraph = null }: {
  content: ChapterContent
  bookKey: string
  /** 内部跳转：目标 + 链接角色（normal | noteref | backlink）。去哪儿由上层决定 */
  onNavigate: (target: ReadingTarget, role: LinkRole) => void
  /** 本章首行之前的播放单元数（被呈现层剥掉的重复章名）；只有文字章用得上。
   *  不补这个偏移，播放层读的原样正文比屏上多出前缀，「从本段听」与探针起播会系统性早一段。 */
  paragraphBase?: number
  /** 正在念的播放单元号（null = 本章不在听）；高亮命中判据归 `paragraphSlotOf` */
  listenParagraph?: number | null
}): ReactNode {
  const lineOffsets = useMemo(
    () => content.kind === 'text'
      ? playUnitStarts(content.text.split('\n').map((text) => ({ text })))
        .map((start) => start + paragraphBase)
      : null,
    [content, paragraphBase],
  )
  const richIds = useMemo(
    () => content.kind === 'rich' ? playUnitStartsByNode(chapterContentLines(content)) : null,
    [content],
  )
  /** 图文章的块序：`playUnitStartsByNode` 的条目按起段号排序（并列保持行清单里的先后）。
   *  为什么要块序而不只留起段号：不可朗读块（分隔符 / 纯标点行）与它后面第一块同起段号，
   *  高亮若按段号值比，一次点亮两块、画两枚三角（文字章逐行比的是格子下标，没有这个形态）。 */
  const richBlocks = useMemo(() => {
    if (richIds === null) return null
    const blocks = [...richIds.entries()].sort(([, a], [, b]) => a - b)
    return { starts: blocks.map(([, start]) => start), ids: blocks.map(([id]) => id) }
  }, [richIds])
  const liveLine = listenParagraph === null || lineOffsets === null
    ? -1
    : paragraphSlotOf(lineOffsets, listenParagraph)
  const liveNode = listenParagraph === null || richBlocks === null
    ? null
    : richBlocks.ids[paragraphSlotOf(richBlocks.starts, listenParagraph)] ?? null

  const ctx: Ctx = {
    bookKey,
    documentId: content.kind === 'rich' ? content.documentId : '',
    onNavigate,
    inLink: false,
    pids: richIds ?? NO_PARAGRAPH_IDS,
    liveNode,
  }
  return (
    <div className="novel-body">
      {content.kind === 'text'
        ? content.text.split('\n').map((para, i) => (
          <p key={i} data-pidx={lineOffsets?.[i] ?? paragraphBase + i}
            className={i === liveLine ? 'novel-tts-live' : undefined}>
            {para}
          </p>
        ))
        : content.nodes.map((node, i) => renderNode(node, i, ctx))}
    </div>
  )
}
