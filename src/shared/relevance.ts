import type { Relevance, SearchHit } from './wire.js'

/**
 * 相关性判据：一条命中与本轮关键词的关系。唯一实现，三个消费点各调一次（搜索结果页、
 * 书籍详情浮层那次跨源搜索、AI 工具面 `dshnovel_search`）——判据若在两半各写一份，
 * 用户看到的「相关」与模型看到的「相关」就会分叉（同 `participation.participates` 的手法：
 * 一条谓词，多个 adapter 消费）。
 *
 * 家必须在 `src/shared/`：浏览器半现下只 import `shared/wire.js`，`services/**` 不在它的可达面里，
 * 而这份判据 Node 半与浏览器半都要用。`wire.ts` 只声明形状，算法住这里，wire 的零运行时依赖不破。
 *
 * 判据不是本仓发明的新语义：忽略大小写的 contains 是通用形状，本仓只在此之上分三档。
 * 对面同源语义的读数、本仓两条偏离及其理由都住矩阵行 `d-search-relevance` 的 note（那一行是唯一主人），这里不复述。
 */

/** 参与比较的全部「装饰」字符：空白、成对的书名号类括号、中英标点。写宽一档（含全部非字母数字）
 *  会把「冰魔女契约」这种少字形态判成不等——那是另一条放行链，此处不预设。 */
const DECORATION = /[\s《》〈〉「」『』【】\[\]()（）｛｝·、,，.。:：;；!！?？\-—–_~*'"“”‘’/\\|+]/g

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
/** kept 档的窄面：suspect 不进归并（裁决见 `docs/adr/0033`），归并面的档位字段随它收窄到两档 */
export type KeptHit = MarkedHit & { relevance: 'exact' | 'contains' }
export interface RelevancePartition { kept: KeptHit[]; suspect: MarkedHit[] }

/** 一趟命中分成「默认视野」与「折叠区」：`suspect` 只换位置不删；空关键词＝没有这一维（全归 kept）——
 *  空串是任何串的子串，让空串参与比较会把整轮悄悄判成「全命中」。
 *  「为什么折叠而不丢弃」的裁决只住 `docs/adr/0032`，这里不复述。 */
export function partitionByRelevance(keyword: string, hits: readonly SearchHit[]): RelevancePartition {
  const marked = hits.map((h) => ({ hit: h, relevance: relevanceOf(keyword, h) }))
  const kept = marked.filter((m): m is KeptHit => m.relevance !== 'suspect')
  const suspect = marked.filter((m) => m.relevance === 'suspect')
  return { kept: kept.sort((a, b) => RELEVANCE_RANK[a.relevance] - RELEVANCE_RANK[b.relevance]), suspect }
}
