import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiClientError } from '../../src/client/api.js'
import { streamExport } from '../../src/client/download.js'

/**
 * 导出流的响应头口径：`x-novel-total-chapters` 是本仓服务端写的（`dispatch` 的
 * `String(plan.totalInRange)`），读取面只认纯十进制串；解析不成立就按缺席交回 null
 * （`export-run` 记 '' → 面板只说「导出中 · N KB」），不把脏串念成「共 N 章」。
 */

function stubFetch(res: Response): void {
  vi.stubGlobal('fetch', vi.fn(async () => res))
}

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream({
    start(c) {
      for (const s of chunks) c.enqueue(enc.encode(s))
      c.close()
    },
  })
}

async function totalsFor(header: string | null): Promise<Array<string | null>> {
  // exactOptionalPropertyTypes：`headers: undefined` 不是合法 ResponseInit，条件建键
  const init: ResponseInit = header === null ? {} : { headers: { 'x-novel-total-chapters': header } }
  stubFetch(new Response(streamOf(['ab', 'c']), init))
  const seen: Array<string | null> = []
  const blob = await streamExport({
    sourceId: 's', bookKey: 'k', title: 't',
    onProgress: (_bytes, total) => seen.push(total),
    signal: new AbortController().signal,
  })
  expect(await blob.text()).toBe('abc')
  return seen
}

describe('导出的 total 头解析', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('纯数字头 → 逐包回调带上章数', async () => {
    expect(await totalsFor('7')).toEqual(['7', '7'])
  })

  it('非数字 / 带杂字 / 空串 → 记缺席，不当成数字', async () => {
    expect(await totalsFor('abc')).toEqual([null, null])
    expect(await totalsFor('12abc')).toEqual([null, null])
    expect(await totalsFor('-3')).toEqual([null, null])
    expect(await totalsFor('')).toEqual([null, null])
  })

  it('没有这个头 → 缺席', async () => {
    expect(await totalsFor(null)).toEqual([null, null])
  })

  it('首包前失败 → JSON 错误信封翻成 ApiClientError（不落字节）', async () => {
    stubFetch(new Response(JSON.stringify({ error: { code: 'NotFound', message: '没这本书' } }), {
      status: 404, headers: { 'content-type': 'application/json' },
    }))
    const p = streamExport({
      sourceId: 's', bookKey: 'k', title: 't',
      onProgress: () => undefined,
      signal: new AbortController().signal,
    })
    await expect(p).rejects.toBeInstanceOf(ApiClientError)
    await expect(p).rejects.toMatchObject({ code: 'NotFound', status: 404, message: '没这本书' })
  })
})