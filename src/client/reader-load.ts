/**
 * 阅读器懒加载决策（纯函数，可单测）。触发口径用「未载边界哨兵相对视口的 top」，不用容器
 * scrollTop/scrollHeight：那个口径在阅读器自己的容器 `clientHeight == scrollHeight` 时两向都失效，
 * 且占位块会把 scrollHeight 撑成整本书高。判据由此与「谁在滚」解耦。渲染只出已载章节。
 */

/** 预取余量（屏数）：边界进入「视口底 + N 屏」以内即加载下一章 */
const PRELOAD_SCREENS = 2

/**
 * 下一个要加载的章下标（前向窗口：**视口所在章之后**第一个未载章）。不用「最大已载下标 + 1」：
 * 跳 50 再回 10，用户读到第 11 章末尾接上的是第 51 章（`tests/client/reader-load.test.ts` 钉住）。
 * 视口章自己未载 → 就是它；读尽/空表 → -1。
 */
export function nextChapterIndex(chapters: ReadonlyArray<unknown>, from: number): number {
  if (chapters.length === 0) return -1
  const start = Math.min(Math.max(0, from), chapters.length - 1)
  if (chapters[start] === null || chapters[start] === undefined) return start
  for (let i = start + 1; i < chapters.length; i++) {
    const text = chapters[i]
    if (text === null || text === undefined) return i
  }
  return -1
}

/**
 * 应发起加载的章下标；不该加载 → null（无未载章 / 已有在途章 / 边界还没进预取区）。`chapters` 的元素
 * 类型是 `unknown`：**懒加载只问「在不在」**，收窄成 `ChapterContent` 等于让加载算法认识载荷形态。
 */
export function nextLoadTarget(
  sentinelTop: number, viewportHeight: number,
  opts: { chapters: ReadonlyArray<unknown>; loading: number | null; from: number },
): number | null {
  if (opts.loading !== null) return null                          // 单在途：滚动风暴去重
  const next = nextChapterIndex(opts.chapters, opts.from)
  if (next === -1) return null
  return sentinelTop < viewportHeight * (1 + PRELOAD_SCREENS) ? next : null
}
