import { vi } from 'vitest'
import type { Mock } from 'vitest'
import { ROUTES, planarNavigation } from '../../src/shared/wire.js'
import type { ChapterAnchor } from '../../src/client/progress.js'
import type { ReaderPort, VisibleNode } from '../../src/client/reader-session.js'
import type { ChapterContent, ChapterEntry, NavigationItem } from '../../src/client/views/types.js'

/**
 * 阅读器测试的共用假件：会话几何端口、ResizeObserver 替身与真视图 / 播放层的 GET 路由分流。
 *
 * 三份几何桩原本各抄一份（阅读会话 / 图文载荷 / 迷你条），差异只在「留了哪些旋钮」；最全的一份
 * 收进这里后，缺的旋钮只是没人读，「同名桩读数不同」的漂移不再可能。ResizeObserver 与 GET 分流
 * 同理：它们都是 jsdom 里必须由用例自己补的平台面，两份假体各写一遍就各有一份会漂。
 */

/** 假 port 的完整形状：会话只读，测试可改字段、可读调用记录 */
export interface FakePort extends ReaderPort {
  /** 声明成属性：用例会摘下原实现包一层记次序（方法签名在 `unbound-method` 眼里算脱离对象调用） */
  measureAnchors: () => ChapterAnchor[]
  anchors: ChapterAnchor[]
  top: number
  height: number
  scrollH: number
  sentinel: number | null
  /** 章块顶相对视口顶的偏移（`targetOffset(index, null)` 的读数） */
  chapterOff: number | null
  /** 锚点 ID → 相对视口顶的偏移；未登记 = 该节点不在 DOM → null */
  targetOffs: Map<string, number>
  /** 视口顶所在正文节点（返回栈采点与排版复位共用） */
  node: VisibleNode | null
  /** currentNode 读取计数：排版前采点必须发生在 setPref 的同步栈里，退订后不读 */
  nodeReads: number
  /** 章内段块（`index:paragraphIndex`）的相对视口顶偏移与高度；未登记 = 不在 DOM */
  paragraphOffs: Map<string, { top: number; height: number }>
  /** setScrollTop 的调用记录（证明「不许落位」的用例：一次都不许发生） */
  tops: number[]
}

/** 可编程假 port：锚点 / 滚动 / 哨兵 / 目标测量全由测试摆布；`over` 只换起手读数。 */
export function fakePort(over: Partial<FakePort> = {}): FakePort {
  const port: FakePort = {
    anchors: [],
    top: 0,
    height: 1000,
    scrollH: 5000,
    sentinel: null,
    chapterOff: null,
    targetOffs: new Map(),
    node: null,
    nodeReads: 0,
    paragraphOffs: new Map(),
    tops: [],
    ...over,
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
    targetOffsetOfParagraph: (index: number, paragraphIndex: number) =>
      port.paragraphOffs.get(`${index}:${paragraphIndex}`) ?? null,
  }
  return port
}

/** 假 ResizeObserver：记观察点、留最近构造的实例；`disconnect` 之后的触发不再回调（与真实现同口径） */
export class FakeResizeObserver {
  /** 最近构造的实例的回调泵：用例手动触发一次「内容变高」 */
  static fire: (() => void) | null = null
  /** 最近构造的实例（阅读装摘用例读它的观察点） */
  static latest: FakeResizeObserver | null = null
  readonly observed: Element[] = []
  private alive = true
  constructor(cb: ResizeObserverCallback) {
    FakeResizeObserver.latest = this
    FakeResizeObserver.fire = () => { if (this.alive) cb([], this) }
  }
  observe(target: Element): void { this.observed.push(target) }
  unobserve(): void {}
  disconnect(): void { this.alive = false }
}

/** 真视图 / 播放层的 GET 读面：目录 → 正文 → 听书源清单 → 书架（其余路径按 `strict` 归书架或直接抛）。
 *  分流的四支本来就是同一套读数，差异只在「章数据从哪来、其余路径归谁」；各套件只填这两处。 */
export interface ReaderRouteReads {
  /** 线性目录（阅读单元）来源 */
  chapters: () => ChapterEntry[]
  /** 章号 → 正文；可以是异步的（用例用闸演「该章还在途」） */
  chapter: (index: number) => ChapterContent | Promise<ChapterContent>
  /** 导航展示树；缺省由线性目录派生（文字书的平面目录） */
  navigation?: () => NavigationItem[]
  /** 听书源清单；不传 = 该路由不归假件管，落到书架分支 */
  ttsSources?: () => unknown
  /** 书架读数：`shelf` 路由回它；未声明 `strict` 时其余路径也回它（真视图的缺省读数） */
  shelf: () => unknown
  /** true = 只认识目录 / 正文 / 源清单 / 书架四支，其余路径抛「unexpected GET」 */
  strict?: boolean
}

/** 一次 GET 的路由分流：`path` 里的 `index` 取章号（缺席按 0，与读者解析同口径） */
export function readerRouteGet(reads: ReaderRouteReads): (path: string) => Promise<unknown> {
  return async (path: string) => {
    if (path.startsWith('navigation')) {
      const chapters = reads.chapters()
      return { chapters, items: reads.navigation?.() ?? planarNavigation(chapters) }
    }
    if (path.startsWith('chapter')) {
      const m = /[?&]index=(\d+)/.exec(path)
      return reads.chapter(m === null ? 0 : Number(m[1]))
    }
    if (reads.ttsSources !== undefined && path === ROUTES.ttsSources.path) return reads.ttsSources()
    if (path === ROUTES.shelf.path || reads.strict !== true) return reads.shelf()
    throw new Error(`unexpected GET ${path}`)
  }
}

/** 同上，包成可断言的 Mock：`makeReaderDeps` 覆写 `apiGet` 时要这一形态。 */
export function readerRouteGetMock(reads: ReaderRouteReads): Mock {
  return vi.fn(readerRouteGet(reads))
}
