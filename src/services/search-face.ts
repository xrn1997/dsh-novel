import { RuleEvalError } from '../engine/index.js'
import { extractItems, makeSubEval, resolveHeaders } from './bridge.js'
import type { SubRuleEval } from './bridge.js'
import { classify } from './errors.js'
import type { ErrorCategory } from './errors.js'
import { fetchTextPage } from './fetcher.js'
import type { Fetcher } from './fetcher.js'
import { isNativeSource } from './normalize.js'
import { buildSearchRequest, fetchInitOf } from './request.js'
import { resolveSearchTemplate } from './search-template.js'
import type { ProbeErrorCode } from '../shared/wire.js'
import type { NovelSource } from './types.js'

/**
 * 搜索面（CONTEXT.md「搜索面」）：
 * 「发一次书源搜索请求并取回条目」的唯一实现——JS 形态 searchUrl 沙箱求值 → `{{…}}` 预求值
 * → `url,{json}` 选项 → Native 首页裁页码 → 带超时抓取 → charset 解码 → 列表规则求值 → 条目提取。
 * 聚合搜索（reading.searchOne）与探针（probe.probeSource）是消费它的两个 adapter：
 * 前者展开字段，后者做关键词重试——请求语义不再各持一份。
 *
 * 请求组装归 request.assembleRequest（选项语义唯一主人），抓取+解码归 fetcher.fetchTextPage
 * （超时单点）；本模块只持有搜索面特有的编排：模板解析 → 计划 → 条目求值。
 *
 * 错误策略归调用方：抓取/解码/沙箱错误**上抛**（调用方各自 catch 并用 searchErrorCodeOf 归类）；
 * 规则缺失是**结果**（ok:false），因为两个 adapter 都把它当正常分支而非异常。
 */

/** 发一次搜索请求的结果：规则缺失（结果形态）或 条目 + 落地地址 + 源绑定求值器 */
export type SearchFaceResult =
  | { ok: false; code: 'RuleMissing'; message: string }
  | { ok: true; items: string[]; landedUrl: string; subEval: SubRuleEval }

/**
 * 发一次书源搜索请求（page 固定 1——搜索面无翻页；探针/聚合搜索都只取首页）。
 * landedUrl = 实际落地地址（跟随重定向后的 finalUrl，浏览器语义）——规则求值与相对链接
 * 一律以它为基准，与目录/正文面（page.url = finalUrl）同口径。
 */
export async function fetchSearchPage(
  source: NovelSource, keyword: string, fetcher: Fetcher, timeoutMs?: number, jsTimeoutMs?: number,
): Promise<SearchFaceResult> {
  const { searchUrl, ruleBookList, ruleBookName } = source.rules
  if (searchUrl === null || ruleBookList === null || ruleBookName === null) {
    const missing = [
      searchUrl === null ? 'searchUrl' : null,
      ruleBookList === null ? 'ruleBookList' : null,
      ruleBookName === null ? 'ruleBookName' : null,
    ].filter((x): x is string => x !== null)
    return { ok: false, code: 'RuleMissing', message: `搜索规则缺失或形态不支持：缺 ${missing.join('、')}` }
  }
  const subEval = makeSubEval(fetcher, source, jsTimeoutMs === undefined ? undefined : { jsTimeoutMs })
  const template = await resolveSearchTemplate(source, searchUrl, keyword, 1, fetcher, jsTimeoutMs)
  const plan = buildSearchRequest(template, { key: keyword, page: 1 }, source.baseUrl,
    { trimFirstPage: isNativeSource(source.raw) })
  const { text, landedUrl } = await fetchTextPage(fetcher, plan.url,
    { ...fetchInitOf(plan, await resolveHeaders(fetcher, source, { jsTimeoutMs })), timeoutMs }, plan.charset)
  const items = extractItems(await subEval(ruleBookList, { html: text, baseUrl: landedUrl }, 'search', 'list'))
  return { ok: true, items, landedUrl, subEval }
}

/** 探针错误码投影：classify 的 wire 投影——类目 → ProbeErrorCode 的表在此一处。
 *  引擎三类与抓取两类用类名（e.name 即 wire 错误码）；缺规则用 'RuleMissing'（与 HTTP 面同码）；
 *  其余 → 'Error' 兜底（出现即分类漏了）。 */
const PROBE_CODE_OF: Record<ErrorCategory, string> = {
  'rule-eval': '',                    // e.name（UnsupportedRuleError/RuleEvalError/JsSandboxError）
  'rule-missing': 'RuleMissing',
  fetch: '',                          // e.name（FetchError/DecodeError）
  'not-found': 'Error',               // 搜索面不会抛缺席错——出现即意外，兜底如实
  'local-import': 'Error',            // 以下四类目只属于本地书面/任务面，搜索面不见——兜底如实
  'local-too-large': 'Error',
  unavailable: 'Error',
  'job-running': 'Error',
  other: 'Error',
}

export function searchErrorCodeOf(e: unknown): ProbeErrorCode {
  const code = PROBE_CODE_OF[classify(e)]
  return (code === '' ? (e instanceof Error ? e.name : 'Error') : code) as ProbeErrorCode
}
