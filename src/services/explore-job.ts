import { randomUUID } from 'node:crypto'
import type { ExploreBook, ExploreSnapshot, SearchGroup, SearchHit } from '../shared/wire.js'
import type { JobHost, JobOutcome } from './import-job.js'
import { canonUrl } from './request.js'

/**
 * 分类轮次的持有者：**一轮 = 一个源 + 一个类**，整轮跨页累积的书单由 Node 半持有，
 * 读面给**全量快照**、整帧替换。
 *
 * 为什么另起一个持有者而不扩 `SearchJobs`：那边是**游标增量**（`added`/`next`），读方自己把帧接成
 * 列表；这里的读模型是「零累积、整帧替换」——续页改写的不只是新条目，还有 `page` / `hasMore`
 * 这些**整轮**读数，游标装不下「同一轮的读数变了」。旧版这里的理由是「归并会修订已发出的条目」
 * （第二个源带回同一本书要给那条加 origin），那条理由随跨源浏览轴一起走了（`docs/adr/0028`）。
 *
 * **为什么累积住在这里**：续页要跨页记忆——一个源第 2 页带回的书里有多少是新的（去重），
 * 有多少是本页零新增（= 这个源到底了），两件都需要「上一页收到了什么」，而浏览器半刻意什么都不握
 * （换页不该让这套长出一个累积器）。累积因此只能落在持有者这一侧。
 *
 * 与 `search-job` 同口径的部分照旧：宿主登记（kind `novel-explore`）、终态单点 `end`、
 * 变了就 `notify`、协作式取消；与 `SourceJobs`（导入 / 批量验证）**分槽**——那两个是写，
 * 让浏览分类挡住导入等于惩罚读动作。读面形状见 `ExploreSnapshot`。
 */

/** 运行器契约：门面（`ReadingService`）把「单源跑一页」包进来——持有者不认识门面，也不认识站点。
 *  返回值一律 `unknown`：那一页的东西经 `emit` 收，运行器自己返回什么都不相干。
 *  与 `SearchJobRun` 的差别只在读面（快照 vs 游标），故两边签名同形。 */
export type ExploreJobRun = (
  emit: (group: SearchGroup) => void,
  /** 协作式取消：运行器每取一步查一次；在途请求不撤回 */
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
 *  `lastNew` 归零就是「这个源在这一类上到底了」的判据。
 *  唯一的例外是**这一页抓取失败**——失败的一页不是到底的一页，见 `absorb`。
 *  第 1 页就失败仍算到底：它一条都没累积，这一轮的续页对它无处可续（失败在 `error` 泳道上可见）。 */
interface HeldSource {
  /** 本源本轮累积到的条目（跨页并入，按 `dedupKeyOf` 去重） */
  hits: SearchHit[]
  /** **本页**真正新增的条数：归零就是「这个源到底了」的判据（唯一的例外是下面那条 pageError） */
  lastNew: number
  /** 这一页抓取失败（轮次还在跑时，成功的一页会把它清掉）。结构化那一份（码 + 话）留在这里是有理由的：
   *  读面只出一行人类可读的串（`ExploreSnapshot.error` 的形状就是 `string`），
   *  错误码不该只活在拼出来的中文里；`end()` 的整轮级失败盖掉那一行时，这条记录盖不掉。
   *  它与「这个源到底了」那条判据分开存的意义不变：**「这一页没问到」与「这一类真的没货」是两件事**。 */
  pageError?: { code: string; message: string }
}

/** 服务端持有的整轮结果（内部态；跨半只出 `ExploreSnapshot`，不泄这份累积器） */
interface Held {
  id: string
  /** 提交时点名的那一个源——浏览轴的这一维在提交时就定死了，本轮不再换 */
  sourceId: string
  /** 源名由**第一个在轮次还在跑时**到达的组带回来（执行体交的组里就带着源身份）：持有者不查注册表，
   *  源清单的主人是门面那一层。还没收到任何组时它是空串——那时可读的只有「在跑」或「整轮失败」。
   *  终态之后迟到的组不再报名（它不拥有这一轮的结论，见 `absorb`）。 */
  sourceName: string
  kind: string
  startedAt: number
  /** 本源本轮累积到的东西（单源 ⇒ 不再需要按 sourceId 分组的 Map） */
  held: HeldSource
  /** 已加载到第几页（`start` 起第 1 页，`advance` 每续一次 +1） */
  page: number
  /** 有一批正握着这一轮在跑（由 `launch` 置位、由终态单点清位）。**它不是 `phase` 的替身**：
   *  `cancel` 会立刻把 `phase` 落终态（读方要的是确定答复），而运行器是协作式的、在途请求不撤回，
   *  此后 `phase` 已不再描述「还有没有一批在跑」。续页的守卫只看这个标记。 */
  inflight: boolean
  /** 批次代际（`launch` 每次 +1）。陈旧批次拿它对号入座：新一轮接手后，旧批既不能接着 emit、
   *  也不能在自己的收尾里结算这一轮（后者会表现为「第 2 页还没回来就显示 done」）。 */
  generation: number
  phase: 'running' | 'done' | 'failed'
  /** 这一轮被取消（终态但仍可读）；只有 cancel() 会置位，被新一轮替换不算 */
  cancelled: boolean
  finishedAt?: number
  /** 这一轮的**一条**失败泳道：整轮级失败（运行器抛错、被取消）由 `end` 写，
   *  「这一页没问到」由 `absorb` 写、下一批成功的一页把它清掉——两个写主都只在轮次还在跑时成立，
   *  终态之后 `absorb` 不再碰这条泳道（边界为什么在那里，写在 `absorb` 的口径里）。
   *  执行体从不抛错，抓取失败是以带 `error` 的组交回来的——少了后半条，「这一类没问到」就会与
   *  「这一类真的没货」折成同一帧。 */
  error?: string
  settle: (outcome: JobOutcome) => void
}

/** 命中在本源内的去重键：有地址按地址的规范形（`,{option}` 选项后缀与主机的书写差异都不算新书），
 *  没地址退到「书名 + NUL + 作者」（可见字符拼键会把两本不同的书撞成一本）。
 *  取不到地址的条目照样能去重，否则同一本书每页都会被当成新的，「零新增即到底」永远不成立。 */
function dedupKeyOf(hit: SearchHit): string {
  return hit.url === null || hit.url === '' ? `${hit.title}\u0000${hit.author ?? ''}` : canonUrl(hit.url)
}

/** 组里的命中 → 快照里的书。**不做任何合并**：一条命中就是一本书，顺序就是站点给的顺序。
 *  旧版这里过一层跨源归并（把「同一本在几个源上」折进一条），那条轴已随 `docs/adr/0028` 撤掉。
 *  放在本文件而不是 wire：它是快照的形状（读面的一次投影），不是引擎语义。
 *  可空字段照 `SearchHit` 原样落 `null`，**不折成缺键**（wire 文件头的可空口径：null 是在场的值）；
 *  唯一的收口是空串封面——站点给 `coverUrl: ''` 说的是「没封面」，让它穿过去会让 `<img src="">`
 *  替用户演一次加载失败。 */
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

  /** 提交一轮分类浏览：**一个源、一个类、从第 1 页起**。**只留最近一轮**：新提交即替换上一轮——
   *  上一轮若在跑则被协作式收手，读面立刻指向新一轮（两真相同时在场是更坏的选择）。
   *  换源与换类都走这一条：新一轮是**另一个对象**，旧批此后写的东西读面再也看不到。 */
  start(sourceId: string, kind: string, run: ExploreJobRun): { jobId: string } {
    const prev = this.current
    if (prev !== null && prev.phase === 'running') {
      this.end(prev, 'killed', '已被新一次分类浏览替换', '任务已被新一次分类浏览替换')
    }
    const held: Held = {
      id: (this.deps.uuid ?? randomUUID)(), sourceId, sourceName: '', kind,
      startedAt: this.now(), held: { hits: [], lastNew: 0 }, page: 1,
      inflight: false, generation: 0, phase: 'running', cancelled: false,
      settle: () => {},
    }
    this.current = held
    return this.launch(held, run)
  }

  /** 续第 `page + 1` 页：**同一轮、同一 id**，本轮已收到的累积原样留着，新一页并进去。
   *  换 id 就等于让浏览器半的「零累积、整帧替换」读模型清空重来——续页是这一轮里的事，不是新的一轮。
   *
   *  三种「续不动」如实抛错（不猜、不做无效起跑）：没有轮次；在途那一批还没收手；分类对不上。
   *  在途那一种尤其不能放行——两个批次同时往同一个源的累积里写得不到可读读数，而旧批次的收尾
   *  会把刚点亮的新批次一并结算（表现为「第 2 页还没回来就显示 done」）。
   *
   *  守卫看**在途标记**而不是 `phase`：`cancel` 会让 `phase` 先行落终态，若拿它当判据，
   *  取消之后再点一次就会被误放行（正是上面那个 bug 的入口）。取消是**收回了在途那一批的
   *  所有权**（清掉标记），因此取消后还能再点一次续页；被收回的那批由代际点穴，碰不到新一轮。 */
  advance(kind: string, run: ExploreJobRun): { jobId: string } {
    const h = this.current
    if (h === null) throw new Error('没有可续页的分类轮次')
    if (h.kind !== kind) throw new Error(`轮次分类不符：当前「${h.kind}」，请求「${kind}」`)
    if (h.inflight) throw new Error(`分类轮次「${kind}」这一批还在抓，不能同时续页`)
    h.page += 1
    h.phase = 'running'
    // 续页把这轮重新点亮：上一批留下的「已停止 / 失败」不再描述它（否则新批在跑而界面说停过）
    h.cancelled = false
    h.finishedAt = undefined
    h.error = undefined
    return this.launch(h, run)
  }

  /** 起跑一段（`start` 的第 1 批与 `advance` 的每一批共用这一处）：宿主登记 + 变了就 `notify`
   *  + 同步起跑 + 终态单点收口。两处各抄一遍就会长出两种收尾口径。
   *
   *  一批起跑即领一代（`generation`）：交给运行器的 `emit` / `shouldStop` 与这批的收尾都认这一代。
   *  代际被新一批盖过之后，旧批的三件事同时失效——不再吐组（`emit` 弃）、不再接着跑（`shouldStop`
   *  为真）、收尾不结算（`finish` 弃）。少了任何一件，旧批都能伸手改一轮它已经不再拥有的轮次。 */
  private launch(h: Held, run: ExploreJobRun): { jobId: string } {
    const gen = ++h.generation
    h.inflight = true
    const host = this.deps.host
    if (host !== undefined) {
      const done = new Promise<JobOutcome>((res) => {
        h.settle = (o): void => { res(o) }
      })
      // 宿主契约：start() 内同步调 run() 取 hooks，故 done 必须先建好
      host.start({
        kind: 'novel-explore',
        // 页码段的 label **不报源数**：一轮就是一个源，那个数恒为 1，报它不携带任何信息
        // （旧版这里报「本轮问了几家」，那是跨源编排才有的读数）。
        label: `书城分类「${h.kind}」第 ${h.page} 页`,
        run: () => ({ cancel: (reason): void => { this.cancel(reason) }, done }),
      })
    }
    this.notify()                                      // 开场 / 续页起跑：观察者据此把读面当成在跑
    const emit = (group: SearchGroup): void => {
      if (h.generation !== gen) return                 // 陈旧批次迟到的组：这一轮已不归它
      this.absorb(h, group)
      this.notify()
    }
    const shouldStop = (): boolean => h.generation !== gen || h.phase !== 'running'
    // 同步起跑（照 search-job 的口径）：`run` 交出的 emit 必须在本函数返回前就在位，
    // 否则调用方紧接着 emit 的第一组会丢（被否的写法：`Promise.resolve().then(() => run(...))`）。
    // 本模块的运行器虽要先等网络，这条属性照样要立——它是调用方的契约，不是运行器的习惯。
    let running: Promise<unknown>
    try {
      running = Promise.resolve(run(emit, shouldStop))
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

  /** 一个源的结果落进本轮：第 1 页那一组原样收下（没有更早的记忆可比、也没有「新增」可言），
   *  此后每一页**并进同一份累积**（新一页的书紧挨着上一页的）。`lastNew` 记的是**本页真正新增**
   *  的条数（去重之后），它就是「这个源到底了没有」的判据。
   *
   *  **本持有者绝不原地改交进来的那个组**（累积走「换一个新的 `hits` 数组」而不是往 `prev.hits` 里
   *  push）：交进来的组不归这里所有——`fetchExploreGroup` 命中快照时交回的正是**缓存持有的那个对象**。
   *  原地改它等于把第 2..N 页的累积写回快照：同一个 (源, 类) 在 TTL 内再进一轮时，第 1 页会端出整段
   *  并集而页码还写「第 1 页」，且第 2 页变成缓存命中、内容已在并集里 ⇒ 零新增 ⇒ 被冤判到底，
   *  其后各页静默不可达。这与「零新增即到底」是同一个家族：**一个不是「没有更多」的状态被读成
   *  「没有更多」**。（选择在持有者这一侧换数组、而不是在 `KindCache` 里进出各拷一份：缓存拷贝只能
   *  护住快照那一份，护不住「谁都可以改 emit 出来的对象」这条更宽的约定，且拷贝要沿着每一处
   *  传递复用才成立。`hits` 是浅拷，够用——本轮只增删列表，不改条目自身。）
   *
   *  **失败的一页不是到底的一页**：这一批带了错误时，错误如实落进泳道，累积与 `lastNew` 原样留着、
   *  这个源不算到底——一次偶发故障不该冒充「这一类没有更多书了」，也不该把用户刚看到的那批书划掉；
   *  下一次续页照旧会打它（重试的机会留给用户）。
   *
   *  **终态之后这一批不再拥有这一轮的结论**：轮次落定（被取消 / 已结束）后，同一批迟到的组仍会走到这里
   *  ——协作式取消不撤回在途请求、代际也没变，所以**条目照旧并入**（结果保留是既有语义）。
   *  但**轮次那一层的说法一个字都不改**：页级失败既不写 `pageError` 也不盖 `error`，成功的一页也不把已有的那次
   *  清掉（还在跑时才清，且只清**页泳道**——有 `pageError` 才动那一行）；**源名同理**——它是这一轮对
   *  「这是哪个源」的说法，与错误泳道同属轮次读数，所以也在闸内：迟到的批次只并条目，改不了这一轮的归属
   *  （把它放在闸外，就是「不拥有结论」与「想怎么写源名就怎么写」同时成立）。
   *  终态那条 `error` 说的是「这一轮为什么结束」，而迟到那一页的成败是**页**的事实，不许回头改写**轮**的
   *  结论——否则「任务已取消：用户停止」会被一句「这一页没回来」盖掉，也会被一句迟到的成功抹平成没错误。
   *  旧形状里页泳道与整轮泳道是两条、各认各的写主，天然撞不上；合并成一条之后，这条边界必须显式立。 */
  private absorb(h: Held, group: SearchGroup): void {
    const prev = h.held
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
    if (prev.hits.length === 0) {
      h.held = { ...prev, hits: [...group.hits], lastNew: group.hits.length }
      return
    }
    const known = new Set(prev.hits.map(dedupKeyOf))
    const fresh = group.hits.filter((hit) => {
      const key = dedupKeyOf(hit)
      if (known.has(key)) return false
      known.add(key)
      return true
    })
    h.held = { ...prev, hits: [...prev.hits, ...fresh], lastNew: fresh.length }
  }

  /** 读面快照：**全量**书单（这一轮跨页累积的那一份）+ 一条失败泳道。
   *  书单在读时投影而不缓存：`booksOf` 是纯函数、条目 < 200，缓存只会多出一份要跟着失效的状态。
   *  两种读作「无任务」（null）的情况要分清：从未提交过；以及**结束后过了保留期**——
   *  后者绝不返回一个空 `books`，那会把「结果已过期」伪装成「这一类没有书」。
   *  「这个源到底了没有」的对外读数就是这里 `hasMore` 的那个累积因子（本页零新增 ⇒ 点不动）：
   *  它没有第二个消费者，故不再另开一个查询方法——同一条判据开两个出口，迟早一边说到底、一边说没到底。 */
  snapshot(): ExploreSnapshot | null {
    const h = this.current
    if (h === null) return null
    if (h.phase !== 'running' && h.finishedAt !== undefined
      && this.now() - h.finishedAt > RETAIN_MS) return null
    return {
      id: h.id, sourceId: h.sourceId, sourceName: h.sourceName, kind: h.kind,
      phase: h.phase, cancelled: h.cancelled,
      page: h.page,
      // 「现在能不能点」而非「还有没有书」：一批在途时先点不了——客户端用自己的 running 显加载态，
      // 服务端据此让 409 只剩一个意思（现在没得可加载），不必为「正在跑」再造一种错。
      // 「失败那一页不算到底」由 `absorb` 不动 `lastNew` 来保证，这里不必再判一次错误。
      hasMore: h.phase !== 'running' && h.page < MAX_EXPLORE_PAGES && h.held.lastNew > 0,
      books: booksOf(h.held.hits),
      startedAt: h.startedAt,
      ...(h.finishedAt === undefined ? {} : { finishedAt: h.finishedAt }),
      ...(h.error === undefined ? {} : { error: h.error }),
    }
  }

  /** 取消当前这轮。返回：是否真有个在跑的轮次。
   *  **今天只有宿主可达**：书城这一侧没有「停止浏览」那颗钮，`shared/wire.ts` 因此没给发现面开
   *  cancel 端（搜索面那颗有，走 `searchJobCancel`）。
   *  与 `SearchJobs` 同口径**立即结算终态**而不等运行器收手：这是读，没有半途写脏的顾虑，
   *  读方要的是「这一轮到此为止」的确定答复。停止不是失败——`cancelled` 让浏览器半不报红条。
   *  结算同时**收回在途那一批的所有权**（见 `end`）：运行器还会自己收手，但那之后它只是一段
   *  没有轮次的在途请求；用户再点续页照样起新批，不会被这段残影挡住。 */
  cancel(reason?: string): boolean {
    const h = this.current
    if (h === null || h.phase !== 'running') return false
    h.cancelled = true
    const why = reason ?? '用户停止'
    this.end(h, 'killed', `任务已取消：${why}`, `任务已取消：${why}`)
    return true
  }

  private now(): number { return this.deps.now?.() ?? Date.now() }

  /** 终态单点：phase / finishedAt / error、在途标记与宿主结算同处写，缺一处就是
   *  「界面说结束了而宿主还挂着 running」。清在途标记即**收回在途那一批的所有权**：
   *  取消或收手之后，谁都不能再拿「还在跑」当借口拦下一次续页（那一批已由代际点穴）。 */
  private end(h: Held, status: JobOutcome['status'], detail?: string, error?: string): void {
    if (h.phase !== 'running') return
    h.inflight = false
    h.phase = status === 'completed' ? 'done' : 'failed'
    if (error !== undefined) h.error = error
    h.finishedAt = this.now()
    h.settle({ status, ...(detail === undefined || detail === '' ? {} : { detail }) })
    this.notify()                                      // 终态也要发：SSE 据此收尾并关流
  }
}
