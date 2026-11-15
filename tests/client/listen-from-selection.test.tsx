// @vitest-environment jsdom
import { useRef } from 'react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useListenFromSelection } from '../../src/client/views/listen-from-selection.js'
import { must } from '../support/fixture.js'

/**
 * 选区起播的落点判定（`views/listen-from-selection.ts`）：document 监听只有阅读器一份，
 * 归属靠 DOM 上的 `[data-pidx]` + `[data-chapter]`。本文件钉四件事：
 * ① 鼠标收尾（mouseup）与键盘划选（selectionchange）走同一判据；
 * ② 章身份来自最近的 `[data-chapter]`（跨章选区的归属不靠调用方补）；
 * ③ 选区落在正文容器之外 / 塌陷 / 量不到段号时不出落点；
 * ④ 一滚就收（捕获阶段接任意滚动容器），不让浮钮悬在无关的正文上。
 */

/** 探针组件：把 hook 的落点投影成可断言的值，并提供「起播」与「收起」两颗钮。 */
function Probe({ onListen }: { onListen: (chapterIndex: number, paragraphIndex: number) => void }): ReactNode {
  const ref = useRef<HTMLDivElement | null>(null)
  const { at, clear } = useListenFromSelection(ref)
  return (
    <div>
      <div ref={ref}>
        <div data-chapter={3}>
          <p data-pidx={7}>甲段文字，选它。</p>
          <p data-pidx={9}>乙段文字</p>
        </div>
      </div>
      <p data-pidx={1}>容器之外的段</p>
      <span data-testid="at">{at === null ? '' : `${at.chapterIndex}:${at.paragraphIndex}`}</span>
      <button type="button" onClick={() => { if (at !== null) { onListen(at.chapterIndex, at.paragraphIndex); clear() } }}>
        起播
      </button>
      <button type="button" onClick={clear}>收起</button>
    </div>
  )
}

/** 选中某个元素的内容：造 DOM 选区后按事件类型触发收尾。 */
function selectIn(element: Element, fire: () => void): void {
  const range = document.createRange()
  range.selectNodeContents(element)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
  fire()
}

afterEach(() => { cleanup() })

describe('选区起播的落点判定', () => {
  it('鼠标收尾（mouseup）：落点带上最近的 [data-chapter] 与 [data-pidx]', () => {
    const onListen = vi.fn()
    render(<Probe onListen={onListen} />)
    const p = must(document.querySelector('[data-pidx="7"]'), '甲段')
    selectIn(p, () => { fireEvent.mouseUp(p) })

    expect(screen.getByTestId('at').textContent).toBe('3:7')
    fireEvent.click(screen.getByRole('button', { name: '起播' }))
    expect(onListen).toHaveBeenCalledWith(3, 7)
    expect(screen.getByTestId('at').textContent, '起播后收起').toBe('')
  })

  it('键盘划选（selectionchange）：不靠鼠标那一下，判据同一条', () => {
    const onListen = vi.fn()
    render(<Probe onListen={onListen} />)
    const p = must(document.querySelector('[data-pidx="9"]'), '乙段')
    selectIn(p, () => { fireEvent(document, new Event('selectionchange')) })

    expect(screen.getByTestId('at').textContent).toBe('3:9')
    fireEvent.click(screen.getByRole('button', { name: '起播' }))
    expect(onListen).toHaveBeenCalledWith(3, 9)
  })

  it('选区在正文容器之外 / 塌陷：不出落点', () => {
    render(<Probe onListen={vi.fn()} />)
    const outside = must(document.querySelectorAll('[data-pidx]')[2], '容器之外的段')
    selectIn(outside, () => { fireEvent.mouseUp(outside) })
    expect(screen.getByTestId('at').textContent, '容器外不算').toBe('')

    // 塌陷选区（只有光标没有范围）也收掉
    const p = must(document.querySelector('[data-pidx="7"]'), '甲段')
    selectIn(p, () => { fireEvent.mouseUp(p) })
    expect(screen.getByTestId('at').textContent).toBe('3:7')
    window.getSelection()?.removeAllRanges()
    fireEvent(document, new Event('selectionchange'))
    expect(screen.getByTestId('at').textContent, '塌陷即收').toBe('')
  })

  it('一滚就收：捕获阶段接住滚动，浮钮不跟着正文跑', () => {
    render(<Probe onListen={vi.fn()} />)
    const p = must(document.querySelector('[data-pidx="7"]'), '甲段')
    selectIn(p, () => { fireEvent.mouseUp(p) })
    expect(screen.getByTestId('at').textContent).toBe('3:7')

    // scroll 不冒泡，但捕获阶段仍经过 document——监听挂的就是 capture
    fireEvent.scroll(must(document.querySelector('[data-chapter="3"]'), '章块'))
    expect(screen.getByTestId('at').textContent, '滚动即收').toBe('')
  })

  it('收起钮清掉落点（点击与清空是同一件事）', () => {
    render(<Probe onListen={vi.fn()} />)
    const p = must(document.querySelector('[data-pidx="7"]'), '甲段')
    selectIn(p, () => { fireEvent.mouseUp(p) })
    fireEvent.click(screen.getByRole('button', { name: '收起' }))
    expect(screen.getByTestId('at').textContent).toBe('')
  })
})