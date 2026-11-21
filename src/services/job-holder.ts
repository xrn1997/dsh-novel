import { DEFAULT_JOB_OUTPUT_BYTES, JobTail } from './job-tail.js'
import type { JobTailRead } from './job-tail.js'

/**
 * 后台任务与宿主之间的那一层挂点——三个持有者（SourceJobs / SearchJobs / ExploreJobs）共用的只有这一件事：向 `ctx.jobs` 登记一条
 * 任务，并把「宿主请求收手」「终态结算」「过程行往哪交」三根线接回来。为什么要独立一家：这段机械由三个持有者共用，分散会让宿主契约
 * 变更时三处各自发现——而「UI 说跑完了、宿主那边还挂着 running」恰恰只在漏改的那一处出现（`ADR-0018` 裁的是槽与读模型，不是这段接线）。
 * 刻意**不**做：不接管状态形状、不设运行器泛型、不统一槽政策——只转发位的壳比三份各写一遍更坏。
 */

/** 宿主登记任务的终态词汇（唯一住址：三个持有者共读这一份联合类型） */
export type JobOutcome = { status: 'completed' | 'killed' | 'failed'; detail?: string }

/**
 * 宿主后台任务注册表（`ctx.jobs`）在本插件用到的子集——与宿主发布物对齐：注册表交 `JobSpec`，`run(job)` **同步**取回 `{ cancel, done }`；
 * 输出是**拉**：spec 的 `output` 是拉源数组，注册表按自己持有的字节游标来拉，终态前再排空一次。**hooks 上没有 `readOutput`**：过程行只有
 * 接在 `output` 拉源上才进得了 `job_output`。本地窄面镜像，不引类型包：`kind` 用 `string`（注册表当不透明的 id 命名空间）；任务 id 由
 * 注册表生成，本仓不构造、不解析。`outputLimitBytes` 是自报帽、原样投影进 snapshot，不是缓冲区（缓冲住 `job-tail.ts`）。缺席即不接线。
 */
export interface JobOutputSource {
  read(fromByte: number): JobTailRead
}

/** `run(job)` 交给生产者的句柄：本插件的过程行走 `spec.output` 拉源，句柄上的成员一个也不用（推模型 `append` 与拉源互斥）。 */
export interface JobRunHandle {
  updateProgress(line: string): void
}

export interface JobHostSpec {
  kind: string
  /** 模型可见的一行说明（宿主 UI / `job_*` 工具读它） */
  label: string
  outputLimitBytes?: number
  output?: readonly JobOutputSource[]
  run(job: JobRunHandle): {
    /** 宿主请求终止：**协作式**——不打断在途网络请求，只在取下一条前收手 */
    cancel(reason?: string): void
    done: Promise<JobOutcome>
  }
}

export interface JobHost {
  start(spec: JobHostSpec): string
}

/** 一条任务与宿主登记之间的私有挂点（wire 的 `JobState` 不为此加字段：取消/结算/过程行纯属 Node 半与宿主之间的事）。 */
export class HostTie {
  /** 宿主是否已请求收手（协作式：在途网络请求不打断，只拦下一条） */
  requested = false
  reason = ''
  /** 过程行的有界尾缓冲：每单元收尾 push 一行，宿主按自己的字节游标经 `output` 拉源读走 */
  readonly tail: JobTail
  private readonly done: Promise<JobOutcome>
  private readonly resolve: (outcome: JobOutcome) => void

  private constructor(tail: JobTail) {
    this.tail = tail
    let resolve!: (outcome: JobOutcome) => void
    this.done = new Promise<JobOutcome>((res) => { resolve = res })
    this.resolve = resolve
  }

  /** 登记一条宿主任务并交出挂点；`host` 缺席即返回 null（任务照跑）。**宿主契约**：`start()` 内同步调 `run()` 取回 hooks，所以 `done`
   * 必须先建好再调 `start`——这一条顺序是这段机械唯一真正会咬人的地方。输出走 `output` 拉源（超帽丢弃由 `lossy` 如实报出）；`tail`
   * 传入即复用同一份缓冲（分类轮次「一批一次登记、一轮一份缓冲」是持有者自己的政策）。`onCancel` 是持有者自己的收手落点。 */
  static open(host: JobHost | undefined, opts: {
    kind: string; label: string
    onCancel?: (reason: string) => void
    tail?: JobTail
  }): HostTie | null {
    if (host === undefined) return null
    const tie = new HostTie(opts.tail ?? new JobTail(DEFAULT_JOB_OUTPUT_BYTES))
    host.start({
      kind: opts.kind,
      label: opts.label,
      outputLimitBytes: tie.tail.maxBytes,
      output: [{ read: (fromByte: number) => tie.tail.readFrom(fromByte) }],
      run: () => ({
        cancel: (reason): void => {
          tie.requested = true
          tie.reason = reason ?? '已取消'
          opts.onCancel?.(tie.reason)
        },
        done: tie.done,
      }),
    })
    return tie
  }

  /** 终态结算：把 outcome 交给宿主等的 `done`。 */
  settle(outcome: JobOutcome): void { this.resolve(outcome) }

  /** 过程行落进尾缓冲（没登记宿主即没有挂点）：行文口径归各调用处，这里只管缓冲与上限。 */
  note(line: string): void { this.tail.push(line) }
}

/** 三个持有者的任务状态共有的终态三格；快照形状与槽政策仍各归各的 module。 */
export interface JobTerminalState {
  phase: 'running' | 'done' | 'failed'
  finishedAt?: number | undefined
  error?: string | undefined
}

/** 终态结算的唯一实现：phase / finishedAt / error / 宿主结算四件事同处写。三个持有者各抄一遍时，漏掉 `tie.settle` 只表现为「界面说
 *  结束了、宿主还挂着 running」——那种缺陷从单侧代码上看不出来。`notify` 由要发信号的持有者交（导入面没有观察流）。 */
export function settleTerminal(
  state: JobTerminalState,
  tie: HostTie | null | undefined,
  outcome: { status: JobOutcome['status']; detail?: string | undefined; error?: string | undefined },
  now: number,
  notify?: () => void,
): void {
  state.phase = outcome.status === 'completed' ? 'done' : 'failed'
  if (outcome.error !== undefined) state.error = outcome.error
  state.finishedAt = now
  tie?.settle({
    status: outcome.status,
    ...(outcome.detail === undefined || outcome.detail === '' ? {} : { detail: outcome.detail }),
  })
  notify?.()
}

/** 结束后的保留期判据（读面据此把整轮读作「无任务」）：搜索与发现共用这一份。 */
export function expiredAfter(state: JobTerminalState, retentionMs: number, now: number): boolean {
  return state.phase !== 'running' && state.finishedAt !== undefined && now - state.finishedAt > retentionMs
}

/** 一条「状态变了」信号：观察者各持自己的游标，持有者只发信号不发数据。搜索面与发现面两条 SSE 必须共用这一份；各写一份 `Set` +
 *  快照成数组，漏掉「快照成数组」就会变成「回调里再 subscribe/unsubscribe 会让本轮漏发给别人」。 */
export class ChangeSignal {
  private readonly listeners = new Set<() => void>()

  /** 订阅。返回退订口（连接关闭、组件卸载都必须用它，否则监听器长驻持有者）。 */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  notify(): void {
    // 快照成数组：回调里再 subscribe/unsubscribe 不该让本轮漏发给别人
    for (const listener of [...this.listeners]) listener()
  }
}
