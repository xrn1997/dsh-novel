// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PREFS, prefsStore, setPref } from '../../src/client/store.js'
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

  it('toggles readingMode to page and exposes the three page animation options', () => {
    const view = render(<PrefsPanel zIndex={11} />)
    // 默认滚动模式下不展示翻页动效选项
    expect(view.queryByText('拟真翻书')).toBeNull()

    fireEvent.click(view.getByText('翻页阅读'))
    expect(prefsStore.get().readingMode).toBe('page')
    expect(view.getByText('拟真翻书')).toBeTruthy()
    expect(view.getByText('顺滑平移')).toBeTruthy()
    expect(view.getByText('极速直切')).toBeTruthy()

    fireEvent.click(view.getByText('顺滑平移'))
    expect(prefsStore.get().pageAnimation).toBe('slide')

    fireEvent.click(view.getByText('极速直切'))
    expect(prefsStore.get().pageAnimation).toBe('none')
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
          measure={36}
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
      expect(onChangeChapter).toHaveBeenCalledWith(2, 'start')
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
      expect(onChangeChapter).toHaveBeenCalledWith(0, 'end')
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
        measure: 36,
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
      expect(onChangeChapter).toHaveBeenCalledWith(0, 'end')
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
})
