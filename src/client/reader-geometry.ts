import type { ChapterAnchor } from './progress.js'
import type { ReaderPort, VisibleNode } from './reader-session.js'
import { listenParagraphElement } from './reader-paragraph.js'
import {
  contentOriginTop, portScrollHeight, portScrollTop, portViewHeight, portViewTop, setPortScrollTop,
} from './scrollport.js'
import { findNovelNode, novelNodes, NOVEL_NODE_ATTR } from './util.js'
import { clampTopInset, crossedIndex } from './viewport-top.js'

/**
 * 阅读器几何：把 DOM 测量实现成一个 `ReaderPort`，视图只提供最小元素源。从视图搬出来是因为这套测量
 * 有两套坐标系与一条读取顺序；放在视图闭包里时唯一能证它的方式是整页渲染并改写原型方法，
 * 而它一旦错，症状是进度静默错位。几何因此可在假元素上直接测，视图只剩 ref 接线。
 */
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
      const target = anchorId === null ? block : findNovelNode(block, anchorId)
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
      return anchorIds.map((anchorId) => {
        const target = anchorId === null ? block : byId.get(anchorId)
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

/** 视口顶所在的正文节点：判据吃 `client/viewport-top.ts` 的 `crossedIndex`（与进度锚点、听书探针同一条
 *  规则）；本函数只负责把**节点矩形**这条数据路喂进去。文字章 → null。 */
export function currentNodeOf(
  blocks: ReadonlyArray<HTMLElement | null>, viewTop: number,
): VisibleNode | null {
  const nodes: Array<{ index: number; nodeId: string; top: number }> = []
  blocks.forEach((block, index) => {
    for (const el of novelNodes(block)) {
      const nodeId = el.getAttribute('data-novel-node')
      if (nodeId === null) continue
      nodes.push({ index, nodeId, top: el.getBoundingClientRect().top - viewTop })
    }
  })
  const at = crossedIndex(nodes, (cand) => cand.top)
  const hit = at === -1 ? undefined : nodes[at]
  return hit === undefined ? null : { index: hit.index, nodeId: hit.nodeId, offsetWithinNode: -hit.top }
}
