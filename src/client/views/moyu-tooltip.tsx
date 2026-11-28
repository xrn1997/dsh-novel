/** 摸鱼舞台的自绘 Tooltip（宿主 Tooltip 的形态）：500ms 悬停延迟、深色气泡、
 *  悬浮于一切之上、快捷键独立键帽。宿主的 Tooltip 挂 body portal；本插件的平台模块表只有
 *  react 两条（tsdown.config.ts 的 PLATFORM_MODULES），拿不到 react-dom 的 createPortal，
 *  所以这里用「手工 portal」：气泡节点由本组件直接挂到舞台根（fixed 坐标＝视口）——
 *  唯一差异是 DOM 挂载点在舞台作用域树内（视图守卫要求视觉规则只读 --novel-* 局部 token，
 *  而局部 token 只在作用域树内可读），定位与遮挡行为与 body portal 相同。 */
import type { ReactNode } from 'react'
import { useEffect, useRef } from 'react'

/** 一枚独立键帽的文字（宿主 shortcutKeys 的逐键形态）。 */
export type MoyuShortcutKeys = readonly string[]

interface BubbleState {
  node: HTMLDivElement | null
  timer: number | null
}

function buildBubble(node: HTMLDivElement, label: string, keys: MoyuShortcutKeys): void {
  node.replaceChildren()
  const text = document.createElement('span')
  text.className = 'novel-moyu-tooltip-label'
  text.textContent = label
  node.appendChild(text)
  for (const key of keys) {
    const cap = document.createElement('span')
    cap.className = 'novel-moyu-tooltip-key'
    cap.textContent = key
    node.appendChild(cap)
  }
}

function placeBubble(node: HTMLDivElement, anchor: DOMRect, side: 'top' | 'bottom'): void {
  node.style.visibility = 'hidden'
  node.style.left = '0px'
  node.style.top = '0px'
  const box = node.getBoundingClientRect()
  const left = Math.min(
    Math.max(8, anchor.left + anchor.width / 2 - box.width / 2),
    Math.max(8, window.innerWidth - box.width - 8),
  )
  const top = side === 'bottom'
    ? anchor.bottom + 8
    : anchor.top - box.height - 8
  node.style.left = `${Math.round(left)}px`
  node.style.top = `${Math.round(Math.max(8, top))}px`
  node.style.visibility = ''
}

export interface MoyuTooltipProps {
  /** 气泡文字（经 useCopy()/Translate 取词后传入）。 */
  label: string
  /** 快捷键键帽（逐键独立成帽；空数组＝无键帽）。 */
  keys?: MoyuShortcutKeys
  /** 气泡在锚点的哪一侧；宿主输入条在上、头/坞在下。 */
  side?: 'top' | 'bottom'
  /** 悬停延迟（宿主常用 500ms；ContextMeter 触发器 200ms）。 */
  delayMs?: number
  /** 为 true 时不弹（宿主 Tooltip disabled 语义）。 */
  disabled?: boolean
  /** 被包住的触发元素（单个）；气泡锚定它的盒。 */
  children: ReactNode
}

/** 宿主 Tooltip 形态的包壳：display:contents 不改布局，事件经冒泡捕获。 */
export function MoyuTooltip({
  label, keys = [], side = 'bottom', delayMs = 500, disabled = false, children,
}: MoyuTooltipProps): ReactNode {
  const wrapRef = useRef<HTMLSpanElement | null>(null)
  const bubbleRef = useRef<BubbleState>({ node: null, timer: null })
  const labelRef = useRef(label)
  labelRef.current = label
  const keysRef = useRef(keys)
  keysRef.current = keys

  useEffect(() => {
    const state = bubbleRef.current
    return () => {
      if (state.timer !== null) window.clearTimeout(state.timer)
      state.node?.remove()
      state.node = null
    }
  }, [])

  const hide = (): void => {
    const state = bubbleRef.current
    if (state.timer !== null) {
      window.clearTimeout(state.timer)
      state.timer = null
    }
    state.node?.remove()
    state.node = null
  }

  const show = (delay: number): void => {
    if (disabled) return
    const state = bubbleRef.current
    if (state.timer !== null) window.clearTimeout(state.timer)
    state.timer = window.setTimeout(() => {
      state.timer = null
      const wrap = wrapRef.current
      const anchor = wrap?.firstElementChild?.getBoundingClientRect()
      if (anchor === undefined) return
      /* 气泡挂舞台根（fixed 坐标＝视口）：舞台是唯一能读到 --novel-* 局部 token 的作用域树，
         视觉规则只读局部 token 的守卫（tests/client/logic.test.ts）不允许规则里散写宿主 token。 */
      const host = wrap?.closest('[data-novel-moyu]') ?? document.body
      const node = state.node ?? host.appendChild(document.createElement('div'))
      node.className = 'novel-moyu-tooltip'
      node.setAttribute('role', 'tooltip')
      buildBubble(node, labelRef.current, keysRef.current)
      state.node = node
      placeBubble(node, anchor, side)
    }, delay)
  }

  return (
    <span
      ref={wrapRef}
      style={{ display: 'contents' }}
      onMouseEnter={() => { show(delayMs) }}
      onMouseLeave={hide}
      onFocus={() => { show(delayMs) }}
      onBlur={hide}
    >
      {children}
    </span>
  )
}

