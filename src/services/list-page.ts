import { listContextsOf } from './bridge.js'
import type { ItemContext, SubRuleEval } from './bridge.js'
import { buildSearchRequest } from './request.js'
import { createSourceEval, DEFAULT_JS_BUDGET_MS } from './source-eval.js'
import type { SourceEval } from './source-eval.js'
import type { SourceRequest } from './source-request.js'
import type { NovelSource } from './types.js'

/**
 * 「读一页条目」：搜索面与发现面同构的那一段——建一次源级求值器 → 组装请求 → 抓取解码 →
 * 列表规则求值。两面只交模板、变量、首页裁页与列表规则；模板怎么来、缺哪条算规则缺失、
 * 抓完怎么解释（详情页嗅探 / 找书地址）仍归各自的面，不是本模块的事。
 *
 * 求值器随结果交回：搜索面的详情形态要用**同一个**求值器另绑 `book`（详情规则常引用 `book.bookUrl`），
 * 抓取与列表求值用的仍是它未绑定的那一份。
 *
 * 抓取（`fetchListPage`）与列表求值（`evalListRule`）分两步收，合体是 `readListPage`：搜索面的详情
 * 嗅探要用落地地址判「命中即详情页、**列表规则根本不参与**」——判定必须在抓取之后、列表求值**之前**，
 * 求值时机因此归调用面（先求值再丢结果会让列表规则的炸点与 @js 外呼泄漏到详情之路上）。
 */
export interface ListPageRequest {
  template: string
  vars: Record<string, string | number>
  /** 首页裁页语义（`request.assembleRequest` 是唯一判据） */
  trimFirstPage: boolean
  timeoutMs?: number
  jsTimeoutMs?: number
  signal?: AbortSignal
}

/** 抓取半段：求值器与整段原文都交给面，列表规则求值与否由面按自己的判据定。 */
export interface ListPageFetch {
  /** 实际落地地址：相对链接与规则求值一律以它为基准（浏览器语义） */
  landedUrl: string
  /** 请求地址（未跟随重定向）：判「跳转过」比的是这一格 */
  requestUrl: string
  /** 整段响应原文（详情形态与字段求值用） */
  text: string
  evalr: SourceEval
  /** 列表求值用的那一份（未绑 book）；详情形态请从 `evalr` 另取 */
  subEval: SubRuleEval
}

export interface ListPageRead extends ListPageFetch {
  contexts: ItemContext[]
}

/** 连列表规则一起读的形态：`listRule: null` = 调用方已判过「列表规则缺失」，按空列表读（空规则不是失败）。 */
export interface ListPageReadRequest extends ListPageRequest {
  listRule: string | null
}

export async function fetchListPage(
  source: NovelSource, request: SourceRequest, page: ListPageRequest,
): Promise<ListPageFetch> {
  // 脚本出站也走源级外观：拿基础 fetcher 会让模板里的 @js 请求绕过限速（见 source-request 的头条裁决）
  const evalr = createSourceEval(request.fetcherFor(source), source,
    { jsTimeoutMs: page.jsTimeoutMs ?? DEFAULT_JS_BUDGET_MS })
  const plan = buildSearchRequest(page.template, page.vars, source.baseUrl,
    { trimFirstPage: page.trimFirstPage })
  const { text, landedUrl } = await request.fetchText(source, plan, {
    ...(page.timeoutMs === undefined ? {} : { timeoutMs: page.timeoutMs }),
    ...(page.signal === undefined ? {} : { signal: page.signal }),
  })
  const subEval = evalr.subEval()
  return { landedUrl, requestUrl: plan.url, text, evalr, subEval }
}

/** 列表规则求值（`fetchListPage` 的下游）：空规则求值即空列表，不是失败。 */
export async function evalListRule(fetch: ListPageFetch, listRule: string | null): Promise<ItemContext[]> {
  return listRule === null
    ? []
    : await listContextsOf(fetch.subEval, listRule, { html: fetch.text, baseUrl: fetch.landedUrl }, 'search')
}

export async function readListPage(
  source: NovelSource, request: SourceRequest, page: ListPageReadRequest,
): Promise<ListPageRead> {
  const fetch = await fetchListPage(source, request, page)
  return { ...fetch, contexts: await evalListRule(fetch, page.listRule) }
}
