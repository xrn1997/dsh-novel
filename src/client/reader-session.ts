import { hasProgress } from '../shared/wire.js'
import { anchorTop, locateChapter, ratioWithin } from './progress.js'
import type { ChapterAnchor } from './progress.js'
import { debounce } from './util.js'
import { nextLoadTarget } from './reader-load.js'
import { createStore } from './store.js'
import type { BookNavigation, ChapterContent, ChapterEntry, LinkRole, NavigationItem, ReadingTarget, ShelfBook } from './views/types.js'

/**
 * 阅读会话：「目录 → 存档恢复 → 逐章加载 → 预取 → 进度落盘」的**时序唯一持有者**，
 * 经 interface 可测。
 *
 * 为什么不留在视图：真 bug（在途被占、两帧未落定、切章强制存 vs 防抖、陈旧闭包）全住在
 * 命令式协调里，抽纯函数只把复杂度挪走、无 seam 可测。DOM 测量经 ReaderPort 注入
 * （视图实现，测试给假 port）；锚点数学复用已测的 progress，不造第二份。
 * 图文（EPUB）未新增第二条加载循环：载荷换成 `ChapterContent`（会话只搬不拆）、目标换成
 * 「章号 + 锚点 + 节点内偏移」，仍走同一在途槽与 settleJump 落位次序。
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
}

/** 当前位置锚：视口顶所在的正文节点（章 + 节点 + 节点内偏移）。
 *  **两处消费者是同一个问题**——「视口顶现在落在哪个节点上」：正文链接跳走前的返回采点、
 *  排版（字号/行距/栏宽）变化后的视口复位。只活在窗口内，绝不落盘。 */
export interface VisibleNode { index: number; nodeId: string; offsetWithinNode: number }

/** 待定位目标：章号 + 可空章内锚点 + 锚点内像素偏移。
 *  章首直达（目录点击）恒 `{index, anchorId, offsetWithinNode: 0}`——原路径一字未改；
 *  只有「回到链接来源」会带上非零偏移（让返回落在同一个节点内的同一处，而不是节点顶）。 */
export interface JumpTarget { index: number; anchorId: string | null; offsetWithinNode: number }

/** DOM 测量口（视图实现；会话只读不碰 DOM） */
export interface ReaderPort {
  measureAnchors(): ChapterAnchor[]
  scrollTop(): number
  setScrollTop(px: number): void
  viewHeight(): number
  scrollHeight(): number
  /** 哨兵相对视口顶部的偏移；哨兵不在 DOM → null（不预取） */
  sentinelOffset(): number | null
  /** 目标（章 + 可空锚点）相对视口顶部的偏移；`anchorId` 为 null = 该章块顶。
   *  目标节点不在 DOM → null（不落位、不清待定位目标，等下一轮）。 */
  targetOffset(index: number, anchorId: string | null): number | null
  /** 视口顶所在正文节点；该章没有可定位节点（文字章）或量不到 → null */
  currentNode(): VisibleNode | null
}

export interface ReaderSessionState {
  toc: ChapterEntry[] | null
  /** 目录展示树（同一份读面里的另一列表；高亮与跳转按它，章数/进度仍按 toc） */
  navigation: NavigationItem[] | null
  /** null/空洞 = 未载（视图不渲染该章） */
  chapters: Array<ChapterContent | null>
  loadingIdx: number | null
  error: { code?: string; message?: string } | null
  /** 待定位目标（渲染落地后 settleJump 定位并清零） */
  pendingJump: JumpTarget | null
  /** 当前视口所在章（0 基）。**只在跨章时写**——同章滚动继续走防抖落盘，不唤醒渲染；
   *  消费者是工具栏章进度细线与目录抽屉的「当前章」高亮，都是低频呈现。 */
  currentChapter: number
  /** 正文链接的返回栈深度（> 0 = 视图给「返回原处」入口）。窗口内状态，不落盘。 */
  returnDepth: number
}

type DebouncedSave = ((chapterIndex: number, offsetRatio: number) => void) & { cancel(): void; flush(): void }

/** 恢复位预约：目录已发布但存档章还没问回来时，预取会先抢走在途槽（哨兵此时在视口顶 →
 *  目标 = 第 0 章），open() 的恢复 load 半路静默返回——整条恢复丢失、退出再进回到第一章。
 *  所以目录一发布就占槽到存档章落定（2026-09-22 实测；打点见 `load()` 的 early-return）。 */
const RESTORE_SLOT = -1

export class ReaderSession {
  private readonly store = createStore<ReaderSessionState>({
    toc: null, navigation: null, chapters: [], loadingIdx: null, error: null,
    pendingJump: null, currentChapter: 0, returnDepth: 0,
  })
  /** 异步回调读最新目录/已载表/锚点（原视图五个「防陈旧闭包」ref 的职责收拢于此） */
  private tocNow: ChapterEntry[] | null = null
  private navigationNow: NavigationItem[] | null = null
  private chaptersNow: Array<ChapterContent | null> = []
  private anchorsNow: ChapterAnchor[] = []
  private inflight: number | null = null
  /** 阅读位置：**唯一真相**（章 + 章内比例）。滚动测量 / 目录选中 / 存档恢复都只是「修正」它，
   *  落盘策略只由 `commit` 判定——读数若只是每次滚动现算的一次性输出，每条时序路径就会各自
   *  决定何时落盘，缺陷全出在这一族。 */
  private position = { chapterIndex: 0, offsetRatio: 0 }
  private bookKey = ''
  private sourceId = ''
  /** 最近一次失败的章下标（null = 目录/进入阶段失败）——retry 用 */
  private failedIndex: number | null = null
  /** 正文链接的返回栈（窗口内状态；每次导航前采点，返回时弹一条）。**绝不落盘**。 */
  private returnStack: VisibleNode[] = []
  /** 会话代际：`open`（换书/重开）与 `dispose`（退出阅读器）各自 +1。异步续作（迟到的正文、
   *  双帧回调）只服务它出发时的那一代——不符即作废，不落位不落盘。**只补在异步续作上**：
   *  既有的在途槽次序、RESTORE_SLOT 预约与防抖 flush 语义一字未动。 */
  private generation = 0
  /** 这本书此刻**在不在书架上**（`'unknown'` = 书架没拉到，不假装知道）。
   *  读数来自 `open` 里那次已有的书架查询：为存档恢复查过一次，再为「要不要问入架」查第二次
   *  就是给同一个问题立第二个主人。视图据此在离开阅读器时问一次——不在架的书，进度 PUT 会被
   *  服务端判 `NOT_ON_SHELF`，这一屏读到哪儿就此静默消失。 */
  private onShelfNow: 'unknown' | 'on' | 'off' = 'unknown'
  private readonly save: DebouncedSave

  constructor(
    private readonly deps: ReaderSessionDeps,
    private readonly port: ReaderPort,
    /** 滚动防抖窗口（缺省 2s；测试收紧） */
    saveDebounceMs = 2000,
  ) {
    const d = debounce((chapterIndex: number, offsetRatio: number): void => {
      deps.saveProgress(chapterIndex, offsetRatio)
    }, saveDebounceMs)
    this.save = Object.assign((i: number, r: number): void => d(i, r), { cancel: () => d.cancel(), flush: () => d.flush() })
  }

  get state(): ReaderSessionState { return this.store.get() }
  /** 在架读数（视图据此决定离开时要不要问一句） */
  get onShelf(): 'unknown' | 'on' | 'off' { return this.onShelfNow }
  subscribe = (cb: () => void): (() => void) => this.store.subscribe(cb)

  /** 进入一本书：目录 → 存档恢复；无存档/书架拉不到 → 从头 */
  async open(sourceId: string, bookKey: string): Promise<void> {
    const gen = ++this.generation                       // 换书/重开：上一代的一切在途续作自此作废
    this.sourceId = sourceId
    this.bookKey = bookKey
    this.tocNow = null
    this.navigationNow = null
    this.chaptersNow = []
    this.anchorsNow = []
    this.position = { chapterIndex: 0, offsetRatio: 0 }
    this.inflight = null
    this.failedIndex = null
    this.returnStack = []
    this.onShelfNow = 'unknown'                           // 换书即重问：上一本的在架状态不带到这一本
    this.save.cancel()
    this.store.set({
      toc: null, navigation: null, chapters: [], loadingIdx: null, error: null,
      pendingJump: null, currentChapter: 0, returnDepth: 0,
    })
    try {
      const nav = await this.deps.fetchNavigation(sourceId, bookKey)
      if (gen !== this.generation) return
      // 线性序列与展示树是同一份读面的两列表：章数/进度/导出按 chapters，抽屉与高亮按 items
      const toc = nav.chapters
      this.tocNow = toc
      this.navigationNow = nav.items
      const blank = new Array<ChapterContent | null>(toc.length).fill(null)
      this.chaptersNow = blank
      // 先预约槽再发布目录：从这一刻到存档章落定之间没有别的 await，预取插不进来
      this.inflight = RESTORE_SLOT
      this.store.set({ toc, navigation: nav.items, chapters: blank })
      let restoreIndex = 0
      let restoreRatio = 0
      try {
        const shelf = await this.deps.fetchShelf()
        if (gen !== this.generation) return
        const mine = shelf.find((b) => b.bookKey === bookKey)
        // 同一次查询顺手记下在架读数：它是这条链上唯一问得到「这本书在不在架上」的时刻
        this.onShelfNow = mine === undefined ? 'off' : 'on'
        if (mine !== undefined) {
          if (typeof mine.totalChapters !== 'number') this.deps.saveTotalChapters(toc.length)
          // 「有没有存档」判据单点归 wire.hasProgress（第 0 章的章内位置也算进度）；
          // 存档章越出目录（换源/目录变短/缓存重建）→ clamp 到最后一章，不许落成空白阅读器
          if (hasProgress(mine.progress)) {
            restoreIndex = Math.min(mine.progress.chapterIndex, toc.length - 1)
            restoreRatio = mine.progress.offsetRatio
          }
        }
      } catch { /* 书架拉不到：从头读，不阻断进入 */ }
      if (gen !== this.generation) return
      this.inflight = null
      this.commit('restore', restoreIndex, restoreRatio)      // 站定：位置 = 存档值，不写回
      await this.load(sourceId, restoreIndex, restoreRatio)
    } catch (e) {
      if (gen !== this.generation) return
      this.store.set({ error: toErrorInfo(e) })
    }
  }

  /** 加载某章（单在途槽：同章并发/滚动风暴去重）；restoreRatio>0 = 双帧后按锚点定位 */
  async load(sourceId: string, index: number, restoreRatio = 0): Promise<void> {
    const toc = this.tocNow
    if (toc === null || index < 0 || index >= toc.length) return
    if (this.inflight !== null) return
    const gen = this.generation
    this.inflight = index
    this.store.set({ loadingIdx: index })
    try {
      const content = await this.deps.fetchChapter(sourceId, this.bookKey, index)
      // 迟到（换书/卸载）的正文什么都不做：不落位、不落盘、不碰新会话的在途槽（finally 同一条闸）
      if (gen !== this.generation) return
      const next = [...this.chaptersNow]
      next[index] = content
      this.chaptersNow = next
      // 成功即清错（此前错误条粘屏：成功 load 不清 error、会话无 clearError 接口，重试还是空操作）
      this.failedIndex = null
      this.store.set({ chapters: next, error: null })
      this.pruneToViewport()                                  // 跳章目标到货：窗口跟着视口收口（不串章）
      if (restoreRatio > 0) {
        this.deps.afterFrames(() => {
          if (gen !== this.generation) return
          this.recalcAnchors()
          this.deps.afterFrames(() => {
            if (gen !== this.generation) return
            this.port.setScrollTop(anchorTop(this.anchorsNow, index, restoreRatio,
              this.port.scrollHeight(), this.port.viewHeight()))
          })
        })
      }
    } catch (e) {
      if (gen !== this.generation) return
      this.failedIndex = index
      // 跳章失败 → 撤销意图：commit('jump') 已把「读到第 N 章」写进存档，而第 N 章从未渲染过
      // ——不回退就是拿用户没见过的章当阅读位置。锚点为空（进入阶段第一章就失败）无可回退。
      const jump = this.store.get().pendingJump
      if (jump !== null && jump.index === index) this.store.set({ pendingJump: null })
      if (this.position.chapterIndex === index) {
        // 视口 = 「读者实际在哪儿」的证据（与 handleViewportChange 同一读取口径）
        this.recalcAnchors()
        if (this.anchorsNow.length > 0) {
          const at = locateChapter(this.anchorsNow, this.port.scrollTop())
          this.commit('cross', at.chapterIndex, at.offsetRatio)
        }
      }
      this.store.set({ error: toErrorInfo(e) })
    } finally {
      if (gen === this.generation) {                          // 作废的续作不许碰在途槽（那已是新会话的）
        this.inflight = null
        this.store.set({ loadingIdx: null })
        this.settlePendingLoad()
      }
    }
  }

   /** 在途槽释放后补拉「请求跳转时被在途挡下」的章（竞态）：requestJump 置 pendingJump 再试
   *  load，当时 inflight 非空则 load 立刻 return；正向流水到尾部后 chapters 不再变，
   *  settleJump 永不满足 → 该次点击无声消失、pendingJump 永挂。此处补一次。 */
  private settlePendingLoad(): void {
    const jump = this.store.get().pendingJump
    if (jump === null) return
    if (jump.index === this.failedIndex) return            // 刚失败过：不自动重试，等用户「重试」
    if (!this.mounted(jump.index)) {
      void this.load(this.sourceId, jump.index)
    }
  }

  /** 重试最近一次失败：章加载失败 → 重拉该章；进入/目录失败 → 重开。成功路径会清 error。 */
  retry(): void {
    if (this.failedIndex !== null) { void this.load(this.sourceId, this.failedIndex); return }
    void this.open(this.sourceId, this.bookKey)
  }

  /** 手动清错（成功 load 已自动清；此口留给视图的显式「知道了」类交互） */
  clearError(): void {
    this.failedIndex = null
    this.store.set({ error: null })
  }

  /** 未载边界哨兵进预取区 → 加载下一章（单一在途；读尽/边界未到 → 不动）。
   *  目标 = **视口所在章之后**第一个未载章（不是最大已载章 +1，见 reader-load 头注）。 */
  checkPreload(sourceId: string): void {
    const sentinel = this.port.sentinelOffset()
    if (sentinel === null) return
    const target = nextLoadTarget(sentinel, this.port.viewHeight(), {
      chapters: this.chaptersNow, loading: this.inflight, from: this.position.chapterIndex,
    })
    // 刚失败的同一章不自动重试（与 settlePendingLoad 同一条纪律）：漏了这句，失败章会随每次
    // 视口变化被重新预取，成了静默重试环
    if (target !== null && target !== this.failedIndex) void this.load(sourceId, target)
  }

  /** 已载集裁到「视口章所属的连续区间」：未载章不进 DOM，不裁则跳远端再回来时缺的章被跳过，
   *  渲染顺序不再等于书的顺序。只在视口章已载时裁：它在途时裁会把用户手上的正文清空。 */
  private pruneToViewport(): void {
    const at = this.position.chapterIndex
    if (!this.mounted(at)) return
    let lo = at
    while (lo > 0 && this.mounted(lo - 1)) lo--
    let hi = at
    while (hi + 1 < this.chaptersNow.length && this.mounted(hi + 1)) hi++
    let dropped = false
    const next = this.chaptersNow.map((text, i) => {
      if (i >= lo && i <= hi) return text
      if (text !== null) dropped = true
      return null
    })
    if (!dropped) return
    this.chaptersNow = next
    this.store.set({ chapters: next })
  }

  /** 位置修正的**唯一入口**：cause 决定落盘时机，与「视口是否动过」解耦。
   *  - `restore`：来自存档 → 只是站定，不写回（写回去是幽灵写）
   *  - `jump`   ：目录选中 = 导航事件 → 立即落（章已定，章内比例等视口落定后修正）
   *  - `cross`  ：视口跨章 = 导航事件 → 立即落
   *  - `scroll` ：同章滚动 = 连续量 → 防抖落
   *  两个分支同走一条防抖队列：挂起位里永远只剩最新一次读数，迟到的旧值无处可存。 */
  private commit(cause: 'restore' | 'jump' | 'cross' | 'scroll', chapterIndex: number, offsetRatio: number): void {
    // 幽灵写闸（与 `restore` 的「站定不写」同一条口径）：读数与**当前位置完全相同**时这一笔
    // 没有新信息，落盘只是把同一个数写回去——挂载期的第一次视口读数正是这一形态（位置刚从
    // 存档站定，读数再算一遍还是同一个值）。不闸住它，「浮层开合不写进度」这类断言就要跟
    // 挂起的冗余写抢时间。只闸 `scroll`：`jump`/`cross` 是导航事件，「选中即落盘」不因值恰好
    // 相同而放弃。
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
  /** 视口变化：预取 + 位置修正（跨章是导航事件，同章滚动是连续量）。
   *  目录跳章在途期间**不采信读数**：视口还是旧位置，采信等于用旧证据推翻用户刚下的导航
   *  命令（跳章后正文未到时读数会把位置改回原章）。落地由 `settleJump` 收口（它清
   *  pendingJump），之后的读数才是新位置的证据。 */
  handleViewportChange(sourceId: string): void {
    this.checkPreload(sourceId)
    this.recalcAnchors()
    if (this.anchorsNow.length === 0) return
    if (this.store.get().pendingJump !== null) return
    const { chapterIndex, offsetRatio } = locateChapter(this.anchorsNow, this.port.scrollTop())
    this.commit(chapterIndex === this.position.chapterIndex ? 'scroll' : 'cross', chapterIndex, offsetRatio)
  }

  /** 导航直达（目录点击 / 注释面板转交的主序列目标）：目标章未载则加载（落地后由 settleJump 定位）。
   *  **选中即落盘**：「读到哪一章」是导航事件，不押在「视口真的动过」上——章在途时用户切走、
   *  视口没动，只靠 handleViewportChange 意图就会静默丢失。
   *  `anchorId` 非空 = 跳到该章文档内的那个锚点（EPUB 目录：同一 XHTML 的多个条目跳不同锚点）。 */
  requestJump(sourceId: string, index: number, anchorId: string | null = null): void {
    this.jumpTo(sourceId, { index, anchorId, offsetWithinNode: 0 })
  }

  /** 正文内链（链接节点）跳转：**先采返回位置，再导航**。
   *  - `backlink` 本身**就是**返回动作（「回正文」链接），消费掉栈里那条而不是再压一条——
   *    否则返回动作自己把返回栈撑长；
   *  - 其余角色先采点压栈（视图据此给「返回原处」入口）。脚注也采点：面板是浮层、主阅读位置
   *    不动，但面板里还能再点到主序列，没有这条采点那次跳转就没有「原处」可回。
   *  返回这条采点（没采到 / backlink / 越界目标 → null）当句柄：关闭面板只消费打开时压的那条
   *  （见 `closeSupplement`）；落点由视图决定（补充文档开面板、主序列走跳章）。 */
  followLink(sourceId: string, target: ReadingTarget, role: LinkRole): VisibleNode | null {
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
      this.jumpTo(sourceId, { index: target.index, anchorId: target.anchorId, offsetWithinNode: 0 })
    }
    return entry
  }

  /** 返回原处（工具栏「返回」/ 关闭注释面板的兜底入口）：弹一条返回项，经**同一单在途加载路径**落位。
   *  来源章若已被裁掉（跳远端后只保留视口章）→ 与目录跳章同一条补载逻辑重新取回；
   *  落位与位置提交仍归 settleJump（它等目标挂载后才动）。 */
  goBack(sourceId: string): void {
    const entry = this.returnStack.pop()
    if (entry === undefined) return
    this.markReturnDepth()
    this.jumpTo(sourceId, { index: entry.index, anchorId: entry.nodeId, offsetWithinNode: entry.offsetWithinNode })
  }

  /** 关闭补充文档面板：**只消费「开面板时压入的那一条」**——`entry` 就是 `followLink` 交给视图的那个句柄。
   *  栈顶已不是它，说明期间用户又跟了别的链接（或自己按过工具栏返回）：那条记的是**别人的原处**，
   *  此时弹栈会把主序列送回用户没点过的地方，还会经 `commit('jump')` 写进存档。
   *  目录直接打开的补充文档（视图没有句柄）→ 什么都不做，只关面板。 */
  closeSupplement(sourceId: string, entry: VisibleNode | null): void {
    if (entry === null) return
    if (this.returnStack[this.returnStack.length - 1] !== entry) return
    this.goBack(sourceId)
  }

  /** 目录抽屉的当前项：**当前章内最近的已登记导航锚点**（视口顶已越过里最靠下的那个，章首
   *  算第一个）；一个都没越过 → 取**文档序最近的下方锚点**（最小正偏移；取导航列表第一条会在
   *  nav 把靠后节排前面时打错高亮）。并列按导航顺序取第一条（至多一条 aria-current）；
   *  量不到任何目标（章在途/文字章无节点）→ null，视图不打标。 */
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
    let best: { id: string; off: number } | null = null
    let below: { id: string; off: number } | null = null
    for (const c of candidates) {
      const off = this.port.targetOffset(chapter, c.anchorId)
      if (off === null) continue                            // 这个目标不在 DOM：不是候选
      if (off <= 0) {
        if (best === null || off > best.off) best = { id: c.id, off }
      } else if (below === null || off < below.off) {
        below = { id: c.id, off }                          // 并列者同样留在先到者手里（与上面同口径）
      }
    }
    return best?.id ?? below?.id ?? null
  }

  private jumpTo(sourceId: string, target: JumpTarget): void {
    // 越界目标（导航树带来的坏下标 / 陈旧的目标）什么都不做：写进去等于当下就把「读到第 N 章」
    // 落成存档里一个不存在的章，同时 pendingJump 再也等不到挂载——那本书的进度从此停摆。
    if (!this.inRange(target.index)) return
    this.store.set({ pendingJump: target })
    this.commit('jump', target.index, 0)
    if (!this.mounted(target.index)) {
      void this.load(sourceId, target.index)
    }
  }

  /** 目标章下标是否落在当前目录范围内（目录还没发布 = 无从判断，一律不算有效） */
  private inRange(index: number): boolean {
    const toc = this.tocNow
    return toc !== null && index >= 0 && index < toc.length
  }

  /** 压一条返回项：与栈顶**同一处**的快照不重复压——脚注引用开面板与面板里再点主序列链接
   *  问的是同一个视口位置（视口没动过），压两份只让工具栏多一次「返回原处」（点它回到原地）。
   *  返回这个位置当前那条（新压的或已压的）：调用方（视图）拿它当「关闭面板要消费哪条」的句柄。 */
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

  /** pendingJump 的目标已渲染 → 按真实位置定位并清零；未落地则下轮再试。
   *  **先挂载再测量**是硬次序：章块与锚点节点不在 DOM 时无可测量。
   *  定位后补一笔**真实比例**（章号意图 requestJump 已落盘，这里补「落位后读到章内哪儿」）。
   *  **窄回退**：章块已挂载而锚点量不到（悬空锚点 / 手改过的落盘元数据）退回该章章首——挂住
   *  的代价不是「这次没跳成」，而是 `handleViewportChange` 被 pendingJump 整条早退：滚动不再
   *  落盘、进度静默停摆，比「损坏元数据落到章首」坏得多。正文确实没挂载（在途）才继续挂住。 */
  settleJump(): void {
    const jump = this.store.get().pendingJump
    if (jump === null) return
    let off = this.port.targetOffset(jump.index, jump.anchorId)
    let offsetWithinNode = jump.offsetWithinNode
    if (off === null && jump.anchorId !== null && this.mounted(jump.index)) {
      off = this.port.targetOffset(jump.index, null)
      offsetWithinNode = 0
    }
    if (off === null) return
    this.port.setScrollTop(this.port.scrollTop() + off + offsetWithinNode)
    this.store.set({ pendingJump: null })
    this.recalcAnchors()
    const a = this.anchorsNow.find((x) => x.index === jump.index)
    if (a === undefined) return
    this.commit('jump', jump.index, ratioWithin(a, this.port.scrollTop()))
  }

  /** 该章正文是否已挂载（chapters 表里的空洞 = 还没到；DOM 侧无从判断，会话只看这张表） */
  private mounted(index: number): boolean {
    return this.chaptersNow[index] !== null && this.chaptersNow[index] !== undefined
  }

  /** 锚点刷新（视图在章节 DOM 变化后调用；会话在定位前也会自刷） */
  recalcAnchors(): void {
    this.anchorsNow = this.port.measureAnchors()
  }

  /** 退出阅读器：先作废在途续作（代际 +1），再把防抖窗口里的进度补落盘——flush 不 cancel，
   *  cancel 会静默丢最后一段章内偏移，而 fetch 卸载后照样完成，没有「来不及存」的结构理由。
   *  在途槽一并复位：dispose = 这条会话到此为止；留着旧槽会让本实例此后的加载被无声挡下。 */
  dispose(): void {
    this.generation++
    this.inflight = null
    this.save.flush()
  }
}

function toErrorInfo(e: unknown): { code?: string; message?: string } {
  const err = e as { code?: unknown }
  return {
    ...(typeof err?.code === 'string' ? { code: err.code } : {}),
    message: e instanceof Error ? e.message : String(e),
  }
}
