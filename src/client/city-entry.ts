import type { ExploreSources } from '../shared/wire.js'

/**
 * 书城进入的**纯判据**：从「可选源 / 记住的源与分类 / 恢复读是否已定 / 自动那条路是否走过 / 服务端
 * 此刻那一轮」算出唯一动作。本模块不持 React 状态、零 DOM，视图只负责把判据落成 state 与提交。
 *
 * 为什么要有它：「进入即加载」的先后关系必须由一张纯判据表回答；分散在视图 ref 与 effect 三处，
 * 先后只能靠竞态用例钉。`submitted` **不在入参里**（它是 `useExploreJob` 内部的让位闸，两件事）。
 * 手点路径**不进判据的动作计算**（恒提交），但它与自动那条路共用 `asked` 闸。
 */

/** 上次逛的源与分类（`cityStore` 的形状）；`null` = 还没选过，由回落算式落第一项 */
export interface RememberedSelection {
  sourceId: string | null
  kind: string | null
}

/** 落位的源+分类对：唯一写口是 `city-selection.ts` 的 `select`（只写 `cityStore`；本挂载投影是它的读面） */
export interface CitySelection {
  sourceId: string
  kind: string
}

/**
 * 源/分类回落算式：记住的源还在清单里就用它，否则第一项；记住的分类被这个源声明就用它，否则这个源的
 * 第一个分类。**被选中的源声明零分类时返回 null**——不跳过它去借别的源的分类（那是造事实）。
 * 产出的是「该落到哪一对」，与读 store 的 `rememberedCitySelection` 不是一回事。
 */
export function resolveCitySelection(
  sources: ExploreSources['sources'] | null,
  remembered: RememberedSelection,
): CitySelection | null {
  if (sources === null) return null
  const [first] = sources
  if (first === undefined) return null          // 清单为空：没有可落的源，回落也无对象可指
  const source = sources.find((s) => s.id === remembered.sourceId) ?? first
  const [firstKind] = source.kinds
  if (firstKind === undefined) return null      // 零分类：口径见本函数头注（不借别的源的分类）
  const kind = remembered.kind !== null && source.kinds.includes(remembered.kind)
    ? remembered.kind
    : firstKind
  return { sourceId: source.id, kind }
}

/** 判据的输入：视图现场的两枚闸（`restored` / `asked`）与两枚事实。`asked` 由**任一入口**置位，
 *  管的是「自动那条路最多动作一次」。`round` 只要身份那两格——呈现判据与本模块无关。 */
export interface CityEntryInput {
  sources: ExploreSources['sources'] | null
  remembered: RememberedSelection
  restored: boolean
  asked: boolean
  round: { sourceId: string; kind: string } | null
}

/** 判据的输出：`wait` / `none` 都不动现场；`select` 落选中的源+分类，动作只决定要不要提交 */
export type CityEntryDecision =
  | { type: 'wait' }
  | { type: 'none' }
  | { type: 'select'; sourceId: string; kind: string; action: 'submit' | 'follow' }

/**
 * 自动那条路的一步决策：① 源清单未到 → `wait`（此刻说「没有」是编的）；② 没有可落的源+分类 → `none`；
 * ③ 恢复读未定 → `none`（抢跑会杀掉服务端正持有的那一轮，书单空闪一帧）；④ `asked` → `none`。
 * 其余给出选中的源+分类：服务端那一轮正是这一对 → `follow`（回来看它跑完，重提会杀掉它），否则 `submit`。
 */
export function decideCityEntry(input: CityEntryInput): CityEntryDecision {
  if (input.sources === null) return { type: 'wait' }
  const selection = resolveCitySelection(input.sources, input.remembered)
  if (selection === null || !input.restored || input.asked) return { type: 'none' }
  const follows = input.round !== null
    && input.round.sourceId === selection.sourceId
    && input.round.kind === selection.kind
  return { type: 'select', ...selection, action: follows ? 'follow' : 'submit' }
}
