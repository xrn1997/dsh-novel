import { rawExploreEnabled } from './normalize.js'
import type { NovelSource } from './types.js'

/** 「谁参搜」的唯一判据：启用 ∧ 文本源。搜索面与发现面都必须读这一份，
 *  别让两处各写一份启停 invariant。
 *  本插件当前仅支持小说文本面（wire `SourceContentKind` 注释同口径）；将来支持其他媒介时
 *  **只在此扩参与集**，不许散落第二处判别。非文本源留库、不删、不改启用态——只是不参搜
 *  （漫画/短剧书不混进文字书架）。 */
export function participates(s: NovelSource): boolean {
  return s.enabled && s.type === 'text'
}

/** 「谁进城」：参搜 ∧ 声明了分类入口 ∧ 书源自己没把发现关掉（三条）。
 *  没有分类入口的源在书城**完全隐形**（不占位、不装死）——它照样能搜索与进书架。
 *  开关从 `normalize.rawExploreEnabled` 那道读口拿，不在谓词里再摸一次 `raw`：raw → 模型位的
 *  派生读口只那一处有（与 `contentTypeOfRaw` / `rawHeaderRule` 同族），此处读第二次就是给
 *  「缺键算开还是算关」长出第二份答案——原生方言的 raw 根本没这个键，答案错一次就藏掉一批源。 */
export function exploreParticipates(s: NovelSource): boolean {
  return participates(s) && s.rules.ruleExploreKinds.length > 0 && rawExploreEnabled(s.raw)
}
