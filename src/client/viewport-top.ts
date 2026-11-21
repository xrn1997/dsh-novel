/**
 * 视口顶那一侧判据的唯一主人：遮挡怎么进读数（`clampTopInset`），读数怎么落项（`crossedIndex`）。
 * 阅读侧三条数据路（进度锚点 / 正文节点矩形 / `[data-pidx]` 块矩形）载体不同，**判据只此一份**：
 * 取最后一条已越过视口顶的起点；一条都没越过 → 文档序第一个非空项；没有非空项 → -1。
 * 边界是 `<=`（起点正好压在视口顶也算已越过）。
 *
 * 为什么收在一处：`<=` / `<`、无命中回落、跳过空洞这三条口径各写一遍时，漂移一次就是「落盘位置动了
 * 而跟读高亮不动」这类没有第二个读数的缺陷。视口顶读数先过 `clampTopInset`（`ADR-0089`）。
 */

/** 顶条遮挡的非负夹取：遮挡读数的家是 `ReaderView` 的 `topInset`（每次现量）；进判据线前统一过这里，
 *  缺席 = 0。消费点不许再各自夹一遍（`ADR-0089`）。 */
export function clampTopInset(inset: number | undefined): number {
  return Math.max(0, inset ?? 0)
}

/**
 * 当前项下标（`-1` = 表里没有可判的项）。
 *
 * `items` 起点按文档序排列；洞（`null` / `undefined`）跳过——跳章打开时 `chapterRefs` 从空数组逐章
 * 补格，缺席下标表示「该章还没渲染」，不参与比较也不当回落项。`topOf` 给该项起点相对**视口顶**的
 * 偏移（已越过 ≤ 0），每项只被问一次。
 *
 * 不提前退出：取「最后一条已越过」而不是「取最大起点」——测试桩几何里可出现「前面的项在视口下方、
 * 后面的项已越过」，按文档序取更可预期；候选数被已载窗口钉死，全扫代价可忽略。
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
