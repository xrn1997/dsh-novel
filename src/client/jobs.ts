import { useEffect, useRef } from 'react'
import { apiGet, apiSend, describeError } from './api.js'
import { zhTranslate, type CopyKey, type Translate } from './copy/index.js'
import { createStore, useStore } from './store.js'
import { bodies, ROUTES } from '../shared/wire.js'
import type { JobIssue, JobState } from './views/types.js'
import { STATUS_POLL_MS } from './util.js'

/**
 * 后台任务面：导入/批量验证跑在服务端，客户端只是提交者与观察者——
 * 关设置、切换界面、刷新页面都不影响任务；常驻状态层（`shell.overlay`）单实例轮询，
 * 结果写进本模块的任务镜像，视图环内的消费者只读镜像（`useJobSurface`）。
 */

export async function startImportJob(files: Array<{ name: string; text: string }>): Promise<{ jobId: string }> {
  return apiSend<{ jobId: string }>(ROUTES.sourcesImport, bodies.import(files))
}

export async function startBatchProbeJob(ids: string[]): Promise<{ jobId: string }> {
  return apiSend<{ jobId: string }>(ROUTES.sourcesBatchProbe, bodies.ids(ids))
}

/** 书源验证提交的依赖面（窄接口：三入口的 SettingsDeps 都结构满足；测试注入假实现） */
export interface VerifyDeps {
  /** 提交一轮验证任务（wire 口） */
  startBatchProbeJob: (ids: string[]) => Promise<{ jobId: string }>
  /** 失败反馈（瞬态层） */
  pushError: (msg: string) => void
  /** 催任务读面；缺省 = `refreshJob`（常驻轮询立刻重拉一次，不等下一个 1s 拍） */
  refresh?: () => void
}

/** 书源验证的领域动作（验证编排收拢于此）。
 *  三个入口（待办箱 / 行内「验证/重验」/ 批量「验证所选」）只表达「验证哪些源」；提交后的编排
 *  收在这一处：成功 → 催任务读面（源列表刷新归任务终态，`SettingsSection` 按 job.id 记账一次）；
 *  失败 → 一处反馈（文案单点 `sources.verify.startFailed`；此前三处各持一份，一改即漂移）。
 *  ids 在此按点击时快照：调用方传进来的数组可能随后变异，POST 载荷不许跟着动。
 *  `t` 缺省 zhTranslate：三个入口都从 `useCopy()` 交当前 `t`，失败那句与入口同语言。 */
export async function startSourceVerification(
  ids: string[], deps: VerifyDeps, t: Translate = zhTranslate,
): Promise<void> {
  try {
    await deps.startBatchProbeJob([...ids])
    ;(deps.refresh ?? refreshJob)()
  } catch (e) {
    deps.pushError(t('sources.verify.startFailed', { detail: describeError(e, t) }))
  }
}

export async function fetchJobStatus(): Promise<JobState | null> {
  return (await apiGet<{ job: JobState | null }>(ROUTES.sourcesJobStatus.path)).job
}

/** 最近一次导入任务的模块级缓存：
 *  服务端单任务槽被 probe 任务覆盖后，导入汇总条仍要可看——轮询见到 import 任务即缓存。
 *  模块级：设置区卸载重挂载也不丢。 */
let lastImportJob: JobState | null = null
export function getLastImportJob(): JobState | null { return lastImportJob }

/** 轮询取数依赖（SettingsDeps.fetchJobStatus 的最小面，补完 seam）：
 *  生产缺省真实现；测试注入假取数 + 假时钟——轮询节拍第一次变得可测。
 *  本地声明而不引 deps.ts 的类型：避免 deps.ts(值) ↔ jobs.ts 的环。
 *  节拍不作为注入格：它的家只有 `STATUS_POLL_MS` 一个，注入一格却无人驱动，等于把 interface
 *  开得比需要宽（这批 seam 收窄的立意正是「成员数就是每条用例的固定成本」）。 */
export interface JobStatusDeps {
  fetchJobStatus: () => Promise<JobState | null>
}

/** 生产取数依赖：模块级真实现打包——hook 缺省即它，接线零变化 */
const prodJobStatusDeps: JobStatusDeps = { fetchJobStatus }

// ── 任务现场的唯一镜像 ────────────────────────────────────────────────
/** 为什么住模块 store 而不是 props/hook 局部 state：轮询单实例住在**面板之外**的常驻状态层
 *  （`shell.overlay`），与书源管理区不在同一分支，props 传不过去；轮询若住面板内则切走即停、
 *  读数即消失。口径与 transient / sourceListUi 同类：跨卸载要活的现场走模块级 store，测试有复位口。 */
const jobSurface = createStore<{ job: JobState | null; stale: boolean }>({ job: null, stale: false })
const jobTick = createStore<{ n: number }>({ n: 0 })
const jobOpen = createStore<{ pending: OpenTarget }>({ pending: null })

/** 状态层点击要把用户带去的现场：导入弹层 / 任务卡。 */
export type OpenTarget = 'import' | 'probe' | null

export function useJobSurface(): { job: JobState | null; stale: boolean } { return useStore(jobSurface) }
/** 立刻再取一次（不等下一个节拍）：提交任务后调用，运行卡即刻出现。 */
export function refreshJob(): void { jobTick.set({ n: jobTick.get().n + 1 }) }
/** 状态层 → 书源管理区的跨子树信令：点击时记下意图，SettingsSection 取走即清空（不重放）。 */
export function requestJobOpen(kind: Exclude<OpenTarget, null>): void { jobOpen.set({ pending: kind }) }
export function useJobOpenRequest(): OpenTarget { return useStore(jobOpen).pending }
export function takeJobOpen(): OpenTarget {
  const p = jobOpen.get().pending
  if (p !== null) jobOpen.set({ pending: null })
  return p
}
/** 测试复位（模块级 store 跨用例存活——同 `resetTransient` / `resetSourceListUi` 先例） */
export function resetJobSurface(): void {
  jobSurface.set({ job: null, stale: false })
  jobTick.set({ n: 0 })
  jobOpen.set({ pending: null })
}

/** 唯一轮询驱动：挂载即拉 + `STATUS_POLL_MS` 节拍 + `refreshJob()` 立刻重拉；结果写 `jobSurface`。
 *  抖动时保留旧值但如实置 `stale`（不静默停在最后一帧）。卸载即停（不许孤儿轮询）。
 *  取数走注入 deps（useLatest ref 进 effect）：deps 若是每 render 新字面量，直接进
 *  依赖数组会每帧重启轮询，故 effect 只认 tick。 */
export function useJobPolling(deps: JobStatusDeps = prodJobStatusDeps): void {
  const { n } = useStore(jobTick)
  const depsRef = useRef(deps)
  depsRef.current = deps
  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | null = null
    const loop = async (): Promise<void> => {
      try {
        const j = await depsRef.current.fetchJobStatus()
        if (j !== null && j.kind === 'import') lastImportJob = j   // 顺带喂缓存（probe 任务不覆盖）
        if (alive) jobSurface.set({ job: j, stale: false })
      } catch {
        if (alive) jobSurface.set({ ...jobSurface.get(), stale: true })
      }
      if (!alive) return
      timer = setTimeout(() => { void loop() }, STATUS_POLL_MS)
    }
    void loop()
    return () => { alive = false; if (timer !== null) clearTimeout(timer) }
  }, [n])
}

/** 标签缺省 zhTranslate：未接 locale 的调用方（测试直渲 / 老宿主）保持既有中文；
 *  有 t 就传——字典是真源，这里不再持有第二份中文。 */
export function jobKindLabel(kind: JobState['kind'], t: Translate = zhTranslate): string {
  return kind === 'import' ? t('job.kind.import') : t('job.kind.probe')
}

const JOB_ISSUE_KEY: Record<JobIssue['kind'], CopyKey> = {
  failed: 'job.issue.failed',
  warning: 'job.issue.warning',
  dup: 'job.issue.dup',
  replaced: 'job.issue.replaced',
}

export function jobIssueLabel(kind: JobIssue['kind'], t: Translate = zhTranslate): string {
  return t(JOB_ISSUE_KEY[kind])
}
