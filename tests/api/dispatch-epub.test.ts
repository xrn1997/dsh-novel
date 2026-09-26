import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { ReadingService } from '../../src/services/reading.js'
import { chapterContentToText } from '../../src/services/chapter-content.js'
import type { ChapterContent } from '../../src/shared/wire.js'
import { LOCAL_SOURCE_ID, paramRoutes, queries, ROUTES } from '../../src/shared/wire.js'
import { IMAGE_SAMPLES, makeEpubFixture } from '../fixtures/epub.js'
import { startServer } from './helpers.js'
import { makeTempDir, trackService } from '../temp-dir.js'

/**
 * 本地 EPUB 的 HTTP 集成：真 http.Server + 真 ReadingService + 临时数据根（无假 handler）。
 * 覆盖导入回执、图文正文、线性目录与导航树、补充文档、资源流与安全头、删除与失败清理。
 * 响应的值形状钉在 wire（`LocalImportResponse` / `ChapterContent` / `BookNavigation`），
 * 这里断言的是**真实响应体与真实落盘**，不是「状态码 200 就算过」。
 */

let svc: ReadingService, base: string, close: () => Promise<void>, dataDir: string
beforeAll(async () => {
  dataDir = await makeTempDir('novel-apiep-')
  svc = trackService(await ReadingService.create({
    dir: dataDir,
    fetchImpl: (async () => new Response('', { status: 404 })) as never,   // 本地书面不触网
  }))
  ;({ base, close } = await startServer(svc))
})
afterAll(async () => { await svc.flush(); await close() })

const api = (route: string): string => `${base}/novel-api/${route}`

/** 真 HTTP 导入一份 fixture；失败时把错误体带进断言消息 */
async function importBook(fixture: string, name: string): Promise<any> {
  const r = await fetch(api(queries.localImport({ name })), {
    method: 'POST', body: makeEpubFixture(fixture) as unknown as BodyInit,
  })
  const text = await r.text()
  expect(r.status, text).toBe(200)
  return (JSON.parse(text) as { value: any }).value
}

const localEntries = async (): Promise<string[]> => (await fs.readdir(path.join(dataDir, 'local'))).sort()
const idOf = (bookKey: string): string => bookKey.slice('local:'.length)
/** 本书的落盘物「在不在」：EPUB 是目录 + 顶层元数据两件（用例共享数据根，故按 ID 断言而不清空比对） */
const expectGone = async (bookKey: string): Promise<void> => {
  const entries = await localEntries()
  expect(entries, bookKey).not.toContain(idOf(bookKey))
  expect(entries, bookKey).not.toContain(`${idOf(bookKey)}.json`)
}
const expectPresent = async (bookKey: string): Promise<void> => {
  const entries = await localEntries()
  expect(entries, bookKey).toContain(idOf(bookKey))
  expect(entries, bookKey).toContain(`${idOf(bookKey)}.json`)
}
const chapterUrl = (bookKey: string, index: number): string =>
  api(queries.chapter({ sourceId: LOCAL_SOURCE_ID, url: bookKey, index }))

describe('EPUB 导入 → 阅读（真实 HTTP）', () => {
  it('导入回执是 LocalImportResponse：书目字段 + 章数/格式/编码/告警，并自动上架', async () => {
    const book = await importBook('epub3-rich', '样本.epub')
    expect(book).toMatchObject({
      sourceId: LOCAL_SOURCE_ID, title: '图文样本', author: '样本作者',
      totalChapters: 2, chapterCount: 2, format: 'epub', encoding: null, warnings: [],
    })
    // 封面走 wire 的资源路径构造器（本地资源口），前端拿到即可显示
    expect(book.coverUrl).toBe(`/novel-api/${queries.localResource({ id: book.bookKey, resourceId: 'r0' })}`)
    const shelf = (await (await fetch(api('shelf'))).json() as any).value as Array<{ bookKey: string }>
    expect(shelf.map((b) => b.bookKey)).toContain(book.bookKey)
  })

  it('GET /chapter 返回图文树，文字投影与它同源', async () => {
    const book = await importBook('epub3-rich', '样本.epub')
    const { value: content } = await (await fetch(chapterUrl(book.bookKey, 0))).json() as any
    expect(content.kind).toBe('rich')
    expect(content.documentId).toBe('d0')
    expect(content.nodes[0]).toMatchObject({ kind: 'element', tag: 'h1' })
    expect(await svc.getChapter(LOCAL_SOURCE_ID, book.bookKey, 0)).toBe(chapterContentToText(content as ChapterContent))
    // 章号越界 → 404（本地产物不存在），不是 500
    expect((await fetch(chapterUrl(book.bookKey, 99))).status).toBe(404)
  })

  it('GET /toc 仍是线性旧响应；GET /navigation 给线性序列 + 原生目录树（同章多锚点各自成条）', async () => {
    const book = await importBook('epub3-rich', '样本.epub')
    const { value: toc } = await (await fetch(api(queries.toc({ sourceId: LOCAL_SOURCE_ID, url: book.bookKey })))).json() as any
    expect(toc).toEqual([
      { name: '第一章', url: `${book.bookKey}#0` },
      { name: '第二章', url: `${book.bookKey}#1` },
    ])
    const { value: nav } = await (await fetch(api(queries.navigation({ sourceId: LOCAL_SOURCE_ID, url: book.bookKey })))).json() as any
    expect(nav.chapters).toEqual(toc)                       // 线性序列与 toc 同一份（进度/导出口径）
    expect(nav.items.map((i: any) => i.label)).toEqual(['第一卷'])
    expect(nav.items[0].children.map((i: any) => i.label)).toEqual(['甲', '乙', '丙'])
    expect(nav.items[0].target).toBeNull()                  // 分组标题没有目标
    const leaves = nav.items[0].children
    expect(leaves.map((i: any) => i.target)).toEqual([
      { kind: 'chapter', index: 0, anchorId: expect.stringMatching(/^a\d+$/) },
      { kind: 'chapter', index: 0, anchorId: expect.stringMatching(/^a\d+$/) },
      { kind: 'chapter', index: 1, anchorId: expect.stringMatching(/^a\d+$/) },
    ])
    expect(leaves[0].target.anchorId).not.toBe(leaves[1].target.anchorId)
  })

  it('GET local/document 读补充文档（脚注）；未知文档 ID → 404', async () => {
    const book = await importBook('epub3-rich', '样本.epub')
    const { value: notes } = await (await fetch(api(queries.localDocument({ id: book.bookKey, documentId: 'd2' })))).json() as any
    expect(notes).toMatchObject({ kind: 'rich', documentId: 'd2' })
    expect(chapterContentToText(notes as ChapterContent)).toContain('脚注一')
    expect((await fetch(api(queries.localDocument({ id: book.bookKey, documentId: 'd99' })))).status).toBe(404)
    // 原型链成员（JSON.parse 出的普通对象会命中它们）不是文档 ID：取到 undefined 的 file 会炸成 500，
    // 只按自有键查表才落回「找不到」的既有路径
    for (const evil of ['constructor', '__proto__', 'toString']) {
      expect((await fetch(api(queries.localDocument({ id: book.bookKey, documentId: evil })))).status, evil).toBe(404)
    }
  })

  it('GET local/resource：验证过的 MIME、nosniff、同源 CORP、私有缓存，字节与落盘一致', async () => {
    const book = await importBook('epub3-rich', '样本.epub')
    const r = await fetch(api(queries.localResource({ id: book.bookKey, resourceId: 'r0' })))
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toBe('image/png')
    expect(r.headers.get('x-content-type-options')).toBe('nosniff')
    expect(r.headers.get('cross-origin-resource-policy')).toBe('same-origin')
    expect(r.headers.get('cache-control')).toBe('private, max-age=3600')
    expect(r.headers.get('content-length')).toBe(String(IMAGE_SAMPLES.png.length))
    expect(Buffer.from(await r.arrayBuffer()).equals(IMAGE_SAMPLES.png)).toBe(true)
    // 只认不透明 ID：未知 ID、路径形态与原型链成员一律 404（路径从不来自请求）
    for (const bad of ['r99', '../../original.epub', 'constructor', '__proto__', 'toString']) {
      expect((await fetch(api(queries.localResource({ id: book.bookKey, resourceId: bad })))).status, bad).toBe(404)
    }
  })

  it('独立 SVG 资源额外附强 CSP（default-src none + sandbox）', async () => {
    const book = await importBook('epub3-svg-figure', '矢量.epub')
    const r = await fetch(api(queries.localResource({ id: book.bookKey, resourceId: 'r0' })))
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toBe('image/svg+xml')
    expect(r.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox")
    expect(await r.text()).toContain('<svg')
  })

  it('GET local/warnings 回持久化的导入说明（干净书空数组）', async () => {
    const clean = await importBook('epub3-rich', '干净.epub')
    const degraded = await importBook('epub3-inline-svg-anchor', '降级.epub')
    expect((await (await fetch(api(queries.localWarnings({ id: clean.bookKey })))).json() as any).value).toEqual([])
    const warnings = (await (await fetch(api(queries.localWarnings({ id: degraded.bookKey })))).json() as any).value
    expect(warnings.map((w: { code: string }) => w.code)).toContain('epub-degraded-anchor')
  })

  it('跨源 Origin 被既有 fence 拒（资源口也不例外）', async () => {
    const book = await importBook('epub3-rich', '样本.epub')
    const r = await fetch(api(queries.localResource({ id: book.bookKey, resourceId: 'r0' })), {
      headers: { origin: 'https://evil.example', referer: 'https://evil.example/page' },
    })
    expect(r.status).toBe(403)
  })

  it('断连的请求只销毁自己那条流：随后的资源请求照常拿全字节', async () => {
    const book = await importBook('epub3-rich', '样本.epub')
    const ctrl = new AbortController()
    const aborted = fetch(api(queries.localResource({ id: book.bookKey, resourceId: 'r0' })), { signal: ctrl.signal })
    ctrl.abort()
    await expect(aborted).rejects.toThrow()
    const r = await fetch(api(queries.localResource({ id: book.bookKey, resourceId: 'r0' })))
    expect(r.status).toBe(200)
    expect(Buffer.from(await r.arrayBuffer()).equals(IMAGE_SAMPLES.png)).toBe(true)
  })
})

describe('EPUB 的失败与删除（真实 HTTP）', () => {
  it('导入中断（坏 EPUB）→ 400；local/ 不留痕；既有书照读', async () => {
    const keep = await importBook('epub3-rich', '既有.epub')
    const before = await localEntries()
    const r = await fetch(api(queries.localImport({ name: '坏.epub' })), {
      method: 'POST', body: makeEpubFixture('epub3-broken-cover') as unknown as BodyInit,
    })
    expect(r.status).toBe(400)
    expect(((await r.json()) as any).error.code).toBe('BadRequest')
    expect(await localEntries()).toEqual(before)
    expect((await fetch(chapterUrl(keep.bookKey, 0))).status).toBe(200)
  })

  it('导入的内容不是可读 EPUB → 400 且点名（内容判定：改名字不能绕过）', async () => {
    const r = await fetch(api(queries.localImport({ name: '伪装.txt' })), {
      method: 'POST', body: makeEpubFixture('epub-entity-internal') as unknown as BodyInit,
    })
    expect(r.status).toBe(400)
    expect(((await r.json()) as any).error.message).toContain('实体声明')
  })

  it('ZIP 加密条目的归档 → 400：不落成 format:txt 的乱码书，也不入架', async () => {
    const before = await localEntries()
    const shelfOf = async (): Promise<string[]> =>
      ((await (await fetch(api('shelf'))).json() as any).value as Array<{ bookKey: string }>).map((b) => b.bookKey)
    const shelfBefore = await shelfOf()
    const r = await fetch(api(queries.localImport({ name: '加密.zip' })), {
      method: 'POST', body: makeEpubFixture('encrypted-entry') as unknown as BodyInit,
    })
    expect(r.status).toBe(400)
    const body = await r.json() as any
    expect(body.error.code).toBe('BadRequest')
    expect(body.error.message).toContain('加密')
    // 回执不是成功信封：没有 value（也就不可能带 format:'txt' 的乱码书）
    expect(body.value).toBeUndefined()
    expect(await localEntries()).toEqual(before)
    expect(await shelfOf()).toEqual(shelfBefore)
  })

  it('.txt 名字的合法 EPUB 走图文路径（后缀不参与判定）', async () => {
    const ok = await importBook('epub3-rich', '伪装.txt')
    expect(ok).toMatchObject({ format: 'epub', title: '图文样本', author: '样本作者' })
  })

  it('DELETE local / shelf 单删 / 批删：EPUB 整棵目录随条目走，删后新请求 404', async () => {
    const viaLocal = await importBook('epub3-rich', 'a.epub')
    expect((await fetch(api(queries.localDelete({ id: viaLocal.bookKey })), { method: 'DELETE' })).status).toBe(200)
    await expectGone(viaLocal.bookKey)
    expect((await fetch(chapterUrl(viaLocal.bookKey, 0))).status).toBe(404)
    expect((await fetch(api(queries.localResource({ id: viaLocal.bookKey, resourceId: 'r0' })))).status).toBe(404)

    const single = await importBook('epub2-basic', 'b.epub')
    const another = await importBook('epub3-rich', 'c.epub')
    await fetch(api(paramRoutes.shelfKey(single.bookKey)), { method: 'DELETE' })
    // 只删这本的目录与元数据：另一本照旧在
    await expectGone(single.bookKey)
    await expectPresent(another.bookKey)
    const batch = await fetch(api(ROUTES.shelfBatchDelete.path), {
      method: 'POST', body: JSON.stringify({ keys: [another.bookKey] }),
    })
    expect(((await batch.json()) as any).value.removed).toBe(1)
    await expectGone(another.bookKey)
  })
})
