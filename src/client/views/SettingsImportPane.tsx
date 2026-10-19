import type { ReactNode } from 'react'
import { useCallback, useRef, useState } from 'react'
import { describeError } from '../api.js'
import { validateSourceJson } from '../importer.js'
import type { ItemCheck } from '../importer.js'
import { plural, useCopy } from '../copy/index.js'
import { jobIssueLabel, jobKindLabel } from '../jobs.js'
import { prodDeps } from '../deps.js'
import type { SettingsDeps } from '../deps.js'
import { debounce } from '../util.js'
import { ErrorBanner, jobPct, RunCard } from './bits.js'
import type { JobState } from './types.js'

/**
 * 导入现场（书源管理 tab 的导入弹层内容，2026 调度台 IA）：拖放主入口 + 三态（空闲/运行/完成汇总）+ 粘贴小道。
 * 职责：只持「导入现场」——job 经 props 注入；import 任务的客户端缓存兜底（getLastImportJob）
 * 留在 jobs.ts 单点。改版口径：导入是低频任务，收纳进弹层（壳层 `Dialog` 的 wide 档）；提交成功后
 * 经 onSubmitted 关弹层，任务在服务端跑，**完成事项回流待办收件箱**（新导入 → 待验证卡），
 * 不留在原地——闭环。运行卡/完成汇总在弹层内呈现（重开弹层可回看；任务进度同时走全局状态条）。
 */

/** 粘贴超此值提示改用文件导入（不阻止） */
const BIG_PASTE_BYTES = 200 * 1024

/** 导入弹层的依赖面：提交一次导入任务 + 读最近一次导入回执 + 失败上报。
 *  任务读面（`job` / `refresh`）由壳层从常驻镜像传下来，这里不再持一条轮询口。 */
type ImportPaneDeps = Pick<SettingsDeps, 'startImportJob' | 'lastImportJob' | 'pushError'>

export function ImportPane({ job, refresh, unverifiedCount, onVerifyUnverified, onSubmitted, deps = prodDeps }: {
  job: JobState | null; refresh: () => void; unverifiedCount: number; onVerifyUnverified: () => void
  /** 提交成功回调：弹层语境 = 关闭弹层（任务在服务端继续，结果经待办收件箱回流） */
  onSubmitted?: () => void
  /** 依赖束：缺省生产实现；测试注入假 adapter */
  deps?: ImportPaneDeps
}): ReactNode {
  const t = useCopy()
  const fileRef = useRef<HTMLInputElement | null>(null)
  const pasteRef = useRef<HTMLTextAreaElement | null>(null)
  const [dragging, setDragging] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [check, setCheck] = useState<{ ok: boolean; total: number; bad: ItemCheck[] } | null>(null)
  const [bigPaste, setBigPaste] = useState(false)
  const [showDetail, setShowDetail] = useState(false)
  // kind 分家：导入区只呈现 import 任务；probe 任务不顶掉导入汇总——
  // 服务端单任务槽覆盖后，用客户端缓存的最近导入任务兜底
  const importJob = job?.kind === 'import' ? job : deps.lastImportJob()
  const busy = job?.phase === 'running'
  const recheck = useCallback(debounce(() => {
    const v = pasteRef.current?.value ?? ''
    setBigPaste(v.length > BIG_PASTE_BYTES)
    if (v.trim() === '') { setCheck(null); return }
    const r = validateSourceJson(v, t)
    setCheck({ ok: r.ok, total: r.total, bad: r.bad })
  }, 300), [t])
  /** 文件直通：读原文 → 一次性提交服务端任务，不经 textarea（MB 级文本零进出 React） */
  const submitFiles = (files: FileList | null): void => {
    if (files === null || files.length === 0) return
    void (async () => {
      setSubmitting(true)
      try {
        const named = await Promise.all([...files].map(async (f) => ({ name: f.name, text: await f.text() })))
        await deps.startImportJob(named)
        refresh()                                          // 立即拉一轮状态，不等下个 1s
        onSubmitted?.()                                    // 弹层语境：提交成功即关弹层（任务在服务端跑）
      } catch (e) {
        deps.pushError(t('import.submitFailed', { detail: describeError(e, t) }))
      } finally {
        setSubmitting(false)
        if (fileRef.current !== null) fileRef.current.value = ''   // 清空——同一文件可重选
      }
    })()
  }
  const importPaste = (): void => {
    const v = pasteRef.current?.value ?? ''
    if (v.trim() === '') return
    void (async () => {
      setSubmitting(true)
      try {
        await deps.startImportJob([{ name: t('import.paste'), text: v }])   // 与文件导入同一任务端点
        refresh()
        onSubmitted?.()
      } catch (e) {
        deps.pushError(t('import.submitFailed', { detail: describeError(e, t) }))
      } finally { setSubmitting(false) }
    })()
  }
  const dropzone = (
    <div data-novel-dropzone
      className={`novel-dropzone${dragging ? ' dragging' : ''}${busy || submitting ? ' busy' : ''}`}
      role="button" tabIndex={0}
      onClick={() => { if (!busy && !submitting) fileRef.current?.click() }}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (!busy && !submitting) fileRef.current?.click() } }}
      onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        if (!busy && !submitting) submitFiles(e.dataTransfer.files)
      }}
    >
      <div className="novel-dropzone-icon" aria-hidden="true">📄</div>
      <div className="novel-dropzone-lead">{t('import.dropLead')}</div>
      <div className="novel-muted">{t('import.backgroundNote')}</div>
    </div>
  )
  const pasteArea = (
    <details className="novel-paste" aria-label={t('import.paste')}>
      <summary className="novel-summary">{t('import.pasteSummary')}</summary>
      <div className="novel-group novel-paste-body">
        <textarea
          ref={pasteRef}
          className="novel-textarea"
          onChange={recheck}
          placeholder={t('import.pastePlaceholder')}
          rows={5}
          aria-label={t('import.pasteLabel')}
        />
        {bigPaste && <div className="novel-warn novel-note-sm">{t('import.bigPaste')}</div>}
        {check === null ? null : (
          <div className="novel-note-md">
            {check.ok ? (
              check.bad.length === 0
                ? <span className="novel-ok">{plural(t, check.total, 'import.check.ok.one', 'import.check.ok.other')}</span>
                : (
                  <span className="novel-warn">
                    {plural(t, check.total, 'import.check.bad.one', 'import.check.bad.other', { m: check.bad.length })}
                    {check.bad.slice(0, 3).map((b) => t('import.check.badItem', { name: b.name, fields: b.missing.join('/') })).join(t('import.check.badItemSep'))}
                    {check.bad.length > 3 ? plural(t, check.bad.length - 3, 'import.check.badMore.one', 'import.check.badMore.other') : ''}
                  </span>
                )
            ) : <span className="novel-err">{t('import.check.invalid')}</span>}
          </div>
        )}
        <div className="novel-toolbar">
          <button className="novel-btn primary" disabled={check?.ok !== true || submitting || busy} onClick={importPaste}>
            {submitting ? t('import.submitting') : t('import.submit')}
          </button>
          <span className="novel-muted">{t('import.pasteHint')}</span>
        </div>
      </div>
    </details>
  )
  return (
    <div className="novel-group" role="group" aria-label={t('import.title')}>
      <input
        ref={fileRef}
        type="file"
        accept=".json,.txt,application/json"
        multiple
        className="novel-file-hidden"
        onChange={(e) => { submitFiles(e.target.files) }}
      />
      {/* 运行态：拖放区替换为运行卡 */}
      {importJob !== null && importJob.phase === 'running' ? (
        <ImportRunCard job={importJob} />
      ) : (
        <>
          {/* 完成态：左侧竖条说成败 + 「去验证」直达 */}
          {importJob !== null && importJob.phase !== 'running' && (
            <div className={`novel-panel novel-result${importJob.phase === 'failed' ? ' err' : ''}`}>
              <div className="novel-toolbar">
                <strong className={importJob.phase === 'failed' ? 'novel-err' : 'novel-ok'}>
                  {importJob.phase === 'failed' ? t('import.failed') : t('import.done')}
                </strong>
                <span className="novel-note-md">
                  {t('import.summary.added', { n: importJob.counts.ok })}
                  {importJob.counts.replaced > 0 && t('import.summary.replaced', { n: importJob.counts.replaced })}
                  {importJob.counts.dupSkipped > 0 && t('import.summary.dup', { n: importJob.counts.dupSkipped })}
                  {importJob.counts.failed > 0 && t('import.summary.failed', { n: importJob.counts.failed })}
                </span>
                <button className="novel-btn sm" onClick={() => setShowDetail(!showDetail)}>{t('import.detail')}</button>
                <span className="novel-grow" />
                {unverifiedCount > 0 && (
                  <button className="novel-btn sm primary" disabled={busy}
                    onClick={() => { onVerifyUnverified(); refresh() }}>
                    {plural(t, unverifiedCount, 'import.verifyUnverified.one', 'import.verifyUnverified.other')}
                  </button>
                )}
              </div>
              {importJob.phase === 'failed' && <ErrorBanner error={{ code: 'ImportInterrupted', message: importJob.error ?? t('common.unknownError') }} />}
              {showDetail && <ImportIssues job={importJob} />}
            </div>
          )}
          {dropzone}
          {pasteArea}
          <div className="novel-muted">
            {t('import.footer')}
          </div>
        </>
      )}
    </div>
  )
}

/** 导入运行卡：kind 分家的「导入」侧——显示在导入区。
 * 外壳归 bits.RunCard（与 ProbeRunCard 曾是近逐字同构的双胞胎），此处只供文案与 counts。 */
export function ImportRunCard({ job }: { job: JobState }): ReactNode {
  const t = useCopy()
  const pct = jobPct(job)
  return (
    <RunCard
      label={t('job.progress', { kind: jobKindLabel(job.kind, t) })}
      meta={t('job.counts', { done: job.done, total: job.total, pct })}
      pct={pct}
      counts={<>
        <span className="novel-ok">{t('import.run.added', { n: job.counts.ok })}</span>
        {job.counts.dupSkipped > 0 && <span className="novel-muted">{t('import.summary.dup', { n: job.counts.dupSkipped })}</span>}
        {job.counts.failed > 0 && <span className="novel-err">{t('import.summary.failed', { n: job.counts.failed })}</span>}
      </>}
    />
  )
}

/** 汇总明细：坏文件 + issues（失败/重复/替换点名），642 条全铺屏是灾难——点开才展示 */
function ImportIssues({ job }: { job: JobState }): ReactNode {
  const t = useCopy()
  return (
    <div className="novel-group novel-issues">
      {job.fileErrors.map((f) => (
        <div key={f.file} className="novel-err novel-note-md">{t('import.fileError', { file: f.file, detail: f.error })}</div>
      ))}
      {job.issues.length === 0 ? null : job.issues.map((i, n) => (
        <div key={n} className="novel-note-md">
          <span className={i.kind === 'failed' ? 'novel-err' : i.kind === 'warning' ? 'novel-warn' : 'novel-muted'}>
            {jobIssueLabel(i.kind, t)} {i.name}
          </span>
          <span className="novel-muted"> · {truncate(i.detail, 80)}</span>
        </div>
      ))}
    </div>
  )
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`
}
