import { randomUUID } from 'node:crypto'
import { JobRunningError } from './errors.js'
import { SourceIntake } from './intake.js'
import { HostTie } from './job-holder.js'
import type { JobHost, JobOutcome } from './job-holder.js'
import { applyProbeResult } from './probe.js'
import type { ProbeResult } from './probe.js'
import type { SourceRegistry } from './sources.js'
import type { NovelSource } from './types.js'

/**
 * 书源后台任务：导入/批量验证跑在服务端进程内，单任务槽——
 * 运行中互斥、结束后结果保留（关设置/刷新页面后 UI 重挂载即可恢复展示）。
 * 任务态只在内存：DSH 重启即丢，但源已按批落盘不丢数据——导入幂等可重跑，不做任务持久化（YAGNI）。
 * 与宿主之间那段登记机械不住这里（住 `job-holder.ts`）；这里只拥有**导入与批量验证的计数与明细**。
 */
/** JobState/JobIssue 定义在 wire 契约（src/shared/wire.ts）；此处 re-export 保持 import 路径可用 */
export type { JobState, JobIssue } from '../shared/wire.js'
import type { JobIssue, JobState } from '../shared/wire.js'

export type JobKind = JobState['kind']
export type ImportFile = { name: string; text: string }

/** 类住在错误分类学单点（errors.ts）；re-export 保持既有 import 路径可用 */
export { JobRunningError }

/** 去重键归 intake（入库规则唯一实现）；re-export 保持 import 路径可用 */
export { dedupKey } from './intake.js'

const ISSUE_CAP = 200
const PROBE_CONCURRENCY = 5
// 落盘粒度已内聚进注册表（edit 合并写，调度归 createDebouncedWriter：每 20 次变更强制落盘 + 尾沿防抖）——
// 任务运行器不再持有 persist 节流常量

export class SourceJobs {
  private current: JobState | null = null
  private readonly ties = new WeakMap<JobState, HostTie>()
  constructor(private readonly deps: {
    registry: SourceRegistry
    probe(source: NovelSource): Promise<ProbeResult>
    /** 宿主 `ctx.jobs` 的窄面；缺省即不登记（任务照跑） */
    host?: JobHost
    now?: () => number
    uuid?: () => string
  }) {}

  status(): JobState | null { return this.current }

  startImport(files: ImportFile[]): { jobId: string } {
    const state = this.begin('import', `导入书源 ${files.length} 个文件`)
    void this.runImport(state, files).catch((e: unknown) => {
      this.fail(state, e instanceof Error ? e.message : String(e))
    })
    return { jobId: state.id }
  }

  startBatchProbe(ids: string[]): { jobId: string } {
    const state = this.begin('batch-probe', `批量验证书源 ${ids.length} 家`)
    state.total = ids.length
    void this.runBatchProbe(state, ids).catch((e: unknown) => {
      this.fail(state, e instanceof Error ? e.message : String(e))
    })
    return { jobId: state.id }
  }

  private now(): number { return this.deps.now?.() ?? Date.now() }

  /** 收尾的三处写口（done / fail / cancel）集中在这里，宿主登记的那条一并结算——
   *  漏掉一处就是「UI 显示已结束而宿主还挂着 running」。 */
  private settle(state: JobState, status: JobOutcome['status'], detail: string, error?: string): void {
    state.phase = status === 'completed' ? 'done' : 'failed'
    if (error !== undefined) state.error = error
    state.finishedAt = this.now()
    this.ties.get(state)?.settle({ status, ...(detail === '' ? {} : { detail }) })
  }

  private fail(state: JobState, error: string): void {
    this.settle(state, 'failed', error, error)
  }

  /** 宿主是否已请求收手（协作式：在途网络请求不打断，只拦下一条）。 */
  private cancelled(state: JobState): boolean { return this.ties.get(state)?.requested === true }

  /** 取消落地点：已入库/已验证的结果一律保留（导入幂等、验证是逐条写回的），
   *  只等齐落盘后收工。wire 的 `phase` 不设 'killed'——两个终态对本插件的 UI 判据
   *  （`phase !== 'running'`）没有区别，加一态要动 wire + 三处 UI 判据，收益为零。 */
  private cancelledOut(state: JobState): Promise<void> {
    const reason = this.ties.get(state)?.reason ?? '已取消'
    return this.deps.registry.flush().then(() => {
      this.settle(state, 'killed', `任务已取消：${reason}`, `任务已取消：${reason}`)
    })
  }

  private begin(kind: JobKind, label: string): JobState {
    if (this.current !== null && this.current.phase === 'running') throw new JobRunningError(this.current)
    const state: JobState = {
      id: (this.deps.uuid ?? randomUUID)(), kind, phase: 'running',
      total: 0, done: 0,
      counts: { ok: 0, failed: 0, dupSkipped: 0, replaced: 0 },
      issues: [], fileErrors: [], startedAt: this.now(),
    }
    this.current = state
    // 宿主登记：身份/生命周期归 ctx.jobs（`<kind>-N`、running→终态、按 owner 栅栏），
    // 本插件的 JobState 继续是计数与明细的唯一载体。kind 用 novel-* 前缀与 bash/subagent 分namespace。
    // 协作式取消只需记账（取下一条前查 `cancelled`），故不给 onCancel 落点。
    const tie = HostTie.open(this.deps.host, {
      kind: kind === 'import' ? 'novel-import' : 'novel-probe',
      label,
    })
    if (tie !== null) this.ties.set(state, tie)
    return state
  }

  /** 过程行落进宿主那条任务的尾缓冲（缺席即没有挂点，不写）。
   *  覆盖每单元收尾、文件级解析失败与预筛无效 id；行文只用既有任务词汇（源名、状态词、
   *  `error.code`），口径归各调用处，不复述 issues 明细。 */
  private note(state: JobState, line: string): void {
    this.ties.get(state)?.note(line)
  }

  private issue(state: JobState, kind: JobIssue['kind'], name: string, detail: string): void {
    if (state.issues.length < ISSUE_CAP) state.issues.push({ kind, name, detail })
  }

  /**
   * 导入：逐文件 parse（坏文件记 fileErrors 继续）→ 逐条交 SourceIntake 入库
   * （normalize / 批内留首条 / 按址去重 / replace 清脏——入库规则唯一实现在 intake.ts，
   * 本方法只把 IntakeDecision 映射成任务词汇：counts 与 issues）。
   * 逐条落库（注册表内部合并落盘）；**导入不探针**——验证归批量验证任务；任务末 flush 等齐落盘。
   */
  private async runImport(state: JobState, files: ImportFile[]): Promise<void> {
    const items: unknown[] = []
    for (const f of files) {
      let parsed: unknown
      try { parsed = JSON.parse(stripBom(f.text)) } catch {
        state.fileErrors.push({ file: f.name, error: 'JSON 解析失败' })
        this.note(state, `${f.name}：JSON 解析失败`)
        continue
      }
      if (Array.isArray(parsed)) items.push(...parsed)
      else items.push(parsed)
    }
    state.total = items.length
    const intake = new SourceIntake(this.deps.registry)
    for (const item of items) {
      if (this.cancelled(state)) return this.cancelledOut(state)   // 协作式收手：已入库的保留
      const d = await intake.intake(item)
      switch (d.kind) {
        case 'failed':
          state.counts.failed++
          this.issue(state, 'failed', d.name, d.missing.map((m) => `${m.field}：${m.message}`).join('；') || 'normalize 失败')
          break
        case 'added':
          state.counts.ok++
          break
        case 'replaced':
          state.counts.replaced++
          this.issue(state, 'replaced', d.source.name, d.clearedRest > 0 ? '已替换旧源（同地址其余条目一并清除）' : '已替换旧源')
          break
        case 'skipped':
          state.counts.dupSkipped++
          this.issue(state, 'dup', d.name, d.reason === 'batch'
            ? '重复跳过：与批内前一条同地址'
            : `重复跳过：与已有可用源同地址（${d.existing?.name ?? '?'}）`)
          break
      }
      this.note(state, `${d.kind === 'added' || d.kind === 'replaced' ? d.source.name : d.name}：${d.kind}`)
      state.done++
    }
    await this.deps.registry.flush()                       // 任务完成 ⇒ 结果已落盘（既有语义不变）
    this.settle(state, 'completed', '')
  }

  /**
   * 批量验证：有效 id 并发 5 路探针（限流敬畏——对齐 searchParallel 口径）。
   * 单条失败即结果（broken/异常记 counts）不中断。落盘粒度已收进注册表（每 20 次变更强制落盘
   * + 100ms 尾沿防抖，调度归 storage.createDebouncedWriter），任务运行器不再持「每 N 条 persist」的常量。
   */
  private async runBatchProbe(state: JobState, ids: string[]): Promise<void> {
    const valid: string[] = []
    for (const id of ids) {
      if (this.deps.registry.get(id) === undefined) {
        this.issue(state, 'failed', id, '源不存在（已跳过）')
        this.note(state, `${id}：源不存在`)
      } else valid.push(id)
    }
    state.total = valid.length
    let cursor = 0
    let settled = 0
    const worker = async (): Promise<void> => {
      for (;;) {
        if (this.cancelled(state)) return                 // 协作式收手：取下一条前查一次
        const i = cursor++
        if (i >= valid.length) return
        const id = valid[i]
        // 重查：任务运行期间源可能被删——取不到就点名跳过，不产生 TypeError 垃圾失败
        // （此前的缺陷正是这里不重查，undefined 喂给探针 → 抛 TypeError 冒充正常失败）
        const s = this.deps.registry.get(id)
        if (s === undefined) {
          this.issue(state, 'failed', id, '源不存在（运行中被删除，已跳过）')
          this.note(state, `${id}：源不存在`)
          state.done++
          settled++
          continue
        }
        // 站点判据先记账，再写回状态：`applyProbeResult` 会把落盘失败如实抛（ADR 0011 / 0013），
        // 把它折进「这一家 broken」就是把磁盘侧事实记进站点判据分母（ADR 0011 的写盘失败边界）；
        // 这里把失败移交给注册表（retainWriteFailure），收尾 flush 会如实抛，只补一条任务读数。
        try {
          const r = await this.deps.probe(s)
          if (r.ok) { state.counts.ok++; this.note(state, `${s.name}：verified`) }
          else {
            state.counts.failed++
            this.issue(state, 'failed', s.name, r.error?.message ?? '探针未通过')
            this.note(state, `${s.name}：broken（${r.error?.code ?? 'Error'}）`)
          }
          try {
            await applyProbeResult(this.deps.registry, id, r)
          } catch (e) {
            this.deps.registry.retainWriteFailure(e)
            this.issue(state, 'warning', s.name, `探针结果落盘失败（${errCode(e)}）：状态还只在内存里，等收尾 flush 或下一次写重试`)
          }
        } catch (e) {
          state.counts.failed++
          this.issue(state, 'failed', s.name, e instanceof Error ? e.message : String(e))
          this.note(state, `${s.name}：broken（${errCode(e)}）`)
        }
        state.done++
        settled++
      }
    }
    await Promise.all(Array.from({ length: Math.min(PROBE_CONCURRENCY, Math.max(valid.length, 1)) }, worker))
    if (this.cancelled(state)) return this.cancelledOut(state)   // 已写回的状态不抹除，只等落盘收工
    await this.deps.registry.flush()                       // 任务完成 ⇒ 结果已落盘（既有语义不变）
    this.settle(state, 'completed', '')
  }
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/** 错误码读数（`code` 不在场就说不在场，不猜成某个具体码）：探针的 broken 标注与状态落盘失败
 *  的标注共用这一份，两处各写一遍筛键迟早分叉。 */
function errCode(e: unknown): string {
  const raw = e instanceof Error ? (e as unknown as { code?: unknown }).code : undefined
  return typeof raw === 'string' ? raw : 'Error'
}
