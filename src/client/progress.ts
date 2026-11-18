/**
 * 阅读器进度数学（纯函数——连续滚动流的正确性全在此）。
 * 连续滚动流：章章首尾相接，锚点 = 每章起点 offset **+ 该章实测高度**。
 *
 * 跨度口径单点 = **该章自己的渲染高度**：存（locateChapter）与取（anchorTop）用同一个跨度，
 * 于是两者互逆。两侧不要各用一套跨度：存侧借「到下一章的距离」（尾章没有 next → 比例恒 0，
 * 而尾章正是用户正在读的那一章），取侧借「内容剩余高度」——同一个比例会算出不同像素。
 */
import { crossedIndex } from './viewport-top.js'

export interface ChapterAnchor { index: number; start: number; height: number }

/** 章内比例：`scrollTop` 在锚点 [start, start+height] 内的占比（夹在 0..1；高度没量到 → 0）。
 *  **唯一实现**：存侧（locateChapter）与取侧的「落位后回读真实比例」（阅读会话的 settleJump）共用它。
 *  本文件头注那条规矩就是为这件事立的——同一个比例两处各写一遍，就会算出两个数。 */
export function ratioWithin(a: ChapterAnchor, scrollTop: number): number {
  return a.height > 0 ? Math.min(1, Math.max(0, (scrollTop - a.start) / a.height)) : 0
}

/** 定位当前章与章内比例：锚点按内容坐标升序，**当前项判据吃 `viewport-top` 的那一份**
 *  （取最后一条已越过滚动位的；一条都没越过 → 第一张锚点）；比例 = 章内已滚过的高度占比。
 *  这条数据路刻意只读锚点缓存、不做每帧 rect 读取——判据共用，数据流不合并。 */
export function locateChapter(anchors: ChapterAnchor[], scrollTop: number): { chapterIndex: number; offsetRatio: number } {
  const at = crossedIndex(anchors, (a) => a.start - scrollTop)
  // 没有锚点 = 还没量到任何章：章号与比例都留在基线 0（不是"取位失败"，这里就没有取位这回事）
  const a = at === -1 ? undefined : anchors[at]
  if (a === undefined) return { chapterIndex: 0, offsetRatio: 0 }
  return { chapterIndex: a.index, offsetRatio: ratioWithin(a, scrollTop) }
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
