import type { SourceRequest } from '../../src/services/source-request.js'
import { decodeBody, fetchTextPage } from '../../src/services/fetcher.js'
import type { Fetcher } from '../../src/services/fetcher.js'
import { fetchInitOf } from '../../src/services/request.js'

/** 测试适配器：不跑限速/动态头解析；仍走 fetchTextPage/decodeBody 解码 */
export function fakeSourceRequest(fetcher: Fetcher): SourceRequest {
  return {
    fetcherFor: () => fetcher,
    async fetchText(_source, plan, opts) {
      const init = { ...fetchInitOf(plan), ...(opts?.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }) }
      const { text, landedUrl } = await fetchTextPage(fetcher, plan.url, init, plan.charset)
      return { text, landedUrl }
    },
    async fetchPage(_source, plan, opts) {
      const init = { ...fetchInitOf(plan), ...(opts?.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }) }
      const page = await fetcher.fetchPage(plan.url, init)
      return { url: page.finalUrl, requestedUrl: plan.url, body: decodeBody(page, plan.charset) }
    },
  }
}
