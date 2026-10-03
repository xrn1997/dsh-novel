// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { ApiClientError } from '../../src/client/api.js'
import { useExploreJob } from '../../src/client/explore-job.js'
import type { ExploreSnapshot } from '../../src/shared/wire.js'
import { makeCoreDeps } from './fake-deps.js'
import type { CoreDepsOverrides } from './fake-deps.js'

afterEach(cleanup)

const snap = (over: Partial<ExploreSnapshot> = {}): ExploreSnapshot => ({
  id: 'j1', kind: '玄幻', phase: 'running', cancelled: false,
  total: 2, done: 1, page: 1, hasMore: false, books: [], failures: [], startedAt: 1, ...over,
})

/** 探针：把钩子的返回值暴露给断言（钩子只能活在组件里） */
let seen: ReturnType<typeof useExploreJob> | null = null
function Probe({ deps }: { deps: ReturnType<typeof makeCoreDeps> }): null { seen = useExploreJob(deps); return null }

/** 假依赖：读面按用例给的序列逐次吐快照；SSE 缺省（`makeCoreDeps` 的「立刻结束、一帧不发」）
 *  = 服务端没有推送可用 ⇒ 强制走轮询兜底那条地基。`over` 供续页那组覆写写面。 */
const depsOf = (jobs: Array<ExploreSnapshot | null>, over: CoreDepsOverrides = {}) =>
  makeCoreDeps({
    apiGet: vi.fn(async () => ({ job: jobs.shift() ?? null })),
    apiSend: vi.fn(async () => ({ jobId: 'j1' })),
    ...over,
  })

describe('useExploreJob', () => {
  it('全量替换：同一轮的第二帧整体覆盖第一帧（不是累加）', async () => {
    const deps = depsOf([
      snap({ done: 1, books: [{ name: 'A', author: 'x', sourceCount: 1, origins: [] }] }),
      snap({ done: 2, books: [{ name: 'A', author: 'x', sourceCount: 2, origins: [] }, { name: 'B', author: 'y', sourceCount: 1, origins: [] }] }),
    ])
    render(<Probe deps={deps} />)
    await waitFor(() => { expect(seen?.round?.books.map((b) => b.name)).toEqual(['A']) })
    await new Promise((r) => setTimeout(r, 700))            // 等一轮轮询（POLL_MS=600）
    expect(seen?.round?.books.map((b) => b.name)).toEqual(['A', 'B'])
    expect(seen?.round?.books[0].sourceCount).toBe(2)        // 修订看得见（这正是全量快照的意义）
  })

  it('身份闸：快照换了 id 即整帧换掉，旧轮的条目不留', async () => {
    const deps = depsOf([
      snap({ id: 'j1', done: 1, books: [{ name: 'A', author: 'x', sourceCount: 1, origins: [] }] }),
      snap({ id: 'j2', kind: '都市', done: 0, total: 3, books: [] }),
    ])
    render(<Probe deps={deps} />)
    await waitFor(() => { expect(seen?.round?.id).toBe('j2') })
    expect(seen?.round?.kind).toBe('都市')
    expect(seen?.round?.books).toEqual([])
  })

  it('取消不是完成：快照说 cancelled 时视图态照实带出（宿主侧取消到得了这里，UI 才分得开两件事）', async () => {
    const deps = depsOf([snap({ phase: 'failed', cancelled: true, done: 1, total: 2 })])
    render(<Probe deps={deps} />)
    await waitFor(() => { expect(seen?.round?.cancelled).toBe(true) })
    expect(seen?.round?.running).toBe(false)
  })

  it('恢复闸：恢复读落地（无论读到轮次、读到没有、还是读失败）都要落下，且落地前是真 false', async () => {
    // 读到「没有一轮」也算定：不落闸，调用方会一直等一个永远不来的答案
    const empty = depsOf([null])
    render(<Probe deps={empty} />)
    expect(seen?.restored).toBe(false)                       // 首帧：还没问过服务端
    await waitFor(() => { expect(seen?.restored).toBe(true) })
    cleanup()

    const failed = makeCoreDeps({ apiGet: vi.fn(async () => { throw new Error('读面不可用') }) })
    render(<Probe deps={failed} />)
    await waitFor(() => { expect(seen?.restored).toBe(true) })
  })
})

describe('useExploreJob · 续页（loadMore）', () => {
  it('一次续页 = 一次 POST explore/list/more，且本轮回到 running（钮据此禁用、防重复发）', async () => {
    const deps = depsOf([snap({ phase: 'done', page: 1, hasMore: true })])
    render(<Probe deps={deps} />)
    await waitFor(() => { expect(seen?.round?.hasMore).toBe(true) })
    act(() => { seen?.loadMore() })
    await waitFor(() => { expect(seen?.round?.running).toBe(true) })
    expect(deps.apiSend).toHaveBeenCalledTimes(1)
    expect(deps.apiSend).toHaveBeenCalledWith('POST', 'explore/list/more')
    // 页码归服务端的下一个快照：本地自己加一，就是把「已 N 页」提前念成还没发生的事
    expect(seen?.round?.page).toBe(1)
  })

  it('409 = 「现在没得可加载」：把钮收掉，但不报红（没得加载不是故障）', async () => {
    const deps = depsOf([snap({ phase: 'done', page: 2, hasMore: true })], {
      apiSend: vi.fn(async () => { throw new ApiClientError('Conflict', 409, '没有更多了') }),
    })
    render(<Probe deps={deps} />)
    await waitFor(() => { expect(seen?.round?.hasMore).toBe(true) })
    act(() => { seen?.loadMore() })
    await waitFor(() => { expect(seen?.round?.hasMore).toBe(false) })
    expect(seen?.error).toBeNull()               // 红条只留给真故障
    expect(seen?.round?.running).toBe(false)     // 也没起新批：服务端手上那轮已经到底了
  })

  it('真失败（不是 409）如实报错，且钮留着（重试是用户的事，不是我们收回）', async () => {
    const deps = depsOf([snap({ phase: 'done', page: 1, hasMore: true })], {
      apiSend: vi.fn(async () => { throw new Error('网络请求失败') }),
    })
    render(<Probe deps={deps} />)
    await waitFor(() => { expect(seen?.round?.hasMore).toBe(true) })
    act(() => { seen?.loadMore() })
    await waitFor(() => { expect(seen?.error).toContain('续页失败') })
    expect(seen?.round?.hasMore).toBe(true)      // 既没成功也没「没得加载」：不许替用户把路堵上
  })
})
