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
 */

/** 假元素只实现几何读取用到的面：rect.top、按属性取子元素、getAttribute。 */
interface FakeEl {
  top: number
  attrs: Record<string, string>
  children: FakeEl[]
  getAttribute(name: string): string | null
  getBoundingClientRect(): DOMRect
  querySelectorAll(selector: string): FakeEl[]
}

const fake = (top: number, attrs: Record<string, string> = {}, children: FakeEl[] = []): FakeEl => ({
  top, attrs, children,
  getAttribute(name) { return this.attrs[name] ?? null },
  getBoundingClientRect() { return { top: this.top, height: 20 } as DOMRect },
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

/** 一张章章首尾相接的合成页面：每章 = 块顶（内容坐标）+ 一个正文节点 + 一段带 data-pidx 的正文。
 *  给各路径的读数都从同一组内容坐标换算（`rect.top = 内容坐标 - scrollTop`，视口顶 = 0）。 */
interface PageChapter { index: number; top: number; height: number; nodeTop: number; pid: number; pidTop: number }

function pageOf(chapters: PageChapter[], scrollTop: number): {
  anchors: ChapterAnchor[]
  blocks: Array<HTMLElement | null>
} {
  const anchors = chapters.map((c) => ({ index: c.index, start: c.top, height: c.height }))
  // 块按**章号**落格（`chapterRefs.current[i]` 是第 i 章）：缺章留洞，不是把后面一章前移
  const size = chapters.reduce((n, c) => Math.max(n, c.index + 1), 0)
  const blocks: Array<HTMLElement | null> = new Array<HTMLElement | null>(size).fill(null)
  for (const c of chapters) {
    blocks[c.index] = asEl(fake(c.top - scrollTop, { 'data-chapter': String(c.index) }, [
      fake(c.nodeTop - scrollTop, { 'data-novel-node': `n${c.index}` }),
      fake(c.pidTop - scrollTop, { 'data-pidx': String(c.pid) }),
    ]))
  }
  return { anchors, blocks }
}

const page: PageChapter[] = [
  { index: 0, top: 0, height: 1000, nodeTop: 0, pid: 0, pidTop: 0 },
  { index: 1, top: 1000, height: 1200, nodeTop: 1000, pid: 3, pidTop: 1000 },
  { index: 2, top: 2200, height: 800, nodeTop: 2200, pid: 7, pidTop: 2200 },
]

/** 三条路各自给出的当前章；顺序 = 锚点 / 节点 / 听书块 */
function chaptersAt(scrollTop: number): number[] {
  const { anchors, blocks } = pageOf(page, scrollTop)
  return [
    locateChapter(anchors, scrollTop).chapterIndex,
    currentNodeOf(blocks, 0)?.index ?? -1,
    readingPositionAt(blocks, 0)?.chapterIndex ?? -1,
  ]
}

describe('crossedIndex（视口顶判据的唯一一份）', () => {
  it('取最后一条已越过视口顶的；一条都没越过回落文档序第一个；空表 → -1', () => {
    const tops = [-300, -100, 0, 50]
    expect(crossedIndex(tops, (top) => top)).toBe(2)           // 0 正好压在视口顶也算越过（<=）
    expect(crossedIndex(tops, (top) => top - 50)).toBe(3)       // 全部越过 → 最后一条
    expect(crossedIndex([50, 80], (top) => top)).toBe(0)       // 无命中 → 第一个
    expect(crossedIndex([], (top) => top)).toBe(-1)
  })

  it('跳过空洞：null 显式占位与缺席下标都不参与比较、也不当回落项', () => {
    expect(crossedIndex<number>([null, -10, undefined, -20], (top) => top)).toBe(3)
    expect(crossedIndex<number>([null, 10], (top) => top)).toBe(1)     // 首个非空项即回落项
    expect(crossedIndex<number>([null, undefined], (top) => top)).toBe(-1)
    const sparse: Array<number | null | undefined> = []
    sparse[2] = -5
    expect(crossedIndex(sparse, (top) => top)).toBe(2)
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
  it('章界与亚像素：同一滚动位三条路判同一章', () => {
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
      expect(chaptersAt(c.top), `${c.why}（scrollTop=${c.top}）`).toEqual([c.chapter, c.chapter, c.chapter])
    }
  })

  it('已载窗口有洞：三条路都跳过缺章，落到同一个在载章', () => {
    // 跳章打开：第 1 章不在 DOM（窗口 [0, 2]），第 2 章块因此紧接着第 0 章块。
    const holed: PageChapter[] = [
      { index: 0, top: 0, height: 1000, nodeTop: 0, pid: 0, pidTop: 0 },
      { index: 2, top: 1000, height: 800, nodeTop: 1000, pid: 7, pidTop: 1000 },
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
})
