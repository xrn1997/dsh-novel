/**
 * 阅读器进度数学（纯函数——连续滚动流的正确性全在此）。
 * 连续滚动流：章章首尾相接，锚点 = 每章起点 offset **+ 该章实测高度**。
 *
 * 跨度口径单点 = **该章自己的渲染高度**：存（locateChapter）与取（anchorTop）用同一个跨度，
 * 于是两者互逆。此前两侧各有一套：存侧借「到下一章的距离」（尾章没有 next → 比例恒 0，
 * 而尾章正是用户正在读的那一章），取侧借「内容剩余高度」——同一个比例两边算出不同像素。
 */
export interface ChapterAnchor { index: number; start: number; height: number }

/** 定位当前章与章内比例：取 start <= scrollTop 的最大锚点；比例 = 章内已滚过的高度占比 */
export function locateChapter(anchors: ChapterAnchor[], scrollTop: number): { chapterIndex: number; offsetRatio: number } {
  if (anchors.length === 0) return { chapterIndex: 0, offsetRatio: 0 }
  let idx = anchors[0].index
  for (const a of anchors) {
    if (a.start <= scrollTop) idx = a.index
    else break
  }
  const a = anchors.find((x) => x.index === idx)!
  const offsetRatio = a.height > 0 ? Math.min(1, Math.max(0, (scrollTop - a.start) / a.height)) : 0
  return { chapterIndex: idx, offsetRatio }
}

/** 恢复定位反函数：章 + 比例 → scrollTop（夹在可滚动范围内，不许越过内容底）。
 *  chapterIndex 不在已测锚点里（越界/未载）→ 0 */
export function anchorTop(
  anchors: ChapterAnchor[], chapterIndex: number, offsetRatio: number,
  scrollHeight: number, clientHeight: number,
): number {
  const a = anchors.find((x) => x.index === chapterIndex)
  if (a === undefined) return 0
  const raw = a.start + Math.min(1, Math.max(0, offsetRatio)) * a.height
  return Math.min(Math.max(0, scrollHeight - clientHeight), Math.max(0, raw))
}

// debounce 已迁 util.ts（它不是阅读进度数学）
