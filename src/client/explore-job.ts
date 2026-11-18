import { useCallback, useEffect, useRef, useState } from 'react'
import { bodies, ROUTES } from '../shared/wire.js'
import type { ExploreBook, ExploreSnapshot } from '../shared/wire.js'
import { ApiClientError, describeError } from './api.js'
import { zhTranslate } from './copy/index.js'
import type { Translate } from './copy/index.js'
import { createJobChannel } from './job-channel.js'
import { JOB_POLL_MS } from './util.js'
import type { JobWatchDeps } from './deps.js'

/**
 * 浏览器半的「分类浏览轮次」接线：**一轮 = 一个源的一个分类**（`ADR-0028` 的浏览轴）——
 * 提交一轮 → 盯住它 → **整体替换**视图态。
 *
 * 与 `search-job.ts` 的关键差别：那边的读面是**游标增量**（`added`/`next`，客户端累积），
 * 这边的读面是**全量快照**——续页改写的不只是条目清单，还有 `page` 与 `hasMore` 这些**整轮**读数，
 * 游标装不下「同一轮的读数变了」；增量模型表达不了这种改写，所以这里不做累积器，
 * 每读到一帧就整体替换。代价（列表规模小到可忽略）换来一个不会说谎的读面。
 *
 * **身份闸在这里是「无条件整帧换掉」，不是一段比对**：`search-job.ts` 必须验 `job.id`，因为它的
 * 累积器握着一份只对自己有效的游标；本模块没有任何可留的东西——轮到谁就以谁的整帧为准，服务端
 * 换了轮（别的观察者提交）时新帧自然全覆盖，正是要的「跟随最近一轮」。所以这里不留轮次身份的
 * 副本：那份副本无人读，只会随代码漂成一句谎。落到通道接口上就是恒真的身份判据（`sameRound`）。
 *
 * 通道仪式（timer、SSE 优先 + 快照轮询兜底、任一时刻只一条通道、撤通道连 timer 带代际）住
 * `client/job-channel.ts`；本模块只交三件策略：整帧替换的 `apply`、恒真的身份判据、读失败后的
 * 收手（读不到还转圈只会刷屏）。
 *
 * **续页不是新轮**：`loadMore` 只把同一轮再打一页（服务端不换轮、不换 id），所以上面那套「零累积、
 * 整帧替换」一行都不用改——新一页的书随下一帧进来，客户端不持有任何要跟着翻页对齐的东西。
 */

/** 本轮视图态（服务端快照的投影；`running` 就是 UI 的「还在跑吗」判据）。
 *  本模块不带 `total`/`done`/`failures`——那是「一轮打多个源」的读数：单源下 `total` 恒为 1（一个常数）、
 *  `done` 与 `phase` 说的是同一件事、`failures` 退化成一条 `error` 泳道，三者都不进视图态。
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
  /** 唯一那条错误泳道：读面/写面自己的失败（`city.job.readFailed` / `city.job.submitFailed` / `city.job.moreFailed`）
   *  与快照那句「这一页没回来」（`ExploreSnapshot` 的 `error`）都落在这里。单源没有「某几个源没响应」
   *  那种清单要分列，两件事靠各自的文案分辨、谁也不冒充谁——**尤其不许把抓取失败咽成静默的空书单**。 */
  error: string | null
  /** 挂载恢复的读面是否已定（读到轮次、读到「没有轮次」、读失败，三者都算定）。
   *  它定下来之前 `round` 恒为 `null`——那是「还没问过服务端」，不是「服务端说没有」。
   *  调用方要判「这一轮在不在」必须等这个闸：抢在它之前提交，就会把服务端正持有的那一轮杀掉。 */
  restored: boolean
  /** 提交一轮分类浏览：**两个点名都在 body 里**（源与类，见 `ADR-0028`）——切源、切类都是再调
   *  一次；服务端按这两个点名走内存快照，重复提交很便宜。 */
  submit: (sourceId: string, kind: string) => void
  /** 把**当前这一轮**再打一页（同一轮 id，客户端不做累积——整帧替换的读模型照旧成立）。
   *  典型路径是尾行那颗「加载更多」。
   *
   *  **409 不是故障**：它只有「此刻没得可加载」一个意思（服务端把在途那一段用 `hasMore=false`
   *  排除了出去），照实把按钮收掉即可，不许挂红条——把「已经到底了」念成一次失败，用户会去
   *  「重试」一个本来就不存在的东西。其余失败才有红条。 */
  loadMore: () => void
}

/** 快照 → 视图态的**唯一投影**，导出它：测试要钉的就是这份映射本身。让它留在模块内，测试就只能
 *  自己复制一份映射——那份复制迟早跟实现分叉，而且分叉的方向永远是「拿着过期形状继续跑」。 */
export const toRound = (job: ExploreSnapshot): ExploreRound => ({
  id: job.id, sourceId: job.sourceId, sourceName: job.sourceName, kind: job.kind,
  books: job.books, running: job.phase === 'running',
  cancelled: job.cancelled, page: job.page, hasMore: job.hasMore,
})

export function useExploreJob(deps: JobWatchDeps, t: Translate = zhTranslate): ExploreJobView {
  const alive = useRef(true)
  /** 通道是否还活着：**每次现读**。卸载时翻面的那次写入落在 await 之后——编译器看不见闭包里的写入，
   *  同一个流程里的第二次读会被当成常量收窄；这道守卫是运行时防线，读法必须留在调用边界上。
   *  通道内部的在途读由通道代际作废，这里只守本模块自己的异步段（提交 / 续页 / 挂载恢复）。 */
  const aliveNow = (): boolean => alive.current
  /** 「本页已经提交过」闸：POST 的回包说了算（它是新一轮的出生证明）。挂载恢复读到的是**上一轮**
   *  的快照，它要是后到，就会把新轮刚落下的空帧盖成旧轮的书单——`search-job.ts` 的对应闸是
   *  「累积器已被新一轮替换」（那边握着一份游标，有身份可比），这里没有任何可留的东西，故只用一枚
   *  布尔：提交落地即关闸，恢复读此后一律让位。 */
  const submitted = useRef(false)
  const [round, setRound] = useState<ExploreRound | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [restored, setRestored] = useState(false)

  /** 一帧落地：整体替换 + 判「还要不要继续看」。服务端连一轮都没有 = 没有可显示的结果，如实说 */
  const apply = (job: ExploreSnapshot | null): boolean => {
    if (job === null) {
      setError(t('city.job.unavailable'))
      setRound(null)
      return false
    }
    // 停止不是失败：取消后不挂红条（也不把服务端那句「任务已取消」当错误念给用户）
    setError(job.phase === 'running' || job.cancelled ? null : job.error ?? null)
    setRound(toRound(job))
    return job.phase === 'running'
  }

  /** 状态读面：通道的地基读与挂载恢复是同一发请求，URL 与空值口径只此一处。 */
  const readStatus = async (): Promise<ExploreSnapshot | null> =>
    (await deps.apiGet<{ job: ExploreSnapshot | null }>(ROUTES.exploreListStatus.path)).job ?? null

  /** 通道：timer / SSE 回落 / 撤通道 / 代际归 `job-channel.ts`；本模块只交三件策略——全量快照读面
   *  （无游标）、整帧替换的 `apply`、恒真的身份判据（没有可丢的东西，见文件头）与读失败收手。
   *  spec 锚定首次渲染的闭包（与挂载恢复同口径）：运行中的一轮不随重渲染换代。锚的是机械身份
   *  不是语言——`t` 每次调用现读当前 locale，切语言后新生成的文案跟新语言；存量串冻在生成时语言
   *  （政策见 `copy/index.tsx`）。 */
  const [channel] = useState(() => createJobChannel<ExploreSnapshot, null>(
    {
      read: async () => readStatus(),
      subscribe: (_round, onFrame, signal) => deps.apiEventStream(ROUTES.exploreListStream.path, onFrame, signal),
      apply: (_round, job) => apply(job),
      sameRound: () => true,
      onReadError: (_round, e) => {
        setError(t('city.job.readFailed', { detail: describeError(e, t) }))
        setRound((r) => (r === null ? null : { ...r, running: false }))
        return false
      },
    },
    deps.jobPollMs ?? JOB_POLL_MS,
  ))

  /** 盯住这一轮：通道接管（旧流与它可能已经排好的下一发轮询一起撤），本轮从推送重开。 */
  const watch = useCallback((): void => { channel.start(null) }, [channel])

  const submit = useCallback((sourceId: string, kind: string): void => {
    const s = sourceId.trim()
    const k = kind.trim()
    if (s === '' || k === '') return
    void (async () => {
      try {
        const { jobId } = await deps.apiSend<{ jobId: string }>(ROUTES.exploreList, bodies.exploreList(s, k))
        if (!aliveNow()) return
        submitted.current = true             // 新轮出生：此后的挂载恢复（读的是上一轮）一律让位
        // 提交返回的 id 就是本轮身份：先落一帧空态再开始盯（避免旧轮的条目在新轮里停留）。
        // 撤通道归 `watch` 的接管那一步（这一段没有 await，旧通道的迟到帧插不进来）。
        // 源名这一帧留空是诚实的：它住在服务端那一帧里（本模块不握源名册，自己编一个名字就是造
        // 事实），下一帧整帧换掉时它自然带上——客户端什么都不累积，这里也不累积一个名字。
        setError(null)
        setRound({ id: jobId, sourceId: s, sourceName: '', kind: k, page: 1, hasMore: false, books: [], running: true, cancelled: false })
        watch()
      } catch (e) {
        if (!aliveNow()) return
        setError(t('city.job.submitFailed', { detail: describeError(e, t) }))   // 服务端没起新轮：上一轮结果照旧可读，不清屏
      }
    })()
  }, [deps, t, watch])

  /**
   * 把这一轮再打一页。**这是本模块唯一的乐观态**，且只动 `running`：按下即进「加载中」——
   * 若不本地按下去，按钮在这一段仍亮着，连点就会发出两次同样的续页（第二次撞服务端的 409，
   * 那一次噪声是我们自己造的）。页码与 `hasMore` 都不本地推：那是服务端的事实，推出来就是把
   * 还没发生的事写给用户看（本地这一帧随下一帧整体换掉，正是本模块的读模型）。
   *
   * 能按下就说明服务端**那一刻手里没有在途的批**（`hasMore` 为真蕴含它），所以失败时把本地按下去的
   * `running` 还回来是诚实的：那种情况下服务端也没起任何东西。
   */
  const loadMore = useCallback((): void => {
    setRound((r) => (r === null ? null : { ...r, running: true }))
    void (async () => {
      try {
        await deps.apiSend<{ jobId: string }>(ROUTES.exploreListMore)
        if (!aliveNow()) return
        setError(null)
        watch()
      } catch (e) {
        if (!aliveNow()) return
        if (e instanceof ApiClientError && e.status === 409) {
          // 409 = 「此刻没得可加载」：钮照实收掉，不报红——这一条不是故障，是「到头了」
          setRound((r) => (r === null ? null : { ...r, running: false, hasMore: false }))
          return
        }
        setError(t('city.job.moreFailed', { detail: describeError(e, t) }))   // 真失败：红条照说，钮还回来（重试是用户的事）
        setRound((r) => (r === null ? null : { ...r, running: false }))
      }
    })()
  }, [deps, t, watch])

  useEffect(() => {
    alive.current = true
    // 挂载即恢复：本轮结果住在服务端，切 tab 再回来不该重打一遍
    void (async () => {
      let job: ExploreSnapshot | null
      try {
        job = await readStatus()
      } catch {
        // 首屏读不到就是没有：静默（真去看时会再报错）。但闸要落下——不落，调用方会一直等着
        // 「那一轮在不在」的答案，点了没反应比读到空更糟
        if (aliveNow()) setRestored(true)
        return
      }
      if (!aliveNow()) return
      if (job !== null && !submitted.current && apply(job)) watch()   // 提交先回来 → 不覆盖新一轮
      setRestored(true)
    })()
    return () => {
      alive.current = false                       // 只停「看」，服务端那轮继续跑
      channel.stop()
    }
  }, [])                                          // eslint-disable-line react-hooks/exhaustive-deps

  return { round, error, restored, submit, loadMore }
}
