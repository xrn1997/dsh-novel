import { describe, expect, it } from 'vitest'
import { planarNavigation } from '../../src/shared/wire.js'
import { locateChapter } from '../../src/client/progress.js'
import type { ChapterAnchor } from '../../src/client/progress.js'
import { ReaderSession } from '../../src/client/reader-session.js'
import type { ReaderSessionDeps } from '../../src/client/reader-session.js'
import type { ChapterContent, ChapterEntry, ShelfBook } from '../../src/client/views/types.js'
import { fakePort } from './reader-fakes.js'

/**
 * 章间空档归章判据的复现与规格（2026-11-25 活体遥测钉的缺陷）。
 *
 * 缺陷链（Edge 159.0.4402.13 / Windows / 100% DPI，dsh-novel 阅读器实测）：
 * 1. 章块顶是亚像素量（`getBoundingClientRect`）：ch3 块顶 = 7178.125（内容坐标）；
 *    块高不含章间外边距 → ch2 锚点 [72, 7156.53125] 与 ch3 锚点 [7178.125, …] 之间有
 *    约 21.6px **无锚点空档**（章间 margin）。
 * 2. `settleJump` 把 contentTop 精确瞄在目标块顶（让出顶条的顶对齐）：赋值
 *    `scrollTop + 40.125 - 40 = 7138.125`；浏览器把 scrollTop 赋值**四舍五入到整数**
 *    （实测赋 123.6 回读 124）→ 存下 7138 → contentTop = 7178，比 ch3 块顶**差 0.125px 压不到线**。
 * 3. `settleJump` 自己的提交是 `find(index) + ratioWithin`（钳 0），把这笔欠账**钳成
 *    `(2, 0)` 看起来完美**；3ms 后视口帧的 `locateChapter` 是诚实判据：7178.125 - 7178 =
 *    +0.125 > 0 → 未越过 → 取最后越过的 ch2、比例钳 1 → **(1, 1)** → 跳章回弹回前一章。
 *
 * 症状：目录/侧栏跳到「已挂载的相邻章」有约一半概率弹回前一章（取决于块顶小数部分
 * 的取整方向）；ch5→ch6 不弹是取整运气（小数 ≥ .5 向上进章），不是路径差异。
 * 纯阅读器（无 moyu）同样暴露：这是 moyu 把既有 reader 缺陷钉成了确定复现。
 *
 * 判据修法（待批）：章间空档是后一章的「引导页」——读数越过本章块尾（严格 >）且
 * 未到下一章块顶时，归下一章 @0。连续锚点（下一章块顶 == 本章块尾）不受影响。
 * 本文件里标「今日实然」的断言在修法落地前是红的——它们就是复现。
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
    // 今日实然：{ chapterIndex: 1, offsetRatio: 1 } —— 跳到第 2 章后第一帧视口读数把它推翻
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

describe('ReaderSession：跳到已挂载相邻章，落位取整差 0.125px 不得回弹', () => {
  it('settle 落位 → 视口读数：位置必须钉在目标章（今日实然：回弹 (1,1)）', async () => {
    const port = fakePort()
    // 浏览器实测：scrollTop 赋值四舍五入到整数（123.6 → 124）。假件原样存值，
    // 这正是 jsdom 测试面对这类缺陷全盲的原因——在这里把取整补上。
    const rawSetScrollTop = port.setScrollTop.bind(port)
    port.setScrollTop = (px: number): void => { rawSetScrollTop(Math.round(px)) }

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
    session.afterRender()                                // settleJump：赋 7138.125 → 取整 7138；提交 (2,0)
    session.feedViewport()                               // 诚实判据：contentTop 7178 差 0.125 压不到线

    // 今日实然：currentChapter 回弹成 1、存档写成 (1,1) —— 与活体遥测的 +97ms 那一笔一致
    expect(session.state.currentChapter).toBe(2)
    expect(saves.at(-1)).toEqual([2, 0])
    session.dispose()
  })
})
