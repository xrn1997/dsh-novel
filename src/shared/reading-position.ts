import type { ShelfProgress } from './wire.js'

/**
 * 阅读位置的跨半谓词：只吃书架上那条进度，不持状态、零运行时依赖（type-only 引 wire 的形状）。
 * 放这里而不是 `shared/wire.ts`：wire 只住值形状与路由/body 契约，且被 inline 进 client bundle，
 * 不得长出运行时谓词；两个消费方（阅读器的存档恢复、书架卡片的在读/未读筛选）都是客户端。
 */

/** 「这本书读过没有」——存档恢复与书架卡片（在读/未读筛选、进度行）共用这一份判定。
 *  口径是「章 > 0 **或** 章内比例 > 0」：第 0 章里的位置同样是进度。两处各写一份且相反时，
 *  同一条存档会「在读」与「没读过」互相矛盾——单点在此。 */
export function hasProgress(p: ShelfProgress): boolean {
  return p.chapterIndex > 0 || p.offsetRatio > 0
}
