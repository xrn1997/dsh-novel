import { partitionByRelevance } from './relevance.js'
import type { RelevancePartition } from './relevance.js'
import type { SearchGroup } from './wire.js'

/**
 * 一轮搜索的轮级分区与读数：每源组只跑一次相关性判据，收口面与归并面读同一份结果。
 * 为什么单立一个 module：三个消费点（搜索结果页、工具面、归并面）必须共用同一份分区；
 * 各跑一趟分区、客户端再自己数一遍收口数字，「哪份分区喂给谁」就会变成三处维护点。
 * 名字就是口径：`answered` 数答了话的组（缺 `error`，零条也算），`hits` / `kept` / `suspect`
 * 只汇总答话组；失败组留在 `parts` 里——逐源轴要逐家点名，归并面自己跳过（它给的不是书目）。
 */

/** 一组命中与它的分区：归并面与收口读数共用同一份，不再各跑一次判据。 */
export interface RoundPartition { group: SearchGroup; part: RelevancePartition }

/** 一轮的原始计数。**名字就是口径**：answered = 答了话（error 缺席，零条也算），
 *  kept/suspect = 默认视野与折叠区，hits = 答话组的命中行数。 */
export interface RoundCounts {
  searched: number
  answered: number
  failed: number
  hits: number
  kept: number
  suspect: number
}

export interface RoundSummary { parts: RoundPartition[]; counts: RoundCounts }

/** 一轮搜索的轮级派生：每源只分区一次；失败组留在 parts 里（归并面跳过），计数只算答话组。 */
export function summarizeRound(keyword: string, groups: readonly SearchGroup[]): RoundSummary {
  const parts = groups.map((group) => ({ group, part: partitionByRelevance(keyword, group.hits) }))
  let answered = 0
  let failed = 0
  let hits = 0
  let kept = 0
  let suspect = 0
  for (const { group, part } of parts) {
    if (group.error !== undefined) { failed += 1; continue }
    answered += 1
    hits += group.hits.length
    kept += part.kept.length
    suspect += part.suspect.length
  }
  return { parts, counts: { searched: groups.length, answered, failed, hits, kept, suspect } }
}
