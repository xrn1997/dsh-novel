import type { ReactNode } from 'react'
import { useCopy } from '../copy/index.js'
import { useTransient } from '../transient.js'
import { jobKindLabel } from '../jobs.js'
import { jobPct, ProgressBar } from './bits.js'
import type { JobState } from './types.js'

/**
 * 全局状态条（瞬态统一层的呈现端）：错误(红,sticky) > 运行任务 > 保存中(聚合) > 成功(自动退场）。
 * **浮层**：absolute 定位、不参与布局（挂载/卸载不顶动区块内容——曾把整块顶下去 35px 造成
 * 启停闪烁，见 styles.tsx `.novel-status-bar` 注释）；空闲零占用（无条目无任务不渲染）。
 * 任务泳道保留 data-novel-job-status（smoke 断言）。
 * interface：job（任务现场）+ onOpen（点任务泳道跳转到对应区块）。
 */

/** 泳道形状（栏数 / 弱底 / 光标）归样式类 .novel-lane.cols-*：原先由 statusLane() 工厂
 *  每次渲染现造五个 style 对象，样式表里搜不到这些规则，改观感要改 JS。 */

export function GlobalStatusBar({ job, stale = false, onOpen }: { job: JobState | null; stale?: boolean; onOpen: () => void }): ReactNode {
  const t = useCopy()
  const { entries, dismiss } = useTransient()
  const errors = entries.filter((e) => e.kind === 'error')
  const pendings = entries.filter((e) => e.kind === 'pending')
  const oks = entries.filter((e) => e.kind === 'ok')
  const running = job !== null && job.phase === 'running'
  if (errors.length === 0 && pendings.length === 0 && oks.length === 0 && !running && !stale) return null
  const pct = running && job !== null ? jobPct(job) : 0
  return (
    <div data-novel-status-bar className="novel-status-bar">
      {stale && (
        <div data-novel-job-stale className="novel-warn novel-lane cols-1">
          {t('status.stale')}
        </div>
      )}
      {errors.map((e) => (
        <div key={e.id} className="novel-err novel-lane cols-err">
          <span>⚠ {e.label}</span>
          <span />
          {e.anchor === undefined ? null : (
            <button className="novel-btn sm"
              onClick={() => document.querySelector(e.anchor as string)?.scrollIntoView({ block: 'center' })}>
              {t('status.locate')}
            </button>
          )}
          <button className="novel-btn sm" aria-label={t('status.dismissError')} onClick={() => dismiss(e.id)}>✕</button>
        </div>
      ))}
      {running && job !== null && (
        <button data-novel-job-status className="novel-lane cols-job" onClick={onOpen}>
          <span className="novel-muted">{t('job.progress', { kind: jobKindLabel(job.kind, t) })}</span>
          <span className="novel-muted">{t('job.counts', { done: job.done, total: job.total, pct })}</span>
          {/* 迷你进度条与两区运行卡同源：ProgressBar + jobPct，仅高度覆写 */}
          <ProgressBar pct={pct} style={{ height: 4 }} />
          <span className="novel-lane-link">{t('status.viewTask')}</span>
        </button>
      )}
      {pendings.length > 0 && (
        <div className="novel-muted novel-lane cols-1">
          {pendings.length === 1
            ? pendings[0].label
            : t('status.saving', { n: pendings.length })}
        </div>
      )}
      {oks.map((e) => (
        <div key={e.id} className="novel-ok novel-lane cols-1">✓ {e.label}</div>
      ))}
    </div>
  )
}
