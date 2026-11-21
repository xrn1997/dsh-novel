import { RANKED, RELEVANCE_RANK, normalizeRelevance } from './relevance.js'
import { summarizeRound } from './round-summary.js'
import type { RoundPartition } from './round-summary.js'
import { SEARCH_BOOKS_CAP } from './wire.js'
import type { MergedBook, MergedSource, SearchGroup } from './wire.js'

/**
 * 按书归并：一轮逐源命中收成「一本书一行、多源在下面」。唯一实现，搜索结果页与 AI 工具面共用；
 * 书籍详情浮层刻意不吃（只谈一本，逐源读数会被吞掉），只吃相关性。分区由 `shared/round-summary.ts` 单点给。
 *
 * 归并键取 `(规范化书名, 规范化作者)`，规范化只认 `shared/relevance.ts` 的 `normalizeRelevance`；
 * 对照读数与假合并/漏并的代价住矩阵行 `d-merge-dedup` 与 `ADR-0033`，这里不复述。
 *
 * 行与家是两条读数：`sources` 留每一行，家数按去重后的源计——按行数算会让一家撞两条的源压过两家真答话。
 * 跳过哪一组的闸只判本轮失败（`error`），不判探针状态：新导入源恒 `unverified`，按状态筛会把整轮清空。
 * 刻意不替用户选「用哪家读」：探针 verified 只证搜索面，本仓没有能判源好坏的读数。
 */
export interface MergedRound { books: MergedBook[]; total: number }

/** 只收 `kept`（suspect 进同键就是假书）；失败组不是书目，由逐源轴点名。 */
export function mergePartitioned(parts: readonly RoundPartition[], cap: number = SEARCH_BOOKS_CAP): MergedRound {
  const by = new Map<string, { title: string; author: string | null; rank: 0 | 1; arrival: number; sources: MergedSource[]; sourceIds: Set<string> }>()
  let arrival = 0
  for (const { group, part } of parts) {
    if (group.error !== undefined) continue // 失败源不进视图：它给的不是书目
    for (const m of part.kept) { // 只 kept 参与：suspect 焊进同键就是成堆假书
      const t = normalizeRelevance(m.hit.title)
      const a = normalizeRelevance(m.hit.author)
      const key = `${t}\u0001${a}`   // 键的两项各归一；分隔符是不可见控制符，不让拼接长出第二套可撞的写法
      const row: MergedSource = { sourceId: group.sourceId, sourceName: group.sourceName, title: m.hit.title, author: m.hit.author, url: m.hit.url }
      const slot = by.get(key)
      // 书行那两个名字取首个到达源的原样：后面的源只添自己的那一行，不改写它
      if (slot === undefined) by.set(key, { title: m.hit.title, author: m.hit.author, rank: RELEVANCE_RANK[m.relevance], arrival: arrival++, sources: [row], sourceIds: new Set([group.sourceId]) })
      else {
        // 同键 kept 恒同档，这句当下拿不到跨档输入；哪天档位按源/分类细分，它才开始决定序。
        const r = RELEVANCE_RANK[m.relevance]
        if (r < slot.rank) slot.rank = r
        slot.sources.push(row)
        slot.sourceIds.add(group.sourceId)
      }
    }
  }
  const all = [...by.values()]
  all.sort((x, y) => x.rank - y.rank || y.sourceIds.size - x.sourceIds.size || x.arrival - y.arrival)
  return {
    total: all.length,
    books: all.slice(0, cap).map((b) => ({
      title: b.title, author: b.author, relevance: RANKED[b.rank],
      sources: b.sources, sourceCount: b.sourceIds.size,
    })),
  }
}

/** 测试/审计脚本的 convenience：生产两半先 summarizeRound 再 mergePartitioned，保证只分区一次。 */
export function mergeBooks(keyword: string, groups: readonly SearchGroup[], cap: number = SEARCH_BOOKS_CAP): MergedRound {
  return mergePartitioned(summarizeRound(keyword, groups).parts, cap)
}
