import type { NovelSource } from './types.js'

/** 「谁参搜」的唯一判据：启用 ∧ 文本源。原先住在 ReadingService 的私有静态方法里，
 *  发现面也要用同一判据的一半——抽出来做单一主人，别让两处各写一份启停 invariant。
 *  本插件当前仅支持小说文本面（wire `SourceContentKind` 注释同口径）；将来支持其他媒介时
 *  **只在此扩参与集**，不许散落第二处判别（用户拍板 2026-09：「未来未必不支持其他类型，
 *  现在只支持小说」）。非文本源留库、不删、不改启用态——只是不参搜（漫画/短剧书不再混进文字书架）。 */
export function participates(s: NovelSource): boolean {
  return s.enabled && s.type === 'text'
}

/** 「谁进城」：在参搜的基础再加上「声明了分类入口」。
 *  没有 ruleFind 的源在书城**完全隐形**（不占位、不装死）——它照样能搜索与进书架。 */
export function exploreParticipates(s: NovelSource): boolean {
  return participates(s) && s.rules.ruleExploreKinds.length > 0
}
