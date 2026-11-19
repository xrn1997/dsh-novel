/**
 * 阅读器注入的**实时阅读位置探针**：DOM 几何 → 章 + 段号。
 *
 * 为什么是模块级一格而不是参数：播放层是模块级的（阅读器卸载不停播），而「读者此刻在看哪里」
 * 只有阅读器组件的 DOM 量得出来。阅读器挂载时注册探针、卸载时注销，播放层在「从阅读位置起播」
 * 那一刻现取——不缓存读数，缓存会让按钮用的是上一次打开书时的位置。
 *
 * 换算不在这里：像素 / 段数口径与它们的互逆关系归 `client/progress.ts` 的章内位置 codec；
 * 段号 ⇄ 屏上块的命中判据归 `client/reader-paragraph.ts`，本文件只再导出。
 */
import { crossedIndex } from '../viewport-top.js'

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
 * DOM 几何 → 阅读位置：章块按 `chapterRefs` 的章号顺序排（洞 = 该章还没渲染），取
 * 「视口顶已越过」的最靠下那一章；章内取同样的判据在**所有带 `data-pidx` 的起行块**上
 * （文字章是行、图文章的标题 / 列表项 / 引用块各算一块），视口还在首块之上就落首块。
 * 量不到任何章 → null（此刻起播没有可信位置）。
 *
 * 洞有两种形态：`null`（显式占位）与**缺席下标**（`chapterRefs.current` 从跳章打开时起就是空的，
 * 逐章渲染才补格，读回来是 `undefined`）。两种都按「该章还没渲染」跳过——对 `undefined` 调
 * `getBoundingClientRect` 会抛，抛点又被播放层当「量不到」吞掉，位置就静默退回比例估算。
 *
 * 为什么从元素上量而不是从会话状态读：会话的 `currentChapter` 是**跨章**读数，给不出章内段；
 * 而「从阅读位置起播」要的正是段级位置。`data-pidx` 的取值口径归 `ChapterBody`（两种正文形态
 * 都与播放单元同一口径），本函数只做几何选择，不解释段号。
 */
export function readingPositionAt(
  blocks: readonly (Element | null)[], viewTop: number,
): ReadingPosition | null {
  // 章与段吃同一条判据（`client/viewport-top.ts` 的 `crossedIndex`）：本函数只负责把
  // 「块矩形」这条数据路喂进去，边界口径不再各写一遍。
  const chapterIndex = crossedIndex(blocks, (block) => block.getBoundingClientRect().top - viewTop)
  if (chapterIndex === -1) return null
  const block = blocks[chapterIndex]
  if (block === null || block === undefined) return null   // crossedIndex 越过洞后落到的必是元素

  // `data-pidx` 只认整数：坏值（NaN / 空串 / 小数）若混进候选，起段号的比较会整体失准，
  // 宁可当这块没有落点，也不猜（与 `listenParagraphElement` 同一条取值纪律）。
  const marked: Array<{ pid: number; top: number }> = []
  for (const p of block.querySelectorAll('[data-pidx]')) {
    const raw = p.getAttribute('data-pidx')
    const value = raw === null ? Number.NaN : Number(raw)
    if (!Number.isInteger(value)) continue
    marked.push({ pid: value, top: p.getBoundingClientRect().top - viewTop })
  }
  const at = crossedIndex(marked, (item) => item.top)
  const paragraphIndex = at === -1 ? 0 : (marked[at]?.pid ?? 0)
  return { chapterIndex, paragraphIndex }
}

/**
 * 段号落在哪个「起段号」格：判据已归 `client/reader-paragraph.ts`（阅读器几何与高亮共用），
 * 这里只再导出，调用点不必改。
 */
export { paragraphSlotOf, listenParagraphElement } from '../reader-paragraph.js'
