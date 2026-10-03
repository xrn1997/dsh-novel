// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import { useExploreJob } from '../../src/client/explore-job.js'
import type { ExploreSnapshot } from '../../src/shared/wire.js'

afterEach(cleanup)

const snap = (over: Partial<ExploreSnapshot> = {}): ExploreSnapshot => ({
  id: 'j1', kind: '玄幻', phase: 'running', cancelled: false,
  total: 2, done: 1, books: [], failures: [], startedAt: 1, ...over,
})

/** 探针：把钩子的返回值暴露给断言（钩子只能活在组件里） */
let seen: ReturnType<typeof useExploreJob> | null = null
function Probe({ deps }: { deps: never }): null { seen = useExploreJob(deps); return null }

const depsOf = (jobs: Array<ExploreSnapshot | null>) => ({
  apiGet: async () => ({ job: jobs.shift() ?? null }),
  apiSend: async () => ({ jobId: 'j1' }),
  apiEventStream: async () => { throw new Error('无 SSE') },   // 强制走轮询兜底
  apiUpload: async () => ({}) as never,
  pushError: () => {}, pushOk: () => {},
}) as never

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
})
