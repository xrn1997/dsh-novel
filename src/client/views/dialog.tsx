import type { ReactNode } from 'react'
import { useEffect, useId, useRef } from 'react'
import { useCopy } from '../copy/index.js'

/**
 * 模态契约的唯一住址（词汇见 `CONTEXT.md` 的「模态契约（dialog）」）：遮罩、面板标记、Esc、
 * 入场焦点、Tab 圈、归还触发件——六件事必须只住这一份；若五处浮层各抄一遍，
 * 很快会分化出两种行为（例如导入弹层与书籍详情浮层没有 Tab 圈，注释却写着「沿用同一条焦点口径」）。
 *
 * 口径三条，都不许回到调用方：
 * ① **入场焦点落面板内第一颗未禁用钮**——删除确认落「取消」、入架一问落「先不加入」、详情浮层落
 *    标题行「关闭」；导入弹层缺省态落动作行「关闭」（有完成回执时落回执第一颗）。四种现状由 DOM
 *    序自然给齐，无须调用方选。Tab 圈另认**全部可聚焦件**：拖放区是 `role=button` 的 div、粘贴框
 *    是 textarea，Tab 序若也只认钮，导入弹层的主入口就被关在键盘外。
 * ② **焦点 effect 挂载作用域**（空依赖 + `onClose` 走 ref）：模态在场期间父层随时重渲染
 *    （任务轮询每秒一次），依赖里带闭包就会每次把焦点劫回第一颗、opener 被重捕获成模态内按钮
 *    （两处修过的真缺陷，回归钉在 `tests/client/dialog.test.tsx`）。
 * ③ **无障碍名默认取可见标题**（`aria-labelledby` 指向面板内那一行）：把同一句话再抄进
 *    `aria-label` 就是给同一读数第二个主人；只有名字要与可见标题不同（浮层带「书籍详情：」前缀）
 *    才用 `label` 那一格。
 *
 * 归还对象默认取挂载时的 `document.activeElement`；触发件会在模态挂载前就随自己的容器卸载的
 * （行内「⋯」菜单项）必须显式传 `opener`，否则读到的已是 `body`。
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
  /** 几何档位：外观与结构归样式层，这里只选哪一档标记 */
  variant?: 'modal' | 'wide' | 'drawer'
  /** 关闭后焦点还给谁；不传即挂载时那个焦点位 */
  opener?: HTMLElement | null
}

/** 入场焦点只认面板内第一颗未禁用钮（口径见 `ADR-0037`） */
const FIRST_BUTTON = 'button:not([disabled])'
/** Tab 圈认全部可聚焦件：只认 `<button>` 会把导入弹层的拖放区（`role=button` 的 div）与粘贴框
 *  （textarea）排除在键盘之外——那两个才是那一层的主入口。 */
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])'

/** 闭合 `<details>` 里的内容不进 Tab 序（它自己的 summary 仍可聚焦）；`display:none` 的隐藏
 *  文件输入同理。按「真正能接焦点」裁一遍，Tab 圈的首/末才不会落在点不亮的元素上。 */
function isTabbable(el: HTMLElement): boolean {
  if (el.tabIndex < 0) return false
  if (el.closest('[hidden]') !== null) return false
  if (el.tagName !== 'SUMMARY' && el.closest('details:not([open])') !== null) return false
  const style = getComputedStyle(el)
  return style.display !== 'none' && style.visibility !== 'hidden'
}

export function Dialog({ title, label, onClose, children, actions, variant = 'modal', opener = null }: DialogProps): ReactNode {
  const t = useCopy()
  const panelRef = useRef<HTMLDivElement | null>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose                      // 每 render 刷新 ref：effect 内永远调到最新闭包
  const titleId = useId()
  useEffect(() => {
    const entered = document.activeElement
    const focusables = (): HTMLElement[] => panelRef.current === null ? []
      : [...panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(isTabbable)
    panelRef.current?.querySelector<HTMLElement>(FIRST_BUTTON)?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { onCloseRef.current(); return }
      if (e.key !== 'Tab') return
      const f = focusables()
      if (f.length === 0) { e.preventDefault(); return }
      const first = f[0]
      const last = f[f.length - 1]
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      const back = opener ?? entered
      if (back instanceof HTMLElement && back.isConnected) back.focus()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
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
      <div ref={panelRef} className={variant === 'wide' ? 'novel-modal wide' : 'novel-modal'} role="dialog" aria-modal="true"
        {...(label === undefined ? { 'aria-labelledby': titleId } : { 'aria-label': label })}>
        <div className="novel-modal-title" id={titleId}>{title}</div>
        {children}
        {actions === undefined ? null : <div className="novel-modal-actions">{actions}</div>}
      </div>
    </div>
  )
}
