import type { ApiEnvelope } from '../shared/wire.js'
import { NOVEL_API_PREFIX } from '../shared/wire.js'

/**
 * /novel-api 同源 fetch 封装。前缀与信封形状归 wire 契约（src/shared/wire.ts，双半唯一真相）。
 * 信封：{ ok:true, value } → value；{ ok:false, error } → ApiClientError；非 JSON/网络层 → NetworkError。
 */
export class ApiClientError extends Error {
  readonly code: string
  readonly status: number
  readonly segment?: { facet: string; segmentIndex: number; segmentRaw: string }
  constructor(code: string, status: number, message: string, segment?: ApiClientError['segment']) {
    super(message)
    this.name = 'ApiClientError'
    this.code = code
    this.status = status
    this.segment = segment
  }
}

/** query 构造归 wire 契约（shared/wire.ts 的 encodeQuery / queries）——此处不再持有第二份 qs */

const PREFIX = `${NOVEL_API_PREFIX}/`

/** 响应体 → JSON（失败 = NetworkError，消息与旧实现一字不差） */
async function jsonOf(res: Response): Promise<unknown> {
  try {
    return await res.json()
  } catch {
    throw new ApiClientError('NetworkError', res.status, `响应不是 JSON（HTTP ${res.status}）`)
  }
}

/** 信封解析单点（旧实现 request/apiUpload 各一份，已合并）：ok → value；否则抛 ApiClientError */
function unwrap<T>(body: unknown, status: number): T {
  const env = body as ApiEnvelope<T>
  if (env.ok === true) return env.value as T
  const err = env.error
  throw new ApiClientError(err?.code ?? 'Unknown', status, err?.message ?? `HTTP ${status}`, err?.segment)
}

async function request<T>(path: string, method: string, body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(PREFIX + path, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch (e) {
    throw new ApiClientError('NetworkError', 0, `网络请求失败: ${(e as Error).message}`)
  }
  return unwrap<T>(await jsonOf(res), res.status)
}

export function apiGet<T>(path: string): Promise<T> { return request<T>(path, 'GET') }
export function apiSend<T>(method: 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
  return request<T>(path, method, body)
}

/** 原始字节上传（本地书导入 TXT / EPUB，UI）：octet-stream body，响应仍走信封 */
export async function apiUpload<T>(pathWithQuery: string, body: Blob): Promise<T> {
  let res: Response
  try {
    res = await fetch(PREFIX + pathWithQuery, { method: 'POST', body })
  } catch (e) {
    throw new ApiClientError('NetworkError', 0, `网络请求失败: ${(e as Error).message}`)
  }
  return unwrap<T>(await jsonOf(res), res.status)
}

/**
 * SSE 读流：起一条事件流，每帧把 `data:` 原文交给 `onFrame`；流正常结束 resolve、
 * 连不上 / 断线 / abort 则 reject（调用方据此回落到快照轮询）。
 *
 * 为什么不用 `EventSource`：它自带重连与 `Last-Event-ID`，等于把游标交给浏览器——
 * 而本仓的进度口径是「推送只是加速器，显式查询才是真相」（`docs/reference/dsh-plugin-api.md` §9：
 * 通知不 replay，必须提供 baseline / cursor / 显式 query）。游标握在客户端手里，
 * 两条通道才能共用同一份合并代码而不产生第二真相。
 */
export async function apiEventStream(
  pathWithQuery: string,
  onFrame: (data: string) => void,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch(PREFIX + pathWithQuery, { signal, headers: { accept: 'text/event-stream' } })
  if (!res.ok || res.body === null) {
    throw new ApiClientError('NetworkError', res.status, `事件流不可用（HTTP ${res.status}）`)
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) return
    buf += decoder.decode(value, { stream: true })
    let at = buf.indexOf('\n\n')
    while (at >= 0) {
      frameOf(buf.slice(0, at), onFrame)
      buf = buf.slice(at + 2)
      at = buf.indexOf('\n\n')
    }
  }
}

/** 一个事件块 → 帧体：`data:` 行按规范以 \n 拼接；注释行与其它字段忽略 */
function frameOf(block: string, onFrame: (data: string) => void): void {
  const lines = block.split('\n').filter((l) => l.startsWith('data:'))
  if (lines.length === 0) return
  onFrame(lines.map((l) => l.slice('data:'.length).trimStart()).join('\n'))
}
