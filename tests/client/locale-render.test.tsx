// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { CopyProvider, enTranslate, zhTranslate } from '../../src/client/copy/index.js'
import type { Translate } from '../../src/client/copy/index.js'
import { NovelView } from '../../src/client/views/NovelView.js'
import { navigate } from '../../src/client/store.js'

/** 英文渲染：导航面。断言取 role + 组名，不按中文/英文散字找节点——
 *  同一棵树里 shelf 面板与 tab 可能同词，组名才是 tab 身份。 */

afterEach(() => { cleanup(); navigate({ name: 'shelf' }) })

describe('英文渲染：导航', () => {
  it('tab 与 aria-label 走 en 字典', () => {
    navigate({ name: 'shelf' })
    render(createElement(CopyProvider, { value: enTranslate, children: createElement(NovelView) }))
    const group = screen.getByRole('group', { name: 'Novel view navigation' })
    // 书架面板落地英文后「Shelf」同树多处出现：tab 身份按组内按钮取，不按散字取
    expect(within(group).getByRole('button', { name: 'Shelf' })).toBeTruthy()
    expect(within(group).getByRole('button', { name: 'Discover' })).toBeTruthy()
    expect(within(group).getByRole('button', { name: 'Sources' })).toBeTruthy()
  })

  it('无 CopyProvider 时回退中文（默认 t = zhTranslate）', () => {
    navigate({ name: 'shelf' })
    render(createElement(NovelView))
    const group = screen.getByRole('group', { name: '小说视图导航' })
    expect(within(group).getByRole('button', { name: '书架' })).toBeTruthy()
    expect(within(group).getByRole('button', { name: '书城' })).toBeTruthy()
    expect(within(group).getByRole('button', { name: '书源管理' })).toBeTruthy()
  })

  it('同一个 t 的字典切换：父级重渲后已挂载树跟着当前 locale 走', () => {
    let active: 'zh' | 'en' = 'zh'
    const t: Translate = (key, params) => (active === 'zh' ? zhTranslate : enTranslate)(key, params)
    const tree = () => createElement(CopyProvider, { value: t, children: createElement(NovelView) })
    const { rerender } = render(tree())
    expect(screen.getByRole('group', { name: '小说视图导航' })).toBeTruthy()
    active = 'en'
    rerender(tree())
    expect(screen.getByRole('group', { name: 'Novel view navigation' })).toBeTruthy()
  })
})
