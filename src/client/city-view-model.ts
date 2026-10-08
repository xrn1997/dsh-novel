import type { ExploreBook } from '../shared/wire.js'

/** 分类页的**纯派生**层：文案与判据只此一处，视图里不再各拼一份（客户端逻辑层测试口径：
 *  纯函数、零 React、零 DOM——这些函数能在没有 DOM 的情况下被钉住）。
 *
 *  浏览轴收成按源后（`docs/adr/0028`），「一本书来自几个源」这类跨源读数在本层没有对象了：
 *  旧的 `sourceCountLabel`（卡片角标）、`cityProgress`（「已 x / y 源」）、`failureSummary`（失败清单
 *  摘要）一并删除——单源下它们要么恒为 1、要么退化成一条错误。本层只说一个源的一轮能诚实说的事。
 *
 *  零本书有六种形状，谁都不许冒充谁：**还在跑 / 被停止 / 这一类真的没货** 这一族归本层
 *  （`bookListEmpty` + `roundReadout`）；**这一页没回来** 那一族由界面上的失败横幅说，本层只保证它
 *  不冒充「没货」（`bookListEmpty` 认 `error` 那一条）；**跨源一条没搜到 / 跨源有源没响应** 那两族
 *  只在详情浮层的跨源聚合里出现，归 `CityBookSheet`，不在这里造判据。 */

/** 卡片元信息：`作者 · 分类 · 字数`，**缺的整段不出现**（原生源的 ruleSearch 常常没有
 *  intro/wordCount，写「暂无」就是拿假信息占位）。作者为空是合法的（单源本就不按书名合并任何东西）。 */
export function cityMeta(book: Pick<ExploreBook, 'author' | 'kind' | 'wordCount'>): string {
  return [book.author ?? '', book.kind ?? '', book.wordCount ?? ''].filter((s) => s !== '').join(' · ')
}

/** 源行右端那句类数：读数本身是**这个源自己声明的分类入口数**，不是热度、不是跨源计数。
 *
 *  源行只写名字，**分组不进这一行**——`docs/adr/0028` 已裁「分组是书源包作者手写的、质不统一，
 *  撑不起一级浏览轴」；既然不当轴，就不该在浏览面每一行重复一遍（一行装三件事时最长那条会把栏宽
 *  顶穿，省略号落在谁身上都不划算）。当前源的分组由右区头行说一次（`CityView` 的 `sourceSub`），
 *  要看全部分组去书源管理那一 tab。 */
export function kindCountLabel(kindCount: number): string {
  return `${kindCount} 类`
}

/** 跨源那一次搜索的关键词，**唯一主人**：有作者就带上——重名书大量存在，只给书名会把
 *  别的作者的同名书一并捞回来当成本书的入口；作者缺席时如实只给书名，不拿分类、不拿简介凑。 */
export function sheetKeyword(book: Pick<ExploreBook, 'name' | 'author'>): string {
  return book.author === null || book.author === '' ? book.name : `${book.name} ${book.author}`
}

/** 尾行读数：单源的轮次只有「翻到第几页、手上几本」两件事可说。
 *  第 1 页说「这一页」，往后说「累计」——累积住在服务端持有者，客户端整帧替换，
 *  所以这个数就是快照给的 `books.length`，不是本地加出来的。 */
export function pageReadout(page: number, count: number): string {
  return page <= 1 ? `第 1 页 · 这一页 ${count} 本` : `第 ${page} 页 · 累计 ${count} 本`
}

/** 空态分支的唯一判据：**可选源数**为 0 = 库里没有源提供分类浏览（与「这一类零结果」是两件事）。
 *  入参从旧的「分类数」换成按源的「声明了分类入口的源数」——两态语义一致（没货 vs 没路），
 *  签名不变，只是数的东西换了轴，返回的分支名因此也跟着轴走。 */
export function cityEmptyState(sourceCount: number): 'no-sources' | 'has-sources' {
  return sourceCount === 0 ? 'no-sources' : 'has-sources'
}

/** 轮次判据只读的这几个字段（`ExploreRound` 的结构子集）。**刻意写成子集而不是直接收 `ExploreRound`**：
 *  「这一轮逛的是谁」那四条身份读数在本层的判据里没有对象，收全类型等于把没人读的东西算进契约面；
 *  留下这五个，单测递一个最小对象就能钉住整条判据。形状按结构类型对上，视图直接把 `round` 递进来即可。 */
export interface RoundShape {
  books: readonly ExploreBook[]
  running: boolean
  cancelled: boolean
  page: number
  hasMore: boolean
}

/**
 * 书单区的空态：**按轮次的形状说话，不按「书单数组是不是空的」说话**。零本有四种来路，只有一种
 * 能说成「这一类没有货」，其余三种说了就是编：
 * ① 还在跑（源还在往回送）——结论未定；② 被停止——停止不是完成，也不是空结果；
 * ③ 这一页没回来（快照带了 `error`、或服务端说 failed）——没跑完的一轮不能替分类下结论。
 * 只有「干净跑完、无错误」才配得上这句空结果。
 * 返回 null = 不占位（有书时铺网格；三种未定态既不铺网格也不说话——沉默比假结论诚实）。
 * 单源下没有「一轮里 0 个源」那一档：一轮要么打这个源、要么还没打，不存在「一个源都没被问」。
 */
export function bookListEmpty(round: RoundShape, error: string | null): { title: string; hint: string } | null {
  if (round.running || round.cancelled || round.books.length > 0 || error !== null) return null
  return {
    title: '这一类还没有书',
    hint: '这个源在这一类没给出书——空结果不是失败，换个分类或换个源看看。',
  }
}

/** 轮次读数（**只说这一轮跑到哪儿了**：单源没有跨源进度可数，这行文字不承载任何动作）。
 *  「加载更多」那颗按钮不归这里管：它认的是 `hasMore` 与快照的页码（见 `CityView` 的尾行）。
 *  三条先后各说各的：① 被停止优先——「已停止」不许长得像走到了底的一轮；
 *  ② 还在跑而一页未回——如实说「正在启动」，此刻手上没有本数可报；③ 其余归本数读数（`pageReadout`）。
 *  **它不再收 `error`**：抓失败那句话由界面上的失败横幅说（唯一落点 `CityView` 的那条横幅），
 *  尾行重复一遍就是同一事实两个家；而这一轮跑到第几页、手上几本，是错误在场时照样要说的事实。 */
export function roundReadout(round: RoundShape): string {
  if (round.cancelled) return '已停止'
  if (round.running && round.books.length === 0) return '正在启动分类抓取…'
  return pageReadout(round.page, round.books.length)
}
