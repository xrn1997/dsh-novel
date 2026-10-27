import { ROUTES } from '../shared/wire.js'
import type { ShelfEntry } from '../shared/wire.js'
import type { ShelfFilterKey } from './shelf-view-model.js'
import { createStore } from './store.js'

/**
 * 面板期书架投影：书架读取面、落架账与筛选/关键字在**面板存活期**共用一份。
 *
 * 为什么升格成模块级 store（裁决见 `docs/adr/0046`）：书架读取面、阅读器与搜索落架账必须共用一份；
 * 若 ShelfView 每次挂载整取、ReaderSession 为答一个 `onShelf` 布尔再整取、落架账只活组件挂载期，
 * 三个读者会各取一份、各丢一份——切去阅读器再回来，行上又写「＋ 加书架」，而书其实已在架上。
 *
 * 真相仍在服务端：`load` 每次挂载重取；加架由调用方并入落架账、删除由调用方对账。
 * 本模块不预读、不缓存正文/目录，面板卸载即丢。搜索轮次与任务快照不在这里（仍归各自的观察通道）。
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

let inflight: Promise<void> | null = null
/** 投影代际：卸载、删除对账与新记入的加架都递增，起始更早的在途响应按它丢弃——
 *  卸载后旧请求不许回写新投影，删前/加前快照也不许把书架读数打回去。 */
let generation = 0

/** 作废旧读：三者都改变书架读取面；新的一发由下一次挂载 / `ensurePanelShelf` / `loadPanelShelf` 再起。 */
function invalidateReads(): void {
  generation += 1
  inflight = null
}

/** 取一次书架（并发调用并到同一发）。成功后以服务端列表为基线，与既有落架账取并集
 *  （写成功过、服务端列表短暂滞后也不丢账）；删除由 `removePanelShelfBooks` 对账。 */
export function loadPanelShelf(deps: PanelShelfDeps): Promise<void> {
  if (inflight !== null) return inflight
  const gen = generation
  inflight = deps.apiGet(ROUTES.shelf.path).then(
    (list) => {
      if (gen !== generation) return
      const landed = new Set([...panelShelf.get().landed, ...list.map((b) => b.bookKey)])
      panelShelf.set({ books: list, error: null, landed })
    },
    (e) => {
      if (gen !== generation) return
      // 失败不伪装成空架：books 置空 + error，视图据此显示不可用而不是「书架空空」
      panelShelf.set({ books: [], error: deps.describeError(e) })
    },
  ).finally(() => {
    // 旧代的 finally 不许清掉新一代的在途句柄
    if (gen === generation) inflight = null
  })
  return inflight
}

/** 书架还没取过、上次读面失败，或指定书不在已有列表里才取（阅读器问在架读数时用）。
 *  不传 `bookKey` 时只问「这一面板读过书架吗」——搜索结果页要的是整份落架基线，不是某一本书。
 *  已有投影覆盖所需且没有在途刷新就不付第二发。**在途那一发必须先等**：阅读器还要从
 *  同一份列表恢复进度，直接答缓存会读到上一次写回之前的旧位置。等完之后仍缺当前书或上次
 *  读面失败，再重取一次——列表可能停在最近一次加架之前，不能把「还没刷到」答成「不在架」。 */
export async function ensurePanelShelf(deps: PanelShelfDeps, bookKey?: string): Promise<void> {
  if (inflight !== null) await inflight
  const { books, error } = panelShelf.get()
  const covered = books !== null && error === null
    && (bookKey === undefined || books.some((b) => b.bookKey === bookKey))
  if (covered) return
  await loadPanelShelf(deps)
}

/** 阅读器视角的在架读数：读面失败照实 reject（问不到 ≠ 不在架），成功给当前书架列表。
 *  投影若在读面期间被卸载重置（`books` 回到 null），同样 reject——空架是「确实没有」，
 *  不是「还没问到」。视图不再自己重述这条不变量。 */
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

/** 落架成功：记进面板期账本（按地址去重；幂等 PUT 的语义是「这一发成功过」），并作废
 *  起始更早的在途读面——否则加架前的快照落地会把这本书仍判成「不在架」。只有真新增那一发
 *  才抬代际：同一地址第二次记入时，早于第一次记入的那些读面已经被作废过一轮了。 */
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

/** 删除成功后对账：架位与落架账一起移除（否则删掉再加的书会被旧账误标成「已在架」）。
 *  起始早于这次删除的在途读面带的是删前快照，落地会把书带回来——按代际整发作废，
 *  需要时由下一次挂载 / `ensurePanelShelf` 重取。 */
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
