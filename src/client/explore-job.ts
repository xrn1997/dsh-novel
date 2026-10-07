import { useEffect, useRef, useState } from 'react'
import { ROUTES } from '../shared/wire.js'
import type { ExploreBook, ExploreSnapshot } from '../shared/wire.js'
import { ApiClientError } from './api.js'
import type { ClientCoreDeps } from './deps.js'

/**
 * 浏览器半的「分类浏览轮次」接线：**一轮 = 一个源的一个分类**（`docs/adr/0028` 的浏览轴）——
 * 提交一轮 → 盯住它（SSE 优先、快照轮询兜底）→ **整体替换**视图态。
 *
 * 与 `search-job.ts` 的关键差别：那边的读面是**游标增量**（`added`/`next`，客户端累积），
 * 这边的读面是**全量快照**——因为续页改写的不只是条目清单，还有 `page` 与 `hasMore` 这些**整轮**
 * 读数，游标装不下「同一轮的读数变了」（旧版这里的理由是跨源归并会**修订已经发出去的条目**，
 * 那条理由随跨源浏览轴一起走了）。增量模型表达不了这种改写，所以这里不做累积器，
 * 每读到一帧就整体替换。代价（列表规模小到可忽略）换来一个不会说谎的读面。
 *
 * **身份闸在这里是「无条件整帧换掉」，不是一段比对**：`search-job.ts` 必须验 `job.id`，因为它的
 * 累积器握着一份只对自己有效的游标；本模块没有任何可留的东西——轮到谁就以谁的整帧为准，服务端
 * 换了轮（别的观察者提交）时新帧自然全覆盖，正是要的「跟随最近一轮」。所以这里不留轮次身份的
 * 副本：那份副本无人读，只会随代码漂成一句谎。
 *
 * 轮询是地基、SSE 是加速器（官方口径：通知不 replay，可靠恢复必须有显式 query），
 * 任一时刻只有一条通道在推进（两条同时在飞会把「谁是最新」搞乱）。撤通道必须**连在途那一发的
 * 所有权一起撤**：`clearTimeout` 只拦还没起飞的、abort 只断流不断回包，两者都撤不回已经飞出去的
 * 那次读——那份迟到帧要靠 `stopChannels` 的代际认出自己该被丢掉，否则它会拿旧轮整帧盖掉刚落地
 * 的新轮（与下面 `submitted` 那枚闸挡的是同一件事，区别只在它管得到恢复读、管不到在途的轮询）。
 *
 * **续页不是新轮**：`loadMore` 只把同一轮往前推一页（服务端换页不换 id），所以上面那套「零累积、
 * 整帧替换」一行都不用改——新一页的书随下一帧进来，客户端不持有任何要跟着翻页对齐的东西。
 */

/** 轮询节奏：与搜索面同档（600ms 足够「边抓边出」的观感，又不把 /novel-api 打成刷屏） */
const POLL_MS = 600

/** 本轮视图态（服务端快照的投影；`running` 就是 UI 的「还在跑吗」判据）。
 *  旧版带着 `total`/`done`/`failures`——那是「一轮打多个源」的读数：单源下 `total` 恒为 1（一个常数）、
 *  `done` 与 `phase` 说的是同一件事、`failures` 退化成一条 `error` 泳道，三者一并收掉。
 *  源身份这两条是「这一轮逛的是谁」的唯一说法，界面上每一处点名都读它。 */
export interface ExploreRound {
  id: string
  sourceId: string
  /** 该源此刻的名字（服务端那一帧带来的；提交后那帧空态还没有它，见 `submit`） */
  sourceName: string
  kind: string
  books: ExploreBook[]
  running: boolean
  /** 本轮被停止（宿主侧取消——书城这一侧没有停止那颗钮，`submit`/`loadMore` 都不产这条位）：
   *  结果保留、只是不再往下抓。
   *  UI 据此说「已停止」而不是「跑完了」——两者都是 `running=false`，只看 running 分不开。 */
  cancelled: boolean
  /** 已加载到第几页：服务端说是第几页就是第几页，客户端**不自己加一**（自己加=
   *  把还没发生的续页提前念成事实）。 */
  page: number
  /** 此刻能不能再点一次「加载更多」——服务端原样带过来。**有批在途时为 false**，
   *  所以它管的是**显隐**；「正在加载」那个禁用态由 `running` 管（见 `ExploreJobView.loadMore`）。 */
  hasMore: boolean
}

export interface ExploreJobView {
  round: ExploreRound | null
  /** 唯一那条错误泳道：读面/写面自己的失败（`分类结果读取失败：` / `分类提交失败：` / `续页失败：`）
   *  与快照那句「这一页没回来」（`ExploreSnapshot` 的 `error`）都落在这里。单源没有「某几个源没响应」
   *  那种清单要分列，两件事靠各自的文案分辨、谁也不冒充谁——**尤其不许把抓取失败咽成静默的空书单**。 */
  error: string | null
  /** 挂载恢复的读面是否已定（读到轮次、读到「没有轮次」、读失败，三者都算定）。
   *  它定下来之前 `round` 恒为 `null`——那是「还没问过服务端」，不是「服务端说没有」。
   *  调用方要判「这一轮在不在」必须等这个闸：抢在它之前提交，就会把服务端正持有的那一轮杀掉。 */
  restored: boolean
  /** 提交一轮分类浏览：**两个点名都在 body 里**（源与类，见 `docs/adr/0028`）——切源、切类都是再调
   *  一次；服务端按这两个点名走内存快照，重复提交很便宜。 */
  submit: (sourceId: string, kind: string) => void
  /** 把**当前这一轮**再往前推一页（同一轮 id，客户端不做累积——整帧替换的读模型照旧成立）。
   *  典型路径是尾行那颗「加载更多」。
   *
   *  **409 不是故障**：它只有「此刻没得可加载」一个意思（服务端把在途那一段用 `hasMore=false`
   *  排除了出去），照实把按钮收掉即可，不许挂红条——把「已经到底了」念成一次失败，用户会去
   *  「重试」一个本来就不存在的东西。其余失败才有红条。 */
  loadMore: () => void
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** 快照 → 视图态的**唯一投影**，导出它：测试要钉的就是这份映射本身。让它留在模块内，测试就只能
 *  自己复制一份映射——那份复制迟早跟实现分叉，而且分叉的方向永远是「拿着旧形状继续跑」。 */
export const toRound = (job: ExploreSnapshot): ExploreRound => ({
  id: job.id, sourceId: job.sourceId, sourceName: job.sourceName, kind: job.kind,
  books: job.books, running: job.phase === 'running',
  cancelled: job.cancelled === true, page: job.page, hasMore: job.hasMore,
})

export function useExploreJob(deps: ClientCoreDeps): ExploreJobView {
  const alive = useRef(true)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const stream = useRef<AbortController | null>(null)
  /** 「本页已经提交过」闸：POST 的回包说了算（它是新一轮的出生证明）。挂载恢复读到的是**上一轮**
   *  的快照，它要是后到，就会把新轮刚落下的空帧盖成旧轮的书单——`search-job.ts` 的对应闸是
   *  「累积器已被新一轮替换」（那边握着一份游标，有身份可比），这里没有任何可留的东西，故只用一枚
   *  布尔：提交落地即关闸，恢复读此后一律让位。 */
  const submitted = useRef(false)
  /** 通道代际：每撤一次通道加一。在途那一发撤不回，所以迟到帧靠它认出自己已经没有所有权
   *  （判据是「通道还在不在」，不是「轮次是谁」——本模块不留轮次身份的副本）。 */
  const gen = useRef(0)
  const [round, setRound] = useState<ExploreRound | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [restored, setRestored] = useState(false)

  const stopChannels = (): void => {
    gen.current += 1
    if (timer.current !== null) { clearTimeout(timer.current); timer.current = null }
    stream.current?.abort(); stream.current = null
  }

  const armPoll = (): void => {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = setTimeout(() => { void poll() }, POLL_MS)
  }

  /** 一帧落地：整体替换 + 判「还要不要继续看」。服务端连一轮都没有 = 没有可显示的结果，如实说 */
  const apply = (job: ExploreSnapshot | null): boolean => {
    if (job === null) {
      stopChannels()
      setError('分类浏览已不可读（服务重启或结果已过保留期）')
      setRound(null)
      return false
    }
    // 停止不是失败：取消后不挂红条（也不把服务端那句「任务已取消」当错误念给用户）
    setError(job.phase === 'running' || job.cancelled === true ? null : job.error ?? null)
    setRound(toRound(job))
    return job.phase === 'running'
  }

  const poll = async (): Promise<void> => {
    const g = gen.current
    if (!alive.current) return
    let job: ExploreSnapshot | null
    try {
      // 读面缺 `job` 键与「`job` 为 null」是同一件事（没有一轮）——边界输入不该把渲染打崩
      job = (await deps.apiGet<{ job: ExploreSnapshot | null }>(ROUTES.exploreListStatus.path)).job ?? null
    } catch (e) {
      // 代际已换 = 这一发属于一条已被撤掉的通道：连那句「读取失败」都不许报，
      // 否则旧通道的断线会把新轮的一帧好结果刷成红条
      if (!alive.current || gen.current !== g) return
      setError(`分类结果读取失败：${errText(e)}`)
      setRound((r) => (r === null ? null : { ...r, running: false }))
      return
    }
    if (!alive.current || gen.current !== g) return
    if (apply(job) && alive.current) armPoll()
  }

  /** 盯住这一轮：先开 SSE；断开 / 连不上 / 提前结束而本轮未终态 → 回落轮询。
   *  进门先 `stopChannels` 接管通道：旧流与它可能已经排好的下一发轮询一起撤——只 abort 流不清 timer，
   *  续页与新提交就会留下一条 SSE 加一条轮询并行推进（口径见文件头「任一时刻只有一条通道」）。 */
  const watch = (): void => {
    stopChannels()
    const g = gen.current
    const ctrl = new AbortController()
    stream.current = ctrl
    void (async (): Promise<void> => {
      let running = true
      try {
        await deps.apiEventStream(ROUTES.exploreListStream.path, (data): void => {
          if (!alive.current || gen.current !== g) return
          let job: ExploreSnapshot | null
          try {
            job = (JSON.parse(data) as { job: ExploreSnapshot | null }).job
          } catch { return }                       // 坏帧不致命：下一帧或轮询兜底
          running = apply(job)
          if (!running) ctrl.abort()               // 终态：自己关流，不留着占连接
        }, ctrl.signal)
      } catch { /* 连不上或断线：一律回落轮询，不单独报错（只有轮询失败才真的报错） */ }
      if (!alive.current || gen.current !== g) return   // 这条流已被更新的通道顶掉：残影不许再排一轮轮询
      if (running) armPoll()
    })()
  }

  const submit = (sourceId: string, kind: string): void => {
    const s = sourceId.trim()
    const k = kind.trim()
    if (s === '' || k === '') return
    void (async () => {
      try {
        const { jobId } = await deps.apiSend<{ jobId: string }>('POST', ROUTES.exploreList.path, { sourceId: s, kind: k })
        if (!alive.current) return
        submitted.current = true             // 新轮出生：此后的挂载恢复（读的是上一轮）一律让位
        // 提交返回的 id 就是本轮身份：先落一帧空态再开始盯（避免旧轮的条目在新轮里停留）。
        // 撤通道归 `watch` 的接管那一步（这一段没有 await，旧通道的迟到帧插不进来）。
        // 源名这一帧留空是诚实的：它住在服务端那一帧里（本模块不握源名册，自己编一个名字就是造
        // 事实），下一帧整帧换掉时它自然带上——客户端什么都不累积，这里也不累积一个名字。
        setError(null)
        setRound({ id: jobId, sourceId: s, sourceName: '', kind: k, page: 1, hasMore: false, books: [], running: true, cancelled: false })
        watch()
      } catch (e) {
        if (!alive.current) return
        setError(`分类提交失败：${errText(e)}`)   // 服务端没起新轮：上一轮结果照旧可读，不清屏
      }
    })()
  }

  /**
   * 把这一轮往前推一页。**这是本模块唯一的乐观态**，且只动 `running`：按下即进「加载中」——
   * 若不本地按下去，按钮在这一段仍亮着，连点就会发出两次同样的续页（第二次撞服务端的 409，
   * 那一次噪声是我们自己造的）。页码与 `hasMore` 都不本地推：那是服务端的事实，推出来就是把
   * 还没发生的事写给用户看（本地这一帧随下一帧整体换掉，正是本模块的读模型）。
   *
   * 能按下就说明服务端**那一刻手里没有在途的批**（`hasMore` 为真蕴含它），所以失败时把本地按下去的
   * `running` 还回来是诚实的：那种情况下服务端也没起任何东西。
   */
  const loadMore = (): void => {
    setRound((r) => (r === null ? null : { ...r, running: true }))
    void (async () => {
      try {
        await deps.apiSend<{ jobId: string }>('POST', ROUTES.exploreListMore.path)
        if (!alive.current) return
        setError(null)
        watch()
      } catch (e) {
        if (!alive.current) return
        if (e instanceof ApiClientError && e.status === 409) {
          // 409 = 「此刻没得可加载」：钮照实收掉，不报红——这一条不是故障，是「到头了」
          setRound((r) => (r === null ? null : { ...r, running: false, hasMore: false }))
          return
        }
        setError(`续页失败：${errText(e)}`)   // 真失败：红条照说，钮还回来（重试是用户的事）
        setRound((r) => (r === null ? null : { ...r, running: false }))
      }
    })()
  }

  useEffect(() => {
    alive.current = true
    // 挂载即恢复：本轮结果住在服务端，切 tab 再回来不该重打一遍
    void (async () => {
      let job: ExploreSnapshot | null
      try {
        job = (await deps.apiGet<{ job: ExploreSnapshot | null }>(ROUTES.exploreListStatus.path)).job ?? null
      } catch {
        // 首屏读不到就是没有：静默（真去看时会再报错）。但闸要落下——不落，调用方会一直等着
        // 「那一轮在不在」的答案，点了没反应比读到空更糟
        if (alive.current) setRestored(true)
        return
      }
      if (!alive.current) return
      if (job !== null && !submitted.current && apply(job)) watch()   // 提交先回来 → 不覆盖新一轮
      setRestored(true)
    })()
    return () => {
      alive.current = false                       // 只停「看」，服务端那轮继续跑
      stopChannels()
    }
  }, [])                                          // eslint-disable-line react-hooks/exhaustive-deps

  return { round, error, restored, submit, loadMore }
}
