/**
 * 任务卡的 UI 现场注册表：常驻状态层点任务泳道是跨子树动作（overlay 与小说视图不在同一分支），
 * 意图消费方 `SettingsSection` 得等卡片真正挂载之后才能把它带进视野。不要用
 * `data-novel-run-card` 属性选择器加延时重试来跨子树查找：选择器是无类型接口，卡片在不在一棵
 * 渲染树上只有渲染树自己知道，消费半无从断言。
 *
 * 这里只装**现场**：`RunCard` 挂载即登记、卸载即清空，消费方只拿到「去现场」一个动作。
 * 不承载业务真相（不读任务）；该种类没有卡片登记时动作是空操作，与「卡片不在场」同义。
 *
 * 现场按**任务种类**分桶，因为两张运行卡可以同时在树上：导入卡可能来自最近导入回执缓存
 * （`getLastImportJob`），验证卡来自当前 running 任务，而任务进行中导入弹层仍可打开。不分类
 * 登记就是「最后登记的那张拥有现场」，一次「看验证卡」的意图会滚到导入卡上。同一桶内仍是
 * 后登记者拥有现场（同一时刻只有一张同类卡在树上）——那属于渲染侧的取舍，不是本模块的判据。
 */
export type RunCardKind = 'import' | 'probe'

const cards = new Map<RunCardKind, HTMLElement>()

/** `RunCard` 根节点的 ref 回调：挂载登记、卸载清空——只动自己那一种。 */
export function setRunCard(kind: RunCardKind, next: HTMLElement | null): void {
  if (next === null) cards.delete(kind)
  else cards.set(kind, next)
}

/** 把指定种类的运行卡带进视野；该种类不在场时返回 false（调用方可等下一拍再试一次）。 */
export function focusRunCard(kind: RunCardKind): boolean {
  const card = cards.get(kind)
  if (card === undefined) return false
  card.scrollIntoView({ block: 'center' })
  return true
}
