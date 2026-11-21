import { createReaderGeometry } from './reader-geometry.js'
import type { ReaderPort } from './reader-session.js'
import type { ReaderViewportFeed } from './reader-session.js'
import { findScrollport, portViewTop } from './scrollport.js'
import { clampTopInset } from './viewport-top.js'
import type { ReadingPosition } from './tts/reading-position.js'
import { readingPositionAt, setReadingProbe } from './tts/reading-position.js'

/**
 * 阅读器的 DOM 侧绑定：「渲染后拍点」从视图搬出来后的唯一主人。它拥有六件事：
 * (a) **这一帧要不要测量**——视图每次渲染只调 `rendered`，拿会话的 DOM 版本与上次量过的比；
 * (b) **帧泵**（生产 rAF、测试手动泵，同版多帧合并一次拍点）；(c) **测量前刷新 ReaderPort**；
 * (d) **装摘视口事件**（scroll 捕获 / resize / ResizeObserver 并进 `feedViewport`）；
 * (e) **阅读探针注册**；(f) **拍点后回调**（会话 afterRender 之后同一次测量里跑）。
 *
 * 不在这里：时序语义归 `client/reader-session.ts`，几何语义归 `client/reader-geometry.ts`。
 */

/** 元素来源：视图只交 ref 读数，取的时刻由绑定定；真实滚动容器是绑定自己刷新出来的。 */
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
  /** 用户主动滚动意图（滚轮 / 触摸 / 滚动键 / 滚动条拖动）。程序写入 scrollTop 不经过这里——
   *  跟读自动跟随靠它区分「播放把视口带走」与「读者自己把视口带走」。 */
  intent?(): void
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

/** 生产 DOM 平台缝：真 document / window / ResizeObserver（导出只为让 jsdom 用例对读装摘接线）。 */
export const PROD_HOST: ReaderBindingHost = {
  findPort: (body) => findScrollport(body),
  listenViewport: (handlers, body) => {
    // capture 阶段收「任意容器」的 scroll（scroll 不冒泡，但捕获阶段会经过 document）。
    const onScroll = (): void => { handlers.scroll() }
    const onLayout = (): void => { handlers.layout() }
    // 用户意图与 scroll 分开收（程序写入 scrollTop 也会发 scroll）。wheel / touch 只在正文层里算；
    // 滚动键排除控件自己消费的 Space / Enter；滚动条拖动按事件时刻现找的容器判。
    const intent = (): void => { handlers.intent?.() }
    const insideBody = (target: EventTarget | null): boolean =>
      body === null ? true : target instanceof Node && body.contains(target)
    const onWheel = (event: WheelEvent): void => { if (insideBody(event.target)) intent() }
    const onTouch = (event: TouchEvent): void => { if (insideBody(event.target)) intent() }
    const SCROLL_KEYS = new Set(['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', ' ', 'Spacebar'])
    /** 目标在一只**自己的滚动容器**里（设置卡 / 抽屉 / 正文代码块）：按键滚的是它，不算读者接管；
     *  正文层自己的与包住正文层的外层滚动容器都算阅读。 */
    const insideNestedScroller = (target: HTMLElement | null): boolean => {
      if (target === null) return false
      const inner = findScrollport(target)
      if (inner === null) return false
      if (inner === findScrollport(body)) return false
      return body === null || !inner.contains(body)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.ctrlKey || event.metaKey || event.altKey) return
      if (!SCROLL_KEYS.has(event.key)) return
      const target = event.target instanceof HTMLElement ? event.target : null
      if (target !== null && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA'
        || target.tagName === 'SELECT' || target.isContentEditable)) return
      // 按钮 / 链接只消费 Space 与 Enter；PageUp / PageDown 等仍会滚正文，不能因焦点停在钮上就吞掉接管。
      if (target !== null && (event.key === ' ' || event.key === 'Spacebar' || event.key === 'Enter')
        && target.closest('button, a[href], [role="button"], [role="link"]') !== null) return
      if (insideNestedScroller(target)) return
      intent()
    }
    const onPointer = (event: PointerEvent): void => {
      const port = findScrollport(body)
      if (port === null || event.target !== port) return
      if (typeof event.offsetX !== 'number' || event.offsetX < port.clientWidth) return
      intent()
    }
    document.addEventListener('scroll', onScroll, { capture: true, passive: true })
    document.addEventListener('wheel', onWheel, { capture: true, passive: true })
    document.addEventListener('touchstart', onTouch, { capture: true, passive: true })
    document.addEventListener('touchmove', onTouch, { capture: true, passive: true })
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPointer, { capture: true })
    window.addEventListener('resize', onLayout)
    // 内容高度变化不经过 window resize（插图到货 / 章块增删都改它）：观察到就按「布局变了」并入
    let ro: ResizeObserver | null = null
    if (body !== null && typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(onLayout)
      ro.observe(body)
    }
    return () => {
      document.removeEventListener('scroll', onScroll, { capture: true })
      document.removeEventListener('wheel', onWheel, { capture: true })
      document.removeEventListener('touchstart', onTouch, { capture: true })
      document.removeEventListener('touchmove', onTouch, { capture: true })
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPointer, { capture: true })
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
  /** 视口顶的固定遮挡高度（阅读器顶条，px）：阅读探针按**看得见的顶**取段，与
   *  `ReaderSessionDeps.topInset` 同一口径。缺省 0。 */
  topInset?(): number
  /** 用户主动滚动 / 导航意图：跟读自动跟随据此让位；程序写入 scrollTop 与听书条控件不触发。 */
  onUserIntent?(): void
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
  private readonly onUserIntent: () => void
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
    this.onUserIntent = () => { opts.onUserIntent?.() }
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

  /** 每次渲染后调用的**唯一一道门**：这一帧要不要测量由这里按 DOM 版本裁。`after` 是拍点后回调
   *  （同版多帧只留最新闭包）。未挂载时只记版本、不排帧——挂载那一步自己会拍第一帧。 */
  rendered(revision: number, after?: (() => void) | null): void {
    if (!this.mounted) { this.measuredRevision = revision; return }
    if (revision === this.measuredRevision) {
      // 版本没变：这一帧不需要测量，但挂起的帧要更新回调闭包（跑最新渲染捕获的 ref/状态）。
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
      intent: () => { this.onUserIntent() },
    }, this.source.body())
    // 探针量的是**调用那一刻**的 DOM：不缓存读数（缓存会让「从阅读位置起播」用上一次打开书时的位置）
    this.host.setProbe(() => readingPositionAt(
      this.source.chapters(), portViewTop(this.portEl) + clampTopInset(this.topInset()),
    ))
    target.feedViewport()                       // 首帧视口读数（与旧视图的初始喂入同一条）。
                                                // 换源不重喂：监听常驻，落位/锚点/预取/补载走 domRevision 拍点；只有同高换源
                                                // 且无滚动事件的窄边角要等下一次视口事件补采点（有界、可接受）。
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
