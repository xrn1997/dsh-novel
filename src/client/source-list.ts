import { createStore } from './store.js'
import type { SourcePublic } from './views/types.js'

/** 源列表过滤：名称/地址/分组子串命中（大小写不敏感）；空 query 原样返回。
 *  630+ 源的列表没有过滤无法用——定位是列表化的前提。 */
export function filterSources(sources: SourcePublic[], query: string): SourcePublic[] {
  const q = query.trim().toLowerCase()
  if (q === '') return sources
  return sources.filter((s) =>
    s.name.toLowerCase().includes(q)
    || s.baseUrl.toLowerCase().includes(q)
    || s.groups.some((g) => g.toLowerCase().includes(q)))
}

/** 状态下拉过滤：五维单选，与文本过滤交集（先 filterByStatus 再 filterSources）。
 *  读数职责已归待办箱（`source-inbox.ts`），下拉不带计数——旧状态 chips 随改版退役。
 *  'disabled' 维度是 enabled 布尔而非 status——停用与坏源是两个正交维度。 */
export type StatusFilter = 'all' | 'verified' | 'broken' | 'unverified' | 'disabled'

export function filterByStatus(sources: SourcePublic[], filter: StatusFilter): SourcePublic[] {
  if (filter === 'all') return sources
  if (filter === 'disabled') return sources.filter((s) => !s.enabled)
  return sources.filter((s) => s.status === filter)
}

/** 「未分组」伪选项哨兵值：下拉里专门筛 groups 为空的源（给它们补分组的定位入口）。
 *  用不可能出现在真实组名里的哨兵串而非「未分组」字面量——真实组名五花八门，撞名即误筛；
 *  视图渲染时把它显示成「未分组（n）」 */
export const UNGROUPED = '__ungrouped__'

/** 分组过滤：'' = 全部（含无分组源——不过滤即全量）；精确匹配分组名，
 *  与状态下拉/文本过滤叠加（交集）；UNGROUPED 哨兵 = 只看无分组源。
 *  分组只出下拉单选（真实组名五花八门，做 chips 收不住宽度）；v1 不做多组并筛（宁窄不宽） */
export function filterByGroup(sources: SourcePublic[], group: string): SourcePublic[] {
  if (group === '') return sources
  if (group === UNGROUPED) return sources.filter((s) => s.groups.length === 0)
  return sources.filter((s) => s.groups.includes(group))
}

/** 组名装饰图标提取：上游组名自带视觉图标（「快速书源 ⚡」尾部的 ⚡）——
 *  分组列只显示图标（图标即组的视觉身份），hover 出全名；无符号组（如「小说」）返回 null，
 *  显示侧回退全名（不造图标）。FE0F/ZWJ 是 emoji 组合件，一并纳入图标段 */
export function groupIcon(group: string): string | null {
  const m = group.match(/[\p{So}\p{Sk}\uFE0F\u200D]+/u)
  return m === null ? null : m[0]
}

// ── 列表 UI 状态────────────────────────────────────────────
// 模块级 store（routeStore 同款模式）：试跑下钻返回、设置区重开都不丢现场——
// 642 源的过滤/勾选是「工作现场」，卸载即清零是不可接受的（状态机走查洞 1）。

export interface SourceListUi {
  query: string
  statusFilter: StatusFilter
  /** 分组过滤（'' = 全部）——与其他现场同级：重开设置不丢 */
  groupFilter: string
  selection: string[]
  editMode: boolean
}

const initial: SourceListUi = { query: '', statusFilter: 'all', groupFilter: '', selection: [], editMode: false }

export const sourceListUi = createStore<SourceListUi>(initial)

export function setQuery(query: string): void { sourceListUi.set({ query }) }
export function setStatusFilter(f: StatusFilter): void { sourceListUi.set({ statusFilter: f }) }
export function setGroupFilter(g: string): void { sourceListUi.set({ groupFilter: g }) }
export function setEditMode(editMode: boolean): void {
  // 退出编辑态顺带清选择——选择集只在编辑态有意义
  sourceListUi.set(editMode ? { editMode } : { editMode, selection: [] })
}
/** 只清勾选、不动编辑态：「清空选择」钮 + 删除成功后的收尾（对象没了，勾选留着是幽灵 id）。
 *  批量启停**不**用它——那批源还在列表里，勾选是它们的现场（2026-09 用户裁定）。
 *  此原语此前不存在，调用点只能借 `setEditMode(false)` 顺手清，连带把编辑态一起退掉。 */
export function clearSelection(): void { sourceListUi.set({ selection: [] }) }
export function toggleSelect(id: string): void {
  const cur = sourceListUi.get().selection
  sourceListUi.set({ selection: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] })
}
export function selectMany(ids: string[]): void {
  const set = new Set([...sourceListUi.get().selection, ...ids])
  sourceListUi.set({ selection: [...set] })
}

/** 测试专用：整现场一次复位（模块级 store 跨用例残留——先例 transient.resetTransient）。
 *  五个 setter 手工复位既啰嗦又漏项（groupFilter 就曾被漏过）。 */
export function resetSourceListUi(): void { sourceListUi.set(initial) }
