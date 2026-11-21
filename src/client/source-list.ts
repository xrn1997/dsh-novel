import { createStore } from './store.js'
import type { SourcePublic } from './views/types.js'

/** 源列表过滤：名称/地址/分组子串命中（大小写不敏感）；空 query 原样返回。大库没有过滤无法用。 */
export function filterSources(sources: SourcePublic[], query: string): SourcePublic[] {
  const q = query.trim().toLowerCase()
  if (q === '') return sources
  return sources.filter((s) =>
    s.name.toLowerCase().includes(q)
    || s.baseUrl.toLowerCase().includes(q)
    || s.groups.some((g) => g.toLowerCase().includes(q)))
}

/** 状态下拉过滤：六维单选，与文本过滤交集。读数归列表头**状态带**，下拉不带计数；
 *  'disabled' 维是 enabled 布尔、'ai' 维是 AI 标记，两者与 status 正交。 */
export type StatusFilter = 'all' | 'verified' | 'broken' | 'unverified' | 'disabled' | 'ai'

export function filterByStatus(sources: SourcePublic[], filter: StatusFilter): SourcePublic[] {
  if (filter === 'all') return sources
  if (filter === 'disabled') return sources.filter((s) => !s.enabled)
  if (filter === 'ai') return sources.filter((s) => s.aiSearch)
  return sources.filter((s) => s.status === filter)
}

/** 「未分组」伪选项哨兵值：用不可能出现在真实组名里的哨兵串而非字面量——组名是用户数据，撞名即误筛。 */
export const UNGROUPED = '__ungrouped__'

/** 分组过滤：'' = 全部；精确匹配组名，与状态下拉/文本过滤叠加；UNGROUPED = 只看无分组源。只出下拉单选。 */
export function filterByGroup(sources: SourcePublic[], group: string): SourcePublic[] {
  if (group === '') return sources
  if (group === UNGROUPED) return sources.filter((s) => s.groups.length === 0)
  return sources.filter((s) => s.groups.includes(group))
}

/** 组名装饰图标提取：输入里存在自带装饰图标的组名；分组列只显示图标、hover 出全名，无符号组回退全名。 */
export function groupIcon(group: string): string | null {
  const m = group.match(/[\p{So}\p{Sk}\uFE0F\u200D]+/u)
  return m === null ? null : m[0]
}

// 模块级 store：试跑下钻返回、设置区重开都不丢现场——过滤/勾选是「工作现场」，卸载即清零不可接受。

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
/** 只清勾选、不动编辑态：「清空选择」钮 + 删除成功后的收尾。批量启停**不**用它（那批源还在列表里，
 *  勾选是它们的现场）；不要借 `setEditMode(false)` 顺手清。 */
export function clearSelection(): void { sourceListUi.set({ selection: [] }) }
export function toggleSelect(id: string): void {
  const cur = sourceListUi.get().selection
  sourceListUi.set({ selection: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] })
}
export function selectMany(ids: string[]): void {
  const set = new Set([...sourceListUi.get().selection, ...ids])
  sourceListUi.set({ selection: [...set] })
}

/** 测试专用：整现场一次复位（模块级 store 跨用例残留）；不要用五个 setter 手工复位，容易漏项。 */
export function resetSourceListUi(): void { sourceListUi.set(initial) }
