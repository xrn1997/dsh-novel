import type { ReactNode } from 'react'
import { useState } from 'react'
import { useCopy } from '../copy/index.js'
import { useStore } from '../store.js'
import {
  chapterProgressOf, lineOf, listenFaceOf, rateLabel, segmentLabel,
} from './listen-readout.js'
import type { TtsPlayerState } from './player.js'
import { useTimerReadout } from './use-timer-readout.js'
import {
  pauseListening, playFromReadingPosition, resumeListening, seekParagraph,
  skipChapter, skipParagraph, stopListening, ttsPlayer, ttsProgress,
} from './player.js'
import { TtsSettingsNote, TtsSettingsPanel, TtsSettingsRows } from './TtsSettings.js'
import { ttsErrorMessage } from './tts-error.js'
import { useTtsSources } from './use-tts-sources.js'

/**
 * 阅读器内嵌听书条：本书是正在听的会话时才由 ReaderView 挂载。
 *
 * 条底跟纸走（`.novel-tts-bar` 的 `--novel-paper` 派生，与 `.novel-rdr-bar` 同一条判据），
 * 设置面板复用共享件（`TtsSettings.tsx`，与全局迷你条同一份行清单与浮层契约）。条上只管当前段
 * 与常用动作，引擎 / 音量 / 起播点这类低频设置收进面板——「从阅读位置起播」只在这里出现：它读的
 * 探针量的是**当前打开的书**，而本组件只在「本书 = 正在听的书」时挂载，闸门由挂载条件给出。
 *
 * 进度面只有一条：末行整宽的章内段滑杆。段内时间滑杆不再上条（`ADR-0075`）——听书的落盘与导航
 * 粒度本来就是段，第二条时间轴只让读者多分辨一次「哪条能拖」。
 *
 * 文案全走 `useCopy()`（字典在 `copy/tts.ts`）；播放失败码在这里翻成人话，裸码不上屏。
 */
export interface TtsBarProps {
  darkController: boolean
  /** 引擎清单读面（打开面板时取一次；注入面与阅读器其余读数同一束） */
  apiGet: <T>(path: string) => Promise<T>
  /** 失败上报：面板取数失败与起播失败都走瞬态层，不在条内自造第二个错误家 */
  pushError: (message: string) => void
  /** 「定位到正在念的段」：滚动归阅读器视图（它才持滚动容器与章块 ref），条只发意图 */
  onLocate: () => void
}

export function TtsBar({ darkController, apiGet, pushError, onLocate }: TtsBarProps): ReactNode {
  const t = useCopy()
  const st = useStore(ttsPlayer)
  // 整块上屏投影（能否暂停 / 连败停的读数 / 空章抑制）：判据全住 `listen-readout.ts`，
  // 这里不拿计数器对比阈值、也不自己查空章。
  const face = listenFaceOf(st)
  const [panelOpen, setPanelOpen] = useState(false)
  const sources = useTtsSources(panelOpen, apiGet, pushError)

  // 定时读数的每秒节拍归 `useTimerReadout`（与浮窗定时 chip 同一份）：不挂表时读数只在会话
  // 状态变化时挪一格——暂停中与直出型（没有计时介质）下就冻在旧读数上。
  const timer = useTimerReadout(st, t)

  if (!st.active) return null

  const report = (error: unknown): void => { pushError(ttsErrorMessage(t, error)) }
  const run = (pending: Promise<void>): void => { void pending.catch(report) }

  return (
    <div className={darkController ? 'novel-dark novel-tts-bar' : 'novel-tts-bar'}>
      {panelOpen && (
        <TtsSettingsPanel label={t('tts.settings')} onClose={() => { setPanelOpen(false) }}>
          <TtsSettingsRows sources={sources} surface="bar" />
          <div className="novel-tts-row novel-tts-actions">
            <button className="novel-chip" onClick={() => { run(playFromReadingPosition()) }}>
              {t('tts.fromReading')}
            </button>
            <button className="novel-chip" onClick={() => { run(skipChapter(-1)) }}>{t('tts.prevChapter')}</button>
            <button className="novel-chip" onClick={() => { run(skipChapter(1)) }}>{t('tts.nextChapter')}</button>
          </div>
          <TtsSettingsNote />
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
        <button className="novel-rdr-ctl" title={t('tts.rate')} aria-expanded={panelOpen}
          onClick={() => { setPanelOpen((open) => !open) }}>
          {rateLabel(st, t)}
        </button>
        <button className="novel-rdr-ctl" title={t('tts.timer')} aria-expanded={panelOpen}
          onClick={() => { setPanelOpen((open) => !open) }}>
          {timer.label}
        </button>
        <button className={panelOpen ? 'novel-rdr-ctl novel-tts-on' : 'novel-rdr-ctl'}
          aria-label={t('tts.settings')} title={t('tts.settings')} aria-expanded={panelOpen}
          onClick={() => { setPanelOpen((open) => !open) }}>
          <svg aria-hidden="true" viewBox="0 0 16 16">
            <circle cx="8" cy="8" r="2.2" />
            <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4" />
          </svg>
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

/**
 * 章内段滑杆：**只让这一小块订阅段进度**。timeupdate 约每秒四发，若由 `TtsBar` 订阅，
 * 整条听书条（连同展开的设置卡与它的章名列表）都会跟着重渲；`chapterProgressOf` 的算式
 * 仍只住 `listen-readout.ts`，这里只取成品。
 */
function ChapterSeekRow({ st, hasSegments }: { st: TtsPlayerState; hasSegments: boolean }): ReactNode {
  const t = useCopy()
  const progress = useStore(ttsProgress)
  if (!hasSegments) return null
  const chapter = chapterProgressOf(st, progress, t)
  // 连续 value 在末段念到段尾时会到 `count`，而滑杆的 domain 是 0..count-1：不夹这一下，
  // 受控值就超出 max（原生控件会静默夹取，读屏与表单状态却记着越界值）。
  const value = Math.min(chapter.count - 1, Math.max(0, Math.floor(chapter.value)))
  return (
    <div className="novel-tts-chapter-seek">
      <input
        className="novel-tts-range" type="range"
        min={0} max={chapter.count - 1} step={1}
        aria-label={t('tts.seekChapter')} value={value}
        aria-valuetext={chapter.readout}
        title={chapter.readout}
        onChange={(event) => { seekParagraph(Number(event.target.value)) }}
      />
    </div>
  )
}
