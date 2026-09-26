import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import iconv from 'iconv-lite'
import { chapterContentToText } from '../../src/services/chapter-content.js'
import { EpubImportError } from '../../src/services/epub/errors.js'
import {
  LocalArtifactNotFoundError, LocalBooks, LocalFileTooLargeError, LocalImportError, decodeLocalText, isLocalBookKey, splitChapters,
} from '../../src/services/localbooks.js'
import { IMAGE_SAMPLES, makeEpubFixture } from '../fixtures/epub.js'
import { makeTempDir } from '../temp-dir.js'

describe('decodeLocalText', () => {
  it('UTF-8 无 BOM', () => {
    const r = decodeLocalText(Buffer.from('斗罗大陆正文', 'utf8'))
    expect(r).toEqual({ text: '斗罗大陆正文', encoding: 'utf-8' })
  })
  it('UTF-8 BOM：剥 BOM 并标 utf-8-bom', () => {
    const r = decodeLocalText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('正文', 'utf8')]))
    expect(r).toEqual({ text: '正文', encoding: 'utf-8-bom' })
  })
  it('UTF-16LE BOM', () => {
    const r = decodeLocalText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('正文', 'utf16le')]))
    expect(r.text).toBe('正文')
    expect(r.encoding).toBe('utf-16le')
  })
  it('GBK 回退：UTF-8 严格探测失败 → iconv gbk 解', () => {
    const gbk = iconv.encode('夜里挑灯看剑', 'gbk')
    const r = decodeLocalText(gbk)
    expect(r).toEqual({ text: '夜里挑灯看剑', encoding: 'gbk' })
  })
})

describe('splitChapters', () => {
  it('中文数字/阿拉伯数字/大写数字 + 卷回节 + 序章楔子番外', () => {
    const text = '楔子\nA\n\n第1章 初\nB\n\n第一章 终\nC\n\n卷二·试炼\nD\n\n尾声\nE\n\n番外 一\nF'
    const spans = splitChapters(text)
    expect(spans.map((s) => s.name)).toEqual(['楔子', '第1章 初', '第一章 终', '卷二·试炼', '尾声', '番外 一'])
    // 切片往返：每段内容正确
    expect(text.slice(spans[1].start, spans[1].end).trim()).toBe('B')
    expect(text.slice(spans[5].start, spans[5].end).trim()).toBe('F')
  })
  it('章前有引言 → 补「正文」首段', () => {
    const text = '这是一段引言\n\n第1章 起\n正文内容'
    const spans = splitChapters(text)
    expect(spans.map((s) => s.name)).toEqual(['正文', '第1章 起'])
    expect(text.slice(spans[0].start, spans[0].end).trim()).toBe('这是一段引言')
  })
  it('无章节标题 → 整本单章「正文」（不炸）', () => {
    const text = '只有正文\n没有标题'
    expect(splitChapters(text)).toEqual([{ name: '正文', start: 0, end: text.length }])
  })
  it('Chapter N 英文形态', () => {
    expect(splitChapters('Chapter 1 Start\nx').map((s) => s.name)).toEqual(['Chapter 1 Start'])
  })
})

describe('isLocalBookKey', () => {
  it('合法 uuid 形态 true；其余 false（防路径穿越）', () => {
    expect(isLocalBookKey('local:123e4567-e89b-12d3-a456-426614174000')).toBe(true)
    expect(isLocalBookKey('local:../../etc/passwd')).toBe(false)
    expect(isLocalBookKey('local:short')).toBe(false)
    expect(isLocalBookKey('other:123e4567-e89b-12d3-a456-426614174000')).toBe(false)
  })
})

describe('LocalBooks', () => {
  const mk = async (maxImportBytes?: number): Promise<{ lb: LocalBooks; dir: string }> => {
    const dir = await makeTempDir('novel-lb-')
    return { lb: await LocalBooks.create(dir, maxImportBytes === undefined ? {} : { maxImportBytes }), dir }
  }
  const TXT = '引言\n\n第1章 起\n内容一\n\n第2章 续\n内容二'

  it('import → 落盘两文件 + bookKey 形态 + toc/chapter 往返', async () => {
    const { lb, dir } = await mk()
    const r = await lb.import(Buffer.from(TXT, 'utf8'), '我的书.txt')
    expect(r.bookKey).toMatch(/^local:[0-9a-f-]{36}$/)
    expect(r.title).toBe('我的书')                       // 去扩展名
    expect(r.chapterCount).toBe(3)                        // 正文/第1章/第2章
    expect(r.encoding).toBe('utf-8')
    const files = await fs.readdir(path.join(dir, 'local'))
    expect(files.filter((f) => f.endsWith('.txt'))).toHaveLength(1)
    expect(files.filter((f) => f.endsWith('.json'))).toHaveLength(1)
    const toc = await lb.getToc(r.bookKey)
    expect(toc.map((c) => c.name)).toEqual(['正文', '第1章 起', '第2章 续'])
    expect(await lb.getChapter(r.bookKey, 1)).toBe('内容一')
    expect(await lb.getChapter(r.bookKey, 2)).toBe('内容二')
  })

  it('超限 → LocalFileTooLargeError；空文件 → LocalImportError；都不落盘（HTTP 码归分类表，错误体不携带）', async () => {
    const { lb, dir } = await mk(10)
    await expect(lb.import(Buffer.from('一二三四五六七八九十十一', 'utf8'), 'x.txt')).rejects.toBeInstanceOf(LocalFileTooLargeError)
    await expect(lb.import(Buffer.alloc(0), 'x.txt')).rejects.toBeInstanceOf(LocalImportError)
    expect(await fs.readdir(path.join(dir, 'local'))).toEqual([])
  })

  it('LRU 上限 3 本：第 4 本导入后重读第 1 本不炸（穿透读盘）', async () => {
    const { lb } = await mk()
    const keys: string[] = []
    for (let i = 0; i < 4; i++) keys.push((await lb.import(Buffer.from(`第1章 A${i}\nA${i}`, 'utf8'), `b${i}.txt`)).bookKey)
    expect(await lb.getChapter(keys[0], 0)).toBe('A0')
  })

  it('remove 删两文件；非法 bookKey → false', async () => {
    const { lb, dir } = await mk()
    const r = await lb.import(Buffer.from(TXT, 'utf8'), 'x.txt')
    expect(await lb.remove(r.bookKey)).toBe(true)
    expect(await fs.readdir(path.join(dir, 'local'))).toEqual([])
    expect(await lb.remove('local:../../etc')).toBe(false)
    expect(await lb.remove('local:123e4567-e89b-12d3-a456-426614174000')).toBe(false)   // 不存在
  })

  it('chapter 越界/未知 bookKey → 明确报错（宁炸不猜）', async () => {
    const { lb } = await mk()
    const r = await lb.import(Buffer.from(TXT, 'utf8'), 'x.txt')
    await expect(lb.getChapter(r.bookKey, 99)).rejects.toThrow()
    await expect(lb.getChapter('local:123e4567-e89b-12d3-a456-426614174000', 0)).rejects.toThrow('不存在')
  })

  it('零内容章（两个相邻标题行）→ getChapter 返回空串，不产生负长度切片', async () => {
    const { lb } = await mk()
    const r = await lb.import(Buffer.from('第1章 一\n第2章 二\n内容', 'utf8'), 'adj.txt')
    expect(r.chapterCount).toBe(2)
    expect(await lb.getChapter(r.bookKey, 0)).toBe('')   // 相邻标题行 → 退化 span（start>end）→ 必须为 ''
    expect(await lb.getChapter(r.bookKey, 1)).toBe('内容')
  })
})

// ── 格式分流与 EPUB 发布/读取/删除 ────────────────────────────────────────
// 存量的 TXT 布局与元数据形态**一字不改**：旧 `<uuid>.txt` + 无 schemaVersion 的 `<uuid>.json`
// 继续按既有形态读；EPUB 是 `<uuid>/`（documents + resources + original.epub）+ schemaVersion=2
// 的顶层元数据（提交标记）。判定按内容，后缀不参与。

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer))
  return Buffer.concat(chunks)
}

describe('格式判定与 TXT 存量', () => {
  const TXT = '第1章 起\n内容一\n\n第2章 续\n内容二'
  const mk = async (): Promise<{ lb: LocalBooks; dir: string }> => {
    const dir = await makeTempDir('novel-lbm-')
    return { lb: await LocalBooks.create(dir), dir }
  }
  const idOf = (bookKey: string): string => bookKey.slice('local:'.length)

  it('新 TXT 元数据不带 schemaVersion / format（缺席 = 既有 TXT 形态）', async () => {
    const { lb, dir } = await mk()
    const r = await lb.import(Buffer.from(TXT, 'utf8'), '我的书.txt')
    const raw = JSON.parse(await fs.readFile(path.join(dir, 'local', `${idOf(r.bookKey)}.json`), 'utf8')) as Record<string, unknown>
    expect(Object.keys(raw).sort()).toEqual(['chapters', 'encoding', 'importedAt', 'length', 'originalName', 'title'])
    expect(r).toMatchObject({ format: 'txt', encoding: 'utf-8', chapterCount: 2, title: '我的书', warnings: [], book: {} })
  })

  it('存量 TXT（无 schemaVersion 的既有元数据）重启后仍可读目录/正文/导航', async () => {
    const { lb, dir } = await mk()
    const id = '11111111-1111-4111-8111-111111111111'
    await fs.writeFile(path.join(dir, 'local', `${id}.txt`), TXT)
    await fs.writeFile(path.join(dir, 'local', `${id}.json`), JSON.stringify({
      title: '存量', originalName: '存量.txt', importedAt: 1, encoding: 'utf-8',
      chapters: splitChapters(TXT), length: TXT.length,
    }))
    const again = await LocalBooks.create(dir)                          // 重启：新实例读同一份落盘
    expect((await again.getToc(`local:${id}`)).map((c) => c.name)).toEqual(['第1章 起', '第2章 续'])
    expect(await again.getChapterContent(`local:${id}`, 1)).toEqual({ kind: 'text', text: '内容二' })
    expect(await again.getChapter(`local:${id}`, 1)).toBe('内容二')
    expect(await again.getNavigation(`local:${id}`)).toEqual({
      chapters: [
        { name: '第1章 起', url: `local:${id}#0` },
        { name: '第2章 续', url: `local:${id}#1` },
      ],
      items: [
        { id: 't0', label: '第1章 起', target: { kind: 'chapter', index: 0, anchorId: null }, children: [] },
        { id: 't1', label: '第2章 续', target: { kind: 'chapter', index: 1, anchorId: null }, children: [] },
      ],
    })
    expect(await again.getImportWarnings(`local:${id}`)).toEqual([])
  })

  it('判定按内容不按后缀：.txt 名字的 EPUB 走 EPUB 路径', async () => {
    const { lb } = await mk()
    const r = await lb.import(makeEpubFixture('epub3-rich'), '伪装.TXT')
    expect(r).toMatchObject({ format: 'epub', title: '图文样本', chapterCount: 2, encoding: null })
  })

  it('ZIP 魔数即走 EPUB 路径：没有 mimetype 的普通 ZIP 报错，不做 TXT 兜底', async () => {
    const { lb, dir } = await mk()
    // 缺 mimetype 不是「不是 EPUB 的文件」，而是 EPUB 路径上的失败（包层点名它）——分流只看魔数，
    // 落回 TXT 会让一个 ZIP 被 GBK 解成一整本乱码并以 200 入架（失败冒充成功）
    const err: unknown = await lb.import(makeEpubFixture('epub-missing-mimetype'), '缺身份.epub').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(EpubImportError)
    expect((err as Error).message).toContain('mimetype')
    expect(await fs.readdir(path.join(dir, 'local'))).toEqual([])
  })

  it('加密条目的归档：归档层的安全拒绝照原样上抛，不落成 format:txt 的乱码书', async () => {
    const { lb, dir } = await mk()
    const keep = await lb.import(Buffer.from(TXT, 'utf8'), '既有.txt')
    // 加密位是归档层在扫中央目录时就判掉的**安全拒绝**（本插件不提供解密），不是「打不开的 ZIP」：
    // 被 catch 吞掉就会转走 TXT 链，GBK 兜底 + 无标题单章 → 一份加密 ZIP 变成 200 的乱码书
    const err: unknown = await lb.import(makeEpubFixture('encrypted-entry'), '加密.zip').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(EpubImportError)
    expect((err as Error).message).toContain('加密')
    expect((await fs.readdir(path.join(dir, 'local'))).sort())
      .toEqual([`${idOf(keep.bookKey)}.json`, `${idOf(keep.bookKey)}.txt`])
  })

  it('GBK 回退维持原样（不新增「二进制即拒收」启发式）', async () => {
    const { lb } = await mk()
    const r = await lb.import(iconv.encode('第1章 夜\n挑灯看剑', 'gbk'), 'gbk书.TXT')
    expect(r).toMatchObject({ format: 'txt', encoding: 'gbk', title: 'gbk书' })
    expect(await lb.getChapter(r.bookKey, 0)).toBe('挑灯看剑')
  })

  it('UTF-16 文本照常按 TXT 导入（含 BOM 的非 ASCII 字节集不是 ZIP 魔数）', async () => {
    const { lb } = await mk()
    const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('第1章 夜\n挑灯看剑', 'utf16le')])
    const r = await lb.import(buf, 'utf16书.TXT')
    expect(r).toMatchObject({ format: 'txt', encoding: 'utf-16le', title: 'utf16书' })
    expect(await lb.getChapter(r.bookKey, 0)).toBe('挑灯看剑')
  })

  it('导入中断（EPUB 解析失败）：本次 UUID 的临时/已发布物与元数据全清，既有书照读', async () => {
    const { lb, dir } = await mk()
    const ok = await lb.import(Buffer.from(TXT, 'utf8'), '既有.txt')
    // broken-cover 的失败点在**文档已写盘之后**（封面验证在第二遍转换之后）：staging 里确有产物，
    // 才谈得上「清理」；坏根文件/坏图片那类失败发生在写盘之前，证不了清理
    await expect(lb.import(makeEpubFixture('epub3-broken-cover'), '坏.epub')).rejects.toThrow()
    expect((await fs.readdir(path.join(dir, 'local'))).sort()).toEqual([`${idOf(ok.bookKey)}.json`, `${idOf(ok.bookKey)}.txt`])
    expect(await lb.getChapter(ok.bookKey, 1)).toBe('内容二')
  })

  it('提交标记（顶层元数据）写失败：刚发布出去的目录与原子写残留一并回收，既有书照读', async () => {
    const { lb, dir } = await mk()
    const keep = await lb.import(Buffer.from(TXT, 'utf8'), '既有.txt')
    const realRename = fs.rename
    // 只拦「EPUB 顶层元数据」那一次 rename：staging→最终目录的目标是 `<uuid>`（不带 .json 后缀），
    // 元数据是提交标记（口径②）——它没落地就不算发布完成，库里的目录只是半成品
    const spy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (/[\\/]local[\\/][0-9a-f-]{36}\.json$/.test(String(to))) throw new Error('模拟提交标记写失败')
      return realRename(from, to)
    })
    try {
      await expect(lb.import(makeEpubFixture('epub3-rich'), '样本.epub')).rejects.toThrow('模拟提交标记写失败')
    } finally {
      spy.mockRestore()
    }
    // 目录已 rename 出去、元数据的临时文件已落盘（rename 失败时它就停在那儿）：两者都归本次 UUID，
    // 必须一起消失——只剩既有那本的两件文件即证「回收是整棵的」而不是只删元数据
    expect((await fs.readdir(path.join(dir, 'local'))).sort()).toEqual([`${idOf(keep.bookKey)}.json`, `${idOf(keep.bookKey)}.txt`])
    expect(await lb.getChapter(keep.bookKey, 1)).toBe('内容二')
  })

  it('删除：EPUB 是整棵目录 + 元数据（含损坏备份），TXT 是两件文件——都不留残骸', async () => {
    const { lb, dir } = await mk()
    const epub = await lb.import(makeEpubFixture('epub3-rich'), '样本.epub')
    const id = idOf(epub.bookKey)
    expect(await lb.remove(epub.bookKey)).toBe(true)
    expect(await fs.readdir(path.join(dir, 'local'))).toEqual([])        // documents/resources 随目录一起走

    // 元数据损坏不影响删除（存在性只看文件在不在），且连损坏时产生的 .bak 一并清掉
    const txt = await lb.import(Buffer.from(TXT, 'utf8'), 'x.txt')
    const tid = idOf(txt.bookKey)
    await fs.writeFile(path.join(dir, 'local', `${tid}.json`), '{ 损坏的 JSON')
    await expect(lb.getToc(txt.bookKey)).rejects.toThrow()
    expect(await lb.remove(txt.bookKey)).toBe(true)
    expect(await fs.readdir(path.join(dir, 'local'))).toEqual([])
    expect(id).not.toBe(tid)
  })
})

describe('EPUB 发布、重启读取与资源读口', () => {
  const mk = async (): Promise<{ lb: LocalBooks; dir: string }> => {
    const dir = await makeTempDir('novel-lbe-')
    return { lb: await LocalBooks.create(dir), dir }
  }

  it('发布布局：临时目录 rename 成最终目录，顶层元数据是提交标记（含阅读序列/文档/资源/导航/告警）', async () => {
    const { lb, dir } = await mk()
    const buf = makeEpubFixture('epub3-rich')
    const r = await lb.import(buf, '样本.epub')
    const id = r.bookKey.slice('local:'.length)
    expect(r).toMatchObject({ title: '图文样本', format: 'epub', encoding: null, chapterCount: 2, warnings: [] })
    expect(r.book).toEqual({
      author: '样本作者',
      totalChapters: 2,
      coverUrl: `/novel-api/local/resource?id=${encodeURIComponent(r.bookKey)}&resourceId=r0`,
    })
    // local/ 下只有顶层元数据 + 目录：本次的临时目录已 rename 走，不留 `.importing`
    expect((await fs.readdir(path.join(dir, 'local'))).sort()).toEqual([id, `${id}.json`])
    expect((await fs.readdir(path.join(dir, 'local', id))).sort()).toEqual(['documents', 'original.epub', 'resources'])
    expect(await fs.readFile(path.join(dir, 'local', id, 'original.epub'))).toEqual(buf)   // 原字节一字不差
    const meta = JSON.parse(await fs.readFile(path.join(dir, 'local', `${id}.json`), 'utf8')) as any
    expect(meta).toMatchObject({ schemaVersion: 2, format: 'epub', title: '图文样本', author: '样本作者', originalName: '样本.epub' })
    expect(meta.chapters.map((c: any) => [c.index, c.label, c.documentId])).toEqual([[0, '第一章', 'd0'], [1, '第二章', 'd1']])
    expect(Object.keys(meta.documents)).toHaveLength(3)
    expect(meta.documents.d2).toMatchObject({ index: null, label: '注释', path: 'OEBPS/notes.xhtml' })
    // 资源：共享插图与封面是同一份（按书内路径去重），字节数就是落盘字节数
    expect(meta.resources).toEqual({ r0: { id: 'r0', file: 'resources/r0.png', mediaType: 'image/png', bytes: IMAGE_SAMPLES.png.length, width: 2, height: 3 } })
    expect(meta.navigation[0]).toMatchObject({ label: '第一卷', target: null })
    expect(meta.warnings).toEqual([])
  })

  it('重启读取：图文正文/导航树/补充文档/资源流都从落盘产物读出，且图文与文字共用同一内容', async () => {
    const { lb, dir } = await mk()
    const r = await lb.import(makeEpubFixture('epub3-rich'), '样本.epub')
    const again = await LocalBooks.create(dir)                       // 重启：不依赖任何进程内状态
    const content = await again.getChapterContent(r.bookKey, 0)
    if (content.kind !== 'rich') throw new Error('第 0 章应是图文树')
    expect(content.documentId).toBe('d0')
    expect(chapterContentToText(content)).toContain('下一行')
    expect(await again.getChapter(r.bookKey, 0)).toBe(chapterContentToText(content))

    const nav = await again.getNavigation(r.bookKey)
    expect(nav.chapters.map((c) => c.name)).toEqual(['第一章', '第二章'])          // 线性序列 = 进度/导出口径
    expect(nav.items.map((i) => i.label)).toEqual(['第一卷'])                      // 展示树 = 原生目录
    expect(nav.items[0].children.map((c) => c.label)).toEqual(['甲', '乙', '丙'])

    // 补充文档（脚注）可打开、不计章
    expect(chapterContentToText(await again.getSupplement(r.bookKey, 'd2'))).toContain('脚注一')
    // 资源：MIME 是验证结果，流读回的字节与落盘一致
    const res = await again.getResource(r.bookKey, 'r0')
    expect(res.mediaType).toBe('image/png')
    expect(res.bytes).toBe(IMAGE_SAMPLES.png.length)
    expect((await streamToBuffer(res.stream)).equals(IMAGE_SAMPLES.png)).toBe(true)
  })

  it('资源读口只认 ID：未知资源/未知文档/未知书/TXT 书/越界相对名 → 本地产物不存在（404 类目）', async () => {
    const { lb, dir } = await mk()
    const epub = await lb.import(makeEpubFixture('epub3-rich'), '样本.epub')
    const txt = await lb.import(Buffer.from('第1章 A\n内容', 'utf8'), 'x.txt')
    await expect(lb.getResource(epub.bookKey, 'r99')).rejects.toBeInstanceOf(LocalArtifactNotFoundError)
    await expect(lb.getSupplement(epub.bookKey, 'd99')).rejects.toBeInstanceOf(LocalArtifactNotFoundError)
    await expect(lb.getResource(epub.bookKey, '../original.epub')).rejects.toBeInstanceOf(LocalArtifactNotFoundError)
    await expect(lb.getResource(txt.bookKey, 'r0')).rejects.toBeInstanceOf(LocalArtifactNotFoundError)
    await expect(lb.getChapterContent('local:123e4567-e89b-12d3-a456-426614174000', 0)).rejects.toBeInstanceOf(LocalArtifactNotFoundError)
    // 章号越界也是「找不到」而不是 500
    await expect(lb.getChapterContent(epub.bookKey, 99)).rejects.toBeInstanceOf(LocalArtifactNotFoundError)

    // 原型链上的名字不是 ID：表是 JSON.parse 出来的普通对象，`meta.resources['constructor']` 命中继承成员
    // 会让 `ref.file` 取到 undefined → path.resolve 抛 TypeError → 分类落 other → 500。
    // 查表只认自有键，任意构造 id 都落到「找不到」这条既有路径（404）
    for (const evil of ['constructor', '__proto__', 'toString']) {
      await expect(lb.getResource(epub.bookKey, evil), evil).rejects.toBeInstanceOf(LocalArtifactNotFoundError)
      await expect(lb.getSupplement(epub.bookKey, evil), evil).rejects.toBeInstanceOf(LocalArtifactNotFoundError)
    }

    // 落盘元数据被改写成越界相对名：读口也照样挡住（相对名只可能来自本仓写入，但仍夹紧在本书目录内）
    const evilId = '22222222-2222-4222-8222-222222222222'
    await fs.writeFile(path.join(dir, 'local', `${evilId}.json`), JSON.stringify({
      schemaVersion: 2, format: 'epub', title: '越界', author: null, originalName: 'e.epub', importedAt: 1,
      chapters: [], documents: {}, navigation: [], warnings: [],
      resources: { r0: { id: 'r0', file: '../../../secret.png', mediaType: 'image/png', bytes: 1, width: 1, height: 1 } },
    }))
    await expect(lb.getResource(`local:${evilId}`, 'r0')).rejects.toBeInstanceOf(LocalArtifactNotFoundError)
  })

  it('资源文件被删（元数据仍在）→ 打开失败即抛，不返回半个流', async () => {
    const { lb, dir } = await mk()
    const r = await lb.import(makeEpubFixture('epub3-rich'), '样本.epub')
    const id = r.bookKey.slice('local:'.length)
    await fs.rm(path.join(dir, 'local', id, 'resources', 'r0.png'))
    await expect(lb.getResource(r.bookKey, 'r0')).rejects.toBeInstanceOf(LocalArtifactNotFoundError)
  })

  it('告警随元数据持久化：降级告警重启后仍读得到（resource 是书内逻辑名，不含主机路径）', async () => {
    const { lb, dir } = await mk()
    // 内联 SVG 里的锚点被我们自己剥掉 → 降级 + 告警（不是拒整本，口径见 import.ts 头注②）
    const r = await lb.import(makeEpubFixture('epub3-inline-svg-anchor'), '降级.epub')
    const degraded = r.warnings.filter((w) => w.code === 'epub-degraded-anchor')
    expect(degraded).toHaveLength(2)
    expect(degraded.every((w) => w.resource === 'OEBPS/ch1.xhtml')).toBe(true)
    expect(degraded.every((w) => w.message.includes('降级'))).toBe(true)
    const again = await LocalBooks.create(dir)
    expect(await again.getImportWarnings(r.bookKey)).toEqual(r.warnings)
  })
})
