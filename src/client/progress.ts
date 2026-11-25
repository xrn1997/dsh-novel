/**
 * 章内位置 codec：章号 + 章内比例 ⇄ 像素 / 段号。纯函数，两个 adapter 同住一处。
 * - **measured（像素）**：跨度是**该章自己的渲染高度**，存与取用同一个跨度、两者互逆；别在调用点换跨度。
 * - **uniform（段数）**：把段数当等距，只在没有几何时用；它与像素口径**不是同一个数**。
 * 两个 adapter 不互相冒充：阅读器在场时 progress 归阅读会话（ADR-0093）；回阅读器按段号精确落位（ADR-0094）。
 */
import { crossedIndex } from './viewport-top.js'

export interface ChapterAnchor { index: number; start: number; height: number }

/** 章内比例：`scrollTop` 在锚点 [start, start+height] 内的占比（夹在 0..1；高度没量到 → 0）。**唯一实现**：
 *  存侧与取侧的「落位后回读真实比例」共用它——同一比例两处各写一遍就会算出两个数。 */
export function ratioWithin(a: ChapterAnchor, scrollTop: number): number {
  return a.height > 0 ? Math.min(1, Math.max(0, (scrollTop - a.start) / a.height)) : 0
}

/** 定位当前章与章内比例：锚点按内容坐标升序，**当前项判据吃 `viewport-top` 那一份**；比例 = 章内已滚过
 *  的高度占比。这条数据路只读锚点缓存、不做每帧 rect 读取——判据共用，数据流不合并。 */
export function locateChapter(anchors: ChapterAnchor[], scrollTop: number): { chapterIndex: number; offsetRatio: number } {
  const at = crossedIndex(anchors, (a) => a.start - scrollTop)
  // 没有锚点 = 还没量到任何章：章号与比例都留在基线 0（不是"取位失败"，这里就没有取位这回事）
  const a = at === -1 ? undefined : anchors[at]
  if (a === undefined) return { chapterIndex: 0, offsetRatio: 0 }
  // 章块之间的页边距不属于任何锚点（块高不含章间 margin），而浏览器给 scrollTop 赋值会取整：
  // 落位差出的亚像素会落进这条缝。缝里的 scrollTop 归**下一章的开篇留白**（ratio 0），否则
  // 取整误差把位置回读成上一章 ratio 1，下一帧 commit 就造成跳章回弹。块底正常阅读不受影响（严格 >）。
  const next = anchors[at + 1]
  if (next !== undefined && scrollTop > a.start + a.height && scrollTop < next.start) {
    return { chapterIndex: next.index, offsetRatio: 0 }
  }
  return { chapterIndex: a.index, offsetRatio: ratioWithin(a, scrollTop) }
}

/** 恢复定位反函数：章 + 比例 → scrollTop（夹在可滚动范围内）；章不在已测锚点里 → 0。 */
export function anchorTop(
  anchors: ChapterAnchor[], chapterIndex: number, offsetRatio: number,
  scrollHeight: number, clientHeight: number,
): number {
  const a = anchors.find((x) => x.index === chapterIndex)
  if (a === undefined) return 0
  const raw = a.start + Math.min(1, Math.max(0, offsetRatio)) * a.height
  return Math.min(Math.max(0, scrollHeight - clientHeight), Math.max(0, raw))
}

/** 章内滚动比例 → 段下标（0 基）：uniform adapter 的正向。两端对齐，中间四舍五入；段数 0 回 0 交上层 clamp。 */
export function estimateParagraphIndex(offsetRatio: number, paragraphCount: number): number {
  if (paragraphCount <= 0) return 0
  const ratio = Number.isFinite(offsetRatio) ? Math.min(1, Math.max(0, offsetRatio)) : 0
  return Math.min(paragraphCount - 1, Math.round(ratio * (paragraphCount - 1)))
}

/** 段下标 → 章内滚动比例：`estimateParagraphIndex` 的**反函数**（同一两端对齐口径，来回换算不漂）。 */
export function paragraphRatio(paragraphIndex: number, paragraphCount: number): number {
  if (paragraphCount <= 1) return 0
  const index = Number.isFinite(paragraphIndex) ? Math.trunc(paragraphIndex) : 0
  return Math.min(paragraphCount - 1, Math.max(0, index)) / (paragraphCount - 1)
}
