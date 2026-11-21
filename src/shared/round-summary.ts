import { partitionByRelevance } from './relevance.js'
import type { RelevancePartition } from './relevance.js'
import type { SearchGroup } from './wire.js'

/**
 * 一轮搜索的轮级分区与读数：每源组只跑一次相关性判据，搜索结果页、工具面与归并面读同一份。
 * 名字就是口径：`answered` 数答了话的组（缺 `error`，零条也算）；`hits` / `kept` / `suspect` 只汇总答话组。
 * 失败组留在 `parts` 里供逐源轴点名，归并面自己跳过。
 */

/** 一组命中与它的分区：归并面与收口读数共用同一份，不再各跑一次判据。 */
export interface RoundPartition { group: SearchGroup; part: RelevancePartition }

/** 一轮的原始计数（口径同模块头）：answered / hits / kept / suspect。 */
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
