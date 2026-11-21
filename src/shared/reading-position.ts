import type { ShelfProgress } from './wire.js'

/** 阅读位置的跨半谓词：只吃书架进度，不持状态、零运行时依赖。住这里而非 wire：wire 只住值形状且 inline 进 client bundle。 */

/** 读过没有的判定：章 > 0 或章内比例 > 0（第 0 章里的位置同样是进度）。
 *  存档恢复与书架卡片共用这一份；两处各写一份且相反，同一条存档就会自相矛盾。 */
export function hasProgress(p: ShelfProgress): boolean {
  return p.chapterIndex > 0 || p.offsetRatio > 0
}
