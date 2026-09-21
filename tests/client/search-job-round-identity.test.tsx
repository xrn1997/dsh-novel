// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSearchJob } from '../../src/client/search-job.js'
import { SearchJobs } from '../../src/services/search-job.js'
import type { SearchGroup } from '../../src/shared/wire.js'
import { makeCoreDeps } from './fake-deps.js'
import type { CoreDepsOverrides } from './fake-deps.js'

/**
 * 搜索观察 module 的**轮次身份**测试（身份与游标不可分开，口径见 docs/design/client.md）。
 *
 * Seam（评审预先圈定）：`useSearchJob` 这一个观察 interface，两种传输 adapter
 * （SSE 帧 `apiEventStream` / 快照查询 `apiGet`）都从它驱动；「服务端」是真实的
 * `SearchJobs` 持有者（单槽：新提交即替换旧轮），假的只有传输。
 *
 * 缺陷形态（评审复现）：页面甲看 A 轮，页面乙启动 B 轮；甲的连接/轮询带着 A 的
 * 旧游标读到 B 的切片快照，观察者只验 `acc.current === a` 不验 `job.id` →
 * B-first 被旧游标吃掉、A/B 结果混排、keyword 与 id 各说各话。
 *
 * 修复口径：换轮在观察 module 内收尾——丢弃旧累积、从 `since=0` 恢复新轮完整基线、
 * 重新建立观察（旧连接 abort）；既不「只改 id 继续追加」，也不「只丢帧等旧任务等到天荒地老」。
 */

afterEach(cleanup)

/** 最小分组桩：身份即 sourceId（断言只看轮次归属与完整度，不看命中内容） */
const group = (sourceId: string): SearchGroup => ({ sourceId, sourceName: sourceId, status: 'verified', hits: [] })

/** 起一轮永不自行收尾的搜索：换轮由下一次 start()（另一观察者提交）触发 */
const startRound = (jobs: SearchJobs, keyword: string, emitIds: string[]): void => {
  jobs.start(keyword, emitIds.length, (emit) => {
    for (const id of emitIds) emit(group(id))
    return new Promise(() => {})
  })
}

/** 身份序列确定性的持有者：第一轮 A、第二轮 B */
const makeJobs = (): SearchJobs => {
  let seq = 0
  return new SearchJobs({ uuid: () => ['A', 'B'][seq++] })
}

/** 查询串里的 since（缺省 0）——模拟「服务端只认当前槽 + 数字游标」的读面 */
const sinceOf = (path: string): number => Number(new URLSearchParams(path.split('?')[1] ?? '').get('since') ?? '0')

/** 真读面假传输：apiGet 直通 SearchJobs.snapshot(since)；apiEventStream 由各用例覆写 */
const serverDeps = (jobs: SearchJobs, over: CoreDepsOverrides = {}): ReturnType<typeof makeCoreDeps> =>
  makeCoreDeps({
    apiGet: vi.fn(async (path: string) => ({ job: jobs.snapshot(sinceOf(path)) })),
    ...over,
  })

/** SSE 假 adapter：帧由用例喂；abort 即关流（记录关流与否，换轮不许留双流） */
interface OpenStream { onFrame: (data: string) => void; signal: AbortSignal }
const captureStreams = (): { streams: OpenStream[]; apiEventStream: unknown } => {
  const streams: OpenStream[] = []
  const apiEventStream = vi.fn(async (_p: string, onFrame: (data: string) => void, signal: AbortSignal) => {
    streams.push({ onFrame, signal })
    await new Promise<void>((r) => signal.addEventListener('abort', () => r(), { once: true }))
  })
  return { streams, apiEventStream }
}

const groupIds = (hook: { result: { current: ReturnType<typeof useSearchJob> } }): string[] | undefined =>
  hook.result.current.round?.groups.map((g) => g.sourceId)

describe('搜索观察 module：轮次身份与游标不可分开（换轮 = 丢旧累积 + 恢复新基线）', () => {
  it('另一观察者换轮（SSE 帧）：旧连接收到新轮切片 → 不混轮不缺组，从 since=0 恢复乙轮完整基线', async () => {
    const jobs = makeJobs()
    startRound(jobs, '甲词', ['A-result'])
    const { streams, apiEventStream } = captureStreams()
    const deps = serverDeps(jobs, { apiEventStream })
    const hook = renderHook(() => useSearchJob(deps))

    await waitFor(() => expect(hook.result.current.round?.id).toBe('A'))   // 挂载恢复：甲轮基线
    await waitFor(() => expect(streams.length).toBe(1))

    // 页面乙提交 B 轮：服务端单槽替换；甲的连接从此泵出 B 的快照（按甲的旧游标切片，
    // B-first 已被 since 吃掉）——这就是「旧 since 读新任务」在推送侧的形态
    startRound(jobs, '乙词', ['B-first', 'B-second'])
    expect(jobs.snapshot(1)?.added.map((g) => g.sourceId)).toEqual(['B-second'])
    await act(async () => { streams[0].onFrame(JSON.stringify({ job: jobs.snapshot(1) })) })

    await waitFor(() => expect(groupIds(hook)).toEqual(['B-first', 'B-second']))
    const round = hook.result.current.round
    expect(round?.id).toBe('B')
    expect(round?.keyword).toBe('乙词')
    expect(round?.done).toBe(2)
    // 旧连接不留下：换轮后被 abort，且为新轮重开了一条观察
    await waitFor(() => expect(streams.length).toBe(2))
    expect(streams[0].signal.aborted).toBe(true)
  })

  it('旧 since 读新任务（快照轮询）：轮询带旧游标读到新轮切片 → 收敛到乙轮完整基线，B-first 不丢', async () => {
    const jobs = makeJobs()
    startRound(jobs, '甲词', ['A-result'])
    const deps = serverDeps(jobs)                    // apiEventStream 缺省：立刻结束 → 走轮询地基
    const hook = renderHook(() => useSearchJob(deps))
    await waitFor(() => expect(hook.result.current.round?.id).toBe('A'))

    // 轮询节拍之间页面乙换轮；下一次轮询仍带旧游标（服务端只认当前槽 + 数字游标）
    startRound(jobs, '乙词', ['B-first', 'B-second'])
    await waitFor(() => {
      expect(hook.result.current.round?.id).toBe('B')
      expect(groupIds(hook)).toEqual(['B-first', 'B-second'])
    }, { timeout: 4000 })
    expect(hook.result.current.round?.keyword).toBe('乙词')
    // 基线是显式 since=0 重读出来的，不是把切片硬接在旧累积后面
    const apiGet = deps.apiGet as ReturnType<typeof vi.fn>
    expect(apiGet.mock.calls.some((c) => String(c[0]).includes('since=0'))).toBe(true)
  })

  it('基线与连接之间换轮：恢复读到甲轮、连接泵出的首帧已是乙轮切片 → 首帧即换轮，收敛乙轮完整基线', async () => {
    const jobs = makeJobs()
    startRound(jobs, '甲词', ['A-result'])
    const snapshotA = jobs.snapshot(0)               // 恢复基线在换轮前读到的那份
    const { streams, apiEventStream } = captureStreams()
    let reads = 0
    const apiGet = vi.fn(async (path: string) => {
      reads++
      // 首读 = 换轮前的甲轮快照；此后 = 服务端当前槽的真实读数（乙轮）
      return { job: reads === 1 ? snapshotA : jobs.snapshot(sinceOf(path)) }
    })
    const deps = makeCoreDeps({ apiGet, apiEventStream })
    const hook = renderHook(() => useSearchJob(deps))

    await waitFor(() => expect(hook.result.current.round?.id).toBe('A'))
    await waitFor(() => expect(streams.length).toBe(1))

    startRound(jobs, '乙词', ['B-first', 'B-second'])
    await act(async () => { streams[0].onFrame(JSON.stringify({ job: jobs.snapshot(1) })) })

    await waitFor(() => expect(groupIds(hook)).toEqual(['B-first', 'B-second']))
    expect(hook.result.current.round?.id).toBe('B')
    // 恢复走显式基线重读（挂载一次 + 换轮一次），不是把首帧切片当基线
    expect(apiGet.mock.calls.filter((c) => String(c[0]).includes('since=0')).length).toBeGreaterThanOrEqual(2)
    expect(streams[0].signal.aborted).toBe(true)
  })
})
