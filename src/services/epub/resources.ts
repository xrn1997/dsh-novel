import type { Element } from 'domhandler'
import { imageSize } from 'image-size'
import type { EpubWarningLog } from './warnings.js'
import { WARN_ACTIVE_ATTR, WARN_CSS_ATTR, WARN_REMOVED } from './warnings.js'
import { crc32Unsigned } from './archive.js'
import { EpubImportError } from './errors.js'
import { normalizeMediaType, resolveEpubHref } from './package.js'
import {
  attrOf, childElements, decodeEpubXml, isElement, localName, parseXml, textOf, xmlBudget,
  type XmlBudget, type XmlLimits,
} from './xml.js'

/**
 * 资源层：图片**类型/尺寸验证**与**受限 SVG 重建**。本层不认识书架、不写盘、不发请求——
 * 它只回答「这些字节能不能当作一张图交给浏览器、交给它的显示宽高是多少」。
 *
 * 四条口径（改这一层先读它们）：
 *
 * ① **不信声明，也不只读文件头**。manifest 声明的 MIME 必须与魔数一致（`image/jpg` 这种常见别名按
 *    `image/jpeg` 归一）；读图库给出的宽高只是起点——容器结构还要完整（PNG 逐 chunk 核 CRC 到 IEND、
 *    JPEG 走到 EOI、GIF 看 trailer、WebP 核 RIFF 长度）。**「读得出宽高」不等于浏览器解得开**：
 *    截断的图在文件头里照样有尺寸，按它放行就等于把坏图当可读资源交出去。
 * ② **显示宽高要把 EXIF 旋转折进去**（Orientation 5–8 交换宽高）。交出去的宽高是阅读器首帧占位用的，
 *    折错了不是「显示旋转」，而是图一加载完就跳版。
 * ③ **可见图形宁报错不删掉**。独立 SVG 只按白名单重建；白名单外的可见元素（`foreignObject`/`use`/
 *    嵌套 `image`/`pattern`…）报错点名资源，而不是删掉这一块冒充成功（图形看起来还在，其实少了）。
 *    活动内容（`script`/`style` 元素、事件属性、`style` 属性）剥除并留告警——那不是「内容」。
 * ④ **SVG 单图包装解析成它包的那张栅格**。封面常见写法是一层 `<svg>` 里只放一个缩放过的 `<image>`：
 *    那不是矢量图，把它当独立 SVG 交给浏览器会多一层壳，还可能被其中的外链拖去请求书外资源。
 */

type RasterFamily = 'jpeg' | 'png' | 'gif' | 'webp'

export type RasterMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
export type RasterExt = 'jpg' | 'png' | 'gif' | 'webp'

/** 声明类型 → 家族。`image/jpg` 不是标准名，但真实书里很多，按 jpeg 收（不为此拒掉整本书） */
const DECLARED_TYPES: ReadonlyMap<string, RasterFamily> = new Map<string, RasterFamily>([
  ['image/jpeg', 'jpeg'], ['image/jpg', 'jpeg'], ['image/png', 'png'], ['image/gif', 'gif'], ['image/webp', 'webp'],
])

/** 家族 → 权威 MIME 与安全扩展名（扩展名只从这里取：磁盘上的名字不携带 manifest 的任何声明） */
const FAMILY_FACTS: Readonly<Record<RasterFamily, { mediaType: RasterMediaType; ext: RasterExt }>> = {
  jpeg: { mediaType: 'image/jpeg', ext: 'jpg' },
  png: { mediaType: 'image/png', ext: 'png' },
  gif: { mediaType: 'image/gif', ext: 'gif' },
  webp: { mediaType: 'image/webp', ext: 'webp' },
}

/** 读图库的 type 取值 → 家族（只收本插件支持的四种，别的如实报不支持） */
const SNIFFED_TYPES: ReadonlyMap<string, RasterFamily> = new Map<string, RasterFamily>([
  ['jpg', 'jpeg'], ['jpeg', 'jpeg'], ['png', 'png'], ['gif', 'gif'], ['webp', 'webp'],
])

/** SVG 的权威媒体类型（唯一字面量来源）：本层按它选路建/识别包装，导入层按它判「包装里包的还是 SVG」 */
export const SVG_MEDIA_TYPE = 'image/svg+xml'

/** 光栅图的验证结果：权威类型 + 安全扩展名 + **显示**宽高（EXIF 旋转已折算） */
export interface RasterFacts {
  readonly kind: 'raster'
  readonly mediaType: RasterMediaType
  readonly ext: RasterExt
  readonly width: number
  readonly height: number
}

/** 独立 SVG 的重建结果：静态、已净化的一段 SVG 文本；宽高未知时为 null（调用方按用途决定要不要拒） */
export interface SvgFacts {
  readonly kind: 'svg'
  readonly mediaType: 'image/svg+xml'
  readonly ext: 'svg'
  readonly content: string
  readonly width: number | null
  readonly height: number | null
}

/** SVG 单图包装：要的不是这份 SVG，而是它包着的**同一本书里**的那张栅格图 */
export interface SvgWrapperFacts {
  readonly kind: 'wrapper'
  readonly path: string
}

export type ImageFacts = RasterFacts | SvgFacts | SvgWrapperFacts

export interface ImageValidationOptions {
  /** 唯一标签：报错点名它（调用方拼好「资源名 + 引用处文档」），也用作 SVG 解析预算里的点名 */
  readonly what: string
  /** 资源自身的书内路径（解析 SVG 内部 href 的基准） */
  readonly path: string
  /** manifest 声明的 MIME（类型一致性的判据；权威类型由内容决定） */
  readonly declaredMediaType: string
  readonly imagePixels: number
  readonly domLimits: XmlLimits
  /** 告警出口：SVG 里被剥除的活动内容/属性按同一条合并口径进这里 */
  readonly warnings: EpubWarningLog
}

/** 按声明选路：SVG 走重建/包装识别，其余走光栅验证（声明类型本身也要在受支持之列） */
export function validateImage(bytes: Buffer, opts: ImageValidationOptions): ImageFacts {
  const declared = normalizeMediaType(opts.declaredMediaType)
  if (declared === SVG_MEDIA_TYPE) return classifySvg(bytes, opts)
  const family = DECLARED_TYPES.get(declared)
  if (family === undefined) {
    throw new EpubImportError(`不支持的图片类型（${opts.declaredMediaType}）：${opts.what}`)
  }
  return validateRaster(bytes, { what: opts.what, family, imagePixels: opts.imagePixels })
}

/** 光栅图：魔数/MIME 一致 + 容器完整 + 像素在预算内，最后把 EXIF 旋转折进显示宽高 */
export function validateRaster(bytes: Buffer, opts: {
  readonly what: string
  readonly family: RasterFamily
  readonly imagePixels: number
}): RasterFacts {
  const size = sniff(bytes, opts.what)
  const sniffed = size.type === undefined ? undefined : SNIFFED_TYPES.get(size.type)
  if (sniffed === undefined) {
    throw new EpubImportError(`不支持的图片格式（${size.type ?? '认不出'}）：${opts.what}`)
  }
  if (sniffed !== opts.family) {
    throw new EpubImportError(`图片声明为 ${opts.family}，实际内容是 ${sniffed}：${opts.what}`)
  }
  const width = positiveDimension(size.width)
  const height = positiveDimension(size.height)
  if (width === null || height === null) {
    throw new EpubImportError(`图片尺寸读不出（文件头不给宽高）：${opts.what}`)
  }
  if (width * height > opts.imagePixels) {
    throw new EpubImportError(`图片像素超过上限 ${opts.imagePixels}（${width}×${height}）：${opts.what}`)
  }
  verifyContainer(bytes, opts.family, opts.what)
  // EXIF 的 5–8 是「带 90° 倍数旋转」的那四种：显示宽高交换；1/缺省保持原样
  const rotated = opts.family === 'jpeg' && size.orientation !== undefined && size.orientation >= 5 && size.orientation <= 8
  return {
    kind: 'raster',
    ...FAMILY_FACTS[opts.family],
    width: rotated ? height : width,
    height: rotated ? width : height,
  }
}

/** 读图库入口（只认 Uint8Array）：它抛的是宿主 TypeError，一律披上本层的类并点名资源 */
function sniff(bytes: Buffer, what: string): { width?: number; height?: number; type?: string; orientation?: number } {
  try {
    return imageSize(bytes)
  } catch (e) {
    throw new EpubImportError(`${what}：读不出图片格式（容器损坏，或不是受支持的图片：${e instanceof Error ? e.message : String(e)}）`)
  }
}

function positiveDimension(value: number | undefined): number | null {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return null
  return Math.floor(value)
}

// ── 容器结构核对 ───────────────────────────────────────────────────────────────

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * 按格式核对容器结构：PNG 逐 chunk 核 CRC、JPEG 走到 EOI、GIF 看 trailer、WebP 核 RIFF 长度。
 *
 * 这不是像素解码（真解码归浏览器验收门），而是**结构完整性**：截断/损坏的字节在文件头里读得出尺寸，
 * 却是浏览器解不开的图——按「读得出宽高」放行就等于把坏图当可读资源交出去。
 */
function verifyContainer(bytes: Buffer, family: RasterFamily, what: string): void {
  switch (family) {
    case 'png': return verifyPng(bytes, what)
    case 'jpeg': return verifyJpeg(bytes, what)
    case 'gif': return verifyGif(bytes, what)
    case 'webp': return verifyWebp(bytes, what)
  }
}

function verifyPng(bytes: Buffer, what: string): void {
  if (bytes.length < PNG_SIGNATURE.length || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new EpubImportError(`PNG 数据损坏（签名不对）：${what}`)
  }
  let p = 8
  while (p + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(p)
    const end = p + 12 + length
    if (end > bytes.length) throw new EpubImportError(`PNG 数据损坏（chunk 长度越界）：${what}`)
    const type = bytes.toString('latin1', p + 4, p + 8)
    const expected = bytes.readUInt32BE(p + 8 + length)
    const actual = crc32Unsigned(bytes.subarray(p + 4, p + 8 + length)) >>> 0
    if (expected !== actual) throw new EpubImportError(`PNG 数据损坏（chunk ${type} 的 CRC 对不上）：${what}`)
    if (type === 'IEND') return
    p = end
  }
  throw new EpubImportError(`PNG 数据损坏（缺 IEND，文件被截断）：${what}`)
}

function verifyJpeg(bytes: Buffer, what: string): void {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new EpubImportError(`JPEG 数据损坏（没有 SOI）：${what}`)
  }
  let p = 2
  while (p + 1 < bytes.length) {
    if (bytes[p] !== 0xff) { p += 1; continue }
    let marker = bytes[p + 1]
    while (marker === 0xff && p + 2 < bytes.length) { p += 1; marker = bytes[p + 1] }
    if (marker === 0xd9) return                                     // EOI：完整
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { p += 2; continue }   // 不带长度段的标记
    if (marker === 0xda) return verifyJpegScan(bytes, p, what)      // SOS：之后是熵编码数据，找 EOI
    if (p + 4 > bytes.length) break
    const length = bytes.readUInt16BE(p + 2)
    if (length < 2) throw new EpubImportError(`JPEG 数据损坏（段长非法）：${what}`)
    p += 2 + length
  }
  throw new EpubImportError(`JPEG 数据损坏（没有 EOI，文件被截断）：${what}`)
}

/** 熵编码段里 `0xFF` 后跟非填充字节才是标记；`FFD9` 是 EOI（`FF00`/`FFD0-D7` 是数据） */
function verifyJpegScan(bytes: Buffer, from: number, what: string): void {
  for (let p = from + 2; p + 1 < bytes.length; p += 1) {
    if (bytes[p] !== 0xff) continue
    const next = bytes[p + 1]
    if (next === 0xff || next === 0x00 || (next >= 0xd0 && next <= 0xd7)) continue
    if (next === 0xd9) return
  }
  throw new EpubImportError(`JPEG 数据损坏（没有 EOI，文件被截断）：${what}`)
}

function verifyGif(bytes: Buffer, what: string): void {
  if (bytes.length < 14 || !/^GIF8[79]a$/.test(bytes.toString('latin1', 0, 6))) {
    throw new EpubImportError(`GIF 数据损坏（文件头不对）：${what}`)
  }
  if (bytes[bytes.length - 1] !== 0x3b) {
    throw new EpubImportError(`GIF 数据损坏（缺 trailer 0x3B，文件被截断）：${what}`)
  }
}

function verifyWebp(bytes: Buffer, what: string): void {
  if (bytes.length < 12 || bytes.toString('latin1', 0, 4) !== 'RIFF' || bytes.toString('latin1', 8, 12) !== 'WEBP') {
    throw new EpubImportError(`WebP 数据损坏（RIFF/WEBP 文件头不对）：${what}`)
  }
  const declared = bytes.readUInt32LE(4) + 8
  if (declared !== bytes.length) {
    throw new EpubImportError(`WebP 数据损坏（RIFF 声明长度 ${declared}，实际 ${bytes.length}）：${what}`)
  }
}

// ── 独立 SVG：单图包装识别与白名单重建 ─────────────────────────────────────────

/** 重建白名单（配套设计的逐项清单）：只有这些元素会出现在产物里 */
const SVG_ELEMENTS: ReadonlySet<string> = new Set([
  'svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'text', 'tspan', 'defs', 'linearGradient', 'radialGradient', 'stop',
])

/** 非渲染元数据：丢掉它不改变图形 */
const SVG_METADATA_ELEMENTS: ReadonlySet<string> = new Set(['title', 'desc', 'metadata'])

/** 活动内容元素：剥除并留告警（与 XHTML 同一条口径） */
const SVG_ACTIVE_ELEMENTS: ReadonlySet<string> = new Set(['script', 'style'])

/** 可被 `url(#id)` 引用的定义类元素：只有它们算「已登记的渐变」 */
const SVG_GRADIENT_ELEMENTS: ReadonlySet<string> = new Set(['linearGradient', 'radialGradient'])

/** 包装识别时忽略的**分组**容器：`g` 自己不产生可见图形，但它的子元素才是一张张图元 */
const SVG_GROUP_CONTAINERS: ReadonlySet<string> = new Set(['g'])

/**
 * 包装识别时整个跳过的**非渲染**容器：`defs` 里的东西（渐变/图案/裁剪路径…）只是「登记在那里备引用」，
 * 一律不直接渲染。把它们当成可见节点，`<svg><defs><linearGradient/></defs><image/></svg>` 这种
 * 常见封面包装就会被误判成「不止一张图」而按独立 SVG 重建、再因 `image` 不在白名单里拒整本。
 * 渐变登记走 `registerGradients`，它扫全树（含 defs），不受这里跳过的影响。
 */
const SVG_NON_RENDERING: ReadonlySet<string> = new Set(['defs'])

/** 保留的属性：几何/变换/文本/颜色/渐变定义。别的属性要么是元数据（丢），要么报不支持 */
const SVG_ATTRS: ReadonlySet<string> = new Set([
  'xmlns', 'version', 'width', 'height', 'viewBox', 'preserveAspectRatio',
  'transform', 'id',
  'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'd', 'points',
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
  'stroke-dasharray', 'stroke-dashoffset', 'stroke-miterlimit', 'stroke-opacity', 'opacity', 'color',
  'stop-color', 'stop-opacity', 'offset',
  'gradientUnits', 'gradientTransform', 'spreadMethod', 'fx', 'fy',
  'font-family', 'font-size', 'font-weight', 'font-style', 'text-anchor', 'letter-spacing',
  'word-spacing', 'dominant-baseline', 'dx', 'dy',
])

/** 属性值里出现 url 引用：必须整值就是一个 `url(#id)`，且指向同文件已登记的渐变。
 *  CSS 的 `url()` 函数名**大小写不敏感**（`URL(#g)` 与 `url(#g)` 等价），所以匹配也必须不敏感：
 *  漏掉大写写法就会把该值当普通属性原样保留，而渐变定义那边已改写成安全 ID——引用成了死链，
 *  图形静默消失。 */
const URL_REF = /url\(/i
const URL_REF_ONLY = /^url\(\s*['"]?#([^)'"\s]+)['"]?\s*\)$/i


const SVG_NS = 'http://www.w3.org/2000/svg'

/**
 * 独立 SVG：只包一张书内栅格就当包装交回那张栅格（调用方按光栅验证它），
 * 否则按白名单重建为一份静态 SVG。
 */
function classifySvg(bytes: Buffer, opts: ImageValidationOptions): SvgFacts | SvgWrapperFacts {
  const budget = xmlBudget(`SVG 图片 ${opts.what}`, opts.domLimits)
  const root = parseSvg(bytes, opts, budget)
  const wrapper = soleRasterHref(root)
  if (wrapper !== null) return { kind: 'wrapper', path: wrapperPath(wrapper, opts) }
  const builder = new SvgBuilder(opts.what, budget, opts.warnings)
  const content = builder.emit(root)
  return { kind: 'svg', mediaType: SVG_MEDIA_TYPE, ext: 'svg', content, width: builder.width, height: builder.height }
}

function parseSvg(bytes: Buffer, opts: ImageValidationOptions, budget: XmlBudget): Element {
  let text: string
  try {
    text = decodeEpubXml(bytes)
  } catch (e) {
    if (e instanceof EpubImportError) throw new EpubImportError(`${opts.what}：${e.message}`)
    throw e
  }
  const root = parseXml(text, budget)
  if (localName(root.name) !== 'svg') {
    throw new EpubImportError(`${opts.what}：声明为 SVG 的资源根元素不是 svg（是 ${root.name}）`)
  }
  return root
}

/** 包装里的 href 按 SVG 自身目录解析（与正文链接同一套归档内寻址）：解析不了即报错，绝不发请求 */
function wrapperPath(href: string, opts: ImageValidationOptions): string {
  try {
    const resolved = resolveEpubHref(opts.path, href)
    if (resolved.path === opts.path) throw new EpubImportError('指向自己（那不是一张图）')
    return resolved.path
  } catch (e) {
    if (e instanceof EpubImportError) throw new EpubImportError(`${opts.what}：SVG 包装里的图片引用不可用（${e.message}）`)
    throw e
  }
}

/**
 * 是不是「只包一张栅格」的包装：除元数据与被动容器外，整棵图里只剩一个 `<image>`。
 * 返回它的 href；不是包装则 null——此时按独立 SVG 重建，而 `image` 不在白名单里会如实报不支持。
 *
 * 两个消费者共用这一份判据（不许有第二份抄本）：`classifySvg` 判**独立 SVG 资源**是不是单图包装，
 * `import.ts` 判**正文里整页的内联 SVG** 是不是「一页只有一张书内图」的封面/图形页。
 */
export function soleRasterHref(root: Element): string | null {
  const visible: Element[] = []
  const collect = (el: Element): void => {
    for (const child of el.children) {
      if (!isElement(child)) continue
      const name = localName(child.name)
      // defs 里的定义不渲染：整棵跳过（见 SVG_NON_RENDERING）
      if (SVG_NON_RENDERING.has(name)) continue
      if (SVG_METADATA_ELEMENTS.has(name) || SVG_GROUP_CONTAINERS.has(name)) {
        collect(child)
        continue
      }
      visible.push(child)
      if (name !== 'image') collect(child)
    }
  }
  collect(root)
  if (visible.length !== 1 || localName(visible[0].name) !== 'image') return null
  const href = attrOf(visible[0], 'href')
  return href === null || href.trim() === '' ? null : href.trim()
}

/** 重建器：白名单元素/属性 + ID 重写（同文件渐变引用），宽高从根属性或 viewBox 取 */
class SvgBuilder {
  private readonly idMap = new Map<string, string>()
  private readonly gradientIds = new Set<string>()
  private nextId = 0

  width: number | null = null
  height: number | null = null

  constructor(
    private readonly what: string,
    private readonly budget: XmlBudget,
    private readonly warnings: EpubWarningLog,
  ) {}

  emit(root: Element): string {
    this.registerGradients(root)
    return this.element(root, true)
  }

  /** 先登记全部渐变 ID（引用可以写在定义之前），再逐元素重建 */
  private registerGradients(el: Element): void {
    if (SVG_GRADIENT_ELEMENTS.has(localName(el.name))) {
      const id = attrOf(el, 'id')
      if (id !== null && id !== '') this.gradientIds.add(id)
    }
    for (const child of el.children) if (isElement(child)) this.registerGradients(child)
  }

  private safeId(original: string): string {
    const hit = this.idMap.get(original)
    if (hit !== undefined) return hit
    const minted = `s${this.nextId++}`
    this.idMap.set(original, minted)
    return minted
  }

  private element(el: Element, root: boolean): string {
    const name = localName(el.name)
    if (SVG_ACTIVE_ELEMENTS.has(name)) {
      this.warnings.add(WARN_REMOVED, this.what, '移除了 SVG 里的活动内容（不执行书内脚本，不加载书内样式）', `<${name}>`)
      return ''
    }
    if (SVG_METADATA_ELEMENTS.has(name)) return ''
    if (!SVG_ELEMENTS.has(name)) {
      throw new EpubImportError(`${this.what}：SVG 里有本插件不支持的可见元素 <${name}>（不支持的图形不删掉冒充成功）`)
    }
    if (root) {
      const viewBox = attrOf(el, 'viewBox')
      this.width = svgLength(attrOf(el, 'width')) ?? viewBoxSize(viewBox, true)
      this.height = svgLength(attrOf(el, 'height')) ?? viewBoxSize(viewBox, false)
    }
    const attrs = this.attributes(el, root)
    let children = ''
    for (const child of el.children) {
      if (child.type === 'text') children += escapeText(child.data)
      else if (child.type === 'cdata') children += escapeText(textOf(child, this.budget))
      else if (isElement(child)) children += this.element(child, false)
    }
    return children === '' ? `<${name}${attrs}/>` : `<${name}${attrs}>${children}</${name}>`
  }

  private attributes(el: Element, root: boolean): string {
    const name = localName(el.name)
    const parts: string[] = []
    for (const [attr, value] of Object.entries(el.attribs)) {
      if (attr === 'style') {
        this.warnings.add(WARN_CSS_ATTR, this.what, '移除了 SVG 里的 style 属性（本插件不加载书内样式）', `<${name}>`)
        continue
      }
      if (/^on/i.test(attr)) {
        this.warnings.add(WARN_ACTIVE_ATTR, this.what, '移除了 SVG 里的事件属性（不执行书内脚本）', attr.toLowerCase())
        continue
      }
      if (attr === 'id') {
        parts.push(`id="${escapeAttr(this.safeId(value))}"`)
        continue
      }
      // 命名空间声明与编辑器/元数据属性（含 `:` 的、`data-*`、`class`）：不是可见内容，丢掉
      if (attr.startsWith('xmlns') || attr.startsWith('data-') || attr === 'class') continue
      // 带命名空间前缀的 href（`xlink:href`）不是元数据：在渐变上是**继承**（引用另一处渐变的 stop），
      // 在别处是外部引用——两者都改变可见外观。静默丢掉会让图形少一块却报成功：实测
      // `<linearGradient xlink:href="#base"/>` 被剥成空渐变、矩形失去填充且不留任何告警。
      // 不可支持的引用照本层口径点名报错（与 url(...)/白名单外元素同一条）。
      if (localName(attr) === 'href') {
        throw new EpubImportError(
          `${this.what}：SVG 的 <${name}> 用了 ${attr} 引用（本插件不支持渐变继承与外部引用，不静默丢掉）`,
        )
      }
      if (attr.includes(':')) continue
      if (URL_REF.test(value)) {
        // 只有 fill/stroke 支持同文件渐变引用；别的 url(...)（filter/mask/clip-path/marker-*）都是
        // 「引用了本插件没有的能力」——报错点名属性，不删掉那块图形冒充成功
        if (attr !== 'fill' && attr !== 'stroke') {
          throw new EpubImportError(`${this.what}：SVG 的 <${name}> 属性 ${attr} 用了 url(...) 引用（本插件只支持 fill/stroke 指向同文件渐变）`)
        }
        parts.push(`${attr}="${escapeAttr(this.rewriteUrl(value, name, attr))}"`)
        continue
      }
      if (!SVG_ATTRS.has(attr)) {
        throw new EpubImportError(`${this.what}：SVG 的 <${name}> 用了本插件不支持的属性 ${attr}（可能改变可见外观，不静默丢掉）`)
      }
      parts.push(`${attr}="${escapeAttr(value)}"`)
    }
    // 作为独立 <img> 渲染的 SVG 必须有根命名空间：原文件没写也补上，否则它不是一份可渲染的 SVG
    if (root && !parts.some((p) => p.startsWith('xmlns='))) parts.unshift(`xmlns="${SVG_NS}"`)
    return parts.length === 0 ? '' : ` ${parts.join(' ')}`
  }

  /** 渐变引用只许指向同文件已登记的渐变，并把 ID 重写成安全串（原 ID 不出现在产物里） */
  private rewriteUrl(value: string, element: string, attr: string): string {
    const m = URL_REF_ONLY.exec(value.trim())
    if (m === null) {
      throw new EpubImportError(`${this.what}：SVG 的 <${element}> 属性 ${attr} 不是可支持的同文件引用：${value}`)
    }
    const id = m[1]
    if (!this.gradientIds.has(id)) {
      throw new EpubImportError(`${this.what}：SVG 引用了本文件里没有登记的渐变 #${id}（不支持的引用不改成别的）`)
    }
    return `url(#${this.safeId(id)})`
  }
}

/** SVG 长度：只认无单位与 `px`（别的单位/百分比退到 viewBox——不猜 DPI） */
function svgLength(value: string | null): number | null {
  if (value === null) return null
  const m = /^\s*([0-9]*\.?[0-9]+)\s*(px)?\s*$/.exec(value)
  if (m === null) return null
  const n = Number.parseFloat(m[1])
  return Number.isFinite(n) && n > 0 ? n : null
}

/** viewBox 的第三/第四个数是用户单位下的宽/高（只在显式宽高不可解析时兜底） */
function viewBoxSize(value: string | null, width: boolean): number | null {
  if (value === null) return null
  const parts = value.trim().split(/[\s,]+/).map((p) => Number.parseFloat(p))
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null
  const n = width ? parts[2] : parts[3]
  return n > 0 ? n : null
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
}

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
