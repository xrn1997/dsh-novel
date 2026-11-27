/**
 * 视口顶那一侧判据的唯一主人：遮挡怎么进读数（`clampTopInset`），读数怎么落项（`crossedIndex`）。
 * 阅读侧三条数据路（进度锚点 / 正文节点矩形 / `[data-pidx]` 块矩形）载体不同，**判据只此一份**：
 * 按文档序找最后一条起点已越过判据线的项。最后一条已越过项仍压线/跨线（块尾 `>= 0`）→ 归它；
 * 最后一条已越过项已整条离线而更早的覆盖项还在 → 线在覆盖项内部（下一子项完整落在覆盖项跨度内）
 * 就归下一子项，否则归覆盖项；没有任何覆盖项 → 所有已越过项都整条离线，其后有未越过的项就归下一项
 * （空档），没有就留在最后一条已越过项。一条都没越过 → 文档序第一个非空项；没有非空项 → -1。
 * 边界成对：起点 `<=`（正好压线算已越过），块尾 `< 0` 才算整条离线——块尾正压线仍是这块占着线；
 * 块尾非有限（NaN / ±Infinity）没有「整条离线」的可证读数，按占线处理（有覆盖项仍走覆盖分支）。
 * 嵌套项（父段尾部可见、段内图已离线）与并排单元格（左格高段跨线、右格短段已离线）不许被更晚的
 * 非覆盖项顶成空档；完整落在覆盖项跨度内的子块缝仍归下一子项。所有已越过项都整条离线、其后又有
 * 起点在下的项时，判据线落在**空档**（块与块之间的无内容带：章间 margin、段间 margin，线上没有这
 * 一项的任何像素）——空档归下一项：阅读位置只认「顶条下方第一条可见内容」，把空档判给上一块，落位
 * 就会读回「上一章 @1」并被下一帧诚实读数打回（`ADR-0106`）。
 *
 * 为什么收在一处：`<=` / `<`、空档归属、无命中回落、跳过空洞这几条口径各写一遍时，漂移一次就是
 * 「落盘位置动了而跟读高亮不动」这类没有第二个读数的缺陷。视口顶读数先过 `clampTopInset`（`ADR-0089`）。
 */

/** 顶条遮挡的非负夹取：遮挡读数有两处家——`ReaderView` 的 `topInset`（阅读器顶条，每次现量）与
 *  `mini-bar-state` 的窗控带读数（宿主 chrome，随窗口读数取）；进判据线前统一过这里，
 *  缺席 = 0。消费点不许再各自夹一遍（`ADR-0089`）。 */
export function clampTopInset(inset: number | undefined): number {
  return Math.max(0, inset ?? 0)
}

/** 一项相对判据线的区间（起点 / 块尾，都是「相对视口顶」的偏移）：已越过 = `start <= 0`，
 *  整条离线 = `end < 0`；`end >= 0`（压线或跨线）算覆盖线。零高项（没量到高度的块）压线时占线、
 *  离线时让位——与判据天然一致。 */
export interface ItemSpan { start: number; end: number }

/** 把同一坐标系里的区间 `[top, bottom]` 换算成相对判据线 `line` 的 `ItemSpan`：三条数据路的适配
 *  都从这里过，别在调用点各减一遍（`top` / `bottom` / `line` 必须同一坐标系：内容坐标或视口坐标）。 */
export function spanRelativeTo(top: number, bottom: number, line: number): ItemSpan {
  return { start: top - line, end: bottom - line }
}

/**
 * 当前项下标（`-1` = 表里没有可判的项）。
 *
 * `items` 按文档序排列；洞（`null` / `undefined`）跳过——跳章打开时 `chapterRefs` 从空数组逐章
 * 补格，缺席下标表示「该章还没渲染」，不参与比较也不当回落项。`spanOf` 给该项 [起点, 块尾] 相对
 * **判据线**的偏移（头注里的空档判据吃块尾），每项只被问一次。
 *
 * 不提前退出：取「最后一条已越过」而不是「取最大起点」——测试桩几何里可出现「前面的项在视口下方、
 * 后面的项已越过」，按文档序取更可预期；候选数被已载窗口钉死，全扫代价可忽略。
 */
export function crossedIndex<T>(
  items: readonly (T | null | undefined)[], spanOf: (item: T) => ItemSpan,
): number {
  let best = -1
  let crossedEnd = Number.NaN
  let nextAhead = -1
  let nextAheadStart = Number.NaN
  let nextAheadEnd = Number.NaN
  let covering = -1
  let coveringEnd = Number.NaN
  let first = -1
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]
    if (item === null || item === undefined) continue
    if (first === -1) first = index
    const span = spanOf(item)
    // 非有限起点（NaN / ±Infinity）不参与越过与空档判断；回落骨架仍按非空项返回
    if (!Number.isFinite(span.start)) continue
    if (span.start <= 0) {
      best = index
      crossedEnd = span.end
      nextAhead = -1
      if (Number.isFinite(span.end) && span.end >= 0) {
        covering = index
        coveringEnd = span.end
      }
    } else if (best !== -1 && nextAhead === -1) {
      nextAhead = index
      nextAheadStart = span.start
      nextAheadEnd = span.end
    }
  }
  if (best === -1) return first
  // 最后一条已越过项仍压线/跨线：线被它占着，直接作数（读到块底不许跳项）
  if (Number.isFinite(crossedEnd) && crossedEnd >= 0) return best
  if (covering !== -1) {
    // 更早的已越过项仍覆盖线：下一项完整落在它跨度内部 = 覆盖项内部的子块缝，归下一子项；
    // 否则下一项已超出覆盖项块尾 = 线在覆盖项自己的尾巴上，归覆盖项（嵌套图 / 并排单元格不造假空档）
    if (nextAhead !== -1 && nextAheadStart < coveringEnd && nextAheadEnd <= coveringEnd) return nextAhead
    return covering
  }
  // 块尾非有限（NaN / ±Infinity）没有「整条离线」的可证读数：按占线处理，不凭空翻到下一项
  return Number.isFinite(crossedEnd) && crossedEnd < 0 && nextAhead !== -1 ? nextAhead : best
}
