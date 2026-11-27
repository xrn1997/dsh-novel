import { useEffect, useRef, useState } from 'react'
import { bodies, queries, ROUTES } from '../shared/wire.js'
import type { JobEnvelope, JobStarted, SearchGroup, SearchJobSnapshot } from '../shared/wire.js'
import { describeError } from './api.js'
import { zhTranslate } from './copy/index.js'
import type { Translate } from './copy/index.js'
import { createJobChannel } from './job-channel.js'
import { JOB_POLL_MS } from './util.js'
import type { JobWatchDeps } from './deps.js'

/** 大轮次流式派生：超过这个组数后合并 UI 更新（代价随源数平方增长）；终态/换轮/小轮次仍立即落。 */
const COALESCE_AFTER_GROUPS = 16
const COALESCE_MS = 150

/**
 * 浏览器半的「聚合搜索后台任务」接线：提交一轮 → 盯住它 → 按游标累积增量分组。
 *
 * 为什么不在这里跑批：中央座位一次只渲染一个面板，切走即卸载；循环与结果握在 useState 里就
 * 两头丢。批循环与结果持有都在 Node 半，本模块只读：重挂载从 `since=0` 重拉就全回来了。
 * **通道仪式不在这里**（`client/job-channel.ts`）；本模块只交轮次语义——累积器、身份判据
 * （`job.id` 与本轮 id）、换轮恢复、大轮次的 UI 合并。
 * **轮次身份与游标不可分开**：服务端单槽 + 数字游标，旧游标读回来的是新轮按旧游标切的片。
 * 回包先过 `sameRound`；不一致即换轮（丢旧累积、`since=0` 重读、重开观察）。旧观察者
 * **跟随最近一轮**——服务端只保留一轮，跟随是唯一能收敛的语义。
 */

/** 本轮视图态（由服务端快照 + 本地累积得出；`running` 就是 UI 的「还在跑吗」判据） */
export interface SearchRound {
  id: string
  keyword: string
  /** 本轮真实参搜源数（服务端 searchPlan 说了算；首帧之前为 0） */
  total: number
  /** 已完成源数（= 服务端已交付的组数，完成序） */
  done: number
  groups: SearchGroup[]
  running: boolean
  /** 用户按过「停止」：结果保留、只是不再往下搜（文案与红条都据此分叉） */
  cancelled: boolean
}

interface Acc {
  id: string
  keyword: string
  total: number
  cancelled: boolean
  /** 下一次读取该带的游标（= 已收组数） */
  since: number
  groups: SearchGroup[]
}

export interface SearchJobView {
  round: SearchRound | null
  /** 停止本轮：服务端立刻进终态，**已搜出的分组一律保留**；在途的最多 searchParallel 条不撤回。 */
  cancel: () => void
  /** 读面/写面层面的失败——与「某源未响应」（分组里的 error）不同层 */
  error: string | null
  /** 起跑一轮；成功 resolve 本轮 jobId，失败或被后一次提交取代时 resolve null。调用方拿 id 认领
   *  自己的轮次——服务端单槽跟随最近一轮，关键词不是身份。 */
  submit: (keyword: string) => Promise<string | null>
}

export function useSearchJob(
  deps: JobWatchDeps,
  t: Translate = zhTranslate,
  opts?: {
    /** 挂载恢复是否开观察通道（缺省 true）。浮层只认自己 POST 回来的轮次，恢复读到的是别人的——
     *  快照读照做，但流/轮询纯属白占连接，故关掉。 */
    resume?: boolean
  },
): SearchJobView {
  const acc = useRef<Acc | null>(null)
  const publishTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingPublish = useRef<{ a: Acc; running: boolean } | null>(null)
  const alive = useRef(true)
  /** 通道是否还活着：**每次现读**。卸载时的写入落在 await 之后，编译器会把同一个流程里的第二次
   *  读收窄成常量。这里只守本模块自己的异步段。 */
  const aliveNow = (): boolean => alive.current
  /** 起跑序号：只有最后一次 `submit` 的回包能 `begin`/报错——否则观察者会被倒回旧轮。 */
  const submitSeq = useRef(0)
  const [round, setRound] = useState<SearchRound | null>(null)
  const [error, setError] = useState<string | null>(null)

  /** 累积器 → 视图态：单点投影，别在多处各拼一份（progress 与 summary 不要各算一份百分比） */
  const setRoundNow = (a: Acc, running: boolean): void => {
    setRound({ id: a.id, keyword: a.keyword, total: a.total, done: a.since, groups: [...a.groups], running, cancelled: a.cancelled })
  }

  const flushPublish = (): void => {
    if (publishTimer.current !== null) {
      clearTimeout(publishTimer.current)
      publishTimer.current = null
    }
    const pending = pendingPublish.current
    if (pending === null) return
    pendingPublish.current = null
    setRoundNow(pending.a, pending.running)
  }

  const publish = (a: Acc, running: boolean, immediate = false): void => {
    if (immediate || !running || a.groups.length <= COALESCE_AFTER_GROUPS) {
      if (publishTimer.current !== null) {
        clearTimeout(publishTimer.current)
        publishTimer.current = null
      }
      pendingPublish.current = null
      setRoundNow(a, running)
      return
    }
    pendingPublish.current = { a, running }
    if (publishTimer.current === null) {
      publishTimer.current = setTimeout(flushPublish, COALESCE_MS)
    }
  }

  /** 快照 → 累积 → 视图态。走到这里的一定是本轮的回包；`null` = 服务端连一轮也没有：如实说。 */
  const apply = (a: Acc, job: SearchJobSnapshot | null): boolean => {
    if (job === null) {
      setError(t('search.job.unavailable'))
      publish(a, false)
      return false
    }
    a.keyword = job.keyword
    a.total = job.total
    a.cancelled = job.cancelled
    a.groups.push(...job.added)
    a.since = job.next                                // 服务端给的游标为准（它可能夹过界）
    const running = job.phase === 'running'
    // 停止不是失败：取消后不挂红条（也不把服务端那句「任务已取消」当错误念给用户）
    setError(running || job.cancelled ? null : job.error ?? null)
    publish(a, running)
    return running
  }

  /** 换上新一轮累积器并立刻上屏：`begin` 与 `rebaseline` 共用这一处写入次序。 */
  const installRound = (a: Acc, running: boolean): void => {
    acc.current = a
    setError(null)
    publish(a, running, true)
  }

  /** 换轮收尾：从 `since=0` 重读服务端当前槽的完整基线，整体替换累积器，交回新 token 重开观察。
   *  快照自带身份，读回来的基线自洽；重读间隙又换轮则下一次身份判据再触发。
   *  返回 `null` = 收手：已卸载 / 本页提交已落地 / 无新轮 / 新轮已终态。 */
  const rebaseline = async (stale: Acc): Promise<Acc | null> => {
    let job: SearchJobSnapshot | null
    try {
      job = (await deps.apiGet<JobEnvelope<SearchJobSnapshot>>(queries.searchJobStatus(0))).job
    } catch (e) {
      if (acc.current !== stale || !aliveNow()) return null
      setError(t('search.job.readFailed', { detail: describeError(e, t) }))
      publish(stale, false)
      return null
    }
    if (!aliveNow() || acc.current !== stale) return null
    if (job === null) {                                    // 服务端连新一轮也没了：如实说，不伪装
      setError(t('search.job.unavailable'))
      publish(stale, false)
      return null
    }
    const next: Acc = { id: job.id, keyword: job.keyword, total: job.total, cancelled: job.cancelled,
      since: job.next, groups: [...job.added] }
    const running = job.phase === 'running'
    installRound(next, running)
    if (job.error !== undefined) setError(job.error)      // 终态轮次的失败原因（若新轮已终态）
    return running ? next : null                          // 已终态：结果已落，不必再开观察
  }

  /** 通道：timer / SSE 回落 / 撤通道 / 代际归 `job-channel.ts`；本模块只交四件业务面。spec 锚定
   *  首次渲染的闭包（运行中的一轮不随重渲染换代）；`t` 每次调用现读当前 locale。 */
  const [channel] = useState(() => createJobChannel<SearchJobSnapshot, Acc>(
    {
      read: async (a) => (await deps.apiGet<JobEnvelope<SearchJobSnapshot>>(queries.searchJobStatus(a.since))).job,
      subscribe: (a, onFrame, signal) => deps.apiEventStream(queries.searchJobStream(a.since), onFrame, signal),
      apply: (a, job) => apply(a, job),
      sameRound: (a, job) => job.id === a.id,
      regain: (a) => rebaseline(a),
      onReadError: (a, e) => {                          // 读不到就收手（读不到还转圈只会刷屏）
        if (acc.current !== a || !aliveNow()) return false
        setError(t('search.job.readFailed', { detail: describeError(e, t) }))
        publish(a, false)
        return false
      },
    },
    deps.jobPollMs ?? JOB_POLL_MS,
  ))

  /** 起跑一轮的读取（提交成功后、挂载恢复时同一条路）。`running=false` 恢复已终态的轮次，不必再开流；
   *  `watch=false` 只落快照、不开观察通道。 */
  const begin = (a: Acc, running = true, watchRun = running): void => {
    installRound(a, running)
    if (watchRun) {
      channel.start(a)
    } else {
      channel.stop()
    }
  }

  const submit = (keyword: string): Promise<string | null> => {
    const kw = keyword.trim()
    if (kw === '') return Promise.resolve(null)
    const mine = ++submitSeq.current
    return (async () => {
      try {
        const { jobId } = await deps.apiSend<JobStarted>(ROUTES.searchJob, bodies.searchJob(kw))
        if (mine !== submitSeq.current) return null   // 迟到回包：后一次提交已起跑，旧回包不许倒回观察者
        // 提交在飞时挂载恢复也可能已经落地——POST 的结果说了算（新一轮替换上一轮）。
        begin({ id: jobId, keyword: kw, total: 0, cancelled: false, since: 0, groups: [] })
        return jobId
      } catch (e) {
        if (mine !== submitSeq.current) return null   // 迟到的失败不盖住后一次提交的现场
        setError(t('search.job.submitFailed', { detail: describeError(e, t) }))   // 服务端没起新轮：上一轮结果照旧可读，不清屏
        return null
      }
    })()
  }

  useEffect(() => {
    alive.current = true                               // StrictMode 双挂载：上一次卸载置过 false
    void (async () => {
      // 挂载即恢复：本轮结果住在服务端，切走再切回来不该重打一遍
      let job: SearchJobSnapshot | null
      try {
        job = (await deps.apiGet<JobEnvelope<SearchJobSnapshot>>(queries.searchJobStatus(0))).job
      } catch { return }                               // 首屏读不到就是没有：静默（真去搜时会再报错）
      if (!aliveNow() || job === null || acc.current !== null) return   // 提交先回来 → 不覆盖新一轮
      begin({ id: job.id, keyword: job.keyword, total: job.total, cancelled: job.cancelled, since: job.next, groups: [...job.added] },
        job.phase === 'running', job.phase === 'running' && opts?.resume !== false)
      if (job.error !== undefined) setError(job.error)
    })()
    return () => {
      alive.current = false                            // 只停「看」，服务端那轮继续跑
      channel.stop()
      if (publishTimer.current !== null) clearTimeout(publishTimer.current)
      publishTimer.current = null
      pendingPublish.current = null
    }
  }, [])                                              // eslint-disable-line react-hooks/exhaustive-deps

  const cancel = (): void => {
    const a = acc.current
    if (a === null) return                             // 视图只在「还在跑」时给这个钮，这里只挡「压根没提交过」
    void deps.apiSend(ROUTES.searchJobCancel, {}).catch((e: unknown): void => {
      if (acc.current !== a || !aliveNow()) return
      setError(t('search.job.cancelFailed', { detail: describeError(e, t) }))
    })
  }

  return { round, error, submit, cancel }
}
