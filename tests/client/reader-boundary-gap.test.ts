import { beforeEach, describe, expect, it } from 'vitest'
import { planarNavigation } from '../../src/shared/wire.js'
import { locateChapter } from '../../src/client/progress.js'
import type { ChapterAnchor } from '../../src/client/progress.js'
import { DEFAULT_PREFS, setPref } from '../../src/client/store.js'
import { ReaderSession } from '../../src/client/reader-session.js'
import type { ReaderSessionDeps } from '../../src/client/reader-session.js'
import type { ChapterContent, ChapterEntry, ShelfBook } from '../../src/client/views/types.js'
import { fakePort } from './reader-fakes.js'

/**
 * 章间空档归章判据的复现与规格。
 *
 * 缺陷形状：章块高度不含章间 margin，块顶是亚像素量；`settleJump` 顶对齐后浏览器把 scrollTop 吸到
 * 整数，落位差出的亚像素会停在两章之间的无内容带里。旧判据只看起点，把这条带读回「上一章 @1」，
 * 下一帧诚实读数把刚落定的跳章打回前一章（2026-11-25 活体遥测：汉兴 ch2→ch3，contentTop 比块顶
 * 差 0.125px）。纯阅读器同样暴露：该书排版几何把既有判据缺陷钉成了确定复现。
 *
 * 判据修法：章块之间的空档是后一章的「引导页」——读数严格越过本章块尾且未到下一章块顶时，归下一章
 * @0。规则住在视口顶落项判据本身（`client/viewport-top.ts` 的 `crossedIndex` 吃块区间，`ADR-0106`），
 * 进度锚点 / 正文节点 / 听书块三条数据路同吃，跨路等价由 `viewport-top.test.ts` 的带缝页钉住；
 * 连续锚点（下一章块顶 == 本章块尾）不受影响。
 *
 * 赋值层另有一层取整补丁（`settleJump` / 恢复 / 排版复位等赋值点统一先 `Math.ceil`）：DPR=1 下落位
 * 不再进缝，但缝读数仍是可达态——拖动滚动条经过缝、DPR≠1 的设备像素吸整、布局位移的补偿落点都会把
 * 诚实读数送进缝；连续锚点那半个像素差（无缝可归、截断即落进上一章块内）由取整补丁兜，缝归谁只能
 * 归判据。两层各钉各的，不许互相冒充。jsdom 假件对浏览器的吸整全盲，所以会话用例把取整后的活体
 * 落点直接摆在读数那一步，不去等它从赋值算式里掉出来。
 *
 * 断言分三层：单元断言钉判据本身（判据撤掉即红）；会话断言钉「缝里的读数不许把位置改写成上一章尾」；
 * 另钉赋值层（`port.tops`）证明两层补丁各就各位。
 */

/** 2026-11-25 活体读数：汉兴 ch2→ch3 的锚点几何（内容坐标，亚像素原样保留） */
const liveAnchors: ChapterAnchor[] = [
  { index: 1, start: 72, height: 7084.53125 },
  { index: 2, start: 7178.125, height: 6890.1875 },
]

/** 连续锚点（下一章块顶 == 本章块尾，无空档）：判据修复对它必须是无操作 */
const contiguousAnchors: ChapterAnchor[] = [
  { index: 0, start: 0, height: 1000 },
  { index: 1, start: 1000, height: 750 },
]

describe('locateChapter：章间空档归后章（无锚点区不许归前一章尾）', () => {
  it('活体复现：settle 取整后 contentTop 差 0.125px 压不到线 → 不得弹回前一章', () => {
    // 无判据时：{ chapterIndex: 1, offsetRatio: 1 } —— 跳到第 2 章后第一帧视口读数把它推翻
    expect(locateChapter(liveAnchors, 7178)).toEqual({ chapterIndex: 2, offsetRatio: 0 })
  })

  it('空档中段（越过本章块尾、未到下一章块顶）都归下一章 @0', () => {
    expect(locateChapter(liveAnchors, 7160)).toEqual({ chapterIndex: 2, offsetRatio: 0 })
    expect(locateChapter(liveAnchors, 7178.1)).toEqual({ chapterIndex: 2, offsetRatio: 0 })
  })

  it('压线仍归后章（crossedIndex 既有口径不动）：正好压在下一章块顶 → 后章 @0', () => {
    expect(locateChapter(liveAnchors, 7178.125)).toEqual({ chapterIndex: 2, offsetRatio: 0 })
  })

  it('恰在块尾（最后一行正压内容线）仍归本章 @1：空档判据必须严格越过块尾', () => {
    expect(locateChapter(liveAnchors, 7156.53125)).toEqual({ chapterIndex: 1, offsetRatio: 1 })
  })

  it('尾章之后的空白（下一章未挂载、没有下一个锚点）维持现状：夹在前章 @1', () => {
    const loneAnchor = { index: 1, start: 72, height: 7084.53125 }
    expect(locateChapter([loneAnchor], 7170)).toEqual({ chapterIndex: 1, offsetRatio: 1 })
  })

  it('连续锚点不受空档判据影响（修复必须是无操作）', () => {
    expect(locateChapter(contiguousAnchors, 1500)).toEqual({ chapterIndex: 1, offsetRatio: 2 / 3 })
    expect(locateChapter(contiguousAnchors, 1000)).toEqual({ chapterIndex: 1, offsetRatio: 0 })
  })

  it('零高块不占线（height≤0 = 没量到内容）：整条离线就让位下一章，压线才算占线', () => {
    const zero: ChapterAnchor = { index: 1, start: 72, height: 0 }
    const mounted: ChapterAnchor = { index: 2, start: 100, height: 500 }
    expect(locateChapter([zero, mounted], 80)).toEqual({ chapterIndex: 2, offsetRatio: 0 })
    expect(locateChapter([zero, mounted], 72)).toEqual({ chapterIndex: 1, offsetRatio: 0 })
  })
})

/** 三章目录 + 存档在第 1 章的会话桩：会话级复现要的只是这三格 */
const toc: ChapterEntry[] = [
  { name: '第一章', url: 'https://s.com/c/1' },
  { name: '第二章', url: 'https://s.com/c/2' },
  { name: '第三章', url: 'https://s.com/c/3' },
]

const text = (i: number): ChapterContent => ({ kind: 'text', text: `正文${i}` })

const shelfAt = (chapterIndex: number): ShelfBook[] => [{
  sourceId: 'src', bookKey: 'https://s.com/book/1', title: '汉兴',
  progress: { chapterIndex, offsetRatio: 0, updatedAt: 0 }, addedAt: 0,
}]

describe('ReaderSession：跳到已挂载相邻章，缝里的读数不得回弹成上一章尾', () => {
  it('settle 落位后读数落缝（活体落点 7138）：位置必须钉在目标章 @0', async () => {
    const port = fakePort()
    const saves: Array<[number, number]> = []
    const deps: ReaderSessionDeps = {
      fetchNavigation: async () => ({ chapters: toc, items: planarNavigation(toc) }),
      fetchChapter: async (_s, _b, i) => text(i),
      fetchShelf: async () => shelfAt(1),
      saveProgress: (i, r) => { saves.push([i, r]) },
      saveTotalChapters: () => {},
      afterFrames: (cb) => { cb() },
      topInset: () => 40,
    }
    const session = new ReaderSession(deps, port, 20)

    await session.open('src', 'https://s.com/book/1')   // 存档@1 → 载第 1 章
    await session.load(2)                                // 挂载第 2 章（窗口 {1,2}，同活体）
    port.anchors = liveAnchors                          // 装上活体几何
    port.chapterOff = 40.125                            // targetOffset(2, null)：块顶离视口顶 40.125px
    port.top = 7138                                     // 读者站在第 1 章尾部
    port.scrollH = 20599
    port.height = 1000
    session.afterRender()                                // 对齐 anchorsFrom === chaptersNow

    session.requestJump(2)                               // 选中即落盘：PUT (2, 0)
    session.afterRender()                                // settleJump 落位（现行赋值先 Math.ceil 越过线）并补真实比例
    port.top = 7138                                      // 取整后的活体落点：contentTop 7178，比 ch3 块顶差 0.125px 压不到线
    session.feedViewport()                               // 诚实判据：读数落缝
    await new Promise((r) => setTimeout(r, 40))           // 防抖窗口过：缝读数那笔 (2, 0) 落盘

    // 无判据时：currentChapter 回弹成 1、存档写成 (1, 1) —— 与活体遥测的 +97ms 那一笔一致
    expect(session.state.currentChapter).toBe(2)
    expect(saves.at(-1)).toEqual([2, 0])
    // 赋值层补丁也在场（`settleJump` 的 `Math.ceil`）：settle 写的是向上取整的 7139，
    // 判据层钉的是「就算落在取整后的缝里（7138）也不许回弹」——两层各自有钉，不许互相冒充。
    expect(port.tops.at(-1)).toBe(7139)
    session.dispose()
  })
})

describe('ReaderSession：判章前锚点必须与当前布局同版', () => {
  it('章块长高后，同一视口读数不得按旧块高被判进空档（布局帧与纯滚动跨章都重测）', async () => {
    for (const layoutChanged of [true, false]) {
      const port = fakePort()
      const session = new ReaderSession({
        fetchNavigation: async () => ({ chapters: toc, items: planarNavigation(toc) }),
        fetchChapter: async (_s, _b, i) => text(i),
        fetchShelf: async () => shelfAt(0),
        saveProgress: () => {},
        saveTotalChapters: () => {},
        afterFrames: (cb) => { cb() },
        topInset: () => 40,
      }, port, 20)

      await session.open('src', 'https://s.com/book/1')   // 存档@0 → 载第 0 章
      await session.load(1)                                // 挂载第 1 章
      port.anchors = [
        { index: 0, start: 0, height: 1000 },
        { index: 1, start: 1048, height: 500 },
      ]
      session.afterRender()                                // 锚点缓存停在旧布局
      port.top = 980                                       // contentTop = 1020：旧几何的章间空档
      // 图片 / 字体让第 0 章长高到 1500，同一读数仍在本章内。布局帧要先重测；只滚动、没标布局的
      // 跨章读数也要在提交前重测——否则过期块高会把章内读数误判成空档、把位置翻到下一章。
      port.anchors = [
        { index: 0, start: 0, height: 1500 },
        { index: 1, start: 1548, height: 500 },
      ]
      session.feedViewport(layoutChanged)
      expect(session.state.currentChapter, `layoutChanged=${layoutChanged}`).toBe(0)
      session.dispose()
    }
  })
})

describe('ReaderSession：空档采点（负 offsetWithinNode）下的排版复位与内链返回闭环', () => {
  beforeEach(() => {
    setPref({ fontSize: DEFAULT_PREFS.fontSize })
  })

  it('空档采点后 applyTypesetRelocation 按负 offsetWithinNode 精确复位回原空档', async () => {
    const port = fakePort()
    const session = new ReaderSession({
      fetchNavigation: async () => ({ chapters: toc, items: planarNavigation(toc) }),
      fetchChapter: async (_s, _b, i) => text(i),
      fetchShelf: async () => shelfAt(1),
      saveProgress: () => {},
      saveTotalChapters: () => {},
      afterFrames: (cb) => { cb() },
      topInset: () => 40,
    }, port, 20)

    await session.open('src', 'https://s.com/book/1')
    port.top = 1000
    // 视口顶落在节点 n1 上方 24px 的空档里：currentNodeOf 采出 offsetWithinNode = -24
    port.node = { index: 1, nodeId: 'n1', offsetWithinNode: -24 }
    try {
      setPref({ fontSize: 22 })
      port.targetOffs.set('n1', 120)
      session.applyTypesetRelocation()
      // 复位算式：Math.ceil(1000 + 120 + (-24) - 40) = 1056（保留在 n1 上方 24px 的空档）
      expect(port.top).toBe(1056)
    } finally {
      setPref({ fontSize: DEFAULT_PREFS.fontSize })
      session.dispose()
    }
  })

  it('空档采点后 applyTypesetRelocation 算式低于 0 时钳底到 +0，不写负数或 -0', async () => {
    const port = fakePort()
    const session = new ReaderSession({
      fetchNavigation: async () => ({ chapters: toc, items: planarNavigation(toc) }),
      fetchChapter: async (_s, _b, i) => text(i),
      fetchShelf: async () => shelfAt(1),
      saveProgress: () => {},
      saveTotalChapters: () => {},
      afterFrames: (cb) => { cb() },
      topInset: () => 40,
    }, port, 20)

    await session.open('src', 'https://s.com/book/1')
    port.top = 0
    port.node = { index: 1, nodeId: 'n1', offsetWithinNode: -24 }
    try {
      setPref({ fontSize: 22 })
      port.targetOffs.set('n1', 50)
      session.applyTypesetRelocation()
      // 算式：0 + 50 + (-24) - 40 = -14 → 钳底为 +0
      expect(Object.is(port.top, 0)).toBe(true)
    } finally {
      setPref({ fontSize: DEFAULT_PREFS.fontSize })
      session.dispose()
    }
  })

  it('空档采点后 followLink → goBack：返回时按负 offsetWithinNode 落回同一空档位置', async () => {
    const port = fakePort()
    const session = new ReaderSession({
      fetchNavigation: async () => ({ chapters: toc, items: planarNavigation(toc) }),
      fetchChapter: async (_s, _b, i) => text(i),
      fetchShelf: async () => shelfAt(1),
      saveProgress: () => {},
      saveTotalChapters: () => {},
      afterFrames: (cb) => { cb() },
      topInset: () => 40,
    }, port, 20)

    await session.open('src', 'https://s.com/book/1')
    await session.load(2)
    port.anchors = liveAnchors
    port.top = 1000
    port.node = { index: 1, nodeId: 'n1', offsetWithinNode: -24 }

    const entry = session.followLink({ kind: 'chapter', index: 2, anchorId: null }, 'normal')
    expect(entry).toEqual({ index: 1, nodeId: 'n1', offsetWithinNode: -24 })
    port.chapterOff = 40
    session.afterRender()

    port.targetOffs.set('n1', 120)
    session.goBack()
    session.afterRender()
    // settleJump 算式：Math.ceil(Math.max(0, port.top + 120 + (-24) - 40))
    expect(port.top).toBe(1056)
    session.dispose()
  })
})
