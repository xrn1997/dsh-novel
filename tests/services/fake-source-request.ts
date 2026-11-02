import type { Fetcher } from '../../src/services/fetcher.js'
import { CookieJar } from '../../src/services/cookies.js'
import { RateLimiter } from '../../src/services/rate-limit.js'
import { createSourceRequest } from '../../src/services/source-request.js'
import type { SourceRequest } from '../../src/services/source-request.js'

/** 测试适配器 = 真缝 + 注入的零等待限速器；charset / 解码 / 上/下行头等口径不再由假件私持。
 *  浏览器入口在本假件里不可用（测试不起真浏览器）：调用即点名抛错。 */
export function fakeSourceRequest(fetcher: Fetcher): SourceRequest {
  return createSourceRequest({
    fetcher,
    webview: {
      fetch: async () => { throw new Error('测试假件不提供浏览器') },
    },
    cookieJar: fetcher.cookieJar ?? new CookieJar(),
    jsTimeoutMs: () => 1000,
    rateLimiterFor: () => new RateLimiter(null),
  })
}
