/** 阅读器注入的**实时阅读位置探针**：DOM 几何 → 章 + 段号。
 * 播放层是模块级的（阅读器卸载不停播），而「读者此刻在看哪里」只有阅读器组件的 DOM 量得出来：
 * 挂载时注册、卸载时注销，播放层在起播那一刻现取——不缓存（缓存会让按钮用上一次打开书时的位置）。
 * 换算与段号命中判据归 `client/progress.ts` / `reader-paragraph.ts`，本文件只再导出。
 */
import { crossedIndex, spanRelativeTo } from '../viewport-top.js'

/** 阅读器提供的实时位置：章号 + 章内段号（0 基）。返 null = 此刻量不到（正文未渲染等）。 */
export type ReadingPosition = { chapterIndex: number; paragraphIndex: number }
export type ReadingProbe = () => ReadingPosition | null

let probe: ReadingProbe | null = null

export function setReadingProbe(next: ReadingProbe | null): void {
  probe = next
}

/** 播放层读当前探针（同模块；不对外承诺稳定的第二份状态）。 */
export function readingProbeNow(): ReadingProbe | null {
  return probe
}

/**
 * DOM 几何 → 阅读位置：章块按 `chapterRefs` 顺序排（洞 = 该章还没渲染），当前章按 `crossedIndex`
 * 的覆盖项规则判（含块间空档归下一项，`ADR-0106`）；章内取同样的判据在**所有带 `data-pidx`
 * 的起行块**上，视口还在首块之上就落首块。
 * 洞的两种形态（`null` 与**缺席下标**）都按「该章还没渲染」跳过——对 `undefined` 调
 * `getBoundingClientRect` 会抛，抛点又被播放层当「量不到」吞掉，位置就静默退回比例估算。
 * 从元素上量而不是从会话状态读：`currentChapter` 是跨章读数，给不出段级位置（`data-pidx` 口径归 `ChapterBody`）。
 */
export function readingPositionAt(
  blocks: readonly (Element | null)[], viewTop: number,
): ReadingPosition | null {
  // 章与段吃同一条判据（`client/viewport-top.ts` 的 `crossedIndex`，含空档归下一项）：
  // 本函数只负责把块矩形换成区间喂进去。缝里读数因此与进度侧同口径——不许在此另立归章例外。
  const chapterIndex = crossedIndex(blocks, (block) => {
    const rect = block.getBoundingClientRect()
    return spanRelativeTo(rect.top, rect.bottom, viewTop)
  })
  if (chapterIndex === -1) return null
  const block = blocks[chapterIndex]
  if (block === null || block === undefined) return null   // crossedIndex 越过洞后落到的必是元素

  // `data-pidx` 只认整数：坏值混进候选会让起段号比较整体失准，宁可当这块没有落点。
  const marked: Array<{ pid: number; start: number; end: number }> = []
  for (const p of block.querySelectorAll('[data-pidx]')) {
    const raw = p.getAttribute('data-pidx')
    const value = raw === null ? Number.NaN : Number(raw)
    if (!Number.isInteger(value)) continue
    const rect = p.getBoundingClientRect()
    marked.push({ pid: value, ...spanRelativeTo(rect.top, rect.bottom, viewTop) })
  }
  const at = crossedIndex(marked, (item) => item)
  const paragraphIndex = at === -1 ? 0 : (marked[at]?.pid ?? 0)
  return { chapterIndex, paragraphIndex }
}

/** 段号落在哪个「起段号」格：判据已归 `client/reader-paragraph.ts`，这里只再导出。 */
export { paragraphSlotOf, listenParagraphElement } from '../reader-paragraph.js'
