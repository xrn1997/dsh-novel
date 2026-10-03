import type { ExploreBook, ExploreFailure } from '../shared/wire.js'

/** 分类页的**纯派生**层：文案与判据只此一处，视图里不再各拼一份（客户端逻辑层测试口径：
 *  纯函数、零 React——这些函数能在没有 DOM 的情况下被钉住）。 */

/** 卡片元信息：`作者 · 分类 · 字数`，**缺的整段不出现**（原生源的 ruleSearch 常常没有
 *  intro/wordCount，写「暂无」就是拿假信息占位）。作者为空是合法的（那一档不参与归并）。 */
export function cityMeta(book: Pick<ExploreBook, 'author' | 'kind' | 'wordCount'>): string {
  return [book.author ?? '', book.kind ?? '', book.wordCount ?? ''].filter((s) => s !== '').join(' · ')
}

/** 来源角标文案：角标说的是**源数**（不是条目数）——服务端已按源去重，这里只负责说法。 */
export function sourceCountLabel(n: number): string {
  return `${n} 源`
}

/** 进度文案：服务端按 searchParallel 自跑分批，**不需要用户动作**，所以这里只是读数。 */
export function cityProgress(done: number, total: number): string {
  return total === 0 ? '' : `已 ${done} / ${total} 源`
}

/** 失败条摘要：只说数量（点名在展开里）——但失败条本身是本设计的**刻意例外**：
 *  它要说清哪个源坏了，与搜索面「把源好坏如实摊开」同哲学。
 *
 *  **不许说成「没响应」**：这一条里住着两种源——一条都没给出的，与「已有累积、只是这一页没回来」
 *  的（见 `ExploreFailure`）。后一种上一页明明答过，把它念成哑源就是拿一句懒话抹掉它的功劳，
 *  也让用户以为这本书的来源全废了。说「这一页没回来」两种都成立。 */
export function failureSummary(failures: readonly ExploreFailure[]): string {
  return failures.length === 0 ? '' : `${failures.length} 个源这一页没回来`
}

/** 空态分支的唯一判据：词表为空 = 库里没有源提供分类浏览（与「这一类零结果」是两件事）。 */
export function cityEmptyKind(kindCount: number): 'no-kinds' | 'has-kinds' {
  return kindCount === 0 ? 'no-kinds' : 'has-kinds'
}

/** 轮次判据只读的这几个字段。**刻意不收 `ExploreRound`**：那是观察者模块的形状，纯派生层一
 *  import 它就跟运行时模块绑上了（这一层的卖点正是零 React、能脱开 DOM 钉住）。形状按结构类型
 *  对上，视图直接把 `round` 递进来即可。 */
export interface RoundShape {
  total: number
  done: number
  books: readonly ExploreBook[]
  running: boolean
  cancelled: boolean
}

/**
 * 书单区的空态：**按轮次的形状说话，不按「书单数组是不是空的」说话**。零本有四种来路，只有一种
 * 能说成「这一类没有货」，其余三种说了就是编：
 * ① 还在跑（源还在往回送）——结论未定；② 被停止——停止不是完成，也不是空结果；
 * ③ 一轮里 0 个源——**没有任何源被问过**，对归类内容一无所知（这一态只由尾行说轮次自己的形状）；
 * ④ 读面/写面报错的那一轮（服务端说 failed）——没跑完的一轮不能替分类下结论。
 * 只有「干净跑完、且这一轮确实有源参与」才配得上这句空结果。
 * 返回 null = 不占位（有书时铺网格；四种未定态既不铺网格也不说话——沉默比假结论诚实）。
 *
 * 有失败的那些源不改变本判据（`books` 已是全量归并结果，空就是真的没有），但改变**说法**：
 * 部分失败时不能说「都答完了」，那是把「这一页没回来」读成「没有货」。这一句用的是与失败条
 * （`failureSummary`）**同一套词**：同一条清单在相邻两处各叫一个名字，读起来就像两份事实。
 */
export function bookListEmpty(round: RoundShape, failures: number, error: string | null): { title: string; hint: string } | null {
  if (round.running || round.cancelled || round.total === 0 || round.books.length > 0 || error !== null) return null
  return {
    title: '这一类还没有书',
    hint: failures === 0
      ? `这一类的 ${round.total} 个源都答完了，一本都没有收录——空结果不是失败，换个分类看看。`
      : '答完的源一本都没有收录；这一页没回来的那几个源见下面那条失败说明。',
  }
}

/** 轮次读数（**只说这一轮跑到哪儿了**：服务端按并发自跑分批，这行文字不承载任何动作）。
 *  「加载更多」那颗按钮不归这里管：它认的是 `hasMore` 与快照的页码（见 `CityView` 的尾行）。
 *  **停止不是完成**：取消后不许说成一个走到了底的轮次，故「已停止」优先于进度文案。
 *  跑完而 0 个源的一轮也不许留空白：`cityProgress` 在源数为 0 时给的是空串（那一档本是给
 *  「还没有一轮」与「这一类零源」共用的），尾行会变成一条空读数。这一态唯一能被快照支持的事实
 *  就是「没有源参与」，如实说它。 */
export function roundReadout(round: RoundShape): string {
  if (round.cancelled) return '已停止'
  if (round.running) return round.total === 0 ? '正在启动分类抓取…' : cityProgress(round.done, round.total)
  return round.total === 0 ? '这一轮没有源参与' : cityProgress(round.done, round.total)
}
