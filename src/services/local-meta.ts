import type { LocalImportWarning, NavigationItem } from '../shared/wire.js'
import type { FindingEntry } from './epub/findings.js'
import { warningListOf } from './epub/findings.js'
import type { EpubChapterRef, EpubDocumentRef, EpubResourceRef } from './epub/import.js'

/**
 * 本地书顶层元数据（`local/<uuid>.json`）的**存储形状与版本化读 codec**。
 *
 * 为什么单独一层：这份文件是跨版本读的——应用升级后要能打开旧书，格式演进要能拿旧形状做一次
 * 显式归一。把「磁盘形状 → 当前内存形状」收在一处，加读面字段时才有唯一落点（在那之前，版本判别
 * 是一个严格等式、旧形状兼容散在读面里，抬版本会让全部存量 EPUB 落进 TXT 分支）。
 *
 * 两条口径：
 * ① **schemaVersion 缺席 = TXT**（旧书零迁移，见 `ADR-0014`）；`schemaVersion: 2` = EPUB，它同时是
 *   发布完成的**提交标记**。版本号或 format 认不出时给具名拒绝，**不猜**、也不落进另一条格式的读法。
 * ② **旧形状只读时归一，不回写磁盘**：归一结果只进内存形状；回写要把整份元数据重写一遍，而它只
 *   影响读面（写盘时机只有导入）。加一个读面字段时，在解码的归一分支给旧书默认值、并加一条
 *   「旧 meta + 新字段」用例——这就是本文件对格式演进的承诺。
 *
 * 章序列/文档表/资源表的**元素形状**仍 import 自 `services/epub/import.ts`：那不是第二张字段表，
 * 存储形状只声明书身份、时间戳与这些表的容器；元素里有什么由导入层说了算，导入端加字段读端不必跟。
 */

/** 当前 EPUB 元数据版本：抬它之前先确认读 codec 认识新形状（或写了迁移），否则存量书会被具名拒绝。 */
export const LOCAL_META_SCHEMA_VERSION = 2

/** 章节偏移表项：字符偏移区间 [start, end)，name 为标题行原文（或兜底「正文」）。 */
export interface ChapterSpan { name: string; start: number; end: number }

/** TXT 的存储形状：**没有版本号**。顶层元数据缺席 schemaVersion 就是它（口径①），旧书一字不改照读。 */
export interface StoredTextMeta {
  title: string
  originalName: string
  importedAt: number
  encoding: string
  chapters: ChapterSpan[]
  length: number
}

/**
 * EPUB 的存储形状（`schemaVersion: 2`）。写入处以它声明盘上的形状；`findings` / `warnings`
 * 两格是历史上不同的落盘方式（新书写事实清单并附一份旧读面投影，旧书只有投影），读时归一成一列。
 */
export interface StoredEpubMetaV2 {
  schemaVersion: typeof LOCAL_META_SCHEMA_VERSION
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
  /**
   * 导入过程的事实清单（半径、动作句、处数与例子）：**拆开落盘**——合并、处数前缀与例子列表由读面
   * 按当下的 `warningListOf` 现算。动作句本身仍是导入时写下的那句（带着那一次的数值与原文）。
   */
  findings?: FindingEntry[]
  /** 旧版本读面的降级投影：同一份事实拼成中文句子后的那一版；读面以 `findings` 为准（同一份事实的投影）。 */
  warnings?: LocalImportWarning[]
}

/** 当前内存形状：TXT 与存储形状同形（还没有需要归一的旧读面字段）。 */
export type LocalTextMeta = StoredTextMeta

/** 当前内存形状：EPUB。告警只有一列——两种落盘形状在解码时归一到这里，读面不再各判一次。 */
export interface LocalEpubMeta {
  format: 'epub'
  title: string
  author: string | null
  originalName: string
  importedAt: number
  chapters: EpubChapterRef[]
  documents: Record<string, EpubDocumentRef>
  resources: Record<string, EpubResourceRef>
  navigation: NavigationItem[]
  /** 导入说明（读面唯一一列）：落盘有事实清单就按当下口径重排，旧书只有投影时原样保留。 */
  warnings: LocalImportWarning[]
}

export type LocalMeta = LocalTextMeta | LocalEpubMeta

/** 内存形状的格式判别（不是存储版本的判别——版本分流在解码里，且拒收认不出的写法）。
 *  归一后 EPUB 恒带 `format`、TXT 恒不带，所以读面只需认这一个值。 */
export function isEpubMeta(meta: LocalMeta): meta is LocalEpubMeta {
  return (meta as { format?: unknown }).format === 'epub'
}

/** 未知版本：版本号或 format 不认识。与「书不存在」分列——这不是 404，是读到了不认识的存储形状。 */
export class LocalMetaVersionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

/** 已知版本的形状坏了（缺必填格 / 顶层不是对象）：同样按存储自损上报，不折成「没有这本书」。 */
export class LocalMetaFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

/**
 * 磁盘元数据 → 当前内存形状（唯一读口，`LocalBooks` 的 meta 读取只走这里）。
 *
 * 版本分流只看原始形状、**先于**格式分流：认不出的版本必须当场具名拒绝，静默把它当 TXT
 * 就等于拿偏移表去读一份文档索引（存量书全部打不开，且报错离原因很远）。
 */
export function decodeLocalMeta(raw: unknown, bookKey: string): LocalMeta {
  const stored = recordOf(raw)
  if (stored === null) {
    throw new LocalMetaFormatError(`本地书元数据结构不可识别（顶层不是对象）: ${bookKey}`)
  }
  const version = stored.schemaVersion
  if (version === undefined) return textMetaOf(stored, bookKey)
  if (version !== LOCAL_META_SCHEMA_VERSION) {
    throw new LocalMetaVersionError(
      `本地书元数据版本不认识: ${describe(version)}（本版本认识：无版本号的 TXT、${LOCAL_META_SCHEMA_VERSION} 的 EPUB）: ${bookKey}`,
    )
  }
  if (stored.format !== 'epub') {
    throw new LocalMetaVersionError(
      `本地书元数据版本 ${LOCAL_META_SCHEMA_VERSION} 的 format 不认识: ${describe(stored.format)}: ${bookKey}`,
    )
  }
  return epubMetaOf(stored, bookKey)
}

/**
 * 旧 TXT 形状即当前内存形状：逐格验形只为把「读不了」提前到解码处说清，别让它变成
 * 后面某次 `.map` 上的 TypeError——两种都落 500，但后者看不出是哪个字段坏了。
 * 有 `format` 却无版本号的形态不认识：它可能是丢了版本号的新形状，不能按偏移表读。
 */
function textMetaOf(stored: Record<string, unknown>, bookKey: string): LocalTextMeta {
  if (stored.format !== undefined) {
    throw new LocalMetaFormatError(
      `本地书元数据声明了 format=${describe(stored.format)} 但缺 schemaVersion，不能按 TXT 读: ${bookKey}`,
    )
  }
  if (typeof stored.title !== 'string' || typeof stored.originalName !== 'string'
    || typeof stored.importedAt !== 'number' || typeof stored.encoding !== 'string'
    || typeof stored.length !== 'number' || !isUnknownArray(stored.chapters)) {
    throw new LocalMetaFormatError(`本地书 TXT 元数据缺必填格: ${bookKey}`)
  }
  return {
    title: stored.title,
    originalName: stored.originalName,
    importedAt: stored.importedAt,
    encoding: stored.encoding,
    chapters: stored.chapters as ChapterSpan[],
    length: stored.length,
  }
}

/**
 * EPUB v2 → 内存形状。两处历史落盘形态在这里归一：
 * - 告警：有事实清单就按当下口径重排（`warningListOf`），没有就用旧读面写下的投影——
 *   两者都不会静默变成「没有痕」。投影不回写盘：读面已经拿到同一份事实，回写只多一次整份重写。
 * - 文档索引/序列/导航的形状归导入层，这里只验容器在不在（形状主人不在这层）。
 */
function epubMetaOf(stored: Record<string, unknown>, bookKey: string): LocalEpubMeta {
  const author = stored.author
  if (typeof stored.title !== 'string' || typeof stored.originalName !== 'string'
    || typeof stored.importedAt !== 'number' || (author !== null && typeof author !== 'string')
    || !isUnknownArray(stored.chapters) || recordOf(stored.documents) === null
    || recordOf(stored.resources) === null || !isUnknownArray(stored.navigation)) {
    throw new LocalMetaFormatError(`本地书 EPUB 元数据缺必填格: ${bookKey}`)
  }
  if (stored.findings !== undefined && !isUnknownArray(stored.findings)) {
    throw new LocalMetaFormatError(`本地书 EPUB 元数据的 findings 不是数组: ${bookKey}`)
  }
  if (stored.warnings !== undefined && !isUnknownArray(stored.warnings)) {
    throw new LocalMetaFormatError(`本地书 EPUB 元数据的 warnings 不是数组: ${bookKey}`)
  }
  const findings = stored.findings as FindingEntry[] | undefined
  const legacy = stored.warnings as LocalImportWarning[] | undefined
  return {
    format: 'epub',
    title: stored.title,
    author,
    originalName: stored.originalName,
    importedAt: stored.importedAt,
    chapters: stored.chapters as EpubChapterRef[],
    documents: recordOf(stored.documents) as Record<string, EpubDocumentRef>,
    resources: recordOf(stored.resources) as Record<string, EpubResourceRef>,
    navigation: stored.navigation as NavigationItem[],
    // 事实清单赢过投影：投影是同一份事实的旧读面写法；两者都缺 = 干净书（不是损坏）
    warnings: findings === undefined ? (legacy ?? []) : warningListOf(findings),
  }
}

/** JSON.parse 的产物按对象读：`typeof === 'object'` 不够，数组与 null 也要排除。 */
function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

/** `Array.isArray` 在 lib 里只收窄成 `any[]`；换成 `unknown[]` 的类型谓词，边界判形只做一次。 */
function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value)
}

/** 错误信息里的版本读数：字符串加引号、其余原样（`undefined` 与数字要一眼分开）。 */
function describe(value: unknown): string {
  return typeof value === 'string' ? JSON.stringify(value) : String(value)
}
