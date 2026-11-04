import { responseOf } from '../engine/host-object.js'
import { cookiesOf } from './engine-fetch.js'
import { decodeBody } from './fetcher.js'
import type { FetchedPage, Fetcher } from './fetcher.js'
import { createSourceEval, DEFAULT_JS_BUDGET_MS } from './source-eval.js'
import type { NovelSource } from './types.js'

type FetchInit = Parameters<Fetcher['fetchPage']>[1]

export const loginCheckOf = (source: NovelSource): string => {
  const raw = source.raw
  if (raw === null || typeof raw !== 'object') return ''
  const v = (raw as Record<string, unknown>).loginCheckJs
  return typeof v === 'string' ? v.trim() : ''
}

/**
 * loginCheckJs（每轮响应后跑一次，可返回替换响应）。本仓的安全子集：
 * - `result` 绑成 ResponseHost，脚本可用 `result.url()/code()/body()`；
 * - 脚本返回同一个响应对象/空值 → 保留原页；
 * - 返回新响应对象（`__host:'response'`）→ 用它替换；
 * - 返回 URL 字符串 → 重试一次。
 * 重试走传入的 raw 执行器（源请求缝内部那层：仍过限速/动态头，但不再触发 loginCheck，
 * 避免自递归）。
 */
export async function applyLoginCheck(
  fetcher: Fetcher,
  source: NovelSource,
  page: FetchedPage,
  init?: FetchInit,
  opts?: { jsTimeoutMs?: number },
): Promise<FetchedPage> {
  const code = loginCheckOf(source)
  if (code === '') return page
  // 与读面同一个声明优先级：URL 选项 charset 可能只在这里（响应头没 charset）
  const body = decodeBody(page, init?.declaredCharset)
  const outcome = await createSourceEval(fetcher, source,
    { jsTimeoutMs: opts?.jsTimeoutMs ?? DEFAULT_JS_BUDGET_MS }).runScript(code, {
    baseUrl: page.finalUrl,
    facet: 'rule',
    resultHost: responseOf({
      url: page.finalUrl,
      statusCode: page.status,
      headers: page.headers ?? {},
      cookies: cookiesOf(page.setCookie),
      body,
      // 响应描述符跨 JSON 桥进沙箱：这两格缺席即不建键（序列化后同样是丢掉 undefined）
      ...(page.contentType === undefined ? {} : { contentType: page.contentType }),
      ...(page.charset === undefined ? {} : { charset: page.charset }),
    }),
    loc: { segmentIndex: 0, segmentRaw: code },
  })
  const value = outcome.value
  if (value.kind !== 'value') return page
  const text = value.text.trim()
  if (text === '') return page

  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { parsed = undefined }
  if (parsed !== null && typeof parsed === 'object') {
    const p = parsed as {
      __host?: string; __data?: Record<string, unknown>
      url?: unknown; method?: unknown; headers?: unknown; body?: unknown
    }
    if (p.__host === 'response' && p.__data !== undefined) {
      const d = p.__data
      const newBody = scalarText(d.body) ?? body
      const newUrl = resolveRetryUrl(scalarText(d.url) ?? page.finalUrl, page.finalUrl)
      const newStatus = typeof d.statusCode === 'number' ? d.statusCode : page.status
      const newHeaders = stringRecordOf(d.headers) ?? page.headers
      const newContentType = typeof d.contentType === 'string' ? d.contentType : page.contentType
      const bodyChanged = newBody !== body
      // 只改头/地址/状态时保留原页字节与原 charset——重编码会把未改动的非 UTF-8 正文解坏。
      if (!bodyChanged && newUrl === page.finalUrl && newStatus === page.status
        && newContentType === page.contentType && sameStringRecord(newHeaders, page.headers)) return page
      return {
        raw: bodyChanged ? Buffer.from(newBody, 'utf8') : page.raw,
        finalUrl: newUrl,
        contentType: newContentType,
        charset: bodyChanged ? 'utf-8' : page.charset,
        status: newStatus,
        setCookie: bodyChanged ? [] : page.setCookie,
        ...(bodyChanged ? { replaced: true } : {}),
        ...(newHeaders === undefined ? {} : { headers: newHeaders }),
      }
    }
    if (typeof p.url === 'string' && p.__host === undefined) {
      // 计划里的重试描述符 `{ url, method, headers, body }`：头与提供 init 合并（脚本后写占优），
      // 方法/体按脚本声明；未声明则沿用原请求的姿态。
      const next: NonNullable<FetchInit> = { ...(init ?? {}) }
      if (typeof p.method === 'string') next.method = p.method
      if (typeof p.body === 'string') next.body = p.body
      const extraHeaders = stringRecordOf(p.headers)
      if (extraHeaders !== undefined) next.headers = { ...(init?.headers ?? {}), ...extraHeaders }
      return fetcher.fetchPage(resolveRetryUrl(p.url, page.finalUrl), next)
    }
  }
  if (/^https?:\/\//i.test(text) || text.startsWith('/') || text.startsWith('./') || text.startsWith('../')) {
    return fetcher.fetchPage(resolveRetryUrl(text, page.finalUrl), init)
  }
  return page
}

/** 重试地址的宽松解析：解析失败回原文交给 fetcher 抛。这不是通用 URL 绝对化——通用面的
 *  唯一实现是 `services/url.ts` 的 `absUrl`（失败 null、拒绝 javascript:/空白）；这里允许
 *  raw 回落是重试语义：脚本给的地址原样交给守门 fetcher，由它给出真实错误。 */
function resolveRetryUrl(raw: string, base: string): string {
  try { return new URL(raw, base).toString() } catch { return raw }
}

/** JSON 标量 → 文本（与 `String()` 同口径：字符串原样、数字/布尔按字面、null 成字）。对象与数组
 *  不在这条转换里：`String()` 在它们身上只会给出一句 "[object Object]"，那是垃圾不是正文或地址，
 *  按「这一格没给」处理比把垃圾喂给下游诚实。 */
function scalarText(v: unknown): string | undefined {
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (v === null) return 'null'
  return undefined
}

/** 重试描述符里的 headers：只收字符串值；空表视为未声明（不覆盖原请求头）。 */
function stringRecordOf(v: unknown): Record<string, string> | undefined {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return undefined
  const out: Record<string, string> = {}
  for (const [k, val] of Object.entries(v)) if (typeof val === 'string') out[k] = val
  return Object.keys(out).length === 0 ? undefined : out
}

function sameStringRecord(a: Record<string, string> | undefined, b: Record<string, string> | undefined): boolean {
  // 缺席即空表：两侧都缺席时两把键集都是空的，走同一条「相等」出口
  const left = a ?? {}
  const right = b ?? {}
  const ak = Object.keys(left)
  const bk = Object.keys(right)
  if (ak.length !== bk.length) return false
  return ak.every((k) => Object.prototype.hasOwnProperty.call(right, k) && left[k] === right[k])
}
