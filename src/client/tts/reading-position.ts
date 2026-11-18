/**
 * 阅读位置 → 听书起播位置的换算，以及阅读器注入的**实时探针**。
 *
 * 为什么是模块级一格而不是参数：播放层是模块级的（阅读器卸载不停播），而「读者此刻在看哪里」
 * 只有阅读器组件的 DOM 量得出来。阅读器挂载时注册探针、卸载时注销，播放层在「从阅读位置起播」
 * 那一刻现取——不缓存读数，缓存会让按钮用的是上一次打开书时的位置。
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
 * 章内滚动比例 → 段下标（0 基）：把阅读存档的 `offsetRatio` 投到段序号上。
 * 口径：两端对齐（0 → 首段、1 → 末段），中间四舍五入到最近的段；越界与非有限值夹紧。
 * 段数 0（空章 / 全是不可朗读段）没有可起播的目标，回 0 交给上层 clamp。
 *
 * 为什么不是 `floor(ratio * count)`：ratio = 1 是存档里的合法末位（读到章末），
 * floor 会把它投到段数之外，播放层还得再夹一次；两端对齐让「从阅读位置起播」在章末
 * 恰好落在最后一段。
 */
export function estimateParagraphIndex(offsetRatio: number, paragraphCount: number): number {
  if (paragraphCount <= 0) return 0
  const ratio = Number.isFinite(offsetRatio) ? Math.min(1, Math.max(0, offsetRatio)) : 0
  return Math.min(paragraphCount - 1, Math.round(ratio * (paragraphCount - 1)))
}

/**
 * 段下标 → 章内滚动比例：`estimateParagraphIndex` 的**反函数**（同一两端对齐口径，
 * 合法段号来回换算不漂）。「回阅读器」用它把听书段换成阅读会话的恢复目标形状
 * （恢复要吃的是「章 + 比例」，不是段锚点）；两个方向的判据住在同一处，别在调用点另写一份。
 */
export function paragraphRatio(paragraphIndex: number, paragraphCount: number): number {
  if (paragraphCount <= 1) return 0
  const index = Number.isFinite(paragraphIndex) ? Math.trunc(paragraphIndex) : 0
  return Math.min(paragraphCount - 1, Math.max(0, index)) / (paragraphCount - 1)
}

/**
 * 段号落在哪个「起段号」格：`starts` 升序（屏上各正文块的起始播放单元号），取最后一个
 * ≤ 段号的起点——一个块可占多个播放单元（超长段二次切分），段号在块区间内都归它。
 * 跟读高亮（ChapterBody）与「定位到正在念的段」（DOM 查找）共用这一条命中判据；
 * 段号在首块起点之前（被剥掉的章名占的单元）返回 -1 = 屏上没有对应块。
 */
export function paragraphSlotOf(starts: readonly number[], paragraphIndex: number): number {
  let slot = -1
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index]
    if (start === undefined || start > paragraphIndex) break
    slot = index
  }
  return slot
}

/** 章块内按段号找正文块（「定位到正在念的段」的 DOM 落点）：起段号取自 `data-pidx`，
 *  命中判据与跟读高亮同一条（`paragraphSlotOf`）；量不到返回 null，调用方不动滚动。 */
export function listenParagraphElement(block: Element, paragraphIndex: number): Element | null {
  // `data-pidx` 只认整数：坏值（NaN / 空串 / 小数）若混进 `starts`，`paragraphSlotOf` 的
  // 「起点大于段号就停」会永远不成立，于是落到别的块上——宁可当这块没有落点，也不猜。
  const marked = [...block.querySelectorAll('[data-pidx]')]
  const starts: number[] = []
  const elements: Element[] = []
  for (const element of marked) {
    const value = Number(element.getAttribute('data-pidx'))
    if (!Number.isInteger(value)) continue
    starts.push(value)
    elements.push(element)
  }
  const slot = paragraphSlotOf(starts, paragraphIndex)
  return slot === -1 ? null : elements[slot] ?? null
}
