// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { apply } from '../../src/client/index.js'

/**
 * 客户端注册面：小说 = **全局面板**（2026-09 迁移，用户拍板），不再是对话区 tab。
 *
 * 宿主契约（本机 host checkout 实证，`docs/reference/dsh-plugin-api.md` §10 证据 10c）：
 * - `sidebar.panellist`：root 作用域 list——每条 entry 是侧栏一行全局面板图标，注册项
 *   `{ id, order?, label? }`；宿主 sidebar shell 自带按钮/aria-current/tooltip，占用者组件
 *   只收 owner props `{ size, active }` 出图；
 * - `main`：root 作用域 keyed——「Central panel selected by sidebar entry id」，注册项
 *   `{ key }`，**同 id 的 panellist 行选中后 AppFrame 按 key 渲染 main 里的占用者**；
 *   保留键 `conversation` 归 Conversation，其余 key 无 Session 绑定；
 * - 「selecting a missing main entry throws」→ 两个座位必须同批注册（apply 内同步完成）。
 *
 * 本文件钉注册面本身（seam = `apply(ctx)` + 假 slots 服务）：座位名、id/key 一致性、
 * 图标组件吃得下 owner props、main 占用者真的渲染 NovelView、`conversation.view` 撤除。
 */

interface Registration { name: string; options: Record<string, unknown>; component: unknown }

function fakeSlots(): {
  slots: {
    inject: (name: string, fn: () => () => void) => () => void
    register: (options: Record<string, unknown>, component: unknown) => () => void
  }
  injected: string[]
  registrations: Registration[]
  effects: string[]
} {
  const injected: string[] = []
  const registrations: Registration[] = []
  const effects: string[] = []
  const slots = {
    inject(name: string, fn: () => () => void): () => void {
      injected.push(name)
      return fn()
    },
    register(options: Record<string, unknown>, component: unknown): () => void {
      registrations.push({ name: String(options.name), options, component })
      return () => {}
    },
  }
  return { slots, injected, registrations, effects }
}

function fakeCtx(s: ReturnType<typeof fakeSlots>): unknown {
  return {
    slots: s.slots,
    effect(fn: () => unknown, label?: string): unknown {
      s.effects.push(String(label))
      return fn()
    },
  }
}

afterEach(cleanup)

describe('客户端注册面：小说 = 全局面板（main keyed + sidebar.panellist list）', () => {
  it('apply 注入 sidebar.panellist 与 main 两个座位（同 id/key「novel」）；conversation.view 注册撤除', () => {
    const s = fakeSlots()
    apply(fakeCtx(s) as never)
    expect(s.injected).toContain('sidebar.panellist')
    expect(s.injected).toContain('main')
    expect(s.injected).toContain('shell.overlay')                 // 常驻状态层不变
    expect(s.injected).not.toContain('conversation.view')

    const icon = s.registrations.find((r) => r.name === 'sidebar.panellist')
    expect(icon, 'sidebar.panellist 未注册').toBeDefined()
    expect(icon?.options.id).toBe('novel')
    expect(icon?.options.label).toBe('小说')

    const panel = s.registrations.find((r) => r.name === 'main')
    expect(panel, 'main 未注册').toBeDefined()
    expect(panel?.options.key).toBe('novel')                      // 与 panellist id 同一个词

    expect(s.registrations.some((r) => r.name === 'shell.overlay' && r.options.id === 'novel-status')).toBe(true)
    // 每个注册都在 ctx.effect 内（随插件卸载可退订），且带可读标签
    expect(s.effects.filter((l) => l.includes('dsh-novel')).length).toBeGreaterThanOrEqual(3)
  })

  it('panellist 占用者 = 图标组件：吃得下宿主行的 owner props { size, active }', () => {
    const s = fakeSlots()
    apply(fakeCtx(s) as never)
    const icon = s.registrations.find((r) => r.name === 'sidebar.panellist')?.component as never
    const { container: c1 } = render(createElement(icon, { size: 16, active: false }))
    const svg = c1.querySelector('svg')
    expect(svg, '图标组件未渲染 svg').not.toBeNull()
    expect(svg?.getAttribute('width')).toBe('16')
    expect(svg?.getAttribute('aria-hidden')).toBe('true')          // 无障碍名归宿主行的 label
    const { container: c2 } = render(createElement(icon, { size: 18, active: true }))
    expect(c2.querySelector('svg')?.getAttribute('width')).toBe('18')
  })

  it('面板图标 = android-ebook 启动器前景字形（用户指定资产）：pathData 原样来自其 ic_launcher_foreground', () => {
    // 资产来源（external facts）：xrn1997/android-ebook @ master
    // `module_app/src/main/res/drawable-v24/ic_launcher_foreground.xml`（blob 80f575c，viewport
    // 2178.7234 + group translate 577.3617）——本仓按字形本体裁 viewBox（group 坐标系
    // 0..1025，字形 bbox 约 39..986 × 20..979），fill 用 currentColor 随宿主行前景色；
    // 背景层（ic_launcher_background.xml = 纯白方块，blob b5cd46e）刻意不搬：侧栏行自带底色，
    // 白方块在暗色主题下是块白斑。此钉防「图标被随手换回通用书本 stroke」。
    const s = fakeSlots()
    apply(fakeCtx(s) as never)
    const icon = s.registrations.find((r) => r.name === 'sidebar.panellist')?.component as never
    const { container } = render(createElement(icon, { size: 16, active: false }))
    const svg = container.querySelector('svg')
    expect(svg?.getAttribute('viewBox')).toBe('0 0 1025 1025')
    const path = container.querySelector('path')
    expect(path?.getAttribute('d')?.startsWith('M410.74,19.6')).toBe(true)   // 前景 pathData 原样
    expect(path?.getAttribute('d')?.includes('M749.71,264.67')).toBe(true)
    expect(path?.getAttribute('fill')).toBe('currentColor')
  })

  it('main 占用者 = 小说视图本体：渲染 NovelView（根、tab 导航、样式层都在）', () => {
    const s = fakeSlots()
    apply(fakeCtx(s) as never)
    const panel = s.registrations.find((r) => r.name === 'main')?.component as never
    render(createElement(panel))
    expect(document.querySelector('.novel-root')).not.toBeNull()
    expect(document.querySelector('[data-novel-style]')).not.toBeNull()
    expect(screen.getByRole('group', { name: '小说视图导航' })).toBeTruthy()
  })
})
