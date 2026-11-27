import { describe, expect, it } from 'vitest'
import { createReaderGeometry, currentNodeOf } from '../../src/client/reader-geometry.js'

/** 只实现几何读取用到的面：rect.top/bottom/height、滚动读数、按 data-novel-node / data-pidx 取节点 */
interface FakeNode {
  attrs: Record<string, string>
  tagName: string
  top: number
  height: number
  getAttribute(name: string): string | null
  closest(selector: string): Element | null
  getBoundingClientRect(): DOMRect
}

interface NodeOpts { tagName?: string; className?: string; inCell?: boolean }

const elNode = (attrs: Record<string, string>, top: number, height = 20, opts: NodeOpts = {}): FakeNode => ({
  attrs: opts.className === undefined ? attrs : { ...attrs, class: opts.className },
  tagName: opts.tagName ?? 'P',
  top,
  height,
  getAttribute(name) { return this.attrs[name] ?? null },
  closest() { return opts.inCell === true ? (this as unknown as Element) : null },
  getBoundingClientRect() { return { top: this.top, bottom: this.top + this.height, height: this.height } as DOMRect },
})

const node = (nodeId: string, top: number, height = 20, opts?: NodeOpts): FakeNode =>
  elNode({ 'data-novel-node': nodeId }, top, height, opts)

const pidxNode = (pidx: number, top: number, height = 20): FakeNode =>
  elNode({ 'data-pidx': String(pidx) }, top, height)

const headingNode = (top: number, height = 40): FakeNode =>
  elNode({ class: 'novel-rdr-mark' }, top, height, { tagName: 'H2' })

interface FakeBlock extends FakeNode {
  nodes: FakeNode[]
  querySelectorAll(selector: string): FakeNode[]
}

const matchesSelector = (el: FakeNode, selector: string): boolean => {
  if (selector === 'h2.novel-rdr-mark') {
    return el.tagName.toUpperCase() === 'H2'
      && (el.attrs['class']?.split(/\s+/).includes('novel-rdr-mark') ?? false)
  }
  if (selector.startsWith('[') && selector.endsWith(']')) {
    return selector.slice(1, -1) in el.attrs
  }
  return false
}

const block = (top: number, height: number, nodes: FakeNode[] = []): FakeBlock => ({
  ...elNode({}, top, height, { tagName: 'DIV' }),
  nodes,
  querySelectorAll(selector: string) { return this.nodes.filter((n) => matchesSelector(n, selector)) },
})

interface FakePort extends FakeNode {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

const port = (top: number, scrollTop: number, scrollHeight = 5000, clientHeight = 800): FakePort => ({
  ...node('', top, clientHeight, { tagName: 'DIV' }),
  scrollTop, scrollHeight, clientHeight,
  getBoundingClientRect() { return { top: this.top, bottom: this.top + this.clientHeight, height: this.clientHeight } as DOMRect },
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
    const c0 = block(100, 300, [pidxNode(0, 70, 50), pidxNode(1, 130), pidxNode(2, 220)])
    const g = geometryOf({ port: port(100, 50), chapters: [c0] })
    const cur = g.currentNode()
    expect(cur).toEqual({ index: 0, nodeId: 'pidx:0', offsetWithinNode: 30 })
    expect(g.targetOffset(0, cur?.nodeId ?? null)).toBe(-30)
    expect(g.targetOffsets(0, [null, 'pidx:0', 'pidx:2', 'pidx:bad'])).toEqual([0, -30, 120, null])
  })

  it('纯文本章视口顶落在章标题上（首段之前）时以 pidx:head 为锚，不回退到上一章末段', () => {
    const c0 = block(0, 200, [pidxNode(0, 20), pidxNode(1, 120)])
    const c1 = block(220, 300, [headingNode(220, 40), pidxNode(0, 280), pidxNode(1, 340)])
    const g = geometryOf({ port: port(240, 240), chapters: [c0, c1] })
    const cur = g.currentNode()
    expect(cur).toEqual({ index: 1, nodeId: 'pidx:head', offsetWithinNode: 20 })
    expect(g.targetOffset(1, 'pidx:head')).toBe(-20)
    expect(g.targetOffsets(1, [null, 'pidx:head', 'pidx:0'])).toEqual([-20, -20, 40])
  })

  it('纯文本章含空行/纯标点行与正文共享同一 data-pidx 时，采点与反查统一命中最后一个正文块', () => {
    // 模拟第 0 行是空行/纯标点（top=60）与第 1 行真实正文（top=120, height=50）共享 data-pidx="0"
    const c0 = block(50, 300, [pidxNode(0, 60), pidxNode(0, 120, 50), pidxNode(1, 200)])
    const g = geometryOf({ port: port(150, 50), chapters: [c0] })
    const cur = g.currentNode()
    expect(cur).toEqual({ index: 0, nodeId: 'pidx:0', offsetWithinNode: 30 })
    expect(g.targetOffset(0, 'pidx:0')).toBe(-30)
    expect(g.targetOffsets(0, ['pidx:0', 'pidx:1'])).toEqual([-30, 50])
  })

  it('currentNodeOf：文字章标题与段块之间的空档归下一段（pidx: 路径同吃块区间）', () => {
    const c0 = block(0, 400, [headingNode(10, 40), pidxNode(0, 90, 60), pidxNode(1, 200, 50)])
    // viewTop = 70：标题 [10, 50] 之后、首段 [90, 150] 之前 → 归 pidx:0，偏移 -20
    expect(currentNodeOf([asEl(c0)], 70)).toEqual({ index: 0, nodeId: 'pidx:0', offsetWithinNode: -20 })
    // viewTop = 170：首段块尾 150 之后、次段 [200, 250] 之前 → 归 pidx:1
    expect(currentNodeOf([asEl(c0)], 170)).toEqual({ index: 0, nodeId: 'pidx:1', offsetWithinNode: -30 })
    // 块尾正压线（end == 0）仍归本段：读到段底不许跳段
    expect(currentNodeOf([asEl(c0)], 150)).toEqual({ index: 0, nodeId: 'pidx:0', offsetWithinNode: 60 })
  })

  it('currentNodeOf：段间空档归下一节点并给负 offsetWithinNode', () => {
    const c0 = block(0, 300, [node('n0', 20, 40), node('n1', 120, 60)])
    // viewTop = 80 落在 n0 [20, 60] 与 n1 [120, 180] 的段间空档
    expect(currentNodeOf([asEl(c0)], 80)).toEqual({ index: 0, nodeId: 'n1', offsetWithinNode: -40 })
  })

  it('currentNodeOf：富文本多行段含已滚出的行内节点时不触发假空档，且不跨章错位', () => {
    const c0 = block(0, 200, [
      node('p1', 10, 190),                                               // 多行父段 [10, 200]，仍在屏上
      node('em1', 12, 18, { tagName: 'EM' }),                            // 第 1 行内嵌行内节点，已滚出 viewTop=80
      node('b1', 32, 18, { tagName: 'STRONG' }),
      node('br1', 50, 0, { tagName: 'BR' }),
      node('sp1', 52, 16, { tagName: 'SPAN', className: 'inline' }),
      node('lnk1', 54, 16, { tagName: 'BUTTON', className: 'novel-ref' }),
    ])
    const c1 = block(248, 300, [node('c1-p0', 248, 80)])
    // viewTop = 80：仍在第 0 章 p1 下半段，绝不因 em1/lnk1 已离线而跳去第 1 章 c1-p0
    expect(currentNodeOf([asEl(c0), asEl(c1)], 80)).toEqual({ index: 0, nodeId: 'p1', offsetWithinNode: 70 })
  })

  it('currentNodeOf：.novel-fig / .novel-ref-part / .novel-ref-block 占独立块带，参与定位', () => {
    const c0 = block(0, 400, [
      node('fig1', 10, 40, { tagName: 'SPAN', className: 'novel-fig' }),
      node('refblk', 90, 120, { tagName: 'BUTTON', className: 'novel-ref novel-ref-block' }),
      node('refpart1', 90, 40, { tagName: 'SPAN', className: 'novel-ref-part' }),
      node('refpart2', 150, 60, { tagName: 'SPAN', className: 'novel-ref-part' }),
    ])
    // viewTop = 65 落在 fig1 [10, 50] 之后空档 → 归 refblk
    expect(currentNodeOf([asEl(c0)], 65)).toEqual({ index: 0, nodeId: 'refblk', offsetWithinNode: -25 })
    expect(currentNodeOf([asEl(c0)], 20)).toEqual({ index: 0, nodeId: 'fig1', offsetWithinNode: 10 })
    // viewTop = 140 落在 refpart1 [90, 130] 之后空档 → 归下一块 refpart2
    expect(currentNodeOf([asEl(c0)], 140)).toEqual({ index: 0, nodeId: 'refpart2', offsetWithinNode: -10 })
  })

  it('currentNodeOf：段内插图已整条离线、父段尾部仍跨线时，不翻到下一段（嵌套块不造假空档）', () => {
    const c0 = block(0, 300, [
      node('p1', 10, 190),                                                // 父段 [10,200] 尾部跨线
      node('fig1', 50, 70, { tagName: 'SPAN', className: 'novel-fig' }),  // 段内图 [50,120] 已离线
      node('p2', 220, 50),                                                // 下一段 [220,270] 在下方
    ])
    expect(currentNodeOf([asEl(c0)], 150)).toEqual({ index: 0, nodeId: 'p1', offsetWithinNode: 140 })
  })

  it('currentNodeOf：表格行 TR 下的并排单元格 TD/TH 不触发假空档，锚定在 TR', () => {
    const c0 = block(0, 300, [
      node('tr1', 20, 120, { tagName: 'TR' }),
      node('td1', 20, 30, { tagName: 'TD', inCell: true }),
      node('cell-p', 20, 30, { tagName: 'P', inCell: true }),
      node('p-after', 180, 40),
    ])
    expect(currentNodeOf([asEl(c0)], 80)).toEqual({ index: 0, nodeId: 'tr1', offsetWithinNode: 60 })
  })

  it('currentNodeOf：仅含裸行内节点的图文章兜底回退，不平白丢掉唯一锚点', () => {
    const c0 = block(0, 120, [node('only-em', 20, 60, { tagName: 'EM' })])
    expect(currentNodeOf([asEl(c0)], 40)).toEqual({ index: 0, nodeId: 'only-em', offsetWithinNode: 20 })
  })

  it('章块未渲染（null 洞）跳过，不改变章号', () => {
    const g = geometryOf({ port: port(0, 0), chapters: [null, block(100, 50)] })
    expect(g.measureAnchors()).toEqual([{ index: 1, start: 100, height: 50 }])
  })
})
