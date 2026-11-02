/**
 * 替身 fetch 的入参 → 地址读数。
 *
 * `typeof fetch` 的入参面是 `RequestInfo | URL`：测试替身只发字符串或 `URL`，但类型面不排除
 * `Request`。直接 `String(input)` 在 `Request` 上得到的是 `[object Request]`（`no-base-to-string`
 * 抓的正是这种默认字符串化），于是断言会对着一个恒定的占位串蒙对。这里按形状取一次真地址：
 * `Request` 读它的 `url`。
 *
 * 与生产侧同一口径：地址是数据，不是对象的字符串形态；取不到地址的入参在编码层就不存在
 * （`typeof fetch` 只有这三支），所以这里没有第四支、也不猜。
 */
export function requestUrlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  return input instanceof URL ? input.href : input.url
}

/**
 * 替身 fetch 收到的请求体 → 文本读数。
 *
 * `RequestInit.body` 是 `BodyInit | null`，直接 `String(...)` 会得到 `[object FormData]` 这类占位串。
 * 本仓的请求体一律是字符串（表单体在编码层就已拼成串），所以这里只认字符串：缺席读空串，
 * 别的形态说明替身与调用方脱节——抛错，不默认字符串化。
 */
export function requestBodyOf(init?: RequestInit): string {
  const body = init?.body
  if (body === null || body === undefined) return ''
  if (typeof body !== 'string') throw new Error(`替身 fetch 收到的请求体不是字符串：${Object.prototype.toString.call(body)}`)
  return body
}
