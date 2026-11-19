// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { ROUTES, TTS_RATE, planarNavigation } from '../../src/shared/wire.js'
import type {
  ChapterContent, ChapterEntry, RouteTarget, ShelfEntry, TtsSourceInfo, WriteMethod,
} from '../../src/shared/wire.js'
import { apiGet, apiSend } from '../../src/client/api.js'
import { panelShelf, resetPanelShelf } from '../../src/client/panel-shelf.js'
import { resetTtsPlayerForTests, seekParagraph, setListenRate, setListenTimer, startListening, ttsPlayer } from '../../src/client/tts/player.js'
import { RATE_STEPS } from '../../src/client/tts/TtsBar.js'
import { useDirectVoices } from '../../src/client/tts/TtsSettings.js'
import { readingPositionAt, readingProbeNow, setReadingProbe } from '../../src/client/tts/reading-position.js'
import { ReaderView } from '../../src/client/views/ReaderView.js'
import { makeReaderDeps } from './fake-deps.js'
import type { DepsOverrides, FakeReaderDeps } from './fake-deps.js'
import { must } from '../support/fixture.js'
import { FakeAudio, FakeSpeechSynthesis, FakeUtterance, FakeVoice } from './tts-fakes.js'

/**
 * 阅读器听书集成的行为网：真播放层（模块级 store/动作）+ 真 ReaderView/ChapterBody，
 * mock 掉 `/novel-api`、`Audio` 与（直出用例的）`speechSynthesis`。
 *
 * 这一层钉的是**接线**：pill 的续听语义、条的读数与设置面板、选区起播、阅读探针注册、
 * 音色行的「不可用不渲染」与错误码 → 文案。播放层自身的行为网在 tts-player / tts-direct。
 */
vi.mock('../../src/client/api.js', () => ({
  apiGet: vi.fn(),
  apiSend: vi.fn(),
  apiUpload: vi.fn(),
  apiEventStream: vi.fn(),
  describeError: (error: unknown): string => (error instanceof Error ? error.message : String(error)),
}))

const chapter = (name: string): ChapterEntry => ({ name, url: name })

let chapterNames: string[]
let chapterTexts: string[][]
let shelf: ShelfEntry[]
let ttsSources: TtsSourceInfo[]

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

/** 阅读器一侧的依赖：目录/正文/书架/引擎清单都走它（与播放层各自 mock 的 `api.js` 同源读数）。
 *  `chapterGates` = 按章号挂住的正文读取（演「该章还没载」；用例自己放行）。 */
function readerDeps(
  over: DepsOverrides = {},
  chapterGates: ReadonlyMap<number, Promise<void>> = new Map(),
): FakeReaderDeps {
  return makeReaderDeps({
    apiGet: vi.fn(async (path: string) => {
      if (path.startsWith('navigation')) {
        const chapters = chapterNames.map((name) => chapter(name))
        return { chapters, items: planarNavigation(chapters) }
      }
      if (path.startsWith('chapter')) {
        const gate = chapterGates.get(indexOf(path))
        if (gate !== undefined) await gate
        return { kind: 'text', text: textOf(indexOf(path)) } satisfies ChapterContent
      }
      if (path === ROUTES.ttsSources.path) return { sources: ttsSources, hostSpeech: { state: 'absent' } }
      return shelf
    }),
    ...over,
  })
}

function renderReader(deps: FakeReaderDeps): ReturnType<typeof render> {
  return render(createElement(ReaderView, { sourceId: 's1', bookKey: 'k1', title: '书一', deps }))
}

function shelfPuts(): Record<string, unknown>[] {
  return vi.mocked(apiSend).mock.calls
    .filter(([target]) => target.path.startsWith('shelf/'))
    .map(([, body]) => (body ?? {}) as Record<string, unknown>)
}

/** 交给合成口的文本（按调用序）：pill 的暂停 / 继续不该重新取段音频。 */
function synthTexts(): string[] {
  return vi.mocked(apiSend).mock.calls
    .filter(([target]) => target.path === ROUTES.ttsSynthesize.path)
    .map(([, body]) => ((body ?? {}) as { text?: string }).text ?? '')
}

/** 单章夹具：jsdom 没有布局，滚动/预取判据会把「当前章」推到已载的最后一章；只测 pill 的
 *  「当前章 0 段」时把书目收成一章，读数才不依赖几何桩。 */
function singleChapter(): void {
  chapterNames = ['第一章']
  chapterTexts = [['第一段。', '第二段。', '第三段。']]
}

function rect(top: number, height: number): DOMRect {
  return {
    top, bottom: top + height, height, left: 0, right: 0, width: 0, x: 0, y: top,
    toJSON: () => ({}),
  }
}

/** jsdom 没有布局：把所有段顶都算成 0 会让阅读探针落到本章最后一段。把视口顶钉在首段上，
 *  pill 的起播位置才不受几何噪声影响（需要别的段落时用例自己再覆盖）。 */
function pinFirstParagraph(container: HTMLElement): void {
  const block = must(container.querySelector<HTMLElement>('[data-chapter="0"]'), 'chapter block')
  const ps = [...block.querySelectorAll('p[data-pidx]')] as HTMLElement[]
  vi.spyOn(block, 'getBoundingClientRect').mockReturnValue(rect(0, 2000))
  vi.spyOn(must(ps[0], 'p0'), 'getBoundingClientRect').mockReturnValue(rect(0, 20))
  vi.spyOn(must(ps[1], 'p1'), 'getBoundingClientRect').mockReturnValue(rect(20, 20))
  vi.spyOn(must(ps[2], 'p2'), 'getBoundingClientRect').mockReturnValue(rect(40, 20))
}

beforeEach(() => {
  resetTtsPlayerForTests()
  resetPanelShelf()
  setReadingProbe(null)
  FakeAudio.reset()
  vi.stubGlobal('Audio', FakeAudio)
  vi.clearAllMocks()
  chapterNames = ['第一章', '第二章']
  chapterTexts = [['第一段。', '第二段。', '第三段。'], ['第二章第一段。', '第二章第二段。']]
  shelf = []
  ttsSources = [{ id: 'builtin:baidu', kind: 'builtin' }]

  vi.mocked(apiGet).mockImplementation(async (path: string) => {
    if (path.startsWith('navigation')) {
      return { chapters: chapterNames.map((name) => chapter(name)), items: [] }
    }
    if (path.startsWith('chapter')) return { kind: 'text', text: textOf(indexOf(path)) }
    if (path === ROUTES.shelf.path) return shelf
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
  resetTtsPlayerForTests()
  setReadingProbe(null)
  vi.unstubAllGlobals()
})

describe('听书 pill：起播与续听', () => {
  it('无存档 → 从阅读器此刻看得见的段起播', async () => {
    singleChapter()
    const deps = readerDeps()
    const { container } = renderReader(deps)
    await waitFor(() => expect(container.querySelector('[data-chapter="0"]')).not.toBeNull())

    pinFirstParagraph(container)

    fireEvent.click(screen.getByRole('button', { name: '听书' }))
    await waitFor(() => expect(ttsPlayer.get().active).toBe(true))
    expect(ttsPlayer.get()).toMatchObject({
      bookKey: 'k1', sourceId: 's1', title: '书一', chapterIndex: 0, paragraphIndex: 0,
    })
  })

  it('有 listen 存档 → 位置跟阅读器走，引擎/音色/语速/音量仍走存档回退链', async () => {
    singleChapter()
    shelf = [shelfEntry({
      listen: {
        chapterIndex: 1, paragraphIndex: 1, engineId: 'http:book', voice: 'vb',
        rate: 1.6, volume: 0.3,
      },
    })]
    const deps = readerDeps()
    const { container } = renderReader(deps)
    await waitFor(() => expect(container.querySelector('[data-chapter="0"]')).not.toBeNull())
    await waitFor(() => expect(panelShelf.get().books).not.toBeNull())

    pinFirstParagraph(container)

    fireEvent.click(screen.getByRole('button', { name: '听书' }))
    await waitFor(() => expect(ttsPlayer.get().active).toBe(true))
    expect(ttsPlayer.get()).toMatchObject({
      // 位置来自阅读器（第 0 章第 0 段），不被更早的听书存档拽回/拽走
      chapterIndex: 0, paragraphIndex: 0,
      // 播放参数仍按本书 listen 存档回退
      engineId: 'http:book', voice: 'vb', rate: 1.6, volume: 0.3,
    })
  })

  it('播放中条渲染段读数与当前段预览', async () => {
    singleChapter()
    const deps = readerDeps()
    const { container } = renderReader(deps)
    await waitFor(() => expect(container.querySelector('[data-chapter="0"]')).not.toBeNull())
    pinFirstParagraph(container)

    fireEvent.click(screen.getByRole('button', { name: '听书' }))
    await waitFor(() => expect(ttsPlayer.get().playing).toBe(true))
    const bar = must(container.querySelector<HTMLElement>('.novel-tts-bar'), 'tts bar')
    expect(bar.textContent).toContain('第 1 / 3 段')
    expect(bar.textContent).toContain('第一段。')
  })

  it('本书正在听时 pill 是暂停 / 继续：再按不重置位置、不重新起播', async () => {
    singleChapter()
    const deps = readerDeps()
    const { container } = renderReader(deps)
    await waitFor(() => expect(container.querySelector('[data-chapter="0"]')).not.toBeNull())
    pinFirstParagraph(container)

    fireEvent.click(screen.getByRole('button', { name: '听书' }))
    await waitFor(() => expect(ttsPlayer.get().playing).toBe(true))
    await act(async () => { seekParagraph(2) })
    await waitFor(() => expect(ttsPlayer.get().playing).toBe(true))
    expect(ttsPlayer.get()).toMatchObject({ chapterIndex: 0, paragraphIndex: 2 })

    // 第一次再按 = 暂停：会话还在，段号不动；暂停走 pauseListening 而不是第二次 startListening。
    fireEvent.click(screen.getByRole('button', { name: '听书' }))
    expect(ttsPlayer.get()).toMatchObject({ active: true, playing: false, paragraphIndex: 2 })
    const synthAfterPause = synthTexts().length

    // 第二次再按 = 继续：仍是第 2 段（不回 0、不改章），已取到的段音频原地续播、不重新合成。
    fireEvent.click(screen.getByRole('button', { name: '听书' }))
    await waitFor(() => expect(ttsPlayer.get().playing).toBe(true))
    expect(ttsPlayer.get()).toMatchObject({ chapterIndex: 0, paragraphIndex: 2 })
    expect(synthTexts().length).toBe(synthAfterPause)
  })
})

describe('设置面板', () => {
  it('改语速 → setListenRate 并随位置落盘写回 listen 支', async () => {
    singleChapter()
    const deps = readerDeps()
    const { container } = renderReader(deps)
    await waitFor(() => expect(container.querySelector('[data-chapter="0"]')).not.toBeNull())
    pinFirstParagraph(container)

    fireEvent.click(screen.getByRole('button', { name: '听书' }))
    await waitFor(() => expect(ttsPlayer.get().playing).toBe(true))

    fireEvent.click(screen.getByRole('button', { name: '听书设置' }))
    // 面板的其余入口都在场：音量、跳章、「从阅读位置起播」（引擎选择是 select）
    expect(screen.getByLabelText('音量')).toBeTruthy()
    expect(screen.getByLabelText('引擎')).toBeTruthy()
    expect(screen.getByRole('button', { name: '上一章' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '下一章' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '从阅读位置起播' })).toBeTruthy()
    // 浮窗尺寸是浮窗自己的现场，不投影给阅读器条（ADR-0080）
    expect(screen.queryByText('浮窗大小')).toBeNull()
    const slider = screen.getByLabelText('语速')
    fireEvent.change(slider, { target: { value: '1.5' } })
    expect(ttsPlayer.get().rate).toBe(1.5)

    // pause 立即 flush 防抖中的位置（不拿墙钟等 2s 防抖窗）：listen 与 progress 各一笔
    fireEvent.click(screen.getByRole('button', { name: '暂停' }))
    const puts = shelfPuts()
    const listen = must(puts.find((body) => 'listen' in body), 'listen body').listen as Record<string, unknown>
    expect(listen.rate).toBe(1.5)
    expect(must(puts.find((body) => 'progress' in body), 'progress body').progress).toEqual({
      chapterIndex: 0, offsetRatio: 0,
    })
  })

  it('设置面板走共享浮层契约：入场焦点在面板内，Esc 关闭并还焦触发钮', async () => {
    singleChapter()
    const deps = readerDeps()
    const { container } = renderReader(deps)
    await waitFor(() => expect(container.querySelector('[data-chapter="0"]')).not.toBeNull())
    fireEvent.click(screen.getByRole('button', { name: '听书' }))
    await waitFor(() => expect(ttsPlayer.get().playing).toBe(true))

    const opener = screen.getByRole('button', { name: '听书设置' })
    opener.focus()
    fireEvent.click(opener)
    const panel = screen.getByRole('dialog', { name: '听书设置' })
    expect(panel.contains(document.activeElement)).toBe(true)

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: '听书设置' })).toBeNull()
    expect(document.activeElement).toBe(opener)
  })

  it('设置卡头行：左边是可见卡名、右边是关闭钮，卡名就是 dialog 的无障碍名', async () => {
    singleChapter()
    const { container } = renderReader(readerDeps())
    await waitFor(() => expect(container.querySelector('[data-chapter="0"]')).not.toBeNull())
    fireEvent.click(screen.getByRole('button', { name: '听书' }))
    await waitFor(() => expect(ttsPlayer.get().playing).toBe(true))
    fireEvent.click(screen.getByRole('button', { name: '听书设置' }))

    const panel = screen.getByRole('dialog', { name: '听书设置' })
    const title = panel.querySelector('.novel-tts-panel-title')
    expect(title?.textContent, '头行左侧不是空白').toBe('听书设置')
    // 头行两件是兄弟：卡名在前、关闭钮在后（右上角孤零零一颗 X 就是这里缺了标题）
    const close = screen.getByRole('button', { name: '关闭听书设置' })
    expect(title?.nextElementSibling).toBe(close)
    expect(panel.getAttribute('aria-labelledby')).toBe(title?.id)
  })

  it('引擎源没有 voices → 音色行不渲染', async () => {
    singleChapter()
    const deps = readerDeps()
    const { container } = renderReader(deps)
    await waitFor(() => expect(container.querySelector('[data-chapter="0"]')).not.toBeNull())
    fireEvent.click(screen.getByRole('button', { name: '听书' }))
    await waitFor(() => expect(ttsPlayer.get().playing).toBe(true))
    fireEvent.click(screen.getByRole('button', { name: '听书设置' }))

    await screen.findByRole('option', { name: '内置朗读' })
    expect(screen.queryByLabelText('音色')).toBeNull()
  })

  it('定时器档位归会话：条卸载再挂回来，chip 仍显示已定的那一档', async () => {
    singleChapter()
    const { container } = renderReader(readerDeps())
    await waitFor(() => expect(container.querySelector('[data-chapter="0"]')).not.toBeNull())
    fireEvent.click(screen.getByRole('button', { name: '听书' }))
    await waitFor(() => expect(ttsPlayer.get().playing).toBe(true))
    setListenTimer('chapter')

    // 宿主切走面板 = 阅读器子树整棵卸载；会话与定时器按 ADR-0072 留在场
    cleanup()
    const again = renderReader(readerDeps())
    await waitFor(() => expect(again.container.querySelector('[data-chapter="0"]')).not.toBeNull())
    fireEvent.click(screen.getByRole('button', { name: '听书设置' }))

    // 档位只存在 ttsPlayer 里；组件本地态会在重挂时归零，chip 就说谎成「没定」。
    // 查询收进面板内：条上的定时读数与面板里的档位 chip 会给出同一段文字，全局查会撞。
    expect(ttsPlayer.get().timerChoice).toBe('chapter')
    const panel = screen.getByRole('dialog', { name: '听书设置' })
    const chapterChip = [...panel.querySelectorAll('button')].find((b) => b.textContent === '本章结束')
    expect(chapterChip?.getAttribute('aria-pressed')).toBe('true')
  })

  /** 行为裁决（本计划明列的唯一行为变化）：条上的定时 chip 从「只显档位」改为与浮窗同一读数
   *  ——计时中显倒计时、否则档位。两个表面同一件事一个读数，不再各说各话。 */
  it('定时 chip 与浮窗同一读数：计时中显倒计时、否则档位', async () => {
    singleChapter()
    const { container } = renderReader(readerDeps())
    await waitFor(() => expect(container.querySelector('[data-chapter="0"]')).not.toBeNull())
    fireEvent.click(screen.getByRole('button', { name: '听书' }))
    await waitFor(() => expect(ttsPlayer.get().playing).toBe(true))

    expect(screen.getByTitle('定时').textContent, '没定 → 显「定时」').toBe('定时')
    act(() => { setListenTimer(15) })
    expect(screen.getByTitle('定时').textContent, '计时中 → 倒计时 m:ss，不再只显档位')
      .toMatch(/^\d+:\d{2}$/)
    expect(screen.getByTitle('定时').textContent).not.toBe('15 分')
    act(() => { setListenTimer('chapter') })
    expect(screen.getByTitle('定时').textContent, '本章档没有到点时刻，不倒计时').toBe('本章结束')
    act(() => { setListenTimer(null) })
    expect(screen.getByTitle('定时').textContent, '取消定时回档位空缺').toBe('定时')
  })

  it('引擎清单每次打开设置都重取：配置页新增订阅不靠组件重挂', async () => {
    singleChapter()
    ttsSources = [{ id: 'builtin:baidu', kind: 'builtin' }]
    const deps = readerDeps()
    const { container } = renderReader(deps)
    await waitFor(() => expect(container.querySelector('[data-chapter="0"]')).not.toBeNull())
    fireEvent.click(screen.getByRole('button', { name: '听书' }))
    await waitFor(() => expect(ttsPlayer.get().playing).toBe(true))

    fireEvent.click(screen.getByRole('button', { name: '听书设置' }))
    const select = await screen.findByLabelText<HTMLSelectElement>('引擎')
    await waitFor(() => expect([...select.options].some((o) => o.textContent === '内置朗读')).toBe(true))

    fireEvent.click(screen.getByRole('button', { name: '听书设置' }))
    ttsSources = [
      ...ttsSources,
      { id: 'http:new', kind: 'http', name: '新订阅' },
    ]
    fireEvent.click(screen.getByRole('button', { name: '听书设置' }))
    await waitFor(() => expect(
      [...screen.getByLabelText<HTMLSelectElement>('引擎').options].some((o) => o.textContent === '新订阅'),
    ).toBe(true))
  })

  it('引擎源带 voices → 音色行渲染并可选', async () => {
    singleChapter()
    ttsSources = [{
      id: 'builtin:baidu', kind: 'builtin',
      voices: [{ id: 'v1', name: '男声一' }],
    }]
    const deps = readerDeps()
    const { container } = renderReader(deps)
    await waitFor(() => expect(container.querySelector('[data-chapter="0"]')).not.toBeNull())
    fireEvent.click(screen.getByRole('button', { name: '听书' }))
    await waitFor(() => expect(ttsPlayer.get().playing).toBe(true))
    fireEvent.click(screen.getByRole('button', { name: '听书设置' }))
    const voice = await screen.findByLabelText('音色')
    fireEvent.change(voice, { target: { value: 'v1' } })
    expect(ttsPlayer.get().voice).toBe('v1')
  })

  it('直出模式音色行读 browserTtsVoices()', async () => {
    singleChapter()
    const synth = new FakeSpeechSynthesis()
    synth.voices = [new FakeVoice('bv1', '本地女声', 'zh-CN')]
    vi.stubGlobal('speechSynthesis', synth)
    vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance)

    const deps = readerDeps()
    const { container } = renderReader(deps)
    await waitFor(() => expect(container.querySelector('[data-chapter="0"]')).not.toBeNull())
    await startListening({
      sourceId: 's1', bookKey: 'k1', title: '书一', chapterIndex: 0, paragraphIndex: 0,
      engineId: 'browser:local',
    })
    await waitFor(() => expect(container.querySelector('.novel-tts-bar')).not.toBeNull())

    fireEvent.click(screen.getByRole('button', { name: '听书设置' }))
    const voice = await screen.findByLabelText('音色')
    // 语区跟着名字上屏：平台表里几十支跨语种的音色，只给厂商昵称就是让用户盲选
    expect(voice.textContent).toContain('本地女声（zh-CN）')
  })

  it('平台音色迟到（voiceschanged）：投影随事件补上，不等下一次重渲染碰运气', () => {
    const synth = new FakeSpeechSynthesis()
    vi.stubGlobal('speechSynthesis', synth)
    const h = renderHook(() => useDirectVoices())
    expect(h.result.current, '冷启动空表').toEqual([])

    synth.voices = [new FakeVoice('late', '迟到的嗓音')]
    act(() => { synth.emitVoicesChanged() })
    expect(h.result.current).toEqual([{ id: 'late', name: '迟到的嗓音', lang: 'zh-CN' }])
    h.unmount()
    // 退订要真的退掉：卸载后再来一发不该把已走的订阅者叫回来
    synth.voices = [new FakeVoice('later', '更晚的嗓音')]
    act(() => { synth.emitVoicesChanged() })
    expect(h.result.current, '已卸载的订阅不复活').toEqual([{ id: 'late', name: '迟到的嗓音', lang: 'zh-CN' }])
  })
})

describe('条上直接控制：语速 / 定时单击循环', () => {
  async function openListeningBar(): Promise<void> {
    singleChapter()
    const { container } = renderReader(readerDeps())
    await waitFor(() => expect(container.querySelector('[data-chapter="0"]')).not.toBeNull())
    fireEvent.click(screen.getByRole('button', { name: '听书' }))
    await waitFor(() => expect(ttsPlayer.get().playing).toBe(true))
  }

  it('语速按钮单击循环：1x → 1.25x → 1.5x → 1.75x；越过 3x 回 0.5x；不弹设置卡', async () => {
    await openListeningBar()
    const rate = screen.getByTitle('语速')
    expect(ttsPlayer.get().rate).toBe(1)

    fireEvent.click(rate)
    expect(ttsPlayer.get().rate).toBe(1.25)
    fireEvent.click(rate)
    expect(ttsPlayer.get().rate).toBe(1.5)
    fireEvent.click(rate)
    expect(ttsPlayer.get().rate).toBe(1.75)
    expect(screen.queryByRole('dialog', { name: '听书设置' }), '语速循环不打开设置卡').toBeNull()

    act(() => { setListenRate(3) })
    fireEvent.click(rate)
    expect(ttsPlayer.get().rate, '上限回卷到最低档').toBe(0.5)
    act(() => { setListenRate(1.13) })
    fireEvent.click(rate)
    expect(ttsPlayer.get().rate, '非档位值落到下一个更大的档').toBe(1.25)
  })

  it('定时按钮单击循环：关闭 → 15 → 30 → 60 → 本章结束 → 关闭；不弹设置卡', async () => {
    await openListeningBar()
    const timer = screen.getByTitle('定时')
    expect(timer.getAttribute('aria-label'), '未设定时报档位，不重复名词').toBe('定时 关闭，点击切换下一档')

    fireEvent.click(timer)
    expect(ttsPlayer.get().timerChoice).toBe(15)
    expect(screen.getByTitle('定时').textContent).toMatch(/^\d+:\d{2}$/)
    expect(timer.getAttribute('aria-label'), '计时中仍报预设档位，不把倒计时当选项').toBe('定时 15 分，点击切换下一档')
    fireEvent.click(timer)
    expect(ttsPlayer.get().timerChoice).toBe(30)
    fireEvent.click(timer)
    expect(ttsPlayer.get().timerChoice).toBe(60)
    fireEvent.click(timer)
    expect(ttsPlayer.get().timerChoice).toBe('chapter')
    expect(screen.getByTitle('定时').textContent).toBe('本章结束')
    expect(timer.getAttribute('aria-label')).toBe('定时 本章结束，点击切换下一档')
    fireEvent.click(timer)
    expect(ttsPlayer.get().timerChoice, '本章结束再点回到关闭').toBeNull()
    expect(screen.getByTitle('定时').textContent).toBe('定时')
    expect(timer.getAttribute('aria-label')).toBe('定时 关闭，点击切换下一档')
    expect(screen.queryByRole('dialog', { name: '听书设置' }), '定时循环不打开设置卡').toBeNull()
  })

  it('条上语速档位落在 TTS_RATE 定义域内且升序', () => {
    const steps = [...RATE_STEPS]
    expect(steps[0], '首档跟定义域下限').toBe(TTS_RATE.min)
    expect(steps.at(-1), '末档跟定义域上限').toBe(TTS_RATE.max)
    expect([...steps].sort((a, b) => a - b), '档位升序').toEqual(steps)
    expect(steps.every((step) => step >= TTS_RATE.min && step <= TTS_RATE.max), '无一越界').toBe(true)
  })
})

describe('起播入口：选区与阅读位置', () => {
  it('选区选中段落文本 → 浮动「从本段听」→ 从该段起播', async () => {
    singleChapter()
    const deps = readerDeps()
    const { container } = renderReader(deps)
    await waitFor(() => expect(container.querySelector('[data-chapter="0"]')).not.toBeNull())

    const p = must(container.querySelector<HTMLElement>('[data-chapter="0"] p[data-pidx="1"]'), 'paragraph 1')
    const range = document.createRange()
    range.selectNodeContents(p)
    const selection = window.getSelection()
    expect(selection).not.toBeNull()
    selection?.removeAllRanges()
    selection?.addRange(range)
    fireEvent.mouseUp(p)

    fireEvent.click(await screen.findByRole('button', { name: '从本段听' }))
    await waitFor(() => expect(ttsPlayer.get().active).toBe(true))
    expect(ttsPlayer.get()).toMatchObject({ chapterIndex: 0, paragraphIndex: 1 })
  })

  it('「从阅读位置起播」读探针的 DOM 几何（视口顶所在段）', async () => {
    singleChapter()
    const deps = readerDeps()
    const { container } = renderReader(deps)
    await waitFor(() => expect(container.querySelector('[data-chapter="0"]')).not.toBeNull())

    fireEvent.click(screen.getByRole('button', { name: '听书' }))
    await waitFor(() => expect(ttsPlayer.get().playing).toBe(true))

    const block = must(container.querySelector<HTMLElement>('[data-chapter="0"]'), 'chapter block')
    const ps = [...block.querySelectorAll('p[data-pidx]')] as HTMLElement[]
    vi.spyOn(block, 'getBoundingClientRect').mockReturnValue(rect(-200, 2000))
    vi.spyOn(must(ps[0], 'p0'), 'getBoundingClientRect').mockReturnValue(rect(-200, 20))
    vi.spyOn(must(ps[1], 'p1'), 'getBoundingClientRect').mockReturnValue(rect(-20, 20))
    vi.spyOn(must(ps[2], 'p2'), 'getBoundingClientRect').mockReturnValue(rect(80, 20))

    fireEvent.click(screen.getByRole('button', { name: '听书设置' }))
    fireEvent.click(screen.getByRole('button', { name: '从阅读位置起播' }))
    await waitFor(() => expect(ttsPlayer.get().paragraphIndex).toBe(1))
    expect(ttsPlayer.get().chapterIndex).toBe(0)
  })

  it('本书不是正在听的那本 → 不渲染条形与「从阅读位置起播」', async () => {
    await startListening({
      sourceId: 's1', bookKey: 'k2', title: '书二', chapterIndex: 0, paragraphIndex: 0,
    })
    expect(ttsPlayer.get().active).toBe(true)

    const deps = readerDeps()
    const { container } = renderReader(deps)
    await waitFor(() => expect(container.querySelector('[data-chapter="0"]')).not.toBeNull())
    expect(container.querySelector('.novel-tts-bar')).toBeNull()
    expect(screen.queryByRole('button', { name: '从阅读位置起播' })).toBeNull()
    expect(screen.getByRole('button', { name: '听书' })).toBeTruthy()
  })
})

describe('失败码 → 文案（不渲染裸码）', () => {
  it('空目录起播 → 本地化提示，不含 TTS_CHAPTERS_EMPTY', async () => {
    chapterNames = []
    chapterTexts = []
    const pushError = vi.fn()
    const deps = readerDeps({ pushError })
    renderReader(deps)
    await waitFor(() => expect(screen.getByRole('button', { name: '听书' })).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: '听书' }))
    await waitFor(() => expect(pushError).toHaveBeenCalledWith('这本书没有可朗读的章节。'))
    expect(String(pushError.mock.calls[0]?.[0])).not.toContain('TTS_')
  })

  it('直出源无音色起播 → 本地化提示，不含 TTS_NO_VOICES', async () => {
    shelf = [shelfEntry({
      listen: {
        chapterIndex: 0, paragraphIndex: 0, engineId: 'browser:local', voice: null,
        rate: 1, volume: 0.8,
      },
    })]
    const pushError = vi.fn()
    const deps = readerDeps({ pushError })
    const { container } = renderReader(deps)
    await waitFor(() => expect(container.querySelector('[data-chapter="0"]')).not.toBeNull())
    await waitFor(() => expect(panelShelf.get().books).not.toBeNull())

    fireEvent.click(screen.getByRole('button', { name: '听书' }))
    await waitFor(() => expect(pushError).toHaveBeenCalledWith('当前设备没有可用的浏览器语音——可在听书设置里换用内置朗读。'))
    expect(String(pushError.mock.calls[0]?.[0])).not.toContain('TTS_')
  })
})

describe('定位到正在念的段', () => {
  it('目标章不在已载窗口：点击定位会显式导航到那一章（写进度是这次导航自己的语义）', async () => {
    chapterNames = ['第一章', '第二章', '第三章']
    chapterTexts = [['第一章第一段。'], ['第二章第一段。'], ['第三章第一段。']]
    await startListening({
      sourceId: 's1', bookKey: 'k1', title: '书一', chapterIndex: 2, paragraphIndex: 0,
    })
    // 卡住阅读器的自动预取（章 1）：章 2 因此不在已载窗口，定位只能走显式导航。
    let release = (): void => { throw new Error('章正文闸未就绪') }
    const deps = readerDeps({}, new Map([[1, new Promise<void>((resolve) => { release = resolve })]]))
    const { container } = renderReader(deps)
    await waitFor(() => expect(container.querySelector('[data-chapter="0"]')).not.toBeNull())
    expect(ttsPlayer.get().chapterIndex).toBe(2)
    expect(container.querySelector('[data-chapter="2"]'), '章 2 还没载').toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '定位到正在念的段' }))
    // `requestJump` 的 commit('jump') 立即写阅读进度：这是「按了有反应」的可观测证据。
    await waitFor(() => expect(deps.apiSend.mock.calls.some(([, body]) => {
      const progress = (body as { progress?: { chapterIndex?: number } } | null)?.progress
      return progress?.chapterIndex === 2
    })).toBe(true))

    release()
    await waitFor(() => expect(container.querySelector('[data-chapter="2"]')).not.toBeNull())
    expect(container.querySelector('[data-chapter="2"] .novel-tts-live')?.textContent).toBe('第三章第一段。')
  })

  it('章到货后最终落位居中在命中段，而不是被「章首对齐」拉回去', async () => {
    chapterNames = ['第一章', '第二章', '第三章']
    chapterTexts = [
      ['第一章第一段。'],
      ['第二章第一段。'],
      ['第三章第一段。', '第三章第二段。', '第三章第三段。'],
    ]
    await startListening({
      sourceId: 's1', bookKey: 'k1', title: '书一', chapterIndex: 2, paragraphIndex: 1,
    })
    // 阅读器的真实滚动容器：可视高 600、内容高 2400。jsdom 没有排版引擎，替身要自己保一条
    // 几何关系——章块的「内容坐标」固定，rect 随容器 scrollTop 平移。静态矩形下「先居中再
    // 跳章」与「先跳章再居中」的两次加法可交换，量不出本次回归（最终都是章首高度 + 居中位移）。
    const scrollport = document.createElement('div')
    scrollport.style.overflowY = 'auto'
    Object.defineProperty(scrollport, 'clientHeight', { value: 600, configurable: true })
    Object.defineProperty(scrollport, 'scrollHeight', { value: 2400, configurable: true })
    document.body.append(scrollport)
    const chapterTop = [0, 800, 1500]
    const chapterHeight = [800, 700, 900]
    const rectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element): DOMRect {
      if (this === scrollport) return rect(0, 600)                 // 视口盒钉在屏幕顶
      const chapter = this.closest('[data-chapter]')
      if (chapter === null) return rect(0, 0)
      const index = Number(chapter.getAttribute('data-chapter'))
      const top = chapterTop[index] ?? 0
      if (this === chapter) return rect(top - scrollport.scrollTop, chapterHeight[index] ?? 0)
      const pidx = this.getAttribute('data-pidx')
      // 段在章内的固定位置：内容坐标 = 章顶 + 100 + 段号 × 100
      return pidx === null ? rect(0, 0) : rect(top + 100 + Number(pidx) * 100 - scrollport.scrollTop, 20)
    })
    try {
      // 卡住阅读器的自动预取（章 1）：章 2 因此不在已载窗口，定位只能走显式导航。
      let release = (): void => { throw new Error('章正文闸未就绪') }
      const deps = readerDeps({}, new Map([[1, new Promise<void>((resolve) => { release = resolve })]]))
      const { container } = render(
        createElement(ReaderView, { sourceId: 's1', bookKey: 'k1', title: '书一', deps }),
        { container: scrollport },
      )
      await waitFor(() => expect(container.querySelector('[data-chapter="0"]')).not.toBeNull())
      expect(container.querySelector('[data-chapter="2"]'), '章 2 还没载').toBeNull()

      fireEvent.click(screen.getByRole('button', { name: '定位到正在念的段' }))
      release()
      await waitFor(() => expect(container.querySelector('[data-chapter="2"]')).not.toBeNull())
      // 命中段是第三章第二段：内容坐标 1500 + 100 + 1×100 = 1700、高 20，居中即
      // 1700 + 20/2 - 600/2 = 1410。章首对齐那条路会给 1500——差的就是「先落位再居中」。
      await waitFor(() => expect(scrollport.scrollTop).toBe(1410))
    } finally {
      rectSpy.mockRestore()
      scrollport.remove()
    }
  })
})

describe('剥重复章名后的段号（ReaderView 接线）', () => {
  it('正文首行重复章名被剥掉：data-pidx 从 1 起，跟读高亮落在真正的第一行正文上', async () => {
    // 播放层念的是原样正文（第一段就是章名），屏上却由 h2 单独出章名、正文首行被剥。
    // 两套号差 1：ReaderView 的 paragraphBase 不接到 ChapterBody，高亮与「从本段听」就整体早一段。
    chapterNames = ['第一章']
    chapterTexts = [['第一章', '正文一。', '正文二。', '正文三。']]
    const deps = readerDeps()
    const { container } = renderReader(deps)
    await waitFor(() => expect(container.querySelector('[data-chapter="0"]')).not.toBeNull())
    expect([...container.querySelectorAll('[data-chapter="0"] p')].map((p) => p.getAttribute('data-pidx')))
      .toEqual(['1', '2', '3'])
    expect(container.querySelector('[data-chapter="0"] p[data-pidx="0"]'), '被剥的章名行不在屏上').toBeNull()

    await act(async () => {
      await startListening({ sourceId: 's1', bookKey: 'k1', title: '书一', chapterIndex: 0, paragraphIndex: 1 })
    })
    const live = must(container.querySelector('.novel-tts-live'), '命中段')
    expect(live.getAttribute('data-pidx')).toBe('1')
    expect(live.textContent).toBe('正文一。')
  })
})

describe('阅读探针', () => {
  it('挂载注册、卸载注销', async () => {
    const deps = readerDeps()
    const { container, unmount } = renderReader(deps)
    expect(readingProbeNow()).not.toBeNull()
    await waitFor(() => expect(container.querySelector('[data-chapter="0"]')).not.toBeNull())
    unmount()
    expect(readingProbeNow()).toBeNull()
  })

  it('返值与 DOM 几何一致：视口顶所在章 + 章内该段', () => {
    const holder = document.createElement('div')
    document.body.append(holder)
    const makeChapter = (tops: number[]): { block: HTMLElement; ps: HTMLElement[] } => {
      const block = document.createElement('div')
      block.dataset.chapter = '0'
      const ps = tops.map((top, i) => {
        const p = document.createElement('p')
        p.dataset.pidx = String(i)
        block.append(p)
        vi.spyOn(p, 'getBoundingClientRect').mockReturnValue(rect(top, 20))
        return p
      })
      holder.append(block)
      return { block, ps }
    }

    const first = makeChapter([-200, -20, 80])
    const second = makeChapter([180, 260])
    vi.spyOn(first.block, 'getBoundingClientRect').mockReturnValue(rect(-200, 400))
    vi.spyOn(second.block, 'getBoundingClientRect').mockReturnValue(rect(180, 200))

    expect(readingPositionAt([first.block, second.block], 0)).toEqual({ chapterIndex: 0, paragraphIndex: 1 })
    expect(readingPositionAt([first.block, second.block], 190)).toEqual({ chapterIndex: 1, paragraphIndex: 0 })
    expect(readingPositionAt([null, second.block], 0)).toEqual({ chapterIndex: 1, paragraphIndex: 0 })
    expect(readingPositionAt([], 0)).toBeNull()
    holder.remove()
  })

  it('稀疏章数组（跳章打开时的洞）按在场章块量，不炸', () => {
    const holder = document.createElement('div')
    document.body.append(holder)
    const block = document.createElement('div')
    block.dataset.chapter = '2'
    const p = document.createElement('p')
    p.dataset.pidx = '4'
    block.append(p)
    holder.append(block)
    vi.spyOn(block, 'getBoundingClientRect').mockReturnValue(rect(-100, 500))
    vi.spyOn(p, 'getBoundingClientRect').mockReturnValue(rect(-100, 20))

    // 跳章打开时 ReaderView 先把 chapterRefs 清空、逐章渲染才补格：缺席下标是 undefined 洞，
    // 不是显式 null。对洞取几何会抛，抛点会被播放层当「量不到」吞掉、静默退回比例估算。
    const sparse: Array<Element | null> = []
    sparse[2] = block
    expect(Object.hasOwn(sparse, 0)).toBe(false)

    expect(readingPositionAt(sparse, 0)).toEqual({ chapterIndex: 2, paragraphIndex: 4 })
    holder.remove()
  })
})
