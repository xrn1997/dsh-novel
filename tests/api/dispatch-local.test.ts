import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import iconv from 'iconv-lite'
import { ReadingService } from '../../src/services/reading.js'
import { LocalBooks } from '../../src/services/localbooks.js'
import { startServer } from './helpers.js'
import { makeTempDir, trackService } from '../temp-dir.js'

let svc: ReadingService, local: LocalBooks, base: string, close: () => Promise<void>
let dataDir: string
beforeAll(async () => {
  dataDir = await makeTempDir('novel-apil-')
  // 本地书面归门面：LocalBooks 在 create 内装配；1024 上限同时是流式传输上限
  svc = trackService(await ReadingService.create({ dir: dataDir, localImportMaxBytes: 1024, fetchImpl: (async () => new Response('', { status: 404 })) as any }))
  local = await LocalBooks.create(dataDir, { maxImportBytes: 1024 })   // 仅断言用第二实例（防孤儿用例查文件已删）
  ;({ base, close } = await startServer(svc))
})
afterAll(async () => { await svc.flush(); await close() })

const TXT = '第1章 起\n内容一\n\n第2章 续\n内容二'

// 注：BodyInit 在本仓库 TS lib 下不收 Buffer（iconv.encode 返回 Buffer）——参数放宽 + 沿用 harness.ts 窄口强转
async function importTxt(body: string | Buffer, name: string): Promise<Response> {
  return fetch(`${base}/novel-api/local/import?name=${encodeURIComponent(name)}`, { method: 'POST', body: body as unknown as BodyInit })
}

describe('本地书路由', () => {
  it('import → 200 信封含 ShelfBook（已自动加书架，sourceId=__local__）', async () => {
    const r = await importTxt(TXT, '测试册.txt')
    expect(r.status).toBe(200)
    const { value: book } = await r.json() as any
    expect(book).toMatchObject({ sourceId: '__local__', title: '测试册', bookKey: expect.stringMatching(/^local:/) })
    const { value: shelf } = await (await fetch(`${base}/novel-api/shelf`)).json() as any
    expect(shelf.some((b: any) => b.bookKey === book.bookKey)).toBe(true)
  })
  it('toc/chapter 分流到本地书（__local__ 不查注册表）', async () => {
    const { value: book } = await (await importTxt(TXT, 'x.txt')).json() as any
    const { value: toc } = await (await fetch(`${base}/novel-api/toc?sourceId=__local__&url=${encodeURIComponent(book.bookKey)}`)).json() as any
    expect(toc.map((c: any) => c.name)).toEqual(['第1章 起', '第2章 续'])
    const { value: content } = await (await fetch(`${base}/novel-api/chapter?sourceId=__local__&url=${encodeURIComponent(book.bookKey)}&index=1`)).json() as any
    expect(content).toEqual({ kind: 'text', text: '内容二' })
  })
  it('GBK 文件导入：解码正确回显 encoding', async () => {
    const r = await importTxt(iconv.encode('第1章 夜\n挑灯看剑', 'gbk'), 'gbk书.txt')
    const { value: book } = await r.json() as any
    expect(book).toMatchObject({ title: 'gbk书' })
    const { value: content } = await (await fetch(`${base}/novel-api/chapter?sourceId=__local__&url=${encodeURIComponent(book.bookKey)}&index=0`)).json() as any
    expect(content).toEqual({ kind: 'text', text: '挑灯看剑' })
  })
  it('本地读口在 TXT 上：warnings 空数组（告警面通用），document/resource 是 404', async () => {
    const { value: book } = await (await importTxt(TXT, 'ports.txt')).json() as any
    const enc = encodeURIComponent(book.bookKey)
    const w = await fetch(`${base}/novel-api/local/warnings?id=${enc}`)
    expect(w.status).toBe(200)
    expect(((await w.json()) as any).value).toEqual([])
    for (const route of [`local/document?id=${enc}&documentId=d0`, `local/resource?id=${enc}&resourceId=r0`]) {
      const r = await fetch(`${base}/novel-api/${route}`)
      expect(r.status, route).toBe(404)
      expect(((await r.json()) as any).error.code, route).toBe('NotFound')
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
  it('空文件 → 400；超限 → 413（信封）', async () => {
    expect((await importTxt('', 'e.txt')).status).toBe(400)
    expect((await importTxt('x'.repeat(2048), 'big.txt')).status).toBe(413)
  })
  it('DELETE /local → 删文件 + 书架条目消失', async () => {
    const { value: book } = await (await importTxt(TXT, 'd.txt')).json() as any
    const r = await fetch(`${base}/novel-api/local?id=${encodeURIComponent(book.bookKey)}`, { method: 'DELETE' })
    expect(((await r.json()) as any).value.removed).toBe(true)
    const { value: shelf } = await (await fetch(`${base}/novel-api/shelf`)).json() as any
    expect(shelf.some((b: any) => b.bookKey === book.bookKey)).toBe(false)
  })
  it('shelf DELETE 对 local: 书连带删文件（防孤儿）', async () => {
    const { value: book } = await (await importTxt(TXT, 'orphan.txt')).json() as any
    await fetch(`${base}/novel-api/shelf/${encodeURIComponent(book.bookKey)}`, { method: 'DELETE' })
    expect(await local.remove(book.bookKey)).toBe(false)                  // 文件已被连带删光 → remove 找不到
  })
})
