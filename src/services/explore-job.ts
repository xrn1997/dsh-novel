import { randomUUID } from 'node:crypto'
import type { ExploreBook, ExploreFailure, ExploreSnapshot, SearchGroup, SearchHit } from '../shared/wire.js'
import type { JobHost, JobOutcome } from './import-job.js'
import { mergeBooks } from './merge.js'
import { canonUrl } from './request.js'

/**
 * 分类轮次的持有者：整轮**逐源结果**由 Node 半持有，读面给**全量快照**。
 *
 * 为什么另起一个持有者而不扩 `SearchJobs`：那边读面是 append-only 的游标增量
 * （`added`/`next`），而归并会**修订已经发出去的条目**——第二个源带回同一本书要给已发的那条
 * 加 origin、`sourceCount` 从 1 变 2。增量模型装不下修订，硬塞进去就得为「已发条目怎么改」
 * 发明第三套语义；快照整帧替换则让归并保持成一个纯函数（`mergeBooks`）。代价是每帧重算，
 * 规模上划算（每源首页 10~20 条）。
 *
 * **为什么按源累积住在这里**：续页要跨页记忆——一个源第 2 页带回的书里有多少是新的（去重），
 * 有多少是本页零新增（= 这个源到底了），两件都需要「上一页收到了什么」，而客户端刻意什么都不握
 * （它的读模型是「零累积、整帧替换」，换页不该让这套长出一个累积器）。累积因此只能落在持有者
 * 这一侧，且**只按实际收到的组**累积：续页那一批里被跳过的源一个组都不发（`skip` 是静默契约）。
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

/** 整轮结果保留期：**本持有者自己的档**，不与搜索任务的 `SEARCH_JOB_RETENTION_MS` 同值。
 *  超时后读面返回 null——「结果已过期」绝不伪装成「这一类没有书」。
 *  **刻意不进 wire**：分类轮次的读面是全量快照、浏览器半从不对它做游标算术，用不到这个值——
 *  它只服务 Node 半的读面，也就没有跟搜索那份对齐的理由。 */
const RETAIN_MS = 5 * 60_000

/** 一轮最多翻到第几页（**唯一主人**）。页数是用户点出来的，不是自动跟进，故这个数只是兜底：
 *  到底了还愿意再点、站点的分类又永远翻不到头时，总得有个上界——触到它 `hasMore` 就变 false。
 *  选择上界而不是「翻到没有新书为止」，是因为「没有新书」在分页站点上可能只是一页重复；
 *  上界是确定的。 */
export const MAX_EXPLORE_PAGES = 10

/** 一个源在本轮累积到的东西：条目本身 + **本页**新增条数。
 *  `lastNew` 归零就是「这个源在这一类上到底了」的判据（续页不再打它，也计入 `hasMore`）。 */
interface HeldSource {
  group: SearchGroup
  lastNew: number
}

/** 服务端持有的整轮结果（内部态；跨半只出 `ExploreSnapshot`，不泄全量 groups） */
interface Held {
  id: string
  kind: string
  total: number
  startedAt: number
  /** **按 sourceId 累积**（完成序）：同一个源的第 2 页并进它第 1 页那一组，不新起一组——
   *  键就是 sourceId 本身，所以「一个源一组」是结构上的事实，不靠调用方守规矩。 */
  groups: Map<string, HeldSource>
  /** 已加载到第几页（`start` 起第 1 页，`advance` 每续一次 +1） */
  page: number
  phase: 'running' | 'done' | 'failed'
  /** 用户主动停止（终态但仍可读）；只有 cancel() 会置位，被新一轮替换不算 */
  cancelled: boolean
  finishedAt?: number
  error?: string
  settle: (outcome: JobOutcome) => void
}

/** 命中在本源内的去重键：有地址按地址的规范形（`,{option}` 选项后缀与主机的书写差异都不算新书），
 *  没地址退到「书名 + NUL + 作者」——与归并键同一条理由（可见字符拼键会把两本不同的书撞成一本）。
 *  取不到地址的条目照样能去重，否则同一本书每页都会被当成新的，「零新增即到底」永远不成立。 */
function dedupKeyOf(hit: SearchHit): string {
  return hit.url === null || hit.url === '' ? `${hit.title}\u0000${hit.author ?? ''}` : canonUrl(hit.url)
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
      startedAt: this.now(), groups: new Map(), page: 1, phase: 'running', cancelled: false,
      settle: () => {},
    }
    this.current = held
    return this.launch(held, run)
  }

  /** 续第 `page + 1` 页：**同一轮、同一 id**，本轮已收到的累积原样留着，新一页并进去。
   *  换 id 就等于让浏览器半的「零累积、整帧替换」读模型清空重来——续页是这一轮里的事，不是新的一轮。
   *
   *  三种「续不动」如实抛错（不猜、不做无效起跑）：没有轮次；在途那一批还没收手；分类对不上。
   *  在途那一种尤其不能放行——`end` 是按**轮次**收口的，旧批次的收尾会把刚点亮的新批次一并结算掉
   *  （表现为「第 2 页还没回来就显示 done」），而两个批次同时往同一个源的累积里写也得不到可读读数。 */
  advance(kind: string, run: ExploreJobRun): { jobId: string } {
    const h = this.current
    if (h === null) throw new Error('没有可续页的分类轮次')
    if (h.kind !== kind) throw new Error(`轮次分类不符：当前「${h.kind}」，请求「${kind}」`)
    if (h.phase === 'running') throw new Error(`分类轮次「${kind}」这一批还在抓，不能同时续页`)
    h.page += 1
    h.phase = 'running'
    // 续页把这轮重新点亮：上一批留下的「已停止 / 失败」不再描述它（否则新批在跑而界面说停过）
    h.cancelled = false
    h.finishedAt = undefined
    h.error = undefined
    return this.launch(h, run)
  }

  /** 起跑一段（`start` 的第 1 批与 `advance` 的每一批共用这一处）：宿主登记 + 变了就 `notify`
   *  + 同步起跑 + 终态单点收口。两处各抄一遍就会长出两种收尾口径。 */
  private launch(h: Held, run: ExploreJobRun): { jobId: string } {
    const host = this.deps.host
    if (host !== undefined) {
      const done = new Promise<JobOutcome>((res) => {
        h.settle = (o): void => { res(o) }
      })
      // 宿主契约：start() 内同步调 run() 取 hooks，故 done 必须先建好
      host.start({
        kind: 'novel-explore',
        label: h.page === 1
          ? `书城分类「${h.kind}」（${h.total} 家书源）`
          : `书城分类「${h.kind}」第 ${h.page} 页（${h.total} 家书源）`,
        run: () => ({ cancel: (reason): void => { this.cancel(reason) }, done }),
      })
    }
    this.notify()                                      // 开场 / 续页起跑：观察者据此把读面当成在跑
    const emit = (group: SearchGroup): void => { this.absorb(h, group); this.notify() }
    const shouldStop = (): boolean => h.phase !== 'running'   // 取消 / 被替换都表现为「不再是本轮的 running」
    // 同步起跑（照 search-job 的口径）：`run` 交出的 emit 必须在本函数返回前就在位，
    // 否则调用方紧接着 emit 的第一组会丢（被否的写法：`Promise.resolve().then(() => run(...))`）。
    // 本模块的运行器虽要先等网络，这条属性照样要立——它是调用方的契约，不是运行器的习惯。
    let running: Promise<unknown>
    try {
      running = Promise.resolve(run(emit, shouldStop))
    } catch (e) {
      this.end(h, 'failed', undefined, e instanceof Error ? e.message : String(e))
      return { jobId: h.id }
    }
    void running.then(
      () => { this.end(h, 'completed') },
      (e: unknown) => { this.end(h, 'failed', undefined, e instanceof Error ? e.message : String(e)) },
    )
    return { jobId: h.id }
  }

  /** 一个源的结果落进本轮：首次出现即建组（第 1 页那一组原样收下——它是这个源给的第一批，
   *  没有更早的记忆可比、也没有「新增」可言），再次出现**并进同一组**（第 2 页的书紧挨着第 1 页的）。
   *  只按**实际收到的组**累积，绝不按目标清单推：续页那批里被跳过的源一个组都不发（`skip` 是静默契约），
   *  替它们补一个空组就会把「已到底」洗成「这一页 0 条」——两者本该是同义的，但补出来的空组还会
   *  把那一段记忆抹掉（下一轮续页又会去打它）。
   *  `lastNew` 记的是**本页真正新增**的条数（去重之后），它就是「这个源到底了没有」的判据。 */
  private absorb(h: Held, group: SearchGroup): void {
    const prev = h.groups.get(group.sourceId)
    if (prev === undefined) {
      h.groups.set(group.sourceId, { group, lastNew: group.hits.length })
      return
    }
    const known = new Set(prev.group.hits.map(dedupKeyOf))
    const fresh = group.hits.filter((hit) => {
      const key = dedupKeyOf(hit)
      if (known.has(key)) return false
      known.add(key)
      return true
    })
    prev.group.hits.push(...fresh)
    prev.lastNew = fresh.length
  }

  /** 已经到底的源 id（本页零新增）：续页要跳过的就是它们——与 `skip` 是同一份判据的两侧，
   *  「谁到底了」只有这里一个出处。没有组的源不在内：它没发过组，一无所知，不是「到底」。 */
  exhaustedSourceIds(): string[] {
    const out: string[] = []
    for (const [id, e] of this.current?.groups ?? []) if (e.lastNew === 0) out.push(id)
    return out
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
    const held = [...h.groups.values()]
    const books: ExploreBook[] = mergeBooks(held.map((e) => e.group))
    const failures: ExploreFailure[] = held
      .map((e) => e.group)
      .filter((g) => g.error !== undefined)
      .map((g) => ({ sourceId: g.sourceId, sourceName: g.sourceName, code: g.error!.code, message: g.error!.message }))
    return {
      id: h.id, kind: h.kind, phase: h.phase, cancelled: h.cancelled,
      total: h.total, done: h.groups.size,
      page: h.page,
      hasMore: h.page < MAX_EXPLORE_PAGES && held.some((e) => e.lastNew > 0),
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
