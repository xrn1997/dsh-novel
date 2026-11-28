// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as moyuStream from '../../src/client/moyu-stream.js'
import { MOYU_TICK_MS } from '../../src/client/moyu-stream.js'
import type { ListenScope } from '../../src/client/tts/listen-scope.js'
import * as ttsPlayerModule from '../../src/client/tts/player.js'
import { resetTtsPlayerForTests, ttsPlayer } from '../../src/client/tts/player.js'
import { DEFAULT_PREFS, prefsStore, setPref } from '../../src/client/store.js'
import type { Prefs } from '../../src/client/store.js'
import { attachMoyuHost, bindMoyuWorkspace, refreshMoyuWorkspaces, resetMoyuHostForTests } from '../../src/client/moyu-host.js'
import { makeFakeMoyuHost } from './fake-moyu-host.js'
import type { ReaderScene } from '../../src/client/reader-scene.js'
import type { ReaderSceneState } from '../../src/client/reader-scene.js'
import type { ReaderSession } from '../../src/client/reader-session.js'
import type { ReaderSessionState } from '../../src/client/reader-session.js'
import { EscStopSequence, MoyuStage, escLayerOf } from '../../src/client/views/MoyuStage.js'
import type { MoyuStageProps } from '../../src/client/views/MoyuStage.js'
import type { ChapterContent } from '../../src/client/views/types.js'

const chapters: ChapterContent[] = [
  { kind: 'text', text: '第一段正文。\n第二段正文。' },
  { kind: 'text', text: '第二章正文。' },
  { kind: 'text', text: '第三章正文。' },
]

function state(over: Partial<ReaderSessionState> = {}): ReaderSessionState {
  return {
    toc: chapters.map((_, index) => ({ name: `第${index + 1}章`, url: `u${index + 1}` })),
    navigation: null,
    chapters,
    loadingIdx: null,
    error: null,
    domRevision: 0,
    currentChapter: 0,
    returnDepth: 0,
    ...over,
  }
}

const sceneState: ReaderSceneState = {
  surface: null,
  note: null,
  askShelf: false,
  joinBusy: false,
  joinError: null,
  mask: false,
  escOwner: 'none',
}

const listen: ListenScope = { showing: false, active: false, busy: false, chapterIndex: 0, paragraphIndex: 0 }

function setup(over: {
  prefs?: Partial<Prefs>
  readerState?: Partial<ReaderSessionState>
  readerSceneState?: Partial<ReaderSceneState>
  listenScope?: Partial<ListenScope>
  overlays?: ReactNode
  defaultDockOpen?: boolean
} = {}) {
  const requestJump = vi.fn()
  const retry = vi.fn()
  const toggle = vi.fn()
  const exitToShelf = vi.fn()
  const session = { requestJump, retry } as unknown as ReaderSession
  const scene = { toggle, exitToShelf } as unknown as ReaderScene
  const onOpenExport = vi.fn()
  const onListen = vi.fn()
  const onClose = vi.fn()
  const onNavigate = vi.fn()
  const onTtsError = vi.fn()
  const apiGet = vi.fn(() => new Promise<never>(() => undefined))
  const props: MoyuStageProps = {
    session,
    sourceId: 's1',
    bookKey: 'k1',
    title: '测试书名',
    state: state(over.readerState),
    prefs: { ...DEFAULT_PREFS, readingMode: 'moyu', ...over.prefs },
    scene,
    sceneState: { ...sceneState, ...over.readerSceneState },
    listen: { ...listen, ...over.listenScope },
    importNotesCount: 0,
    onOpenExport,
    onListen,
    onClose,
    onNavigate,
    onTtsError,
    apiGet,
    ...(over.overlays === undefined ? {} : { overlays: over.overlays }),
    ...(over.defaultDockOpen === undefined ? {} : { defaultDockOpen: over.defaultDockOpen }),
  }
  const view = render(<MoyuStage {...props} />)
  return { ...view, props, requestJump, retry, toggle, exitToShelf, onOpenExport, onListen, onClose, onNavigate, onTtsError }
}

beforeEach(() => {
  resetTtsPlayerForTests()
  setPref(DEFAULT_PREFS)
  globalThis.localStorage.clear()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  resetTtsPlayerForTests()
})

describe('MoyuStage', () => {
  it('renders the disguised workspace and advances chapters through the reader session', () => {
    const view = setup({ prefs: { moyuReveal: 'instant' } })
    expect(view.container.querySelector('.novel-moyu-stage')).not.toBeNull()
    expect(screen.getAllByText('测试书名').length).toBeGreaterThan(0)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '下一节请继续梳理。' } })
    fireEvent.click(screen.getByRole('button', { name: '进入下一章' }))
    expect(view.requestJump).toHaveBeenCalledWith(1)
    expect(screen.getByText('下一节请继续梳理。')).toBeTruthy()

    view.rerender(<MoyuStage {...view.props} state={state({ currentChapter: 1 })} />)
    expect(view.container.querySelectorAll('[data-visited="true"]')).toHaveLength(2)
    expect(view.container.querySelector('[data-chapter-file="2"]')?.getAttribute('data-visited')).toBe('false')
  })

  it('空草稿发送钮灰态、Enter 空输入仍进章；工作区 chip 是入口，不接管发送', () => {
    const host = makeFakeMoyuHost()
    const stop = attachMoyuHost(host.port)
    refreshMoyuWorkspaces(host.port)
    host.workspaces.setItems([{ workspaceId: 'w-1', title: '工作区一' }])
    bindMoyuWorkspace('w-1')
    try {
      const view = setup({ prefs: { moyuReveal: 'instant' } })
      const send = screen.getByRole('button', { name: '进入下一章' })
      expect((send as HTMLButtonElement).disabled).toBe(true)
      fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
      expect(view.requestJump).toHaveBeenCalledWith(1)
      // 选中工作区只是记下入口目标：发送钮在任何状态下都只进章，不代开宿主会话。
      expect(host.openCalls).toEqual([])
      expect(host.sessions.retains).toEqual([])
    } finally {
      stop()
      resetMoyuHostForTests()
    }
  })

  it('Esc 层序表与双击停止窗口是纯函数契约', () => {
    expect(escLayerOf({ menuOpen: true, detailOpen: true, previewOpen: true, searchOpen: true, filter: 'x' })).toBe('menu')
    expect(escLayerOf({ menuOpen: false, detailOpen: true, previewOpen: true, searchOpen: true, filter: 'x' })).toBe('detail')
    expect(escLayerOf({ menuOpen: false, detailOpen: false, previewOpen: true, searchOpen: true, filter: 'x' })).toBe('preview')
    expect(escLayerOf({ menuOpen: false, detailOpen: false, previewOpen: false, searchOpen: true, filter: 'x' })).toBe('search-clear')
    expect(escLayerOf({ menuOpen: false, detailOpen: false, previewOpen: false, searchOpen: true, filter: '' })).toBe('search-close')
    expect(escLayerOf({ menuOpen: false, detailOpen: false, previewOpen: false, searchOpen: false, filter: '' })).toBe('exit')
    const seq = new EscStopSequence()
    expect(seq.press(1_000, true)).toBe(false)
    expect(seq.press(1_240, true)).toBe(true)
    expect(seq.press(3_000, true)).toBe(false)
    expect(seq.press(3_100, false)).toBe(false)
    expect(seq.press(3_120, true)).toBe(false)
    expect(seq.press(3_200, true)).toBe(true)
    seq.reset()
    expect(seq.press(3_300, true)).toBe(false)
  })

  it('被会话窗口裁掉的章仍留在对话流（投影按内容缓存，不因 chapters 变 null 退化）', () => {
    const view = setup({ prefs: { moyuReveal: 'instant' } })
    expect(screen.getByText('第一段正文。')).toBeTruthy()
    view.rerender(<MoyuStage {...view.props} state={state({ currentChapter: 1, chapters: [null, chapters[1] ?? null, chapters[2] ?? null] })} />)
    // 第 0 章内容已被裁成 null，但摸鱼对话流是「读过的轮次」，正文不许消失。
    expect(screen.getByText('第一段正文。')).toBeTruthy()
    expect(screen.getByText('第二段正文。')).toBeTruthy()
  })

  it('completes streaming with Space', () => {
    vi.useFakeTimers()
    setup()
    act(() => { vi.advanceTimersByTime(MOYU_TICK_MS) })
    fireEvent.keyDown(document, { key: ' ' })
    expect(screen.getByText('第一段正文。')).toBeTruthy()
    expect(screen.getByText('第二段正文。')).toBeTruthy()
  })

  it('consumes Esc one layer at a time before leaving the stage', () => {
    const view = setup()
    fireEvent.click(screen.getByRole('button', { name: '更多操作' }))
    expect(screen.getByText('显示与阅读设置')).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByText('显示与阅读设置')).toBeNull()
    expect(view.onClose).not.toHaveBeenCalled()

    // README 预览 tab（D1）：Esc 先关预览回「文件」tab，再按才退舞台。
    fireEvent.click(screen.getByRole('button', { name: 'README.md' }))
    expect(screen.getByRole('button', { name: '在阅读器打开' })).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('button', { name: '在阅读器打开' })).toBeNull()
    expect(view.onClose).not.toHaveBeenCalled()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(view.onClose).toHaveBeenCalledTimes(1)
  })

  it('文件坞收起后 Esc 不再先「关」一枚不可见的预览 tab', () => {
    const view = setup({ prefs: { moyuReveal: 'instant' } })
    fireEvent.click(screen.getByRole('button', { name: 'README.md' }))
    expect(screen.getByRole('button', { name: '在阅读器打开' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '收起侧边栏' }))
    expect(screen.queryByRole('button', { name: '在阅读器打开' })).toBeNull()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(view.onClose).toHaveBeenCalledTimes(1)
  })

  it('routes menu commands to ReaderScene and shows the mapped error code chip', () => {
    const view = setup({
      readerState: { error: { code: 'NetworkError', message: '上游超时' } },
      listenScope: { showing: true, active: true, chapterIndex: 0, paragraphIndex: 0 },
    })
    fireEvent.click(screen.getByRole('button', { name: '更多操作' }))
    fireEvent.click(screen.getByText('显示与阅读设置'))
    expect(view.toggle).toHaveBeenCalledWith('prefs')
    fireEvent.click(screen.getByRole('button', { name: '更多操作' }))
    fireEvent.click(screen.getByText('导出记录'))
    expect(view.onOpenExport).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: '更多操作' }))
    fireEvent.click(screen.getByText('语音朗读（听书）'))
    expect(view.onListen).toHaveBeenCalledTimes(1)

    // M4：错误行第三列是 `<code>` 错误码芯片（按真实错误原因映射），「重试」钮删除。
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull()
    expect(screen.getByText('NETWORK')).toBeTruthy()
    expect(view.retry).not.toHaveBeenCalled()
  })

  it('folds rich images by default and reveals the TTS queue from player state', () => {
    ttsPlayer.set({
      active: true,
      bookKey: 'k1',
      sourceId: 's1',
      chapterIndex: 0,
      paragraphIndex: 1,
      paragraphCount: 3,
      playing: true,
      rate: 1,
    })
    const rich: ChapterContent = {
      kind: 'rich',
      documentId: 'doc',
      nodes: [
        { kind: 'element', id: 'p1', tag: 'p', children: [{ kind: 'text', text: '图文正文' }], rowSpan: null, colSpan: null, start: null, value: null },
        { kind: 'image', id: 'img1', resourceId: 'asset.png', alt: '插图', width: 320, height: 180 },
      ],
    }
    const view = setup({ prefs: { moyuReveal: 'instant' }, readerState: { chapters: [rich, chapters[1] ?? null, chapters[2] ?? null] }, listenScope: { showing: true, active: true } })
    expect(screen.getByText('语音任务 · 第 1 章 · 第 2/3 段')).toBeTruthy()
    const card = screen.getByRole('button', { name: /asset\.png · 点击预览/ })
    expect(view.container.querySelector('img')).toBeNull()
    fireEvent.click(card)
    expect(screen.getByAltText('插图')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '收起预览' }))
    expect(view.container.querySelector('img')).toBeNull()
  })

  it('measures the nearest novel main port instead of covering host chrome', async () => {
    const fixture = setup({ prefs: { moyuReveal: 'instant' } })
    fixture.unmount()
    const main = document.createElement('div')
    main.setAttribute('data-novel-main', '')
    main.getBoundingClientRect = () => new DOMRect(200, 40, 1080, 860)
    document.body.appendChild(main)
    const view = render(<MoyuStage {...fixture.props} />, { container: main })
    await waitFor(() => expect(view.container.querySelector<HTMLElement>('.novel-moyu-stage')?.style.left).toBe('200px'))
    expect(view.container.querySelector<HTMLElement>('.novel-moyu-stage')?.style.top).toBe('40px')
    expect(view.container.querySelector<HTMLElement>('.novel-moyu-stage')?.style.width).toBe('1080px')
    expect(view.container.querySelector<HTMLElement>('.novel-moyu-stage')?.style.height).toBe('860px')
    view.unmount()
    main.remove()
  })

  it('keeps the error code chip visible when the current chapter failed before content arrived', () => {
    setup({ readerState: { chapters: [null, chapters[1] ?? null, chapters[2] ?? null], error: { code: 'UnsupportedRuleError', message: '目录已到，正文加载失败' } } })
    expect(screen.getByText('PARSE')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull()
  })

  it('traps Tab focus inside the stage', () => {
    const view = setup({ prefs: { moyuReveal: 'instant' } })
    const buttons = [...view.container.querySelectorAll<HTMLButtonElement>('button:not([disabled])')]
    const first = buttons[0]
    const last = buttons.at(-1)
    if (first === undefined || last === undefined) throw new Error('missing stage buttons')
    last.focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(first)
  })

  it('keeps the long paragraph highlighted across split playback units', () => {
    const longParagraph = '句。'.repeat(200)
    const view = setup({
      prefs: { moyuReveal: 'instant' },
      readerState: { chapters: [{ kind: 'text', text: `${longParagraph}\n第二段` }, chapters[1] ?? null, chapters[2] ?? null] },
      listenScope: { showing: true, active: true, chapterIndex: 0, paragraphIndex: 1 },
    })
    expect(view.container.querySelector('[data-pidx="0"]')?.classList.contains('is-tts-live')).toBe(true)
  })

  it('collapses and restores the file dock on desktop', () => {
    const view = setup({ prefs: { moyuReveal: 'instant' } })
    expect(view.container.querySelector('.novel-moyu-dock')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '收起右侧边栏' }))
    expect(view.container.querySelector('.novel-moyu-dock')).toBeNull()
    expect(view.container.querySelector('.novel-moyu-stage')?.classList.contains('has-dock')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: '打开右侧边栏' }))
    expect(view.container.querySelector('.novel-moyu-dock')).not.toBeNull()
  })

  it('starts visit history at the restored chapter instead of chapter zero', () => {
    const view = setup({ prefs: { moyuReveal: 'instant' }, readerState: { toc: null, chapters: [null, null, null], currentChapter: 0 } })
    expect(view.container.querySelector('[data-turn-index]')).toBeNull()
    view.rerender(<MoyuStage {...view.props} state={state({ currentChapter: 2 })} />)
    expect(view.container.querySelectorAll('[data-turn-index]')).toHaveLength(1)
    expect(view.container.querySelector('[data-turn-index="2"]')).not.toBeNull()
    expect(view.container.querySelector('[data-chapter-file="0"]')?.getAttribute('data-visited')).toBe('false')
    expect(view.container.querySelector('[data-chapter-file="2"]')?.getAttribute('data-visited')).toBe('true')
  })

  it('renders scene overlays inside the measured stage', () => {
    const view = setup({
      prefs: { moyuReveal: 'instant' },
      overlays: <div className="novel-moyu-overlay"><div role="dialog" aria-label="测试面板">panel</div></div>,
    })
    expect(view.container.querySelector('.novel-moyu-stage > .novel-moyu-overlay')).not.toBeNull()
  })

  it('surfaces TTS skip failures through the provided error reporter', async () => {
    const failure = new Error('skip failed')
    const skip = vi.spyOn(ttsPlayerModule, 'skipParagraph').mockRejectedValueOnce(failure)
    try {
      const view = setup({ listenScope: { showing: true, active: true } })
      fireEvent.click(screen.getByRole('button', { name: '下一段' }))
      await waitFor(() => expect(view.onTtsError).toHaveBeenCalledWith(failure))
    } finally {
      skip.mockRestore()
    }
  })


  it('renders the host turn shell: user prompt, process rows and a foldable process group', () => {
    const view = setup({ prefs: { moyuReveal: 'instant' } })
    expect(screen.getByText('请读取 chapters/0001_chapter.ts，梳理本节上下文脉络并输出完整分析记录。')).toBeTruthy()
    expect(screen.getByText('思考')).toBeTruthy()
    expect(screen.getByText('读取')).toBeTruthy()
    expect(view.container.querySelector('.novel-moyu-user-bubble')).not.toBeNull()

    const header = screen.getByRole('button', { name: /已完成，用时/ })
    expect(header.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(header)
    expect(header.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('读取')).toBeNull()
    fireEvent.click(header)
    expect(screen.getByText('读取')).toBeTruthy()
  })

  it('expands the thinking disclosure in place', () => {
    setup({ prefs: { moyuReveal: 'instant' } })
    const think = screen.getByRole('button', { name: /思考/ })
    expect(screen.queryByText(/本章上下文：共 2 段/)).toBeNull()
    fireEvent.click(think)
    expect(screen.getByText(/本章上下文：共 2 段、12 字/)).toBeTruthy()
  })

  it('renders clean presentation headings instead of DSH process rows', () => {
    setup({ prefs: { moyuReveal: 'instant', moyuStyle: 'clean' } })
    expect(screen.getByText('阶段 1 · 文本上下文摘录')).toBeTruthy()
    expect(screen.getByText('seg_1')).toBeTruthy()
    expect(screen.queryByText('搜索')).toBeNull()
  })

  it('interleaves DSH process rows every five paragraphs and keeps the clean preset free of them', () => {
    const longText = Array.from({ length: 10 }, (_, index) => `段落${index + 1}。`).join('\n')
    const fill = setup({ prefs: { moyuReveal: 'instant' }, readerState: { chapters: [{ kind: 'text', text: longText }, chapters[1] ?? null, chapters[2] ?? null] } })
    expect(screen.getByText('搜索')).toBeTruthy()
    expect(screen.getByText('本章上下文与历史锚点')).toBeTruthy()
    fill.unmount()
    setup({ prefs: { moyuReveal: 'instant', moyuStyle: 'clean' }, readerState: { chapters: [{ kind: 'text', text: longText }, chapters[1] ?? null, chapters[2] ?? null] } })
    expect(screen.queryByText('搜索')).toBeNull()
    expect(screen.getAllByText(/阶段 \d+ · 文本上下文摘录/).length).toBeGreaterThan(1)
  })

  it('opens the README document preview tab with workspace metadata', () => {
    setup({ prefs: { moyuReveal: 'instant' } })
    fireEvent.click(screen.getByRole('button', { name: 'README.md' }))
    // D1：README 是文档预览 tab + 真 Markdown 渲染（元信息以列表项上屏）。
    expect(screen.getByText(/3 modules \(0001 ~ 0003\)/)).toBeTruthy()
    expect(screen.getByText(/novel-core · read-stream/)).toBeTruthy()
    expect(screen.getByRole('button', { name: '在阅读器打开' })).toBeTruthy()
  })

  it('switches the output cadence from the model chip menu', () => {
    setup({ prefs: { moyuReveal: 'instant' } })
    fireEvent.click(screen.getByRole('button', { name: /选择呈现风格/ }))
    fireEvent.click(screen.getByText('流式揭示'))
    expect(prefsStore.get().moyuReveal).toBe('stream')
  })

  it('does not reproject every chapter on each reveal tick', () => {
    vi.useFakeTimers()
    const project = vi.spyOn(moyuStream, 'extractMoyuTurnBlocks')
    try {
      setup()
      const initialCalls = project.mock.calls.length
      act(() => { vi.advanceTimersByTime(MOYU_TICK_MS * 3) })
      expect(project.mock.calls.length).toBe(initialCalls)
    } finally {
      project.mockRestore()
    }
  })

  it('rebuilds the trajectory tab as a ledger with turn headers, event rows and the event detail', () => {
    const view = setup({ prefs: { moyuReveal: 'instant' } })
    view.rerender(<MoyuStage {...view.props} state={state({ currentChapter: 1 })} />)
    fireEvent.click(screen.getByRole('tab', { name: '轨迹' }))
    // sticky 轮次头（轮号 + 输入/输出/思考/时间四列指标头）+ 每轮 3 行事件（用户/工具/消息）。
    expect(screen.getAllByText(/第 \d+ 轮/)).toHaveLength(2)
    expect(screen.getAllByText('用户').length).toBeGreaterThan(0)
    expect(screen.getAllByText('工具').length).toBeGreaterThan(0)
    expect(screen.getAllByText('消息').length).toBeGreaterThan(0)
    expect(screen.getAllByText('输入').length).toBeGreaterThan(0)
    // 指标口径：字数→输入/输出（~tok）、段数→思考、揭示耗时→时间。
    expect(screen.getAllByText(/~\d+ tok/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/\d+ 段/).length).toBeGreaterThan(0)

    // 点行选中 → 事件详情浮层（本章统计 +「在阅读器打开」跳章）。
    const rows = view.container.querySelectorAll<HTMLButtonElement>('.novel-moyu-traj-row')
    const first = rows[0]
    if (first === undefined) throw new Error('missing trajectory rows')
    fireEvent.click(first)
    expect(screen.getByText('事件详情')).toBeTruthy()
    expect(screen.getByText('段数')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '在阅读器打开' }))
    expect(view.requestJump).toHaveBeenCalledWith(0)
    expect(view.onClose).toHaveBeenCalledTimes(1)
  })

  it('filters and folds the trajectory ledger by chapter name', () => {
    const view = setup({ prefs: { moyuReveal: 'instant' } })
    view.rerender(<MoyuStage {...view.props} state={state({ currentChapter: 1 })} />)
    fireEvent.click(screen.getByRole('tab', { name: '轨迹' }))
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索轨迹' }), { target: { value: '第2章' } })
    expect(screen.queryByText(/第 1 轮/)).toBeNull()
    expect(screen.getByText(/第 2 轮/)).toBeTruthy()
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索轨迹' }), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: '收起所有轮次' }))
    expect(view.container.querySelectorAll('.novel-moyu-traj-row')).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: '展开所有轮次' }))
    expect(view.container.querySelectorAll('.novel-moyu-traj-row').length).toBeGreaterThan(0)
  })

  it('shows host-dimension stats pills and fake-clock message times', () => {
    setup({ prefs: { moyuReveal: 'instant' } })
    // I1/I2：UsagePill（database 图标 + ~tok + 缓存命中）与 ActivityPill 的「· X tok/s」。
    expect(screen.getByText(/tok\/s/)).toBeTruthy()
    expect(screen.getByText(/缓存命中 \d+%/)).toBeTruthy()
    // M1/M5：轮尾＝用量胶囊 + 消息时刻、用户行＝时刻常显；全部来自假时钟（当天 09:30 起）。
    expect(screen.getByText('用量 ~8 tok')).toBeTruthy()
    expect(screen.getAllByText('09:30').length).toBeGreaterThan(0)
  })

  it('opens chapter files as document preview tabs and closes back to the files tab', () => {
    const view = setup({ prefs: { moyuReveal: 'instant' } })
    const row = view.container.querySelector<HTMLButtonElement>('[data-chapter-file="0"]')
    if (row === null) throw new Error('missing chapter file row')
    fireEvent.click(row)
    expect(screen.getByRole('button', { name: '在阅读器打开' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '关闭标签页' }))
    expect(screen.queryByRole('button', { name: '在阅读器打开' })).toBeNull()
    expect(view.container.querySelector('.novel-moyu-files-tree')).not.toBeNull()
  })

  it('navigates back to the shelf from the breadcrumb parent segment', () => {
    const view = setup({ prefs: { moyuReveal: 'instant' } })
    fireEvent.click(screen.getByRole('button', { name: '测试书名' }))
    expect(view.exitToShelf).toHaveBeenCalledTimes(1)
  })

  it('exposes the dock separator with min-bound and keyboard resize', () => {
    const view = setup({ prefs: { moyuReveal: 'instant' } })
    const sep = view.container.querySelector<HTMLElement>('[role="separator"]')
    if (sep === null) throw new Error('missing dock separator')
    expect(sep.getAttribute('aria-valuemin')).toBe('300')
    expect(sep.getAttribute('aria-valuenow')).toBe('320')
    fireEvent.keyDown(sep, { key: 'ArrowLeft' })
    expect(sep.getAttribute('aria-valuenow')).toBe('340')
    fireEvent.keyDown(sep, { key: 'Home' })
    expect(sep.getAttribute('aria-valuenow')).toBe('300')
    fireEvent.keyDown(sep, { key: 'ArrowRight' })
    expect(sep.getAttribute('aria-valuenow')).toBe('300')
  })
})

describe('MoyuStage 工作区入口', () => {
  beforeEach(() => {
    resetMoyuHostForTests()
  })
  afterEach(() => {
    resetMoyuHostForTests()
  })

  /** 挂一套齐装满员的宿主窄口 + 一个已枚举的工作区。 */
  function setupHost() {
    const host = makeFakeMoyuHost()
    const stop = attachMoyuHost(host.port)
    refreshMoyuWorkspaces(host.port)
    host.workspaces.setItems([{ workspaceId: 'w-1', title: '工作区一' }])
    return { host, stop }
  }

  it('点工作区＝在宿主打开会话（入口），Toast 如实回执', async () => {
    const { host } = setupHost()
    setup({ prefs: { moyuReveal: 'instant' } })
    fireEvent.click(screen.getByRole('button', { name: '选择工作区' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '在「工作区一」打开宿主会话' }))
    await waitFor(() => expect(host.openCalls).toEqual([{ workspaceId: 'w-1', sessionId: 's-1' }]))
    await waitFor(() => expect(screen.getByText('已在宿主打开「工作区一」')).toBeTruthy())
    // 打开＝建/切会话，不投递任何消息。
    expect(host.sessions.retains).toEqual([{ sessionId: 's-1', source: 'moyuStage' }])
  })

  it('打开失败：Toast 带宿主原文，不改阅读现场', async () => {
    const { host } = setupHost()
    const view = setup({ prefs: { moyuReveal: 'instant' } })
    host.failNextOpen = new Error('workspace refused')
    fireEvent.click(screen.getByRole('button', { name: '选择工作区' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '在「工作区一」打开宿主会话' }))
    await waitFor(() => expect(screen.getByText('打开宿主会话失败：workspace refused')).toBeTruthy())
    expect(view.requestJump).not.toHaveBeenCalled()
    expect(host.sessions.retains).toEqual([])
  })

  it('入口不接管输入框：有草稿时发送仍是进章', async () => {
    const { host } = setupHost()
    const view = setup({ prefs: { moyuReveal: 'instant' } })
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '继续。' } })
    fireEvent.click(screen.getByRole('button', { name: '进入下一章' }))
    expect(view.requestJump).toHaveBeenCalledWith(1)
    expect(host.openCalls).toEqual([])
  })

  it('更多视图菜单只留宿主导航入口：不再有「创建你的插件」（它会起一轮真会话）', async () => {
    const { host } = setupHost()
    setup({ prefs: { moyuReveal: 'instant' } })
    fireEvent.click(screen.getByRole('button', { name: '更多会话视图' }))
    expect(screen.queryByRole('menuitem', { name: '创建你的插件' })).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: '浏览更多插件' }))
    expect(host.openListCalls).toBe(1)
  })

  it('展开朝上的菜单以锚点为底边（above 不是「从锚点顶向下铺」）', () => {
    setup({ prefs: { moyuReveal: 'instant' } })
    fireEvent.click(screen.getByRole('button', { name: /选择呈现风格/ }))
    const surface = document.querySelector<HTMLElement>('.novel-moyu-menu-surface')
    expect(surface).not.toBeNull()
    expect(surface?.style.bottom).not.toBe('')
    expect(surface?.style.top).toBe('')
  })

  it('工作区面或打开面缺席＝入口整枚隐藏（不画空座、不炸面板）', () => {
    setup({ prefs: { moyuReveal: 'instant' } })
    expect(screen.queryByRole('button', { name: '选择工作区' })).toBeNull()
  })
})

describe('MoyuStage 真轮次镜像', () => {
  beforeEach(() => {
    resetMoyuHostForTests()
  })
  afterEach(() => {
    resetMoyuHostForTests()
  })

  /** 挂一套齐装满员的宿主窄口 + 一个已枚举的工作区，返回 fake 与视图。 */
  function setupMirror() {
    const host = makeFakeMoyuHost()
    const stop = attachMoyuHost(host.port)
    refreshMoyuWorkspaces(host.port)
    host.workspaces.setItems([{ workspaceId: 'w-1', title: '工作区一' }])
    const view = setup({ prefs: { moyuReveal: 'instant' } })
    return { host, view, stop }
  }

  /** 走一次入口（点工作区）并等宿主回调跑完。 */
  async function openEntry(host: ReturnType<typeof makeFakeMoyuHost>): Promise<void> {
    fireEvent.click(screen.getByRole('button', { name: '选择工作区' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '在「工作区一」打开宿主会话' }))
    await waitFor(() => expect(host.openCalls).toHaveLength(1))
    await waitFor(() => expect(screen.getByText('已在宿主打开「工作区一」')).toBeTruthy())
  }

  /** 真值时刻（本地钟构造，格式断言与 TZ 无关）。 */
  const at = (hour: number, minute: number): number => new Date(2026, 0, 15, hour, minute).getTime()

  it('映射进舞台流：用户气泡 / 思考行 / 工具行 / 助手正文 / 轮尾（真时刻 + 真用量）', async () => {
    const { host, view } = setupMirror()
    await openEntry(host)
    act(() => {
      host.sessions.pushChatSnapshot('s-1', [
        { key: 'n1', kind: 'user', turn: 1, data: { content: [{ type: 'text', text: '帮我读第一章' }], time: at(14, 30) } },
        {
          key: 'n2', kind: 'assistant-step', turn: 1,
          data: {
            turn: 1, step: 1, time: at(14, 30),
            blocks: [
              { kind: 'reasoning', text: '第一行摘要\n第二行全文' },
              { kind: 'text', text: '第一章正文摘要。' },
            ],
          },
        },
        {
          key: 'n3', kind: 'tool-call', turn: 1,
          data: {
            root: {
              kind: 'tool-result', callId: 'c1', name: 'dshnovel_read', seq: 3, time: at(14, 30), args: {},
              call: { name: 'dshnovel_read', argsRaw: '{"chapterIndex":0}' }, callTime: 1,
              content: [], isError: false, subCalls: [],
            },
          },
        },
        {
          key: 'n4', kind: 'turn-tail', turn: 1,
          data: {
            turn: 1, seq: 4, time: at(14, 31), closing: null, branchUnavailable: false,
            tokenUsage: { totalTokens: 12345, outputTokens: 500 },
          },
        },
      ])
    })
    expect(view.container.querySelector('[data-mirror-turn]')).not.toBeNull()
    expect(screen.getByText('帮我读第一章')).toBeTruthy()
    expect(screen.getByText('14:30')).toBeTruthy()
    expect(screen.getByText('第一行摘要')).toBeTruthy()
    fireEvent.click(view.container.querySelector('[data-mirror-turn] .novel-moyu-disclosure-line') ?? document.body)
    expect(view.container.querySelector('[data-mirror-turn] .novel-moyu-think-body')?.textContent).toBe('第一行摘要\n第二行全文')
    expect(screen.getByText('dshnovel_read')).toBeTruthy()
    expect(screen.getByText('{"chapterIndex":0}')).toBeTruthy()
    expect(screen.getByText('第一章正文摘要。')).toBeTruthy()
    expect(screen.getByText('14:31')).toBeTruthy()
    expect(screen.getByText('用量 12345 tok')).toBeTruthy()
    expect(screen.queryByText(/用量 ~12345/)).toBeNull()
  })

  it('与章轮次按时间交错共存于同一条流（镜像轮前后夹住章轮；同一套组件、无「这是真的」标记）', async () => {
    const { host, view } = setupMirror()
    await openEntry(host)
    act(() => {
      host.sessions.pushChatSnapshot('s-1', [
        { key: 'n1', kind: 'user', turn: 1, data: { content: [{ type: 'text', text: '更早的真轮次' }], time: Date.now() - 60_000 } },
        { key: 'n2', kind: 'turn-tail', turn: 1, data: { turn: 1, seq: 2, time: Date.now() - 59_000, closing: null, branchUnavailable: false } },
        { key: 'n3', kind: 'user', turn: 2, data: { content: [{ type: 'text', text: '更晚的真轮次' }], time: Date.now() + 60_000 } },
        { key: 'n4', kind: 'turn-tail', turn: 2, data: { turn: 2, seq: 4, time: Date.now() + 61_000, closing: null, branchUnavailable: false } },
      ])
    })
    view.rerender(<MoyuStage {...view.props} state={state({ currentChapter: 1 })} />)
    const order = Array.from(view.container.querySelectorAll('.novel-moyu-turn')).map((node) =>
      (node.hasAttribute('data-mirror-turn') ? 'm' : 'c'))
    expect(order).toEqual(['m', 'c', 'c', 'm'])
    expect(view.container.querySelector('[data-mirror-turn]')?.className).toBe('novel-moyu-turn')
    expect(view.container.querySelector('[data-mirror-turn="mirror-s-1-2"]')).not.toBeNull()
  })

  it('形状漂移＝该轮降级成中性占位行（失败半径＝那一轮）；未映射种类也占位，不炸整条流', async () => {
    const { host, view } = setupMirror()
    await openEntry(host)
    act(() => {
      host.sessions.pushChatSnapshot('s-1', [
        { key: 'n1', kind: 'user', turn: 1, data: { content: [{ type: 'text', text: '好轮' }], time: Date.now() - 60_000 } },
        { key: 'n2', kind: 'model-retry', turn: 1, data: {} },
        { key: 'n3', kind: 'user', turn: 2, data: { time: Date.now() + 60_000 } },
      ])
    })
    expect(screen.getByText('好轮')).toBeTruthy()
    expect(screen.getAllByText('未渲染条目')).toHaveLength(2)
    const sections = Array.from(view.container.querySelectorAll('.novel-moyu-turn'))
    expect(sections).toHaveLength(3)
    const bad = view.container.querySelector('[data-mirror-turn="mirror-s-1-2"]')
    expect(bad?.querySelectorAll('.novel-moyu-mirror-skip')).toHaveLength(1)
    expect(bad?.querySelector('.novel-moyu-user-bubble')).toBeNull()
  })

  it('uiConversation 缺席＝不镜像（入口照样成功，舞台只显章轮次）', async () => {
    const { host, view } = setupMirror()
    host.port.uiConversation = undefined
    await openEntry(host)
    act(() => {
      host.sessions.pushChatSnapshot('s-1', [
        { key: 'n1', kind: 'user', turn: 1, data: { content: [{ type: 'text', text: '不该出现' }], time: Date.now() } },
      ])
    })
    expect(view.container.querySelector('[data-mirror-turn]')).toBeNull()
    expect(screen.queryByText('不该出现')).toBeNull()
  })

  it('跨书不串场：A 书入口会话的轮次不出现在 B 书的对话流', async () => {
    const { host, view } = setupMirror()
    await openEntry(host)
    act(() => {
      host.sessions.pushChatSnapshot('s-1', [
        { key: 'n1', kind: 'user', turn: 1, data: { content: [{ type: 'text', text: 'A 书的真轮次' }], time: Date.now() } },
      ])
    })
    expect(view.container.querySelector('[data-mirror-turn]')).not.toBeNull()
    view.rerender(<MoyuStage {...view.props} bookKey="k2" title="另一本书" />)
    expect(view.container.querySelector('[data-mirror-turn]')).toBeNull()
    expect(screen.queryByText('A 书的真轮次')).toBeNull()
  })

  it('turn-error 接错误行（「本轮运行失败」+ 真消息 + 错误码芯片），不落占位', async () => {
    const { host, view } = setupMirror()
    await openEntry(host)
    act(() => {
      host.sessions.pushChatSnapshot('s-1', [
        { key: 'n1', kind: 'user', turn: 1, data: { content: [{ type: 'text', text: '会失败的一轮' }], time: Date.now() - 60_000 } },
        { key: 'n2', kind: 'turn-error', turn: 1, data: { kind: 'turn-error', message: 'quota exceeded', code: 'quota' } },
      ])
    })
    const mirrorTurn = view.container.querySelector('[data-mirror-turn="mirror-s-1-1"]')
    expect(mirrorTurn?.querySelector('.novel-moyu-error-title')?.textContent).toBe('本轮运行失败')
    expect(mirrorTurn?.querySelector('.novel-moyu-error-msg')?.textContent).toBe('quota exceeded')
    expect(mirrorTurn?.querySelector('.novel-moyu-error-code')?.textContent).toBe('QUOTA')
    expect(mirrorTurn?.querySelectorAll('.novel-moyu-mirror-skip')).toHaveLength(0)
  })
})
