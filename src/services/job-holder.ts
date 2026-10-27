import { DEFAULT_JOB_OUTPUT_BYTES, JobTail } from './job-tail.js'

/**
 * 后台任务与宿主之间的那一层挂点——三个持有者（`SourceJobs` / `SearchJobs` / `ExploreJobs`）
 * 共用的**只有这一件事**：向 `ctx.jobs` 登记一条任务，并把「宿主请求收手」「终态结算」
 * 「过程行往哪交」三根线接回来。
 *
 * 为什么要独立一家：这段机械由三个持有者共用；分散在各文件里会让宿主契约变更时三处各自发现，
 * 而「UI 说跑完了、宿主那边还挂着 running」这条缺陷，恰恰只在漏改的那一处出现。集中后，
 * 各持有者剩下的差异是**快照形状、槽政策与业务判据**——那三样本来就不该共用
 * （`docs/adr/0018` 裁的是槽与读模型，不是这段接线仪式）。
 *
 * 这里刻意**不**做的事：不接管状态形状、不设「任务运行器」泛型、不统一槽政策。抽一层只有转发
 * 位的壳，比三份各写一遍更坏——壳会把「谁负责收手」这条线切成两半。
 */

/** 宿主登记任务的终态词汇（唯一住址：三个持有者共读这一份联合类型） */
export type JobOutcome = { status: 'completed' | 'killed' | 'failed'; detail?: string }

/** 宿主后台任务注册表（`ctx.jobs`）在本插件用到的子集——与宿主真名真形对齐：
 *  宿主侧叫 `JobStart`/`JobHooks`，`run()` **无入参**，
 *  hooks 面是 `{ cancel, done, readOutput? }`——**没有 append/log/write**，输出是拉：注册表（经 `job_output` 工具）
 *  调生产方自己的 `readOutput()`，宿主任务面板没有文本面。
 *  **本地窄面镜像，不引类型包**：照 `src/index.ts` 既有的 `NovelContext` + `*Like` 先例办，只声明用到的成员。
 *  `kind` 用 `string` 是刻意的——注册表把 kind 当作不透明的 id 命名空间（唯一判据是「非空字符串」），
 *  自定义 kind 不需要宿主的 `JobKindMap` 合并，id 直接长成 `novel-import-1`。
 *  `outputLimitBytes` 是正整数自报帽、注册表原样投影进 snapshot，不是缓冲区——缓冲住 `job-tail.ts`。
 *  缺席即不接线（headless 组合与单测直构都走这条），任务语义不受影响。 */
export interface JobHostSpec {
  kind: string
  /** 模型可见的一行说明（宿主 UI / `job_*` 工具读它） */
  label: string
  outputLimitBytes?: number
  run(): {
    /** 宿主请求终止：**协作式**——不打断在途网络请求，只在取下一条前收手 */
    cancel(reason?: string): void
    done: Promise<JobOutcome>
    /** 拉模型输出面：一次调用交出「上次读之后」的全部过程行（消费式，见 job-tail.ts） */
    readOutput?(): string
  }
}

export interface JobHost {
  start(spec: JobHostSpec): string
}

/** 一条任务与宿主登记之间的那个私有挂点（wire 的 `JobState` 不为此加字段：它是跨半契约，
 *  而取消/结算/过程行纯属 Node 半与宿主之间的事）。 */
export class HostTie {
  /** 宿主是否已请求收手（协作式：在途网络请求不打断，只拦下一条） */
  requested = false
  reason = ''
  /** 过程行的有界尾缓冲：每单元收尾 push 一行，宿主经 `job_output` 拉走（消费式） */
  readonly tail: JobTail
  private readonly done: Promise<JobOutcome>
  private readonly resolve: (outcome: JobOutcome) => void

  private constructor(tail: JobTail) {
    this.tail = tail
    let resolve!: (outcome: JobOutcome) => void
    this.done = new Promise<JobOutcome>((res) => { resolve = res })
    this.resolve = resolve
  }

  /** 登记一条宿主任务并交出挂点；`host` 缺席即返回 null（任务照跑，宿主那侧没有这条）。
   *  **宿主契约**：`start()` 内同步调 `run()` 取回 hooks，所以 `done` 那枚 promise 必须先建好
   *  再调 `start`——这一条顺序是这段机械唯一真正会咬人的地方，收在这里就不必三个持有者各自记。
   *  `onCancel` 是持有者自己的收手落点（新一轮替换、代际点穴……各不一样），默认只记账。
   *  `tail` 传入即复用同一份缓冲：分类轮次「一批一次登记、一轮一份缓冲」是持有者自己的政策
   *  （后果写在 `explore-job.ts` 的 `launch`），挂点不决定缓冲的生命周期。 */
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
      run: () => ({
        cancel: (reason): void => {
          tie.requested = true
          tie.reason = reason ?? '已取消'
          opts.onCancel?.(tie.reason)
        },
        done: tie.done,
        readOutput: (): string => tie.tail.read(),
      }),
    })
    return tie
  }

  /** 终态结算：把 outcome 交给宿主等的 `done`。 */
  settle(outcome: JobOutcome): void { this.resolve(outcome) }

  /** 过程行落进尾缓冲（没登记宿主即没有挂点）：行文口径归各调用处，这里只管缓冲与上限。 */
  note(line: string): void { this.tail.push(line) }
}

/** 一条「状态变了」信号：观察者各持自己的游标，持有者只发信号不发数据。
 *  搜索面与发现面两条 SSE 必须共用这一份；若各写一份 `Set` + 快照成数组，漏掉「快照成数组」，
 *  就会变成「回调里再 subscribe/unsubscribe 会让本轮漏发给别人」。 */
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
