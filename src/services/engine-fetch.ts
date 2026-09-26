import { decodeBody } from './fetcher.js'
import type { Fetcher } from './fetcher.js'
import { assembleRequest, fetchInitOf } from './request.js'

/** 请求头输入双形态：静态表（绝大多数源）| 惰性 provider（`@js` 动态头——每次请求前现算，
 *  头规则每请求求值一次，device-id 逐请求刷新）。 */
export type HeadersInput = Record<string, string> | (() => Promise<Record<string, string>>)

async function resolveHeadersInput(headers: HeadersInput): Promise<Record<string, string>> {
  return typeof headers === 'function' ? await headers() : headers
}

/**
 * 引擎 EvalContext.fetch 守门注入：@js 里的 java.ajax 也走守门抓取 + 解码链。
 * java.ajax 的 URL 可带 `url,{json}` 请求选项——
 * 不解析的话整串（含 `,{...}`）被当 URL 发出，站点直接 403/404（实测 wcxsw 源：
 * 脚本拼 `search.php,{'body':...}` 传给 java.ajax，我们原样 fetch → 403）。
 *
 * 请求语义不再自持一份：选项解释 / POST 表单默认头 / init 姿态全部走 assembleRequest + fetchInitOf
 * （此前这里手写一遍「与 buildSearchRequest 同口径」——注释同步的分叉，现已收口）。
 * 本模块只负责「源级 header 打底 + 解码」这两件引擎桥特有的事；落地地址（finalUrl）随数据面透出——
 * 脚本经 `java.connect(u).raw().request().url()` 取的就是它（`raw()` 与 `url()` 同值，都指
 * **跟随重定向后的末次请求**地址；缺失时由桥按请求地址兜底）。
 */
export function engineFetch(
  fetcher: Fetcher, headers: HeadersInput, vars?: Record<string, string | number>,
): (url: string) => Promise<{ body: string; contentType?: string; finalUrl: string }> {
  return async (rawUrl) => {
    // baseUrl = null：java.ajax 的 URL 由脚本自己拼好，不做绝对化（与原实现一致）
    const plan = assembleRequest(rawUrl, vars ?? {}, null)
    const page = await fetcher.fetchPage(plan.url, fetchInitOf(plan, await resolveHeadersInput(headers)))
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
  url: string; body: string; contentType?: string; statusCode: number; cookies: Record<string, string>
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
      statusCode: page.status,
      // `java.post(...).cookies()` 的返回值 = 响应 cookie 表（name → value）；
      // 取每条 Set-Cookie 的第一个 `;` 前段
      cookies: Object.fromEntries(page.setCookie.map(h => h.split(';')[0]).map(p => {
        const i = p.indexOf('=')
        return i < 0 ? [p, ''] : [p.slice(0, i), p.slice(i + 1)]
      })),
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
