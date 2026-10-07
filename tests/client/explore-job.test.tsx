// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, renderHook, waitFor } from '@testing-library/react'
import { ApiClientError } from '../../src/client/api.js'
import { toRound, useExploreJob } from '../../src/client/explore-job.js'
import type { ExploreBook, ExploreSnapshot } from '../../src/shared/wire.js'
import { makeCoreDeps } from './fake-deps.js'
import type { CoreDepsOverrides } from './fake-deps.js'

afterEach(cleanup)

/** 单源的一轮快照：两个点名（源身份 + 类）就在形状里，没有跨源读数——
 *  `total`/`done`/`failures` 那份清单随 `docs/adr/0028` 一起走了。 */
const snap = (over: Partial<ExploreSnapshot> = {}): ExploreSnapshot => ({
  id: 'j1', sourceId: 's9', sourceName: '站点甲', kind: '玄幻', phase: 'running', cancelled: false,
  page: 1, hasMore: false, books: [], startedAt: 1, ...over,
})

const book = (name: string, over: Partial<ExploreBook> = {}): ExploreBook =>
  ({ name, author: '青衫客', bookUrl: `https://a/${name}`,
    coverUrl: null, kind: null, lastChapter: null, intro: null, wordCount: null, ...over })

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
      snap({ page: 1, books: [book('A')] }),
      snap({ page: 2, hasMore: true, books: [book('A'), book('B')] }),
    ])
    render(<Probe deps={deps} />)
    await waitFor(() => { expect(seen?.round?.books.map((b) => b.name)).toEqual(['A']) })
    await new Promise((r) => setTimeout(r, 700))            // 等一轮轮询（POLL_MS=600）
    expect(seen?.round?.books.map((b) => b.name)).toEqual(['A', 'B'])   // 不是 ['A','A','B']：没人在客户端接列表
    expect(seen?.round?.page).toBe(2)                      // 整轮读数跟着这一帧一起换，不留在第一帧上
    expect(seen?.round?.hasMore).toBe(true)
  })

  it('身份闸：快照换了 id 即整帧换掉，旧轮的条目不留', async () => {
    const deps = depsOf([
      snap({ id: 'j1', books: [book('A')] }),
      snap({ id: 'j2', sourceId: 's8', sourceName: '站点乙', kind: '都市', books: [] }),
    ])
    render(<Probe deps={deps} />)
    await waitFor(() => { expect(seen?.round?.id).toBe('j2') })
    expect(seen?.round?.kind).toBe('都市')
    expect(seen?.round?.sourceName).toBe('站点乙')          // 「这一轮逛的是谁」也随整帧换掉
    expect(seen?.round?.books).toEqual([])
  })

  it('取消不是完成：快照说 cancelled 时视图态照实带出（宿主侧取消到得了这里，UI 才分得开两件事）', async () => {
    const deps = depsOf([snap({ phase: 'failed', cancelled: true })])
    render(<Probe deps={deps} />)
    await waitFor(() => { expect(seen?.round?.cancelled).toBe(true) })
    expect(seen?.round?.running).toBe(false)
  })

  it('一条错误泳道：快照的 error 原样进视图态；在跑与被停止都不报红', async () => {
    const deps = depsOf([snap({ phase: 'failed', error: '站点甲：这一页没回来（FetchError）—— 超时' })])
    render(<Probe deps={deps} />)
    await waitFor(() => { expect(seen?.error).toContain('这一页没回来') })
    cleanup()

    // 「这一页没问到」与「这一类真的没货」不许折成同一帧，也不许在还没答完时冒充此刻的结论
    const running = depsOf([snap({ error: '上一批的残留' })])
    render(<Probe deps={running} />)
    await waitFor(() => { expect(seen?.round?.running).toBe(true) })
    expect(seen?.error).toBeNull()
    cleanup()

    const stopped = depsOf([snap({ phase: 'failed', cancelled: true, error: '任务已取消' })])
    render(<Probe deps={stopped} />)
    await waitFor(() => { expect(seen?.round?.cancelled).toBe(true) })
    expect(seen?.error).toBeNull()
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

  it('submit 带 sourceId：POST 的 body 是 { sourceId, kind } 两个字段', async () => {
    const calls: Array<{ path: string; body: unknown }> = []
    const deps = makeCoreDeps({
      apiSend: vi.fn(async (_method: string, path: string, body: unknown) => {
        calls.push({ path, body })
        return { jobId: 'j1' }
      }),
    })
    const { result } = renderHook(() => useExploreJob(deps))
    act(() => result.current.submit('s9', '玄幻'))
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0].path).toBe('explore/list')
    expect(calls[0].body).toEqual({ sourceId: 's9', kind: '玄幻' })
  })

  it('提交落地即关闸：空帧带着这一轮的点名，源名留给服务端那一帧（客户端不编名字）', async () => {
    const deps = depsOf([null], { apiSend: vi.fn(async () => ({ jobId: 'j7' })) })
    const { result } = renderHook(() => useExploreJob(deps))
    act(() => result.current.submit('s9', '玄幻'))
    await waitFor(() => { expect(result.current.round?.id).toBe('j7') })
    expect(result.current.round).toMatchObject({
      sourceId: 's9', sourceName: '', kind: '玄幻', running: true, page: 1, hasMore: false,
    })
  })

  it('通道代际：切源时在途的那一发轮询读后到，不许拿旧轮整帧盖掉刚落地的新轮', async () => {
    // `submitted` 那枚闸只管得到挂载恢复，管不到已经飞出去的 apiGet：clearTimeout 撤不回在途的一发，
    // abort 只断流不断回包。这一条钉的是另一半——迟到帧要靠通道代际认出自己已被撤掉。
    const stale = snap({ id: 'j-old', sourceName: '站点甲', kind: '穿越重生', books: [book('旧轮的书')] })
    const held = snap({ id: 'j2', sourceId: 's8', sourceName: '站点乙', kind: '都市' })
    const gate = { open: (): void => {} }
    let reads = 0
    const deps = makeCoreDeps({
      apiGet: vi.fn(async () => {
        reads += 1
        if (reads === 1) return { job: stale }                     // 挂载恢复：服务端正拿着旧轮
        if (reads === 2) {                                          // 轮询那一发卡在闸上
          await new Promise<void>((res) => { gate.open = res })
          return { job: stale }
        }
        return { job: held }                                        // 新通道起，读到的都是新轮
      }),
      apiSend: vi.fn(async () => ({ jobId: 'j2' })),
    })
    const { result } = renderHook(() => useExploreJob(deps))
    await waitFor(() => { expect(result.current.round?.id).toBe('j-old') })
    // 盲等 POLL_MS 会假绿：机器稍慢时轮询还没起飞，submit 已接管，放行的是空气
    await waitFor(() => { expect(reads).toBe(2) }, { timeout: 2000 })  // 轮询已起飞，卡在闸上
    act(() => { result.current.submit('s8', '都市') })
    await waitFor(() => { expect(result.current.round?.id).toBe('j2') })

    act(() => { gate.open() })                                      // 放行迟到的旧轮帧
    // 这一格短于 POLL_MS：此刻唯一还能动这轮读数的就是那发迟到的旧帧
    await new Promise((r) => setTimeout(r, 50))
    expect(result.current.round?.id).toBe('j2')
    expect(result.current.round?.kind).toBe('都市')
    expect(result.current.round?.books).toEqual([])                 // 「旧轮的书」没被当成本轮的结果
    expect(result.current.error).toBeNull()                         // 旧通道也没顺手抹一道红
  })

  it('通道代际：迟到的那一发轮询**报错**时，也不许把新轮刷成红条', async () => {
    // 盖帧之外更狠的一条臂：旧通道断线的那句「分类结果读取失败」落在新轮身上就是假故障
    const stale = snap({ id: 'j-old', kind: '穿越重生', books: [book('旧轮的书')] })
    const gate = { open: (): void => {} }
    let reads = 0
    const deps = makeCoreDeps({
      apiGet: vi.fn(async () => {
        reads += 1
        if (reads === 1) return { job: stale }
        await new Promise<void>((res) => { gate.open = res })
        throw new Error('旧通道断线')                               // 迟到的那一发以失败收场
      }),
      apiSend: vi.fn(async () => ({ jobId: 'j2' })),
    })
    const { result } = renderHook(() => useExploreJob(deps))
    await waitFor(() => { expect(reads).toBe(2) }, { timeout: 2000 })
    act(() => { result.current.submit('s8', '都市') })
    await waitFor(() => { expect(result.current.round?.id).toBe('j2') })
    act(() => { gate.open() })
    await new Promise((r) => setTimeout(r, 50))
    expect(result.current.error).toBeNull()                         // 旧通道的失败不占这一轮的错误泳道
    expect(result.current.round?.running).toBe(true)                // 也不把新轮按成「跑完了」
  })

  it('watch 接管通道：新流起来时旧轮询的定时一并撤掉，不留两条通道并行', async () => {
    // 旧通道「没有推送可用」→ 排好了一发轮询；新通道推送可用（这条流挂住不结束）→ 自己不该再轮。
    // 于是提交之后再过一整个 POLL_MS，读面次数必须还停在恢复那一次：多出来的一发就是双通道。
    let reads = 0
    let streams = 0
    const deps = makeCoreDeps({
      apiGet: vi.fn(async () => { reads += 1; return { job: snap({ id: 'j-old' }) } }),
      apiSend: vi.fn(async () => ({ jobId: 'j2' })),
      apiEventStream: vi.fn(async () => {
        streams += 1
        if (streams === 2) await new Promise(() => {})              // 第二条流常开：新通道不回落轮询
      }),
    })
    const { result } = renderHook(() => useExploreJob(deps))
    await waitFor(() => { expect(reads).toBe(1) })
    act(() => { result.current.submit('s8', '都市') })
    await waitFor(() => { expect(result.current.round?.id).toBe('j2') })
    await new Promise((r) => setTimeout(r, 700))
    expect(reads).toBe(1)                                           // 旧那条排好的轮询没落地
  })

  it('toRound 是快照到视图态的唯一投影：源身份原样带出，跨源读数不在形状里', () => {
    const job: ExploreSnapshot = {
      id: 'j1', sourceId: 's9', sourceName: '站点甲', kind: '玄幻', phase: 'failed',
      cancelled: false, page: 1, hasMore: false, books: [], startedAt: 1, error: '超时',
    }
    const round = toRound(job)
    expect(round).toMatchObject({ sourceId: 's9', sourceName: '站点甲', running: false, hasMore: false })
    expect(Object.keys(round).filter((k) => ['total', 'done', 'failures'].includes(k))).toEqual([])
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
