// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import type { ReactNode } from 'react'
import { NovelStatusOverlay } from '../../src/client/views/NovelStatusOverlay.js'
import { SettingsSection } from '../../src/client/views/SettingsSection.js'
import { resetJobSurface, takeJobOpen } from '../../src/client/jobs.js'
import { createStore, navigate, routeStore, useStore } from '../../src/client/store.js'
import type { Store } from '../../src/client/store.js'
import { apply } from '../../src/client/index.js'
import { fakeCtx, fakeHost } from './fake-host.js'
import { makeDeps } from './fake-deps.js'
import { NOVEL_CSS } from '../../src/client/styles.js'
import type { JobState, SourcePublic } from '../../src/client/views/types.js'

/**
 * 常驻状态层（`shell.overlay` 位）的接线钉子。
 * 为什么要存在：`conversation.view` 是 list 基数且壳层只渲染当前激活 entry（官方 slots 层级表 +
 * 宿主壳层 `renderSlot('conversation.view', …, { only: active.id })`），状态条原先住在
 * `SettingsSection` 里 ⇒ 用户一切 tab 就看不见仍在服务端跑的任务。
 * 本文件钉死新住址的几件事：常驻层自带任务泳道、空闲零占用、点击把用户送回现场并记下要看什么，
 * 以及「送回现场」要真的把小说面板带到前台——用户停在宿主别的界面上点「点此查看」，不能点了没反应。
 */

const runningImport: JobState = {
  id: 'imp1', kind: 'import', phase: 'running', total: 642, done: 100,
  counts: { ok: 90, failed: 5, dupSkipped: 4, replaced: 1 },
  issues: [], fileErrors: [], startedAt: 0,
}
const runningProbe: JobState = { ...runningImport, id: 'prb1', kind: 'batch-probe' }

const depsWith = (job: JobState | null) => makeDeps({
  fetchJobStatus: vi.fn(async () => job),
  apiGet: vi.fn(async (path: string) => (path === 'sources' ? [] as SourcePublic[] : null)),
})

afterEach(() => {
  cleanup()
  resetJobSurface()
  navigate({ name: 'shelf' })
  vi.unstubAllGlobals()
})

/** `.novel-status-bar` 条身自己的规则体（行首锚定：`.novel-shell-status .novel-status-bar` 那条
 *  只是 pointer-events 的补充，不是条身） */
const barRule = (): string => (NOVEL_CSS.match(/^\.novel-status-bar \{[\s\S]*?\}/m) ?? [''])[0]

describe('NovelStatusOverlay（视图环之外的常驻状态层）', () => {
  it('条身锚右下且非通栏：overlay 层铺满整个 frame，顶部通栏会压住宿主会话顶栏并吃掉那一带的点击', () => {
    const css = barRule()
    expect(css).toContain('bottom:')
    expect(css).toContain('right:')
    expect(css).not.toMatch(/\btop:/)
    // 同时给 left 与 right = 通栏（真机读数：y=6、左右各 8、宽 1264、高 26，正盖在宿主标题行上）
    expect(css).not.toContain('left:')
    expect(css).toContain('max-width')
  })


  it('任务在跑 → 常驻层里有任务泳道与进度读数（不依赖小说视图任何 tab 在场）', async () => {
    render(<NovelStatusOverlay deps={depsWith(runningImport)} focusPanel={() => {}} />)
    const lane = await screen.findByText('导入中…')
    expect(lane.textContent).toBeTruthy()
    expect(document.querySelector('[data-novel-job-status]')).not.toBeNull()
    expect(document.querySelector('[data-novel-shell-status]')).not.toBeNull()
    expect(lane.parentElement?.parentElement?.textContent).toContain('100/642')
  })

  it('自带样式层与 token 锚点：小说视图卸载后不许剥成裸文字（真机实测缺陷）', async () => {
    const { container } = render(<NovelStatusOverlay deps={depsWith(runningImport)} focusPanel={() => {}} />)
    const root = container.querySelector('[data-novel-shell-status]')
    // --novel-* 只定义在 `.novel-root, [data-novel-scope]` 上；overlay 在宿主 overlayLayer 里，
    // 没有 .novel-root 祖先 ⇒ 少了这个属性就整棵取不到值（底色/圆角/z-index 静默失效）
    expect(root?.hasAttribute('data-novel-scope')).toBe(true)
    // 样式层随视图卸载（切到「对话」tab 即实测 0 条），本层必须自己注一份
    expect(root?.querySelector('[data-novel-style]')).not.toBeNull()
  })

  it('空闲（无任务无瞬态条目）→ 整块不渲染，零占用', async () => {
    const { container } = render(<NovelStatusOverlay deps={depsWith(null)} focusPanel={() => {}} />)
    await new Promise((r) => setTimeout(r, 10))
    expect(container.querySelector('[data-novel-status-bar]')).toBeNull()
  })

  it('点任务泳道（import）→ 路由去书源管理，记下「要打开导入弹层」，并把小说面板带到前台', async () => {
    navigate({ name: 'shelf' })
    const focusPanel = vi.fn()
    render(<NovelStatusOverlay deps={depsWith(runningImport)} focusPanel={focusPanel} />)
    fireEvent.click(await screen.findByText('导入中…'))
    expect(routeStore.get().route.name).toBe('sources')
    expect(takeJobOpen()).toBe('import')
    expect(focusPanel).toHaveBeenCalled()
  })

  it('点任务泳道（probe）→ 记的是「看任务卡」，不是弹层', async () => {
    const focusPanel = vi.fn()
    render(<NovelStatusOverlay deps={depsWith(runningProbe)} focusPanel={focusPanel} />)
    fireEvent.click(await screen.findByText('验证中…'))
    expect(takeJobOpen()).toBe('probe')
    expect(focusPanel).toHaveBeenCalled()
  })
})

describe('SettingsSection 让位（同一份任务只有一个轮询实例、一处呈现）', () => {
  it('书源管理区内不再自带状态条——避免同一条数出现两个住址', async () => {
    const { container } = render(<SettingsSection deps={depsWith(runningImport)} />)
    await new Promise((r) => setTimeout(r, 20))
    expect(container.querySelector('[data-novel-status-bar]')).toBeNull()
    expect(container.querySelector('.novel-status-host')).toBeNull()
  })
})

/** 宿主壳层最小模型（照宿主契约）：侧栏选中哪个 id，main keyed 槽就渲染哪个面板；
 *  shell.overlay 常驻不随选中卸载。面板本体用「现场标记」代位——路由 → 视图的呈现归
 *  views-wiring 的钉子，此处只裁一件事：用户被送到的现场在不在眼前。 */
function HostFrame({ panel, overlay }: { panel: Store<{ id: string }>; overlay: unknown }): ReactNode {
  const { id } = useStore(panel)
  const { route } = useStore(routeStore)
  return (
    <>
      {id === 'novel' ? <div>小说现场：{route.name}</div> : <div>宿主界面：{id}</div>}
      {createElement(overlay as never)}
    </>
  )
}

describe('任务泳道 = 跨界面的「去现场」（小说面板不在前台也必须走得到）', () => {
  it('宿主别的界面上点「点此查看」→ 小说面板被带到前台、书源管理现场呈现在眼前', async () => {
    // 走 apply 注册的真实常驻层（生产接线），取数边界换成 fetch 桩（信封形状归 wire 契约）
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ ok: true, value: { job: runningProbe } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )))
    const host = fakeHost()
    apply(fakeCtx(host) as never)
    const overlay = host.registrations.find((r) => r.name === 'shell.overlay')?.component
    const panel = createStore<{ id: string }>({ id: 'plugins' })
    host.layout.selectPanel.mockImplementation((id: string | null) => panel.set({ id: id ?? 'conversation' }))
    navigate({ name: 'shelf' })
    render(<HostFrame panel={panel} overlay={overlay} />)
    fireEvent.click(await screen.findByText('点此查看 →'))
    expect(await screen.findByText('小说现场：sources')).toBeTruthy()
    expect(host.layout.selectPanel).toHaveBeenCalledWith('novel')
  })
})
