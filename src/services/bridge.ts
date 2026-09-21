import render from 'dom-serializer'
import { evaluate, RuleEvalError } from '../engine/index.js'
import type { EngineValue, Facet, RuleUsage } from '../engine/index.js'
// runScript 深引（与 search-template 同口径）：header 规则求值走沙箱完成值语义，
// 引擎 barrel 刻意不收 runScript（公开面只有 evaluate）——服务半第二个深引消费点。
import { runScript } from '../engine/js-sandbox.js'
import { engineFetch, engineFetchRaw } from './engine-fetch.js'
import { headerOf } from './fetcher.js'
import type { Fetcher } from './fetcher.js'
import type { NovelSource } from './types.js'

// 兼容 re-export：absUrl 迁至 url.ts（拆 request↔bridge 环）、engineFetch 迁至 engine-fetch.ts
// （请求组装语义归 request.assembleRequest）——既有 import 路径保持可用。
export { absUrl } from './url.js'
export { engineFetch } from './engine-fetch.js'

/** 页面快照（URL + 解码后正文 + 可选解析好的 JSON）——门面层传给字段求值的输入。
 *  `url` 是**实际落地**地址（跟随重定向后，相对链接按其解析——浏览器语义）；
 *  `requestedUrl` 只作诊断（两者不同＝被跳转走了，报错里点名，站点整站 302 一眼可见）。 */
export interface Page { url: string; requestedUrl?: string; body: string; json?: unknown }

/** 条目片段上的子规则求值器：与引擎内部 evaluateRef 同构（片段即 html 上下文）。
 *  usage（取值用途）：'value'（getString 口径——链尾未知词 = HTML 属性名）/ 'list'（getElements
 *  口径——链尾未知词 = 选择器）。服务层按规则用途显式传，缺省沿用引擎的 'list'。 */
export interface SubRuleEval {
  (rule: string, ctx: { html?: string; json?: unknown; baseUrl: string }, facet: Facet, usage?: RuleUsage): Promise<EngineValue>
}

/** 值规约（链终点取值）：miss→null；value→text；list→join('\n')；matches→取每行首列 join。 */
export function firstValue(v: EngineValue, facet: Facet = 'rule'): string | null {
  switch (v.kind) {
    case 'miss': return null
    case 'value': return v.text
    case 'list': return v.items.join('\n')
    case 'matches': return v.rows.map((r) => r[0] ?? '').join('\n')
    case 'nodes': throw nodesError(v, facet)
  }
}

/** 多值规约：miss→null；value→[text]；list→items；matches→每行首列。 */
export function listValue(v: EngineValue, facet: Facet = 'rule'): string[] | null {
  switch (v.kind) {
    case 'miss': return null
    case 'value': return [v.text]
    case 'list': return v.items
    case 'matches': return v.rows.map((r) => r[0] ?? '')
    case 'nodes': throw nodesError(v, facet)
  }
}

/** 列表页条目提取：nodes→逐节点 HTML 片段；list→逐项；matches→行 join('\t')；miss→[]（零结果合法）。 */
export function extractItems(v: EngineValue): string[] {
  switch (v.kind) {
    case 'miss': return []
    case 'value': return [v.text]
    case 'list': return [...v.items]
    case 'matches': return v.rows.map((r) => r.join('\t'))
    // encodeEntities:'utf8'：默认选项把 CJK 全部编码成 &#x…; 数字实体；'utf8' 只转义 &<> 保留可读原文
    case 'nodes': return v.nodes.toArray().map((n) => render(n, { encodeEntities: 'utf8' }))
  }
}

/** 源级求值上下文组装单点：「引擎上下文该有哪些字段」的唯一实现——
 *  fetch（守门 + auth 头合并）/ source / vars / jsLib 全在此拼装；面（facet）只决定
 *  html/json/baseUrl 的取值。此前 makeSubEval 与 search-template.scriptOf 各拼一份，
 *  runLogin 手拼漏 jsLib/vars（@js 登录调 jsLib 函数只在登录那一刻炸 not defined），
 *  tocUrlOf 连 source/fetch 都没有。新面接入 = 传参数，不 = 再手拼一份字段。 */
export function engineContextOf(
  fetcher: Fetcher, source: NovelSource,
  opts: {
    baseUrl: string; html?: string; json?: unknown; vars?: Record<string, string>
    /** legado `book` 变量（脚本可见的书籍身份——目录/正文面常见 `book.bookUrl`） */
    book?: Record<string, unknown>
    /** legado `chapter` 变量（章节身份：title/index/url） */
    chapter?: Record<string, unknown>
    /** js 沙箱预算透传（EvalContext.jsTimeoutMs；缺省时引擎回退 DEFAULT_JS_TIMEOUT_MS） */
    jsTimeoutMs?: number
  },
): {
  html?: string; json?: unknown; baseUrl: string; source: string
  vars?: Record<string, string>
  fetch: ReturnType<typeof engineFetch>
  fetchRaw: ReturnType<typeof engineFetchRaw>
  jsLib?: string
  book?: Record<string, unknown>; chapter?: Record<string, unknown>; jsTimeoutMs?: number
} {
  return {
    ...(opts.html === undefined ? {} : { html: opts.html }),
    ...(opts.json === undefined ? {} : { json: opts.json }),
    baseUrl: opts.baseUrl,
    source: source.baseUrl,
    ...(opts.vars === undefined ? {} : { vars: opts.vars }),
    // 头走惰性 provider：`@js` 动态头每请求现算（legado getHeaderMap 每请求求值口径）；
    // 规则求值自身用的静态头在 resolveHeaders 内单独构造——不递归回 provider。
    fetch: engineFetch(fetcher, () => resolveHeaders(fetcher, source, { jsTimeoutMs: opts.jsTimeoutMs })),
    fetchRaw: engineFetchRaw(fetcher, () => resolveHeaders(fetcher, source, { jsTimeoutMs: opts.jsTimeoutMs })),
    ...(source.rules.jsLib === null ? {} : { jsLib: source.rules.jsLib }),
    ...(opts.book === undefined ? {} : { book: opts.book }),
    ...(opts.chapter === undefined ? {} : { chapter: opts.chapter }),
    ...(opts.jsTimeoutMs === undefined ? {} : { jsTimeoutMs: opts.jsTimeoutMs }),
  }
}

/**
 * 请求头解析（legado `BaseSource.getHeaderMap` 口径）：静态 header 直答；`headerRule`
 * （`@js:`/`<js>` 动态头）经沙箱求值得到 JSON 头表，再叠 auth/cookie（与静态形态同序：auth 在后占优）。
 *
 * 失败语义对齐 legado 的 try/catch：规则求值抛错或产物不是合法 JSON 对象 → **warn 后回退
 * 静态头**（动态头缺失 = 站点按无 device 鉴权处理，下游自然报错——不吞请求也不炸整条链；
 * legado 同款 catch 后继续发请求）。**不递归**：规则脚本自身的 fetch 用静态头（provider 不进场），
 * 否则头规则里一次 java.ajax 就会重新求值头规则。
 */
export async function resolveHeaders(
  fetcher: Fetcher, source: NovelSource, opts?: { jsTimeoutMs?: number },
): Promise<Record<string, string>> {
  const rule = source.rules.headerRule
  const staticHeaders = headerOf(source)
  if (rule == null || rule.trim() === '') return staticHeaders
  // 规则前缀剥离（legado getHeaderMap：@js: → substring(4)；<js>…</js> → 两标记之间）
  let code = rule
  if (/^@js:/i.test(rule)) code = rule.slice(4)
  else if (/^<js>/i.test(rule)) {
    const close = rule.lastIndexOf('<')
    code = close > 4 ? rule.slice(4, close) : rule.slice(4)
  }
  try {
    const outcome = await runScript({
      code,
      baseUrl: source.baseUrl,
      source: source.baseUrl,
      // 规则脚本自身的网络能力：静态头打底（见上：不递归）
      fetch: engineFetch(fetcher, staticHeaders),
      fetchRaw: engineFetchRaw(fetcher, staticHeaders),
      jsLib: source.rules.jsLib ?? undefined,
      jsTimeoutMs: opts?.jsTimeoutMs,
      loc: { segmentIndex: 0, segmentRaw: rule },
      facet: 'rule',
      scriptForm: true,
    })
    const text = firstValue(outcome.value, 'rule')
    if (text === null || text === '') throw new Error('动态头规则产物为空')
    const parsed: unknown = JSON.parse(text) // 非 JSON（脚本产出坏串）→ 落到下方 catch
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('动态头规则产物不是 JSON 对象')
    }
    const dynamic: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed)) if (typeof v === 'string') dynamic[k] = v
    return { ...dynamic, ...staticHeaders }
  } catch (e) {
    console.warn(`[dsh-novel] 动态头规则求值失败，回退静态头（${source.name}）：`,
      e instanceof Error ? e.message : String(e))
    return staticHeaders
  }
}

/** 缝合器：源级 SubRuleEval——上下文组装走 engineContextOf 单点。
 *  第三参兼容两形态：`Record<string,string>`（历史 vars 形态）或 opts 对象（vars/book/chapter）。 */
export function makeSubEval(
  fetcher: Fetcher, source: NovelSource,
  optsOrVars?: Record<string, string> | { vars?: Record<string, string>; book?: Record<string, unknown>; chapter?: Record<string, unknown>; jsTimeoutMs?: number },
): SubRuleEval {
  const opts = optsOrVars === undefined
    ? {}
    : isVarsShaped(optsOrVars) ? { vars: optsOrVars } : optsOrVars
  return (rule, ctx, facet, usage) =>
    evaluate(rule, engineContextOf(fetcher, source, {
      baseUrl: ctx.baseUrl, html: ctx.html, json: ctx.json,
      ...(opts.vars === undefined ? {} : { vars: opts.vars }),
      ...(opts.book === undefined ? {} : { book: opts.book }),
      ...(opts.chapter === undefined ? {} : { chapter: opts.chapter }),
      ...(opts.jsTimeoutMs === undefined ? {} : { jsTimeoutMs: opts.jsTimeoutMs }),
    }), facet, usage ?? 'list')
}

/** 历史 vars 形态判别：全值 string 的对象按 vars 处理（与 opts 对象的键不重叠——vars/book/chapter/jsTimeoutMs） */
function isVarsShaped(
  v: Record<string, string> | { vars?: Record<string, string>; book?: Record<string, unknown>; chapter?: Record<string, unknown>; jsTimeoutMs?: number },
): v is Record<string, string> {
  const keys = Object.keys(v)
  return keys.length > 0 && keys.every((k) => !['vars', 'book', 'chapter', 'jsTimeoutMs'].includes(k))
}

/** 链终点不该剩节点集：带 facet 与节点数的段级错误（segmentIndex -1 = 服务层规约层） */
function nodesError(v: Extract<EngineValue, { kind: 'nodes' }>, facet: Facet): RuleEvalError {
  return new RuleEvalError('结果不是取值而是节点集', {
    facet,
    segmentIndex: -1,
    segmentRaw: '(服务层规约)',
    hits: v.nodes.length,
  })
}
