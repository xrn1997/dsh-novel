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

export class ReaderSession {
  private readonly store = createStore<ReaderSessionState>({
    toc: null, chapters: [], loadingIdx: null, error: null, pendingJump: null, currentChapter: 0,
  })
  /** 异步回调读最新目录/已载表/锚点（原视图五个「防陈旧闭包」ref 的职责收拢于此） */
  private tocNow: ChapterEntry[] | null = null
  private chaptersNow: Array<string | null> = []
  private anchorsNow: ChapterAnchor[] = []
  private inflight: number | null = null
  private lastChapter = 0
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
    this.lastChapter = 0
    this.inflight = null
    this.failedIndex = null
    this.save.cancel()
    this.store.set({ toc: null, chapters: [], loadingIdx: null, error: null, pendingJump: null, currentChapter: 0 })
    try {
      const toc = await this.deps.fetchToc(sourceId, bookKey)
      this.tocNow = toc
      const blank = new Array<string | null>(toc.length).fill(null)
      this.chaptersNow = blank
      this.store.set({ toc, chapters: blank })
      let restoreIndex = 0
      let restoreRatio = 0
      try {
        const shelf = await this.deps.fetchShelf()
        const mine = shelf.find((b) => b.bookKey === bookKey)
        if (mine !== undefined) {
          if (typeof mine.totalChapters !== 'number') this.deps.saveTotalChapters(toc.length)
          if (mine.progress.chapterIndex > 0) {
            restoreIndex = mine.progress.chapterIndex
            restoreRatio = mine.progress.offsetRatio
          }
        }
      } catch { /* 书架拉不到：从头读，不阻断进入 */ }
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

  /** 未载边界哨兵进预取区 → 加载下一章（单一在途；读尽/边界未到 → 不动） */
  checkPreload(sourceId: string): void {
    const sentinel = this.port.sentinelOffset()
    if (sentinel === null) return
    const target = nextLoadTarget(sentinel, this.port.viewHeight(), {
      chapters: this.chaptersNow, loading: this.inflight,
    })
    if (target !== null) void this.load(sourceId, target)
  }

  /** 视口变化：预取 + 进度落盘（切章强制存；同章防抖存） */
  handleViewportChange(sourceId: string): void {
    this.checkPreload(sourceId)
    this.recalcAnchors()
    if (this.anchorsNow.length === 0) return
    const { chapterIndex, offsetRatio } = locateChapter(this.anchorsNow, this.port.scrollTop())
    if (chapterIndex !== this.lastChapter) {
      this.lastChapter = chapterIndex
      this.store.set({ currentChapter: chapterIndex })        // 跨章才唤醒渲染（进度细线 + 目录高亮）
      this.deps.saveProgress(chapterIndex, offsetRatio)      // 切章强制存（不等防抖）
    } else {
      this.save(chapterIndex, offsetRatio)                   // 同章滚动：防抖存
    }
  }

  /** 目录直达：目标章未载则加载（落地后由 settleJump 定位） */
  requestJump(sourceId: string, index: number): void {
    this.store.set({ pendingJump: index })
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
