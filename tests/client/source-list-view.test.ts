import { describe, expect, it } from 'vitest'
import { deriveSourceListView } from '../../src/client/source-list-view.js'
import { sourceInbox } from '../../src/client/source-inbox.js'
import type { SourceListUi } from '../../src/client/source-list.js'
import type { SourcePublic } from '../../src/client/views/types.js'

/**
 * 源列表派生 view-model 的纯函数单测：
 * SettingsSourceList 曾把这些计算写成组件体闭包——零直接覆盖。抽纯函数后逐条钉语义，
 * 尤其是「分组选项集不随状态过滤缩水」这个语义决策（改了它过滤器就不可组合）。
 *
 * 2026 调度台改版的口径变化（本文件随之更新）：状态 chips 退役 → 状态下拉（不带计数），
 * chipCount 从 view-model 移除；坏源/未验证的 id 集合归 source-inbox.ts（待办派生唯一住址），
 * 本 view-model 不再重复派生 brokenIds/unverifiedIds。
 * 2026-09 续：读数落点从「待办箱与列表头部 meta」收敛为**仅列表头部状态带**（stats，本文件
 * 钉死），因为待办卡改成可忽略——读数不能跟着提示一起消失。
 */

const src = (over: Partial<SourcePublic> & { id: string }): SourcePublic => ({
  name: over.id, baseUrl: `https://${over.id}.com`, enabled: true, groups: [],
  type: 'text', status: 'verified', importedAt: 0, hasHeader: false, hasAuth: false, authExpired: false,
  ...over,
})

/** 默认现场：无过滤、无选择、浏览态 */
const ui0: SourceListUi = { query: '', statusFilter: 'all', groupFilter: '', selection: [], editMode: false }
const ui = (over: Partial<SourceListUi>): SourceListUi => ({ ...ui0, ...over })

// 五源覆盖三个状态 × 启停两态 × 带/不带登录态 × 带图标/无图标分组
const ALL: SourcePublic[] = [
  src({ id: 'a', status: 'verified', groups: ['快速 ⚡', '小说'], hasAuth: true }),
  src({ id: 'b', status: 'broken', groups: ['快速 ⚡'] }),
  src({ id: 'c', status: 'unverified', groups: ['小说'] }),
  src({ id: 'd', status: 'verified', enabled: false, groups: [] }),
  src({ id: 'e', status: 'broken', enabled: false, groups: ['小说'], hasAuth: true }),
]

describe('deriveSourceListView：分组选项集（语义决策：不随状态过滤缩水）', () => {
  it('默认现场：全库聚合计数，插入序遍历', () => {
    const vm = deriveSourceListView(ALL, ui0, 100)
    expect([...vm.groupCounts.entries()]).toEqual([['快速 ⚡', 2], ['小说', 3]])
  })

  it('状态过滤后选项集不缩水——选了「坏源」，非坏源分组仍在下拉里（可组合过滤）', () => {
    const vm = deriveSourceListView(ALL, ui({ statusFilter: 'broken' }), 100)
    expect(vm.filtered.map((s) => s.id)).toEqual(['b', 'e'])   // 过滤管线生效
    expect([...vm.groupCounts.entries()]).toEqual([['快速 ⚡', 2], ['小说', 3]])  // 选项集纹丝不动
  })

  it('文本过滤同样不影响选项集', () => {
    const vm = deriveSourceListView(ALL, ui({ query: 'a' }), 100)
    expect(vm.filtered.map((s) => s.id)).toEqual(['a'])
    expect(vm.groupCounts.size).toBe(2)
  })

  it('ungroupedCount：groups 为空的源数（「未分组」伪选项计数，同口径不随过滤缩水）', () => {
    expect(deriveSourceListView(ALL, ui0, 100).ungroupedCount).toBe(1)                    // d
    expect(deriveSourceListView(ALL, ui({ statusFilter: 'broken' }), 100).ungroupedCount).toBe(1)
    expect(deriveSourceListView([src({ id: 'y', groups: ['小说'] })], ui0, 100).ungroupedCount).toBe(0)
  })
})

describe('deriveSourceListView：分组图例', () => {
  it('只列带图标组，形态 `icon = 组名`，\\n 连接（无图标组在格内显示全名，无需图例）', () => {
    const vm = deriveSourceListView(ALL, ui0, 100)
    expect(vm.groupLegend).toBe('⚡ = 快速 ⚡')
  })

  it('全库无图标组 → 空串（视图据此不渲染「?」）', () => {
    const vm = deriveSourceListView([src({ id: 'x', groups: ['小说'] })], ui0, 100)
    expect(vm.groupLegend).toBe('')
  })
})

describe('deriveSourceListView：过滤管线（状态 → 分组 → 文本，交集）', () => {
  it('三维叠加取交集（状态下拉与 chips 同一过滤语义，source-list.ts 单点）', () => {
    const vm = deriveSourceListView(ALL, ui({ statusFilter: 'broken', groupFilter: '小说', query: 'e' }), 100)
    expect(vm.filtered.map((s) => s.id)).toEqual(['e'])
  })

  it('disabled 维是 enabled 布尔而非 status（停用与坏源正交）', () => {
    const vm = deriveSourceListView(ALL, ui({ statusFilter: 'disabled' }), 100)
    expect(vm.filtered.map((s) => s.id)).toEqual(['d', 'e'])
  })

  it('shown = filtered 的前 limit 条（前端分页，加载更多只加 limit）', () => {
    const vm = deriveSourceListView(ALL, ui0, 2)
    expect(vm.shown.map((s) => s.id)).toEqual(['a', 'b'])
    expect(vm.filtered).toHaveLength(5)
  })
})

describe('deriveSourceListView：选中态派生', () => {
  it('selected 是选中集 Set 形态；全选 = 过滤结果非空且全在选中集', () => {
    const vm = deriveSourceListView(ALL, ui({ selection: ['a', 'b', 'c', 'd', 'e'], editMode: true }), 100)
    expect(vm.selected.has('a')).toBe(true)
    expect(vm.allFilteredSelected).toBe(true)
  })

  it('部分选中 → false；过滤结果为空 → 恒 false（全选 0 个没有语义）', () => {
    expect(deriveSourceListView(ALL, ui({ selection: ['a'] }), 100).allFilteredSelected).toBe(false)
    expect(deriveSourceListView(ALL, ui({ query: '不存在' }), 100).allFilteredSelected).toBe(false)
    expect(deriveSourceListView([], ui0, 100).allFilteredSelected).toBe(false)
  })

  it('全选判定以**过滤结果**为作用域：状态下拉缩小过滤面后，选满过滤结果即全选', () => {
    const vm = deriveSourceListView(ALL, ui({ statusFilter: 'broken', selection: ['b', 'e'] }), 100)
    expect(vm.allFilteredSelected).toBe(true)
  })
})

describe('deriveSourceListView：登录态计数（删除确认模态的点名口径）', () => {
  it('authCountOf 只数作用域内带 hasAuth 的源；ids 外的不计', () => {
    const vm = deriveSourceListView(ALL, ui0, 100)
    expect(vm.authCountOf(['a', 'b'])).toBe(1)
    expect(vm.authCountOf(['b', 'c', 'd'])).toBe(0)
    expect(vm.authCountOf(['a', 'e'])).toBe(2)
    expect(vm.authCountOf([])).toBe(0)
  })
})

/** 列表头**状态带**（2026-09）：读数从待办卡搬来此处唯一住址——卡可被忽略，读数不能跟着消失。
 *  启用/停用是 enabled 维、未验证/坏源是 status 维，两个正交维并列显示，不做合计约束。 */
describe('deriveSourceListView：stats（状态带计数）', () => {
  it('五个读数为真：共 5 · 已启用 3 · 已停用 2 · 未验证 1 · 坏源 2', () => {
    expect(deriveSourceListView(ALL, ui0, 100).stats).toEqual({ total: 5, enabled: 3, disabled: 2, unverified: 1, broken: 2 })
  })

  it('算**全库**不算过滤结果：状态/分组/文本过滤都不改状态带（它是资产总读数，「当前过滤」另有其位）', () => {
    for (const over of [{ statusFilter: 'broken' as const }, { groupFilter: '小说' }, { query: 'a' }]) {
      expect(deriveSourceListView(ALL, ui(over), 100).stats).toEqual({ total: 5, enabled: 3, disabled: 2, unverified: 1, broken: 2 })
    }
  })

  it('停用 ≠ 免验：停用的坏源/未验证照样计入（与待办集合同一口径）', () => {
    const onlyOff = [src({ id: 'z', status: 'broken', enabled: false }), src({ id: 'w', status: 'unverified', enabled: false })]
    expect(deriveSourceListView(onlyOff, ui0, 100).stats).toEqual({ total: 2, enabled: 0, disabled: 2, unverified: 1, broken: 1 })
  })

  it('防漂移钉：stats.broken / stats.unverified 必须等于两张待办卡的成员数（两处各算一份迟早对不上）', () => {
    const vm = deriveSourceListView(ALL, ui0, 100)
    const inbox = sourceInbox(ALL)
    expect(vm.stats.broken).toBe(inbox.broken.length)
    expect(vm.stats.unverified).toBe(inbox.unverified.length)
  })
})
