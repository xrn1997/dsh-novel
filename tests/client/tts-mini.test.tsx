// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement, StrictMode } from 'react'
import { ROUTES, BROWSER_TTS_ENGINE_ID, TTS_DEFAULTS, planarNavigation } from '../../src/shared/wire.js'
import type {
  ChapterContent, ChapterEntry, RouteTarget, ShelfEntry, WriteMethod,
} from '../../src/shared/wire.js'
import { apiGet, apiSend } from '../../src/client/api.js'
import { apply } from '../../src/client/index.js'
import { resetPanelShelf } from '../../src/client/panel-shelf.js'
import type { ReaderPort } from '../../src/client/reader-session.js'
import { ReaderSession } from '../../src/client/reader-session.js'
import { navigate, routeStore } from '../../src/client/store.js'
import { NOVEL_CSS } from '../../src/client/styles.js'
import { ls } from '../../src/client/util.js'
import {
  TTS_MAX_CONSECUTIVE_FAILURES,
  pauseListening, requestReaderRelocation, resetTtsPlayer, setListenRate, setListenTimer, skipChapter,
  startListening, takeReaderRelocation, ttsPlayer, ttsProgress,
} from '../../src/client/tts/player.js'
import { TtsMiniBar } from '../../src/client/tts/TtsMiniBar.js'
import { TtsSettingsRows } from '../../src/client/tts/TtsSettings.js'
import {
  CAPSULE_SIZE, DEFAULT_MINI_BAR_SIZE, deriveMiniBarSide, miniBarStore, resetMiniBarPosition,
  resetMiniBarSize, setMiniBarCenter, setMiniBarCollapsed,
} from '../../src/client/tts/mini-bar-state.js'
import { readerPresence } from '../../src/client/tts/reader-presence.js'
import { ReaderView } from '../../src/client/views/ReaderView.js'
import { Dialog } from '../../src/client/views/dialog.js'
import { ShelfView } from '../../src/client/views/ShelfView.js'
import { makeCoreDeps, makeReaderDeps } from './fake-deps.js'
import type { FakeReaderDeps } from './fake-deps.js'
import { fakeCtx, fakeHost } from './fake-host.js'
import { must } from '../support/fixture.js'

/**
 * 全局迷你条 + 书架「正在听」徽标的行为网（Task 12 的验收面）。
 *
 * 钉三件事：
 * ① 迷你条**只在「会话在 ∧ 阅读器在场书键里没有会话本书」时**出现在宿主 overlay 层（判据是
 *    `reader-presence` 的子树信号 + 书键，不是插件内路由——宿主切走面板时路由仍停在 reader）；
 *    两态浮窗（缺省贴边胶囊 / 展开精修媒体卡）的动作与设置都接播放层与共享设置件；
 * ② 「回阅读器」= 一次性重定位现场（带 `{sourceId, bookKey}`）+ 切路由。阅读器开书时**按书键**
 *    取现场当**恢复目标**（存档恢复同一条不写路径），因此落的是听书章段而不是存档 progress；
 *    取走即摘、别的书不消费，第二次开书回存档；
 * ③ 书架只有一条消费位置：卡片按 `progress` 显示进度行，正在听的本书标「正在听」——
 *    不再并列一条「听至」读数。
 *
 * 播放层是真模块（store/动作），`/novel-api` 与 Audio 被替身接管；阅读器一侧走真
 * ReaderView / ReaderSession，只有网络经 fake-deps 注入。
 */
vi.mock('../../src/client/api.js', () => ({
  apiGet: vi.fn(),
  apiSend: vi.fn(),
  apiUpload: vi.fn(),
  apiEventStream: vi.fn(),
  describeError: (error: unknown): string => (error instanceof Error ? error.message : String(error)),
}))

class FakeAudio {
  static instances: FakeAudio[] = []
  src = ''
  volume = 1
  preload = ''
  paused = true
  currentTime = 0
  onended: (() => void) | null = null
  onplaying: (() => void) | null = null
  constructor() { FakeAudio.instances.push(this) }
  play = vi.fn(async () => { this.paused = false; this.onplaying?.() })
  pause = vi.fn(() => { this.paused = true })
  /** 停播时播放层会摘 src 松开缓冲（`removeAttribute` + `load` 那一对，不是赋空串） */
  removeAttribute = vi.fn()
  load = vi.fn()
}

let chapterNames: string[]
let chapterTexts: string[][]
let shelf: ShelfEntry[]

const chapterEntries = (): ChapterEntry[] => chapterNames.map((name) => ({ name, url: name }))

function indexOf(path: string): number {
  const m = /[?&]index=(\d+)/.exec(path)
  return m === null ? 0 : Number(m[1])
}

function textOf(index: number): string {
  return must(chapterTexts[index], `chapter text ${index}`).join('\n')
}

function shelfEntry(over: Partial<ShelfEntry> = {}): ShelfEntry {
  return {
    sourceId: 's1', bookKey: 'k1', title: '书一', sourceName: null,
    progress: { chapterIndex: 0, offsetRatio: 0, updatedAt: 0 },
    addedAt: 0,
    ...over,
  }
}

function readerDeps(over: Partial<FakeReaderDeps> = {}): FakeReaderDeps {
  return makeReaderDeps({
    apiGet: vi.fn(async (path: string) => {
      if (path.startsWith('navigation')) {
        const chapters = chapterEntries()
        return { chapters, items: planarNavigation(chapters) }
      }
      if (path.startsWith('chapter')) return { kind: 'text', text: textOf(indexOf(path)) } satisfies ChapterContent
      if (path === ROUTES.ttsSources.path) return { sources: [], hostSpeech: { state: 'absent' } }
      return shelf
    }),
    ...over,
  })
}

function renderReader(deps: FakeReaderDeps): ReturnType<typeof render> {
  return render(createElement(ReaderView, { sourceId: 's1', bookKey: 'k1', title: '书一', deps }))
}

/** 写口里带 progress 的 body（阅读器的 restore 路径不许有一笔；播放层自己的落盘另算） */
function progressBodies(send: Mock): Record<string, unknown>[] {
  return send.mock.calls
    .filter(([target]) => (target as RouteTarget<WriteMethod>).path.startsWith('shelf/'))
    .map(([, body]) => (body ?? {}) as Record<string, unknown>)
    .filter((body) => 'progress' in body)
}

function cardOf(title: string): HTMLElement {
  const card = [...document.querySelectorAll<HTMLElement>('.novel-card')]
    .find((el) => el.textContent.includes(title))
  expect(card, `书架卡片「${title}」不在场`).toBeDefined()
  return must(card, `书架卡片「${title}」`)
}

interface FakePort extends ReaderPort {
  anchors: Array<{ index: number; start: number; height: number }>
  top: number
  height: number
  scrollH: number
}

/** 会话级假几何（与 reader-session.test 同形但只留本文件用到的读数） */
function fakePort(): FakePort {
  const port: FakePort = {
    anchors: [], top: 0, height: 1000, scrollH: 5000,
    measureAnchors: () => port.anchors,
    scrollTop: () => port.top,
    setScrollTop: (px: number) => { port.top = px },
    viewHeight: () => port.height,
    scrollHeight: () => port.scrollH,
    sentinelOffset: () => null,
    targetOffset: () => null,
    targetOffsets: (_index, anchorIds) => anchorIds.map(() => null),
    currentNode: () => null,
  }
  return port
}

beforeEach(() => {
  resetTtsPlayer()
  resetPanelShelf()
  // 迷你条的位置与收起态是模块级现场：不留上一用例的落位
  resetMiniBarPosition()
  resetMiniBarSize()
  setMiniBarCollapsed(false)
  navigate({ name: 'shelf' })
  FakeAudio.instances = []
  vi.stubGlobal('Audio', FakeAudio)
  vi.clearAllMocks()
  // 三章 / 每章三段：段号换算（1 → 0.5）与恢复落位都取得到整读数
  chapterNames = ['第一章', '第二章', '第三章']
  chapterTexts = [
    ['第一段。', '第二段。', '第三段。'],
    ['第二章第一段。', '第二章第二段。', '第二章第三段。'],
    ['第三章第一段。', '第三章第二段。', '第三章第三段。'],
  ]
  shelf = []
  vi.mocked(apiGet).mockImplementation(async (path: string) => {
    if (path.startsWith('navigation')) {
      const chapters = chapterEntries()
      return { chapters, items: planarNavigation(chapters) }
    }
    if (path.startsWith('chapter')) return { kind: 'text', text: textOf(indexOf(path)) }
    if (path === ROUTES.shelf.path) return shelf
    if (path === ROUTES.ttsSources.path) return { sources: [], hostSpeech: { state: 'absent' } }
    throw new Error(`unexpected GET ${path}`)
  })
  vi.mocked(apiSend).mockImplementation(async (target: RouteTarget<WriteMethod>, body?: unknown) => {
    if (target.path === ROUTES.ttsSynthesize.path) {
      const record = (body ?? {}) as { text?: unknown }
      const text = typeof record.text === 'string' ? record.text : ''
      return { key: `k-${text}`, mediaType: 'audio/mpeg' }
    }
    if (target.path.startsWith('shelf/')) return {}
    throw new Error(`unexpected ${target.method} ${target.path}`)
  })
})

afterEach(() => {
  cleanup()
  resetTtsPlayer()
  navigate({ name: 'shelf' })
  vi.unstubAllGlobals()
})

describe('shell.overlay 注册面', () => {
  it('迷你条是第二个 shell.overlay 条目：id「@xrn1997/dsh-novel.tts-mini」、order 90', () => {
    const host = fakeHost()
    apply(fakeCtx(host) as never)
    const reg = host.registrations.find(
      (r) => r.name === 'shell.overlay' && r.options.id === '@xrn1997/dsh-novel.tts-mini',
    )
    expect(reg, '迷你条未注册到 shell.overlay').toBeDefined()
    expect(reg?.options.order).toBe(90)
  })

  it('两个条目同一次 inject 注册：注入一次、两枚注册、退订成对', () => {
    // 宿主「同一 slot 二次 inject」的契约在仓内无法验证，故接线收成一次 inject + 两枚注册
    // （`src/client/index.tsx`）。这里把两条可观察后果钉住：注入只发生一次；退订同时撤两枚。
    const host = fakeHost()
    const unregisters: Mock[] = []
    const register = host.slots.register
    host.slots.register = (options, component) => {
      register(options, component)
      const off = vi.fn()
      unregisters.push(off)
      return off
    }
    interface EffectSeam { effect: (fn: () => () => void, label?: string) => () => void }
    const ctx = fakeCtx(host) as EffectSeam
    const disposers: Array<() => void> = []
    const effect = ctx.effect
    ctx.effect = (fn, label) => {
      const dispose = effect(fn, label)
      if (label !== undefined && label.includes('shell overlay')) disposers.push(dispose)
      return dispose
    }
    apply(ctx as never)

    expect(host.injected.filter((name) => name === 'shell.overlay')).toEqual(['shell.overlay'])
    const entries = host.registrations.filter((r) => r.name === 'shell.overlay')
    expect(entries.map((r) => [r.options.id, r.options.order])).toEqual([
      ['@xrn1997/dsh-novel.status', 100],
      ['@xrn1997/dsh-novel.tts-mini', 90],
    ])
    // 应用共四枚注册（侧栏 / main / 状态层 / 迷你条）；退订这个 overlay effect 只撤后两枚，
    // 侧栏与 main 的两枚各有自己的 effect，不能被顺带撤掉
    expect(unregisters).toHaveLength(4)
    expect(disposers).toHaveLength(1)
    for (const dispose of disposers) dispose()
    expect(must(unregisters[2], '状态层退订')).toHaveBeenCalledTimes(1)
    expect(must(unregisters[3], '迷你条退订')).toHaveBeenCalledTimes(1)
    expect(must(unregisters[0], '侧栏退订')).not.toHaveBeenCalled()
    expect(must(unregisters[1], 'main 退订')).not.toHaveBeenCalled()
  })

  it('注册的占用者自带文案口：在放时渲染出迷你条（不依赖小说面板在场）', async () => {
    const host = fakeHost()
    apply(fakeCtx(host) as never)
    const component = host.registrations.find(
      (r) => r.name === 'shell.overlay' && r.options.id === '@xrn1997/dsh-novel.tts-mini',
    )?.component as never
    render(createElement(component))
    await act(async () => {
      await startListening({ sourceId: 's1', bookKey: 'k1', title: '书一', chapterIndex: 1, paragraphIndex: 1 })
    })
    expect(document.querySelector('[data-novel-tts-mini]')).not.toBeNull()
  })

  it('注册面把「回阅读器」接到宿主 layout.selectPanel：宿主停在别的面板上也到得了现场', async () => {
    const host = fakeHost()
    apply(fakeCtx(host) as never)
    const component = host.registrations.find(
      (r) => r.name === 'shell.overlay' && r.options.id === '@xrn1997/dsh-novel.tts-mini',
    )?.component as never
    render(createElement(component))
    await act(async () => {
      await startListening({ sourceId: 's1', bookKey: 'k1', title: '书一', chapterIndex: 1, paragraphIndex: 1 })
    })
    fireEvent.click(screen.getByRole('button', { name: '回阅读器' }))
    expect(host.layout.selectPanel).toHaveBeenCalledWith('@xrn1997/dsh-novel.panel')
    expect(routeStore.get().route.name).toBe('reader')
  })
})

describe('迷你条的在场条件', () => {
  it('在放 + route=shelf → 渲染书名 / 章段读数 / 当前句（封面位已退场）', async () => {
    const focusPanel = vi.fn()
    render(createElement(TtsMiniBar, { focusPanel }))
    await act(async () => {
      await startListening({ sourceId: 's1', bookKey: 'k1', title: '书一', chapterIndex: 1, paragraphIndex: 1 })
    })
    const bar = must(document.querySelector<HTMLElement>('[data-novel-tts-mini]'), '迷你条')
    expect(bar.textContent).toContain('书一')
    expect(bar.textContent).toContain('第 2 章')
    expect(bar.textContent).toContain('2/3')
    expect(bar.querySelector('.novel-tts-mini-body')?.textContent).toBe('第二章第二段。')
    // 身份让位：浮窗不再渲染封面位（ADR-0074）
    expect(bar.querySelector('.novel-tts-mini-cover')).toBeNull()
    // 未在放时不渲染
    await act(async () => { ttsPlayer.set({ active: false }) })
    expect(document.querySelector('[data-novel-tts-mini]')).toBeNull()
  })

  it('在放 + route=reader + 阅读器未挂载（宿主切走面板）→ 仍渲染', async () => {
    // 宿主切走「小说」面板时中央呈现座位卸载面板子树，而 routeStore 仍停在 reader（永不复位）：
    // 按路由判在场会把迷你条藏在最该出现的那一格（ADR-0022）。
    navigate({ name: 'reader', sourceId: 's1', bookKey: 'k1', title: '书一' })
    const focusPanel = vi.fn()
    render(createElement(TtsMiniBar, { focusPanel }))
    await act(async () => {
      await startListening({ sourceId: 's1', bookKey: 'k1', title: '书一', chapterIndex: 0, paragraphIndex: 0 })
    })
    expect(document.querySelector('[data-novel-tts-mini]')).not.toBeNull()
  })

  it('在放 + 阅读器子树在场 → 不渲染（阅读器里的听书条是同一件事的就地版本）', async () => {
    render(createElement(TtsMiniBar, { focusPanel: vi.fn() }))
    await act(async () => {
      await startListening({ sourceId: 's1', bookKey: 'k1', title: '书一', chapterIndex: 0, paragraphIndex: 0 })
    })
    expect(document.querySelector('[data-novel-tts-mini]')).not.toBeNull()
    const reader = renderReader(readerDeps())
    await waitFor(() => expect(reader.container.querySelector('[data-chapter="0"]')).not.toBeNull())
    expect(readerPresence.get().depth).toBe(1)
    expect(document.querySelector('[data-novel-tts-mini]')).toBeNull()
    // 卸载即撤场（释放函数在 effect cleanup 里），迷你条回到常驻层
    reader.unmount()
    expect(readerPresence.get().depth).toBe(0)
    expect(document.querySelector('[data-novel-tts-mini]')).not.toBeNull()
  })

  it('在放 + 阅读器开着另一本 → 迷你条照常在场（控制面不许整个消失，ADR-0072）', async () => {
    render(createElement(TtsMiniBar, { focusPanel: vi.fn() }))
    await act(async () => {
      await startListening({ sourceId: 's1', bookKey: 'k1', title: '书一', chapterIndex: 0, paragraphIndex: 0 })
    })
    const reader = render(createElement(ReaderView, { sourceId: 's2', bookKey: 'k2', title: '书二', deps: readerDeps() }))
    await waitFor(() => expect(reader.container.querySelector('[data-chapter="0"]')).not.toBeNull())
    expect(readerPresence.get().bookKeys).toContain('k2')
    expect(readerPresence.get().bookKeys).not.toContain('k1')
    expect(document.querySelector('[data-novel-tts-mini]')).not.toBeNull()
    reader.unmount()
    expect(readerPresence.get().bookKeys).toEqual([])
  })

  it('阅读器卸载清在场信号：挂载记一笔、卸载后 depth 归零', async () => {
    const reader = renderReader(readerDeps())
    await waitFor(() => expect(reader.container.querySelector('[data-chapter="0"]')).not.toBeNull())
    expect(readerPresence.get().depth).toBe(1)
    reader.unmount()
    expect(readerPresence.get().depth).toBe(0)
  })

  it('未在放（无会话）→ 整块不渲染', () => {
    render(createElement(TtsMiniBar, { focusPanel: vi.fn() }))
    expect(document.querySelector('[data-novel-tts-mini]')).toBeNull()
  })

  it('条上动作：暂停/继续、下一段、停止都接播放层（不自造第二份播放状态）', async () => {
    render(createElement(TtsMiniBar, { focusPanel: vi.fn() }))
    await act(async () => {
      await startListening({ sourceId: 's1', bookKey: 'k1', title: '书一', chapterIndex: 0, paragraphIndex: 0 })
    })
    fireEvent.click(screen.getByRole('button', { name: '暂停' }))
    expect(ttsPlayer.get().playing).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: '继续播放' }))
    expect(ttsPlayer.get().playing).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '下一段' }))
    expect(ttsPlayer.get().paragraphIndex).toBe(1)
    fireEvent.click(screen.getByRole('button', { name: '停止听书' }))
    expect(ttsPlayer.get().active).toBe(false)
    // 停止即离场：没有在放会话就没有迷你条（与在场条件同一条判据）
    expect(document.querySelector('[data-novel-tts-mini]')).toBeNull()
  })
})

describe('迷你条是浮窗：两个完整形态、可拖、可收起', () => {
  /** 起播到「第二章第二段」并返回迷你条根节点（展开态）。 */
  async function listening(): Promise<HTMLElement> {
    render(createElement(TtsMiniBar, { focusPanel: vi.fn() }))
    await act(async () => {
      await startListening({ sourceId: 's1', bookKey: 'k1', title: '书一', chapterIndex: 1, paragraphIndex: 1 })
    })
    return must(document.querySelector<HTMLElement>('[data-novel-tts-mini]'), '迷你条')
  }

  it('展开态正文区整段上屏（不再是两行截断）', async () => {
    const bar = await listening()
    const body = must(bar.querySelector('.novel-tts-mini-body'), '正文区')
    expect(body.textContent).toBe('第二章第二段。')
  })

  async function renderExpanded(over: Record<string, unknown> = {}): Promise<HTMLElement> {
    const bar = await listening()
    if (Object.keys(over).length > 0) {
      await act(async () => { ttsPlayer.set({ ...ttsPlayer.get(), ...over }) })
    }
    return bar
  }

  it('展开态：顶行身份钮与齿轮是兄弟按钮，不嵌套；无手柄', async () => {
    await renderExpanded()
    const collapse = screen.getByRole('button', { name: /收起迷你条/ })
    const gear = screen.getByRole('button', { name: '听书设置' })
    expect(collapse.parentElement).toBe(gear.parentElement)
    expect(collapse.querySelector('button')).toBeNull()
    expect(screen.queryByRole('button', { name: '拖动迷你条' })).toBeNull()
    // 可见标签（书名 + 章）必须包含在可访问名里：读屏用户不会只听到「收起」，
    // 与胶囊展开钮的「展开迷你条 · 书名 · 段号」同一写法
    expect(collapse.getAttribute('aria-label')).toContain('书一')
    expect(collapse.getAttribute('aria-label')).toContain('第 2 章')
  })

  it('齿轮不是拖面：从它起手拖动不改中心', async () => {
    await renderExpanded()
    const gear = screen.getByRole('button', { name: '听书设置' })
    fireEvent.pointerDown(gear, { pointerId: 1, clientX: 900, clientY: 400 })
    fireEvent.pointerMove(window, { pointerId: 1, buttons: 1, clientX: 950, clientY: 400 })
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 950, clientY: 400 })
    expect(miniBarStore.get().cx).toBeNull()
  })

  it('点身份钮收起', async () => {
    await renderExpanded()
    fireEvent.click(screen.getByRole('button', { name: /收起迷你条/ }))
    expect(miniBarStore.get().collapsed).toBe(true)
  })

  it('窗口外松手（没有 pointerup）：buttons=0 的那次移动当场收场，之后悬停不再拖动', async () => {
    await renderExpanded()
    const handle = screen.getByRole('button', { name: /收起迷你条/ })
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 900, clientY: 400 })
    fireEvent.pointerMove(window, { pointerId: 1, buttons: 1, clientX: 940, clientY: 400 })
    expect(miniBarStore.get().cx, '拖动帧已跟手').not.toBeNull()

    // 指针在窗口外松开：浏览器不再投递 pointerup，下一次移动带 buttons=0 —— 收场并落盘
    fireEvent.pointerMove(window, { pointerId: 1, buttons: 0, clientX: 960, clientY: 430 })
    const settled = miniBarStore.get()
    // 收场后没有新的按下，再悬停也不许挪块（否则就是「幽灵拖动」）
    fireEvent.pointerMove(window, { pointerId: 1, buttons: 0, clientX: 700, clientY: 300 })
    expect(miniBarStore.get()).toMatchObject({ cx: settled.cx, cy: settled.cy })
  })

  async function renderCapsule(): Promise<HTMLElement> {
    const bar = await renderExpanded()
    await act(async () => { setMiniBarCollapsed(true) })
    return bar
  }

  it('胶囊 208×44：只给身份与段号，不再显示当前句', async () => {
    await renderCapsule()
    expect(document.querySelector('.novel-tts-mini-capsule')).not.toBeNull()
    expect(document.querySelector('.novel-tts-mini-line')).toBeNull()
    expect(document.querySelector('.novel-tts-mini-cap-line')).not.toBeNull()
    expect(screen.getByText('书一')).not.toBeNull()
    expect(screen.getByText('2/3')).not.toBeNull()
  })

  it('胶囊：环不是拖面，身份钮是；位移 7px 不动、9px 才动', async () => {
    await renderCapsule()
    const ring = screen.getByRole('button', { name: '暂停' })
    const id = screen.getByRole('button', { name: /展开迷你条/ })
    fireEvent.pointerDown(ring, { pointerId: 1, clientX: 900, clientY: 400 })
    fireEvent.pointerMove(window, { pointerId: 1, buttons: 1, clientX: 950, clientY: 400 })
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 950, clientY: 400 })
    expect(miniBarStore.get().cx).toBeNull()

    fireEvent.pointerDown(id, { pointerId: 1, clientX: 900, clientY: 400 })
    fireEvent.pointerMove(window, { pointerId: 1, buttons: 1, clientX: 907, clientY: 400 })
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 907, clientY: 400 })
    expect(miniBarStore.get().cx).toBeNull()

    fireEvent.pointerDown(id, { pointerId: 1, clientX: 900, clientY: 400 })
    fireEvent.pointerMove(window, { pointerId: 1, buttons: 1, clientX: 909, clientY: 400 })
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 909, clientY: 400 })
    expect(miniBarStore.get().cx).not.toBeNull()
  })

  describe('拖边调尺寸', () => {
    const KEY = 'dsh-novel.tts-mini'
    const free = async (): Promise<HTMLElement> => {
      const bar = await renderExpanded()
      await act(async () => {
        miniBarStore.set({ cx: 500, cy: 400, w: 320, h: 200, collapsed: false })
      })
      return bar
    }

    it('展开态有三条边 + 右下角，收起态没有', async () => {
      await renderExpanded()
      expect(document.querySelectorAll('.novel-tts-mini-edge')).toHaveLength(4)
      cleanup()
      await renderCapsule()
      expect(document.querySelectorAll('.novel-tts-mini-edge')).toHaveLength(0)
    })

    it('拖右边 40px：宽 +40，左缘不动，松手落盘', async () => {
      // 清落盘现场：走 `ls` 那道 guard，不碰裸 `localStorage` 全局（本仓的 JS 宿主与测试环境里它都可能缺席）
      ls.setItem(KEY, '{}')
      await free()
      fireEvent.pointerDown(must(document.querySelector('[data-edge="right"]'), '右边带'), {
        pointerId: 1, clientX: 900, clientY: 400,
      })
      fireEvent.pointerMove(window, { pointerId: 1, buttons: 1, clientX: 940, clientY: 400 })
      fireEvent.pointerUp(window, { pointerId: 1, clientX: 940, clientY: 400 })
      expect(miniBarStore.get().w).toBe(360)
      expect(must(miniBarStore.get().cx, '中心') - 180).toBeCloseTo(340, 5)
      const saved = JSON.parse(ls.getItem(KEY) ?? '{}') as { w?: number }
      expect(saved.w).toBe(360)
    })

    it('拖动帧不落盘；pointercancel 落的是最后一帧', async () => {
      // 清落盘现场：走 `ls` 那道 guard，不碰裸 `localStorage` 全局（本仓的 JS 宿主与测试环境里它都可能缺席）
      ls.setItem(KEY, '{}')
      await free()
      const edge = must(document.querySelector('[data-edge="right"]'), '右边带')
      fireEvent.pointerDown(edge, { pointerId: 1, clientX: 900, clientY: 400 })
      fireEvent.pointerMove(window, { pointerId: 1, buttons: 1, clientX: 940, clientY: 400 })
      const mid = JSON.parse(ls.getItem(KEY) ?? '{}') as { w?: number | null }
      expect(mid.w ?? null, '拖动帧不落盘').toBeNull()
      fireEvent.pointerMove(window, { pointerId: 1, buttons: 1, clientX: 960, clientY: 400 })
      fireEvent.pointerCancel(window, { pointerId: 1 })
      const saved = JSON.parse(ls.getItem(KEY) ?? '{}') as { w?: number }
      expect(saved.w).toBe(380)
    })

    it('拖过量：夹到 520 / 420 上限与 260 / 162 下限', async () => {
      await free()
      const right = must(document.querySelector('[data-edge="right"]'), '右边带')
      fireEvent.pointerDown(right, { pointerId: 1, clientX: 900, clientY: 400 })
      fireEvent.pointerMove(window, { pointerId: 1, buttons: 1, clientX: 2000, clientY: 400 })
      fireEvent.pointerUp(window, { pointerId: 1, clientX: 2000, clientY: 400 })
      expect(miniBarStore.get().w).toBe(520)

      const bottom = must(document.querySelector('[data-edge="bottom"]'), '下边带')
      fireEvent.pointerDown(bottom, { pointerId: 2, clientX: 900, clientY: 400 })
      fireEvent.pointerMove(window, { pointerId: 2, buttons: 1, clientX: 900, clientY: -2000 })
      fireEvent.pointerUp(window, { pointerId: 2, clientX: 900, clientY: -2000 })
      expect(miniBarStore.get().h).toBe(162)
    })

    it('窄视口下拖下边：被夹的宽度只影响呈现，不改写宽度意图', async () => {
      const prev = window.innerWidth
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 500 })
      try {
        await renderExpanded()
        await act(async () => {
          miniBarStore.set({ cx: null, cy: null, w: 520, h: 280, collapsed: false })
        })
        const bottom = must(document.querySelector('[data-edge="bottom"]'), '下边带')
        fireEvent.pointerDown(bottom, { pointerId: 1, clientX: 400, clientY: 400 })
        fireEvent.pointerMove(window, { pointerId: 1, buttons: 1, clientX: 400, clientY: 420 })
        fireEvent.pointerUp(window, { pointerId: 1, clientX: 400, clientY: 420 })
        expect(miniBarStore.get().w, '宽度意图仍是 520（呈现时夹到 484）').toBe(520)
        expect(miniBarStore.get().h).toBe(300)
      } finally {
        Object.defineProperty(window, 'innerWidth', { configurable: true, value: prev })
      }
    })

    it('松手不做近边吸附：拖完停在原处（不吸回旧落位）', async () => {
      await free()
      const right = must(document.querySelector('[data-edge="right"]'), '右边带')
      fireEvent.pointerDown(right, { pointerId: 1, clientX: 900, clientY: 400 })
      fireEvent.pointerMove(window, { pointerId: 1, buttons: 1, clientX: 902, clientY: 400 })
      fireEvent.pointerUp(window, { pointerId: 1, clientX: 902, clientY: 400 })
      // 左缘锚在 340：宽 322 → 中心 501；吸附会把它拉回 484（旧 320 宽的中心）或整块贴边
      expect(miniBarStore.get().cx).toBeCloseTo(501, 5)
    })
  })

  it('正文截断时才出现「看全文」；点了记重定位现场并切回阅读器', async () => {
    await renderExpanded()
    const body = must(document.querySelector('.novel-tts-mini-body'), '正文区')
    Object.defineProperty(body, 'scrollHeight', { configurable: true, value: 120 })
    Object.defineProperty(body, 'clientHeight', { configurable: true, value: 60 })
    await act(async () => { ttsPlayer.set({ ...ttsPlayer.get(), paragraphText: '换一段，触发重新量高。' }) })
    fireEvent.click(screen.getByRole('button', { name: '看全文' }))
    expect(takeReaderRelocation('s1', 'k1')).not.toBeNull()
    expect(routeStore.get().route.name).toBe('reader')
  })

  it('拖动在浮窗外松手后，下一次点齿轮不被旧拖动吞掉', async () => {
    await renderExpanded()
    const body = must(document.querySelector('.novel-tts-mini-body'), '正文区')
    fireEvent.pointerDown(body, { pointerId: 1, clientX: 900, clientY: 700 })
    fireEvent.pointerMove(window, { pointerId: 1, buttons: 1, clientX: 900, clientY: 760 })
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 900, clientY: 760 })
    const gear = screen.getByRole('button', { name: '听书设置' })
    fireEvent.pointerDown(gear, { pointerId: 2, clientX: 900, clientY: 760 })
    fireEvent.pointerUp(gear, { pointerId: 2, clientX: 900, clientY: 760 })
    fireEvent.click(gear, { detail: 1 })
    expect(screen.queryByRole('dialog', { name: '听书设置' })).not.toBeNull()
  })

  it('正文区可拖不可点：拖动改中心，点击无动作', async () => {
    const bar = await renderExpanded()
    const body = must(bar.querySelector('.novel-tts-mini-body'), '正文区')
    fireEvent.pointerDown(body, { pointerId: 1, clientX: 900, clientY: 700 })
    fireEvent.pointerMove(window, { pointerId: 1, buttons: 1, clientX: 900, clientY: 760 })
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 900, clientY: 760 })
    expect(miniBarStore.get().cy).not.toBeNull()
    await act(async () => { fireEvent.click(body) })
    expect(miniBarStore.get().collapsed).toBe(false)
  })

  it('运输行五颗：动作钮 32、停止是 quiet、没有语速 / 定时 chip', async () => {
    await renderExpanded()
    const acts = must(document.querySelector('.novel-tts-mini-acts'), '运输行')
    const buttons = [...acts.querySelectorAll('button')]
    expect(buttons.map((b) => b.getAttribute('aria-label')))
      .toEqual(['回阅读器', '上一段', '暂停', '下一段', '停止听书'])
    for (const b of buttons) {
      expect(b.classList.contains('novel-tts-ictl') || b.classList.contains('novel-tts-ringplay')).toBe(true)
    }
    expect(screen.getByRole('button', { name: '停止听书' }).classList.contains('quiet')).toBe(true)
  })

  it('底行读数：1x 不显语速，1.25x 显示；任何地方没有 m:ss', async () => {
    await renderExpanded()
    expect(screen.queryByText('1x')).toBeNull()
    await act(async () => { setListenRate(1.25) })
    expect(screen.getByText('1.25x')).not.toBeNull()
    expect(screen.queryByText(/^\d+:\d{2}$/)).toBeNull()
  })

  it('空章：正文区显示空章读数，进度条不渲染', async () => {
    await renderExpanded({ paragraphCount: 0, paragraphText: '' })
    expect(screen.getByText('本章没有可朗读的段落')).not.toBeNull()
    expect(document.querySelector('.novel-tts-mini-chapseek')).toBeNull()
  })

  it('直出型：底行不出现时间读数，进度条 aria-valuetext 是段读数', async () => {
    await renderExpanded()
    ttsProgress.set({ position: 0, duration: 0 })
    expect(document.querySelector('.novel-tts-mini-chapseek-range')?.getAttribute('aria-valuetext'))
      .toBe('第 2 / 3 段')
  })

  it('拖顶行身份钮两轴跟手、松手远处原地落位（不吸边）', async () => {
    const bar = await listening()
    const handle = screen.getByRole('button', { name: /收起迷你条/ })
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 900, clientY: 800 })
    expect(bar.getAttribute('data-dragging')).toBe('true')
    fireEvent.pointerMove(bar, { pointerId: 1, buttons: 1, clientX: 500, clientY: 770 })
    fireEvent.pointerUp(bar, { pointerId: 1, clientX: 500, clientY: 770 })
    // dx -400、dy -30：中心 (864,384) → (464,354)；四边 gap 均 > 24 → 原地
    expect(miniBarStore.get()).toMatchObject({ cx: 464, cy: 354, collapsed: false })
    expect(bar.getAttribute('data-dragging')).toBe('false')
    expect(bar.style.left).toBe('464px')
    expect(bar.style.top).toBe('354px')
    const saved = JSON.parse(must(ls.getItem('dsh-novel.tts-mini'), '落盘的迷你条现场')) as Record<string, unknown>
    expect(saved).toMatchObject({ cx: 464, cy: 354 })
  })

  it('近边松手贴齐右缘（gap 14 ≤ 24 吸附）', async () => {
    const bar = await listening()
    fireEvent.pointerDown(screen.getByRole('button', { name: /收起迷你条/ }), {
      pointerId: 1, clientX: 900, clientY: 800,
    })
    fireEvent.pointerMove(bar, { pointerId: 1, buttons: 1, clientX: 886, clientY: 800 })
    fireEvent.pointerUp(bar, { pointerId: 1, clientX: 886 })
    expect(miniBarStore.get()).toMatchObject({ cx: 864, cy: 384 })   // 贴右缘
    expect(bar.getAttribute('data-side')).toBe('right')
  })

  it('胶囊拖到左下角：两轴独立吸附（左 + 底），拖过不算点', async () => {
    setMiniBarCollapsed(true)
    const bar = await listening()
    setMiniBarCenter(104, 384, CAPSULE_SIZE, { width: 1024, height: 768 })  // 起点：胶囊贴左缘
    fireEvent.pointerDown(screen.getByRole('button', { name: /展开迷你条/ }), {
      pointerId: 1, clientX: 200, clientY: 400,
    })
    fireEvent.pointerMove(bar, { pointerId: 1, buttons: 1, clientX: 200, clientY: 746 })  // dx 0、dy +346 → cy 730（底 gap 10）
    fireEvent.pointerUp(bar, { pointerId: 1, clientX: 200, clientY: 746 })
    // 两轴 gap ≤ 24 → 左贴齐（104 = 208/2）+ 底贴齐（746 = 768-22）；拖过不算点
    expect(miniBarStore.get()).toMatchObject({ cx: 104, cy: 746, collapsed: true })
    expect(bar.getAttribute('data-side')).toBe('left')
    // 真机在 pointerup 后会补发一次 click（detail > 0）：被胶囊的捕获层吞掉，不是一次展开
    fireEvent.click(screen.getByRole('button', { name: /展开迷你条/ }), { detail: 1 })
    expect(miniBarStore.get().collapsed).toBe(true)
  })

  it('拖动后被吞掉的补发 click 落地清零：随后键盘激活能展开（不再被拖动历史挡住）', async () => {
    setMiniBarCollapsed(true)
    const bar = await listening()
    const expand = screen.getByRole('button', { name: /展开迷你条/ })
    // 指针拖动（同一颗展开钮起手）：松手后浏览器补发的那一次 click 带 detail > 0
    fireEvent.pointerDown(expand, { pointerId: 1, clientX: 900, clientY: 400 })
    fireEvent.pointerMove(bar, { pointerId: 1, buttons: 1, clientX: 700, clientY: 400 })
    fireEvent.pointerUp(bar, { pointerId: 1, clientX: 700, clientY: 400 })
    fireEvent.click(expand, { detail: 1 })
    expect(miniBarStore.get().collapsed, '补发 click 不是点击：不展开').toBe(true)
    expect(ttsPlayer.get().playing, '补发 click 也不动播放层').toBe(true)
    // 键盘激活（Enter / Space 合成的 click，detail 为 0）不是补发 click：必须能展开
    expand.focus()
    fireEvent.keyDown(expand, { key: 'Enter' })
    fireEvent.click(expand, { detail: 0 })
    expect(miniBarStore.get().collapsed, '键盘用户拖过之后仍要打得开边栏').toBe(false)
  })

  it('边栏高度随内容变化（120↔140）后重新夹回屏内：不溢出也不留缝', async () => {
    class FakeResizeObserver {
      static fire: (() => void) | null = null
      constructor(cb: ResizeObserverCallback) {
        FakeResizeObserver.fire = () => { cb([], this) }
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    try {
      expect(typeof globalThis.ResizeObserver, 'stub 已装到 globalThis').toBe('function')
      const bar = await listening()
      expect(FakeResizeObserver.fire, '组件装了 ResizeObserver').not.toBeNull()
      const rect = (height: number) => (): DOMRect => ({
        width: 280, height, top: 0, left: 0, right: 280, bottom: height, x: 0, y: 0,
        toJSON: () => ({}),
      })
      // 先从较矮的现场量起（120 只验重夹逻辑）：贴底松手后中心 708（底 gap 0）
      bar.getBoundingClientRect = rect(120)
      fireEvent.pointerDown(screen.getByRole('button', { name: /收起迷你条/ }), {
        pointerId: 1, clientX: 900, clientY: 800,
      })
      fireEvent.pointerMove(bar, { pointerId: 1, buttons: 1, clientX: 900, clientY: 1400 })
      fireEvent.pointerUp(bar, { pointerId: 1, clientX: 900, clientY: 1400 })
      expect(miniBarStore.get().cy, '矮边栏贴底').toBe(708)
      // 当前句与章内进度条都在的常态边栏是 140：不重夹就会超视口 10px
      bar.getBoundingClientRect = rect(140)
      act(() => { FakeResizeObserver.fire?.() })
      expect(miniBarStore.get().cy, '按新高度夹回屏内').toBe(698)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('只落过纵向（旧现场迁回 / 未拖横向）时仍贴右缘：行内 style 给解析后的右缘像素', async () => {
    miniBarStore.set({ cx: null, cy: 500, w: null, h: null, collapsed: false })
    const bar = await listening()
    // 缺省横向解析成右缘中心（视口宽减半宽），translate 把中心对到它：右缘仍贴视口右缘
    expect(bar.style.transform, '中心定位的 X 位移不能省').toBe('translate(-50%,-50%)')
    expect(bar.style.left).toBe(`${window.innerWidth - DEFAULT_MINI_BAR_SIZE.width / 2}px`)
    expect(bar.style.top).toBe('500px')
  })

  it('缺省落位由布局读数给全：行内 style 右缘居中，样式层不再定义定位', async () => {
    const bar = await listening()
    expect(bar.style.transform).toBe('translate(-50%,-50%)')
    expect(bar.style.left).toBe(`${window.innerWidth - DEFAULT_MINI_BAR_SIZE.width / 2}px`)
    expect(bar.style.top).toBe(`${window.innerHeight / 2}px`)
    // 缺省定位一旦回到 CSS，缺省轴判据就有了第二个家（读数与样式各写一份，换视口时必漂）
    const css = NOVEL_CSS.replace(/\/\*[\s\S]*?\*\//g, '')
    const dockRule = /\.novel-tts-mini-dock\s*\{([^}]*)\}/.exec(css)
    expect(dockRule, '样式层该留着 .novel-tts-mini-dock 规则').not.toBeNull()
    expect(dockRule?.[1] ?? '', 'dock 规则体不许带定位属性').not.toMatch(/\b(top|right|left|transform):/)
    expect(css, 'data-side 只剩弹层开向的消费，不再是定位规则的选择器')
      .not.toMatch(/\.novel-tts-mini-dock\[data-side='[a-z]+'\]\s*\{/)
  })

  it('按下没移动够不算拖：位置不动（同一次指针序列里点与拖互斥）', async () => {
    const bar = await listening()
    fireEvent.pointerDown(screen.getByRole('button', { name: /收起迷你条/ }), {
      pointerId: 1, clientX: 900, clientY: 800,
    })
    fireEvent.pointerMove(bar, { pointerId: 1, buttons: 1, clientX: 901, clientY: 801 })
    fireEvent.pointerUp(bar, { pointerId: 1, clientX: 901 })
    expect(miniBarStore.get()).toMatchObject({ cx: null, cy: null })
  })

  it('方向键四向移动、Shift 三档、Home 复位（左右键不再换边）', async () => {
    const bar = await listening()
    const handle = screen.getByRole('button', { name: /收起迷你条/ })
    fireEvent.keyDown(handle, { key: 'ArrowDown' })
    expect(miniBarStore.get()).toMatchObject({ cx: 864, cy: 400 })
    fireEvent.keyDown(handle, { key: 'ArrowLeft', shiftKey: true })
    expect(miniBarStore.get()).toMatchObject({ cx: 816, cy: 400 })
    fireEvent.keyDown(handle, { key: 'ArrowLeft' })
    expect(deriveMiniBarSide(miniBarStore.get(), window.innerWidth)).toBe('right')
    fireEvent.keyDown(handle, { key: 'Home' })
    expect(miniBarStore.get()).toMatchObject({ cx: null, cy: null })
    // 复位即缺省落位：行内 style 直接给解析后的右缘居中，不再退回样式层缺省
    expect(bar.style.left).toBe(`${window.innerWidth - DEFAULT_MINI_BAR_SIZE.width / 2}px`)
    expect(bar.style.top).toBe(`${window.innerHeight / 2}px`)
  })
})

describe('两态浮窗：收起胶囊 / 展开边栏（ADR-0073）', () => {
  async function listening(): Promise<HTMLElement> {
    render(createElement(TtsMiniBar, { focusPanel: vi.fn() }))
    await act(async () => {
      await startListening({ sourceId: 's1', bookKey: 'k1', title: '书一', chapterIndex: 1, paragraphIndex: 1 })
    })
    return must(document.querySelector<HTMLElement>('[data-novel-tts-mini]'), '迷你条')
  }

  /** 贴边形态跟着「真的贴上」走，不跟呈现方向走（ADR-0073 放开自由落位后的分工）：
   *  块悬在屏内时 dock 必须报 data-flush='none'，样式层才会在四条边上都画描边。 */
  it('data-flush：缺省贴右、吸附贴左、自由落位为 none（side 不能代答）', async () => {
    const bar = await listening()
    const view = { width: window.innerWidth, height: window.innerHeight }
    expect(bar.getAttribute('data-flush')).toBe('right')
    // 现场是模块级 store：直接推进去要过 act，否则订阅它的组件不会在这一行里重渲
    await act(async () => { setMiniBarCenter(864, 384, DEFAULT_MINI_BAR_SIZE, view) })
    expect(bar.getAttribute('data-flush')).toBe('right')
    await act(async () => { setMiniBarCenter(140, 384, DEFAULT_MINI_BAR_SIZE, view) })
    expect(bar.getAttribute('data-flush')).toBe('left')
    // 中心仍在右半屏的自由落位：side 说 right，flush 说 none——按 side 收边框就是给悬空的边留敞口
    await act(async () => { setMiniBarCenter(600, 384, DEFAULT_MINI_BAR_SIZE, view) })
    expect(deriveMiniBarSide(miniBarStore.get(), view.width)).toBe('right')
    expect(bar.getAttribute('data-flush')).toBe('none')
  })

  it('缺省收起为完整身份条：环 / 书名 / 段号 / 进度细线；点一下展开', async () => {
    setMiniBarCollapsed(true)
    const bar = await listening()
    const capsule = must(bar.querySelector('.novel-tts-mini-capsule'), '收起胶囊')
    expect(bar.getAttribute('data-novel-tts-mini-collapsed')).toBe('true')
    expect(capsule.querySelector('.novel-tts-ringplay')).not.toBeNull()
    expect(capsule.querySelector('.novel-tts-mini-title')?.textContent).toBe('书一')
    expect(capsule.querySelector('.novel-tts-mini-badge')?.textContent).toBe('2/3')
    expect(capsule.querySelector('.novel-tts-mini-cap-line')).not.toBeNull()
    // 收起态不给半截句子（ADR-0079），也不再渲染封面位
    expect(capsule.querySelector('.novel-tts-mini-line')).toBeNull()
    expect(capsule.querySelector('.novel-tts-mini-cover')).toBeNull()
    expect(screen.queryByRole('button', { name: '下一段' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /展开迷你条/ }))
    expect(miniBarStore.get().collapsed).toBe(false)
    expect(document.querySelector('.novel-tts-mini-panel')).not.toBeNull()
  })

  it('胶囊上的环钮只切播放，不展开（点击与拖动、播放与展开各归各）', async () => {
    setMiniBarCollapsed(true)
    await listening()
    fireEvent.click(screen.getByRole('button', { name: '暂停' }))
    expect(ttsPlayer.get().playing).toBe(false)
    expect(miniBarStore.get().collapsed).toBe(true)
  })

  /** 弹层方向是**读数**不是快照：开层那一刻量一次，之后拖头行 / 方向键挪块 / 缩窗口都留着旧方向，
   *  夹取只管浮窗本体，弹层就被视口裁掉半截。 */
  it('设置弹层方向跟着现场走：块挪上挪下，data-flip 当场改口，余量跟着换', async () => {
    const bar = await listening()
    const view = { width: window.innerWidth, height: window.innerHeight }
    const room = (): string => bar.style.getPropertyValue('--novel-tts-popover-room')
    fireEvent.click(screen.getByRole('button', { name: '听书设置' }))
    await act(async () => { setMiniBarCenter(864, 600, DEFAULT_MINI_BAR_SIZE, view) })   // 中下：上方地方够
    expect(bar.getAttribute('data-flip')).toBe('false')
    expect(room(), '上方展开：余量 = 块顶 − 间距 − 视口留白').toBe('486px')
    await act(async () => { setMiniBarCenter(864, 100, DEFAULT_MINI_BAR_SIZE, view) })   // 块顶到上沿：翻到下方
    expect(bar.getAttribute('data-flip')).toBe('true')
    expect(room(), '下方展开：余量 = 视口高 − 块底 − 间距 − 视口留白').toBe('554px')
    await act(async () => { setMiniBarCenter(864, 500, DEFAULT_MINI_BAR_SIZE, view) })   // 回到中下：上方又够了
    expect(bar.getAttribute('data-flip')).toBe('false')
    expect(room(), '回到上方：余量重新按上方算').toBe('386px')
  })

  it('音色行不闪：重开设置时旧清单留着，等新清单回来再替换（失败才清空）', async () => {
    let calls = 0
    vi.mocked(apiGet).mockImplementation(async (path: string) => {
      if (path.startsWith('navigation')) {
        const chapters = chapterEntries()
        return { chapters, items: planarNavigation(chapters) }
      }
      if (path.startsWith('chapter')) return { kind: 'text', text: textOf(indexOf(path)) } satisfies ChapterContent
      if (path === ROUTES.shelf.path) return shelf
      if (path === ROUTES.ttsSources.path) {
        calls += 1
        if (calls === 1) {
          return {
            sources: [{ id: 'builtin:baidu', kind: 'builtin', voices: [{ id: 'v1', name: '嗓音一' }] }],
            hostSpeech: { state: 'absent' },
          }
        }
        return await new Promise<never>(() => {})   // 重取挂在途中：这一帧必须还拿旧清单顶着
      }
      throw new Error(`unexpected GET ${path}`)
    })
    await listening()
    fireEvent.click(screen.getByRole('button', { name: '听书设置' }))
    await waitFor(() => expect(screen.getByLabelText('音色')).not.toBeNull())
    fireEvent.click(screen.getByRole('button', { name: '听书设置' }))   // 收起
    fireEvent.click(screen.getByRole('button', { name: '听书设置' }))   // 重开：不清空旧清单 → 音色行不消失
    expect(screen.getByLabelText('音色'), '重开时旧清单还在，音色行不闪').not.toBeNull()
  })

  it('设置面板与阅读器条对齐：语速 / 定时 / 起播章在浮窗上也能调', async () => {
    await listening()
    fireEvent.click(screen.getByRole('button', { name: '听书设置' }))
    const rate = screen.getByLabelText('语速')
    await act(async () => { fireEvent.change(rate, { target: { value: '1.5' } }) })
    expect(ttsPlayer.get().rate).toBe(1.5)
    fireEvent.click(screen.getByRole('button', { name: '30 分' }))
    expect(ttsPlayer.get().timerChoice).toBe(30)
    const start = screen.getByLabelText('起播章')
    expect([...start.querySelectorAll('option')].map((o) => o.textContent))
      .toEqual(['第 1 章 第一章', '第 2 章 第二章', '第 3 章 第三章'])
    await act(async () => { fireEvent.change(start, { target: { value: '2' } }) })
    expect(ttsPlayer.get()).toMatchObject({ chapterIndex: 2, paragraphIndex: 0 })
  })

  it('浮窗设置里有尺寸三档与复位，只投影给浮窗', async () => {
    await listening()
    fireEvent.click(screen.getByRole('button', { name: '听书设置' }))
    expect(screen.getByText('浮窗大小')).not.toBeNull()
    expect(screen.getByRole('button', { name: '小' })).not.toBeNull()
    expect(screen.getByRole('button', { name: '中' }).classList.contains('on')).toBe(true)
    // 三档是开关型 chip：按下态既要有视觉（on 类）也要有 aria-pressed
    expect(screen.getByRole('button', { name: '中' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: '小' }).getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByRole('button', { name: '大' })).not.toBeNull()
    expect(screen.getByRole('button', { name: '复位大小' })).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '大' }))
    expect(miniBarStore.get()).toMatchObject({ w: 380, h: 280 })
    expect(screen.getByRole('button', { name: '大' }).classList.contains('on')).toBe(true)
    expect(screen.getByRole('button', { name: '大' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: '复位大小' }))
    expect(miniBarStore.get()).toMatchObject({ w: null, h: null })
    expect(screen.getByRole('button', { name: '中' }).classList.contains('on')).toBe(true)
  })

  it('定时 chip 都是 type=button 且按下态有 aria-pressed（与尺寸档同一套判据）', async () => {
    await listening()
    fireEvent.click(screen.getByRole('button', { name: '听书设置' }))
    const off = screen.getByRole('button', { name: '关闭' })
    expect(off.getAttribute('type')).toBe('button')
    expect(off.getAttribute('aria-pressed')).toBe('true')
    const thirty = screen.getByRole('button', { name: '30 分' })
    expect(thirty.getAttribute('type')).toBe('button')
    fireEvent.click(thirty)
    expect(ttsPlayer.get().timerChoice).toBe(30)
    expect(thirty.getAttribute('aria-pressed')).toBe('true')
    expect(off.getAttribute('aria-pressed')).toBe('false')
  })

  it('设置弹层翻转吃内容实测高：矮卡上方装得下就不翻（固定档会误翻）', async () => {
    const bar = await listening()
    const view = { width: window.innerWidth, height: window.innerHeight }
    const descriptor = must(
      Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight'), 'scrollHeight 访问器',
    )
    // jsdom 不做布局：给设置卡造一个 120 的内容实测高（回退常量是 320），两者翻转方向相反
    Object.defineProperty(Element.prototype, 'scrollHeight', {
      configurable: true,
      get(this: Element): number { return this.classList.contains('novel-tts-panel') ? 120 : 0 },
    })
    try {
      await act(async () => { setMiniBarCenter(864, 300, DEFAULT_MINI_BAR_SIZE, view) })
      fireEvent.click(screen.getByRole('button', { name: '听书设置' }))
      // 中心 300 − 半高 100 = 顶 200；扣 6px 间距后上方余量 194 ≥ 120 → 不翻
      await waitFor(() => expect(bar.getAttribute('data-flip')).toBe('false'))
    } finally {
      Object.defineProperty(Element.prototype, 'scrollHeight', descriptor)
    }
  })

  it('连败到阈值且暂停：边栏给 role=status 一行，胶囊用 title / data-failed 给同一读数', async () => {
    const bar = await listening()
    await act(async () => {
      // 停因是播放层公布的成品事实：表面只读 `halt`，不拿计数器与阈值对比
      ttsPlayer.set({
        ...ttsPlayer.get(), playing: false, consecutiveFailures: TTS_MAX_CONSECUTIVE_FAILURES,
        halt: { reason: 'consecutive-failures', failures: TTS_MAX_CONSECUTIVE_FAILURES },
      })
    })
    const status = screen.getByRole('status')
    expect(status.textContent).toContain('连续 5 段播放失败，已暂停')
    expect(bar.getAttribute('data-failed')).toBe('true')

    // 收起：提示行随边栏退场，但同一读数仍由 title / data-failed 给出
    await act(async () => { setMiniBarCollapsed(true) })
    const capsule = must(bar.querySelector<HTMLElement>('.novel-tts-mini-capsule'), '收起胶囊')
    expect(capsule.getAttribute('title')).toContain('连续 5 段播放失败')
    expect(bar.getAttribute('data-failed')).toBe('true')

    // 真开口（计数清零 + 在放）后提示自然消失
    await act(async () => {
      ttsPlayer.set({ ...ttsPlayer.get(), playing: true, consecutiveFailures: 0, halt: null })
    })
    expect(bar.getAttribute('data-failed')).toBe('false')
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('引擎切换失败：受控下拉写回实际生效值，不显示没生效的选择', async () => {
    act(() => {
      ttsPlayer.set({
        ...ttsPlayer.get(), active: true, bookKey: 'k1', sourceId: 's1', title: '书一',
        chapterIndex: 0, chapterNames: ['第一章'], paragraphCount: 3, paragraphIndex: 0,
        engineId: TTS_DEFAULTS.engineId, mode: 'bytes',
      })
    })
    render(createElement(TtsSettingsRows, {
      sources: [
        { id: TTS_DEFAULTS.engineId, kind: 'builtin' },
        { id: BROWSER_TTS_ENGINE_ID, kind: 'browser' },
      ],
      surface: 'bar',
    }))
    const select = must(screen.getByLabelText<HTMLSelectElement>('引擎'), '引擎下拉')
    expect(select.value).toBe(TTS_DEFAULTS.engineId)
    // jsdom 没有 speechSynthesis：换直出源等不到语音表 → TTS_NO_VOICES，选择不生效
    fireEvent.change(select, { target: { value: BROWSER_TTS_ENGINE_ID } })
    await waitFor(() => expect(select.value, '失败后写回实际引擎').toBe(TTS_DEFAULTS.engineId))
    expect(ttsPlayer.get().engineId).toBe(TTS_DEFAULTS.engineId)
  })

  it('起播章切换失败：受控下拉写回实际章号', async () => {
    await act(async () => {
      await startListening({ sourceId: 's1', bookKey: 'k1', title: '书一', chapterIndex: 0, paragraphIndex: 0 })
    })
    render(createElement(TtsSettingsRows, { sources: null, surface: 'bar' }))
    const select = must(screen.getByLabelText<HTMLSelectElement>('起播章'), '起播章下拉')
    expect([...select.options].map((option) => option.value)).toContain('2')
    // 下一章的正文读取直接失败：跳章 reject，界面不许停在那颗没生效的选项上
    vi.mocked(apiGet).mockImplementationOnce(async () => { throw new Error('章节取不到') })
    fireEvent.change(select, { target: { value: '2' } })
    await waitFor(() => expect(select.value, '失败后写回实际章号').toBe(String(ttsPlayer.get().chapterIndex)))
    expect(ttsPlayer.get().chapterIndex).toBe(0)
  })

  it('设置钮是开关：再点一次收起弹层，浮窗本体不收（与阅读器条同一判据）', async () => {
    await listening()
    const gear = screen.getByRole('button', { name: '听书设置' })
    fireEvent.click(gear)
    expect(screen.queryByRole('dialog', { name: '听书设置' })).not.toBeNull()
    expect(gear.getAttribute('aria-expanded')).toBe('true')
    // 再点：只收弹层——边栏还在场，不能把整块浮窗一起收掉
    fireEvent.click(gear)
    expect(screen.queryByRole('dialog', { name: '听书设置' })).toBeNull()
    expect(gear.getAttribute('aria-expanded')).toBe('false')
    expect(miniBarStore.get().collapsed).toBe(false)
    expect(document.querySelector('.novel-tts-mini-panel')).not.toBeNull()
    // 三开三关不粘滞
    fireEvent.click(gear)
    expect(screen.queryByRole('dialog', { name: '听书设置' })).not.toBeNull()
    fireEvent.click(gear)
    expect(screen.queryByRole('dialog', { name: '听书设置' })).toBeNull()
  })

  it('设置卡入场焦点落在中性关闭钮：定时在走时 Enter 不会静默取消定时', async () => {
    await listening()
    act(() => { setListenTimer(30) })
    const gear = screen.getByRole('button', { name: '听书设置' })
    // jsdom 的 click 不聚焦：先显式建立「触发件已持焦」的现场，还焦断言才验得到契约
    gear.focus()
    fireEvent.click(gear)
    const close = screen.getByRole('button', { name: '关闭听书设置' })
    expect(document.activeElement, '入场焦点该落在中性关闭钮，不落在定时档「关闭」chip 上').toBe(close)
    // 可见出口：点它只收面板；定时与会话都不动（第一颗钮若是定时档 chip，这一次 Enter 会取消定时）
    fireEvent.click(close)
    expect(screen.queryByRole('dialog', { name: '听书设置' })).toBeNull()
    expect(ttsPlayer.get().timerChoice, '关闭设置卡不该取消定时').toBe(30)
    expect(gear.getAttribute('aria-expanded')).toBe('false')
    // Esc 与关后还焦照旧：再开一次，Esc 只收卡片，焦点回到触发它的齿轮
    fireEvent.click(gear)
    expect(screen.queryByRole('dialog', { name: '听书设置' })).not.toBeNull()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: '听书设置' })).toBeNull()
    expect(document.activeElement, '关后还焦到触发件').toBe(gear)
  })

  it('引擎现值不在清单时按 kind 取显示名，不把裸 id 上屏', async () => {
    await listening()
    fireEvent.click(screen.getByRole('button', { name: '听书设置' }))
    const select = screen.getByLabelText('引擎')
    // 缺省引擎是内置源（清单在这一档还没到 / 不在清单）：显示名取词，选中值仍是 wire 的身份串
    expect([...select.querySelectorAll('option')].map((option) => option.textContent)).toEqual(['内置朗读'])
    expect(must(select, '引擎下拉').querySelector('option')?.getAttribute('value')).toBe(TTS_DEFAULTS.engineId)
  })

  it('弹层开着按 Esc：只收弹层，浮窗不收；再按一次才收起胶囊', async () => {
    await listening()
    fireEvent.click(screen.getByRole('button', { name: '听书设置' }))
    expect(screen.queryByRole('dialog', { name: '听书设置' })).not.toBeNull()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: '听书设置' })).toBeNull()
    expect(miniBarStore.get().collapsed).toBe(false)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(miniBarStore.get().collapsed).toBe(true)
  })

  it('停止与收起物理分离：停止在运输行，收起在头行', async () => {
    const bar = await listening()
    const stop = screen.getByRole('button', { name: '停止听书' })
    const collapse = screen.getByRole('button', { name: /收起迷你条/ })
    expect(bar.querySelector('.novel-tts-mini-head')?.contains(stop)).toBe(false)
    expect(bar.querySelector('.novel-tts-mini-acts')?.contains(stop)).toBe(true)
    expect(bar.querySelector('.novel-tts-mini-head')?.contains(collapse)).toBe(true)
    expect(bar.querySelector('.novel-tts-mini-acts')?.contains(collapse)).toBe(false)
  })

  it('快捷键（无阅读器子树时）：Space 播放/暂停、Shift+方向键跳段、Esc 收起', async () => {
    await listening()
    fireEvent.keyDown(window, { key: ' ' })
    expect(ttsPlayer.get().playing).toBe(false)
    fireEvent.keyDown(window, { key: ' ' })
    expect(ttsPlayer.get().playing).toBe(true)
    // 跳段在途（loading）不接下一跳：每跳之间让 play() 的微任务落地
    await act(async () => { fireEvent.keyDown(window, { key: 'ArrowRight', shiftKey: true }) })
    expect(ttsPlayer.get().paragraphIndex).toBe(2)
    await act(async () => { fireEvent.keyDown(window, { key: 'ArrowLeft', shiftKey: true }) })
    expect(ttsPlayer.get().paragraphIndex).toBe(1)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(miniBarStore.get().collapsed).toBe(true)
  })

  it('loading 中按 Space 会暂停（判据与浮窗播放钮同一条：在放 ∨ 起播在途）', async () => {
    await listening()
    expect(ttsPlayer.get()).toMatchObject({ playing: true, loading: false })
    // 跳章并让章正文读取悬着：`moveChapter` 先把 loading 置真、playing 置假——这正是
    // 「屏幕上的环按得停、Space 却按不动」的那一档（resume 被 loading 挡回，等于没反应）
    vi.mocked(apiGet).mockImplementationOnce(() => new Promise<never>(() => {}))
    await act(async () => { void skipChapter(1) })
    expect(ttsPlayer.get(), '章正文在途：loading 真、playing 假').toMatchObject({ loading: true, playing: false })
    fireEvent.keyDown(window, { key: ' ' })
    expect(ttsPlayer.get(), 'Space 该消费这一次暂停').toMatchObject({ loading: false, playing: false })
  })

  it('输入框里不抢键：Space 落在 textarea 上不动播放层', async () => {
    await listening()
    const input = document.createElement('textarea')
    document.body.appendChild(input)
    input.focus()
    fireEvent.keyDown(input, { key: ' ' })
    expect(ttsPlayer.get().playing).toBe(true)
    input.remove()
  })

  it('Space 归手上那颗控件：焦点在浮窗按钮上不劫持播放', async () => {
    const bar = await listening()
    const stop = screen.getByRole('button', { name: '停止听书' })
    stop.focus()
    fireEvent.keyDown(stop, { key: ' ' })
    expect(ttsPlayer.get().playing, '快捷键没把焦点按钮的 Space 抢成播放/暂停').toBe(true)
    expect(ttsPlayer.get().active, 'Space 也不该顺手停掉会话').toBe(true)

    // 胶囊收起后，展开钮上的 Space 同样归那颗钮：jsdom 不合成原生激活，这里钉的是「快捷键不出手」，
    // 真机的展开由按钮自己的 Space 完成（点一下同一条路，见下面的 click）。
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(miniBarStore.get().collapsed).toBe(true)
    const expand = screen.getByRole('button', { name: /展开迷你条/ })
    expand.focus()
    fireEvent.keyDown(expand, { key: ' ' })
    expect(miniBarStore.get().collapsed, '快捷键不替这颗钮展开').toBe(true)
    expect(ttsPlayer.get().playing, '也不落全局播放/暂停').toBe(true)
    fireEvent.click(expand)
    expect(miniBarStore.get().collapsed).toBe(false)
    expect(bar.isConnected).toBe(true)
  })

  it('胶囊是两颗并列按钮的容器：不再按钮套按钮', async () => {
    setMiniBarCollapsed(true)
    const bar = await listening()
    const capsule = must(bar.querySelector('.novel-tts-mini-capsule'), '收起胶囊')
    // 容器自己不是控件：没有 role、不进 Tab 序，控件是里面那两颗真按钮
    expect(capsule.getAttribute('role')).toBeNull()
    expect(capsule.getAttribute('tabindex'), '容器不进 Tab 序：可聚焦的是里面那两颗钮').toBeNull()
    const names = [...capsule.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'))
    expect(names[0]).toBe('暂停')
    // 展开钮的可访问名带书目与段号：读屏用户不只会听到「展开」，还知道展开的是哪一本、念到哪
    expect(names[1]).toContain('展开迷你条')
    expect(names[1]).toContain('书一')
    expect(names[1]).toContain('第 2 / 3 段')
  })

  it('直出型：环退化为静态轨道，章内进度条仍在（章位置不依赖计时）', async () => {
    const bar = await listening()
    vi.stubGlobal('speechSynthesis', {
      getVoices: () => [{ voiceURI: 'v1', name: '嗓音一' }],
      speak: (u: { onstart?: (() => void) | null }) => { u.onstart?.() },
      cancel: () => {},
    })
    await act(async () => {
      await startListening({
        sourceId: 's1', bookKey: 'k1', title: '书一', chapterIndex: 0, paragraphIndex: 0,
        engineId: 'browser:local',
      })
    })
    expect(bar.querySelector('.novel-tts-ring-val.direct')).not.toBeNull()
    expect(screen.queryByLabelText('本段进度')).toBeNull()
    expect(screen.getByLabelText('章内进度')).not.toBeNull()
  })

  it('没有会话时不劫持全局快捷键：Space / Shift+方向键仍归页面', () => {
    render(createElement(TtsMiniBar, { focusPanel: vi.fn() }))
    const space = new KeyboardEvent('keydown', { key: ' ', cancelable: true, bubbles: true })
    window.dispatchEvent(space)
    expect(space.defaultPrevented).toBe(false)
    const arrow = new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, cancelable: true, bubbles: true })
    window.dispatchEvent(arrow)
    expect(arrow.defaultPrevented).toBe(false)
  })

  it('同场有模态认领键盘层时，Esc 只收模态，不收浮窗', async () => {
    await listening()
    expect(miniBarStore.get().collapsed).toBe(false)
    render(createElement(Dialog, {
      title: '别处的模态', onClose: () => {}, children: createElement('p', null, '内容'),
    }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(miniBarStore.get().collapsed, '一次 Esc 不能顺手把底下那层也收了').toBe(false)
  })

  it('播放环是纯控件：按它不启动拖动，手上那一下仍是播放 / 暂停', async () => {
    const bar = await listening()
    await act(async () => { setMiniBarCollapsed(true) })
    const ring = screen.getByRole('button', { name: '暂停' })
    expect(ttsPlayer.get().playing).toBe(true)
    fireEvent.pointerDown(ring, { pointerId: 1, clientX: 900, clientY: 400 })
    fireEvent.pointerMove(bar, { pointerId: 1, buttons: 1, clientX: 700, clientY: 400 })
    fireEvent.pointerUp(bar, { pointerId: 1, clientX: 700, clientY: 400 })
    expect(miniBarStore.get().cx, '从环起手不拖动浮窗').toBeNull()
    fireEvent.click(ring, { detail: 1 })
    expect(ttsPlayer.get().playing, '这一下就是用户按了播放环').toBe(false)
  })
})

describe('回阅读器：一次性重定位 + 恢复不写进度', () => {
  it('点「回阅读器」→ 记下听书章段并切到阅读器、把面板带到前台', async () => {
    const focusPanel = vi.fn()
    render(createElement(TtsMiniBar, { focusPanel }))
    await act(async () => {
      await startListening({ sourceId: 's1', bookKey: 'k1', title: '书一', chapterIndex: 1, paragraphIndex: 1 })
    })
    fireEvent.click(screen.getByRole('button', { name: '回阅读器' }))
    expect(routeStore.get().route).toEqual({ name: 'reader', sourceId: 's1', bookKey: 'k1', title: '书一' })
    expect(focusPanel).toHaveBeenCalledTimes(1)
    // 现场已被迷你条记下并带上书键（阅读器开书时按书键取走）
    expect(takeReaderRelocation('s1', 'k1')).toEqual({ chapterIndex: 1, offsetRatio: 0.5 })
  })

  it('阅读器以听书章段为恢复目标（不是存档 progress），恢复路径零 progress 写', async () => {
    // 存档读在第 0 章：没有重定位时阅读器会落在第 0 章
    shelf = [shelfEntry({
      totalChapters: 3,
      progress: { chapterIndex: 0, offsetRatio: 0.4, updatedAt: 1 },
      listen: {
        chapterIndex: 1, paragraphIndex: 1, engineId: 'builtin:baidu', voice: null,
        rate: 1, volume: 0.8,
      },
    })]
    const focusPanel = vi.fn()
    render(createElement(TtsMiniBar, { focusPanel }))
    await act(async () => {
      await startListening({ sourceId: 's1', bookKey: 'k1', title: '书一', chapterIndex: 1, paragraphIndex: 1 })
    })
    fireEvent.click(screen.getByRole('button', { name: '回阅读器' }))

    const deps = readerDeps()
    const { container, unmount } = renderReader(deps)
    await waitFor(() => expect(container.querySelector('[data-chapter="1"]')).not.toBeNull())
    expect(container.querySelector('[data-chapter="0"]'), '恢复目标应是听书章，不是存档章').toBeNull()
    // 阅读器的 restore 路径不写进度：这次开书只是站定到听书章，不是一次阅读动作
    // （播放层自己的位置落盘会写 progress，那是另一条节拍，不在此断言其条数）。
    expect(progressBodies(deps.apiSend)).toEqual([])

    // 播放层自己也在写共用 progress（`ADR-0078`）：2s 防抖若在本用例的慢环境里落地，第二次开书
    // 会读到听书位置而不是存档位置——本用例要证的是「重定位现场只消费一次」，先把播放层现场与
    // 面板投影收掉，让第二次开书走「重新取服务端存档」（夹具里仍是第 0 章）。
    act(() => { resetTtsPlayer(); resetPanelShelf() })

    // 现场已消费：同一本书再开一次回到存档 progress（第 0 章）
    unmount()
    const second = renderReader(deps)
    await waitFor(() => expect(second.container.querySelector('[data-chapter="0"]')).not.toBeNull())
    expect(second.container.querySelector('[data-chapter="1"]')).toBeNull()
  })

  it('重定位现场按书键消费一次；段号 → 章内比例两端对齐（段 1/3 → 0.5）', () => {
    ttsPlayer.set({ active: true, chapterIndex: 1, paragraphIndex: 1, paragraphCount: 3 })
    requestReaderRelocation('s1', 'k1', 1, 1)
    // 别的书取不走、也不消费（现场留给它真正的主人）
    expect(takeReaderRelocation('s2', 'k2')).toBeNull()
    expect(takeReaderRelocation('s1', 'k2')).toBeNull()
    expect(takeReaderRelocation('s1', 'k1')).toEqual({ chapterIndex: 1, offsetRatio: 0.5 })
    expect(takeReaderRelocation('s1', 'k1')).toBeNull()
  })

  it('重定位按书键交接：先开别的书走自己的存档进度，原书开书时才消费', async () => {
    // 听书会话在 k1 的第 2 章第 2 段；k1 自己的存档停在第 1 章，k2 的存档停在末章（第 3 章）
    shelf = [
      shelfEntry({ bookKey: 'k1', title: '书一', progress: { chapterIndex: 0, offsetRatio: 0, updatedAt: 1 } }),
      shelfEntry({ bookKey: 'k2', title: '书二', sourceId: 's2', progress: { chapterIndex: 2, offsetRatio: 0, updatedAt: 1 } }),
    ]
    ttsPlayer.set({ active: true, bookKey: 'k1', sourceId: 's1', chapterIndex: 1, paragraphIndex: 1, paragraphCount: 3 })
    requestReaderRelocation('s1', 'k1', 1, 1)

    const deps = readerDeps()
    // 先开 k2：落它自己的存档章，**不**吃 k1 的听书现场
    const other = render(createElement(ReaderView, { sourceId: 's2', bookKey: 'k2', title: '书二', deps }))
    await waitFor(() => expect(other.container.querySelector('[data-chapter="2"]')).not.toBeNull())
    expect(other.container.querySelector('[data-chapter="1"]')).toBeNull()
    other.unmount()

    // 再开 k1：现场还在，按听书章段（第 2 章）恢复
    const own = render(createElement(ReaderView, { sourceId: 's1', bookKey: 'k1', title: '书一', deps }))
    await waitFor(() => expect(own.container.querySelector('[data-chapter="1"]')).not.toBeNull())
    expect(own.container.querySelector('[data-chapter="2"]')).toBeNull()
  })

  it('StrictMode 双 effect：重定位不被第一趟 mount 吃掉（两次开书落同一处）', async () => {
    shelf = [shelfEntry({ progress: { chapterIndex: 0, offsetRatio: 0.4, updatedAt: 1 } })]
    ttsPlayer.set({ active: true, chapterIndex: 1, paragraphIndex: 1, paragraphCount: 3 })
    requestReaderRelocation('s1', 'k1', 1, 1)
    const deps = readerDeps()
    const { container } = render(createElement(StrictMode, null,
      createElement(ReaderView, { sourceId: 's1', bookKey: 'k1', title: '书一', deps })))
    await waitFor(() => expect(container.querySelector('[data-chapter="1"]')).not.toBeNull())
    expect(container.querySelector('[data-chapter="0"]')).toBeNull()
  })

  it('会话按重定位落位：该章该比例，且恢复（restore）不写进度', async () => {
    shelf = [shelfEntry({ progress: { chapterIndex: 0, offsetRatio: 0.4, updatedAt: 1 } })]
    ttsPlayer.set({ active: true, chapterIndex: 1, paragraphIndex: 1, paragraphCount: 3 })
    requestReaderRelocation('s1', 'k1', 1, 1)
    const port = fakePort()
    port.anchors = [{ index: 1, start: 2000, height: 2000 }]
    port.scrollH = 5000
    port.height = 1000
    const fetched: number[] = []
    const saves: Array<[number, number]> = []
    const session = new ReaderSession({
      fetchNavigation: async () => ({ chapters: chapterEntries(), items: planarNavigation(chapterEntries()) }),
      fetchChapter: async (_s, _b, i) => { fetched.push(i); return { kind: 'text', text: textOf(i) } },
      fetchShelf: async () => shelf,
      saveProgress: (i, r) => { saves.push([i, r]) },
      saveTotalChapters: () => {},
      afterFrames: (cb) => cb(),
    }, port)
    await session.open('s1', 'k1', takeReaderRelocation('s1', 'k1'))
    expect(fetched).toEqual([1])
    // anchorTop: 章起点 2000 + 0.5 × 该章高度 2000
    expect(port.top).toBe(3000)
    expect(saves).toEqual([])
  })
})

describe('书架只有一条消费位置：进度行 + 「正在听」徽标', () => {
  it('卡片按 progress 显示进度；正在听的本书标「正在听」，不再出现「听至」', async () => {
    shelf = [
      shelfEntry({
        bookKey: 'k1', title: '书一', totalChapters: 4,
        progress: { chapterIndex: 1, offsetRatio: 0, updatedAt: 2 },
        listen: {
          chapterIndex: 1, paragraphIndex: 2, engineId: 'builtin:baidu', voice: null,
          rate: 1, volume: 0.8,
        },
      }),
      shelfEntry({
        bookKey: 'k2', title: '书二', sourceId: 's2', totalChapters: 4,
        progress: { chapterIndex: 0, offsetRatio: 0.5, updatedAt: 1 },
      }),
      shelfEntry({ bookKey: 'k3', title: '书三', sourceId: 's3', totalChapters: 4 }),
    ]
    await act(async () => {
      await startListening({ sourceId: 's1', bookKey: 'k1', title: '书一', chapterIndex: 1, paragraphIndex: 0 })
    })
    const deps = makeCoreDeps({ apiGet: vi.fn(async () => shelf) })
    render(createElement(ShelfView, { deps }))
    await waitFor(() => expect(screen.getByText('书三')).toBeTruthy())

    const playing = cardOf('书一')
    expect(playing.textContent).toContain('正在听')
    expect(playing.textContent).toContain('2/4 章 · 25%')

    const other = cardOf('书二')
    expect(other.textContent).not.toContain('正在听')
    expect(other.textContent).toContain('1/4 章 · 13%')

    const never = cardOf('书三')
    expect(never.textContent).toContain('未开始 · 4 章')
    for (const card of [playing, other, never]) {
      expect(card.textContent).not.toContain('听至')
    }

    // 「正在听」= 此刻在放（playing），不是「会话还在」（active）：暂停后这一格不撒谎；
    // 进度行仍按 progress 显示，与播放态无关。
    act(() => { pauseListening() })
    expect(cardOf('书一').textContent).not.toContain('正在听')
    expect(cardOf('书一').textContent).toContain('2/4 章 · 25%')
  })

  it('听书位置落盘后，当前书架卡片按共用进度更新', async () => {
    shelf = [shelfEntry({
      bookKey: 'k1', title: '书一', totalChapters: 4,
      progress: { chapterIndex: 0, offsetRatio: 0, updatedAt: 1 },
    })]
    const deps = makeCoreDeps({ apiGet: vi.fn(async () => shelf) })
    render(createElement(ShelfView, { deps }))
    await waitFor(() => expect(cardOf('书一').textContent).toContain('未开始 · 4 章'))

    await act(async () => {
      await startListening({ sourceId: 's1', bookKey: 'k1', title: '书一', chapterIndex: 0, paragraphIndex: 1 })
    })
    // pause flush 位置落盘：3 段里的第 1 段 = 章内 0.5 → 4 章制下 13%
    await act(async () => { pauseListening() })
    await waitFor(() => expect(cardOf('书一').textContent).toContain('1/4 章 · 13%'))
  })
})
