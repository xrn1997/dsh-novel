import { RANKED, RELEVANCE_RANK, normalizeRelevance } from './relevance.js'
import { summarizeRound } from './round-summary.js'
import type { RoundPartition } from './round-summary.js'
import { SEARCH_BOOKS_CAP } from './wire.js'
import type { MergedBook, MergedSource, SearchGroup } from './wire.js'

/**
 * 按书归并：把一轮逐源命中收成「一本书一行、它的多源在下面」。唯一实现，两个消费点
 * （搜索结果页、AI 工具面）都经 `mergePartitioned` 吃同一份——与 `participation.participates` 同构。
 * 书籍详情浮层**刻意不吃**归并（它只谈一本，而它那三条逐源读数会被归并吞掉），只吃相关性。
 * 分区由 `shared/round-summary.ts` 单点给：本面只消费 `RoundPartition` 的 `kept`，不自己跑判据。
 *
 * 归并键取 `(规范化书名, 规范化作者)`，对面那把键的读数住矩阵行 `d-merge-dedup`（唯一主人），这里不复述；
 * 规范化只认 `shared/relevance.ts` 的 `normalizeRelevance` 那一份，不在这里长第二份。
 * 假合并与漏并是这把键的固有代价，
 * 它们只住在呈现层（展开后每条命中的地址与动作都在原处），裁决见 `ADR-0033`。
 *
 * 刻意不做的一件事：不替用户选「用哪家读」。本仓没有能判源好坏的读数（探针 verified 只证搜索面），
 * 「读这本」只活在展开后的逐源行里。
 *
 * 行与家是两条读数，绝不折叠：`sources` 留每一行（一家给两种写法就两行都在册，「这一家把它叫作什么」），
 * 家数按**去重后的源**计——那一栏要回答的是「几家答话了」，不是「几行在册」：按行数算会让一家撞两条
 * 的 sloppy 源压过两家真答话的源，而同档那一子句读的就是它。（归并键与序的对面口径唯一读数住矩阵行
 * `d-merge-dedup`；本仓在序的第二子句按去重家数计，这一处偏离与对面是否同样去重都只在那一行登记，裁决见 `ADR-0033`。）
 * 跳过哪一组的闸也只判本轮失败（`error`），不判源的探针状态：新导入的源恒 `unverified`
 * （`importOne` 不探针），按状态筛等于把几乎整轮清空而测试全绿。
 */
export interface MergedRound { books: MergedBook[]; total: number }

/** 从轮级分区归并出书目：只收 `kept`（suspect 焊进同键就是成堆假书）；失败组由调用方留在
 *  parts 里给逐源轴点名，本面跳过——它给的不是书目。 */
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
        // 取最好的一档。今天同键的 kept 恒同档——只有分类能让某一行抬档，而它抬不到整串命中那一档，
        // 所以这句当下拿不到跨档的输入；哪天 relevanceOf 长出按源或按分类的档位，这句就开始决定序。
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

/** 一轮 → 归并：测试与审计脚本的 convenience；生产两半先 summarizeRound 再 mergePartitioned，
 *  这样同一轮只分区一次。 */
export function mergeBooks(keyword: string, groups: readonly SearchGroup[], cap: number = SEARCH_BOOKS_CAP): MergedRound {
  return mergePartitioned(summarizeRound(keyword, groups).parts, cap)
}
