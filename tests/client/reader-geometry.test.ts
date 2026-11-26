import { describe, expect, it } from 'vitest'
import { createReaderGeometry } from '../../src/client/reader-geometry.js'

/** 只实现几何读取用到的面：rect.top/height、滚动读数、按 data-novel-node 取节点 */
interface FakeNode {
  attrs: Record<string, string>
  top: number
  height: number
  getAttribute(name: string): string | null
  getBoundingClientRect(): DOMRect
}

const node = (nodeId: string, top: number, height = 20): FakeNode => ({
  attrs: { 'data-novel-node': nodeId }, top, height,
  getAttribute(name) { return this.attrs[name] ?? null },
  getBoundingClientRect() { return { top: this.top, height: this.height } as DOMRect },
})

interface FakeBlock extends FakeNode {
  nodes: FakeNode[]
  querySelectorAll(): FakeNode[]
}

const block = (top: number, height: number, nodes: FakeNode[] = []): FakeBlock => ({
  ...node('', top, height),
  nodes,
  querySelectorAll() { return this.nodes },
})

interface FakePort extends FakeNode {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

const port = (top: number, scrollTop: number, scrollHeight = 5000, clientHeight = 800): FakePort => ({
  ...node('', top, clientHeight),
  scrollTop, scrollHeight, clientHeight,
  getBoundingClientRect() { return { top: this.top, height: this.clientHeight } as DOMRect },
})

const asEl = (el: FakeNode): HTMLElement => el as unknown as HTMLElement

function geometryOf(parts: {
  port: FakePort
  sentinel?: FakeNode | null
  chapters?: Array<FakeBlock | null>
}) {
  const chapters = parts.chapters ?? []
  return createReaderGeometry({
    port: () => asEl(parts.port),
    sentinel: () => (parts.sentinel === undefined || parts.sentinel === null ? null : asEl(parts.sentinel)),
    chapters: () => chapters.map((c) => (c === null ? null : asEl(c))),
  })
}

describe('createReaderGeometry（ReaderPort 的纯几何实现）', () => {
  it('measureAnchors：章块相对内容原点的偏移 + 渲染高度', () => {
    const c0 = block(100, 200)
    const c1 = block(300, 100)
    const g = geometryOf({ port: port(100, 50), chapters: [c0, c1] })
    expect(g.measureAnchors()).toEqual([
      { index: 0, start: 50, height: 200 },
      { index: 1, start: 250, height: 100 },
    ])
  })

  it('滚动读数：scrollTop / setScrollTop / viewHeight / scrollHeight', () => {
    const p = port(100, 50, 5000, 800)
    const g = geometryOf({ port: p })
    expect(g.scrollTop()).toBe(50)
    expect(g.viewHeight()).toBe(800)
    expect(g.scrollHeight()).toBe(5000)
    g.setScrollTop(123)
    expect(p.scrollTop).toBe(123)
  })

  it('sentinelOffset：相对滚动视口顶；哨兵不在 DOM → null', () => {
    const g = geometryOf({ port: port(100, 50), sentinel: node('', 400) })
    expect(g.sentinelOffset()).toBe(300)
    expect(geometryOf({ port: port(100, 50), sentinel: null }).sentinelOffset()).toBeNull()
  })

  it('targetOffset：章块顶 / 章内锚点 / 缺席', () => {
    const c0 = block(100, 200, [node('n1', 90), node('n2', 150)])
    const c1 = block(300, 100)
    const g = geometryOf({ port: port(100, 50), chapters: [c0, c1] })
    expect(g.targetOffset(0, null)).toBe(0)
    expect(g.targetOffset(1, null)).toBe(200)
    expect(g.targetOffset(0, 'n2')).toBe(50)
    expect(g.targetOffset(0, 'missing')).toBeNull()
    expect(g.targetOffset(9, null)).toBeNull()
  })

  it('targetOffsets：一次建章内索引服务多个锚点，与逐个 targetOffset 同结果', () => {
    const c0 = block(100, 200, [node('n1', 90), node('n2', 150), node('n3', 190)])
    const g = geometryOf({ port: port(100, 50), chapters: [c0] })
    expect(g.targetOffsets(0, [null, 'n1', 'n2', 'missing'])).toEqual([0, -10, 50, null])
    expect(g.targetOffsets(9, [null, 'n1'])).toEqual([null, null])
    // 与逐个调用同读数（会话侧的批量快路径靠这条等价性成立）
    for (const anchorId of [null, 'n1', 'n2', 'missing'] as const) {
      expect(g.targetOffsets(0, [anchorId])[0]).toBe(g.targetOffset(0, anchorId))
    }
  })

  it('currentNode：取已越过视口顶的最靠下节点；都在下方取第一个；无节点 → null', () => {
    const c0 = block(100, 200, [node('n1', 90), node('n2', 150)])
    const c1 = block(300, 100, [node('n3', 400)])
    const g = geometryOf({ port: port(100, 50), chapters: [c0, c1] })
    expect(g.currentNode()).toEqual({ index: 0, nodeId: 'n1', offsetWithinNode: 10 })

    const below = geometryOf({
      port: port(100, 50),
      chapters: [block(100, 100, [node('a', 150), node('b', 200)])],
    })
    expect(below.currentNode()).toEqual({ index: 0, nodeId: 'a', offsetWithinNode: -50 })

    const textOnly = geometryOf({ port: port(100, 50), chapters: [block(100, 100)] })
    expect(textOnly.currentNode()).toBeNull()
  })

  it('纯文本章（仅有 data-pidx、无 data-novel-node）也能采点与反查偏移，支撑文字章排版复位', () => {
    const pidxNode = (pidx: number, top: number, height = 20): FakeNode => ({
      attrs: { 'data-pidx': String(pidx) }, top, height,
      getAttribute(name) { return this.attrs[name] ?? null },
      getBoundingClientRect() { return { top: this.top, height: this.height } as DOMRect },
    })
    const c0 = block(100, 300, [pidxNode(0, 70), pidxNode(1, 130), pidxNode(2, 220)])
    const g = geometryOf({ port: port(100, 50), chapters: [c0] })
    const cur = g.currentNode()
    expect(cur).toEqual({ index: 0, nodeId: 'pidx:0', offsetWithinNode: 30 })
    expect(g.targetOffset(0, cur?.nodeId ?? null)).toBe(-30)
    expect(g.targetOffsets(0, [null, 'pidx:0', 'pidx:2', 'pidx:bad'])).toEqual([0, -30, 120, null])
  })

  it('纯文本章视口顶落在章标题上（首段之前）时以 pidx:head 为锚，不回退到上一章末段', () => {
    const pidxNode = (pidx: number, top: number, height = 20): FakeNode => ({
      attrs: { 'data-pidx': String(pidx) }, top, height,
      getAttribute(name) { return this.attrs[name] ?? null },
      getBoundingClientRect() { return { top: this.top, height: this.height } as DOMRect },
    })
    const headingNode = (top: number, height = 40): FakeNode => ({
      attrs: { class: 'novel-rdr-mark' }, top, height,
      getAttribute(name) { return this.attrs[name] ?? null },
      getBoundingClientRect() { return { top: this.top, height: this.height } as DOMRect },
    })
    const c0 = block(0, 200, [pidxNode(0, 20), pidxNode(1, 120)])
    const c1 = block(220, 300, [headingNode(220, 40), pidxNode(0, 280), pidxNode(1, 340)])
    const g = geometryOf({ port: port(240, 240), chapters: [c0, c1] })
    const cur = g.currentNode()
    expect(cur).toEqual({ index: 1, nodeId: 'pidx:head', offsetWithinNode: 20 })
    expect(g.targetOffset(1, 'pidx:head')).toBe(-20)
    expect(g.targetOffsets(1, [null, 'pidx:head', 'pidx:0'])).toEqual([-20, -20, 40])
  })

  it('纯文本章含空行/纯标点行与正文共享同一 data-pidx 时，采点与反查统一命中最后一个正文块', () => {
    const pidxNode = (pidx: number, top: number, height = 20): FakeNode => ({
      attrs: { 'data-pidx': String(pidx) }, top, height,
      getAttribute(name) { return this.attrs[name] ?? null },
      getBoundingClientRect() { return { top: this.top, height: this.height } as DOMRect },
    })
    // 模拟第 0 行是空行/纯标点（top=60）与第 1 行真实正文（top=120）共享 data-pidx="0"
    const c0 = block(50, 300, [pidxNode(0, 60), pidxNode(0, 120), pidxNode(1, 200)])
    const g = geometryOf({ port: port(150, 50), chapters: [c0] })
    const cur = g.currentNode()
    expect(cur).toEqual({ index: 0, nodeId: 'pidx:0', offsetWithinNode: 30 })
    expect(g.targetOffset(0, 'pidx:0')).toBe(-30)
    expect(g.targetOffsets(0, ['pidx:0', 'pidx:1'])).toEqual([-30, 50])
  })

  it('章块未渲染（null 洞）跳过，不改变章号', () => {
    const g = geometryOf({ port: port(0, 0), chapters: [null, block(100, 50)] })
    expect(g.measureAnchors()).toEqual([{ index: 1, start: 100, height: 50 }])
  })
})
