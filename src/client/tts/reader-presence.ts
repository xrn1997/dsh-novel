import { createStore } from '../store.js'

/**
 * 阅读器子树的在场信号：全局迷你条的可见性判据（「此刻有没有阅读器子树挂着、挂的是哪本书」），
 * **不是**插件内路由。
 *
 * 为什么不能读 `routeStore`：宿主的中央呈现座位一次只渲染一个面板，切走「小说」时整棵面板子树
 * 卸载，而插件内路由仍停在 `reader`（`ADR-0022`：中央呈现座位一切走就卸载面板子树；路由没有
 * 「面板被卸载」这一档，也不会被谁复位）。按路由判「在不在阅读器」恰好把迷你条藏在最该出现的
 * 那一格：读者已经看着别的面板，听书却还在放——后台播放正是这个常驻层的全部理由。
 *
 * 为什么带书键：阅读器里的 `TtsBar` 只覆盖「正在听的就是本书」一案；阅读器开着**另一本**时
 * 就地条不挂载，若迷你条也按「子树在场」退场，控制面就整个消失（`ADR-0072`）。故接管判据按
 * 书键对齐：在场书键集合里有会话本书 → 就地条接管；否则迷你条接手。
 *
 * 计数而不是布尔：StrictMode 的 mount → cleanup → mount 会连发两轮，布尔会让第二趟误清；
 * 计数也不靠「同场只会有一个阅读器」这条今天成立、判据不该依赖的事实活着。释放函数自带一次闸：
 * 重复调用不重复减（effect cleanup 只该跑一趟，但减多了会把在场信号减成负数）。书键按多重集
 * 记：同一本书挂两棵子树时撤一棵不该把另一棵的在场也撤掉。
 */
export const readerPresence = createStore<{ depth: number; bookKeys: string[] }>({ depth: 0, bookKeys: [] })

/** 阅读器挂载时调用（`useEffect(() => enterReader(bookKey), [bookKey])`）：返回撤场用的释放函数。 */
export function enterReader(bookKey: string): () => void {
  const cur = readerPresence.get()
  readerPresence.set({ depth: cur.depth + 1, bookKeys: [...cur.bookKeys, bookKey] })
  let released = false
  return () => {
    if (released) return
    released = true
    const now = readerPresence.get()
    const at = now.bookKeys.indexOf(bookKey)
    readerPresence.set({
      depth: Math.max(0, now.depth - 1),
      bookKeys: at === -1 ? now.bookKeys : [...now.bookKeys.slice(0, at), ...now.bookKeys.slice(at + 1)],
    })
  }
}
