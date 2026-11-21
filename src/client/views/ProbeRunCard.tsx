import type { ReactNode } from 'react'
import { useCopy } from '../copy/index.js'
import { jobKindLabel } from '../jobs.js'
import { jobPct, RunCard } from './bits.js'
import type { JobState } from './types.js'

/** 批量验证运行卡：kind 分家的「验证」侧——渲染在壳层任务槽（待办箱下方）。
 * 外壳归 bits.RunCard（与 ImportRunCard 共用同一外壳），此处只供文案与 counts。 */
export function ProbeRunCard({ job }: { job: JobState }): ReactNode {
  const t = useCopy()
  const pct = jobPct(job)
  return (
    <RunCard
      kind="probe"
      label={t('job.progress', { kind: jobKindLabel(job.kind, t) })}
      meta={<>{t('job.counts', { done: job.done, total: job.total, pct })}{t('sources.probe.concurrency')}</>}
      pct={pct}
      counts={<>
        <span className="novel-ok">{t('sources.probe.ok', { n: job.counts.ok })}</span>
        <span className="novel-muted">{t('sources.probe.failed', { n: job.counts.failed })}</span>
      </>}
    />
  )
}
