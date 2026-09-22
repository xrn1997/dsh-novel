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
 * 下一个要加载的章下标（前向窗口：**视口所在章之后**第一个未载章）。
 * 不用「最大已载下标 + 1」：那个口径下，跳到远端再往回跳，预取会指到远端已载章的后面——
 * 跳 50 再回 10，用户读到第 11 章末尾接上的是第 51 章（实测 DOM 顺序 [0,10,50]）。
 * 视口章自己未载（刚跳过去、正文还在途）→ 就是它；读尽/空表 → -1。
 * @param chapters 已载正文数组（null/空洞 = 未载）
 * @param from 视口所在章下标（会话的阅读位置）
 */
export function nextChapterIndex(chapters: ReadonlyArray<string | null>, from: number): number {
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
 * 应发起加载的章下标；不该加载 → null（无未载章 / 已有在途章 / 边界还没进预取区）。
 * @param sentinelTop 未载边界哨兵相对视口顶的距离（已滚过头为负）
 * @param viewportHeight 视口高（滚动容器 clientHeight）
 * @param opts.chapters 已载正文数组  @param opts.loading 在途章下标（单在途槽；空闲传 null）
 * @param opts.from 视口所在章下标（预取只往前接它）
 */
export function nextLoadTarget(
  sentinelTop: number, viewportHeight: number,
  opts: { chapters: ReadonlyArray<string | null>; loading: number | null; from: number },
): number | null {
  if (opts.loading !== null) return null                          // 单在途：滚动风暴去重
  const next = nextChapterIndex(opts.chapters, opts.from)
  if (next === -1) return null
  return sentinelTop < viewportHeight * (1 + PRELOAD_SCREENS) ? next : null
}
