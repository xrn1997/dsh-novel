import http from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ReadingService } from '../../src/services/reading.js'
import { createApiHandler } from '../../src/api/dispatch.js'
import type { ApiHandlerOptions } from '../../src/api/dispatch.js'
import type { ApiEnvelope, ApiErrorBody } from '../../src/shared/wire.js'

/** 起真 http.Server（127.0.0.1:0）承载 dispatch——忠实覆盖 Node 原生 req/res 语义 */
export async function startServer(service: ReadingService, opts?: ApiHandlerOptions): Promise<{ base: string; close: () => Promise<void> }> {
  const handler = createApiHandler(service, opts)
  const server = http.createServer((req, res) => {
    void handler(req, res).catch(() => { /* handler 内部已 writeError 兜底 */ })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

/**
 * `Response.json()` 的 `any` 只在这三处落地：路由回包一律是统一信封（`ApiEnvelope`），
 * 形状判形一次，用例侧就只跟具体 payload 类型打交道，不再一路 `as any` 往下传。
 */
export async function envelopeOf<T>(res: Response): Promise<ApiEnvelope<T>> {
  return (await res.json()) as ApiEnvelope<T>
}

/** 成功信封的 value：缺席即回包与用例脱节，响亮失败而不是让下游 undefined 蒙对。 */
export async function valueOf<T>(res: Response): Promise<T> {
  const env = await envelopeOf<T>(res)
  if (env.value === undefined) throw new Error(`回包不是成功信封（ok=${String(env.ok)}）`)
  return env.value
}

/** 失败信封的 error：成功信封走这条即用例与契约脱节。 */
export async function errorOf(res: Response): Promise<ApiErrorBody> {
  const env = await envelopeOf<unknown>(res)
  if (env.error === undefined) throw new Error('回包不是错误信封')
  return env.error
}

/** 抓取替身的入参判形；实现与 services 面共用同一份。 */
export { requestUrlOf as requestUrl } from '../support/fetch-input.js'
