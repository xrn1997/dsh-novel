import { randomUUID } from 'node:crypto'
import type { ExploreBook, ExploreSnapshot, JobStarted, SearchGroup, SearchHit } from '../shared/wire.js'
import { ChangeSignal, expiredAfter, HostTie, settleTerminal } from './job-holder.js'
import type { JobHost, JobOutcome } from './job-holder.js'
import { DEFAULT_JOB_OUTPUT_BYTES, JobTail } from './job-tail.js'
import { canonUrl } from './request.js'

/**
 * 分类轮次的持有者：**一轮 = 一个源 + 一个类**，整轮跨页累积的书单由 Node 半持有，读面给**全量快照**、整帧替换。
 *
 * 为什么另起一个持有者而不扩 `SearchJobs`：那边是**游标增量**，读方自己把帧接成列表；这里续页改写的不只是
 * 新条目，还有 `page` / `hasMore` 这些**整轮**读数，游标装不下「同一轮的读数变了」。本模块不做跨源归并：
 * 一条命中就是一本书（口径见 `ADR-0028`）。累积必须住在这里：续页要跨页记忆（去重与「本页零新增 = 到底」），
 * 而浏览器半刻意什么都不握。
 *
 * 与 `search-job` 同口径：宿主登记（kind `novel-explore`）、终态单点 `end`、变了就 `notify`、协作式取消；
 * 与 `SourceJobs`（导入/批量验证）**分槽**——写任务不该挡住读动作。读面形状见 `ExploreSnapshot`。
 */

/** 运行器契约：门面（`ReadingService`）把「单源跑一页」包进来——持有者不认识门面，也不认识站点。返回值一律
 *  `unknown`：那一页经 `emit` 收。**页码由持有者交给运行器**：「这一批打第几页」必须有唯一主人——按读面页号
 *  自行 +1 会把「已占到第几页」与「下一个该打第几页」焊成同一个数，而失败的那一批不该占号。 */
export type ExploreJobRun = (
  emit: (group: SearchGroup) => void,
  /** 协作式取消：运行器每取一步查一次；在途请求不撤回 */
  shouldStop: () => boolean,
  /** 这一批要打的那一页（`Held.attempted`） */
  page: number,
) => Promise<unknown>

/** 整轮结果保留期：**本持有者自己的档**，不与搜索任务同值。超时后读面返回 null——「结果已过期」绝不伪装成
 *  「这一类没有书」。**刻意不进 wire**：浏览器半从不对全量快照做游标算术，用不到这个值。 */
const RETAIN_MS = 5 * 60_000

/** 一轮最多翻到第几页（**唯一主人**）：页数是用户点出来的，不是自动跟进，故这个数只是兜底上界——触到它
 *  `hasMore` 就变 false。选上界而不是「翻到没有新书为止」，是因为「没有新书」在分页站点上可能只是一页重复。 */
export const MAX_EXPLORE_PAGES = 10

/** 一个源在本轮累积到的东西：条目本身 + **本页**新增条数。`lastNew` 归零就是「到底了」的判据；唯一例外是
 *  **这一页抓取失败**（失败的一页不是到底的一页，见 `absorb`）。第 1 页就失败仍算到底：它一条都没累积。
 */
interface HeldSource {
  /** 本源本轮累积到的条目（跨页并入，按 `dedupKeyOf` 去重） */
  hits: SearchHit[]
  /** **本页**真正新增的条数：归零就是「这个源到底了」的判据（唯一的例外是下面那条 pageError） */
  lastNew: number
  /** 这一页抓取失败（成功的一页会把它清掉）。结构化那一份（码 + 话）留在这里：读面只出一行人类可读的串，
   *  错误码不该只活在拼出来的中文里。**「这一页没问到」与「这一类真的没货」是两件事**。 */
  pageError?: { code: string; message: string } | undefined
}

/** 服务端持有的整轮结果（内部态；跨半只出 `ExploreSnapshot`，不泄这份累积器） */
interface Held {
  id: string
  /** 提交时点名的那一个源——浏览轴的这一维在提交时就定死了，本轮不再换 */
  sourceId: string
  /** 源名由**第一个在轮次还在跑时**到达的组带回来：持有者不查注册表（源清单的主人是门面）。终态之后迟到的
   *  组不再报名（它不拥有这一轮的结论，见 `absorb`）；还没收到任何组时是空串。 */
  sourceName: string
  kind: string
  startedAt: number
  /** 本源本轮累积到的东西（单源 ⇒ 不再需要按 sourceId 分组的 Map） */
  accum: HeldSource
  /** **这一轮占到第几页**：第 1 页由提交带来，此后只有成功并入的那一页才占号。失败或被停止的那一批不占号，
   *  所以下一次续页打回的仍是同一页——「重试的机会留给用户」落在页号上才有机械保证。 */
  page: number
  /** **这一批在打第几页**：`start` 交 1、`advance` 交 `page + 1`；成功并入的一刻由 `absorb` 转成 `page`。 */
  attempted: number
  /** 有一批正握着这一轮在跑（`launch` 置位、终态单点清位）。**它不是 `phase` 的替身**：`cancel` 会立刻把
   *  `phase` 落终态，而在途请求不撤回，此后 `phase` 已不再描述「还有没有一批在跑」。续页的守卫只看这个标记。 */
  inflight: boolean
  /** 批次代际（`launch` 每次 +1）：陈旧批次不得 emit、不得在自己的收尾里结算这一轮（否则「第 2 页还没回来就显示 done」）。 */
  generation: number
  phase: 'running' | 'done' | 'failed'
  /** 这一轮被取消（终态但仍可读）；只有 cancel() 会置位，被新一轮替换不算 */
  cancelled: boolean
  finishedAt?: number | undefined
  /** 这一轮的**一条**失败泳道：整轮级失败由 `end` 写，「这一页没问到」由 `absorb` 写、下一批成功的一页清掉。
   *  执行体从不抛错，抓取失败是以带 `error` 的组交回来的——少了后半条，「没问到」就会与「真的没货」折成同一帧。 */
  error?: string | undefined
  /** 与**当前这批**宿主登记之间的挂点（`launch` 每批换一次；一轮一份尾缓冲见 `tail`）。 */
  tie: HostTie | null
  /** 过程行的有界尾缓冲：**一轮一份**（续页复用同一轮 ⇒ 同一份），仅在登记给宿主时存在。 */
  tail?: JobTail
}

/** 命中在本源内的去重键：有地址按地址的规范形（`,{option}` 与主机书写差异都不算新书），没地址退到「书名 + NUL +
 *  作者」。取不到地址的条目照样能去重，否则同一本书每页都会被当成新的，「零新增即到底」永远不成立。 */
function dedupKeyOf(hit: SearchHit): string {
  return hit.url === null || hit.url === '' ? `${hit.title}\u0000${hit.author ?? ''}` : canonUrl(hit.url)
}

/** 组里的命中 → 快照里的书。**不做任何合并**：一条命中就是一本书，顺序就是站点给的顺序（口径见 `ADR-0028`）。
 *  可空字段照 `SearchHit` 原样落 `null`，**不折成缺键**；唯一收口是空串封面——`coverUrl: ''` 说的是「没封面」，
 *  让它穿过去会让 `<img src="">` 替用户演一次加载失败。 */
function booksOf(hits: readonly SearchHit[]): ExploreBook[] {
  return hits.map((hit) => ({
    name: hit.title,
    author: hit.author,
    bookUrl: hit.url,
    coverUrl: hit.coverUrl === '' ? null : hit.coverUrl,
    kind: hit.kind,
    lastChapter: hit.lastChapterName,
    intro: hit.intro,
    wordCount: hit.wordCount,
  }))
}

export class ExploreJobs {
  private current: Held | null = null

  /** 「本轮状态变了」信号（机械住 `job-holder.ts` 的 `ChangeSignal`）：SSE 路由订阅它、自己取快照；只发信号不发数据。 */
  readonly signal = new ChangeSignal()

  private readonly deps: {
    /** 宿主 `ctx.jobs` 的窄面；缺省即不登记（单测直构与无 jobs 的组合走这条） */
    host?: JobHost
    now?: () => number
    uuid?: () => string
  }

  constructor(deps: {
    /** 宿主 `ctx.jobs` 的窄面；缺省即不登记（单测直构与无 jobs 的组合走这条） */
    host?: JobHost
    now?: () => number
    uuid?: () => string
  } = {}) {
    this.deps = deps
  }

  /** 提交一轮分类浏览：**一个源、一个类、从第 1 页起**。**只留最近一轮**：新提交即替换上一轮（在跑的协作式
   *  收手），读面立刻指向新一轮。换源与换类都走这一条：新一轮是**另一个对象**，旧批写的东西读面再也看不到。 */
  start(sourceId: string, kind: string, run: ExploreJobRun): JobStarted {
    const prev = this.current
    if (prev !== null && prev.phase === 'running') {
      this.end(prev, 'killed', '已被新一次分类浏览替换', '任务已被新一次分类浏览替换')
    }
    const held: Held = {
      id: (this.deps.uuid ?? randomUUID)(), sourceId, sourceName: '', kind,
      startedAt: this.now(), accum: { hits: [], lastNew: 0 }, page: 1, attempted: 1,
      inflight: false, generation: 0, phase: 'running', cancelled: false,
      tie: null,
    }
    this.current = held
    return this.launch(held, run)
  }

  /** 续第 `page + 1` 页：**同一轮、同一 id**，已收到的累积原样留着，新一页并进去——换 id 会让浏览器半的
   *  「零累积、整帧替换」读模型清空重来。
   *  三种「续不动」如实抛错：没有轮次；在途那一批还没收手；分类对不上。在途那一种尤其不能放行——两个批次
   *  同时写同一份累积得不偿失，而旧批的收尾会把刚点亮的新批一并结算。
   *  守卫看**在途标记**而不是 `phase`：`cancel` 会让 `phase` 先行落终态，拿它当判据就会误放行。
   *  取消是**收回了在途那一批的所有权**，因此取消后还能再点一次续页；被收回的那批由代际点穴。 */
  advance(kind: string, run: ExploreJobRun): JobStarted {
    const h = this.current
    if (h === null) throw new Error('没有可续页的分类轮次')
    if (h.kind !== kind) throw new Error(`轮次分类不符：当前「${h.kind}」，请求「${kind}」`)
    if (h.inflight) throw new Error(`分类轮次「${kind}」这一批还在抓，不能同时续页`)
    // 页号在这里**不落**，只记这一批要打第几页：占号是成功并入那一拍的事——上一批失败时这里算出的仍是同一页，续页既是往前也是重试。
    h.attempted = h.page + 1
    h.phase = 'running'
    // 续页把这轮重新点亮：上一批留下的「已停止 / 失败」不再描述它（否则新批在跑而界面说停过）
    h.cancelled = false
    h.finishedAt = undefined
    h.error = undefined
    return this.launch(h, run)
  }

  /** 起跑一段（`start` 首批与 `advance` 每批共用）：宿主登记 + 变了就 `notify` + 同步起跑 + 终态单点收口。
   *  一批起跑即领一代：交给运行器的 `emit` / `shouldStop` 与这批的收尾都认这一代；代际被盖过后旧批三件事同时
   *  失效——不再吐组、不再接着跑、收尾不结算。少了任何一件，旧批都能伸手改一轮它已经不再拥有的轮次。 */
  private launch(h: Held, run: ExploreJobRun): JobStarted {
    const gen = ++h.generation
    h.inflight = true
    const host = this.deps.host
    if (host !== undefined) {
      // 尾缓冲一轮一份（续页复用同一轮）：没宿主就不建。每批各自向宿主登记，拉源认的是**同一份**缓冲——按字节
      // 偏移读、每个读者各持游标，早页的读者不会把后页刚 push 的行拉走；过程行本来就不按批次分页归属。
      if (h.tail === undefined) h.tail = new JobTail(DEFAULT_JOB_OUTPUT_BYTES)
      // 页码段的 label **不报源数**：一轮就是一个源，那个数恒为 1；跨源编排才有「本轮问了几家」这种读数。
      h.tie = HostTie.open(host, {
        kind: 'novel-explore',
        label: `书城分类「${h.kind}」第 ${h.attempted} 页`,
        tail: h.tail,
        // 宿主请求收手即整轮进终态：与 search 面同口径（读，没有半途写脏的顾虑）
        onCancel: (reason): void => { this.cancel(reason) },
      })
    }
    this.signal.notify()                                      // 开场 / 续页起跑：观察者据此把读面当成在跑
    const emit = (group: SearchGroup): void => {
      if (h.generation !== gen) return                 // 陈旧批次迟到的组：这一轮已不归它
      this.absorb(h, group)
      // 每翻一页留一行过程行进尾缓冲：行文把「本轮条数」与「源状态」分成两轴——status 是源的验证态、不是这一页
      // 的结果；整轮结果（snapshot）分工照 ADR-0018 不变。
      h.tail?.push(group.error !== undefined
        ? `${group.sourceName}：第 ${h.attempted} 页失败（${group.error.code}）`
        : `${group.sourceName}：第 ${h.attempted} 页 ${group.hits.length} 条（源 ${group.status}）`)
      this.signal.notify()
    }
    const shouldStop = (): boolean => h.generation !== gen || h.phase !== 'running'
    // 同步起跑（照 search-job 的口径）：`run` 交出的 emit 必须在本函数返回前就在位，否则调用方紧接着 emit 的
    // 第一组会丢（被否的写法：`Promise.resolve().then(() => run(...))`）。这是调用方的契约。
    let running: Promise<unknown>
    try {
      running = Promise.resolve(run(emit, shouldStop, h.attempted))
    } catch (e) {
      this.finish(h, gen, 'failed', e instanceof Error ? e.message : String(e))
      return { jobId: h.id }
    }
    void running.then(
      () => { this.finish(h, gen, 'completed') },
      (e: unknown) => { this.finish(h, gen, 'failed', e instanceof Error ? e.message : String(e)) },
    )
    return { jobId: h.id }
  }

  /** 一批的收尾：**只有还握着这一轮的批次才能结算**。代际对不上即陈旧批次，它无权动这一轮。 */
  private finish(h: Held, gen: number, status: JobOutcome['status'], error?: string): void {
    if (h.generation !== gen) return
    this.end(h, status, undefined, error)
  }

  /** 一个源的结果落进本轮：第 1 页原样收下，此后每页**并进同一份累积**；`lastNew` 记本页真正新增的条数。
   *
   *  **绝不原地改交进来的那个组**（换一个新的 `hits` 数组，不往 `prev.hits` 里 push）：`fetchExploreGroup` 命中
   *  快照时交回的正是**缓存持有的那个对象**，原地改等于把第 2..N 页写回快照——TTL 内再进一轮时第 1 页会端出
   *  整段并集而页码还写「第 1 页」，第 2 页变成缓存命中（零新增 ⇒ 被冤判到底）。**一个不是「没有更多」的状态
   *  被读成「没有更多」**，与「零新增即到底」是同一个家族。选择在持有者这侧换数组而不是在 `KindCache` 里拷贝：
   *  拷贝只护得住快照那一份，护不住「谁都可以改 emit 出来的对象」这条更宽的约定。`hits` 是浅拷，够用。
   *
   *  **失败的一页不是到底的一页**：这一批带了错误时，错误落进泳道，累积与 `lastNew` 原样留着、也不占号——
   *  一次偶发故障不该冒充「没有更多书了」，也不该把用户刚看到的那批书划掉。
   *
   *  **终态之后这一批不再拥有这一轮的结论**：协作式取消不撤回在途请求、代际也没变，所以迟到的组**条目照旧并入**
   *  （结果保留是既有语义），但轮次那一层的说法一个字不改：页级失败不写 `pageError`、不盖 `error`，成功的一页
   *  也不清掉已有的那次；**源名同理**（它同属轮次读数）——迟到批次只并条目，改不了这一轮的归属与结论。
   */
  private absorb(h: Held, group: SearchGroup): void {
    const prev = h.accum
    const running = h.phase === 'running'      // 轮次结论只归此刻握着这一轮的那一批写
    if (running) h.sourceName = group.sourceName  // 源名跟着组进来：持有者不查注册表
    if (group.error !== undefined) {
      if (running) {
        prev.pageError = group.error
        h.error = `${group.sourceName}：这一页没回来（${group.error.code}）—— ${group.error.message}`
      }
      return
    }
    if (running && prev.pageError !== undefined) {
      prev.pageError = undefined
      h.error = undefined
    }
    // 成功并入的一刻才占号（终态之后迟到的组不算，它不拥有这一轮的读数）。
    if (running) h.page = h.attempted
    if (prev.hits.length === 0) {
      h.accum = { ...prev, hits: [...group.hits], lastNew: group.hits.length }
      return
    }
    const known = new Set(prev.hits.map(dedupKeyOf))
    const fresh = group.hits.filter((hit) => {
      const key = dedupKeyOf(hit)
      if (known.has(key)) return false
      known.add(key)
      return true
    })
    h.accum = { ...prev, hits: [...prev.hits, ...fresh], lastNew: fresh.length }
  }

  /** 读面快照：**全量**书单 + 一条失败泳道。书单在读时投影而不缓存（`booksOf` 是纯函数，条数上界就是
   *  `MAX_EXPLORE_PAGES` × 每页条数）。null 的两种读法要分清：从未提交过；结束后过了保留期——**绝不返回空
   *  `books`**，那会把「结果已过期」伪装成「这一类没有书」。「到底没有」的对外读数就是 `hasMore` 的累积因子。 */
  snapshot(): ExploreSnapshot | null {
    const h = this.current
    if (h === null) return null
    if (expiredAfter(h, RETAIN_MS, this.now())) return null
    return {
      id: h.id, sourceId: h.sourceId, sourceName: h.sourceName, kind: h.kind,
      phase: h.phase, cancelled: h.cancelled,
      page: h.page,
      // 「现在能不能点」而非「还有没有书」：一批在途时先点不了，服务端让 409 只剩一个意思（现在没得可加载）。
      // 「失败那一页不算到底」由 `absorb` 不动 `lastNew` 保证，这里不必再判一次错误。
      hasMore: h.phase !== 'running' && h.page < MAX_EXPLORE_PAGES && h.accum.lastNew > 0,
      books: booksOf(h.accum.hits),
      startedAt: h.startedAt,
      ...(h.finishedAt === undefined ? {} : { finishedAt: h.finishedAt }),
      ...(h.error === undefined ? {} : { error: h.error }),
    }
  }

  /** 取消当前这轮。返回是否真有个在跑的轮次。**只有宿主可达**（书城没有「停止浏览」钮，wire 未开发现面 cancel 端）。
   *  与 `SearchJobs` 同口径**立即结算终态**而不等运行器收手：读没有半途写脏的顾虑，读方要确定答复；停止不是失败。
   *  结算同时**收回在途那一批的所有权**：运行器还会自己收手，但之后它只是一段没有轮次的在途请求，不挡下一次续页。 */
  cancel(reason?: string): boolean {
    const h = this.current
    if (h === null || h.phase !== 'running') return false
    h.cancelled = true
    const why = reason ?? '用户停止'
    this.end(h, 'killed', `任务已取消：${why}`, `任务已取消：${why}`)
    return true
  }

  private now(): number { return this.deps.now?.() ?? Date.now() }

  /** 终态单点：`settleTerminal` 写终态与宿主结算；`inflight` 归本轮——清它就是收回在途那一批的所有权，之后谁都不能再拿「还在跑」拦续页。 */
  private end(h: Held, status: JobOutcome['status'], detail?: string, error?: string): void {
    if (h.phase !== 'running') return
    h.inflight = false
    settleTerminal(h, h.tie, { status, detail, error }, this.now(), () => this.signal.notify())
  }
}
