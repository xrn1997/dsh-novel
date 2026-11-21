import type { Cheerio } from 'cheerio'
import type { AnyNode } from 'domhandler'
import type { EngineValue, Facet, RuleUsage } from './types.js'
import { UnsupportedRuleError } from './errors.js'

export type Combinator = 'first' | 'and' | 'zip'

export interface CombineOpts {
  /** 抛错时的段级定位（组合符没有自己的段，调用方给 -1 + 原文） */
  loc?: { facet?: Facet; segmentIndex: number; segmentRaw: string }
  /** 两条用途的合并形状不同，必须分派：`list` 产出**节点集**（`&&` 合并全部节点、`%%` 的驱动长度取**首支**）；
   *  `value` 产出**字符串列表**（空/Miss 分支不参与，驱动长度取**第一个非空支**）。缺省 'value'。 */
  usage?: RuleUsage
}

/**
 * 组合符求值（语义钉死）：
 * - `first`（||）：左→右返回首个既非 Miss 也非空 List 的分支；全 Miss → Miss；全空 List → 空 List
 *   （不折叠成 Miss——Miss≠空 List）。
 * - `and`（&&）：合并所有非空分支——**空/Miss 分支静默跳过**，其余按序拼接（Value 间 `\n`、List 摊平、nodes
 *   合并成节点集）；全空/Miss → Miss。空/Miss 只跳过、不代表整体 Miss：改成「任一 Miss → 整体 Miss」会让
 *   缺一支的目录整块判失败。
 * - `zip`（%%）：交叉合并——第 i 轮按分支顺序各取第 i 项，驱动长度 = 首个参与分支的长度，尾项不产出。
 * Matches（2-D）在 `first` 下透传、`and` 下单分支透传，多分支混合与 `%%` 一律抛；节点集与字符串分支混在
 * 一起合并同样抛错——静默丢掉一侧正是「空结果冒充失败」。
 */
export function combine(values: EngineValue[], combinator: Combinator, opts?: CombineOpts): EngineValue {
  const usage = opts?.usage ?? 'value'
  switch (combinator) {
    case 'first': return combineFirst(values)
    case 'and': return combineAnd(values, usage, opts?.loc)
    case 'zip': return combineZip(values, usage, opts?.loc)
  }
}

function combineFirst(values: EngineValue[]): EngineValue {
  let allMiss = true
  for (const v of values) {
    if (v.kind === 'miss') continue
    allMiss = false
    if (v.kind === 'list' && v.items.length === 0) continue // 空 List = 未取到，继续向右
    return v
  }
  if (allMiss && values.length > 0) return { kind: 'miss', detail: '所有分支未命中' }
  return { kind: 'list', items: [] } // 全空 List 或零分支 → 空 List（保留 Miss≠空 List 区分）
}

/** `&&`：跳过 Miss/空 List 分支，其余按序合并（全 Value → `\n` 连接；全 nodes → 节点集；混合形状 → 抛） */
function combineAnd(
  values: EngineValue[], usage: RuleUsage,
  loc?: { facet?: Facet; segmentIndex: number; segmentRaw: string },
): EngineValue {
  const kept = values.filter((v) => v.kind !== 'miss' && !(v.kind === 'list' && v.items.length === 0))
  if (kept.length === 0) return { kind: 'miss', detail: '&& 所有分支未命中' }
  if (kept.some((v) => v.kind === 'matches')) {
    const only = kept[0]
    if (kept.length === 1 && only !== undefined) return only
    throw new UnsupportedRuleError('&& 混合 AllInOne(matches) 二维结果无法合并', mergeErrCtx(usage, loc))
  }
  if (kept.some((v) => v.kind === 'nodes')) {
    if (!kept.every((v) => v.kind === 'nodes')) {
      throw new UnsupportedRuleError('&& 混合节点集与字符串结果无法合并（列表路径的分支只会是节点集）', mergeErrCtx(usage, loc))
    }
    return mergeNodes(kept.map((v) => v.nodes))
  }
  if (kept.every((v) => v.kind === 'value')) {
    return { kind: 'value', text: kept.map((v) => (v as { text: string }).text).join('\n') }
  }
  const items: string[] = []
  for (const v of kept) {
    if (v.kind === 'value') items.push(v.text)
    else if (v.kind === 'list') items.push(...v.items)
  }
  return { kind: 'list', items }
}

function combineZip(
  values: EngineValue[], usage: RuleUsage,
  loc?: { facet?: Facet; segmentIndex: number; segmentRaw: string },
): EngineValue {
  // 参与分支按用途分派：取值用途空/Miss 不入集合、驱动长度 = 第一个非空支；列表用途分支无条件入列
  // → 空首支也占第一位（首支为空 ⇒ 整条为空）。
  const branches = (usage === 'list'
    ? values.map((v): EngineValue => (v.kind === 'miss' ? { kind: 'list', items: [] } : v))
    : values.filter((v) => v.kind !== 'miss' && !(v.kind === 'list' && v.items.length === 0)))
  if (branches.length === 0) return { kind: 'miss', detail: '%% 所有分支未命中' }
  if (branches.some((v) => v.kind === 'matches')) {
    throw new UnsupportedRuleError('%% 交叉合并不支持 AllInOne(matches) 二维结果', mergeErrCtx(usage, loc))
  }
  if (branches.some((v) => v.kind === 'nodes')) {
    if (!branches.every((v) => v.kind === 'nodes')) {
      throw new UnsupportedRuleError('%% 混合节点集与字符串结果无法合并（列表路径的分支只会是节点集）', mergeErrCtx(usage, loc))
    }
    const sets = branches.map((v) => v.nodes)
    const columns = sets.map((s) => s.toArray())
    const driver = columns[0]?.length ?? 0
    const out: AnyNode[] = []
    for (let i = 0; i < driver; i++) {
      for (const col of columns) {
        const node = col[i]
        if (node !== undefined) out.push(node)
      }
    }
    // 首支为空 = 驱动 0 轮 = 整条无条目，取位为空即选择失败
    if (out.length === 0) return { kind: 'miss', detail: '%% 首个分支为空，交叉取数无从驱动' }
    return mergeNodes(sets, out)
  }
  const lists: string[][] = branches.map((v) => (v.kind === 'list' ? v.items : v.kind === 'value' ? [v.text] : []))
  const max = lists[0]?.length ?? 0
  const items: string[] = []
  for (let i = 0; i < max; i++) {
    for (const list of lists) {
      const item = list[i]
      if (item !== undefined) items.push(item)
    }
  }
  if (items.length === 0) return { kind: 'miss', detail: '%% 首个分支为空，交叉取数无从驱动' }
  return { kind: 'list', items }
}

function mergeNodes(sets: Cheerio<AnyNode>[], nodes?: AnyNode[]): EngineValue {
  const first = sets[0]
  if (first === undefined) return { kind: 'list', items: [] }
  const all = nodes ?? sets.flatMap((s) => s.toArray())
  return { kind: 'nodes', nodes: first._make(all) }
}

function mergeErrCtx(usage: RuleUsage, loc?: { facet?: Facet; segmentIndex: number; segmentRaw: string }) {
  return {
    facet: loc?.facet ?? 'rule',
    segmentIndex: loc?.segmentIndex ?? -1,
    segmentRaw: loc?.segmentRaw ?? `${usage === 'list' ? '列表' : '取值'}用途下的组合符`,
  }
}

/**
 * 反序：List → 项反序；Matches → 行反序；nodes → 节点集反序（用 Cheerio 自身 `_make` 重建选择集，
 * 保持同一文档根）；Value/Miss → 原样。
 */
export function reverseList(v: EngineValue): EngineValue {
  switch (v.kind) {
    case 'list': return { kind: 'list', items: [...v.items].reverse() }
    case 'matches': return { kind: 'matches', rows: [...v.rows].reverse() }
    case 'nodes': {
      const reversed = v.nodes.toArray().reverse()
      return { kind: 'nodes', nodes: v.nodes._make(reversed) }
    }
    default: return v // value / miss 原样
  }
}
