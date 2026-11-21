import { interpolateUrl } from '../engine/index.js'
// 死线守卫与它的中继错误按子模块直取：RegexDeadlineError 不在引擎公开面上（归属裁决见 engine/errors.ts）
import { RegexDeadlineError } from '../engine/errors.js'
import { guardedTest } from '../engine/regex-guard.js'
import type { ItemContext, SubRuleEval } from './bridge.js'
import { classify } from './errors.js'
import type { ErrorCategory } from './errors.js'
import { log } from './log.js'
import { isNativeSource } from './normalize.js'
import { absUrlKeepOption, canonUrl } from './request.js'
import { resolveSearchTemplate } from './search-template.js'
import { evalListRule, fetchListPage } from './list-page.js'
import type { SourceRequest } from './source-request.js'
import type { ProbeErrorCode } from '../shared/wire.js'
import type { NovelSource } from './types.js'

/**
 * 搜索面：「发一次书源搜索请求并取回条目」的唯一实现——JS 形态 searchUrl 沙箱求值 → `{{…}}` 预求值 → `url,{json}` 选项 →
 * Native 首页裁页码 → 带超时抓取 → charset 解码 → 列表规则求值 → 条目提取。聚合搜索（reading.searchOne）与探针
 * （probe.probeSource）是消费它的两个 adapter：前者展开字段，后者做关键词重试。
 *
 * 请求组装归 request.assembleRequest，抓取+解码归 source-request.SourceRequest.fetchText；本模块只持有搜索面特有的
 * 编排：模板解析 → 计划 → 条目求值。错误策略归调用方：抓取/解码/沙箱错误**上抛**（调用方用 searchErrorCodeOf 归类）；
 * 规则缺失是**结果**（ok:false），因为两个 adapter 都把它当正常分支。
 */

/** 发一次搜索请求的结果：规则缺失（结果形态）或 条目上下文 + 落地地址 + 源绑定求值器。`shape`：'list' = contexts 是逐条目的求值
 *  上下文（含 AllInOne 行）；'info' = 整段响应就是详情页，调用方按**详情规则**展开成一条书目。 */
export type SearchFaceResult =
  | { ok: false; code: 'RuleMissing'; message: string }
  | { ok: true; shape: 'list'; contexts: ItemContext[]; landedUrl: string; subEval: SubRuleEval }
  | {
    ok: true
    shape: 'info'
    /** 整段响应原文（原样交给详情字段规则求值） */
    body: string
    /** 为什么是详情页：`pattern` = 落地地址整串命中 `bookUrlPattern`；`empty-list` = 列表规则零命中后的回落。**探针按这条分岔**：
     *  回落来的「零命中」可能只是这个词被停用，照旧换词重试；嗅探命中的是源的本性，重试没有意义。 */
    via: 'pattern' | 'empty-list'
    /** 这条书目的地址——重定向过就用落地地址，否则用请求地址绝对化后的形态。**未重定向时保留 `,{option}` 后缀**：POST 型 API 详情页
     *  的 book_id 就活在选项 body 里，剥掉后再也发不出同一个请求（与搜索结果 bookUrl、章节 URL 的 keepOption 同源）。 */
    bookUrl: string
    landedUrl: string
    subEval: SubRuleEval
  }

/**
 * 发一次书源搜索请求（page 固定 1——搜索面无翻页）。landedUrl = 实际落地地址：规则求值与相对链接一律以它为基准，与目录/正文面同口径。
 * 详情页嗅探也判在这里：① 落地地址整串命中 → 整段响应就是详情页，**列表规则根本不参与**；② 列表 0 条**且源未声明 pattern** →
 * 同样按详情页（声明过却没命中就是 0 结果，不再回落）。
 */
export interface SearchFaceOptions {
  timeoutMs?: number
  jsTimeoutMs?: number
  signal?: AbortSignal
}

export async function fetchSearchPage(
  source: NovelSource, keyword: string, request: SourceRequest, opts?: SearchFaceOptions,
): Promise<SearchFaceResult> {
  const { timeoutMs, jsTimeoutMs, signal } = opts ?? {}
  const { searchUrl, ruleBookList, ruleBookName, bookUrlPattern } = source.rules
  if (searchUrl === null || ruleBookName === null) {
    const missing = [
      searchUrl === null ? 'searchUrl' : null,
      ruleBookName === null ? 'ruleBookName' : null,
    ].filter((x): x is string => x !== null)
    return { ok: false, code: 'RuleMissing', message: `搜索规则缺失或形态不支持：缺 ${missing.join('、')}` }
  }
  // 模板里的 js 脚本出站也走源级外观：拿基础 fetcher 会让脚本请求绕过限速（见 source-request 的头条裁决）
  const template = await resolveSearchTemplate(source, searchUrl, keyword, 1, request.fetcherFor(source), jsTimeoutMs)
  const vars = { key: keyword, page: 1 }
  // 读页与发现面同一份（`list-page.ts`）：本面只多两件——JS 形态模板与详情嗅探（嗅探判要抢在列表
  // 求值之前，故这里只取抓取半段，列表规则求值挪到嗅探判之后）
  const page = await fetchListPage(source, request, {
    template, vars, trimFirstPage: isNativeSource(source.raw),
    // 取消与超时是两个轴：超时由 fetcher 自己的预算收口，signal 只表达「调用方不要了」
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(jsTimeoutMs === undefined ? {} : { jsTimeoutMs }),
    ...(signal === undefined ? {} : { signal }),
  })
  // 「重定向过」的判据是落地地址 ≠ 请求地址（本仓没有响应对象上的标志可比）
  const redirected = canonUrl(page.landedUrl) !== canonUrl(page.requestUrl)
  const info = (via: 'pattern' | 'empty-list'): SearchFaceResult => {
    const bookUrl = redirected ? page.landedUrl
      : absUrlKeepOption(interpolateUrl(template, vars), page.landedUrl) ?? page.landedUrl
    // 详情形态的求值上下文自带 `book` 绑定（详情规则常引用 `book.bookUrl`）：两个 adapter 都拿这一份 subEval，不再各自决定绑什么
    return {
      ok: true, shape: 'info', via, body: page.text, landedUrl: page.landedUrl, bookUrl,
      subEval: page.evalr.subEval({ vars: {}, book: { bookUrl, origin: source.baseUrl } }),
    }
  }
  const sniff = patternOf(bookUrlPattern, source.name)
  // 详情形态只对**声明了 ruleBookInfo.name** 的源开放：详情字段对平铺方言会回退搜索条目规则——不这么闸，一次「零结果」的搜索
  // 就会被按 `tag.a@text` 展开成「以页面第一个链接当书名」的假书目。
  const canInfo = (source.rules.ruleDetailName ?? null) !== null
  // 嗅探判必须在列表规则求值**之前**：命中即详情页，列表规则根本不参与（先求值再丢结果会让列表
  // 规则的炸点与 @js 外呼泄漏到详情之路上——列表规则出错不该废掉一次嗅探命中的搜索）
  if (canInfo && startsDetail(sniff, page.landedUrl, source.name)) return info('pattern')
  // 缺列表规则不是缺规则：空规则求值即得空列表，然后走②那条详情回落；书名规则仍是硬要求（空规则返回整页文本）。
  const contexts = await evalListRule(page, ruleBookList)
  if (canInfo && contexts.length === 0 && (bookUrlPattern === null || bookUrlPattern.trim() === '')) {
    return info('empty-list')
  }
  return { ok: true, shape: 'list', contexts, landedUrl: page.landedUrl, subEval: page.subEval }
}

/** 落地 URL 是否命中 `bookUrlPattern`。执行走死线守卫；超时与「正则非法」同一处置：留痕后按未命中处理，不让一条坏规则废掉整次搜索。 */
function startsDetail(sniff: RegExp | null, url: string, sourceName: string): boolean {
  if (sniff === null) return false
  try {
    return guardedTest(sniff, url)
  } catch (e) {
    if (!(e instanceof RegexDeadlineError)) throw e
    log.warn(`源「${sourceName}」的 bookUrlPattern 求值超时（疑似灾难性回溯），已忽略详情页嗅探：${sniff.source}`)
    return false
  }
}

/** `bookUrlPattern` → 整串匹配正则（空/缺 → null）。匹配须是**全串**语义而 JS `test` 是子串语义——不锚定就会把 `\/novel\/[0-9]+\.html`
 *  这类写法判成命中，把搜索结果页当详情页解析。编译不了 → warn 点名 + 按未声明处理（不让坏正则废掉本来能用的搜索）。 */
function patternOf(raw: string | null, sourceName: string): RegExp | null {
  if (raw === null || raw.trim() === '') return null
  try {
    return new RegExp(`^(?:${raw})$`)
  } catch {
    log.warn(`源「${sourceName}」的 bookUrlPattern 不是合法正则，已忽略详情页嗅探：${raw}`)
    return null
  }
}

/** 探针错误码投影：类目 → ProbeErrorCode 的表在此一处。引擎三类与抓取两类用类名；缺规则用 'RuleMissing'；其余 → 'Error' 兜底（出现即分类漏了）。 */
const PROBE_CODE_OF: Record<ErrorCategory, string> = {
  'rule-eval': '',                    // e.name（UnsupportedRuleError/RuleEvalError/JsSandboxError）
  'rule-missing': 'RuleMissing',
  fetch: '',                          // e.name（FetchError/DecodeError）
  'not-found': 'Error',               // 搜索面不会抛缺席错——出现即意外，兜底如实
  'bad-request': 'Error',             // 值域错是写口的事（搜索面只读）——出现即意外，兜底如实
  'local-import': 'Error',            // 以下类目只属于本地书面/任务面/听书面，搜索面不见——兜底如实
  'local-too-large': 'Error',
  unavailable: 'Error',
  'job-running': 'Error',
  'tts-engine-missing': 'Error',
  'tts-engine-unavailable': 'Error',
  'tts-upstream': 'Error',
  'tts-bad-response': 'Error',
  other: 'Error',
}

export function searchErrorCodeOf(e: unknown): ProbeErrorCode {
  const code = PROBE_CODE_OF[classify(e)]
  return (code === '' ? (e instanceof Error ? e.name : 'Error') : code) as ProbeErrorCode
}
