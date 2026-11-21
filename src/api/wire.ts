import type { IncomingMessage, ServerResponse } from 'node:http'
import { EngineError } from '../engine/index.js'
import { classify } from '../services/errors.js'
import type { ErrorCategory } from '../services/errors.js'

/** 失败信封的 error 载荷；形状住 wire 契约（`src/shared/wire.ts`），此处 re-export 保持导入路径。 */
export type { ApiErrorBody, ApiEnvelope } from '../shared/wire.js'
import type { ApiErrorBody } from '../shared/wire.js'

/** 路由层自检/内部错误的带状态错误：不进分类学，`errorStatusOf` 直通 status/code。 */
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
 * 同源 fence：远端 loopback + Host 在本机名单 +（若有）Origin / Referer 与 Host 同源才放行。
 * 无 Origin / Referer 放行是给本机工具与 curl 的承诺；跨源 POST 必带 Origin，故 Origin 在场必须同源，
 * 否则 `text/plain` 的 simple POST 就能 CSRF。Host 先钉：DNS rebinding 下攻击者域名也满足 loopback 与同源。
 * `apiAllowHosts` 是自定义域名的逃生口——每个追加名都是在那个域上让掉 rebinding 防线。
 */
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]'])

/** fence 拒绝的步骤（路由层据此翻 403 措辞）；判据只住 `fenceDenialOf`。 */
export type FenceDenial = 'remote' | 'host' | 'origin' | 'referer'

/** 已归一名单（`fenceAllowlist` 的产物）或原始配置项。 */
export type FenceAllowHosts = readonly string[] | ReadonlySet<string>

export interface FenceOptions {
  /** 配置 `apiAllowHosts` 追加的本机别名（只比主机名，大小写归一、端口剥掉）；传 Set = 已算好的名单，构造期一次、逐请求复用。 */
  allowHosts?: FenceAllowHosts
}

/**
 * Host → 可比对主机名，只认「URL 解析不改写」的写法（配置校验与 fence 共用这一把尺）。
 * `2130706433` / `0x7f000001` 会被 WHATWG 归成 `127.0.0.1`，放行等于给 rebinding 开后门；
 * 端口合法（`localhost:80` 与 `localhost` 同源），但解析结果与原文不同即判不可信。
 */
export function hostNameOf(host: string): string | null {
  let url: URL
  try { url = new URL(`http://${host}`) } catch { return null }
  const name = url.hostname.toLowerCase()
  if (name === '') return null
  const withoutPort = url.port !== ''
    ? host.slice(0, host.length - url.port.length - 1)
    : host.replace(/:80$/i, '')                       // 默认端口不进 url.port，但合法的 Host 会带着它
  return withoutPort.toLowerCase() === name ? name : null
}

/** Host 无 scheme，`:80` / `:443` 都可能是该连接默认端口的写法，故都按缺席归一；Origin / Referer 带 scheme，只折算该 scheme 的默认端口。 */
function hostKeyOf(host: string): string {
  const url = new URL(`http://${host}`)
  const port = url.port === '' || url.port === '80' || url.port === '443' ? '' : `:${url.port}`
  return `${url.hostname.toLowerCase()}${port}`
}

/** 同源比对键：主机名 + 端口（URL 已按 scheme 折算默认端口）。 */
function originKeyOf(url: URL): string {
  return `${url.hostname.toLowerCase()}${url.port === '' ? '' : `:${url.port}`}`
}

/** 本机名单 = 缺省三值 + 配置追加；传 Set 则直接复用。脏配置按「解析不出就丢」——fence 是最后一道闸，不因一条脏配置整体放行。 */
export function fenceAllowlist(extra?: FenceAllowHosts): ReadonlySet<string> {
  if (extra instanceof Set) return extra
  const allow = new Set(LOOPBACK_HOSTNAMES)
  if (!Array.isArray(extra)) return allow
  for (const entry of extra) {
    if (typeof entry !== 'string') continue
    const name = hostNameOf(entry)
    if (name !== null) allow.add(name)
  }
  return allow
}

/** 这一发为何不被信任（`null` = 放行）；顺序即判据顺序。 */
export function fenceDenialOf(
  req: Pick<IncomingMessage, 'headers' | 'socket'>, opts: FenceOptions = {},
): FenceDenial | null {
  const remote = req.socket.remoteAddress ?? ''
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) return 'remote'
  const host = req.headers.host
  if (host === undefined) return 'host'
  const hostname = hostNameOf(host)
  if (hostname === null || !fenceAllowlist(opts.allowHosts).has(hostname)) return 'host'
  const hostKey = hostKeyOf(host)
  const origin = req.headers.origin
  if (origin !== undefined) {                       // Origin 在场 → 必须同源（curl 不发起源头）
    try { if (originKeyOf(new URL(origin)) !== hostKey) return 'origin' } catch { return 'origin' }
  }
  const referer = req.headers.referer
  if (referer === undefined) return null            // 无 referer：本机工具/curl 合法
  try { return originKeyOf(new URL(referer)) === hostKey ? null : 'referer' } catch { return 'referer' }
}

export function isTrustedRequest(
  req: Pick<IncomingMessage, 'headers' | 'socket'>, opts: FenceOptions = {},
): boolean {
  return fenceDenialOf(req, opts) === null
}

/** JSON 信封体字节上限（唯一主人）：调用方要放宽就传参。 */
export const DEFAULT_JSON_BODY_MAX_BYTES = 1024 * 1024

/**
 * 带上限的流式读 body：两份字节上限逻辑的唯一实现（JSON 信封体与本地导入共用）。
 * 超限抛 413；`overMessage` 归调用方（两处措辞不同）。超限只 throw 不 destroy（destroy 会断流）。
 */
export async function readCappedBody(
  req: IncomingMessage, maxBytes: number, overMessage: (max: number) => string,
): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    size += buf.length
    if (size > maxBytes) throw new ApiError(overMessage(maxBytes), 413, 'PayloadTooLarge')
    chunks.push(buf)
  }
  return Buffer.concat(chunks)
}

/** 空 body → fallback；超限 → 413；非法 JSON → 400。流读与上限归 `readCappedBody`。 */
export async function readJsonBody<T>(req: IncomingMessage, fallback: T, maxBytes = DEFAULT_JSON_BODY_MAX_BYTES): Promise<T> {
  const text = (await readCappedBody(req, maxBytes, (max) => `body 超过 ${max} 字节上限`)).toString('utf8').trim()
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

export function writeOk(res: ServerResponse, value: unknown): void {
  writeJson(res, 200, { ok: true, value })
}

export function writeError(res: ServerResponse, e: unknown): void {
  const { status, body } = errorStatusOf(e)
  writeJson(res, status, { ok: false, error: body })
}

/**
 * 错误 → HTTP 投影的两分法：domain 错误经 `classify` 查本表；`ApiError` 自带 status/code 直通。
 * 路由侧一律走 ApiError，不再 inline `writeJson` 硬编状态码。
 */
const STATUS_OF: Record<ErrorCategory, { status: number; code: string }> = {
  'rule-eval': { status: 422, code: '' },        // code 用 e.name（引擎类名即 wire 错误码）
  'rule-missing': { status: 422, code: 'RuleMissing' },
  fetch: { status: 502, code: '' },              // code 用 e.name（FetchError/DecodeError）
  'not-found': { status: 404, code: 'NotFound' },
  'bad-request': { status: 400, code: 'BadRequest' },
  // 三条路由侧映射也收进本表：本地导入两态 / 本地未挂载 / 任务互斥
  'local-import': { status: 400, code: 'BadRequest' },
  'local-too-large': { status: 413, code: 'PayloadTooLarge' },
  unavailable: { status: 503, code: 'Unavailable' },
  'job-running': { status: 409, code: 'JobRunning' },
  // 段合成三分档：引擎缺席 400（调用方选择），上游失败 / 坏响应 502（网关问题）。
  // code 原样带 TTS_*（不是类名）——给真链路脚本 / curl / 诊断面一个「换引擎」还是「稍后再试」的判据；
  // 播放层不看它，单段失败在那一层统一跳过留痕（client/tts/listen-session.ts），错误码只到 HTTP 面为止。
  'tts-engine-missing': { status: 400, code: 'TTS_ENGINE_MISSING' },
  'tts-engine-unavailable': { status: 503, code: 'TTS_ENGINE_UNAVAILABLE' },
  'tts-upstream': { status: 502, code: 'TTS_UPSTREAM' },
  'tts-bad-response': { status: 502, code: 'TTS_BAD_RESPONSE' },
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
