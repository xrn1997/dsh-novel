/**
 * 导入编排测试：`importEpub` 把一份 EPUB 字节变成「只有规范化文档与已验证资源」的指定目录。
 *
 * 这一层是**端到端**的（真 ZIP → 真包结构 → 真文档转换 → 真落盘），所以断言都落在生成物上：
 * 读回 JSON 里的**内容值**（不是「文件存在」）、按不透明 ID 拼出来的相对路径、以及资源字节的解码事实。
 *
 * 三条口径在这里被钉住：
 * ① 章数按 spine 主序列，补充文档可打开但不计章（脚注/附录）；
 * ② 只解析**可达**的补充文档（导航或书内链接指到的），未使用的 manifest 条目一律不要求受支持；
 * ③ 半径按主语落（`ADR-0061`、`ADR-0063`）：整本拒只留给容器入口与包文档读不出、主序列被剪到空、
 *    声明了封面却读不出、写不出产物；一份文档读不出（空白页、DOM 超预算、
 *    整页 SVG 落不下那张图）→ 留空页 + 点名的痕，一条声明或一处引用解不开 → 剪那一条 / 取消可点击性，
 *    一张图读不出 → 该处不留。被剥除的活动内容与降级（重复锚点取文档序第一个、导航目标随剥离降级、
 *    目标锚点从未存在时按该条降级）只记痕。
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ChapterContent, ContentNode, LocalImportWarning, NavigationItem, ReadingTarget } from '../../src/shared/wire.js'
import type { EpubLimits } from '../../src/services/epub/archive.js'
import { EpubImportError } from '../../src/services/epub/errors.js'
import { importEpub, type EpubImportData } from '../../src/services/epub/import.js'
import { FINDING_RADII, warningListOf } from '../../src/services/epub/findings.js'
import { chapterContentToText } from '../../src/services/chapter-content.js'
import { makeEpubFixture } from '../fixtures/epub.js'
import { makeTempDir } from '../temp-dir.js'
import { must, pick } from '../support/fixture.js'

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

/** 导入落盘的是事实清单（半径、处数与例子都在里面）；断言按生产同一条投影取给用户看的那一份 */
function warningsOf(data: EpubImportData): LocalImportWarning[] {
  return warningListOf(data.findings)
}

function expectEpubError(e: Error, pattern: RegExp): void {
  expect(e.name).toBe('EpubImportError')
  expect(e).toBeInstanceOf(EpubImportError)
  expect(e.message).toMatch(pattern)
}

/** 读回落盘的文档 JSON（内容值断言都建立在它上面，只断言「文件存在」等于没断言） */
async function readDocument(dir: string, book: EpubImportData, documentId: string): Promise<ChapterContent> {
  const ref = must(book.documents[documentId], `文档索引 ${documentId}（导入回执里没有这一份）`)
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
  return nodes.map((n): unknown => {
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

/** 锚点号 / 文档号在期望值里是运行期匹配器，不是被断言到的那串值——收成 unknown，不冒充 string。 */
const anchorMatching = (): unknown => expect.stringMatching(/^a\d+$/)
const documentIdMatching = (): unknown => expect.any(String)

describe('epub3-rich：主序列计章、补充文档可打开但不计章', () => {
  it('脚注在补充文档中，不改变正文计数', async () => {
    const dir = await makeTempDir('novel-epub-')
    const book = await importEpub(makeEpubFixture('epub3-rich'), dir)
    expect(book.chapters).toHaveLength(2)
    expect(Object.keys(book.documents)).toHaveLength(3)
    expect(pick(book.items, 0).children).toHaveLength(3)
  })

  it('主序列按 spine 排（ZIP 顺序反着写也不影响），补充文档 index 为 null', async () => {
    const { book } = await importOf('epub3-rich')
    expect(book.title).toBe('图文样本')
    expect(book.author).toBe('样本作者')
    expect(book.chapters.map((c) => [c.index, c.label])).toEqual([[0, '第一章'], [1, '第二章']])
    const main = book.chapters.map((c) => must(book.documents[c.documentId], `文档索引 ${c.documentId}`))
    expect(main.map((d) => d.index)).toEqual([0, 1])
    expect(pick(main, 0).file).toMatch(/^documents\/\w+\.json$/)
    // 脚注文档：不在阅读序列里，但落盘可读
    const notes = Object.values(book.documents).find((d) => d.index === null)
    expect(notes?.path).toBe('OEBPS/notes.xhtml')
  })

  it('目录叶目标绑到「阅读单元/补充文档 + 锚点」，且锚点真的在生成物里', async () => {
    const { book, dir } = await importOf('epub3-rich')
    expect(navShape(book.items)).toEqual([
      { label: '第一卷', target: null, children: [
        { label: '甲', target: { kind: 'chapter', index: 0, anchorId: anchorMatching() }, children: [] },
        { label: '乙', target: { kind: 'chapter', index: 0, anchorId: anchorMatching() }, children: [] },
        { label: '丙', target: { kind: 'chapter', index: 1, anchorId: anchorMatching() }, children: [] },
      ] },
    ])
    const leaves = pick(book.items, 0).children
    const ids = new Set<string>()
    for (const chapter of book.chapters) for (const id of collectIds(nodesOf(await readDocument(dir, book, chapter.documentId)))) ids.add(id)
    for (const leaf of leaves) {
      const target = leaf.target as Extract<ReadingTarget, { kind: 'chapter' }>
      expect(target.kind).toBe('chapter')
      if (target.anchorId !== null) expect(ids.has(target.anchorId), `锚点 ${target.anchorId} 不在文档树里`).toBe(true)
    }
    // 同一文档的两个锚点各自成条：anchorId 必须不同（否则两个叶指向同一处）
    expect((pick(leaves, 0).target as { anchorId: string }).anchorId).not.toBe((pick(leaves, 1).target as { anchorId: string }).anchorId)
  })

  it('正文内容值：粗斜体、列表编号、表格跨行跨列、pre/sup/sub/换行/分隔线', async () => {
    const { book, dir } = await importOf('epub3-rich')
    const nodes = nodesOf(await readDocument(dir, book, pick(book.chapters, 0).documentId))
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
        { link: 'noteref', target: { kind: 'supplement', documentId: documentIdMatching(), anchorId: anchorMatching() }, children: ['1'] },
        '与跨章',
        { link: 'normal', target: { kind: 'chapter', index: 1, anchorId: anchorMatching() }, children: ['丙'] },
      ] },
      { tag: 'div', start: null, value: null, rowSpan: null, colSpan: null, children: ['未知容器 ', '下划线', ' 保留子内容'] },
      { tag: 'div', start: null, value: null, rowSpan: null, colSpan: null, children: ['结构容器 ', { tag: 'strong', start: null, value: null, rowSpan: null, colSpan: null, children: ['变粗'] }] },
    ])
  })

  it('脚注链接指向补充文档、返回链接指回正文锚点（角色各自正确）', async () => {
    const { book, dir } = await importOf('epub3-rich')
    const notesRef = Object.values(book.documents).find((d) => d.index === null)
    expect(notesRef).toBeTruthy()
    const notes = nodesOf(await readDocument(dir, book, must(notesRef, '补充文档引用').id))
    const back = notes.find((n) => n.kind === 'element' && n.children.some((c) => c.kind === 'link'))
    const link = (back as Extract<ContentNode, { kind: 'element' }>).children.find((c) => c.kind === 'link') as Extract<ContentNode, { kind: 'link' }>
    expect(link.role).toBe('backlink')
    expect(link.target).toMatchObject({ kind: 'chapter', index: 0 })
    // 反向链接的锚点确实落在第一章的树上（引用锚点）
    const ch1 = nodesOf(await readDocument(dir, book, pick(book.chapters, 0).documentId))
    const target = link.target as Extract<ReadingTarget, { kind: 'chapter' }>
    expect(target.anchorId).not.toBeNull()
    expect(collectIds(ch1).has(must(target.anchorId, '目录叶的锚点号'))).toBe(true)
  })

  it('共享图片只落一份资源；资源字节按原样解码得出宽高', async () => {
    const { book, dir } = await importOf('epub3-rich')
    expect(Object.keys(book.resources)).toHaveLength(1)
    const res = pick(Object.values(book.resources), 0)
    expect(res.mediaType).toBe('image/png')
    expect([res.width, res.height]).toEqual([2, 3])
    expect(res.file).toMatch(/^resources\/r\d+\.png$/)
    expect(res.bytes).toBe(74)
    // 两章都引用它，但只写了一份文件；内容与 fixture 的 PNG 逐字节相同
    expect((await fs.readFile(path.join(dir, res.file))).equals(makePngSample())).toBe(true)
  })

  it('封面优先 EPUB3 的 cover-image：封面资源与正文插图是同一份（按书内路径去重）', async () => {
    const { book } = await importOf('epub3-rich')
    const cover = must(book.coverResourceId, 'book.coverResourceId')
    // 正文里也引了同一张图：资源表里只有一份，封面指向它
    expect(Object.keys(book.resources)).toEqual([cover])
    expect(must(book.resources[cover], `资源索引 ${cover}`).mediaType).toBe('image/png')
  })

  it('好书上没有告警（告警不许在好书上刷存在感）', async () => {
    const { book } = await importOf('epub3-rich')
    expect(warningsOf(book)).toEqual([])
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
    const b = must(Object.values(book.documents).find((d) => d.path === 'OEBPS/text/b.xhtml'), 'find 命中的那一项')
    const nodes = nodesOf(await readDocument(dir, book, b.id))
    const links = nodes.flatMap(function collect(n: ContentNode): ContentNode[] {
      if (n.kind === 'element') return n.children.flatMap(collect)
      if (n.kind === 'link') return [n, ...n.children.flatMap(collect)]
      return []
    }).filter((n): n is Extract<ContentNode, { kind: 'link' }> => n.kind === 'link')
    expect(links.map((l) => l.target)).toEqual([
      { kind: 'supplement', documentId: must(Object.values(book.documents).find((d) => d.path === 'OEBPS/text/a.xhtml'), 'find 命中的那一项').id, anchorId: anchorMatching() },
      { kind: 'supplement', documentId: must(c, 'c.xhtml 文档').id, anchorId: anchorMatching() },
    ])
  })

  it('导航指到的补充文档：可达性也可以只由目录建立，且不计章', async () => {
    const { book } = await importOf('epub3-nav-to-supplement')
    expect(book.chapters).toHaveLength(1)
    expect(Object.values(book.documents).map((d) => d.path).sort()).toEqual(['OEBPS/ch1.xhtml', 'OEBPS/sup.xhtml'])
    const leaf = pick(book.items, 1)
    expect(leaf.label).toBe('附录')
    const target = leaf.target as Extract<ReadingTarget, { kind: 'supplement' }>
    expect(target.kind).toBe('supplement')
    expect(target.documentId).toBe(must(Object.values(book.documents).find((d) => d.path === 'OEBPS/sup.xhtml'), 'find 命中的那一项').id)
  })

  it('spine 里声明了补充文档但没有任何链接/导航指向它：不解析（未使用条目不受支持要求）', async () => {
    const { book } = await importOf('epub3-supplement-unreachable')
    expect(book.chapters).toHaveLength(1)
    expect(Object.values(book.documents).map((d) => d.path)).toEqual(['OEBPS/ch1.xhtml'])
    // 没有目录 → 包层已记合成导航的告警（与「不解析孤立补充文档」无关）
    expect(warningsOf(book).map((w) => w.code)).toEqual(['epub-navigation-synthesized'])
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
    const first = nodesOf(await readDocument(dir, book, pick(book.chapters, 0).documentId))
    expect(shape(first)).toEqual(['img:整页插图:2x3'])
    // 第二章用 `../OEBPS/...` 那套相对路径引用同一张图：归一到同一份资源
    const second = nodesOf(await readDocument(dir, book, pick(book.chapters, 1).documentId))
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
      { label: '上卷', target: { kind: 'chapter', index: 0, anchorId: anchorMatching() }, children: [
        { label: '第一章', target: { kind: 'chapter', index: 0, anchorId: anchorMatching() }, children: [] },
      ] },
      { label: '第二章', target: { kind: 'chapter', index: 1, anchorId: null }, children: [] },
    ])
    const cover = must(book.coverResourceId, 'book.coverResourceId')
    expect(must(book.resources[cover], `资源索引 ${cover}`)).toMatchObject({ mediaType: 'image/png', width: 2, height: 3 })
  })

  it('两种封面声明同时在：取 EPUB3 的 cover-image（EPUB2 的 meta 只是其次）', async () => {
    const { book, dir } = await importOf('epub3-cover-priority')
    const cover = must(book.coverResourceId, 'book.coverResourceId')
    const coverRes = must(book.resources[cover], `资源索引 ${cover}`)
    expect(coverRes).toMatchObject({ mediaType: 'image/png', width: 2, height: 3 })
    expect((await fs.readFile(path.join(dir, coverRes.file))).equals(makePngSample())).toBe(true)
    // 没被采纳的那条不登记（也未使用）：EPUB2 那份声明的字节是垃圾，取错就会当场报错而不是悄悄换一张
    expect(Object.keys(book.resources)).toEqual([cover])
  })

  it('路径形态样本（中文/空格/百分号 + 同文档锚点）：正文与导航目标都落对', async () => {
    const { book } = await importOf('epub3-paths')
    expect(book.chapters.map((c) => c.label)).toEqual(['中文'])
    // 第二个导航叶指向导航文档自己的锚点：那份文档按「导航可达」转成补充文档
    const leaf = pick(book.items, 1)
    expect(leaf.label).toBe('本页顶')
    expect(leaf.target).toMatchObject({ kind: 'supplement', anchorId: anchorMatching() })
  })
})

describe('EPUB3 导航列表形态', () => {
  it('toc 导航把 ol 写成 ul：整本照读，目录标签与锚点都绑定', async () => {
    const { book } = await importOf('epub3-nav-ul')
    expect(book.chapters).toHaveLength(1)
    expect(navShape(book.items)).toEqual([
      { label: '第一章', target: { kind: 'chapter', index: 0, anchorId: anchorMatching() }, children: [] },
      { label: '第二卷', target: null, children: [
        { label: '第二章', target: { kind: 'chapter', index: 0, anchorId: anchorMatching() }, children: [] },
      ] },
    ])
  })
})

describe('EPUB2 命名锚点与声明形态', () => {
  it('目录目标指向 <a name="x">：整本可导入，目标绑到那个锚点（且锚点真的落在生成物里）', async () => {
    const { book, dir } = await importOf('epub2-named-anchor')
    expect(book.chapters).toHaveLength(1)
    const documentId = pick(book.chapters, 0).documentId
    const nodes = nodesOf(await readDocument(dir, book, documentId))
    const ids = collectIds(nodes)
    const targets = book.items.map((i) => i.target as Extract<ReadingTarget, { kind: 'chapter' }>)
    expect(targets.map((t) => t.kind)).toEqual(['chapter', 'chapter', 'chapter', 'chapter'])
    for (const t of targets) {
      expect(t.anchorId).toMatch(/^a\d+$/)
      expect(ids.has(must(t.anchorId, '锚点号')), `锚点 ${t.anchorId} 不在文档树里`).toBe(true)
    }
    // 只有 name / name 与 id 双写 / 一个元素上两个不同的名字：都指向各自那个元素的落点
    expect(pick(targets, 0).anchorId).not.toBe(pick(targets, 1).anchorId)
    expect(pick(targets, 2).anchorId).toBe(pick(targets, 3).anchorId)
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
    expect(pick(book.items, 1).target).toMatchObject({ kind: 'supplement', anchorId: anchorMatching() })
  })
})

describe('SVG：独立插图重建、包装封面解析成栅格', () => {
  it('插图为重建后的 SVG 资源（落盘内容与返回的 content 一致）', async () => {
    const { book, dir } = await importOf('epub3-svg-figure')
    expect(Object.keys(book.resources)).toHaveLength(2)
    const fig = must(Object.values(book.resources).find((r) => r.mediaType === 'image/svg+xml'), 'find 命中的那一项')
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
    const nodes = nodesOf(await readDocument(dir, book, pick(book.chapters, 0).documentId))
    expect(shape(nodes)).toEqual([
      { tag: 'p', start: null, value: null, rowSpan: null, colSpan: null, children: ['插图', 'img:矢量插图:10x20'] },
    ])
  })

  it('SVG 单图包装封面：封面资源是它包的那张 PNG，不是那份 SVG', async () => {
    const { book, dir } = await importOf('epub3-svg-figure')
    const cover = must(book.coverResourceId, 'book.coverResourceId')
    const coverRes = must(book.resources[cover], `资源索引 ${cover}`)
    expect(coverRes).toMatchObject({ mediaType: 'image/png', width: 2, height: 3 })
    expect(coverRes.file).toMatch(/\.png$/)
    expect((await fs.readFile(path.join(dir, coverRes.file))).equals(makePngSample())).toBe(true)
    // 包装用的 SVG 本身没有落盘（它不是内容，只是一层包装）
    expect(Object.values(book.resources).some((r) => r.file.includes('cover'))).toBe(false)
    expect(await fs.readdir(path.join(dir, 'resources'))).toHaveLength(2)
  })
})

describe('安全面：拒绝要有精确错误', () => {
  it('声明的封面损坏：失败、点名封面资源，并把损坏原因写进这句报错（导入失败时用户看不到告警面）', async () => {
    const e = await importRejection('epub3-broken-cover')
    expectEpubError(e, /OEBPS\/images\/cover\.png/)
    expectEpubError(e, /损坏|截断/)
    expect(must(e, '封面失败的错误').message).not.toMatch(/导入告警/)
  })

  it('正文内联 SVG 是文档唯一内容：先按文档级留痕，整本只剩这一页时才轮到整本判据', async () => {
    const e = await importRejection('epub3-inline-svg-only')
    expectEpubError(e, /没有任何可读的一页/)
    expectEpubError(e, /1 份/)
  })

  it('被引用的图片像素超预算：读不出这张图属资源级，见「资源读不出：该处不留并点名」', async () => {
    const { book } = await importOf('epub3-broken-image', { imagePixels: 5 })
    expect(droppedOf(book).join('\n')).toMatch(/OEBPS\/images\/fig\.png/)
  })

  it('归档层读不出条目：仍按整本失败（半径不降到一份资源——条目连读都读不出是容器级事实）', async () => {
    const e = await importRejection('epub3-rich', { entryBytes: 1 })
    expectEpubError(e, /实际解压超过上限/)
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
    expect(must(caught, '捕获到的错误').message).toMatch(/documents\/d\d+\.json/)
    expect(must(caught, '捕获到的错误').message).not.toContain(dir)   // 主机布局不进用户可见文案
  })

  it('超深正文：主语是这一页——留空页、章号不动、痕点名深度预算（不是整本拒，也不是爆栈）', async () => {
    const { book, dir } = await importOf('epub3-doc-too-deep')
    const doc = must(Object.values(book.documents).find((d) => d.path === 'OEBPS/ch1.xhtml'), '超深的那一份文档')
    expect(book.chapters).toHaveLength(2)
    expect(doc.index).toBe(1)                                     // 章号照占，不往前挪
    expect(nodesOf(await readDocument(dir, book, doc.id))).toEqual([])
    const blank = warningsOf(book).filter((w) => w.code === 'epub-empty-document')
    expect(blank).toHaveLength(1)
    expect(pick(blank, 0).resource).toBe('OEBPS/ch1.xhtml')
    expect(pick(blank, 0).message).toMatch(/深度/)
  })

  it('超宽正文：默认预算读得出；节点预算缩到 200 后同样只落空页并点名这份文档', async () => {
    const ok = await importOf('epub3-doc-too-wide')
    expect(ok.book.chapters).toHaveLength(2)
    expect(warningsOf(ok.book).filter((w) => w.code === 'epub-empty-document')).toEqual([])
    const { book } = await importOf('epub3-doc-too-wide', { xmlNodes: 200 })
    expect(book.chapters).toHaveLength(2)                         // 半径降到主语：这一章还在序列里
    const blank = warningsOf(book).filter((w) => w.code === 'epub-empty-document')
    expect(blank).toHaveLength(1)
    expect(pick(blank, 0).resource).toBe('OEBPS/ch1.xhtml')
    expect(pick(blank, 0).message).toMatch(/节点/)
  })

})

describe('安全面：安全去除项要有告警，不默默失去内容', () => {
  it('脚本/内嵌框/对象/表单/样式/事件属性一律剥除，正文文字保留', async () => {
    const { book, dir } = await importOf('epub3-active-content')
    expect(book.chapters).toHaveLength(1)
    expect(warningsOf(book).map((w) => w.code).sort())
      .toEqual(['epub-active-attribute', 'epub-css-attribute', 'epub-external-link', 'epub-link-not-followable', 'epub-removed-active-content'])
    for (const w of warningsOf(book)) expect(w.resource).toBe('OEBPS/ch1.xhtml')
    const nodes = nodesOf(await readDocument(dir, book, pick(book.chapters, 0).documentId))
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
    const removed = warningsOf(book).find((w) => w.code === 'epub-removed-active-content')
    expect(removed?.message).toMatch(/处/)
    expect(removed?.message).toMatch(/script/)
  })

  it('正文内联 SVG：整本照读，装饰图形剥离并留告警（点名文档与处数）', async () => {
    const { book, dir } = await importOf('epub3-inline-svg')
    expect(book.chapters).toHaveLength(1)
    const svgWarn = warningsOf(book).filter((w) => w.code === 'epub-removed-inline-svg')
    expect(svgWarn).toHaveLength(1)
    expect(pick(svgWarn, 0).resource).toBe('OEBPS/ch1.xhtml')
    expect(pick(svgWarn, 0).message).toMatch(/svg/)
    // 被剥离的是内联 SVG 那一块，正文文字照旧（不静默丢内容：丢了什么看得见）
    const nodes = nodesOf(await readDocument(dir, book, pick(book.chapters, 0).documentId))
    expect(shape(nodes)).toEqual([
      { tag: 'p', start: null, value: null, rowSpan: null, colSpan: null, children: ['图：'] },
    ])
  })
})

/**
 * 真书反例（Gutenberg #7337 图像版）：spine 第一项是「整页只有一棵内联 SVG、
 * 里面只有一张 `<image>` 指向书内封面图」的封面页——EPUB3 推荐的封面写法。
 * 口径：**只在整页别无可读内容时**按那张图导成单图章节，
 * 其余形状（书外图、图外加矢量、页里有正文）一概维持原判定。
 */
describe('整页 SVG 图形页：按其内唯一一张书内图降级成单图章节', () => {
  it('封面页导入成功：章按 spine 计、图与声明的封面共用一份资源、降级看得见', async () => {
    const { book, dir } = await importOf('epub3-svg-cover-page')
    expect(book.chapters.map((c) => c.label)).toEqual(['封面', '第一章'])
    const nodes = nodesOf(await readDocument(dir, book, pick(book.chapters, 0).documentId))
    expect(nodes).toHaveLength(1)
    const img = pick(nodes, 0)
    expect(img.kind).toBe('image')
    if (img.kind !== 'image') throw new Error(`封面页应当是一张图，实际 ${img.kind}`)
    // 宽高取自**图片本身**的事实（2×3 的 PNG），不是 SVG 上那套 width="100%" 的百分比
    expect([img.width, img.height, img.alt]).toEqual([2, 3, ''])
    // 同一张 PNG 同时是声明的封面：资源只落一份，两处引用同一个不透明 ID
    expect(img.resourceId).toBe(book.coverResourceId)
    expect(Object.keys(book.resources)).toHaveLength(1)
    // 降级要看得见；而「移除了内联 SVG」那条不再成立——图形没被丢掉，是按图读进来了
    const codes = warningsOf(book).map((w) => w.code)
    expect(codes).toContain('epub-svg-image-page')
    expect(codes).not.toContain('epub-removed-inline-svg')
    const warn = must(warningsOf(book).find((w) => w.code === 'epub-svg-image-page'), 'warningsOf(book) 里 find 命中的那一项')
    expect(warn.resource).toBe('OEBPS/wrap0000.xhtml')
    expect(warn.message).toMatch(/图/)
  })

  it('那张图指向书外：这一页按空页留、点名原因，别的章节照读（不整本拒）', async () => {
    const { book, dir } = await importOf('epub3-svg-cover-page-remote')
    const cover = must(Object.values(book.documents).find((d) => d.path === 'OEBPS/wrap0000.xhtml'), '封面页文档')
    expect(nodesOf(await readDocument(dir, book, cover.id))).toEqual([])
    expect(book.chapters).toHaveLength(2)
    const blank = warningsOf(book).filter((w) => w.code === 'epub-empty-document')
    expect(pick(blank, 0).resource).toBe('OEBPS/wrap0000.xhtml')
    expect(pick(blank, 0).message).toMatch(/书外/)
  })

  it('那张图的引用解不开：说「解不开」而不是「指向书外」，这一页同样按空页留', async () => {
    const { book } = await importOf('epub3-svg-cover-page-escaping')
    const blank = warningsOf(book).filter((w) => w.code === 'epub-empty-document')
    expect(pick(blank, 0).message).toMatch(/解不开/)
    expect(pick(blank, 0).message).not.toMatch(/书外/)
  })

  it('SVG 里除那张图还有矢量形状：不是「只包一张图」，这一页按空页留并说清原因', async () => {
    const { book } = await importOf('epub3-svg-cover-page-not-sole')
    const blank = warningsOf(book).filter((w) => w.code === 'epub-empty-document')
    expect(pick(blank, 0).resource).toBe('OEBPS/wrap0000.xhtml')
    expect(pick(blank, 0).message).toMatch(/唯一/)
    expect(book.chapters).toHaveLength(2)
  })

  it('封面页容器带的锚点随图落到树上：目录指向它不是悬空锚点', async () => {
    // 容器（`div#cover`）被那张图顶替，它承载的锚点在扫描期已铸成 ID。替代出来的树上必须有这个
    // ID 的落点，否则目录那条目标指向一个不存在的节点（阅读会话退回章首、目录当前项量不到）。
    const { book, dir } = await importOf('epub3-svg-cover-anchor')
    const leaf = must(book.items.flatMap(function flat(i: NavigationItem): NavigationItem[] {
      return [i, ...i.children.flatMap(flat)]
    }).find((i) => i.label === '封面'), 'find 命中的那一项')
    expect(leaf.target).toMatchObject({ kind: 'chapter', index: 0 })
    const anchorId = (leaf.target as { anchorId: string | null }).anchorId
    expect(anchorId).toMatch(/^a\d+$/)
    const nodes = nodesOf(await readDocument(dir, book, pick(book.chapters, 0).documentId))
    expect(collectIds(nodes).has(must(anchorId, '锚点号')), `锚点 ${anchorId} 不在文档树里`).toBe(true)
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
    const nodes = nodesOf(await readDocument(dir, book, pick(book.chapters, 0).documentId))
    expect(shape(nodes)).toEqual([
      { tag: 'p', start: null, value: null, rowSpan: null, colSpan: null, children: ['正文与花饰'] },
    ])
    const codes = warningsOf(book).map((w) => w.code)
    expect(codes).toContain('epub-removed-inline-svg')
    expect(codes).not.toContain('epub-svg-image-page')
  })
})

describe('目标锚点从未存在：按该条降级，整本照读', () => {
  it('失效锚点（导航指向不存在的锚点）：整本照读，条目落该页开头并留痕', async () => {
    const { book } = await importOf('epub3-missing-anchor')
    expect(book.chapters.length).toBe(1)
    expect(book.items[0]?.target).toMatchObject({ kind: 'chapter', index: 0, anchorId: null })
    const hit = book.findings.find((f) => f.code === 'epub-degraded-anchor')
    expect(hit, '失效锚点必须留下一条痕').toBeDefined()
    expect(hit?.scope).toBe('item')
    expect(hit?.resource).toBe('OEBPS/ch1.xhtml')
    expect(hit?.action).toMatch(/不存在/)
    expect(hit?.details.join('')).toMatch(/#gone/)
  })

  it('失效锚点（正文链接指向不存在的锚点）：整本照读，该处取消可点击性且文字不丢', async () => {
    const { book, dir } = await importOf('epub3-link-missing-anchor')
    const ch1 = await readDocument(dir, book, pick(book.chapters, 0).documentId)
    const text = JSON.stringify(nodesOf(ch1))
    expect(text).toContain('去哪儿')          // 文字照留
    expect(text).not.toContain('"link"')      // 可点击性取消
    const hit = book.findings.find((f) => f.code === 'epub-degraded-anchor')
    expect(hit?.scope).toBe('element')
    expect(hit?.resource).toBe('OEBPS/ch1.xhtml')
    expect(hit?.details.join('')).toMatch(/#gone/)
  })

  it('拼错的名字与被剥掉的锚点分开记：同一痕码，动作句说「不存在」而不是「随剥离消失」', async () => {
    // 这份文档里同样有被剥离的内联 SVG（其中确实有个 id="ornament"），但链接指的是拼错的名字：
    // 「从未存在」与「被我们剥掉」是两件事——码相同（程序分流不变），动作句必须分得清是哪一种
    const { book, dir } = await importOf('epub3-inline-svg-bad-anchor')
    expect(book.chapters).toHaveLength(1)
    const nodes = nodesOf(await readDocument(dir, book, pick(book.chapters, 0).documentId))
    expect(JSON.stringify(nodes)).toContain('这张图')       // 文字照留
    expect(JSON.stringify(nodes)).not.toContain('"link"')   // 可点击性取消
    const hit = book.findings.filter((f) => f.code === 'epub-degraded-anchor')
    expect(hit).toHaveLength(1)
    expect(pick(hit, 0).action).toMatch(/不存在/)
    expect(pick(hit, 0).action).not.toMatch(/剥离/)
    expect(pick(hit, 0).details.join('')).toMatch(/#ornamnet/)
  })
})

describe('目标锚点随被剥离内容消失：降级 + 告警，不拒整本', () => {
  /** 降级告警按动作分两条（导航降级 / 内链降级），同码但动作不同——同码同资源同动作才合并 */
  async function degradedWarnings(name: string): Promise<{ nav: string[]; link: string[] }> {
    const { book } = await importOf(name)
    const hit = warningsOf(book).filter((w) => w.code === 'epub-degraded-anchor')
    return {
      nav: hit.filter((w) => /降级到该文档开头/.test(w.message)).map((w) => `${w.resource}\u0000${w.message}`),
      link: hit.filter((w) => /降级成纯文本/.test(w.message)).map((w) => `${w.resource}\u0000${w.message}`),
    }
  }

  it('导航目标指向内联 SVG 内的锚点：整本照读，该叶降级到文档开头并点名文档与锚点', async () => {
    const { book } = await importOf('epub3-inline-svg-anchor')
    expect(book.chapters).toHaveLength(1)
    // 目标降级成「该文档 + 无片段」：文档还在、位置退到开头，导航仍然可用
    expect(pick(book.items, 0).target).toEqual({ kind: 'chapter', index: 0, anchorId: null })
    // 对照组：真锚点照旧绑到落点——降级不是「这份文档的锚点全都不绑了」
    expect(pick(book.items, 1).target).toMatchObject({ anchorId: anchorMatching() })
    const { nav } = await degradedWarnings('epub3-inline-svg-anchor')
    expect(nav).toHaveLength(1)
    expect(nav[0]).toContain('OEBPS/ch1.xhtml')   // 告警点名文档
    expect(nav[0]).toContain('#ornament')         // 与锚点（导航仍然点了名，用户看得见降级事实）
  })

  it('正文内链指向同一处：该链接降级成纯文本（只留子内容），并留同风格告警', async () => {
    const { book, dir } = await importOf('epub3-inline-svg-anchor')
    const nodes = nodesOf(await readDocument(dir, book, pick(book.chapters, 0).documentId))
    // 降级的那条只剩文字（不再有 link 节点），同一段里指向真锚点的另一条照旧是链接
    // 期望里那一格声明成 unknown：兄弟项是字符串，直接写成对象字面量会被按 `string` 上下文查键
    const expectedLink: unknown = { link: 'normal', target: { kind: 'chapter', index: 0, anchorId: anchorMatching() }, children: ['开头'] }
    expect(shape(nodes)).toEqual([
      { tag: 'h1', start: null, value: null, rowSpan: null, colSpan: null, children: ['第一章'] },
      { tag: 'p', start: null, value: null, rowSpan: null, colSpan: null, children: ['图：'] },
      { tag: 'p', start: null, value: null, rowSpan: null, colSpan: null, children: [
        '看', '这张图', '与', expectedLink,
      ] },
    ])
    expect(JSON.stringify(nodes)).not.toMatch(/ornament/)
    const { link } = await degradedWarnings('epub3-inline-svg-anchor')
    expect(link).toHaveLength(1)
    expect(link[0]).toContain('OEBPS/ch1.xhtml')
    expect(link[0]).toContain('#ornament')
  })
})

describe('文档级锚点（真书封面页把 id 挂在 body 上）：等价于文档开头，既不降级也不拒整本', () => {
  it('目录叶与正文内链都指 body 上的 id：目标文档在、anchorId 为 null、链接仍可点', async () => {
    const { book, dir } = await importOf('epub3-body-anchor')
    const inner = must(Object.values(book.documents).find((d) => d.path === 'OEBPS/text/part0009.xhtml'), '内页文档')
    const cover = must(Object.values(book.documents).find((d) => d.path === 'OEBPS/ch1.xhtml'), '封面文档')
    expect(inner.index).toBe(1)
    // 目录叶：锚点语义就是「这一页的开头」，wire 里已经是 anchorId = null 的一等表达
    expect(pick(book.items, 0).target).toEqual({ kind: 'chapter', index: inner.index, anchorId: null })
    // 正文内链：链接**还在**（不是降级成纯文本），落点同样是文档开头
    const links = nodesOf(await readDocument(dir, book, cover.id)).flatMap(function collect(n: ContentNode): ContentNode[] {
      if (n.kind === 'element') return n.children.flatMap(collect)
      if (n.kind === 'link') return [n, ...n.children.flatMap(collect)]
      return []
    }).filter((n): n is Extract<ContentNode, { kind: 'link' }> => n.kind === 'link')
    expect(links.map((l) => l.target)).toEqual([{ kind: 'chapter', index: inner.index, anchorId: null }])
    // 语义等价，不是降级：不该产生一条降级告警
    expect(warningsOf(book).filter((w) => w.code === 'epub-degraded-anchor')).toEqual([])
  })
})

describe('同一份文档里撞名的锚点：文档序第一个赢并留痕，不整本拒', () => {
  it('目录指到撞名的 id：落在第一个承载它的节点，另一处照读，另有一条 trace', async () => {
    const { book, dir } = await importOf('epub3-dup-anchor')
    const ch1 = must(Object.values(book.documents).find((d) => d.path === 'OEBPS/ch1.xhtml'), 'ch1 文档')
    const nodes = nodesOf(await readDocument(dir, book, ch1.id))
    const first = pick(nodes, 0)
    expect(first.kind).toBe('element')
    const firstId = (first as Extract<ContentNode, { kind: 'element' }>).id
    // 两份同名段落里绑定期认文档序第一个（树上承载它的是哪一个，是有确定答案的事实）
    expect(pick(book.items, 0).target).toEqual({ kind: 'chapter', index: ch1.index, anchorId: firstId })
    // 另一处不是被丢掉的：它照样作为正文读出来
    expect(nodes).toHaveLength(2)
    const dup = warningsOf(book).filter((w) => w.code === 'epub-duplicate-anchor')
    expect(dup).toHaveLength(1)
    expect(pick(dup, 0).resource).toBe('OEBPS/ch1.xhtml')
    expect(pick(dup, 0).message).toMatch(/a/)
  })
})

/** 资源级失败的后果：整本照读、该处不留、告警点名这张资源与精确原因（码给程序分流，message 给人看） */
function droppedOf(book: EpubImportData): string[] {
  return warningsOf(book).filter((w) => w.code === 'epub-image-dropped').map((w) => w.message)
}

describe('资源读不出：该处不留并点名，不再整本拒收', () => {
  it('正文引用书外图片：这张图不留、告警点名它与出处，整本照读', async () => {
    const { book } = await importOf('epub3-remote-image')
    expect(book.chapters.length).toBeGreaterThan(0)
    const dropped = warningsOf(book).filter((w) => w.code === 'epub-image-dropped')
    expect(dropped).toHaveLength(1)
    expect(pick(dropped, 0).resource).toMatch(/example\.invalid/)
    expect(pick(dropped, 0).message).toMatch(/OEBPS\/ch1\.xhtml/)
  })

  it('损坏图片：不留 + 点名资源与「截断/损坏」这个原因', async () => {
    const { book } = await importOf('epub3-broken-image')
    const dropped = droppedOf(book).join('\n')
    expect(dropped).toMatch(/OEBPS\/images\/fig\.png/)
    expect(dropped).toMatch(/损坏|IEND/)
  })

  it('SVG 里的 foreignObject：不留 + 点名资源与元素', async () => {
    const { book } = await importOf('epub3-svg-foreign-object')
    const dropped = droppedOf(book).join('\n')
    expect(dropped).toMatch(/foreignObject/)
    expect(dropped).toMatch(/OEBPS\/images\/fig\.svg/)
  })

  it('SVG 里的 use 外链：不留 + 点名资源（绝不发请求）', async () => {
    const { book } = await importOf('epub3-svg-external-use')
    const dropped = droppedOf(book).join('\n')
    expect(dropped).toMatch(/use/)
    expect(dropped).toMatch(/OEBPS\/images\/fig\.svg/)
  })

  it('SVG 引用未登记的渐变：不留 + 点名资源（不改写冒充成功）', async () => {
    const { book } = await importOf('epub3-svg-missing-gradient')
    const dropped = droppedOf(book).join('\n')
    expect(dropped).toMatch(/missing/)
    expect(dropped).toMatch(/OEBPS\/images\/fig\.svg/)
  })

  it('被加密的图片：不留，原因点名「被加密」而不是「损坏」', async () => {
    const { book } = await importOf('epub3-encrypted-image')
    const dropped = droppedOf(book).join('\n')
    expect(dropped).toMatch(/OEBPS\/images\/fig\.png/)
    expect(dropped).toMatch(/加密/)
    // 字节是被混淆的，按字节报错会把读者引去换图（那是白费力气）
    expect(dropped).not.toMatch(/损坏/)
  })

  it('坏图带着目录引用的锚点：锚点照旧落在树上真实存在的节点，alt 文字读得出', async () => {
    const { book, dir } = await importOf('epub3-broken-inline-image')
    const ch1 = must(Object.values(book.documents).find((d) => d.path === 'OEBPS/ch1.xhtml'), 'ch1 文档')
    const nodes = nodesOf(await readDocument(dir, book, ch1.id))
    const leaf = pick(book.items, 0)
    const anchorId = (must(leaf.target, '目录叶的目标') as Extract<ReadingTarget, { kind: 'chapter' }>).anchorId
    // 图没了，但位置还在：绑定期不许指向树上不存在的 ID
    expect(anchorId).not.toBeNull()
    expect(collectIds(nodes)).toContain(anchorId as string)
    // 这张图的说明文字照读（内容不静默消失）
    expect(JSON.stringify(nodes)).toContain('插图说明')
    expect(droppedOf(book).join('\n')).toMatch(/OEBPS\/images\/fig\.png/)
  })
})

describe('文档级半径：一份文档读不出正文，不牵动整本书', () => {
  it('只有全角空格的版权页：照样进阅读序列、章号不动、读出来是空白页、告警点名它', async () => {
    const { book, dir } = await importOf('epub3-blank-copyright-page')
    const cr = must(Object.values(book.documents).find((d) => d.path === 'OEBPS/copyright.xhtml'), '版权页文档')
    expect(book.chapters).toHaveLength(2)
    expect(cr.index).toBe(1)                       // 章号没有被「跳过」动过
    expect(pick(book.chapters, 1).documentId).toBe(cr.id)
    const nodes = nodesOf(await readDocument(dir, book, cr.id))
    // 空白是可见性判据，不是空树：结构照留（锚点才有落点），文字面仍为空
    expect(chapterContentToText({ kind: 'rich', documentId: cr.id, nodes })).toBe('')
    const blank = warningsOf(book).filter((w) => w.code === 'epub-empty-document')
    expect(blank).toHaveLength(1)
    expect(pick(blank, 0).resource).toBe('OEBPS/copyright.xhtml')
  })

  it('空页保留结构树：扫描期铸出的锚点仍有落点，目录指过去不会绑到不存在的节点', async () => {
    const { book, dir } = await importOf('epub3-blank-with-anchor')
    const blank = must(Object.values(book.documents).find((d) => d.path === 'OEBPS/blank.xhtml'), '空页文档')
    expect(book.chapters).toHaveLength(2)
    const target = must(pick(book.items, 0).target, '目录叶目标') as Extract<ReadingTarget, { kind: 'chapter' }>
    expect(target.index).toBe(1)
    const anchorId = must(target.anchorId, '空页锚点 ID')
    const nodes = nodesOf(await readDocument(dir, book, blank.id))
    // 目录绑的那个锚点 ID 必须在树上真的存在——空页丢树等于把目标绑到不存在的节点
    expect(collectIds(nodes).has(anchorId)).toBe(true)
    expect(chapterContentToText({ kind: 'rich', documentId: blank.id, nodes })).toBe('')   // 仍是空白页
    expect(warningsOf(book).filter((w) => w.code === 'epub-empty-document').map((w) => w.resource))
      .toEqual(['OEBPS/blank.xhtml'])
  })

  it('整本每一份都读不出字：这时才轮到整本失败，读数说「没有任何可读的一页」', async () => {
    const e = await importRejection('epub3-all-blank')
    expectEpubError(e, /没有任何可读的一页/)
    expectEpubError(e, /2 份/)
  })

  it('整本判据的原因只从主序列里取：导航可达的坏附录不替空白正文背锅', async () => {
    const e = await importRejection('epub3-all-blank-with-bad-supplement')
    expectEpubError(e, /没有任何可读的一页/)
    expect(e.message).toContain('OEBPS/ch1.xhtml')
    expect(e.message).not.toContain('OEBPS/appendix.xhtml')
  })

  it('整本每一份都解不开：原因带得出第一份与具体原因，书内位置只说一遍', async () => {
    const e = await importRejection('epub3-all-bad')
    expectEpubError(e, /没有任何可读的一页/)
    expect(e.message).toMatch(/实体/)
    // 扫描期那条动作句本身已带位置：判据再前缀一次资源名就会把同一份文档说两遍
    expect(e.message.match(/OEBPS\/bad1\.xhtml/g)).toHaveLength(1)
  })

  it('纯插图文档读得出（图算内容）：不被空页判据误伤', async () => {
    const { book } = await importOf('epub3-image-only')
    expect(warningsOf(book).filter((w) => w.code === 'epub-empty-document')).toEqual([])
  })

  it('目录与正文内链指进一份读不出的文档的锚点：落该页开头，不把「没读出来」说成「锚点不存在」', async () => {
    const { book, dir } = await importOf('epub3-nav-into-unreadable')
    expect(book.chapters).toHaveLength(2)
    expect(pick(book.items, 1).target).toEqual({ kind: 'chapter', index: 1, anchorId: null })
    // 正文内链同理：目标文档在，链接仍可点，只是落点退到页首（那一页本来就是空白）
    const ch1 = must(Object.values(book.documents).find((d) => d.path === 'OEBPS/ch1.xhtml'), 'ch1 文档')
    const links = nodesOf(await readDocument(dir, book, ch1.id)).flatMap(function collect(n: ContentNode): ContentNode[] {
      if (n.kind === 'element') return n.children.flatMap(collect)
      if (n.kind === 'link') return [n, ...n.children.flatMap(collect)]
      return []
    }).filter((n): n is Extract<ContentNode, { kind: 'link' }> => n.kind === 'link')
    expect(links.map((l) => l.target)).toEqual([{ kind: 'chapter', index: 1, anchorId: null }])
    // 「这一页为什么读不出」仍然有一条痕，不会因为落点退化就静默
    expect(warningsOf(book).filter((w) => w.code === 'epub-empty-document').map((w) => w.resource))
      .toEqual(['OEBPS/deep.xhtml'])
  })
})

describe('逐文档声明的半径：一份文档排不动 / 要脚本，不牵动整本书', () => {
  it('只有封面声明固定版式：整本照读，封面按流式读并留痕，章号不动', async () => {
    const { book } = await importOf('epub3-itemref-fxl-cover')
    expect(book.chapters).toHaveLength(2)
    const hit = warningsOf(book).filter((w) => w.code === 'epub-fixed-layout-document')
    expect(pick(hit, 0).resource).toBe('OEBPS/coverpage.xhtml')
    // 痕说的是「版式可能失真」，不是「读不出」：这一页照样有正文
    expect(hit[0]?.message).toMatch(/失真/)
    expect(warningsOf(book).filter((w) => w.code === 'epub-empty-document')).toEqual([])
  })

  it('只有一份文档声明 scripted：那一页落空页，同书另一章照读', async () => {
    const { book, dir } = await importOf('epub3-itemref-scripted-cover')
    const fx = must(Object.values(book.documents).find((d) => d.path === 'OEBPS/interact.xhtml'), '脚本页文档')
    expect(book.chapters).toHaveLength(2)
    expect(nodesOf(await readDocument(dir, book, fx.id))).toEqual([])
    expect(warningsOf(book).filter((w) => w.code === 'epub-scripted-document').map((w) => w.resource))
      .toEqual(['OEBPS/interact.xhtml'])
  })

  it('整本书只有一份 scripted 文档：这时才轮到整本判据（没有任何可读的一页）', async () => {
    const e = await importRejection('epub3-scripted')
    expectEpubError(e, /没有任何可读的一页/)
    // 原因不能只剩一句泛话：整本判据按 document/fatal 取第一条，scripted 的事实要带得出来
    expect(e.message).toContain('OEBPS/ch1.xhtml')
    expect(e.message).toMatch(/scripted/)
  })
})

describe('条目级半径：一条声明读不出，剪那一条并压缩阅读序列，不牵动整本书', () => {
  it('spine 有一条指向归档里不存在的文档：其余照读、章号连续无洞、被剪的那条点名', async () => {
    const { book, dir } = await importOf('epub3-spine-missing-entry')
    expect(book.chapters.map((c) => c.index)).toEqual([0, 1])           // 没有洞：0 与 1 连着
    expect(pick(book.chapters, 1).label).toBe('第三章')                  // 压缩后第三条就是第 1 章
    const gone = Object.values(book.documents).find((d) => d.path === 'OEBPS/gone.xhtml')
    expect(gone).toBeUndefined()
    const pruned = warningsOf(book).filter((w) => w.code === 'epub-item-pruned')
    expect(pruned.map((w) => w.resource)).toContain('OEBPS/gone.xhtml')
    // 章号即数组下标：读第 1 章拿到的必须是第三章那份文档（防止下标与字段分叉）
    const second = await readDocument(dir, book, pick(book.chapters, 1).documentId)
    expect(shape(nodesOf(second))[0]).toEqual({ tag: 'h1', start: null, value: null, rowSpan: null, colSpan: null, children: ['第三章'] })
  })

  it('目录里有一条指向读不出的文档：只剪那一条，它的兄弟与父级照留', async () => {
    const { book } = await importOf('epub3-nav-dead-item')
    const group = pick(book.items, 0)
    expect(group.label).toBe('第一卷')
    expect(group.children.map((c) => c.label)).toEqual(['第一章'])
  })

  it('正文链接指向归档里没有的文档：那条链接降级成文字并留痕，整本照读', async () => {
    const { book, dir } = await importOf('epub3-missing-target')
    const ch1 = must(Object.values(book.documents).find((d) => d.path === 'OEBPS/ch1.xhtml'), 'ch1 文档')
    const nodes = nodesOf(await readDocument(dir, book, ch1.id))
    expect(JSON.stringify(nodes)).toContain('去哪儿')            // 文字一个字不丢
    expect(JSON.stringify(nodes)).not.toContain('"link"')        // 只是不再可点
    expect(warningsOf(book).map((w) => w.code)).toContain('epub-item-pruned')
  })

  it('正文链接指向 manifest 有、归档没有的文档：同一条引用级半径，整本照读', async () => {
    const { book, dir } = await importOf('epub3-link-missing-entry')
    const ch1 = must(Object.values(book.documents).find((d) => d.path === 'OEBPS/ch1.xhtml'), 'ch1 文档')
    const nodes = nodesOf(await readDocument(dir, book, ch1.id))
    expect(JSON.stringify(nodes)).toContain('去哪儿')
    expect(JSON.stringify(nodes)).not.toContain('"link"')
    const pruned = warningsOf(book).filter((w) => w.code === 'epub-item-pruned')
    expect(pruned.map((w) => w.resource)).toContain('OEBPS/gone.xhtml')
    expect(pick(pruned, 0).message).toMatch(/归档里没有/)
  })

  it('正文图片指向 manifest 有、归档没有的资源：那一处不留图，整本照读', async () => {
    const { book, dir } = await importOf('epub3-image-missing-entry')
    const ch1 = must(Object.values(book.documents).find((d) => d.path === 'OEBPS/ch1.xhtml'), 'ch1 文档')
    const nodes = nodesOf(await readDocument(dir, book, ch1.id))
    expect(JSON.stringify(nodes)).toContain('甲')
    expect(JSON.stringify(nodes)).not.toContain('"image"')
    expect(warningsOf(book).map((w) => w.code)).toContain('epub-image-dropped')
  })
})

describe('章号不变量：剪掉的那一条不留洞，index 永远等于阅读数组下标', () => {
  for (const name of ['epub3-spine-missing-entry', 'epub3-spine-non-xhtml'] as const) {
    it(`${name}：章号连续，且目录/链接指向的 index 读回来就是那份文档`, async () => {
      const { book, dir } = await importOf(name)
      expect(book.chapters.map((c) => c.index)).toEqual([0, 1])
      expect(book.chapters.every((c, i) => c.index === i)).toBe(true)
      // 被剪的那一条不占号：第三条文档必须坐在 index 1 上
      const third = must(Object.values(book.documents).find((d) => d.path === 'OEBPS/ch3.xhtml'), '第三章文档')
      expect(pick(book.chapters, 1).documentId).toBe(third.id)
      const nodes = nodesOf(await readDocument(dir, book, pick(book.chapters, 1).documentId))
      expect(shape(nodes)[0]).toEqual({ tag: 'h1', start: null, value: null, rowSpan: null, colSpan: null, children: ['第三章'] })
      expect(warningsOf(book).filter((w) => w.code === 'epub-item-pruned')).toHaveLength(1)
    })
  }
})

describe('一条引用/一份文档坏掉，不牵动整本书（安全面不放宽）', () => {
  it('正文链接越出书根：文字照留、这一处不再可点、痕点名出处，整本照读', async () => {
    const { book, dir } = await importOf('epub3-link-escaping')
    const ch1 = must(Object.values(book.documents).find((d) => d.path === 'OEBPS/ch1.xhtml'), 'ch1 文档')
    const nodes = nodesOf(await readDocument(dir, book, ch1.id))
    expect(JSON.stringify(nodes)).toContain('逃出去的字')
    expect(JSON.stringify(nodes)).not.toContain('"link"')
    const pruned = warningsOf(book).filter((w) => w.code === 'epub-item-pruned')
    expect(pruned).toHaveLength(1)
    expect(pick(pruned, 0).resource).toBe('OEBPS/ch1.xhtml')
    expect(pick(pruned, 0).message).toMatch(/越出书根/)
  })

  it('一份内容文档不合法：那一页落空页并带原因，同书其余章节照读（我们仍不解析坏的那份）', async () => {
    const { book, dir } = await importOf('epub3-one-bad-document')
    expect(book.chapters.map((c) => c.index)).toEqual([0, 1, 2])
    const bad = must(Object.values(book.documents).find((d) => d.path === 'OEBPS/bad.xhtml'), '坏页文档')
    expect(nodesOf(await readDocument(dir, book, bad.id))).toEqual([])
    const blank = warningsOf(book).filter((w) => w.code === 'epub-empty-document')
    expect(pick(blank, 0).resource).toBe('OEBPS/bad.xhtml')
    expect(pick(blank, 0).message).toMatch(/实体/)
    // 其余两页一个字不少
    const third = nodesOf(await readDocument(dir, book, pick(book.chapters, 2).documentId))
    expect(JSON.stringify(third)).toContain('第三章')
  })
})

describe('spine 判据只有一处：包层已接纳的声明不被编排层重判', () => {
  it('同一路径被两个 manifest id 声明：按 idref 接纳的章节照读，路径索引的后写覆盖不得再剪一次', async () => {
    const { book, dir } = await importOf('epub3-manifest-dup-path')
    expect(book.chapters.map((c) => c.index)).toEqual([0])
    const nodes = nodesOf(await readDocument(dir, book, pick(book.chapters, 0).documentId))
    expect(JSON.stringify(nodes)).toContain('第一章')
    // 包层没剪这一条，编排层也不许补剪：整本书的剪除痕应为空
    expect(warningsOf(book).filter((w) => w.code === 'epub-item-pruned')).toEqual([])
  })
})

/**
 * 半径表与后果焊在一起：每个半径键都用一份真实样本走一遍导入，断言
 * ① 产物里那条事实的 scope/severity 与表一致；② 表声明的后果真的落在生成物上。
 * 只改表不改执行、或只改执行不改表，都会在这里红——表不再只是注释。
 */
describe('半径表与后果：每个半径键都有可观察的落法', () => {
  interface RadiusCase {
    readonly radius: keyof typeof FINDING_RADII
    readonly fixture: string
    readonly code: string
    readonly check: (book: EpubImportData, dir: string) => void | Promise<void>
  }
  const cases: readonly RadiusCase[] = [
    {
      radius: 'blankDocument', fixture: 'epub3-blank-copyright-page', code: 'epub-empty-document',
      check: async (book, dir) => {
        expect(book.chapters).toHaveLength(2)                         // 留空页：章号不动
        const blank = must(Object.values(book.documents).find((d) => d.path === 'OEBPS/copyright.xhtml'), '空白页文档')
        expect(blank.index).toBe(1)
        const nodes = nodesOf(await readDocument(dir, book, blank.id))
        expect(chapterContentToText({ kind: 'rich', documentId: blank.id, nodes })).toBe('')
      },
    },
    {
      radius: 'documentDegraded', fixture: 'epub3-itemref-fxl-cover', code: 'epub-fixed-layout-document',
      check: async (book, dir) => {
        const page = must(Object.values(book.documents).find((d) => d.path === 'OEBPS/coverpage.xhtml'), '固定版式页')
        expect(nodesOf(await readDocument(dir, book, page.id)).length).toBeGreaterThan(0)   // 照读，只是版式可能失真
      },
    },
    {
      radius: 'itemPruned', fixture: 'epub3-spine-missing-entry', code: 'epub-item-pruned',
      check: (book) => {
        expect(book.chapters.map((c) => c.index)).toEqual([0, 1])     // 剪那一条：序列压缩不留洞
        expect(Object.values(book.documents).some((d) => d.path === 'OEBPS/gone.xhtml')).toBe(false)
      },
    },
    {
      radius: 'itemNoted', fixture: 'epub-spine-linear-variant', code: 'epub-spine-linear-variant',
      check: async (book, dir) => {
        expect(book.chapters).toHaveLength(1)                         // 照读，不剪
        const nodes = nodesOf(await readDocument(dir, book, pick(book.chapters, 0).documentId))
        expect(JSON.stringify(nodes)).toContain('第一章')
      },
    },
    {
      radius: 'itemDegraded', fixture: 'epub3-missing-anchor', code: 'epub-degraded-anchor',
      check: (book) => {
        const leaf = pick(book.items, 0)                              // 导航条目降级到该页开头
        expect((must(leaf.target, '目录叶目标') as Extract<ReadingTarget, { kind: 'chapter' }>).anchorId).toBeNull()
        expect(book.chapters).toHaveLength(1)                         // 整本照读
      },
    },
    {
      radius: 'bookVariant', fixture: 'zip-baseline', code: 'epub-navigation-synthesized',
      check: (book) => {
        expect(book.chapters).toHaveLength(1)                         // 整本照读
        expect(book.items.length).toBeGreaterThan(0)                  // 按 spine 合成平面目录
      },
    },
    {
      radius: 'elementDropped', fixture: 'epub3-broken-image', code: 'epub-image-dropped',
      check: async (book, dir) => {
        const nodes = JSON.stringify(nodesOf(await readDocument(dir, book, pick(book.chapters, 0).documentId)))
        expect(nodes).toContain('坏图')                               // alt 文字照留
        expect(nodes).not.toContain('"image"')                        // 该处不留图
      },
    },
    {
      radius: 'elementRemoved', fixture: 'epub3-inline-svg', code: 'epub-removed-inline-svg',
      check: async (book, dir) => {
        const nodes = JSON.stringify(nodesOf(await readDocument(dir, book, pick(book.chapters, 0).documentId)))
        expect(nodes).toContain('图：')                               // 内容照读
        expect(nodes).not.toContain('svg')                            // 这一处表达不全
      },
    },
    {
      radius: 'elementNoted', fixture: 'epub3-dup-anchor', code: 'epub-duplicate-anchor',
      check: async (book, dir) => {
        const nodes = JSON.stringify(nodesOf(await readDocument(dir, book, pick(book.chapters, 0).documentId)))
        expect(nodes).toContain('甲')                                 // 两处都照读
        expect(nodes).toContain('又一个甲')
        const leaf = pick(book.items, 0)                              // 承载者取文档序第一个
        expect((must(leaf.target, '目录叶目标') as Extract<ReadingTarget, { kind: 'chapter' }>).anchorId).not.toBeNull()
      },
    },
  ]
  for (const c of cases) {
    it(`${c.radius}（${FINDING_RADII[c.radius].scope}/${FINDING_RADII[c.radius].severity}）：表声明的后果落在产物上`, async () => {
      const { book, dir } = await importOf(c.fixture)
      const hit = book.findings.find((f) => f.code === c.code)
      expect(hit, `样本 ${c.fixture} 没有发出 ${c.code}`).toBeDefined()
      expect(hit?.scope).toBe(FINDING_RADII[c.radius].scope)
      expect(hit?.severity).toBe(FINDING_RADII[c.radius].severity)
      await c.check(book, dir)
    })
  }

  it('半径表的每一格都有样本：加一格不补样本即红（「每个半径键都有可观察的落法」不是自称）', () => {
    expect(cases.map((c) => c.radius).sort()).toEqual((Object.keys(FINDING_RADII) as Array<keyof typeof FINDING_RADII>).sort())
  })
})
