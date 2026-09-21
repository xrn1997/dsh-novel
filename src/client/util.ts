/**
 * client 中立小工具：debounce 与 localStorage guard 不属于
 * 「阅读进度」也不属于「轻量 store」——此前住在这两个 module 里，找它们要靠 grep。
 */

/** 防抖：ms 窗口内合并调用只留最后一次；flush 立即触发挂起调用；cancel 丢弃 */
export function debounce<A extends unknown[]>(
  fn: (...args: A) => void, ms: number,
): ((...args: A) => void) & { flush(): void; cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null
  let pending: A | null = null
  const wrapped = (...args: A): void => {
    pending = args
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => { timer = null; const p = pending; pending = null; if (p !== null) fn(...p) }, ms)
  }
  wrapped.flush = (): void => {
    if (timer !== null) { clearTimeout(timer); timer = null }
    const p = pending
    pending = null
    if (p !== null) fn(...p)
  }
  wrapped.cancel = (): void => {
    if (timer !== null) { clearTimeout(timer); timer = null }
    pending = null
  }
  return wrapped
}

/** localStorage guard：renderToString/无 DOM 环境退内存 Map（不许炸）——prefs 等持久位共用 */
const memory = new Map<string, string>()
export const ls: Pick<Storage, 'getItem' | 'setItem'> = {
  getItem: (k) => {
    try { return globalThis.localStorage?.getItem(k) ?? memory.get(k) ?? null } catch { return memory.get(k) ?? null }
  },
  setItem: (k, v) => {
    memory.set(k, v)
    try { globalThis.localStorage?.setItem(k, v) } catch { /* 无 DOM：内存兜底 */ }
  },
}

/** 正文层字色：纸张色由 prefs 固定（正文层永不接宿主 token，防回归——皮肤 token 是
 *  半透明玻璃值），故字色必须**由纸张色算**：写死深色字在自选深色纸上等于隐形。按感知亮度
 * （WCAG 线性化 + Rec.709 权重，阈值 0.35）择一，深浅两纸两端都够对比。
  *  纯函数（从 ReaderView 迁入）：无 React、无 IO——可直接单测。 */
export function paperInk(paper: string): string {
  const hex = paper.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)
  if (hex === null) return '#222'                       // 非 hex（color input 也可能给 rgb()）：退回原行为
  const h = hex[1].length === 3 ? hex[1].split('').map((c) => c + c).join('') : hex[1]
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
  const lin = (v: number): number => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
  const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
  return L > 0.35 ? '#222' : '#e8e8ea'
}

/** 字符串 → 四档档位（1..4）：按 codePoint 求和取模——同一输入恒同档、可复现。
 *  封面色块与来源色点共用同一份四档色板，派生机制也必须同一份（否则两处会各自漂移）。 */
function tintTier(text: string): 1 | 2 | 3 | 4 {
  let sum = 0
  for (const ch of text.trim()) sum = (sum + (ch.codePointAt(0) ?? 0)) % 4
  return (sum + 1) as 1 | 2 | 3 | 4
}

/** 无封面降级的首字色块档位（token 层 --novel-cover-1..4 的类名映射；hex 不出 token 层，
 *  theme-tokens 守卫口径）。按首字符 codePoint 求和派生——同书恒同色、可复现；
 *  空标题回 t1（与 coverFallbackChar 的「书」同防）。 */
export function coverTintClass(title: string): 'novel-cover-t1' | 'novel-cover-t2' | 'novel-cover-t3' | 'novel-cover-t4' {
  return `novel-cover-t${tintTier(title)}` as 'novel-cover-t1' | 'novel-cover-t2' | 'novel-cover-t3' | 'novel-cover-t4'
}

/** 来源色点的档位（书架卡片「来源 chip」的色点）：按 **sourceId** 派生——同一书源在整架书上是同一个颜色，
 *  一屏之内一眼分得出来源不同。类名刻意不复用 cover 的（色点是点、封面是块，同一张卡上两块颜色可以不同），
 *  但档位色仍是同四档 token（hex 不出 token 层）。空 id 回 t1。 */
export function sourceTintClass(sourceId: string): 'novel-src-t1' | 'novel-src-t2' | 'novel-src-t3' | 'novel-src-t4' {
  return `novel-src-t${tintTier(sourceId)}` as 'novel-src-t1' | 'novel-src-t2' | 'novel-src-t3' | 'novel-src-t4'
}
