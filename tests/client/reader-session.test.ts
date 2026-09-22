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
    h.port.anchors = [{ index: 2, start: 2000, height: 2000 }]
    h.port.scrollH = 5000; h.port.height = 1000
    await h.session.open('src', 'https://s.com/book/1')
    expect(h.fetched).toEqual([2])
    // anchorTop(anchors, 2, 0.5, scrollH=5000, viewH=1000) = start 2000 + 0.5×**该章高度** 2000 = 3000
    // （跨度取章自己的渲染高度，与 locateChapter 同源；再夹在可滚动范围 scrollH-viewH=4000 内）
    expect(h.port.top).toBe(3000)
  })

  it('进书：目录一发布就来的预取不许抢走存档恢复的在途槽', async () => {
    // 视图侧事实（ReaderView）：toc 一发布，[chapters] effect 立刻 recalcAnchors + checkPreload；
    // 此刻哨兵是正文里唯一元素、就在视口顶 → 预取目标 = 第 0 章。而存档章要等 fetchShelf
    // 回来才知道。这中间在途槽若被预取抢走，open() 的恢复 load 会半路静默短路
    // （`if (this.inflight !== null) return`）——整条恢复丢失，真机表现即「切走再回来变第一章」。
    const port = fakePort()
    const fetched: number[] = []
    let releaseShelf = (): void => {}
    const shelfPromise = new Promise<ShelfBook[]>((r) => {
      releaseShelf = () => r([shelfBook({ chapterIndex: 2, offsetRatio: 0, updatedAt: 0 })])
    })
    const session = new ReaderSession({
      fetchToc: async () => toc,
      // 正文永不落地：真机正文走网络（在途），而书架是本地读、先回来——正是这个先后出的问题
      fetchChapter: (_s, _b, i) => { fetched.push(i); return new Promise<string>(() => {}) },
      fetchShelf: () => shelfPromise,
      saveProgress: () => {}, saveTotalChapters: () => {}, afterFrames: (cb) => cb(),
    }, port)
    const opening = session.open('src', 'https://s.com/book/1')
    let primed = false
    const unsub = session.subscribe(() => {          // 视图 shim：等价 ReaderView 的 [chapters] effect
      if (primed || session.state.toc === null) return
      primed = true
      session.recalcAnchors()
      port.sentinel = 0                              // 哨兵在视口顶 = 预取区内
      session.checkPreload('src')
    })
    await new Promise((r) => setTimeout(r, 0))        // 目录发布 + 预取该发生的都发生了
    expect(fetched).toEqual([])                       // 旧实现 [0]：存档未落定就预取
    releaseShelf()
    await new Promise((r) => setTimeout(r, 0))
    expect(fetched).toEqual([2])                      // 旧实现仍 [0]：恢复被在途槽挡下、静默丢弃
    unsub()
    void opening                                      // 正文永不落地：open 不收敛，只验发起
  })

  it('进书：第 0 章的章内位置也算进度（存档 (0, 0.9) 要落回章内，不许当成「无存档」）', async () => {
    // 判据口径：第 0 章里的位置同样是「读过」。此前用手写条件 chapterIndex>0 判「有没有存档」，
    // 与书架卡片侧（算了比例）相反——读第 1 章的人进度永远恢复不了，且进书后视图那一次
    // 视口读数（0,0）会把存档抹平（真机存档被观测成 (0, 0.9999) → (0,0)）。
    const h = makeSession({ shelf: [shelfBook({ chapterIndex: 0, offsetRatio: 0.9, updatedAt: 1 })] })
    h.port.anchors = [{ index: 0, start: 0, height: 2000 }]
    h.port.scrollH = 3000; h.port.height = 1000
    await h.session.open('src', 'https://s.com/book/1')
    expect(h.fetched).toEqual([0])
    expect(h.port.top).toBeGreaterThan(0)          // 旧实现：0（恢复整条被丢）
  })

  it('进书：存档章越出目录（换源 / 目录变短 / 缓存重建）→ 落到最后一章，不许空白阅读器', async () => {
    const h = makeSession({ shelf: [shelfBook({ chapterIndex: 9, offsetRatio: 0.5, updatedAt: 1 })] })
    await h.session.open('src', 'https://s.com/book/1')
    expect(h.fetched).toEqual([2])                 // 目录 3 章：clamp 到 index 2
    expect(h.session.state.chapters[2]).toBe('正文2')
    expect(h.session.state.error).toBeNull()
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

  it('拉取失败 → error 状态 + 在途槽释放（同一章还能再发请求）', async () => {
    const h = makeSession({ failChapter: 1 })
    await h.session.open('src', 'https://s.com/book/1')
    h.fetched.length = 0
    await h.session.load('src', 1)
    expect(h.session.state.error?.message).toContain('第 1 章拉取失败')
    await h.session.load('src', 1)
    expect(h.fetched).toEqual([1, 1])       // 槽已释放：请求确实又发出去了
  })
})

describe('ReaderSession 进度落盘策略', () => {
  it('切章强制存（不等防抖）；同章滚动防抖存', async () => {
    const h = makeSession({ debounceMs: 20 })
    await h.session.open('src', 'https://s.com/book/1')
    h.port.anchors = [{ index: 0, start: 0, height: 1000 }, { index: 1, start: 1000, height: 1000 }, { index: 2, start: 2000, height: 1000 }]

    h.port.top = 1200                              // 进入第 1 章
    h.session.handleViewportChange('src')
    expect(h.saves).toEqual([[1, 0.2]])            // 立即存

    h.port.top = 1500                              // 同章内滚动
    h.session.handleViewportChange('src')
    expect(h.saves).toHaveLength(1)                // 防抖：还没落

    await new Promise((r) => setTimeout(r, 40))    // 防抖窗口过
    expect(h.saves).toEqual([[1, 0.2], [1, 0.5]])
  })

  it('切章强制存要作废同章防抖窗里的旧值（旧值迟到落盘 = 存档回退到上一章）', async () => {
    // 真机链路：同章滚动挂起一次防抖存 → 用户从目录直达后面的章（跨章强制存）
    // → 2s 后那条旧值才到期落盘，把刚存下的新章覆盖回旧章。
    // 用户侧症状：存档永远停在「跳章前的章」，再进就是那一章（真机存档被观测成
    // 跳章前的 (0, ~1.0)——同一条迟到写）。
    const h = makeSession({ debounceMs: 40 })
    await h.session.open('src', 'https://s.com/book/1')
    h.port.anchors = [{ index: 0, start: 0, height: 1000 }, { index: 1, start: 1000, height: 1000 }, { index: 2, start: 2000, height: 1000 }, { index: 3, start: 3000, height: 1000 }]
    h.port.top = 1500
    h.session.handleViewportChange('src')            // 跨到第 1 章：强制存
    expect(h.saves).toEqual([[1, 0.5]])

    h.port.top = 1600
    h.session.handleViewportChange('src')            // 同章滚动：挂防抖
    expect(h.saves).toHaveLength(1)

    h.port.top = 2500
    h.session.handleViewportChange('src')            // 目录到第 2 章：跨章强制存
    expect(h.saves).toEqual([[1, 0.5], [2, 0.5]])

    await new Promise((r) => setTimeout(r, 80))      // 防抖窗口过：旧值不该再落一次
    expect(h.saves).toEqual([[1, 0.5], [2, 0.5]])    // 旧实现多一条 [1, 0.6]——存档被旧值覆盖
  })

  it('dispose 把防抖窗口内的进度 flush 掉，不静默丢（离开阅读器即丢最后一段位置的回归钉）', async () => {
    const h = makeSession({ debounceMs: 5000 })     // 窗口拉长：让「未到期」成为确定前提
    await h.session.open('src', 'https://s.com/book/1')
    h.port.anchors = [{ index: 0, start: 0, height: 1000 }, { index: 1, start: 1000, height: 1000 }, { index: 2, start: 2000, height: 1000 }]
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

  it('目录直达：选中的章立刻落盘（章还在途、视口没动就切走，回来必须还在那一章）', async () => {
    // 选定章之前，落盘只有两个入口：handleViewportChange（要视口真的滚过）与 dispose 的 flush
    // （只补发防抖窗里的待发值）。目录跳章两者都不占——真机症状：目录选第 N 章后立刻切会话，
    // 回来仍在原处（无头实测：正文确实取回来了，存档一个字节没动）。
    const h = makeSession({ debounceMs: 5000 })      // 窗口拉长：证明这一笔不是防抖顺带落的
    await h.session.open('src', 'https://s.com/book/1')
    expect(h.saves).toEqual([])
    h.session.requestJump('src', 2)                  // 目录选第 3 章（未载 → 在途）
    expect(h.saves).toEqual([[2, 0]])                // 旧实现 []：导航意图零落盘
    await new Promise((r) => setTimeout(r, 0))       // 章到货
    h.session.dispose()                              // 用户此刻切走
    expect(h.saves).toEqual([[2, 0]])                // 那一笔就是最终存档
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

  it('倒退跳章：已载集裁到视口所在连续区间（正文顺序不许串章）', async () => {
    // 真机实测：跳 50 再跳回 10，DOM 里渲染的是 [0, 10, 50]——未载章不进 DOM，缺的章被跳过，
    // 用户读完第 11 章紧接的是第 51 章。预取也跟着视口走（旧口径取到 51 而非 11）。
    const many: ChapterEntry[] = Array.from({ length: 60 }, (_, i) => ({ name: `第${i + 1}章`, url: `https://s.com/c/${i}` }))
    const port = fakePort()
    const session = new ReaderSession({
      fetchToc: async () => many,
      fetchChapter: async (_s, _b, i) => `正文${i}`,
      fetchShelf: async () => [], saveProgress: () => {}, saveTotalChapters: () => {},
      afterFrames: (cb) => cb(),
    }, port, 5)
    await session.open('src', 'b')
    await new Promise((r) => setTimeout(r, 0))
    session.requestJump('src', 50)
    await new Promise((r) => setTimeout(r, 0))
    session.requestJump('src', 10)
    await new Promise((r) => setTimeout(r, 0))
    const loaded = session.state.chapters.map((c, i) => (c === null ? null : i)).filter((x) => x !== null)
    expect(loaded).toEqual([10])                 // 旧实现 [0, 10, 50]
    expect(session.state.currentChapter).toBe(10)
  })

  it('目录跳章在途时的视口读数不许推翻导航命令', async () => {
    // 实测（真机复现台）：跳第 20 章后、正文还没到，一次视口读数把位置改回第 1 章——
    // 接着刚到的第 20 章被「窗口跟着视口走」裁掉，用户看到的还是第 1 章。
    // 在途期间视口读数只是「旧位置」的证据，不该压过用户刚下的导航命令。
    const h = makeSession()
    await h.session.open('src', 'https://s.com/book/1')
    h.port.anchors = [{ index: 0, start: 0, height: 1000 }]     // 只有旧章在 DOM（新章在途）
    h.port.top = 100
    h.session.requestJump('src', 2)
    expect(h.session.state.pendingJump).toBe(2)
    h.session.handleViewportChange('src')
    expect(h.session.state.currentChapter).toBe(2)              // 旧实现：被读数改回 0
    expect(h.session.state.pendingJump).toBe(2)
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

 describe('ReaderSession 默认防抖窗口', () => {
  it('生产默认 2s：滚动读数不当场落，到点才落（用例都显式传窗口，默认值只在这里钉）', async () => {
    const port = fakePort()
    const saves: Array<[number, number]> = []
    // 第三个参数不传 = 生产默认（2000ms）——所有别的用例都显式传窗口，改默认值无一物变红
    const session = new ReaderSession({
      fetchToc: async () => toc,
      fetchChapter: async (_s, _b, i) => `正文${i}`,
      fetchShelf: async () => [],
      saveProgress: (i, r) => { saves.push([i, r]) },
      saveTotalChapters: () => {},
      afterFrames: (cb) => cb(),
    }, port)
    // 只假造 setTimeout：微任务与 Date 留真（否则 await 会卡在假定时器上）
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      await session.open('src', 'https://s.com/book/1')
      port.anchors = [{ index: 0, start: 0, height: 3000 }]
      port.top = 1500
      session.handleViewportChange('src')          // 同章滚动 → scroll 原因 → 走防抖
      expect(saves).toEqual([])                    // 连续量不当场落
      vi.advanceTimersByTime(1999)
      expect(saves).toEqual([])
      vi.advanceTimersByTime(1)
      expect(saves).toEqual([[0, 0.5]])            // 窗口就是 2000ms
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('ReaderSession 跳章失败（位置回退 + 不自动重试）', () => {
  it('失败即把位置退回视口：未渲染的章不许留在存档里', async () => {
    // `requestJump` 是「选中即落盘」，所以那一刻存档已经写成第 2 章——而第 2 章从没渲染过。
    // 旧实现只清 pendingJump，位置仍停在 2：退出后再进来会照着它恢复，预取也一直瞄着它。
    const h = makeSession({ failChapter: 2, debounceMs: 5000 })
    await h.session.open('src', 'https://s.com/book/1')
    h.port.anchors = [{ index: 0, start: 0, height: 3000 }]
    h.port.top = 0
    h.fetched.length = 0
    h.session.requestJump('src', 2)
    await new Promise((r) => setTimeout(r, 0))
    expect(h.fetched).toEqual([2])
    expect(h.session.state.error?.message).toContain('第 2 章拉取失败')
    expect(h.session.state.currentChapter).toBe(0)      // 旧实现：2
    expect(h.saves).toEqual([[2, 0], [0, 0]])           // 存档被纠正回视口章
  })

  it('失败章不被预取自动重试（等用户点重试，与 settlePendingLoad 同一条纪律）', async () => {
    const h = makeSession({ failChapter: 2 })
    await h.session.open('src', 'https://s.com/book/1')
    await h.session.load('src', 1)                       // 视口章之后只剩第 2 章这个空洞
    h.port.anchors = [{ index: 0, start: 0, height: 3000 }]
    h.port.top = 0
    h.port.sentinel = 0                                  // 哨兵进预取区
    h.fetched.length = 0
    h.session.requestJump('src', 2)
    await new Promise((r) => setTimeout(r, 0))
    expect(h.fetched).toEqual([2])
    h.session.checkPreload('src')
    await new Promise((r) => setTimeout(r, 0))
    expect(h.fetched).toEqual([2])                       // 旧实现：[2, 2]
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
