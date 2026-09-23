import type { Cheerio } from 'cheerio'
import type { AnyNode } from 'domhandler'
import type { EngineValue, Facet, RuleUsage } from './types.js'
import { UnsupportedRuleError } from './errors.js'

export type Combinator = 'first' | 'and' | 'zip'

export interface CombineOpts {
  /** 抛错时的段级定位（组合符没有自己的段，调用方给 -1 + 原文） */
  loc?: { facet?: Facet; segmentIndex: number; segmentRaw: string }
  /** 对面两条路径的合并形状不同，必须按用途分派：
   *  `list`（getElements）分支产出 **Elements**，`&&` 走 `elements.addAll(es)`、`%%` 的驱动长度
   *  取 `elementsList[0]`（空首支也算一支 ⇒ 整条为空）；
   *  `value`（getStringList）分支产出 **List&lt;String&gt;**，空/Miss 分支根本不入 `results`，
   *  驱动长度取 `results[0]`（第一个非空支）。缺省 'value'。 */
  usage?: RuleUsage
}

/**
 * 组合符求值（语义钉死；`&&`/`%%` 口径按 legado-with-MD3 AnalyzeByJSoup/JSonPath 考证修正）：
 * - `first`（||）：左→右返回首个既非 Miss 也非空 List 的分支；空 List 视为「未取到」继续向右；
 *   全 Miss → Miss；全空 List（无 Miss）→ 空 List（不折叠成 Miss——Miss≠空 List）。
 * - `and`（&&）：legado 语义是「合并所有非空分支」——**空/Miss 分支静默跳过**（`if (!temp.isNullOrEmpty()) results.add`），
 *   非空结果按序拼接（Value 间 `\n` 连接，List 摊平，**nodes 合并成节点集**）；全空/Miss → Miss。
 *   （此前实现为「任一 Miss → 整体 Miss」——与 legado 相反；而 nodes 分支在这段什么也不贡献，
 *   于是 `tag.li&&tag.ul` 在列表用途下合并成空列表 = 目录整块消失且不报错。）
 * - `zip`（%%）：交叉合并——第 i 轮按分支顺序各取第 i 项，**驱动长度 = 首个参与分支的长度**
 *   （对面两条路径各自的首支，见 CombineOpts.usage），更长分支的尾项不产出。
 *   遇 Matches（AllInOne 2-D）→ UnsupportedRuleError（宁炸不猜）。
 * Matches 在 `first` 下透传原样；`and` 下单分支透传、多分支混合 → UnsupportedRuleError（与 `%%` 同款宁炸不猜）。
 * 节点集与字符串分支混在一起合并 → UnsupportedRuleError：对面列表路径的分支只会是 Elements、
 * 取值路径只会是 List&lt;String&gt;，混形状没有对应语义，静默丢掉一侧正是本仓定的「空结果冒充失败」。
 *
 * 设计文档：docs/design/engine.md
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

/** legado `&&`：跳过 Miss/空 List 分支，其余按序合并（全 Value → `\n` 连接单 Value；全 nodes → 节点集；混合形状 → 抛） */
function combineAnd(
  values: EngineValue[], usage: RuleUsage,
  loc?: { facet?: Facet; segmentIndex: number; segmentRaw: string },
): EngineValue {
  const kept = values.filter((v) => v.kind !== 'miss' && !(v.kind === 'list' && v.items.length === 0))
  if (kept.length === 0) return { kind: 'miss', detail: '&& 所有分支未命中' }
  // Matches（2-D）无法摊平进 1-D——单分支透传原样；多分支混合无意义。
  // 与 `%%` 同款宁炸不猜：曾用 Miss 冒充失败（同文件另一组合符的做法就是抛），
  // 「用 Miss 冒充失败」正是本仓定为最高罪的那条。
  if (kept.some((v) => v.kind === 'matches')) {
    if (kept.length === 1) return kept[0]
    throw new UnsupportedRuleError('&& 混合 AllInOne(matches) 二维结果无法合并', mergeErrCtx(usage, loc))
  }
  if (kept.some((v) => v.kind === 'nodes')) {
    if (!kept.every((v) => v.kind === 'nodes')) {
      throw new UnsupportedRuleError('&& 混合节点集与字符串结果无法合并（对面列表路径的分支只会是 Elements）', mergeErrCtx(usage, loc))
    }
    return mergeNodes(kept.map((v) => (v as { kind: 'nodes'; nodes: Cheerio<AnyNode> }).nodes))
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
  // 参与分支按用途分派（对面两份代码的差别就是行为差别）：
  //  · 取值路径 getStringList：`if (!temp.isNullOrEmpty()) results.add(temp)` → 空/Miss 不入集合，
  //    驱动长度 = results[0]（第一个非空支）。
  //  · 列表路径 getElements：`elementsList.add(el)` 无条件 → 空首支也占第一位，
  //    驱动长度 = elementsList[0].size（首支为空 ⇒ 整条为空）。
  const branches = (usage === 'list'
    ? values.map((v) => (v.kind === 'miss' ? { kind: 'list', items: [] } as EngineValue : v))
    : values.filter((v) => v.kind !== 'miss' && !(v.kind === 'list' && v.items.length === 0)))
  if (branches.length === 0) return { kind: 'miss', detail: '%% 所有分支未命中' }
  if (branches.some((v) => v.kind === 'matches')) {
    // AllInOne 2-D 结果与列表交叉取数无意义——宁炸不猜
    throw new UnsupportedRuleError('%% 交叉合并不支持 AllInOne(matches) 二维结果', mergeErrCtx(usage, loc))
  }
  if (branches.some((v) => v.kind === 'nodes')) {
    if (!branches.every((v) => v.kind === 'nodes')) {
      throw new UnsupportedRuleError('%% 混合节点集与字符串结果无法合并（对面列表路径的分支只会是 Elements）', mergeErrCtx(usage, loc))
    }
    const sets = branches.map((v) => (v as { kind: 'nodes'; nodes: Cheerio<AnyNode> }).nodes)
    const driver = sets[0]?.length ?? 0
    const out: AnyNode[] = []
    for (let i = 0; i < driver; i++) for (const s of sets) if (i < s.length) out.push(s.toArray()[i])
    // 首支为空 = 驱动 0 轮 = 整条无条目（对面 elementsList[0]），取位为空即选择失败
    if (out.length === 0) return { kind: 'miss', detail: '%% 首个分支为空，交叉取数无从驱动' }
    return mergeNodes(sets, out)
  }
  // 仅字符串分支有意义；Value 视作单元素列表
  const lists: string[][] = branches.map((v) => (v.kind === 'list' ? v.items : v.kind === 'value' ? [v.text] : []))
  const max = lists[0]?.length ?? 0
  const items: string[] = []
  for (let i = 0; i < max; i++) {
    for (const list of lists) {
      if (i < list.length) items.push(list[i])
    }
  }
  if (items.length === 0) return { kind: 'miss', detail: '%% 首个分支为空，交叉取数无从驱动' }
  return { kind: 'list', items }
}

/** 节点集合并/重建：与 reverseList 同款 `_make`（保持同一文档根，不另起 cheerio 实例） */
function mergeNodes(sets: Cheerio<AnyNode>[], nodes?: AnyNode[]): EngineValue {
  const first = sets[0]
  if (first === undefined) return { kind: 'list', items: [] }
  const all = nodes ?? sets.flatMap((s) => s.toArray())
  return { kind: 'nodes', nodes: (first as Cheerio<AnyNode>)._make(all) }
}

function mergeErrCtx(usage: RuleUsage, loc?: { facet?: Facet; segmentIndex: number; segmentRaw: string }) {
  return {
    facet: loc?.facet ?? 'rule',
    segmentIndex: loc?.segmentIndex ?? -1,
    segmentRaw: loc?.segmentRaw ?? `${usage === 'list' ? '列表' : '取值'}用途下的组合符`,
  }
}

/**
 * 反序：List → 项反序；Matches → 行反序；Value/Miss → 原样；
 * nodes → 节点集反序（用 Cheerio 自身 `_make` 重建选择集，保持同一文档根）。
 */
export function reverseList(v: EngineValue): EngineValue {
  switch (v.kind) {
    case 'list': return { kind: 'list', items: [...v.items].reverse() }
    case 'matches': return { kind: 'matches', rows: [...v.rows].reverse() }
    case 'nodes': {
      const reversed = v.nodes.toArray().reverse()
      return { kind: 'nodes', nodes: (v.nodes as Cheerio<AnyNode>)._make(reversed) }
    }
    default: return v // value / miss 原样
  }
}
