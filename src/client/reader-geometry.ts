import type { ChapterAnchor } from './progress.js'
import type { ReaderPort, VisibleNode } from './reader-session.js'
import {
  contentOriginTop, portScrollHeight, portScrollTop, portViewHeight, portViewTop, setPortScrollTop,
} from './scrollport.js'
import { findNovelNode, novelNodes, NOVEL_NODE_ATTR } from './util.js'

/**
 * 阅读器几何：把 DOM 测量实现成一个 `ReaderPort`，视图只提供最小元素源。
 *
 * 为什么从视图里搬出来：这套测量有两套坐标系（滚动内容原点 / 滚动视口顶）与一条
 * 「章块 + 哨兵 + 节点」的读取顺序；放在视图闭包里时，唯一能证它的方式是整页渲染并改写
 * `Element.prototype.getBoundingClientRect` / `window.scrollTo`——量到的是几何，不是接线，
 * 而它一旦错，症状是进度静默错位。现在几何可以在假元素上直接测，视图只剩 ref 接线。
 *
 * 会话侧的 `ReaderPort` 契约不变（`client/reader-session.ts`）；本模块只实现它。
 */
export interface ReaderGeometrySource {
  /** 真实滚动容器（`findScrollport` 的产物）；null = 文档自身在滚 */
  port(): HTMLElement | null
  /** 未载边界哨兵；不在 DOM → null（不预取） */
  sentinel(): HTMLElement | null
  /** 已渲染章块（按章号；缺席 = 该章还没渲染） */
  chapters(): ReadonlyArray<HTMLElement | null>
}

export function createReaderGeometry(source: ReaderGeometrySource): ReaderPort {
  return {
    measureAnchors: () => {
      // 锚点 = 章块相对「滚动内容原点」的偏移 + 该章渲染高度（跨度的唯一来源：存与取
      // 都用它，两个方向才互逆）。不能用 offsetTop：宿主的滚动容器在阅读器之外，
      // 两套坐标系混用会让 locateChapter 恒判第 0 章（进度不落地）。
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
    /** 目标 = 章块顶（anchorId null）或章内那个锚点节点；两者相对**滚动视口顶**。
     *  章块/节点不在 DOM → null（会话据此不落位、等下一轮）。 */
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
    currentNode: () => currentNodeOf(source.chapters(), portViewTop(source.port())),
  }
}

/** 视口顶所在的正文节点：取「视口顶已越过」的节点里最靠下的那个（视口顶就在它内部或它之后）；
 *  一个都没越过（视口还在第一个节点之上）→ 取文档顺序里第一个。没有可定位节点（文字章）→ null。 */
export function currentNodeOf(
  blocks: ReadonlyArray<HTMLElement | null>, viewTop: number,
): VisibleNode | null {
  let best: { index: number; nodeId: string; top: number } | undefined
  let first: { index: number; nodeId: string; top: number } | undefined
  blocks.forEach((block, index) => {
    for (const el of novelNodes(block)) {
      const nodeId = el.getAttribute('data-novel-node')
      if (nodeId === null) continue
      const cand = { index, nodeId, top: el.getBoundingClientRect().top - viewTop }
      if (first === undefined) first = cand
      if (cand.top <= 0 && (best === undefined || cand.top > best.top)) best = cand
    }
  })
  const hit = best ?? first
  return hit === undefined ? null : { index: hit.index, nodeId: hit.nodeId, offsetWithinNode: -hit.top }
}
