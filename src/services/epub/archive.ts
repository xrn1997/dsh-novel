import type { Readable } from 'node:stream'
import * as rawBufferCrc32 from 'buffer-crc32'
import { fromBuffer, type Entry, type ZipFile } from 'yauzl'
import { EpubImportError } from './errors.js'

/** 本层只用增量累计这一个方法，不必把上游那份声明拖进来 */
type Crc32 = { readonly unsigned: (buffer: Buffer, partial?: number) => number }

/**
 * buffer-crc32@1.0.0 的两副面孔（上游打包缺陷，不是本仓偏好）：声明（dist/index.d.mts）写的是 `export =`，
 * 运行时（dist/index.mjs）只导出 `default`。两种「干净」写法实测都不通：
 * `import crc32 from 'buffer-crc32'` 在 skipLibCheck 下被 .d.mts 判成「模块没有 default 导出」（TS1192，
 * typecheck 红）；`import { unsigned as x } from 'buffer-crc32'` 类型上过得去，但运行时拿不到东西
 * （解析到只导出 default 的 ESM 入口，一读条目就炸）。
 * 所以取 default、取不到退回 namespace：两条解析路径（ESM 入口 / 内联 CJS）下 default 都指同一个函数对象，
 * 这里是本文件唯一为上游缺陷让路的地方。
 */
const crc32 = ((rawBufferCrc32 as unknown as { default?: Crc32 }).default ?? (rawBufferCrc32 as unknown as Crc32))

/**
 * 增量 CRC32（`unsigned` 的取值口径：partial 传上一次的返回值）。
 *
 * 为什么要对外露这一行：正文层核 PNG chunk 的 CRC 也要算同一件事（「不信元数据」在归档层是
 * 条目 CRC，在图片层是 chunk CRC）。那一层再抄一份上游缺陷的让路代码就会长出第二个让路点，
 * 所以让路只留在本文件，别的层从这里取。
 */
export function crc32Unsigned(buffer: Buffer, partial = 0): number {
  return crc32.unsigned(buffer, partial)
}

/**
 * EPUB 归档层的**安全边界**：把一份上传上来的 ZIP 变成一个「条目可信、读取受限」的句柄。
 *
 * 为什么自己写这一层，而不是拿现成解压器直接读：EPUB 是**不受信输入**——上传的是用户给的字节，
 * 里面的路径可以指向书外（zip-slip）、条目可以是符号链接/加密/异种压缩、压缩数据可以声称 1 KiB
 * 却解出 4 GiB（zip bomb）。这些不是「解析失败」，是安全边界，必须在**解压任何字节之前**判掉：
 * 只判用到的条目就等于允许恶意条目藏在书里蒙混过关。
 *
 * 三条口径（改动这一层时先读它们）：
 * ① **条目名/重名/加密/压缩方式全表预检**（扫中央目录时逐条判），合法条目才登记；**未用到的条目不解压**
 *    （预算也不是靠解压未用条目算出来的——那本身就是攻击面）；
 * ② **限量按实际字节数**：声明大小只作展示，所有预算都在流中按真实产出的字节累加，并另外累计 CRC32
 *    与中央目录比对——不信元数据是这一层的全部意义；
 * ③ **任何读取失败都关归档**：读失败意味着后面所有读取都建立在一份不可信的映射上，继续读没有意义；
 *    关闭是幂等的（调用方的 finally 里会再关一次）。
 */

/** 一条已通过安全门的 ZIP 条目（中央目录视角） */
export interface EpubArchiveEntry {
  /** 归一化后的书内逻辑名：正斜杠分隔、无 `.`/空段、不以斜杠开头 */
  readonly name: string
  /** 中央目录**声称**的解压大小——只作展示/预筛，一切限量按流中实际字节算 */
  readonly size: number
}

/**
 * EPUB 解析的资源上限（**唯一主人**）：新增一类预算就加进本对象，别在别的模块另立一份常量——
 * 分散的「安全上限」总会在某次改动里只改一半，而一半的预算等于没有预算。
 *
 * 归档层用得上的是前三项；XML 单文档的三项（字节、深度、结构节点数）由 XML 层（`xml.ts`，
 * 包层与正文层的文档解析共用它）消费，图片像素由正文层（`resources.ts`）消费——**一个对象一个主人**：
 * 各层都用这里同名的那一项，谁都不在自己模块里另立一份常量（分散的「安全上限」总会在某次改动里
 * 只改一半，而一半的预算等于没有预算）。
 *
 * 为什么「深度/节点数」是独立于字节的预算：字节上限管不住**结构炸弹**——约一万层嵌套（108 KB，
 * 远低于 8 MiB）就足以让无预算的递归走法吃穿调用栈抛 `RangeError`。
 */
export interface EpubLimits {
  /** 中央目录条目数上限 */
  entries: number
  /** 单条目**实际**解压字节上限 */
  entryBytes: number
  /** 本归档累计**实际**解压字节上限（重复读也累加） */
  totalBytes: number
  /** 单份 XML/XHTML/SVG 文档的解压上限（container/OPF/NCX/nav 与正文文档共用） */
  xmlBytes: number
  /** 单份 XML/XHTML/SVG 文档的元素嵌套深度上限 */
  xmlDepth: number
  /** 单份 XML/XHTML/SVG 文档的结构节点（元素与 CDATA 容器）数上限 */
  xmlNodes: number
  /** 单张图片的像素数上限（宽 × 高；正文层消费） */
  imagePixels: number
}

export const DEFAULT_EPUB_LIMITS: EpubLimits = {
  entries: 10_000,
  entryBytes: 32 * 1024 * 1024,
  totalBytes: 512 * 1024 * 1024,
  xmlBytes: 8 * 1024 * 1024,
  xmlDepth: 128,
  xmlNodes: 200_000,
  imagePixels: 40_000_000,
}

/**
 * 打开一份 EPUB 归档。条目名/重名/加密/压缩方式在**打开阶段**判完：抛出即没有句柄，
 * 调用方也就不可能从坏归档里读到任何东西。
 *
 * limits 是覆盖式的：测试按需缩小某一项预算（也不必为了测上限去造 32 MiB 真字节）。
 *
 * 为什么这里只转发一行：构造器私有（外部能自己拼 `byName`/`budget` 就等于绕过全部门禁），而私有
 * 构造器只有类自己能调，所以构造实装只能落在类上的静态工厂；入口名留在这里，调用方按层名找人即可。
 */
export function openEpubArchive(bytes: Buffer, limits?: Partial<EpubLimits>): Promise<EpubArchive> {
  return EpubArchive.open(bytes, limits)
}

/**
 * 已通过安全门的归档句柄。**读一条、计量一条**：预算在这里按流中实际字节累加，
 * CRC 也在这里与中央目录比对——open 阶段判结构，read 阶段判内容。
 *
 * 构造器私有是这一层的一部分：句柄只能由静态工厂在扫完中央目录之后造出来，外部没法自己拼一份
 * 「名字 → 条目」的映射绕过上面的门（那会让整层形同虚设）。
 */
export class EpubArchive {
  /** 条目表（中央目录顺序）；调用方按逻辑名查找，拿不到 ZIP 路径 */
  readonly entries: readonly EpubArchiveEntry[]

  private readonly zip: ZipFile
  private readonly byName: ReadonlyMap<string, Entry>
  private readonly budget: EpubLimits
  private usedBytes = 0
  private closed = false

  private constructor(zip: ZipFile, byName: ReadonlyMap<string, Entry>, entries: readonly EpubArchiveEntry[], budget: EpubLimits) {
    this.zip = zip
    this.byName = byName
    this.entries = entries
    this.budget = budget
  }

  /** 唯一的构造路径：打开归档、扫中央目录逐条过安全门，全绿才交出句柄 */
  static open(bytes: Buffer, limits?: Partial<EpubLimits>): Promise<EpubArchive> {
    const budget: EpubLimits = { ...DEFAULT_EPUB_LIMITS, ...limits }
    return new Promise((resolve, reject) => {
      fromBuffer(
        bytes,
        // strictFileNames：不让库把 `\` 悄悄折成 `/`——折了，反斜杠名字在 Windows 上就是另一棵目录树，
        //   而 `OEBPS\ch1.xhtml` 还会与真的 `OEBPS/ch1.xhtml` 归一成同一个名字（歧义落进条目表）。
        //   注意：无条件拒反斜杠/绝对路径/`..` 段的是 yauzl 的 validateFileName，与这个开关无关。
        // validateEntrySizes：库的长度核对与我们在流中的 CRC 累计互补（库管长度、我们管内容）。
        { lazyEntries: true, strictFileNames: true, validateEntrySizes: true },
        (err, zip) => {
          if (err) {
            reject(new EpubImportError(`EPUB 不是可读的 ZIP 归档：${err.message}`))
            return
          }
          EpubArchive.scan(zip, budget).then(resolve, reject)
        },
      )
    })
  }

  /** 扫中央目录逐条过安全门，全绿才交出句柄（延迟解压：这里一个字节都不解） */
  private static scan(zip: ZipFile, budget: EpubLimits): Promise<EpubArchive> {
    return new Promise((resolve, reject) => {
      const byName = new Map<string, Entry>()
      const table: EpubArchiveEntry[] = []
      let settled = false
      const fail = (cause: unknown): void => {
        if (settled) return
        settled = true
        zip.close()
        reject(wrapError(cause, 'EPUB 归档中央目录不可信'))
      }
      zip.on('error', fail)
      zip.on('entry', (entry: Entry) => {
        try {
          if (table.length >= budget.entries) {
            throw new EpubImportError(`EPUB 条目数超过上限 ${budget.entries}（第 ${table.length + 1} 条：${entry.fileName}）`)
          }
          const name = normalizeEntryPath(entry.fileName)
          if (byName.has(name)) throw new EpubImportError(`EPUB 归档内有重名条目：${name}`)
          checkEntryKind(entry, name)
          byName.set(name, entry)
          table.push({ name, size: entry.uncompressedSize })
        } catch (e) {
          fail(e)
          return
        }
        zip.readEntry()
      })
      zip.on('end', () => {
        if (settled) return
        settled = true
        resolve(new EpubArchive(zip, byName, table, budget))
      })
      zip.readEntry()
    })
  }

  /**
   * 读一个条目的完整内容。
   *
   * maxBytes 是**本次读取**的类别上限（例如 XML/XHTML 比图片小得多），与单条目预算取小者：
   * 单条目预算是归档层的硬上限，任何调用方都不能把它放宽。
   */
  async read(name: string, maxBytes?: number): Promise<Buffer> {
    if (this.closed) throw new EpubImportError(`EPUB 归档已关闭，无法读取 ${name}`)
    const key = normalizeEntryPath(name)
    const entry = this.byName.get(key)
    if (entry === undefined) throw new EpubImportError(`EPUB 归档中没有条目：${name}`)
    const cap = Math.min(this.budget.entryBytes, maxBytes ?? this.budget.entryBytes)

    let stream: Readable
    try {
      stream = await this.openStream(entry, key)
    } catch (e) {
      // 连流都开不出来（本地头损坏等）也是「读取失败」，同样关归档——口径③不分失败发生在哪一步
      this.abort()
      throw e
    }
    const chunks: Buffer[] = []
    let actual = 0
    let runningCrc = 0
    try {
      for await (const chunk of stream) {
        const buf = chunk as Buffer
        actual += buf.length
        this.usedBytes += buf.length
        if (actual > cap) {
          throw new EpubImportError(`EPUB 条目 ${key} 实际解压超过上限 ${cap} 字节`)
        }
        if (this.usedBytes > this.budget.totalBytes) {
          throw new EpubImportError(`EPUB 累计解压超过上限 ${this.budget.totalBytes} 字节（本条：${key}）`)
        }
        runningCrc = crc32.unsigned(buf, runningCrc)
        chunks.push(buf)
      }
    } catch (e) {
      stream.destroy()
      this.abort()
      throw wrapError(e, `EPUB 条目 ${key} 读取失败`)
    }

    if ((runningCrc >>> 0) !== (entry.crc32 >>> 0)) {
      this.abort()
      throw new EpubImportError(`EPUB 条目 ${key} CRC 校验失败：中央目录 ${entry.crc32 >>> 0}，实际 ${runningCrc >>> 0}`)
    }
    return Buffer.concat(chunks, actual)
  }

  /** 幂等关闭：失败路径与调用方 finally 都会关，重复关不该炸 */
  close(): void {
    this.abort()
  }

  /** 读失败即关（见文件头口径③） */
  private abort(): void {
    this.closed = true
    this.zip.close()
  }

  private openStream(entry: Entry, key: string): Promise<Readable> {
    return new Promise((resolve, reject) => {
      this.zip.openReadStream(entry, (err, stream) => {
        if (err) reject(wrapError(err, `EPUB 条目 ${key} 无法解压`))
        else resolve(stream)
      })
    })
  }
}

/** 加密 / 压缩方式 / 符号链接：决定这个条目是否可信，与「用不用它」无关，所以逐条都判 */
function checkEntryKind(entry: Entry, name: string): void {
  if (entry.isEncrypted()) {
    throw new EpubImportError(`EPUB 条目被 ZIP 加密（本插件不提供解密）：${name}`)
  }
  if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
    throw new EpubImportError(`EPUB 条目用了不支持的压缩方式 ${entry.compressionMethod}（只接受 store/deflate）：${name}`)
  }
  // 只有 Unix 宿主（versionMadeBy 高字节 3）的外部属性才按 unix 模式位解释：同一段 bit 在 DOS
  // 属性里是只读/隐藏等标志，混读会把普通文件误判成符号链接，而符号链接能把读取引到书外。
  const mode = entry.externalFileAttributes >>> 16
  if ((entry.versionMadeBy >>> 8) === 3 && (mode & 0xf000) === 0xa000) {
    throw new EpubImportError(`EPUB 条目是符号链接（可能指向书外）：${name}`)
  }
}

/**
 * ZIP 条目名 → 书内逻辑名，或抛错。**这道门只管 ZIP 条目名，不管 EPUB href**：
 * 正文里的 `../Images/x.png` 是 href，按文档目录归一、只要不出书根就合法（那是 `resolveEpubHref`
 * 的事）；ZIP 条目名没有「相对某个文档」的语境，越出归档根就是攻击。两者不能互相套用规则：
 * 拿 href 的合法性去放行条目名，或者拿条目名的严格去拒绝 href，都是错的。
 *
 * 归一（`. 段` / 空段 / 栈内 `..`）是为了让「同一逻辑名的两种写法」显形——重名判定必须落在
 * 归一后的名字上，否则 `OEBPS/ch1.xhtml` 与 `OEBPS/./ch1.xhtml` 就是两条互不冲突的条目。
 */
function normalizeEntryPath(raw: string): string {
  // NUL 会截断下游一切把名字当 C 字符串/路径段的地方。yauzl 的 validateFileName 不校验 NUL，
  // 所以这条是**只有本层拦得住**的判据之一。
  if (raw.includes('\0')) throw new EpubImportError(`EPUB 条目名含 NUL：${JSON.stringify(raw)}`)
  // 下面三条（反斜杠 / 绝对路径 / 盘符）与再下面的 `..`：这四种形态在**条目名**上其实由依赖先拦——
  // yauzl 的 validateFileName 无条件拒含反斜杠、绝对路径与任一 `..` 段的名字，与 strictFileNames 无关。
  // 本层保留同名判据是**纵深防御**（换依赖、或那道门被绕过时不至于裸奔），不是唯一防线；
  // 只有本层拦得住的两类是本条 NUL 与末尾的「归一后为空」。
  if (raw.includes('\\')) throw new EpubImportError(`EPUB 条目名含反斜杠：${raw}`)
  if (raw.startsWith('/')) throw new EpubImportError(`EPUB 条目名是绝对路径：${raw}`)
  if (/^[A-Za-z]:/.test(raw)) throw new EpubImportError(`EPUB 条目名含盘符：${raw}`)
  const out: string[] = []
  for (const segment of raw.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      // 条目名走不到这里（含 `..` 段的名字被 yauzl 先拒）；这条折叠分支活在查找侧：调用方给出的
      // `OEBPS/sub/../ch1.xhtml` 折叠成 OEBPS/ch1.xhtml；栈里已经空了的 `..` 才是越界。
      if (out.length === 0) throw new EpubImportError(`EPUB 条目名越出归档根：${raw}`)
      out.pop()
      continue
    }
    out.push(segment)
  }
  // 归一后什么都剩不下（名字是 `.`、`./`、`//` 这类）：yauzl 也不拦（它只拒 `..` 段），本层独占
  if (out.length === 0) throw new EpubImportError(`EPUB 条目名归一后为空：${JSON.stringify(raw)}`)
  return out.join('/')
}

/** 非本层的异常（库/流/系统）也要披上本层的类并点名条目：否则调用方只能靠文案猜分类 */
function wrapError(cause: unknown, what: string): EpubImportError {
  if (cause instanceof EpubImportError) return cause
  return new EpubImportError(`${what}：${cause instanceof Error ? cause.message : String(cause)}`)
}
