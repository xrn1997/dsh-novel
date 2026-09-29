import { decodeBody } from '../../src/services/fetcher.js'
import type { FetchedPage } from '../../src/services/fetcher.js'

/**
 * 采集侧「响应 → 落盘文本」的**唯一实现**：与生产**同一条解码链**
 * （`decodeBody`：声明 charset → content-type → `<meta>` 嗅探）。
 *
 * 为什么单独成模块并钉测试：原先这里是 `buf.toString('utf8')`——GBK 页会被存成乱码。而采集侧断言跑在
 * **真**解码链上、回放侧一律以 utf-8 提供文本，于是**采集能过、回放必红**：又一种「采集与回放断的不是
 * 同一批」（同族两例：manifest 用落地地址当键、详情面对纯 API 源过严）。存储的应当是**管线读到的那段文本**，
 * 不是「把字节当 utf-8 念一遍」。
 */
const CT_CHARSET_RE = /charset=([^;\s"']+)/i

/** 只取响应头 content-type 里的 charset 作为「声明」；其余交给 `decodeBody` 的嗅探链 */
export function declaredCharsetOf(contentType: string | undefined): string | undefined {
  return contentType === undefined ? undefined : CT_CHARSET_RE.exec(contentType)?.[1]
}

/** 采集落盘文本：与生产解码同源 */
export function recordBodyOf(raw: Buffer, finalUrl: string, contentType: string | undefined, status = 200): string {
  const page: FetchedPage = {
    raw, finalUrl, contentType, charset: undefined, status, setCookie: [],
  }
  return decodeBody(page, declaredCharsetOf(contentType))
}
