import type { ChapterAnchor } from './progress.js'
import type { ReaderPort, VisibleNode } from './reader-session.js'
import { listenParagraphElement } from './reader-paragraph.js'
import {
  contentOriginTop, portScrollHeight, portScrollTop, portViewHeight, portViewTop, setPortScrollTop,
} from './scrollport.js'
import { PHRASING_TAGS } from '../shared/content-tags.js'
import { findNovelNode, novelNodes, NOVEL_NODE_ATTR } from './util.js'
import { clampTopInset, crossedIndex, spanRelativeTo } from './viewport-top.js'
import type { ItemSpan } from './viewport-top.js'

/**
 * 阅读器几何：把 DOM 测量实现成一个 `ReaderPort`，视图只提供最小元素源。从视图搬出来是因为这套测量
 * 有两套坐标系与一条读取顺序；放在视图闭包里时唯一能证它的方式是整页渲染并改写原型方法，
 * 而它一旦错，症状是进度静默错位。几何因此可在假元素上直接测，视图只剩 ref 接线。
 */
const PIDX_ANCHOR_PREFIX = 'pidx:'
const HEAD_ANCHOR = 'pidx:head'

function chapterHeadingElement(block: Element): Element | null {
  for (const el of block.querySelectorAll('h2.novel-rdr-mark')) {
    if (el.getAttribute('class')?.split(/\s+/).includes('novel-rdr-mark') === true) return el
  }
  return null
}

function parsePidxAnchor(anchorId: string): { raw: string; pidx: number } | null {
  if (!anchorId.startsWith(PIDX_ANCHOR_PREFIX)) return null
  const raw = anchorId.slice(PIDX_ANCHOR_PREFIX.length)
  const pidx = Number(raw)
  if (raw === '' || !Number.isInteger(pidx)) return null
  return { raw, pidx }
}

function pidxElementsOf(block: Element): Map<string, Element> {
  const byPidx = new Map<string, Element>()
  for (const el of block.querySelectorAll('[data-pidx]')) {
    const raw = el.getAttribute('data-pidx')?.trim()
    if (raw === undefined || raw === '' || !Number.isInteger(Number(raw))) continue
    // 空行/纯标点行与后续正文共享同一 data-pidx：后出现覆盖先出现，与 listenParagraphElement 同口径命中真实正文块。
    byPidx.set(raw, el)
  }
  return byPidx
}

function findAnchorElement(block: Element, anchorId: string | null): Element | null {
  if (anchorId === null) return block
  if (anchorId === HEAD_ANCHOR) return chapterHeadingElement(block)
  const parsed = parsePidxAnchor(anchorId)
  if (parsed !== null) {
    return pidxElementsOf(block).get(parsed.raw) ?? listenParagraphElement(block, parsed.pidx)
  }
  return findNovelNode(block, anchorId)
}

export interface ReaderGeometrySource {
  /** 真实滚动容器（`findScrollport` 的产物）；null = 文档自身在滚 */
  port(): HTMLElement | null
  /** 未载边界哨兵；不在 DOM → null（不预取） */
  sentinel(): HTMLElement | null
  /** 已渲染章块（按章号；缺席 = 该章还没渲染） */
  chapters(): ReadonlyArray<HTMLElement | null>
  /** 视口顶的固定遮挡高度：`currentNode` 按**看得见的顶**取节点。缺省 0。注意它只影响「视口顶是哪个
   *  节点」：`targetOffset` 给的是相对视口顶的屏幕偏移，让位由会话统一做（两处各减一次就减两次）。 */
  topInset?(): number
}

export function createReaderGeometry(source: ReaderGeometrySource): ReaderPort {
  return {
    measureAnchors: () => {
      // 锚点 = 章块相对「滚动内容原点」的偏移 + 该章渲染高度（跨度唯一来源，两向才互逆）。
      // 不能用 offsetTop：宿主的滚动容器在阅读器之外，两套坐标系混用会让 locateChapter 恒判第 0 章。
      const origin = contentOriginTop(source.port())
      const list: ChapterAnchor[] = []
      const blocks = source.chapters()
      for (let i = 0; i < blocks.length; i++) {
        const el = blocks[i]
        if (el !== null && el !== undefined) {
          const rect = el.getBoundingClientRect()
          list.push({ index: i, start: rect.top - origin, height: rect.height })
        }
      }
      return list
    },
    scrollTop: () => portScrollTop(source.port()),
    setScrollTop: (px) => setPortScrollTop(source.port(), px),
    viewHeight: () => portViewHeight(source.port()),
    scrollHeight: () => portScrollHeight(source.port()),
    sentinelOffset: () => {
      const sentinel = source.sentinel()
      if (sentinel === null) return null
      return sentinel.getBoundingClientRect().top - portViewTop(source.port())
    },
    /** 目标相对**滚动视口顶**；章块/节点不在 DOM → null（会话据此不落位、等下一轮）。 */
    targetOffset: (index, anchorId) => {
      const block = source.chapters()[index]
      if (block === null || block === undefined) return null
      const target = findAnchorElement(block, anchorId)
      if (target === null) return null
      return target.getBoundingClientRect().top - portViewTop(source.port())
    },
    targetOffsets: (index, anchorIds) => {
      const block = source.chapters()[index]
      if (block === null || block === undefined) return anchorIds.map(() => null)
      const viewTop = portViewTop(source.port())
      const byId = new Map<string, Element>()
      for (const el of novelNodes(block)) {
        const id = el.getAttribute(NOVEL_NODE_ATTR)
        if (id !== null && !byId.has(id)) byId.set(id, el)
      }
      const needsPidx = anchorIds.some((id) => id !== null && id.startsWith(PIDX_ANCHOR_PREFIX))
      const byPidx = needsPidx ? pidxElementsOf(block) : null
      return anchorIds.map((anchorId) => {
        if (anchorId === null) return block.getBoundingClientRect().top - viewTop
        if (anchorId === HEAD_ANCHOR) {
          const target = chapterHeadingElement(block)
          return target === null ? null : target.getBoundingClientRect().top - viewTop
        }
        const parsed = parsePidxAnchor(anchorId)
        if (parsed !== null) {
          const target = byPidx?.get(parsed.raw) ?? listenParagraphElement(block, parsed.pidx)
          return target === null ? null : target.getBoundingClientRect().top - viewTop
        }
        const target = byId.get(anchorId)
        return target === undefined ? null : target.getBoundingClientRect().top - viewTop
      })
    },
    currentNode: () => currentNodeOf(
      source.chapters(), portViewTop(source.port()) + clampTopInset(source.topInset?.()),
    ),
    /** 听书段 → 屏上块：段号命中判据归 `client/reader-paragraph.ts`，这里只把块几何换成相对视口顶的偏移。 */
    targetOffsetOfParagraph: (index, paragraphIndex) => {
      const block = source.chapters()[index]
      if (block === null || block === undefined) return null
      const target = listenParagraphElement(block, paragraphIndex)
      if (target === null) return null
      const rect = target.getBoundingClientRect()
      return { top: rect.top - portViewTop(source.port()), height: rect.height }
    },
  }
}

const PHRASING_DOM_TAGS: ReadonlySet<string> = new Set([...PHRASING_TAGS].map((tag) => tag.toUpperCase()))

/** 节点形状：几何过滤只认这三个读数，浏览器门把同一形状从页内序列化后复用同一判据。 */
interface NovelNodeShape {
  tagName: string
  className: string | null
  /** 是否落在表格单元格内（单元格自己也算）：由调用方按 `closest('td, th')` 填 */
  inTableCell: boolean
}

/** 节点是否占一条独立纵向块带：排除段落内短语子元素与并排表格单元格（它们滚出后会让父段误判进空档）。
 *  短语词表与渲染降级共用 `shared/content-tags.ts` 的 `PHRASING_TAGS`，不在这里另抄一份；
 *  `.novel-fig` 与 `.novel-ref-part` 虽渲染成 span 却占独立块带，`.novel-ref-block` 是块级链接，三者保留。 */
export function isFlowNovelNode({ tagName, className, inTableCell }: NovelNodeShape): boolean {
  if (inTableCell) return false
  const tag = tagName.toUpperCase()
  const classes = className === null ? null : className.trim().split(/\s+/)
  if (tag === 'SPAN') {
    return classes !== null && (classes.includes('novel-fig') || classes.includes('novel-ref-part'))
  }
  if (tag === 'BUTTON') {
    return classes !== null && classes.includes('novel-ref-block')
  }
  return tag !== 'BR' && !PHRASING_DOM_TAGS.has(tag)
}

/** 视口顶所在的正文节点：先按章块过 `crossedIndex` 判章，再在同一章内判节点（与进度锚点、听书探针
 *  同口径，含空档归下一项，`ADR-0106`）；图文章按 `data-novel-node` 并过滤短语与单元格子元素，
 *  文字章按章标题与 `data-pidx`（带 `pidx:` 前缀）；两者都没有 → null。 */
export function currentNodeOf(
  blocks: ReadonlyArray<HTMLElement | null>, viewTop: number,
): VisibleNode | null {
  const chapterIndex = crossedIndex(blocks, (block) => {
    const rect = block.getBoundingClientRect()
    return spanRelativeTo(rect.top, rect.bottom, viewTop)
  })
  if (chapterIndex === -1) return null
  const block = blocks[chapterIndex]
  if (block === null || block === undefined) return null

  const nodes: Array<{ nodeId: string } & ItemSpan> = []
  const richNodes = novelNodes(block)
  if (richNodes.length > 0) {
    const flowNodes = richNodes.filter((el) => isFlowNovelNode({
      tagName: el.tagName,
      className: el.getAttribute('class'),
      inTableCell: el.closest('td, th') !== null,
    }))
    // 整章只剩行内节点时保留原候选：宁可把行内节点当锚点，也不让采点整章丢失。
    // 这条兜底只管「丢不丢锚点」，不参与空档归项——别把它读成缝归例外。
    const candidates = flowNodes.length > 0 ? flowNodes : richNodes
    for (const el of candidates) {
      const nodeId = el.getAttribute(NOVEL_NODE_ATTR)
      if (nodeId === null) continue
      const rect = el.getBoundingClientRect()
      nodes.push({ nodeId, ...spanRelativeTo(rect.top, rect.bottom, viewTop) })
    }
  } else {
    const heading = chapterHeadingElement(block)
    if (heading !== null) {
      const rect = heading.getBoundingClientRect()
      nodes.push({ nodeId: HEAD_ANCHOR, ...spanRelativeTo(rect.top, rect.bottom, viewTop) })
    }
    for (const [raw, el] of pidxElementsOf(block)) {
      const rect = el.getBoundingClientRect()
      nodes.push({ nodeId: `${PIDX_ANCHOR_PREFIX}${raw}`, ...spanRelativeTo(rect.top, rect.bottom, viewTop) })
    }
  }
  const at = crossedIndex(nodes, (cand) => cand)
  const hit = at === -1 ? undefined : nodes[at]
  return hit === undefined ? null : { index: chapterIndex, nodeId: hit.nodeId, offsetWithinNode: -hit.start }
}
