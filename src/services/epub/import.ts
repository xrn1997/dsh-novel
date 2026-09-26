import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Element } from 'domhandler'
import type { ChapterContent, ContentNode, LocalImportWarning, NavigationItem, ReadingTarget } from '../../shared/wire.js'
import { DEFAULT_EPUB_LIMITS, openEpubArchive, type EpubArchive, type EpubLimits } from './archive.js'
import { containerNode, convertXhtml, documentTitle, scanXhtml, svgOnlyPageReason, type SvgOnlyPage } from './documents.js'
import { EpubWarningLog } from './warnings.js'
import { EpubImportError } from './errors.js'
import {
  epubBaseName, readEpubPackage, resolveEpubHref,
  type EpubHref, type EpubManifestItem, type EpubNavItem,
} from './package.js'
import { soleRasterHref, SVG_MEDIA_TYPE, validateImage } from './resources.js'
import { decodeEpubXml, parseXml, xmlBudget, type XmlBudget, type XmlLimits } from './xml.js'

/**
 * 导入编排：把一份 EPUB 字节变成「只有规范化文档与已验证资源」的指定目录 + 一份索引（`EpubImportData`）。
 *
 * 本层**只写 `outputDir`**：不发布、不写元数据、不认识书架与 HTTP（发布、提交标记与清理是服务层的事）。
 * 它把包层（结构）、文档层（图文规范化）、资源层（图片验证）串起来，并独占两件事：
 *
 * ① **opaque ID 的铸造**（`d0`/`n12`/`a3`/`r7`）：写盘路径与锚点目标都由它拼；原书的 id、文件名、
 *    磁盘布局既不进 wire 也进不了路径。
 * ② **两遍走**（分工与理由另见 `documents.ts` 头注）：
 *    第一遍顺主序列 + 导航目标 + 书内链接把要用的文档收全（已访问集合自然终止环路），建齐文档 ID、
 *    锚点映射与「这份文档里引用了哪些图片」；第二遍才逐份转换、绑目标、落盘。
 *    第二遍是**逐份**的：每份文档解析 → 转换 → 写盘 → 释放，不把整本 DOM 常驻在内存里。
 *    图片在第一遍与第二遍之间**预取并验证完**：转换是同步遍历，读盘不能藏在里面。
 *    代价是每份文档读两遍（两遍走必然如此）：归档的累计解压预算按实际读入量计，
 *    512 MiB 对一部书仍宽裕——拿它换「不整本常驻」是划算的。
 *
 * 三条口径（改这一层先读它们）：
 *
 * ① **章按 spine 主序列**，补充文档（脚注/附录）可打开但不计章；只有**可达**的补充文档才解析
 *    （导航或书内链接指到的），未使用的 manifest 条目不要求受支持。
 * ② **失效目标一律失败**：导航/正文链接指到的文档与锚点必须真的存在（坏目标不冒充成功），
 *    重复锚点在扫描期就报错，远程图片与损坏/超预算/**被加密**（原因必须点名加密，不许按混淆字节
 *    说成「损坏」）的图片让导入失败并点名资源。
 *    **唯一例外**：锚点存在过、却随**被剥离的内容**（正文内联 SVG 等，口径见 `documents.ts` 注③④）
 *    一起不在树上了。那不是「我们读不懂这个目标」——锚点确实在源文档里，是**我们自己**剥掉了承载
 *    它的图形，事实清楚——所以走降级 + 告警（`epub-degraded-anchor`）而不是拒整本：
 *    **导航目标**降级成「该文档 + 无片段」（跳到该文档开头，导航仍然可用），**正文内链**降级成
 *    纯文本（只留子内容、不出 link 节点）。两者的告警都点名文档与锚点，用户看得见降级事实。
 *    拼写错、指向从未存在的 id 仍然按坏书拒收：降级只认「被剥离的内容里确实有过这个名字」。
 * ③ **被剥除的活动内容只记告警**（丢了什么看得见），**可见图形不支持则报错**——两者不是一回事。
 *    例外是正文内联 SVG：剥离 + 告警，只有它是该文档唯一内容时才报错（口径与理由见 `documents.ts` 头注③）。
 */

/** 认得的正文媒体类型（唯一一项）：spine 或链接指向别的类型即「不是可读正文」 */
const XHTML_MEDIA_TYPE = 'application/xhtml+xml'

/** 不可跟随 scheme：这些 href 不是「外站链接」而是活动/本机资源引用，同样只留文字 */
const UNFOLLOWABLE_SCHEMES: ReadonlySet<string> = new Set(['javascript', 'vbscript', 'data', 'file', 'about', 'chrome', 'blob'])

const WARN_UNFOLLOWABLE = 'epub-link-not-followable'
const WARN_EXTERNAL_LINK = 'epub-external-link'
/** 目标锚点随被剥离的内容一起消失（我们自己剥的）：导航降级到文档开头、内链降级成纯文本 */
const WARN_DEGRADED_ANCHOR = 'epub-degraded-anchor'
/** 整页只有一棵内联 SVG 的图形页（EPUB3 推荐的封面写法）：按其内唯一一张书内图导成一图章节 */
const WARN_SVG_IMAGE_PAGE = 'epub-svg-image-page'

/** 降级告警的两种动作文案（同码不同动作 → 各自成条：导航降级与内链降级是两件不同的事） */
const DEGRADED_NAV = '导航目标锚点随被剥离的内容（内联 SVG 等）一起消失，已降级到该文档开头'
const DEGRADED_LINK = '正文链接的目标锚点随被剥离的内容（内联 SVG 等）一起消失，已降级成纯文本'

/** 主序列阅读单元：`index` 就是章号（补充文档不在这个表里） */
export interface EpubChapterRef {
  readonly index: number
  readonly documentId: string
  /** 章名（文档 title；缺则取文档基础名）——目录不覆盖时的章名来源 */
  readonly label: string
}

/** 一份落盘文档：`file` 是相对 outputDir 的路径（只由 opaque ID 生成） */
export interface EpubDocumentRef {
  readonly id: string
  readonly file: string
  /** 在主序列里的章号；补充文档为 null */
  readonly index: number | null
  readonly label: string
  /** 文档在原书里的逻辑名（书内位置，离书即无意义）：排障与告警点名用，不是磁盘路径 */
  readonly path: string
}

/** 一份落盘资源：类型/尺寸是**验证结果**（不是 manifest 声明），扩展名只从这里取 */
export interface EpubResourceRef {
  readonly id: string
  readonly file: string
  readonly mediaType: string
  readonly bytes: number
  /** 光栅图的**显示**宽高（EXIF 旋转已折算）；SVG 为 null */
  readonly width: number | null
  readonly height: number | null
}

/** 导入结果（服务层据此发布目录、写元数据、入架） */
export interface EpubImportData {
  readonly title: string | null
  readonly author: string | null
  /** 阅读序列（按 spine 主序列；`index` 即章号）：章数只认它 */
  readonly chapters: readonly EpubChapterRef[]
  /** 展示用目录树（wire 形状；target 已绑到 opaque documentId/anchorId） */
  readonly items: readonly NavigationItem[]
  /** documentId → 落盘文档（含主序列与**可达**补充文档） */
  readonly documents: Readonly<Record<string, EpubDocumentRef>>
  /** resourceId → 落盘资源（只含被引用到的资源） */
  readonly resources: Readonly<Record<string, EpubResourceRef>>
  /** 封面资源 ID；无封面是 null（无封面不是失败） */
  readonly coverResourceId: string | null
  readonly warnings: readonly LocalImportWarning[]
}

/** 导入期唯一 ID 铸造器：四个命名空间各一条序列（`d`文档 / `n`节点 / `a`锚点 / `r`资源） */
class IdMinter {
  // 计数器的名字带 `n` 前缀：与下面的方法名（`node`/`anchor`…）同名会被类字段顶掉（实测：方法直接不见）
  private nDoc = 0
  private nNode = 0
  private nAnchor = 0
  private nRes = 0

  document(): string { return `d${this.nDoc++}` }
  node(): string { return `n${this.nNode++}` }
  anchor(): string { return `a${this.nAnchor++}` }
  resource(): string { return `r${this.nRes++}` }
}

/** 第一遍的每份文档：身份、锚点映射，以及转换期要用的图片绑定 */
interface ScannedDocument {
  readonly id: string
  readonly path: string
  readonly index: number | null
  readonly label: string
  readonly anchors: ReadonlyMap<string, string>
  /** 随被剥离的子树（内联 SVG、活动内容）一起消失的锚点名：目标绑定期据此降级（口径见头注②） */
  readonly strippedAnchors: ReadonlySet<string>
  readonly links: readonly string[]
  readonly images: readonly string[]
}

/** 已登记资源：`width/height` 是验证结果的显示宽高（SVG 可能为 null） */
interface RegisteredResource {
  readonly ref: EpubResourceRef
  readonly width: number | null
  readonly height: number | null
}

/**
 * 读一份 EPUB、把规范化文档与资源写进 `outputDir`，返回索引。所有失败都是 `EpubImportError`
 * 且点名书内位置。`limits` 是覆盖式的（与归档层同口径）：测试按需缩小某一项预算。
 */
export async function importEpub(bytes: Buffer, outputDir: string, limits: Partial<EpubLimits> = {}): Promise<EpubImportData> {
  const archive = await openEpubArchive(bytes, limits)
  try {
    return await orchestrate(archive, outputDir, limits)
  } finally {
    // 失败时归档自己已关（archive.ts 口径③），这里是两条路径共用的收尾；关闭是幂等的
    archive.close()
  }
}

async function orchestrate(archive: EpubArchive, outputDir: string, limits: Partial<EpubLimits>): Promise<EpubImportData> {
  const budget: EpubLimits = { ...DEFAULT_EPUB_LIMITS, ...limits }
  const domLimits: XmlLimits = { depth: budget.xmlDepth, nodes: budget.xmlNodes }
  const pkg = await readEpubPackage(archive, limits)
  const ids = new IdMinter()
  const warnings = new EpubWarningLog()
  // 包层的告警先入池（同码同文合并的第二处入口：包层的告警已经是成句文案，原样带过）
  for (const w of pkg.warnings) warnings.add(w.code, w.resource, w.message)

  const manifestByPath = new Map<string, EpubManifestItem>()
  for (const item of pkg.manifest.values()) manifestByPath.set(item.path, item)

  // ── 第一遍：文档集合、锚点映射、链接与图片清点 ──────────────────────────────
  const docs = new Map<string, ScannedDocument>()
  const queue: string[] = []
  const enqueue = async (docPath: string, index: number | null, context: string): Promise<void> => {
    if (docs.has(docPath)) return
    const item = manifestByPath.get(docPath)
    if (item === undefined) throw new EpubImportError(`${context}指向 manifest 里没有的文档：${docPath}`)
    // media-type 的比对只需相等判定：包层在读 manifest 时已归一小写并去掉参数（唯一实现在 package.ts）
    if (item.mediaType !== XHTML_MEDIA_TYPE) {
      throw new EpubImportError(`${context}指向的不是 XHTML 文档（media-type=${item.mediaType}）：${docPath}`)
    }
    const root = await readXhtml(archive, docPath, budget, domLimits)
    const budgetOfDoc = xmlBudget(docPath, domLimits)
    const scan = scanXhtml(root, budgetOfDoc, () => ids.anchor())
    docs.set(docPath, {
      id: ids.document(), path: docPath, index,
      label: documentTitle(root, budgetOfDoc) ?? epubBaseName(docPath),
      anchors: scan.anchors, strippedAnchors: scan.strippedAnchors, links: scan.links, images: scan.images,
    })
    queue.push(docPath)
  }

  // 主序列（spine 的 linear 项）按顺序拿章号：文档 ID 的铸造顺序就是阅读顺序
  for (const [index, docPath] of pkg.spine.entries()) await enqueue(docPath, index, 'OPF 主序列')
  // 导航指到的文档也算可达（目录要能跳到它，比如附录）；它可能本身就不在 spine 里
  for (const href of navTargets(pkg.navigation)) await enqueue(href.path, null, `导航目标（${href.path}）`)
  // 正文链接的传递闭包（活队列：新收的文档也要继续顺链走），已访问集合自然终止环路
  for (let at = 0; at < queue.length; at += 1) {
    const doc = docs.get(queue[at]) as ScannedDocument
    for (const link of doc.links) {
      const cls = classifyHref(link, doc.path)
      if (cls.kind !== 'internal') continue
      const target = manifestByPath.get(cls.href.path)
      if (target === undefined || target.mediaType !== XHTML_MEDIA_TYPE) continue   // 绑定期再按语境拒绝/降级
      await enqueue(cls.href.path, null, `${doc.path} 的书内链接`)
    }
  }

  // ── 资源登记（按书内路径去重；图片先于文档，封面最后）────────────────────────
  const byPath = new Map<string, RegisteredResource>()
  const resources: Record<string, EpubResourceRef> = {}

  const register = async (srcPath: string, context: string, requireSize: boolean): Promise<RegisteredResource> => {
    const hit = byPath.get(srcPath)
    if (hit !== undefined) return hit
    const item = manifestByPath.get(srcPath)
    if (item === undefined) throw new EpubImportError(`${context}引用的资源不在 manifest 里：${srcPath}`)
    const what = `${srcPath}（${context}）`
    // 被加密的资源在读字节/验格式**之前**拒绝：字节是混淆过的，按字节报错会把原因说成「图片损坏」，
    // 读者据此去换图是白费力气（真正的原因是本插件不提供解密）
    if (pkg.encryptedPaths.has(srcPath)) {
      throw new EpubImportError(`${what}：资源被加密（本插件不提供解密，正文里用到的它读不出）`)
    }
    // SVG 是 XML 文档（要解析成树），按 **XML 类别**的字节上限读——与 container/OPF/NCX/正文同一档；
    // 光栅图只做魔数与容器核对、不进解析器，按条目上限读。用 `entryBytes` 一把抓会让 SVG 默认能到
    // 32 MiB（预算表里 XML 那条写的是 8 MiB），解析器前的这道闸等于没有。
    // manifest 读入时已归一（`package.ts` 的 `normalizeMediaType`），这里只需相等判定。
    const cap = item.mediaType === SVG_MEDIA_TYPE ? budget.xmlBytes : budget.entryBytes
    const raw = await archive.read(srcPath, cap)
    const facts = validateImage(raw, {
      what, path: srcPath, declaredMediaType: item.mediaType,
      imagePixels: budget.imagePixels, domLimits, warnings,
    })
    if (facts.kind === 'wrapper') {
      // 单图包装：要的是它包着的那张栅格（同书内引用），按那份资源登记；包装本身不落盘
      const inner = manifestByPath.get(facts.path)
      if (inner !== undefined && inner.mediaType === SVG_MEDIA_TYPE) {
        throw new EpubImportError(`${what}：SVG 包装指向的还是 SVG（包装只允许包一张栅格图）`)
      }
      return register(facts.path, context, requireSize)
    }
    if (requireSize && (facts.width === null || facts.height === null)) {
      throw new EpubImportError(`${what}：SVG 缺少可用的宽高（width/height/viewBox 都没有），插图的占位尺寸无从确定`)
    }
    // 落盘的是**验证后的产物**：光栅原样，SVG 是重建后的静态文本——`bytes` 必须记落盘字节数，
    // 不是原条目大小（重建后的 SVG 与源文件常常不一样长，资源端点的 Content-Length 要跟它对得上）
    const payload = facts.kind === 'raster' ? raw : Buffer.from(facts.content, 'utf8')
    const id = ids.resource()
    const ref: EpubResourceRef = {
      id, file: `resources/${id}.${facts.ext}`, mediaType: facts.mediaType, bytes: payload.length,
      width: facts.width, height: facts.height,
    }
    await writeInto(outputDir, ref.file, payload)
    const registered: RegisteredResource = { ref, width: facts.width, height: facts.height }
    byPath.set(srcPath, registered)
    resources[id] = ref
    return registered
  }

  // 图片绑定：键是「出处文档 + 原始 src」，因为同一个 src 在不同目录下解释结果不同（`../` 的基准是文档）
  const imageBindings = new Map<string, { resourceId: string; width: number; height: number }>()
  for (const doc of docs.values()) {
    for (const src of doc.images) {
      const cls = classifyHref(src, doc.path)
      if (cls.kind !== 'internal') {
        // 正文用的远程/不可用图片：导入失败并点名这张图——整页插图静默消失是最坏的结果
        throw new EpubImportError(`${doc.path}：正文引用了书外图片（本插件只加载书内资源）：${src}`)
      }
      const registered = await register(cls.href.path, `引用处 ${doc.path}`, true)
      if (registered.width === null || registered.height === null) {
        throw new EpubImportError(`${cls.href.path}：图片宽高未知（插图的占位尺寸无从确定）`)
      }
      imageBindings.set(imageKey(doc.path, src), { resourceId: registered.ref.id, width: registered.width, height: registered.height })
    }
  }

  // ── 目标绑定（导航与正文链接共用同一套判定）──────────────────────────────
  /** 锚点查询的三种结果：命中（含「本来就没有片段」）/ 随被剥离内容消失（降级）/ 抛错（从未存在） */
  type AnchorLookup = { readonly kind: 'anchor'; readonly anchorId: string | null } | { readonly kind: 'stripped' }

  const docOf = (href: EpubHref, context: string): ScannedDocument => {
    const doc = docs.get(href.path)
    if (doc === undefined) throw new EpubImportError(`${context}：目标不是可读的 XHTML 文档：${href.path}`)
    return doc
  }

  const targetOf = (doc: ScannedDocument, anchorId: string | null): ReadingTarget => (doc.index === null
    ? { kind: 'supplement', documentId: doc.id, anchorId }
    : { kind: 'chapter', index: doc.index, anchorId })

  /**
   * 查锚点：先查树上那张表，再查「被剥离的锚点」名单。
   *
   * 两边都不在才是坏书（拼写错、指向不存在的 id）：我们读不懂这个目标就不猜。**在名单里**意味着
   * 锚点确实在源文档里、是我们自己剥掉了承载它的图形（内联 SVG 等）——那不是「没有目标」，
   * 所以由调用方降级 + 告警，不在这里抛错。
   */
  const lookupAnchor = (doc: ScannedDocument, fragment: string, context: string): AnchorLookup => {
    const anchorId = doc.anchors.get(fragment)
    if (anchorId !== undefined) return { kind: 'anchor', anchorId }
    if (doc.strippedAnchors.has(fragment)) return { kind: 'stripped' }
    throw new EpubImportError(`${context}：目标锚点在文档里不存在：#${fragment}（${doc.path}）`)
  }

  /** 导航目标：锚点随被剥离内容消失时降级成「该文档 + 无片段」（跳到该文档开头），导航仍然可用 */
  const bindTarget = (href: EpubHref, context: string): ReadingTarget => {
    const doc = docOf(href, context)
    if (href.fragment === null) return targetOf(doc, null)
    const lookup = lookupAnchor(doc, href.fragment, context)
    if (lookup.kind === 'anchor') return targetOf(doc, lookup.anchorId)
    warnings.add(WARN_DEGRADED_ANCHOR, doc.path, DEGRADED_NAV, `${doc.path}#${href.fragment}（${context}）`)
    return targetOf(doc, null)
  }

  /**
   * 正文链接：书内且可读 → 目标；外站/活动 scheme/不可读目标 → null（保留文字并记告警）。
   * 目标锚点随被剥离内容消失也走这条降级路（返回 null ⇒ 该处只剩子内容，不再有 link 节点）。
   */
  const bindLink = (href: string, from: string): ReadingTarget | null => {
    const cls = classifyHref(href, from)
    if (cls.kind === 'unfollowable') {
      warnings.add(WARN_UNFOLLOWABLE, from, '移除了不可跟随的链接（只保留文字）', cls.label)
      return null
    }
    if (cls.kind === 'external') {
      warnings.add(WARN_EXTERNAL_LINK, from, '取消了书外链接的可点击性（只保留文字）', shortLabel(href))
      return null
    }
    if (!docs.has(cls.href.path)) {
      const item = manifestByPath.get(cls.href.path)
      if (item === undefined) {
        throw new EpubImportError(`${from}：书内链接指向归档里不存在的文档：${cls.href.path}`)
      }
      warnings.add(WARN_EXTERNAL_LINK, from, '取消了指向书内不可读资源的链接（只保留文字）', `${cls.href.path}（${item.mediaType}）`)
      return null
    }
    const doc = docOf(cls.href, from)
    if (cls.href.fragment === null) return targetOf(doc, null)
    const lookup = lookupAnchor(doc, cls.href.fragment, from)
    if (lookup.kind === 'anchor') return targetOf(doc, lookup.anchorId)
    // 告警的 resource 是**出处文档**（同其它链接类告警），message 点名目标文档与锚点
    warnings.add(WARN_DEGRADED_ANCHOR, from, DEGRADED_LINK, `${cls.href.path}#${cls.href.fragment}`)
    return null
  }

  const bindNav = (list: readonly EpubNavItem[], from: string): NavigationItem[] => list.map((item) => ({
    id: ids.node(),
    label: item.label,
    // 分组标题（没有目标）照留：它是目录的层级，不是内容
    target: item.target === null ? null : bindTarget(item.target, `${from}（${item.label}）`),
    children: bindNav(item.children, from),
  }))
  const items = bindNav(pkg.navigation, '导航')

  // ── 第二遍：逐份转换、绑目标、落盘、释放 ──────────────────────────────────
  /**
   * 整页只有一棵内联 SVG 的图形页（EPUB3 推荐的封面写法，真书反例见 `documents.ts` 注③）：
   * SVG 里恰好只剩一张 `<image>` 且它指向**书内可加载**的资源时，这一页按那张图导成单图章节，
   * 并留一条降级说明；两种落不下的情形仍按原口径拒整本——
   * 「不是一张图」与「那张图在书外」是两件事，各说各的话（宁可精确，不含糊成一句泛拒）。
   * 判据的这一半必须问资源与归档，文档层答不了，所以裁决在这一层。
   */
  const svgImagePageNodes = async (page: SvgOnlyPage, docPath: string): Promise<ContentNode[]> => {
    const href = soleRasterHref(page.element)
    if (href === null) throw new EpubImportError(svgOnlyPageReason(docPath))
    const cls = classifyHref(href, docPath)
    if (cls.kind !== 'internal') {
      throw new EpubImportError(`${docPath}：整页 SVG 里那张图指向书外（本插件只加载书内资源）：${href}`)
    }
    const registered = await register(cls.href.path, `SVG 图形页 ${docPath}`, true)
    if (registered.width === null || registered.height === null) {
      throw new EpubImportError(`${cls.href.path}：图片宽高未知（插图的占位尺寸无从确定）`)
    }
    warnings.add(WARN_SVG_IMAGE_PAGE, docPath,
      '整页内联 SVG 按其内唯一的一张书内图片导入（本插件不渲染矢量图形，这一页按图读）', cls.href.path)
    const image: ContentNode = {
      kind: 'image', id: ids.node(), resourceId: registered.ref.id, alt: '',
      width: registered.width, height: registered.height,
    }
    // 被顶替掉的容器各自留着锚点：目录与正文指向它们（`#cover` 这类）的目标必须有落点，
    // 否则那个锚点 ID 在树上不存在——落位退化成章首、目录当前项也量不到（锚点是扫描期铸的，
    // 而承载它的容器随整页 SVG 一起没了）。由内到外逐层包一个 div，身份一一承接。
    return [[...page.carriedAnchors].reverse().reduce<ContentNode>(
      (child, anchorId) => containerNode(anchorId, [child]), image,
    )]
  }

  const documents: Record<string, EpubDocumentRef> = {}
  for (const doc of docs.values()) {
    const root = await readXhtml(archive, doc.path, budget, domLimits)
    const converted = convertXhtml(root, {
      budget: xmlBudget(doc.path, domLimits),
      anchors: doc.anchors,
      resolveLink: (href: string) => bindLink(href, doc.path),
      resolveImage: (src, alt) => {
        void alt
        const hit = imageBindings.get(imageKey(doc.path, src.trim()))
        if (hit === undefined) throw new EpubImportError(`${doc.path}：图片 ${src} 没有在扫描期清点到（内部一致性被破坏）`)
        return hit
      },
      nextNodeId: () => ids.node(),
      warnings,
    })
    const nodes = converted.svgOnly === null ? converted.nodes : await svgImagePageNodes(converted.svgOnly, doc.path)
    const content: ChapterContent = { kind: 'rich', documentId: doc.id, nodes }
    const file = `documents/${doc.id}.json`
    await writeInto(outputDir, file, Buffer.from(JSON.stringify(content), 'utf8'))
    documents[doc.id] = { id: doc.id, file, index: doc.index, label: doc.label, path: doc.path }
  }

  // ── 封面：EPUB3 的 cover-image 优先，其次 EPUB2 的 meta name="cover"；无封面不是失败 ─────
  // 封面声明了却读不出（缺失/损坏/不支持）就是导入失败：不造一个「有效封面 URL」糊过去。
  const coverCandidate = pkg.coverCandidates[0]
  const coverResourceId = coverCandidate === undefined
    ? null
    : (await register(coverCandidate.path, 'EPUB 封面声明', false)).ref.id

  const chapters: EpubChapterRef[] = [...docs.values()]
    .filter((d): d is ScannedDocument & { index: number } => d.index !== null)
    .sort((a, b) => a.index - b.index)
    .map((d) => ({ index: d.index, documentId: d.id, label: d.label }))

  return {
    title: pkg.title, author: pkg.author, chapters, items,
    documents, resources, coverResourceId, warnings: warnings.list(),
  }
}

// ── 走文档树的小工具（标题与正文各读一次文档，DOM 用完即弃）───────────────────────

async function readXhtml(archive: EpubArchive, docPath: string, budget: EpubLimits, domLimits: XmlLimits): Promise<Element> {
  const bytes = await archive.read(docPath, budget.xmlBytes)
  let text: string
  try {
    text = decodeEpubXml(bytes)
  } catch (e) {
    if (e instanceof EpubImportError) throw new EpubImportError(`${docPath}：${e.message}`)
    throw e
  }
  return parseXml(text, xmlBudget(docPath, domLimits))
}

/** 图片绑定的键：同一个 src 在不同文档里解释结果不同（`../` 的基准是文档目录），所以按文档分键 */
function imageKey(docPath: string, src: string): string {
  return `${docPath}\u0000${src}`
}

/**
 * 原始 href 的三分类——**不可跟随**（活动/本机 scheme、空 href）与**书外**（外站）不是一回事：
 * 前者是「这条链接本来就不该被点开」，后者是「内容在书外的某个站点上」，告警文案要分开说。
 * 书内相对引用交给 `resolveEpubHref`：它解析不了（越出书根、NUL、反斜杠、坏百分号）是**坏书**，抛错。
 */
type HrefClass =
  | { readonly kind: 'internal'; readonly href: EpubHref }
  | { readonly kind: 'external' }
  | { readonly kind: 'unfollowable'; readonly label: string }

function classifyHref(href: string, from: string): HrefClass {
  const trimmed = href.trim()
  if (trimmed === '') return { kind: 'unfollowable', label: '空 href' }
  if (trimmed.startsWith('//')) return { kind: 'external' }
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(trimmed)
  if (scheme !== null) {
    const name = scheme[1].toLowerCase()
    return UNFOLLOWABLE_SCHEMES.has(name) ? { kind: 'unfollowable', label: `${name}:` } : { kind: 'external' }
  }
  return { kind: 'internal', href: resolveEpubHref(from, trimmed) }
}

/** 告警细节里的短标签：整条 href 可能很长，截断（细节只是给人看的例子） */
function shortLabel(href: string): string {
  const trimmed = href.trim()
  return trimmed.length > 80 ? `${trimmed.slice(0, 80)}…` : trimmed
}

/** 导航树的全部叶子/父级目标（含只有分组标题的 null 不参与） */
function navTargets(items: readonly EpubNavItem[]): EpubHref[] {
  const out: EpubHref[] = []
  for (const item of items) {
    if (item.target !== null) out.push(item.target)
    out.push(...navTargets(item.children))
  }
  return out
}

/**
 * 写进 outputDir（相对路径只由 opaque ID 拼出来）：父目录按需建，调用方决定发布与清理。
 *
 * 裸 fs 错误必须在这里换成 `EpubImportError`：它的 message 里带着**主机绝对路径**（`mkdir 'C:\…'`），
 * 那既是异常类逃逸（服务层按类分流会把它漏成 500），也是主机目录布局泄露。报错只给书内逻辑名与
 * 系统错误码——两者足够定位「写哪一份产物、为什么写不进去」。
 */
async function writeInto(outputDir: string, relPath: string, data: Buffer): Promise<void> {
  const target = path.join(outputDir, relPath)
  try {
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, data)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    throw new EpubImportError(`写不出导入产物 ${relPath}（${code ?? '写盘失败'}）：请检查输出目录是否可写`)
  }
}
