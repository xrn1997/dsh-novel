// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSearchJob } from '../../src/client/search-job.js'
import type { SearchGroup, SearchJobSnapshot } from '../../src/shared/wire.js'
import { makeCoreDeps } from './fake-deps.js'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const group = (i: number): SearchGroup => ({ sourceId: `s${i}`, sourceName: `s${i}`, status: 'verified', hits: [] })

const snapshot = (n: number, phase: 'running' | 'done' = 'running', id = 'J'): SearchJobSnapshot => ({
  id, keyword: 'k', phase, cancelled: false, total: 40, done: n,
  added: n === 0 ? [] : [group(n)], next: n, startedAt: 0,
  ...(phase === 'done' ? { finishedAt: 1 } : {}),
})

const openStream = (frames: Array<(data: string) => void>) =>
  vi.fn(async (_path: string, onFrame: (data: string) => void, signal: AbortSignal) => {
    frames.push(onFrame)
    await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
  })

/** 大轮次流式结果：每组到达都整轮派生是平方级；UI 更新应合并，换轮与终态必须立即落。 */
describe('搜索观察通道：大轮次合并 UI 更新', () => {
  it('超过合并阈值后按拍落一帧，终态不等拍', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const frames: Array<(data: string) => void> = []
    const deps = makeCoreDeps({
      apiGet: vi.fn(async () => ({ job: snapshot(0) })),
      apiEventStream: openStream(frames),
    })
    const hook = renderHook(() => useSearchJob(deps))
    await act(async () => { await Promise.resolve() })
    expect(hook.result.current.round?.id).toBe('J')
    expect(frames).toHaveLength(1)

    await act(async () => {
      for (let i = 1; i <= 20; i++) frames[0]!(JSON.stringify({ job: snapshot(i) }))
    })
    // 前 16 组即时落；17..20 合并进一次待发更新
    expect(hook.result.current.round?.groups).toHaveLength(16)
    await act(async () => { vi.advanceTimersByTime(200) })
    expect(hook.result.current.round?.groups).toHaveLength(20)

    await act(async () => { frames[0]!(JSON.stringify({ job: snapshot(21, 'done') })) })
    expect(hook.result.current.round?.groups).toHaveLength(21)
    expect(hook.result.current.round?.running).toBe(false)
  })

  it('换轮立即落：旧轮压在待发队列里的读数不许补回来', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const frames: Array<(data: string) => void> = []
    let reads = 0
    const deps = makeCoreDeps({
      // 挂载恢复拿到 J 的空基线；换轮收尾重读服务端当前槽拿到 K 的基线
      apiGet: vi.fn(async () => ({ job: reads++ === 0 ? snapshot(0) : snapshot(3, 'running', 'K') })),
      apiEventStream: openStream(frames),
    })
    const hook = renderHook(() => useSearchJob(deps))
    await act(async () => { await Promise.resolve() })
    await act(async () => {
      for (let i = 1; i <= 20; i++) frames[0]!(JSON.stringify({ job: snapshot(i) }))
    })
    expect(hook.result.current.round?.groups).toHaveLength(16)   // 17..20 还在待发里

    await act(async () => { frames[0]!(JSON.stringify({ job: snapshot(1, 'running', 'K') })) })
    expect(hook.result.current.round?.id).toBe('K')
    await act(async () => { vi.advanceTimersByTime(200) })
    expect(hook.result.current.round?.id).toBe('K')
    expect(hook.result.current.round?.groups).toHaveLength(1)    // 新轮基线那一组，不是旧轮的 20 组
  })
})
