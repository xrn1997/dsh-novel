import type { ReactNode } from 'react'
import { useCopy } from '../copy/index.js'

/* ── 轨迹台账：工具栏 + sticky 轮次头 + 事件表 + 事件详情浮层 ─────────
   形态逐项照宿主轨迹面板：
   - 工具栏：⊞/⊟ 展开收起 + 搜索框。
   - 轮次头：44px sticky 轮次头，标题 + 输入/输出/思考/时间四列指标头
     （4×71 + 3×12 = 320px 列道，列道与行尾对齐同 8px 右余量）。
   - 事件行：30px 表格行、0.5px l1 发丝、hover/选中两态；
     行内容＝序号 + 类型标签 + 摘要 + 四列指标（指标只在数据在场的行铺）。
   - 「事件详情」概述排版：42px 头 + 94px 标签列的 dl 键值行。
   时间线/拖选不做。指标数据＝真阅读数据映射（见 moyu-metrics.ts）。 */

export interface MoyuTrajectoryEvent {
  key: string
  kind: 'user' | 'tool' | 'message'
  /** 全局序号（#1 起，跨轮连续）。 */
  index: number
  summary: string
  /** 四列指标（已格式化的上屏值；null＝该列不铺）。 */
  input: string | null
  output: string | null
  think: string | null
  time: string | null
}

export interface MoyuTrajectoryTurn {
  /** 1 基轮号（宿主 `turn.label`）。 */
  turn: number
  chapterIndex: number
  /** 章名（搜索轨迹的过滤面）。 */
  name: string
  events: MoyuTrajectoryEvent[]
  /** 事件详情的本章统计（已格式化的上屏值）。 */
  detail: { paragraphs: string; chars: string; reveal: string; tok: string }
}

export interface MoyuTrajectoryProps {
  turns: readonly MoyuTrajectoryTurn[]
  folded: ReadonlySet<number>
  allFolded: boolean
  selected: number | null
  query: string
  onQueryChange: (query: string) => void
  onToggleFold: (chapterIndex: number) => void
  onToggleAll: () => void
  onSelect: (chapterIndex: number | null) => void
}

/** 事件详情浮层（宿主「事件详情」概述排版）：本章统计 + 「在阅读器打开」。挂在舞台根上，
 *  不进对话滚动面——绝对定位的浮层在滚动容器里会跟着内容漂。 */
export function MoyuTrajectoryDetail({ turn, onClose, onOpenInReader }: {
  turn: MoyuTrajectoryTurn
  onClose: () => void
  onOpenInReader: (chapterIndex: number) => void
}): ReactNode {
  const t = useCopy()
  return (
    <div className="novel-moyu-traj-detail" role="dialog" aria-label={t('reader.moyu.trajectory.detailTitle')}>
      <div className="novel-moyu-traj-detail-head">
        <span className="novel-moyu-traj-detail-title">{t('reader.moyu.trajectory.detailTitle')}</span>
        <button
          type="button"
          className="novel-moyu-traj-detail-close"
          aria-label={t('reader.moyu.trajectory.detailClose')}
          onClick={onClose}
        >
          <CloseIcon />
        </button>
      </div>
      <dl className="novel-moyu-traj-detail-rows">
        <div><dt>{t('reader.moyu.trajectory.detailParagraphs')}</dt><dd>{turn.detail.paragraphs}</dd></div>
        <div><dt>{t('reader.moyu.trajectory.detailChars')}</dt><dd>{turn.detail.chars}</dd></div>
        <div><dt>{t('reader.moyu.trajectory.detailReveal')}</dt><dd>{turn.detail.reveal}</dd></div>
        <div><dt>{t('reader.moyu.trajectory.detailTok')}</dt><dd>{turn.detail.tok}</dd></div>
      </dl>
      <button
        type="button"
        className="novel-moyu-traj-detail-open"
        onClick={() => onOpenInReader(turn.chapterIndex)}
      >
        {t('reader.moyu.openInReader')}
      </button>
    </div>
  )
}

function SearchIcon(): ReactNode {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M6.58727 11.8586C9.55061 11.8586 11.9529 9.45637 11.9529 6.49304C11.9529 3.5297 9.55061 1.12744 6.58727 1.12744C3.62394 1.12744 1.22168 3.5297 1.22168 6.49304C1.22168 9.45637 3.62394 11.8586 6.58727 11.8586Z" />
      <path d="M10.2991 10.3933L14.7783 14.8725" />
    </svg>
  )
}

function CloseIcon(): ReactNode {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3.5 3.5L12.5 12.5" /><path d="M12.5 3.5L3.5 12.5" />
    </svg>
  )
}

const METRIC_KEYS = [
  'reader.moyu.trajectory.col.input',
  'reader.moyu.trajectory.col.output',
  'reader.moyu.trajectory.col.think',
  'reader.moyu.trajectory.col.time',
] as const

export function MoyuTrajectory(props: MoyuTrajectoryProps): ReactNode {
  const { turns, folded, allFolded, selected, query, onQueryChange, onToggleFold, onToggleAll, onSelect } = props
  const t = useCopy()
  return (
    <div className="novel-moyu-traj">
      <div className="novel-moyu-traj-toolbar" role="toolbar" aria-label={t('reader.moyu.trajectory.toolbarAria')}>
        <button
          type="button"
          className="novel-moyu-traj-action"
          aria-label={allFolded ? t('reader.moyu.trajectory.expandTurns') : t('reader.moyu.trajectory.collapseTurns')}
          aria-pressed={allFolded}
          onClick={onToggleAll}
        >
          <span className="novel-moyu-traj-action-icon" aria-hidden="true">{allFolded ? '⊞' : '⊟'}</span>
          {allFolded ? t('reader.moyu.trajectory.expandTurns') : t('reader.moyu.trajectory.collapseTurns')}
        </button>
        <div className="novel-moyu-traj-search">
          <span className="novel-moyu-traj-search-icon" aria-hidden="true"><SearchIcon /></span>
          <input
            type="search"
            className="novel-moyu-traj-search-input"
            aria-label={t('reader.moyu.trajectory.search')}
            placeholder={t('reader.moyu.trajectory.searchPlaceholder')}
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
          />
        </div>
      </div>
      <div className="novel-moyu-traj-table">
        {turns.map((turn) => {
          const isFolded = folded.has(turn.chapterIndex)
          return (
            <section key={turn.chapterIndex} className="novel-moyu-traj-turn">
              <div className="novel-moyu-traj-turn-head">
                <div className="novel-moyu-traj-turn-inner">
                  <button
                    type="button"
                    className="novel-moyu-traj-turn-title"
                    aria-expanded={!isFolded}
                    onClick={() => onToggleFold(turn.chapterIndex)}
                  >
                    {t('reader.moyu.trajectory.turnLabel', { turn: turn.turn })}
                  </button>
                  <div className="novel-moyu-traj-columns" aria-hidden="true">
                    {METRIC_KEYS.map((key) => <span key={key} className="novel-moyu-traj-column">{t(key)}</span>)}
                  </div>
                </div>
              </div>
              {!isFolded && turn.events.map((event) => (
                <button
                  key={event.key}
                  type="button"
                  className="novel-moyu-traj-row"
                  data-kind={event.kind}
                  data-selected={selected === turn.chapterIndex ? 'true' : undefined}
                  aria-pressed={selected === turn.chapterIndex}
                  onClick={() => onSelect(selected === turn.chapterIndex ? null : turn.chapterIndex)}
                >
                  <span className="novel-moyu-traj-index">#{event.index}</span>
                  <span className="novel-moyu-traj-tag-slot">
                    <span className={`novel-moyu-traj-tag is-${event.kind}`}>{t(`reader.moyu.trajectory.kind.${event.kind}`)}</span>
                  </span>
                  <span className="novel-moyu-traj-text">{event.summary}</span>
                  <span className="novel-moyu-traj-trailing">
                    <span className="novel-moyu-traj-metric">{event.input ?? ''}</span>
                    <span className="novel-moyu-traj-metric">{event.output ?? ''}</span>
                    <span className="novel-moyu-traj-metric">{event.think ?? ''}</span>
                    <span className="novel-moyu-traj-metric">{event.time ?? ''}</span>
                  </span>
                </button>
              ))}
            </section>
          )
        })}
      </div>
    </div>
  )
}
