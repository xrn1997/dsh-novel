import { hasProgress } from '../shared/wire.js'
import { anchorTop, locateChapter } from './progress.js'
import type { ChapterAnchor } from './progress.js'
import { debounce } from './util.js'
import { nextLoadTarget } from './reader-load.js'
import { createStore } from './store.js'
import type { ChapterEntry, ShelfBook } from './views/types.js'

/**
 * 阅读会话：把「目录 → 书架恢复 → 逐章加载 → 预取 → 进度落盘」的**时序编排**
 * 从 ReaderView 的 ref 协调里收拢成一个经 interface 可测的 module。
 *
 * 此前三个数学模块（progress / reader-load / scrollport）已测，但它们只是把复杂度**挪走**——
 * 真 bug（在途被占、两帧未落定、切章强制存 vs 2s 防抖、陈旧闭包）全住在视图的命令式协调里，
 * 无 seam 可测。会话持有状态与策略；DOM 测量经 ReaderPort 注入（视图实现它，测试给假 port）。
 * 锚点数学不自带第二份——复用已测的 progress.anchorTop / locateChapter。
 * 口径详见 `docs/design/client.md`。
 */

/** 依赖束：网络面（测试注入假实现）+ 帧调度（视图 = rAF 双帧，测试 = 同步执行） */
export interface ReaderSessionDeps {
  fetchToc(sourceId: string, bookKey: string): Promise<ChapterEntry[]>
  fetchChapter(sourceId: string, bookKey: string, index: number): Promise<string>
  fetchShelf(): Promise<ShelfBook[]>
  /** 进度落盘（会话负责防抖/强制策略；此处只管真发一次） */
  saveProgress(chapterIndex: number, offsetRatio: number): void
  /** 总章数回写（幂等补数据）；仅书在架且缺 totalChapters 时会话才调 */
  saveTotalChapters(total: number): void
  /** 布局落定后的回调调度 */
  afterFrames(cb: () => void): void
}

/** DOM 测量口（视图实现；会话只读不碰 DOM） */
export interface ReaderPort {
  measureAnchors(): ChapterAnchor[]
  scrollTop(): number
  setScrollTop(px: number): void
  viewHeight(): number
  scrollHeight(): number
  /** 哨兵相对视口顶部的偏移；哨兵不在 DOM → null（不预取） */
  sentinelOffset(): number | null
  /** 目标章块相对视口顶部的偏移（目录直达用）；未渲染 → null */
  chapterOffset(index: number): number | null
}

export interface ReaderSessionState {
  toc: ChapterEntry[] | null
  /** null/空洞 = 未载（视图不渲染该章） */
  chapters: Array<string | null>
  loadingIdx: number | null
  error: { code?: string; message?: string } | null
  /** 待定位章（渲染落地后 settleJump 定位并清零） */
  pendingJump: number | null
  /** 当前视口所在章（0 基）。**只在跨章时写**——同章滚动继续走防抖落盘，不唤醒渲染；
   *  消费者是工具栏章进度细线与目录抽屉的「当前章」高亮，都是低频呈现。 */
  currentChapter: number
}

type DebouncedSave = ((chapterIndex: number, offsetRatio: number) => void) & { cancel(): void; flush(): void }

/** 恢复位预约：目录已发布但存档章还没问回来，这段时间在途槽必须被占住。
 *  否则视图的预取先抢走槽（目录一发布哨兵就是正文里唯一元素、在视口顶 → 目标 = 第 0 章），
 *  open() 的恢复 load 走到 `inflight !== null` 半路静默返回——整条恢复丢失。
 *  真机症状：切到会话再切回来 / 退出再进，都回到第一章（2026-09-22 无头实测，打点见
 *  `load()` 的 early-return）。 */
const RESTORE_SLOT = -1

export class ReaderSession {
  private readonly store = createStore<ReaderSessionState>({
    toc: null, chapters: [], loadingIdx: null, error: null, pendingJump: null, currentChapter: 0,
  })
  /** 异步回调读最新目录/已载表/锚点（原视图五个「防陈旧闭包」ref 的职责收拢于此） */
  private tocNow: ChapterEntry[] | null = null
  private chaptersNow: Array<string | null> = []
  private anchorsNow: ChapterAnchor[] = []
  private inflight: number | null = null
  /** 阅读位置：**唯一真相**（章 + 章内比例）。滚动测量 / 目录选中 / 存档恢复都只是「修正」它，
   *  落盘策略只由 `commit` 判定——此前「读到哪儿」是每次滚动现算的一次性输出、没有状态，
   *  于是每条时序路径各自决定何时落盘（三次真机缺陷全出在这一族）。 */
  private position = { chapterIndex: 0, offsetRatio: 0 }
  private bookKey = ''
  private sourceId = ''
  /** 最近一次失败的章下标（null = 目录/进入阶段失败）——retry 用 */
  private failedIndex: number | null = null
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
  subscribe = (cb: () => void): (() => void) => this.store.subscribe(cb)

  /** 进入一本书：目录 → 存档恢复；无存档/书架拉不到 → 从头 */
  async open(sourceId: string, bookKey: string): Promise<void> {
    this.sourceId = sourceId
    this.bookKey = bookKey
    this.tocNow = null
    this.chaptersNow = []
    this.anchorsNow = []
    this.position = { chapterIndex: 0, offsetRatio: 0 }
    this.inflight = null
    this.failedIndex = null
    this.save.cancel()
    this.store.set({ toc: null, chapters: [], loadingIdx: null, error: null, pendingJump: null, currentChapter: 0 })
    try {
      const toc = await this.deps.fetchToc(sourceId, bookKey)
      this.tocNow = toc
      const blank = new Array<string | null>(toc.length).fill(null)
      this.chaptersNow = blank
      // 先预约槽再发布目录：从这一刻到存档章落定之间没有别的 await，预取插不进来
      this.inflight = RESTORE_SLOT
      this.store.set({ toc, chapters: blank })
      let restoreIndex = 0
      let restoreRatio = 0
      try {
        const shelf = await this.deps.fetchShelf()
        const mine = shelf.find((b) => b.bookKey === bookKey)
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
      this.inflight = null
      this.commit('restore', restoreIndex, restoreRatio)      // 站定：位置 = 存档值，不写回
      await this.load(sourceId, restoreIndex, restoreRatio)
    } catch (e) {
      this.store.set({ error: toErrorInfo(e) })
    }
  }

  /** 加载某章（单在途槽：同章并发/滚动风暴去重）；restoreRatio>0 = 双帧后按锚点定位 */
  async load(sourceId: string, index: number, restoreRatio = 0): Promise<void> {
    const toc = this.tocNow
    if (toc === null || index < 0 || index >= toc.length) return
    if (this.inflight !== null) return
    this.inflight = index
    this.store.set({ loadingIdx: index })
    try {
      const text = await this.deps.fetchChapter(sourceId, this.bookKey, index)
      const next = [...this.chaptersNow]
      next[index] = text
      this.chaptersNow = next
      // 成功即清错（此前错误条粘屏：成功 load 不清 error、会话无 clearError 接口，重试还是空操作）
      this.failedIndex = null
      this.store.set({ chapters: next, error: null })
      this.pruneToViewport()                                  // 跳章目标到货：窗口跟着视口收口（不串章）
      if (restoreRatio > 0) {
        this.deps.afterFrames(() => {
          this.recalcAnchors()
          this.deps.afterFrames(() => {
            this.port.setScrollTop(anchorTop(this.anchorsNow, index, restoreRatio,
              this.port.scrollHeight(), this.port.viewHeight()))
          })
        })
      }
    } catch (e) {
      this.failedIndex = index
      // 跳章失败 → 撤销意图：位置回到视口（`requestJump` 那次 commit('jump') 已把「读到第 N 章」
      // 写进存档，而第 N 章从未渲染过——不回退就是拿用户没见过的章当阅读位置，退出后下次进来
      // 还会照着它恢复）。锚点为空（进入阶段第一章就失败）时无可回退，保持原样。
      if (this.store.get().pendingJump === index) this.store.set({ pendingJump: null })
      if (this.position.chapterIndex === index) {
        // 视口就是「读者实际在哪儿」的证据（与 handleViewportChange 同一读取口径）。
        // 进入阶段第一章就失败时锚点为空 → 无可回退，保持原样。
        this.recalcAnchors()
        if (this.anchorsNow.length > 0) {
          const at = locateChapter(this.anchorsNow, this.port.scrollTop())
          this.commit('cross', at.chapterIndex, at.offsetRatio)
        }
      }
      this.store.set({ error: toErrorInfo(e) })
    } finally {
      this.inflight = null
      this.store.set({ loadingIdx: null })
      this.settlePendingLoad()
    }
  }

   /** 在途槽释放后补拉「请求跳转时被在途挡下」的章（竞态）：
   *  requestJump 只置 pendingJump 再试 load——若当时 inflight 非空，load 立刻 return；
   *  当正向流水已到尾部（nextChapterIndex === -1）chapters 不再变化，settleJump 永不满足 →
   *  该次点击无声消失、pendingJump 永挂。此处补一次：目标仍未载且不是刚失败的同一章 → 拉。 */
  private settlePendingLoad(): void {
    const jump = this.store.get().pendingJump
    if (jump === null) return
    if (jump === this.failedIndex) return                 // 刚失败过：不自动重试，等用户「重试」
    if (this.chaptersNow[jump] === null || this.chaptersNow[jump] === undefined) {
      void this.load(this.sourceId, jump)
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
    // 刚失败的同一章不自动重试（与 settlePendingLoad 同一条纪律）：漏了这一句，失败章会随每次
    // 视口变化被重新预取——位置已退回视口，`nextChapterIndex` 又会指向那个空洞，成了静默重试环
    if (target !== null && target !== this.failedIndex) void this.load(sourceId, target)
  }

  /** 已载集裁到「视口章所属的连续区间」：正文的渲染顺序必须等于书的顺序。
   *  目录跳到远端后，旧已载章与视口不相邻却照样渲染——读完第 11 章紧接第 51 章
   *  （实测 DOM 顺序 [0,10,50]，因为未载章不进 DOM，缺的章被跳过）。只在视口章已载时裁：
   *  它在途时裁会把用户手上的正文清空（跳章失败的场景就只剩错误条）。 */
  private pruneToViewport(): void {
    const at = this.position.chapterIndex
    if (this.chaptersNow[at] === null || this.chaptersNow[at] === undefined) return
    const loaded = (i: number): boolean => this.chaptersNow[i] !== null && this.chaptersNow[i] !== undefined
    let lo = at
    while (lo > 0 && loaded(lo - 1)) lo--
    let hi = at
    while (hi + 1 < this.chaptersNow.length && loaded(hi + 1)) hi++
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
   *  目录跳章在途期间**不采信读数**：那时的视口还是旧位置，采信它等于用旧证据推翻用户刚下的
   *  导航命令（实测：跳第 20 章后正文未到，一次读数把位置改回第 1 章，随后刚到的第 20 章
   *  被窗口裁掉）。落地由 `settleJump` 收口（它清 pendingJump），之后的读数才是新位置的证据。 */
  handleViewportChange(sourceId: string): void {
    this.checkPreload(sourceId)
    this.recalcAnchors()
    if (this.anchorsNow.length === 0) return
    if (this.store.get().pendingJump !== null) return
    const { chapterIndex, offsetRatio } = locateChapter(this.anchorsNow, this.port.scrollTop())
    this.commit(chapterIndex === this.position.chapterIndex ? 'scroll' : 'cross', chapterIndex, offsetRatio)
  }

  /** 目录直达：目标章未载则加载（落地后由 settleJump 定位）。
   *  **选中即落盘**：视口落在哪儿是随后的事（章可能还在途、用户可能已经切走），而
   *  「读到哪一章」是用户可感知的导航事件。此前只靠 handleViewportChange 那一笔，等于把
   *  导航意图押在「视口真的动过」上——章在途时用户切走，视口从头到尾没动，那一笔不会发生，
   *  意图静默丢失（真机：目录选章立刻切会话，回来仍在原处，正文其实已经取回来了）。 */
  requestJump(sourceId: string, index: number): void {
    this.store.set({ pendingJump: index })
    this.commit('jump', index, 0)
    if (this.chaptersNow[index] === null || this.chaptersNow[index] === undefined) {
      void this.load(sourceId, index)
    }
  }

  /** pendingJump 的章已渲染 → 按真实滚动位置定位并清零；未落地则下轮再试 */
  settleJump(): void {
    const jump = this.store.get().pendingJump
    if (jump === null) return
    const off = this.port.chapterOffset(jump)
    if (off === null) return
    this.port.setScrollTop(this.port.scrollTop() + off)
    this.store.set({ pendingJump: null })
  }

  /** 锚点刷新（视图在章节 DOM 变化后调用；会话在定位前也会自刷） */
  recalcAnchors(): void {
    this.anchorsNow = this.port.measureAnchors()
  }

  /** 退出阅读器：把防抖窗口里的进度补落盘再走。cancel 会静默丢最后一段章内偏移（实测缺陷），
   *  而 fetch 在组件卸载后照样完成——这里没有「来不及存」的结构理由，只有存与不存。 */
  dispose(): void { this.save.flush() }
}

function toErrorInfo(e: unknown): { code?: string; message?: string } {
  const err = e as { code?: unknown }
  return {
    ...(typeof err?.code === 'string' ? { code: err.code } : {}),
    message: e instanceof Error ? e.message : String(e),
  }
}
