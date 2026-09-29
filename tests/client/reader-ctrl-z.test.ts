import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CTRL_Z, PrefsPanel, ReaderView } from '../../src/client/views/ReaderView.js'

/**
 * Aa 控制器层 z 序守卫——「能弹出但点不了」防回归。
 *
 * 病根（无头 Edge elementFromPoint 实证）：面板嵌在 sticky 工具栏内，工具栏 position:sticky
 * + z-index **自成 stacking context**，面板的 z-index 只在工具栏内部有效。工具栏（5）低于
 * 根部遮罩（10）时，透明遮罩反压整层——面板看得见，但每个点击都被遮罩吞掉直接关面板。
 * 不变量是**工具栏 > 遮罩**（面板 > 遮罩只是工具栏内部的排序）。
 */
describe('Aa 控制器层 z 序守卫（「能弹出但点不了」防回归）', () => {
  it('不变量：工具栏 stacking context 必须压过遮罩（面板嵌在工具栏内，z 只在工具栏内有效）', () => {
    expect(CTRL_Z.toolbar, '工具栏 ≤ 遮罩 → 透明遮罩反压整层面板：看得见点不了').toBeGreaterThan(CTRL_Z.mask)
    expect(CTRL_Z.panel).toBeGreaterThan(CTRL_Z.mask)
  })

  it('接线：真实渲染用的就是这套值（防「常量改了但组件没用」）', () => {
    // 工具栏常驻渲染：renderToString 直接断言内联 z-index（React 序列化为 z-index:12）
    const html = renderToString(createElement(ReaderView, { sourceId: 's', bookKey: 'k', title: 'T' }))
    expect(html).toContain(`z-index:${CTRL_Z.toolbar}`)
    // 面板（导出组件单渲染）：挂载于工具栏内是结构前提——源码里它是工具栏的子元素
    const panel = renderToString(createElement(PrefsPanel))
    expect(panel).toContain(`z-index:${CTRL_Z.panel}`)
    // 遮罩只在两个控制器面板都闭着时不渲染（ctrlOpen / expOpen 同候），renderToString（闭态）拿不到——扫源码确认用的是常量而非散写字面量
    const src = readFileSync(fileURLToPath(new URL('../../src/client/views/ReaderView.tsx', import.meta.url)), 'utf8')
    expect(src).toContain('zIndex: CTRL_Z.mask')
  })
})
