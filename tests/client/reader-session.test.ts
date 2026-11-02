import { afterEach, describe, expect, it, vi } from 'vitest'
import { planarNavigation } from '../../src/shared/wire.js'
import { ReaderSession } from '../../src/client/reader-session.js'
import type { ReaderSessionDeps, ReaderViewportFeed, VisibleNode } from '../../src/client/reader-session.js'
import type { ChapterAnchor } from '../../src/client/progress.js'
import { DEFAULT_PREFS, setPref } from '../../src/client/store.js'
import type { ChapterContent, ChapterEntry, NavigationItem, ShelfBook } from '../../src/client/views/types.js'
import { last, must, pick } from '../support/fixture.js'

/**
 * 阅读会话的时序测试：在途槽、双帧恢复、切章强制存 vs 同章防抖存、哨兵预取、目录直达重试，
 * 全部在这里钉死——这些时序只管会话，视图不另存一份。
 */

const toc: ChapterEntry[] = [
  { name: '第一章', url: 'https://s.com/c/1' },
  { name: '第二章', url: 'https://s.com/c/2' },
  { name: '第三章', url: 'https://s.com/c/3' },
]

/** 文字章正文（会话不关心形态：它只搬 ChapterContent） */
const text = (i: number): ChapterContent => ({ kind: 'text', text: `正文${i}` })

/** 可编程假 port：锚点/滚动/哨兵/目标测量全由测试摆布 */
function fakePort() {
  const port = {
    anchors: [] as ChapterAnchor[],
    top: 0,
    height: 1000,
    scrollH: 5000,
    sentinel: null as number | null,
    /** 章块顶相对视口顶的偏移（`targetOffset(index, null)` 的读数） */
    chapterOff: null as number | null,
    /** 锚点/节点 ID → 相对视口顶的偏移；未登记 = 该节点不在 DOM → null */
    targetOffs: new Map<string, number>(),
    /** 视口顶所在正文节点（返回栈采点与排版复位共用） */
    node: null as VisibleNode | null,
    /** currentNode 读取计数：排版前采点必须发生在 setPref 的同步栈里，退订后不再读 */
    nodeReads: 0,
    /** setScrollTop 历史（证明「不许落位」的用例：一次都不许发生） */
    tops: [] as number[],
    measureAnchors: (): ChapterAnchor[] => port.anchors,
    scrollTop: (): number => port.top,
    setScrollTop: (px: number): void => { port.top = px; port.tops.push(px) },
    viewHeight: (): number => port.height,
    scrollHeight: (): number => port.scrollH,
    sentinelOffset: (): number | null => port.sentinel,
    targetOffset: (_index: number, anchorId: string | null): number | null =>
      (anchorId === null ? port.chapterOff : (port.targetOffs.get(anchorId) ?? null)),
    /** 批量口径 = 逐个读数（会话侧只钉「一批候选都拿到」，真实索引实现归 reader-geometry.test.ts） */
    targetOffsets: (index: number, anchorIds: ReadonlyArray<string | null>): Array<number | null> =>
      anchorIds.map((anchorId) => port.targetOffset(index, anchorId)),
    currentNode: (): VisibleNode | null => { port.nodeReads++; return port.node },
  }
  return port
}

/** 手动帧泵：`flush()` 按登记顺序跑掉挂起帧；`cancelled` 记 cancelFrame 收到的句柄 */
function makeFramePump(): {
  feed: ReaderViewportFeed
  pending: () => number
  flush: () => void
  cancelled: number[]
  refreshCount: () => number
} {
  const queue = new Map<number, () => void>()
  const cancelled: number[] = []
  let nextHandle = 1
  let refreshes = 0
  return {
    feed: {
      scheduleFrame: (cb) => { const h = nextHandle++; queue.set(h, cb); return h },
      cancelFrame: (h) => { cancelled.push(h); queue.delete(h) },
      refreshPort: () => { refreshes++ },
    },
    pending: () => queue.size,
    flush: () => {
      const cbs = [...queue.values()]
      queue.clear()
      for (const cb of cbs) cb()
    },
    cancelled,
    refreshCount: () => refreshes,
  }
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
  /** 书架读不到（抛）：在架读数必须停在 'unknown' 而不是假装「不在架上」 */
  shelfError?: boolean
  chapters?: Record<number, string>
  /** 目录展示树（缺省 = 由线性目录派生的平面导航） */
  navigation?: NavigationItem[]
  failChapter?: number
  debounceMs?: number
  /** 视口帧调度（缺省不传 = 会话的立即执行缺省，与既有内联 deps 同口径） */
  viewport?: ReaderViewportFeed
}): FakeHarness {
  const port = fakePort()
  const fetched: number[] = []
  const saves: Array<[number, number]> = []
  const totals: number[] = []
  const deps: ReaderSessionDeps = {
    fetchNavigation: async () => ({ chapters: toc, items: opts?.navigation ?? planarNavigation(toc) }),
    fetchChapter: async (_s, _b, i) => {
      fetched.push(i)
      if (opts?.failChapter === i) throw new Error(`第 ${i} 章拉取失败`)
      return { kind: 'text', text: opts?.chapters?.[i] ?? `正文${i}` }
    },
    fetchShelf: async () => {
      if (opts?.shelfError) throw new Error('书架拉不到')
      return opts?.shelf ?? []
    },
    saveProgress: (i, r) => { saves.push([i, r]) },
    saveTotalChapters: (n) => { totals.push(n) },
    afterFrames: (cb) => cb(),                       // 测试：同步落定
    // 缺省不建这个键：`ReaderSessionDeps.viewport` 是「缺席走缺省」的契约（`?? IMMEDIATE_VIEWPORT_FEED`），
    // 不拿显式 undefined 冒充缺席。
    ...(opts?.viewport === undefined ? {} : { viewport: opts.viewport }),
  }
  return { session: new ReaderSession(deps, port, opts?.debounceMs ?? 20), port, fetched, saves, totals }
}

/** 手动控制的正文 promise（「目标还在途」这类竞态用例要它） */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
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

  // 在架读数三态（视图据此决定离开那一跳要不要问一句「要不要加入书架」）：它是上面那次存档
  // 查询的副产品，不是第二次请求。书架拉不到停在 'unknown'——**不知道不等于没有**，不许据此拦用户。
  it('在架读数：架上 / 不在架 / 书架拉不到', async () => {
    const on = makeSession({ shelf: [shelfBook({ chapterIndex: 0, offsetRatio: 0, updatedAt: 0 })] })
    await on.session.open('src', 'https://s.com/book/1')
    expect(on.session.onShelf).toBe('on')

    const off = makeSession({ shelf: [] })
    await off.session.open('src', 'https://s.com/book/1')
    expect(off.session.onShelf).toBe('off')

    const unknown = makeSession({ shelfError: true })
    await unknown.session.open('src', 'https://s.com/book/1')
    expect(unknown.session.onShelf).toBe('unknown')      // 拉不到照样进得去，不阻断阅读
    expect(unknown.fetched).toEqual([0])
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

  it('存档恢复的双帧落位之前，旧视口读数不许触发回溯补载', async () => {
    const port = fakePort()
    port.anchors = [{ index: 2, start: 2000, height: 2000 }]
    port.height = 1000
    port.scrollH = 8000
    port.top = 0
    const frames: Array<() => void> = []
    const fetched: number[] = []
    const session = new ReaderSession({
      fetchNavigation: async () => ({ chapters: toc, items: planarNavigation(toc) }),
      fetchChapter: async (_s, _b, i) => { fetched.push(i); return text(i) },
      fetchShelf: async () => [shelfBook({ chapterIndex: 2, offsetRatio: 0.5, updatedAt: 0 })],
      saveProgress: () => {}, saveTotalChapters: () => {},
      afterFrames: (cb) => { frames.push(cb) },
    }, port)
    await session.open('src', 'https://s.com/book/1')
    expect(fetched).toEqual([2])
    session.handleViewportChange('src')                    // 落位前的旧视口（top 仍是进入前的 0）
    await new Promise((r) => setTimeout(r, 0))
    expect(fetched, '恢复落位前的旧视口不是补载证据').toEqual([2])
    while (frames.length > 0) must(frames.shift(), '待跑的双帧')()            // 跑完双帧：落位
    expect(port.top).toBe(3000)
    session.handleViewportChange('src')                    // 落位后的真实视口才开始判断补载
    await new Promise((r) => setTimeout(r, 0))
    expect(fetched).toContain(1)
  })

  it('空目录 + 有存档比例：恢复载入根本不发生，闸不许把会话钉在「等待落位」里', async () => {
    // 空目录 → 没有可恢复的章，`load` 直接返回、双帧落位永不发生。`restoring` 若照落真，
    // 此后每次视口读数都在 `handleViewportChange` 顶部被吞：预取、位置提交与补载全停，
    // 会话对滚动彻底失聪（且不报任何错）。
    const port = fakePort()
    let measures = 0
    port.measureAnchors = () => { measures++; return port.anchors }
    const fetched: number[] = []
    const session = new ReaderSession({
      fetchNavigation: async () => ({ chapters: [], items: [] }),
      fetchChapter: async (_s, _b, i) => { fetched.push(i); return text(i) },
      fetchShelf: async () => [shelfBook({ chapterIndex: 0, offsetRatio: 0.5, updatedAt: 0 })],
      saveProgress: () => {}, saveTotalChapters: () => {},
      afterFrames: (cb) => cb(),
    }, port)
    await session.open('src', 'https://s.com/book/1')
    expect(fetched, '空目录没有任何章可载').toEqual([])
    expect(session.state.currentChapter, '位置停在 0，不是越界夹出来的 -1').toBe(0)
    session.handleViewportChange('src', { layoutChanged: true })
    expect(measures, '视口读数照常处理（读被吞 = 会话已失聪）').toBe(1)
  })

  it('负下标存档（手改过的落盘元数据）：夹回第 0 章照常载入', async () => {
    // clamp 只朝「越界」一侧做就会把 -5 原样交给 `load`（早退 = 同样的空转）。两头都要夹。
    const port = fakePort()
    const fetched: number[] = []
    const session = new ReaderSession({
      fetchNavigation: async () => ({ chapters: toc, items: planarNavigation(toc) }),
      fetchChapter: async (_s, _b, i) => { fetched.push(i); return text(i) },
      fetchShelf: async () => [shelfBook({ chapterIndex: -5, offsetRatio: 0.5, updatedAt: 0 })],
      saveProgress: () => {}, saveTotalChapters: () => {},
      afterFrames: (cb) => cb(),
    }, port)
    await session.open('src', 'https://s.com/book/1')
    expect(fetched).toEqual([0])
  })

  it('进书：目录一发布就来的预取不许抢走存档恢复的在途槽', async () => {
    // 视图侧事实：toc 一发布就 afterRender，此刻哨兵在视口顶 → 预取目标 = 第 0 章，
    // 而存档章要等 fetchShelf 回来才知道。在途槽若被预取抢走，open() 的恢复 load 会半路静默短路
    // （`if (this.inflight !== null) return`）——真机表现即「切走再回来变第一章」。
    const port = fakePort()
    const fetched: number[] = []
    let releaseShelf = (): void => {}
    const shelfPromise = new Promise<ShelfBook[]>((r) => {
      releaseShelf = () => r([shelfBook({ chapterIndex: 2, offsetRatio: 0, updatedAt: 0 })])
    })
    const session = new ReaderSession({
      fetchNavigation: async () => ({ chapters: toc, items: planarNavigation(toc) }),
      // 正文永不落地：真机正文走网络（在途），而书架是本地读、先回来——正是这个先后出的问题
      fetchChapter: (_s, _b, i) => { fetched.push(i); return new Promise<ChapterContent>(() => {}) },
      fetchShelf: () => shelfPromise,
      saveProgress: () => {}, saveTotalChapters: () => {}, afterFrames: (cb) => cb(),
    }, port)
    const opening = session.open('src', 'https://s.com/book/1')
    let primed = false
    const unsub = session.subscribe(() => {          // 视图 shim：等价 ReaderView 的渲染后拍点 effect
      if (primed || session.state.toc === null) return
      primed = true
      port.sentinel = 0                              // 哨兵在视口顶 = 预取区内
      session.afterRender('src')
    })
    await new Promise((r) => setTimeout(r, 0))        // 目录发布 + 预取该发生的都发生了
    expect(fetched).toEqual([])                       // 回归：存档未落定不得预取
    releaseShelf()
    await new Promise((r) => setTimeout(r, 0))
    expect(fetched).toEqual([2])                      // 回归：恢复不得被在途槽挡下丢弃
    unsub()
    void opening                                      // 正文永不落地：open 不收敛，只验发起
  })

  it('进书：第 0 章的章内位置也算进度（存档 (0, 0.9) 要落回章内，不许当成「无存档」）', async () => {
    // 判据口径：第 0 章里的位置同样是「读过」，存档有无不看 chapterIndex>0——否则读第 1 章的
    // 进度永远恢复不了，进书后那次视口读数（0,0）还会把存档抹平（真机观测：(0, 0.9999) → (0,0)）。
    const h = makeSession({ shelf: [shelfBook({ chapterIndex: 0, offsetRatio: 0.9, updatedAt: 1 })] })
    h.port.anchors = [{ index: 0, start: 0, height: 2000 }]
    h.port.scrollH = 3000; h.port.height = 1000
    await h.session.open('src', 'https://s.com/book/1')
    expect(h.fetched).toEqual([0])
    expect(h.port.top).toBeGreaterThan(0)          // 回归：恢复不得整条被丢（落点在章顶）
  })

  it('进书：存档章越出目录（换源 / 目录变短 / 缓存重建）→ 落到最后一章，不许空白阅读器', async () => {
    const h = makeSession({ shelf: [shelfBook({ chapterIndex: 9, offsetRatio: 0.5, updatedAt: 1 })] })
    await h.session.open('src', 'https://s.com/book/1')
    expect(h.fetched).toEqual([2])                 // 目录 3 章：clamp 到 index 2
    expect(h.session.state.chapters[2]).toEqual(text(2))
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
      fetchNavigation: async () => { throw new Error('站点挂了') },
      fetchChapter: async () => text(0), fetchShelf: async () => [],
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
    expect(h.session.state.chapters[1]).toEqual(text(1))
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
    // 真机链路：同章滚动挂起防抖存 → 目录直达后面的章（跨章强制存）→ 旧值迟到落盘覆盖回旧章。
    // 用户侧症状：存档永远停在「跳章前的章」（真机观测到的正是这条迟到写）。
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
    expect(h.saves).toEqual([[1, 0.5], [2, 0.5]])    // 回归：防抖到期不得再落一笔被覆盖的旧值
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
    expect(h.saves).toEqual([[1, 0.2], [1, 0.5]])   // 退出即落盘：dispose 必须 flush，cancel 会丢这一笔
  })

  it('dispose 无待发进度 → 不造幽灵写口（flush 只在真有 pending 时发）', async () => {
    const h = makeSession({ debounceMs: 5000 })
    await h.session.open('src', 'https://s.com/book/1')
    h.session.dispose()
    expect(h.saves).toEqual([])
  })

  it('滚动只量一次锚点；布局变化才重测', async () => {
    const h = makeSession({ debounceMs: 5000 })
    const measure = vi.spyOn(h.port, 'measureAnchors')
    await h.session.open('src', 'https://s.com/book/1')
    h.port.anchors = [{ index: 0, start: 0, height: 3000 }]
    h.port.top = 1200
    h.session.handleViewportChange('src')
    expect(measure).toHaveBeenCalledTimes(1)
    h.port.top = 1500
    h.session.handleViewportChange('src')
    expect(measure).toHaveBeenCalledTimes(1)
    h.session.handleViewportChange('src', { layoutChanged: true })
    expect(measure).toHaveBeenCalledTimes(2)
    h.session.dispose()
  })

  it('新章载入换了已载表：下一次滚动即使未标 layoutChanged 也重测锚点', async () => {
    const h = makeSession({ debounceMs: 5000 })
    await h.session.open('src', 'https://s.com/book/1')
    h.port.anchors = [{ index: 0, start: 0, height: 1000 }]
    h.port.top = 10
    h.session.handleViewportChange('src')         // 首次：已载表还没量过
    const measure = vi.spyOn(h.port, 'measureAnchors')
    h.port.anchors = [
      { index: 0, start: 0, height: 1000 },
      { index: 1, start: 1000, height: 1000 },
    ]
    await h.session.load('src', 1)                // 新章载入 → 已载表换版本
    h.session.handleViewportChange('src')         // 纯滚动：过期来自载入，不是滚动
    expect(measure).toHaveBeenCalledTimes(1)
    h.session.dispose()
  })

  it('提交之前来的那帧滚动，不吃掉渲染后拍点的重测', async () => {
    const h = makeSession({ debounceMs: 5000 })
    await h.session.open('src', 'https://s.com/book/1')
    h.session.afterRender('src')
    const measure = vi.spyOn(h.port, 'measureAnchors')
    await h.session.load('src', 1)                // 到货：store 已写新表，React 还没提交
    h.session.handleViewportChange('src')         // 这一帧量到的是还没有新章块的 DOM
    expect(measure).toHaveBeenCalledTimes(1)
    h.session.afterRender('src')                  // 提交后的拍点必须再量一次，否则锚点停在旧表
    expect(measure).toHaveBeenCalledTimes(2)
    h.session.handleViewportChange('src')         // 之后纯滚动只读缓存
    expect(measure).toHaveBeenCalledTimes(2)
    h.session.dispose()
  })
})

describe('ReaderSession 预取与目录直达', () => {
  it('哨兵进预取区 → 拉下一未载章；读尽不动', async () => {
    const h = makeSession()
    await h.session.open('src', 'https://s.com/book/1')
    h.fetched.length = 0
    h.port.sentinel = 500                          // 视口高 1000 → 预取区内
    h.session.afterRender('src')
    await new Promise((r) => setTimeout(r, 0))
    expect(h.fetched).toEqual([1])

    // 全载完后不再拉
    await h.session.load('src', 2)
    h.fetched.length = 0
    h.session.afterRender('src')
    await new Promise((r) => setTimeout(r, 0))
    expect(h.fetched).toEqual([])
  })

  it('afterRender：一次完成落位与预取', async () => {
    const h = makeSession()
    await h.session.open('src', 'https://s.com/book/1')
    h.fetched.length = 0
    h.port.anchors = [{ index: 0, start: 0, height: 1000 }, { index: 1, start: 1000, height: 1000 }]
    h.port.chapterOff = 0
    h.port.sentinel = 0
    h.session.requestJump('src', 1)
    await new Promise((r) => setTimeout(r, 0))
    h.fetched.length = 0
    h.session.afterRender('src')
    await new Promise((r) => setTimeout(r, 0))
    expect(h.session.state.pendingJump).toBeNull()
    expect(h.fetched).toEqual([2])     // 落位在第 1 章后，预取目标是第 2 章
  })

  it('目录直达：未载先拉；渲染落地后定位并清 pendingJump', async () => {
    const h = makeSession()
    await h.session.open('src', 'https://s.com/book/1')
    h.port.top = 0
    h.session.requestJump('src', 2)
    expect(h.session.state.pendingJump).toMatchObject({ index: 2, anchorId: null })
    await new Promise((r) => setTimeout(r, 0))     // 拉完
    expect(h.session.state.chapters[2]).toEqual(text(2))

    h.port.chapterOff = 300                        // 章块已在视口下 300px
    h.session.afterRender('src')
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
    expect(h.saves).toEqual([[2, 0]])                // 回归：导航意图必须当场落一笔
    await new Promise((r) => setTimeout(r, 0))       // 章到货
    h.session.dispose()                              // 用户此刻切走
    expect(h.saves).toEqual([[2, 0]])                // 那一笔就是最终存档
  })

  it('afterRender：章未渲染（targetOffset 给 null）不动、不清——下轮再试', async () => {
    const h = makeSession()
    await h.session.open('src', 'https://s.com/book/1')
    h.session.requestJump('src', 2)
    h.port.chapterOff = null
    h.session.afterRender('src')
    expect(h.session.state.pendingJump).toMatchObject({ index: 2 })
    expect(h.port.top).toBe(0)
  })

  it('倒退跳章：已载集裁到视口所在连续区间（正文顺序不许串章）', async () => {
    // 真机实测：跳 50 再跳回 10，DOM 里渲染的是 [0, 10, 50]——未载章不进 DOM，缺的章被跳过，
    // 用户读完第 11 章紧接的是第 51 章。预取跟着视口走，不跟最大已载章（否则会取到 51）。
    const many: ChapterEntry[] = Array.from({ length: 60 }, (_, i) => ({ name: `第${i + 1}章`, url: `https://s.com/c/${i}` }))
    const port = fakePort()
    const session = new ReaderSession({
      fetchNavigation: async () => ({ chapters: many, items: planarNavigation(many) }),
      fetchChapter: async (_s, _b, i) => text(i),
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
    expect(loaded).toEqual([10])                 // 回归：已载集只留视口所在的连续区间
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
    expect(h.session.state.pendingJump).toMatchObject({ index: 2 })
    h.session.handleViewportChange('src')
    expect(h.session.state.currentChapter).toBe(2)              // 回归：视口读数不得推翻在途导航命令
    expect(h.session.state.pendingJump).toMatchObject({ index: 2 })
  })

   it('在途窗口内目录直达：在途收工后补拉目标章（点击不再无声消失）', async () => {
    const h = makeSession()
    await h.session.open('src', 'https://s.com/book/1')
    h.fetched.length = 0
    const inflight = h.session.load('src', 1)   // 占住在途槽
    h.session.requestJump('src', 2)             // 在途被占 → load 短路，只置 pendingJump
    expect(h.session.state.pendingJump).toMatchObject({ index: 2 })
    expect(h.fetched).toEqual([1])
    await inflight
    await new Promise((r) => setTimeout(r, 0))  // settlePendingLoad 补拉
    expect(h.fetched).toContain(2)
    expect(h.session.state.chapters[2]).toEqual(text(2))
  })
})

 describe('ReaderSession 默认防抖窗口', () => {
  it('生产默认 2s：滚动读数不当场落，到点才落（用例都显式传窗口，默认值只在这里钉）', async () => {
    const port = fakePort()
    const saves: Array<[number, number]> = []
    // 第三个参数不传 = 生产默认（2000ms）——所有别的用例都显式传窗口，改默认值无一物变红
    const session = new ReaderSession({
      fetchNavigation: async () => ({ chapters: toc, items: planarNavigation(toc) }),
      fetchChapter: async (_s, _b, i) => text(i),
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
    // 回归钉子：失败即把位置退回视口，存档不留未渲染的章——否则退出后照着它恢复，预取也一直瞄着它。
    const h = makeSession({ failChapter: 2, debounceMs: 5000 })
    await h.session.open('src', 'https://s.com/book/1')
    h.port.anchors = [{ index: 0, start: 0, height: 3000 }]
    h.port.top = 0
    h.fetched.length = 0
    h.session.requestJump('src', 2)
    await new Promise((r) => setTimeout(r, 0))
    expect(h.fetched).toEqual([2])
    expect(h.session.state.error?.message).toContain('第 2 章拉取失败')
    expect(h.session.state.currentChapter).toBe(0)      // 回归：失败章不得留在 currentChapter
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
    h.session.afterRender('src')
    await new Promise((r) => setTimeout(r, 0))
    expect(h.fetched).toEqual([2])                       // 回归：失败章等用户重试，预取不得自拉
  })
})

describe('ReaderSession 错误清除与重试', () => {
  it('retry 重拉失败章：成功即清 error（此前成功分支不清 error、视图 onRetry 还是空操作）', async () => {
    const port = fakePort()
    let fails = 1
    const session = new ReaderSession({
      fetchNavigation: async () => ({ chapters: toc, items: planarNavigation(toc) }),
      fetchChapter: async (_s, _b, i) => {
        if (i === 1 && fails-- > 0) throw new Error('抖一下')
        return text(i)
      },
      fetchShelf: async () => [], saveProgress: () => {}, saveTotalChapters: () => {}, afterFrames: (cb) => cb(),
    }, port)
    await session.open('src', 'b')
    await session.load('src', 1)
    expect(session.state.error?.message).toContain('抖一下')
    session.retry()
    await new Promise((r) => setTimeout(r, 0))
    expect(session.state.chapters[1]).toEqual(text(1))
    expect(session.state.error).toBeNull()
  })

  it('进入（目录）失败 → retry 重开并清 error', async () => {
    const port = fakePort()
    let fails = 1
    const session = new ReaderSession({
      fetchNavigation: async () => { if (fails-- > 0) throw new Error('站点挂了'); return { chapters: toc, items: planarNavigation(toc) } },
      fetchChapter: async () => text(0), fetchShelf: async () => [],
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

describe('ReaderSession 锚点跳转（待定位目标 = 章号 + 锚点 + 节点内偏移）', () => {
  it('进书就带上目录树：toc 留线性列表，navigation 收展示树（两者不是同一口径）', async () => {
    const items: NavigationItem[] = [
      {
        id: 'g1', label: '第一卷', target: null,
        children: [
          { id: 'n1', label: '第一章（上）', target: { kind: 'chapter', index: 0, anchorId: 'a1' }, children: [] },
          { id: 'n2', label: '第一章（下）', target: { kind: 'chapter', index: 0, anchorId: 'a2' }, children: [] },
        ],
      },
    ]
    const h = makeSession({ navigation: items })
    await h.session.open('src', 'https://s.com/book/1')
    expect(h.session.state.toc).toHaveLength(3)          // 线性阅读序列（进度/导出按它）
    expect(h.session.state.navigation).toEqual(items)    // 展示树（同一 XHTML 的两个锚点是两条）
  })

  it('同章两个锚点：各自落到自己的锚点，并按落位后的真实比例补一笔（不落到章首）', async () => {
    // 目标章已挂在 DOM 里（同章情形），两次跳转都在同一章内 → 走的是既有的落位路径，
    // 没有第二套加载循环；区别只是待定位目标多带一个锚点。
    const h = makeSession()
    await h.session.open('src', 'https://s.com/book/1')
    h.port.anchors = [{ index: 0, start: 0, height: 3000 }]
    h.port.targetOffs.set('a1', 400)
    h.port.targetOffs.set('a2', 800)

    h.session.requestJump('src', 0, 'a1')
    h.session.afterRender('src')
    expect(h.port.top).toBe(400)                          // 锚点落在视口顶（不是章首 0）
    expect(h.saves).toHaveLength(2)                       // 意图即时落 + 落位后真实比例
    expect(h.saves[0]).toEqual([0, 0])
    expect(pick(h.saves, 1)[0]).toBe(0)
    expect(pick(h.saves, 1)[1]).toBeCloseTo(400 / 3000)   // 不钉裸浮点字面量（同文件邻近用例都是 toBeCloseTo）

    h.port.targetOffs.set('a2', 800)                      // a2 在绝对 1200（此刻视口在 400）
    h.session.requestJump('src', 0, 'a2')
    h.session.afterRender('src')
    expect(h.port.top).toBe(1200)
    expect(h.saves[2]).toEqual([0, 0])
    expect(pick(h.saves, 3)[0]).toBe(0)
    expect(pick(h.saves, 3)[1]).toBeCloseTo(0.4)          // 1200 / 3000：落位后的真实比例
  })

  it('章首直达落位后也补一笔真实比例（章号意图之外，补的是「落位后读到章内哪儿」）', async () => {
    const h = makeSession()
    await h.session.open('src', 'https://s.com/book/1')
    h.port.anchors = [{ index: 0, start: 0, height: 1000 }, { index: 1, start: 1000, height: 1000 }]
    h.port.chapterOff = 1200                              // 目标章块在视口下 1200px
    h.session.requestJump('src', 1)
    expect(h.saves).toEqual([[1, 0]])                     // 选中即落盘（章号意图）
    h.session.afterRender('src')
    expect(h.port.top).toBe(1200)
    expect(h.saves[1]).toEqual([1, 0.2])                  // (1200 - 1000) / 1000：落位后的真实比例
  })

  it('锚点目标不在 DOM（未挂载/被裁）→ 不落位、不清，等下一轮', async () => {
    const h = makeSession()
    await h.session.open('src', 'https://s.com/book/1')
    h.session.requestJump('src', 0, 'a9')                 // 该锚点没登记 = 节点不在 DOM
    h.session.afterRender('src')
    expect(h.port.tops).toEqual([])                       // 一次都没量到，就不许动视口
    expect(h.session.state.pendingJump).toMatchObject({ index: 0, anchorId: 'a9' })
  })

  it('章块已挂载而锚点找不到（悬空/损坏的元数据）→ 退回章首并提交真实比例，不许让进度停摆', async () => {
    // 挂住的代价不是「这一次没跳成」：pendingJump 非空会把 handleViewportChange 整条早退掉，
    // 于是滚动不再落盘、currentChapter 冻结——整本书的进度**静默停摆**。
    // 所以宁可落到章首（用户至少还在读这一章），也不留一个永远等不到的目标。
    const h = makeSession()
    await h.session.open('src', 'https://s.com/book/1')
    h.port.anchors = [{ index: 0, start: 0, height: 3000 }]
    h.port.chapterOff = 500                               // 章块在视口下 500px：章首量得到
    h.session.requestJump('src', 0, 'a9')                 // 章已载、锚点不存在
    h.session.afterRender('src')
    expect(h.port.top).toBe(500)                          // 回归：悬空锚点必须退回章首，不许永久挂住
    expect(h.session.state.pendingJump).toBeNull()
    expect(h.saves).toHaveLength(2)                       // 章号意图 + 章首的真实比例
    expect(pick(h.saves, 1)[0]).toBe(0)
    expect(pick(h.saves, 1)[1]).toBeCloseTo(500 / 3000)

    h.port.top = 900                                      // 挂住解除后，滚动读数照常落盘
    h.session.handleViewportChange('src')
    await new Promise((r) => setTimeout(r, 40))           // 防抖窗口（makeSession 缺省 20ms）
    expect(pick(last(h.saves), 0)).toBe(0)
    expect(pick(last(h.saves), 1)).toBeCloseTo(0.3)
  })

  it('章块还没挂载（章节在途）→ 仍挂住待定位目标，等挂载后下一轮再定位', async () => {
    // 回退的边界就在这里：正文确实没到（chapters 里还是空洞）时不许凭空落到别处。
    const h = makeSession()
    await h.session.open('src', 'https://s.com/book/1')
    h.port.chapterOff = 700                               // 假 port 量得到——但这一章根本还没载
    h.session.requestJump('src', 2, 'a9')
    h.session.afterRender('src')
    expect(h.port.tops).toEqual([])                       // 不许落位
    expect(h.session.state.pendingJump).toMatchObject({ index: 2, anchorId: 'a9' })
  })

  it('越界章号：不写存档、不置待定位目标（越界下标会写出不存在的章号并永久挂住）', async () => {
    const h = makeSession({ debounceMs: 5000 })
    await h.session.open('src', 'https://s.com/book/1')
    h.session.requestJump('src', 9)                       // 目录只有 3 章
    h.session.requestJump('src', -1)
    expect(h.session.state.pendingJump).toBeNull()
    expect(h.saves).toEqual([])                           // 回归：越界章号不得写进存档
    expect(h.session.state.currentChapter).toBe(0)
    expect(h.session.state.chapters).toEqual([text(0), null, null])
    h.session.afterRender('src')
    expect(h.port.tops).toEqual([])
  })

  it('跨章目标在途时，滚动读数不许覆盖在途目标（锚点也得原样留着）', async () => {
    // 在途期间视口还是未更新的位置，采信它等于用陈旧证据推翻用户刚下的导航命令（跳第 20 章后
    // 一次读数把位置改回第 1 章，随后刚到的第 20 章被窗口裁掉）。
    const d = deferred<ChapterContent>()
    const fetched: number[] = []
    const port = fakePort()
    const session = new ReaderSession({
      fetchNavigation: async () => ({ chapters: toc, items: planarNavigation(toc) }),
      fetchChapter: (_s, _b, i) => {
        fetched.push(i)
        return i === 2 ? d.promise : Promise.resolve(text(i))
      },
      fetchShelf: async () => [], saveProgress: () => {}, saveTotalChapters: () => {},
      afterFrames: (cb) => cb(),
    }, port, 5)
    await session.open('src', 'b')
    port.anchors = [{ index: 0, start: 0, height: 1000 }]
    session.requestJump('src', 2, 'a9')
    expect(port.tops).toEqual([])
    session.handleViewportChange('src')                   // 旧位置的读数
    expect(session.state.currentChapter).toBe(2)          // 回归：视口读数不得改回未更新位置
    expect(session.state.pendingJump).toMatchObject({ index: 2, anchorId: 'a9' })

    port.targetOffs.set('a9', 250)
    d.resolve(text(2))                                    // 目标到货
    await new Promise((r) => setTimeout(r, 0))
    session.afterRender('src')
    expect(port.top).toBe(250)
    expect(session.state.pendingJump).toBeNull()
  })

  it('目标晚到但用户已点另一个目标：先到的那个一次都不许落位', async () => {
    const d1 = deferred<ChapterContent>()
    const d2 = deferred<ChapterContent>()
    const fetched: number[] = []
    const port = fakePort()
    const deps: ReaderSessionDeps = {
      fetchNavigation: async () => ({ chapters: toc, items: planarNavigation(toc) }),
      fetchChapter: (_s, _b, i) => {
        fetched.push(i)
        if (i === 1) return d1.promise
        if (i === 2) return d2.promise
        return Promise.resolve(text(i))
      },
      fetchShelf: async () => [], saveProgress: () => {}, saveTotalChapters: () => {},
      afterFrames: (cb) => cb(),
    }
    const session = new ReaderSession(deps, port, 5)
    await session.open('src', 'b')
    fetched.length = 0
    port.anchors = [{ index: 2, start: 0, height: 1000 }]
    port.targetOffs.set('a1', 100)                        // 第一个目标登记着（若被落位就一定看得见）
    port.targetOffs.set('a2', 250)

    session.requestJump('src', 1, 'a1')                   // 在途
    session.requestJump('src', 2, 'a2')                   // 用户改了主意：在途被占 → 只置目标
    expect(session.state.pendingJump).toMatchObject({ index: 2, anchorId: 'a2' })

    d1.resolve(text(1))                                   // 第一个目标晚到
    await new Promise((r) => setTimeout(r, 0))
    port.targetOffs.delete('a2')                          // 第 3 章还没挂载：锚点量不到
    session.afterRender('src')
    expect(port.tops).toEqual([])                         // 迟到的是「上一个目标」：不许落位
    expect(session.state.pendingJump).toMatchObject({ index: 2 })

    d2.resolve(text(2))
    await new Promise((r) => setTimeout(r, 0))
    port.targetOffs.set('a2', 250)                        // 目标挂载了
    session.afterRender('src')
    expect(port.top).toBe(250)                            // 只认最后点的那个目标
    expect(session.state.pendingJump).toBeNull()
  })

  it('跳转失败：位置退回真实视口，待定位目标（含锚点）一并撤销', async () => {
    const many: ChapterEntry[] = Array.from({ length: 5 }, (_, i) => ({ name: `第${i + 1}章`, url: `u${i}` }))
    const port = fakePort()
    const saves: Array<[number, number]> = []
    const session = new ReaderSession({
      fetchNavigation: async () => ({ chapters: many, items: planarNavigation(many) }),
      fetchChapter: async (_s, _b, i) => {
        if (i === 3) throw new Error('第 3 章拉取失败')
        return text(i)
      },
      fetchShelf: async () => [],
      saveProgress: (i, r) => { saves.push([i, r]) },
      saveTotalChapters: () => {}, afterFrames: (cb) => cb(),
    }, port, 5000)
    await session.open('src', 'b')
    port.anchors = [{ index: 0, start: 0, height: 3000 }]
    port.top = 0
    session.requestJump('src', 3, 'a9')
    await new Promise((r) => setTimeout(r, 0))
    expect(saves).toEqual([[3, 0], [0, 0]])               // 意图落盘 → 失败后纠正回真实视口
    expect(session.state.currentChapter).toBe(0)
    expect(session.state.pendingJump).toBeNull()
    expect(session.state.error?.message).toContain('第 3 章拉取失败')
  })
})

describe('ReaderSession 代际（卸载/换书后的迟到续作）', () => {
  it('卸载后迟到的正文不落位、不落盘、不留痕（代际标识挡住旧会话的续作）', async () => {
    const d = deferred<ChapterContent>()
    const port = fakePort()
    const saves: Array<[number, number]> = []
    const session = new ReaderSession({
      fetchNavigation: async () => ({ chapters: toc, items: planarNavigation(toc) }),
      fetchChapter: () => d.promise,
      fetchShelf: async () => [], saveProgress: (i, r) => { saves.push([i, r]) },
      saveTotalChapters: () => {}, afterFrames: (cb) => cb(),
    }, port)
    const opening = session.open('src', 'b')
    await new Promise((r) => setTimeout(r, 0))           // 目录已发布、正文在途
    session.dispose()                                    // 用户退出阅读器
    d.resolve(text(0))
    await opening
    await new Promise((r) => setTimeout(r, 0))
    expect(port.tops).toEqual([])                        // 不在已卸载的视口上落位
    expect(saves).toEqual([])                            // 也不在退出后再写一笔进度
    expect(session.state.chapters[0]).toBeNull()         // 迟到的正文不进已载表
  })

  it('换书：上一本的目录/正文迟到时不许盖掉新书的现场', async () => {
    const stale = deferred<ChapterContent>()
    const port = fakePort()
    const second: ChapterEntry[] = [{ name: '新书第一章', url: 'u0' }]
    let calls = 0
    const session = new ReaderSession({
      fetchNavigation: async () => {
        calls++
        if (calls === 1) return { chapters: toc, items: planarNavigation(toc) }
        return { chapters: second, items: planarNavigation(second) }
      },
      fetchChapter: (_s, _b, i) => (calls === 1 ? stale.promise : Promise.resolve(text(i))),
      fetchShelf: async () => [], saveProgress: () => {}, saveTotalChapters: () => {},
      afterFrames: (cb) => cb(),
    }, port)
    const first = session.open('src', 'b1')
    await new Promise((r) => setTimeout(r, 0))
    await session.open('src', 'b2')                      // 换书（同一会话实例重开）
    expect(session.state.toc).toHaveLength(1)
    stale.resolve(text(0))                               // 上一本的正文迟到
    await first
    await new Promise((r) => setTimeout(r, 0))
    expect(session.state.chapters[0]).toEqual(text(0))   // 新书的第 0 章（不是「上一本的第 0 章」覆盖现场）
    expect(session.state.toc).toHaveLength(1)
  })

  it('dispose 复位在途槽：被弃实例上不许留着预约槽（否则此后的加载全被无声挡下）', async () => {
    // dispose 是「这条会话到此为止」：在途槽的真相变成「没有任何加载在途」。
    // 不复位则 RESTORE_SLOT 永久占着槽（open 的续作被代际闸挡下、走不到那句复位），
    // 此后任何 load 都在 `inflight !== null` 上半路静默返回——不变量只在实例内自洽，
    // 而同一个实例还可能被重挂载复用。
    const port = fakePort()
    const fetched: number[] = []
    let releaseShelf = (): void => {}
    const shelfPromise = new Promise<ShelfBook[]>((r) => { releaseShelf = () => r([]) })
    const session = new ReaderSession({
      fetchNavigation: async () => ({ chapters: toc, items: planarNavigation(toc) }),
      fetchChapter: async (_s, _b, i) => { fetched.push(i); return text(i) },
      fetchShelf: () => shelfPromise,                    // 存档迟迟不回：槽上留着 RESTORE_SLOT
      saveProgress: () => {}, saveTotalChapters: () => {}, afterFrames: (cb) => cb(),
    }, port, 5000)
    const opening = session.open('src', 'b')
    await new Promise((r) => setTimeout(r, 0))           // 目录已发布、书架还没回
    session.dispose()                                    // 用户退出阅读器
    releaseShelf()
    await opening
    fetched.length = 0
    void session.load('src', 1)
    await new Promise((r) => setTimeout(r, 0))
    expect(fetched).toEqual([1])                         // 回归：dispose 后不得让 RESTORE_SLOT 一直占槽
  })
})

describe('连续阅读的已载窗口上限（裁章补偿 + 回溯补载）', () => {
  const many: ChapterEntry[] = Array.from({ length: 60 }, (_, i) => ({ name: `第${i + 1}章`, url: `https://s.com/c/${i}` }))

  /** 长书会话：假 port 按「当前已载表」重建锚点（DOM 顺序 = 已载章顺序，裁章后起点整体上移）。 */
  const makeLongSession = (chapterHeight: number) => {
    const port = fakePort()
    port.height = 1000
    port.scrollH = 60 * chapterHeight
    port.sentinel = null                                  // 预取不由本组用例驱动
    const fetched: number[] = []
    const session = new ReaderSession({
      fetchNavigation: async () => ({ chapters: many, items: planarNavigation(many) }),
      fetchChapter: async (_s, _b, i) => { fetched.push(i); return text(i) },
      fetchShelf: async () => [], saveProgress: () => {}, saveTotalChapters: () => {},
      afterFrames: (cb) => cb(),
    }, port, 5)
    const render = (): void => {
      const mounted: number[] = []
      session.state.chapters.forEach((c, i) => { if (c !== null) mounted.push(i) })
      const base = mounted[0] ?? 0
      port.anchors = mounted.map((i) => ({ index: i, start: (i - base) * chapterHeight, height: chapterHeight }))
      session.afterRender('src')
    }
    return { port, session, fetched, render }
  }

  it('连续前读：窗口只保留视口前 6 章，裁章后滚动位按实测高度回补（DOM 不再线性增长）', async () => {
    const { port, session, render } = makeLongSession(1000)
    await session.open('src', 'https://s.com/book/1')
    render()
    for (let i = 1; i <= 20; i++) {
      await session.load('src', i)
      render()
      const a = must(port.anchors.find((x) => x.index === i), `第 ${i} 章的锚点`)
      port.top = a.start + 300
      session.handleViewportChange('src')
      render()
    }
    const kept = session.state.chapters.flatMap((c, i) => (c === null ? [] : [i]))
    expect(kept).toEqual([14, 15, 16, 17, 18, 19, 20])    // 视口 20、前留 6 章
    const a20 = must(port.anchors.find((x) => x.index === 20), '第 20 章的锚点')
    expect(port.top).toBe(a20.start + 300)                 // 补偿后视口仍停在第 20 章同一处
  })

  it('回溯补载不越过裁章下界：不重取会被 prune 立刻裁掉的章', async () => {
    const { port, session, fetched, render } = makeLongSession(10)   // 章高远小于两屏 → 距离判据不会自行收敛
    await session.open('src', 'https://s.com/book/1')
    fetched.length = 0                                               // 只数这一轮补载
    render()
    session.requestJump('src', 30)
    await new Promise((r) => setTimeout(r, 0))
    port.chapterOff = 0
    render()
    for (let i = 0; i < 40; i++) {
      session.handleViewportChange('src')
      await new Promise((r) => setTimeout(r, 0))
      render()
    }
    const backfilled = fetched.filter((i) => i < 30)
    // 视口固定在 30 → keepLo = 24；补载只许到 24，再往前的章会被 prune 当场裁掉并重取
    expect(backfilled).toEqual([29, 28, 27, 26, 25, 24])
    expect(fetched.filter((i) => i < 24), '不许反复重取下界之外的那一章').toEqual([])
  })

  it('高度量不到（0）时不按视口补载：距离证据不可用', async () => {
    const { port, session, fetched, render } = makeLongSession(0)
    await session.open('src', 'https://s.com/book/1')
    fetched.length = 0                                               // 只数这一轮补载
    render()
    session.requestJump('src', 10)
    await new Promise((r) => setTimeout(r, 0))
    port.chapterOff = 0
    render()
    port.top = 0
    for (let i = 0; i < 10; i++) {
      session.handleViewportChange('src')
      await new Promise((r) => setTimeout(r, 0))
      render()
    }
    expect(fetched.filter((i) => i < 10)).toEqual([])
  })

  it('回溯：滚到窗口顶补载上一章，前插后视口仍停在原处', async () => {
    const { port, session, fetched, render } = makeLongSession(3000)   // 章高 3 屏 → 一次补载即够缓冲
    await session.open('src', 'https://s.com/book/1')
    render()
    session.requestJump('src', 10)
    await new Promise((r) => setTimeout(r, 0))
    port.chapterOff = 0
    render()                                               // settleJump 落位（targetOffset 读 chapterOff）
    const a10 = must(port.anchors.find((x) => x.index === 10), '第 10 章的锚点')
    port.top = a10.start + 100
    session.handleViewportChange('src')                    // 靠近窗口顶 → 触发补载第 9 章
    await new Promise((r) => setTimeout(r, 0))
    expect(session.state.chapters[9]).not.toBeNull()
    expect(fetched).toContain(9)
    render()                                               // 前插补偿：视口下移一章高
    const a10new = must(port.anchors.find((x) => x.index === 10), '前插后第 10 章的锚点')
    expect(port.top).toBe(a10new.start + 100)              // 视觉位置没动
  })

  /** 额度闸用例的现场：跳到第 30 章后把锚点测量喂成失真读数（谎报窗口顶在第 25 章）。
   *  诚实测量下同一章重取风暴起不来（裁章下界与 prune 严格互补，每个位置最多 6 发），
   *  额度闸兜的正是「测量失真那一天」——所以这里制造它存在的那种失真：每轮 afterRender 都让
   *  checkBackfill 重取第 24 章，而 24 与真已载集（第 30 章）不相邻、落地即被 prune 裁掉，
   *  下一轮又重取同一章。 */
  const makeStorm = async () => {
    const h = makeLongSession(1000)
    await h.session.open('src', 'https://s.com/book/1')
    h.render()
    h.session.handleViewportChange('src')        // 真实视口读过一次（回溯判据的前提；视口在第 0 章首不补载）
    h.session.requestJump('src', 30)             // 跳章 = 新 episode：额度 16 起算
    await new Promise((r) => setTimeout(r, 0))   // 第 30 章到货
    h.port.chapterOff = 0                        // settleJump 落位读数
    const lie: ChapterAnchor[] = [{ index: 25, start: 0, height: 1000 }]
    h.fetched.length = 0                         // 只数额度内的自动补载
    return {
      ...h,
      storm: async (): Promise<void> => {
        h.port.anchors = lie
        h.session.afterRender('src')
        await new Promise((r) => setTimeout(r, 0))
      },
    }
  }

  it('回溯补载额度是 episode 的硬上界：锚点失真的同一章重取风暴在 16 发后被额度闸挡死', async () => {
    // 一个 episode（open / 跳章 / 跨章换位）就 16 发，不多一发——距离判据依赖高度测量，
    // 测量失真时它永不收敛，这道闸是那个日子里唯一的刹车。
    const { storm, fetched } = await makeStorm()
    for (let i = 0; i < 16; i++) await storm()
    expect(fetched, '同一章（24）被反复重取，恰好花完整个 episode 的 16 发额度').toEqual(Array(16).fill(24))
    for (let i = 0; i < 3; i++) await storm()
    expect(fetched, '额度耗尽后自动补载停手：第 17 发被闸住，不是「再试一次就好」').toHaveLength(16)
  })

  it('跳章把回溯补载额度复位：额度耗尽后，新 episode 的同一发补载又活了', async () => {
    const { storm, session, fetched } = await makeStorm()
    for (let i = 0; i < 16; i++) await storm()
    expect(fetched).toHaveLength(16)
    session.requestJump('src', 30)               // 跳章（跳回同一章也一样）= 新 episode，额度复位
    await storm()
    expect(fetched, '额度随跳章复位：同一发补载重新可用').toHaveLength(17)
  })

  it('渲染前窗口：load 换了已载表但 DOM 未提交时，滚动读数要重测锚点（不拿旧布局冒充新表）', async () => {
    const h = makeSession()
    await h.session.open('src', 'https://s.com/book/1')
    h.port.anchors = [{ index: 0, start: 0, height: 1000 }]
    h.session.afterRender('src')                           // 首轮渲染：锚点表对应已载 [0]
    h.session.handleViewportChange('src')                  // 视口读过一次（回溯判据的前提）
    await h.session.load('src', 1)                         // 已载表换成 [0,1]；视图 afterRender 尚未跑
    // 模拟 React 已把第 1 章提交进 DOM，而滚动事件先于 afterRender 到达
    h.port.anchors = [{ index: 0, start: 0, height: 1000 }, { index: 1, start: 1000, height: 1000 }]
    h.port.top = 1300
    h.session.handleViewportChange('src')
    expect(h.session.state.currentChapter, '旧锚点表会把视口读成第 0 章尾').toBe(1)
    expect(h.saves.at(-1)).toEqual([1, 0.3])
  })
})

describe('ReaderSession 视口喂入（合帧）', () => {
  it('连喂 3 次只排一帧，帧内锚点只重测一次', async () => {
    const pump = makeFramePump()
    const h = makeSession({ viewport: pump.feed })
    await h.session.open('src', 'https://s.com/book/1')
    h.port.anchors = [{ index: 0, start: 0, height: 3000 }]
    const measure = vi.spyOn(h.port, 'measureAnchors')
    const refreshBefore = pump.refreshCount()

    h.session.feedViewport()
    h.session.feedViewport()
    h.session.feedViewport()
    expect(pump.pending(), '三次事件共用同一帧').toBe(1)
    pump.flush()
    expect(measure, '帧内只重测一次锚点（首帧对齐已载表）').toHaveBeenCalledTimes(1)
    expect(pump.refreshCount(), '帧体只重取一次滚动容器').toBe(refreshBefore + 1)
    h.session.dispose()
  })

  it('layoutChanged 按或合并：先 true 后 false / 先 false 后 true 都重测锚点', async () => {
    const pump = makeFramePump()
    const h = makeSession({ viewport: pump.feed })
    await h.session.open('src', 'https://s.com/book/1')
    h.port.anchors = [{ index: 0, start: 0, height: 3000 }]
    h.session.feedViewport()                               // 对齐 anchorsFrom
    pump.flush()
    const measure = vi.spyOn(h.port, 'measureAnchors')

    h.session.feedViewport(true)
    h.session.feedViewport()
    pump.flush()
    expect(measure, '先布局后滚动：布局标记不许被普通事件吃掉').toHaveBeenCalledTimes(1)

    measure.mockClear()
    h.session.feedViewport()
    h.session.feedViewport(true)
    pump.flush()
    expect(measure, '先滚动后布局：同帧内布局标记照样生效').toHaveBeenCalledTimes(1)
    h.session.dispose()
  })

  it('无布局标记且已载表未换版本 → 帧内不重测锚点（纯滚动只读缓存）', async () => {
    const pump = makeFramePump()
    const h = makeSession({ viewport: pump.feed })
    await h.session.open('src', 'https://s.com/book/1')
    h.port.anchors = [{ index: 0, start: 0, height: 3000 }]
    h.session.feedViewport()                               // 对齐 anchorsFrom
    pump.flush()
    const measure = vi.spyOn(h.port, 'measureAnchors')

    h.session.feedViewport()
    pump.flush()
    expect(measure).not.toHaveBeenCalled()
    h.session.dispose()
  })

  it('帧体次序：先 refreshPort 再 measureAnchors', async () => {
    const pump = makeFramePump()
    const base = pump.feed
    const order: string[] = []
    const h = makeSession({
      viewport: {
        scheduleFrame: (cb) => base.scheduleFrame(cb),
        cancelFrame: (h) => base.cancelFrame(h),
        refreshPort: () => { order.push('refresh'); base.refreshPort() },
      },
    })
    await h.session.open('src', 'https://s.com/book/1')
    h.port.anchors = [{ index: 0, start: 0, height: 3000 }]
    const original = h.port.measureAnchors
    h.port.measureAnchors = () => { order.push('measure'); return original() }

    h.session.feedViewport()
    pump.flush()
    expect(order.slice(0, 2), '帧首重取滚动容器，之后才量锚点').toEqual(['refresh', 'measure'])
    h.session.dispose()
  })

  it('会话不自排初始帧；dispose 取消挂起帧；open 重开取消上一代挂起帧', async () => {
    const pump = makeFramePump()
    const h = makeSession({ viewport: pump.feed })
    await h.session.open('src', 'https://s.com/book/1')
    expect(pump.pending(), 'open 不自排帧：初始视口帧仍由视图安装处发起').toBe(0)
    const measure = vi.spyOn(h.port, 'measureAnchors')

    h.session.feedViewport()
    expect(pump.pending()).toBe(1)
    h.session.feedViewport(true)                           // 挂起期间再喂：不排第二帧、布局标记合并
    expect(pump.pending()).toBe(1)
    h.session.dispose()
    expect(pump.cancelled, 'cancelFrame 收到挂起帧的句柄').toHaveLength(1)
    pump.flush()
    expect(measure, '取消的帧不跑：不重测、不读视口').not.toHaveBeenCalled()

    await h.session.open('src', 'https://s.com/book/1')     // 同一实例重开（换书路径）
    h.session.feedViewport()
    expect(pump.pending()).toBe(1)
    await h.session.open('src', 'https://s.com/book/1')
    expect(pump.cancelled, '上一代的挂起帧作废').toHaveLength(2)
    pump.flush()
    expect(measure).not.toHaveBeenCalled()
  })
})

describe('ReaderSession 排版前采点与复位', () => {
  afterEach(() => {
    // 三个排版量复位到缺省：prefsStore 是模块级 store，跨用例串味会让「同值再设」的用例失真
    setPref({ fontSize: DEFAULT_PREFS.fontSize, lineHeight: DEFAULT_PREFS.lineHeight, measure: DEFAULT_PREFS.measure })
  })

  it('open 后 setPref 在同步栈采点；复位落位 = 原 top + 目标偏移 + 节点内偏移', async () => {
    const h = makeSession()
    await h.session.open('src', 'https://s.com/book/1')
    h.port.top = 100
    h.port.node = { index: 0, nodeId: 'p1', offsetWithinNode: 40 }
    const reads = h.port.nodeReads
    setPref({ fontSize: 22 })
    expect(h.port.nodeReads, 'setPref 的同步调用栈里采点').toBe(reads + 1)
    h.port.targetOffs.set('p1', 250)
    h.session.applyTypesetRelocation()
    expect(h.port.top).toBe(100 + 250 + 40)
    h.session.dispose()
  })

  it('目标量不到 → 不落位、快照保留（补上目标后同一发再试与第二次 setPref 后都生效）', async () => {
    const h = makeSession()
    await h.session.open('src', 'https://s.com/book/1')
    h.port.top = 100
    h.port.node = { index: 0, nodeId: 'p1', offsetWithinNode: 40 }
    setPref({ fontSize: 22 })
    h.session.applyTypesetRelocation()                     // p1 还量不到
    expect(h.port.tops, '量不到目标不许凭空落位').toEqual([])

    h.port.targetOffs.set('p1', 120)
    h.session.applyTypesetRelocation()                     // 快照没被 miss 清掉：没有新采点也能落
    expect(h.port.top).toBe(100 + 120 + 40)

    h.port.top = 50                                        // 读者又滚到别处
    setPref({ fontSize: 24 })                              // 第二次 setPref：同步栈重新采点
    h.session.applyTypesetRelocation()
    expect(h.port.top).toBe(50 + 120 + 40)
    h.session.dispose()
  })

  it('复位后重采：连调两次排版，第二次用复位时记下的新锚', async () => {
    const h = makeSession()
    await h.session.open('src', 'https://s.com/book/1')
    h.port.top = 100
    const nodes: Array<VisibleNode | null> = [
      { index: 0, nodeId: 'p1', offsetWithinNode: 40 },
      { index: 0, nodeId: 'p2', offsetWithinNode: 90 },
    ]
    h.port.currentNode = () => (nodes.length > 0 ? must(nodes.shift(), '下一个节点') : null)
    h.port.targetOffs.set('p1', 120)
    h.port.targetOffs.set('p2', 30)
    setPref({ fontSize: 22 })                              // 采点 #1 = p1
    h.session.applyTypesetRelocation()                     // 落位 p1，复位后重采 #2 = p2
    expect(h.port.top).toBe(100 + 120 + 40)
    h.session.applyTypesetRelocation()                     // 第二次直接用重采到的 p2
    expect(h.port.top).toBe(260 + 30 + 90)
    h.session.dispose()
  })

  it('复位后喂一次 layoutChanged 视口读数（先对齐锚点，复位后 measureAnchors +1）', async () => {
    const h = makeSession()
    await h.session.open('src', 'https://s.com/book/1')
    h.port.anchors = [{ index: 0, start: 0, height: 3000 }]
    h.session.afterRender('src')                           // 对齐 anchorsFrom === chaptersNow
    h.port.top = 100
    h.port.node = { index: 0, nodeId: 'p1', offsetWithinNode: 40 }
    h.port.targetOffs.set('p1', 250)
    const measure = vi.spyOn(h.port, 'measureAnchors')
    setPref({ fontSize: 22 })
    h.session.applyTypesetRelocation()
    expect(measure, '复位后的视口读数按布局变化重测，位置提交仍归会话').toHaveBeenCalledTimes(1)
    h.session.dispose()
  })

  it('dispose 退订并清快照：之后 setPref 不再读节点，复位为 no-op', async () => {
    const h = makeSession()
    await h.session.open('src', 'https://s.com/book/1')
    h.port.top = 100
    h.port.node = { index: 0, nodeId: 'p1', offsetWithinNode: 40 }
    setPref({ fontSize: 22 })
    const reads = h.port.nodeReads
    h.session.dispose()
    setPref({ fontSize: 24 })
    expect(h.port.nodeReads, '退订后不再采点').toBe(reads)
    h.port.targetOffs.set('p1', 120)
    h.session.applyTypesetRelocation()
    expect(h.port.tops, '快照已清：退订后的复位不落位').toEqual([])
  })

  it('dispose 后再 open：订阅重新生效且只采一次（幂等守卫挡住双订阅）', async () => {
    const h = makeSession()
    await h.session.open('src', 'https://s.com/book/1')
    h.session.dispose()
    await h.session.open('src', 'https://s.com/book/1')
    await h.session.open('src', 'https://s.com/book/1')   // 同实例连开两次：不许长出第二份订阅
    const reads = h.port.nodeReads
    setPref({ fontSize: 24 })
    expect(h.port.nodeReads, '一次 setPref 只读一次节点（双订阅会读两次）').toBe(reads + 1)
    h.session.dispose()
  })
})
