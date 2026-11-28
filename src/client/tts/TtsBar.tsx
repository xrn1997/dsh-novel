import type { CSSProperties, ReactNode, Ref } from 'react'
import { useEffect, useState } from 'react'
import { useCopy } from '../copy/index.js'
import { useStore } from '../store.js'
import { rangePercent } from '../util.js'
import { TTS_RATE } from '../../shared/wire.js'
import {
  chapterProgressOf, lineOf, listenFaceOf, rateLabel, segmentLabel, timerChoiceLabel,
} from './listen-readout.js'
import type { TtsPlayerState } from './player.js'
import { useTimerReadout } from './use-timer-readout.js'
import {
  pauseListening, playFromReadingPosition, resumeListening, seekParagraph, setListenRate, setListenTimer,
  skipChapter, skipParagraph, stopListening, ttsPlayer, ttsProgress,
} from './player.js'
import {
  SETTINGS_ICON, TtsSettingsNote, TtsSettingsPanel, TtsSettingsRows, nextTimerChoice,
} from './TtsSettings.js'
import { ttsErrorMessage } from './tts-error.js'
import { useTtsSources } from './use-tts-sources.js'

/** 条上语速单击循环的档位（设置卡滑杆仍可落到 0.1 的任意档）：升幂排列；当前值不在档位上时先落到
 *  下一个更大的档，越过上限回最低档。`tests/client/tts-bar.test.tsx` 钉整张表在定义域内且升序。 */
export const RATE_STEPS = [TTS_RATE.min, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, TTS_RATE.max] as const

function cycleRate(rate: number): number {
  for (const step of RATE_STEPS) {
    if (step > rate) return step
  }
  return RATE_STEPS[0]
}

/** 语速单击循环的唯一实现（摸鱼听书条同用一份档表与走法，别在表面各抄一遍）。 */
export { cycleRate }

/**
 * 阅读器内嵌听书条：本书是正在听的会话时才由 ReaderView 挂载。条底跟纸走；设置面板复用共享件
 * （`TtsSettings.tsx`，与全局迷你条同一份行清单与浮层契约）。条上只管当前段与常用动作——
 * 「从阅读位置起播」只在这里出现：它读的探针量的是当前打开的书，闸门由挂载条件给出。
 *
 * 进度面只有一条：末行整宽的章内段滑杆（段内时间滑杆不上条，`ADR-0075`——落盘与导航粒度本来就是段）。
 * 文案全走 `useCopy()`；播放失败码在这里翻成人话，裸码不上屏。
 */
export interface TtsBarProps {
  darkController: boolean
  /** 引擎清单读面（打开面板时取一次；注入面与阅读器其余读数同一束） */
  apiGet: <T>(path: string) => Promise<T>
  /** 失败上报：面板取数失败与起播失败都走瞬态层，不在条内自造第二个错误家 */
  pushError: (message: string) => void
  /** 「定位到正在念的段」：滚动归阅读器视图（它才持滚动容器与章块 ref），条只发意图 */
  onLocate: () => void
  /** 条根 ref：跟读自动跟随要量它的高度，作为「正文看得见的底界」（条贴视口底，目标段不许藏它下面） */
  rootRef?: Ref<HTMLDivElement>
  /** 听书设置卡片开关变化通知：供阅读器在卡片打开时让出翻页快捷键 */
  onPanelOpenChange?: (open: boolean) => void
}

export function TtsBar({ darkController, apiGet, pushError, onLocate, rootRef, onPanelOpenChange }: TtsBarProps): ReactNode {
  const t = useCopy()
  const st = useStore(ttsPlayer)
  // 整块上屏投影（能否暂停 / 连败停的读数 / 空章抑制）：判据全住 `listen-readout.ts`，这里不重算。
  const face = listenFaceOf(st)
  const [panelOpen, setPanelOpen] = useState(false)
  const sources = useTtsSources(panelOpen, apiGet, pushError)

  useEffect(() => {
    onPanelOpenChange?.(panelOpen)
    return () => { onPanelOpenChange?.(false) }
  }, [panelOpen, onPanelOpenChange])

  // 定时读数的每秒节拍归 `useTimerReadout`：不挂表时读数只在会话状态变化时挪一格。
  const timer = useTimerReadout(st, t)

  if (!st.active) return null

  const bumpRate = (): void => { setListenRate(cycleRate(ttsPlayer.get().rate)) }
  const bumpTimer = (): void => { setListenTimer(nextTimerChoice(ttsPlayer.get().timerChoice)) }

  const report = (error: unknown): void => { pushError(ttsErrorMessage(t, error)) }
  const run = (pending: Promise<void>): void => { void pending.catch(report) }

  return (
    <div
      ref={rootRef}
      data-empty-chapter={!face.hasSegments ? 'true' : undefined}
      className={darkController ? 'novel-dark novel-tts-bar' : 'novel-tts-bar'}
    >
      {panelOpen && (
        <TtsSettingsPanel label={t('tts.settings')} onClose={() => { setPanelOpen(false) }}>
          <TtsSettingsRows sources={sources} surface="bar" />
          <div className="novel-tts-group">
            <div className="novel-tts-actions">
              <button type="button" className="novel-chip" onClick={() => { run(playFromReadingPosition()) }}>
                {t('tts.fromReading')}
              </button>
              <button type="button" className="novel-chip" onClick={() => { run(skipChapter(-1)) }}>{t('tts.prevChapter')}</button>
              <button type="button" className="novel-chip" onClick={() => { run(skipChapter(1)) }}>{t('tts.nextChapter')}</button>
            </div>
            <TtsSettingsNote />
          </div>
        </TtsSettingsPanel>
      )}
      <div className="novel-tts-nav">
        <button className="novel-rdr-ctl" aria-label={t('tts.prevParagraph')} title={t('tts.prevParagraph')}
          onClick={() => { run(skipParagraph(-1)) }}>
          <svg aria-hidden="true" viewBox="0 0 16 16"><path d="M10 3 5 8l5 5" /></svg>
        </button>
        <button className="novel-tts-play" aria-label={face.busy ? t('tts.pause') : t('tts.play')}
          title={face.busy ? t('tts.pause') : t('tts.play')}
          onClick={() => { if (face.busy) pauseListening(); else resumeListening() }}>
          {face.busy
            ? <svg aria-hidden="true" viewBox="0 0 16 16"><path d="M5.5 3.5v9M10.5 3.5v9" /></svg>
            : <svg aria-hidden="true" viewBox="0 0 16 16"><path d="M5 3l8 5-8 5z" /></svg>}
        </button>
        <button className="novel-rdr-ctl" aria-label={t('tts.nextParagraph')} title={t('tts.nextParagraph')}
          onClick={() => { run(skipParagraph(1)) }}>
          <svg aria-hidden="true" viewBox="0 0 16 16"><path d="M6 3l5 5-5 5" /></svg>
        </button>
      </div>
      <div className="novel-tts-now">
        <span className="novel-tts-seg">
          {segmentLabel(st, t)}
        </span>
        <span className="novel-tts-preview">{lineOf(st)}</span>
      </div>
      <div className="novel-tts-chips">
        <button className="novel-rdr-ctl" aria-label={t('tts.locate')} title={t('tts.locate')}
          onClick={onLocate}>
          <svg aria-hidden="true" viewBox="0 0 16 16">
            <circle cx="8" cy="8" r="3.2" />
            <path d="M8 1.5v2.3M8 12.2v2.3M1.5 8h2.3M12.2 8h2.3" />
          </svg>
        </button>
        <button className="novel-rdr-ctl" title={t('tts.rate')}
          aria-label={t('tts.rateCycle', { rate: rateLabel(st, t) })}
          onClick={bumpRate}>
          {rateLabel(st, t)}
        </button>
        <button className="novel-rdr-ctl" title={t('tts.timer')}
          aria-label={t('tts.timerCycle', { timer: timerChoiceLabel(st.timerChoice, t) })}
          onClick={bumpTimer}>
          {timer.label}
        </button>
        <button className={panelOpen ? 'novel-rdr-ctl novel-tts-on' : 'novel-rdr-ctl'}
          aria-label={t('tts.settings')} title={t('tts.settings')} aria-expanded={panelOpen}
          onClick={() => { setPanelOpen((open) => !open) }}>
          {SETTINGS_ICON}
        </button>
        <button className="novel-rdr-ctl" aria-label={t('tts.stop')} title={t('tts.stop')}
          onClick={stopListening}>
          <svg aria-hidden="true" viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8" /></svg>
        </button>
      </div>
      {/* 连败暂停的可见读数：`role=status` 让读屏在不抢焦点的情况下播报；真开口后停因清零，
          这一行随状态消失。文案走 `copy/tts.ts`，组件不持数字以外的字。 */}
      {face.failedHint !== null
        ? <div className="novel-tts-fail" role="status">{t('tts.failedHint', { n: face.failedHint })}</div>
        : null}
      {/* 章内进度滑杆：整行宽、拖到任意段即起播（段粒度 = 听书位置的落盘粒度）。
          value 与浮窗填充同出 `chapterProgressOf` 的连续 value，这里取整到段——
          同一个读数的两种控件形态（条是段粒度滑杆、浮窗是连续填充）。空章不渲染。 */}
      <ChapterSeekRow st={st} hasSegments={face.hasSegments} />
    </div>
  )
}

/** 章内段滑杆：**只让这一小块订阅段进度**——timeupdate 约每秒四发，由 TtsBar 订阅会让整条连同设置卡重渲。
 *  `chapterProgressOf` 的算式仍只住 `listen-readout.ts`，这里只取成品。 */
function ChapterSeekRow({ st, hasSegments }: { st: TtsPlayerState; hasSegments: boolean }): ReactNode {
  const t = useCopy()
  const progress = useStore(ttsProgress)
  if (!hasSegments) return null
  const chapter = chapterProgressOf(st, progress, t)
  // 连续 value 在末段念到段尾时会到 `count`，而滑杆 domain 是 0..count-1：不夹这一下受控值就超出 max。
  const value = Math.min(chapter.count - 1, Math.max(0, Math.floor(chapter.value)))
  return (
    <div className="novel-tts-chapter-seek">
      <input
        className="novel-tts-range" type="range"
        min={0} max={chapter.count - 1} step={1}
        aria-label={t('tts.seekChapter')} value={value}
        aria-valuetext={chapter.readout}
        title={chapter.readout}
        style={{
          '--novel-range-fill': chapter.count <= 1 ? '100%' : rangePercent(value, 0, chapter.count - 1),
        } as CSSProperties}
        onChange={(event) => { seekParagraph(Number(event.target.value)) }}
      />
    </div>
  )
}
