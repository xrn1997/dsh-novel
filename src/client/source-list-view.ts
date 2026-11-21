import { filterByGroup, filterByStatus, filterSources, groupIcon, setGroupFilter, setQuery, setStatusFilter } from './source-list.js'
import { sourceInbox } from './source-inbox.js'
import type { SourceListUi, StatusFilter } from './source-list.js'
import type { SourcePublic } from './views/types.js'

/**
 * 源列表的派生 view-model：计数 / 分组图例 / 过滤管线 / 选中态派生都是纯计算，不写成组件体里的闭包。
 * 本 module 把「全库源列表 + UI 现场 → 展示派生值」收成一个纯函数：无 React、无 IO，视图只接线。
 * 另一面是筛选写口 `filterWrites`：「写筛选 + 页码回第一页」必须同一处。
 *
 * 语义决策钉在此处：分组下拉选项集按**全库**聚合（否则组合过滤做不了）；'disabled' 维是 enabled
 * 布尔而非 status；状态下拉**不带计数**（全库读数唯一住址是列表头**状态带** `stats`）；
 * 坏源/未验证的 id 集合读 `source-inbox.ts`，不再 filter 第二遍。
 */

/** 列表头状态带的六个读数：`enabled/disabled` 是 enabled 维，`ai` 是 AI 搜索标记维，`unverified/broken`
 *  是 status 维（三者正交）。算全库、不看过滤，且**停用源照样计入**未验证/坏源与 AI 搜索；
 *  这两维**直接读 `source-inbox.ts` 的集合**。0 也要显示（数字位忽隐忽现会让带子一直抖）。 */
export interface SourceStats { total: number; enabled: number; disabled: number; ai: number; unverified: number; broken: number }

/** 派生结果：视图渲染所需的全部纯计算值 */
export interface SourceListViewModel {
  /** 过滤管线结果：状态 → 分组 → 文本（交集，顺序即应用序） */
  filtered: SourcePublic[]
  /** 前端分页截取（limit 条） */
  shown: SourcePublic[]
  /** 选中集的 Set 形态（行级 selected 判定用） */
  selected: Set<string>
  /** 分组下拉选项集：全库聚合计数（**不随状态/文本过滤缩水**，见文件头注） */
  groupCounts: Map<string, number>
  /** 「未分组」伪选项的计数：groups 为空的源数（全库聚合，口径与 groupCounts 一致） */
  ungroupedCount: number
  /** 表头「?」图例：`icon = 组名`（只列带图标组——无图标组在格内显示全名，无需图例），\n 连接 */
  groupLegend: string
  /** 删除确认模态的登录态点名计数（ids 里带 hasAuth 的源数） */
  authCountOf: (ids: string[]) => number
  /** 过滤结果全选态（编辑态表头复选框）；空过滤结果恒 false（全选 0 个没有语义） */
  allFilteredSelected: boolean
  /** 列表头状态带读数（全库口径，见 SourceStats 注） */
  stats: SourceStats
}

/** 筛选的**唯一写口**：筛选一改就是换一批结果，页码必须回到第一页——旧页码是上一批结果的游标。
 *  页码现场归视图，本写口只收「写筛选 + 重置」这条次序。 */
export function filterWrites(resetPage: () => void): {
  query: (q: string) => void
  status: (f: StatusFilter) => void
  group: (g: string) => void
} {
  return {
    query: (q) => { setQuery(q); resetPage() },
    status: (f) => { setStatusFilter(f); resetPage() },
    group: (g) => { setGroupFilter(g); resetPage() },
  }
}

/** 纯派生：全库源列表 + UI 现场 + 分页 limit → 展示派生值。零副作用。 */
export function deriveSourceListView(all: SourcePublic[], ui: SourceListUi, limit: number): SourceListViewModel {
  const filtered = filterSources(filterByGroup(filterByStatus(all, ui.statusFilter), ui.groupFilter), ui.query)
  const shown = filtered.slice(0, limit)
  const selected = new Set(ui.selection)
  // 分组选项集：全库聚合（不走任何过滤管线——选项集稳定）。
  const groupCounts = new Map<string, number>()
  for (const s of all) for (const g of s.groups) groupCounts.set(g, (groupCounts.get(g) ?? 0) + 1)
  const ungroupedCount = all.filter((s) => s.groups.length === 0).length
  // 状态带：`enabled/disabled` 一趟算齐；`unverified/broken` **直接读待办派生**——不要在这里再 filter 一遍。
  const inbox = sourceInbox(all)
  const stats: SourceStats = { total: all.length, enabled: 0, disabled: 0, ai: 0, unverified: inbox.unverified.length, broken: inbox.broken.length }
  for (const s of all) {
    if (s.enabled) stats.enabled += 1
    else stats.disabled += 1
    if (s.aiSearch) stats.ai += 1
  }
  const legend: string[] = []
  for (const g of groupCounts.keys()) {
    const icon = groupIcon(g)
    if (icon !== null) legend.push(`${icon} = ${g}`)
  }
  return {
    filtered,
    shown,
    selected,
    groupCounts,
    ungroupedCount,
    groupLegend: legend.join('\n'),
    authCountOf: (ids) => {
      const idSet = new Set(ids)
      return all.filter((s) => idSet.has(s.id) && s.hasAuth).length
    },
    allFilteredSelected: filtered.length > 0 && filtered.every((s) => selected.has(s.id)),
    stats,
  }
}
