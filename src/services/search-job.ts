import { randomUUID } from 'node:crypto'
import { SEARCH_HITS_CAP_PER_SOURCE, SEARCH_JOB_RETENTION_MS } from '../shared/wire.js'
import type { SearchGroup, SearchJobSnapshot } from '../shared/wire.js'
import { ChangeSignal, HostTie } from './job-holder.js'
import type { JobHost, JobOutcome } from './job-holder.js'

/**
 * 聚合搜索的后台任务：整轮结果由 **Node 半持有**，读面给游标增量。
 *
 * 为什么要它：宿主 `conversation.view` 是「一次只渲染一个」的座位——切 tab 即卸载；
 * 若把搜索的在途循环放在浏览器半组件里，结果会随卸载清零、重挂载整轮重打。
 * 持有者在 Node 半，「离开界面」就与「任务是否完成」脱钩。
 *
 * 与写任务（`SourceJobs` 的导入 / 批量验证）**分槽**：搜索是读、那两个是写，让搜索挡住导入
 * 等于惩罚探索动作。代价如实记录：宿主侧可同时存在两条 novel 任务（宿主配额
 * `maxConcurrentJobsPerOwner` 缺省 10，够用），UI 的「任何任务在途即禁用」判据只管写任务。
 *
 * 生命周期同样登记给 `ctx.jobs`（kind `novel-search`）——身份、终态、取消入口与写任务同口径；
 * 本模块持有「结果集 + 游标」；过程行尾缓冲挂在登记给宿主的那根线上（`job-holder.ts` 的 `HostTie`，
 * 宿主经 `readOutput` 拉）。
 * 宿主任务面板只有 label / detail（另有 `readOutput` 过程行拉取面），装不下整轮结果——结果与明细仍只在这里。
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
  /** 与宿主登记之间的那根线（`job-holder.ts`）：缺席即没登记，终态与过程行都不往外发。 */
  tie: HostTie | null
}

/** 命中截断：内存上限要有主——逐源不截是无上界（站点侧搜索面本就只取首页） */
function capHits(group: SearchGroup): SearchGroup {
  return group.hits.length <= SEARCH_HITS_CAP_PER_SOURCE
    ? group
    : { ...group, hits: group.hits.slice(0, SEARCH_HITS_CAP_PER_SOURCE) }
}

export class SearchJobs {
  private current: Held | null = null

  /** 「本轮状态变了」信号（机械住 `job-holder.ts` 的 `ChangeSignal`）：SSE 路由订阅它、
   *  自己带游标取增量。
   *  **只发信号不发数据**：游标属于每一条连接，不属于持有者——所以多个观察者、不同游标，
   *  共用同一份持有物而不互相踩。 */
  readonly signal = new ChangeSignal()

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
      // 宿主登记（机械与顺序都住 `job-holder.ts`）：kind 用 novel-* 前缀与 bash/subagent 分 namespace。
      tie: HostTie.open(this.deps.host, {
        kind: 'novel-search',
        label: `聚合搜索「${keyword}」（${total} 家书源）`,
        // 宿主请求收手即整轮进终态：搜索是读，没有半途写脏的顾虑（理由同 `cancel`）
        onCancel: (reason): void => { this.cancel(reason) },
      }),
    }
    this.current = held
    this.signal.notify()                              // 新一轮开场：旧观察者据此把结果清零换轮
    // 同步起跑：`run` 交出的 emit 必须在本函数返回前就在位，否则调用方紧接着 emit 的第一组会丢
    //（被否的写法：`void Promise.resolve().then(() => run(...))`——它把 emit 推后一个微任务，
    //  同步消费 emit 的一方什么都收不到）。
    // 每源答话留一行过程行进尾缓冲（没登记宿主即 `tie` 为 null，不写）：行文把「结果条数」与
    // 「源状态」分成两轴——status 是源的验证态、不是本轮结果；条数用 cap 后实际进快照的数，
    // 截断时附原始数（上限见 SEARCH_HITS_CAP_PER_SOURCE）。单源失败点名 `error.code`；
    // 与整轮结果（读面 snapshot）分工照 ADR-0018 不变。
    const emit = (group: SearchGroup): void => {
      const capped = capHits(group)
      held.groups.push(capped)
      const truncated = group.hits.length > capped.hits.length
        ? `，原始 ${group.hits.length}`
        : ''
      held.tie?.note(group.error !== undefined
        ? `${group.sourceName}：失败（${group.error.code}）`
        : `${group.sourceName}：${capped.hits.length} 条（源 ${group.status}${truncated}）`)
      this.signal.notify()
    }
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
   *  「这一轮到此为止」的确定答复；终态后在途请求不再收货。 */
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
    h.tie?.settle({ status, ...(detail === undefined || detail === '' ? {} : { detail }) })
    this.signal.notify()                                      // 终态也要发：SSE 据此收尾并关流
  }
}
