import { ApiClientError } from './api.js'
import type { ApiEnvelope } from '../shared/wire.js'
import { NOVEL_API_PREFIX, queries } from '../shared/wire.js'

/**
 * 范围导出下载：fetch 流式读取 → Blob；进度按已收字节回调（from/to 缺席 = 全本）；
 * 失败（headers 未发）为 JSON 信封 → ApiClientError；signal 取消即断。
 */
export async function streamExport(opts: {
  sourceId: string; bookKey: string; title: string
  /** 导出范围（1 基含端，缺省全本——两个键都缺席即零参数旧链接） */
  from?: number; to?: number
  onProgress: (bytes: number, totalChapters: string | null) => void
  signal: AbortSignal
}): Promise<Blob> {
  const q = queries.exportBook({ sourceId: opts.sourceId, url: opts.bookKey, title: opts.title, from: opts.from, to: opts.to })
  let res: Response
  try {
    res = await fetch(`${NOVEL_API_PREFIX}/${q}`, { signal: opts.signal })
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e
    throw new ApiClientError('NetworkError', 0, `网络请求失败: ${(e as Error).message}`)
  }
  if (!res.ok || res.body === null) {
    // 失败在首包前 → 走 JSON 错误信封（还没开始流式输出）
    const env = await res.json().catch(() => null) as ApiEnvelope<never> | null
    throw new ApiClientError(env?.error?.code ?? 'Unknown', res.status, env?.error?.message ?? `HTTP ${res.status}`)
  }
  const total = res.headers.get('x-novel-total-chapters')
  const reader = res.body.getReader()
  const parts: Uint8Array[] = []
  let bytes = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(value)
    bytes += value.byteLength
    opts.onProgress(bytes, total)
  }
  return new Blob(parts as BlobPart[], { type: 'text/plain;charset=utf-8' })
}

/** Blob → 浏览器下载（临时 <a download> 点击，立即回收） */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
