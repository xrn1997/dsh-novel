import { decodeBody } from './fetcher.js'
import type { Fetcher } from './fetcher.js'
import { assembleRequest, fetchInitOf } from './request.js'

/** 请求头输入双形态：静态表（绝大多数源）| 惰性 provider（`@js` 动态头——每次请求前现算，
 *  头规则每请求求值一次，device-id 逐请求刷新）。 */
export type HeadersInput = Record<string, string> | (() => Promise<Record<string, string>>)

async function resolveHeadersInput(headers: HeadersInput): Promise<Record<string, string>> {
  return typeof headers === 'function' ? await headers() : headers
}

/** `Set-Cookie` 列表 → name→value 表（取每条第一个 `;` 前段）。post/get 共用。 */
export function cookiesOf(setCookie: string[]): Record<string, string> {
  return Object.fromEntries(setCookie.map(h => h.split(';')[0]).map(p => {
    const i = p.indexOf('=')
    return i < 0 ? [p, ''] : [p.slice(0, i), p.slice(i + 1)]
  }))
}

/**
 * 引擎 EvalContext.fetch 守门注入：@js 里的 java.ajax 也走守门抓取 + 解码链。
 * java.ajax 的 URL 可带 `url,{json}` 请求选项——
 * 不解析的话整串（含 `,{...}`）被当 URL 发出，站点直接 403/404（脚本拼
 * `search.php,{'body':...}` 形态实证）。
 *
 * 请求语义不再自持一份：选项解释 / POST 表单默认头 / init 姿态全部走 assembleRequest + fetchInitOf
 * （此前这里手写一遍「与 buildSearchRequest 同口径」——注释同步的分叉，现已收口）。
 * 本模块只负责「源级 header 打底 + 解码」这两件引擎桥特有的事；落地地址（finalUrl）随数据面透出——
 * 脚本经 `java.connect(u).raw().request().url()` 取的就是它（`raw()` 与 `url()` 同值，都指
 * **跟随重定向后的末次请求**地址；缺失时由桥按请求地址兜底）。
 */
export function engineFetch(
  fetcher: Fetcher, headers: HeadersInput, vars?: Record<string, string | number>,
): (url: string, hdrs?: Record<string, string>) => Promise<{ body: string; contentType?: string; finalUrl: string }> {
  return async (rawUrl, hdrs) => {
    // baseUrl = null：java.ajax 的 URL 由脚本自己拼好，不做绝对化（与原实现一致）
    const plan = assembleRequest(rawUrl, vars ?? {}, null)
    const page = await fetcher.fetchPage(
      plan.url,
      fetchInitOf({ ...plan, headers: { ...plan.headers, ...(hdrs ?? {}) } }, await resolveHeadersInput(headers)),
    )
    return { body: decodeBody(page, plan.charset), contentType: page.contentType, finalUrl: page.finalUrl }
  }
}

/** `java.post(url, body, headers)` 的引擎桥（脚本以 POST 发请求、拿响应对象；口径与书源请求一致）。
 *  请求语义仍走 assembleRequest + fetchInitOf（与 engineFetch 同一份，不自持第二套）；只有三件事不同：
 *  方法恒为 POST、body 由脚本给、脚本那三份 header **叠在源级头之上**（同名后者覆盖）。
 *  返回的是 Response 的**数据面**——`res.body()` / `res.cookies()` 那层方法壳在沙箱 BOOTSTRAP 里包
 *  （宿主桥只走 JSON 序列化边界，不跨边界传函数）。 */
export function engineFetchPost(
  fetcher: Fetcher, headers: HeadersInput, vars?: Record<string, string | number>,
): (url: string, body: string, hdrs?: Record<string, string>) => Promise<{
  url: string; body: string; contentType?: string; charset?: string; statusCode: number
  headers: Record<string, string>; cookies: Record<string, string>
}> {
  return async (rawUrl, body, hdrs) => {
    const plan = assembleRequest(rawUrl, vars ?? {}, null)
    const init = fetchInitOf(
      { ...plan, method: 'POST', body, headers: { ...plan.headers, ...(hdrs ?? {}) } },
      await resolveHeadersInput(headers),
    )
    const page = await fetcher.fetchPage(plan.url, init)
    return {
      url: page.finalUrl,
      body: decodeBody(page, plan.charset),
      contentType: page.contentType,
      charset: page.charset,
      statusCode: page.status,
      headers: page.headers ?? {},
      // `java.post(...).cookies()` 的返回值 = 响应 cookie 表（name → value）
      cookies: cookiesOf(page.setCookie),
    }
  }
}

/** `java.net.URL.openConnection` 的引擎桥：跟重定向、可 GET/POST，返回原始字节与响应头。
 *  安全重开裁决：请求仍走 assembleRequest + fetchInitOf 与同一守门 fetcher，不开裸 socket。 */
export function engineFetchConn(
  fetcher: Fetcher, headers: HeadersInput, vars?: Record<string, string | number>,
): (req: { url: string; method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  url: string; statusCode: number; headers: Record<string, string>; cookies: Record<string, string>; body: Uint8Array
}> {
  return async (req) => {
    const plan = assembleRequest(req.url, vars ?? {}, null)
    const rawMethod = (req.method === undefined || req.method === '' ? 'GET' : req.method).toUpperCase()
    // 不认识的请求方法**点名**：把 PUT/DELETE 静默降成 GET 等于悄悄改用户意图（与「宁炸不猜」相反）。
    if (rawMethod !== 'GET' && rawMethod !== 'POST' && rawMethod !== 'HEAD') {
      throw new Error(`URLConnection 不支持的请求方法：${rawMethod}（本仓只接 GET/POST/HEAD）`)
    }
    const method = rawMethod
    const init = fetchInitOf(
      {
        ...plan, method,
        ...(req.body === undefined ? {} : { body: req.body }),
        headers: { ...plan.headers, ...(req.headers ?? {}) },
      },
      await resolveHeadersInput(headers),
    )
    const page = await fetcher.fetchPage(plan.url, init)
    return {
      url: page.finalUrl,
      statusCode: page.status,
      headers: page.headers ?? {},
      cookies: cookiesOf(page.setCookie),
      body: page.raw,
    }
  }
}

/** `java.get(url, headers)` 的引擎桥：GET + **不跟重定向**（上游 `JsExtensions.get` 的
 *  `followRedirects(false)`），返回 jsoup Connection.Response 的数据面。与 `java.head` 的
 * `manual` 不同，这里仍按 jsoup `execute()` 的口径让 >=400 抛错（3xx 原样返回）。
 * 请求语义仍走 assembleRequest + fetchInitOf，与 ajax/post/head 同一守门 fetcher。 */
export function engineFetchGet(
  fetcher: Fetcher, headers: HeadersInput, vars?: Record<string, string | number>,
): (url: string, hdrs?: Record<string, string>) => Promise<{
  url: string; body: string; contentType?: string; charset?: string; statusCode: number
  headers: Record<string, string>; cookies: Record<string, string>
}> {
  return async (rawUrl, hdrs) => {
    const plan = assembleRequest(rawUrl, vars ?? {}, null)
    const init = fetchInitOf(
      { ...plan, method: 'GET', headers: { ...plan.headers, ...(hdrs ?? {}) } },
      await resolveHeadersInput(headers),
    )
    const page = await fetcher.fetchPage(plan.url, { ...init, noFollow: true })
    return {
      url: page.finalUrl,
      body: decodeBody(page, plan.charset),
      contentType: page.contentType,
      charset: page.charset,
      statusCode: page.status,
      headers: page.headers ?? {},
      cookies: cookiesOf(page.setCookie),
    }
  }
}

/** 二进制抓取桥（`java.downloadFile` 用）：与 engineFetch 同请求语义（选项/头/守门），
 *  但**不解码**——返回原始字节（PNG 密钥图经字符集解码链会直接损坏字节）。
 *  baseUrl = null 同 engineFetch（URL 由脚本拼好）。 */
export function engineFetchRaw(
  fetcher: Fetcher, headers: HeadersInput, vars?: Record<string, string | number>,
): (url: string) => Promise<Uint8Array> {
  return async (rawUrl) => {
    const plan = assembleRequest(rawUrl, vars ?? {}, null)
    const page = await fetcher.fetchPage(plan.url, fetchInitOf(plan, await resolveHeadersInput(headers)))
    return page.raw
  }
}

/** `java.head(url, headers)` 的引擎桥：HEAD + **不跟重定向**（对面 followRedirects(false)——
 *  脚本读 3xx 的 Location/x-origin-url 取图片直链）。请求语义仍走 assembleRequest + fetchInitOf；
 *  fetcher 以 manual 姿态放行非 2xx（要探的就是状态与响应头本身）。 */
export function engineFetchHead(
  fetcher: Fetcher, headers: HeadersInput, vars?: Record<string, string | number>,
): (url: string, hdrs?: Record<string, string>) => Promise<{
  url: string; statusCode: number; headers: Record<string, string>; cookies: Record<string, string>
}> {
  return async (rawUrl, hdrs) => {
    const plan = assembleRequest(rawUrl, vars ?? {}, null)
    const init = fetchInitOf(
      { ...plan, method: 'HEAD', headers: { ...plan.headers, ...(hdrs ?? {}) } },
      await resolveHeadersInput(headers),
    )
    const page = await fetcher.fetchPage(plan.url, { ...init, manual: true })
    return {
      url: page.finalUrl, statusCode: page.status, headers: page.headers ?? {},
      cookies: cookiesOf(page.setCookie),
    }
  }
}
