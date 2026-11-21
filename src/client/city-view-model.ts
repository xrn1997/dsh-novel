import type { ExploreBook } from '../shared/wire.js'
import { plural, zhTranslate } from './copy/index.js'
import type { Translate } from './copy/index.js'

/**
 * 分类页的**纯派生**层：派生文案的组装与判据只此一处（字面量住 `copy/city.ts`）。纯函数、零 DOM。
 * 浏览轴按源（`ADR-0028`），「一本书来自几个源」这类跨源读数在本层没有对象：单源下它们要么恒为 1、
 * 要么退化成一条错误。本层只说一个源的一轮能诚实说的事。
 *
 * 零本书有六种形状，谁都不许冒充谁：**还在跑 / 被停止 / 这一类真的没货**归本层；**这一页没回来**
 * 由界面横幅说，本层只保证不冒充「没货」；**跨源一条没搜到 / 有源没响应**只在详情浮层里，归 `CityBookSheet`。
 */

/** 卡片元信息：`作者 · 分类 · 字数`，**缺的整段不出现**（写「暂无」就是拿假信息占位）。 */
export function cityMeta(book: Pick<ExploreBook, 'author' | 'kind' | 'wordCount'>): string {
  return [book.author ?? '', book.kind ?? '', book.wordCount ?? ''].filter((s) => s !== '').join(' · ')
}

/** 源行右端那句类数：读数是**这个源自己声明的分类入口数**，不是热度、不是跨源计数。源行只写名字，
 *  **分组不进这一行**（`ADR-0028` 已裁分组撑不起一级浏览轴）；当前源的分组由右区头行说一次。 */
export function kindCountLabel(kindCount: number, t: Translate = zhTranslate): string {
  return plural(t, kindCount, 'city.kinds.one', 'city.kinds.other', { n: kindCount })
}

/** 跨源那一次搜索的关键词，**唯一主人**：有作者就带上（重名书大量存在）；作者缺席只给书名，不凑。 */
export function sheetKeyword(book: Pick<ExploreBook, 'name' | 'author'>): string {
  return book.author === null || book.author === '' ? book.name : `${book.name} ${book.author}`
}

/** 尾行读数：单源只有「翻到第几页、手上几本」两件事可说；这个数就是快照给的 `books.length`，不是本地加的。 */
export function pageReadout(page: number, count: number, t: Translate = zhTranslate): string {
  return page <= 1
    ? plural(t, count, 'city.page.first.one', 'city.page.first.other', { n: count })
    : plural(t, count, 'city.page.more.one', 'city.page.more.other', { n: count, page })
}

/** 空态分支的唯一判据：**可选源数**为 0 = 库里没有源提供分类浏览（与「这一类零结果」是两件事）。
 *  入参是「声明了分类入口的源数」——两态语义一致（没货 vs 没路）。 */
export function cityEmptyState(sourceCount: number): 'no-sources' | 'has-sources' {
  return sourceCount === 0 ? 'no-sources' : 'has-sources'
}

/** 轮次判据只读的字段（`ExploreRound` 的结构子集）。**刻意写成子集**：身份读数在本层没有对象，
 *  收全类型等于把没人读的东西算进契约面；留下这几个，单测递一个最小对象就能钉住整条判据。 */
export interface RoundShape {
  books: readonly ExploreBook[]
  running: boolean
  cancelled: boolean
  page: number
  hasMore: boolean
}

/**
 * 书单区的空态：**按轮次的形状说话，不按「数组空不空」说话**。零本有四种来路，只有一种能说成
 * 「这一类没有货」：① 还在跑；② 被停止（停止不是完成）；③ 这一页没回来；④ 干净跑完无错误。
 * 返回 null = 不占位（三种未定态既不铺网格也不说话——沉默比假结论诚实）。
 * 单源下没有「一轮里 0 个源」那一档。
 */
export function bookListEmpty(
  round: RoundShape,
  error: string | null,
  t: Translate = zhTranslate,
): { title: string; hint: string } | null {
  if (round.running || round.cancelled || round.books.length > 0 || error !== null) return null
  return { title: t('city.empty.title'), hint: t('city.empty.hint') }
}

/** 轮次读数（只说这一轮跑到哪儿了）。三条先后各说各的：① 被停止优先——「已停止」不许长得像到了底；
 *  ② 还在跑而一页未回——说「正在启动」；③ 其余归本数读数。**它不再收 `error`**：抓失败那句由界面横幅
 *  说（唯一落点 `CityView`），尾行重复就是同一事实两个家。 */
export function roundReadout(round: RoundShape, t: Translate = zhTranslate): string {
  if (round.cancelled) return t('city.stopped')
  if (round.running && round.books.length === 0) return t('city.starting')
  return pageReadout(round.page, round.books.length, t)
}
