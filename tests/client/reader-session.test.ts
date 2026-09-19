import { describe, expect, it, vi } from 'vitest'
import { ReaderSession } from '../../src/client/reader-session.js'
import type { ReaderPort, ReaderSessionDeps } from '../../src/client/reader-session.js'
import type { ChapterAnchor } from '../../src/client/progress.js'
import type { ChapterEntry, ShelfBook } from '../../src/client/views/types.js'

/**
 * 阅读会话的时序测试：这些断言此前**无处可写**——在途槽、双帧恢复、
 * 切章强制存 vs 同章防抖存、哨兵预取、目录直达重试，全住在 ReaderView 的 ref 协调里。
 */

const toc: ChapterEntry[] = [
  { name: '第一章', url: 'https://s.com/c/1' },
  { name: '第二章', url: 'https://s.com/c/2' },
  { name: '第三章', url: 'https://s.com/c/3' },
]

/** 可编程假 port：锚点/滚动/哨兵全由测试摆布 */
function fakePort() {
  const port = {
    anchors: [] as ChapterAnchor[],
    top: 0,
    height: 1000,
    scrollH: 5000,
    sentinel: null as number | null,
    chapterOff: null as number | null,
    measureAnchors: (): ChapterAnchor[] => port.anchors,
    scrollTop: (): number => port.top,
    setScrollTop: (px: number): void => { port.top = px },
    viewHeight: (): number => port.height,
    scrollHeight: (): number => port.scrollH,
    sentinelOffset: (): number | null => port.sentinel,
    chapterOffset: (): number | null => port.chapterOff,
  }
  return port
}

interface FakeHarness {
  session: ReaderSession
  port: ReturnType<typeof fakePort>
  fetched: number[]
  saves: Array<[number, number]>
  totals: number[]
}

function makeSession(opts?: {
  shelf?: ShelfBook[]
  chapters?: Record<number, string>
  failChapter?: number
  debounceMs?: number
}): FakeHarness {
  const port = fakePort()
  const fetched: number[] = []
  const saves: Array<[number, number]> = []
  const totals: number[] = []
  const deps: ReaderSessionDeps = {
    fetchToc: async () => toc,
    fetchChapter: async (_s, _b, i) => {
      fetched.push(i)
      if (opts?.failChapter === i) throw new Error(`第 ${i} 章拉取失败`)
      return opts?.chapters?.[i] ?? `正文${i}`
    },
    fetchShelf: async () => opts?.shelf ?? [],
    saveProgress: (i, r) => { saves.push([i, r]) },
    saveTotalChapters: (n) => { totals.push(n) },
    afterFrames: (cb) => cb(),                       // 测试：同步落定
  }
  return { session: new ReaderSession(deps, port, opts?.debounceMs ?? 20), port, fetched, saves, totals }
}

const shelfBook = (progress: ShelfBook['progress'], totalChapters?: number): ShelfBook => ({
  sourceId: 'src', bookKey: 'https://s.com/book/1', title: '斗罗',
  progress, addedAt: 0, ...(totalChapters === undefined ? {} : { totalChapters }),
})

describe('ReaderSession.open（目录 → 存档恢复 → 载后定位）', () => {
  it('无存档：从第 0 章开读', async () => {
    const h = makeSession()
    await h.session.open('src', 'https://s.com/book/1')
    expect(h.fetched).toEqual([0])
    expect(h.session.state.toc).toHaveLength(3)
  })

  it('有存档：恢复到存档章 + 比例，双帧后按锚点落滚动位', async () => {
    const h = makeSession({ shelf: [shelfBook({ chapterIndex: 2, offsetRatio: 0.5, updatedAt: 0 })] })
    h.port.anchors = [{ index: 2, start: 2000 }]
    h.port.scrollH = 5000; h.port.height = 1000
    await h.session.open('src', 'https://s.com/book/1')
    expect(h.fetched).toEqual([2])
    // anchorTop(anchors, 2, 0.5, scrollH=5000, viewH=1000) = 2000 + 0.5×(5000-1000-2000) = 3000
    expect(h.port.top).toBe(3000)
  })

  it('总章数回写：缺 totalChapters 才调；带则不调', async () => {
    const a = makeSession({ shelf: [shelfBook({ chapterIndex: 0, offsetRatio: 0, updatedAt: 0 })] })
    await a.session.open('src', 'https://s.com/book/1')
    expect(a.totals).toEqual([3])

    const b = makeSession({ shelf: [shelfBook({ chapterIndex: 0, offsetRatio: 0, updatedAt: 0 }, 3)] })
    await b.session.open('src', 'https://s.com/book/1')
    expect(b.totals).toEqual([])
  })

  it('目录拉失败 → error 进状态（视图渲染错误条）', async () => {
    const port = fakePort()
    const session = new ReaderSession({
      fetchToc: async () => { throw new Error('站点挂了') },
      fetchChapter: async () => '', fetchShelf: async () => [],
      saveProgress: () => {}, saveTotalChapters: () => {}, afterFrames: (cb) => cb(),
    }, port)
    await session.open('src', 'b')
    expect(session.state.error?.message).toContain('站点挂了')
  })
})

describe('ReaderSession.load（单在途槽）', () => {
  it('同章并发只拉一次（滚动风暴去重）', async () => {
    const h = makeSession()
    await h.session.open('src', 'https://s.com/book/1')
    h.fetched.length = 0
    await Promise.all([
      h.session.load('src', 1),
      h.session.load('src', 1),
      h.session.load('src', 2),        // 在途被占：这次直接短路
    ])
    expect(h.fetched).toEqual([1])
    expect(h.session.state.chapters[1]).toBe('正文1')
  })

  it('拉取失败 → error 状态 + 在途槽释放（下一章仍可拉）', async () => {
    const h = makeSession({ failChapter: 1 })
    await h.session.open('src', 'https://s.com/book/1')
    await h.session.load('src', 1)
    expect(h.session.state.error?.message).toContain('第 1 章拉取失败')
    await h.session.load('src', 2)
    expect(h.session.state.chapters[2]).toBe('正文2')
  })
})

describe('ReaderSession 进度落盘策略', () => {
  it('切章强制存（不等防抖）；同章滚动防抖存', async () => {
    const h = makeSession({ debounceMs: 20 })
    await h.session.open('src', 'https://s.com/book/1')
    h.port.anchors = [{ index: 0, start: 0 }, { index: 1, start: 1000 }, { index: 2, start: 2000 }]

    h.port.top = 1200                              // 进入第 1 章
    h.session.handleViewportChange('src')
    expect(h.saves).toEqual([[1, 0.2]])            // 立即存

    h.port.top = 1500                              // 同章内滚动
    h.session.handleViewportChange('src')
    expect(h.saves).toHaveLength(1)                // 防抖：还没落

    await new Promise((r) => setTimeout(r, 40))    // 防抖窗口过
    expect(h.saves).toEqual([[1, 0.2], [1, 0.5]])
  })

  it('dispose 把防抖窗口内的进度 flush 掉，不静默丢（离开阅读器即丢最后一段位置的回归钉）', async () => {
    const h = makeSession({ debounceMs: 5000 })     // 窗口拉长：让「未到期」成为确定前提
    await h.session.open('src', 'https://s.com/book/1')
    h.port.anchors = [{ index: 0, start: 0 }, { index: 1, start: 1000 }, { index: 2, start: 2000 }]
    h.port.top = 1200
    h.session.handleViewportChange('src')           // 切章：强制存
    h.port.top = 1500
    h.session.handleViewportChange('src')           // 同章滚动：挂防抖
    expect(h.saves).toEqual([[1, 0.2]])             // 5s 未到，确实还没落
    h.session.dispose()
    expect(h.saves).toEqual([[1, 0.2], [1, 0.5]])   // 退出即落盘（旧实现 cancel → 这行丢进度）
  })

  it('dispose 无待发进度 → 不造幽灵写口（flush 只在真有 pending 时发）', async () => {
    const h = makeSession({ debounceMs: 5000 })
    await h.session.open('src', 'https://s.com/book/1')
    h.session.dispose()
    expect(h.saves).toEqual([])
  })
})

describe('ReaderSession 预取与目录直达', () => {
  it('哨兵进预取区 → 拉下一未载章；读尽不动', async () => {
    const h = makeSession()
    await h.session.open('src', 'https://s.com/book/1')
    h.fetched.length = 0
    h.port.sentinel = 500                          // 视口高 1000 → 预取区内
    h.session.checkPreload('src')
    await new Promise((r) => setTimeout(r, 0))
    expect(h.fetched).toEqual([1])

    // 全载完后不再拉
    await h.session.load('src', 2)
    h.fetched.length = 0
    h.session.checkPreload('src')
    await new Promise((r) => setTimeout(r, 0))
    expect(h.fetched).toEqual([])
  })

  it('目录直达：未载先拉；渲染落地后定位并清 pendingJump', async () => {
    const h = makeSession()
    await h.session.open('src', 'https://s.com/book/1')
    h.port.top = 0
    h.session.requestJump('src', 2)
    expect(h.session.state.pendingJump).toBe(2)
    await new Promise((r) => setTimeout(r, 0))     // 拉完
    expect(h.session.state.chapters[2]).toBe('正文2')

    h.port.chapterOff = 300                        // 章块已在视口下 300px
    h.session.settleJump()
    expect(h.port.top).toBe(300)
    expect(h.session.state.pendingJump).toBeNull()
  })

  it('settleJump：章未渲染（chapterOffset=null）不动、不清——下轮再试', async () => {
    const h = makeSession()
    await h.session.open('src', 'https://s.com/book/1')
    h.session.requestJump('src', 2)
    h.port.chapterOff = null
    h.session.settleJump()
    expect(h.session.state.pendingJump).toBe(2)
    expect(h.port.top).toBe(0)
  })

   it('在途窗口内目录直达：在途收工后补拉目标章（点击不再无声消失）', async () => {
    const h = makeSession()
    await h.session.open('src', 'https://s.com/book/1')
    h.fetched.length = 0
    const inflight = h.session.load('src', 1)   // 占住在途槽
    h.session.requestJump('src', 2)             // 在途被占 → load 短路，只置 pendingJump
    expect(h.session.state.pendingJump).toBe(2)
    expect(h.fetched).toEqual([1])
    await inflight
    await new Promise((r) => setTimeout(r, 0))  // settlePendingLoad 补拉
    expect(h.fetched).toContain(2)
    expect(h.session.state.chapters[2]).toBe('正文2')
  })
})

 describe('ReaderSession 错误清除与重试', () => {
  it('retry 重拉失败章：成功即清 error（此前成功分支不清 error、视图 onRetry 还是空操作）', async () => {
    const port = fakePort()
    let fails = 1
    const session = new ReaderSession({
      fetchToc: async () => toc,
      fetchChapter: async (_s, _b, i) => {
        if (i === 1 && fails-- > 0) throw new Error('抖一下')
        return `正文${i}`
      },
      fetchShelf: async () => [], saveProgress: () => {}, saveTotalChapters: () => {}, afterFrames: (cb) => cb(),
    }, port)
    await session.open('src', 'b')
    await session.load('src', 1)
    expect(session.state.error?.message).toContain('抖一下')
    session.retry()
    await new Promise((r) => setTimeout(r, 0))
    expect(session.state.chapters[1]).toBe('正文1')
    expect(session.state.error).toBeNull()
  })

  it('进入（目录）失败 → retry 重开并清 error', async () => {
    const port = fakePort()
    let fails = 1
    const session = new ReaderSession({
      fetchToc: async () => { if (fails-- > 0) throw new Error('站点挂了'); return toc },
      fetchChapter: async () => '正文', fetchShelf: async () => [],
      saveProgress: () => {}, saveTotalChapters: () => {}, afterFrames: (cb) => cb(),
    }, port)
    await session.open('src', 'b')
    expect(session.state.error).not.toBeNull()
    session.retry()
    await new Promise((r) => setTimeout(r, 0))
    expect(session.state.error).toBeNull()
    expect(session.state.toc).toHaveLength(3)
  })
})
