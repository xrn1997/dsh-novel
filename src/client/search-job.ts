import { useEffect, useRef, useState } from 'react'
import { queries, ROUTES } from '../shared/wire.js'
import type { SearchGroup, SearchJobSnapshot } from '../shared/wire.js'
import type { ClientCoreDeps } from './deps.js'

/**
 * 浏览器半的「聚合搜索后台任务」接线：提交一轮 → 盯住它（SSE 推送优先，快照轮询兜底）→
 * 按游标累积增量分组。
 *
 * 为什么不在这里跑批：中央呈现座位一次只渲染一个面板（`main` keyed 槽；此前
 * `conversation.view`），切走即卸载组件——在途循环与结果都握在 `useState` 里的话，离开界面就两头丢（结果清零 + 站点白挨剩余请求，
 * 实测见 `docs/design/client.md`）。批循环、结果持有都在 Node 半（`services/search-job.ts`），
 * 本模块只读：卸载只是停止「看」，重挂载从 `since=0` 重新拉一遍就全回来了。
 *
 * 两条投递通道的分工（官方口径：通知不 replay，可靠恢复必须有 baseline / cursor / 显式 query）：
 * - **快照轮询是地基**：`GET search/job-status?since=`，断开、连不上、无推送时全靠它；
 * - **SSE 是加速器**：`GET search/job-stream`，帧体就是同一份 `{ job }` 快照，所以合并代码只有一份。
 * 任一时刻只有一条通道在推进游标——两条同时在飞会把同一批命中累加两遍。
 *
 * **轮次身份与游标不可分开**（口径见 docs/design/client.md 同名条）：服务端读面是单槽 + 数字游标——别的页面（或本页
 * 另一次提交）启动新一轮后，旧连接 / 旧游标读回来的快照是**新轮按旧游标切的片**。回包先验
 * `job.id === acc.id`，不一致即换轮：旧累积整体丢弃、从 `since=0` 显式重读新轮完整基线、
 * 重新建立观察（旧连接 abort）。被否决的两种写法：只改 id 继续追加（A/B 结果混排、B 的头几组
 * 被旧游标吃掉）；只丢帧继续等旧任务（服务端单槽，旧轮永远等不到下一帧）。裁决：旧观察者
 * **跟随最近一轮**（服务端只保留一轮，跟随是唯一能收敛的语义）。
 */

/** 轮询节奏：600ms 足够「边搜边出」的观感，又不会把 `/novel-api` 打成刷屏 */
const POLL_MS = 600

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
  /** 停止本轮：服务端立刻进终态，**已搜出的分组一律保留**；
   *  在途的最多 searchParallel 条不撤回（回来仍计入本轮结果，但要看得到得再进一次页面）。 */
  cancel: () => void
  /** 读面/写面层面的失败——与「某源未响应」（分组里的 error）不同层 */
  error: string | null
  submit: (keyword: string) => void
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export function useSearchJob(deps: ClientCoreDeps): SearchJobView {
  const acc = useRef<Acc | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const stream = useRef<AbortController | null>(null)
  const alive = useRef(true)
  const [round, setRound] = useState<SearchRound | null>(null)
  const [error, setError] = useState<string | null>(null)

  /** 累积器 → 视图态：单点投影，别在多处各拼一份（曾经 progress/summary 各算一份百分比） */
  const publish = (a: Acc, running: boolean): void => {
    setRound({ id: a.id, keyword: a.keyword, total: a.total, done: a.since, groups: [...a.groups], running, cancelled: a.cancelled })
  }

  /** 快照 → 累积 → 视图态。推送帧与轮询回包共用，返回「本轮是否还在跑」。
   *  身份闸：`job.id !== a.id` 说明服务端读面已经换了轮（别的观察者提交了新一轮），
   *  这份快照是**新轮按本观察者旧游标切的片**——增量对新轮无意义，走换轮收尾，不许合并。 */
  const apply = (a: Acc, job: SearchJobSnapshot | null): boolean => {
    if (job === null) {
      setError('后台搜索任务已不可读（服务重启或结果已过保留期）')
      publish(a, false)
      return false
    }
    if (job.id !== a.id) {
      void rebaseline(a)
      return false                              // 旧轮到此为止：不再为它排轮询/续帧
    }
    a.keyword = job.keyword
    a.total = job.total
    a.cancelled = job.cancelled === true
    a.groups.push(...job.added)
    a.since = job.next                                // 服务端给的游标为准（它可能夹过界）
    const running = job.phase === 'running'
    // 停止不是失败：取消后不挂红条（也不把服务端那句「任务已取消」当错误念给用户）
    setError(running || job.cancelled === true ? null : job.error ?? null)
    publish(a, running)
    return running
  }

  /** 换轮收尾（身份切换 + 基线恢复 + 重新观察，一个职责一处裁决）：
   *  从 `since=0` 显式重读服务端当前槽的完整基线，整体替换累积器。快照自带身份，
   *  读回来的基线自洽（若重读间隙又换了一轮，下一次帧/轮询的身份闸会再次触发，同样收敛）。 */
  const rebaseline = async (stale: Acc): Promise<void> => {
    stream.current?.abort()                       // 旧连接属旧轮：先断，防它的迟到帧再进来
    stream.current = null
    let job: SearchJobSnapshot | null
    try {
      job = (await deps.apiGet<{ job: SearchJobSnapshot | null }>(queries.searchJobStatus(0))).job
    } catch (e) {
      if (acc.current !== stale || !alive.current) return
      setError(`搜索结果读取失败：${errText(e)}`)
      publish(stale, false)
      return
    }
    if (!alive.current || acc.current !== stale) return   // 已卸载，或本页提交已落地（POST 说了算）
    if (job === null) {                                    // 服务端连新一轮也没了：如实说，不伪装
      setError('后台搜索任务已不可读（服务重启或结果已过保留期）')
      publish(stale, false)
      return
    }
    begin({ id: job.id, keyword: job.keyword, total: job.total, cancelled: job.cancelled === true,
      since: job.next, groups: [...job.added] }, job.phase === 'running')
    if (job.error !== undefined) setError(job.error)      // 终态轮次的失败原因（若新轮已终态）
  }

  const armPoll = (): void => {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = setTimeout(() => { void poll() }, POLL_MS)
  }

  /** 地基通道：读一次快照。读不到就收手（读不到还转圈只会刷屏）。 */
  const poll = async (): Promise<void> => {
    const a = acc.current
    if (a === null || !alive.current) return
    let job: SearchJobSnapshot | null
    try {
      job = (await deps.apiGet<{ job: SearchJobSnapshot | null }>(queries.searchJobStatus(a.since))).job
    } catch (e) {
      if (acc.current !== a || !alive.current) return
      setError(`搜索结果读取失败：${errText(e)}`)
      publish(a, false)
      return
    }
    if (acc.current !== a || !alive.current) return   // 陈旧回包：已被新一轮替换或已卸载
    if (apply(a, job) && acc.current === a && alive.current) armPoll()
  }

  /** 盯住这一轮：先开 SSE；断开 / 连不上 / 提前结束而本轮未终态 → 回落轮询。 */
  const watch = (a: Acc): void => {
    const ctrl = new AbortController()
    stream.current?.abort()
    stream.current = ctrl
    void (async (): Promise<void> => {
      let running = true
      try {
        await deps.apiEventStream(queries.searchJobStream(a.since), (data): void => {
          if (acc.current !== a || !alive.current) return
          let job: SearchJobSnapshot | null
          try {
            job = (JSON.parse(data) as { job: SearchJobSnapshot | null }).job
          } catch { return }                           // 坏帧不致命：下一帧或轮询兜底
          running = apply(a, job)
          if (!running) ctrl.abort()                   // 终态：自己关流，不留着占连接
        }, ctrl.signal)
      } catch { /* 连不上或断线：一律走下面的回落，不单独报错（轮询失败才会真的报错） */ }
      if (acc.current !== a || !alive.current) return
      if (running) armPoll()
    })()
  }

  /** 起跑一轮的读取（提交成功后、挂载恢复时同一条路）。
   *  `running=false` 用于恢复一个已终态的轮次：结果就在手上，不必再开一条流。 */
  const begin = (a: Acc, running = true): void => {
    acc.current = a
    if (timer.current !== null) { clearTimeout(timer.current); timer.current = null }
    setError(null)
    publish(a, running)
    if (running) watch(a)
  }

  const submit = (keyword: string): void => {
    const kw = keyword.trim()
    if (kw === '') return
    void (async () => {
      try {
        const { jobId } = await deps.apiSend<{ jobId: string }>('POST', ROUTES.searchJob.path, { keyword: kw })
        // 提交在飞时挂载恢复也可能已经落地——POST 的结果说了算（新一轮替换上一轮），故此后置
        begin({ id: jobId, keyword: kw, total: 0, cancelled: false, since: 0, groups: [] })
      } catch (e) {
        setError(`搜索提交失败：${errText(e)}`)        // 服务端没起新轮：上一轮结果照旧可读，不清屏
      }
    })()
  }

  useEffect(() => {
    alive.current = true                               // StrictMode 双挂载：上一次卸载置过 false
    void (async () => {
      // 挂载即恢复：本轮结果住在服务端，切走再切回来不该重打一遍（这正是本次改造的那一半）
      let job: SearchJobSnapshot | null
      try {
        job = (await deps.apiGet<{ job: SearchJobSnapshot | null }>(queries.searchJobStatus(0))).job
      } catch { return }                               // 首屏读不到就是没有：静默（真去搜时会再报错）
      if (!alive.current || job === null || acc.current !== null) return   // 提交先回来 → 不覆盖新一轮
      begin({ id: job.id, keyword: job.keyword, total: job.total, cancelled: job.cancelled === true, since: job.next, groups: [...job.added] },
        job.phase === 'running')
      if (job.error !== undefined) setError(job.error)
    })()
    return () => {
      alive.current = false                            // 只停「看」，服务端那轮继续跑
      if (timer.current !== null) clearTimeout(timer.current)
      timer.current = null
      stream.current?.abort()
      stream.current = null
    }
  }, [])                                              // eslint-disable-line react-hooks/exhaustive-deps

  const cancel = (): void => {
    const a = acc.current
    if (a === null) return                             // 视图只在「还在跑」时给这个钮，这里只挡「压根没提交过」
    void deps.apiSend('POST', ROUTES.searchJobCancel.path, {}).catch((e): void => {
      if (acc.current !== a || !alive.current) return
      setError(`停止搜索失败：${errText(e)}`)
    })
  }

  return { round, error, submit, cancel }
}
