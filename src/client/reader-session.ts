import { hasProgress } from '../shared/reading-position.js'
import { describeError } from './api.js'
import { zhTranslate } from './copy/index.js'
import type { Translate } from './copy/index.js'
import { anchorTop, locateChapter, ratioWithin } from './progress.js'
import type { ChapterAnchor } from './progress.js'
import { debounce } from './util.js'
import { clampTopInset } from './viewport-top.js'
import { nextLoadTarget } from './reader-load.js'
import { createStore, prefsStore } from './store.js'
import type { BookNavigation, ChapterContent, ChapterEntry, LinkRole, NavigationItem, ReadingTarget, ShelfBook } from './views/types.js'

/**
 * 阅读会话：「目录 → 存档恢复 → 逐章加载 → 预取 → 进度落盘」的**时序唯一持有者**，经 interface 可测。
 * DOM 测量经 ReaderPort 注入（视图实现，测试给假 port）；锚点数学复用已测的 progress。
 * 图文（EPUB）不新增加载循环：载荷换成 `ChapterContent`、目标换成「章号 + 锚点 + 节点内偏移」，
 * 仍走同一在途槽与 settleJump 落位次序。
 */

/** 依赖束：网络面（测试注入假实现）+ 帧调度（视图 = rAF 双帧，测试 = 同步执行） */
export interface ReaderSessionDeps {
  /** 目录读面：线性 chapters（进度/导出口径）+ 展示树 items（EPUB 原生 nav/NCX，其他书为平面派生） */
  fetchNavigation(sourceId: string, bookKey: string): Promise<BookNavigation>
  fetchChapter(sourceId: string, bookKey: string, index: number): Promise<ChapterContent>
  fetchShelf(): Promise<ShelfBook[]>
  /** 进度落盘（会话负责防抖/强制策略；此处只管真发一次） */
  saveProgress(chapterIndex: number, offsetRatio: number): void
  /** 总章数回写（幂等补数据）；仅书在架且缺 totalChapters 时会话才调 */
  saveTotalChapters(total: number): void
  /** 布局落定后的回调调度 */
  afterFrames(cb: () => void): void
  /** 滚动视口顶被**固定遮挡**的高度（阅读器顶条，px）：「阅读位置」按视口顶下方第一行算。
   *  存与取必须用同一值：只给恢复加偏移、不给读数加，每进一次阅读器就多漂一条顶条的高度。 */
  topInset?(): number
  /** 视口喂入的帧调度（缺省 = 立即执行，既有内联 deps 一字不用改）；视图注入 rAF，测试注入手动泵 */
  viewport?: ReaderViewportFeed
}

/** 视口喂入的帧调度缝：绑定 = rAF + 重取滚动容器（`findScrollport`）；测试 = 手动泵；缺省 = 同步执行。 */
export interface ReaderViewportFeed {
  scheduleFrame(cb: () => void): number
  cancelFrame(handle: number): void
  /** 帧首重取滚动容器（绑定 = findScrollport；测试 = 计数/空实现） */
  refreshPort(): void
}

const IMMEDIATE_VIEWPORT_FEED: ReaderViewportFeed = {
  scheduleFrame: (cb) => { cb(); return 0 },
  cancelFrame: () => {},
  refreshPort: () => {},
}

/** 当前位置锚：视口顶所在的正文节点（章 + 节点 + 节点内偏移）。正文链接返回采点与排版复位
 *  共用它；只活在窗口内，绝不落盘。 */
export interface VisibleNode { index: number; nodeId: string; offsetWithinNode: number }

/** 待定位目标：章号 + 可空章内锚点 + 锚点内像素偏移。章首直达恒 offsetWithinNode: 0，
 *  只有「回到链接来源」带非零偏移（落在同一节点内的同一处，而不是节点顶）。 */
export interface JumpTarget { index: number; anchorId: string | null; offsetWithinNode: number }

/** 开书恢复目标：章号 + 章内比例。存档 progress 与「回阅读器」的章级站定共用形状，
 *  两者都只走恢复（站定不写），不记成一次阅读（`ADR-0094`）。 */
export interface ReaderRestoreTarget { chapterIndex: number; offsetRatio: number }

/** 听书段 → 阅读器的精确落点：章号 + 播放单元号（0 基）。不经过比例——阅读器按 DOM 里的
 *  `[data-pidx]` 找块，不拿段数比例猜像素（`ADR-0094`）。 */
export interface ReaderRevealTarget { index: number; paragraphIndex: number }

/** DOM 测量口（`client/reader-geometry.ts` 实现；会话只读不碰 DOM） */
export interface ReaderPort {
  measureAnchors(): ChapterAnchor[]
  scrollTop(): number
  setScrollTop(px: number): void
  viewHeight(): number
  scrollHeight(): number
  /** 哨兵相对视口顶部的偏移；哨兵不在 DOM → null（不预取） */
  sentinelOffset(): number | null
  /** 目标（章 + 可空锚点）相对视口顶的偏移；`anchorId` 为 null = 该章块顶。
   *  目标节点不在 DOM → null（不落位、不清待定位目标，等下一轮）。 */
  targetOffset(index: number, anchorId: string | null): number | null
  /** 一批目标的偏移：一次建章内节点索引服务全部导航候选（逐个 `targetOffset` 会对同一棵子树
   *  重复扫描）；找不到的一律给 null。 */
  targetOffsets(index: number, anchorIds: ReadonlyArray<string | null>): Array<number | null>
  /** 视口顶所在正文节点；该章没有可定位节点（文字章）或量不到 → null */
  currentNode(): VisibleNode | null
  /** 章内某个播放单元（`[data-pidx]` 块）相对视口顶的偏移与高度；块不在 DOM → null。
   *  可选：纯文本测试端口可以不给（会话退回章首）。 */
  targetOffsetOfParagraph?(index: number, paragraphIndex: number): { top: number; height: number } | null
}

/** 一次精确落位的现场：目标 + 落点策略。`write` 决定这一跳算不算阅读动作（`ADR-0078`）；
 *  `locate` 无条件顶对齐，`follow` 只在目标成为可见最后一段且落在下半部时翻页。 */
export type RevealMode = 'locate' | 'follow'

interface PendingReveal extends ReaderRevealTarget {
  mode: RevealMode
  write: boolean
  bottomInset: number
}

export interface ReaderSessionState {
  toc: ChapterEntry[] | null
  /** 目录展示树（同一份读面里的另一列表；高亮与跳转按它，章数/进度仍按 toc） */
  navigation: NavigationItem[] | null
  /** null/空洞 = 未载（视图不渲染该章） */
  chapters: Array<ChapterContent | null>
  loadingIdx: number | null
  error: { code?: string; message?: string } | null
  /** DOM 同步版本：会改变布局或需要重新落位的事情各 +1。**视图不解释它**，只比较「这一帧的
   *  版本与上次量过的是否同一个」；新加影响布局的来源时改会话这一处，不是视图的依赖数组。 */
  domRevision: number
  /** 当前视口所在章（0 基）。**只在跨章时写**（同章滚动不唤醒渲染）；消费者是章进度细线与目录高亮。 */
  currentChapter: number
  /** 正文链接的返回栈深度（> 0 = 视图给「返回原处」入口）。窗口内状态，不落盘。 */
  returnDepth: number
}

type DebouncedSave = ((chapterIndex: number, offsetRatio: number) => void) & { cancel(): void; flush(): void }

/** 恢复位预约：目录已发布但存档章还没问回来时，预取会先抢走在途槽、整条恢复丢失。
 *  所以目录一发布就占槽到存档章落定（打点见 `load()` 的 early-return）。 */
const RESTORE_SLOT = -1

/** 连续阅读保留在视口之前的已载章数（向前读按这个窗口裁，否则已载集只增不减）；
 *  向上滚到窗口顶时 `checkBackfill` 补回上一章，回溯阅读不失效。 */
const KEEP_BEHIND = 6
/** 视口顶距已载窗口顶不足这么多屏 → 补载上一章（与预取的屏数量级相同）。 */
const BACKFILL_SCREENS = 2
/** 一次「视口 episode」（`open` / 跳章 / 跨章换位）内自动补载的硬上界：距离判据依赖高度测量，
 *  测量失真时不能靠它兜底。 */
const BACKFILL_MAX_CHAPTERS = 16

export class ReaderSession {
  private readonly store = createStore<ReaderSessionState>({
    toc: null, navigation: null, chapters: [], loadingIdx: null, error: null,
    domRevision: 0, currentChapter: 0, returnDepth: 0,
  })
  /** 异步回调读最新目录/已载表/锚点（原视图五个「防陈旧闭包」ref 的职责收拢于此） */
  private tocNow: ChapterEntry[] | null = null
  private navigationNow: NavigationItem[] | null = null
  private chaptersNow: Array<ChapterContent | null> = []
  private readonly mountedSet = new Set<number>()
  private anchorsNow: ChapterAnchor[] = []
  private domRevision = 0
  /** 待定位目标：渲染落地后由 `settleJump` 定位并清零。**不是渲染态**——不进 store、不触发渲染；
   *  视图只看 `domRevision`，诊断与测试经只读 getter 回查。 */
  private pendingJumpNow: JumpTarget | null = null
  /** 按听书段落位的待办：与 `pendingJumpNow`（目录/内链的章 + 节点锚点）分开，落位时先结导航、再结这条。 */
  private pendingReveal: PendingReveal | null = null
  /** 程序化 reveal 写入 scrollTop 的同拍里滚动事件可能同步到达：这一格挡住它，
   *  由 reveal 自己提交位置（异步滚动事件则由幽灵写闸兜住）。 */
  private holdViewport = false
  /** 上次锚点测量所依据的**已载表引用**（`chaptersNow` 是 copy-on-write）。与当前表不同 =
   *  载入或裁剪过、锚点表已过期。不用布尔脏标记：它会被「提交之前来的那一帧滚动」消费掉，
   *  而那一帧读到的是还没提交新章块的 DOM。 */
  private anchorsFrom: Array<ChapterContent | null> | null = null
  private inflight: number | null = null
  /** 阅读位置：**唯一真相**（章 + 章内比例）；落盘时机只由 `commit` 判定——
   *  否则每条时序路径会各自决定何时落盘。 */
  private position = { chapterIndex: 0, offsetRatio: 0 }
  private bookKey = ''
  private sourceId = ''
  private failedIndex: number | null = null
  /** 正文链接的返回栈（窗口内状态；每次导航前采点，返回时弹一条）。**绝不落盘**。 */
  private returnStack: VisibleNode[] = []
  /** 会话代际：`open`（换书/重开）与 `dispose` 各自 +1。异步续作（迟到的正文、双帧回调）
   *  只服务它出发时的那一代——不符即作废，不落位不落盘。 */
  private generation = 0
  /** 这本书此刻**在不在书架上**（`'unknown'` = 书架没拉到）。读数来自 `open` 里那次已有的
   *  书架查询；不在架的书进度 PUT 会被判 `NOT_ON_SHELF`，这一屏读到哪儿就此静默消失。 */
  private onShelfNow: 'unknown' | 'on' | 'off' = 'unknown'
  /** 渲染后要结的滚动补偿：DOM 提交前量不到新布局（前插一章的高度、裁掉一段后的落点），
   *  统一在 `afterRender` 按实测值补 scrollTop；跳章会清空（落位归 settleJump）。
   *  裁章与前插都记**参考章的新旧起点差**（块高不含章间外边距），量不到才退回高度和 / 块高。 */
  private pendingScrollFixes: Array<
    | { kind: 'drop'; px: number; keep: { index: number; start: number } | null }
    | { kind: 'prepend'; index: number; keep: { index: number; start: number } | null }
  > = []
  /** 视口读数至少来过一次（`open` 复位）。回溯补载只认真实视口：存档恢复的双帧落位之前，
   *  scrollTop 还是进入前的旧值。 */
  private viewportSeen = false
  /** 存档恢复的双帧落位尚未完成（`open` 置真、落位帧清）。这期间视口读数是进入前的旧值：
   *  预取、位置提交与回溯补载一律不许据此做决定。 */
  private restoring = false
  /** 翻页阅读模式：没有滚动视口，跳章/恢复/预取不走 pendingJump / settleJump / 回补那条时序。 */
  private paged = false
  /** 视口顶的固定遮挡高度（顶条）：见 `ReaderSessionDeps.topInset`。每次现量（条高随排版变），
   *  非负夹取的判据住 `client/viewport-top.ts` 的 `clampTopInset`（`ADR-0089`）。 */
  private get topInset(): number {
    return clampTopInset(this.deps.topInset?.())
  }
  /** 「读者看见的内容顶」在内容坐标里的位置：滚动位 + 顶条遮挡。阅读位置（存、取、落位）一律按它算。 */
  private contentTop(): number {
    return this.port.scrollTop() + this.topInset
  }
  private backfillBudget = BACKFILL_MAX_CHAPTERS
  /** 挂起中的视口帧：令牌 + 句柄。**令牌**让同步执行的调度器也不出错——帧体在 `scheduleFrame`
   *  返回前就跑完时，事后写回的是令牌的句柄，不会复活已完成的帧位。 */
  private frame: { handle: number } | null = null
  /** 挂起帧是否要按「布局变了」处理：scroll / resize / ResizeObserver 多来源按或合并。 */
  private pendingLayout = false
  /** 排版变化前视口顶所在节点：`setPref` 的同步调用栈里采（此刻 DOM 还是旧排版）；
   *  排版复位用它算落点，复位后重采。换书/退出即清。 */
  private lastVisibleBeforePrefs: VisibleNode | null = null
  private prefsUnsub: (() => void) | null = null
  private readonly save: DebouncedSave
  private readonly deps: ReaderSessionDeps
  private readonly port: ReaderPort
  /** 错误快照的语言：生成时定（与 job store 同一条已知限制）。视图传当前 t，测试缺省 zh。 */
  private readonly t: Translate

  constructor(deps: ReaderSessionDeps, port: ReaderPort, saveDebounceMs = 2000, t: Translate = zhTranslate) {
    this.deps = deps
    this.port = port
    this.t = t
    const d = debounce((chapterIndex: number, offsetRatio: number): void => {
      deps.saveProgress(chapterIndex, offsetRatio)
    }, saveDebounceMs)
    this.save = Object.assign((i: number, r: number): void => d(i, r), { cancel: () => d.cancel(), flush: () => d.flush() })
  }

  get state(): ReaderSessionState { return this.store.get() }
  /** 待定位目标（**不是渲染态**：只给诊断与测试回查落位时序）；视图不读它，看 `state.domRevision`。 */
  get pendingJump(): JumpTarget | null { return this.pendingJumpNow }
  get onShelf(): 'unknown' | 'on' | 'off' { return this.onShelfNow }
  /** 当前阅读位置快照（翻页模式切入 / 同步进度用；只读副本，不暴露内部可变对象）。 */
  get currentPosition(): { chapterIndex: number; offsetRatio: number } {
    return { chapterIndex: this.position.chapterIndex, offsetRatio: this.position.offsetRatio }
  }
  subscribe = (cb: () => void): (() => void) => this.store.subscribe(cb)

  /** 翻页模式显式上报页内进度：走同一条 commit / 防抖落盘管道，不造第二套存档通道。 */
  reportPosition(chapterIndex: number, offsetRatio: number): void {
    if (!this.inRange(chapterIndex)) return
    const ratio = Number.isFinite(offsetRatio) ? Math.max(0, Math.min(0.999999, offsetRatio)) : 0
    this.commit('scroll', chapterIndex, ratio)
  }

  /** 翻页模式静默预取相邻章：复用单在途槽与失败闸，不触发跳章也不改当前位置。 */
  prefetchChapter(index: number): void {
    if (this.restoring) return
    if (this.inflight !== null) return
    if (!this.inRange(index) || this.mounted(index) || index === this.failedIndex) return
    void this.load(index, 0, { prefetch: true })
  }

  /** 视图在模式切换时同步：切入翻页清掉滚动落位现场；切回滚动清掉翻页期可能残留的滚动补偿，由 `scrollToSavedPosition` 接手。 */
  setPaged(paged: boolean): void {
    if (this.paged === paged) return
    this.paged = paged
    this.pendingScrollFixes = []
    if (!paged) return
    this.pendingJumpNow = null
    this.pendingReveal = null
    this.holdViewport = false
    this.restoring = false
  }

  /** 翻页 → 滚动：按会话里的页内比例把滚动容器摆到对应行；只摆视口，不写进度。 */
  scrollToSavedPosition(): void {
    const { chapterIndex, offsetRatio } = this.position
    if (!this.mounted(chapterIndex)) return
    this.recalcAnchors()
    if (this.anchorsNow.length === 0) return
    const at = anchorTop(this.anchorsNow, chapterIndex, offsetRatio,
      this.port.scrollHeight(), this.port.viewHeight())
    this.port.setScrollTop(Math.max(0, at - this.topInset))
    this.viewportSeen = true
  }

  /** 进入一本书：目录 → 存档恢复；无存档/书架拉不到 → 从头。`relocation` = 「回阅读器」的
   *  章级站定（可选）：替代存档 progress 当恢复目标，恢复路径只站定不写，精确段由随后的
   *  `reveal` 落位（`ADR-0094`）。越界章夹回目录范围。 */
  async open(sourceId: string, bookKey: string, relocation: ReaderRestoreTarget | null = null): Promise<void> {
    const gen = ++this.generation                       // 换书/重开：上一代的一切在途续作自此作废
    this.cancelPendingFrame()                           // 上一代的挂起视口帧同样作废
    this.lastVisibleBeforePrefs = null                  // 上一本的采点不带到这一本（旧快照只会量成 null 或误跳）
    // 采点订阅挂在同步头部：它只对 `setPref` 的同步栈负责，与目录是否到货无关；重开幂等（守卫只订一次）。
    this.subscribePrefs()
    this.sourceId = sourceId
    this.bookKey = bookKey
    this.tocNow = null
    this.navigationNow = null
    this.chaptersNow = []
    this.mountedSet.clear()
    this.anchorsNow = []
    this.position = { chapterIndex: 0, offsetRatio: 0 }
    this.inflight = null
    this.failedIndex = null
    this.returnStack = []
    this.pendingScrollFixes = []
    // 待跳目标是上一本的现场：重开复用同一实例时留着它，会早退视口读数或真跳到旧目标章
    this.pendingJumpNow = null
    this.pendingReveal = null
    this.holdViewport = false
    this.viewportSeen = false
    this.restoring = false
    this.backfillBudget = BACKFILL_MAX_CHAPTERS
    this.onShelfNow = 'unknown'                           // 换书即重问：上一本的在架状态不带到这一本
    this.save.cancel()
    this.domRevision += 1
    this.store.set({
      toc: null, navigation: null, chapters: [], loadingIdx: null, error: null,
      domRevision: this.domRevision, currentChapter: 0, returnDepth: 0,
    })
    try {
      const nav = await this.deps.fetchNavigation(sourceId, bookKey)
      if (gen !== this.generation) return
      // 线性序列与展示树是同一份读面的两列表：章数/进度/导出按 chapters，抽屉与高亮按 items
      const toc = nav.chapters
      this.tocNow = toc
      this.navigationNow = nav.items
      const blank = new Array<ChapterContent | null>(toc.length).fill(null)
      // 先预约槽再发布目录：从这一刻到存档章落定之间没有别的 await，预取插不进来
      this.inflight = RESTORE_SLOT
      this.publishChapters(blank, { toc, navigation: nav.items })
      let restoreIndex = 0
      let restoreRatio = 0
      let restore = false
      // 「回阅读器」的听书重定位**优先于**存档 progress，同一个出口（commit('restore') 站定不写），
      // 不另开跳章路径；章号夹回目录范围。
      if (relocation !== null && toc.length > 0) {
        const at = Number.isFinite(relocation.chapterIndex) ? Math.trunc(relocation.chapterIndex) : 0
        restoreIndex = Math.min(Math.max(0, at), toc.length - 1)
        restoreRatio = Number.isFinite(relocation.offsetRatio)
          ? Math.min(1, Math.max(0, relocation.offsetRatio))
          : 0
        restore = true
      }
      try {
        const shelf = await this.deps.fetchShelf()
        if (gen !== this.generation) return
        const mine = shelf.find((b) => b.bookKey === bookKey)
        // 同一次查询顺手记下在架读数：它是这条链上唯一问得到「这本书在不在架上」的时刻
        this.onShelfNow = mine === undefined ? 'off' : 'on'
        if (mine !== undefined) {
          if (typeof mine.totalChapters !== 'number') this.deps.saveTotalChapters(toc.length)
          // 存档判据单点归 `shared/reading-position.ts` 的 `hasProgress`；越界/负下标夹回目录范围，
          // **空目录没有可恢复目标**——夹不到章时 `load` 直接返回，而那是下面 `restoring` 闸的前提。
          if (!restore && hasProgress(mine.progress) && toc.length > 0) {
            restoreIndex = Math.min(Math.max(0, mine.progress.chapterIndex), toc.length - 1)
            restoreRatio = mine.progress.offsetRatio
            restore = true
          }
        }
      } catch { /* 书架拉不到：从头读，不阻断进入 */ }
      if (gen !== this.generation) return
      this.inflight = null
      this.commit('restore', restoreIndex, restoreRatio)      // 站定：位置 = 存档值，不写回
      // 有存档 → 载入后走双帧落位（含比例 0：不落位的话，回溯补载的前插会让视口落进上一章）；
      // 落位完成前视口读数是进入前的旧值。闸跟着「这一趟真会载入」走：目标载不动时双帧永不发生，
      // 闸要是照落，此后每次视口读数都在 handleViewportChange 顶部被吞。
      this.restoring = restore && !this.paged && this.inRange(restoreIndex)
      await this.load(restoreIndex, restoreRatio, restore ? { restore: true } : undefined)
    } catch (e) {
      if (gen !== this.generation) return
      this.store.set({ error: toErrorInfo(e, this.t) })
    }
  }

  /** 加载某章（单在途槽：同章并发/滚动风暴去重）；`opts.restore` = 双帧后按锚点定位。
   *  `keepViewport` = 前插（回溯补载）：新章加在已载窗口**上方**，渲染后按实测位移下移滚动位。 */
  async load(
    index: number, restoreRatio = 0, opts?: { keepViewport?: boolean; restore?: boolean; prefetch?: boolean },
  ): Promise<void> {
    const toc = this.tocNow
    if (toc === null || index < 0 || index >= toc.length) return
    if (this.inflight !== null) return
    const gen = this.generation
    this.inflight = index
    this.store.set({ loadingIdx: index })
    try {
      const content = await this.deps.fetchChapter(this.sourceId, this.bookKey, index)
      // 迟到（换书/卸载）的正文什么都不做：不落位、不落盘、不碰新会话的在途槽（finally 同一条闸）
      if (gen !== this.generation) return
      // 前插的高度要等 DOM 提交才量得到：先记账，afterRender 里补 scrollTop（长文回溯不跳屏）
      if (opts?.keepViewport === true && this.pendingJumpNow === null) {
        const first = this.anchorsNow[0]
        this.pendingScrollFixes.push({
          kind: 'prepend', index,
          keep: first === undefined ? null : { index: first.index, start: first.start },
        })
      }
      const next = [...this.chaptersNow]
      next[index] = content
      this.mountedSet.add(index)
      // 成功即清错：成功 load 必须同时清 error，否则错误条粘屏、重试看似无效
      this.failedIndex = null
      // 预取成功不清错误条：用户没翻到的那章不该改写当前画面的错误现场。
      if (opts?.prefetch === true) this.publishChapters(next)
      else this.publishChapters(next, { error: null })
      this.pruneToViewport()                                  // 跳章目标到货：窗口跟着视口收口（不串章）
      if (opts?.restore === true && this.paged) {
        this.restoring = false                                // 翻页模式没有滚动落位，首屏归 BookStage 摆
      } else if (opts?.restore === true) {
        this.deps.afterFrames(() => {
          if (gen !== this.generation) return
          this.recalcAnchors()
          this.deps.afterFrames(() => {
            if (gen !== this.generation) return
            const at = anchorTop(this.anchorsNow, index, restoreRatio,
              this.port.scrollHeight(), this.port.viewHeight())
            // 让出顶条：恢复点落在**看得见**的顶，而不是被顶条盖住的那一行（听书写的 progress 是段首）。
            this.port.setScrollTop(Math.max(0, at - this.topInset))
            // 落位帧之后 scrollTop 才是真实视口：从这里开始才允许预取/位置/补载读它
            this.restoring = false
            this.viewportSeen = true
            // 恢复落位是异步双帧：挂起的精确段落位要等这一帧之后才敢量，补一拍让绑定重测。
            if (this.pendingReveal !== null) {
              this.domRevision += 1
              this.store.set({ domRevision: this.domRevision })
            }
          })
        })
      }
    } catch (e) {
      if (gen !== this.generation) return
      // 恢复章拉取失败：落位不会发生，别把会话钉在「等待落位」里
      if (opts?.restore === true) this.restoring = false
      this.failedIndex = index
      // 跳章失败 → 撤销意图：commit('jump') 已把「读到第 N 章」写进存档，而第 N 章从未渲染——不回退就是拿没见过的章当位置。
      const jump = this.pendingJumpNow
      if (jump !== null && jump.index === index) this.pendingJumpNow = null
      // 段号落位与跳章同一失败半径：目标章没载进来，这一发就不再等（别留成挡住视口读数的死目标）。
      if (this.pendingReveal?.index === index) this.pendingReveal = null
      // 翻页模式没有滚动视口，载章失败只清在途槽，不拿旧锚点重记位置（ADR-0101）
      if (!this.paged && this.position.chapterIndex === index) {
        // 视口 = 「读者实际在哪儿」的证据（与 handleViewportChange 同一读取口径）
        this.recalcAnchors()
        if (this.anchorsNow.length > 0) {
          const at = locateChapter(this.anchorsNow, this.contentTop())
          this.commit('cross', at.chapterIndex, at.offsetRatio)
        }
      }
      if (opts?.prefetch !== true) this.store.set({ error: toErrorInfo(e, this.t) })
    } finally {
      if (gen === this.generation) {                          // 作废的续作不许碰在途槽（那已是新会话的）
        this.inflight = null
        this.store.set({ loadingIdx: null })
        this.settlePendingLoad()
        // 恢复那一趟的 finally 不补载：落位由双帧负责（测试里 afterFrames 可能同步落定）。
        // 成功那趟换了已载表、DOM 还没提交，补载交给 afterRender；这里只兜表没变的失败那趟。
        // 翻页模式没有视口读数，不做滚动回补；预取也不生产回补（否则可能顺带拉上一章）。
        if (opts?.restore !== true && opts?.prefetch !== true && !this.paged) this.checkBackfill()
      }
    }
  }

  /** 在途槽释放后补拉「请求跳转时被在途挡下」的章：requestJump 置 pendingJump 再试 load 时被挡，
   *  正向流水到尾部后 settleJump 永不满足 → 该次点击无声消失。此处补一次。 */
  private settlePendingLoad(): void {
    const jump = this.pendingJumpNow
    if (jump === null) return
    if (jump.index === this.failedIndex) return            // 刚失败过：不自动重试，等用户「重试」
    if (!this.mounted(jump.index)) {
      void this.load(jump.index)
    }
  }

  /** 重试最近一次失败：章加载失败 → 重拉该章；进入/目录失败 → 重开。成功路径会清 error。 */
  retry(): void {
    if (this.failedIndex !== null) { void this.load(this.failedIndex); return }
    void this.open(this.sourceId, this.bookKey)
  }

  /** 未载边界哨兵进预取区 → 加载下一章（单一在途；目标 = **视口所在章之后**第一个未载章，见 reader-load 头注）。 */
  private checkPreload(): void {
    const sentinel = this.port.sentinelOffset()
    if (sentinel === null) return
    const target = nextLoadTarget(sentinel, this.port.viewHeight(), {
      chapters: this.chaptersNow, loading: this.inflight, from: this.position.chapterIndex,
    })
    // 刚失败的同一章不自动重试（与 settlePendingLoad 同一条纪律）：否则失败章会随每次视口变化被静默重试
    if (target !== null && target !== this.failedIndex) void this.load(target)
  }

  /** 视口接近已载窗口**顶** → 补载上一章（裁章后的回溯路径）；单在途，正文已在载或刚失败过则不动。 */
  private checkBackfill(): void {
    if (this.restoring) return                                  // 恢复落位前的旧视口：不是证据
    if (!this.viewportSeen) return                              // 视口还没读过：不做回溯判断
    if (this.inflight !== null) return
    if (this.pendingJumpNow !== null) return                     // 在途导航优先，不给视口补章
    if (this.backfillBudget <= 0) return                         // 本 episode 额度用尽
    // 锚点表只认「量它的那一版已载表」。表已换 = 新章块还没进 DOM：此刻重测会把旧布局记成新表的
    // 锚点，下一帧滚动就会跳过重测。等 afterRender 量过 DOM 再判断。
    if (this.anchorsFrom !== this.chaptersNow) return
    const first = this.anchorsNow[0]
    if (first === undefined || first.index === 0) return
    // 量不到高度时「距窗口顶多少」是拿 0 当实测：据此补章会一路触发，直到撞上裁章下界
    if (first.height <= 0) return
    const prev = first.index - 1
    if (this.mounted(prev) || prev === this.failedIndex) return
    // 不越过裁章下界：更早的章加载后会被 `pruneToViewport` 当场裁掉，要再往前读得由用户滚到窗口顶章。
    if (prev < this.position.chapterIndex - KEEP_BEHIND) return
    if (this.port.scrollTop() - first.start > this.port.viewHeight() * BACKFILL_SCREENS) return
    this.backfillBudget -= 1
    void this.load(prev, 0, { keepViewport: true })
  }

  /** 已载集裁到「视口章所属的连续区间」，并在区间内按 `KEEP_BEHIND` 裁掉远章：前者防跳远端
   *  再回来时缺章串读，后者防连续阅读时 DOM 只增不减；只在视口章已载时裁。
   *  裁掉视口**上方**的章 → 内容整体上移，afterRender 按参考章的新旧起点差回补滚动位；
   *  跳章（pendingJump 在场）不补——落位由 settleJump 重测目标，补了会叠加。 */
  private pruneToViewport(): void {
    const at = this.position.chapterIndex
    if (!this.mounted(at)) return
    let lo = at
    while (lo > 0 && this.mounted(lo - 1)) lo--
    let hi = at
    while (hi + 1 < this.chaptersNow.length && this.mounted(hi + 1)) hi++
    const keepLo = Math.max(lo, at - KEEP_BEHIND)
    const dropped: number[] = []
    for (const i of this.mountedSet) if (i < keepLo || i > hi) dropped.push(i)
    if (dropped.length === 0) return
    const behind = dropped.filter((i) => i < at)
    if (!this.paged && behind.length > 0 && this.pendingJumpNow === null) {
      const anchors = this.port.measureAnchors()
      const heights = new Map(anchors.map((a) => [a.index, a.height]))
      const px = behind.reduce((sum, i) => sum + (heights.get(i) ?? 0), 0)
      const ref = anchors.find((a) => a.index === at) ?? null
      if (px > 0 || ref !== null) {
        this.pendingScrollFixes.push({
          kind: 'drop', px, keep: ref === null ? null : { index: ref.index, start: ref.start },
        })
      }
    }
    const next = [...this.chaptersNow]
    for (const i of dropped) {
      next[i] = null
      this.mountedSet.delete(i)
    }
    this.publishChapters(next)
  }

  /** 位置修正的**唯一入口**：cause 决定落盘时机——`restore` 站定不写；`jump` / `cross` 是导航
   *  事件，立即落；`scroll` 是同章连续量，防抖落。两个分支同走一条防抖队列：
   *  挂起位里永远只剩最新一次读数，迟到的旧值无处可存。 */
  private commit(cause: 'restore' | 'jump' | 'cross' | 'scroll', chapterIndex: number, offsetRatio: number): void {
    // 幽灵写闸（与 `restore` 的「站定不写」同一条口径）：读数与当前位置完全相同时这一笔没有新信息，
    // 挂载期的第一次视口读数正是这一形态。只闸 `scroll`：`jump`/`cross` 是导航事件，
    // 「选中即落盘」不因值恰好相同而放弃。
    if (cause === 'scroll' && chapterIndex === this.position.chapterIndex && offsetRatio === this.position.offsetRatio) {
      return
    }
    this.position = { chapterIndex, offsetRatio }
    if (this.store.get().currentChapter !== chapterIndex) {
      this.store.set({ currentChapter: chapterIndex })    // 进度细线 + 目录高亮（低频呈现）
    }
    this.pruneToViewport()
    if (cause === 'restore') return
    this.save(chapterIndex, offsetRatio)
    if (cause !== 'scroll') this.save.flush()
  }
  /** 视口喂入的唯一入口：同一静默期的事件合成一帧，`layoutChanged` 按**或**合并；
   *  帧体先重取滚动容器再让会话读视口：内容变化后旧缓存量到的是上一版布局。 */
  feedViewport(layoutChanged = false): void {
    this.pendingLayout = this.pendingLayout || layoutChanged
    if (this.frame !== null) return
    const token = { handle: 0 }
    this.frame = token
    token.handle = this.viewportFeed.scheduleFrame(() => {
      if (this.frame !== token) return          // 已被 open/dispose 取消：这一帧不读视口
      this.frame = null
      const changed = this.pendingLayout
      this.pendingLayout = false
      this.viewportFeed.refreshPort()
      this.handleViewportChange({ layoutChanged: changed })
    })
  }

  private get viewportFeed(): ReaderViewportFeed {
    return this.deps.viewport ?? IMMEDIATE_VIEWPORT_FEED
  }

  /** 视口变化：预取 + 位置修正（跨章是导航事件，同章滚动是连续量）。纯滚动只读锚点缓存；
   *  `layoutChanged` 或已载表换了版本才重测。目录跳章在途期间**不采信读数**：视口还是旧位置，
   *  采信等于用旧证据推翻用户刚下的导航命令；落地由 `settleJump` 收口。 */
  private handleViewportChange(opts?: { layoutChanged?: boolean }): void {
    // 存档恢复落位前的读数属于「进入前的旧视口」：预取、位置提交与补载都不许据此做决定
    if (this.restoring) return
    // 程序化 reveal 写入 scrollTop 的同拍里滚动事件可能同步到达：这一格由 reveal 自己收口
    if (this.holdViewport) return
    this.checkPreload()
    if (opts?.layoutChanged === true || this.anchorsFrom !== this.chaptersNow) this.recalcAnchors()
    if (this.anchorsNow.length === 0) return               // 还没有可读的视口证据（首帧/正文未到）
    this.viewportSeen = true
    if (this.pendingJumpNow !== null || this.pendingReveal !== null) return
    const { chapterIndex, offsetRatio } = locateChapter(this.anchorsNow, this.contentTop())
    const crossing = chapterIndex !== this.position.chapterIndex
    this.commit(crossing ? 'cross' : 'scroll', chapterIndex, offsetRatio)
    if (crossing) this.backfillBudget = BACKFILL_MAX_CHAPTERS   // 用户跨章 = 新 episode
    this.checkBackfill()                            // 滚到窗口顶 → 补回上一章（裁章后的回溯路径）
  }

  /** 导航直达（目录点击 / 注释面板转交的主序列目标）：目标章未载则加载（落地后由 settleJump 定位）。
   *  **选中即落盘**：章在途时用户切走、视口没动，只靠 handleViewportChange 意图就会静默丢失。
   *  `anchorId` 非空 = 跳到该章文档内的那个锚点（EPUB 目录：同一 XHTML 的多个条目跳不同锚点）。 */
  requestJump(index: number, anchorId: string | null = null): void {
    this.jumpTo({ index, anchorId, offsetWithinNode: 0 })
  }

  /** 按听书段精确落位：目标章可未载，落位等 DOM 提交后由 `settleReveal` 收口（`ADR-0094`）。
   *  `locate` 无条件顶对齐；`follow` 只在翻页时顶对齐。`write` = 这一跳算不算一次阅读动作。
   *  **不经过段数比例**：段号直接映射到 `[data-pidx]` 块；找不到段落时退该章章首，
   *  不让一次落位把 `pendingReveal` 永久挂住（那会挡住后续所有视口读数）。 */
  reveal(target: ReaderRevealTarget, opts: { mode: RevealMode; write: boolean; bottomInset?: number }): void {
    if (this.tocNow !== null && !this.inRange(target.index)) return
    if (this.paged) {
      // 翻页模式的段落定位归 BookStage；这里只处理跨章（回到章首）。
      this.pagedJumpTo(target.index, opts.write)
      return
    }
    // 定位/跟随是比目录跳章更晚的显式动作：旧导航目标作废，避免两套落位互相拉扯。
    this.pendingJumpNow = null
    this.pendingReveal = {
      ...target,
      mode: opts.mode,
      write: opts.write,
      bottomInset: Math.max(0, opts.bottomInset ?? 0),
    }
    // 目标章已在 DOM 且无待结补偿：当场量、当场落；有补偿时先等 afterRender，否则补偿会把落位推开。
    if (this.tocNow !== null && this.mounted(target.index) && this.pendingScrollFixes.length === 0) {
      this.settleReveal()
      return
    }
    // 显式定位/跟随先按「读到这一章」落一笔，按了就有可观测反应；精确段位等正文到货后补（write:false 不走）。
    if (opts.write && this.tocNow !== null) this.commit('jump', target.index, 0)
    // 章未载 / 目录未到：推一拍，等 open 或 load 把块提交进 DOM 后由 afterRender 收口。
    this.domRevision += 1
    this.store.set({ domRevision: this.domRevision })
    if (this.tocNow !== null && this.inflight === null) void this.load(target.index)
  }

  /** 撤销在途跳章（读者接管视口）：清 pending，并按当前视口重记消费位置。
   *  `requestJump` 已按目标章写过一笔，不重记会把读者留在一条他没看见的章上。 */
  cancelJump(): void {
    const hadJump = this.pendingJumpNow !== null
    this.pendingJumpNow = null
    this.pendingReveal = null
    if (!hadJump || this.paged) return
    if (this.restoring) return
    this.recalcAnchors()
    if (this.anchorsNow.length === 0) return
    const at = locateChapter(this.anchorsNow, this.contentTop())
    this.commit('cross', at.chapterIndex, at.offsetRatio)
  }

  /** 正文内链跳转：**先采返回位置，再导航**。
   *  - `backlink` 本身就是返回动作，消费栈里那条而不是再压一条；
   *  - 其余角色先采点压栈（脚注也采点：面板里还能再点到主序列）。
   *  返回这条采点当句柄（null = 没采到/backlink/越界），关闭面板只消费打开时压的那条。 */
  followLink(target: ReadingTarget, role: LinkRole): VisibleNode | null {
    if (target.kind === 'chapter' && !this.inRange(target.index)) return null   // 越界目标：不采点、不导航
    let entry: VisibleNode | null = null
    if (role === 'backlink') {
      if (this.returnStack.length > 0) this.returnStack.pop()
    } else {
      const here = this.port.currentNode()
      if (here !== null) entry = this.pushReturn(here)
    }
    this.markReturnDepth()
    if (target.kind === 'chapter') {
      this.jumpTo({ index: target.index, anchorId: target.anchorId, offsetWithinNode: 0 })
    }
    return entry
  }

  /** 返回原处（工具栏「返回」/ 关闭注释面板的兜底入口）：弹一条返回项，经**同一单在途加载路径**
   *  落位；来源章若已被裁掉，与目录跳章同一条补载逻辑重新取回。 */
  goBack(): void {
    const entry = this.returnStack.pop()
    if (entry === undefined) return
    this.markReturnDepth()
    this.jumpTo({ index: entry.index, anchorId: entry.nodeId, offsetWithinNode: entry.offsetWithinNode })
  }

  /** 返回栈顶是否仍是这条：关闭补充文档前判断这次关闭会不会真返回引用处（不会导航的关闭不取消在途跳章）。 */
  returnTopIs(entry: VisibleNode | null): boolean {
    return entry !== null && this.returnStack[this.returnStack.length - 1] === entry
  }

  /** 关闭补充文档面板：**只消费「开面板时压入的那一条」**（`entry` 是 `followLink` 交出的句柄）。
   *  栈顶已不是它，说明期间用户又跟了别的链接：弹栈会把主序列送回用户没点过的地方，还会写进存档。
   *  目录直接打开的补充文档（没有句柄）→ 只关面板。 */
  closeSupplement(entry: VisibleNode | null): void {
    if (!this.returnTopIs(entry)) return
    this.goBack()
  }

  /** 目录抽屉的当前项：**当前章内最近的已登记导航锚点**（视口顶已越过的最靠下者，章首算第一个）；
   *  一个都没越过 → 取文档序最近的下方锚点（取导航列表第一条会在 nav 乱序时打错高亮）。
   *  并列按导航顺序取第一条；量不到任何目标（章在途/文字章无节点）→ null，视图不打标。 */
  activeNavId(): string | null {
    const items = this.navigationNow
    if (items === null) return null
    const chapter = this.position.chapterIndex
    const candidates: Array<{ id: string; anchorId: string | null }> = []
    const walk = (list: NavigationItem[]): void => {
      for (const item of list) {
        const t = item.target
        if (t !== null && t.kind === 'chapter' && t.index === chapter) candidates.push({ id: item.id, anchorId: t.anchorId })
        walk(item.children)
      }
    }
    walk(items)
    if (candidates.length === 0) return null    // 本章没有导航锚点：不建节点索引
    const offsets = this.port.targetOffsets(chapter, candidates.map((c) => c.anchorId))
    let best: { id: string; off: number } | null = null
    let below: { id: string; off: number } | null = null
    // 越过判据吃「看得见的顶」：目标在顶条遮挡带里（0 < off ≤ inset）还不算滚过去
    const inset = this.topInset
    // `targetOffsets` 与 candidates 同批等长：拿不到偏移 (null/缺席) 一律不是候选（目标不在 DOM）。
    for (const [i, candidate] of candidates.entries()) {
      const off = offsets[i]
      if (off === null || off === undefined) continue
      const id = candidate.id
      if (off <= inset) {
        if (best === null || off > best.off) best = { id, off }
      } else if (below === null || off < below.off) {
        below = { id, off }                                // 并列者同样留在先到者手里（与上面同口径）
      }
    }
    return best?.id ?? below?.id ?? null
  }

  /** 翻页模式跳章：不挂 `pendingJump` / `pendingReveal`，也没有滚动补偿；同章目标不动，
   *  否则写 0 会把读者正在看的页在存档里改成章首。 */
  private pagedJumpTo(index: number, write: boolean): void {
    this.pendingJumpNow = null
    this.pendingReveal = null
    if (index === this.position.chapterIndex) return
    this.commit(write ? 'jump' : 'restore', index, 0)
    if (!this.mounted(index)) void this.load(index)
  }

  private jumpTo(target: JumpTarget): void {
    // 越界目标什么都不做：写进去等于把「读到第 N 章」落成不存在的章，pendingJump 也再也等不到挂载。
    if (!this.inRange(target.index)) return
    this.pendingScrollFixes = []                         // 导航落位归 settleJump，旧补偿作废
    this.pendingReveal = null                            // 导航是更晚的显式动作：挂起的听书落位作废
    this.backfillBudget = BACKFILL_MAX_CHAPTERS          // 跳章 = 新 episode
    if (this.paged) {
      // 翻页模式没有滚动视口，也没有 binding.rendered 去结算 pendingJump：只写章号 + 载章；
      // 页内落位（起点/末页）由 BookStage 的 pendingLand 自己摆。
      this.pagedJumpTo(target.index, true)
      return
    }
    this.setPendingJump(target)
    this.commit('jump', target.index, 0)
    if (!this.mounted(target.index)) {
      void this.load(target.index)
    }
  }

  /** 目标章下标是否落在当前目录范围内（目录还没发布 = 无从判断，一律不算有效） */
  private inRange(index: number): boolean {
    const toc = this.tocNow
    return toc !== null && index >= 0 && index < toc.length
  }

  /** 压一条返回项：与栈顶**同一处**的快照不重复压（视口没动过，压两份只让工具栏多一次「返回原处」）。
   *  返回这个位置当前那条，调用方拿它当「关闭面板要消费哪条」的句柄。 */
  private pushReturn(snapshot: VisibleNode): VisibleNode {
    const top = this.returnStack[this.returnStack.length - 1]
    if (top !== undefined && top.index === snapshot.index && top.nodeId === snapshot.nodeId
      && top.offsetWithinNode === snapshot.offsetWithinNode) return top
    this.returnStack.push(snapshot)
    return snapshot
  }

  private markReturnDepth(): void {
    const depth = this.returnStack.length
    if (this.store.get().returnDepth !== depth) this.store.set({ returnDepth: depth })
  }

  /** 渲染后拍点（唯一入口：阅读器的 DOM 绑定在测量帧里调它）。次序固定：落位 → 重测锚点 →
   *  结算滚动补偿 → 预取/回溯补载。这一趟的重测无条件：它是唯一知道「新章块已提交进 DOM」的时刻，
   *  滚动帧里那次可能量在提交之前。视图只看 `state.domRevision` 决定这一帧要不要拍。 */
  afterRender(): void {
    this.settleJump()
    this.recalcAnchors()
    this.applyScrollFixes()
    // 精确段落位排在滚动补偿之后：它是这一拍最终的视口意图，补偿只负责不让前插/裁章跳屏。
    this.settleReveal()
    if (this.restoring) return          // 落位帧之前 DOM 已提交但视口还没落：不预取、不补载
    this.checkPreload()
    this.checkBackfill()
  }

  /** 排版复位：视图排版 effect 的唯一入口。把「变化前视口顶所在节点」拉回同一相对位置；
   *  目标量不到 → 不落位、**快照不清**（清掉等于让这一轮排版再也找不回锚）。插图框已按可信
   *  宽高预留，量到的偏移就是可信的；位置提交仍归会话（复位后喂一次视口读数）。 */
  applyTypesetRelocation(): void {
    const snap = this.lastVisibleBeforePrefs
    if (snap === null) return
    const off = this.port.targetOffset(snap.index, snap.nodeId)
    if (off === null) return
    this.port.setScrollTop(this.port.scrollTop() + off + snap.offsetWithinNode - this.topInset)
    this.sampleVisibleBeforePrefsChange()            // 复位后重采：连调两次排版也各有正确锚
    this.handleViewportChange({ layoutChanged: true })
  }

  /** 听书段落的落位：目标章挂载后量 `[data-pidx]` 块的视口偏移并顶对齐；与 `settleJump` 同一套
   *  「先挂载再测量」硬次序。`write` 决定走 `jump`（落盘 + flush）还是 `restore`（只站定不写），
   *  后者让「回阅读器」保持 `ADR-0078` 的零进度写语义。 */
  private settleReveal(): void {
    const target = this.pendingReveal
    if (target === null) return
    // 存档恢复的双帧落位尚未完成：此刻的 scrollTop 还是进入前的旧值，量了也会被恢复覆盖。
    if (this.restoring) return
    if (!this.mounted(target.index)) {
      // 章还没提交进 DOM：能载就载，载不动就等下一拍；不在这里挂死。
      if (this.tocNow !== null && this.inflight === null) void this.load(target.index)
      return
    }
    const geometry = this.port.targetOffsetOfParagraph?.(target.index, target.paragraphIndex) ?? null
    const top = geometry?.top ?? this.port.targetOffset(target.index, null)
    if (top === null) {
      // 章块挂载了却量不到落点：放弃这一次，别让 pendingReveal 永久挡住后续视口读数。
      this.pendingReveal = null
      return
    }
    const height = geometry?.height ?? 0
    const viewH = this.port.viewHeight()
    const bandTop = this.topInset
    const bandBottom = Math.max(bandTop, viewH - target.bottomInset)
    const fullyVisible = top >= bandTop && top + height <= bandBottom
    if (target.mode === 'follow' && fullyVisible) {
      // 跟读只在「目标成为当前可见的最后一段，且已经落到带的下半部」时翻页；否则这一页里
      // 不动。翻页的落点仍是带顶（不居中）：视口顶 = 正在念的段，位置才有唯一读法。
      const next = this.port.targetOffsetOfParagraph?.(target.index, target.paragraphIndex + 1) ?? null
      const lastVisible = next === null || next.top >= bandBottom
      const lowerHalf = top + height > bandTop + (bandBottom - bandTop) * 0.6
      if (!lastVisible || !lowerHalf) {
        this.pendingReveal = null
        return
      }
    }
    // 所有落位都对齐到带顶（带顶已扣掉顶条）；跟读翻页也落在带顶——视口顶 = 正在念的段，位置才有唯一读法。
    const delta = top - bandTop
    this.pendingReveal = null
    // 同步滚动事件若在 setScrollTop 里到达，由 holdViewport 挡住；异步事件由幽灵写闸兜住。
    this.holdViewport = true
    try {
      this.port.setScrollTop(this.port.scrollTop() + delta)
    } finally {
      this.holdViewport = false
    }
    this.recalcAnchors()
    const anchor = this.anchorsNow.find((x) => x.index === target.index)
    if (anchor === undefined) return
    this.commit(target.write ? 'jump' : 'restore', target.index, ratioWithin(anchor, this.contentTop()))
  }

  /** pendingJump 的目标已渲染 → 按真实位置定位并清零。**先挂载再测量**是硬次序。
   *  定位后补一笔**真实比例**（章号意图 requestJump 已落盘，这里补「落位后读到章内哪儿」）。
   *  **窄回退**：章块已挂载而锚点量不到（悬空锚点 / 手改元数据）退回该章章首——挂住的代价是
   *  `handleViewportChange` 被 pendingJump 整条早退，滚动不再落盘。正文确实没挂载（在途）才继续挂住。 */
  private settleJump(): void {
    const jump = this.pendingJumpNow
    if (jump === null) return
    let off = this.port.targetOffset(jump.index, jump.anchorId)
    let offsetWithinNode = jump.offsetWithinNode
    if (off === null && jump.anchorId !== null && this.mounted(jump.index)) {
      off = this.port.targetOffset(jump.index, null)
      offsetWithinNode = 0
    }
    if (off === null) return
    // 让出顶条：目标落在看得见的顶（与恢复同一条口径），不藏在条后
    this.port.setScrollTop(this.port.scrollTop() + off + offsetWithinNode - this.topInset)
    this.pendingJumpNow = null                        // 清目标不推进 DOM 版本：这是测量自己的产物
    this.recalcAnchors()
    const a = this.anchorsNow.find((x) => x.index === jump.index)
    if (a === undefined) return
    this.commit('jump', jump.index, ratioWithin(a, this.contentTop()))
  }

  /** 已载表发布：换引用即换版本，同一次通知里推进 DOM 版本（视图按它判断「这一帧要不要拍」）。 */
  private publishChapters(chapters: Array<ChapterContent | null>, patch: Partial<ReaderSessionState> = {}): void {
    this.chaptersNow = chapters
    this.domRevision += 1
    this.store.set({ chapters, domRevision: this.domRevision, ...patch })
  }

  /** 置待定位目标：目标可能已在 DOM（同章锚点跳转），推进 DOM 版本请求一拍。
   *  **清目标不推进**（`settleJump` 里直接置空）：那是测量自己的产物，不该再叫一拍。 */
  private setPendingJump(target: JumpTarget): void {
    this.pendingJumpNow = target
    this.domRevision += 1
    this.store.set({ domRevision: this.domRevision })
  }

  /** 该章正文是否已挂载（`mountedSet` 随载入/裁剪同步维护；会话只看这张索引）。 */
  private mounted(index: number): boolean {
    return this.mountedSet.has(index)
  }

  /** 锚点刷新（存档恢复、布局变化、渲染后拍点与失败定位共用）；同时记下这次测量吃的是哪份已载表。 */
  private recalcAnchors(): void {
    this.anchorsNow = this.port.measureAnchors()
    this.anchorsFrom = this.chaptersNow
  }

  /** 参考章的新旧起点差（裁章与前插共享）；块高不含章间外边距，量不到参考章时返回 null，调用方走回退。 */
  private anchorDelta(keep: { index: number; start: number } | null): number | null {
    if (keep === null) return null
    const after = this.anchorsNow.find((x) => x.index === keep.index)
    return after === undefined ? null : after.start - keep.start
  }

  /** 渲染后结算滚动补偿：裁章 → 按参考章起点差下移；前插 → 按原来第一章的新旧起点差上移。
   *  只改滚动位、不碰位置真相，下一次视口读数照常修正；必须在 DOM 提交之后做。
   *  参考章量不到时：裁章退回高度和，前插退回新章块高。 */
  private applyScrollFixes(): void {
    const fixes = this.pendingScrollFixes
    if (fixes.length === 0) return
    this.pendingScrollFixes = []
    for (const fix of fixes) {
      const delta = this.anchorDelta(fix.keep)
      if (delta !== null) {
        this.port.setScrollTop(this.port.scrollTop() + delta)
        continue
      }
      if (fix.kind === 'drop') {
        this.port.setScrollTop(this.port.scrollTop() - fix.px)
        continue
      }
      const a = this.anchorsNow.find((x) => x.index === fix.index)
      if (a !== undefined) this.port.setScrollTop(this.port.scrollTop() + a.height)
    }
  }

  /** 采点：在 `setPref` 的同步调用栈里执行——那一刻 React 还没重渲染、DOM 还是旧排版，是唯一拿得到「变化前位置」的时刻。 */
  private sampleVisibleBeforePrefsChange(): void {
    this.lastVisibleBeforePrefs = this.port.currentNode()
  }

  /** prefs 采点订阅（`open` 挂、`dispose` 摘）：StrictMode 双挂载与同实例重开都只许订一次。 */
  private subscribePrefs(): void {
    if (this.prefsUnsub !== null) return
    this.prefsUnsub = prefsStore.subscribe(() => { this.sampleVisibleBeforePrefsChange() })
  }

  /** 取消挂起帧并清布局标记：上一代（换书/退出）的视口事件不再代表任何东西。 */
  private cancelPendingFrame(): void {
    if (this.frame === null) return
    const handle = this.frame.handle
    this.frame = null
    this.pendingLayout = false
    this.viewportFeed.cancelFrame(handle)
  }

  /** 退出阅读器：先作废在途续作（代际 +1），再把防抖窗口里的进度 flush 落盘（flush 不 cancel，
   *  cancel 会静默丢最后一段章内偏移）。在途槽一并复位：**同一实例还会被下一次 open 复用**，
   *  留着旧槽会让那次加载被无声挡下。 */
  dispose(): void {
    this.generation++
    this.cancelPendingFrame()
    this.prefsUnsub?.()                                  // 采点订阅随会话结束：此后 setPref 不读节点
    this.prefsUnsub = null
    this.lastVisibleBeforePrefs = null
    this.inflight = null
    this.pendingScrollFixes = []
    this.restoring = false
    this.save.flush()
  }
}

function toErrorInfo(e: unknown, t: Translate = zhTranslate): { code?: string; message?: string } {
  const err = e as { code?: unknown } | null
  return {
    ...(typeof err?.code === 'string' ? { code: err.code } : {}),
    message: describeError(e, t),
  }
}
