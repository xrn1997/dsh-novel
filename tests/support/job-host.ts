import type { JobHost, JobHostSpec, JobOutcome } from '../../src/services/job-holder.js'

/** 宿主 `JobOutputSource.read` 的返回值：独立抄本，不 import 生产 `JobTailRead`——
 *  生产形状变了，这里要人工对齐一次，而不是跟着类型定义一起漂。 */
export interface HostReadResult {
  text: string
  nextOffset: number
  lossy: boolean
}

/** 宿主 `ctx.jobs` 的假面，照**活契约**而不是照我们的镜像：
 *  - `start(spec)` 里同步调 `run(job)` 交回 `{ cancel, done }`（句柄在这里只是形状，宿主真身会给）；
 *  - 输出是 `spec.output` 的**拉源**，注册表侧持游标按字节偏移来拉——所以这里也持游标。
 *
 *  为什么收成一份：这段假面原先在每个任务测试里各抄一遍，而抄的正是我们**错的那一版契约**
 *  （hooks 上的 `readOutput`）。假体与实现一起错，测试就永远绿；收成一份 + 按活契约写，
 *  下一次契约漂移只会在这一处红。 */
export interface JobCapture {
  readonly spec: JobHostSpec
  readonly hooks: ReturnType<JobHostSpec['run']>
  readonly done: Promise<JobOutcome>
  cancel(reason?: string): void
  /** 模拟宿主泵 / `job_output`：从本条目上次读到的偏移继续拉增量。 */
  read(): string
  /** 绝对偏移读（`job_output` 的 `readAt` 语义）：不移动本条的游标。 */
  readFrom(from: number): HostReadResult
}

export interface JobHostDouble {
  readonly host: JobHost
  readonly captures: JobCapture[]
  /** 按登记序记下的 kind / label（宿主面板读这两个字段）。 */
  readonly kinds: string[]
  readonly labels: string[]
  /** 终态词汇（宿主等 done 的那份）。 */
  readonly settled: string[]
  /** 最近一次登记（断言「这次打开的任务」的输出面时用它）。 */
  last(): JobCapture
}

export function jobHostDouble(): JobHostDouble {
  const captures: JobCapture[] = []
  const kinds: string[] = []
  const labels: string[] = []
  const settled: string[] = []
  const cursors = new Map<JobCapture, number>()
  const capture = (spec: JobHostSpec): JobCapture => {
    const hooks = spec.run({ updateProgress: () => {} })
    const self: JobCapture = {
      spec,
      hooks,
      done: hooks.done,
      cancel: (reason?: string): void => { hooks.cancel(reason) },
      readFrom(from: number): HostReadResult {
        const sources = spec.output
        if (sources === undefined || sources.length === 0) return { text: '', nextOffset: from, lossy: false }
        // 本仓每个任务只挂一个拉源；多于一个说明契约长出了新形状，假体不该静默只读第一个。
        if (sources.length > 1) throw new Error('jobHostDouble 只认识单拉源；多拉源要先补游标语义')
        const source = sources[0]
        if (source === undefined) return { text: '', nextOffset: from, lossy: false }
        return source.read(from)
      },
      read(): string {
        const at = cursors.get(self) ?? 0
        const result = self.readFrom(at)
        cursors.set(self, result.nextOffset)
        return result.text
      },
    }
    void hooks.done.then((outcome) => { settled.push(outcome.status) })
    return self
  }
  return {
    host: {
      start(spec: JobHostSpec): string {
        kinds.push(spec.kind)
        labels.push(spec.label)
        const self = capture(spec)
        captures.push(self)
        return `${spec.kind}-${captures.length}`
      },
    },
    captures,
    kinds,
    labels,
    settled,
    last(): JobCapture {
      const self = captures.at(-1)
      if (self === undefined) throw new Error('还没有任务登记')
      return self
    },
  }
}
