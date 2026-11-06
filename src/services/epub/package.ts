import type { Element } from 'domhandler'
import { DEFAULT_EPUB_LIMITS, type EpubArchive, type EpubLimits } from './archive.js'
import { EpubHrefError, rejectBook } from './errors.js'
import { FindingLog, WARN_ITEM_PRUNED, type FindingEntry } from './findings.js'
import {
  attrOf, childElements, decodeEpubXml, descendants, firstChild, firstDescendant, isElement, localName, parseXml, textOf,
  xmlBudget, type XmlBudget, type XmlLimits,
} from './xml.js'

/**
 * EPUB 包层：把已过安全门的归档读成一份**可判定的书结构**——身份（mimetype）、OPF、
 * manifest、阅读顺序（spine）、目录目标（nav / NCX），外加「哪些读不出」这份事实：包级声明
 * （整本固定版式、正文加密）是书级拒绝，逐文档声明（这一份排不动 / 要靠脚本）只交回痕与路径。
 * 单份文档的解码、只读解析与带预算的 DOM 走法归 `xml.ts`（正文层也要用同一套门与预算）。
 *
 * 三条口径（改动这一层先读它们）：
 *
 * ① **连续阅读顺序 ≠ 目录导航**。阅读单元只按 OPF spine 的 `linear` 主序列排（`spine`），
 *    ZIP 条目顺序、文件名、目录叶条数都不参与。目录是另一棵树（`navigation`）：一个叶条目点的是
 *    「文档 + 文档内锚点」，同一文档的多个锚点各自成条，不复制成多章。两者都不做一一对应的假设。
 * ② **缺目录可以降级，坏目录必须报错**。nav → spine 的 toc 指向的 NCX → 按 spine 造平面导航
 *    （这一步留持久告警）；但「声明了导航文档却读不出 toc」不是缺目录，是坏目录——报错，不静默改走别的路。
 *    toc 的列表标签写成 ul（规范要求 ol）按列表读并留变体告警：结构没有歧义，不算坏目录；连列表都没有才报错。
 * ③ **本层不产出跨半形状**。导航目标是原始路径 + 片段（`{ path, fragment }`），opaque 的 documentId /
 *    锚点绑定归正文层；本层也不读正文、不认识书架与 HTTP。这样「包结构」与「正文规范化」各自可单独测。
 */

/** OCF 的 mimetype 条目取值：本层的身份判据（不导出——归档层按 ZIP 魔数分流，不认这串；
 *  把它挂成公开名字只会让人以为跨层有这个契约，实际消费者只有下面两处） */
const EPUB_MIMETYPE_VALUE = 'application/epub+zip'

const MIMETYPE_ENTRY = 'mimetype'

const CONTAINER_PATH = 'META-INF/container.xml'
const ENCRYPTION_PATH = 'META-INF/encryption.xml'
const OPF_MEDIA_TYPE = 'application/oebps-package+xml'
const NCX_MEDIA_TYPE = 'application/x-dtbncx+xml'
/** 认得的正文媒体类型（唯一一项）：spine 或引用指到别的类型就不是可读正文（正文层共用这一份） */
export const XHTML_MEDIA_TYPE = 'application/xhtml+xml'

/** 告警码（稳定标识，导入期原样落进元数据、进书后经「导入说明」重看）：用户看到的是 message，程序按 code 分流 */
const WARN_NAV_SYNTHESIZED = 'epub-navigation-synthesized'
/** 逐文档声明层面就能判定的两种「这一份读不出/排不动」：痕的稳定标识（编排层按它降级） */
const WARN_FIXED_LAYOUT_DOC = 'epub-fixed-layout-document'
const WARN_SCRIPTED_DOC = 'epub-scripted-document'
/** `linear` 写歪（规范只有 yes/no）：这一条照读，只把声明形态记一笔——它不是「被剪」 */
const WARN_SPINE_LINEAR_VARIANT = 'epub-spine-linear-variant'
const WARN_NAV_DEGRADED = 'epub-navigation-degraded'
const WARN_NAV_UNORDERED = 'epub-navigation-unordered-list'
const WARN_ENCRYPTED = 'epub-encrypted-resource'

/** manifest 里的一条：id 是包内身份，path 已相对 OPF 目录解成书内逻辑名 */
export interface EpubManifestItem {
  readonly id: string
  readonly path: string
  readonly mediaType: string
  /** manifest properties（空格分隔），例如 `nav` / `cover-image` / `scripted` */
  readonly properties: readonly string[]
}

/** spine 里的一条：`linear: false` 的是补充文档（不接进阅读流），但同属 spine 声明 */
export interface EpubSpineItem {
  readonly idref: string
  readonly path: string
  readonly linear: boolean
  /** itemref 上的 properties（空格分隔）：`rendition:layout-pre-paginated` 这类逐文档声明（同 manifest 项的那一栏） */
  readonly properties: readonly string[]
}

/** 书内目标：路径（归档根起算的逻辑名）+ 可空片段。锚点绑定之前，这就是目标的全部信息 */
export interface EpubHref {
  readonly path: string
  readonly fragment: string | null
}

/** 目录树节点：`target` 为 null 只用于分组标题（有子节点的卷/部） */
export interface EpubNavItem {
  readonly label: string
  readonly target: EpubHref | null
  readonly children: readonly EpubNavItem[]
}

/** 目录的来源：nav 文档 / NCX / 按 spine 合成（降级时另有告警说明） */
export type EpubNavigationSource = 'nav' | 'ncx' | 'spine'

/**
 * 一份读完的 EPUB 包结构。
 *
 * `spine` 是**主序列**（`spineItems` 里 linear 项的 path，按 spine 顺序）；`spineItems` 保留
 * 留下来的声明（含 linear="no" 的补充文档，指不到文档或不是 XHTML 的条目已被剪掉）——两个字段是
 * 「派生」与「保留下来的声明」的关系，不是两份真相。
 *
 * `encryptedPaths` 是内容加密清单（`encryption.xml` 的 CipherReference，按容器根解析成书内逻辑名）
 * 里的全部目标：spine 里的那些在本层直接拒整本，**其余带出去**——正文层真要用到某个被加密的图片时，
 * 报错原因必须是「被加密（本插件不解密）」，而不是按混淆后的字节说成「图片损坏」（那是误导读者去换图）。
 *
 * `findings` 是本层交出的事实清单（半径与严重度已标好，后果由编排层决定）；code 取值见上面的
 * `WARN_*` 常量（稳定标识，`resource` 一律是书内逻辑名）。
 */
export interface EpubPackage {
  readonly title: string | null
  readonly author: string | null
  readonly manifest: ReadonlyMap<string, EpubManifestItem>
  readonly spine: readonly string[]
  readonly spineItems: readonly EpubSpineItem[]
  /** 声明形态决定读不出的主序列文档（见 `assertSupported`）：编排层把它们落成空页 */
  readonly unreadableSpineDocs: ReadonlySet<string>
  readonly navigation: readonly EpubNavItem[]
  readonly navigationSource: EpubNavigationSource
  /** 封面候选（manifest 项，按优先级排）：EPUB3 的 `cover-image` 在前，EPUB2 的 `meta name=cover` 在后 */
  readonly coverCandidates: readonly EpubManifestItem[]
  /** 内容加密清单里的书内路径（只有 spine 之外的会走到这里：spine 的加密文档在本层就拒了） */
  readonly encryptedPaths: ReadonlySet<string>
  readonly findings: readonly FindingEntry[]
}

/**
 * 读一份 EPUB 的包结构。书级失败都经 `rejectBook` 且点名书内位置，不泄露主机路径：
 * 结构类失败点名条目名 / OPF 里的 idref / 导航文档路径；**路径类失败（href 解析不了、目标不存在）
 * 一律带上出处的文档名**——只说「越出书根」无从知道该去翻哪一份文档。
 */
export async function readEpubPackage(archive: EpubArchive, limits: Partial<EpubLimits> = {}): Promise<EpubPackage> {
  // 本层用得上 XML 单文档的三项预算（归档四项归 openEpubArchive，图片像素归正文层）
  const xmlBytes = limits.xmlBytes ?? DEFAULT_EPUB_LIMITS.xmlBytes
  const domLimits: XmlLimits = {
    depth: limits.xmlDepth ?? DEFAULT_EPUB_LIMITS.xmlDepth,
    nodes: limits.xmlNodes ?? DEFAULT_EPUB_LIMITS.xmlNodes,
  }
  const names = new Set(archive.entries.map((e) => e.name))
  const findings = new FindingLog()

  // ① 身份与容器：mimetype 立身份，container.xml 定位 OPF。缺任一项后面都读不动，先在这里点名
  if (!names.has(MIMETYPE_ENTRY)) {
    rejectBook(`EPUB 归档缺 ${MIMETYPE_ENTRY} 条目（取值应是 ${EPUB_MIMETYPE_VALUE}）：不是可读的 EPUB`)
  }
  const mimetype = (await archive.read(MIMETYPE_ENTRY)).toString('utf8').trim()
  if (mimetype !== EPUB_MIMETYPE_VALUE) {
    rejectBook(`EPUB 的 ${MIMETYPE_ENTRY} 取值不是 ${EPUB_MIMETYPE_VALUE}：${JSON.stringify(mimetype)}`)
  }
  if (!names.has(CONTAINER_PATH)) rejectBook(`EPUB 归档缺 ${CONTAINER_PATH}（OCF 容器的唯一入口）`)
  const containerBudget = xmlBudget(`OCF 容器 ${CONTAINER_PATH}`, domLimits, 'package')
  const opfPath = pickRootfile(await readXmlText(archive, CONTAINER_PATH, xmlBytes, containerBudget), CONTAINER_PATH, containerBudget, names)

  // ② OPF：结构、拒绝项与元数据（都在 parseOpf 里判完，外面拿到的是干净数据）
  const opfBudget = xmlBudget(`OPF 包文档 ${opfPath}`, domLimits, 'package')
  const opf = parseOpf(await readXmlText(archive, opfPath, xmlBytes, opfBudget), opfPath, names, opfBudget, findings)

  // ③ 内容加密：命中 spine 里任一文档即拒（正文读不出就算失败）；其余只留告警但目标集合要带出去
  //    （理由见 `encryptedPaths` 字段注：报错原因必须是「被加密」而不是「字节坏了」）
  const encryptedPaths = new Set<string>()
  if (names.has(ENCRYPTION_PATH)) {
    const spinePaths = new Set(opf.spineItems.map((s) => s.path))
    const encryptionBudget = xmlBudget(`OCF 加密清单 ${ENCRYPTION_PATH}`, domLimits, 'package')
    const encrypted = parseEncryptionTargets(await readXmlText(archive, ENCRYPTION_PATH, xmlBytes, encryptionBudget), ENCRYPTION_PATH, encryptionBudget)
    for (const path of encrypted) {
      encryptedPaths.add(path)
      if (spinePaths.has(path)) rejectBook(`EPUB 正文文档被加密（本插件不提供解密）：${path}`)
      findings.add('itemNoted', WARN_ENCRYPTED, path, '资源被加密（本插件不解密，正文里真用到时无法显示）', path)
    }
  }

  const { items: navigation, source: navigationSource } = await readNavigation(archive, names, opf, xmlBytes, domLimits, findings)

  return {
    title: opf.title,
    author: opf.author,
    manifest: opf.manifest,
    spine: opf.spine,
    spineItems: opf.spineItems,
    unreadableSpineDocs: opf.unreadableSpineDocs,
    navigation,
    navigationSource,
    coverCandidates: coverCandidates(opf.manifest, opf.metadata),
    encryptedPaths,
    findings: findings.entries(),
  }
}

/**
 * media-type 归一的**唯一实现**：小写 + 去掉参数（`; charset=utf-8`）。
 *
 * 为什么不能在比对处各写一份字面比较：RFC 2046 的 media type 不区分大小写、参数不改变资源种类，
 * 声明写全了的书（`Application/XHTML+XML`、`application/xhtml+xml; charset=utf-8`）按字面比对会
 * 被整本拒掉——那是把「书写者的写法」当成「书不可读」。归一发生在**读 manifest/容器的边界**
 * （`parseManifest`/`pickRootfile`），下游（正文层、资源层）拿到的就都是归一值，比对只需一次相等判定。
 * 代价：报错文案里显示的是归一值，不是 OPF 里的原样声明（种类判定不受影响）。
 */
export function normalizeMediaType(declared: string): string {
  const semicolon = declared.indexOf(';')
  const head = semicolon < 0 ? declared : declared.slice(0, semicolon)
  return head.trim().toLowerCase()
}

/** 元素的 `media-type` 属性归一值；属性缺失按 null（报错文案要能说「缺 media-type」） */
function mediaTypeOf(el: Element): string | null {
  const declared = attrOf(el, 'media-type')
  return declared === null ? null : normalizeMediaType(declared)
}

// ── 归档内的 href 解析 ────────────────────────────────────────────────────────────

/**
 * 从书内某份文档的位置解释一个 href。**这是归档内寻址的唯一口**（manifest href、nav/NCX 目标、
 * encryption.xml 的 URI 都走它），因为「同一个文件」在不同写法下必须归一到同一个逻辑名。
 *
 * 与 ZIP 条目名闸门的分工：条目名没有「相对于谁」的语境，越出归档根就是攻击；href 有文档目录，
 * `../Images/x.png` 是合法引用，**只有逃出书根才拒**。两者规则不能互相套用。
 *
 * 解析顺序按 URI 规则：先切 fragment 与查询串，再**解一次**百分号（`%2520` 解成字面 `%20`，不二次解码），
 * 最后按目录栈归一（`.` 丢掉，`..` 退一层）。不支持的 scheme、绝对路径、解码后的 NUL / 反斜杠都拒。
 * 每条失败都带 `fromPath`（解析基准就是那份文档）：报错指名出处，读者才有得可查。
 */
export function resolveEpubHref(fromPath: string, href: string): EpubHref {
  const raw = href.trim()
  if (raw === '') hrefFail(fromPath, `书内链接是空 href：${JSON.stringify(href)}`)
  const hash = raw.indexOf('#')
  const beforeFragment = hash < 0 ? raw : raw.slice(0, hash)
  const rawFragment = hash < 0 ? null : raw.slice(hash + 1)
  const query = beforeFragment.indexOf('?')      // 查询串不参与归档寻址（href 指向的是 ZIP 条目）
  const rawPath = query < 0 ? beforeFragment : beforeFragment.slice(0, query)
  const fragment = rawFragment === null || rawFragment === '' ? null : decodeHrefPart(rawFragment, raw, fromPath)
  if (rawPath === '') return { path: fromPath, fragment }   // 只有 fragment：目标就是文档自己

  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(rawPath)) hrefFail(fromPath, `书内链接用了不支持的 scheme（书外资源不寻址）：${raw}`)
  if (rawPath.startsWith('/')) hrefFail(fromPath, `书内链接是绝对路径（只认相对引用）：${raw}`)

  const stack = fromPath === '' ? [] : fromPath.split('/').slice(0, -1)   // 文档所在目录
  for (const segment of decodeHrefPart(rawPath, raw, fromPath).split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (stack.length === 0) hrefFail(fromPath, `书内链接越出书根（\`..\` 没有上一层可退）：${raw}`)
      stack.pop()
      continue
    }
    stack.push(segment)
  }
  if (stack.length === 0) hrefFail(fromPath, `书内链接归一后为空：${raw}`)
  return { path: stack.join('/'), fragment }
}

/**
 * 路径失败的点名一律带上**出处文档**（口径与预算的 `what` 一致）：基准为空时基准就是
 * 归档根，没有文档可点名——按归档根解析的两处（container.xml 的 rootfile、encryption.xml 的 URI）
 * 由调用方经 `rootRelativeHref` 补上自己那份文档名。
 *
 * 交出去的是 `EpubHrefError`（「这一条引用解不开」），不是书级异常：包层一条声明解不开与正文层一条
 * 链接解不开主语不同，两边各按各的半径接（见 `services/epub/errors.ts`）。
 */
function hrefFail(fromPath: string, message: string): never {
  throw new EpubHrefError(fromPath === '' ? message : `${fromPath}：${message}`)
}

/**
 * 在**按归档根解析**的语境里解释 href（OCF 容器与加密清单的 URI 都是这种口径）：基准是归档根，
 * 而出处文档是调用方（container.xml / encryption.xml）——报错点名读者能去翻的那份文件。
 * 包文档自己指不到 OPF / 加密清单指不到东西是整本书读不出，按书级收口。
 */
function rootRelativeHref(documentPath: string, href: string): string {
  try {
    return resolveEpubHref('', href).path
  } catch (e) {
    if (e instanceof EpubHrefError) rejectBook(`${documentPath}：${e.message}`)
    throw e
  }
}

/**
 * 包层解释一条 href：解不开就是**这本书的结构声明**读不出，按书级收口。
 *
 * `resolveEpubHref` 交回的是引用级失败（主语是那条引用），而包层三条路（manifest 的 href、
 * nav/NCX 的条目目标）的主语是那条声明本身——在册待裁把这类失败暂留在书级（`ADR-0061` / `ADR-0063`）。
 * 这一处收口而不是让它往外逃，否则引用级异常会穿过门面变成 500，把读者的书说成服务端坏了。
 */
function packageHref(fromPath: string, href: string): EpubHref {
  try {
    return resolveEpubHref(fromPath, href)
  } catch (e) {
    if (e instanceof EpubHrefError) rejectBook(e.message)
    throw e
  }
}

/** 百分号解码一次 + 解码后的名字闸门（NUL / 反斜杠会造成同一名字的两种解释） */
function decodeHrefPart(part: string, whole: string, fromPath: string): string {
  let decoded: string
  try {
    decoded = decodeURIComponent(part)
  } catch {
    hrefFail(fromPath, `书内链接的百分号序列不合法：${whole}`)
  }
  if (decoded.includes('\0')) hrefFail(fromPath, `书内链接解码后含 NUL：${whole}`)
  if (decoded.includes('\\')) hrefFail(fromPath, `书内链接含反斜杠（同一份书内会出现两棵目录树）：${whole}`)
  return decoded
}

// ── OPF ────────────────────────────────────────────────────────────────────────

interface OpfData {
  readonly title: string | null
  readonly author: string | null
  readonly metadata: Element | null
  readonly manifest: ReadonlyMap<string, EpubManifestItem>
  readonly spineItems: readonly EpubSpineItem[]
  readonly spine: readonly string[]
  readonly tocIdref: string | null
  readonly version: string
  /** 声明形态决定了「这一份读不出」的那些文档路径（事实；后果由编排层落空页） */
  readonly unreadableSpineDocs: ReadonlySet<string>
}

function parseOpf(text: string, opfPath: string, names: ReadonlySet<string>, budget: XmlBudget, findings: FindingLog): OpfData {
  const root = parseXml(text, budget)
  if (localName(root.name) !== 'package') rejectBook(`rootfile 指向的不是 OPF 包文档（根元素是 ${root.name}）：${opfPath}`)

  const metadata = firstChild(root, 'metadata')
  const manifest = parseManifest(root, opfPath)
  const spineEl = firstChild(root, 'spine')
  if (spineEl === null) rejectBook(`OPF 里没有 spine（没有阅读顺序）：${opfPath}`)
  const spineItems = parseSpine(spineEl, manifest, names, opfPath, findings)
  const spine = spineItems.filter((s) => s.linear).map((s) => s.path)
  if (spine.length === 0) {
    // 「根本没写」与「每一条都被剪」是两件事：后者要把第一条剪除原因带出去，
    // 否则用户只看到一句「主序列为空」，排障得自己去猜是哪一条声明、坏在哪一层
    const firstPrune = findings.entries().find((f) => f.code === WARN_ITEM_PRUNED)
    const detail = firstPrune === undefined ? '' : `；第一条被剪的原因：${firstPrune.action}`
    rejectBook(`OPF 的主序列为空（没有可用的 linear itemref：要么没写，要么每一条都指不到可读的 XHTML 文档${detail}）：${opfPath}`)
  }
  const unreadableSpineDocs = assertSupported(metadata, spineItems, manifest, opfPath, budget, findings)

  return {
    title: firstText(metadata, 'title', budget),
    author: firstText(metadata, 'creator', budget),
    metadata,
    manifest,
    spineItems,
    spine,
    tocIdref: attrOf(spineEl, 'toc'),
    version: attrOf(root, 'version') ?? '',
    unreadableSpineDocs,
  }
}

function parseManifest(root: Element, opfPath: string): Map<string, EpubManifestItem> {
  const manifestEl = firstChild(root, 'manifest')
  if (manifestEl === null) rejectBook(`OPF 里没有 manifest（没有资源清单）：${opfPath}`)
  const out = new Map<string, EpubManifestItem>()
  for (const item of childElements(manifestEl, 'item')) {
    const id = attrOf(item, 'id')
    if (id === null || id.trim() === '') rejectBook(`OPF manifest 条目缺 id：${opfPath}`)
    if (out.has(id)) rejectBook(`OPF manifest 里 id 重复：${id}（${opfPath}）`)
    const href = attrOf(item, 'href')
    if (href === null || href.trim() === '') rejectBook(`OPF manifest 条目 ${id} 缺 href：${opfPath}`)
    const mediaType = attrOf(item, 'media-type')
    if (mediaType === null || mediaType.trim() === '') rejectBook(`OPF manifest 条目 ${id} 缺 media-type：${opfPath}`)
    out.set(id, {
      id,
      path: packageHref(opfPath, href).path,
      mediaType: normalizeMediaType(mediaType),
      properties: (attrOf(item, 'properties') ?? '').trim().split(/\s+/).filter((p) => p !== ''),
    })
  }
  return out
}

/**
 * 阅读序列里读不出的那一条声明：剪掉这一条并留痕，不牵动整本书。
 *
 * 一条 `itemref` 坏掉（缺 idref、指不到 manifest、指到归档里没有的文件、同一资源出现两次）说的是
 * 「这一条声明」，不是「这本书没有阅读顺序」；只有**全部**被剪光才轮到整本判据（主序列为空那条）。
 * 剪完之后 `spine` 就是剩下的有序声明，章号由编排层按它的位置铸——只有一处算章号。
 */
function parseSpine(
  spineEl: Element,
  manifest: ReadonlyMap<string, EpubManifestItem>,
  names: ReadonlySet<string>,
  opfPath: string,
  findings: FindingLog,
): EpubSpineItem[] {
  const out: EpubSpineItem[] = []
  const seenIdrefs = new Set<string>()
  // 去重落在**解析后的路径**上：两个 id 指向同一 href 时，歧义与同一 idref 写两遍完全一样
  const seenPaths = new Map<string, string>()
  const prune = (resource: string | null, why: string): void => {
    findings.add('itemPruned', WARN_ITEM_PRUNED, resource, why)
  }
  for (const itemref of childElements(spineEl, 'itemref')) {
    const idref = attrOf(itemref, 'idref')
    if (idref === null || idref.trim() === '') { prune(opfPath, 'OPF spine 有 itemref 缺 idref（这一条进不了阅读序列）'); continue }
    const item = manifest.get(idref)
    if (item === undefined) { prune(opfPath, `OPF spine 的 idref 不在 manifest 里，这一条进不了阅读序列：${idref}`); continue }
    // 同一资源出现两次：本仓的阅读序列是「一章一个位置」，重复的那一条指不到唯一的落点，
    // 剪掉后出现的那一条并留痕（第一处照读，不是猜哪个才算）
    if (seenIdrefs.has(idref)) { prune(item.path, `OPF spine 里 idref 重复，后出现的一条被剪：${idref}`); continue }
    const previous = seenPaths.get(item.path)
    if (previous !== undefined) {
      prune(item.path, `OPF spine 里 ${previous} 与 ${idref} 指向同一路径，后出现的一条被剪：${item.path}`)
      continue
    }
    // manifest 写得出路径不等于归档里真有那份文档：这一条进不了阅读序列，但别的章照读
    if (!names.has(item.path)) { prune(item.path, `OPF spine 指向归档里不存在的文档，这一条被剪：${item.path}（idref ${idref}）`); continue }
    // 不是 XHTML 的那一条当不成阅读单元（媒体类型是包声明层面的事实，与上面的存在性校验同一层、同一口径）
    if (item.mediaType !== XHTML_MEDIA_TYPE) { prune(item.path, `OPF spine 的这一条不是可读的 XHTML 文档（media-type=${item.mediaType}），这一条被剪：${item.path}`); continue }
    seenIdrefs.add(idref)
    seenPaths.set(item.path, idref)
    const linear = attrOf(itemref, 'linear') ?? 'yes'
    // 规范只有 yes/no：写歪的那个值说不出作者要什么，按缺省 yes 读（内容在归档里、读得出就别丢），
    // 并把「这一条的声明形态不对」留痕
    if (linear !== 'yes' && linear !== 'no') {
      findings.add('itemNoted', WARN_SPINE_LINEAR_VARIANT, item.path, `OPF spine 的 linear 取值不是 yes/no（按缺省 yes 读这一条）：${linear}（${idref}）`)
    }
    out.push({
      idref,
      path: item.path,
      // 只有明确的 no 才算补充文档：写歪的值按缺省 yes 读（与上面那条痕说的是同一件事）
      linear: linear !== 'no',
      properties: (attrOf(itemref, 'properties') ?? '').trim().split(/\s+/).filter((p) => p !== ''),
    })
  }
  return out
}

/**
 * 包声明层面就能判定的「不支持」：固定版式与主序列脚本。
 *
 * 半径按**声明的主语**分：包级声明（整本书是固定版式）是书级事实，仍拒；逐文档声明只说
 * 「这一份排不动 / 要靠脚本才动得了」，交回痕与 `unreadableSpineDocs`，由编排层落空页。
 * 返回读不出的那些文档路径（事实），痕由 `findings` 记账。
 */
function assertSupported(
  metadata: Element | null,
  spineItems: readonly EpubSpineItem[],
  manifest: ReadonlyMap<string, EpubManifestItem>,
  opfPath: string,
  budget: XmlBudget,
  findings: FindingLog,
): ReadonlySet<string> {
  const unreadable = new Set<string>()
  for (const meta of metadata === null ? [] : childElements(metadata, 'meta')) {
    // EPUB3：meta property="rendition:layout">pre-paginated
    if (attrOf(meta, 'property') === 'rendition:layout' && textOf(meta, budget).trim() === 'pre-paginated') {
      rejectBook(`EPUB 声明固定版式（rendition:layout=pre-paginated），本插件只支持流式排版：${opfPath}`)
    }
    // EPUB2 时代包的固定版式声明写法：meta name="fixed-layout" content="true"
    if (attrOf(meta, 'name') === 'fixed-layout' && attrOf(meta, 'content') === 'true') {
      rejectBook(`EPUB 声明固定版式（meta name="fixed-layout" content="true"），本插件只支持流式排版：${opfPath}`)
    }
  }
  for (const entry of spineItems) {
    // 逐文档的固定版式声明（itemref properties，包级 meta 的另一种写法）只说「这一份排不动」：
    // 按流式读它、留一条痕，不因此判整本书死刑（主语是一条声明，就不是整本书）
    if (entry.properties.includes('rendition:layout-pre-paginated')) {
      findings.add('documentDegraded', WARN_FIXED_LAYOUT_DOC, entry.path,
        '文档声明为固定版式（itemref properties="rendition:layout-pre-paginated"），已按流式读（这一页的版式可能失真）')
    }
    if (!entry.linear) continue   // 补充文档里的脚本不接进阅读流，不属于「主内容」
    const item = manifest.get(entry.idref)
    if (item !== undefined && item.properties.includes('scripted')) {
      // 这一份要靠脚本才动得了：读端不执行书内脚本，交回「读不出」这份事实，由编排层落空页
      findings.add('blankDocument', WARN_SCRIPTED_DOC, item.path,
        '主序列文档声明为 scripted（本插件不执行书内脚本，这一页读不出正文）')
      unreadable.add(item.path)
    }
  }
  return unreadable
}

/** 封面候选：EPUB3 的 cover-image 优先，其次 EPUB2 的 meta name="cover" 指向的 manifest 项 */
function coverCandidates(manifest: ReadonlyMap<string, EpubManifestItem>, metadata: Element | null): EpubManifestItem[] {
  const out: EpubManifestItem[] = []
  const seen = new Set<string>()
  const add = (item: EpubManifestItem | undefined): void => {
    if (item === undefined || seen.has(item.id)) return
    seen.add(item.id)
    out.push(item)
  }
  for (const item of manifest.values()) if (item.properties.includes('cover-image')) add(item)
  if (metadata !== null) {
    for (const meta of childElements(metadata, 'meta')) {
      if (attrOf(meta, 'name') !== 'cover') continue
      const id = attrOf(meta, 'content')
      add(id === null ? undefined : manifest.get(id))
    }
  }
  return out
}

// ── 目录（nav / NCX / 合成）────────────────────────────────────────────────────

/** 目录派生的顺序：EPUB3 的 toc nav → spine 的 toc 指向的 NCX → 按 spine 合成（附告警） */
async function readNavigation(
  archive: EpubArchive,
  names: ReadonlySet<string>,
  opf: OpfData,
  xmlBytes: number,
  domLimits: XmlLimits,
  findings: FindingLog,
): Promise<{ items: EpubNavItem[]; source: EpubNavigationSource }> {
  const navItem = [...opf.manifest.values()].find((item) => item.properties.includes('nav'))
  if (navItem !== undefined) {
    // 声明了导航文档：读不出 toc 就是坏目录，不能改走 NCX/spine 把问题掩盖过去
    const navBudget = xmlBudget(`EPUB3 导航文档 ${navItem.path}`, domLimits, 'package')
    const items = parseNavDocument(await readXmlText(archive, navItem.path, xmlBytes, navBudget), navItem.path, names, navBudget, findings)
    return { items, source: 'nav' }
  }
  if (opf.tocIdref !== null) {
    const ncx = opf.manifest.get(opf.tocIdref)
    if (ncx === undefined) rejectBook(`OPF spine 的 toc 指向的 idref 不在 manifest 里：${opf.tocIdref}`)
    if (ncx.mediaType !== NCX_MEDIA_TYPE) rejectBook(`OPF spine 的 toc 指向的不是 NCX（media-type=${ncx.mediaType}）：${ncx.path}`)
    const ncxBudget = xmlBudget(`EPUB2 NCX ${ncx.path}`, domLimits, 'package')
    const items = parseNcx(await readXmlText(archive, ncx.path, xmlBytes, ncxBudget), ncx.path, names, ncxBudget, findings)
    if (opf.version.startsWith('3')) {
      findings.add('bookVariant', WARN_NAV_DEGRADED, ncx.path, 'EPUB3 包没有可用的 nav 文档，退用 spine 指向的 NCX 目录', ncx.path)
    }
    return { items, source: 'ncx' }
  }
  findings.add('bookVariant', WARN_NAV_SYNTHESIZED, null, 'EPUB 既没有 nav 文档也没有 NCX 目录，已按 spine 顺序生成平面目录（条目名取文档名）')
  return { items: opf.spine.map((path) => ({ label: epubBaseName(path), target: { path, fragment: null }, children: [] })), source: 'spine' }
}

/** EPUB3 的 nav 文档：只取 toc 那一棵（landmarks / page-list 不是正文目录） */
function parseNavDocument(
  text: string,
  navPath: string,
  names: ReadonlySet<string>,
  budget: XmlBudget,
  findings: FindingLog,
): EpubNavItem[] {
  const root = parseXml(text, budget)
  if (localName(root.name) !== 'html') rejectBook(`manifest 标为 nav 的文档不是 XHTML（根元素是 ${root.name}）：${navPath}`)
  const toc = descendants(root, 'nav', budget).find(isTocNav)
  if (toc === undefined) rejectBook(`导航文档里没有 toc 导航（landmarks / page-list 不算正文目录）：${navPath}`)
  const list = navListsOf(toc)[0]
  if (list === undefined) rejectBook(`toc 导航里没有 ol/ul 列表：${navPath}`)
  const variant = { unordered: false }
  const items = parseNavList(list, navPath, budget, variant)
  if (items.length === 0) rejectBook(`toc 导航里没有条目：${navPath}`)
  if (variant.unordered) {
    // 规范要求 ol，但有些书用 ul（嵌套层也算）：结构语义没有歧义，按列表读并把「这是变体」记下来；
    // 不因此改走合成目录，否则真实标题会被文件名盖掉。
    findings.add('itemNoted', WARN_NAV_UNORDERED, navPath, 'toc 导航使用 ul（规范要求 ol），已按列表读取', navPath)
  }
  return pruneDeadTargets(items, names, navPath, findings)
}

/** toc 的列表：规范是 ol，部分书用 ul；两者按同一语义读，顺序以 DOM 为准 */
function navListsOf(parent: Element): Element[] {
  return parent.children.filter((child): child is Element =>
    isElement(child) && (localName(child.name) === 'ol' || localName(child.name) === 'ul'))
}

/** toc nav 的两种写法：`epub:type="toc"`（前缀任意）或 `role="doc-toc"` */
function isTocNav(el: Element): boolean {
  const type = attrOf(el, 'type')
  if (type !== null && type.split(/\s+/).includes('toc')) return true
  const role = attrOf(el, 'role')
  return role !== null && role.split(/\s+/).includes('doc-toc')
}

function parseNavList(
  list: Element,
  navPath: string,
  budget: XmlBudget,
  variant: { unordered: boolean },
): EpubNavItem[] {
  if (localName(list.name) === 'ul') variant.unordered = true
  const items: EpubNavItem[] = []
  for (const li of childElements(list, 'li')) {
    const anchor = firstChild(li, 'a')
    const labelEl = anchor ?? firstChild(li, 'span')
    if (labelEl === null) rejectBook(`导航条目缺 a/span 标题：${navPath}`)
    // 无 href 的条目（含只有标题的 span）是分组标题：target 为 null，子条目照读
    const href = anchor === null ? null : attrOf(anchor, 'href')
    const target = href === null || href.trim() === '' ? null : packageHref(navPath, href)
    const children: EpubNavItem[] = []
    for (const nested of navListsOf(li)) children.push(...parseNavList(nested, navPath, budget, variant))
    items.push({ label: textOf(labelEl, budget).trim(), target, children })
  }
  return items
}

/** EPUB2 的 NCX：navPoint 可以既带 content 又有子 navPoint（父节点自己也是可跳转的目标） */
function parseNcx(text: string, ncxPath: string, names: ReadonlySet<string>, budget: XmlBudget, findings: FindingLog): EpubNavItem[] {
  const root = parseXml(text, budget)
  if (localName(root.name) !== 'ncx') rejectBook(`spine 的 toc 指向的不是 NCX 文档（根元素是 ${root.name}）：${ncxPath}`)
  const navMap = firstDescendant(root, 'navMap', budget)
  if (navMap === null) rejectBook(`NCX 里没有 navMap：${ncxPath}`)
  const items = childElements(navMap, 'navPoint').map((point) => parseNavPoint(point, ncxPath, budget))
  if (items.length === 0) rejectBook(`NCX 的 navMap 里没有 navPoint：${ncxPath}`)
  return pruneDeadTargets(items, names, ncxPath, findings)
}

function parseNavPoint(point: Element, ncxPath: string, budget: XmlBudget): EpubNavItem {
  const navLabel = firstChild(point, 'navLabel')
  if (navLabel === null) rejectBook(`NCX navPoint 缺 navLabel：${ncxPath}`)
  const textEl = firstChild(navLabel, 'text')
  const content = firstChild(point, 'content')
  const src = content === null ? null : attrOf(content, 'src')
  if (src === null || src.trim() === '') rejectBook(`NCX navPoint 缺 content/src：${ncxPath}`)
  return {
    label: textOf(textEl ?? navLabel, budget).trim(),
    target: packageHref(ncxPath, src),
    children: childElements(point, 'navPoint').map((child) => parseNavPoint(child, ncxPath, budget)),
  }
}

/**
 * 剪掉指向读不出的文档的目录条目：**只丢那一条**，它的子条目上提，父级分组与兄弟照留。
 *
 * 目录是展示树，少一条不影响这本书读不读得动；一条悬空目标就把整本书判死，是把「这一条声明」
 * 的动作主语写错了。全部条目都悬空则得到一棵空目录——仍然不是坏书（阅读序列另有判据）。
 * 声明本身就没有条目是另一件事（`parseNavDocument` / `parseNcx` 的判空分支，坏目录）：那一格的
 * 主语是导航文档的结构，这里是「有条目、只是目标指不到东西」，两格不折叠。
 */
function pruneDeadTargets(items: readonly EpubNavItem[], names: ReadonlySet<string>, navPath: string, findings: FindingLog): EpubNavItem[] {
  const out: EpubNavItem[] = []
  for (const item of items) {
    const children = pruneDeadTargets(item.children, names, navPath, findings)
    if (item.target !== null && !names.has(item.target.path)) {
      findings.add('itemPruned', WARN_ITEM_PRUNED, item.target.path,
        `目录条目指向归档里不存在的文档，这一条被剪（来源 ${navPath}）`, item.label)
      out.push(...children)
      continue
    }
    out.push({ ...item, children })
  }
  return out
}

/**
 * 文档基础名（不含扩展名）。没有更好的真实标题可依时用它（合成目录的条目名、无 title 文档的章名）：
 * 不编造也不留空。正文层也用它当章名兜底，所以是导出的命名规则（同一件事不许有两份实现）。
 */
export function epubBaseName(path: string): string {
  const slash = path.lastIndexOf('/')
  const name = slash < 0 ? path : path.slice(slash + 1)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

// ── 加密清单 ───────────────────────────────────────────────────────────────────

/** encryption.xml 的加密目标（按容器根解析）：正文层据此判「用到的图片被加密」 */
function parseEncryptionTargets(text: string, path: string, budget: XmlBudget): string[] {
  const root = parseXml(text, budget)
  if (localName(root.name) !== 'encryption') rejectBook(`加密清单的根元素不是 encryption（是 ${root.name}）：${path}`)
  const out: string[] = []
  for (const data of descendants(root, 'EncryptedData', budget)) {
    for (const ref of descendants(data, 'CipherReference', budget)) {
      const uri = attrOf(ref, 'URI') ?? attrOf(ref, 'uri')
      if (uri === null || uri.trim() === '') rejectBook(`加密清单的 CipherReference 缺 URI：${path}`)
      out.push(rootRelativeHref(path, uri))
    }
  }
  return out
}

// ── OCF 容器 ───────────────────────────────────────────────────────────────────

/**
 * 容器 → OPF 路径。多个 rootfile（多 rendition）**不拼书**：按容器声明顺序取第一个
 * media-type 受支持的那个；第一个受支持的却指向不存在的文件也是失败（不跳去下一份，
 * 那是「猜用户想要哪一本」）。
 */
function pickRootfile(text: string, containerPath: string, budget: XmlBudget, names: ReadonlySet<string>): string {
  const root = parseXml(text, budget)
  if (localName(root.name) !== 'container') rejectBook(`OCF 容器的根元素不是 container（是 ${root.name}）：${containerPath}`)
  const rootfiles = descendants(root, 'rootfile', budget)
  if (rootfiles.length === 0) rejectBook(`OCF 容器里没有 rootfile：${containerPath}`)
  const supported = rootfiles.filter((el) => mediaTypeOf(el) === OPF_MEDIA_TYPE)
  const first = supported[0]
  if (first === undefined) {
    const seen = [...new Set(rootfiles.map((el) => mediaTypeOf(el) ?? '(缺 media-type)'))].join('、')
    rejectBook(`OCF 容器里没有受支持的 rootfile（要求 media-type=${OPF_MEDIA_TYPE}，实际有：${seen}）：${containerPath}`)
  }
  const fullPath = attrOf(first, 'full-path')
  if (fullPath === null || fullPath.trim() === '') rejectBook(`OCF rootfile 缺 full-path：${containerPath}`)
  const opfPath = rootRelativeHref(containerPath, fullPath)
  if (!names.has(opfPath)) rejectBook(`OCF rootfile 指向归档里不存在的文件：${opfPath}（${containerPath}）`)
  return opfPath
}

// ── XML 读取 ───────────────────────────────────────────────────────────────────

/**
 * 读一份包文档的字节并解码：解码失败按预算的主语说话（包文档读不出＝整本拒），
 * 而预算的 `what` 已带着书内位置——单说「不是合法 UTF-8」无从知道是哪一份文档，这里不再另披一层。
 */
async function readXmlText(archive: EpubArchive, name: string, xmlBytes: number, budget: XmlBudget): Promise<string> {
  const bytes = await archive.read(name, xmlBytes)
  return decodeEpubXml(bytes, budget)
}

/** 取第一个非空的直接子元素文本（dc:title 这类可能有多条化名，第一条空的跳过） */
function firstText(parent: Element | null, local: string, budget: XmlBudget): string | null {
  if (parent === null) return null
  for (const el of childElements(parent, local)) {
    const text = textOf(el, budget).trim()
    if (text !== '') return text
  }
  return null
}
