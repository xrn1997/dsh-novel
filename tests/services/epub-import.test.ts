/**
 * 导入编排测试：`importEpub` 把一份 EPUB 字节变成「只有规范化文档与已验证资源」的指定目录。
 *
 * 这一层是**端到端**的（真 ZIP → 真包结构 → 真文档转换 → 真落盘），所以断言都落在生成物上：
 * 读回 JSON 里的**内容值**（不是「文件存在」）、按不透明 ID 拼出来的相对路径、以及资源字节的解码事实。
 *
 * 三条口径在这里被钉住：
 * ① 章数按 spine 主序列，补充文档可打开但不计章（脚注/附录）；
 * ② 只解析**可达**的补充文档（导航或书内链接指到的），未使用的 manifest 条目一律不要求受支持；
 * ③ 远程/损坏/被加密的资源、失效锚点、重复锚点、不支持的可见图形都让导入失败并点名；被移除的活动内容
 *    只记告警；正文内联 SVG 是这一条的唯一例外（剥离 + 告警，只有它是文档唯一内容时才失败）。
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ChapterContent, ContentNode, NavigationItem, ReadingTarget } from '../../src/shared/wire.js'
import type { EpubLimits } from '../../src/services/epub/archive.js'
import { EpubImportError } from '../../src/services/epub/errors.js'
import { importEpub, type EpubImportData } from '../../src/services/epub/import.js'
import { makeEpubFixture } from '../fixtures/epub.js'
import { makeTempDir } from '../temp-dir.js'

async function importOf(name: string, limits?: Partial<EpubLimits>): Promise<{ book: EpubImportData; dir: string }> {
  const dir = await makeTempDir('novel-epub-')
  return { book: await importEpub(makeEpubFixture(name), dir, limits), dir }
}

/** 收下被拒绝的异常（坏书不许冒充可读是本仓的最高罪）；「只写 outputDir」由成功路径的目录清单用例钉住 */
async function importRejection(name: string, limits?: Partial<EpubLimits>): Promise<Error> {
  const dir = await makeTempDir('novel-epub-')
  // 样本先造、**不进同一个 catch**：拼错样本名若也被这里接住，就成了「导入器按预期拒绝」的
  // 一条假读数——它报的是类型不符（Error 而不是 EpubImportError），实际什么都没测。
  const bytes = makeEpubFixture(name)
  try {
    await importEpub(bytes, dir, limits)
  } catch (e) {
    return e as Error
  }
  throw new Error(`预期拒绝，实际成功——坏书冒充可读是本仓的最高罪（样本：${name}）`)
}

function expectEpubError(e: Error, pattern: RegExp): void {
  expect(e.name).toBe('EpubImportError')
  expect(e).toBeInstanceOf(EpubImportError)
  expect(e.message).toMatch(pattern)
}

/** 读回落盘的文档 JSON（内容值断言都建立在它上面，只断言「文件存在」等于没断言） */
async function readDocument(dir: string, book: EpubImportData, documentId: string): Promise<ChapterContent> {
  const ref = book.documents[documentId]
  expect(ref, `文档 ${documentId} 不在索引里`).toBeTruthy()
  return JSON.parse(await fs.readFile(path.join(dir, ref.file), 'utf8')) as ChapterContent
}

function nodesOf(content: ChapterContent): ContentNode[] {
  if (content.kind !== 'rich') throw new Error('EPUB 文档必须是图文面')
  return content.nodes
}

/** 树上全部节点 ID（用来验证目录/链接的锚点真的落在生成物里） */
function collectIds(nodes: readonly ContentNode[]): Set<string> {
  const ids = new Set<string>()
  const walk = (list: readonly ContentNode[]): void => {
    for (const n of list) {
      if (n.kind === 'element' || n.kind === 'link') { ids.add(n.id); walk(n.children) }
      else if (n.kind !== 'text') ids.add(n.id)
    }
  }
  walk(nodes)
  return ids
}

/** 结构投影（去掉每次都变的 ID，便于整树断言） */
function shape(nodes: readonly ContentNode[]): unknown[] {
  return nodes.map((n) => {
    switch (n.kind) {
      case 'text': return n.text
      case 'break': return 'br'
      case 'rule': return 'hr'
      case 'image': return `img:${n.alt}:${n.width}x${n.height}`
      case 'link': return { link: n.role, target: n.target, children: shape(n.children) }
      case 'element': return { tag: n.tag, start: n.start, value: n.value, rowSpan: n.rowSpan, colSpan: n.colSpan, children: shape(n.children) }
    }
  })
}

/** 目录树的标签与目标（不含 children，避免断言里出现整棵树的噪声） */
function navShape(items: readonly NavigationItem[]): unknown[] {
  return items.map((i) => ({ label: i.label, target: i.target, children: navShape(i.children) }))
}

describe('epub3-rich：主序列计章、补充文档可打开但不计章', () => {
  it('脚注在补充文档中，不改变正文计数', async () => {
    const dir = await makeTempDir('novel-epub-')
    const book = await importEpub(makeEpubFixture('epub3-rich'), dir)
    expect(book.chapters).toHaveLength(2)
    expect(Object.keys(book.documents)).toHaveLength(3)
    expect(book.items[0].children).toHaveLength(3)
  })

  it('主序列按 spine 排（ZIP 顺序反着写也不影响），补充文档 index 为 null', async () => {
    const { book } = await importOf('epub3-rich')
    expect(book.title).toBe('图文样本')
    expect(book.author).toBe('样本作者')
    expect(book.chapters.map((c) => [c.index, c.label])).toEqual([[0, '第一章'], [1, '第二章']])
    const main = book.chapters.map((c) => book.documents[c.documentId])
    expect(main.map((d) => d.index)).toEqual([0, 1])
    expect(main[0].file).toMatch(/^documents\/\w+\.json$/)
    // 脚注文档：不在阅读序列里，但落盘可读
    const notes = Object.values(book.documents).find((d) => d.index === null)
    expect(notes?.path).toBe('OEBPS/notes.xhtml')
  })

  it('目录叶目标绑到「阅读单元/补充文档 + 锚点」，且锚点真的在生成物里', async () => {
    const { book, dir } = await importOf('epub3-rich')
    expect(navShape(book.items)).toEqual([
      { label: '第一卷', target: null, children: [
        { label: '甲', target: { kind: 'chapter', index: 0, anchorId: expect.stringMatching(/^a\d+$/) as unknown as string }, children: [] },
        { label: '乙', target: { kind: 'chapter', index: 0, anchorId: expect.stringMatching(/^a\d+$/) as unknown as string }, children: [] },
        { label: '丙', target: { kind: 'chapter', index: 1, anchorId: expect.stringMatching(/^a\d+$/) as unknown as string }, children: [] },
      ] },
    ])
    const leaves = book.items[0].children
    const ids = new Set<string>()
    for (const chapter of book.chapters) for (const id of collectIds(nodesOf(await readDocument(dir, book, chapter.documentId)))) ids.add(id)
    for (const leaf of leaves) {
      const target = leaf.target as Extract<ReadingTarget, { kind: 'chapter' }>
      expect(target.kind).toBe('chapter')
      if (target.kind === 'chapter' && target.anchorId !== null) expect(ids.has(target.anchorId), `锚点 ${target.anchorId} 不在文档树里`).toBe(true)
    }
    // 同一文档的两个锚点各自成条：anchorId 必须不同（否则两个叶指向同一处）
    expect((leaves[0].target as { anchorId: string }).anchorId).not.toBe((leaves[1].target as { anchorId: string }).anchorId)
  })

  it('正文内容值：粗斜体、列表编号、表格跨行跨列、pre/sup/sub/换行/分隔线', async () => {
    const { book, dir } = await importOf('epub3-rich')
    const nodes = nodesOf(await readDocument(dir, book, book.chapters[0].documentId))
    expect(shape(nodes)).toEqual([
      { tag: 'h1', start: null, value: null, rowSpan: null, colSpan: null, children: ['第一章'] },
      { tag: 'p', start: null, value: null, rowSpan: null, colSpan: null, children: [
        '甲 ',
        { tag: 'strong', start: null, value: null, rowSpan: null, colSpan: null, children: ['粗'] },
        ' 与 ',
        { tag: 'em', start: null, value: null, rowSpan: null, colSpan: null, children: ['斜'] },
        'br',
        '下一行',
      ] },
      { tag: 'p', start: null, value: null, rowSpan: null, colSpan: null, children: ['实体 & 与 &amp; 与 A'] },
      { tag: 'ol', start: 3, value: null, rowSpan: null, colSpan: null, children: [
        { tag: 'li', start: null, value: 7, rowSpan: null, colSpan: null, children: ['第七项'] },
        { tag: 'li', start: null, value: null, rowSpan: null, colSpan: null, children: ['第八项'] },
      ] },
      { tag: 'table', start: null, value: null, rowSpan: null, colSpan: null, children: [
        { tag: 'tr', start: null, value: null, rowSpan: null, colSpan: null, children: [
          { tag: 'th', start: null, value: null, rowSpan: 2, colSpan: null, children: ['竖跨'] },
          { tag: 'td', start: null, value: null, rowSpan: null, colSpan: 2, children: ['横跨'] },
        ] },
        { tag: 'tr', start: null, value: null, rowSpan: null, colSpan: null, children: [
          { tag: 'td', start: null, value: null, rowSpan: null, colSpan: null, children: ['右'] },
          { tag: 'td', start: null, value: null, rowSpan: null, colSpan: null, children: ['下'] },
        ] },
      ] },
      // pre 里的换行与缩进逐字保留（文字面的行规约会绕过 pre）
      { tag: 'pre', start: null, value: null, rowSpan: null, colSpan: null, children: ['pre 里  的空白\n  原样保留'] },
      { tag: 'p', start: null, value: null, rowSpan: null, colSpan: null, children: [
        '上标 x',
        { tag: 'sup', start: null, value: null, rowSpan: null, colSpan: null, children: ['2'] },
        ' 与下标 H',
        { tag: 'sub', start: null, value: null, rowSpan: null, colSpan: null, children: ['2'] },
        'O',
      ] },
      { tag: 'blockquote', start: null, value: null, rowSpan: null, colSpan: null, children: ['引用一段'] },
      'hr',
      { tag: 'p', start: null, value: null, rowSpan: null, colSpan: null, children: [
        'img:插图:2x3', 'img::2x3',
      ] },
      { tag: 'p', start: null, value: null, rowSpan: null, colSpan: null, children: [
        '脚注',
        { link: 'noteref', target: { kind: 'supplement', documentId: expect.any(String) as unknown as string, anchorId: expect.stringMatching(/^a\d+$/) as unknown as string }, children: ['1'] },
        '与跨章',
        { link: 'normal', target: { kind: 'chapter', index: 1, anchorId: expect.stringMatching(/^a\d+$/) as unknown as string }, children: ['丙'] },
      ] },
      { tag: 'div', start: null, value: null, rowSpan: null, colSpan: null, children: ['未知容器 ', '下划线', ' 保留子内容'] },
      { tag: 'div', start: null, value: null, rowSpan: null, colSpan: null, children: ['结构容器 ', { tag: 'strong', start: null, value: null, rowSpan: null, colSpan: null, children: ['变粗'] }] },
    ])
  })

  it('脚注链接指向补充文档、返回链接指回正文锚点（角色各自正确）', async () => {
    const { book, dir } = await importOf('epub3-rich')
    const notesRef = Object.values(book.documents).find((d) => d.index === null)
    expect(notesRef).toBeTruthy()
    const notes = nodesOf(await readDocument(dir, book, notesRef!.id))
    const back = notes.find((n) => n.kind === 'element' && n.children.some((c) => c.kind === 'link'))
    const link = (back as Extract<ContentNode, { kind: 'element' }>).children.find((c) => c.kind === 'link') as Extract<ContentNode, { kind: 'link' }>
    expect(link.role).toBe('backlink')
    expect(link.target).toMatchObject({ kind: 'chapter', index: 0 })
    // 反向链接的锚点确实落在第一章的树上（引用锚点）
    const ch1 = nodesOf(await readDocument(dir, book, book.chapters[0].documentId))
    const target = link.target as Extract<ReadingTarget, { kind: 'chapter' }>
    expect(target.anchorId).not.toBeNull()
    expect(collectIds(ch1).has(target.anchorId!)).toBe(true)
  })

  it('共享图片只落一份资源；资源字节按原样解码得出宽高', async () => {
    const { book, dir } = await importOf('epub3-rich')
    expect(Object.keys(book.resources)).toHaveLength(1)
    const [res] = Object.values(book.resources)
    expect(res.mediaType).toBe('image/png')
    expect([res.width, res.height]).toEqual([2, 3])
    expect(res.file).toMatch(/^resources\/r\d+\.png$/)
    expect(res.bytes).toBe(74)
    // 两章都引用它，但只写了一份文件；内容与 fixture 的 PNG 逐字节相同
    expect((await fs.readFile(path.join(dir, res.file))).equals(makePngSample())).toBe(true)
  })

  it('封面优先 EPUB3 的 cover-image：封面资源与正文插图是同一份（按书内路径去重）', async () => {
    const { book } = await importOf('epub3-rich')
    const cover = book.coverResourceId
    expect(cover).not.toBeNull()
    // 正文里也引了同一张图：资源表里只有一份，封面指向它
    expect(Object.keys(book.resources)).toEqual([cover])
    expect(book.resources[cover!].mediaType).toBe('image/png')
  })

  it('好书上没有告警（告警不许在好书上刷存在感）', async () => {
    const { book } = await importOf('epub3-rich')
    expect(book.warnings).toEqual([])
  })

  it('输出目录只含规范化文档与已验证资源，文件名只由 opaque ID 生成', async () => {
    const { book, dir } = await importOf('epub3-rich')
    expect((await fs.readdir(dir)).sort()).toEqual(['documents', 'resources'])
    const docs = await fs.readdir(path.join(dir, 'documents'))
    const resources = await fs.readdir(path.join(dir, 'resources'))
    expect(docs.sort()).toEqual(Object.values(book.documents).map((d) => path.basename(d.file)).sort())
    expect(resources.sort()).toEqual(Object.values(book.resources).map((r) => path.basename(r.file)).sort())
    for (const name of [...docs, ...resources]) expect(name).toMatch(/^[dnr]\d+\.[a-z0-9]+$/)
    // 原书副本、元数据提交标记都不归本层写（发布归服务层）
    expect(docs.some((n) => n.endsWith('.epub'))).toBe(false)
    expect(await fs.readdir(dir).then((l) => l.some((n) => n.endsWith('.json')))).toBe(false)
  })
})

/** 设计里的 2×3 PNG 字节（与 fixture 同一份）：断言「资源解码得出宽高且内容原样」 */
function makePngSample(): Buffer {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAYAAAC56t6BAAAAEUlEQVR4nGP4b5z2H4QZMBgA0UkPixOR9RgAAAAASUVORK5CYII=',
    'base64',
  )
}

describe('可达性与补充文档', () => {
  it('环形链接：a↔b 互链自然终止，文档各转一次', async () => {
    const { book } = await importOf('epub3-link-cycle')
    expect(book.chapters).toHaveLength(1)
    expect(Object.values(book.documents).map((d) => d.path).sort()).toEqual([
      'OEBPS/ch1.xhtml', 'OEBPS/text/a.xhtml', 'OEBPS/text/b.xhtml', 'OEBPS/text/c.xhtml',
    ].sort())
  })

  it('只在 manifest 里、不在 spine 里的文档：顺着链接可达就转换（c 靠 a↔b 链到）', async () => {
    const { book, dir } = await importOf('epub3-link-cycle')
    const c = Object.values(book.documents).find((d) => d.path === 'OEBPS/text/c.xhtml')
    expect(c?.index).toBeNull()
    const b = Object.values(book.documents).find((d) => d.path === 'OEBPS/text/b.xhtml')!
    const nodes = nodesOf(await readDocument(dir, book, b.id))
    const links = nodes.flatMap(function collect(n: ContentNode): ContentNode[] {
      if (n.kind === 'element') return n.children.flatMap(collect)
      if (n.kind === 'link') return [n, ...n.children.flatMap(collect)]
      return []
    }).filter((n): n is Extract<ContentNode, { kind: 'link' }> => n.kind === 'link')
    expect(links.map((l) => l.target)).toEqual([
      { kind: 'supplement', documentId: book.documents[Object.keys(book.documents).find((k) => book.documents[k].path === 'OEBPS/text/a.xhtml')!].id, anchorId: expect.stringMatching(/^a\d+$/) as unknown as string },
      { kind: 'supplement', documentId: c!.id, anchorId: expect.stringMatching(/^a\d+$/) as unknown as string },
    ])
  })

  it('导航指到的补充文档：可达性也可以只由目录建立，且不计章', async () => {
    const { book } = await importOf('epub3-nav-to-supplement')
    expect(book.chapters).toHaveLength(1)
    expect(Object.values(book.documents).map((d) => d.path).sort()).toEqual(['OEBPS/ch1.xhtml', 'OEBPS/sup.xhtml'])
    const leaf = book.items[1]
    expect(leaf.label).toBe('附录')
    const target = leaf.target as Extract<ReadingTarget, { kind: 'supplement' }>
    expect(target.kind).toBe('supplement')
    expect(target.documentId).toBe(Object.values(book.documents).find((d) => d.path === 'OEBPS/sup.xhtml')!.id)
  })

  it('spine 里声明了补充文档但没有任何链接/导航指向它：不解析（未使用条目不受支持要求）', async () => {
    const { book } = await importOf('epub3-supplement-unreachable')
    expect(book.chapters).toHaveLength(1)
    expect(Object.values(book.documents).map((d) => d.path)).toEqual(['OEBPS/ch1.xhtml'])
    // 没有目录 → 包层已记合成导航的告警（与「不解析孤立补充文档」无关）
    expect(book.warnings.map((w) => w.code)).toEqual(['epub-navigation-synthesized'])
  })

  it('未使用的 manifest 资源不要求受支持：垃圾字节的未用图片 / 未用音频都不拒整本', async () => {
    const bad = await importOf('epub3-unused-bad-image')
    expect(bad.book.chapters).toHaveLength(1)
    expect(Object.keys(bad.book.resources)).toEqual([])
    expect(bad.book.coverResourceId).toBeNull()
    const audio = await importOf('epub-audio-unused')
    expect(audio.book.chapters).toHaveLength(2)
    expect(Object.keys(audio.book.resources)).toEqual([])
  })
})

describe('纯插图章节与无封面', () => {
  it('纯插图章节是有效正文；同一张图两章引用只落一份资源', async () => {
    const { book, dir } = await importOf('epub3-image-only')
    expect(book.chapters).toHaveLength(2)
    expect(Object.keys(book.resources)).toHaveLength(1)
    const first = nodesOf(await readDocument(dir, book, book.chapters[0].documentId))
    expect(shape(first)).toEqual(['img:整页插图:2x3'])
    // 第二章用 `../OEBPS/...` 那套相对路径引用同一张图：归一到同一份资源
    const second = nodesOf(await readDocument(dir, book, book.chapters[1].documentId))
    expect(shape(second)).toEqual([
      { tag: 'p', start: null, value: null, rowSpan: null, colSpan: null, children: ['接着看图', 'img::2x3'] },
    ])
  })

  it('没有封面不是失败（coverResourceId 为 null）', async () => {
    const { book } = await importOf('epub3-no-nav')
    expect(book.coverResourceId).toBeNull()
    expect(book.chapters).toHaveLength(2)
  })

  it('EPUB2：NCX 的目标绑到锚点，封面走 meta name="cover"', async () => {
    const { book } = await importOf('epub2-basic')
    expect(navShape(book.items)).toEqual([
      { label: '上卷', target: { kind: 'chapter', index: 0, anchorId: expect.stringMatching(/^a\d+$/) as unknown as string }, children: [
        { label: '第一章', target: { kind: 'chapter', index: 0, anchorId: expect.stringMatching(/^a\d+$/) as unknown as string }, children: [] },
      ] },
      { label: '第二章', target: { kind: 'chapter', index: 1, anchorId: null }, children: [] },
    ])
    const cover = book.coverResourceId
    expect(cover).not.toBeNull()
    expect(book.resources[cover!]).toMatchObject({ mediaType: 'image/png', width: 2, height: 3 })
  })

  it('两种封面声明同时在：取 EPUB3 的 cover-image（EPUB2 的 meta 只是其次）', async () => {
    const { book, dir } = await importOf('epub3-cover-priority')
    const cover = book.coverResourceId
    expect(cover).not.toBeNull()
    expect(book.resources[cover!]).toMatchObject({ mediaType: 'image/png', width: 2, height: 3 })
    expect((await fs.readFile(path.join(dir, book.resources[cover!].file))).equals(makePngSample())).toBe(true)
    // 没被采纳的那条不登记（也未使用）：EPUB2 那份声明的字节是垃圾，取错就会当场报错而不是悄悄换一张
    expect(Object.keys(book.resources)).toEqual([cover])
  })

  it('路径形态样本（中文/空格/百分号 + 同文档锚点）：正文与导航目标都落对', async () => {
    const { book } = await importOf('epub3-paths')
    expect(book.chapters.map((c) => c.label)).toEqual(['中文'])
    // 第二个导航叶指向导航文档自己的锚点：那份文档按「导航可达」转成补充文档
    const leaf = book.items[1]
    expect(leaf.label).toBe('本页顶')
    expect(leaf.target).toMatchObject({ kind: 'supplement', anchorId: expect.stringMatching(/^a\d+$/) as unknown as string })
  })
})

describe('EPUB2 命名锚点与声明形态', () => {
  it('目录目标指向 <a name="x">：整本可导入，目标绑到那个锚点（且锚点真的落在生成物里）', async () => {
    const { book, dir } = await importOf('epub2-named-anchor')
    expect(book.chapters).toHaveLength(1)
    const documentId = book.chapters[0].documentId
    const nodes = nodesOf(await readDocument(dir, book, documentId))
    const ids = collectIds(nodes)
    const targets = book.items.map((i) => i.target as Extract<ReadingTarget, { kind: 'chapter' }>)
    expect(targets.map((t) => t.kind)).toEqual(['chapter', 'chapter', 'chapter', 'chapter'])
    for (const t of targets) {
      expect(t.anchorId).toMatch(/^a\d+$/)
      expect(ids.has(t.anchorId!), `锚点 ${t.anchorId} 不在文档树里`).toBe(true)
    }
    // 只有 name / name 与 id 双写 / 一个元素上两个不同的名字：都指向各自那个元素的落点
    expect(targets[0].anchorId).not.toBe(targets[1].anchorId)
    expect(targets[2].anchorId).toBe(targets[3].anchorId)
    expect(shape(nodes)).toEqual([
      { tag: 'h1', start: null, value: null, rowSpan: null, colSpan: null, children: ['第一章'] },
      { tag: 'p', start: null, value: null, rowSpan: null, colSpan: null, children: [
        { tag: 'span', start: null, value: null, rowSpan: null, colSpan: null, children: [] }, '甲',
      ] },
      { tag: 'p', start: null, value: null, rowSpan: null, colSpan: null, children: [
        { tag: 'span', start: null, value: null, rowSpan: null, colSpan: null, children: [] }, '乙',
      ] },
      { tag: 'p', start: null, value: null, rowSpan: null, colSpan: null, children: [
        { tag: 'span', start: null, value: null, rowSpan: null, colSpan: null, children: [] }, '丙',
      ] },
    ])
  })

  it('media-type 带参数/大写：spine 与导航文档都照读（声明形态不改变资源种类）', async () => {
    const { book } = await importOf('epub3-parameter-media-type')
    expect(book.chapters).toHaveLength(1)
    // 导航文档自己也成了可达文档（导航的第二个叶指向它自己的锚点）
    expect(Object.values(book.documents).map((d) => d.path).sort())
      .toEqual(['OEBPS/ch1.xhtml', 'OEBPS/nav.xhtml'])
    expect(book.items[1].target).toMatchObject({ kind: 'supplement', anchorId: expect.stringMatching(/^a\d+$/) as unknown as string })
  })
})

describe('SVG：独立插图重建、包装封面解析成栅格', () => {
  it('插图为重建后的 SVG 资源（落盘内容与返回的 content 一致）', async () => {
    const { book, dir } = await importOf('epub3-svg-figure')
    expect(Object.keys(book.resources)).toHaveLength(2)
    const fig = Object.values(book.resources).find((r) => r.mediaType === 'image/svg+xml')!
    expect(fig.file).toMatch(/^resources\/r\d+\.svg$/)
    expect([fig.width, fig.height]).toEqual([10, 20])
    const onDisk = await fs.readFile(path.join(dir, fig.file), 'utf8')
    // bytes 记的是**落盘产物**的大小（重建后的 SVG 与源文件常常不一样长），不是原条目大小
    expect(fig.bytes).toBe(Buffer.byteLength(onDisk, 'utf8'))
    expect(onDisk).toMatch(/<svg[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/)
    expect(onDisk).toMatch(/fill="url\(#s\d+\)"/)
    // 源文件写的是大写 `URL(#grad)`（CSS 的 url() 大小写不敏感）：漏掉它就会留下一条指向已改写 ID 的死链
    expect(onDisk).not.toMatch(/url\(#grad\)/i)
    expect(onDisk).not.toMatch(/<script|alert\(1\)|<style/)
    // 插图节点用重建后的宽高占位（首帧即有尺寸，加载完不跳版）
    const nodes = nodesOf(await readDocument(dir, book, book.chapters[0].documentId))
    expect(shape(nodes)).toEqual([
      { tag: 'p', start: null, value: null, rowSpan: null, colSpan: null, children: ['插图', 'img:矢量插图:10x20'] },
    ])
  })

  it('SVG 单图包装封面：封面资源是它包的那张 PNG，不是那份 SVG', async () => {
    const { book, dir } = await importOf('epub3-svg-figure')
    const cover = book.coverResourceId
    expect(cover).not.toBeNull()
    expect(book.resources[cover!]).toMatchObject({ mediaType: 'image/png', width: 2, height: 3 })
    expect(book.resources[cover!].file).toMatch(/\.png$/)
    expect((await fs.readFile(path.join(dir, book.resources[cover!].file))).equals(makePngSample())).toBe(true)
    // 包装用的 SVG 本身没有落盘（它不是内容，只是一层包装）
    expect(Object.values(book.resources).some((r) => r.file.includes('cover'))).toBe(false)
    expect(await fs.readdir(path.join(dir, 'resources'))).toHaveLength(2)
  })
})

describe('安全面：拒绝要有精确错误', () => {
  it('正文远程图片：失败并点名这张图与出处文档', async () => {
    const e = await importRejection('epub3-remote-image')
    expectEpubError(e, /example\.invalid/)
    expectEpubError(e, /OEBPS\/ch1\.xhtml/)
  })

  it('被引用的图片损坏：失败并点名资源', async () => {
    const e = await importRejection('epub3-broken-image')
    expectEpubError(e, /OEBPS\/images\/fig\.png/)
    expectEpubError(e, /损坏|IEND/)
  })

  it('声明的封面损坏：失败并点名封面资源（不造一个有效封面 URL）', async () => {
    const e = await importRejection('epub3-broken-cover')
    expectEpubError(e, /OEBPS\/images\/cover\.png/)
  })

  it('重复锚点：失败并点名文档', async () => {
    const e = await importRejection('epub3-dup-anchor')
    expectEpubError(e, /重复/)
    expectEpubError(e, /OEBPS\/ch1\.xhtml/)
  })

  it('失效锚点（导航指向不存在的锚点）：失败并点名锚点', async () => {
    const e = await importRejection('epub3-missing-anchor')
    expectEpubError(e, /gone/)
    expectEpubError(e, /OEBPS\/ch1\.xhtml/)
  })

  it('失效链接（正文链到归档里没有的文档）：失败并点名目标', async () => {
    const e = await importRejection('epub3-missing-target')
    expectEpubError(e, /gone\.xhtml/)
    expectEpubError(e, /OEBPS\/ch1\.xhtml/)
  })

  it('正文内联 SVG 是文档唯一内容：失败并点名文档与原因（剥离后没有别的正文）', async () => {
    const e = await importRejection('epub3-inline-svg-only')
    expectEpubError(e, /OEBPS\/ch1\.xhtml/)
    expectEpubError(e, /唯一/)
    expectEpubError(e, /svg/i)
  })

  it('SVG 里的 foreignObject：失败并点名资源（内嵌 HTML 的可见图形不支持）', async () => {
    const e = await importRejection('epub3-svg-foreign-object')
    expectEpubError(e, /foreignObject/)
    expectEpubError(e, /OEBPS\/images\/fig\.svg/)
  })

  it('SVG 里的 use 外链：失败并点名资源（绝不发请求）', async () => {
    const e = await importRejection('epub3-svg-external-use')
    expectEpubError(e, /use/)
    expectEpubError(e, /OEBPS\/images\/fig\.svg/)
  })

  it('SVG 引用未登记的渐变：失败并点名资源（不改写冒充成功）', async () => {
    const e = await importRejection('epub3-svg-missing-gradient')
    expectEpubError(e, /missing/)
    expectEpubError(e, /OEBPS\/images\/fig\.svg/)
  })

  it('被引用的图片在 encryption.xml 里：失败并点名「被加密」，不是「损坏」', async () => {
    const e = await importRejection('epub3-encrypted-image')
    expectEpubError(e, /OEBPS\/images\/fig\.png/)
    expectEpubError(e, /加密/)
    // 原因必须精确：字节是被混淆的，按字节报错会把读者引去换图（那是白费力气）
    expect(e.message).not.toMatch(/损坏/)
  })

  it('写入失败（输出目录不可用）：报本子树的异常类，且不泄露主机绝对路径', async () => {
    const dir = await makeTempDir('novel-epub-')
    // 把输出目录指到一个**文件**下面：mkdir/写文件必然失败，且与平台权限语义无关（可确定性复现）
    const blocked = path.join(dir, 'blocked')
    await fs.writeFile(blocked, '不是一个目录')
    let caught: Error | null = null
    try {
      await importEpub(makeEpubFixture('epub3-no-nav'), blocked)
    } catch (e) {
      caught = e as Error
    }
    expect(caught).toBeInstanceOf(EpubImportError)
    expect(caught!.message).toMatch(/documents\/d\d+\.json/)
    expect(caught!.message).not.toContain(dir)   // 主机布局不进用户可见文案
  })

  it('超深正文：默认深度预算即报错，且是本子树的异常类（不是爆栈）', async () => {
    const e = await importRejection('epub3-doc-too-deep')
    expectEpubError(e, /OEBPS\/ch1\.xhtml/)
    expectEpubError(e, /深度/)
    expect(e.constructor.name).toBe('EpubImportError')
  })

  it('超宽正文：默认预算读得出，节点预算缩到 200 后报错并点名这份文档', async () => {
    const ok = await importOf('epub3-doc-too-wide')
    expect(ok.book.chapters).toHaveLength(1)
    const e = await importRejection('epub3-doc-too-wide', { xmlNodes: 200 })
    expectEpubError(e, /OEBPS\/ch1\.xhtml/)
    expectEpubError(e, /节点/)
  })

  it('被引用的图片像素超预算：失败并点名资源（缩预算，不必造真大图）', async () => {
    const e = await importRejection('epub3-rich', { imagePixels: 5 })
    expectEpubError(e, /OEBPS\/cover\.png/)
    expectEpubError(e, /像素/)
  })
})

describe('安全面：安全去除项要有告警，不默默失去内容', () => {
  it('脚本/内嵌框/对象/表单/样式/事件属性一律剥除，正文文字保留', async () => {
    const { book, dir } = await importOf('epub3-active-content')
    expect(book.chapters).toHaveLength(1)
    expect(book.warnings.map((w) => w.code).sort())
      .toEqual(['epub-active-attribute', 'epub-css-attribute', 'epub-external-link', 'epub-link-not-followable', 'epub-removed-active-content'])
    for (const w of book.warnings) expect(w.resource).toBe('OEBPS/ch1.xhtml')
    const nodes = nodesOf(await readDocument(dir, book, book.chapters[0].documentId))
    expect(shape(nodes)).toEqual([
      { tag: 'p', start: null, value: null, rowSpan: null, colSpan: null, children: ['点击这里'] },
      { tag: 'p', start: null, value: null, rowSpan: null, colSpan: null, children: ['JS 链', 'FILE 链', 'DATA 链', '外站链'] },
      { tag: 'p', start: null, value: null, rowSpan: null, colSpan: null, children: ['正文保留'] },
    ])
    // 树上一个 link 节点都没有：非书内 href 一律取消可点击性（只留文字）
    expect(JSON.stringify(nodes)).not.toMatch(/"link"/)
  })

  it('告警合并同类同文：脚本/样式这一类的处数写进 message，不刷一屏', async () => {
    const { book } = await importOf('epub3-active-content')
    const removed = book.warnings.find((w) => w.code === 'epub-removed-active-content')
    expect(removed?.message).toMatch(/处/)
    expect(removed?.message).toMatch(/script/)
  })

  it('正文内联 SVG：整本照读，装饰图形剥离并留告警（点名文档与处数）', async () => {
    const { book, dir } = await importOf('epub3-inline-svg')
    expect(book.chapters).toHaveLength(1)
    const svgWarn = book.warnings.filter((w) => w.code === 'epub-removed-inline-svg')
    expect(svgWarn).toHaveLength(1)
    expect(svgWarn[0].resource).toBe('OEBPS/ch1.xhtml')
    expect(svgWarn[0].message).toMatch(/svg/)
    // 被剥离的是内联 SVG 那一块，正文文字照旧（不静默丢内容：丢了什么看得见）
    const nodes = nodesOf(await readDocument(dir, book, book.chapters[0].documentId))
    expect(shape(nodes)).toEqual([
      { tag: 'p', start: null, value: null, rowSpan: null, colSpan: null, children: ['图：'] },
    ])
  })
})

/**
 * 真书反例（2026-09-26，Gutenberg #7337 图像版）：spine 第一项是「整页只有一棵内联 SVG、
 * 里面只有一张 `<image>` 指向书内封面图」的封面页——EPUB3 推荐的封面写法。原先这条判据把它
 * 当空章节拒掉整本书。现在的口径：**只在整页别无可读内容时**按那张图导成单图章节，
 * 其余形状（书外图、图外加矢量、页里有正文）一概维持原判定。
 */
describe('整页 SVG 图形页：按其内唯一一张书内图降级成单图章节', () => {
  it('封面页导入成功：章按 spine 计、图与声明的封面共用一份资源、降级看得见', async () => {
    const { book, dir } = await importOf('epub3-svg-cover-page')
    expect(book.chapters.map((c) => c.label)).toEqual(['封面', '第一章'])
    const nodes = nodesOf(await readDocument(dir, book, book.chapters[0].documentId))
    expect(nodes).toHaveLength(1)
    const img = nodes[0]
    expect(img.kind).toBe('image')
    if (img.kind !== 'image') throw new Error(`封面页应当是一张图，实际 ${img.kind}`)
    // 宽高取自**图片本身**的事实（2×3 的 PNG），不是 SVG 上那套 width="100%" 的百分比
    expect([img.width, img.height, img.alt]).toEqual([2, 3, ''])
    // 同一张 PNG 同时是声明的封面：资源只落一份，两处引用同一个不透明 ID
    expect(img.resourceId).toBe(book.coverResourceId)
    expect(Object.keys(book.resources)).toHaveLength(1)
    // 降级要看得见；而「移除了内联 SVG」那条不再成立——图形没被丢掉，是按图读进来了
    const codes = book.warnings.map((w) => w.code)
    expect(codes).toContain('epub-svg-image-page')
    expect(codes).not.toContain('epub-removed-inline-svg')
    const warn = book.warnings.find((w) => w.code === 'epub-svg-image-page')!
    expect(warn.resource).toBe('OEBPS/wrap0000.xhtml')
    expect(warn.message).toMatch(/图/)
  })

  it('那张图指向书外：整本仍被拒，且点名是「图在书外」（新判据不新增失败面）', async () => {
    const e = await importRejection('epub3-svg-cover-page-remote')
    expectEpubError(e, /OEBPS\/wrap0000\.xhtml/)
    expectEpubError(e, /书外/)
  })

  it('SVG 里除那张图还有矢量形状：不是「只包一张图」，仍按原口径拒绝', async () => {
    const e = await importRejection('epub3-svg-cover-page-not-sole')
    expectEpubError(e, /OEBPS\/wrap0000\.xhtml/)
    expectEpubError(e, /唯一/)
  })

  it('封面页容器带的锚点随图落到树上：目录指向它不是悬空锚点', async () => {
    // 容器（`div#cover`）被那张图顶替，它承载的锚点在扫描期已铸成 ID。替代出来的树上必须有这个
    // ID 的落点，否则目录那条目标指向一个不存在的节点（阅读会话退回章首、目录当前项量不到）。
    const { book, dir } = await importOf('epub3-svg-cover-anchor')
    const leaf = book.items.flatMap(function flat(i: NavigationItem): NavigationItem[] {
      return [i, ...i.children.flatMap(flat)]
    }).find((i) => i.label === '封面')!
    expect(leaf.target).toMatchObject({ kind: 'chapter', index: 0 })
    const anchorId = (leaf.target as { anchorId: string | null }).anchorId
    expect(anchorId).toMatch(/^a\d+$/)
    const nodes = nodesOf(await readDocument(dir, book, book.chapters[0].documentId))
    expect(collectIds(nodes).has(anchorId!), `锚点 ${anchorId} 不在文档树里`).toBe(true)
  })

  it('SVG 资源按 XML 类别的字节预算读：同一样本默认导入成功、预算收紧即拒', async () => {
    // 只断言「拒了」证明不了拒的是 XML 那一档上限（图片档 32 MiB 也会在别处拒）。两向验：
    // 默认预算下这份 4 KB 的 SVG 正常导入，把 xmlBytes 收到 1 KB 才拒——拒的正是这一类。
    const { book } = await importOf('epub3-svg-oversize')
    expect(book.chapters).toHaveLength(1)
    const e = await importRejection('epub3-svg-oversize', { xmlBytes: 1024 })
    expectEpubError(e, /fig\.svg/)
    expectEpubError(e, /解压超过上限/)
  })

  it('有正文的页里夹一棵单图 SVG：照旧剥离 + 告警，不因新判据多落一张图', async () => {
    const { book, dir } = await importOf('epub3-inline-svg-image-with-text')
    expect(Object.keys(book.resources)).toHaveLength(0)
    const nodes = nodesOf(await readDocument(dir, book, book.chapters[0].documentId))
    expect(shape(nodes)).toEqual([
      { tag: 'p', start: null, value: null, rowSpan: null, colSpan: null, children: ['正文与花饰'] },
    ])
    const codes = book.warnings.map((w) => w.code)
    expect(codes).toContain('epub-removed-inline-svg')
    expect(codes).not.toContain('epub-svg-image-page')
  })
})

describe('目标锚点随被剥离内容消失：降级 + 告警，不拒整本', () => {
  /** 降级告警按动作分两条（导航降级 / 内链降级），同码但动作不同——同码同资源同动作才合并 */
  async function degradedWarnings(name: string): Promise<{ nav: string[]; link: string[] }> {
    const { book } = await importOf(name)
    const hit = book.warnings.filter((w) => w.code === 'epub-degraded-anchor')
    return {
      nav: hit.filter((w) => /降级到该文档开头/.test(w.message)).map((w) => `${w.resource}\u0000${w.message}`),
      link: hit.filter((w) => /降级成纯文本/.test(w.message)).map((w) => `${w.resource}\u0000${w.message}`),
    }
  }

  it('导航目标指向内联 SVG 内的锚点：整本照读，该叶降级到文档开头并点名文档与锚点', async () => {
    const { book } = await importOf('epub3-inline-svg-anchor')
    expect(book.chapters).toHaveLength(1)
    // 目标降级成「该文档 + 无片段」：文档还在、位置退到开头，导航仍然可用
    expect(book.items[0].target).toEqual({ kind: 'chapter', index: 0, anchorId: null })
    // 对照组：真锚点照旧绑到落点——降级不是「这份文档的锚点全都不绑了」
    expect(book.items[1].target).toMatchObject({ anchorId: expect.stringMatching(/^a\d+$/) as unknown as string })
    const { nav } = await degradedWarnings('epub3-inline-svg-anchor')
    expect(nav).toHaveLength(1)
    expect(nav[0]).toContain('OEBPS/ch1.xhtml')   // 告警点名文档
    expect(nav[0]).toContain('#ornament')         // 与锚点（导航仍然点了名，用户看得见降级事实）
  })

  it('正文内链指向同一处：该链接降级成纯文本（只留子内容），并留同风格告警', async () => {
    const { book, dir } = await importOf('epub3-inline-svg-anchor')
    const nodes = nodesOf(await readDocument(dir, book, book.chapters[0].documentId))
    // 降级的那条只剩文字（不再有 link 节点），同一段里指向真锚点的另一条照旧是链接
    expect(shape(nodes)).toEqual([
      { tag: 'h1', start: null, value: null, rowSpan: null, colSpan: null, children: ['第一章'] },
      { tag: 'p', start: null, value: null, rowSpan: null, colSpan: null, children: ['图：'] },
      { tag: 'p', start: null, value: null, rowSpan: null, colSpan: null, children: [
        '看', '这张图', '与',
        { link: 'normal', target: { kind: 'chapter', index: 0, anchorId: expect.stringMatching(/^a\d+$/) as unknown as string }, children: ['开头'] },
      ] },
    ])
    expect(JSON.stringify(nodes)).not.toMatch(/ornament/)
    const { link } = await degradedWarnings('epub3-inline-svg-anchor')
    expect(link).toHaveLength(1)
    expect(link[0]).toContain('OEBPS/ch1.xhtml')
    expect(link[0]).toContain('#ornament')
  })

  it('锚点从未存在（拼写错）：仍然整本拒收——降级只认「被剥离内容里确实有过这个锚点」', async () => {
    // 这份文档里同样有被剥离的内联 SVG（其中确实有个 id），但链接指的是拼错的名字：
    // 从没存在过的目标仍是「我们读不懂」，不许被降级路径吞掉（宁炸不猜）
    const e = await importRejection('epub3-inline-svg-bad-anchor')
    expectEpubError(e, /ornamnet/)
    expectEpubError(e, /不存在/)
    expectEpubError(e, /OEBPS\/ch1\.xhtml/)
  })
})
