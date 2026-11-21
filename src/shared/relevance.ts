import type { Relevance, SearchHit } from './wire.js'

/**
 * 相关性判据：一条命中与本轮关键词的关系。唯一实现，搜索结果页、详情浮层跨源搜索与 AI 工具面各调一次——
 * 两半各写一份，「相关」就会分叉。家必须在 `shared/`：浏览器半够不到 `services/**`，wire 只声明形状。
 *
 * 判据即忽略大小写的 contains，本仓只在其上分三档；对照读数与两条偏离住矩阵行 `d-search-relevance`，不复述。
 */

/** 参与比较的装饰字符：空白、书名号类成对括号、中英标点；写宽会把少字形态判成不等。 */
const DECORATION = /[\s《》〈〉「」『』【】[\]()（）｛｝·、,，.。:：;；!！?？\-—–_~*'"“”‘’/\\|+]/g

/** 三档的序读数：排序面读这一份，别处不许再写第二份 */
export const RELEVANCE_RANK = { exact: 0, contains: 1, suspect: 2 } as const satisfies Record<Relevance, number>

/** 档名按档序列出——归并面要把「这一本里最好的那一档」反查回档名，靠键插入序不赌 */
export const RANKED = ['exact', 'contains', 'suspect'] as const satisfies readonly Relevance[]

export function normalizeRelevance(x: string | null): string {
  return (x ?? '').normalize('NFKC').toLowerCase().replace(DECORATION, '')
}

/** 只判三件字段：其余命中字段与相关性无关 */
export type RelevanceInput = { title: string; author: string | null; kind: string | null }

export function relevanceOf(keyword: string, item: RelevanceInput): Relevance {
  const k = normalizeRelevance(keyword)
  if (k === '') return 'contains'
  const title = normalizeRelevance(item.title)
  const author = normalizeRelevance(item.author)
  if (title === k || author === k) return 'exact'
  if (title.includes(k) || author.includes(k) || normalizeRelevance(item.kind).includes(k)) return 'contains'
  // 「书名 作者」这类复合关键词：整串永远不是站点书名的子串，不放行就会把真结果判死
  const tokens = keyword.trim().split(/\s+/).map(normalizeRelevance).filter((tk) => tk !== '' && tk !== k)
  if (tokens.some((tk) => title.includes(tk))) return 'contains'
  return 'suspect'
}

export type MarkedHit = { hit: SearchHit; relevance: Relevance }
/** kept 档的窄面：suspect 不进归并（裁决见 `ADR-0033`），归并面的档位字段随它收窄到两档 */
export type KeptHit = MarkedHit & { relevance: 'exact' | 'contains' }
export interface RelevancePartition { kept: KeptHit[]; suspect: MarkedHit[] }

/** 一趟命中分成默认视野与折叠区：suspect 只换位置不删；空关键词＝没有这一维——
 *  空串是任何串的子串，参与比较会把整轮判成全命中（折叠而非丢弃的裁决住 `ADR-0032`）。 */
export function partitionByRelevance(keyword: string, hits: readonly SearchHit[]): RelevancePartition {
  const marked = hits.map((h) => ({ hit: h, relevance: relevanceOf(keyword, h) }))
  const kept = marked.filter((m): m is KeptHit => m.relevance !== 'suspect')
  const suspect = marked.filter((m) => m.relevance === 'suspect')
  return { kept: kept.sort((a, b) => RELEVANCE_RANK[a.relevance] - RELEVANCE_RANK[b.relevance]), suspect }
}
