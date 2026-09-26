import iconv from 'iconv-lite'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Readable } from 'node:stream'
import { LOCAL_SOURCE_ID, planarNavigation, resourceUrl } from '../shared/wire.js'
import type {
  BookNavigation, ChapterContent, ChapterEntry, LocalImportWarning, NavigationItem, ShelfBook,
} from '../shared/wire.js'
import { chapterContentToText } from './chapter-content.js'
import { importEpub } from './epub/import.js'
import type { EpubChapterRef, EpubDocumentRef, EpubImportData, EpubResourceRef } from './epub/import.js'
import { readJson, writeJsonAtomic, isAtomicTemp, backupPathOf } from './storage.js'

/** 本地书的保留源 id：**单主人是 shared/wire.ts**（跨半契约常量）。服务半可直接 import shared
 *  （services/types.ts、reading.ts 已在做），故此处不再是第二份声明——re-export 保留既有 import 路径。 */
export { LOCAL_SOURCE_ID }

/** 章节偏移表项：字符偏移区间 [start, end)，name 为标题行原文（或兜底「正文」） */
export interface ChapterSpan { name: string; start: number; end: number }

/** bookKey 形态 `local:<uuid>`；严格 uuid 校验兼防路径穿越 */
export const BOOK_KEY_RE = /^local:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/
export function isLocalBookKey(bookKey: string): boolean {
  return BOOK_KEY_RE.test(bookKey)
}

/**
 * 本地文件解码链（不复用 fetcher.decodeBody——其兜底是 UTF-8，GBK 会乱码；
 * 本地文件也没有 Content-Type）：BOM 优先 → UTF-8 严格探测 → GBK 回退。
 */
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

/** 本地书导入失败（文件为空/解析不出章节等）——类目 local-import（错误体不再
 *  自带 HTTP status，映射归分类表 services/errors.classify + api/wire.STATUS_OF 唯一主人） */
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

/** 本地产物不存在（书元数据 / 章号 / 文档 / 资源查不到）——类目 not-found（HTTP 404）。
 *  与 LocalImportError 分列：导入失败是「这次的输入不成立」（400），而读一个不存在的东西是 404；
 *  两者混成一类会让「书被删了」显示成「本地导入失败」。 */
export class LocalArtifactNotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

/** TXT 元数据（**既有形态**）：没有 schemaVersion——顶层元数据缺席它就是 TXT，旧书零迁移 */
interface LocalTextMeta {
  title: string
  originalName: string
  importedAt: number
  encoding: string
  chapters: ChapterSpan[]
  length: number
}

/**
 * EPUB 元数据：`schemaVersion: 2` 既是**提交标记**（顶层元数据写完才算发布完成），也是格式判据。
 *
 * 章序列/文档表/资源表直接复用导入层的索引类型：形状主人是 `services/epub/import.ts`，
 * 这里不再抄一份字段表（抄一份的下场是导入端加字段、读端不知道）。书目元数据（作者/封面/总章数）
 * 不进这里——它们走既有 `SHELF_META` 字段集落 shelf.json，本地格式不新增可 patch 字段。
 */
interface LocalEpubMeta {
  schemaVersion: 2
  format: 'epub'
  title: string
  author: string | null
  originalName: string
  importedAt: number
  /** 阅读序列（index 即章号）；章数只认它 */
  chapters: EpubChapterRef[]
  documents: Record<string, EpubDocumentRef>
  resources: Record<string, EpubResourceRef>
  /** 展示用目录树（原生 nav/NCX；wire 形状） */
  navigation: NavigationItem[]
  warnings: LocalImportWarning[]
}

type LocalMeta = LocalTextMeta | LocalEpubMeta

function isEpubMeta(meta: LocalMeta): meta is LocalEpubMeta {
  return (meta as { schemaVersion?: unknown }).schemaVersion === 2 && (meta as { format?: unknown }).format === 'epub'
}

/** 导入结果里可进书架的书目字段（字段名与 wire 的 ShelfBook 同源，不另立字段表）。
 *  EPUB 有作者/封面/章数，TXT 全缺席（沿用既有行为：TXT 入架只写 title）。 */
export type LocalBookMeta = Pick<ShelfBook, 'author' | 'coverUrl' | 'totalChapters'>

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
  /** **打开时 stat 出的真实字节数**（响应头用）：导入期记的落盘值只在元数据里，
   *  文件被截断时它不是真相——按它发 content-length 会让客户端等一条永远不来的尾巴 */
  readonly bytes: number
  /** 已成功打开的落盘资源流：打开失败即抛，响应头不会先发。调用方负责在断连/出错时销毁 */
  readonly stream: Readable
}

const MAX_CACHED_BOOKS = 3
/** EPUB 原文在书目录里的名字（重解析路径保留上传字节） */
const ORIGINAL_EPUB = 'original.epub'
/** 构建期目录后缀：`local/<uuid>.importing/` 建成后一次 rename 成 `local/<uuid>/` */
const STAGING_SUFFIX = '.importing'

/**
 * 本地书库：TXT 与 EPUB 的**落盘身份**、发布提交协议、正文/导航/资源读取与删除。
 *
 * 三条口径（改这一层先读它们）：
 * ① **分流只看魔数**：文件头是 ZIP 本地头签名 `PK\x03\x04` 即走 EPUB 路径，此后归档层与包层的
 *    **任何**失败都照原样上抛（`EpubImportError` → 400）——加密位 / 符号链接 / 非 store-deflate /
 *    重名 / zip-slip / 条目与解压超限 / 缺 mimetype / 坏 XML 都是这条路径上的失败，**不做 TXT 兜底**。
 *    不是 ZIP 魔数的才走既有 TXT 解码链（BOM → UTF-8 严格 → GBK 回退，一字不改）。
 *    为什么不去「先试着开归档、失败就当 TXT」：那正是把归档层明令的**安全拒绝**吞成「不是 EPUB」，
 *    再让 GBK 兜底与「无标题单章」把一份加密 ZIP 落成一整本乱码、以 200 入架——本仓
 *    「失败冒充成功」的最坏形态。分流判据因此只认文件头 4 字节，不看任何解析结果；
 *    缺 mimetype 的普通 ZIP 同属 EPUB 路径的失败，不为它开第二条路。
 * ② **顶层元数据是提交标记**：EPUB 先在 `local/<uuid>.importing/` 建全部产物，一次 rename 到
 *    `local/<uuid>/`，再原子写 `local/<uuid>.json`，最后才由门面入架。本地目录与 shelf.json 之间
 *    **没有**跨文件事务，不假装有：强杀恰在「元数据写完、书架落盘前」会留一份完整但未入架的副本，
 *    本轮不建恢复扫描器（如实披露，不用自动删除掩盖）。
 * ③ **失败只碰本次 UUID 的路径**（staging / 已发布目录 / 元数据 / 同名 TXT 两件），绝不删 `local/`
 *    之外的东西、绝不碰别的书的文件。
 *
 * 本层不认识 EPUB 的语法：解析与规范化全归 `services/epub/`，这里只做分流、落盘、读取与删除。
 */
export class LocalBooks {
  private readonly localDir: string
  private readonly maxImportBytes: number
  /** bookKey → 解码全文；Map 迭代序 = LRU 序（get 时 delete+set 提升）。**只装 TXT**：
   *  EPUB 正文按文档按需读 JSON，不把整本塞进这个 LRU（那是两份缓存与两套失效口径）。 */
  private readonly textCache = new Map<string, string>()

  private constructor(dir: string, maxImportBytes: number) {
    this.localDir = path.join(dir, 'local')
    this.maxImportBytes = maxImportBytes
  }

  static async create(dir: string, opts?: { maxImportBytes?: number }): Promise<LocalBooks> {
    const lb = new LocalBooks(dir, opts?.maxImportBytes ?? 50 * 1024 * 1024)
    await fs.mkdir(lb.localDir, { recursive: true })
    return lb
  }

  /** 导入（TXT / EPUB 按**文件头魔数**分流）+ 落盘。发布是否算完成由顶层元数据说了算（口径②）。 */
  async import(buf: Buffer, name: string): Promise<LocalImportResult> {
    if (buf.length === 0) throw new LocalImportError('文件为空')
    if (buf.length > this.maxImportBytes) {
      throw new LocalFileTooLargeError(`文件超过 ${Math.round(this.maxImportBytes / 1024 / 1024)}MB 上限`)
    }
    return hasZipMagic(buf) ? this.publishEpub(buf, name) : this.publishText(buf, name)
  }

  /** TXT：布局与元数据形态与既有**完全一致**（`<uuid>.txt` + 无 schemaVersion 的 `<uuid>.json`）——
   *  旧偏移表、旧进度、旧读取路径一字不改。 */
  private async publishText(buf: Buffer, name: string): Promise<LocalImportResult> {
    const { text, encoding } = decodeLocalText(buf)
    const chapters = splitChapters(text)
    const id = randomUUID()
    const meta: LocalTextMeta = {
      title: titleOf(name.replace(/\.txt$/i, '')), originalName: name,
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

  /**
   * EPUB 发布协议（口径②）：建 staging → 导入器只写 documents/ 与 resources/ → 原字节另存
   * original.epub → rename 成最终目录 → 原子写顶层元数据（提交标记）→（门面入架）。
   * 中途任何失败都回收本次 UUID 的全部落盘物（含刚发布出去的目录与原子写的临时残留）。
   */
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
    const title = titleOf(name.replace(/\.[^./\\]+$/, ''))
    return {
      bookKey,
      title: data.title ?? title,
      chapterCount: data.chapters.length,
      format: 'epub',
      // 各文档可能各自编码，不伪称整本 UTF-8
      encoding: null,
      warnings: [...data.warnings],
      book: bookMetaOf(data, bookKey),
    }
  }

  /** 目录：线性阅读序列（TXT 的旧响应一字不改；EPUB 按 spine 的章序列、名字取文档标题） */
  async getToc(bookKey: string): Promise<ChapterEntry[]> {
    return this.tocOf(await this.metaOf(bookKey), bookKey)
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

  /** 章节正文（**文字面**）：图文面的文字投影——唯一实现在 chapter-content.chapterContentToText，
   *  这里不写第二份投影（同一本书的导出、AI 工具与阅读器必须读到同一段文字） */
  async getChapter(bookKey: string, index: number): Promise<string> {
    return chapterContentToText(await this.getChapterContent(bookKey, index))
  }

  /** 补充文档（脚注/附录）：按文档 ID 读规范化 JSON——正文流之外的东西不计章号 */
  async getSupplement(bookKey: string, documentId: string): Promise<ChapterContent> {
    const meta = await this.epubMetaOf(bookKey)
    return this.readDocument(bookKey, meta, documentId)
  }

  /** 导入告警（导入说明可重看）：非 EPUB 恒空数组 */
  async getImportWarnings(bookKey: string): Promise<LocalImportWarning[]> {
    const meta = await this.metaOf(bookKey)
    return isEpubMeta(meta) ? meta.warnings : []
  }

  /**
   * 资源读口：**只认不透明 ID**——先在持久化的资源表里查（查不到 404 类错误），再按表里的相对名
   * 打开文件；路径从不来自请求。打开成功后才返回流（响应头不会先发），字节数取**打开后 stat 的
   * 真实 size**（元数据里那份是导入期记的，文件被截断时按它发 content-length 头体就不一致）。
   */
  async getResource(bookKey: string, resourceId: string): Promise<LocalResource> {
    const meta = await this.epubMetaOf(bookKey)
    // 表是 JSON.parse 出的普通对象：必须只认**自有键**——`constructor`/`__proto__`/`toString` 会命中
    // 继承成员，`ref.file` 取到 undefined → path.resolve 抛 TypeError → 500，而这里要的是 404
    const ref = Object.hasOwn(meta.resources, resourceId) ? meta.resources[resourceId] : undefined
    if (ref === undefined) throw new LocalArtifactNotFoundError(`本地书没有这份资源: ${resourceId}`)
    // open 与 stat 必须收在**同一个 try** 里：分开写时 stat 抛错既不关 fd（句柄泄漏），
    // 又会绕过 ENOENT→404 的判定落到 classify 的 other。
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
      // 其余失败（打开成功后的 stat 失败即 I/O/产物损坏）原样上抛：文件是在的，404 会说谎
      // 「没有这份资源」；这条读数与 `readDocument` 的损坏产物同族（500，原因原样透出）。
      throw e
    }
  }

  /** 删除：TXT 是两件文件、EPUB 是整棵目录 + 顶层元数据——**都走 discard 同一份清点**，
   *  不会留下「只删了顶层 JSON、documents/resources 还在」的残骸。
   *  存在性只看元数据文件在不在（**不解析**）：损坏的元数据不该让恢复路径也炸。 */
  async remove(bookKey: string): Promise<boolean> {
    if (!isLocalBookKey(bookKey)) return false
    const id = this.idOf(bookKey)
    const existed = await fs.stat(this.fileOf(id, 'json')).then(() => true, () => false)
    await this.discard(id)
    this.textCache.delete(bookKey)
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
      // **显式选 500**（不是让它当默认）：查不到文档是 404（`LocalArtifactNotFoundError`，读者问的是
      // 一本书里没有的东西），而「元数据说这份产物在、读出来的内容却对不上号」是服务端自己的存储坏了——
      // 报 404 会把自损伪装成「没这本书的这份文档」，用户与我们都无从下手（宁炸不猜）。
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
    let text = this.textCache.get(bookKey)
    if (text === undefined) {
      text = decodeLocalText(await fs.readFile(this.fileOf(this.idOf(bookKey), 'txt'))).text
      this.textCache.delete(bookKey)                                       // LRU 提升
      this.textCache.set(bookKey, text)
      while (this.textCache.size > MAX_CACHED_BOOKS) {
        this.textCache.delete(this.textCache.keys().next().value as string)
      }
    }
    // 退化 span（相邻标题行 / 文末孤标题）可能 start > end——夹紧边界，保证只切出 '' 而非负长度
    const start = Math.max(0, Math.min(span.start, text.length))
    const end = Math.max(start, Math.min(span.end, text.length))
    return text.slice(start, end).trim()
  }

  // ── 内部：路径与清理 ───────────────────────────────────────────────────

  private idOf(bookKey: string): string {
    const m = BOOK_KEY_RE.exec(bookKey)
    if (m === null) throw new LocalArtifactNotFoundError(`非法本地书 key: ${bookKey}`)
    return m[1]
  }

  private async metaOf(bookKey: string): Promise<LocalMeta> {
    if (!isLocalBookKey(bookKey)) throw new LocalArtifactNotFoundError(`非法本地书 key: ${bookKey}`)
    const meta = await readJson<LocalMeta | null>(this.fileOf(this.idOf(bookKey), 'json'), null)
    if (meta === null) throw new LocalArtifactNotFoundError(`本地书不存在: ${bookKey}`)
    return meta
  }

  private async epubMetaOf(bookKey: string): Promise<LocalEpubMeta> {
    const meta = await this.metaOf(bookKey)
    if (!isEpubMeta(meta)) throw new LocalArtifactNotFoundError(`本地书不是 EPUB（没有文档与资源表）: ${bookKey}`)
    return meta
  }

  /**
   * 落盘产物的绝对路径：相对名只可能来自本仓写入的元数据，仍然夹紧在本书目录内——
   * 元数据即使被改写也走不出 `local/<uuid>/`。
   */
  private artifactPath(bookKey: string, relFile: string): string {
    const root = this.bookDirOf(this.idOf(bookKey))
    const abs = path.resolve(root, relFile)
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      throw new LocalArtifactNotFoundError(`本地书产物路径越界: ${relFile}`)
    }
    return abs
  }

  /**
   * 清掉本次 UUID 的**全部**落盘物：已发布目录、构建期目录、元数据与它的损坏备份、同名 TXT 两件，
   * 以及原子写失败时留下的临时残留。路径全由 `local/` + uuid 拼出（前缀就是 uuid），绝不触碰别的书。
   */
  private async discard(id: string): Promise<void> {
    const entries = await fs.readdir(this.localDir).catch((): string[] => [])
    const json = this.fileOf(id, 'json')
    const txt = this.fileOf(id, 'txt')
    // 残留与备份的**命名判据归 storage**（isAtomicTemp / backupPathOf）：这里原先自己写死
    // `.tmp` 与 `.bak` 去猜低层的名字，低层一改命名就会悄悄漏清（残留留在盘上没人知道）。
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

/** 上传文件名 → 兜底书名：去掉路径分隔/非法字符（TXT 与 EPUB 共用同一条收口） */
function titleOf(base: string): string {
  return base.replace(/[\\/:*?"<>|\r\n]/g, '_').trim() || '未命名'
}

/** 导入索引 → 持久化元数据：索引里的字段原样落盘（形状主人是导入层），只补书身份与时间戳 */
function metaOfImport(data: EpubImportData, name: string): LocalEpubMeta {
  return {
    schemaVersion: 2,
    format: 'epub',
    title: data.title ?? titleOf(name.replace(/\.[^./\\]+$/, '')),
    author: data.author,
    originalName: name,
    importedAt: Date.now(),
    chapters: [...data.chapters],
    documents: { ...data.documents },
    resources: { ...data.resources },
    navigation: [...data.items],
    warnings: [...data.warnings],
  }
}

/** 导入索引 → 书架书目字段：**复用既有 SHELF_META 字段**（作者/封面/总章数），不新增本地格式字段。
 *  封面 URL 走 `wire.resourceUrl`（唯一构造器，与客户端插图的 src 同一份）——两处各拼一次
 *  会在前缀或参数名改动时分叉成两个半场各说各话。 */
function bookMetaOf(data: EpubImportData, bookKey: string): LocalBookMeta {
  return {
    totalChapters: data.chapters.length,
    ...(data.author === null ? {} : { author: data.author }),
    ...(data.coverResourceId === null
      ? {}
      : { coverUrl: resourceUrl(bookKey, data.coverResourceId) }),
  }
}

/**
 * 分流的**唯一判据**（口径①）：ZIP 本地头签名 `PK\x03\x04`。
 *
 * 为什么只看文件头 4 字节、不看任何解析结果：把「打不开的 ZIP」也算成「不是 EPUB」就等于让归档层
 * 明令的安全拒绝（加密、符号链接、非 store-deflate、重名、zip-slip、超限）与包层失败统统落回 TXT 链，
 * 而 TXT 链对任何字节都能给出结果（GBK 兜底 + 无标题单章）——一份加密 ZIP 会变成 200 的整本乱码。
 * 判定「是 EPUB」不再比判定「不是」更严：ZIP 就是 ZIP，是 EPUB 与否由 EPUB 路径自己判并对失败负责。
 *
 * 另一面（brief 明令）：**不新增「二进制即拒收」的启发式**——那会让现网本来能读的 TXT（GBK 短篇、
 * 含控制字符的导出文件）变成拒收，比乱码更坏。这里的判据是白名单式的：只有 ZIP 签名改道，
 * 其余字节一律走既有 TXT 解码链（GBK 回退维持原样）。
 */
function hasZipMagic(buf: Buffer): boolean {
  return buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04
}
