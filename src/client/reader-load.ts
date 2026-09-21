/**
 * 阅读器懒加载决策（纯函数——缺陷修复抽出，可单测）。
 *
 * 触发口径用「未载边界哨兵相对视口的 top」，**不用**容器 scrollTop/scrollHeight。理由两层：
 * ① 历史实测（conversation.view 时代）——滚动落在宿主 resident scrollport 上、阅读器自己的
 * 容器 `clientHeight == scrollHeight` 永不滚（无头实测 97541 = 97541），旧口径
 * `scrollHeight - scrollTop - clientHeight < 2 屏` 两个方向都失效：容器不滚 → 事件不来；
 * 912 章占位块又把 scrollHeight 撑成整本书高（97579px）→ 真滚了也只在全书末尾 1% 才触发。
 * ② 判据与「谁在滚」解耦——滚动容器身份随宿主挂载点变过一次（a9f35f7 迁全局面板，
 * 病史见 docs/design/client.md），视口相对的哨兵在任何 scrollport 下都成立。
 * 渲染只出**已载章节**（未载章节不进 DOM），未载边界由哨兵元素表达。
 */

/** 预取余量（屏数）：边界进入「视口底 + N 屏」以内即加载下一章 */
const PRELOAD_SCREENS = 2

/**
 * 下一个要加载的章下标（前向流水：从已载最大下标往后；空表 → 0；读尽 → -1）。
 * 前向流水而不是「首个空洞」：目录直达跳章后用户是从那一章往下读，不该回头补前面的洞。
 * @param chapters 已载正文数组（null/空洞 = 未载）
 */
export function nextChapterIndex(chapters: ReadonlyArray<string | null>): number {
  for (let i = chapters.length - 1; i >= 0; i--) {
    const text = chapters[i]
    if (text !== null && text !== undefined) return i + 1 < chapters.length ? i + 1 : -1
  }
  return chapters.length === 0 ? -1 : 0
}

/**
 * 应发起加载的章下标；不该加载 → null（无未载章 / 已有在途章 / 边界还没进预取区）。
 * @param sentinelTop 未载边界哨兵相对视口顶的距离（已滚过头为负）
 * @param viewportHeight 视口高（滚动容器 clientHeight）
 * @param opts.chapters 已载正文数组  @param opts.loading 在途章下标（单在途槽；空闲传 null）
 */
export function nextLoadTarget(
  sentinelTop: number, viewportHeight: number,
  opts: { chapters: ReadonlyArray<string | null>; loading: number | null },
): number | null {
  if (opts.loading !== null) return null                          // 单在途：滚动风暴去重
  const next = nextChapterIndex(opts.chapters)
  if (next === -1) return null
  return sentinelTop < viewportHeight * (1 + PRELOAD_SCREENS) ? next : null
}
