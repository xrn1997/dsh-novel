import { describe, expect, it } from 'vitest'
import { locateChapter } from '../../src/client/progress.js'
import { currentNodeOf } from '../../src/client/reader-geometry.js'
import { readingPositionAt } from '../../src/client/tts/reading-position.js'
import { clampTopInset, crossedIndex } from '../../src/client/viewport-top.js'
import type { ChapterAnchor } from '../../src/client/progress.js'

/**
 * 「视口顶落在哪一项上」的判据、遮挡夹取与跨 module 等价钉子。
 *
 * 这里钉的不是三条数据路本身（各自的 adapter 断言住 `logic.test.ts` / `reader-geometry.test.ts` /
 * `tts-bar.test.tsx`），而是**同一条边界口径**：同一张合成页面分别喂给进度锚点、正文节点、
 * 听书块矩形三条路，当前章必须一致。规则改写一处而另一处没跟，红在这里。
 * 合成页必须**忠实**：节点/段块矩形铺满章块的内容区（真实排版里段间只有 margin 缝，块内不存在
 * 无主空带）——否则「块内深处」会被空档判据误翻进下一章，钉子钉的就是假页面的几何而不是判据。
 */

/** 假元素只实现几何读取用到的面：rect.top/bottom/height、标签与单元格归属、按属性取子元素、getAttribute。 */
interface FakeEl {
  top: number
  height: number
  tagName: string
  attrs: Record<string, string>
  children: FakeEl[]
  getAttribute(name: string): string | null
  closest(selector: string): Element | null
  getBoundingClientRect(): DOMRect
  querySelectorAll(selector: string): FakeEl[]
}

const fake = (
  top: number, height = 20, attrs: Record<string, string> = {}, children: FakeEl[] = [], tagName = 'P', inCell = false,
): FakeEl => ({
  top, height, tagName, attrs, children,
  getAttribute(name) { return this.attrs[name] ?? null },
  closest() { return inCell ? (this as unknown as Element) : null },
  getBoundingClientRect() { return { top: this.top, height: this.height, bottom: this.top + this.height } as DOMRect },
  querySelectorAll(selector) {
    // 产品只查 `[attr]` 形态（`novelNodes` / `[data-pidx]`）：假元素的检索面按此收窄，够用即可
    const key = selector.slice(1, -1)
    const out: FakeEl[] = []
    const walk = (els: FakeEl[]): void => {
      for (const el of els) {
        if (key in el.attrs) out.push(el)
        walk(el.children)
      }
    }
    walk(this.children)
    return out
  },
})

const asEl = (el: FakeEl): HTMLElement => el as unknown as HTMLElement

/** 一张合成页面：每章 = 块（内容坐标 [top, top+height)）+ 一个铺满块正文的节点 + 一个铺满块正文的
 *  带 data-pidx 的正文段；`top` 与前一章 `top + height` 之间可有无内容空档。
 *  给各路径的读数都从同一组内容坐标换算（`rect.top = 内容坐标 - scrollTop`，视口顶 = 0）。 */
interface PageChapter { index: number; top: number; height: number; pid: number }

function pageOf(chapters: PageChapter[], scrollTop: number): {
  anchors: ChapterAnchor[]
  blocks: Array<HTMLElement | null>
} {
  const anchors = chapters.map((c) => ({ index: c.index, start: c.top, height: c.height }))
  // 块按**章号**落格（`chapterRefs.current[i]` 是第 i 章）：缺章留洞，不是把后面一章前移
  const size = chapters.reduce((n, c) => Math.max(n, c.index + 1), 0)
  const blocks: Array<HTMLElement | null> = new Array<HTMLElement | null>(size).fill(null)
  for (const c of chapters) {
    // 节点与段矩形铺满块内容区（[top, top+height)）：忠实页里块内没有无主带，缝只在块间
    blocks[c.index] = asEl(fake(c.top - scrollTop, c.height, { 'data-chapter': String(c.index) }, [
      fake(c.top - scrollTop, c.height, { 'data-novel-node': `n${c.index}` }),
      fake(c.top - scrollTop, c.height, { 'data-pidx': String(c.pid) }),
    ], 'DIV'))
  }
  return { anchors, blocks }
}

// 首尾相接页：章顶 = 上一块块尾，空档判据对它必须全程无操作
const page: PageChapter[] = [
  { index: 0, top: 0, height: 1000, pid: 0 },
  { index: 1, top: 1000, height: 1200, pid: 3 },
  { index: 2, top: 2200, height: 800, pid: 7 },
]

// 带缝页：章间 48px 空档（`.novel-rdr-body [data-chapter] + [data-chapter] { margin-top: 48px }` 的形状）
const gapped: PageChapter[] = [
  { index: 0, top: 0, height: 1000, pid: 0 },
  { index: 1, top: 1048, height: 1200, pid: 3 },
  { index: 2, top: 2296, height: 800, pid: 7 },
]

/** 三条路各自给出的当前章；顺序 = 锚点 / 节点 / 听书块 */
function chaptersAt(chs: PageChapter[], scrollTop: number): number[] {
  const { anchors, blocks } = pageOf(chs, scrollTop)
  return [
    locateChapter(anchors, scrollTop).chapterIndex,
    currentNodeOf(blocks, 0)?.index ?? -1,
    readingPositionAt(blocks, 0)?.chapterIndex ?? -1,
  ]
}

describe('crossedIndex（视口顶判据的唯一一份）', () => {
  // 点项（start == end）：只测落项与回落骨架；空档/块尾边界用区间项单钉
  const point = (top: number) => ({ start: top, end: top })

  it('取最后一条起点已越过的；一条都没越过回落文档序第一个；空表 → -1', () => {
    const tops = [-300, -100, 0, 50]
    expect(crossedIndex(tops, point)).toBe(2)           // 0 正好压在视口顶也算已越过（<=）
    expect(crossedIndex(tops, (top) => point(top - 50))).toBe(3)   // 全部越过 → 最后一条
    expect(crossedIndex([50, 80], point)).toBe(0)       // 无命中 → 第一个
    expect(crossedIndex([], point)).toBe(-1)
  })

  it('跳过空洞：null 显式占位与缺席下标都不参与比较、也不当回落项', () => {
    expect(crossedIndex<number>([null, -10, undefined, -20], point)).toBe(3)
    expect(crossedIndex<number>([null, 10], point)).toBe(1)     // 首个非空项即回落项
    expect(crossedIndex<number>([null, undefined], point)).toBe(-1)
    const sparse: Array<number | null | undefined> = []
    sparse[2] = -5
    expect(crossedIndex(sparse, point)).toBe(2)
  })

  it('空档归下一项：已落项块尾严格在上线之上、下一项起点在下 → 线落空档，归下一项（ADR-0106）', () => {
    const gapItems = [{ start: -200, end: -100 }, { start: 50, end: 250 }]
    expect(crossedIndex(gapItems, (i) => i)).toBe(1)
    // 没有下一项（缝在表尾 / 未挂载）：留在已落项，不凭空造项
    expect(crossedIndex([{ start: -200, end: -100 }], (i) => i)).toBe(0)
  })

  it('块尾正压线仍归本项（起点 `<=`、块尾严格 `<`：正常读到块底不许跳章）', () => {
    expect(crossedIndex([{ start: -100, end: 0 }, { start: 48, end: 200 }], (i) => i)).toBe(0)
  })

  it('零高项不占线：整条离线就让位下一项，压线（start == end == 0）才算占线', () => {
    expect(crossedIndex([{ start: -50, end: -50 }, { start: 10, end: 20 }], (i) => i)).toBe(1)
    expect(crossedIndex([{ start: 0, end: 0 }, { start: 10, end: 20 }], (i) => i)).toBe(0)
  })

  it('非有限起点（NaN / ±Infinity）不参与越过与空档判断：回落骨架仍按非空项（输入端保证有限，此钉兜腐坏调用方）', () => {
    const nan = { start: Number.NaN, end: Number.NaN }
    const posInf = { start: Number.POSITIVE_INFINITY, end: Number.POSITIVE_INFINITY }
    const negInf = { start: Number.NEGATIVE_INFINITY, end: Number.NEGATIVE_INFINITY }
    expect(crossedIndex([{ start: -200, end: -100 }, nan], (i) => i)).toBe(0)          // 缝后没有可判的下一项 → 留在本项
    expect(crossedIndex([{ start: -200, end: -100 }, nan, { start: 50, end: 90 }], (i) => i)).toBe(2) // 下一项跳过 NaN
    expect(crossedIndex([{ start: -200, end: -100 }, posInf, { start: 50, end: 90 }], (i) => i)).toBe(2)
    expect(crossedIndex([{ start: -200, end: -100 }, negInf, { start: 50, end: 90 }], (i) => i)).toBe(2)
    expect(crossedIndex([{ start: -200, end: 50 }, negInf], (i) => i)).toBe(0)         // -Infinity 不顶掉前面占线项
    expect(crossedIndex([nan], (i) => i)).toBe(0)                                      // 无命中 → 回落仍按非空
    expect(crossedIndex([negInf], (i) => i)).toBe(0)                                   // 全无效 → 回落仍按非空
  })

  it('块尾非有限（NaN / ±Infinity）没有离线证据：按占线处理，不凭空翻到下一项', () => {
    const followed = [{ start: 50, end: 250 }]
    expect(crossedIndex([{ start: -200, end: Number.NaN }, ...followed], (i) => i)).toBe(0)
    expect(crossedIndex([{ start: -200, end: Number.POSITIVE_INFINITY }, ...followed], (i) => i)).toBe(0)
    expect(crossedIndex([{ start: -200, end: Number.NEGATIVE_INFINITY }, ...followed], (i) => i)).toBe(0)
  })

  it('非单调输入：后续项再次越过时复位空档候选，候选永不回取 best 之前的项', () => {
    expect(crossedIndex([{ start: -200, end: -100 }, { start: 50, end: 100 }, { start: -10, end: 50 }], (i) => i)).toBe(2)
    expect(crossedIndex([{ start: 100, end: 200 }, { start: -50, end: -20 }, { start: 30, end: 80 }], (i) => i)).toBe(2)
    expect(crossedIndex([{ start: 100, end: 200 }, { start: -50, end: -20 }], (i) => i)).toBe(1)
  })

  it('覆盖项不得被更晚的非覆盖项顶成空档：嵌套块与并排单元格同口径', () => {
    // 父段 [10,200] 尾部仍跨线；段内图 [50,120] 已整条离线；下一段 [220,270] 在下方 → 归父段
    expect(crossedIndex([
      { start: -140, end: 50 }, { start: -100, end: -30 }, { start: 70, end: 150 },
    ], (i) => i)).toBe(0)
    // 覆盖项内部的子块缝仍归下一子项：[90,210] 内 refpart1 已离线、refpart2 在下方
    expect(crossedIndex([
      { start: -50, end: 70 }, { start: -50, end: -10 }, { start: 10, end: 70 },
    ], (i) => i)).toBe(2)
    // 并排单元格形状：左格高段跨线、右格短段离线、下一行在下方 → 归覆盖线的高段
    expect(crossedIndex([
      { start: -150, end: 150 }, { start: -150, end: -50 }, { start: 150, end: 250 },
    ], (i) => i)).toBe(0)
    // 纵向重叠但不被覆盖项包含（rowspan 形状）：下一项块尾出了覆盖项块尾 → 仍归覆盖项
    expect(crossedIndex([
      { start: -150, end: 100 }, { start: -150, end: -50 }, { start: 80, end: 140 },
    ], (i) => i)).toBe(0)
  })
})

describe('readingPositionAt（章内段间空档同口径）', () => {
  it('段间空档落下一段；末段离线且无下段时留在末段', () => {
    const block = asEl(fake(0, 500, {}, [
      fake(20, 40, { 'data-pidx': '0' }),
      fake(100, 60, { 'data-pidx': '1' }),
    ], 'DIV'))
    expect(readingPositionAt([block], 80)).toEqual({ chapterIndex: 0, paragraphIndex: 1 })
    expect(readingPositionAt([block], 200)).toEqual({ chapterIndex: 0, paragraphIndex: 1 })
  })

  it('并排单元格：左格高段仍跨线时，段号不得被右格离线短段带翻到下一行', () => {
    const block = asEl(fake(0, 500, {}, [
      fake(0, 300, { 'data-pidx': '0' }),     // 左格高段 [0,300] 跨线
      fake(0, 100, { 'data-pidx': '3' }),     // 右格短段 [0,100] 已离线
      fake(300, 100, { 'data-pidx': '1' }),   // 下一行 [300,400] 在下方
    ], 'DIV'))
    expect(readingPositionAt([block], 150)).toEqual({ chapterIndex: 0, paragraphIndex: 0 })
  })
})

describe('clampTopInset（顶条遮挡的夹取只有一份，ADR-0089）', () => {
  it('负值与缺席都归零；正当读数原样过', () => {
    expect(clampTopInset(-12)).toBe(0)
    expect(clampTopInset(undefined)).toBe(0)
    expect(clampTopInset(0)).toBe(0)
    expect(clampTopInset(40)).toBe(40)
  })
})

describe('三条数据路边界一致（锚点 / 节点 rect / 听书块 rect）', () => {
  it('章界与亚像素：同一滚动位三条路判同一章（首尾相接页：空档判据无操作）', () => {
    const cases: Array<{ top: number; chapter: number; why: string }> = [
      { top: -100, chapter: 0, why: '视口在全书之前 → 无命中回落第一章' },
      { top: 0, chapter: 0, why: '章顶正好压在视口顶也算已越过' },
      { top: 999, chapter: 0, why: '仍在第一章内' },
      { top: 1000, chapter: 1, why: '第二章章顶 = 边界，归第二章' },
      { top: 1000.5, chapter: 1, why: '亚像素越过章顶同样归第二章' },
      { top: 1600, chapter: 1, why: '第二章中段' },
      { top: 2199, chapter: 1, why: '第三章章顶前一像素' },
      { top: 2200, chapter: 2, why: '第三章章顶 = 边界，归第三章' },
      { top: 2999, chapter: 2, why: '末章内' },
      { top: 99_999, chapter: 2, why: '滚过头 → 最后一条已越过的' },
    ]
    for (const c of cases) {
      expect(chaptersAt(page, c.top), `${c.why}（scrollTop=${c.top}）`).toEqual([c.chapter, c.chapter, c.chapter])
    }
  })

  it('章间空档：同一缝位三条路同归下一章（缝不许只归进度侧，ADR-0106）', () => {
    const cases: Array<{ top: number; chapter: number; why: string }> = [
      { top: 1000, chapter: 0, why: '缝口 = 块尾正压线，仍归上一章 @1' },
      { top: 1000.5, chapter: 1, why: '刚进缝（亚像素）：归下一章，进度侧回弹链在节点/探针侧同样不许成立' },
      { top: 1024, chapter: 1, why: '缝中段' },
      { top: 1047.9, chapter: 1, why: '缝出口前一尘：归下一章 @0' },
      { top: 1048, chapter: 1, why: '下一章块顶压线：起点 `<=` 照旧归它' },
      { top: 2290, chapter: 2, why: '第二道缝：同口径' },
      { top: 3096, chapter: 2, why: '末章块尾之后无下一项：留在末章 @1' },
    ]
    for (const c of cases) {
      expect(chaptersAt(gapped, c.top), `${c.why}（scrollTop=${c.top}）`).toEqual([c.chapter, c.chapter, c.chapter])
    }
    // 缝里读数与进度侧同值：下一章 @0，不是上一章 @1
    const { anchors, blocks } = pageOf(gapped, 1024)
    expect(locateChapter(anchors, 1024)).toEqual({ chapterIndex: 1, offsetRatio: 0 })
    expect(readingPositionAt(blocks, 0)).toEqual({ chapterIndex: 1, paragraphIndex: 3 })
    expect(currentNodeOf(blocks, 0)).toMatchObject({ index: 1, nodeId: 'n1', offsetWithinNode: -24 })
  })

  it('已载窗口有洞：三条路都跳过缺章，落到同一个在载章', () => {
    // 跳章打开：第 1 章不在 DOM（窗口 [0, 2]），第 2 章块因此紧接着第 0 章块。
    const holed: PageChapter[] = [
      { index: 0, top: 0, height: 1000, pid: 0 },
      { index: 2, top: 1000, height: 800, pid: 7 },
    ]
    for (const scrollTop of [0, 500, 999, 1000, 1500]) {
      const { anchors, blocks } = pageOf(holed, scrollTop)
      const expected = scrollTop >= 1000 ? 2 : 0
      expect([
        locateChapter(anchors, scrollTop).chapterIndex,
        currentNodeOf(blocks, 0)?.index ?? -1,
        readingPositionAt(blocks, 0)?.chapterIndex ?? -1,
      ], `scrollTop=${scrollTop}`).toEqual([expected, expected, expected])
    }
  })

  it('有洞又有缝：洞后的缝照归在载的下一章，null 格不当下一项', () => {
    // 窗口 [0, 2]（第 1 章没挂载）：ch0 块尾到 ch2 块顶之间全是无内容带，归 ch2。
    const holedGap: PageChapter[] = [
      { index: 0, top: 0, height: 1000, pid: 0 },
      { index: 2, top: 1100, height: 800, pid: 7 },
    ]
    for (const scrollTop of [1001, 1050, 1099]) {
      expect(chaptersAt(holedGap, scrollTop), `scrollTop=${scrollTop}`).toEqual([2, 2, 2])
    }
  })

  it('真实富文本章（末段含行内 <em>/<button>/<br>）：末段中段与章间空档均保三条路同章', () => {
    const anchors: ChapterAnchor[] = [
      { index: 0, start: 0, height: 500 },
      { index: 1, start: 548, height: 400 },
    ]
    const makeRichBlocks = (scrollTop: number): HTMLElement[] => [
      asEl(fake(0 - scrollTop, 500, { 'data-chapter': '0' }, [
        fake(0 - scrollTop, 200, { 'data-novel-node': 'c0-p0', 'data-pidx': '0' }),
        fake(220 - scrollTop, 280, { 'data-novel-node': 'c0-p1', 'data-pidx': '1' }, [
          fake(224 - scrollTop, 20, { 'data-novel-node': 'c0-em' }, [], 'EM'),
          fake(244 - scrollTop, 0, { 'data-novel-node': 'c0-br' }, [], 'BR'),
          fake(250 - scrollTop, 20, { 'data-novel-node': 'c0-lnk', class: 'novel-ref' }, [], 'BUTTON'),
        ]),
      ], 'DIV')),
      asEl(fake(548 - scrollTop, 400, { 'data-chapter': '1' }, [
        fake(548 - scrollTop, 400, { 'data-novel-node': 'c1-p0', 'data-pidx': '0' }),
      ], 'DIV')),
    ]
    // scrollTop = 320：行内节点（224~270）已滚出视口，但末段 c0-p1 [220, 500] 仍在屏上 → 三条路同判第 0 章
    const midBlocks = makeRichBlocks(320)
    expect([
      locateChapter(anchors, 320).chapterIndex,
      currentNodeOf(midBlocks, 0)?.index ?? -1,
      readingPositionAt(midBlocks, 0)?.chapterIndex ?? -1,
    ]).toEqual([0, 0, 0])
    expect(currentNodeOf(midBlocks, 0)).toEqual({ index: 0, nodeId: 'c0-p1', offsetWithinNode: 100 })

    // scrollTop = 520：落在章间 48px 空档 [500, 548] → 三条路同判第 1 章
    const gapBlocks = makeRichBlocks(520)
    expect([
      locateChapter(anchors, 520).chapterIndex,
      currentNodeOf(gapBlocks, 0)?.index ?? -1,
      readingPositionAt(gapBlocks, 0)?.chapterIndex ?? -1,
    ]).toEqual([1, 1, 1])
  })
})
