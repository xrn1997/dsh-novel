import { useCallback, useEffect, useRef, useState } from 'react'
import { bodies, ROUTES } from '../shared/wire.js'
import type { ExploreBook, ExploreSnapshot, JobEnvelope, JobStarted } from '../shared/wire.js'
import { ApiClientError, describeError } from './api.js'
import { zhTranslate } from './copy/index.js'
import type { Translate } from './copy/index.js'
import { createJobChannel } from './job-channel.js'
import { JOB_POLL_MS } from './util.js'
import type { JobWatchDeps } from './deps.js'

/**
 * 浏览器半的「分类浏览轮次」接线：**一轮 = 一个源的一个分类**（`ADR-0028`）——提交一轮 →
 * 盯住它 → **整体替换**视图态。
 *
 * 与 `search-job.ts` 的差别：那边是游标增量（客户端累积），这边是全量快照——续页改写 `page`
 * 与 `hasMore` 这些整轮读数，游标装不下，所以不做累积器。身份闸也不是比对：本模块没有可留的
 * 东西，轮到谁就以谁的整帧为准，落到通道接口就是恒真的 `sameRound`。
 * 通道仪式住 `client/job-channel.ts`；本模块只交三件策略：整帧替换、恒真身份判据、读失败收手。
 * **续页不是新轮**：`loadMore` 只把同一轮再打一页，零累积的读模型照旧。
 */

/** 本轮视图态（服务端快照的投影）。不带 total/done/failures——那是「一轮打多个源」的读数，
 *  单源下都退化；源身份两条是「这一轮逛的是谁」的唯一说法。 */
export interface ExploreRound {
  id: string
  sourceId: string
  /** 该源此刻的名字（服务端那一帧带来的；提交后那帧空态还没有它，见 `submit`） */
  sourceName: string
  kind: string
  books: ExploreBook[]
  running: boolean
/** 本轮被停止（宿主侧取消）：结果保留、只是不再往下抓。UI 据此说「已停止」而不是「跑完了」——
 *  两者都是 running=false。 */
  cancelled: boolean
/** 已加载到第几页：服务端说是第几页就是第几页，客户端**不自己加一**。 */
  page: number
/** 能不能再点「加载更多」：管**显隐**；「正在加载」的禁用态由 `running` 管。 */
  hasMore: boolean
}

export interface ExploreJobView {
  round: ExploreRound | null
/** 唯一那条错误泳道：读写面失败与快照的 `error` 都落这里，靠文案分辨；
 *  **尤其不许把抓取失败咽成静默的空书单**。 */
  error: string | null
/** 挂载恢复的读面是否已定（读到轮次 / 没有轮次 / 读失败都算定）。定下来之前 `round` 恒为 null，
 *  调用方要判「这一轮在不在」必须等这个闸：抢在它之前提交会杀掉服务端正持有的那一轮。 */
  restored: boolean
/** 提交一轮：**两个点名都在 body 里**（源与类，`ADR-0028`）——切源、切类都是再调一次；
 *  服务端按点名走内存快照，重复提交很便宜。 */
  submit: (sourceId: string, kind: string) => void
/** 把**当前这一轮**再打一页（同一轮 id，客户端不累积）。**409 不是故障**：它只有「此刻没得
 *  可加载」一个意思，照实收掉按钮，不许挂红条；其余失败才有红条。 */
  loadMore: () => void
}

/** 快照 → 视图态的**唯一投影**，导出它：测试要钉的就是这份映射本身。 */
export const toRound = (job: ExploreSnapshot): ExploreRound => ({
  id: job.id, sourceId: job.sourceId, sourceName: job.sourceName, kind: job.kind,
  books: job.books, running: job.phase === 'running',
  cancelled: job.cancelled, page: job.page, hasMore: job.hasMore,
})

export function useExploreJob(deps: JobWatchDeps, t: Translate = zhTranslate): ExploreJobView {
  const alive = useRef(true)
/** 通道是否还活着：**每次现读**——卸载时的写入落在 await 之后，编译器会把同一个流程里的
 *  第二次读收窄成常量。这里只守本模块自己的异步段。 */
  const aliveNow = (): boolean => alive.current
/** 「本页已经提交过」闸：POST 回包说了算。挂载恢复读到的是**上一轮**快照，后到就会盖掉新轮
 *  刚落下的空帧；提交落地即关闸，恢复读此后一律让位。 */
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
    (await deps.apiGet<JobEnvelope<ExploreSnapshot>>(ROUTES.exploreListStatus.path)).job ?? null

/** 通道：timer / SSE 回落 / 撤通道 / 代际归 `job-channel.ts`；本模块只交三件策略。spec 锚定
 *  首次渲染的闭包；`t` 每次调用现读当前 locale（政策见 `copy/index.tsx`）。 */
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

/** 盯住这一轮：通道接管，本轮从推送重开。 */
  const watch = useCallback((): void => { channel.start(null) }, [channel])

  const submit = useCallback((sourceId: string, kind: string): void => {
    const s = sourceId.trim()
    const k = kind.trim()
    if (s === '' || k === '') return
    void (async () => {
      try {
        const { jobId } = await deps.apiSend<JobStarted>(ROUTES.exploreList, bodies.exploreList(s, k))
        if (!aliveNow()) return
        submitted.current = true             // 新轮出生：此后的挂载恢复（读的是上一轮）一律让位
        // 提交返回的 id 就是本轮身份：先落一帧空态再盯。源名留空是诚实的——它住在服务端那一帧里。
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
   * 把这一轮再打一页。**这是本模块唯一的乐观态**，且只动 `running`：按下即进「加载中」，
   * 否则连点会发两次同样的续页。页码与 `hasMore` 都不本地推——那是服务端的事实。
   * 失败回滚 `running` 是诚实的：`hasMore` 为真蕴含服务端那一刻手里没有在途的批，本地这一步
   * 失败时服务端也没起任何东西，不留下一个「还在转」的假现场。
   */
  const loadMore = useCallback((): void => {
    setRound((r) => (r === null ? null : { ...r, running: true }))
    void (async () => {
      try {
        await deps.apiSend<JobStarted>(ROUTES.exploreListMore)
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
        // 首屏读不到就是没有：静默（真去看时会再报错），但闸要落下——否则调用方一直等。
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
