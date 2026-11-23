import type { CSSProperties, MutableRefObject, ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useCopy } from '../copy/index.js'
import { listenParagraphElement } from '../reader-paragraph.js'
import {
  classifyClickZone,
  computePageCount,
  computeSpreadLayout,
  firstParagraphInSpread,
  pageRangeOfSpread,
  ratioForSpread,
  spreadForElementLeft,
  spreadForRatio,
} from '../reader-pagination.js'
import type { PageCount, ParagraphHorizontalSpan } from '../reader-pagination.js'
import type { PageAnimation } from '../store.js'
import { chapterBodyProjection } from '../util.js'
import { ChapterBody } from './ChapterBody.js'
import type { ChapterContent, LinkRole, ReadingTarget } from './types.js'

export interface BookStageProps {
  chapterIndex: number
  totalChapters: number
  chapterName: string
  content: ChapterContent | null
  loading: boolean
  bookKey: string
  fontSize: number
  lineHeight: number
  measure: number
  animation: PageAnimation
  initialRatio: number
  listenParagraph: number | null
  listenFollowing: boolean
  locateTick?: number
  keyboardBlocked: boolean
  onNavigate: (target: ReadingTarget, role: LinkRole) => void
  onChangeChapter: (nextChapter: number, landAt: 'start' | 'end') => void
  onReportRatio: (ratio: number) => void
  onUserIntent: () => void
  chapterRefs: MutableRefObject<Array<HTMLDivElement | null>>
  bodyRef: MutableRefObject<HTMLDivElement | null>
  probeParagraphRef?: MutableRefObject<(() => number) | null>
}

interface TurnMotion {
  seq: number
  kind: 'flip' | 'slide'
  dir: 'next' | 'prev'
  crossChapter?: boolean
}

const WHEEL_COOLDOWN_MS = 260
const SWIPE_THRESHOLD_PX = 42
const DEFAULT_STAGE_WIDTH = 980
const DEFAULT_STAGE_HEIGHT = 620
const STAGE_PAD_X = 112
const STAGE_PAD_Y = 116
const FLIP_CLEANUP_MS = 620
const SLIDE_CLEANUP_MS = 340

function interactiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.closest('a, button, input, textarea, select, [role="button"], [role="link"]') !== null
}

function insideEditableOrControl(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable) {
    return true
  }
  return target.closest('button, a[href], [role="button"], [role="link"]') !== null
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function elementLeftForParagraph(el: Element, trackLeft: number, listenParagraph: number): number {
  const rects = typeof el.getClientRects === 'function' ? Array.from(el.getClientRects()) : []
  const valid = rects.filter((r) => r.width > 0 || r.height > 0)
  if (valid.length === 0) return el.getBoundingClientRect().left - trackLeft
  const first = valid[0]
  const last = valid[valid.length - 1]
  if (first === undefined || last === undefined) return el.getBoundingClientRect().left - trackLeft
  // 超长段落若跨页且被二次切分为多个播放单元，念到后续单元时自动切到后半段所在页
  const raw = el.getAttribute('data-pidx')
  const startPid = raw === null ? Number.NaN : Number(raw)
  if (Number.isInteger(startPid) && listenParagraph > startPid && last.left > first.left + 8) {
    return last.left - trackLeft
  }
  return first.left - trackLeft
}

function findLiveParagraphElement(track: HTMLElement, listenParagraph: number): Element | null {
  return track.querySelector('.novel-tts-live') ?? listenParagraphElement(track, listenParagraph)
}

function paragraphSpansInTrack(track: HTMLElement): ParagraphHorizontalSpan[] {
  const trackLeft = track.getBoundingClientRect().left
  const spans: ParagraphHorizontalSpan[] = []
  for (const el of track.querySelectorAll('[data-pidx]')) {
    const raw = el.getAttribute('data-pidx')
    const pid = raw === null ? Number.NaN : Number(raw)
    if (!Number.isInteger(pid)) continue
    const rects = typeof el.getClientRects === 'function' ? el.getClientRects() : null
    if (rects !== null && rects.length > 0) {
      let minLeft = Number.POSITIVE_INFINITY
      let maxRight = Number.NEGATIVE_INFINITY
      for (const r of Array.from(rects)) {
        if (r.width === 0 && r.height === 0) continue
        if (r.left < minLeft) minLeft = r.left
        if (r.right > maxRight) maxRight = r.right
      }
      if (Number.isFinite(minLeft) && Number.isFinite(maxRight)) {
        spans.push({ paragraphIndex: pid, left: minLeft - trackLeft, right: maxRight - trackLeft })
        continue
      }
    }
    const box = el.getBoundingClientRect()
    spans.push({ paragraphIndex: pid, left: box.left - trackLeft, right: box.right - trackLeft })
  }
  return spans
}

/**
 * 翻页阅读舞台：基于 CSS multi-column 实现厚实精装书质感 + 自适应单/双页摊开阅读。
 * - 宽屏（≥860px）自动双页对开，窄屏自动切回单页
 * - 纯 CSS 轻盈动效（零正文 DOM 复制）：拟真翻书（柔焦 3D 透明纸页掠影）、顺滑平移（横向柔焦）、极速直切
 * - 完整支持点击左右区、键盘、滚轮、手势滑动、进度落盘以及与听书双向精准同步
 */
export function BookStage(props: BookStageProps): ReactNode {
  const {
    chapterIndex, totalChapters, chapterName, content,
    loading, bookKey, fontSize, lineHeight, measure, animation, initialRatio,
    listenParagraph, listenFollowing, locateTick = 0, keyboardBlocked,
    onNavigate, onChangeChapter, onReportRatio, onUserIntent,
    chapterRefs, bodyRef, probeParagraphRef,
  } = props
  const t = useCopy()

  const stageRef = useRef<HTMLDivElement | null>(null)
  const trackRef = useRef<HTMLDivElement | null>(null)
  const [stageSize, setStageSize] = useState<{ width: number; height: number }>({
    width: DEFAULT_STAGE_WIDTH,
    height: DEFAULT_STAGE_HEIGHT,
  })
  const [pageCount, setPageCount] = useState<PageCount>({ totalColumns: 1, totalSpreads: 1 })
  const [spreadIndex, setSpreadIndex] = useState<number>(0)
  const [measuredChapter, setMeasuredChapter] = useState<number>(-1)
  const [layoutVersion, setLayoutVersion] = useState<number>(0)
  const [motion, setMotion] = useState<TurnMotion | null>(null)

  const spreadIndexRef = useRef<number>(0)
  spreadIndexRef.current = spreadIndex
  const measuredChapterRef = useRef<number>(-1)
  const listenRef = useRef<{ following: boolean; paragraph: number | null }>({
    following: listenFollowing,
    paragraph: listenParagraph,
  })
  listenRef.current = { following: listenFollowing, paragraph: listenParagraph }

  const motionSeqRef = useRef<number>(0)
  const motionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastWheelRef = useRef<number>(0)
  const touchStartRef = useRef<{ x: number; y: number } | null>(null)
  const ratioRef = useRef<number>(initialRatio)
  const pendingLandRef = useRef<'start' | 'end' | 'ratio'>('ratio')
  const prevChapterRef = useRef<number>(chapterIndex)

  const clearMotionTimer = useCallback((): void => {
    if (motionTimerRef.current !== null) {
      clearTimeout(motionTimerRef.current)
      motionTimerRef.current = null
    }
  }, [])

  const triggerMotion = useCallback((dir: 'next' | 'prev', crossChapter = false): void => {
    if (animation === 'none' || prefersReducedMotion()) return
    clearMotionTimer()
    motionSeqRef.current += 1
    const seq = motionSeqRef.current
    const kind = animation
    setMotion({ seq, kind, dir, crossChapter })
    const duration = kind === 'flip' ? FLIP_CLEANUP_MS : SLIDE_CLEANUP_MS
    motionTimerRef.current = setTimeout(() => {
      motionTimerRef.current = null
      setMotion((cur) => (cur !== null && cur.seq === seq ? null : cur))
    }, duration)
  }, [animation, clearMotionTimer])

  const finishMotion = useCallback((seq: number): void => {
    clearMotionTimer()
    setMotion((cur) => (cur !== null && cur.seq === seq ? null : cur))
  }, [clearMotionTimer])

  useEffect(() => () => { clearMotionTimer() }, [clearMotionTimer])

  // 切换动画模式时立刻清掉挂起动效
  useEffect(() => {
    clearMotionTimer()
    setMotion(null)
  }, [animation, clearMotionTimer])

  // 同步外部切换章节（目录跳转 / 听书跨章 / 按钮跨章）
  if (prevChapterRef.current !== chapterIndex) {
    prevChapterRef.current = chapterIndex
    if (pendingLandRef.current === 'ratio') {
      ratioRef.current = initialRatio
    }
  }

  // 监听舞台容器尺寸：自适应单/双页 + 窗口缩放重排
  useEffect(() => {
    const el = stageRef.current
    if (el === null) return
    const measureStage = (): void => {
      const rect = el.getBoundingClientRect()
      const w = rect.width > 0 ? rect.width : DEFAULT_STAGE_WIDTH
      const h = rect.height > 0 ? rect.height : DEFAULT_STAGE_HEIGHT
      setStageSize((prev) => (
        Math.abs(prev.width - w) < 2 && Math.abs(prev.height - h) < 2
          ? prev
          : { width: w, height: h }
      ))
    }
    measureStage()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measureStage)
    ro.observe(el)
    return () => { ro.disconnect() }
  }, [])

  const availableWidth = Math.max(240, stageSize.width - STAGE_PAD_X)
  const pageHeight = Math.max(220, Math.floor(stageSize.height - STAGE_PAD_Y))
  const layout = useMemo(
    () => computeSpreadLayout(availableWidth, measure, fontSize),
    [availableWidth, measure, fontSize],
  )
  const isDouble = layout.columnsPerSpread === 2

  const body = useMemo(
    () => (content === null ? null : chapterBodyProjection(content, chapterName)),
    [content, chapterName],
  )

  // 注册翻页模式阅读探针：供「听书」按钮精准从当前页第一段起播
  useEffect(() => {
    if (probeParagraphRef === undefined) return
    probeParagraphRef.current = () => {
      const track = trackRef.current
      if (track === null) return 0
      const spans = paragraphSpansInTrack(track)
      return firstParagraphInSpread(spans, spreadIndexRef.current, layout.stride, layout.contentWidth)
    }
    return () => { probeParagraphRef.current = null }
  }, [probeParagraphRef, layout.stride, layout.contentWidth])

  // 内容、章号、字号、行距、尺寸变化后测量多栏总宽度并站定目标屏
  useEffect(() => {
    if (content === null) {
      measuredChapterRef.current = -1
      setMeasuredChapter(-1)
      setPageCount({ totalColumns: 1, totalSpreads: 1 })
      setSpreadIndex(0)
      return
    }
    const measureTrack = (): void => {
      const track = trackRef.current
      if (track === null) return
      const nextCount = computePageCount(
        track.scrollWidth, layout.columnWidth, layout.columnGap, layout.columnsPerSpread,
      )
      setPageCount(nextCount)
      const land = pendingLandRef.current
      let targetSpread: number
      if (land === 'end') {
        targetSpread = nextCount.totalSpreads - 1
      } else if (land === 'start') {
        targetSpread = 0
      } else if (listenRef.current.following && listenRef.current.paragraph !== null) {
        const el = findLiveParagraphElement(track, listenRef.current.paragraph)
        if (el !== null) {
          const leftInTrack = elementLeftForParagraph(el, track.getBoundingClientRect().left, listenRef.current.paragraph)
          targetSpread = spreadForElementLeft(leftInTrack, layout.stride, nextCount.totalSpreads)
        } else {
          targetSpread = spreadForRatio(ratioRef.current, nextCount.totalSpreads)
        }
      } else {
        targetSpread = spreadForRatio(ratioRef.current, nextCount.totalSpreads)
      }
      pendingLandRef.current = 'ratio'
      measuredChapterRef.current = chapterIndex
      spreadIndexRef.current = targetSpread
      setSpreadIndex(targetSpread)
      setMeasuredChapter(chapterIndex)
      ratioRef.current = ratioForSpread(targetSpread, nextCount.totalSpreads)
      setLayoutVersion((v) => v + 1)
    }
    const raf = requestAnimationFrame(measureTrack)
    return () => { cancelAnimationFrame(raf) }
  }, [content, chapterIndex, layout.columnWidth, layout.columnGap, layout.columnsPerSpread, layout.stride, pageHeight, fontSize, lineHeight])

  // 听书自动跟读：当播放段落在本章内推进或点击「定位」时，直接对齐真实高亮块并同步进度
  useEffect(() => {
    if (!listenFollowing || listenParagraph === null || content === null) return
    if (measuredChapterRef.current !== chapterIndex) return
    const track = trackRef.current
    if (track === null) return
    const el = findLiveParagraphElement(track, listenParagraph)
    if (el === null) return
    const leftInTrack = elementLeftForParagraph(el, track.getBoundingClientRect().left, listenParagraph)
    const targetSpread = spreadForElementLeft(leftInTrack, layout.stride, pageCount.totalSpreads)
    const curSpread = spreadIndexRef.current
    if (targetSpread === curSpread) return
    triggerMotion(targetSpread > curSpread ? 'next' : 'prev')
    spreadIndexRef.current = targetSpread
    setSpreadIndex(targetSpread)
    const ratio = ratioForSpread(targetSpread, pageCount.totalSpreads)
    ratioRef.current = ratio
    onReportRatio(ratio)
  }, [
    listenFollowing, listenParagraph, content, chapterIndex,
    layoutVersion, locateTick, layout.stride, pageCount.totalSpreads,
    triggerMotion, onReportRatio,
  ])

  const canPrev = spreadIndex > 0 || chapterIndex > 0
  const canNext = spreadIndex + 1 < pageCount.totalSpreads || (totalChapters > 0 && chapterIndex + 1 < totalChapters)

  const goNext = useCallback((): void => {
    onUserIntent()
    if (spreadIndex + 1 < pageCount.totalSpreads) {
      const next = spreadIndex + 1
      triggerMotion('next')
      spreadIndexRef.current = next
      setSpreadIndex(next)
      const ratio = ratioForSpread(next, pageCount.totalSpreads)
      ratioRef.current = ratio
      onReportRatio(ratio)
      return
    }
    if (totalChapters > 0 && chapterIndex + 1 < totalChapters) {
      triggerMotion('next', true)
      pendingLandRef.current = 'start'
      ratioRef.current = 0
      onChangeChapter(chapterIndex + 1, 'start')
    }
  }, [onUserIntent, spreadIndex, pageCount.totalSpreads, triggerMotion, onReportRatio, totalChapters, chapterIndex, onChangeChapter])

  const goPrev = useCallback((): void => {
    onUserIntent()
    if (spreadIndex > 0) {
      const prev = spreadIndex - 1
      triggerMotion('prev')
      spreadIndexRef.current = prev
      setSpreadIndex(prev)
      const ratio = ratioForSpread(prev, pageCount.totalSpreads)
      ratioRef.current = ratio
      onReportRatio(ratio)
      return
    }
    if (chapterIndex > 0) {
      triggerMotion('prev', true)
      pendingLandRef.current = 'end'
      onChangeChapter(chapterIndex - 1, 'end')
    }
  }, [onUserIntent, spreadIndex, pageCount.totalSpreads, triggerMotion, onReportRatio, chapterIndex, onChangeChapter])

  // 键盘翻页：← / PageUp 上一页，→ / PageDown / Space 下一页
  useEffect(() => {
    if (keyboardBlocked) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.ctrlKey || event.metaKey || event.altKey) return
      if (insideEditableOrControl(event.target)) return
      if (event.key === 'ArrowRight' || event.key === 'PageDown' || event.key === ' ' || event.key === 'Spacebar') {
        event.preventDefault()
        goNext()
      } else if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
        event.preventDefault()
        goPrev()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [keyboardBlocked, goNext, goPrev])

  const onBookClick = (event: React.MouseEvent<HTMLDivElement>): void => {
    if (interactiveTarget(event.target)) return
    const selection = typeof window !== 'undefined' ? window.getSelection()?.toString() : ''
    if (selection !== undefined && selection.length > 0) return
    const rect = event.currentTarget.getBoundingClientRect()
    const zone = classifyClickZone(event.clientX, rect.left, rect.width)
    if (zone === 'next') goNext()
    else if (zone === 'prev') goPrev()
  }

  const onBookWheel = (event: React.WheelEvent<HTMLDivElement>): void => {
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
    if (Math.abs(delta) < 12) return
    const now = Date.now()
    if (now - lastWheelRef.current < WHEEL_COOLDOWN_MS) return
    lastWheelRef.current = now
    if (delta > 0) goNext()
    else goPrev()
  }

  const onTouchStart = (event: React.TouchEvent<HTMLDivElement>): void => {
    const touch = event.touches[0]
    if (touch === undefined) return
    touchStartRef.current = { x: touch.clientX, y: touch.clientY }
  }

  const onTouchEnd = (event: React.TouchEvent<HTMLDivElement>): void => {
    const start = touchStartRef.current
    touchStartRef.current = null
    const touch = event.changedTouches[0]
    if (start === null || touch === undefined) return
    const dx = touch.clientX - start.x
    const dy = touch.clientY - start.y
    if (Math.abs(dx) < SWIPE_THRESHOLD_PX || Math.abs(dx) <= Math.abs(dy)) return
    if (dx < 0) goNext()
    else goPrev()
  }

  const range = pageRangeOfSpread(spreadIndex, layout.columnsPerSpread, pageCount.totalColumns)
  const pageLabel = range.from === range.to
    ? t('reader.pageIndicator', { current: range.from, total: range.total })
    : t('reader.pageRangeIndicator', { from: range.from, to: range.to, total: range.total })

  const shellStyle: CSSProperties = {
    width: layout.contentWidth + 56,
    '--novel-book-page-h': `${pageHeight}px`,
  } as CSSProperties

  const trackStyle: CSSProperties = {
    width: layout.contentWidth,
    height: pageHeight,
    fontSize,
    lineHeight,
    columnCount: layout.columnsPerSpread,
    columnWidth: layout.columnWidth,
    columnGap: layout.columnGap,
    transform: `translate3d(${-spreadIndex * layout.stride}px, 0, 0)`,
  }

  const trackSettled = measuredChapter === chapterIndex
  const trackClass = [
    'novel-book-track',
    trackSettled ? 'is-settled' : '',
    motion !== null && motion.kind === 'flip' ? 'is-flipping' : '',
    motion !== null && motion.kind === 'slide' && motion.crossChapter !== true ? 'is-sliding' : '',
  ].filter((c) => c !== '').join(' ')

  const chapterClass = motion !== null && motion.kind === 'slide' && motion.crossChapter === true
    ? `novel-book-chapter is-slide-enter-${motion.dir}`
    : 'novel-book-chapter'

  return (
    <div
      ref={stageRef}
      data-novel-book-stage
      data-page-layout={isDouble ? 'spread' : 'single'}
      data-page-anim={animation}
      className="novel-book-stage"
      onWheel={onBookWheel}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      {/* 外层硬壳书封：提供物理书封边、中央书脊凹槽与桌面立体投影 */}
      <div className={isDouble ? 'novel-book-cover is-spread' : 'novel-book-cover is-single'}>
        {isDouble && <div className="novel-book-binding-back" aria-hidden="true" />}
        <div className="novel-book-edge novel-book-edge-left" aria-hidden="true" />
        {/* 书页本体块：底部叠页与拱形底衬同属一个坐标系，确保中缝与弯弧像素级对齐 */}
        <div
          className={isDouble ? 'novel-book-shell is-spread' : 'novel-book-shell is-single'}
          style={shellStyle}
          onClick={onBookClick}
        >
          {isDouble ? (
            <>
              <div className="novel-book-edge-bottom is-left" aria-hidden="true" />
              <div className="novel-book-edge-bottom is-right" aria-hidden="true" />
              <div className="novel-book-arch novel-book-arch-left" aria-hidden="true" />
              <div className="novel-book-arch novel-book-arch-right" aria-hidden="true" />
              <div className="novel-book-spine" aria-hidden="true" />
            </>
          ) : (
            <>
              <div className="novel-book-edge-bottom is-single" aria-hidden="true" />
              <div className="novel-book-arch novel-book-arch-single" aria-hidden="true" />
            </>
          )}
          <div className="novel-book-viewport" style={{ width: layout.contentWidth, height: pageHeight }}>
            {/* 静态正文裁剪盒：仅裁剪静态多栏轨道，外层 viewport 保持 overflow:visible 避免切掉翻页顶底角 */}
            <div className="novel-book-track-clip" style={{ width: layout.contentWidth, height: pageHeight }}>
              {content === null ? (
                <div className="novel-rdr-loading">
                  {loading ? t('common.loading') : t('reader.tocLoading')}
                </div>
              ) : (
                <div
                  key={chapterIndex}
                  ref={(el) => {
                    trackRef.current = el
                    bodyRef.current = el
                  }}
                  className={trackClass}
                  style={trackStyle}
                >
                  <div
                    ref={(el) => { chapterRefs.current[chapterIndex] = el }}
                    data-chapter={chapterIndex}
                    className={chapterClass}
                  >
                    <h2 className="novel-rdr-mark">{chapterName}</h2>
                    {body !== null && (
                      <ChapterBody
                        content={body.content}
                        bookKey={bookKey}
                        onNavigate={onNavigate}
                        paragraphBase={body.paragraphBase}
                        listenParagraph={listenParagraph}
                      />
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* 纯 CSS 轻盈 3D 翻页层（零正文 DOM 复制）：半透明柔焦纸页轻掠书脊 + 柔和扫影 */}
            {animation === 'flip' && motion !== null && motion.kind === 'flip' && (
              <div
                key={motion.seq}
                aria-hidden="true"
                className={`novel-book-flip-stage ${isDouble ? 'is-spread' : 'is-single'} dir-${motion.dir}`}
              >
                <div className={`novel-book-cast-shadow ${isDouble ? 'is-spread' : 'is-single'} dir-${motion.dir}`} />
                <div
                  className={`novel-book-leaf ${isDouble ? 'is-spread' : 'is-single'} dir-${motion.dir}`}
                  onAnimationEnd={(event) => {
                    if (event.target === event.currentTarget) finishMotion(motion.seq)
                  }}
                />
              </div>
            )}
          </div>
          <div className="novel-book-footer">
            <button
              type="button"
              className="novel-book-nav"
              aria-label={t('reader.pagePrev')}
              disabled={!canPrev}
              onClick={goPrev}
            >
              ‹ {t('reader.pagePrev')}
            </button>
            <span className="novel-book-page-num" data-novel-page-num>{pageLabel}</span>
            <button
              type="button"
              className="novel-book-nav"
              aria-label={t('reader.pageNext')}
              disabled={!canNext}
              onClick={goNext}
            >
              {t('reader.pageNext')} ›
            </button>
          </div>
        </div>
        <div className="novel-book-edge novel-book-edge-right" aria-hidden="true" />
      </div>
    </div>
  )
}
