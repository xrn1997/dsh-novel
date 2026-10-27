// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { Dialog } from '../../src/client/views/dialog.js'

/**
 * 模态契约的行为钉子（契约的语义与口径见 `src/client/views/dialog.tsx` 与 `CONTEXT.md` 的
 * 「模态契约（dialog）」）。这一族断言只在这一处钉一次，别在各浮层抄第二份——抄本一多就会长出
 * 两种行为。调用点的钉子只负责「该挂的时候挂了、opener 传的是对的触发件」。
 *
 * jsdom 的 `click` 不聚焦（真实浏览器会），凡断言焦点的用例都先显式 `focus()` 建立现场。
 */

afterEach(cleanup)

/** 三颗钮的模态：第一颗禁用，用来验「入场焦点落第一颗**未禁用**钮」不是「落第一颗钮」 */
function threeButtons(close: () => void): ReactNode {
  return (
    <Dialog title="确认吗？" onClose={close}
      actions={<>
        <button disabled>禁用那颗</button>
        <button>取消</button>
        <button>确认</button>
      </>}>
      <div className="novel-modal-body">正文一句话</div>
    </Dialog>
  )
}

describe('标记：dialog 语义与无障碍名', () => {
  it('role=dialog + aria-modal + 名字取可见标题本身（不再往 aria-label 抄第二份）', () => {
    render(threeButtons(() => undefined))
    const dialog = screen.getByRole('dialog')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(dialog.getAttribute('aria-label')).toBeNull()
    expect(dialog.textContent).toContain('确认吗？')
    expect(screen.queryByText('正文一句话')).toBeTruthy()
    const titleId = dialog.getAttribute('aria-labelledby')
    expect(titleId).toBeTruthy()
    expect(document.getElementById(titleId ?? '')?.textContent).toBe('确认吗？')
  })

  it('名字要与可见标题不同时才用 label（详情浮层那种带前缀的说法）', () => {
    render(
      <Dialog title="半城风月" label="书籍详情：半城风月" variant="drawer" onClose={() => undefined}>
        <div>内容</div>
      </Dialog>,
    )
    expect(screen.getByRole('dialog').getAttribute('aria-label')).toBe('书籍详情：半城风月')
  })
})

describe('入场焦点与 Tab 圈', () => {
  it('入场焦点落面板内第一颗未禁用钮', () => {
    render(threeButtons(() => undefined))
    expect(screen.getByText('取消') === document.activeElement).toBe(true)
  })

  it('末位 Tab 回到首位、首位 Shift+Tab 回到末位（不许走到遮罩背后）', () => {
    render(threeButtons(() => undefined))
    const cancel = screen.getByText('取消')
    const confirm = screen.getByText('确认')
    confirm.focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(cancel)
    cancel.focus()
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(confirm)
  })

  it('Tab 圈把 role=button 的拖放区算进首位（导入弹层的主入口不是 <button>）', () => {
    render(
      <Dialog title="t" onClose={() => undefined} actions={<button>关闭</button>}>
        <div role="button" tabIndex={0}>拖放区</div>
      </Dialog>,
    )
    const drop = screen.getByRole('button', { name: '拖放区' })
    const close = screen.getByText('关闭')
    close.focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(drop)
    drop.focus()
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(close)
  })

  it('Tab 圈把 textarea 算进来（导入弹层的粘贴框）', () => {
    render(
      <Dialog title="t" onClose={() => undefined} actions={<button>关闭</button>}>
        <textarea aria-label="粘贴" />
      </Dialog>,
    )
    const paste = screen.getByLabelText('粘贴')
    const close = screen.getByText('关闭')
    close.focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(paste)
    paste.focus()
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(close)
  })

  it('面板里暂时没有可聚焦件（在途全禁用）时，Tab 也不许走到遮罩背后', () => {
    render(
      <Dialog title="t" onClose={() => undefined}>
        <button disabled>稍后</button>
      </Dialog>,
    )
    const e = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    document.dispatchEvent(e)
    expect(e.defaultPrevented).toBe(true)
  })
})

describe('退出路：Esc 与遮罩', () => {
  it('Esc 走 onClose，且调的是最新闭包（effect 挂载作用域，闭包却要跟得上重渲染）', () => {
    const first = vi.fn()
    const latest = vi.fn()
    const { rerender } = render(<Dialog title="t" onClose={first}><div>正文</div></Dialog>)
    rerender(<Dialog title="t" onClose={latest}><div>正文</div></Dialog>)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(latest).toHaveBeenCalledTimes(1)
    expect(first).not.toHaveBeenCalled()
  })

  it('点遮罩空处退出；点面板内不退出', () => {
    const close = vi.fn()
    render(<Dialog title="t" onClose={close}><div className="novel-modal-body">正文</div></Dialog>)
    fireEvent.click(document.querySelector('.novel-modal') as HTMLElement)
    expect(close).not.toHaveBeenCalled()
    fireEvent.click(document.querySelector('.novel-modal-mask') as HTMLElement)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('卸载即撤监听：模态不在场时 Esc 不该再出声', () => {
    const close = vi.fn()
    render(threeButtons(close))
    cleanup()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(close).not.toHaveBeenCalled()
  })
})

describe('关后还焦', () => {
  it('显式 opener 优先于挂载时的焦点位（⋯ 菜单项那种「触发件已随菜单卸载」的形状）', () => {
    const trigger = document.createElement('button')
    const ghost = document.createElement('button')
    document.body.append(trigger, ghost)
    ghost.focus()                                        // 挂载时焦点在 ghost（真实场景里它已卸载）
    const { unmount } = render(<Dialog title="t" opener={trigger} onClose={() => undefined}><div>b</div></Dialog>)
    unmount()
    expect(document.activeElement).toBe(trigger)
    trigger.remove()
    ghost.remove()
  })

  it('没传 opener 就归还挂载时那个焦点位', () => {
    const trigger = document.createElement('button')
    document.body.append(trigger)
    trigger.focus()
    const { unmount } = render(<Dialog title="t" onClose={() => undefined}><div>b</div></Dialog>)
    unmount()
    expect(document.activeElement).toBe(trigger)
    trigger.remove()
  })

  it('归还对象已不在文档里时不扔焦点（别把焦点交给一个不在场的节点）', () => {
    const trigger = document.createElement('button')
    document.body.append(trigger)
    trigger.focus()
    const { unmount } = render(<Dialog title="t" onClose={() => undefined}><div>b</div></Dialog>)
    trigger.remove()                                     // 触发件先离开文档（列表行被删掉那种）
    expect(() => { unmount() }).not.toThrow()
    expect(document.activeElement?.contains(trigger)).toBe(false)
  })
})

describe('重渲染不扰焦点', () => {
  it('父层每秒轮询带来的新 render 不重抢焦点、也不重捕获归还对象', () => {
    const trigger = document.createElement('button')
    document.body.append(trigger)
    trigger.focus()
    const { rerender } = render(threeButtons(() => undefined))
    const confirm = screen.getByText('确认')
    confirm.focus()
    rerender(threeButtons(() => undefined))              // 与真实轮询同形：tick → 新闭包 → 新 render
    expect(document.activeElement).toBe(confirm)         // 回归：焦点不得被劫回「取消」
    rerender(threeButtons(() => undefined))
    fireEvent.keyDown(document, { key: 'Escape' })
    cleanup()
    expect(document.activeElement).toBe(trigger)        // 归还对象仍是挂载时那一位，不是模态内按钮
    trigger.remove()
  })
})

describe('抽屉档（书籍详情浮层的几何）', () => {
  it('scrim 与面板的类名归样式层，标题行右侧那颗「关闭」钮仍由契约给', () => {
    const close = vi.fn()
    render(
      <Dialog title="半城风月" variant="drawer" onClose={close}>
        <div className="novel-city-bookhead">正文</div>
      </Dialog>,
    )
    expect(document.querySelector('.novel-city-scrim')).toBeTruthy()
    expect(document.querySelector('.novel-city-drawer .novel-city-drawer-head')).toBeTruthy()
    expect(document.querySelector('.novel-city-drawer .novel-city-bookhead')).toBeTruthy()
    expect(document.querySelector('.novel-modal-actions')).toBeNull()   // 抽屉档不吃 actions：关闭钮长在标题行右侧
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(close).toHaveBeenCalledTimes(1)
  })
})
