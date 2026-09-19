import { randomUUID } from 'node:crypto'
import { SourceIntake } from './intake.js'
import type { ProbeResult } from './probe.js'
import type { SourceRegistry } from './sources.js'
import type { NovelSource } from './types.js'

/**
 * 书源后台任务：导入/批量验证跑在服务端进程内，单任务槽——
 * 运行中互斥、结束后结果保留（关设置/刷新页面后 UI 重挂载即可恢复展示）。
 * 任务态只在内存：DSH 重启即丢，但源已按批落盘不丢数据——导入幂等可重跑，不做任务持久化（YAGNI）。
 */
/** JobState/JobIssue 定义在 wire 契约（src/shared/wire.ts）；此处 re-export 保持 import 路径可用 */
export type { JobState, JobIssue } from '../shared/wire.js'
import type { JobIssue, JobState } from '../shared/wire.js'

export type JobKind = JobState['kind']
export type ImportFile = { name: string; text: string }

/** 运行中重复提交：路由层映射 409 JobRunning（services 不 import api 层） */
export class JobRunningError extends Error {
  constructor(running: JobState) {
    super(`已有任务在运行（${running.kind === 'import' ? '导入' : '验证'} ${running.done}/${running.total}）`)
    this.name = 'JobRunningError'
  }
}

/** 去重键归 intake（入库规则唯一实现）；re-export 保持 import 路径可用 */
export { dedupKey } from './intake.js'

const ISSUE_CAP = 200
const PROBE_CONCURRENCY = 5
// 落盘粒度已内聚进注册表（edit 合并写：每 20 次变更强制落盘 + 尾沿防抖）——
// 任务运行器不再持有 persist 节流常量

/** 宿主后台任务注册表（`ctx.jobs`）在本插件用到的子集。
 *  **本地窄面镜像，不引类型包**：npm 上 `@deepseek-ai/dsh-jobs` 停在 `0.0.1-rc.3`，宿主跑的是
 *  `0.1.5-rc.1`，且本仓解析不到该包（`docs/reference/dsh-plugin-api.md` 证据 9a + 风险第 10 条）。
 *  照 `src/index.ts` 既有的 `NovelContext` + `*Like` 先例办：只声明用到的成员。
 *  `kind` 用 `string` 是刻意的——注册表把 kind 当作不透明的 id 命名空间（唯一判据是「非空字符串」），
 *  所以自定义 kind 不需要宿主的 `JobKindMap` 合并，id 直接长成 `novel-import-1`。
 *  缺席即不接线（headless 组合与单测直构都走这条），任务语义不受影响。 */
export interface JobHostSpec {
  kind: string
  /** 模型可见的一行说明（宿主 UI / `job_*` 工具读它） */
  label: string
  run(): {
    /** 宿主请求终止：**协作式**——不打断在途网络请求，只在取下一条前收手 */
    cancel(reason?: string): void
    done: Promise<JobOutcome>
  }
}

export interface JobHost {
  start(spec: JobHostSpec): string
}

/** 宿主登记任务的终态词汇（唯一住址：本文件与 `search-job.ts` 共用，别各写一份联合类型） */
export type JobOutcome = { status: 'completed' | 'killed' | 'failed'; detail?: string }

/** 与宿主登记的那条任务的私有挂点（wire 的 `JobState` 不为此加字段：
 *  它是跨半契约，而取消/结算纯属 Node 半与宿主之间的事）。 */
interface HostTie {
  requested: boolean
  reason: string
  settle: (outcome: JobOutcome) => void
}

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
  private settle(state: JobState, status: 'completed' | 'killed' | 'failed', detail: string, error?: string): void {
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
    const host = this.deps.host
    if (host !== undefined) {
      const tie: HostTie = { requested: false, reason: '', settle: () => {} }
      const done = new Promise<{ status: 'completed' | 'killed' | 'failed'; detail?: string }>((res) => {
        tie.settle = (o): void => { res(o) }
      })
      // 宿主契约：start() 内同步调 run() 取回 hooks，所以 tie/done 必须先建好再调 start。
      host.start({
        kind: kind === 'import' ? 'novel-import' : 'novel-probe',
        label,
        run: () => ({
          cancel: (reason): void => { tie.requested = true; tie.reason = reason ?? '已取消' },
          done,
        }),
      })
      this.ties.set(state, tie)
    }
    return state
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
      try { parsed = JSON.parse(stripBom(f.text)) } catch { state.fileErrors.push({ file: f.name, error: 'JSON 解析失败' }); continue }
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
      state.done++
    }
    await this.deps.registry.flush()                       // 任务完成 ⇒ 结果已落盘（既有语义不变）
    this.settle(state, 'completed', '')
  }

  /**
   * 批量验证：有效 id 并发 5 路探针（限流敬畏——对齐 searchParallel 口径）。
   * 单条失败即结果（broken/异常记 counts）不中断。落盘粒度已收进注册表（每 20 次变更强制落盘
   * + 100ms 尾沿防抖，见 sources.ts），任务运行器不再持「每 N 条 persist」的常量。
   */
  private async runBatchProbe(state: JobState, ids: string[]): Promise<void> {
    const valid: string[] = []
    for (const id of ids) {
      if (this.deps.registry.get(id) === undefined) this.issue(state, 'failed', id, '源不存在（已跳过）')
      else valid.push(id)
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
        // 重查（洞3 修复）：任务运行期间源可能被删——取不到就点名跳过，不产生 TypeError 垃圾失败
        const s = this.deps.registry.get(id)
        if (s === undefined) {
          this.issue(state, 'failed', id, '源不存在（运行中被删除，已跳过）')
          state.done++
          settled++
          continue
        }
        try {
          const r = await this.deps.probe(s)
          await this.deps.registry.edit((tx) => tx.setStatus(id, r.ok ? 'verified' : 'broken', r.error?.message, r.probedAt))
          if (r.ok) state.counts.ok++
          else { state.counts.failed++; this.issue(state, 'failed', s.name, r.error?.message ?? '探针未通过') }
        } catch (e) {
          state.counts.failed++
          this.issue(state, 'failed', s.name, e instanceof Error ? e.message : String(e))
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
