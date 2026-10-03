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
 *  它要说清哪个源坏了，与搜索面「把源好坏如实摊开」同哲学。 */
export function failureSummary(failures: readonly ExploreFailure[]): string {
  return failures.length === 0 ? '' : `${failures.length} 个源没响应`
}

/** 空态分支的唯一判据：词表为空 = 库里没有源提供分类浏览（与「这一类零结果」是两件事）。 */
export function cityEmptyKind(kindCount: number): 'no-kinds' | 'has-kinds' {
  return kindCount === 0 ? 'no-kinds' : 'has-kinds'
}
