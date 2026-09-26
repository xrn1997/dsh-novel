import { strToU8, zipSync, type Zippable } from 'fflate'

/**
 * 合成 EPUB（ZIP）fixture 的**唯一表**：`epub2-basic` / `epub3-rich` 这类「内容样本」由包层与正文层的
 * 任务在**同一张表**里追加，未知名字一律抛错——表是封闭的，测试不能凭空造名字，也不能有内容尚不成立
 * 的预留条目（登记了却造不出来，等于给后来者留一个必炸的名字）。
 *
 * 本表两条不可让渡的口径：
 * ① **写与读不同实现**：这里用 fflate 写 ZIP，生产读取器走 yauzl——用被验方的库造样本，
 *    「读得回来」只证明那个库自洽；
 * ② **异常样本由小范围字节修改制造**：在**有效** fixture 的中央目录上改若干字节（每条样本的注释
 *    写明改的是哪个字段），而不是手搓整份 ZIP——手搓的字节布局一旦错了，测的就是 fixture 作者的笔误
 *    而不是解析器。
 *
 * mimetype 由 zipOf 强制放首项、store 方式（EPUB OCF 的硬要求：首项未压缩，读端不必解压就能嗅探），
 * 其余条目 deflate；调用方只列自己的条目，不重复声明 mimetype。
 */

/** EPUB OCF 的 mimetype 条目名与取值（首项、store） */
const MIMETYPE = 'mimetype'
const MIMETYPE_VALUE = 'application/epub+zip'

/** 签名与固定偏移：改字节一律按名字查表算偏移，不盲扫字节（名字字节恰好像别的字段就会误伤） */
const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
/** 中央目录记录内的字段偏移（ZIP APPNOTE 的记录布局，从记录起点算） */
const FIELD = {
  versionMadeBy: 4, flags: 8, method: 10, crc: 16, compressedSize: 20, size: 24,
  externalAttributes: 38, localHeaderOffset: 42, name: 46,
} as const
/** 本地文件头里文件名的起点（签名 4 + 版本 2 + 标志 2 + 方式 2 + 时间 2 + 日期 2 + CRC 4 + 两个大小 8 + 名称长度 2 + 扩展长度 2） */
const LOCAL_NAME_OFFSET = 30

const CONTAINER_XML = '<?xml version="1.0" encoding="UTF-8"?>\n'
  + '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">'
  + '<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>'
  + '</container>'

const CONTENT_OPF = '<?xml version="1.0" encoding="UTF-8"?>\n'
  + '<package version="3.0" xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid">'
  + '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>样本</dc:title><dc:creator>作者</dc:creator></metadata>'
  + '<manifest><item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/></manifest>'
  + '<spine><itemref idref="ch1"/></spine></package>'

function chapterXml(n: number): string {
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>第' + n + '章</title></head>'
    + '<body><h1>第' + n + '章</h1><p>第' + n + '章的正文。</p></body></html>'
}

/** 大条目内容：3 字节/字的文本，配合缩小的预算触发单条/累计上限 */
const BIG_TEXT = '正文'.repeat(2048)
const HALF_TEXT = '半'.repeat(1000)

/**
 * 写一份 ZIP：mimetype 首项且 store，其余 deflate。条目顺序即对象字面量顺序，
 * 也是中央目录顺序——「首项」这件事在这里被钉住，而不是靠调用方自觉。
 *
 * 条目体可以是字符串（UTF-8）或现成字节：编码样本（UTF-16 BOM、latin-1、非法 UTF-8）必须绕过
 * `strToU8` 写出真字节，否则测的是「写的时候就已经是 UTF-8」，编码那条判据永远不被触发。
 */
function zipOf(files: ReadonlyArray<readonly [string, string | Buffer]>, opts: { mimetype?: boolean } = {}): Buffer {
  const data: Zippable = {}
  if (opts.mimetype !== false) data[MIMETYPE] = [strToU8(MIMETYPE_VALUE), { level: 0 }]
  for (const [name, body] of files) data[name] = [typeof body === 'string' ? strToU8(body) : body, { level: 6 }]
  return Buffer.from(zipSync(data))
}

/** 基线条目：一份「结构像 EPUB」的有效归档，异常样本都在它上面只改一处 */
function baselineEntries(): Array<[string, string]> {
  return [
    ['META-INF/container.xml', CONTAINER_XML],
    ['OEBPS/content.opf', CONTENT_OPF],
    ['OEBPS/ch1.xhtml', chapterXml(1)],
  ]
}

function baseline(): Buffer {
  return zipOf(baselineEntries())
}

/** 只为凑条目数的 filler：内容是最小的合法 XHTML 片段，不参与任何规则求值 */
function fillerEntries(count: number): Array<[string, string]> {
  return Array.from({ length: count }, (_, i) => [`OEBPS/filler/${String(i)}.xhtml`, '<x>'] as [string, string])
}

function u32le(value: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(value >>> 0, 0)
  return b
}

/** 中央目录一条记录的定位结果：改字节时只认这里的偏移 */
interface CentralRecord {
  readonly name: string
  readonly offset: number
  readonly nameOffset: number
  readonly localHeaderOffset: number
}

/** 读 EOCD 再顺序走中央目录，把每条记录的名字与关键字段偏移定位出来 */
function centralRecords(buf: Buffer): CentralRecord[] {
  const eocd = buf.lastIndexOf(u32le(EOCD_SIGNATURE))
  if (eocd < 0) throw new Error('fixture 不是 ZIP：找不到 EOCD')
  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  const out: CentralRecord[] = []
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== CENTRAL_SIGNATURE) throw new Error(`fixture 的中央目录第 ${i} 条签名不对`)
    const nameOffset = p + FIELD.name
    const nameLength = buf.readUInt16LE(p + 28)
    out.push({
      name: buf.toString('latin1', nameOffset, nameOffset + nameLength),
      offset: p,
      nameOffset,
      localHeaderOffset: buf.readUInt32LE(p + FIELD.localHeaderOffset),
    })
    p = nameOffset + nameLength + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32)
  }
  return out
}

function recordOf(buf: Buffer, name: string): CentralRecord {
  const hit = centralRecords(buf).find((r) => r.name === name)
  if (!hit) throw new Error(`fixture 的中央目录里没有条目 ${name}`)
  return hit
}

/** 破坏中央目录 偏移 16 的 CRC32 字段：内容没坏但校验值对不上——读端必须报 CRC，不许把坏数据当正文 */
function breakCrc(buf: Buffer, name: string): Buffer {
  const r = recordOf(buf, name)
  buf.writeUInt32LE((buf.readUInt32LE(r.offset + FIELD.crc) ^ 0xffffffff) >>> 0, r.offset + FIELD.crc)
  return buf
}

/** 破坏中央目录 偏移 24 声明的解压大小（+1 字节）：长度核对对不上，必须报错而不是把短内容当全内容 */
function breakDeclaredSize(buf: Buffer, name: string): Buffer {
  const r = recordOf(buf, name)
  buf.writeUInt32LE(buf.readUInt32LE(r.offset + FIELD.size) + 1, r.offset + FIELD.size)
  return buf
}

/** 置中央目录 偏移 8 的通用标志 bit0（ZIP 加密位）：条目还在，但本插件不提供解密 */
function markEncrypted(buf: Buffer, name: string): Buffer {
  const r = recordOf(buf, name)
  buf.writeUInt16LE(buf.readUInt16LE(r.offset + FIELD.flags) | 0x1, r.offset + FIELD.flags)
  return buf
}

/** 改中央目录 偏移 10 的压缩方式：只接受 store(0)/deflate(8)，别的当场拒绝 */
function markMethod(buf: Buffer, name: string, method: number): Buffer {
  const r = recordOf(buf, name)
  buf.writeUInt16LE(method, r.offset + FIELD.method)
  return buf
}

/** 造一个符号链接条目：中央目录 偏移 4 的宿主字节改成 unix(3)、偏移 38 的外部属性模式位改 0xA1FF
 *  （S_IFLNK | 0777）——ZIP 只用这一对字段表示符号链接，读端不按 unix 模式解释就会漏掉它 */
function markSymlink(buf: Buffer, name: string): Buffer {
  const r = recordOf(buf, name)
  buf.writeUInt16LE((3 << 8) | (buf.readUInt16LE(r.offset + FIELD.versionMadeBy) & 0xff), r.offset + FIELD.versionMadeBy)
  buf.writeUInt32LE(0xa1ff0000, r.offset + FIELD.externalAttributes)
  return buf
}

/** 就地改条目名（中央目录 46 起 + 本地头 30 起两处都改，否则两处的名字自相矛盾）。
 *  长度必须一致：名字长度进的是定长字段，改了长度整份 ZIP 的偏移全变 */
function renameEntry(buf: Buffer, from: string, to: string): Buffer {
  if (from.length !== to.length) throw new Error('fixture 改名必须等长')
  const r = recordOf(buf, from)
  buf.write(to, r.nameOffset, 'latin1')
  buf.write(to, r.localHeaderOffset + LOCAL_NAME_OFFSET, 'latin1')
  return buf
}

/** 改中央目录记的本地头起点处那 4 字节签名（偏移 0）：中央目录本身没坏，坏处只在**读到那一条**时暴露 */
function breakLocalHeaderSignature(buf: Buffer, name: string): Buffer {
  const r = recordOf(buf, name)
  buf.writeUInt32LE(0xdeadbeef, r.localHeaderOffset)
  return buf
}

/** 砍掉末尾的 EOCD（22 字节、无归档注释）：归档再也定位不到中央目录 */
function cutEndOfCentralDirectory(buf: Buffer): Buffer {
  return buf.subarray(0, buf.length - 22)
}

// ── 包层样本（包结构、阅读顺序与导航目标）──────────────────────────────
// 这些样本的异常点在 **XML 内容**里（缺 idref、坏导航、实体声明、编码声明…），不在 ZIP 字节里，
// 所以用模板拼 OPF/导航再写进正常归档——与上面「改中央目录若干字节」的手法各自对应一类缺陷。

const OPF_MEDIA_TYPE = 'application/oebps-package+xml'
const NCX_MEDIA_TYPE = 'application/x-dtbncx+xml'
const XHTML_MEDIA_TYPE = 'application/xhtml+xml'

/** 标准 XHTML 外部 DOCTYPE：无内部子集，解析器必须**忽略**它继续（不 resolve、不请求远端 DTD） */
const XHTML_DOCTYPE = '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">'

/** 2×3 RGBA 纯色 PNG（74 字节，四个 chunk 的 CRC 逐项核对过）：封面样本要真能被读图库解出宽高 */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAYAAAC56t6BAAAAEUlEQVR4nGP4b5z2H4QZMBgA0UkPixOR9RgAAAAASUVORK5CYII=',
  'base64',
)

/** 同上但砍掉末尾 12 字节（IEND 整块）：头部声明得出宽高，容器却没收尾——「损坏图片」的最小样本。
 *  为什么这一刀算损坏：读图库只读文件头，仅凭它「读得出宽高」不等于浏览器解得出这张图。 */
const TRUNCATED_PNG = TINY_PNG.subarray(0, TINY_PNG.length - 12)

/** 1×1 GIF89a（43 字节，末尾 0x3B 是 trailer）：四个受支持光栅格式之一 */
const TINY_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')

/** CRC-32（IEEE，PNG/ZIP 同款，逐位算不用查表）：**本文件自算**，不借生产读端的
 *  `crc32Unsigned`——下面两份样本要证明的正是「结构项逐条过关」，与校验器共用同一份实现
 *  会让那句话只证明那一份实现自洽（同文件头注 ① 的写读分离口径）。 */
function crc32(bytes: Buffer): number {
  let c = 0xffffffff
  for (const b of bytes) {
    c ^= b
    for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
  }
  return (c ^ 0xffffffff) >>> 0
}

/** 重组一份 PNG：签名 + 给定 chunk 序列，每个 chunk 的 CRC 现算（长度字段与 CRC 因此必然自洽） */
function pngOfChunks(parts: ReadonlyArray<readonly [string, Buffer]>): Buffer {
  const chunks = parts.map(([type, payload]) => {
    const head = Buffer.alloc(8)
    head.writeUInt32BE(payload.length, 0)
    head.write(type, 4, 'latin1')
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), payload])), 0)
    return Buffer.concat([head, payload, crc])
  })
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ...chunks])
}

/** 取 PNG 里第一个指定类型 chunk 的载荷（样本只由 TINY_PNG 的 chunk 重排而成，够用） */
function pngPayloadOf(buf: Buffer, type: string): Buffer {
  let p = 8
  while (p + 12 <= buf.length) {
    const length = buf.readUInt32BE(p)
    if (buf.toString('latin1', p + 4, p + 8) === type) return buf.subarray(p + 8, p + 8 + length)
    p += 12 + length
  }
  throw new Error(`fixture 内部错误：TINY_PNG 里没有 ${type} chunk`)
}

/** 2×3 PNG，**结构逐项自洽**（签名、IHDR、IDAT、IEND 齐备，三个 CRC 全对）但 IHDR 的位深字段写成 3：
 *  RGBA（色型 6）只许 8/16，任何合规解码器都拒。这是「容器结构过关、字节却渲染不出来」的**最小样本**——
 *  本仓的图片校验只看容器结构（逐 chunk 核 CRC 到 IEND），它会照常放行；真解码归浏览器验收门。
 *  比「截断」更贴近真站上的坏图：被 CDN/分词工具重排过的字节常常长度自洽、语义全坏。 */
const PNG_INVALID_IHDR = (() => {
  const ihdr = Buffer.from(pngPayloadOf(TINY_PNG, 'IHDR'))
  ihdr[8] = 3                                                   // 位深
  return pngOfChunks([['IHDR', ihdr], ['IDAT', pngPayloadOf(TINY_PNG, 'IDAT')], ['IEND', Buffer.alloc(0)]])
})()

/** 1×1 GIF89a 的**帧数据与扩展尾巴都不存在**，末尾补一个 trailer 0x3B（头与尾都对、长度 33 > 14）：
 *  前 32 字节 = 头(6)+逻辑屏描述符(7)+全局色表(6)+图形控制扩展的前 6 字节（该扩展本应 8 字节，
 *  后面才是图像描述符与数据子块），**从扩展中段截断后直接封尾**。
 *  本仓的 GIF 核对只认魔数与末字节 0x3B（见 `services/epub/resources.ts` 的 verifyGif），所以它会被
 *  当可读资源放行。真解码的裁决在浏览器验收门（`tests/browser/epub-reader.test.ts`）：实测（2026-09
 *  无头 Edge）浏览器**拒绝**这一份——截在扩展中段是结构性坏，阅读器如实报加载失败且不塌预留框。
 *  这条钉子钉的正是这个差异：容器结构过关 ≠ 能渲染，两侧各管一段。 */
const GIF_DATA_LOST = Buffer.concat([TINY_GIF.subarray(0, 32), Buffer.from([0x3b])])

/** 最小 WebP（RIFF + 单个 VP8L chunk，3×2，25 字节）：VP8L 头里 14 位宽/14 位高按位打包 */
const TINY_WEBP = Buffer.concat([
  Buffer.from('RIFF', 'latin1'), buf32(17), Buffer.from('WEBP', 'latin1'),
  Buffer.from('VP8L', 'latin1'), buf32(5), Buffer.from([0x2f, 0x02, 0x40, 0x00, 0x00]),
])

function buf16(value: number): Buffer {
  const b = Buffer.alloc(2)
  b.writeUInt16LE(value, 0)
  return b
}

function buf32(value: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(value >>> 0, 0)
  return b
}

/** JPEG 是大端（TIFF 内部才看它自己的字节序声明）：段长/宽高都得按 BE 写 */
function be16(value: number): Buffer {
  const b = Buffer.alloc(2)
  b.writeUInt16BE(value, 0)
  return b
}

/**
 * 自造的最小 JPEG：SOI + EXIF APP1（可带 Orientation）+ SOF0 + SOS + 熵数据 + EOI。
 *
 * 为什么要自造而不是塞一份真实照片：EXIF 旋转这条判据**只有真的带 Orientation 标签**才触发，
 * 而「无旋转」的对照组又必须是同一套结构——手写段表才能让两张图只差一个字段。段长逐段写足，
 * 读图库（image-size）与资源层的容器核对都按 JPEG 的段规则读；熵数据只是占位字节，
 * 本插件不做像素解码（真解码归浏览器验收门）。
 */
function tinyJpeg(opts: { width: number; height: number; orientation: number }): Buffer {
  // TIFF 内部按它自己声明的字节序走：头是小端（`II`），所以 IFD 里的多字节字段也得小端写
  const tiff = Buffer.concat([
    Buffer.from('II', 'latin1'), buf16(42), buf32(8),                        // TIFF 头：小端 + IFD0 偏移 8
    buf16(1),                                                                // IFD0 条目数
    buf16(0x0112), buf16(3), buf32(1), buf16(opts.orientation), buf16(0),     // Orientation (SHORT×1)
    buf32(0),                                                                // 下一个 IFD 偏移 = 0
  ])
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1]), be16(2 + 6 + tiff.length), Buffer.from('Exif\0\0', 'latin1'), tiff])
  const sof0 = Buffer.concat([
    Buffer.from([0xff, 0xc0]), be16(17), Buffer.from([8]), be16(opts.height), be16(opts.width),
    Buffer.from([3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0]),
  ])
  const sos = Buffer.from([0xff, 0xda, 0x00, 0x0c, 3, 1, 0, 2, 0, 3, 0, 0x00, 0x3f, 0x00])
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, sof0, sos, Buffer.from([0x12, 0x34]), Buffer.from([0xff, 0xd9])])
}

/** 2×3、Orientation=6（顺时针 90°）的 JPEG：显示宽高必须折成 3×2 */
const TINY_JPEG_ROTATED = tinyJpeg({ width: 2, height: 3, orientation: 6 })

/** 同结构但 Orientation=1（无旋转）：对照组，显示宽高保持 2×3 */
const TINY_JPEG = tinyJpeg({ width: 2, height: 3, orientation: 1 })

function xhtmlOf(title: string, body: string): string {
  return '<?xml version="1.0" encoding="UTF-8"?>\n' + XHTML_DOCTYPE + '\n'
    + '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>' + title + '</title></head>'
    + '<body>' + body + '</body></html>'
}

function containerOf(rootfiles: ReadonlyArray<readonly [string, string]>): string {
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles>'
    + rootfiles.map(([path, type]) => '<rootfile full-path="' + path + '" media-type="' + type + '"/>').join('')
    + '</rootfiles></container>'
}

/** 正常容器：单 rootfile → OEBPS/content.opf */
const CONTAINER_OPF = containerOf([['OEBPS/content.opf', OPF_MEDIA_TYPE]])

/** OPF 模板：只描述差异（版本、编码声明、书名/作者、追加 meta、manifest、spine） */
function opfOf(spec: {
  version?: string
  decl?: string
  title?: string
  author?: string
  meta?: string
  manifest: string
  spine: string
  spineAttrs?: string
}): string {
  const meta = (spec.title === undefined ? '' : '<dc:title>' + spec.title + '</dc:title>')
    + (spec.author === undefined ? '' : '<dc:creator>' + spec.author + '</dc:creator>')
    + (spec.meta ?? '')
  return '<?xml version="1.0" encoding="' + (spec.decl ?? 'UTF-8') + '"?>\n'
    + '<package version="' + (spec.version ?? '3.0') + '" xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid">'
    + '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">' + meta + '</metadata>'
    + '<manifest>' + spec.manifest + '</manifest>'
    + '<spine' + (spec.spineAttrs ?? '') + '>' + spec.spine + '</spine>'
    + '</package>'
}

function itemXml(id: string, href: string, opts: { type?: string; attrs?: string } = {}): string {
  return '<item id="' + id + '" href="' + href + '" media-type="' + (opts.type ?? XHTML_MEDIA_TYPE) + '"' + (opts.attrs ?? '') + '/>'
}

function itemrefXml(idref: string, attrs = ''): string {
  return '<itemref idref="' + idref + '"' + attrs + '/>'
}

/** 正文锚点 a/b/c 现在就落在文档里：导航叶（ch1#a、ch1#b、ch2#c）与脚注目标必须真实可命中。
 *  这三份是**共用**的通用正文（包层与正文层的一堆样本都拿它当 ch1/ch2）：刻意不带任何跨文档链接与插图——
 *  引用别的不存在的文档会让那些样本在正文层导入时变成坏书，那是另一回事。 */
const CH1_BODY = '<h1>第一章</h1><p id="a">甲</p><p id="b">乙</p>'
const CH2_BODY = '<h1>第二章</h1><p id="c">丙</p>'
const NOTES_BODY = '<h1>注释</h1><p id="n1">脚注一</p>'

/** 「只包一张书内图」的内联 SVG：viewBox 与 image 尺寸都对上 TINY_PNG 的 2×3。
 *  SVG_COVER_PAGE_BODY 是它在真书里的样子——EPUB3 推荐的整页封面写法（一层 div 包着，
 *  真书取样自 Gutenberg #7337 图像版 `pg7337-images-3.epub`）。 */
const SVG_ONLY_IMAGE = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"'
  + ' width="100%" height="100%" viewBox="0 0 2 3" preserveAspectRatio="xMidYMid meet" version="1.1">'
  + '<image width="2" height="3" xlink:href="images/cover.png"/></svg>'

const SVG_COVER_PAGE_BODY = '<div class="cover">' + SVG_ONLY_IMAGE + '</div>'

/**
 * 图文基准（epub3-rich）专用的正文：一份「真书里会长什么样」的样本——
 * 粗斜体、列表编号、表格跨行跨列、pre/上下标/换行/分隔线、共享插图（含无 alt 的一张）、
 * 跨章链接、指向 linear="no" 补充文档的脚注引用，以及未知无害容器与结构容器。
 *
 * 实体只解一次也在这一份里钉住：`&amp;` → `&`，`&amp;amp;` → 字面 `&amp;`，`&#65;` → A。
 */
const RICH_CH1_BODY = '<h1 id="h1">第一章</h1>'
  // 粗斜体在导入期规范成 strong/em；br 是渲染上的硬断行（文字面据此断行，不按源码缩进断）
  + '<p id="a">甲 <b>粗</b> 与 <i>斜</i><br/>下一行</p>'
  + '<p id="b">实体 &amp; 与 &amp;amp; 与 &#65;</p>'
  + '<ol start="3"><li value="7">第七项</li><li>第八项</li></ol>'
  + '<table><tr><th rowspan="2">竖跨</th><td colspan="2">横跨</td></tr><tr><td>右</td><td>下</td></tr></table>'
  + '<pre>pre 里  的空白\n  原样保留</pre>'
  + '<p>上标 x<sup>2</sup> 与下标 H<sub>2</sub>O</p>'
  + '<blockquote>引用一段</blockquote><hr/>'
  // 同一张图两章各引一次（共享资源）；第二张没有 alt（alt 为空串，投影成「[图片]」）
  + '<p><img src="cover.png" alt="插图"/><img src="cover.png"/></p>'
  // 非线性脚注：引用在正文、目标在 linear="no" 的 notes.xhtml（跳转要跨文档）
  + '<p>脚注<a id="fnref1" href="notes.xhtml#n1" epub:type="noteref">1</a>与跨章<a href="ch2.xhtml#c">丙</a></p>'
  // 未知无害容器保留子内容；结构容器规范成 div（b 变成 strong）
  + '<div>未知容器 <u>下划线</u> 保留子内容</div><section>结构容器 <b>变粗</b></section>'
const RICH_CH2_BODY = '<h1>第二章</h1><p id="c">丙</p>'
  + '<p><img src="cover.png" alt="共用插图"/></p>'
  // 与 ch1 的「跨章」链接互为回指：主序列内部成环，靠已访问集合终止
  + '<p><a href="ch1.xhtml#b">回到乙</a></p>'
const RICH_NOTES_BODY = '<h1>注释</h1><p id="n1">脚注一</p>'
  // 反向链接（epub:type="backlink"）指回正文里的引用锚点：跨文档锚点必须真命中
  + '<p><a href="ch1.xhtml#fnref1" epub:type="backlink">返回正文</a></p>'

const TWO_CHAPTER_MANIFEST = itemXml('ch1', 'ch1.xhtml') + itemXml('ch2', 'ch2.xhtml')
const TWO_CHAPTER_SPINE = itemrefXml('ch1') + itemrefXml('ch2')

/** 常见三件套：容器 + OPF + 第一章；异常样本改其中一件或另加条目 */
function pkgEntries(opf: string | Buffer, extra: Array<[string, string | Buffer]> = []): Array<[string, string | Buffer]> {
  return [
    ['META-INF/container.xml', CONTAINER_OPF],
    ['OEBPS/content.opf', opf],
    ['OEBPS/ch1.xhtml', xhtmlOf('第一章', CH1_BODY)],
    ...extra,
  ]
}

/** 单章 OPF 骨架（无导航）：缺件、加密、混淆字体这几个样本共用它，免得各自再写一遍 manifest/spine */
const ONE_CHAPTER_OPF = opfOf({ title: '最小样本', manifest: itemXml('ch1', 'ch1.xhtml'), spine: itemrefXml('ch1') })

/** 图文基准样本的导航文档：一个卷组 + 三个叶（ch1#a / ch1#b / ch2#c）。
 *  landmarks 与 page-list **排在 toc 前面**：正文目录必须按 `epub:type` 认，不能「取第一个 nav」 */
const RICH_NAV = '<?xml version="1.0" encoding="UTF-8"?>\n' + XHTML_DOCTYPE + '\n'
  + '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目录</title></head><body>'
  + '<nav epub:type="landmarks"><ol><li><a epub:type="bodymatter" href="ch1.xhtml">正文</a></li></ol></nav>'
  + '<nav epub:type="page-list"><ol><li><a href="ch1.xhtml#a">1</a></li></ol></nav>'
  + '<nav epub:type="toc"><h1>目录</h1><ol><li><span>第一卷</span><ol>'
  + '<li><a href="ch1.xhtml#a">甲</a></li><li><a href="ch1.xhtml#b">乙</a></li><li><a href="ch2.xhtml#c">丙</a></li>'
  + '</ol></li></ol></nav>'
  + '</body></html>'

/** EPUB2 的 NCX：带标准外部 DOCTYPE；父 navPoint 自己也带目标（与 nav 的分组标题形态不同） */
const BASIC_NCX = '<?xml version="1.0" encoding="UTF-8"?>\n'
  + '<!DOCTYPE ncx PUBLIC "-//NISO//DTD ncx 2005-1//EN" "http://www.daisy.org/z3986/2005/ncx-2005-1.dtd">\n'
  + '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">'
  + '<head><meta name="dtb:uid" content="bookid"/></head><docTitle><text>NCX 样本</text></docTitle><navMap>'
  + '<navPoint id="n1" playOrder="1"><navLabel><text>上卷</text></navLabel><content src="ch1.xhtml#a"/>'
  + '<navPoint id="n1-1" playOrder="2"><navLabel><text>第一章</text></navLabel><content src="ch1.xhtml#b"/></navPoint>'
  + '</navPoint>'
  + '<navPoint id="n2" playOrder="3"><navLabel><text>第二章</text></navLabel><content src="ch2.xhtml"/></navPoint>'
  + '</navMap></ncx>'

/** 只含 landmarks / page-list 的「导航文档」：有 nav 属性声明却给不出正文目录 */
const BROKEN_NAV = '<?xml version="1.0" encoding="UTF-8"?>\n' + XHTML_DOCTYPE + '\n'
  + '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>指南</title></head><body>'
  + '<nav epub:type="landmarks"><ol><li><a epub:type="bodymatter" href="ch1.xhtml">正文</a></li></ol></nav>'
  + '<nav epub:type="page-list"><ol><li><a href="ch1.xhtml#a">1</a></li></ol></nav>'
  + '</body></html>'

/** `depth` 层 `<div>` 包住 `inner`：深度炸弹样本靠程序化生成，不手写几千行，层数也确定 */
function nestedDivs(depth: number, inner = ''): string {
  return '<div>'.repeat(depth) + inner + '</div>'.repeat(depth)
}

/**
 * 深度炸弹导航文档：正文目录本身合法（一个 toc 叶指向 ch1#a，目标存在），只是 DOM 嵌套远超
 * 单文档深度预算（128 层）。没有预算的递归走法会在这里吃穿调用栈，抛宿主的 `RangeError`——
 * 那不是本子树的异常类，服务层错误分类表按类分流时会把它漏成 500。
 */
function deepNavOf(depth: number): string {
  return '<?xml version="1.0" encoding="UTF-8"?>\n' + XHTML_DOCTYPE + '\n'
    + '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>深目录</title></head><body>'
    + '<nav epub:type="toc"><ol><li><a href="ch1.xhtml#a">甲</a>' + nestedDivs(depth) + '</li></ol></nav>'
    + '</body></html>'
}

/** 宽目录：`items` 个真条目（目标都存在，条目全合法），只是节点数远超调小的节点预算 */
function wideNavOf(items: number): string {
  const entries = Array.from({ length: items }, (_, i) => '<li><a href="ch1.xhtml#a">第' + (i + 1) + '章</a></li>').join('')
  return '<?xml version="1.0" encoding="UTF-8"?>\n' + XHTML_DOCTYPE + '\n'
    + '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>宽目录</title></head><body>'
    + '<nav epub:type="toc"><ol>' + entries + '</ol></nav></body></html>'
}

/** 一份带 nav 文档的单章包：超深/超宽目录、坏 href 三个样本共用它，免得各自再写一遍 manifest/spine */
function oneChapterWithNav(extra: Array<[string, string | Buffer]>): Buffer {
  return zipOf(pkgEntries(opfOf({
    title: '目录样本',
    manifest: itemXml('ch1', 'ch1.xhtml') + itemXml('nav', 'nav.xhtml', { attrs: ' properties="nav"' }),
    spine: itemrefXml('ch1'),
  }), extra))
}

/** 加密清单：CipherReference 的 URI 按容器根解析 */
function encryptionXml(uris: readonly string[]): string {
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#">'
    + uris.map((uri) => '<enc:EncryptedData><enc:EncryptionMethod Algorithm="http://www.idpf.org/2008/embedding"/>'
      + '<enc:CipherData><enc:CipherReference URI="' + uri + '"/></enc:CipherData></enc:EncryptedData>').join('')
    + '</encryption>'
}

/**
 * 封闭表：ZIP 层样本（含一份正常基线）+ 包层样本（Task 3）。
 * 正文层样本（图文规范化、图片、脚注）由后续任务在同一张表里追加。
 */
const FIXTURES: Record<string, () => Buffer> = {
  /** ZIP 层正常样本：只保证 mimetype 首项 store、条目名与内容可读；包/正文语义由后续任务的样本承担 */
  'zip-baseline': baseline,

  /** 条目名 `../evil.txt`：越出归档根 */
  'zip-slip': () => zipOf([...baselineEntries(), ['../evil.txt', '越界']]),

  /** 条目名 `/etc/passwd`：绝对路径 */
  'absolute-path': () => zipOf([...baselineEntries(), ['/etc/passwd', '绝对路径']]),

  /** 条目名 `C:/evil.txt`：盘符 */
  'windows-drive': () => zipOf([...baselineEntries(), ['C:/evil.txt', '盘符']]),

  /** 条目名含反斜杠：Windows 会把同一份归档的目录树解释成另一棵，规则不允许这种歧义 */
  'backslash-path': () => zipOf([...baselineEntries(), ['OEBPS\\ch1.xhtml', '反斜杠']]),

  /** 条目名含 NUL：yauzl 的 validateFileName 不校验 NUL，这是本层**独占**拒绝的形态之一 */
  'nul-entry-name': () => zipOf([...baselineEntries(), ['OEBPS/bad\u0000name.txt', '含 NUL 的名字']]),

  /** 条目名是 `.`：归一剔掉 `.` 段后什么都不剩，yauzl 也不拦（它只拒 `..` 段）——本层独占的另一种形态 */
  'dot-entry-name': () => zipOf([...baselineEntries(), ['.', '归一后为空的名字']]),

  /** 重名：把第 5 条 `OEBPS/ch2.xhtml` 的名字就地改成 `OEBPS/ch1.xhtml`（中央目录 + 本地头，等长） */
  'duplicate-path': () => renameEntry(
    zipOf([...baselineEntries(), ['OEBPS/ch2.xhtml', chapterXml(2)]]),
    'OEBPS/ch2.xhtml',
    'OEBPS/ch1.xhtml',
  ),

  /** 符号链接（指向书外的经典手法）：宿主字节改 unix、外部属性模式位改 S_IFLNK */
  symlink: () => markSymlink(baseline(), 'OEBPS/ch1.xhtml'),

  /** 加密条目：置通用标志 bit0 */
  'encrypted-entry': () => markEncrypted(baseline(), 'OEBPS/ch1.xhtml'),

  /** 压缩方式 9（deflate64）：本层只接受 store/deflate */
  'unsupported-method': () => markMethod(baseline(), 'OEBPS/ch1.xhtml', 9),

  /** CRC32 字段与内容不符 */
  'crc-mismatch': () => breakCrc(baseline(), 'OEBPS/ch1.xhtml'),

  /** 声明的解压大小比实际多 1 字节 */
  'declared-size-mismatch': () => breakDeclaredSize(baseline(), 'OEBPS/ch1.xhtml'),

  /** 6 条条目：配合缩小的 entries 预算触发条目上限 */
  'entry-limit': () => zipOf([...baselineEntries(), ['OEBPS/ch2.xhtml', chapterXml(2)], ['OEBPS/ch3.xhtml', chapterXml(3)]]),

  // 真实上限的实证（各用例只缩小预算，走的是同一条代码路径，却从没量过设计定的那个数）：
  // 基线含 mimetype 共 4 条， filler 补到边界两侧各一条。
  /** 恰好 10_000 条：默认预算下必须打得开（边界不许把「等于上限」判成越界） */
  'entry-limit-exact': () => zipOf([...baselineEntries(), ...fillerEntries(10_000 - 4)]),

  /** 10_001 条：默认预算下必须被拒，并点名越界的那一条 */
  'entry-limit-over': () => zipOf([...baselineEntries(), ...fillerEntries(10_000 - 4 + 1)]),

  /** 单条 12 KiB 文本：配合缩小的单条目预算触发解压上限 */
  'entry-byte-limit': () => zipOf([...baselineEntries(), ['OEBPS/big.txt', BIG_TEXT]]),

  /** 两条各 3 KiB：先读一条不越累计预算、第二条越界——测的是累计而非单条 */
  'total-byte-limit': () => zipOf([...baselineEntries(), ['OEBPS/one.txt', HALF_TEXT], ['OEBPS/two.txt', HALF_TEXT]]),

  /** 砍掉末尾 EOCD：连中央目录都定位不到 */
  'truncated-zip': () => cutEndOfCentralDirectory(baseline()),

  /** 本地头签名被改（中央目录仍完好）：扫目录看不出来，读到那一条才炸——钉住「未读取的条目不读本地头」 */
  'bad-local-header': () => breakLocalHeaderSignature(baseline(), 'OEBPS/ch1.xhtml'),

  // ── 包层正常样本 ────────────────────────────────────────────────────

  /**
   * EPUB3 图文基准（后续任务的共用样本，结构别动）：
   * ① ZIP 顺序把 ch2 排在 ch1 之前，spine 却声明 ch1→ch2——「按 spine 阅读、不按 ZIP 顺序」的真样本；
   * ② notes.xhtml 在 spine 里但 linear="no"：补充文档，既不算第三章也不进主序列；
   * ③ 导航三叶分别落 ch1#a / ch1#b / ch2#c（同一文档两个锚点各自成条，不复制成两章）；
   * ④ 导航文档里另有 landmarks 与 page-list：正文目录只许取 toc；
   * ⑤ 封面走 EPUB3 的 properties="cover-image"，指向一份真 PNG。
   */
  'epub3-rich': () => zipOf([
    ['META-INF/container.xml', CONTAINER_OPF],
    ['OEBPS/ch2.xhtml', xhtmlOf('第二章', RICH_CH2_BODY)],   // ZIP 顺序：ch2 先于 ch1
    ['OEBPS/notes.xhtml', xhtmlOf('注释', RICH_NOTES_BODY)],
    ['OEBPS/cover.png', TINY_PNG],
    ['OEBPS/nav.xhtml', RICH_NAV],
    ['OEBPS/content.opf', opfOf({
      title: '图文样本',
      author: '样本作者',
      manifest: TWO_CHAPTER_MANIFEST + itemXml('notes', 'notes.xhtml')
        + itemXml('nav', 'nav.xhtml', { attrs: ' properties="nav"' })
        + itemXml('cover-img', 'cover.png', { type: 'image/png', attrs: ' properties="cover-image"' }),
      spine: TWO_CHAPTER_SPINE + itemrefXml('notes', ' linear="no"'),
    })],
    ['OEBPS/ch1.xhtml', xhtmlOf('第一章', RICH_CH1_BODY)],
  ]),

  /**
   * EPUB2 + NCX：spine 的 toc 属性指向 NCX（EPUB2 的目录口径）；封面走 EPUB2 的 meta name="cover"；
   * NCX 带标准外部 DOCTYPE（必须能忽略），navPoint 有嵌套（父节点自己也有目标）。
   */
  'epub2-basic': () => zipOf([
    ['META-INF/container.xml', CONTAINER_OPF],
    ['OEBPS/content.opf', opfOf({
      version: '2.0',
      title: 'NCX 样本',
      author: '样本作者二',
      meta: '<meta name="cover" content="cover-img"/>',
      manifest: TWO_CHAPTER_MANIFEST + itemXml('ncx', 'toc.ncx', { type: NCX_MEDIA_TYPE })
        + itemXml('cover-img', 'images/cover.png', { type: 'image/png' }),
      spine: TWO_CHAPTER_SPINE,
      spineAttrs: ' toc="ncx"',
    })],
    ['OEBPS/toc.ncx', BASIC_NCX],
    ['OEBPS/images/cover.png', TINY_PNG],
    ['OEBPS/ch1.xhtml', xhtmlOf('第一章', CH1_BODY)],
    ['OEBPS/ch2.xhtml', xhtmlOf('第二章', CH2_BODY)],
  ]),

  /** 命名空间前缀全换一遍（opf: / d: / xhtml: / ops:）：判定必须按本地名，不认前缀写法 */
  'epub3-namespaced': () => zipOf([
    ['META-INF/container.xml', CONTAINER_OPF],
    ['OEBPS/content.opf', '<?xml version="1.0" encoding="UTF-8"?>\n'
      + '<opf:package version="3.0" xmlns:opf="http://www.idpf.org/2007/opf" unique-identifier="bookid">'
      + '<opf:metadata xmlns:d="http://purl.org/dc/elements/1.1/"><d:title>前缀样本</d:title><d:creator>前缀作者</d:creator></opf:metadata>'
      + '<opf:manifest>' + itemXml('ch1', 'ch1.xhtml') + itemXml('nav', 'nav.xhtml', { attrs: ' properties="nav"' }) + '</opf:manifest>'
      + '<opf:spine>' + itemrefXml('ch1') + '</opf:spine></opf:package>'],
    ['OEBPS/nav.xhtml', '<?xml version="1.0" encoding="UTF-8"?>\n'
      + '<xhtml:html xmlns:xhtml="http://www.w3.org/1999/xhtml" xmlns:ops="http://www.idpf.org/2007/ops">'
      + '<xhtml:head><xhtml:title>目录</xhtml:title></xhtml:head><xhtml:body>'
      + '<xhtml:nav ops:type="toc"><xhtml:ol><xhtml:li><xhtml:a href="ch1.xhtml#a">甲</xhtml:a></xhtml:li></xhtml:ol></xhtml:nav>'
      + '</xhtml:body></xhtml:html>'],
    ['OEBPS/ch1.xhtml', xhtmlOf('第一章', CH1_BODY)],
  ]),

  /**
   * 路径形态样本：OPF 在 OEBPS/pkg/，文档在 OEBPS/text/ 与 OEBPS/nav/——href 里同时有
   * `../`（书内合法的父目录）、百分号转义、中文与空格；导航第二条只有 fragment（同文档锚点）。
   */
  'epub3-paths': () => zipOf([
    ['META-INF/container.xml', containerOf([['OEBPS/pkg/content.opf', OPF_MEDIA_TYPE]])],
    ['OEBPS/pkg/content.opf', opfOf({
      title: '路径样本',
      manifest: itemXml('ch1', '../text/%E4%B8%AD%E6%96%87%20%E7%AB%A0%E8%8A%82.xhtml')
        + itemXml('nav', '../nav/nav.xhtml', { attrs: ' properties="nav"' }),
      spine: itemrefXml('ch1'),
    })],
    ['OEBPS/text/中文 章节.xhtml', xhtmlOf('中文', CH1_BODY)],
    ['OEBPS/nav/nav.xhtml', '<?xml version="1.0" encoding="UTF-8"?>\n'
      + '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目录</title></head><body>'
      // body 里的 id="top" 是 `#top` 那个叶子的真锚点：导航目标必须命中已生成的节点
      + '<h1 id="top">目录</h1>'
      + '<nav epub:type="toc"><ol>'
      + '<li><a href="../text/%E4%B8%AD%E6%96%87%20%E7%AB%A0%E8%8A%82.xhtml#a">中文章</a></li>'
      + '<li><a href="#top">本页顶</a></li>'
      + '</ol></nav></body></html>'],
  ]),

  /** OPF 是带 BOM 的 UTF-16LE（声明 encoding="utf-16"）：BOM 优先于声明 */
  'epub3-utf16-bom': () => {
    const opf = opfOf({ decl: 'utf-16', title: 'BOM 样本', manifest: itemXml('ch1', 'ch1.xhtml'), spine: itemrefXml('ch1') })
    return zipOf(pkgEntries(Buffer.from('\ufeff' + opf, 'utf16le')))
  },

  /** OPF 声明 iso-8859-1 且书名含非 ASCII（é）：按声明解，不套 UTF-8、不回退 GBK。
   *  整份 OPF 都是 latin-1 字节，所以书名的可编码字符集也必须是 latin-1（不能塞汉字） */
  'epub2-latin1': () => zipOf(pkgEntries(Buffer.from(opfOf({
    version: '2.0', decl: 'iso-8859-1', title: 'Café', manifest: itemXml('ch1', 'ch1.xhtml'), spine: itemrefXml('ch1'),
  }), 'latin1'))),

  /** OPF 声明 UTF-8 却含非法字节 0x80：解码必须报错，不许当 GBK 猜出乱码来 */
  'epub3-invalid-utf8': () => {
    const bytes = Buffer.from(opfOf({ title: '坏编码样本', manifest: itemXml('ch1', 'ch1.xhtml'), spine: itemrefXml('ch1') }), 'utf8')
    bytes[bytes.indexOf(Buffer.from('坏', 'utf8'))] = 0x80   // 「坏」的首字节换成非法起始字节
    return zipOf(pkgEntries(bytes))
  },

  /** EPUB3 同时有 nav 与 NCX：nav 优先（NCX 是遗留物），且不该产生降级告警 */
  'epub3-nav-and-ncx': () => zipOf(pkgEntries(opfOf({
    title: '双目录样本',
    manifest: itemXml('ch1', 'ch1.xhtml') + itemXml('nav', 'nav.xhtml', { attrs: ' properties="nav"' })
      + itemXml('ncx', 'toc.ncx', { type: NCX_MEDIA_TYPE }),
    spine: itemrefXml('ch1'),
    spineAttrs: ' toc="ncx"',
  }), [
    ['OEBPS/toc.ncx', BASIC_NCX],
    ['OEBPS/nav.xhtml', '<?xml version="1.0" encoding="UTF-8"?>\n'
      + '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目录</title></head><body>'
      + '<nav epub:type="toc"><ol><li><a href="ch1.xhtml#a">nav 的目录</a></li></ol></nav></body></html>'],
  ])),

  /** 只有 spine、没有 nav 也没有 NCX：包层必须按 spine 造平面导航并留告警，而不是报错或空目录 */
  'epub3-no-nav': () => zipOf(pkgEntries(opfOf({
    title: '无目录样本', manifest: TWO_CHAPTER_MANIFEST, spine: TWO_CHAPTER_SPINE,
  }), [['OEBPS/ch2.xhtml', xhtmlOf('第二章', CH2_BODY)]])),

  /** EPUB3 没 nav、spine 的 toc 指向 NCX：可读 NCX，但要记「降级」说明 */
  'epub3-ncx-fallback': () => zipOf(pkgEntries(opfOf({
    title: '降级样本',
    manifest: TWO_CHAPTER_MANIFEST + itemXml('ncx', 'toc.ncx', { type: NCX_MEDIA_TYPE }),
    spine: TWO_CHAPTER_SPINE,
    spineAttrs: ' toc="ncx"',
  }), [
    ['OEBPS/toc.ncx', BASIC_NCX],
    ['OEBPS/ch2.xhtml', xhtmlOf('第二章', CH2_BODY)],
  ])),

  /** 声明了 navigation document 却只有 landmarks/page-list：坏目录必须报错，不许静默降级 */
  'epub3-nav-broken': () => zipOf(pkgEntries(opfOf({
    title: '坏目录样本',
    manifest: itemXml('ch1', 'ch1.xhtml') + itemXml('nav', 'nav.xhtml', { attrs: ' properties="nav"' }),
    spine: itemrefXml('ch1'),
  }), [['OEBPS/nav.xhtml', BROKEN_NAV]])),

  /** 导航指向归档里不存在的目标：坏目标不许冒充成功 */
  'epub3-nav-missing-target': () => zipOf(pkgEntries(opfOf({
    title: '坏目标样本',
    manifest: itemXml('ch1', 'ch1.xhtml') + itemXml('nav', 'nav.xhtml', { attrs: ' properties="nav"' }),
    spine: itemrefXml('ch1'),
  }), [['OEBPS/nav.xhtml', '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目录</title></head><body>'
    + '<nav epub:type="toc"><ol><li><a href="gone.xhtml#x">消失的一章</a></li></ol></nav></body></html>']])),

  /** 书名放在 CDATA 里且 CDATA 内含 `&nbsp;`：CDATA 是字面文本，不许当实体声明被拒，也不许丢内容 */
  'epub3-cdata': () => zipOf(pkgEntries('<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<package version="3.0" xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid">'
    + '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title><![CDATA[书 &nbsp; 名]]></dc:title></metadata>'
    + '<manifest>' + itemXml('ch1', 'ch1.xhtml') + '</manifest><spine>' + itemrefXml('ch1') + '</spine></package>')),

  // ── 包层失败/警告样本 ──────────────────────────────────────────────

  /** 整份归档没有 mimetype 条目（EPUB 身份按它判定，不是靠后缀） */
  'epub-missing-mimetype': () => zipOf(pkgEntries(ONE_CHAPTER_OPF), { mimetype: false }),

  /** 没有 META-INF/container.xml：连 OPF 都定位不到 */
  'epub-missing-container': () => zipOf([
    ['OEBPS/content.opf', ONE_CHAPTER_OPF],
    ['OEBPS/ch1.xhtml', xhtmlOf('第一章', CH1_BODY)],
  ]),

  /** 容器指向的 OPF 不在归档里 */
  'epub-missing-opf': () => zipOf([
    ['META-INF/container.xml', CONTAINER_OPF],
    ['OEBPS/ch1.xhtml', xhtmlOf('第一章', CH1_BODY)],
  ]),

  /** rootfile 的 media-type 不受支持（只有一份 NCX）：没有受支持的 rootfile 即失败 */
  'epub-bad-rootfile': () => zipOf([
    ['META-INF/container.xml', containerOf([['OEBPS/toc.ncx', NCX_MEDIA_TYPE]])],
    ['OEBPS/toc.ncx', BASIC_NCX],
  ]),

  /** rootfile 的 media-type 对，指向的却是正文文档：根元素不是 package */
  'epub-rootfile-not-opf': () => zipOf([
    ['META-INF/container.xml', containerOf([['OEBPS/ch1.xhtml', OPF_MEDIA_TYPE]])],
    ['OEBPS/ch1.xhtml', xhtmlOf('第一章', CH1_BODY)],
  ]),

  /** 多个 rootfile：取 container 声明顺序里第一个受支持的（A），不把两本拼成一堆章 */
  'epub-multi-rootfile': () => zipOf([
    ['META-INF/container.xml', containerOf([
      ['OEBPS/junk.opf', NCX_MEDIA_TYPE],
      ['OEBPS/a.opf', OPF_MEDIA_TYPE],
      ['OEBPS/b.opf', OPF_MEDIA_TYPE],
    ])],
    ['OEBPS/a.opf', opfOf({ title: '甲本', manifest: itemXml('ch1', 'ch1.xhtml'), spine: itemrefXml('ch1') })],
    ['OEBPS/b.opf', opfOf({ title: '乙本', manifest: itemXml('ch2', 'ch2.xhtml'), spine: itemrefXml('ch2') })],
    ['OEBPS/ch1.xhtml', xhtmlOf('第一章', CH1_BODY)],
    ['OEBPS/ch2.xhtml', xhtmlOf('第二章', CH2_BODY)],
  ]),

  /** spine 的 idref 不在 manifest 里 */
  'epub-spine-missing-idref': () => zipOf(pkgEntries(opfOf({
    title: '缺 idref 样本', manifest: itemXml('ch1', 'ch1.xhtml'), spine: itemrefXml('nope'),
  }))),

  /** 同一 idref 在 spine 里出现两次：重复即拒（否则同一资源的锚点目标有歧义） */
  'epub-spine-duplicate-idref': () => zipOf(pkgEntries(opfOf({
    title: '重复 idref 样本', manifest: itemXml('ch1', 'ch1.xhtml'), spine: itemrefXml('ch1') + itemrefXml('ch1'),
  }))),

  /** spine 只有 linear="no" 的项：主序列为空 → 没有可读正文，失败 */
  'epub-empty-spine': () => zipOf(pkgEntries(opfOf({
    title: '空主序列样本', manifest: itemXml('ch1', 'ch1.xhtml'), spine: itemrefXml('ch1', ' linear="no"'),
  }))),

  /** EPUB3 固定版式：rendition:layout=pre-paginated，本插件不假报支持 */
  'epub3-fixed-layout': () => zipOf(pkgEntries(opfOf({
    title: '固定版式样本', meta: '<meta property="rendition:layout">pre-paginated</meta>',
    manifest: itemXml('ch1', 'ch1.xhtml'), spine: itemrefXml('ch1'),
  }))),

  /** EPUB2 固定版式（iBooks/Kindle 的写法）：meta name="fixed-layout" content="true" */
  'epub2-fixed-layout': () => zipOf(pkgEntries(opfOf({
    version: '2.0', title: '固定版式二', meta: '<meta name="fixed-layout" content="true"/>',
    manifest: itemXml('ch1', 'ch1.xhtml'), spine: itemrefXml('ch1'),
  }))),

  /** 主序列文档被包声明为 scripted：脚本正文拒绝（读端不执行书内脚本） */
  'epub3-scripted': () => zipOf(pkgEntries(opfOf({
    title: '脚本样本', manifest: itemXml('ch1', 'ch1.xhtml', { attrs: ' properties="scripted"' }), spine: itemrefXml('ch1'),
  }))),

  /** encryption.xml 指向主序列正文：内容 DRM，本插件不提供解密 → 整本拒绝 */
  'epub-drm-content': () => zipOf(pkgEntries(ONE_CHAPTER_OPF, [['META-INF/encryption.xml', encryptionXml(['OEBPS/ch1.xhtml'])]])),

  /** 字体混淆只影响未使用的字体：整本照读，只留一条点名资源的告警 */
  'epub-font-obfuscated': () => zipOf(pkgEntries(opfOf({
    title: '混淆字体样本',
    manifest: itemXml('ch1', 'ch1.xhtml') + itemXml('font', 'fonts/font.otf', { type: 'application/vnd.ms-opentype' }),
    spine: itemrefXml('ch1'),
  }), [
    ['OEBPS/fonts/font.otf', '混淆过的字体字节'],
    ['META-INF/encryption.xml', encryptionXml(['OEBPS/fonts/font.otf'])],
  ])),

  /** 有未使用的音频条目：不能据此把整本误判成有声书（不拒绝、也不额外告警） */
  'epub-audio-unused': () => zipOf(pkgEntries(opfOf({
    title: '带音频样本',
    manifest: TWO_CHAPTER_MANIFEST + itemXml('audio', 'audio/bg.mp3', { type: 'audio/mpeg' }),
    spine: TWO_CHAPTER_SPINE,
  }), [
    ['OEBPS/audio/bg.mp3', '不是真的音频，但从未被引用'],
    ['OEBPS/ch2.xhtml', xhtmlOf('第二章', CH2_BODY)],
  ])),

  /** 外部 DTD 声明（可忽略）之外还引用了未声明的外部实体：拒（不 resolve 外部的 DTD） */
  'epub-entity-external': () => zipOf(pkgEntries('<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<!DOCTYPE package SYSTEM "http://example.invalid/evil.dtd">\n'
    + '<package version="3.0" xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid">'
    + '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>&external;</dc:title></metadata>'
    + '<manifest>' + itemXml('ch1', 'ch1.xhtml') + '</manifest><spine>' + itemrefXml('ch1') + '</spine></package>')),

  /** 内部实体声明 + 引用：拒，且**不许展开**（billion-laughs 的入口） */
  'epub-entity-internal': () => zipOf(pkgEntries('<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<!DOCTYPE package [ <!ENTITY boom "BOOM"> ]>\n'
    + '<package version="3.0" xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid">'
    + '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>&boom;</dc:title></metadata>'
    + '<manifest>' + itemXml('ch1', 'ch1.xhtml') + '</manifest><spine>' + itemrefXml('ch1') + '</spine></package>')),

  // ── 包层预算与路径出处的样本 ────────────────────────────────────────

  /** 超深导航文档（两万层 div 嵌套）：字节远不到 8 MiB，但结构深度吃穿调用栈——深度预算必须在这里报错 */
  'epub3-nav-too-deep': () => oneChapterWithNav([['OEBPS/nav.xhtml', deepNavOf(20_000)]]),

  /** 超宽导航文档（三百条真条目）：节点预算的作用域是单份文档，条数够多就要报错 */
  'epub3-nav-too-wide': () => oneChapterWithNav([['OEBPS/nav.xhtml', wideNavOf(300)]]),

  /** manifest 的 href 逃出书根：路径失败必须点名**出处文档**（这里的出处是 content.opf） */
  'epub-bad-manifest-href': () => zipOf(pkgEntries(opfOf({
    title: '越界 href 样本', manifest: itemXml('ch1', '../../outside/ch1.xhtml'), spine: itemrefXml('ch1'),
  }))),

  /** 导航文档里的 href 逃出书根：出处是导航文档，不是 OPF */
  'epub3-nav-bad-href': () => oneChapterWithNav([['OEBPS/nav.xhtml',
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目录</title></head><body>'
    + '<nav epub:type="toc"><ol><li><a href="../../outside.xhtml">外面</a></li></ol></nav></body></html>']]),

  /** 容器 rootfile 的 full-path 逃出书根：基准是归档根（没有文档可点名），出处则由 container.xml 补上 */
  'epub-bad-rootfile-path': () => zipOf([
    ['META-INF/container.xml', containerOf([['../outside.opf', OPF_MEDIA_TYPE]])],
    ['OEBPS/ch1.xhtml', xhtmlOf('第一章', CH1_BODY)],
  ]),

  /** spine 指向的 manifest 项落到不存在的归档条目上：悬空阅读单元必须报错，不许留个读不出的章节 */
  'epub-spine-missing-entry': () => zipOf(pkgEntries(opfOf({
    title: '悬空 spine 样本',
    manifest: itemXml('ch1', 'ch1.xhtml') + itemXml('ghost', 'ghost.xhtml'),
    spine: itemrefXml('ch1') + itemrefXml('ghost'),
  }))),

  /** 两个 manifest id 指向**同一个 href**，spine 里各出现一次：idref 不同而路径相同，歧义与重复 idref 一样 */
  'epub-spine-duplicate-path': () => zipOf(pkgEntries(opfOf({
    title: '同路径双 id 样本',
    manifest: itemXml('ch1', 'ch1.xhtml') + itemXml('ch1-alias', 'ch1.xhtml'),
    spine: itemrefXml('ch1') + itemrefXml('ch1-alias'),
  }))),

  /** 固定版式只声明在 itemref 上（包级没有 rendition:layout）：同一件事的另一种写法，一样不可重排 */
  'epub3-itemref-fixed-layout': () => zipOf(pkgEntries(opfOf({
    title: '逐文档固定版式样本',
    manifest: itemXml('ch1', 'ch1.xhtml'),
    spine: itemrefXml('ch1', ' properties="rendition:layout-pre-paginated"'),
  }))),

  // ── 正文层样本（图文规范化、资源与导入编排；Task 4）────────────────────

  /**
   * 纯插图章节 + 共享图片 + 图片无 alt：正文只有一张图也是有效内容；
   * 同一张图两章各引一次只落一份资源（资源身份按书内路径，不按引用次数）。
   */
  'epub3-image-only': () => zipOf([
    ['META-INF/container.xml', CONTAINER_OPF],
    ['OEBPS/content.opf', opfOf({
      title: '插图样本',
      manifest: TWO_CHAPTER_MANIFEST + itemXml('fig', 'pics/fig.png', { type: 'image/png' }),
      spine: TWO_CHAPTER_SPINE,
    })],
    ['OEBPS/ch1.xhtml', xhtmlOf('第一章', '<img src="pics/fig.png" alt="整页插图"/>')],
    ['OEBPS/ch2.xhtml', xhtmlOf('第二章', '<p>接着看图<img src="../OEBPS/pics/fig.png"/></p>')],
    ['OEBPS/pics/fig.png', TINY_PNG],
  ]),

  /**
   * 环形链接：ch1 链到补充文档 a，a 与 b 互链，b 再链到**不在 spine 里**的 c。
   * 「可达」按链接算而不是按 spine 声明算：c 只在 manifest 里，只有顺着链接才走得到。
   */
  'epub3-link-cycle': () => zipOf([
    ['META-INF/container.xml', CONTAINER_OPF],
    ['OEBPS/content.opf', opfOf({
      title: '环形链接样本',
      manifest: itemXml('ch1', 'ch1.xhtml') + itemXml('a', 'text/a.xhtml') + itemXml('b', 'text/b.xhtml') + itemXml('c', 'text/c.xhtml'),
      spine: itemrefXml('ch1') + itemrefXml('a', ' linear="no"') + itemrefXml('b', ' linear="no"'),
    })],
    ['OEBPS/ch1.xhtml', xhtmlOf('第一章', '<p id="a">甲<a href="text/a.xhtml#x">补充一</a></p>')],
    ['OEBPS/text/a.xhtml', xhtmlOf('补充一', '<p id="x">补充一<a href="b.xhtml#y">去二</a></p>')],
    ['OEBPS/text/b.xhtml', xhtmlOf('补充二', '<p id="y">补充二<a href="a.xhtml#x">回一</a><a href="c.xhtml#z">去三</a></p>')],
    ['OEBPS/text/c.xhtml', xhtmlOf('补充三', '<p id="z">补充三</p>')],
  ]),

  /**
   * spine 里有 linear="no" 的补充文档，但**既没有导航指向它、也没有任何书内链接指向它**：
   * 未使用的补充文档不解析（只有可达的才转换），文档数 = 主序列 1 份。
   */
  'epub3-supplement-unreachable': () => zipOf([
    ['META-INF/container.xml', CONTAINER_OPF],
    ['OEBPS/content.opf', opfOf({
      title: '孤立补充样本',
      manifest: TWO_CHAPTER_MANIFEST + itemXml('notes', 'notes.xhtml'),
      spine: itemrefXml('ch1') + itemrefXml('notes', ' linear="no"'),
    })],
    ['OEBPS/ch1.xhtml', xhtmlOf('第一章', CH1_BODY)],
    ['OEBPS/notes.xhtml', xhtmlOf('注释', NOTES_BODY)],
  ]),

  /**
   * 导航指向补充文档（spine 里 linear="no"、且没有正文链接指向它）：可达性也可以只由目录建立。
   * 章数仍是主序列 1 章——补充文档可打开，不进阅读流、不计章。
   */
  'epub3-nav-to-supplement': () => zipOf([
    ['META-INF/container.xml', CONTAINER_OPF],
    ['OEBPS/content.opf', opfOf({
      title: '目录到补充样本',
      manifest: itemXml('ch1', 'ch1.xhtml') + itemXml('sup', 'sup.xhtml')
        + itemXml('nav', 'nav.xhtml', { attrs: ' properties="nav"' }),
      spine: itemrefXml('ch1') + itemrefXml('sup', ' linear="no"'),
    })],
    ['OEBPS/nav.xhtml', '<?xml version="1.0" encoding="UTF-8"?>\n'
      + '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目录</title></head><body>'
      + '<nav epub:type="toc"><ol><li><a href="ch1.xhtml#a">甲</a></li><li><a href="sup.xhtml#s">附录</a></li></ol></nav>'
      + '</body></html>'],
    ['OEBPS/ch1.xhtml', xhtmlOf('第一章', CH1_BODY)],
    ['OEBPS/sup.xhtml', xhtmlOf('附录', '<p id="s">附录正文</p>')],
  ]),

  /**
   * 独立 SVG 插图（重建）+ SVG 单图包装封面（解析成它包的那张栅格）：
   * ① fig.svg 里有渐变引用、style/script 与普通图形——重建时只留白名单，渐变 ID 重写。
   *    引用写成大写 `URL(#grad)`：CSS 的 url() 大小写不敏感，识别不到就会留下一条指向已改写 ID 的死链
   *    （图形静默消失），这里把它钉住；
   * ② cover.svg 只是把 cover.png 缩放包了一层——封面资源应是那张 PNG，而不是这份 SVG 包装。
   *    cover.svg 里另有一份**不渲染**的 `<defs><linearGradient/></defs>`：包装识别必须跳过 defs，
   *    否则它会被误判成「不止一张图」而整本报错（真实封面常见这种写法）。
   */
  'epub3-svg-figure': () => zipOf([
    ['META-INF/container.xml', CONTAINER_OPF],
    ['OEBPS/content.opf', opfOf({
      title: '矢量样本',
      manifest: itemXml('ch1', 'ch1.xhtml') + itemXml('fig', 'images/fig.svg', { type: 'image/svg+xml' })
        + itemXml('cover-img', 'images/cover.svg', { type: 'image/svg+xml', attrs: ' properties="cover-image"' })
        + itemXml('cover-png', 'images/cover.png', { type: 'image/png' }),
      spine: itemrefXml('ch1'),
    })],
    ['OEBPS/ch1.xhtml', xhtmlOf('第一章', '<p>插图<img src="images/fig.svg" alt="矢量插图"/></p>')],
    ['OEBPS/images/fig.svg', '<?xml version="1.0" encoding="UTF-8"?>\n'
      + '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="10" height="20" viewBox="0 0 10 20" version="1.1">'
      + '<title>矢量插图</title>'
      + '<defs><linearGradient id="grad" x1="0" y1="0" x2="1" y2="1">'
      + '<stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff"/></linearGradient></defs>'
      + '<g transform="translate(1 2)"><rect id="box" x="0" y="0" width="4" height="6" fill="URL(#grad)" stroke="#000" stroke-width="1"/>'
      + '<circle cx="5" cy="5" r="2" opacity="0.5"/><path d="M0 0 L1 1" fill="none"/>'
      + '<text x="1" y="1" font-size="3" text-anchor="middle">字</text></g>'
      + '<style>rect{fill:green}</style><script>alert(1)</script></svg>'],
    ['OEBPS/images/cover.svg', '<?xml version="1.0" encoding="UTF-8"?>\n'
      + '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 2 3">'
      + '<defs><linearGradient id="cov" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff"/></linearGradient></defs>'
      + '<image xlink:href="cover.png" width="2" height="3"/></svg>'],
    ['OEBPS/images/cover.png', TINY_PNG],
  ]),

  /**
   * 整页 SVG 封面页 + **容器带锚点** + 目录指向它（`wrap0000.xhtml#cover`）。
   *
   * 这是真书里的常见写法（一层 `div id="cover"` 包着整页 SVG）。容器在转换后被那张图顶替，
   * 它承载的锚点必须仍有落点：否则目录那条目标绑到一个树上不存在的 ID——落位退化成章首、
   * 目录当前项也量不到（锚点是扫描期铸的，而承载它的容器随整页 SVG 一起没了）。
   */
  'epub3-svg-cover-anchor': () => zipOf([
    ['META-INF/container.xml', CONTAINER_OPF],
    ['OEBPS/content.opf', opfOf({
      title: '封面锚点样本',
      manifest: itemXml('coverpage', 'wrap0000.xhtml', { attrs: ' properties="svg"' })
        + itemXml('nav', 'nav.xhtml', { attrs: ' properties="nav"' })
        + itemXml('ch1', 'ch1.xhtml')
        + itemXml('cover-img', 'images/cover.png', { type: 'image/png', attrs: ' properties="cover-image"' }),
      spine: itemrefXml('coverpage') + itemrefXml('ch1'),
    })],
    ['OEBPS/wrap0000.xhtml', xhtmlOf('封面', '<div id="cover">' + SVG_ONLY_IMAGE + '</div>')],
    ['OEBPS/nav.xhtml', '<?xml version="1.0" encoding="UTF-8"?>\n' + XHTML_DOCTYPE + '\n'
      + '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目录</title></head><body>'
      + '<nav epub:type="toc"><ol><li><a href="wrap0000.xhtml#cover">封面</a></li></ol></nav>'
      + '</body></html>'],
    ['OEBPS/ch1.xhtml', xhtmlOf('第一章', CH1_BODY)],
    ['OEBPS/images/cover.png', TINY_PNG],
  ]),

  /**
   * SVG 资源**超过 XML 类别的字节预算**（注释撑到 4 KB，样本整体很小）。
   *
   * SVG 是要进解析器的 XML 文档，按 `xmlBytes`（8 MiB 那一档）读；`entryBytes` 是 32 MiB 那一档，
   * 按它读等于这道闸不存在。两向可验：默认预算下导入成功，预算收到 1 KB 即拒——只断言「拒了」
   * 证明不了拒的是**这一类**上限。
   */
  'epub3-svg-oversize': () => svgFigureBook(
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">'
    + '<!--' + 'x'.repeat(4096) + '--><rect width="4" height="4"/></svg>',
  ),

  /**
   * 链接里的插图（XHTML5 的 `<a>` 是透明内容模型，图在链接里是**合法书写**）。
   *
   * 链接渲染成 `<button>`，缺省按内容**收缩包裹**——里面 `width: 100%` 的插图框于是解析成 auto，
   * 图未解码时没有内在尺寸，框塌成 0（实测：链接里的 600×900 图在到手前量到 0×0、到手后跳到
   * 600×900，后文位移近一屏，「图片延迟不改变恢复位置」那条不变量失效）。真排版下的读数在
   * tests/browser/epub-reader.test.ts。
   */
  'epub3-link-image': () => zipOf([
    ['META-INF/container.xml', CONTAINER_OPF],
    ['OEBPS/content.opf', opfOf({
      title: '链接图样本',
      manifest: itemXml('ch1', 'ch1.xhtml') + itemXml('img', 'images/fig.png', { type: 'image/png' }),
      spine: itemrefXml('ch1'),
    })],
    ['OEBPS/ch1.xhtml', xhtmlOf('第一章',
      '<p id="a">甲</p><p id="b">前<a href="ch1.xhtml#a"><img src="images/fig.png" alt="链接里的图"/></a>后</p><p id="c">尾部正文</p>')],
    ['OEBPS/images/fig.png', TINY_PNG],
  ]),

  /** 独立 SVG 里的 foreignObject（内嵌 HTML 的可见图形）：不支持就报错，不删掉冒充成功 */
  'epub3-svg-foreign-object': () => svgFigureBook(
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">'
    + '<foreignObject width="10" height="10"><p xmlns="http://www.w3.org/1999/xhtml">内嵌文字</p></foreignObject></svg>',
  ),

  /** 独立 SVG 里的 use 外链（指向书外）：报错点名资源，绝不发请求 */
  'epub3-svg-external-use': () => svgFigureBook(
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="10" height="10">'
    + '<use xlink:href="http://example.invalid/other.svg#a"/></svg>',
  ),

  /** 独立 SVG 引用了未登记的渐变（url(#missing)）：无法支持的能力报错，不改写、不静默丢 */
  'epub3-svg-missing-gradient': () => svgFigureBook(
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="4" height="4" fill="url(#missing)"/></svg>',
  ),

  /**
   * 正文用内联 SVG 且旁边还有真正文：按「剥离 + 告警」处理（可见图形的例外口径），正文文字与图片保留。
   * 只有内联 SVG 是该文档唯一内容时才报错——那是空章节冒充成功（见 epub3-inline-svg-only）。
   */
  'epub3-inline-svg': () => zipOf(pkgEntries(opfOf({
    title: '内联矢量样本', manifest: itemXml('ch1', 'ch1.xhtml'), spine: itemrefXml('ch1'),
  }), [['OEBPS/ch1.xhtml', xhtmlOf('第一章',
    '<p>图：<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4"/></svg></p>')]])),

  /** 内联 SVG 是这份文档的**唯一**内容（连文字都没有）：剥离后什么都不剩，按空章节拒绝并点名原因 */
  'epub3-inline-svg-only': () => zipOf(pkgEntries(opfOf({
    title: '纯内联矢量样本', manifest: itemXml('ch1', 'ch1.xhtml'), spine: itemrefXml('ch1'),
  }), [['OEBPS/ch1.xhtml', xhtmlOf('第一章',
    '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4"/></svg>')]])),

  /**
   * **真书反例（2026-09-26，Gutenberg #7337 图像版 `pg7337-images-3.epub`）**：spine 第一项是一页
   * 封面页——整页只有一棵内联 SVG，SVG 里只有一张 `<image>` 指向书内那张封面 PNG。这是 EPUB3 推荐的
   * 封面写法（同一张 PNG 另以 `properties="cover-image"` + `meta name="cover"` 声明为封面），
   * 真实出版方与 Gutenberg 都这样发。它原先被「内联 SVG 是唯一内容即拒整本」那条判据杀掉整本书。
   */
  'epub3-svg-cover-page': () => zipOf([
    ['META-INF/container.xml', CONTAINER_OPF],
    ['OEBPS/content.opf', opfOf({
      title: '封面页样本', author: '作者',
      meta: '<meta name="cover" content="cover-img"/>',
      manifest: itemXml('coverpage', 'wrap0000.xhtml', { attrs: ' properties="svg"' })
        + itemXml('ch1', 'ch1.xhtml')
        + itemXml('cover-img', 'images/cover.png', { type: 'image/png', attrs: ' properties="cover-image"' }),
      spine: itemrefXml('coverpage') + itemrefXml('ch1'),
    })],
    ['OEBPS/wrap0000.xhtml', xhtmlOf('封面', SVG_COVER_PAGE_BODY)],
    ['OEBPS/ch1.xhtml', xhtmlOf('第一章', CH1_BODY)],
    ['OEBPS/images/cover.png', TINY_PNG],
  ]),

  /** 封面页那张 `<image>` 指向**书外**：不是「我们读不懂形状」而是资源在站外——整本仍按原口径拒绝 */
  'epub3-svg-cover-page-remote': () => zipOf([
    ['META-INF/container.xml', CONTAINER_OPF],
    ['OEBPS/content.opf', opfOf({
      title: '封面页远程样本',
      manifest: itemXml('coverpage', 'wrap0000.xhtml', { attrs: ' properties="svg"' }) + itemXml('ch1', 'ch1.xhtml'),
      spine: itemrefXml('coverpage') + itemrefXml('ch1'),
    })],
    ['OEBPS/wrap0000.xhtml', xhtmlOf('封面', SVG_COVER_PAGE_BODY.replace('images/cover.png', 'https://example.invalid/cover.png'))],
    ['OEBPS/ch1.xhtml', xhtmlOf('第一章', CH1_BODY)],
  ]),

  /** 封面页的 SVG 里除那张图还有一枚 `<rect>`：不是「只包一张图」，判据不许顺着真书形状松手 */
  'epub3-svg-cover-page-not-sole': () => zipOf([
    ['META-INF/container.xml', CONTAINER_OPF],
    ['OEBPS/content.opf', opfOf({
      title: '封面页混排样本',
      manifest: itemXml('coverpage', 'wrap0000.xhtml', { attrs: ' properties="svg"' })
        + itemXml('ch1', 'ch1.xhtml')
        + itemXml('cover-img', 'images/cover.png', { type: 'image/png' }),
      spine: itemrefXml('coverpage') + itemrefXml('ch1'),
    })],
    ['OEBPS/wrap0000.xhtml', xhtmlOf('封面',
      SVG_COVER_PAGE_BODY.replace('</svg>', '<rect width="2" height="3"/></svg>'))],
    ['OEBPS/ch1.xhtml', xhtmlOf('第一章', CH1_BODY)],
    ['OEBPS/images/cover.png', TINY_PNG],
  ]),

  /**
   * 有正文的页里夹一棵「只包一张书内图」的内联 SVG：这条**不该**被新判据放行——判据只在文档
   * 别无可读内容时成立，否则正文里的一层装饰会凭空多落一张图（资源面白涨、图形位置也说不清）。
   */
  'epub3-inline-svg-image-with-text': () => zipOf([
    ['META-INF/container.xml', CONTAINER_OPF],
    ['OEBPS/content.opf', opfOf({
      title: '正文夹矢量图样本',
      manifest: itemXml('ch1', 'ch1.xhtml') + itemXml('cover-img', 'images/cover.png', { type: 'image/png' }),
      spine: itemrefXml('ch1'),
    })],
    ['OEBPS/ch1.xhtml', xhtmlOf('第一章', '<p>正文与花饰' + SVG_ONLY_IMAGE + '</p>')],
    ['OEBPS/images/cover.png', TINY_PNG],
  ]),

  /**
   * 目标锚点落在**内联 SVG 内部**：nav 的一条叶与正文的一条内链都指到 `#ornament`（花饰里的那个 id），
   * 另一条叶指正文的真锚点 `#top` 当对照组。
   *
   * 这份书必须能读：锚点确实在源文档里，是本插件自己把承载它的图形剥掉了（口径见 documents.ts 注③），
   * 事实清楚 —— 导航目标降级到文档开头（导航仍可用）、正文内链降级成纯文本，各留一条告警；
   * 若按「锚点不存在」处理，一层装饰性花饰就能把整本拒掉（这正是本样本要钉住的回归）。
   * 文档里另有可显示文字，所以不触发「内联 SVG 是文档唯一内容」那条拒绝。
   */
  'epub3-inline-svg-anchor': () => zipOf([
    ['META-INF/container.xml', CONTAINER_OPF],
    ['OEBPS/content.opf', opfOf({
      title: '内联矢量锚点样本',
      manifest: itemXml('ch1', 'ch1.xhtml') + itemXml('nav', 'nav.xhtml', { attrs: ' properties="nav"' }),
      spine: itemrefXml('ch1'),
    })],
    ['OEBPS/nav.xhtml', '<?xml version="1.0" encoding="UTF-8"?>\n'
      + '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目录</title></head><body>'
      + '<nav epub:type="toc"><ol><li><a href="ch1.xhtml#ornament">花饰</a></li><li><a href="ch1.xhtml#top">开头</a></li></ol></nav>'
      + '</body></html>'],
    ['OEBPS/ch1.xhtml', xhtmlOf('第一章',
      '<h1 id="top">第一章</h1>'
      + '<p>图：<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect id="ornament" width="4" height="4"/></svg></p>'
      + '<p>看<a href="#ornament">这张图</a>与<a href="ch1.xhtml#top">开头</a></p>')],
  ]),

  /**
   * 反例守护：同一份文档里，被剥离的内联 SVG 里确实有 `id="ornament"`，但链接指向的是拼错的
   * `#ornamnet`——**从未存在**的锚点仍然是坏书，不许被「这份文档有被剥离的锚点」这条降级路径吞掉。
   * 与上一个样本只差锚点名字，用来把「降级」的边界钉在「我们剥掉的那个锚点」上。
   */
  'epub3-inline-svg-bad-anchor': () => zipOf(pkgEntries(opfOf({
    title: '错锚点样本', manifest: itemXml('ch1', 'ch1.xhtml'), spine: itemrefXml('ch1'),
  }), [['OEBPS/ch1.xhtml', xhtmlOf('第一章',
    '<h1 id="top">第一章</h1>'
    + '<p>图：<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect id="ornament" width="4" height="4"/></svg></p>'
    + '<p>看<a href="#ornamnet">这张图</a></p>')]])),

  /** 同一份文档里两个元素共用一个 id：锚点目标有歧义，报错不猜 */
  'epub3-dup-anchor': () => zipOf(pkgEntries(opfOf({
    title: '重复锚点样本', manifest: itemXml('ch1', 'ch1.xhtml'), spine: itemrefXml('ch1'),
  }), [['OEBPS/ch1.xhtml', xhtmlOf('第一章', '<p id="a">甲</p><p id="a">又一个甲</p>')]])),

  /** 导航指向文档里不存在的锚点：坏目标必须报错（与「目标文档不存在」同一口径） */
  'epub3-missing-anchor': () => oneChapterWithNav([['OEBPS/nav.xhtml',
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目录</title></head><body>'
    + '<nav epub:type="toc"><ol><li><a href="ch1.xhtml#gone">消失的锚点</a></li></ol></nav></body></html>']]),

  /** 正文链接指向归档里不存在的文档：失效链接报错，不静默降级成纯文字 */
  'epub3-missing-target': () => zipOf(pkgEntries(opfOf({
    title: '失效链接样本', manifest: itemXml('ch1', 'ch1.xhtml'), spine: itemrefXml('ch1'),
  }), [['OEBPS/ch1.xhtml', xhtmlOf('第一章', '<p id="a">甲<a href="gone.xhtml#x">去哪儿</a></p>')]])),

  /** 正文用远程图片（书外资源）：导入失败并点名这张图，不许静默消失 */
  'epub3-remote-image': () => zipOf(pkgEntries(opfOf({
    title: '远程图片样本', manifest: itemXml('ch1', 'ch1.xhtml'), spine: itemrefXml('ch1'),
  }), [['OEBPS/ch1.xhtml', xhtmlOf('第一章', '<p id="a">甲<img src="https://example.invalid/x.png" alt="远程图"/></p>')]])),

  /** 被引用的图片字节损坏（缺 IEND）：导入失败并点名资源 */
  'epub3-broken-image': () => zipOf(pkgEntries(opfOf({
    title: '损坏图片样本',
    manifest: itemXml('ch1', 'ch1.xhtml') + itemXml('fig', 'images/fig.png', { type: 'image/png' }),
    spine: itemrefXml('ch1'),
  }), [
    ['OEBPS/ch1.xhtml', xhtmlOf('第一章', '<p id="a">甲<img src="images/fig.png" alt="坏图"/></p>')],
    ['OEBPS/images/fig.png', TRUNCATED_PNG],
  ])),

  /** 声明为封面的资源字节损坏：导入失败（不造一个「有效封面 URL」糊过去） */
  'epub3-broken-cover': () => zipOf(pkgEntries(opfOf({
    title: '坏封面样本',
    manifest: itemXml('ch1', 'ch1.xhtml') + itemXml('cover-img', 'images/cover.png', { type: 'image/png', attrs: ' properties="cover-image"' }),
    spine: itemrefXml('ch1'),
  }), [['OEBPS/images/cover.png', TRUNCATED_PNG]])),

  /** 未使用的 manifest 图片条目不要求格式受支持：字节是垃圾也照读整本（不该拒） */
  'epub3-unused-bad-image': () => zipOf(pkgEntries(opfOf({
    title: '未用坏图样本',
    manifest: itemXml('ch1', 'ch1.xhtml') + itemXml('junk', 'images/junk.png', { type: 'image/png' }),
    spine: itemrefXml('ch1'),
  }), [['OEBPS/images/junk.png', '不是 PNG 的字节']])),

  /**
   * **结构完整、浏览器解不开**的两张图（真解码归浏览器验收门 `tests/browser/epub-reader.test.ts`）。
   * 它们与 `epub3-broken-image`（缺 IEND，导入期就拒）刻意不同：这两份字节逐项过得了本仓的容器结构
   * 核对（PNG 三个 chunk 的 CRC 全对到 IEND；GIF 头与 trailer 齐备），却没有任何解码器能渲染
   * （PNG 的 IHDR 位深/色型组合非法；GIF 的帧数据整段不存在）。真站上被 CDN 重排过的图正是这一形态。
   * 阅读器必须把「解不开」如实显示成加载失败，且**不许塌掉预留的那块盒子**（跳版）。
   */
  'epub3-undecodable-image': () => zipOf(pkgEntries(opfOf({
    title: '解不开的图样本',
    manifest: itemXml('ch1', 'ch1.xhtml')
      + itemXml('badpng', 'images/bad.png', { type: 'image/png' })
      + itemXml('badgif', 'images/bad.gif', { type: 'image/gif' }),
    spine: itemrefXml('ch1'),
  }), [
    ['OEBPS/ch1.xhtml', xhtmlOf('第一章',
      '<p id="a">甲<img src="images/bad.png" alt="结构完整却解不开的 PNG"/></p>'
      + '<p id="b">乙<img src="images/bad.gif" alt="只剩 trailer 的 GIF"/></p>')],
    ['OEBPS/images/bad.png', PNG_INVALID_IHDR],
    ['OEBPS/images/bad.gif', GIF_DATA_LOST],
  ])),

  /**
   * 活动内容样本：脚本/内嵌框/对象/表单/样式/事件属性/CSS url 与三种非书内 href。
   * 全部安全去除并记告警；正文文字一个不丢——「移除了什么」必须能从告警看出来。
   * 带一份真目录：这样告警里只有「安全去除」这一类，不会混进合成目录那条（本样本要断言的就是那几条）。
   */
  'epub3-active-content': () => oneChapterWithNav([
    ['OEBPS/nav.xhtml', '<?xml version="1.0" encoding="UTF-8"?>\n'
      + '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目录</title></head><body>'
      + '<nav epub:type="toc"><ol><li><a href="ch1.xhtml#a">甲</a></li></ol></nav></body></html>'],
    ['OEBPS/ch1.xhtml', xhtmlOf('第一章',
      '<p id="a" onclick="evil()" style="background:url(http://example.invalid/bg.png)">点击这里</p>'
      + '<script>alert(1)</script><iframe src="https://example.invalid/frame"></iframe>'
      + '<object data="x.swf"></object><form action="/x"><input name="a"/></form>'
      + '<style>p{color:red}</style>'
      + '<p><a href="javascript:void(0)">JS 链</a><a href="file:///etc/passwd">FILE 链</a>'
      + '<a href="data:text/html,x">DATA 链</a><a href="https://example.invalid/page">外站链</a></p>'
      + '<p id="b">正文保留</p>')],
  ]),

  /** 超深正文（200 层 div）：默认深度预算 128 就要报错——没有预算的递归走法会吃穿调用栈 */
  'epub3-doc-too-deep': () => zipOf(pkgEntries(opfOf({
    title: '超深正文样本', manifest: itemXml('ch1', 'ch1.xhtml'), spine: itemrefXml('ch1'),
  }), [['OEBPS/ch1.xhtml', xhtmlOf('第一章', nestedDivs(200, '很深'))]])),

  /** 超宽正文（300 个行内元素）：默认预算下读得出，节点预算缩到 200 后必须报错并点名这份文档 */
  'epub3-doc-too-wide': () => zipOf(pkgEntries(opfOf({
    title: '超宽正文样本', manifest: itemXml('ch1', 'ch1.xhtml'), spine: itemrefXml('ch1'),
  }), [['OEBPS/ch1.xhtml', xhtmlOf('第一章', '<p id="a">' + '<i>字</i>'.repeat(300) + '</p>')]])),

  /**
   * EPUB2 旧式命名锚点：NCX 的四个目标分别指向 `<a name="legacy">`（只有 name）、
   * `<a name="both" id="both">`（name 与 id 双写，HTML4 时代的推荐写法，同一个落点）与
   * `<a id="alpha" name="beta">`（一个元素上两个**不同**的名字，指向同一个落点）。
   * 只认 `id` 的实现会把其中三条目录目标当成「锚点不存在」而拒整本。
   */
  'epub2-named-anchor': () => zipOf([
    ['META-INF/container.xml', CONTAINER_OPF],
    ['OEBPS/content.opf', opfOf({
      version: '2.0',
      title: '命名锚点样本',
      manifest: itemXml('ch1', 'ch1.xhtml') + itemXml('ncx', 'toc.ncx', { type: NCX_MEDIA_TYPE }),
      spine: itemrefXml('ch1'),
      spineAttrs: ' toc="ncx"',
    })],
    ['OEBPS/toc.ncx', '<?xml version="1.0" encoding="UTF-8"?>\n'
      + '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">'
      + '<head><meta name="dtb:uid" content="bookid"/></head><docTitle><text>命名锚点</text></docTitle><navMap>'
      + '<navPoint id="n1" playOrder="1"><navLabel><text>命名锚点</text></navLabel><content src="ch1.xhtml#legacy"/></navPoint>'
      + '<navPoint id="n2" playOrder="2"><navLabel><text>双写锚点</text></navLabel><content src="ch1.xhtml#both"/></navPoint>'
      + '<navPoint id="n3" playOrder="3"><navLabel><text>别名一</text></navLabel><content src="ch1.xhtml#alpha"/></navPoint>'
      + '<navPoint id="n4" playOrder="4"><navLabel><text>别名二</text></navLabel><content src="ch1.xhtml#beta"/></navPoint>'
      + '</navMap></ncx>'],
    ['OEBPS/ch1.xhtml', xhtmlOf('第一章',
      '<h1>第一章</h1><p><a name="legacy"></a>甲</p><p><a name="both" id="both"></a>乙</p><p><a id="alpha" name="beta"></a>丙</p>')],
  ]),

  /**
   * 被引用的图片在 encryption.xml 里（内容 DRM/混淆）：导入必须点名「被加密」而不是「容器损坏」。
   * 字节故意是混淆过的垃圾——按字节报错会把原因说成「图片坏了」，读者据此去换图是白费力气。
   */
  'epub3-encrypted-image': () => zipOf(pkgEntries(opfOf({
    title: '加密图片样本',
    manifest: itemXml('ch1', 'ch1.xhtml') + itemXml('fig', 'images/fig.png', { type: 'image/png' }),
    spine: itemrefXml('ch1'),
  }), [
    ['OEBPS/ch1.xhtml', xhtmlOf('第一章', '<p id="a">甲<img src="images/fig.png" alt="加密图"/></p>')],
    ['OEBPS/images/fig.png', '被 EPUB 加密（混淆）过的字节'],
    ['META-INF/encryption.xml', encryptionXml(['OEBPS/images/fig.png'])],
  ])),

  /**
   * media-type 声明的大小写与参数：spine 项的 `application/xhtml+xml; charset=utf-8` 与
   * 导航文档的 `Application/XHTML+XML` 都是同一件事（RFC 2046 的 media type 不区分大小写、参数不改变种类）。
   * 字面比对的实现会把整本拒掉。导航第二条 `#top` 指向导航文档自己的锚点：导航文档也因此成为
   * 「可达文档」，它的声明同样要过 XHTML 那道判定。
   */
  'epub3-parameter-media-type': () => zipOf([
    ['META-INF/container.xml', CONTAINER_OPF],
    ['OEBPS/content.opf', opfOf({
      title: '声明形态样本',
      manifest: itemXml('ch1', 'ch1.xhtml', { type: 'application/xhtml+xml; charset=utf-8' })
        + itemXml('nav', 'nav.xhtml', { type: 'Application/XHTML+XML', attrs: ' properties="nav"' }),
      spine: itemrefXml('ch1'),
    })],
    ['OEBPS/nav.xhtml', '<?xml version="1.0" encoding="UTF-8"?>\n'
      + '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目录</title></head><body>'
      + '<h1 id="top">目录</h1>'
      + '<nav epub:type="toc"><ol>'
      + '<li><a href="ch1.xhtml#a">甲</a></li><li><a href="#top">本页顶</a></li>'
      + '</ol></nav></body></html>'],
    ['OEBPS/ch1.xhtml', xhtmlOf('第一章', CH1_BODY)],
  ]),

  /**
   * 封面优先级：同时声明 EPUB3 的 `properties="cover-image"`（cover3）与 EPUB2 的
   * `meta name="cover"`（cover2），必须取 EPUB3 那条。
   * 两处都声明时只登记获胜的那份；EPUB2 那条故意给垃圾字节——若实现取错了，这里会当场报错
   * （而不是悄悄换一张封面糊过去）。
   */
  'epub3-cover-priority': () => zipOf(pkgEntries(opfOf({
    title: '封面优先级样本',
    meta: '<meta name="cover" content="cover2"/>',
    manifest: itemXml('ch1', 'ch1.xhtml')
      + itemXml('cover2', 'images/cover2.png', { type: 'image/png' })
      + itemXml('cover3', 'images/cover3.png', { type: 'image/png', attrs: ' properties="cover-image"' }),
    spine: itemrefXml('ch1'),
  }), [
    ['OEBPS/images/cover3.png', TINY_PNG],
    ['OEBPS/images/cover2.png', 'EPUB2 那条封面声明的字节（不该被采纳）'],
  ])),
}

/** 单章 + 一份被正文引用的独立 SVG：SVG 的三种拒绝样本共用这个骨架 */
function svgFigureBook(svg: string): Buffer {
  return zipOf(pkgEntries(opfOf({
    title: '矢量样本',
    manifest: itemXml('ch1', 'ch1.xhtml') + itemXml('fig', 'images/fig.svg', { type: 'image/svg+xml' }),
    spine: itemrefXml('ch1'),
  }), [
    ['OEBPS/ch1.xhtml', xhtmlOf('第一章', '<p id="a">甲<img src="images/fig.svg" alt="矢量图"/></p>')],
    ['OEBPS/images/fig.svg', '<?xml version="1.0" encoding="UTF-8"?>\n' + svg],
  ]))
}

/** 取一份 fixture；名字不在表里即抛错（表是封闭的） */
export function makeEpubFixture(name: string): Buffer {
  const build = FIXTURES[name]
  if (!build) throw new Error(`未知的 EPUB fixture：${name}（可用：${Object.keys(FIXTURES).join('、')}）`)
  return build()
}

/**
 * 图片字节样本（资源层的直接入参）：生产校验器（`services/epub/resources.ts`）以**字节**为入口，
 * 所以这些样本按字节导出，资源层用例不必为了测一张图去造整本 EPUB。同一批样本也被正文层的
 * fixture 复用（一张图两处引用只落一份资源，靠的就是同一个字节源）。
 */
export const IMAGE_SAMPLES = {
  /** 2×3 PNG（有效） */
  png: TINY_PNG,
  /** 同一张 PNG 砍掉 IEND：读得出宽高但容器没收尾 */
  pngTruncated: TRUNCATED_PNG,
  /** 2×3 JPEG，EXIF Orientation=1（无旋转） */
  jpeg: TINY_JPEG,
  /** 2×3 JPEG，EXIF Orientation=6（顺时针 90°）：显示宽高要折成 3×2 */
  jpegRotated: TINY_JPEG_ROTATED,
  /** 1×1 GIF89a */
  gif: TINY_GIF,
  /** 3×2 WebP（VP8L） */
  webp: TINY_WEBP,
  /** 结构逐项自洽（CRC 全对到 IEND）但 IHDR 位深非法的 2×3 PNG：本层放行，浏览器解不开 */
  undecodablePng: PNG_INVALID_IHDR,
  /** 头与 trailer 齐备、帧数据整段不存在的 1×1 GIF：本层放行，浏览器解不开 */
  undecodableGif: GIF_DATA_LOST,
} as const
