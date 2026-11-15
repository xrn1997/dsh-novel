import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import type { TtsSourceInfo } from '../../shared/wire.js'
import { useCopy } from '../copy/index.js'
import { useStore } from '../store.js'
import { lineOf, miniSegmentLabel, rateLabel } from './listen-readout.js'
import { ChapterSeek, MINI_ICON, RingPlay } from './mini-parts.js'
import { useTimerReadout } from './use-timer-readout.js'
import { pushError } from '../transient.js'
import { TTS_MAX_CONSECUTIVE_FAILURES, skipParagraph, stopListening, ttsPlayer } from './player.js'
import { ttsErrorMessage } from './tts-error.js'
import { TtsSettingsNote, TtsSettingsPanel, TtsSettingsRows } from './TtsSettings.js'

/**
 * 展开形态：顶行身份钮 + 齿轮 / 正文区 / 运输行 / 底行读数（`ADR-0079` / `ADR-0080`）。
 *
 * 身份钮同时是**移动拖面**与**收起钮**：位移 ≥ 8px 算拖动，否则算点击；正文区也是拖面但点击无动作
 * （避免误收起）。齿轮、正文里的「看全文」、章内进度条都是真控件，从它们起手不拖也不 resize。
 * 高度由现场值槽给（`--novel-tts-panel-h`），正文区吃掉剩余高度、装不下的那一截挂「看全文 →」；
 * 浮窗仍不滚动、不翻页（`ADR-0079` 的边界）。
 */
export interface TtsMiniPanelProps {
  sources: TtsSourceInfo[] | null
  settingsOpen: boolean
  onToggleSettings: () => void
  onCloseSettings: () => void
  onCollapse: () => void
  onBackToReader: () => void
  onDragPointerDown: (event: ReactPointerEvent<HTMLElement>) => void
  onHeaderKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void
  /** 设置弹层的内容实测高（`null` = 量不到，调用方回退常量）：翻转判据要吃真占位，
   *  拿固定档会在六行卡与一行卡之间两头撒谎。 */
  onSettingsContentHeight?: (height: number | null) => void
}

export function TtsMiniPanel({
  sources, settingsOpen, onToggleSettings, onCloseSettings, onCollapse, onBackToReader,
  onDragPointerDown, onHeaderKeyDown, onSettingsContentHeight,
}: TtsMiniPanelProps): ReactNode {
  const t = useCopy()
  const st = useStore(ttsPlayer)
  const line = lineOf(st)
  const timer = useTimerReadout(st, t)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [truncated, setTruncated] = useState(false)
  const failed = st.consecutiveFailures >= TTS_MAX_CONSECUTIVE_FAILURES && !st.playing
  const skip = (delta: 1 | -1): void => {
    void skipParagraph(delta).catch((error: unknown) => { pushError(ttsErrorMessage(t, error)) })
  }
  const sub = `${st.title} · ${t('tts.mini.chapter', { n: st.chapterIndex + 1 })}`
  const showFoot = st.paragraphCount > 0 || st.rate !== 1 || timer.counting

  // 截断判据取实际几何（字数估算会撒谎）：换段、换尺寸都会重跑；没有 ResizeObserver 的宿主只量一次。
  useEffect(() => {
    const el = bodyRef.current
    if (el === null) return
    const measure = (): void => { setTruncated(el.scrollHeight > el.clientHeight + 1) }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => { observer.disconnect() }
  }, [line])

  // 设置弹层的内容实测高：量不到（无布局宿主 / 还没挂上）就报 null，翻转判据回退常量。
  // 弹层自身有 `max-height: 60vh`，量的是自然内容高（scrollHeight），取小那一档由判据做。
  useEffect(() => {
    if (onSettingsContentHeight === undefined) return
    if (!settingsOpen) {
      onSettingsContentHeight(null)
      return
    }
    const panel = rootRef.current?.querySelector<HTMLElement>('.novel-tts-panel') ?? null
    if (panel === null) return
    const measure = (): void => {
      const height = panel.scrollHeight
      onSettingsContentHeight(Number.isFinite(height) && height > 0 ? height : null)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(panel)
    return () => { observer.disconnect() }
  }, [settingsOpen, onSettingsContentHeight])

  return (
    <div className="novel-tts-mini-panel" ref={rootRef}>
      <div className="novel-tts-mini-head">
        <button
          type="button"
          className="novel-tts-mini-id"
          data-drag="1"
          aria-label={`${t('tts.mini.collapse')} · ${sub}`}
          title={t('tts.mini.dragHint')}
          onPointerDown={onDragPointerDown}
          onKeyDown={onHeaderKeyDown}
          onClick={onCollapse}
        >
          <span className="novel-tts-mini-title">{sub}</span>
          <span className="novel-tts-mini-chev" aria-hidden="true">{MINI_ICON.chevDown}</span>
        </button>
        <button
          type="button"
          className={settingsOpen ? 'novel-tts-ictl sm novel-tts-on' : 'novel-tts-ictl sm'}
          aria-label={t('tts.settings')}
          title={t('tts.settings')}
          aria-expanded={settingsOpen}
          onClick={onToggleSettings}
        >
          {MINI_ICON.gear}
        </button>
      </div>
      <div
        ref={bodyRef}
        className={st.paragraphCount === 0 ? 'novel-tts-mini-body empty' : 'novel-tts-mini-body'}
        data-drag="1"
        onPointerDown={onDragPointerDown}
      >
        {line === null ? t('tts.emptyChapter') : line}
        {truncated && line !== null
          ? (
            <button type="button" className="novel-tts-mini-more" onClick={onBackToReader}>
              {t('tts.mini.viewAll')}
            </button>
          )
          : null}
      </div>
      {/* 连败暂停的可见读数：与阅读器条同一条判据、同一份文案键；真开口后计数清零即消失。 */}
      {failed
        ? <div className="novel-tts-fail" role="status">{t('tts.failedHint', { n: st.consecutiveFailures })}</div>
        : null}
      <div className="novel-tts-mini-acts">
        <button
          type="button"
          className="novel-tts-ictl"
          aria-label={t('tts.mini.backToReader')}
          title={t('tts.mini.backToReader')}
          onClick={onBackToReader}
        >
          {MINI_ICON.book}
        </button>
        <button
          type="button"
          className="novel-tts-ictl"
          aria-label={t('tts.prevParagraph')}
          title={t('tts.prevParagraph')}
          onClick={() => { skip(-1) }}
        >
          {MINI_ICON.prev}
        </button>
        <RingPlay />
        <button
          type="button"
          className="novel-tts-ictl"
          aria-label={t('tts.nextParagraph')}
          title={t('tts.nextParagraph')}
          onClick={() => { skip(1) }}
        >
          {MINI_ICON.next}
        </button>
        <button
          type="button"
          className="novel-tts-ictl quiet"
          aria-label={t('tts.stop')}
          title={t('tts.stop')}
          onClick={stopListening}
        >
          {MINI_ICON.stop}
        </button>
      </div>
      {showFoot
        ? (
          <div className="novel-tts-mini-foot">
            {st.rate !== 1 ? <span className="novel-tts-ro">{rateLabel(st, t)}</span> : null}
            {st.paragraphCount > 0 ? <span className="novel-tts-ro">{miniSegmentLabel(st, t)}</span> : null}
            <ChapterSeek />
            {timer.counting ? <span className="novel-tts-ro">{timer.label}</span> : null}
          </div>
        )
        : null}
      {settingsOpen && (
        <TtsSettingsPanel label={t('tts.settings')} onClose={onCloseSettings}>
          <TtsSettingsRows sources={sources} surface="float" />
          <TtsSettingsNote />
        </TtsSettingsPanel>
      )}
    </div>
  )
}
