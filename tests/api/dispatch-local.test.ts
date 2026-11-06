import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import iconv from 'iconv-lite'
import { ReadingService } from '../../src/services/reading.js'
import { LocalBooks } from '../../src/services/localbooks.js'
import type { ChapterContent, ChapterEntry, LocalImportResponse, LocalImportWarning, ShelfEntry } from '../../src/shared/wire.js'
import { makeTempDir, trackService } from '../temp-dir.js'
import { errorOf, startServer, valueOf } from './helpers.js'

let svc: ReadingService, local: LocalBooks, base: string, close: () => Promise<void>
let dataDir: string
beforeAll(async () => {
  dataDir = await makeTempDir('novel-apil-')
  // 本地书面归门面：LocalBooks 在 create 内装配；1024 上限同时是流式传输上限
  svc = trackService(await ReadingService.create({ dir: dataDir, localImportMaxBytes: 1024, fetchImpl: async () => new Response('', { status: 404 }) }))
  local = await LocalBooks.create(dataDir, { maxImportBytes: 1024 })   // 仅断言用第二实例（防孤儿用例查文件已删）
  ;({ base, close } = await startServer(svc))
})
afterAll(async () => { await svc.flush(); await close() })

const TXT = '第1章 起\n内容一\n\n第2章 续\n内容二'

// 注：BodyInit 在本仓库 TS lib 下不收 Buffer（iconv.encode 返回 Buffer）——按字节原样拷成 Uint8Array 过口
async function importTxt(body: string | Buffer, name: string): Promise<Response> {
  const payload: BodyInit = typeof body === 'string' ? body : new Uint8Array(body)
  return fetch(`${base}/novel-api/local/import?name=${encodeURIComponent(name)}`, { method: 'POST', body: payload })
}

describe('本地书路由', () => {
  it('import → 200 信封含 ShelfBook（已自动加书架，sourceId=__local__）', async () => {
    const r = await importTxt(TXT, '测试册.txt')
    expect(r.status).toBe(200)
    const book = await valueOf<LocalImportResponse>(r)
    expect(book).toMatchObject({ sourceId: '__local__', title: '测试册', bookKey: expect.stringMatching(/^local:/) as string })
    const shelf = await valueOf<ShelfEntry[]>(await fetch(`${base}/novel-api/shelf`))
    expect(shelf.some((b) => b.bookKey === book.bookKey)).toBe(true)
  })
  it('toc/chapter 分流到本地书（__local__ 不查注册表）', async () => {
    const book = await valueOf<LocalImportResponse>(await importTxt(TXT, 'x.txt'))
    const toc = await valueOf<ChapterEntry[]>(await fetch(`${base}/novel-api/toc?sourceId=__local__&url=${encodeURIComponent(book.bookKey)}`))
    expect(toc.map((c) => c.name)).toEqual(['第1章 起', '第2章 续'])
    const content = await valueOf<ChapterContent>(await fetch(`${base}/novel-api/chapter?sourceId=__local__&url=${encodeURIComponent(book.bookKey)}&index=1`))
    expect(content).toEqual({ kind: 'text', text: '内容二' })
  })
  it('GBK 文件导入：解码正确回显 encoding', async () => {
    const r = await importTxt(iconv.encode('第1章 夜\n挑灯看剑', 'gbk'), 'gbk书.txt')
    const book = await valueOf<LocalImportResponse>(r)
    expect(book).toMatchObject({ title: 'gbk书' })
    const content = await valueOf<ChapterContent>(await fetch(`${base}/novel-api/chapter?sourceId=__local__&url=${encodeURIComponent(book.bookKey)}&index=0`))
    expect(content).toEqual({ kind: 'text', text: '挑灯看剑' })
  })
  it('本地读口在 TXT 上：warnings 空数组（告警面通用），document/resource 是 404', async () => {
    const book = await valueOf<LocalImportResponse>(await importTxt(TXT, 'ports.txt'))
    const enc = encodeURIComponent(book.bookKey)
    const w = await fetch(`${base}/novel-api/local/warnings?id=${enc}`)
    expect(w.status).toBe(200)
    expect(await valueOf<LocalImportWarning[]>(w)).toEqual([])
    for (const route of [`local/document?id=${enc}&documentId=d0`, `local/resource?id=${enc}&resourceId=r0`]) {
      const r = await fetch(`${base}/novel-api/${route}`)
      expect(r.status, route).toBe(404)
      expect((await errorOf(r)).code, route).toBe('NotFound')
    }
    // 未知书（元数据不在）同样是 404，而不是 500
    expect((await fetch(`${base}/novel-api/local/warnings?id=${encodeURIComponent('local:123e4567-e89b-12d3-a456-426614174000')}`)).status).toBe(404)
  })
  it('本地读口缺参 → 400；方法不对 → 405', async () => {
    expect((await fetch(`${base}/novel-api/local/resource?id=x`)).status).toBe(400)
    expect((await fetch(`${base}/novel-api/local/document?id=x`)).status).toBe(400)
    expect((await fetch(`${base}/novel-api/local/warnings`)).status).toBe(400)
    expect((await fetch(`${base}/novel-api/local/resource?id=x&resourceId=r0`, { method: 'DELETE' })).status).toBe(405)
  })
  it('空文件 → 400；超限 → 413（信封），传输层文案与限额同一读数', async () => {
    expect((await importTxt('', 'e.txt')).status).toBe(400)
    const tooBig = await importTxt('x'.repeat(2048), 'big.txt')
    expect(tooBig.status).toBe(413)
    const body = await errorOf(tooBig)
    // 本套件的上限是 1KB（亚 MiB）：文案必须说 KB，不能四舍五入成「0MB」
    expect(body.message).toMatch(/^文件超过 1KB 上限/)
    expect(body.message).not.toContain('0MB')
    // 超限是配置边界，不是坏文件：报错要把可调的那一项交到用户手上（键名与设置页称呼都要在）
    expect(body.message).toContain('localImportMaxBytes')
    expect(body.message).toContain('本地文件导入上限')
    // 读数：超限是在请求体还在上传时答的，客户端拿到的是可解析的 413 信封而不是断连
    expect(body.code).toBe('PayloadTooLarge')
  })
  it('声明 .epub 而内容非 ZIP → 400 且原样透出原因', async () => {
    const r = await importTxt('<html><body>nope</body></html>', 'fake.epub')
    expect(r.status).toBe(400)
    expect((await errorOf(r)).message).toMatch(/声明是 EPUB/)
  })
  it('DELETE /local → 删文件 + 书架条目消失', async () => {
    const book = await valueOf<LocalImportResponse>(await importTxt(TXT, 'd.txt'))
    const r = await fetch(`${base}/novel-api/local?id=${encodeURIComponent(book.bookKey)}`, { method: 'DELETE' })
    expect((await valueOf<{ removed: boolean }>(r)).removed).toBe(true)
    const shelf = await valueOf<ShelfEntry[]>(await fetch(`${base}/novel-api/shelf`))
    expect(shelf.some((b) => b.bookKey === book.bookKey)).toBe(false)
  })
  it('shelf DELETE 对 local: 书连带删文件（防孤儿）', async () => {
    const book = await valueOf<LocalImportResponse>(await importTxt(TXT, 'orphan.txt'))
    await fetch(`${base}/novel-api/shelf/${encodeURIComponent(book.bookKey)}`, { method: 'DELETE' })
    expect(await local.remove(book.bookKey)).toBe(false)                  // 文件已被连带删光 → remove 找不到
  })
})
