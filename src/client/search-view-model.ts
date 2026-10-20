import { mergeBooks } from '../shared/merge-by-book.js'
import type { MergedRound } from '../shared/merge-by-book.js'
import { partitionByRelevance } from '../shared/relevance.js'
import type { RelevancePartition } from '../shared/relevance.js'
import type { MergedBook, MergedSource, SearchGroup, SearchHit } from '../shared/wire.js'
import { zhTranslate } from './copy/index.js'
import type { Translate } from './copy/index.js'

/**
 * 搜索结果页的**纯派生**层（与 `shelf-view-model` / `city-view-model` / `source-list-view` 同形：
 *  纯函数、不持 React 状态、零 DOM、零 IO）：一轮命中的现场 → 收口读数、两条呈现轴的行身份与逐源回读。
 *
 * 为什么这一族要搬出视图：它们此前是 `SearchView` 的模块私有函数，只能在整页 jsdom 里间接触达，
 * 而单位律（条／本／家三条读数绝不折叠）与「同址两行」这类判据恰恰是最该被单独钉住的东西。
 * 视图因此回到只做接线与渲染——口径的住址在本文件，判据的**为什么**仍住 `CONTEXT.md` 的
 * 「作品视图（按书）」与 `docs/adr/0032` / `docs/adr/0033`。
 */

/** 一轮搜索的收口数字（进度条退场后仍在） */
export interface SearchSummary { sources: number; hits: number; found: number; failed: number; relevant: number }

/** 一组命中的相关性分区（每组只算一次的现场） */
export interface PartitionedGroup { group: SearchGroup; part: RelevancePartition }

/** 一条逐源行的引用：哪个源上的哪条命中。行身份与 React key 从这一对算；
 *  架位不是这个键（口径住 `services/shelf.ts` 的 `Shelf`）。 */
export interface RowRef { sourceId: string; hit: SearchHit }

/** 一轮结果的现场：按组分区（每组带 group 本体），另有轮级派生两份（归并结果与行元数据索引）。
 *  全部派生在轮次身份上，只有轮真变才重算。为什么要调用方 memo：SSE 每帧都发新的 round 对象
 *  （累积器只增不减、组按源只 emit 一次），打字也走同一棵重渲——不 memo 就是每帧每击键重付
 *  整轮派生（2026-10-13 实测：520 源 × 40 条的轮约 38 ms）。重算时各付几趟如实记：分区一趟、
 *  归并一趟（归并面自带逐组分区——`mergeBooks` 签名被工具面同吃，不在这吃这份现场）、
 *  行元数据索引一趟。
 *  归并面自带分区不是分叉：判据只有一处住址（`shared/relevance.ts`）且同入参同结果的纯函数，
 *  两条轴读到的「相关」因此不会分叉；收口行的「相关 x 条」与组头的「相关 x · 共 y」则读
 *  同一份分区，把「两个数对不上」从源头堵死。 */
export interface RoundView { parts: PartitionedGroup[]; merged: MergedRound; meta: Map<string, SearchHit> }

/** 一轮的现场（分区 + 归并 + 逐源回读索引一次算齐）。memo 归调用方：本函数不认识轮次身份。 */
export function deriveRound(round: { keyword: string; groups: SearchGroup[] }): RoundView {
  const parts = round.groups.map((g) => ({ group: g, part: partitionByRelevance(round.keyword, g.hits) }))
  return {
    parts,
    merged: mergeBooks(round.keyword, round.groups),
    meta: rowMeta(round.groups),
  }
}

/** 收口算式：sources = **真搜完并回来的组数**（不是本轮计划家数——停止的轮次里两者不等，
 *  报计划数就是谎报）；命中条数 = 各命中组之和；found = 有命中的源数；failed = 带 error 的组数；
 *  relevant = 默认视野会摆的条数——判据不在这里写第二份，只汇总分区结果
 *  （hits 与 relevant 两个数不一致时收口行必须并报，否则读成「结果又少了一批」）。
 *  与 `views/bits.tsx` 的 `jobPct` / `searchPct` 百分比算式不同源——
 *  这是**计数**不是百分比，只此一处。 */
export function sumRound(parts: PartitionedGroup[]): SearchSummary {
  let hits = 0
  let found = 0
  let failed = 0
  let relevant = 0
  for (const { group, part } of parts) {
    if (group.error === undefined) {
      hits += group.hits.length
      found += 1
      relevant += part.kept.length
    } else failed += 1
  }
  return { sources: parts.length, hits, found, failed, relevant }
}

/** 一行的身份：(源, 地址)。建索引那一侧、取用那一侧与逐源行的 React key 都读这一个算式，
 *  两处各写一遍就等于给「哪一行属于哪一本」两个主人。
 *  **架位不读它**（口径住 `services/shelf.ts` 的 `Shelf`，算式在 `shelfSeats` / `newlyLandedSeats`）；
 *  `rowId` 只服务行 key 与元数据回读。 */
export const rowId = (sourceId: string, url: string | null): string => JSON.stringify([sourceId, url])

/** 逐源行的 React key：身份走 `rowId`，只在同一身份于本行里重复出现时垫位次。
 *  地址为什么必须在 key 里：换一轮搜同一本书，同一家、同一下标可能给了另一个地址——
 *  不含地址的 key 认不出这是新行，于是它顶用上一行的「已在书架」，看着已架而那一发从未存在。
 *  为什么垫的是同身份内的位次、不是整行列号：一家给同一地址两种写法是既有形状
 *  （`rowMeta` 的「同址两行」口径），列号既会让两行撞同一个 key，也会因旁行挪位
 *  把自己那行的入架态洗成未加。 */
export function rowKeys(rows: RowRef[]): string[] {
  const seen = new Map<string, number>()
  return rows.map((r) => {
    const id = rowId(r.sourceId, r.hit.url)
    const dup = seen.get(id) ?? 0
    seen.set(id, dup + 1)
    return dup === 0 ? id : `${id}#${dup}`
  })
}

/** (源, 地址) → 该条命中。同址两行取第一条的元数据：同一地址的封面本就是一份，
 *  而行上摆的名字仍按各自己那一条给。 */
export function rowMeta(groups: SearchGroup[]): Map<string, SearchHit> {
  const by = new Map<string, SearchHit>()
  for (const g of groups) {
    for (const h of g.hits) {
      const id = rowId(g.sourceId, h.url)
      if (!by.has(id)) by.set(id, h)
    }
  }
  return by
}

/** 按书行的 key：认那一本的名字对（书名, 作者），不认它排在第几。
 *  为什么：流式轮次里同档会按家数降序重排，位置 key 把展开态与入架态串到别的书上
 *  （用户展开的是甲，下一帧开着的成了乙）。归并键本就是规范化后的这对名字，两本不同的书
 *  不可能带同一对原样名字（规范化多对一，同原样必同键），因此无须再垫下标。 */
export function bookRowKey(book: MergedBook): string {
  return JSON.stringify([book.title, book.author])
}

/** 一本的逐源行 = 归并给的行身份 ＋ 从本轮命中回读的元数据；顺序跟着归并的到达序。
 *  回读而非抄一份：封面／简介／最新章这些**书架要存的字段**仍住在命中本身，
 *  把它们焊进 `MergedSource` 就是给同一份元数据第二个主人（归并面只答「这一家把它叫作什么」）。 */
export function bookRows(book: MergedBook, meta: Map<string, SearchHit>): RowRef[] {
  return book.sources.map((s) => ({ sourceId: s.sourceId, hit: rowHit(s, meta.get(rowId(s.sourceId, s.url))) }))
}

/** 逐源行那张命中：名字一律用归并带来的那一份（两边的写法都要看得见），
 *  其余字段按 wire 的可空口径给——回读不到就是 null，不发明「缺键」这第三种形状。
 *  露在最上面那一行由首个到达的源定（取首条的裁决住在 `shared/merge-by-book.ts`），
 *  换一轮搜同一本书可能换个写法出现在书行上；逐源行各家写法都在，这里不抹平名字。 */
function rowHit(s: MergedSource, meta: SearchHit | undefined): SearchHit {
  return {
    title: s.title, author: s.author, url: s.url,
    coverUrl: meta?.coverUrl ?? null, intro: meta?.intro ?? null,
    lastChapterName: meta?.lastChapterName ?? null, kind: meta?.kind ?? null, wordCount: meta?.wordCount ?? null,
  }
}

/** 行上的作者读数：逗号级名单只留前两位，其余由尾缀承担（`search.book.etAl`）。
 *  为什么收：有的源把整张配音表塞进 `author`，而这一段住在主钮的内容里、也就是它的
 *  无障碍名——不收，读屏每本念一遍名单，视觉上还把尾巴与「都加架」顶下两行。收的不是信息：
 *  全串在 `title` 与展开后的逐源行里原样都在。
 *  只在逗号处切：「萧炎：锦鲤 药老：北炎」那种空格分隔的角色表切不出「第二位」，整串交给 CSS 省略号。 */
export function shortAuthor(author: string, t: Translate = zhTranslate): string {
  const head = /^\s*[^,，、]+\s*[,，、]\s*[^,，、]+/.exec(author)
  if (head === null || !/[,，、]/.test(author.slice(head[0].length))) return author
  return t('search.book.etAl', { head: head[0].trimEnd() })
}

/** 一本的架位全集（有地址的那些）：「都加架」的三态与回执都数这个集合，不数行数——
 *  同址两行只落一个架位（口径住 `services/shelf.ts` 的 `Shelf`）。 */
export function shelfSeats(rows: RowRef[]): Set<string> {
  return new Set(rows.flatMap((r) => (r.hit.url === null ? [] : [r.hit.url])))
}

/** 行上入架态：无地址的行永远未落（架位口径住 `services/shelf.ts` 的 `Shelf`）。 */
export function isSeatLanded(landed: ReadonlySet<string>, hit: SearchHit): boolean {
  return hit.url !== null && landed.has(hit.url)
}

/** 「都加架」里**这次新落架**的架位：逐条 PUT 的成功结果按地址去重后给回。
 *  按成功 PUT 计数会把一个架位报成「已加 2 个架位」（同址两行发两发幂等 PUT 也只落一个架位），
 *  虚报架上的账；没发出去的那几条不在 `settled` 里，本来就不该记进回执。 */
export function newlyLandedSeats(todo: RowRef[], settled: ReadonlyArray<PromiseSettledResult<unknown>>): string[] {
  const seats = new Set<string>()
  settled.forEach((res, i) => {
    const url = todo[i].hit.url
    if (res.status === 'fulfilled' && url !== null) seats.add(url)
  })
  return [...seats]
}
