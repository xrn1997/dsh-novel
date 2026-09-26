import { RuleEvalError, interpolateUrl } from '../engine/index.js'
import { extractItems, makeSubEval, resolveHeaders } from './bridge.js'
import type { SubRuleEval } from './bridge.js'
import { classify } from './errors.js'
import type { ErrorCategory } from './errors.js'
import { fetchTextPage } from './fetcher.js'
import type { Fetcher } from './fetcher.js'
import { isNativeSource } from './normalize.js'
import { absUrlKeepOption, buildSearchRequest, canonUrl, fetchInitOf } from './request.js'
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

/** 发一次搜索请求的结果：规则缺失（结果形态）或 条目 + 落地地址 + 源绑定求值器。
 *  `shape`：'list' = items 是**条目原文**，调用方按搜索条目规则逐条展开；'info' = 整段响应本身
 *  就是详情页，调用方按**详情规则**把它展开成一条书目。 */
export type SearchFaceResult =
  | { ok: false; code: 'RuleMissing'; message: string }
  | { ok: true; shape: 'list'; items: string[]; landedUrl: string; subEval: SubRuleEval }
  | {
    ok: true
    shape: 'info'
    /** 整段响应原文（原样交给详情字段规则求值） */
    body: string
    /** 为什么是详情页：`pattern` = 落地地址整串命中 `bookUrlPattern`；`empty-list` = 列表规则
     *  零命中后的回落。**探针按这条分岔**：回落来的「零命中」可能只是这个词被站点停用，它照旧换词
     *  重试；嗅探命中的则是源的本性，重试没有意义。 */
    via: 'pattern' | 'empty-list'
    /** 这条书目的地址——重定向过就用落地地址，否则用请求地址绝对化后的形态。
     *  **未重定向时保留 `,{option}` 后缀**：
     *  POST 型 API 详情页的 book_id 就活在选项 body 里，剥掉之后这条地址再也发不出同一个请求
     *  （与搜索结果 bookUrl、章节 URL 的 keepOption 口径同源）。 */
    bookUrl: string
    landedUrl: string
    subEval: SubRuleEval
  }

/**
 * 发一次书源搜索请求（page 固定 1——搜索面无翻页；探针/聚合搜索都只取首页）。
 * landedUrl = 实际落地地址（跟随重定向后的 finalUrl，浏览器语义）——规则求值与相对链接
 * 一律以它为基准，与目录/正文面（page.url = finalUrl）同口径。
 *
 * 详情页嗅探（`bookUrlPattern`）也判在这里，两个 adapter 不再各写一份：
 * ①落地地址整串命中 → 整段响应就是详情页，**列表规则根本不参与**（判定排在跑列表规则之前）；
 * ②列表 0 条**且源未声明 pattern** → 同样按详情页（守卫就是「pattern 为空」：声明过却没命中
 *   就是 0 结果，不再回落）。
 */
export async function fetchSearchPage(
  source: NovelSource, keyword: string, fetcher: Fetcher, timeoutMs?: number, jsTimeoutMs?: number,
): Promise<SearchFaceResult> {
  const { searchUrl, ruleBookList, ruleBookName, bookUrlPattern } = source.rules
  if (searchUrl === null || ruleBookName === null) {
    const missing = [
      searchUrl === null ? 'searchUrl' : null,
      ruleBookName === null ? 'ruleBookName' : null,
    ].filter((x): x is string => x !== null)
    return { ok: false, code: 'RuleMissing', message: `搜索规则缺失或形态不支持：缺 ${missing.join('、')}` }
  }
  const subEval = makeSubEval(fetcher, source, jsTimeoutMs === undefined ? undefined : { jsTimeoutMs })
  const template = await resolveSearchTemplate(source, searchUrl, keyword, 1, fetcher, jsTimeoutMs)
  const vars = { key: keyword, page: 1 }
  const plan = buildSearchRequest(template, vars, source.baseUrl,
    { trimFirstPage: isNativeSource(source.raw) })
  const { text, landedUrl } = await fetchTextPage(fetcher, plan.url,
    { ...fetchInitOf(plan, await resolveHeaders(fetcher, source, { jsTimeoutMs })), timeoutMs }, plan.charset)
  // 「重定向过」的判据是落地地址 ≠ 请求地址（本仓没有响应对象上的标志可比）
  const redirected = canonUrl(landedUrl) !== canonUrl(plan.url)
  const info = (via: 'pattern' | 'empty-list'): SearchFaceResult => {
    const bookUrl = redirected ? landedUrl
      : absUrlKeepOption(interpolateUrl(template, vars), landedUrl) ?? landedUrl
    // 详情形态的求值上下文自带 `book` 绑定（详情规则常引用 `book.bookUrl`）：
    // 两个 adapter（聚合搜索 / 探针）都拿这一份 subEval 走详情规则，不再各自决定绑什么
    return {
      ok: true, shape: 'info', via, body: text, landedUrl, bookUrl,
      subEval: makeSubEval(fetcher, source, {
        vars: {}, book: { bookUrl, origin: source.baseUrl },
        ...(jsTimeoutMs === undefined ? {} : { jsTimeoutMs }),
      }),
    }
  }
  const sniff = patternOf(bookUrlPattern, source.name)
  // 详情形态只对**声明了 ruleBookInfo.name** 的源开放：两个分支都以「书名为空即没有书目」
  // 为守卫，而本仓的详情字段对平铺方言会回退搜索条目规则——不这么闸，一次「零结果」的搜索
  // 就会被按 `tag.a@text` 展开成「以页面第一个链接当书名」的假书目（冒充成功）。
  // 现库读数：带 ruleBookInfo.name 127/158；27 个带 bookUrlPattern 的源全在其中。
  const canInfo = (source.rules.ruleDetailName ?? null) !== null
  if (canInfo && sniff !== null && sniff.test(landedUrl)) return info('pattern')
  // 缺列表规则不是缺规则：空规则求值即得空列表，
  // 然后走上②那条详情回落。书名规则仍是硬要求（空规则返回整页文本，会造垃圾标题）。
  const items = ruleBookList === null ? []
    : extractItems(await subEval(ruleBookList, { html: text, baseUrl: landedUrl }, 'search', 'list'))
  if (canInfo && items.length === 0 && (bookUrlPattern === null || bookUrlPattern.trim() === '')) return info('empty-list')
  return { ok: true, shape: 'list', items, landedUrl, subEval }
}

/** `bookUrlPattern` → 整串匹配正则（空 / 缺 → null）。
 *  匹配须是**全串**语义而 JS `RegExp.test` 是子串语义——不锚定就会把
 *  `\/novel\/[0-9]+\.html` 这类永远不可能整串等于一条 URL 的写法判成命中（现库 27 个带值源里
 *  实证有这种写法），把搜索结果页当详情页解析。
 *  编译不了 → warn 点名 + 按未声明处理：非法正则若当场抛会废掉整次搜索；本仓不让一个坏
 *  正则废掉本来能用的搜索（与「URL 选项不是合法 JSON」同一先例——留痕，但不放大故障）。 */
function patternOf(raw: string | null, sourceName: string): RegExp | null {
  if (raw === null || raw.trim() === '') return null
  try {
    return new RegExp(`^(?:${raw})$`)
  } catch {
    console.warn(`[dsh-novel] 源「${sourceName}」的 bookUrlPattern 不是合法正则，已忽略详情页嗅探：${raw}`)
    return null
  }
}

/** 探针错误码投影：classify 的 wire 投影——类目 → ProbeErrorCode 的表在此一处。
 *  引擎三类与抓取两类用类名（e.name 即 wire 错误码）；缺规则用 'RuleMissing'（与 HTTP 面同码）；
 *  其余 → 'Error' 兜底（出现即分类漏了）。 */
const PROBE_CODE_OF: Record<ErrorCategory, string> = {
  'rule-eval': '',                    // e.name（UnsupportedRuleError/RuleEvalError/JsSandboxError）
  'rule-missing': 'RuleMissing',
  fetch: '',                          // e.name（FetchError/DecodeError）
  'not-found': 'Error',               // 搜索面不会抛缺席错——出现即意外，兜底如实
  'bad-request': 'Error',             // 值域错是写口的事（搜索面只读）——出现即意外，兜底如实
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
