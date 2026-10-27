import type { ExploreSources } from '../shared/wire.js'

/**
 * 书城进入的**纯判据**：从「可选源清单 / 记住的源与分类 / 挂载恢复读是否已定 / 自动那条路是否已经
 * 走过 / 服务端此刻那一轮」算出唯一动作。本模块不持 React 状态、零 DOM（客户端逻辑层测试口径），
 * 视图只负责把判据落成 state 与提交。
 *
 * 为什么要有它：「进入即加载」的先后关系必须由一张纯判据表回答。若把「是否已问过」「恢复读是否已定」
 * 与源/分类回落分散在视图 ref、观察 hook 与 effect 三处跨两层实施，先后只能靠竞态用例钉。
 * 收成判据表后，每条分支递一个最小对象就能钉住，视图不再解释先后，回落也只剩一份算式。
 *
 * `submitted` **不在入参里**：它是 `useExploreJob` 内部的「提交回包已到、挂载恢复读此后让位」闸，
 * 与「自动那条路该不该提交」是两件事——把它拉进纯判据会让同一层语义在两个家各持半份。
 *
 * 手点路径也**不进判据的动作计算**：`CityView` 的 `pick` 不等恢复读、恒提交（切源/切类必须马上有反应）。
 * 但它与自动那条路共用 `asked` 闸：手点置位后自动那条路不再动作，免得用户在恢复读落地前手选一次、
 * 自动路径又追加一次提交。判据只回答自动那条路该不该动；把「手点恒 submit」折进来会让本模块多一枚
 * 只有视图知道怎么填的入参。
 */

/** 上次逛的源与分类（`cityStore` 的形状）；`null` = 还没选过，由回落算式落第一项 */
export interface RememberedSelection {
  sourceId: string | null
  kind: string | null
}

/** 落位的源+分类对：唯一写口是 `city-selection.ts` 的 `select`（本挂载投影与 `cityStore` 一起写） */
export interface CitySelection {
  sourceId: string
  kind: string
}

/**
 * 源/分类回落算式：记住的源还在清单里就用它，否则第一项；记住的分类被这个源声明就用它，否则这个源的
 * 第一个分类。**被选中的源声明零分类时返回 null**——没有可逛的分类，不跳过它去借别的源的分类
 * （分类归属由源自己声明，借一个就是造事实）；视图据此不落选中态、也不提交。
 * 名字刻意不用 remembered 开头：入参里的 remembered 只是判据之一，产出的是「该落到哪一对」，
 * 与 `city-selection.ts` 读 store 的 `rememberedCitySelection` 不是一回事。
 */
export function resolveCitySelection(
  sources: ExploreSources['sources'] | null,
  remembered: RememberedSelection,
): CitySelection | null {
  if (sources === null || sources.length === 0) return null
  const source = sources.find((s) => s.id === remembered.sourceId) ?? sources[0]
  if (source.kinds.length === 0) return null
  const kind = remembered.kind !== null && source.kinds.includes(remembered.kind)
    ? remembered.kind
    : source.kinds[0]
  return { sourceId: source.id, kind }
}

/** 判据的输入：视图现场的两枚闸（`restored` / `asked`）与两枚事实（源清单 / 服务端那一轮）。
 *  `asked` 由**任一入口**置位（自动那条路提交/follow 过，或用户手点过）——它管的是
 *  「自动那条路最多动作一次」，不是「自动那条路单独走过」。
 *  `round` 只要身份那两格——`bookListEmpty` 等呈现判据与本模块无关，收全 `ExploreRound` 会把
 *  没人读的字段算进契约面。 */
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
 * 自动那条路的一步决策，按顺序：
 * ① 源清单未到 → `wait`——此刻说「没有」是编的；
 * ② 清单里没有可落的源+分类（空清单 / 被选中的源零分类）→ `none`；
 * ③ 挂载恢复读未定 → `none`——那时 `round` 恒为 null 是「还没问过」，抢跑会杀掉服务端正持有的
 *    那一轮（书单空闪一帧再从头抓）；
 * ④ 已经由任一入口起过一轮（`asked`）→ `none`——手点之后自动那条路不再追加提交。
 * 其余给出选中的源+分类：服务端此刻那一轮正是这一对 → `follow`（回来看它跑完，重提会杀掉它），
 * 否则 `submit`。
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
