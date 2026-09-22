import type { IncomingMessage, ServerResponse } from 'node:http'
import { EngineError } from '../engine/index.js'
import { classify } from '../services/errors.js'
import type { ErrorCategory } from '../services/errors.js'

/** 统一失败信封的 error 载荷（成功信封 `{ ok: true, value }` 由 writeOk 落地）。
 *  形状定义在 wire 契约（src/shared/wire.ts）；此处 re-export 保持 import 路径可用。
 *  现状真相与口径：docs/design/services.md。 */
export type { ApiErrorBody, ApiEnvelope } from '../shared/wire.js'
import type { ApiErrorBody } from '../shared/wire.js'

/** 路由层自检/内部抛出的带状态错误；name 固定为构造名（子类继承也正确） */
export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly segment?: ApiErrorBody['segment']
  constructor(message: string, status: number, code: string, segment?: ApiErrorBody['segment']) {
    super(message)
    this.name = new.target.name
    this.status = status
    this.code = code
    this.segment = segment
  }
}

/**
 * 同源 fence：仅放行 loopback 且（无 referer 或 referer 与 host 同源）且（无 origin 或 origin 与 host
 * 同源）的请求。
 * 显式取舍：**无 referer / 无 origin** 放行，是为了本机工具 / curl 能直接用（注释即此承诺）。
 * 看 origin 而不只看 referer 的理由（安全）：恶意页 `<meta name="referrer" content="no-referrer">`
 * 可让 Referer 缺席，但浏览器对跨源 POST **总是**发 Origin——所以「Origin 存在且跨源」必须拒，
 * 否则 `content-type: text/plain` 的 simple POST（不触发 preflight）可 CSRF 打 import/batch/auth。
 */
export function isTrustedRequest(req: Pick<IncomingMessage, 'headers' | 'socket'>): boolean {
  const remote = req.socket.remoteAddress ?? ''
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) return false
  const host = req.headers.host
  const origin = req.headers.origin
  if (origin !== undefined) {                       // Origin 在场 → 必须同源（curl 不发起源头）
    try { if (new URL(origin).host !== host) return false } catch { return false }
  }
  const referer = req.headers.referer
  if (referer === undefined) return true            // 无 referer：本机工具/curl 合法
  try { return new URL(referer).host === host } catch { return false }
}

/**
 * 聚合请求体为 JSON。空 body → fallback；超限 → 413；非法 JSON → 400。
 * 钉死：超限只 throw 不 destroy（destroy 会断 PassThrough 流）。
 */
export async function readJsonBody<T>(req: IncomingMessage, fallback: T, maxBytes = 1024 * 1024): Promise<T> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    size += buf.length
    if (size > maxBytes) throw new ApiError(`body 超过 ${maxBytes} 字节上限`, 413, 'PayloadTooLarge')
    chunks.push(buf)
  }
  if (chunks.length === 0) return fallback
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return fallback
  try {
    return JSON.parse(text) as T
  } catch (e) {
    throw new ApiError(`body 不是合法 JSON: ${e instanceof Error ? e.message : String(e)}`, 400, 'BadRequest')
  }
}

export function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/** 200 成功信封 */
export function writeOk(res: ServerResponse, value: unknown): void {
  writeJson(res, 200, { ok: true, value })
}

/** 错误单点映射后落失败信封 */
export function writeError(res: ServerResponse, e: unknown): void {
  const { status, body } = errorStatusOf(e)
  writeJson(res, status, { ok: false, error: body })
}

/**
 * 错误状态映射：classify 的 HTTP 投影——**domain 错误**的类目 → 状态/错误码的表在此一处。
 * 真实口径是**两分法**（不是「状态映射只许一处」）：
 *   ① domain/引擎错误：类 → ErrorCategory（services/errors.classify）→ 本表 → 状态码/错误码；
 *   ② 路由层自检错误：`ApiError(message, status, code)` **自带 status/code、不进分类学**，直通
 *      （方法不允许 405、未知路由 404、body 校验 400、非受信来源 403…）。
 * 引擎三类带 segment；不做文案前缀匹配——分类权在类型上，不在中文句子上。
 * 路由侧不允许再 inline `writeJson(res, <状态码>, …)`（那会成为第三面）：一律走 ApiError。
 */
const STATUS_OF: Record<ErrorCategory, { status: number; code: string }> = {
  'rule-eval': { status: 422, code: '' },        // code 用 e.name（引擎类名即 wire 错误码）
  'rule-missing': { status: 422, code: 'RuleMissing' },
  fetch: { status: 502, code: '' },              // code 用 e.name（FetchError/DecodeError）
  'not-found': { status: 404, code: 'NotFound' },
  'bad-request': { status: 400, code: 'BadRequest' },
  // 收进本表的三路由侧映射：本地导入两态 / 本地未挂载 / 任务互斥
  'local-import': { status: 400, code: 'BadRequest' },
  'local-too-large': { status: 413, code: 'PayloadTooLarge' },
  unavailable: { status: 503, code: 'Unavailable' },
  'job-running': { status: 409, code: 'JobRunning' },
  other: { status: 500, code: 'InternalError' },
}

export function errorStatusOf(e: unknown): { status: number; body: ApiErrorBody } {
  if (e instanceof ApiError) {
    const body: ApiErrorBody = { code: e.code, message: e.message }
    if (e.segment !== undefined) body.segment = e.segment
    return { status: e.status, body }
  }
  const message = e instanceof Error ? e.message : String(e)
  const { status, code } = STATUS_OF[classify(e)]
  const body: ApiErrorBody = { code: code === '' ? (e instanceof Error ? e.name : 'InternalError') : code, message }
  if (e instanceof EngineError) {
    body.segment = { facet: e.facet, segmentIndex: e.segmentIndex, segmentRaw: e.segmentRaw }
  }
  return { status, body }
}
