import type { IncomingMessage, ServerResponse } from 'node:http'
import { EngineError } from '../engine/index.js'
import { classify } from '../services/errors.js'
import type { ErrorCategory } from '../services/errors.js'

/** 统一失败信封的 error 载荷（成功信封 `{ ok: true, value }` 由 writeOk 落地）。
 *  形状定义在 wire 契约（src/shared/wire.ts）；此处 re-export 保持 import 路径可用。 */
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
 * 同源 fence：仅放行 **远端是 loopback** 且 **Host 在本机名单里** 且（无 referer 或 referer 与 host
 * 同源）且（无 origin 或 origin 与 host 同源）的请求。
 * 显式取舍：**无 referer / 无 origin** 放行，是为了本机工具 / curl 能直接用（注释即此承诺）。
 * 看 origin 而不只看 referer 的理由（安全）：恶意页 `<meta name="referrer" content="no-referrer">`
 * 可让 Referer 缺席，但浏览器对跨源 POST **总是**发 Origin——所以「Origin 存在且跨源」必须拒，
 * 否则 `content-type: text/plain` 的 simple POST（不触发 preflight）可 CSRF 打 import/batch/auth。
 * 先钉 Host 的理由（安全）：DNS rebinding 下攻击者域名的 A 记录指向 127.0.0.1，远端是 loopback、
 * Origin 与 Host 又天然同源——只比同源等于没设防。Host 默认只可能是本机名单（浏览器半走根相对
 * 同源 fetch），不是就拒。
 * 逃生口（代价照实记）：用自定义域名打开面板的人会被这条名单拒之门外（`dsh.local → 127.0.0.1`
 * 与攻击者的域名在结构上无法区分），所以名单可由配置 `apiAllowHosts` 追加。**加进去的每一个名字
 * 都是把 rebinding 防线在那个域名上让掉**——只填自己控制的名字。
 */
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]'])

/** fence 拒绝的那一步（给路由层翻成可行动的 403 措辞用；判据只有 `fenceDenialOf` 一处）。 */
export type FenceDenial = 'remote' | 'host' | 'origin' | 'referer'

/** 已归一的名单（构造期 `fenceAllowlist` 的产物）或原始配置项。 */
export type FenceAllowHosts = readonly string[] | ReadonlySet<string>

export interface FenceOptions {
  /** 配置 `apiAllowHosts` 追加的本机别名（只比主机名：大小写归一、端口剥掉）。
   *  传 Set = 已由 `fenceAllowlist` 算好（含缺省三值），路由构造期算一次、逐请求复用。 */
  allowHosts?: FenceAllowHosts
}

/**
 * Host → 可比对的主机名，**只认「URL 解析不改写」的写法**（「哪些主机名写法可信」这一判据的
 * 唯一实现：配置侧 `config.ts` 的 `apiAllowHosts` 校验同用这把尺，别处不许再抄一份）。
 * 归一（小写、剥端口、默认 80 不出现）照做，但解析结果一旦与原文不同就判不可信：
 * `2130706433` / `0x7f000001` 这类写法会被 WHATWG 归成 `127.0.0.1`，从而落在名单里——
 * 那是只有 rebinding 工具才会发的形状（用户的面板不会长这样），放行等于把刚立起来的这道闸
 * 从后门拆掉。端口按 RFC 允许出现（`localhost:80` 与 `localhost` 是同一个 origin）。
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

/** Host 头不带 scheme，`:80` / `:443` 都可能只是该连接默认端口的写法（反代 TLS 终止时尤其如此），
 *  所以 Host 侧两者都按缺席归一。Origin / Referer 自己带 scheme，交给 WHATWG 只折算该 scheme 的
 *  默认端口——`http://localhost:443` 是一个真实不同的源，不会被并成 `http://localhost`。 */
function hostKeyOf(host: string): string {
  const url = new URL(`http://${host}`)
  const port = url.port === '' || url.port === '80' || url.port === '443' ? '' : `:${url.port}`
  return `${url.hostname.toLowerCase()}${port}`
}

/** 同源比对用的键：主机名 + 端口（URL 已按 scheme 折算默认端口：`http://localhost:80` → 无端口）。 */
function originKeyOf(url: URL): string {
  return `${url.hostname.toLowerCase()}${url.port === '' ? '' : `:${url.port}`}`
}

/** 本机名单 = 缺省三值 + 配置追加的别名。传 Set = 已算好的名单，直接复用（路由构造期一次）。
 *  配置里的坏形状在加载期已被配置缝挡掉（同一把尺：`config.ts` 的 `resolveConfig` 用 `hostNameOf`
 *  拒过一遍），这里仍按「解析不出就丢」处理：fence 是最后一道闸，
 *  不该因为一条脏配置整体放行；字符串不是名单，不许按字符拆成若干名字。 */
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

/** 这一发为什么不被信任（`null` = 放行）。顺序即判据顺序：远端 → Host → Origin → Referer。 */
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

/** JSON 信封体的字节上限（缺省 1MiB）。**这个数是唯一主人**：调用方要放宽就传参，别再写第二个字面量。 */
export const DEFAULT_JSON_BODY_MAX_BYTES = 1024 * 1024

/**
 * 带上限的流式读 body：**两份字节上限逻辑的唯一实现**（JSON 信封体与本地导入的原始字节共用它；
 * 不要各写一份流式计数循环）。超限即抛 413；`overMessage` 由调用方给，因为两处的用户措辞不同
 * （信封体说字节数、上传文件说 MB）。
 * 钉死：超限只 throw 不 destroy（destroy 会断 PassThrough 流）。
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

/**
 * 聚合请求体为 JSON。空 body → fallback；超限 → 413；非法 JSON → 400。
 * 流读与上限判据归 `readCappedBody`，本函数只管「读出来的字节是不是 JSON」。
 */
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
