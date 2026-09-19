import { randomUUID } from 'node:crypto'
import { SEARCH_HITS_CAP_PER_SOURCE, SEARCH_JOB_RETENTION_MS } from '../shared/wire.js'
import type { SearchGroup, SearchJobSnapshot } from '../shared/wire.js'
import type { JobHost, JobOutcome } from './import-job.js'

/**
 * 聚合搜索的后台任务：整轮结果由 **Node 半持有**，读面给游标增量。
 *
 * 为什么要它（实测，见 docs/design/client.md 已知开口）：搜索的在途循环原先住在浏览器半组件里，
 * 而宿主 `conversation.view` 是「一次只渲染一个」的座位——切 tab 即卸载，结果随之清零，
 * 重挂载整轮重打。把持有者搬到这一侧，「离开界面」就与「任务是否完成」脱钩。
 *
 * 与写任务（`SourceJobs` 的导入 / 批量验证）**分槽**：搜索是读、那两个是写，让搜索挡住导入
 * 等于惩罚探索动作。代价如实记录：宿主侧可同时存在两条 novel 任务（宿主配额
 * `maxConcurrentJobsPerOwner` 缺省 10，够用），UI 的「任何任务在途即禁用」判据只管写任务。
 *
 * 生命周期同样登记给 `ctx.jobs`（kind `novel-search`）——身份、终态、取消入口与写任务同口径；
 * 本模块只额外持有「结果集 + 游标」这件事，宿主那套只有一个 `detail` 字符串，装不下。
 */

/** 运行器契约：门面（`ReadingService`）把 `searchProgressive` 包进来——持有者不认识门面。
 *  返回值一律是 `unknown`：整轮结果由持有者经 `emit` 收，运行器自己返回什么都不相干。 */
export type SearchJobRun = (
  emit: (group: SearchGroup) => void,
  /** 协作式取消：运行器每取一个条目查一次；在途请求不撤回（已经打出去就不浪费第二次机会） */
  shouldStop: () => boolean,
) => Promise<unknown>

/** 服务端持有的整轮结果（内部态；跨半只出 `SearchJobSnapshot`，不泄全量 groups） */
interface Held {
  id: string
  keyword: string
  total: number
  startedAt: number
  /** 完成序累积：谁先搜完谁先可见，也是 `since`/`next` 游标的值域 */
  groups: SearchGroup[]
  phase: 'running' | 'done' | 'failed'
  /** 用户主动停止（终态但仍留结果）；只有 cancel() 会置位，被新一轮替换不算 */
  cancelled: boolean
  finishedAt?: number
  error?: string
  settle: (outcome: JobOutcome) => void
}

/** 命中截断：内存上限要有主——640 家不截是无上界（站点侧搜索面本就只取首页） */
function capHits(group: SearchGroup): SearchGroup {
  return group.hits.length <= SEARCH_HITS_CAP_PER_SOURCE
    ? group
    : { ...group, hits: group.hits.slice(0, SEARCH_HITS_CAP_PER_SOURCE) }
}

export class SearchJobs {
  private current: Held | null = null
  private readonly listeners = new Set<() => void>()

  /** 订阅「本轮状态变了」（新一轮、新增分组、终态）。返回退订口。
   *  **只发信号不发数据**：游标属于每一条连接，不属于持有者——SSE 路由收到信号后自己
   *  `snapshot(cursor)` 取增量，所以多个观察者、不同游标，共用同一份持有物而不互相踩。 */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private notify(): void {
    // 快照成数组：回调里再 subscribe/unsubscribe 不该让本轮漏发给别人
    for (const listener of [...this.listeners]) listener()
  }

  constructor(private readonly deps: {
    /** 宿主 `ctx.jobs` 的窄面；缺省即不登记（单测直构与无 jobs 的组合走这条） */
    host?: JobHost
    now?: () => number
    uuid?: () => string
  } = {}) {}

  /** 提交一轮搜索。**只留最近一轮**：新提交即替换上一轮——上一轮若在跑则被协作式收手，
   *  读面立刻指向新一轮（旧结果不再可读，避免两真相同时在场）。 */
  start(keyword: string, total: number, run: SearchJobRun): { jobId: string } {
    const prev = this.current
    if (prev !== null && prev.phase === 'running') {
      this.end(prev, 'killed', '已被新一轮搜索替换', '任务已被新一轮搜索替换')
    }
    const held: Held = {
      id: (this.deps.uuid ?? randomUUID)(), keyword, total,
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
        kind: 'novel-search',
        label: `聚合搜索「${keyword}」（${total} 家书源）`,
        run: () => ({ cancel: (reason): void => { this.cancel(reason) }, done }),
      })
    }
    this.current = held
    this.notify()                                      // 新一轮开场：旧观察者据此把结果清零换轮
    // 同步起跑：`run` 交出的 emit 必须在本函数返回前就在位，否则调用方紧接着 emit 的第一组会丢
    //（被否的写法：`void Promise.resolve().then(() => run(...))`——它把 emit 推后一个微任务，
    //  同步消费 emit 的一方什么都收不到）。
    const emit = (group: SearchGroup): void => { held.groups.push(capHits(group)); this.notify() }
    const shouldStop = (): boolean => held.phase !== 'running'   // 取消 / 被替换都表现为「不再是本轮的 running」
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

  /**
   * 读面快照：`since` 之后的增量 + 下一次该带的游标。
   * 两种读作「无任务」（null）的情况要分清：从未提交过；以及**结束后过了保留期**——
   * 后者绝不返回一个空 `groups`，那会把「结果已过期」伪装成「搜了没命中」。
   */
  snapshot(since = 0): SearchJobSnapshot | null {
    const h = this.current
    if (h === null) return null
    if (h.phase !== 'running' && h.finishedAt !== undefined
      && this.now() - h.finishedAt > SEARCH_JOB_RETENTION_MS) return null
    const start = Math.max(0, Math.min(since, h.groups.length))
    return {
      id: h.id, keyword: h.keyword, phase: h.phase, cancelled: h.cancelled,
      total: h.total, done: h.groups.length,
      added: h.groups.slice(start), next: h.groups.length,
      startedAt: h.startedAt,
      ...(h.finishedAt === undefined ? {} : { finishedAt: h.finishedAt }),
      ...(h.error === undefined ? {} : { error: h.error }),
    }
  }

  /** 取消当前这轮（宿主 cancel 与 UI 的「取消搜索」都走这条）。返回：是否真有个在跑的轮次。
   *  刻意**立即结算终态**而不等运行器收手：搜索是读，没有半途写脏的顾虑，读方要的是
   *  「这一轮到此为止」的确定答复；在途请求回来时因 `phase !== 'running'` 被忽略。 */
  cancel(reason?: string): boolean {
    const h = this.current
    if (h === null || h.phase !== 'running') return false
    h.cancelled = true                                // 停止不是失败：读面要能分清（见 SearchJobSnapshot.cancelled）
    const why = reason ?? '已取消'
    this.end(h, 'killed', `任务已取消：${why}`, `任务已取消：${why}`)
    return true
  }

  private now(): number { return this.deps.now?.() ?? Date.now() }

  /** 终态单点：phase / finishedAt / error 与宿主结算同处写，缺一处就是「UI 说结束了而宿主还挂着 running」 */
  private end(
    h: Held,
    status: JobOutcome['status'],
    detail?: string,
    error?: string,
  ): void {
    if (h.phase !== 'running') return
    h.phase = status === 'completed' ? 'done' : 'failed'
    if (error !== undefined) h.error = error
    h.finishedAt = this.now()
    h.settle({ status, ...(detail === undefined || detail === '' ? {} : { detail }) })
    this.notify()                                      // 终态也要发：SSE 据此收尾并关流
  }
}
