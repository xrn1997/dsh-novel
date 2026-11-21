import type { ReactNode, RefObject } from 'react'
import { useEffect, useId, useRef } from 'react'
import { useCopy } from '../copy/index.js'

/**
 * 模态契约的唯一住址：遮罩、面板标记、Esc、入场焦点、Tab 圈、归还触发件——六件事只住这一份；
 * 五处浮层各抄一遍会分化出两种行为。
 *
 * 口径三条，都不许回到调用方：① **入场焦点**缺省落面板内第一颗未禁用钮；表单类模态（编辑抽屉）
 * 在起手元素上标 `data-dialog-initial` 声明那一位，焦点规则仍只住这里（`ADR-0037`）。② **焦点
 * effect 挂载作用域**（空依赖 + onClose 走 ref）：模态在场期间父层重渲染会把焦点劫回第一颗。
 * ③ **无障碍名默认取可见标题**（`aria-labelledby`），只有名字要与标题不同才用 `label`。
 *
 * 归还对象默认取挂载时的 `document.activeElement`；触发件会在模态挂载前随容器卸载的（行内「⋯」
 * 菜单项）必须显式传 `opener`。
 */
export interface DialogProps {
  /** 面板内那一行可见标题；缺省无障碍名就是它 */
  title: string
  /** 无障碍名要与可见标题不同时才给 */
  label?: string
  /** 遮罩点空与 Esc 的唯一出口：在途禁退由调用方在这条回调里判（模态不再自持一份 busy） */
  onClose: () => void
  /** 面板主体 */
  children?: ReactNode
  /** 模态档底部的动作行；抽屉档的动作长在标题行右侧，不吃这一格 */
  actions?: ReactNode
  /** 几何档位：`modal` 确认框（400px）/ `form` 表单（520px）/ `wide` 大信息层（680px）/ `drawer` 侧抽屉。 */
  variant?: 'modal' | 'form' | 'wide' | 'drawer'
  /** 关闭后焦点还给谁；不传即挂载时那个焦点位 */
  opener?: HTMLElement | null
}

/** 入场焦点的显式初始位：标了 `data-dialog-initial` 的元素**优先**拿焦点——表单类模态必须落第一个输入框，
 *  否则用户填完第一格按回车就把整张表单丢了。 */
const INITIAL_FOCUS = '[data-dialog-initial]'
/** 没有显式初始位时的回退：面板内第一颗未禁用钮（口径见 `ADR-0037`） */
const FIRST_BUTTON = 'button:not([disabled])'
/** Tab 圈认全部可聚焦件：只认 `<button>` 会把拖放区（`role=button` 的 div）与粘贴框排除在键盘外。 */
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])'

/** 闭合 `<details>` 与 `display:none` 的隐藏文件输入不进 Tab 序：Tab 圈首/末不能落在点不亮的元素上。 */
function isTabbable(el: HTMLElement): boolean {
  if (el.tabIndex < 0) return false
  if (el.closest('[hidden]') !== null) return false
  if (el.tagName !== 'SUMMARY' && el.closest('details:not([open])') !== null) return false
  const style = getComputedStyle(el)
  return style.display !== 'none' && style.visibility !== 'hidden'
}

/** 键盘层序（`ADR-0037` 的「同场 Esc 的归属」）：同场两层各挂一条 document 监听时，一次 Esc 会把两层
 *  一起收——顶上那层还没表态，底下就已丢了现场。层序只住这一处，认领顺序 = 打开顺序，最上层先吃。 */
const layers: symbol[] = []

/** 认领一层键盘现场：`isTop()` 为假时这一层的 Esc / Tab 圈都不出手（入场焦点与还焦仍按挂载时机走）。 */
export function claimKeyLayer(): { isTop: () => boolean; release: () => void } {
  const token = Symbol('key-layer')
  layers.push(token)
  return {
    isTop: () => layers.at(-1) === token,
    release: () => {
      const at = layers.indexOf(token)
      if (at >= 0) layers.splice(at, 1)
    },
  }
}

/** 同场是否有任何一层认领了键盘现场：常驻层全局快捷键据此让路——一次 Esc 只收最上面那一层。 */
export function keyLayerActive(): boolean {
  return layers.length > 0
}

/**
 * 浮层的键盘与焦点契约（Esc / 入场焦点 / Tab 圈 / 关闭后还焦）：模态与内嵌卡片共用这一份。
 * 调用方只给面板 ref、关闭回调与归还对象；遮罩与面板标记归各自的几何档。
 * effect 挂载作用域（空依赖 + onClose 走 ref）：浮层在场期间父层重渲染会把焦点劫回第一颗。
 */
export function useDialogContract({ panelRef, onClose, opener = null }: {
  panelRef: RefObject<HTMLDivElement | null>
  onClose: () => void
  opener?: HTMLElement | null
}): void {
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose                      // 每 render 刷新 ref：effect 内永远调到最新闭包
  useEffect(() => {
    const entered = document.activeElement
    const layer = claimKeyLayer()
    const focusables = (): HTMLElement[] => panelRef.current === null ? []
      : [...panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(isTabbable)
    const panel = panelRef.current
    const initial = panel === null
      ? null
      : panel.querySelector<HTMLElement>(INITIAL_FOCUS) ?? panel.querySelector<HTMLElement>(FIRST_BUTTON)
    initial?.focus()
    const onKey = (e: KeyboardEvent): void => {
      // 上面还压着一层时这一层不出手：Esc 与 Tab 圈都只归最上层。
      if (!layer.isTop()) return
      if (e.key === 'Escape') { onCloseRef.current(); return }
      if (e.key !== 'Tab') return
      const f = focusables()
      const [first] = f
      const last = f.at(-1)
      // 空表即没有可聚焦件：Tab 不出框（首、末任一缺席都是这一支，故只留一道闸）
      if (first === undefined || last === undefined) { e.preventDefault(); return }
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      layer.release()
      document.removeEventListener('keydown', onKey)
      const back = opener ?? entered
      if (back instanceof HTMLElement && back.isConnected) back.focus()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}

export function Dialog({ title, label, onClose, children, actions, variant = 'modal', opener = null }: DialogProps): ReactNode {
  const t = useCopy()
  const panelRef = useRef<HTMLDivElement | null>(null)
  const titleId = useId()
  useDialogContract({ panelRef, onClose, opener })
  if (variant === 'drawer') {
    return (
      <>
        <div className="novel-city-scrim" aria-hidden="true" onClick={onClose} />
        <div ref={panelRef} className="novel-city-drawer" role="dialog" aria-modal="true"
          {...(label === undefined ? { 'aria-labelledby': titleId } : { 'aria-label': label })}>
          <div className="novel-city-drawer-head">
            <strong className="novel-city-drawer-title" id={titleId}>{title}</strong>
            <button className="novel-btn sm" onClick={onClose}>{t('common.close')}</button>
          </div>
          {children}
        </div>
      </>
    )
  }
  return (
    <div className="novel-modal-mask" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div ref={panelRef}
        className={variant === 'wide' ? 'novel-modal wide' : variant === 'form' ? 'novel-modal form' : 'novel-modal'}
        role="dialog" aria-modal="true"
        {...(label === undefined ? { 'aria-labelledby': titleId } : { 'aria-label': label })}>
        <div className="novel-modal-title" id={titleId}>{title}</div>
        {children}
        {actions === undefined ? null : <div className="novel-modal-actions">{actions}</div>}
      </div>
    </div>
  )
}
