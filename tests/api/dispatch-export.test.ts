import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ReadingService } from '../../src/services/reading.js'
import { startServer } from './helpers.js'
import { makeTempDir, trackService } from '../temp-dir.js'

const BASE = 'https://s.com'
const TOC_HTML = '<html><body><div class="b ch"><a href="/c/1.html">第一章</a></div><div class="b ch"><a href="/c/2.html">第二章</a></div></body></html>'
const rawSource = {
  bookSourceName: 'S', bookSourceUrl: BASE,
  searchUrl: `${BASE}/search?q={{key}}`,
  ruleBookList: '@css:.b', ruleBookName: 'tag.a@text', ruleBookUrl: 'tag.a@href',
  // 不写 ruleTocUrl（null → tocUrl=bookUrl）：失败用例需 toc 由 bookUrl 驱动；
  // 若写死绝对 ruleTocUrl，/不存在/ 也会命中 mock 的 /book/1/ 目录页，"toc 失败"用例永远走不到
  ruleChapterName: 'tag.a@text', ruleChapterUrl: 'tag.a@href',
  ruleContent: '@css:#content@textNodes',
}

let svc: ReadingService, base: string, close: () => Promise<void>
beforeAll(async () => {
  const dir = await makeTempDir('novel-apiex-')
  svc = trackService(await ReadingService.create({
    dir,
    fetchImpl: (async (input: RequestInfo | URL) => {
      const u = String(input)
      if (u.includes('/book/1/')) return new Response(TOC_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } })
      if (u.includes('/c/')) {
        const n = u.includes('/c/1') ? '一' : '二'
        return new Response(`<html><body><div id="content">第${n}章正文</div></body></html>`, { headers: { 'content-type': 'text/html; charset=utf-8' } })
      }
      return new Response('', { status: 404 })
    }) as any,
  }))
  await svc.importOne(rawSource)
  ;({ base, close } = await startServer(svc, { exportDelayMs: 1 }))   // 测试不睡
})
afterAll(async () => { await svc.flush(); await close() })

async function sourceId(): Promise<string> {
  const { value: src } = await (await fetch(`${base}/novel-api/sources`)).json() as any
  return src[0].id
}

describe('GET /novel-api/export', () => {
  it('方法防护：POST → 405', async () => {
    expect((await fetch(`${base}/novel-api/export`, { method: 'POST' })).status).toBe(405)
  })
  it('流式导出：BOM 开头 + Content-Disposition + X-Novel-Total-Chapters + 两章正文', async () => {
    const id = await sourceId()
    const r = await fetch(`${base}/novel-api/export?sourceId=${id}&url=${encodeURIComponent(`${BASE}/book/1/`)}&title=${encodeURIComponent('测试书')}`)
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toContain('text/plain')
    expect(r.headers.get('content-disposition')).toContain(`attachment; filename*=UTF-8''${encodeURIComponent('测试书')}.txt`)
    expect(r.headers.get('x-novel-total-chapters')).toBe('2')
    const buf = new Uint8Array(await r.arrayBuffer())   // fetch text() 按 WHATWG 规范吞 BOM——BOM 只能查字节
    expect([buf[0], buf[1], buf[2]]).toEqual([0xef, 0xbb, 0xbf])
    const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(buf)
    expect(text).toContain('《测试书》· 第一章\n\n第一章正文')
    expect(text).toContain('《测试书》· 第二章\n\n第二章正文')
  })
  it('范围导出：from=2&to=2 → 只出第二章 + total=1 + x-novel-range 2-2', async () => {
    const id = await sourceId()
    const r = await fetch(`${base}/novel-api/export?sourceId=${id}&url=${encodeURIComponent(`${BASE}/book/1/`)}&title=t&from=2&to=2`)
    expect(r.status).toBe(200)
    expect(r.headers.get('x-novel-total-chapters')).toBe('1')
    expect(r.headers.get('x-novel-range')).toBe('2-2')
    const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(new Uint8Array(await r.arrayBuffer()))
    expect(text).toContain('第二章')
    expect(text).not.toContain('第一章正文')
  })
  it('范围倒置 from>to（裁剪后仍倒置）→ 422 BadRange 错误信封（非流）', async () => {
    const id = await sourceId()
    const r = await fetch(`${base}/novel-api/export?sourceId=${id}&url=${encodeURIComponent(`${BASE}/book/1/`)}&title=t&from=2&to=1`)
    expect(r.status).toBe(422)
    const env = await r.json() as any
    expect(env.ok).toBe(false)
    expect(env.error?.code).toBe('BadRange')
  })
  it('from 非整数 → 400 BadRequest 错误信封', async () => {
    const id = await sourceId()
    const r = await fetch(`${base}/novel-api/export?sourceId=${id}&url=${encodeURIComponent(`${BASE}/book/1/`)}&title=t&from=abc`)
    expect(r.status).toBe(400)
    const env = await r.json() as any
    expect(env.error?.code).toBe('BadRequest')
  })
  it('范围越界裁剪：from=0&to=99 → 全书两章照出', async () => {
    const id = await sourceId()
    const r = await fetch(`${base}/novel-api/export?sourceId=${id}&url=${encodeURIComponent(`${BASE}/book/1/`)}&title=t&from=0&to=99`)
    expect(r.headers.get('x-novel-range')).toBe('1-2')
    const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(new Uint8Array(await r.arrayBuffer()))
    expect(text).toContain('第一章正文')
    expect(text).toContain('第二章正文')
  })
  it('toc 失败 → 错误信封（502，非流）', async () => {
    const id = await sourceId()
    const r = await fetch(`${base}/novel-api/export?sourceId=${id}&url=${encodeURIComponent(`${BASE}/不存在/`)}&title=x`)
    expect(r.status).toBe(502)
    const env = await r.json() as any                      // 走了信封而非流 → 可 json 解析
    expect(env.ok).toBe(false)
    expect(env.error?.code).toBe('FetchError')             // 守门 fetcher：404 → FetchError → 502
  })
})
