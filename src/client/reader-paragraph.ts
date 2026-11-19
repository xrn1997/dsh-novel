/**
 * 章内「播放单元号 ↔ 屏上正文块」的命中判据：听书段号与阅读器 DOM 的公共语言。
 *
 * 为什么住 `client/` 而不在 `client/tts/`：阅读探针、跟读高亮、定位与几何测量都要这一条，
 * 它不是听书独占的知识。判据只有一份，`tts/reading-position.ts` 只是再导出，调用点不必改。
 */

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