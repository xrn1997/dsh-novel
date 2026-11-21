import { useEffect, useState } from 'react'
import type { RefObject } from 'react'

/**
 * 「从本段听」的选区落点：**阅读器一份** document 监听（`selectionchange` / `mouseup` / 捕获滚动），
 * 按 DOM 上的 `[data-pidx]` + `[data-chapter]` 把选区归成「哪一章、哪一段」。
 * 不在 `ChapterBody` 里逐章挂：连续滚动下常驻 N 个章块，逐章三条就是 3N 条；选区与浮钮本来就是
 * 跨章的一次阅读器动作。`ChapterBody` 因此退回纯渲染：段号由它写进 `data-pidx`，读的人不再是它。
 * 两个事件都挂（`selectionchange` 覆盖键盘划选，`mouseup` 收尾）；固定定位的按钮不跟滚动走，
 * 捕获阶段接住任意滚动容器，一滚就收。
 */

export interface ListenFromAt {
  /** 命中段所在的章序（`[data-chapter]`），补「去哪个章」的归属 */
  chapterIndex: number
  /** 命中的播放单元号（与 `splitParagraphs` 同一口径，已含被剥章名的 `paragraphBase` 偏移） */
  paragraphIndex: number
  /** 浮动按钮落点（fixed 定位）：取选区中点下沿；量不到选区时退到这一段自己的盒子。 */
  x: number
  y: number
}

/** 选区包围盒：`getBoundingClientRect` 缺席（非浏览器 / 无选区布局）或量到 0 时返回 null。 */
function selectionBounds(selection: Selection): DOMRect | null {
  const range = selection.rangeCount > 0 ? selection.getRangeAt(0) : null
  if (range === null || typeof range.getBoundingClientRect !== 'function') return null
  const bounds = range.getBoundingClientRect()
  return bounds.width === 0 && bounds.height === 0 ? null : bounds
}

export interface ListenFromSelection {
  /** 当前选区落点；null = 不出浮动按钮 */
  at: ListenFromAt | null
  /** 收起浮动按钮（点击起播、滚动、选区塌陷都走它） */
  clear: () => void
}

/** 在阅读器正文容器上装**一份**选区监听，返回落点与收起动作。「点了就起播」不归这里——
 *  本模块只回答「选中的是哪一章哪一段」。 */
export function useListenFromSelection(
  containerRef: RefObject<HTMLElement | null>,
): ListenFromSelection {
  const [at, setAt] = useState<ListenFromAt | null>(null)
  useEffect(() => {
    const onSelection = (): void => {
      const selection = window.getSelection()
      if (selection === null || selection.isCollapsed) {
        setAt(null)
        return
      }
      // 锚点在选区**起点**一侧：按元素祖辈找所在的段。认的是带段号的块本身、不是标签名——
      // 图文正文的起行块可能是标题 / 列表项 / 引用块，只查 p 会让这些块里的选区永远出不了按钮。
      const anchor = selection.anchorNode
      const element = anchor instanceof Element ? anchor : anchor?.parentElement ?? null
      const paragraph = element?.closest('[data-pidx]') ?? null
      const root = containerRef.current
      if (paragraph === null || root === null || !root.contains(paragraph)) {
        setAt(null)
        return
      }
      const chapterNode = paragraph.closest('[data-chapter]')
      if (chapterNode === null || !root.contains(chapterNode)) {
        setAt(null)
        return
      }
      const chapterRaw = chapterNode.getAttribute('data-chapter')
      const chapterIndex = chapterRaw === null ? Number.NaN : Number(chapterRaw)
      if (!Number.isInteger(chapterIndex)) {
        setAt(null)
        return
      }
      // 先认领归属再读选区文本：连续滚动下选区可能在别的章上，`toString()` 会把整段文本物化。
      if (selection.toString().trim() === '') {
        setAt(null)
        return
      }
      const raw = paragraph.getAttribute('data-pidx')
      const paragraphIndex = raw === null ? Number.NaN : Number(raw)
      if (!Number.isInteger(paragraphIndex)) {
        setAt(null)
        return
      }
      const bounds = selectionBounds(selection) ?? paragraph.getBoundingClientRect()
      setAt({ chapterIndex, paragraphIndex, x: bounds.left + bounds.width / 2, y: bounds.bottom + 8 })
    }
    const onScroll = (): void => { setAt(null) }
    document.addEventListener('selectionchange', onSelection)
    document.addEventListener('mouseup', onSelection)
    document.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('selectionchange', onSelection)
      document.removeEventListener('mouseup', onSelection)
      document.removeEventListener('scroll', onScroll, true)
    }
  }, [containerRef])
  return { at, clear: () => { setAt(null) } }
}
