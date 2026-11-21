import { mergePartitioned } from '../shared/merge-by-book.js'
import type { MergedRound } from '../shared/merge-by-book.js'
import { summarizeRound } from '../shared/round-summary.js'
import type { RoundCounts, RoundPartition } from '../shared/round-summary.js'
import type { MergedBook, MergedSource, SearchGroup, SearchHit } from '../shared/wire.js'
import { zhTranslate } from './copy/index.js'
import type { Translate } from './copy/index.js'
import type { ShelfAddOutcome } from './shelf-action.js'

/**
 * 搜索结果页的**纯派生**层（与 `shelf-view-model` / `city-view-model` 同形）：纯函数、零 DOM、零 IO。
 * 一轮命中 → 轮级读数（分区与计数住 `shared/round-summary.ts`）、两条呈现轴的行身份与逐源回读。
 *
 * 为什么在视图外：单位律（条／本／家绝不折叠）与「同址两行」这类判据最该被单独钉住；口径的**为什么**
 * 仍住 `CONTEXT.md` 的「作品视图（按书）」与 `ADR-0032` / `ADR-0033`。
 */

/** 一条逐源行的引用：哪个源上的哪条命中。行身份与 React key 从这一对算；架位不是这个键。 */
export interface RowRef { sourceId: string; hit: SearchHit }

/** 逐源组在一个轮次里的呈现现场：这一组的分区 + 两档行与它们的 key。分档仍是**视图的**事
 *  （失败组照样在这里，由视图挪进失败折叠）。 */
export interface GroupView {
  partition: RoundPartition
  keptRows: RowRef[]
  keptKeys: string[]
  suspectRows: RowRef[]
  suspectKeys: string[]
}

/** 一本在按书视图里的呈现现场：归并来的书目 + 逐源行、行 key 与架位全集（同一份 `rows` 派生）。 */
export interface BookView {
  book: MergedBook
  rows: RowRef[]
  keys: string[]
  seats: Set<string>
}

/** 一轮结果的现场：轮级分区与计数、归并结果、两条呈现轴预计算好的行身份。全部派生在轮次身份上；
 *  调用方必须 memo（SSE 每帧发新的 round 对象，不 memo 就每帧每击键重付整轮派生）。
 *  轮级只分区一次：收口行、组头与归并取行读同一份分区，两个数对不上从源头堵死。
 *  行 key 与架位也收在这里：散回渲染路径就会每帧重算。 */
export interface RoundView {
  parts: RoundPartition[]
  summary: RoundCounts
  merged: MergedRound
  groupViews: GroupView[]
  bookViews: BookView[]
}

/** 一轮的现场（轮级分区与计数 + 归并 + 两条呈现轴的行身份一次算齐）；memo 归调用方。 */
export function deriveRound(round: { keyword: string; groups: SearchGroup[] }): RoundView {
  const { parts, counts } = summarizeRound(round.keyword, round.groups)
  const merged = mergePartitioned(parts)
  const meta = rowMeta(round.groups)
  const groupViews = parts.map((part) => {
    const keptRows = part.part.kept.map((m) => ({ sourceId: part.group.sourceId, hit: m.hit }))
    const suspectRows = part.part.suspect.map((m) => ({ sourceId: part.group.sourceId, hit: m.hit }))
    return { partition: part, keptRows, keptKeys: rowKeys(keptRows), suspectRows, suspectKeys: rowKeys(suspectRows) }
  })
  const bookViews = merged.books.map((book) => {
    const rows = bookRows(book, meta)
    return { book, rows, keys: rowKeys(rows), seats: shelfSeats(rows) }
  })
  return { parts, summary: counts, merged, groupViews, bookViews }
}

/** 一行的身份：(源, 地址)。建索引、取用与逐源行 key 都读这一个算式。**架位不读它**
 *  （口径住 `services/shelf.ts` 的 `Shelf`）；`rowId` 只服务行 key 与元数据回读。 */
export const rowId = (sourceId: string, url: string | null): string => JSON.stringify([sourceId, url])

/** 逐源行的 React key：身份走 `rowId`，同一身份重复出现时垫同身份内位次。地址必须在 key 里
 *  （换一轮搜同一本书可能同家同下标给另一个地址）；不垫整行列号——既会撞 key，也会因旁行挪位串入架态。 */
export function rowKeys(rows: RowRef[]): string[] {
  const seen = new Map<string, number>()
  return rows.map((r) => {
    const id = rowId(r.sourceId, r.hit.url)
    const dup = seen.get(id) ?? 0
    seen.set(id, dup + 1)
    return dup === 0 ? id : `${id}#${dup}`
  })
}

/** (源, 地址) → 该条命中。同址两行取第一条的元数据（同一地址的封面本就是一份）。 */
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

/** 按书行的 key：认（书名, 作者），不认它排第几——流式轮次里同档会按家数重排，位置 key 会把
 *  展开态与入架态串到别的书上。归并键本就是规范化后的这对名字，不同书不可能同键。 */
export function bookRowKey(book: MergedBook): string {
  return JSON.stringify([book.title, book.author])
}

/** 一本的逐源行 = 归并给的行身份 + 从本轮命中回读的元数据；回读而非抄一份——封面/简介/最新章
 *  仍住在命中本身，焊进 `MergedSource` 就是给同一份元数据第二个主人。 */
export function bookRows(book: MergedBook, meta: Map<string, SearchHit>): RowRef[] {
  return book.sources.map((s) => ({ sourceId: s.sourceId, hit: rowHit(s, meta.get(rowId(s.sourceId, s.url))) }))
}

/** 逐源行那张命中：名字一律用归并带来的那一份，其余字段按 wire 的可空口径给（回读不到就是 null）。
 *  露在最上面那行由首个到达的源定（裁决住 `shared/merge-by-book.ts`）。 */
function rowHit(s: MergedSource, meta: SearchHit | undefined): SearchHit {
  return {
    title: s.title, author: s.author, url: s.url,
    coverUrl: meta?.coverUrl ?? null, intro: meta?.intro ?? null,
    lastChapterName: meta?.lastChapterName ?? null, kind: meta?.kind ?? null, wordCount: meta?.wordCount ?? null,
  }
}

/** 行上的作者读数：逗号级名单只留前两位，其余由尾缀承担（`search.book.etAl`）。整张配音表塞进
 *  `author` 的形状存在，而这段住在主钮的无障碍名里——不收，读屏每本念一遍名单。全串在 `title`
 *  与展开后的逐源行里原样都在；只在逗号处切，空格分隔的角色表整串交给 CSS 省略号。 */
export function shortAuthor(author: string, t: Translate = zhTranslate): string {
  const head = /^\s*[^,，、]+\s*[,，、]\s*[^,，、]+/.exec(author)
  if (head === null || !/[,，、]/.test(author.slice(head[0].length))) return author
  return t('search.book.etAl', { head: head[0].trimEnd() })
}

/** 一本的架位全集（有地址的那些）：「都加架」的三态与回执都数这个集合——同址两行只落一个架位。 */
export function shelfSeats(rows: RowRef[]): Set<string> {
  return new Set(rows.flatMap((r) => (r.hit.url === null ? [] : [r.hit.url])))
}

/** 行上入架态：无地址的行永远未落（架位口径住 `services/shelf.ts` 的 `Shelf`）。 */
export function isSeatLanded(landed: ReadonlySet<string>, hit: SearchHit): boolean {
  return hit.url !== null && landed.has(hit.url)
}

/** 「都加架」里**这次新落架**的架位：逐条 PUT 的成功结局按地址去重后给回（按成功 PUT 计数会把
 *  一个架位报成「已加 2 个」）。`addShelfSeat` 从不 reject，结局就是 `ShelfAddOutcome`。 */
export function newlyLandedSeats(todo: RowRef[], outcomes: readonly ShelfAddOutcome[]): string[] {
  const seats = new Set<string>()
  // 以 todo 为轴逐行读结局（`Promise.all` 按 todo 逐条发，两表一一对应）；没有结局与失败结局同一条闸。
  todo.forEach((row, i) => {
    const outcome = outcomes[i]
    const url = row.hit.url
    if (outcome === undefined || !outcome.ok || url === null) return
    seats.add(url)
  })
  return [...seats]
}

/** 「都加架」的回执：新落架 / 仍缺 / 无地址三笔账。新落架才报成功，仍缺报失败，无地址点名
 *  （没试过不是失败）；零加成不许借成功通道报喜。 */
export interface AddAllReceipt { newly: string[]; stillMissing: number; noAddress: number }

/** 「都加架」的回执算式：`stillMissing` 认架位（同址两行只算一个），`noAddress` 认行（没法发 PUT）。 */
export function addAllReceipt(input: {
  rows: RowRef[]; landed: ReadonlySet<string>; todo: RowRef[]; outcomes: readonly ShelfAddOutcome[]
}): AddAllReceipt {
  const seats = shelfSeats(input.rows)
  const newly = newlyLandedSeats(input.todo, input.outcomes)
  const noAddress = input.rows.length - input.rows.filter((r) => r.hit.url !== null).length
  const stillMissing = [...seats].filter((id) => !input.landed.has(id) && !newly.includes(id)).length
  return { newly, stillMissing, noAddress }
}
