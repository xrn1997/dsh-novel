import { randomUUID } from 'node:crypto'
import type { ExploreBook, ExploreFailure, ExploreSnapshot, SearchGroup } from '../shared/wire.js'
import type { JobHost, JobOutcome } from './import-job.js'
import { mergeBooks } from './merge.js'

/**
 * 分类轮次的持有者：整轮**逐源结果**由 Node 半持有，读面给**全量快照**。
 *
 * 为什么另起一个持有者而不扩 `SearchJobs`：那边读面是 append-only 的游标增量
 * （`added`/`next`），而归并会**修订已经发出去的条目**——第二个源带回同一本书要给已发的那条
 * 加 origin、`sourceCount` 从 1 变 2。增量模型装不下修订，硬塞进去就得为「已发条目怎么改」
 * 发明第三套语义；快照整帧替换则让归并保持成一个纯函数（`mergeBooks`）。代价是每帧重算，
 * 规模上划算（每源首页 10~20 条）。
 *
 * 与 `search-job` 同口径的部分照旧：宿主登记（kind `novel-explore`）、终态单点 `end`、
 * 变了就 `notify`、协作式取消；与 `SourceJobs`（导入 / 批量验证）**分槽**——那两个是写，
 * 让浏览分类挡住导入等于惩罚读动作。读面形状见 `ExploreSnapshot`。
 */

/** 运行器契约：门面（`ReadingService`）把「逐源跑一轮」包进来——持有者不认识门面。
 *  返回值一律 `unknown`：整轮结果经 `emit` 收，运行器自己返回什么都不相干。
 *  与 `SearchJobRun` 的差别只在读面，故两边签名同形（将来若合并成泛型持有者，读面仍是分岔点）。 */
export type ExploreJobRun = (
  emit: (group: SearchGroup) => void,
  /** 协作式取消：运行器每取一个源查一次；在途请求不撤回 */
  shouldStop: () => boolean,
) => Promise<unknown>

/** 整轮结果保留期：与搜索同一档。超时后读面返回 null——「结果已过期」绝不伪装成
 *  「这一类没有书」。**刻意不进 wire**：浏览器半从不对这条快照做游标算术，用不到这个值。 */
const RETAIN_MS = 5 * 60_000

/** 服务端持有的整轮结果（内部态；跨半只出 `ExploreSnapshot`，不泄全量 groups） */
interface Held {
  id: string
  kind: string
  total: number
  startedAt: number
  /** 完成序累积：谁先抓完谁先进归并 */
  groups: SearchGroup[]
  phase: 'running' | 'done' | 'failed'
  /** 用户主动停止（终态但仍可读）；只有 cancel() 会置位，被新一轮替换不算 */
  cancelled: boolean
  finishedAt?: number
  error?: string
  settle: (outcome: JobOutcome) => void
}

export class ExploreJobs {
  private current: Held | null = null
  private readonly listeners = new Set<() => void>()

  constructor(private readonly deps: {
    /** 宿主 `ctx.jobs` 的窄面；缺省即不登记（单测直构与无 jobs 的组合走这条） */
    host?: JobHost
    now?: () => number
    uuid?: () => string
  } = {}) {}

  /** 订阅「本轮状态变了」。返回退订口。
   *  **只发信号不发数据**：快照由订阅者自取，故多个观察者（SSE 每条连接各一份）共用同一份持有物。 */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private notify(): void {
    // 快照成数组：回调里再 subscribe/unsubscribe 不该让本轮漏发给别人
    for (const listener of [...this.listeners]) listener()
  }

  /** 提交一轮分类浏览。**只留最近一轮**：新提交即替换上一轮——上一轮若在跑则被协作式收手，
   *  读面立刻指向新一轮（两真相同时在场是更坏的选择）。 */
  start(kind: string, total: number, run: ExploreJobRun): { jobId: string } {
    const prev = this.current
    if (prev !== null && prev.phase === 'running') {
      this.end(prev, 'killed', '已被新一次分类浏览替换', '任务已被新一次分类浏览替换')
    }
    const held: Held = {
      id: (this.deps.uuid ?? randomUUID)(), kind, total,
      startedAt: this.now(), groups: [], phase: 'running', cancelled: false,
      settle: () => {},
    }
    const host = this.deps.host
    if (host !== undefined) {
      const done = new Promise<JobOutcome>((res) => {
        held.settle = (o): void => { res(o) }
      })
      // 宿主契约：start() 内同步调 run() 取 hooks，故 done 必须先建好
      host.start({
        kind: 'novel-explore',
        label: `书城分类「${kind}」（${total} 家书源）`,
        run: () => ({ cancel: (reason): void => { this.cancel(reason) }, done }),
      })
    }
    this.current = held
    this.notify()                                      // 新一轮开场：观察者据此把旧列表整帧换掉
    const emit = (group: SearchGroup): void => { held.groups.push(group); this.notify() }
    const shouldStop = (): boolean => held.phase !== 'running'   // 取消 / 被替换都表现为「不再是本轮的 running」
    // 同步起跑（照 search-job 的口径）：`run` 交出的 emit 必须在本函数返回前就在位，
    // 否则调用方紧接着 emit 的第一组会丢（被否的写法：`Promise.resolve().then(() => run(...))`）。
    // 本模块的运行器虽要先等网络，这条属性照样要立——它是调用方的契约，不是运行器的习惯。
    let running: Promise<unknown>
    try {
      running = Promise.resolve(run(emit, shouldStop))
    } catch (e) {
      this.end(held, 'failed', undefined, e instanceof Error ? e.message : String(e))
      return { jobId: held.id }
    }
    void running.then(
      () => { this.end(held, 'completed') },
      (e: unknown) => { this.end(held, 'failed', undefined, e instanceof Error ? e.message : String(e)) },
    )
    return { jobId: held.id }
  }

  /** 读面快照：**全量**归并书单 + 失败源清单。
   *  归并在读时做而不缓存：`mergeBooks` 是纯函数、条目 < 200，缓存只会多出一份要跟着失效的状态；
   *  这样「第二个源带回同一本书」不需要任何修订语义，下一次读自然就合上了。
   *  两种读作「无任务」（null）的情况要分清：从未提交过；以及**结束后过了保留期**——
   *  后者绝不返回一个空 `books`，那会把「结果已过期」伪装成「这一类没有书」。 */
  snapshot(): ExploreSnapshot | null {
    const h = this.current
    if (h === null) return null
    if (h.phase !== 'running' && h.finishedAt !== undefined
      && this.now() - h.finishedAt > RETAIN_MS) return null
    const books: ExploreBook[] = mergeBooks(h.groups)
    const failures: ExploreFailure[] = h.groups
      .filter((g) => g.error !== undefined)
      .map((g) => ({ sourceId: g.sourceId, sourceName: g.sourceName, code: g.error!.code, message: g.error!.message }))
    return {
      id: h.id, kind: h.kind, phase: h.phase, cancelled: h.cancelled,
      total: h.total, done: h.groups.length,
      books, failures, startedAt: h.startedAt,
      ...(h.finishedAt === undefined ? {} : { finishedAt: h.finishedAt }),
      ...(h.error === undefined ? {} : { error: h.error }),
    }
  }

  /** 取消当前这轮（宿主 cancel 与 UI 的「停止浏览」都走这条）。返回：是否真有个在跑的轮次。
   *  与 `SearchJobs` 同口径**立即结算终态**而不等运行器收手：这是读，没有半途写脏的顾虑，
   *  读方要的是「这一轮到此为止」的确定答复。停止不是失败——`cancelled` 让浏览器半不报红条。 */
  cancel(reason?: string): boolean {
    const h = this.current
    if (h === null || h.phase !== 'running') return false
    h.cancelled = true
    const why = reason ?? '用户停止'
    this.end(h, 'killed', `任务已取消：${why}`, `任务已取消：${why}`)
    return true
  }

  private now(): number { return this.deps.now?.() ?? Date.now() }

  /** 终态单点：phase / finishedAt / error 与宿主结算同处写，缺一处就是
   *  「界面说结束了而宿主还挂着 running」 */
  private end(h: Held, status: JobOutcome['status'], detail?: string, error?: string): void {
    if (h.phase !== 'running') return
    h.phase = status === 'completed' ? 'done' : 'failed'
    if (error !== undefined) h.error = error
    h.finishedAt = this.now()
    h.settle({ status, ...(detail === undefined || detail === '' ? {} : { detail }) })
    this.notify()                                      // 终态也要发：SSE 据此收尾并关流
  }
}
