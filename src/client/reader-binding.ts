import { createReaderGeometry } from './reader-geometry.js'
import type { ReaderPort } from './reader-session.js'
import type { ReaderViewportFeed } from './reader-session.js'
import { findScrollport, portViewTop } from './scrollport.js'
import { clampTopInset } from './viewport-top.js'
import type { ReadingPosition } from './tts/reading-position.js'
import { readingPositionAt, setReadingProbe } from './tts/reading-position.js'

/**
 * 阅读器的 DOM 侧绑定：「渲染后拍点」从视图搬出来后的唯一主人。
 *
 * 它拥有六件事：
 * (a) **这一帧要不要测量**——视图每次渲染只调一个无条件的门（`rendered`），拿会话的 DOM 版本
 *     （`state.domRevision`）与上次量过的比；比较住这里，视图不再枚举依赖数组（少列一条影响
 *     布局的来源就静默漏拍的那类缺陷，从此没有第二处可犯）。
 * (b) **帧泵**：测量排在帧上（生产 rAF、测试手动泵）——同一版的多帧渲染合并成一次拍点。
 * (c) **测量前刷新 ReaderPort**：帧体先找/刷新滚动容器再让会话读视口（内容变化后旧缓存量到的
 *     是上一版布局）。
 * (d) **装摘视口事件**：scroll 捕获、resize、内容尺寸变化（ResizeObserver）都并进会话的
 *     `feedViewport`；装摘经 `host` 注入（测试不装真 DOM）。
 * (e) **阅读探针注册**：挂载时注册、卸载时注销；探针量的是调用那一刻的 DOM。
 * (f) **拍点后回调**：会话 `afterRender` 之后同一次测量里跑（「定位到正在念的段」这类消费者
 *     要的次序保证：会话的 settleJump 会把视口拉回章块顶，先居中再落位等于白中）。
 *
 * 不在这里的东西：时序语义（落位 → 重测 → 补偿 → 预取）归 `client/reader-session.ts`；几何
 * 语义归 `client/reader-geometry.ts`；标记结构与纯 UI 策略仍归 `ReaderView`。
 */

/** 元素来源：视图只交 ref 读数，取的时刻由绑定定。
 *  真实滚动容器**不在这里**——它是绑定自己刷新出来的（测量前/视口帧前），几何口吃的是同一份。 */
export interface ReaderElementSource {
  /** 正文层容器：向上找真实滚动容器的起点，也是 ResizeObserver 的观察点 */
  body(): HTMLElement | null
  /** 未载边界哨兵（不在 DOM → null，不预取） */
  sentinel(): HTMLElement | null
  /** 已渲染章块（按章号；缺席 = 该章还没渲染） */
  chapters(): ReadonlyArray<HTMLElement | null>
}

/** 帧调度缝：生产 = rAF，测试 = 手动泵 */
export interface ReaderFrameScheduler {
  schedule(cb: () => void): number
  cancel(handle: number): void
}

/** 绑定要驱动的那一半会话（`ReaderSession` 结构上满足它）：DOM 侧只认识这两枚命令 */
export interface ReaderDomTarget {
  /** 渲染后拍点：落位 → 重测锚点 → 结算滚动补偿 → 预取/回溯补载（次序归会话） */
  afterRender(): void
  /** 视口喂入：scroll / resize / 内容尺寸变化都并进会话的同一条合帧 */
  feedViewport(layoutChanged?: boolean): void
}

/** 视口事件的两类来源：纯滚动与「布局变了」（resize / 内容尺寸变化） */
export interface ReaderViewportHandlers {
  scroll(): void
  layout(): void
}

/** DOM 侧平台缝（注入垫片）：测试给记录型实现，因此绑定的判据与次序不必起 jsdom */
export interface ReaderBindingHost {
  /** 找真实滚动容器（缺省 `findScrollport`） */
  findPort(body: HTMLElement | null): HTMLElement | null
  /** 装视口事件监听，返回摘除函数；正文元素一并给（ResizeObserver 的观察点） */
  listenViewport(handlers: ReaderViewportHandlers, body: HTMLElement | null): () => void
  /** 注册/注销阅读探针（缺省 `setReadingProbe`） */
  setProbe(probe: (() => ReadingPosition | null) | null): void
}

const RAF_FRAMES: ReaderFrameScheduler = {
  schedule: (cb) => requestAnimationFrame(cb),
  cancel: (handle) => cancelAnimationFrame(handle),
}

/** 生产 DOM 平台缝：真 document / window / ResizeObserver。导出只为让 jsdom 用例对读装摘的接线
 *  （判据本身用注入的假 host 测，不必起 DOM）。 */
export const PROD_HOST: ReaderBindingHost = {
  findPort: (body) => findScrollport(body),
  listenViewport: (handlers, body) => {
    // capture 阶段收「任意容器」的 scroll（scroll 不冒泡，但捕获阶段会经过 document）——
    // 滚动容器（.novel-main 或更外层）的滚动因此都收得到。
    const onScroll = (): void => { handlers.scroll() }
    const onLayout = (): void => { handlers.layout() }
    document.addEventListener('scroll', onScroll, { capture: true, passive: true })
    window.addEventListener('resize', onLayout)
    // 内容高度变化不经过 window resize（插图到货 / 章块增删都改它）：观察到就按「布局变了」并入
    let ro: ResizeObserver | null = null
    if (body !== null && typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(onLayout)
      ro.observe(body)
    }
    return () => {
      document.removeEventListener('scroll', onScroll, { capture: true })
      window.removeEventListener('resize', onLayout)
      ro?.disconnect()
    }
  },
  setProbe: (probe) => { setReadingProbe(probe) },
}

export interface ReaderBindingOptions {
  source: ReaderElementSource
  /** 帧调度（缺省 rAF） */
  frames?: ReaderFrameScheduler
  /** DOM 平台缝（缺省真 document/window/ResizeObserver） */
  host?: ReaderBindingHost
  /** 视口顶的固定遮挡高度（阅读器顶条，px）：阅读探针按**看得见的顶**取段——
   *  探针与阅读会话的位置口径必须是同一个（`ReaderSessionDeps.topInset`）。缺省 0。 */
  topInset?(): number
}

export class ReaderBinding {
  /** 几何口：会话只读不碰 DOM（测量实现归 `reader-geometry`，本绑定只负责刷新它的元素源） */
  readonly port: ReaderPort
  /** 给会话注入的帧调度缝（`feedViewport` 的合帧状态机住会话，帧调度实现住这里） */
  readonly viewport: ReaderViewportFeed
  private readonly source: ReaderElementSource
  private readonly frames: ReaderFrameScheduler
  private readonly host: ReaderBindingHost
  private readonly topInset: () => number
  private portEl: HTMLElement | null = null
  private target: ReaderDomTarget | null = null
  private mounted = false
  private unlisten: (() => void) | null = null
  /** 上次量过的 DOM 版本；`-1` = 还没量过（挂载时复位，让首帧必拍一次） */
  private measuredRevision = -1
  /** 挂起中的测量帧句柄 */
  private measureFrame: number | null = null
  /** 最近一次渲染给的门数据里那枚「拍点后回调」（同版多帧渲染取最新闭包） */
  private afterMeasure: (() => void) | null = null

  constructor(opts: ReaderBindingOptions) {
    this.source = opts.source
    this.frames = opts.frames ?? RAF_FRAMES
    this.host = opts.host ?? PROD_HOST
    this.topInset = () => opts.topInset?.() ?? 0
    this.port = createReaderGeometry({
      port: () => this.portEl,
      sentinel: () => this.source.sentinel(),
      chapters: () => this.source.chapters(),
      topInset: () => this.topInset(),
    })
    this.viewport = {
      scheduleFrame: (cb) => this.frames.schedule(cb),
      cancelFrame: (handle) => { this.frames.cancel(handle) },
      refreshPort: () => { this.refreshPort() },
    }
  }

  /** 当前真实滚动容器（null = 文档自身在滚）——视图的显式居中动作（定位到正在念的段）要用它 */
  scrollport(): HTMLElement | null {
    return this.portEl
  }

  /** 每次渲染后调用的**唯一一道门**：这一帧要不要测量由这里按 DOM 版本裁。
   *  `after` 是拍点后回调（同一版的多帧渲染只留最新那次给的闭包）。
   *  未挂载时只记版本、不排帧——挂载那一步自己会拍第一帧，视图不必关心两个 effect 谁先跑。 */
  rendered(revision: number, after?: (() => void) | null): void {
    if (!this.mounted) { this.measuredRevision = revision; return }
    if (revision === this.measuredRevision) {
      // 版本没变：这一帧不需要测量。但若已有一帧挂起，仍更新回调闭包——同版可能又渲染了几次，
      // 拍点后回调要跑最新那次给的（否则用的是旧渲染捕获的 ref/状态）
      if (this.measureFrame !== null) this.afterMeasure = after ?? null
      return
    }
    this.measuredRevision = revision
    this.afterMeasure = after ?? null
    this.scheduleMeasure()
  }

  /** 装监听、注册探针、首帧喂视口，并排下挂载后的第一拍（DOM 已提交，端口可能刚出现） */
  mount(target: ReaderDomTarget): void {
    this.target = target
    this.mounted = true
    this.measuredRevision = -1
    this.refreshPort()
    this.unlisten = this.host.listenViewport({
      scroll: () => { this.target?.feedViewport(false) },
      layout: () => { this.target?.feedViewport(true) },
    }, this.source.body())
    // 探针量的是**调用那一刻**的 DOM：不缓存读数（缓存会让「从阅读位置起播」用上一次打开书时的位置）
    this.host.setProbe(() => readingPositionAt(
      this.source.chapters(), portViewTop(this.portEl) + clampTopInset(this.topInset()),
    ))
    target.feedViewport()                       // 首帧视口读数（与旧视图的初始喂入同一条）。
                                                // 换源不重喂：监听常驻不过期，落位/锚点/预取/补载走 domRevision
                                                // 拍点的 afterRender；只有同高换源且无滚动事件的窄边角要等下一次
                                                // 视口事件才补上 handleViewportChange 的采点（有界、可接受）。
    this.scheduleMeasure()
  }

  /** 摘监听、注销探针、取消挂起帧；挂载作用域到此为止 */
  unmount(): void {
    this.mounted = false
    this.target = null
    this.afterMeasure = null
    if (this.measureFrame !== null) {
      this.frames.cancel(this.measureFrame)
      this.measureFrame = null
    }
    this.unlisten?.()
    this.unlisten = null
    this.host.setProbe(null)
    this.portEl = null
  }

  /** 排一帧测量：已有挂起帧就不再排（同版多帧渲染合并成一次拍点） */
  private scheduleMeasure(): void {
    if (this.measureFrame !== null) return
    this.measureFrame = this.frames.schedule(() => {
      this.measureFrame = null
      this.measure()
    })
  }

  /** 帧体：先刷新端口再测量，最后跑拍点后回调（次序即契约） */
  private measure(): void {
    const target = this.target
    if (!this.mounted || target === null) return
    this.refreshPort()
    target.afterRender()
    const after = this.afterMeasure
    this.afterMeasure = null
    after?.()
  }

  private refreshPort(): void {
    this.portEl = this.host.findPort(this.source.body())
  }
}

export function createReaderBinding(opts: ReaderBindingOptions): ReaderBinding {
  return new ReaderBinding(opts)
}
