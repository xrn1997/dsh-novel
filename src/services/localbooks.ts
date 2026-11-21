import iconv from 'iconv-lite'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Readable } from 'node:stream'
import { LOCAL_SOURCE_ID, planarNavigation, resourceUrl } from '../shared/wire.js'
import type {
  BookNavigation, ChapterContent, ChapterEntry, LocalImportWarning, ShelfBook,
} from '../shared/wire.js'
import { chapterContentToText } from '../shared/chapter-text.js'
import { importEpub } from './epub/import.js'
import type { EpubImportData } from './epub/import.js'
import { warningListOf } from './epub/findings.js'
import { decodeLocalMeta, isEpubMeta, LOCAL_META_SCHEMA_VERSION } from './local-meta.js'
import type { ChapterSpan, LocalEpubMeta, LocalMeta, LocalTextMeta, StoredEpubMetaV2, StoredTextMeta } from './local-meta.js'
import { lruGet, lruSet } from './lru.js'
import { formatByteLimit } from './size.js'
import { readJson, writeJsonAtomic, isAtomicTemp, backupPathOf } from './storage.js'
import { readValue, type ValueSource } from './value-source.js'

/** 本地书的保留源 id：**单主人是 shared/wire.ts**；此处 re-export 保留既有 import 路径。 */
export { LOCAL_SOURCE_ID }

/** 章节偏移表项（形状住在 `local-meta.ts` 的存储/读 codec）：re-export 保留既有 import 路径。 */
export type { ChapterSpan } from './local-meta.js'

/** bookKey 形态 `local:<uuid>`；严格 uuid 校验兼防路径穿越 */
export const BOOK_KEY_RE = /^local:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/
export function isLocalBookKey(bookKey: string): boolean {
  return BOOK_KEY_RE.test(bookKey)
}

/** 本地文件解码链（不复用 fetcher.decodeBody——其兜底是 UTF-8，GBK 会乱码；本地文件也没有 Content-Type）：
 *  BOM 优先 → UTF-8 严格探测 → GBK 回退。 */
export function decodeLocalText(buf: Buffer): { text: string; encoding: string } {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.subarray(3).toString('utf8'), encoding: 'utf-8-bom' }
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: iconv.decode(buf.subarray(2), 'utf16-le'), encoding: 'utf-16le' }
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return { text: iconv.decode(buf.subarray(2), 'utf16-be'), encoding: 'utf-16be' }
  }
  // Buffer.toString('utf8') 会把非法字节静默换成 U+FFFD——必须用 fatal TextDecoder
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), encoding: 'utf-8' }
  } catch {
    return { text: iconv.decode(buf, 'gbk'), encoding: 'gbk' }   // 启发式固有误差（GBK 猜错即乱码）
  }
}

/** 章节标题行（钉死的正则）：第X章/卷/回/节/集/部/篇（中文数字含大写，含「卷二」单位在前形态）+ 序章楔子番外尾声后记 + Chapter N */
const CHAPTER_RE = /^\s*(?:第[0-9零一二三四五六七八九十百千万亿两壹贰叁肆伍陆柒捌玖拾佰仟萬億]+[章卷回节集部篇]|[章卷回节集部篇][0-9零一二三四五六七八九十百千万亿两壹贰叁肆伍陆柒捌玖拾佰仟萬億]+|序章|楔子|番外|尾声|后记|Chapter\s*\d+)\s*[:：.、\s]*(.*)$/

/** 按标题行切章，返回字符偏移表（start=标题行之后，end=下一标题行之前/EOF） */
export function splitChapters(text: string): ChapterSpan[] {
  const spans: ChapterSpan[] = []
  let segStart = 0
  let name: string | null = null
  let offset = 0
  for (const rawLine of text.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (CHAPTER_RE.test(line)) {
      if (name !== null) spans.push({ name, start: segStart, end: offset - 1 })   // 上一段：结束于本行行首前
      else if (offset > 0 && text.slice(0, offset).trim() !== '') {
        spans.push({ name: '正文', start: 0, end: offset - 1 })                    // 标题前的引言段
      }
      name = line.trim()
      segStart = offset + rawLine.length + 1                                       // 标题行之后（+1 = \n）
    }
    offset += rawLine.length + 1
  }
  if (name !== null) spans.push({ name, start: segStart, end: text.length })
  else spans.push({ name: '正文', start: 0, end: text.length })                    // 无标题 → 单章
  return spans
}

/** 本地书导入失败——类目 local-import（HTTP status 映射归 services/errors.classify + api/wire.STATUS_OF 唯一主人）。 */
export class LocalImportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

/** 本地书文件超限——类目 local-too-large（413 PayloadTooLarge 由分类表投影，与空文件的 400 分列） */
export class LocalFileTooLargeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

/** 本地产物不存在（元数据 / 章号 / 文档 / 资源查不到）——类目 not-found（404）。与导入失败分列：
 *  读一个不存在的东西不是「这次的输入不成立」。 */
export class LocalArtifactNotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

/** 导入结果里可进书架的书目字段（字段名与 wire 的 ShelfBook 同源，不另立字段表）。
 *  EPUB 有作者/封面，TXT 全缺席；总章数不进这里——它由门面从 `chapterCount` 统一投影。 */
export type LocalBookMeta = Pick<ShelfBook, 'author' | 'coverUrl'>

/** 本地导入结果（服务层据此入架并投影成 wire 的 LocalImportResponse） */
export interface LocalImportResult {
  bookKey: string
  title: string
  chapterCount: number
  format: 'txt' | 'epub'
  /** 整本编码；EPUB 恒 null（各文档可能各自编码，不伪称整本 UTF-8） */
  encoding: string | null
  warnings: LocalImportWarning[]
  book: LocalBookMeta
}

/** 本地资源读口（**仅 Node 内部**：流与 MIME 不上 wire，磁盘路径不出现在返回形状里） */
export interface LocalResource {
  /** 导入期**验证结果**的 MIME（不是 manifest 声明） */
  readonly mediaType: string
  /** **打开时 stat 出的真实字节数**（响应头用）：导入期记的落盘值只在元数据里，文件被截断时按它发 content-length 会让客户端等一条永远不来的尾巴 */
  readonly bytes: number
  /** 已成功打开的落盘资源流：打开失败即抛，响应头不会先发。调用方负责在断连/出错时销毁 */
  readonly stream: Readable
}

/** 本地导入上限（缺省 50MB）。**这个数是唯一主人**：传输层、门面回退与 `src/config.ts` 的 schema `.default()` 全走它——
 *  流读时按它计数，解析层再判一次，两边不一致会出现「读进来了却拒不解析」的错觉。 */
export const DEFAULT_MAX_IMPORT_BYTES = 50 * 1024 * 1024

/** 同时顾及几本本地书：正文全文与元数据两张表各按这个数收（读一本时另一本留着不至于重解）。 */
const MAX_CACHED_BOOKS = 3
/** EPUB 原文在书目录里的名字（重解析路径保留上传字节） */
const ORIGINAL_EPUB = 'original.epub'
/** 构建期目录后缀：`local/<uuid>.importing/` 建成后一次 rename 成 `local/<uuid>/` */
const STAGING_SUFFIX = '.importing'

/**
 * 本地书库：TXT 与 EPUB 的**落盘身份**、发布提交协议、正文/导航/资源读取与删除。
 *
 * ① **分流只看魔数**：文件头是 ZIP 本地头签名 `PK\x03\x04` 即走 EPUB，此后归档层与包层的**任何**失败都照原样
 *   上抛（`EpubImportError` → 400），**不做 TXT 兜底**；不是 ZIP 魔数才走既有 TXT 解码链（BOM → UTF-8 严格 → GBK）。
 *   分流后仍有一道入口拒收：认得出的具名容器头（PDF / MOBI / UMD）、名字声明 EPUB 而内容无 ZIP 头、TXT 解出来
 *   不是可读文本（`ADR-0065`）。被否的是「对一切非 UTF-8 字节判拒」的全量启发式，不是这几条判据。
 * ② **顶层元数据是提交标记**：EPUB 先在 `local/<uuid>.importing/` 建全部产物，一次 rename 到 `local/<uuid>/`，
 *   再原子写 `local/<uuid>.json`，最后由门面入架。本地目录与 shelf.json 之间**没有**跨文件事务，不假装有：
 *   强杀恰在「元数据写完、书架落盘前」会留一份完整但未入架的副本（本轮不建恢复扫描器）。
 * ③ **失败只碰本次 UUID 的路径**（staging / 已发布目录 / 元数据 / 同名 TXT 两件），绝不删 `local/` 之外的东西。
 *
 * 本层不认识 EPUB 的语法：解析与规范化全归 `services/epub/`，这里只做分流、落盘、读取与删除。
 */
export class LocalBooks {
  private readonly localDir: string
  /** 导入上限（活值）：每次 import 读一次快照——大小判定与报错文案必须是同一个值。 */
  private readonly maxImportBytes: ValueSource<number>
  /** bookKey → 解码全文；Map 迭代序 = LRU 序（get 时 delete+set 提升）。**只装 TXT**：
   *  EPUB 正文按文档按需读 JSON，不把整本塞进这个 LRU（那是两份缓存与两套失效口径）。 */
  private readonly textCache = new Map<string, string>()
  /** bookKey → 元数据；章节/资源读取共用。TXT 的章节偏移表与 EPUB 的文档/资源表都在这里，不缓存就得每章/每图重读重解析。 */
  private readonly metaCache = new Map<string, LocalMeta>()
  private readonly metaInflight = new Map<string, Promise<LocalMeta>>()
  /** 删书代际：在途 meta 读取不得把已删书的旧表重新塞回缓存。全局递增——一本书被删就让所有
   *  在途读取放弃写回（只是少一次缓存，不会串书），避免按书键累积的回收账。 */
  private metaEpoch = 0

  private constructor(dir: string, maxImportBytes: ValueSource<number>) {
    this.localDir = path.join(dir, 'local')
    this.maxImportBytes = maxImportBytes
  }

  static async create(dir: string, opts?: { maxImportBytes?: ValueSource<number> }): Promise<LocalBooks> {
    const lb = new LocalBooks(dir, opts?.maxImportBytes ?? DEFAULT_MAX_IMPORT_BYTES)
    await fs.mkdir(lb.localDir, { recursive: true })
    return lb
  }

  /** 导入（TXT / EPUB 按**文件头魔数**分流）+ 落盘。发布是否算完成由顶层元数据说了算（口径②）。 */
  async import(buf: Buffer, name: string): Promise<LocalImportResult> {
    const maxImportBytes = readValue(this.maxImportBytes)
    if (buf.length === 0) throw new LocalImportError('文件为空')
    if (buf.length > maxImportBytes) {
      throw new LocalFileTooLargeError(`文件超过 ${formatByteLimit(maxImportBytes)} 上限`)
    }
    // 具名容器魔数在分流**之前**拒：TXT 链对任何字节都能给出结果（GBK 兜底 + 无标题单章），让 PDF/MOBI/UMD
    // 落进去等于以 200 入架一本读不出的书。这是具名判据，不是「剩下的字节都算文本」（口径见 `ADR-0014` 的在册待裁与 `ADR-0065`）。
    const named = namedContainerMagicOf(buf)
    if (named !== null) throw new LocalImportError(`文件是 ${named} 容器，本插件的本地导入只支持 TXT 与 EPUB`)
    const isZip = hasZipMagic(buf)
    // 文件名是「按哪种容器去验」的提示，不是改道判据：`.txt` 命名的 ZIP 照旧走 EPUB（内容赢）。只在名字声明了 EPUB、
    // 内容却连 ZIP 头都没有时生效，把「按 TXT 硬解成单章书」挡掉——只多拒、不静默收。
    if (!isZip && /\.epub$/i.test(name)) {
      throw new LocalImportError('文件名声明是 EPUB（.epub），但内容不是 ZIP 容器（缺少 ZIP 本地头签名）：不按 TXT 导入；若文件本是纯文本，请改回 .txt；若本应是 EPUB，文件可能已损坏')
    }
    return isZip ? this.publishEpub(buf, name) : this.publishText(buf, name)
  }

  /** TXT：布局与元数据形态与既有**完全一致**（`<uuid>.txt` + 无 schemaVersion 的 `<uuid>.json`）——旧偏移表、旧进度、旧读取路径一字不改。 */
  private async publishText(buf: Buffer, name: string): Promise<LocalImportResult> {
    const { text, encoding } = decodeLocalText(buf)
    // 判据放在切章之前：切不开也要先把「这不是文本」说出口，别让整本二进制白切一遍再入架
    assertReadableDecodedText(text)
    const chapters = splitChapters(text)
    const id = randomUUID()
    const meta: StoredTextMeta = {
      title: titleFromName(name), originalName: name,
      importedAt: Date.now(), encoding, chapters, length: text.length,
    }
    try {
      await fs.writeFile(this.fileOf(id, 'txt'), buf)                     // 原文落盘（重解码路径保留）
      await writeJsonAtomic(this.fileOf(id, 'json'), meta)
    } catch (e) {
      await this.discard(id)
      throw e
    }
    return {
      bookKey: `local:${id}`, title: meta.title, chapterCount: chapters.length,
      format: 'txt', encoding, warnings: [], book: {},
    }
  }

  /** EPUB 发布协议（口径②）：建 staging → 导入器只写 documents/ 与 resources/ → 原字节另存 original.epub → rename →
   *  原子写顶层元数据 →（门面入架）。中途任何失败都回收本次 UUID 的全部落盘物。 */
  private async publishEpub(buf: Buffer, name: string): Promise<LocalImportResult> {
    const id = randomUUID()
    const bookKey = `local:${id}`
    const staging = this.stagingDirOf(id)
    let data: EpubImportData
    try {
      await fs.mkdir(staging, { recursive: true })
      data = await importEpub(buf, staging)
      await fs.writeFile(path.join(staging, ORIGINAL_EPUB), buf)
      await fs.rename(staging, this.bookDirOf(id))
      await writeJsonAtomic(this.fileOf(id, 'json'), metaOfImport(data, name))
    } catch (e) {
      await this.discard(id)
      throw e
    }
    const title = titleFromName(name)
    return {
      bookKey,
      title: data.title ?? title,
      chapterCount: data.chapters.length,
      format: 'epub',
      // 各文档可能各自编码，不伪称整本 UTF-8
      encoding: null,
      warnings: warningListOf(data.findings),
      book: bookMetaOf(data, bookKey),
    }
  }

  /** 目录：线性阅读序列（TXT 的旧响应一字不改；EPUB 按 spine 的章序列、名字取文档标题） */
  async getToc(bookKey: string): Promise<ChapterEntry[]> {
    return this.tocOf(await this.metaOf(bookKey), bookKey)
  }

  /** 章数：线性阅读序列的长度（TXT 偏移表 / EPUB 阅读单元共用 `meta.chapters`）；只要一个数时走这里，`getToc` 会顺带造整套展示条目。 */
  async chapterCount(bookKey: string): Promise<number> {
    return (await this.metaOf(bookKey)).chapters.length
  }

  /** 目录导航：EPUB 读持久化的原生目录树；无原生目录的书（TXT）按线性序列派生平面导航。
   *  `chapters` 是线性阅读序列（进度/逐章 API/导出范围按它），`items` 是展示树——两者不是一一对应。 */
  async getNavigation(bookKey: string): Promise<BookNavigation> {
    const meta = await this.metaOf(bookKey)
    const chapters = this.tocOf(meta, bookKey)
    return { chapters, items: isEpubMeta(meta) ? meta.navigation : planarNavigation(chapters) }
  }

  /** 章节正文（**图文面**）：EPUB 按需读该章的文档 JSON（不进 TXT 整本 LRU），TXT 走解码 LRU 切片 */
  async getChapterContent(bookKey: string, index: number): Promise<ChapterContent> {
    const meta = await this.metaOf(bookKey)
    if (!isEpubMeta(meta)) return { kind: 'text', text: await this.textChapter(bookKey, index, meta) }
    const chapter = meta.chapters[index]
    if (chapter === undefined) {
      throw new LocalArtifactNotFoundError(`本地书没有第 ${index} 章（共 ${meta.chapters.length} 章）`)
    }
    return this.readDocument(bookKey, meta, chapter.documentId)
  }

  /** 章节正文（**文字面**）：图文面的文字投影——唯一实现是 shared/chapter-text 的 chapterContentToText，不写第二份。 */
  async getChapter(bookKey: string, index: number): Promise<string> {
    return chapterContentToText(await this.getChapterContent(bookKey, index))
  }

  /** 补充文档（脚注/附录）：按文档 ID 读规范化 JSON——正文流之外的东西不计章号 */
  async getSupplement(bookKey: string, documentId: string): Promise<ChapterContent> {
    const meta = await this.epubMetaOf(bookKey)
    return this.readDocument(bookKey, meta, documentId)
  }

  /** 导入告警（导入说明可重看）：非 EPUB 恒空数组；EPUB 读 codec 已在解码时归一成一列 */
  async getImportWarnings(bookKey: string): Promise<LocalImportWarning[]> {
    const meta = await this.metaOf(bookKey)
    return isEpubMeta(meta) ? meta.warnings : []
  }

  /** 资源读口：**只认不透明 ID**——先在持久化资源表里查（查不到 404），再按表里的相对名打开文件；路径从不来自请求。
   *  打开成功后才返回流（响应头不会先发），字节数取**打开后 stat 的真实 size**（截断时元数据那份不是真相）。 */
  async getResource(bookKey: string, resourceId: string): Promise<LocalResource> {
    const meta = await this.epubMetaOf(bookKey)
    // 表是 JSON.parse 的普通对象：必须只认**自有键**——继承成员会让 `ref.file` 取到 undefined，`path.resolve` 抛 TypeError（500）而不是 404
    const ref = Object.hasOwn(meta.resources, resourceId) ? meta.resources[resourceId] : undefined
    if (ref === undefined) throw new LocalArtifactNotFoundError(`本地书没有这份资源: ${resourceId}`)
    // open 与 stat 必须收在**同一个 try**：分开写时 stat 抛错既不关 fd，又绕过 ENOENT→404 落到 classify 的 other
    let handle: Awaited<ReturnType<typeof fs.open>> | null = null
    try {
      handle = await fs.open(this.artifactPath(bookKey, ref.file), 'r')
      const { size } = await handle.stat()
      // 成功路径不关句柄：流的所有权随返回值交给调用方（断连/出错由它销毁）
      return { mediaType: ref.mediaType, bytes: size, stream: handle.createReadStream() }
    } catch (e) {
      await handle?.close().catch(() => undefined)
      // 文件不在（被清掉/损坏）：与「资源 ID 查不到」同一种读数——404，而不是把 500 丢给用户
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new LocalArtifactNotFoundError(`本地资源文件缺失: ${resourceId}`)
      }
      // 其余失败（打开成功后的 stat 失败即 I/O/产物损坏）原样上抛：文件是在的，404 会说谎「没有这份资源」。
      throw e
    }
  }

  /** 删除：TXT 两件文件、EPUB 整棵目录 + 顶层元数据——**都走 discard 同一份清点**，不会留下半份残骸。
   *  存在性只看元数据文件在不在（**不解析**）：损坏的元数据不该让恢复路径也炸。 */
  async remove(bookKey: string): Promise<boolean> {
    if (!isLocalBookKey(bookKey)) return false
    const id = this.idOf(bookKey)
    const existed = await fs.stat(this.fileOf(id, 'json')).then(() => true, () => false)
    await this.discard(id)
    this.textCache.delete(bookKey)
    this.metaCache.delete(bookKey)
    this.metaInflight.delete(bookKey)                 // 删后新读不许 join 删除前那一发
    this.metaEpoch += 1
    return existed
  }

  // ── 内部：读取 ────────────────────────────────────────────────────────

  private tocOf(meta: LocalMeta, bookKey: string): ChapterEntry[] {
    const names = isEpubMeta(meta) ? meta.chapters.map((c) => c.label) : meta.chapters.map((c) => c.name)
    return names.map((name, i) => ({ name, url: `${bookKey}#${i}` }))
  }

  /** 派生产物读取：坏形状（不是图文树 / documentId 与文档表对不上）即报错，不拿错内容冒充成功 */
  private async readDocument(bookKey: string, meta: LocalEpubMeta, documentId: string): Promise<ChapterContent> {
    // 同 getResource：只认自有键，构造出的 id（constructor/__proto__/toString）落 404 而不是 500
    const doc = Object.hasOwn(meta.documents, documentId) ? meta.documents[documentId] : undefined
    if (doc === undefined) throw new LocalArtifactNotFoundError(`本地书里没有这份文档: ${documentId}`)
    const content = JSON.parse(await fs.readFile(this.artifactPath(bookKey, doc.file), 'utf8')) as ChapterContent
    if (content.kind !== 'rich' || content.documentId !== doc.id) {
      // **显式选 500**：查不到文档是 404，而「元数据说产物在、内容却对不上号」是服务端存储坏了——报 404 会把自损伪装成「没这份文档」
      throw new Error(`本地书产物损坏或错位: ${doc.file}`)
    }
    return content
  }

  /** TXT 章切片（既有实现原样搬进来）：解码全文 LRU（3 本）+ 字符偏移夹紧 */
  private async textChapter(bookKey: string, index: number, meta: LocalTextMeta): Promise<string> {
    const span = meta.chapters[index]
    if (span === undefined) {
      throw new LocalArtifactNotFoundError(`本地书没有第 ${index} 章（共 ${meta.chapters.length} 章）`)
    }
    let text = lruGet(this.textCache, bookKey)
    if (text === undefined) {
      text = decodeLocalText(await fs.readFile(this.fileOf(this.idOf(bookKey), 'txt'))).text
      lruSet(this.textCache, bookKey, text, MAX_CACHED_BOOKS)
    }
    // 退化 span（相邻标题行 / 文末孤标题）可能 start > end——夹紧边界，保证只切出 '' 而非负长度
    const start = Math.max(0, Math.min(span.start, text.length))
    const end = Math.max(start, Math.min(span.end, text.length))
    return text.slice(start, end).trim()
  }

  // ── 内部：路径与清理 ───────────────────────────────────────────────────

  private idOf(bookKey: string): string {
    const m = BOOK_KEY_RE.exec(bookKey)
    const id = m === null ? undefined : m[1]
    // 切不出 id 与「整体不匹配」同路：都按非法本地书 key 拒收（本函数已有的错误通道）
    if (id === undefined) throw new LocalArtifactNotFoundError(`非法本地书 key: ${bookKey}`)
    return id
  }

  private async metaOf(bookKey: string): Promise<LocalMeta> {
    if (!isLocalBookKey(bookKey)) throw new LocalArtifactNotFoundError(`非法本地书 key: ${bookKey}`)
    const hit = lruGet(this.metaCache, bookKey)
    if (hit !== undefined) return hit
    const inflight = this.metaInflight.get(bookKey)
    if (inflight !== undefined) return inflight
    const epoch = this.metaEpoch
    const p = (async (): Promise<LocalMeta> => {
      const raw = await readJson<unknown>(this.fileOf(this.idOf(bookKey), 'json'), null)
      if (raw === null) throw new LocalArtifactNotFoundError(`本地书不存在: ${bookKey}`)
      // 唯一的 meta 读口：磁盘形状 → 当前内存形状（版本判别与旧形状归一都在 codec 里）
      const meta = decodeLocalMeta(raw, bookKey)
      if (this.metaEpoch === epoch) lruSet(this.metaCache, bookKey, meta, MAX_CACHED_BOOKS)
      return meta
    })()
    this.metaInflight.set(bookKey, p)
    const clear = (): void => { if (this.metaInflight.get(bookKey) === p) this.metaInflight.delete(bookKey) }
    p.then(clear, clear)
    return p
  }

  private async epubMetaOf(bookKey: string): Promise<LocalEpubMeta> {
    const meta = await this.metaOf(bookKey)
    if (!isEpubMeta(meta)) throw new LocalArtifactNotFoundError(`本地书不是 EPUB（没有文档与资源表）: ${bookKey}`)
    return meta
  }

  /** 落盘产物的绝对路径：相对名只可能来自本仓写入的元数据，仍然夹紧在本书目录内——元数据即使被改写也走不出 `local/<uuid>/`。 */
  private artifactPath(bookKey: string, relFile: string): string {
    const root = this.bookDirOf(this.idOf(bookKey))
    const abs = path.resolve(root, relFile)
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      throw new LocalArtifactNotFoundError(`本地书产物路径越界: ${relFile}`)
    }
    return abs
  }

  /** 清掉本次 UUID 的**全部**落盘物：已发布目录、构建期目录、元数据与损坏备份、同名 TXT 两件、原子写残留。
   *  路径全由 `local/` + uuid 拼出，绝不触碰别的书。 */
  private async discard(id: string): Promise<void> {
    const entries = await fs.readdir(this.localDir).catch((): string[] => [])
    const json = this.fileOf(id, 'json')
    const txt = this.fileOf(id, 'txt')
    // 残留与备份的**命名判据归 storage**（isAtomicTemp / backupPathOf）：在这里写死 `.tmp`/`.bak` 去猜，低层一改命名就会悄悄漏清
    const temps = entries.filter((f) => isAtomicTemp(json, f) || isAtomicTemp(txt, f))
    await Promise.all([
      fs.rm(this.bookDirOf(id), { recursive: true, force: true }),
      fs.rm(this.stagingDirOf(id), { recursive: true, force: true }),
      fs.rm(txt, { force: true }),
      fs.rm(json, { force: true }),
      fs.rm(backupPathOf(json), { force: true }),
      ...temps.map((f) => fs.rm(path.join(this.localDir, f), { force: true })),
    ])
  }

  private fileOf(id: string, ext: 'txt' | 'json'): string {
    return path.join(this.localDir, `${id}.${ext}`)
  }

  private bookDirOf(id: string): string {
    return path.join(this.localDir, id)
  }

  private stagingDirOf(id: string): string {
    return path.join(this.localDir, `${id}${STAGING_SUFFIX}`)
  }
}

// ── 模块级助手 ─────────────────────────────────────────────────────────

/** 兜底书名的洗字符收口：去掉路径分隔/非法字符（TXT 与 EPUB 共用；扩展名已由 `titleFromName` 剥掉） */
function titleOf(base: string): string {
  return base.replace(/[\\/:*?"<>|\r\n]/g, '_').trim() || '未命名'
}

/** 文件名 → 兜底书名：先剥末级扩展名（任意后缀，不认 `.txt` 一种），再交 `titleOf` 洗字符；TXT 与 EPUB 两条发布路径共用。 */
function titleFromName(name: string): string {
  return titleOf(name.replace(/\.[^./\\]+$/, ''))
}

/** 导入索引 → 持久化元数据：只补书身份与时间戳，元素形状原样落盘（形状主人是导入层）；返回类型即**存储形状**的声明点。 */
function metaOfImport(data: EpubImportData, name: string): StoredEpubMetaV2 {
  return {
    schemaVersion: LOCAL_META_SCHEMA_VERSION,
    format: 'epub',
    title: data.title ?? titleFromName(name),
    author: data.author,
    originalName: name,
    importedAt: Date.now(),
    chapters: [...data.chapters],
    documents: { ...data.documents },
    resources: { ...data.resources },
    navigation: [...data.items],
    findings: [...data.findings],
    // 旧版本读面只认这一项：降级运行时仍能显示导入说明；读面优先 findings，不会两本账各说一套
    warnings: warningListOf(data.findings),
  }
}

/** 导入索引 → 书架书目字段：**复用既有 SHELF_META 字段**（作者/封面），不新增本地格式字段；总章数由门面从 `chapterCount` 投影。
 *  封面 URL 走 `wire.resourceUrl`（唯一构造器，与客户端插图的 src 同一份）——各拼一次会在改动时分叉。 */
function bookMetaOf(data: EpubImportData, bookKey: string): LocalBookMeta {
  return {
    ...(data.author === null ? {} : { author: data.author }),
    ...(data.coverResourceId === null
      ? {}
      : { coverUrl: resourceUrl(bookKey, data.coverResourceId) }),
  }
}

/**
 * 分流的**唯一判据**（口径①）：ZIP 本地头签名 `PK\x03\x04`。
 *
 * 为什么只看文件头 4 字节：把「打不开的 ZIP」也算成「不是 EPUB」就等于让归档层的安全拒绝（加密、zip-slip、
 * 超限……）与包层失败统统落回 TXT 链，而 TXT 链对任何字节都能给出结果——一份加密 ZIP 会变成 200 的整本乱码。
 * ZIP 就是 ZIP，是 EPUB 与否由 EPUB 路径自己判。
 *
 * 另一面同样刻意：**不新增「对一切非 UTF-8 字节判拒」的全量启发式**——那会让现网本可读的 TXT（GBK 短篇、
 * 含控制字符的导出）变成拒收，比乱码更坏。判据白名单式：只有 ZIP 签名改道，其余走既有 TXT 解码链；
 * 三条**具名**判据（别的容器、名字声明 EPUB、解出来不含文本）各在 `namedContainerMagicOf`、`import` 与
 * `assertReadableDecodedText`，口径见 `ADR-0065`。
 */
function hasZipMagic(buf: Buffer): boolean {
  return buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04
}

/**
 * 认得出的**具名**容器头：返回名字，认不出返回 `null`。这不是「二进制即拒收」的启发式：只在这几个签名对得上
 * 时拒，其余字节照旧走解码链。三种容器各有固定文件头（UMD 是偏移 0 起的 `89 9B 9A DE`；该格式没有公开规范，
 * 签名由多份独立逆向资料一致给出），认出即点名；认不出的容器靠解码终点断言兜底，那是本仓承认的残留面（`ADR-0065`）。
 */
function namedContainerMagicOf(buf: Buffer): string | null {
  if (buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'PDF'
  // PDB 的 creator/type 在偏移 60 起，MOBI 书恒为 `BOOKMOBI`
  if (buf.length >= 68 && buf.subarray(60, 68).toString('latin1') === 'BOOKMOBI') return 'MOBI / PDB'
  // UMD 的容器头：偏移 0 起的四个字节
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x9b && buf[2] === 0x9a && buf[3] === 0xde) return 'UMD'
  return null
}

/**
 * 解码终点断言：**解出来不等于读得懂**。TXT 链的两处兜底（GBK 永不失败、无标题就切一章）意味着这条路上没有
 * 任何一步会说「不」——一份被清零的归档、一本纯空白文件都会以「1 章导入成功」入架，那是本仓的最高罪。
 * 出现 U+0000 说明字节不是本仓能按 UTF-8/GBK 读出的文本（被清零/截断的二进制，或无 BOM 的 UTF-16）；
 * 整本没有非空白字符则连「有内容」都不成立。
 */
function assertReadableDecodedText(text: string): void {
  if (text.includes('\u0000')) {
    throw new LocalImportError('文件解码后含空字符（U+0000）：这不是可读文本（可能是被清零/截断的二进制，或本插件不支持的无 BOM 的 UTF-16 一类编码）')
  }
  if (text.trim() === '') {
    throw new LocalImportError('文件里没有可读的内容（全文只有空白）：不按「一章空白正文」入架')
  }
}
