import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { dismiss, pushError, pushOk, pushPending, resetTransient, transientEntries } from '../../src/client/transient.js'
import { resetJobSurface } from '../../src/client/jobs.js'
import { NovelStatusOverlay } from '../../src/client/views/NovelStatusOverlay.js'
import { SettingsSection } from '../../src/client/views/SettingsSection.js'

/** 瞬态统一层（「全局状态条」）：条目生命周期 + 状态条渲染分支 */

const kinds = (): string[] => transientEntries().map((e) => e.kind)

describe('transient 条目生命周期', () => {
  beforeEach(resetTransient)
  afterEach(() => { resetTransient(); vi.useRealTimers() })

  it('pending：settle() 收工不留痕', () => {
    const settle = pushPending('「A」启停')
    expect(kinds()).toEqual(['pending'])
    settle()
    expect(transientEntries()).toEqual([])
  })
  it('pending：settle(errText) 移除自身并转错误，携带 anchor（定位跳转/行内标记共用）', () => {
    const settle = pushPending('「A」启停', '[data-novel-source-row="a1"]')
    settle('「A」启停失败：boom')
    const [err] = transientEntries()
    expect(kinds()).toEqual(['error'])
    expect(err.label).toBe('「A」启停失败：boom')
    expect(err.anchor).toBe('[data-novel-source-row="a1"]')
  })
  it('settle 幂等：二次结算不追加错误（then/finally 双路径踩过的坑）', () => {
    const settle = pushPending('「A」启停')
    settle('第一次')
    settle('第二次')
    expect(transientEntries()).toHaveLength(1)
    expect(transientEntries()[0].label).toBe('第一次')
  })
  it('多条 pending 并存（聚合计数的原料，互不吞并）', () => {
    pushPending('「A」启停')
    pushPending('「B」启停')
    expect(kinds()).toEqual(['pending', 'pending'])
  })
  it('ok：TTL 自动退场（少而淡——成功不粘屏）', () => {
    vi.useFakeTimers()
    pushOk('已保存登录态')
    expect(kinds()).toEqual(['ok'])
    vi.advanceTimersByTime(2500)
    expect(transientEntries()).toEqual([])
  })
  it('error：sticky——不自动退场，dismiss 才移除', () => {
    vi.useFakeTimers()
    const id = pushError('boom')
    vi.advanceTimersByTime(60_000)
    expect(kinds()).toEqual(['error'])
    dismiss(id)
    expect(transientEntries()).toEqual([])
  })
})

describe('全局状态条渲染分支（renderToString；住址＝shell.overlay 的常驻层）', () => {
  beforeEach(() => { resetTransient(); resetJobSurface() })
  afterEach(() => { resetTransient(); resetJobSurface() })

  it('空闲零占用：无条目无任务 → 条身整体不渲染', () => {
    const html = renderToString(createElement(NovelStatusOverlay, {}))
    expect(html).not.toContain('data-novel-status-bar')
  })
  it('有错误 → 状态条渲染：文案 + 「定位 →」（带 anchor 时）', () => {
    pushError('「笔趣阁」启停失败：boom', '[data-novel-source-row="a1"]')
    pushError('批量删除失败：boom2')                        // 无 anchor：不出定位按钮
    const html = renderToString(createElement(NovelStatusOverlay, {}))
    expect(html).toContain('data-novel-status-bar')
    expect(html).toContain('「笔趣阁」启停失败：boom')
    expect(html).toContain('定位 →')
    expect(html.match(/定位 →/g)).toHaveLength(1)           // 仅带 anchor 的条目有定位按钮
  })
  it('有成功 → 状态条渲染 ✓；行内不再插「保存中…」行（文案归条）', () => {
    pushOk('已保存登录态')
    const html = renderToString(createElement(NovelStatusOverlay, {}))
    expect(html).toContain('data-novel-status-bar')
    expect(html).toContain('已保存登录态')
  })
  it('状态条＝浮层：锚是铺满视口的 .novel-shell-status（默认 click-through），条身不吃布局', () => {
    // 闪烁回归锁的另一半：泳道挂载不参与布局（真机实测曾整块 +35px 再弹回）
    pushOk('已保存登录态')
    const html = renderToString(createElement(NovelStatusOverlay, {}))
    expect(html).toContain('novel-shell-status')
    expect(html).toContain('class="novel-status-bar"')
    expect(html).not.toContain('novel-status-bar" style')      // 布局归样式层，不靠行内 style 兜
  })
  it('书源管理区不再自带状态条——同一读数不留第二住址', () => {
    pushOk('已保存登录态')
    expect(renderToString(createElement(SettingsSection))).not.toContain('data-novel-status-bar')
  })
})
