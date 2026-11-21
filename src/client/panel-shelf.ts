import { ROUTES } from '../shared/wire.js'
import type { ShelfEntry } from '../shared/wire.js'
import type { ShelfFilterKey } from './shelf-view-model.js'
import { createStore } from './store.js'

/**
 * 面板期书架投影：书架读取面、落架账与筛选/关键字在**面板存活期**共用一份（`ADR-0046`）。
 * 若三个读者各取一份、各丢一份，切去阅读器再回来，行上又写「＋ 加书架」，而书其实已在架上。
 * 真相仍在服务端：`load` 每次挂载重取；本模块不预读、不缓存正文/目录，面板卸载即丢。
 */
export interface PanelShelfState {
  /** `null` = 还没取过（骨架）；失败时是 `[]` + `error`，不拿空架冒充加载中 */
  books: ShelfEntry[] | null
  error: string | null
  filter: ShelfFilterKey
  keyword: string
  /** 已落架的架位（bookKey 即命中地址）；服务端列表是基线，写成功后再并进来 */
  landed: ReadonlySet<string>
}

const initial = (): PanelShelfState => ({
  books: null, error: null, filter: 'all', keyword: '', landed: new Set(),
})

export const panelShelf = createStore<PanelShelfState>(initial())

export interface PanelShelfDeps {
  /** 只读书架列表这一条：具体形状收窄，调用方不必为泛型 T 作证 */
  apiGet: (path: string) => Promise<ShelfEntry[]>
  /** 把读面异常翻成当前语言的展示句；翻译归调用方（copy 不在本模块） */
  describeError: (error: unknown) => string
}

let inflight: Promise<PanelShelfRead> | null = null
/** 投影代际：卸载、删除对账与新记入的加架都递增；起始更早的在途响应按它丢弃。 */
let generation = 0

/** 一发读取的落点。`ok` = 胜出代际且读面成功；`failed` = 胜出但读面失败；`stale` = 被代际作废。
 *  调用方要区分「读面成功」与「这一发还算数吗」——只读 `panelShelf.get()` 会拿到别人的成功。 */
export type PanelShelfRead = 'ok' | 'failed' | 'stale'

/** 作废旧读：三者都改变书架读取面；新的一发由下一次挂载 / `ensurePanelShelf` / `loadPanelShelf` 再起。 */
function invalidateReads(): void {
  generation += 1
  inflight = null
}

/** 取一次书架（并发调用并到同一发）。成功后以服务端列表为基线，与既有落架账取并集（写成功过、
 *  列表短暂滞后也不丢账）。落点是**这一发**的（`PanelShelfRead`），不是投影里此刻的读数。 */
export function loadPanelShelf(deps: PanelShelfDeps): Promise<PanelShelfRead> {
  if (inflight !== null) return inflight
  const gen = generation
  inflight = deps.apiGet(ROUTES.shelf.path).then(
    (list): PanelShelfRead => {
      if (gen !== generation) return 'stale'
      const landed = new Set([...panelShelf.get().landed, ...list.map((b) => b.bookKey)])
      panelShelf.set({ books: list, error: null, landed })
      return 'ok'
    },
    (e: unknown): PanelShelfRead => {
      if (gen !== generation) return 'stale'
      // 失败不伪装成空架：books 置空 + error，视图据此显示不可用而不是「书架空空」
      panelShelf.set({ books: [], error: deps.describeError(e) })
      return 'failed'
    },
  ).finally(() => {
    // 旧代的 finally 不许清掉新一代的在途句柄
    if (gen === generation) inflight = null
  })
  return inflight
}

/** 书架还没取过、上次失败，或指定书不在列表里才取。不传 `bookKey` 时只问「这一面板读过书架吗」。
 *  **在途那一发必须先等**：阅读器要从同一份列表恢复进度，直接答缓存会读到旧位置。 */
export async function ensurePanelShelf(deps: PanelShelfDeps, bookKey?: string): Promise<void> {
  if (inflight !== null) await inflight
  const { books, error } = panelShelf.get()
  const covered = books !== null && error === null
    && (bookKey === undefined || books.some((b) => b.bookKey === bookKey))
  if (covered) return
  await loadPanelShelf(deps)
}

/** 阅读器视角的在架读数：读面失败照实 reject（问不到 ≠ 不在架）；投影在读面期间被重置同样 reject。
 *  视图不再自己重述这条不变量。 */
export async function readPanelShelf(deps: PanelShelfDeps, bookKey: string): Promise<ShelfEntry[]> {
  await ensurePanelShelf(deps, bookKey)
  const { books, error } = panelShelf.get()
  if (error !== null) throw new Error(error)
  // 内部错误文案不上屏（阅读器只把它当「问不到」）；中文可见文案归 client/copy。
  if (books === null) throw new Error('panel shelf projection unavailable')
  return books
}

export function setPanelShelfFilter(filter: ShelfFilterKey): void {
  panelShelf.set({ filter })
}

export function setPanelShelfKeyword(keyword: string): void {
  panelShelf.set({ keyword })
}

/** 进度写成功后的面板期回写：让当前存活的面板投影看到新位置。服务端仍是真相；这只改可丢弃投影。 */
export function patchPanelShelfProgress(bookKey: string, chapterIndex: number, offsetRatio: number): void {
  const { books } = panelShelf.get()
  if (books === null) return
  const index = books.findIndex((b) => b.bookKey === bookKey)
  const book = books[index]
  if (book === undefined) return
  const next = [...books]
  next[index] = { ...book, progress: { chapterIndex, offsetRatio, updatedAt: Date.now() } }
  panelShelf.set({ books: next })
}

/** 落架成功：记进面板期账本（按地址去重），并作废起始更早的在途读面。只有真新增那一发才抬代际。 */
export function markPanelShelfLanded(urls: Iterable<string>): void {
  const current = panelShelf.get().landed
  const next = new Set(current)
  let changed = false
  for (const url of urls) {
    if (!next.has(url)) { next.add(url); changed = true }
  }
  if (!changed) return
  invalidateReads()
  panelShelf.set({ landed: next })
}

/** 删除成功后对账：架位与落架账一起移除；起始早于这次删除的在途读面按代际整发作废。 */
export function removePanelShelfBooks(bookKeys: Iterable<string>): void {
  const keys = new Set(bookKeys)
  if (keys.size === 0) return
  invalidateReads()
  const { books, landed } = panelShelf.get()
  const nextBooks = books === null ? null : books.filter((b) => !keys.has(b.bookKey))
  const nextLanded = new Set([...landed].filter((k) => !keys.has(k)))
  panelShelf.set({ books: nextBooks, landed: nextLanded })
}

/** 测试与面板卸载重置：回到「还没取过」的初始面；在途响应按代际丢弃。 */
export function resetPanelShelf(): void {
  invalidateReads()
  panelShelf.set(initial())
}
