/**
 * 视口顶那一侧判据的唯一主人：遮挡怎么进读数（`clampTopInset`），读数怎么落项（`crossedIndex`）。
 *
 * 阅读侧有三条**数据路**都在回答「视口顶落在哪一项上」，载体却不同：进度锚点（绝对内容坐标，
 * 刻意不做每帧 rect 读取）、正文节点（实时节点矩形）、[data-pidx] 块矩形（听书起播位置）。数据路
 * 保持各自的样子（性能决定），**判据只此一份**：取最后一条已越过视口顶的起点，一条都没越过
 * → 文档序第一个非空项，没有任何非空项 → -1。边界是 `<=`：起点正好压在视口顶也算已越过。
 * 「视口顶」这个读数自己先过 `clampTopInset` 定形：裸端口顶加**非负夹取后的顶条遮挡**——
 * 三条路与存/取/落位吃同一个遮挡口径（裁决见 `ADR-0089`）。
 *
 * 为什么要收在一处：`<=` / `<`、无命中回落、跳过空洞（跳章打开时的缺席下标）这三条边界口径
 * 各写一遍时，漂移一次就是「落盘位置动了而跟读高亮不动」这类没有第二个读数的缺陷；遮挡夹取
 * 抄第二份，坏读数进来那一刻三条路分叉——探针起播位置与落盘读数不再同一口径。
 */

/**
 * 顶条遮挡的非负夹取：遮挡读数的家在 `ReaderView` 的 `topInset`（sticky 顶条的实测高，每次
 * 现量），进判据线前统一过这里；缺席（无顶条 / 测试）= 0。消费点（会话位置读数、绑定探针、
 * 几何当前节点）不许再各自夹一遍（`ADR-0089`）。
 */
export function clampTopInset(inset: number | undefined): number {
  return Math.max(0, inset ?? 0)
}

/**
 * 当前项下标（`-1` = 表里没有可判的项）。
 *
 * @param items   起点按文档序排列（调用方的数据路负责：章块顺序 / 节点文档序 / 段序）。
 *                洞（`null` / `undefined`）跳过——跳章打开时 `chapterRefs` 从空数组逐章补格，
 *                缺席下标就是 `undefined`，它表示「该章还没渲染」，不参与比较也不当回落项。
 * @param topOf   该项起点相对**视口顶**的偏移（已越过 ≤ 0）；每项只被问一次。
 *
 * 不提前退出：**取「最后一条已越过」而不是「取最大起点」**——真排版里起点随文档序单调，
 * 两者等价；但测试用桩几何（视口没真滚、只换节点读数）时可以出现「前面的项在视口下方、
 * 后面的项已越过」，这时按文档序取最后一条越过的是更可预期的口径（旧实现各写一遍，正是
 * 这种分歧的来源）。候选数被已载窗口钉死，全扫的代价可以忽略。
 */
export function crossedIndex<T>(
  items: readonly (T | null | undefined)[], topOf: (item: T) => number,
): number {
  let best = -1
  let first = -1
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]
    if (item === null || item === undefined) continue
    if (first === -1) first = index
    if (topOf(item) <= 0) best = index
  }
  return best === -1 ? first : best
}
