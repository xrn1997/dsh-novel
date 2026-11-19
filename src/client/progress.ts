/**
 * 章内位置 codec：章号 + 章内比例 ⇄ 像素 / 段号。纯函数，两个 adapter 同住一处。
 *
 * - **measured（像素）**：`locateChapter` / `ratioWithin` / `anchorTop`，跨度是**该章自己的渲染
 *   高度**；存与取用同一个跨度，两者互逆。别在调用点换跨度（尾章用「到下一章的距离」会让比例
 *   恒 0；用「内容剩余高度」会算出另一个像素）。
 * - **uniform（段数）**：`paragraphRatio` / `estimateParagraphIndex`，把段数当等距；阅读器不在场
 *   时由播放层写 `progress`，或起播链最后兜底。它与像素口径**不是同一个数**，只在没有几何时用。
 *
 * 两个 adapter 不互相冒充：阅读器在场时 `progress` 归阅读会话（ADR-0093）；回阅读器 / 定位按
 * 段号精确落位（ADR-0094），不拿 uniform 比例猜像素。
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

/** 章内滚动比例 → 段下标（0 基）：uniform adapter 的正向。两端对齐（0 → 首段、1 → 末段），
 *  中间四舍五入到最近的段；越界与非有限值夹紧。段数 0（空章 / 全是不可朗读段）没有可起播的
 *  目标，回 0 交给上层 clamp。 */
export function estimateParagraphIndex(offsetRatio: number, paragraphCount: number): number {
  if (paragraphCount <= 0) return 0
  const ratio = Number.isFinite(offsetRatio) ? Math.min(1, Math.max(0, offsetRatio)) : 0
  return Math.min(paragraphCount - 1, Math.round(ratio * (paragraphCount - 1)))
}

/** 段下标 → 章内滚动比例：`estimateParagraphIndex` 的**反函数**（同一两端对齐口径，合法段号
 *  来回换算不漂）。听书侧写 `progress` 用它把段号换成比例；与像素口径的差异见文件头注。 */
export function paragraphRatio(paragraphIndex: number, paragraphCount: number): number {
  if (paragraphCount <= 1) return 0
  const index = Number.isFinite(paragraphIndex) ? Math.trunc(paragraphIndex) : 0
  return Math.min(paragraphCount - 1, Math.max(0, index)) / (paragraphCount - 1)
}
