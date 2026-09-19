import { filterByGroup, filterByStatus, filterSources, groupIcon } from './source-list.js'
import type { SourceListUi } from './source-list.js'
import type { SourcePublic } from './views/types.js'

/**
 * 源列表的派生 view-model：SettingsSourceList 曾把计数 / 分组图例 /
 * 过滤管线 / 选中态派生写成组件体里的闭包——纯计算被 React 接线包住，只能整壳 jsdom 间接验。
 * 本 module 把「全库源列表 + UI 现场 → 展示所需派生值」收成一个纯函数：输入相同输出必相同，
 * 无 React、无 store、无 IO——逻辑可单测，视图只做接线。
 *
 * 语义决策钉在此处（单测钉死，别在视图里悄悄改）：
 * - 分组下拉选项集按**全库**聚合计数，不随状态/文本过滤缩水——筛选器的选项集要稳定，
 *   否则选了「坏源」状态后非坏源的分组就从下拉里消失，没法组合过滤；
 * - 'disabled' 维度是 enabled 布尔而非 status（停用与坏源正交）——沿用 source-list.ts 口径；
 * - 状态下拉**不带计数**（2026 调度台改版）：下拉只做过滤不做总览；全部读数的唯一住址是
 *   列表头**状态带**（`stats`，本 view-model 派生）——2026-09 起待办卡可被忽略，读数不能再
 *   住在那里；坏源/未验证的 id 集合归 source-inbox.ts（待办派生的唯一住址），本层不重复派生。
 * 口径详见 `docs/design/client.md`。
 */

/** 列表头状态带的五个读数：`enabled/disabled` 是 enabled 维，`unverified/broken` 是 status 维
 *  （两者正交，故不做「合计 = total」这种假约束）。口径：算全库、不看过滤，且**停用源照样
 *  计入**未验证/坏源（2026-09 裁定：停用 ≠ 免验），与待办集合同一口径——测试钉住二者相等。
 *  0 也要显示（「坏源 0」本身就是结论，且数字位忽隐忽现会让这条带子一直抖）。 */
export interface SourceStats { total: number; enabled: number; disabled: number; unverified: number; broken: number }

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

/** 纯派生：全库源列表 + UI 现场 + 分页 limit → 展示派生值。零副作用。 */
export function deriveSourceListView(all: SourcePublic[], ui: SourceListUi, limit: number): SourceListViewModel {
  const filtered = filterSources(filterByGroup(filterByStatus(all, ui.statusFilter), ui.groupFilter), ui.query)
  const shown = filtered.slice(0, limit)
  const selected = new Set(ui.selection)
  // 分组选项集：全库聚合（不走任何过滤管线——选项集稳定，见文件头注）
  const groupCounts = new Map<string, number>()
  for (const s of all) for (const g of s.groups) groupCounts.set(g, (groupCounts.get(g) ?? 0) + 1)
  const ungroupedCount = all.filter((s) => s.groups.length === 0).length
  // 状态带：单次遍历算四个计数（逐维 filter 要把 642 条源过四遍，而这里每次渲染都跑）
  const stats: SourceStats = { total: all.length, enabled: 0, disabled: 0, unverified: 0, broken: 0 }
  for (const s of all) {
    if (s.enabled) stats.enabled += 1
    else stats.disabled += 1
    if (s.status === 'unverified') stats.unverified += 1
    else if (s.status === 'broken') stats.broken += 1
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
