/**
 * 真实滚动容器探测（「谁在滚就按谁算」适配层）。
 *
 * 阅读器不假设滚动发生在哪个容器：从正文向上找第一个真正在滚的祖先（现即 `.novel-main`
 * 自己——五分支共用 `.novel-main` 的 overflow-y:auto）。历史：conversation.view 时代阅读器
 * 放开自己两层 overflow、滚动落在宿主 resident scrollport（`[data-conversation-scroll]`）上，
 * 向上探测正是为它而做；a9f35f7 迁全局面板后宿主链上再无 scrollport，放开规则已删
 * （病史见 docs/design/client.md），但探测保持通用——进度锚点与目录回跳一律按探测结果算，
 * 不赌容器身份。找不到 → null（= 文档自身在滚）。判据是纯函数（可单测），探测本身是薄 DOM 壳。
 */

/** 一个元素算不算「真正在滚」的滚动容器：overflow-y 可滚且内容确实超出 */
export function isScrollport(overflowY: string, scrollHeight: number, clientHeight: number): boolean {
  if (overflowY !== 'auto' && overflowY !== 'scroll' && overflowY !== 'overlay') return false
  return scrollHeight > clientHeight + 1            // +1：亚像素裕度（clientHeight 取整）
}

export type StyleOf = (el: Element) => { overflowY: string }

/** 默认取样式（测试注入假实现——node 环境没有布局） */
const computedStyleOf: StyleOf = (el) => getComputedStyle(el)

/**
 * 从 from 起向上找第一个真正在滚的容器；走到文档根都没有 → null（= 文档自身在滚）。
 * @param from 起点（含自身——布局变回定高时自身就是滚动条）
 * @param styleOf 取样式
 */
export function findScrollport(from: Element | null, styleOf: StyleOf = computedStyleOf): HTMLElement | null {
  let node: Element | null = from
  while (node !== null) {
    const el = node as HTMLElement
    if (isScrollport(styleOf(node).overflowY, el.scrollHeight, el.clientHeight)) return el
    node = node.parentElement
  }
  return null
}

/** 当前滚动位置（null = 文档滚动） */
export function portScrollTop(port: HTMLElement | null): number {
  if (port === null) return window.scrollY || document.documentElement.scrollTop || 0
  return port.scrollTop
}

/** 设置滚动位置（null = 文档滚动） */
export function setPortScrollTop(port: HTMLElement | null, top: number): void {
  if (port === null) { window.scrollTo(0, top); return }
  port.scrollTop = top
}

/** 视口高（预取余量换算用） */
export function portViewHeight(port: HTMLElement | null): number {
  return port === null ? window.innerHeight : port.clientHeight
}

/** 视口顶在屏幕坐标里的位置（把元素 rect 换算成「相对滚动视口」用） */
export function portViewTop(port: HTMLElement | null): number {
  return port === null ? 0 : port.getBoundingClientRect().top
}

/** 内容总高（恢复定位的 span 分母用） */
export function portScrollHeight(port: HTMLElement | null): number {
  if (port === null) return (document.scrollingElement ?? document.documentElement).scrollHeight
  return port.scrollHeight
}

/** 滚动内容坐标原点在屏幕坐标里的位置（元素 rect.top - 它 = 内容坐标） */
export function contentOriginTop(port: HTMLElement | null): number {
  if (port === null) return -portScrollTop(null)
  return port.getBoundingClientRect().top - port.scrollTop
}
