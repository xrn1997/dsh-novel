import type { ReactNode, RefObject } from 'react'
import { useEffect, useId, useRef } from 'react'
import { useCopy } from '../copy/index.js'

/**
 * 模态契约的唯一住址（词汇见 `CONTEXT.md` 的「模态契约（dialog）」）：遮罩、面板标记、Esc、
 * 入场焦点、Tab 圈、归还触发件——六件事必须只住这一份；若五处浮层各抄一遍，
 * 很快会分化出两种行为（例如导入弹层与书籍详情浮层没有 Tab 圈，注释却写着「沿用同一条焦点口径」）。
 *
 * 口径三条，都不许回到调用方：
 * ① **入场焦点**：缺省落面板内第一颗未禁用钮——删除确认落「取消」、入架一问落「先不加入」、
 *    详情浮层落标题行「关闭」；导入弹层缺省态落动作行「关闭」（有完成回执时落回执第一颗）。
 *    这几种现状由 DOM 序自然给齐，无须调用方选。**表单类模态**（编辑抽屉）不能吃这条缺省：
 *    落在动作行第一颗「取消」上，用户填完第一格按回车就把整张表单丢了。故表单类模态在它的
 *    **起手元素**上标 `data-dialog-initial` 声明那一位；声明只是「哪一颗先接焦点」的读数，
 *    焦点规则与 effect 仍只住这一份，调用方不写任何聚焦逻辑（口径见 `ADR-0037`）。
 *    Tab 圈另认**全部可聚焦件**：拖放区是 `role=button` 的 div、粘贴框是 textarea，
 *    Tab 序若也只认钮，导入弹层的主入口就被关在键盘外。
 * ② **焦点 effect 挂载作用域**（空依赖 + `onClose` 走 ref）：模态在场期间父层随时重渲染
 *    （任务轮询每秒一次），依赖里带闭包就会每次把焦点劫回第一颗、opener 被重捕获成模态内按钮
 *    （两处竞态形态，回归钉在 `tests/client/dialog.test.tsx`）。
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
  /** 几何档位：外观与结构归样式层，这里只选哪一档标记。
   *  `modal` 确认框（400px）/ `form` 表单（520px）/ `wide` 大信息层（680px）/ `drawer` 侧抽屉。 */
  variant?: 'modal' | 'form' | 'wide' | 'drawer'
  /** 关闭后焦点还给谁；不传即挂载时那个焦点位 */
  opener?: HTMLElement | null
}

/** 入场焦点的显式初始位：调用方标了 `data-dialog-initial` 的元素**优先**拿焦点。
 *  表单类模态（编辑抽屉）必须落第一个输入框——回退规则落在动作行第一颗钮「取消」上时，
 *  用户填完第一格按回车就把整张表单丢了。标记由调用方负责指向真正能接焦点的元素。 */
const INITIAL_FOCUS = '[data-dialog-initial]'
/** 没有显式初始位时的回退：面板内第一颗未禁用钮（口径见 `ADR-0037`） */
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

/**
 * 键盘层序（口径见 `ADR-0037` 的「同场 Esc 的归属」）：同场可以有两层吃 Esc——带遮罩的模态、
 * 阅读器内的听书设置卡，以及阅读浮层。每层各挂一条 document 监听时，一次 Esc 会把两层一起收：
 * 顶上那层还没表态，底下就已经丢了现场。层序只住这一处，认领顺序 = 打开顺序，最上层先吃。
 */
const layers: symbol[] = []

/** 认领一层键盘现场：`isTop()` 为假时这一层的 Esc / Tab 圈都不出手（入场焦点与还焦仍按各自
 *  挂载时机走——那是焦点归属，不是按键仲裁）。阅读浮层那一族也来这儿认领：判据仍在
 *  `reader-surfaces` 的 `escOwner`，这里只裁「同场两层时谁先吃」。 */
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

/** 同场是否有任何一层认领了键盘现场。常驻层的全局快捷键（听书浮窗的 Esc）据此让路：
 *  一次 Esc 只收最上面那一层，底下那层不跟着表态。 */
export function keyLayerActive(): boolean {
  return layers.length > 0
}

/**
 * 浮层的键盘与焦点契约（Esc / 入场焦点 / Tab 圈 / 关闭后还焦）：模态与内嵌卡片共用这一份，
 * 别在每个浮层里各抄一遍。调用方只给面板 ref、关闭回调与归还对象；遮罩与面板标记归各自的
 * 几何档（模态有遮罩，阅读器内的卡片没有）。
 *
 * effect 挂载作用域（空依赖 + onClose 走 ref）：浮层在场期间父层随时重渲染，依赖里带闭包
 * 就会每次把焦点劫回第一颗、opener 被重捕获成面板内按钮（回归钉在
 * `tests/client/dialog.test.tsx`）。
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
      // 上面还压着一层时这一层不出手：Esc 与 Tab 圈都只归最上层
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
