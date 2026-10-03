// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import { useExploreJob } from '../../src/client/explore-job.js'
import type { ExploreSnapshot } from '../../src/shared/wire.js'
import { makeCoreDeps } from './fake-deps.js'

afterEach(cleanup)

const snap = (over: Partial<ExploreSnapshot> = {}): ExploreSnapshot => ({
  id: 'j1', kind: '玄幻', phase: 'running', cancelled: false,
  total: 2, done: 1, books: [], failures: [], startedAt: 1, ...over,
})

/** 探针：把钩子的返回值暴露给断言（钩子只能活在组件里） */
let seen: ReturnType<typeof useExploreJob> | null = null
function Probe({ deps }: { deps: ReturnType<typeof makeCoreDeps> }): null { seen = useExploreJob(deps); return null }

/** 假依赖：读面按用例给的序列逐次吐快照；SSE 缺省（`makeCoreDeps` 的「立刻结束、一帧不发」）
 *  = 服务端没有推送可用 ⇒ 强制走轮询兜底那条地基 */
const depsOf = (jobs: Array<ExploreSnapshot | null>) =>
  makeCoreDeps({
    apiGet: vi.fn(async () => ({ job: jobs.shift() ?? null })),
    apiSend: vi.fn(async () => ({ jobId: 'j1' })),
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
