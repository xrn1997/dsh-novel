import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Element } from 'domhandler'
import type { ChapterContent, ContentNode, NavigationItem, ReadingTarget } from '../../shared/wire.js'
import { DEFAULT_EPUB_LIMITS, openEpubArchive, type EpubArchive, type EpubLimits } from './archive.js'
import {
  containerNode, convertXhtml, documentTitle, scanXhtml,
  EMPTY_SVG_ONLY_ACTION, WARN_EMPTY_DOC, type ConvertedXhtml, type SvgOnlyPage, type XhtmlScan,
} from './documents.js'
import { FindingLog, WARN_ITEM_PRUNED, type FindingEntry } from './findings.js'
import { EpubDocumentError, EpubHrefError, EpubResourceError, rejectBook } from './errors.js'
import {
  epubBaseName, readEpubPackage, resolveEpubHref, XHTML_MEDIA_TYPE,
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
 * ② **后果按半径表导出**（唯一主人在 `findings.ts` 的 `FINDING_RADII`，本层只执行不重述）：
 *    一份文档读不出→留空页，一条声明或引用读不出→剪那一条，一处元素读不出→该处不留，
 *    每格都留痕。**整本拒只有一条路**：`services/epub/errors.ts` 的 `rejectBook`，它留给容器入口与包文档读不出、
 *    主序列被剪到空、声明了封面却读不出这类书级事实（裁决见 `ADR-0061`）。
 *    锚点找不到——随被剥离的内容一起消失、或从未存在过——不是坏书，是**那一条引用**降级：
 *    导航目标降到「该文档 + 无片段」、正文内链降级成纯文本，各留一条 `epub-degraded-anchor`，
 *    动作句分开写，好让用户分清是我们剥掉了承载它的内容还是书本身指错了名字；
 *    body 上的文档级锚点等价于「无片段」，不降级也不告警。
 * ③ **被剥除的活动内容只记痕**（丢了什么看得见）；**一处可见图形读不出也只是那一处不留**
 *    （坏图、不支持的格式、被加密、指向书外——痕点名这张图与原因），整页只有内联 SVG 又落不下
 *    时那一页是空的（理由见 `documents.ts` 头注③）。同一份文档在扫描期、转换期或资源期读不出，
 *    落法都一样：章号不动、目录照有名、痕点名为什么读不出（半径由主语定，不由哪一步被 try 包住定）。
 */

/** 不可跟随 scheme：这些 href 不是「外站链接」而是活动/本机资源引用，同样只留文字 */
const UNFOLLOWABLE_SCHEMES: ReadonlySet<string> = new Set(['javascript', 'vbscript', 'data', 'file', 'about', 'chrome', 'blob'])

const WARN_UNFOLLOWABLE = 'epub-link-not-followable'
const WARN_EXTERNAL_LINK = 'epub-external-link'
/** 目标锚点不可达（随被剥离的内容一起消失，或从未存在过）：导航降级到文档开头、内链降级成纯文本 */
const WARN_DEGRADED_ANCHOR = 'epub-degraded-anchor'
/** 同一份文档里同名锚点出现多处：承载者取文档序第一个，另一处照旧读得出——只留痕，不拒书 */
const WARN_DUP_ANCHOR = 'epub-duplicate-anchor'
/** 一张资源图读不出来：那一处不留（alt 文字与锚点位置照留），告警点名这张资源与精确原因 */
const WARN_IMAGE_DROPPED = 'epub-image-dropped'
/** 整页只有一棵内联 SVG 的图形页（EPUB3 推荐的封面写法）：按其内唯一一张书内图导成一图章节 */
const WARN_SVG_IMAGE_PAGE = 'epub-svg-image-page'

/**
 * 降级告警的四种动作文案：同码不同动作各成一条（导航降级与内链降级是两件不同的事）。
 * 两对之间的分寸：「随被剥离的内容一起消失」说的是我们自己剥掉了承载它的内容，「在文档里不存在」
 * 说的是书的目录或链接本身指错了名字——同一条痕码，用户要靠这句话分清是哪一种。
 */
const DEGRADED_NAV = '导航目标锚点随被剥离的内容（内联 SVG 等）一起消失，已降级到该文档开头'
const DEGRADED_LINK = '正文链接的目标锚点随被剥离的内容（内联 SVG 等）一起消失，已降级成纯文本'
const MISSING_NAV = '导航目标锚点在文档里不存在，已落到该文档开头'
const MISSING_LINK = '正文链接的目标锚点在文档里不存在，已降级成纯文本'

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
  /** 在阅读序列里的章号（被剪的条目不占号，读不出正文的页照旧占号）；补充文档为 null */
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
  /**
   * 导入过程记下的**事实**清单（半径、处数与例子都在里面）：给谁看、说什么语言由读面投影
   * （`services/epub/findings.ts` 的 `warningListOf`），不在这里定死——落盘的是事实，投影随时可以重做。
   */
  readonly findings: readonly FindingEntry[]
}

/** 导入期唯一 ID 铸造器：四个命名空间各一条序列（`d`文档 / `n`节点 / `a`锚点 / `r`资源） */
class IdMinter {
  // 计数器的名字带 `n` 前缀：与下面的方法名（`node`/`anchor`…）同名会被类字段顶掉——
  // 类字段遮蔽同名原型方法，那些方法直接不见
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
  /** 挂在 body 上的 id：等价于「该文档 + 无片段」，绑定期不降级也不告警（见 `XhtmlScan`） */
  readonly documentAnchor: string | null
  /** 同名锚点撞在多处的那些名字：只用来留痕（承载者是文档序第一个） */
  readonly duplicates: readonly string[]
  /**
   * 这一份文档的正文读不读得出（解码 / 结构 / DOM 预算，或包层声明它排不动）。
   * `false` 时锚点表是无从建立的：绑定期不许把「我们没读出来」当成「这个名字不存在」（见 `lookupAnchor`）。
   */
  readonly readable: boolean
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
  const warnings = new FindingLog()
  /** 低层交回的事实清单入池：处数照加、例子各留前三（本层是唯一持有可变账本的地方） */
  const merge = (list: readonly FindingEntry[]): void => {
    for (const entry of list) warnings.addEntry(entry)
  }
  // 包层交出的事实先入池（它自带半径，编排层不重述包层的码）
  merge(pkg.findings)

  /** 一份正文文档的预算：`what` 就是它的书内逻辑名，主语声明成 content —— 这一份读不出归这一页 */
  const contentBudget = (docPath: string): XmlBudget => xmlBudget(docPath, domLimits, 'content')

  /**
   * 读一份**内容文档**：解码、静态闸门、解析与 DOM 预算全按预算声明的主语失败（`EpubDocumentError`），
   * 所以扫描期与转换期撞上的读不出是同一格后果，不需要在这一层再换个类重披。
   * 归档层连字节都取不出仍抛书级——那是容器级事实（`archive.ts` 的口径）。
   */
  const readXhtml = async (docPath: string, docBudget: XmlBudget): Promise<Element> =>
    parseXml(decodeEpubXml(await archive.read(docPath, budget.xmlBytes), docBudget), docBudget)

  // 同一路径被两个 id 声明时，路径索引只认**先声明**的那一条：spine 的接纳按 idref 各自判
  // （`package.ts` 的 `parseSpine`），后写覆盖会让同一份文件在读面换一种媒体类型——判据的第二份抄本。
  const manifestByPath = new Map<string, EpubManifestItem>()
  for (const item of pkg.manifest.values()) if (!manifestByPath.has(item.path)) manifestByPath.set(item.path, item)
  // manifest 写得出路径不等于归档里真有这份文件：缺条目是包层就判得出的事实，
  // 不能拖到 archive.read 才变成整本拒——spine 与目录已先剪，正文链接也要落在同一条半径上
  const archiveNames = new Set(archive.entries.map((entry) => entry.name))

  // ── 第一遍：文档集合、锚点映射、链接与图片清点 ──────────────────────────────
  const docs = new Map<string, ScannedDocument>()
  const queue: string[] = []
  /** 收一份读不出的文档（空页）：锚点表无从建立，供绑定期区分「没这个锚点」与「这份没读出来」 */
  const enqueueBlank = (docPath: string, index: number | null): true => {
    docs.set(docPath, {
      id: ids.document(), path: docPath, index, label: epubBaseName(docPath), readable: false,
      anchors: new Map(), strippedAnchors: new Set(), documentAnchor: null, duplicates: [], links: [], images: [],
    })
    queue.push(docPath)
    return true
  }

  /**
   * 把一份**已确定可以收**的文档收进阅读面：读数、建锚点表、入队。
   *
   * 这里**不判断**「这条引用能不能落到一份可读的 XHTML 文档上」——那个判断归引用方：
   * 主序列已由包层 `parseSpine` 判过（缺 idref / 不在 manifest / 归档里没有 / 非 XHTML 都在那里剪），
   * 导航与正文链接走下面的 `enqueue`，由它们各自按引用级半径处理。收不出正文的页照样进阅读序列。
   */
  const collect = async (docPath: string, index: number | null): Promise<void> => {
    if (docs.has(docPath)) return
    // 包层声明「这一份读不出」（scripted：读端不执行书内脚本）：痕已由包层记过，这里连解析都不做。
    // 解析它不是「多读一点」——它会把一份读不出的页的锚点表建起来，绑定期就会把名字绑到树上不存在的节点
    if (pkg.unreadableSpineDocs.has(docPath)) { enqueueBlank(docPath, index); return }
    let root: Element
    let scan: XhtmlScan
    let title: string | null
    const budgetOfDoc = contentBudget(docPath)
    try {
      root = await readXhtml(docPath, budgetOfDoc)
      title = documentTitle(root, budgetOfDoc)
      scan = scanXhtml(root, budgetOfDoc, () => ids.anchor())
    } catch (e) {
      // 这一份解不开（声明与内容不符、不是良构 XML、超 DOM 预算）：它是一页读不出的正文，
      // 不是一本书读不出——照留章号与目录名，落空页，并把原因点名（安全面不变：我们仍不解析它）
      if (!(e instanceof EpubDocumentError)) throw e
      warnings.add('blankDocument', WARN_EMPTY_DOC, docPath, e.message)
      enqueueBlank(docPath, index)
      return
    }
    docs.set(docPath, {
      id: ids.document(), path: docPath, index, readable: true,
      label: title ?? epubBaseName(docPath),
      anchors: scan.anchors, strippedAnchors: scan.strippedAnchors, documentAnchor: scan.documentAnchor,
      duplicates: scan.duplicates, links: scan.links, images: scan.images,
    })
    // 撞名留痕在编排层：扫描只交事实（哪些名字撞过），后果（记什么、报多重）在这里定
    for (const dupName of scan.duplicates) {
      warnings.add('elementNoted', WARN_DUP_ANCHOR, docPath, '文档里有同名锚点，绑定取文档序第一个（另一处照样作为正文读出来）', dupName)
    }
    queue.push(docPath)
  }

  /**
   * 能不能把这条**引用**指到的文档收进阅读面：收进来返回 `true`。
   *
   * 指不到一份可读的 XHTML 文档时返回 `false` 而不抛错——**这条引用坏在哪一层，由引用方按自己的
   * 半径负责**（导航剪那一条、正文内链取消可点击性），这里只回答「收不收得下」。调用点各自留痕，
   * 所以这里不记 Finding（记了就会与调用点重复）。主序列不走这里：包层已经判过，`collect` 直接收。
   */
  const enqueue = async (docPath: string, index: number | null): Promise<boolean> => {
    if (docs.has(docPath)) return true
    const item = manifestByPath.get(docPath)
    if (item === undefined || item.mediaType !== XHTML_MEDIA_TYPE) return false
    // manifest 声明在、归档里没有这一条：这是「这一条引用指不到文档」，不是容器读失败，
    // 由引用方按自己的半径剪那一条（目录/正文链接各自留痕），不拖到 archive.read 变成整本拒
    if (!archiveNames.has(docPath)) return false
    await collect(docPath, index)
    return true
  }

  // 主序列（spine 的 linear 项）按顺序拿章号：文档 ID 的铸造顺序就是阅读顺序。
  // 包层交出的 `pkg.spine` 是**已接纳**的声明（剪除与压缩已由 `parseSpine` 做完），这里只收不重判；
  // 收不出正文的页照样占号，所以章号数的是阅读单元，不是 itemref 在原文件里的位置。
  let unit = 0
  for (const docPath of pkg.spine) {
    await collect(docPath, unit)
    unit += 1
  }
  // 导航指到的文档也算可达（目录要能跳到它，比如附录）；它可能本身就不在 spine 里。
  // 收不进来不在这里留痕：绑定期会剪那一条目录并点名（一处一件事）
  for (const href of navTargets(pkg.navigation)) await enqueue(href.path, null)
  // 正文链接的传递闭包（活队列：新收的文档也要继续顺链走），已访问集合自然终止环路。
  // `for…of` 与按下标读同一份活队列等价（数组迭代器每步重读长度），故循环中新入队的文档照样会被走到。
  for (const docPath of queue) {
    const doc = docs.get(docPath)
    // 活队列的每一项都由 enqueue 先写进 docs 再入队：取不到即我们自己的账对不上，
    // 而 400 会把服务端 bug 说成「你的书坏了」——**显式选 500**（同 `localbooks.ts` 的 readDocument）
    if (doc === undefined) throw new Error(`正文链接活队列里的 ${docPath} 不在文档表里（内部一致性被破坏）`)
    for (const link of doc.links) {
      const cls = classifyHref(link, doc.path)
      if (cls.kind !== 'internal') continue
      const target = manifestByPath.get(cls.href.path)
      if (target === undefined || target.mediaType !== XHTML_MEDIA_TYPE) continue   // 绑定期再按语境拒绝/降级
      await enqueue(cls.href.path, null)
    }
  }

  // ── 资源登记（按书内路径去重；图片先于文档，封面最后）────────────────────────
  const byPath = new Map<string, RegisteredResource>()
  const resources: Record<string, EpubResourceRef> = {}

  /**
   * 登记结果：失败也把**说得出原因的那句话**交回调用方。
   *
   * 为什么不是 `null`：资源的半径不同——正文插图失败只去掉那一处（痕已记），而封面失败是整本拒，
   * 那句给用户的报错必须带上真正的原因，不能指向一个导入已经失败、用户根本看不到的告警面。
   */
  type Registration =
    | { readonly ok: true; readonly resource: RegisteredResource }
    | { readonly ok: false; readonly reason: string }

  /**
   * 登记一份资源。**资源级**失败（`EpubResourceError`：格式不支持、容器损坏、超像素、被加密、
   * 指向的不是资源……）在这里收口：留一条点名这张资源的痕，把原因交回调用方（它决定这一处怎么落）。
   * 容器级失败（字节连读都读不出、写不出产物）仍按原样上抛——那是整本书的事实，不是一张图的事实。
   */
  const register = async (srcPath: string, context: string, requireSize: boolean, noteFailure = true): Promise<Registration> => {
    try {
      return await registerOnce(srcPath, context, requireSize, noteFailure)
    } catch (e) {
      if (!(e instanceof EpubResourceError)) throw e
      // 封面那一路传 `false`：它的失败会立刻变成整本拒，痕不会出现在任何用户读得到的告警面上，
      // 原因直接进 `rejectBook` 的报错句——在这里再记一笔是死写入。
      if (noteFailure) warnings.add('elementDropped', WARN_IMAGE_DROPPED, srcPath, e.message)
      return { ok: false, reason: e.message }
    }
  }

  const registerOnce = async (srcPath: string, context: string, requireSize: boolean, noteFailure: boolean): Promise<Registration> => {
    const hit = byPath.get(srcPath)
    if (hit !== undefined) return { ok: true, resource: hit }
    const item = manifestByPath.get(srcPath)
    if (item === undefined) throw new EpubResourceError(`${context}引用的资源不在 manifest 里：${srcPath}`)
    const what = `${srcPath}（${context}）`
    // manifest 有、归档无：这是「这一条引用指不到资源」，不是容器读失败——与 spine / 目录 / 正文链接
    // 的存在性半径一致。封面那一路会把这条失败再升成书级（它声明了封面）
    if (!archiveNames.has(srcPath)) throw new EpubResourceError(`${what}：归档里没有这一条（这一处读不出）`)
    // 被加密的资源在读字节/验格式**之前**拒绝：字节是混淆过的，按字节报错会把原因说成「图片损坏」，
    // 读者据此去换图是白费力气（真正的原因是本插件不提供解密）
    if (pkg.encryptedPaths.has(srcPath)) {
      throw new EpubResourceError(`${what}：资源被加密（本插件不提供解密，正文里用到的它读不出）`)
    }
    // SVG 是 XML 文档（要解析成树），按 **XML 类别**的字节上限读——与 container/OPF/NCX/正文同一档；
    // 光栅图只做魔数与容器核对、不进解析器，按条目上限读。用 `entryBytes` 一把抓会让 SVG 默认能到
    // 32 MiB（预算表里 XML 那条写的是 8 MiB），解析器前的这道闸等于没有。
    // manifest 读入时已归一（`package.ts` 的 `normalizeMediaType`），这里只需相等判定。
    const cap = item.mediaType === SVG_MEDIA_TYPE ? budget.xmlBytes : budget.entryBytes
    const raw = await archive.read(srcPath, cap)
    const { facts, findings: imageFindings } = validateImage(raw, {
      what, path: srcPath, declaredMediaType: item.mediaType,
      imagePixels: budget.imagePixels, domLimits,
    })
    // 资源层把 SVG 里剥掉的活动内容按同一张半径表交回（elementRemoved），这里只入池不重述
    merge(imageFindings)
    if (facts.kind === 'wrapper') {
      // 单图包装：要的是它包着的那张栅格（同书内引用），按那份资源登记；包装本身不落盘
      const inner = manifestByPath.get(facts.path)
      if (inner !== undefined && inner.mediaType === SVG_MEDIA_TYPE) {
        throw new EpubResourceError(`${what}：SVG 包装指向的还是 SVG（包装只允许包一张栅格图）`)
      }
      return register(facts.path, context, requireSize, noteFailure)
    }
    if (requireSize && (facts.width === null || facts.height === null)) {
      throw new EpubResourceError(`${what}：SVG 缺少可用的宽高（width/height/viewBox 都没有），插图的占位尺寸无从确定`)
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
    return { ok: true, resource: registered }
  }

  // 图片绑定：键是「出处文档 + 原始 src」，因为同一个 src 在不同目录下解释结果不同（`../` 的基准是文档）。
  // 值是**三态**：绑定成功 / 这张图已经读不出并留痕（'failed'）/ 从未在扫描期清点到（内部一致性被破坏）。
  // 后两态不许折叠成一个：把「我们已经丢了这一处」读成「清点漏了」会把真缺陷报成 500，反之会把 500 藏成告警。
  type ImageOutcome = { readonly resourceId: string; readonly width: number; readonly height: number } | 'failed'
  const imageOutcomes = new Map<string, ImageOutcome>()
  for (const doc of docs.values()) {
    for (const src of doc.images) {
      const key = imageKey(doc.path, src)
      const cls = classifyHref(src, doc.path)
      if (cls.kind !== 'internal') {
        // 正文用的书外图片：这一处表达不出来（本插件只加载书内资源）——该处不留，但要点名这张图与出处
        warnings.add('elementDropped', WARN_IMAGE_DROPPED, src,
          cls.kind === 'unresolvable'
            ? `${doc.path}：正文图片的引用解不开（这一处不留，文字与锚点位置照留）：${cls.reason}`
            : `${doc.path}：正文引用了书外图片（本插件只加载书内资源）`)
        imageOutcomes.set(key, 'failed')
        continue
      }
      const registration = await register(cls.href.path, `引用处 ${doc.path}`, true)
      if (!registration.ok) { imageOutcomes.set(key, 'failed'); continue }
      const registered = registration.resource
      if (registered.width === null || registered.height === null) {
        warnings.add('elementDropped', WARN_IMAGE_DROPPED, cls.href.path, `${cls.href.path}：图片宽高未知（插图的占位尺寸无从确定）`)
        imageOutcomes.set(key, 'failed')
        continue
      }
      imageOutcomes.set(key, { resourceId: registered.ref.id, width: registered.width, height: registered.height })
    }
  }

  // ── 目标绑定（导航与正文链接共用同一套判定）──────────────────────────────
  /** 锚点查询的四种结果：命中（含「本来就没有片段」）/ 随被剥离内容消失（降级）/ 落到该页开头（文档级锚点，或这份文档没读出来）/ 从未存在（同样按该条降级） */
  type AnchorLookup = { readonly kind: 'anchor'; readonly anchorId: string | null } | { readonly kind: 'stripped' } | { readonly kind: 'document' } | { readonly kind: 'degraded' }

  /** 目标文档在不在阅读面：`null` = 这一条引用落不到可读的文档上（半径由引用方决定，不在这儿抛错） */
  const docOf = (href: EpubHref): ScannedDocument | null => docs.get(href.path) ?? null

  const targetOf = (doc: ScannedDocument, anchorId: string | null): ReadingTarget => (doc.index === null
    ? { kind: 'supplement', documentId: doc.id, anchorId }
    : { kind: 'chapter', index: doc.index, anchorId })

  /**
   * 查锚点：先查树上那张表，再查「被剥离的锚点」名单，再查文档级锚点（body 上的 id），最后才答「从未存在」。
   *
   * 「从未存在」的主语是**这一条引用**，不是这本书：返回 `degraded`，由调用方按自己的半径降级
   * （目录落该页开头、正文内链降级成纯文本）并留痕，整本照读（口径见头注②）。
   * **例外是这一份文档根本没读出来**：它的锚点表是空集，而我们拿不到「源里有没有这个名字」的事实——
   * 把「我们没读出来」说成「这个名字不存在」等于给读者报一条源里没有的结论。落点回到这一页的开头
   * （与文档级锚点同形），那一页读不出的原因另有一条痕点名，这里不再多记一条。
   */
  const lookupAnchor = (doc: ScannedDocument, fragment: string): AnchorLookup => {
    const anchorId = doc.anchors.get(fragment)
    if (anchorId !== undefined) return { kind: 'anchor', anchorId }
    if (doc.strippedAnchors.has(fragment)) return { kind: 'stripped' }
    if (doc.documentAnchor === fragment) return { kind: 'document' }
    if (!doc.readable) return { kind: 'document' }
    return { kind: 'degraded' }
  }

  /**
   * 导航目标：目标落不到阅读面（不在归档 / 不在 manifest / 不是 XHTML）→ `null`（这一条目录由调用方剪掉
   * 并留痕）；锚点缺失（随剥离消失，或从未存在）→ 降级成「该文档 + 无片段」（跳到文档开头），导航仍然可用。
   * 目标文档在、但它的正文读不出（空页）时锚点无从查，同样落到该页开头、但不记降级（见 `lookupAnchor`）。
   */
  const bindTarget = (href: EpubHref, context: string): ReadingTarget | null => {
    const doc = docOf(href)
    if (doc === null) return null
    if (href.fragment === null) return targetOf(doc, null)
    const lookup = lookupAnchor(doc, href.fragment)
    if (lookup.kind === 'anchor') return targetOf(doc, lookup.anchorId)
    // 文档级锚点指的就是这一页的开头：与「无片段」等价，不是降级，所以不记告警
    if (lookup.kind === 'document') return targetOf(doc, null)
    if (lookup.kind === 'degraded') {
      warnings.add('itemDegraded', WARN_DEGRADED_ANCHOR, doc.path, MISSING_NAV, `${doc.path}#${href.fragment}（${context}）`)
      return targetOf(doc, null)
    }
    warnings.add('itemDegraded', WARN_DEGRADED_ANCHOR, doc.path, DEGRADED_NAV, `${doc.path}#${href.fragment}（${context}）`)
    return targetOf(doc, null)
  }

  /**
   * 正文链接：书内且可读 → 目标；外站/活动 scheme/不可读目标 → null（保留文字并记告警）。
   * 锚点缺失（随剥离消失，或从未存在）也走这条降级路（返回 null ⇒ 该处只剩子内容，不再有 link 节点）。
   */
  const bindLink = (href: string, from: string): ReadingTarget | null => {
    const cls = classifyHref(href, from)
    if (cls.kind === 'unresolvable') {
      // 引用解不开（越出书根、含 NUL、反斜杠、坏百分号…）：主语是这一处，不是这本书
      warnings.add('elementDropped', WARN_ITEM_PRUNED, from, `这一处链接的引用解不开，已取消可点击性（文字照留）：${cls.reason}`, shortLabel(href))
      return null
    }
    if (cls.kind === 'unfollowable') {
      warnings.add('elementRemoved', WARN_UNFOLLOWABLE, from, '移除了不可跟随的链接（只保留文字）', cls.label)
      return null
    }
    if (cls.kind === 'external') {
      warnings.add('elementRemoved', WARN_EXTERNAL_LINK, from, '取消了书外链接的可点击性（只保留文字）', shortLabel(href))
      return null
    }
    if (!docs.has(cls.href.path)) {
      // 书内链接落不到阅读面（不在 manifest、不是 XHTML、或 manifest 有而归档里没有）：
      // 取消这一条的可点击性，文字一个字不丢——主语是「这一条引用」，不是「这本书」
      // （半径表把它登记在 `itemPruned` 那条）
      const item = manifestByPath.get(cls.href.path)
      const why = item === undefined
        ? '不在 manifest 里'
        : item.mediaType !== XHTML_MEDIA_TYPE
          ? `不是可读的 XHTML 文档（media-type=${item.mediaType}）`
          : '在 manifest 里、归档里没有这一条'
      warnings.add('itemPruned', WARN_ITEM_PRUNED, cls.href.path,
        `${from}：正文链接指向的文档${why}，这一处已取消可点击性（文字照留）`)
      return null
    }
    const doc = docOf(cls.href)
    if (doc === null) return null   // 上面已按 `docs.has` 分流，这里只收类型
    if (cls.href.fragment === null) return targetOf(doc, null)
    const lookup = lookupAnchor(doc, cls.href.fragment)
    if (lookup.kind === 'anchor') return targetOf(doc, lookup.anchorId)
    // 文档级锚点=这一页开头：链接照旧可点，不是降级、不记告警
    if (lookup.kind === 'document') return targetOf(doc, null)
    if (lookup.kind === 'degraded') {
      warnings.add('elementRemoved', WARN_DEGRADED_ANCHOR, from, MISSING_LINK, `${cls.href.path}#${cls.href.fragment}`)
      return null
    }
    // 告警的 resource 是**出处文档**（同其它链接类告警），message 点名目标文档与锚点
    warnings.add('elementRemoved', WARN_DEGRADED_ANCHOR, from, DEGRADED_LINK, `${cls.href.path}#${cls.href.fragment}`)
    return null
  }

  /**
   * 目录绑定：一条条目指到读不出的文档 → **剪那一条**，它的子条目上提（父级分组与兄弟照留），
   * 并留一条痕点名被剪的标签与目标。整棵树都指不到东西就是空目录——那也不是坏书。
   */
  const bindNav = (list: readonly EpubNavItem[], from: string): NavigationItem[] => {
    const out: NavigationItem[] = []
    for (const item of list) {
      const children = bindNav(item.children, from)   // 先绑子树：剪父级时它得能上提
      if (item.target === null) {
        // 分组标题（没有目标）照留：它是目录的层级，不是内容
        out.push({ id: ids.node(), label: item.label, target: null, children })
        continue
      }
      const target = bindTarget(item.target, `${from}（${item.label}）`)
      if (target === null) {
        warnings.add('itemPruned', WARN_ITEM_PRUNED, item.target.path,
          `目录条目指向读不出的文档，这一条被剪（子条目已上提；来源 ${from}）`, item.label)
        out.push(...children)
        continue
      }
      out.push({ id: ids.node(), label: item.label, target, children })
    }
    return out
  }
  const items = bindNav(pkg.navigation, '导航')

  // ── 第二遍：逐份转换、绑目标、落盘、释放 ──────────────────────────────────
  /**
   * 整页只有一棵内联 SVG 的图形页（EPUB3 推荐的封面写法，真书反例见 `documents.ts` 注③）：
   * SVG 里恰好只剩一张 `<image>` 且它指向**书内可加载**的资源时，这一页按那张图导成单图章节，
   * 并留一条降级说明；落不下的情形各说各的话（「不是一张图」与「那张图落不到书内资源上」是两件事），
   * 但都不再拒整本——这一页按空页留，痕点名原因。
   * 判据的这一半必须问资源与归档，文档层答不了，所以裁决在这一层。
   */
  const svgImagePageNodes = async (page: SvgOnlyPage, docPath: string): Promise<ContentNode[] | null> => {
    const href = soleRasterHref(page.element)
    if (href === null) {
      // 不是「只包一张书内图」的矢量页：本插件不渲染矢量，这一页落不下任何东西
      warnings.add('blankDocument', WARN_EMPTY_DOC, docPath, EMPTY_SVG_ONLY_ACTION)
      return null
    }
    const cls = classifyHref(href, docPath)
    if (cls.kind !== 'internal') {
      // 解不开的引用与书外资源都不是「加载得到但读坏了」：各说各的原因，这一页落不下
      const why = cls.kind === 'unresolvable'
        ? `那张图的引用解不开：${cls.reason}`
        : cls.kind === 'unfollowable'
          ? '那张图用了不可跟随的引用（本插件只加载书内资源）'
          : `那张图指向书外：${href}`
      warnings.add('blankDocument', WARN_EMPTY_DOC, docPath, `${EMPTY_SVG_ONLY_ACTION}（${why}）`)
      return null
    }
    const registration = await register(cls.href.path, `SVG 图形页 ${docPath}`, true)
    // register 已经点名那张资源；这一页除了它什么都没有，所以按空页落（不整本拒）。
    // 原因在这里重述一遍而不是写「见上一条」：整本只剩这一页时书会被拒，用户看不到导入说明，
    // 那句指路就落空了
    if (!registration.ok) {
      warnings.add('blankDocument', WARN_EMPTY_DOC, docPath, `${EMPTY_SVG_ONLY_ACTION}（那张图读不出：${registration.reason}）`)
      return null
    }
    const registered = registration.resource
    if (registered.width === null || registered.height === null) {
      warnings.add('blankDocument', WARN_EMPTY_DOC, docPath, `${EMPTY_SVG_ONLY_ACTION}（那张图宽高未知）`)
      return null
    }
    warnings.add('documentDegraded', WARN_SVG_IMAGE_PAGE, docPath,
      '整页内联 SVG 按其内唯一的一张书内图片导入（本插件不渲染矢量图形，这一页按图读）', cls.href.path)
    const image: ContentNode = {
      kind: 'image', id: ids.node(), resourceId: registered.ref.id, alt: '',
      width: registered.width, height: registered.height,
    }
    // 被顶替掉的容器各自留着锚点，必须有落点（否则绑到树上不存在的 ID，落位退化成章首）——
    // 由内到外逐层包一个 div，身份一一承接（理据见 documents.ts 的 `SvgOnlyPage.carriedAnchors`）。
    return [[...page.carriedAnchors].reverse().reduce<ContentNode>(
      (child, anchorId) => containerNode(anchorId, [child]), image,
    )]
  }

  const documents: Record<string, EpubDocumentRef> = {}
  /** 读不出正文的主序列文档：一份一份照留（章号不动、目录照有名），整本判据在循环外 */
  const blankSpine = new Set<string>()
  let spineDocs = 0
  for (const doc of docs.values()) {
    const convertOpts = {
      budget: contentBudget(doc.path),
      anchors: doc.anchors,
      resolveLink: (href: string) => bindLink(href, doc.path),
      resolveImage: (src: string, alt: string) => {
        void alt
        const hit = imageOutcomes.get(imageKey(doc.path, src.trim()))
        // 清点漏了一项是我们的账坏了，不是读者的书坏了：500（同上一处，也同 `localbooks.ts` 的 readDocument）
        if (hit === undefined) throw new Error(`${doc.path}：图片 ${src} 没有在扫描期清点到（内部一致性被破坏）`)
        // 'failed' = 这张图读不出、已经留过痕：文档层据此把**这一处**去掉（alt 文字与锚点位置另算）
        return hit === 'failed' ? null : hit
      },
      nextNodeId: () => ids.node(),
    }
    // 转换期也可能撞出文档级的读不出（这份文档的 DOM 超预算、结构走不完）：与扫描期同格落法——
    // 留空页并点名原因。半径由那份预算的主语决定，不由哪一步被 try 包住决定。
    let converted: ConvertedXhtml | null = null
    // `readable: false` 的页不再尝试转换（痕已由包层或扫描期记过）：执行那份内容不是本插件会做的事，
    // 但这一页在书里的位置是真的
    if (doc.readable) {
      try {
        converted = convertXhtml(await readXhtml(doc.path, convertOpts.budget), convertOpts)
      } catch (e) {
        if (!(e instanceof EpubDocumentError)) throw e
        warnings.add('blankDocument', WARN_EMPTY_DOC, doc.path, e.message)
      }
    }
    if (converted !== null) merge(converted.findings)
    let nodes: ContentNode[] = converted === null ? [] : converted.nodes
    if (converted !== null && converted.svgOnly !== null) {
      const page = await svgImagePageNodes(converted.svgOnly, doc.path)
      // 落不下：这一页按空页留（原因已由 svgImagePageNodes 或资源层点名），不整本拒
      if (page === null) nodes = []
      else nodes = page
    }
    if (converted === null || !converted.readable || nodes.length === 0) {
      // 补充文档读不出正文也照样落盘：它不计章，只可能在被指到时读出空白页——
      // 从文档表里抹掉它是「条目级剪除」那套机制的活（见名册在册待裁），这里不提前半做。
      // 空页的判定是 `converted.readable`：空白是可见性判据，不是树是否为空——扫描期铸出的锚点
      // 随结构树一起留下，目录与内链指过去仍有落点。「树为空」那一条只剩「整页内联 SVG 落不下
      // 那张图」的情形：那一页交的是空树，路径外的锚点没有落点（与 svgOnly 成功路径同口径，
      // 阅读面退到章首）。
      if (doc.index !== null) blankSpine.add(doc.path)
    }
    if (doc.index !== null) spineDocs += 1
    const content: ChapterContent = { kind: 'rich', documentId: doc.id, nodes }
    const file = `documents/${doc.id}.json`
    await writeInto(outputDir, file, Buffer.from(JSON.stringify(content), 'utf8'))
    documents[doc.id] = { id: doc.id, file, index: doc.index, label: doc.label, path: doc.path }
  }

  // 整本判据：个别文档读不出是文档级的事，**每一份**都读不出才是这本书的事
  // （「全部回退等于整体失效」，与引擎侧那条边界同源）。读数带上第一条具体原因——
  // 一本书被判死时，用户与排障的人要看得见「坏在哪份文档、为什么坏」，而不是一句泛话。
  // 原因只从**被判空的那几份主序列文档**里取：补充文档（导航可达的附录）读不出虽也留痕，
  // 却不是主序列没有可读页的原因，拿它点名会把读者引到不相干的一份上
  if (spineDocs > 0 && blankSpine.size === spineDocs) {
    // 不认具体码：空白、scripted、DOM 预算都是「这一份主序列文档读不出」这同一格，
    // 按半径（document + fatal）取第一条，别让新来的原因码从这句报错里静默消失。
    const firstReason = warnings.entries().find((f) => f.scope === 'document' && f.severity === 'fatal'
      && f.resource !== null && blankSpine.has(f.resource))
    // 扫描期那条动作句本身已带书内位置（异常消息由预算的 `what` 起头）：再前缀一遍资源名会把路径说两遍
    const detail = firstReason === undefined || firstReason.resource === null
      ? ''
      : firstReason.action.includes(firstReason.resource)
        ? `：${firstReason.action}`
        : `：${firstReason.resource} ${firstReason.action}`
    rejectBook(`EPUB 主序列里没有任何可读的一页（${spineDocs} 份文档全为空白或不可读）${detail}`)
  }

  // ── 封面：EPUB3 的 cover-image 优先，其次 EPUB2 的 meta name="cover"；无封面不是失败 ─────
  // 封面声明了却读不出（缺失/损坏/不支持）就是导入失败：不造一个「有效封面 URL」糊过去。
  const coverCandidate = pkg.coverCandidates[0]
  const coverResourceId = coverCandidate === undefined
    ? null
    : await (async () => {
      const registration = await register(coverCandidate.path, 'EPUB 封面声明', false, false)
      // 封面是**书级**事实：书架卡片、导入回执都按「这本书有封面」行事，声明了却读不出不能只留痕。
      // 原因必须写进这句报错：导入失败时书架不会出现这本书，用户看不到那份导入告警
      if (!registration.ok) rejectBook(`EPUB 声明的封面（${coverCandidate.path}）读不出：${registration.reason}`)
      return registration.resource.ref.id
    })()

  const chapters: EpubChapterRef[] = [...docs.values()]
    .filter((d): d is ScannedDocument & { index: number } => d.index !== null)
    .sort((a, b) => a.index - b.index)
    .map((d) => ({ index: d.index, documentId: d.id, label: d.label }))

  return {
    title: pkg.title, author: pkg.author, chapters, items,
    documents, resources, coverResourceId, findings: warnings.entries(),
  }
}

// ── 走文档树的小工具（标题与正文各读一次文档，DOM 用完即弃）───────────────────────

/** 图片绑定的键：同一个 src 在不同文档里解释结果不同（`../` 的基准是文档目录），所以按文档分键 */
function imageKey(docPath: string, src: string): string {
  return `${docPath}\u0000${src}`
}

/**
 * 原始 href 的四分类——**不可跟随**（活动/本机 scheme、空 href）与**书外**（外站）不是一回事：
 * 前者是「这条链接本来就不该被点开」，后者是「内容在书外的某个站点上」，告警文案要分开说。
 * 书内相对引用交给 `resolveEpubHref`；它解不开（越出书根、NUL、反斜杠、坏百分号）时抛的是
 * `EpubHrefError`（「这一条引用解不开」，不是书级异常）——一条引用解不开说的是**这一处**，
 * 交回 `unresolvable` 由引用方按半径落（正文链接取消可点击性、插图该处不留），原因原样带出去。
 */
type HrefClass =
  | { readonly kind: 'internal'; readonly href: EpubHref }
  | { readonly kind: 'external' }
  | { readonly kind: 'unfollowable'; readonly label: string }
  | { readonly kind: 'unresolvable'; readonly reason: string }

function classifyHref(href: string, from: string): HrefClass {
  const trimmed = href.trim()
  if (trimmed === '') return { kind: 'unfollowable', label: '空 href' }
  if (trimmed.startsWith('//')) return { kind: 'external' }
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(trimmed)
  if (scheme !== null) {
    const name = scheme[1]
    if (name === undefined) return { kind: 'unresolvable', reason: `认不出链接的 scheme（段 ${shortLabel(trimmed)}）` }
    const lowered = name.toLowerCase()
    return UNFOLLOWABLE_SCHEMES.has(lowered) ? { kind: 'unfollowable', label: `${lowered}:` } : { kind: 'external' }
  }
  try {
    return { kind: 'internal', href: resolveEpubHref(from, trimmed) }
  } catch (e) {
    if (e instanceof EpubHrefError) return { kind: 'unresolvable', reason: e.message }
    throw e
  }
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
    rejectBook(`写不出导入产物 ${relPath}（${code ?? '写盘失败'}）：请检查输出目录是否可写`)
  }
}
