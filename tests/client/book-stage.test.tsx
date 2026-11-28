// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PREFS, normalizeMeasure, prefsStore, setPref } from '../../src/client/store.js'
import { READER_CSS } from '../../src/client/styles/reader.js'
import { BookStage } from '../../src/client/views/BookStage.js'
import { PrefsPanel } from '../../src/client/views/PrefsPanel.js'
import type { ChapterContent } from '../../src/client/views/types.js'

const SAMPLE_CHAPTER: ChapterContent = {
  kind: 'text',
  text: '第一段正文。\n第二段正文。\n第三段正文。',
}

describe('PrefsPanel reading mode & page animation', () => {
  beforeEach(() => {
    setPref({ ...DEFAULT_PREFS })
  })
  afterEach(() => {
    cleanup()
    setPref({ ...DEFAULT_PREFS })
  })

  it('toggles readingMode to page and exposes the page column & animation options', () => {
    const view = render(<PrefsPanel zIndex={11} />)
    // 默认滚动模式下不展示翻页动效与分栏选项
    expect(view.queryByText('拟真翻书')).toBeNull()
    expect(view.queryByText('单页')).toBeNull()

    fireEvent.click(view.getByText('翻页阅读'))
    expect(prefsStore.get().readingMode).toBe('page')
    expect(view.getByText('自动')).toBeTruthy()
    expect(view.getByText('单页')).toBeTruthy()
    expect(view.getByText('双页')).toBeTruthy()
    expect(view.getByText('拟真翻书')).toBeTruthy()
    expect(view.getByText('顺滑平移')).toBeTruthy()
    expect(view.getByText('极速直切')).toBeTruthy()

    fireEvent.click(view.getByText('单页'))
    expect(prefsStore.get().pageColumns).toBe('single')

    fireEvent.click(view.getByText('顺滑平移'))
    expect(prefsStore.get().pageAnimation).toBe('slide')

    fireEvent.click(view.getByText('极速直切'))
    expect(prefsStore.get().pageAnimation).toBe('none')
  })

  it('exposes Moyu as the third mode with its own presentation controls', () => {
    const onClose = vi.fn()
    setPref({ readingMode: 'page' })
    const view = render(<PrefsPanel zIndex={11} onClose={onClose} />)
    fireEvent.click(view.getByText('摸鱼模式'))
    expect(prefsStore.get()).toMatchObject({ readingMode: 'moyu', lastNormalMode: 'page' })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(view.getByText('呈现风格')).toBeTruthy()
    expect(view.getByText('输出节奏')).toBeTruthy()
    fireEvent.click(view.getByText('紧凑日志流'))
    fireEvent.click(view.getByText('即时直出'))
    expect(prefsStore.get()).toMatchObject({ moyuStyle: 'compact', moyuReveal: 'instant' })
    const modeGroup = view.getByRole('group', { name: '阅读方式' })
    expect(modeGroup.style.getPropertyValue('--novel-seg-index')).toBe('2')
  })

  it('supports Night paper swatch, collapsible custom HSL/Hex picker, and Reset Defaults', () => {
    const view = render(<PrefsPanel zIndex={11} />)
    fireEvent.click(view.getByRole('button', { name: '夜间' }))
    expect(prefsStore.get().paperColor).toBe('#111315')

    fireEvent.click(view.getByRole('button', { name: '自定义纸张色' }))
    expect(view.getByLabelText('十六进制色值')).toBeTruthy()
    fireEvent.change(view.getByLabelText('十六进制色值'), { target: { value: 'eef1f7' } })
    expect(prefsStore.get().paperColor).toBe('#eef1f7')

    fireEvent.click(view.getByRole('button', { name: '恢复默认设置' }))
    expect(prefsStore.get()).toEqual(DEFAULT_PREFS)
  })

  it('keeps custom paper color isolated from presets and restores it on re-selecting Custom', () => {
    const view = render(<PrefsPanel zIndex={11} />)
    const customCore = (): HTMLElement => {
      const el = view.container.querySelector('.novel-custom-swatch-core')
      if (!(el instanceof HTMLElement)) throw new Error('missing custom swatch core')
      return el
    }

    // 1. 未自定义过时切预设，customPaperColor 始终为 null 且圆点核心不绑定预设色
    fireEvent.click(view.getByRole('button', { name: '夜间' }))
    fireEvent.click(view.getByRole('button', { name: '淡绿' }))
    expect(prefsStore.get().customPaperColor).toBeNull()
    expect(customCore().style.backgroundColor).toBe('')

    // 2. 设置自定义色后，同时写入 paperColor 与 customPaperColor，圆点显示该自定义色
    fireEvent.click(view.getByRole('button', { name: '自定义纸张色' }))
    fireEvent.change(view.getByLabelText('十六进制色值'), { target: { value: 'eef1f7' } })
    expect(prefsStore.get().paperColor).toBe('#eef1f7')
    expect(prefsStore.get().customPaperColor).toBe('#eef1f7')
    expect(customCore().style.backgroundColor).toBe('rgb(238, 241, 247)')

    // 3. 再切换预设：paperColor 变成预设色，但 customPaperColor 保留且圆点不变、取色器收起
    fireEvent.click(view.getByRole('button', { name: '米黄' }))
    expect(prefsStore.get().paperColor).toBe('#f7f3e8')
    expect(prefsStore.get().customPaperColor).toBe('#eef1f7')
    expect(customCore().style.backgroundColor).toBe('rgb(238, 241, 247)')
    expect(view.queryByLabelText('十六进制色值')).toBeNull()

    // 4. 点回「自定义纸张色」：立即恢复 #eef1f7 并展开取色器；再点一次可收起且保持 #eef1f7
    fireEvent.click(view.getByRole('button', { name: '自定义纸张色' }))
    expect(prefsStore.get().paperColor).toBe('#eef1f7')
    expect(view.getByLabelText('十六进制色值')).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: '自定义纸张色' }))
    expect(view.queryByLabelText('十六进制色值')).toBeNull()
    expect(prefsStore.get().paperColor).toBe('#eef1f7')

    // 5. 恢复默认设置清空 customPaperColor 并收起取色器
    fireEvent.click(view.getByRole('button', { name: '自定义纸张色' }))
    fireEvent.click(view.getByRole('button', { name: '恢复默认设置' }))
    expect(prefsStore.get()).toEqual(DEFAULT_PREFS)
    expect(view.queryByLabelText('十六进制色值')).toBeNull()
    expect(customCore().style.backgroundColor).toBe('')
  })

  it('supports typing 6-digit hex without 3-digit early rewrite and preserves hue/saturation from white preset', () => {
    const view = render(<PrefsPanel zIndex={11} />)
    fireEvent.click(view.getByRole('button', { name: '纯白' }))
    fireEvent.click(view.getByRole('button', { name: '自定义纸张色' }))

    // 从纯白起手拖动色相与饱和度滑杆不会卡死在 0，降低亮度后产出对应色相的颜色
    const hue = view.getByLabelText('色相') as HTMLInputElement
    const sat = view.getByLabelText('饱和') as HTMLInputElement
    const light = view.getByLabelText('亮度') as HTMLInputElement
    fireEvent.change(hue, { target: { value: '120' } })
    expect(hue.value).toBe('120')
    fireEvent.change(sat, { target: { value: '80' } })
    expect(sat.value).toBe('80')
    fireEvent.change(light, { target: { value: '90' } })
    expect(prefsStore.get().paperColor).toBe('#d1fad1')

    // 逐字符手打 6 位 Hex 到第 3 位时不提前展开成 #11aa22
    const hexInput = view.getByLabelText('十六进制色值') as HTMLInputElement
    fireEvent.focus(hexInput)
    fireEvent.change(hexInput, { target: { value: '1A2' } })
    expect(hexInput.value).toBe('1A2')
    expect(prefsStore.get().paperColor).toBe('#d1fad1')
    fireEvent.change(hexInput, { target: { value: '1A2B3C' } })
    expect(prefsStore.get().paperColor).toBe('#1a2b3c')

    // 3 位简写在失焦时提交展开
    fireEvent.change(hexInput, { target: { value: 'eef' } })
    fireEvent.blur(hexInput)
    expect(prefsStore.get().paperColor).toBe('#eeeeff')
    expect(hexInput.value).toBe('EEEEFF')
  })

  it('migrates legacy non-preset paperColor into customPaperColor when switching to a preset', () => {
    setPref({ ...DEFAULT_PREFS, paperColor: '#d8e6f2', customPaperColor: null })
    const view = render(<PrefsPanel zIndex={11} />)
    fireEvent.click(view.getByRole('button', { name: '夜间' }))
    expect(prefsStore.get().paperColor).toBe('#111315')
    expect(prefsStore.get().customPaperColor).toBe('#d8e6f2')

    fireEvent.click(view.getByRole('button', { name: '自定义纸张色' }))
    expect(prefsStore.get().paperColor).toBe('#d8e6f2')
  })
})

describe('BookStage interactions and animation modes', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('flips across chapters on prev/next controls and triggers 3D flip leaf only in flip mode', () => {
    vi.useFakeTimers()
    try {
      const onChangeChapter = vi.fn()
      const onReportRatio = vi.fn()
      const onUserIntent = vi.fn()
      const chapterRefs = { current: [] as Array<HTMLDivElement | null> }
      const bodyRef = { current: null as HTMLDivElement | null }

      const view = render(
        <BookStage
          chapterIndex={1}
          totalChapters={3}
          chapterName="第二章"
          content={SAMPLE_CHAPTER}
          loading={false}
          bookKey="book-1"
          fontSize={18}
          lineHeight={1.8}
          measure={680}
          animation="flip"
          initialRatio={0}
          listenParagraph={null}
          listenFollowing={false}
          keyboardBlocked={false}
          onNavigate={() => {}}
          onChangeChapter={onChangeChapter}
          onReportRatio={onReportRatio}
          onUserIntent={onUserIntent}
          chapterRefs={chapterRefs}
          bodyRef={bodyRef}
        />,
      )

      // 单页章末点下一页 → 跨到下一章开头，并在拟真翻书模式下激活纯 CSS 轻盈翻页层与正文柔焦（零正文复制）
      fireEvent.click(view.getByLabelText('下一页'))
      expect(onUserIntent).toHaveBeenCalledTimes(1)
      expect(onChangeChapter).toHaveBeenCalledWith(2)
      const leaf = view.container.querySelector('.novel-book-leaf')
      expect(leaf).not.toBeNull()
      expect(view.container.querySelector('.novel-book-track.is-flipping')).not.toBeNull()
      expect(view.container.querySelectorAll('.novel-book-chapter')).toHaveLength(1)

      // 翻页动画结束后清理 3D 翻页层与柔焦态
      act(() => { vi.advanceTimersByTime(700) })
      expect(view.container.querySelector('.novel-book-flip-stage')).toBeNull()
      expect(view.container.querySelector('.novel-book-track.is-flipping')).toBeNull()

      // 键盘左键 → 跨回上一章末尾
      fireEvent.keyDown(document, { key: 'ArrowLeft' })
      expect(onChangeChapter).toHaveBeenCalledWith(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('respects keyboardBlocked when a modal or drawer is open', () => {
    const onChangeChapter = vi.fn()
    const view = render(
      <BookStage
        chapterIndex={0}
        totalChapters={3}
        chapterName="第一章"
        content={SAMPLE_CHAPTER}
        loading={false}
        bookKey="book-1"
        fontSize={18}
        lineHeight={1.8}
        measure={36}
        animation="none"
        initialRatio={0}
        listenParagraph={null}
        listenFollowing={false}
        keyboardBlocked={true}
        onNavigate={() => {}}
        onChangeChapter={onChangeChapter}
        onReportRatio={() => {}}
        onUserIntent={() => {}}
        chapterRefs={{ current: [] }}
        bodyRef={{ current: null }}
      />,
    )

    fireEvent.keyDown(document, { key: 'ArrowRight' })
    expect(onChangeChapter).not.toHaveBeenCalled()
    expect(view.container.querySelector('.novel-book-leaf')).toBeNull()
  })

  it('isolates book stage stacking context at z-index 0 so TTS bar and drawers stay above pages', () => {
    const match = /\.novel-book-stage\s*\{([^}]*)\}/.exec(READER_CSS)
    expect(match?.[1]).toContain('z-index: 0')
    expect(match?.[1]).toContain('isolation: isolate')
  })

  it('跨章回翻落末页后补报末页比例：存档不能留在上一章章首', async () => {
    // jsdom 没有排版：用 scrollWidth 假装多栏轨道足够长，让本章有多屏可翻。
    const scrollWidth = vi.spyOn(Element.prototype, 'scrollWidth', 'get')
      .mockImplementation(function (this: Element) {
        return this.classList.contains('novel-book-track') ? 5000 : 0
      })
    try {
      const onChangeChapter = vi.fn()
      const onReportRatio = vi.fn()
      const common = {
        totalChapters: 3,
        content: SAMPLE_CHAPTER,
        loading: false,
        bookKey: 'book-1',
        fontSize: 18,
        lineHeight: 1.8,
        measure: 680,
        animation: 'none' as const,
        initialRatio: 0,
        listenParagraph: null,
        listenFollowing: false,
        keyboardBlocked: false,
        onNavigate: () => {},
        onReportRatio,
        onUserIntent: () => {},
        chapterRefs: { current: [] as Array<HTMLDivElement | null> },
        bodyRef: { current: null as HTMLDivElement | null },
      }
      const view = render(
        <BookStage {...common} chapterIndex={1} chapterName="第二章" onChangeChapter={onChangeChapter} />,
      )
      await waitFor(() => expect(view.container.querySelector('.novel-book-track.is-settled')).not.toBeNull())

      fireEvent.click(view.getByLabelText('上一页'))
      expect(onChangeChapter).toHaveBeenCalledWith(0)
      expect(onReportRatio).not.toHaveBeenCalled()       // 跨章请求本身还不能写比例

      view.rerender(
        <BookStage {...common} chapterIndex={0} chapterName="第一章" onChangeChapter={onChangeChapter} />,
      )
      await waitFor(() => expect(onReportRatio).toHaveBeenCalled())
      const landed = onReportRatio.mock.calls.at(-1)?.[0] as number
      expect(landed).toBeGreaterThan(0)                  // 末页不是章首
      expect(landed).toBeLessThan(1)
    } finally {
      scrollWidth.mockRestore()
    }
  })

  it('冷开恢复：正文到达时同一章的存档比例生效，不落回第一页', async () => {
    // 会话 open 先取书架存档再载正文：舞台已按 initialRatio=0 挂载，比例随正文一起到而章号不变。
    // ratioRef 需在未测量前随 initialRatio 同步，否则异步到达的存档比例会被挂载初值 0 盖掉。
    const scrollWidth = vi.spyOn(Element.prototype, 'scrollWidth', 'get')
      .mockImplementation(function (this: Element) {
        return this.classList.contains('novel-book-track') ? 5000 : 0
      })
    try {
      const common = {
        chapterIndex: 0,
        totalChapters: 2,
        chapterName: '第一章',
        loading: false,
        bookKey: 'book-1',
        fontSize: 18,
        lineHeight: 1.8,
        measure: 680,
        animation: 'none' as const,
        listenParagraph: null,
        listenFollowing: false,
        keyboardBlocked: false,
        onNavigate: () => {},
        onChangeChapter: () => {},
        onReportRatio: () => {},
        onUserIntent: () => {},
        chapterRefs: { current: [] as Array<HTMLDivElement | null> },
        bodyRef: { current: null as HTMLDivElement | null },
      }
      const view = render(<BookStage {...common} content={null} initialRatio={0} />)
      view.rerender(<BookStage {...common} content={SAMPLE_CHAPTER} initialRatio={0.75} />)
      await waitFor(() => expect(view.container.querySelector('.novel-book-track.is-settled')).not.toBeNull())

      const num = view.container.querySelector('[data-novel-page-num]')?.textContent ?? ''
      const match = /第 (\d+)(?:–\d+)? \/ (\d+) 页/.exec(num)
      expect(match).not.toBeNull()
      const from = Number(match?.[1])
      const totalColumns = Number(match?.[2])
      const totalSpreads = Math.ceil(totalColumns / 2)
      expect(from).toBe(Math.floor(0.75 * totalSpreads) * 2 + 1)
      expect(from).toBeGreaterThan(1)
    } finally {
      scrollWidth.mockRestore()
    }
  })

  it('窄屏（舞台宽 < 860px 可用宽）自动切为单页布局', () => {
    const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.hasAttribute('data-novel-book-stage')) {
        return { width: 700, height: 600, left: 0, right: 700, top: 0, bottom: 600, x: 0, y: 0, toJSON: () => ({}) }
      }
      return { width: 0, height: 0, left: 0, right: 0, top: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}) }
    })
    try {
      const view = render(
        <BookStage
          chapterIndex={0}
          totalChapters={2}
          chapterName="第一章"
          content={SAMPLE_CHAPTER}
          loading={false}
          bookKey="book-1"
          fontSize={18}
          lineHeight={1.8}
          measure={680}
          animation="none"
          initialRatio={0}
          listenParagraph={null}
          listenFollowing={false}
          keyboardBlocked={false}
          onNavigate={() => {}}
          onChangeChapter={() => {}}
          onReportRatio={() => {}}
          onUserIntent={() => {}}
          chapterRefs={{ current: [] }}
          bodyRef={{ current: null }}
        />,
      )
      expect(view.container.querySelector('[data-novel-book-stage]')?.getAttribute('data-page-layout')).toBe('single')
    } finally {
      rectSpy.mockRestore()
    }
  })

  it('跨章回翻未到货时跳往别章，残留的末页意图不污染新章落位', async () => {
    const scrollWidth = vi.spyOn(Element.prototype, 'scrollWidth', 'get')
      .mockImplementation(function (this: Element) {
        return this.classList.contains('novel-book-track') ? 5000 : 0
      })
    try {
      const onChangeChapter = vi.fn()
      const common = {
        totalChapters: 4,
        loading: false,
        bookKey: 'book-1',
        fontSize: 18,
        lineHeight: 1.8,
        measure: 680,
        animation: 'none' as const,
        initialRatio: 0,
        listenParagraph: null,
        listenFollowing: false,
        keyboardBlocked: false,
        onNavigate: () => {},
        onChangeChapter,
        onReportRatio: () => {},
        onUserIntent: () => {},
        chapterRefs: { current: [] as Array<HTMLDivElement | null> },
        bodyRef: { current: null as HTMLDivElement | null },
      }
      const view = render(<BookStage {...common} chapterIndex={1} chapterName="第二章" content={SAMPLE_CHAPTER} />)
      await waitFor(() => expect(view.container.querySelector('.novel-book-track.is-settled')).not.toBeNull())

      // 点上一页意图去第 0 章末页，但第 0 章加载失败未到达（content=null），随后外部跳去第 2 章
      fireEvent.click(view.getByLabelText('上一页'))
      expect(onChangeChapter).toHaveBeenCalledWith(0)
      view.rerender(<BookStage {...common} chapterIndex={0} chapterName="第一章" content={null} />)
      view.rerender(<BookStage {...common} chapterIndex={2} chapterName="第三章" content={SAMPLE_CHAPTER} />)

      await waitFor(() => expect(view.container.querySelector('.novel-book-track.is-settled')).not.toBeNull())
      const num = view.container.querySelector('[data-novel-page-num]')?.textContent ?? ''
      expect(num).toContain('第 1')
    } finally {
      scrollWidth.mockRestore()
    }
  })

  it('听书跟读跨章对齐到高亮段后，补报该页比例给会话', async () => {
    const scrollWidth = vi.spyOn(Element.prototype, 'scrollWidth', 'get')
      .mockImplementation(function (this: Element) {
        return this.classList.contains('novel-book-track') ? 5000 : 0
      })
    const rectSpy = vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(function (this: Element) {
      if (this.classList.contains('novel-tts-live')) {
        return [{ left: 2000, right: 2200, top: 0, bottom: 20, width: 200, height: 20, x: 2000, y: 0, toJSON: () => ({}) } as DOMRect] as unknown as DOMRectList
      }
      return [] as unknown as DOMRectList
    })
    try {
      const onReportRatio = vi.fn()
      const view = render(
        <BookStage
          chapterIndex={0}
          totalChapters={2}
          chapterName="第一章"
          content={SAMPLE_CHAPTER}
          loading={false}
          bookKey="book-1"
          fontSize={18}
          lineHeight={1.8}
          measure={680}
          animation="none"
          initialRatio={0}
          listenParagraph={2}
          listenFollowing={true}
          keyboardBlocked={false}
          onNavigate={() => {}}
          onChangeChapter={() => {}}
          onReportRatio={onReportRatio}
          onUserIntent={() => {}}
          chapterRefs={{ current: [] }}
          bodyRef={{ current: null }}
        />,
      )
      await waitFor(() => expect(onReportRatio).toHaveBeenCalled())
      expect(onReportRatio.mock.calls.at(-1)?.[0]).toBeGreaterThan(0)
      expect(view.container.querySelector('[data-novel-page-num]')?.textContent).not.toContain('第 1–')
    } finally {
      scrollWidth.mockRestore()
      rectSpy.mockRestore()
    }
  })

  it('目录已就绪但章正文失败（loading=false, content=null）时不显示「目录加载中…」', () => {
    const view = render(
      <BookStage
        chapterIndex={0}
        totalChapters={2}
        chapterName="第一章"
        content={null}
        loading={false}
        tocReady={true}
        bookKey="book-1"
        fontSize={18}
        lineHeight={1.8}
        measure={36}
        animation="none"
        initialRatio={0}
        listenParagraph={null}
        listenFollowing={false}
        keyboardBlocked={false}
        onNavigate={() => {}}
        onChangeChapter={() => {}}
        onReportRatio={() => {}}
        onUserIntent={() => {}}
        chapterRefs={{ current: [] }}
        bodyRef={{ current: null }}
      />,
    )
    expect(view.container.textContent).not.toContain('目录加载中')
  })

  it('同批连续两次键盘翻页依赖 spreadIndexRef 连续推进两屏', async () => {
    const scrollWidth = vi.spyOn(Element.prototype, 'scrollWidth', 'get')
      .mockImplementation(function (this: Element) {
        return this.classList.contains('novel-book-track') ? 5000 : 0
      })
    try {
      const view = render(
        <BookStage
          chapterIndex={0}
          totalChapters={2}
          chapterName="第一章"
          content={SAMPLE_CHAPTER}
          loading={false}
          bookKey="book-1"
          fontSize={18}
          lineHeight={1.8}
          measure={680}
          animation="none"
          initialRatio={0}
          listenParagraph={null}
          listenFollowing={false}
          keyboardBlocked={false}
          onNavigate={() => {}}
          onChangeChapter={() => {}}
          onReportRatio={() => {}}
          onUserIntent={() => {}}
          chapterRefs={{ current: [] }}
          bodyRef={{ current: null }}
        />,
      )
      await waitFor(() => expect(view.container.querySelector('.novel-book-track.is-settled')).not.toBeNull())
      act(() => {
        fireEvent.keyDown(document, { key: 'ArrowRight' })
        fireEvent.keyDown(document, { key: 'ArrowRight' })
      })
      expect(view.container.querySelector('[data-novel-page-num]')?.textContent).toContain('第 5–6')
    } finally {
      scrollWidth.mockRestore()
    }
  })

  it('同章调字号重排：保持当前屏首段锚点所在页，不因比例向下取整向回漂移', async () => {
    const scrollWidth = vi.spyOn(Element.prototype, 'scrollWidth', 'get')
      .mockImplementation(function (this: Element) {
        return this.classList.contains('novel-book-track') ? 8000 : 0
      })
    // p1 位于横坐标 2600px（在 18px 下处于第 2 屏、在 22px 下依然处于第 2 屏之后的新位置）
    let p1Left = 2600
    const rectSpy = vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(function (this: Element) {
      const pid = this.getAttribute('data-pidx')
      if (pid === '0') {
        return [{ left: 0, right: 200, top: 0, bottom: 20, width: 200, height: 20, x: 0, y: 0, toJSON: () => ({}) } as DOMRect] as unknown as DOMRectList
      }
      if (pid === '1') {
        return [{ left: p1Left, right: p1Left + 200, top: 0, bottom: 20, width: 200, height: 20, x: p1Left, y: 0, toJSON: () => ({}) } as DOMRect] as unknown as DOMRectList
      }
      return [] as unknown as DOMRectList
    })
    const onConsumeInitialParagraph = vi.fn()
    try {
      const common = {
        chapterIndex: 0,
        totalChapters: 2,
        chapterName: '第一章',
        content: SAMPLE_CHAPTER,
        loading: false,
        bookKey: 'book-1',
        lineHeight: 1.8,
        measure: 680,
        animation: 'none' as const,
        initialRatio: 0,
        initialParagraph: 1,
        onConsumeInitialParagraph,
        listenParagraph: null,
        listenFollowing: false,
        keyboardBlocked: false,
        onNavigate: () => {},
        onChangeChapter: () => {},
        onReportRatio: () => {},
        onUserIntent: () => {},
        chapterRefs: { current: [] as Array<HTMLDivElement | null> },
        bodyRef: { current: null as HTMLDivElement | null },
      }
      const view = render(<BookStage {...common} fontSize={18} />)
      await waitFor(() => expect(view.container.querySelector('.novel-book-track.is-settled')).not.toBeNull())
      expect(onConsumeInitialParagraph).toHaveBeenCalledTimes(1)
      expect(view.container.querySelector('[data-novel-page-num]')?.textContent).toContain('第 5–6')

      // 增大字号后第 1 段向右顺延到 3800px，依然对齐到该段所在屏而不是退回更前页
      p1Left = 3800
      view.rerender(<BookStage {...common} fontSize={22} initialParagraph={null} />)
      await waitFor(() => expect(view.container.querySelector('[data-novel-page-num]')?.textContent).toContain('第 7–8'))
    } finally {
      scrollWidth.mockRestore()
      rectSpy.mockRestore()
    }
  })

  it('调字号不改变翻页书页与书壳宽度，调栏宽档位才会改变宽度', () => {
    const common = {
      chapterIndex: 0,
      totalChapters: 2,
      chapterName: '第一章',
      content: SAMPLE_CHAPTER,
      loading: false,
      bookKey: 'book-1',
      lineHeight: 1.8,
      columnMode: 'single' as const,
      animation: 'none' as const,
      initialRatio: 0,
      listenParagraph: null,
      listenFollowing: false,
      keyboardBlocked: false,
      onNavigate: () => {},
      onChangeChapter: () => {},
      onReportRatio: () => {},
      onUserIntent: () => {},
      chapterRefs: { current: [] as Array<HTMLDivElement | null> },
      bodyRef: { current: null as HTMLDivElement | null },
    }
    const view = render(<BookStage {...common} fontSize={16} measure={680} />)
    const widths = (): { shell: string; track: string } => {
      const shell = view.container.querySelector('.novel-book-shell') as HTMLElement
      const track = view.container.querySelector('.novel-book-track') as HTMLElement
      return { shell: shell.style.width, track: track.style.width }
    }
    const initial = widths()
    expect(initial.track).toBe('680px')

    view.rerender(<BookStage {...common} fontSize={26} measure={680} />)
    expect(widths()).toEqual(initial)

    view.rerender(<BookStage {...common} fontSize={26} measure={520} />)
    expect(widths().track).toBe('520px')
    expect(widths().shell).not.toBe(initial.shell)
  })

  it('听书跟随开启时带 initialParagraph 挂载仍消费并清理 modeAnchor，避免污染后续跳章', async () => {
    const scrollWidth = vi.spyOn(Element.prototype, 'scrollWidth', 'get')
      .mockImplementation(function (this: Element) {
        return this.classList.contains('novel-book-track') ? 5000 : 0
      })
    const onConsumeInitialParagraph = vi.fn()
    try {
      const view = render(
        <BookStage
          chapterIndex={0}
          totalChapters={2}
          chapterName="第一章"
          content={SAMPLE_CHAPTER}
          loading={false}
          bookKey="book-1"
          fontSize={18}
          lineHeight={1.8}
          measure={680}
          animation="none"
          initialRatio={0}
          initialParagraph={1}
          onConsumeInitialParagraph={onConsumeInitialParagraph}
          listenParagraph={0}
          listenFollowing={true}
          keyboardBlocked={false}
          onNavigate={() => {}}
          onChangeChapter={() => {}}
          onReportRatio={() => {}}
          onUserIntent={() => {}}
          chapterRefs={{ current: [] }}
          bodyRef={{ current: null }}
        />,
      )
      await waitFor(() => expect(view.container.querySelector('.novel-book-track.is-settled')).not.toBeNull())
      expect(onConsumeInitialParagraph).toHaveBeenCalledTimes(1)
    } finally {
      scrollWidth.mockRestore()
    }
  })
})

describe('normalizeMeasure legacy migration & clamping', () => {
  it('migrates legacy em tiers, scales other small values, clamps out-of-range px, and handles invalid input', () => {
    expect(normalizeMeasure(28)).toBe(520)
    expect(normalizeMeasure(32)).toBe(600)
    expect(normalizeMeasure(36)).toBe(680)
    expect(normalizeMeasure(44)).toBe(820)
    expect(normalizeMeasure(40)).toBe(720)
    expect(normalizeMeasure(10)).toBe(320)
    expect(normalizeMeasure(680)).toBe(680)
    expect(normalizeMeasure(200)).toBe(320)
    expect(normalizeMeasure(3000)).toBe(1400)
    expect(normalizeMeasure(0)).toBe(DEFAULT_PREFS.measure)
    expect(normalizeMeasure(-10)).toBe(DEFAULT_PREFS.measure)
    expect(normalizeMeasure(Number.NaN)).toBe(DEFAULT_PREFS.measure)
    expect(normalizeMeasure('680')).toBe(DEFAULT_PREFS.measure)
    expect(normalizeMeasure(undefined)).toBe(DEFAULT_PREFS.measure)
  })
})
