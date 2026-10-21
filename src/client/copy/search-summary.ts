import { plural } from './index.js'
import type { CopyKey, Translate } from './index.js'

export interface SearchSummaryCounts {
  searched: number
  hits: number
  merged: number
  answered: number
  relevant: number
  failed: number
  stopped: boolean
}

export interface SummarySegment { text: string; emphasis?: boolean }

/** 收口句的语法归字典：模板决定子句顺序与标点，视图只交数字。
 *  为什么是整句模板而不是碎片拼装：碎片各带前导标点，词序就落在拼装处、字典只剩词——
 *  换语序要两处一起改才成立。整句模板把顺序与标点一并收回字典。
 *  计数拆成「数字段 + 单位段」：只有数字进 emphasis，与旧 UI 的 <b> 边界一致（answered 与 relevant
 *  不加粗）；failed 子句无条件出现（`0 家未响应` 也是结论，与旧 JSX 的无条件失败段一致）。
 *  已知限制：relevant 子句键自带前导 `，` / `, `（住 `search.ts`），这是当前两语种共享的标点假设；
 *  换用别的标点形态的语种要先裁一次键形，不在本次范围内改。 */
export function searchSummarySegments(t: Translate, c: SearchSummaryCounts): SummarySegment[] {
  const unit = (n: number, one: CopyKey, other: CopyKey): string =>
    ` ${plural(t, n, one, other, { n })}`
  const count = (n: number, one: CopyKey, other: CopyKey): SummarySegment[] => [
    { text: String(n), emphasis: true },
    { text: unit(n, one, other) },
  ]
  const params: Record<string, SummarySegment[]> = {
    searched: count(c.searched, 'search.summary.sourcesUnit.one', 'search.summary.sourcesUnit.other'),
    hits: count(c.hits, 'search.summary.hitsUnit.one', 'search.summary.hitsUnit.other'),
    merged: count(c.merged, 'search.summary.mergedUnit.one', 'search.summary.mergedUnit.other'),
    answered: [{ text: `${c.answered}${unit(c.answered, 'search.summary.sourcesUnit.one', 'search.summary.sourcesUnit.other')}` }],
    relevant: c.relevant < c.hits
      ? [{ text: plural(t, c.relevant, 'search.summary.relevant.one', 'search.summary.relevant.other', { n: c.relevant }) }]
      : [],
    failed: [
      { text: ' · ' },
      { text: String(c.failed), emphasis: true },
      { text: unit(c.failed, 'search.summary.failedUnit.one', 'search.summary.failedUnit.other') },
    ],
  }
  const raw = t('search.summary.line')
  const segments: SummarySegment[] = []
  if (c.stopped) segments.push({ text: t('search.summary.stopped') })
  for (const part of raw.split(/(\{\w+\})/)) {
    if (part === '') continue
    const m = /^\{(\w+)\}$/.exec(part)
    if (m === null) { segments.push({ text: part }); continue }
    const value = params[m[1]]
    if (value === undefined) { segments.push({ text: part }); continue }
    segments.push(...value)
  }
  return segments
}
