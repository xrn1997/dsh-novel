import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import { useCopy } from '../copy/index.js'
import { useStore } from '../store.js'
import { chapterProgressOf, listenFaceOf } from './listen-readout.js'
import { pauseListening, resumeListening, seekParagraph, ttsPlayer, ttsProgress } from './player.js'

/** 图标与小件的**呈现层**：判据（能否暂停 / 空章抑制 / 段内进度是否真实）全部住
 *  `listen-readout.ts` 的 `listenFaceOf`，这里只按成品摆形状。 */

/** 浮窗两个形态共用的小件与图标：胶囊只带环，边栏再带定时读数与章内进度条。
 *  图标本身是装饰，可见语义由按钮的 aria-label / title 从 `copy/tts.ts` 取词。 */
export const MINI_ICON = {
  play: <svg aria-hidden="true" viewBox="0 0 16 16"><path d="M5 3.5v9l7-4.5z" /></svg>,
  pause: <svg aria-hidden="true" viewBox="0 0 16 16"><path d="M5.5 3.5v9M10.5 3.5v9" /></svg>,
  prev: <svg aria-hidden="true" viewBox="0 0 16 16"><path d="M4 3v10M12 3.5 5.5 8 12 12.5z" /></svg>,
  next: <svg aria-hidden="true" viewBox="0 0 16 16"><path d="M12 3v10M4 3.5 10.5 8 4 12.5z" /></svg>,
  stop: <svg aria-hidden="true" viewBox="0 0 16 16"><rect x="4" y="4" width="8" height="8" rx="1.5" /></svg>,
  gear: (
    <svg aria-hidden="true" viewBox="0 0 16 16">
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4" />
    </svg>
  ),
  book: (
    <svg aria-hidden="true" viewBox="0 0 16 16">
      <path d="M2.5 3.5h4a1.5 1.5 0 0 1 1.5 1.5v7.5a1.5 1.5 0 0 0-1.5-1.5h-4z" />
      <path d="M13.5 3.5h-4A1.5 1.5 0 0 0 8 5v7.5a1.5 1.5 0 0 1 1.5-1.5h4z" />
    </svg>
  ),
  chevDown: <svg aria-hidden="true" viewBox="0 0 16 16"><path d="M4 6l4 4 4-4" /></svg>,
} as const

/** 进度环包播放钮：环 = 本段出声进度（字节型），直出型退化为静态轨道（不摆假进度）。
 *  自己订阅段进度 store：timeupdate 的重渲染圈在这一颗钮里，不连累整块浮窗。
 *  段内比例取 `chapterProgressOf` 的 ratio——比例换算只此一处，环与章内进度条同一把尺。 */
export function RingPlay(): ReactNode {
  const t = useCopy()
  const st = useStore(ttsPlayer)
  const progress = useStore(ttsProgress)
  const face = listenFaceOf(st)
  const circumference = 2 * Math.PI * 21
  const { ratio } = chapterProgressOf(st, progress, t)
  const busy = face.busy
  const label = busy ? t('tts.pause') : t('tts.play')
  return (
    <button
      type="button"
      className="novel-tts-ringplay"
      aria-label={label}
      title={label}
      onClick={(event) => {
        event.stopPropagation()
        if (busy) pauseListening()
        else resumeListening()
      }}
    >
      <svg className="novel-tts-ring" viewBox="0 0 48 48" aria-hidden="true">
        <circle className="novel-tts-ring-track" cx="24" cy="24" r="21" />
        <circle
          className={face.hasProgress ? 'novel-tts-ring-val' : 'novel-tts-ring-val direct'}
          cx="24" cy="24" r="21"
          strokeDasharray={circumference.toFixed(1)}
          strokeDashoffset={(circumference * (1 - ratio)).toFixed(1)}
        />
      </svg>
      <span className="novel-tts-ring-core">{busy ? MINI_ICON.pause : MINI_ICON.play}</span>
    </button>
  )
}

/** 胶囊底边的章内进度细线（`ADR-0079`）：收起态唯一的进度读数。
 *  自订阅段进度 store——timeupdate 的高频重渲染圈在这一条线上，不连累整颗胶囊。 */
export function MiniProgressLine(): ReactNode {
  const t = useCopy()
  const st = useStore(ttsPlayer)
  const progress = useStore(ttsProgress)
  const { pct } = chapterProgressOf(st, progress, t)
  return (
    <span className="novel-tts-mini-cap-line" aria-hidden="true">
      <i style={{ width: `${(pct * 100).toFixed(1)}%` }} />
    </span>
  )
}

/** 章内进度：浮窗唯一的进度条（`ADR-0079` / `ADR-0080`）——读数按段号 + 段内比例推进，拖动即跳到目标段。
 *  算式住 `listen-readout.ts` 的 `chapterProgressOf`：与听书条的段粒度滑杆吃同一个 value
 *  （条取整到段、这里连续填充）。段内时间滑杆已从界面退场（ADR-0075）；空章不渲染
 *  （没有可落的段，摆一条 max=0 的滑杆是假控件）。
 *  原生 range 用连续刻度（整条 = 本章，落点 floor 到所在段），自绘轨道与拖点才能和命中位置对齐；
 *  方向键按段走，不受连续刻度影响。 */
export function ChapterSeek(): ReactNode {
  const t = useCopy()
  const st = useStore(ttsPlayer)
  const progress = useStore(ttsProgress)
  if (!listenFaceOf(st).hasSegments) return null
  const { count, value, pct, readout } = chapterProgressOf(st, progress, t)
  const fill = (pct * 100).toFixed(1)

  /** 连续刻度 → 段：取落点所在段；章尾也夹回末段。 */
  const jumpTo = (raw: number): void => {
    seekParagraph(Math.min(count - 1, Math.max(0, Math.floor(raw))))
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    const step = event.key === 'ArrowRight' || event.key === 'ArrowUp' ? 1
      : event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? -1 : 0
    if (step !== 0) {
      event.preventDefault()
      seekParagraph(st.paragraphIndex + step)
      return
    }
    if (event.key === 'Home') {
      event.preventDefault()
      seekParagraph(0)
    } else if (event.key === 'End') {
      event.preventDefault()
      seekParagraph(count - 1)
    }
  }

  return (
    <div className="novel-tts-mini-chapseek">
      <span className="novel-tts-mini-chapseek-track" aria-hidden="true">
        <i style={{ width: `${fill}%` }} />
      </span>
      <span
        className="novel-tts-mini-chapseek-knob"
        style={{ left: `${fill}%` }}
        aria-hidden="true"
      />
      <input
        className="novel-tts-mini-chapseek-range"
        type="range" min={0} max={count} step={0.001}
        value={value}
        aria-label={t('tts.seekChapter')}
        aria-valuetext={readout}
        title={readout}
        onChange={(event) => { jumpTo(Number(event.target.value)) }}
        onKeyDown={onKeyDown}
      />
    </div>
  )
}
