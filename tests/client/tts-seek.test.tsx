// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { ROUTES, planarNavigation } from '../../src/shared/wire.js'
import type {
  ChapterContent, ChapterEntry, ContentNode, RouteTarget, ShelfEntry, WriteMethod,
} from '../../src/shared/wire.js'
import { apiGet, apiSend } from '../../src/client/api.js'
import { resetPanelShelf } from '../../src/client/panel-shelf.js'
import { DEFAULT_PREFS, prefsStore } from '../../src/client/store.js'
import { paperLiveInk } from '../../src/client/util.js'
import {
  TTS_MAX_CONSECUTIVE_FAILURES,
  jumpToChapter, resetTtsPlayer, seekParagraph, startListening, ttsPlayer, ttsProgress,
} from '../../src/client/tts/player.js'
import { listenParagraphElement, paragraphSlotOf } from '../../src/client/tts/reading-position.js'
import { TtsBar } from '../../src/client/tts/TtsBar.js'
import { TtsMiniBar } from '../../src/client/tts/TtsMiniBar.js'
import { NOVEL_CSS } from '../../src/client/styles.js'
import { ReaderView } from '../../src/client/views/ReaderView.js'
import { makeReaderDeps } from './fake-deps.js'
import type { FakeReaderDeps } from './fake-deps.js'
import { must, pick } from '../support/fixture.js'

/**
 * 听书进度面（seek / 段进度 / 跟读高亮 / 起播章）的行为网：真播放层 + 真 ReaderView/ChapterBody，
 * mock 掉 `/novel-api` 与 `Audio`。钉四件事：
 * ① 听书条只有章内滑杆这一条进度：拖到任意段即起播，段粒度落盘；
 * ② 段进度 store 只认活槽（预载槽的 metadata 不投），直出型恒无计时；
 * ③ 跟读高亮按段号命中正文块（文字章与图文章同一条判据），**只标记不滚动**——高亮不写任何位置；
 * ④ 起播章选择与「定位到正在念的段」接得上，定位是显式动作、不自动跟随。
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
  duration = 0
  onended: (() => void) | null = null
  onplaying: (() => void) | null = null
  ontimeupdate: (() => void) | null = null
  onloadedmetadata: (() => void) | null = null
  constructor() { FakeAudio.instances.push(this) }
  play = vi.fn(async () => { this.paused = false; this.onplaying?.() })
  pause = vi.fn(() => { this.paused = true })
  /** 停播时播放层会摘 src 松开缓冲（`removeAttribute` + `load` 那一对，不是赋空串） */
  removeAttribute = vi.fn()
  load = vi.fn()
}

class FakeUtterance {
  readonly text: string
  voice: unknown = null
  rate = 1
  volume = 1
  onstart: (() => void) | null = null
  onend: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(text: string) { this.text = text }
}

class FakeSpeechSynthesis {
  voices: { voiceURI: string; name: string }[] = [{ voiceURI: 'v1', name: '嗓音一' }]
  getVoices = vi.fn(() => this.voices)
  speak = vi.fn((utterance: FakeUtterance) => { utterance.onstart?.() })
  cancel = vi.fn()
}

let chapterNames: string[]
let chapterTexts: string[][]
let richChapters: Map<number, ChapterContent>
let shelf: ShelfEntry[]

const chapterEntries = (): ChapterEntry[] => chapterNames.map((name) => ({ name, url: name }))

function indexOf(path: string): number {
  const m = /[?&]index=(\d+)/.exec(path)
  return m === null ? 0 : Number(m[1])
}

function contentOf(index: number): ChapterContent {
  const rich = richChapters.get(index)
  if (rich !== undefined) return rich
  return { kind: 'text', text: must(chapterTexts[index], `chapter text ${index}`).join('\n') }
}

function readerDeps(): FakeReaderDeps {
  return makeReaderDeps({
    apiGet: vi.fn(async (path: string) => {
      if (path.startsWith('navigation')) {
        const chapters = chapterEntries()
        return { chapters, items: planarNavigation(chapters) }
      }
      if (path.startsWith('chapter')) return contentOf(indexOf(path))
      if (path === ROUTES.ttsSources.path) return { sources: [], hostSpeech: { state: 'absent' } }
      return shelf
    }),
  })
}

function renderReader(deps: FakeReaderDeps): ReturnType<typeof render> {
  return render(createElement(ReaderView, { sourceId: 's1', bookKey: 'k1', title: '书一', deps }))
}

/** 写口里带 progress 的 body（高亮与 seek 都不许碰阅读进度） */
function progressBodies(): Record<string, unknown>[] {
  return vi.mocked(apiSend).mock.calls
    .filter(([target]) => target.path.startsWith('shelf/'))
    .map(([, body]) => (body ?? {}) as Record<string, unknown>)
    .filter((body) => 'progress' in body)
}

function synthTexts(): string[] {
  return vi.mocked(apiSend).mock.calls
    .filter(([target]) => target.path === ROUTES.ttsSynthesize.path)
    .map(([, body]) => ((body ?? {}) as { text?: string }).text ?? '')
}

const paragraph = (id: string, text: string): ContentNode => ({
  kind: 'element', id, tag: 'p', children: [{ kind: 'text', text }],
  rowSpan: null, colSpan: null, start: null, value: null,
})

/** 几何用例自给的盒读数：jsdom 不做布局，滚动容器的可视高与目标段的位置都得自己造。 */
function rect(top: number, height: number): DOMRect {
  return {
    top, bottom: top + height, height, left: 0, right: 0, width: 0, x: 0, y: top,
    toJSON: () => ({}),
  }
}

beforeEach(() => {
  resetTtsPlayer()
  resetPanelShelf()
  FakeAudio.instances = []
  vi.stubGlobal('Audio', FakeAudio)
  vi.clearAllMocks()
  chapterNames = ['第一章', '第二章', '第三章']
  chapterTexts = [
    ['第一段。', '第二段。', '第三段。'],
    ['第二章第一段。', '第二章第二段。', '第二章第三段。'],
    ['第三章第一段。', '第三章第二段。'],
  ]
  richChapters = new Map()
  shelf = []
  vi.mocked(apiGet).mockImplementation(async (path: string) => {
    if (path.startsWith('navigation')) {
      const chapters = chapterEntries()
      return { chapters, items: planarNavigation(chapters) }
    }
    if (path.startsWith('chapter')) return contentOf(indexOf(path))
    if (path === ROUTES.shelf.path) return shelf
    if (path === ROUTES.ttsSources.path) return { sources: [], hostSpeech: { state: 'absent' } }
    throw new Error(`unexpected GET ${path}`)
  })
  vi.mocked(apiSend).mockImplementation(async (target: RouteTarget<WriteMethod>, body?: unknown) => {
    if (target.path === ROUTES.ttsSynthesize.path) {
      const text = ((body ?? {}) as { text?: string }).text ?? ''
      return { key: `k-${text}`, mediaType: 'audio/mpeg' }
    }
    if (target.path.startsWith('shelf/')) return {}
    throw new Error(`unexpected ${target.method} ${target.path}`)
  })
})

afterEach(() => {
  cleanup()
  resetTtsPlayer()
  vi.unstubAllGlobals()
})

describe('段号命中判据（高亮与定位共用）', () => {
  it('取最后一个 ≤ 段号的起点：一块占多个单元时段号在块区间内都归它', () => {
    expect(paragraphSlotOf([0, 2, 5], 0)).toBe(0)
    expect(paragraphSlotOf([0, 2, 5], 1)).toBe(0)
    expect(paragraphSlotOf([0, 2, 5], 2)).toBe(1)
    expect(paragraphSlotOf([0, 2, 5], 4)).toBe(1)
    expect(paragraphSlotOf([0, 2, 5], 5)).toBe(2)
    expect(paragraphSlotOf([0, 2, 5], 99)).toBe(2)
    // 段号在首块起点之前（被剥掉的章名占的单元）：屏上没有对应块
    expect(paragraphSlotOf([2, 4], 1)).toBe(-1)
    expect(paragraphSlotOf([], 0)).toBe(-1)
  })

  it('DOM 落点按 data-pidx 找块：量不到返回 null（调用方不动滚动）', () => {
    const block = document.createElement('div')
    for (const [pidx, text] of [['0', '甲'], ['2', '乙'], ['5', '丙']] as const) {
      const p = document.createElement('p')
      p.setAttribute('data-pidx', pidx)
      p.textContent = text
      block.appendChild(p)
    }
    expect(listenParagraphElement(block, 3)?.textContent).toBe('乙')
    expect(listenParagraphElement(block, 5)?.textContent).toBe('丙')
    const empty = document.createElement('div')
    expect(listenParagraphElement(empty, 0)).toBeNull()
  })

  it('坏 data-pidx 不参与命中：非整数只当这块没有起点，不许落到它上面', () => {
    const block = document.createElement('div')
    for (const [pidx, text] of [['0', '甲'], ['坏值', '蚀'], ['5', '丙']] as const) {
      const p = document.createElement('p')
      p.setAttribute('data-pidx', pidx)
      p.textContent = text
      block.appendChild(p)
    }
    // 段号 1 应落在起点 0 的块；坏值若被当成 NaN 起段号，会被误命中成「蚀」。
    expect(listenParagraphElement(block, 1)?.textContent).toBe('甲')
    expect(listenParagraphElement(block, 5)?.textContent).toBe('丙')
  })
})

describe('播放层 seek：章内段滑杆', () => {
  it('seekParagraph 跳到任意段并起播该段；位置落盘走会话自己的防抖节拍', async () => {
    await act(async () => {
      await startListening({ sourceId: 's1', bookKey: 'k1', title: '书一', chapterIndex: 0, paragraphIndex: 0 })
    })
    await act(async () => { seekParagraph(2) })
    expect(ttsPlayer.get()).toMatchObject({ chapterIndex: 0, paragraphIndex: 2, paragraphText: '第三段。' })
    expect(synthTexts()).toContain('第三段。')
    expect(progressBodies()).toEqual([])
  })

  it('seekParagraph 越界夹紧；同段不重合成；章正文在途不接、本段合成在途照跳', async () => {
    // 第二章给到 6 段：后面要取一个预取窗（后 2 段）外的落点，让合成请求真悬在闸上
    chapterTexts[1] = ['第二章一。', '第二章二。', '第二章三。', '第二章四。', '第二章五。', '第二章六。']
    await act(async () => {
      await startListening({ sourceId: 's1', bookKey: 'k1', title: '书一', chapterIndex: 0, paragraphIndex: 0 })
    })
    const before = synthTexts().length
    await act(async () => { seekParagraph(0) })
    expect(synthTexts().length).toBe(before)
    await act(async () => { seekParagraph(99) })
    expect(ttsPlayer.get().paragraphIndex).toBe(2)

    // 章正文在途（真窗口：把第二章正文的读取悬住）：段域还是上一章的读数，落点不接
    const realGet = vi.mocked(apiGet).getMockImplementation()
    if (realGet === undefined) throw new Error('apiGet 缺实现')
    let releaseChapter = (): void => { throw new Error('章正文闸未就绪') }
    const chapterGate = new Promise<void>((resolve) => { releaseChapter = resolve })
    vi.mocked(apiGet).mockImplementation(async (path: string) => {
      if (path.startsWith('chapter') && indexOf(path) === 1) await chapterGate
      return realGet(path)
    })
    const jumping = jumpToChapter(1)
    await act(async () => { await Promise.resolve() })
    expect(ttsPlayer.get().loading, '章正文在途').toBe(true)
    await act(async () => { seekParagraph(0) })
    expect(ttsPlayer.get().paragraphIndex, '章正文在途不接滑杆落点').toBe(2)
    releaseChapter()
    await act(async () => { await jumping })
    expect(ttsPlayer.get().chapterIndex).toBe(1)

    // 本段合成在途（loading=true，且不是章正文在途）：照跳——playSeq 会作废在途那一发。
    // 落点取预取窗外的段（只暖后 2 段），合成请求才真的悬在闸上而不是命中回执。
    const realSend = vi.mocked(apiSend).getMockImplementation()
    if (realSend === undefined) throw new Error('apiSend 缺实现')
    let releaseSynth = (): void => { throw new Error('合成闸未就绪') }
    const synthGate = new Promise<void>((resolve) => { releaseSynth = resolve })
    vi.mocked(apiSend).mockImplementation(async (target, body) => {
      if (target.path === ROUTES.ttsSynthesize.path) await synthGate
      return realSend(target, body)
    })
    await act(async () => { seekParagraph(5) })
    expect(ttsPlayer.get().loading, '本段合成在途').toBe(true)
    await act(async () => { seekParagraph(0) })
    expect(ttsPlayer.get().paragraphIndex, '本段合成在途照跳').toBe(0)
    releaseSynth()
    await act(async () => { await Promise.resolve() })
    vi.mocked(apiGet).mockImplementation(realGet)
    vi.mocked(apiSend).mockImplementation(realSend)
  })

  it('段进度只认活槽：timeupdate / metadata 投读数，预载槽的不投', async () => {
    await act(async () => {
      await startListening({ sourceId: 's1', bookKey: 'k1', title: '书一', chapterIndex: 0, paragraphIndex: 0 })
    })
    const [active, preload] = FakeAudio.instances
    expect(active).toBeDefined()
    act(() => {
      must(active, '活槽').duration = 12
      must(active, '活槽').currentTime = 3
      must(active, '活槽').ontimeupdate?.()
    })
    expect(ttsProgress.get()).toEqual({ position: 3, duration: 12 })
    act(() => {
      must(preload, '预载槽').duration = 99
      must(preload, '预载槽').currentTime = 50
      must(preload, '预载槽').onloadedmetadata?.()
    })
    expect(ttsProgress.get()).toEqual({ position: 3, duration: 12 })
  })

  it('换段归零段进度；停止归零；直出型没有计时介质', async () => {
    await act(async () => {
      await startListening({ sourceId: 's1', bookKey: 'k1', title: '书一', chapterIndex: 0, paragraphIndex: 0 })
    })
    const active = must(FakeAudio.instances[0], '活槽')
    act(() => { active.duration = 10; active.currentTime = 6; active.ontimeupdate?.() })
    expect(ttsProgress.get().position).toBe(6)
    await act(async () => { seekParagraph(1) })
    expect(ttsProgress.get()).toEqual({ position: 0, duration: 0 })

    vi.stubGlobal('speechSynthesis', new FakeSpeechSynthesis())
    await act(async () => {
      await startListening({
        sourceId: 's1', bookKey: 'k1', title: '书一', chapterIndex: 0, paragraphIndex: 0,
        engineId: 'browser:local',
      })
    })
    expect(ttsPlayer.get().mode).toBe('direct')
    expect(ttsProgress.get()).toEqual({ position: 0, duration: 0 })
  })

  it('jumpToChapter 换章从首段起播；选中当前章回本章首段；chapterNames 随会话在场', async () => {
    await act(async () => {
      await startListening({ sourceId: 's1', bookKey: 'k1', title: '书一', chapterIndex: 0, paragraphIndex: 1 })
    })
    expect(ttsPlayer.get().chapterNames).toEqual(['第一章', '第二章', '第三章'])
    await act(async () => { void jumpToChapter(2) })
    expect(ttsPlayer.get()).toMatchObject({ chapterIndex: 2, paragraphIndex: 0, paragraphText: '第三章第一段。' })
    await act(async () => { void jumpToChapter(2) })
    expect(ttsPlayer.get().paragraphIndex).toBe(0)
    await act(async () => { void jumpToChapter(0) })
    expect(ttsPlayer.get()).toMatchObject({ chapterIndex: 0, paragraphIndex: 0 })
    expect(progressBodies()).toEqual([])
  })
})

describe('从本段听：选区落点归阅读器一处（监听不按已载章数长）', () => {
  it('选中正文段 → 浮钮 → 从该段起播：章身份与段号都取自 DOM 归属', async () => {
    const deps = readerDeps()
    const { container } = renderReader(deps)
    await waitFor(() => expect(container.querySelector('[data-chapter="0"]')).not.toBeNull())
    const p = must(container.querySelector<HTMLElement>('[data-chapter="0"] [data-pidx="1"]'), '第二章段')
    const range = document.createRange()
    range.selectNodeContents(p)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    fireEvent.mouseUp(p)

    const button = await screen.findByRole('button', { name: '从本段听' })
    await act(async () => { fireEvent.click(button) })
    await waitFor(() => expect(ttsPlayer.get().active).toBe(true))
    expect(ttsPlayer.get()).toMatchObject({ bookKey: 'k1', chapterIndex: 0, paragraphIndex: 1 })
    expect(screen.queryByRole('button', { name: '从本段听' }), '起播后浮钮收起').toBeNull()
  })
})

describe('听书条与迷你条的进度面', () => {
  it('听书条只有章内滑杆：拖到任意段即起播，段内时间滑杆不再上条', async () => {
    const deps = readerDeps()
    const { container } = renderReader(deps)
    await waitFor(() => expect(container.querySelector('[data-chapter="0"]')).not.toBeNull())
    await act(async () => {
      await startListening({ sourceId: 's1', bookKey: 'k1', title: '书一', chapterIndex: 0, paragraphIndex: 0 })
    })
    const chapterSlider = screen.getByLabelText('章内进度')
    expect(chapterSlider.getAttribute('max')).toBe('2')
    await act(async () => { fireEvent.change(chapterSlider, { target: { value: '2' } }) })
    expect(ttsPlayer.get().paragraphIndex).toBe(2)

    // 字节型计时到场也不摆第二条进度（ADR-0075）：条上只有章内这一条
    const active = must(FakeAudio.instances[0], '活槽')
    act(() => { active.duration = 20; active.onloadedmetadata?.() })
    expect(screen.queryByLabelText('本段进度')).toBeNull()
    // 正向读数：条上 range 只有章内这一条——段内时间滑杆若回来，条数会变 2，这条当场红
    expect(container.querySelectorAll('.novel-tts-bar input[type="range"]'), '条上只剩章内一条滑杆').toHaveLength(1)
  })

  it('设置面板的起播章选择列出全章，换选即换章起播', async () => {
    const deps = readerDeps()
    const { container } = renderReader(deps)
    await waitFor(() => expect(container.querySelector('[data-chapter="0"]')).not.toBeNull())
    await act(async () => {
      await startListening({ sourceId: 's1', bookKey: 'k1', title: '书一', chapterIndex: 0, paragraphIndex: 0 })
    })
    fireEvent.click(screen.getByRole('button', { name: '听书设置' }))
    const select = screen.getByLabelText('起播章')
    expect([...select.querySelectorAll('option')].map((o) => o.textContent))
      .toEqual(['第 1 章 第一章', '第 2 章 第二章', '第 3 章 第三章'])
    await act(async () => { fireEvent.change(select, { target: { value: '1' } }) })
    expect(ttsPlayer.get()).toMatchObject({ chapterIndex: 1, paragraphIndex: 0 })
  })

  it('迷你条只有章内进度条：拖动即跳段，本段时间滑杆不再出现', async () => {
    render(createElement(TtsMiniBar, { focusPanel: vi.fn() }))
    await act(async () => {
      await startListening({ sourceId: 's1', bookKey: 'k1', title: '书一', chapterIndex: 0, paragraphIndex: 0 })
    })
    // 缺省是胶囊：章内进度在展开的边栏上，先点开
    fireEvent.click(screen.getByRole('button', { name: /展开迷你条/ }))
    expect(screen.queryByLabelText('本段进度')).toBeNull()
    const chapterSlider = screen.getByLabelText('章内进度')
    expect(chapterSlider.getAttribute('max'), '连续刻度整条 = 本章').toBe('3')
    await act(async () => { fireEvent.change(chapterSlider, { target: { value: '2.4' } }) })
    expect(ttsPlayer.get().paragraphIndex, '落点 floor 到所在段').toBe(2)
    await act(async () => { fireEvent.keyDown(chapterSlider, { key: 'ArrowLeft' }) })
    expect(ttsPlayer.get().paragraphIndex, '方向键按段走').toBe(1)

    // 字节型计时到场也不在浮窗上摆段内滑杆（浮窗与条同口径，ADR-0074 / ADR-0075）
    const active = must(FakeAudio.instances[0], '活槽')
    act(() => { active.duration = 8; active.onloadedmetadata?.() })
    expect(screen.queryByLabelText('本段进度')).toBeNull()

    vi.stubGlobal('speechSynthesis', new FakeSpeechSynthesis())
    await act(async () => {
      await startListening({
        sourceId: 's1', bookKey: 'k1', title: '书一', chapterIndex: 0, paragraphIndex: 0,
        engineId: 'browser:local',
      })
    })
    // 直出型仍可用章内进度条：它只读段号，不依赖计时介质
    expect(screen.getByLabelText('章内进度')).not.toBeNull()
    expect(screen.queryByLabelText('本段进度')).toBeNull()
  })

  it('章内滑杆受控值夹在 max=count-1：末段念到段尾也不把越界值写进控件', () => {
    // 末段 + 段内比例 1 → 连续 value = count（就是那一下越界）
    act(() => { ttsProgress.set({ position: 12, duration: 12 }) })
    act(() => {
      ttsPlayer.set({
        ...ttsPlayer.get(),
        active: true, bookKey: 'k1', sourceId: 's1', title: '书一',
        chapterIndex: 0, chapterNames: ['第一章', '第二章', '第三章'], paragraphCount: 3, paragraphIndex: 2,
        paragraphText: '第三段。', playing: true, mode: 'bytes',
      })
    })
    // 监听受控写入：原生 range 会把越界值静默夹到 max，但写进去的那一个才是受控值与读屏读数
    const valueSpy = vi.spyOn(HTMLInputElement.prototype, 'value', 'set')
    try {
      render(createElement(TtsBar, {
        darkController: false, apiGet: async () => [] as never, pushError: () => {}, onLocate: () => {},
      }))
      const slider = must(screen.getByLabelText<HTMLInputElement>('章内进度'), '章内滑杆')
      expect(slider.getAttribute('max')).toBe('2')
      const assigned = valueSpy.mock.calls.map(([value]) => value)
      expect(assigned, '滑杆的 domain 是 0..count-1，不许写 count').not.toContain('3')
      expect(slider.value).toBe('2')
    } finally {
      valueSpy.mockRestore()
    }
    act(() => { ttsProgress.set({ position: 0, duration: 0 }) })
  })

  it('连续失败到阈值且暂停：条上给一行 role=status 读数，真开口后消失', () => {
    act(() => {
      ttsPlayer.set({
        ...ttsPlayer.get(),
        active: true, bookKey: 'k1', sourceId: 's1', title: '书一',
        chapterIndex: 0, chapterNames: ['第一章', '第二章', '第三章'], paragraphCount: 3, paragraphIndex: 1,
        paragraphText: '第二段。', playing: false, mode: 'bytes',
        consecutiveFailures: TTS_MAX_CONSECUTIVE_FAILURES,
        halt: { reason: 'consecutive-failures', failures: TTS_MAX_CONSECUTIVE_FAILURES },
      })
    })
    render(createElement(TtsBar, {
      darkController: false, apiGet: async () => [] as never, pushError: () => {}, onLocate: () => {},
    }))
    const status = screen.getByRole('status')
    expect(status.textContent).toContain('连续 5 段播放失败，已暂停')
    expect(status.textContent, '错误码翻人话，不裸露 TTS_*').not.toContain('TTS_')

    // 未到线不报（没有停因就没有这一行）
    act(() => {
      ttsPlayer.set({ ...ttsPlayer.get(), consecutiveFailures: TTS_MAX_CONSECUTIVE_FAILURES - 1, halt: null })
    })
    expect(screen.queryByRole('status')).toBeNull()

    // 真开口（计数清零 + 在放）后提示自然消失
    act(() => { ttsPlayer.set({ ...ttsPlayer.get(), consecutiveFailures: 0, playing: true }) })
    expect(screen.queryByRole('status')).toBeNull()
  })
})

describe('跟读高亮：只标记不滚动（高亮不写位置）', () => {
  it('文字章：高亮跟着段号走，换章后旧章不留高亮', async () => {
    const deps = readerDeps()
    const { container } = renderReader(deps)
    await waitFor(() => expect(container.querySelector('[data-chapter="0"]')).not.toBeNull())
    await act(async () => {
      await startListening({ sourceId: 's1', bookKey: 'k1', title: '书一', chapterIndex: 0, paragraphIndex: 0 })
    })
    const liveOf = (): Element | null => container.querySelector('.novel-tts-live')
    expect(liveOf()?.getAttribute('data-pidx')).toBe('0')
    await act(async () => { seekParagraph(1) })
    expect(liveOf()?.getAttribute('data-pidx')).toBe('1')
    expect(container.querySelectorAll('.novel-tts-live')).toHaveLength(1)
    await act(async () => { void jumpToChapter(1) })
    await waitFor(() => expect(container.querySelector('[data-chapter="1"]')).not.toBeNull())
    expect(liveOf()?.closest('[data-chapter="1"]')).not.toBeNull()
    expect(liveOf()?.getAttribute('data-pidx')).toBe('0')
    // 高亮与 seek 不直接写阅读进度；会话的位置落盘走自己的防抖节拍（本窗口还没到点）
    expect(progressBodies()).toEqual([])
  })

  it('高亮不加底色、不画段内进度线，直出型同样标记', async () => {
    const deps = readerDeps()
    const { container } = renderReader(deps)
    await waitFor(() => expect(container.querySelector('[data-chapter="0"]')).not.toBeNull())
    await act(async () => {
      await startListening({ sourceId: 's1', bookKey: 'k1', title: '书一', chapterIndex: 0, paragraphIndex: 0 })
    })
    const live = must(container.querySelector<HTMLElement>('.novel-tts-live'), '命中段')
    expect(live.classList.contains('novel-tts-live')).toBe(true)
    // 字节型计时到场也不长出第二条进度（ADR-0076：段内没有逐字时间戳，不画进度）
    const active = must(FakeAudio.instances[0], '活槽')
    act(() => { active.duration = 10; active.currentTime = 5; active.ontimeupdate?.() })
    // 正向读数：高亮段内没有子元素——段内进度线若回来必是子元素，这条当场红
    expect(live.querySelectorAll('*'), '命中段内不塞进度节点（ADR-0076）').toHaveLength(0)

    // 直出型没有计时介质，同样标记（标记不依赖任何进度读数）
    vi.stubGlobal('speechSynthesis', new FakeSpeechSynthesis())
    await act(async () => {
      await startListening({
        sourceId: 's1', bookKey: 'k1', title: '书一', chapterIndex: 0, paragraphIndex: 0,
        engineId: 'browser:local',
      })
    })
    expect(container.querySelector('.novel-tts-live')).not.toBeNull()
    const directLive = must(container.querySelector('.novel-tts-live'), '直出型命中段')
    expect(directLive.querySelectorAll('*'), '直出型高亮段内同样不塞进度节点').toHaveLength(0)
  })

  it('图文章：高亮落在命中的块上（行清单口径），表格块同样标记', async () => {
    richChapters.set(0, {
      kind: 'rich',
      documentId: 'd1',
      nodes: [
        paragraph('n1', '第一块。'),
        paragraph('n2', '第二块。'),
        {
          kind: 'element', id: 't1', tag: 'table', children: [
            {
              kind: 'element', id: 'b1', tag: 'tbody', children: [
                {
                  kind: 'element', id: 'r1', tag: 'tr', children: [
                    { kind: 'element', id: 'c1', tag: 'td', children: [{ kind: 'text', text: '表行。' }], rowSpan: null, colSpan: null, start: null, value: null },
                  ], rowSpan: null, colSpan: null, start: null, value: null,
                },
              ], rowSpan: null, colSpan: null, start: null, value: null,
            },
          ], rowSpan: null, colSpan: null, start: null, value: null,
        },
      ],
    })
    const deps = readerDeps()
    const { container } = renderReader(deps)
    await waitFor(() => expect(container.querySelector('[data-chapter="0"]')).not.toBeNull())
    await act(async () => {
      await startListening({ sourceId: 's1', bookKey: 'k1', title: '书一', chapterIndex: 0, paragraphIndex: 1 })
    })
    const live = must(container.querySelector('.novel-tts-live'), '图文高亮块')
    expect(live.getAttribute('data-novel-node')).toBe('n2')
    // 表行是第三个播放单元：高亮进表，但不往任何块里塞进度节点（ADR-0076）
    await act(async () => { seekParagraph(2) })
    const tableLive = must(container.querySelector('.novel-tts-live'), '表格高亮块')
    expect(tableLive.closest('table'), '高亮落在表内的行块上').not.toBeNull()
    expect(progressBodies()).toEqual([])
  })

  it('跟读字色跟着纸张色走：换纸后阅读区根上的 --novel-live-ink 现算', async () => {
    const deps = readerDeps()
    const { container } = renderReader(deps)
    const root = must(container.querySelector<HTMLElement>('.novel-rdr'), '阅读器根')
    expect(root.style.getPropertyValue('--novel-live-ink')).toBe(paperLiveInk(DEFAULT_PREFS.paperColor))
    const prev = prefsStore.get()
    try {
      await act(async () => { prefsStore.set({ ...prev, paperColor: '#1e1e1e' }) })
      expect(root.style.getPropertyValue('--novel-live-ink'), '深纸换成深纸那一档').toBe(paperLiveInk('#1e1e1e'))
    } finally {
      await act(async () => { prefsStore.set(prev) })
    }
  })

  it('跟读标记 = 换字色 + 段首小三角（纯换色在部分纸色下认不出，ADR-0076）', () => {
    // jsdom 不做样式级联与排版，量不到三角画没画——这里钉 CSS 契约本身：
    // 命中段带 ::before 字形标记（currentColor 跟着 --novel-live-ink 走），且只许浮在框外。
    // 先剥注释：样式注释里写着 `.novel-tts-live::before` 这类选择器名，照扫即误配。
    const css = NOVEL_CSS.replace(/\/\*[\s\S]*?\*\//g, '')
    const before = pick(must(/\.novel-tts-live::before\s*\{([^}]*)\}/.exec(css), '命中段有 ::before 标记规则'), 1)
    expect(before).toMatch(/position:\s*absolute/)
    expect(before).toMatch(/border-left:[^;]*solid currentColor/)
    // 绝对定位必须有锚：命中块自己 relative，否则会飘到页面根上（几何门量的是真渲染）
    const live = pick(must(/\.novel-tts-live\s*\{([^}]*)\}/.exec(css), '.novel-tts-live 本体设了相对定位'), 1)
    expect(live).toMatch(/position:\s*relative/)
  })

  it('「定位到正在念的段」是显式动作：不点不滚，点了把滚动容器移到目标段', async () => {
    // jsdom 没有布局：造一个真的滚动容器（可滚样式 + 量出来的可视高 / 内容高），
    // 阅读器的 findScrollport 才会认它；否则 port 是 null，按钮按了也只是空转。
    const scrollport = document.createElement('div')
    scrollport.style.overflowY = 'auto'
    Object.defineProperty(scrollport, 'clientHeight', { value: 600, configurable: true })
    Object.defineProperty(scrollport, 'scrollHeight', { value: 3000, configurable: true })
    document.body.append(scrollport)

    const deps = readerDeps()
    const { container } = render(
      createElement(ReaderView, { sourceId: 's1', bookKey: 'k1', title: '书一', deps }),
      { container: scrollport },
    )
    await waitFor(() => expect(container.querySelector('[data-chapter="0"]')).not.toBeNull())
    await act(async () => {
      await startListening({ sourceId: 's1', bookKey: 'k1', title: '书一', chapterIndex: 0, paragraphIndex: 1 })
    })

    // 「不点不滚」：高亮在场不等于视野会自己跟过去（ADR-0071 的只标记不滚动）。
    expect(scrollport.scrollTop).toBe(0)

    // 目标章已在已载窗口内：按钮只滚阅读滚动容器自己，把正在念的那一段居中。
    vi.spyOn(scrollport, 'getBoundingClientRect').mockReturnValue(rect(0, 600))
    const target = must(
      container.querySelector<HTMLElement>('[data-chapter="0"] [data-pidx="1"]'), '正在念的段',
    )
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(rect(500, 20))
    const locate = screen.getByRole('button', { name: '定位到正在念的段' })
    await act(async () => { fireEvent.click(locate) })
    expect(scrollport.scrollTop).toBe(210)

    // jsdom 的程序化 scrollTop 写入不派发 scroll 事件，所以这里量不到随后的进度落盘。
    // 与 ADR-0071 一致：定位是用户主动导航，落进度是它自己的语义——那份证据由 tts-bar 的
    // 未载章用例（requestJump 当场写 progress）承担；本文件不断言「定位不写进度」。
  })
})