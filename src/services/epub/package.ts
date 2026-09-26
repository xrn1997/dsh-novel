import type { Element } from 'domhandler'
import type { LocalImportWarning } from '../../shared/wire.js'
import { DEFAULT_EPUB_LIMITS, type EpubArchive, type EpubLimits } from './archive.js'
import { EpubImportError } from './errors.js'
import {
  attrOf, childElements, decodeEpubXml, descendants, firstChild, firstDescendant, localName, parseXml, textOf, xmlBudget,
  type XmlBudget, type XmlLimits,
} from './xml.js'

/**
 * EPUB 包层：把已过安全门的归档读成一份**可判定的书结构**——身份（mimetype）、OPF、
 * manifest、阅读顺序（spine）、目录目标（nav / NCX）与包级拒绝（固定版式、脚本主内容、内容加密）。
 * 单份文档的解码、只读解析与带预算的 DOM 走法归 `xml.ts`（正文层也要用同一套门与预算）。
 *
 * 三条口径（改动这一层先读它们）：
 *
 * ① **连续阅读顺序 ≠ 目录导航**。阅读单元只按 OPF spine 的 `linear` 主序列排（`spine`），
 *    ZIP 条目顺序、文件名、目录叶条数都不参与。目录是另一棵树（`navigation`）：一个叶条目点的是
 *    「文档 + 文档内锚点」，同一文档的多个锚点各自成条，不复制成多章。两者都不做一一对应的假设。
 * ② **缺目录可以降级，坏目录必须报错**。nav → spine 的 toc 指向的 NCX → 按 spine 造平面导航
 *    （这一步留持久告警）；但「声明了导航文档却读不出 toc」不是缺目录，是坏目录——报错，不静默改走别的路。
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

/** 告警码（稳定标识，导入期原样落进元数据、进书后经「导入说明」重看）：用户看到的是 message，程序按 code 分流 */
const WARN_NAV_SYNTHESIZED = 'epub-navigation-synthesized'
const WARN_NAV_DEGRADED = 'epub-navigation-degraded'
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
 * 完整声明（含 linear="no" 的补充文档）——两个字段是「派生」与「原始声明」的关系，不是两份真相。
 *
 * `encryptedPaths` 是内容加密清单（`encryption.xml` 的 CipherReference，按容器根解析成书内逻辑名）
 * 里的全部目标：spine 里的那些在本层直接拒整本，**其余带出去**——正文层真要用到某个被加密的图片时，
 * 报错原因必须是「被加密（本插件不解密）」，而不是按混淆后的字节说成「图片损坏」（那是误导读者去换图）。
 *
 * `warnings` 的 code 取值（稳定标识）：`epub-navigation-synthesized`（无目录，按 spine 合成）、
 * `epub-navigation-degraded`（EPUB3 退用 NCX）、`epub-encrypted-resource`（**未被用到**的资源被加密：
 * 留一条点名资源的说明；真被正文用到时由正文层按 `encryptedPaths` 拒绝并点名）。`resource` 一律是书内逻辑名。
 */
export interface EpubPackage {
  readonly title: string | null
  readonly author: string | null
  readonly manifest: ReadonlyMap<string, EpubManifestItem>
  readonly spine: readonly string[]
  readonly spineItems: readonly EpubSpineItem[]
  readonly navigation: readonly EpubNavItem[]
  readonly navigationSource: EpubNavigationSource
  /** 封面候选（manifest 项，按优先级排）：EPUB3 的 `cover-image` 在前，EPUB2 的 `meta name=cover` 在后 */
  readonly coverCandidates: readonly EpubManifestItem[]
  /** 内容加密清单里的书内路径（只有 spine 之外的会走到这里：spine 的加密文档在本层就拒了） */
  readonly encryptedPaths: ReadonlySet<string>
  readonly warnings: readonly LocalImportWarning[]
}

/**
 * 读一份 EPUB 的包结构。所有失败都是 `EpubImportError` 且点名书内位置，不泄露主机路径：
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
  const warnings: LocalImportWarning[] = []

  // ① 身份与容器：mimetype 立身份，container.xml 定位 OPF。缺任一项后面都读不动，先在这里点名
  if (!names.has(MIMETYPE_ENTRY)) {
    throw new EpubImportError(`EPUB 归档缺 ${MIMETYPE_ENTRY} 条目（取值应是 ${EPUB_MIMETYPE_VALUE}）：不是可读的 EPUB`)
  }
  const mimetype = (await archive.read(MIMETYPE_ENTRY)).toString('utf8').trim()
  if (mimetype !== EPUB_MIMETYPE_VALUE) {
    throw new EpubImportError(`EPUB 的 ${MIMETYPE_ENTRY} 取值不是 ${EPUB_MIMETYPE_VALUE}：${JSON.stringify(mimetype)}`)
  }
  if (!names.has(CONTAINER_PATH)) throw new EpubImportError(`EPUB 归档缺 ${CONTAINER_PATH}（OCF 容器的唯一入口）`)
  const containerBudget = xmlBudget(`OCF 容器 ${CONTAINER_PATH}`, domLimits)
  const opfPath = pickRootfile(await readXmlText(archive, CONTAINER_PATH, xmlBytes), CONTAINER_PATH, containerBudget, names)

  // ② OPF：结构、拒绝项与元数据（都在 parseOpf 里判完，外面拿到的是干净数据）
  const opf = parseOpf(await readXmlText(archive, opfPath, xmlBytes), opfPath, names, domLimits)

  // ③ 内容加密：命中 spine 里任一文档即拒（正文读不出就算失败）；其余（未使用的字体等）只留告警，
  //    但目标集合要带出去——正文里真用到某份被加密的资源时，报错原因必须是「被加密」而不是「字节坏了」
  const encryptedPaths = new Set<string>()
  if (names.has(ENCRYPTION_PATH)) {
    const spinePaths = new Set(opf.spineItems.map((s) => s.path))
    const encryptionBudget = xmlBudget(`OCF 加密清单 ${ENCRYPTION_PATH}`, domLimits)
    const encrypted = parseEncryptionTargets(await readXmlText(archive, ENCRYPTION_PATH, xmlBytes), ENCRYPTION_PATH, encryptionBudget)
    for (const path of encrypted) {
      encryptedPaths.add(path)
      if (spinePaths.has(path)) throw new EpubImportError(`EPUB 正文文档被加密（本插件不提供解密）：${path}`)
      warnings.push({
        code: WARN_ENCRYPTED,
        message: `资源被加密（本插件不解密，正文里真用到时无法显示）：${path}`,
        resource: path,
      })
    }
  }

  const { items: navigation, source: navigationSource } = await readNavigation(archive, names, opf, xmlBytes, domLimits, warnings)

  return {
    title: opf.title,
    author: opf.author,
    manifest: opf.manifest,
    spine: opf.spine,
    spineItems: opf.spineItems,
    navigation,
    navigationSource,
    coverCandidates: coverCandidates(opf.manifest, opf.metadata),
    encryptedPaths,
    warnings,
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
 * 路径失败的报错一律点名**出处文档**（口径与 `readXmlText` 的文档名包装一致）：基准为空时基准就是
 * 归档根，没有文档可点名——按归档根解析的两处（container.xml 的 rootfile、encryption.xml 的 URI）
 * 由调用方经 `rootRelativeHref` 补上自己那份文档名。
 */
function hrefFail(fromPath: string, message: string): never {
  throw new EpubImportError(fromPath === '' ? message : `${fromPath}：${message}`)
}

/**
 * 在**按归档根解析**的语境里解释 href（OCF 容器与加密清单的 URI 都是这种口径）：基准是归档根，
 * 但出处的文档是调用方（container.xml / encryption.xml）——报错点名读者能去翻的那份文件。
 */
function rootRelativeHref(documentPath: string, href: string): string {
  try {
    return resolveEpubHref('', href).path
  } catch (e) {
    if (e instanceof EpubImportError) throw new EpubImportError(`${documentPath}：${e.message}`)
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
}

function parseOpf(text: string, opfPath: string, names: ReadonlySet<string>, domLimits: XmlLimits): OpfData {
  const budget = xmlBudget(`OPF 包文档 ${opfPath}`, domLimits)
  const root = parseXml(text, budget)
  if (localName(root.name) !== 'package') throw new EpubImportError(`rootfile 指向的不是 OPF 包文档（根元素是 ${root.name}）：${opfPath}`)

  const metadata = firstChild(root, 'metadata')
  const manifest = parseManifest(root, opfPath)
  const spineEl = firstChild(root, 'spine')
  if (spineEl === null) throw new EpubImportError(`OPF 里没有 spine（没有阅读顺序）：${opfPath}`)
  const spineItems = parseSpine(spineEl, manifest, names, opfPath)
  const spine = spineItems.filter((s) => s.linear).map((s) => s.path)
  if (spine.length === 0) throw new EpubImportError(`OPF 的主序列为空（spine 里没有 linear 的 itemref）：${opfPath}`)
  assertSupported(metadata, spineItems, manifest, opfPath, budget)

  return {
    title: firstText(metadata, 'title', budget),
    author: firstText(metadata, 'creator', budget),
    metadata,
    manifest,
    spineItems,
    spine,
    tocIdref: attrOf(spineEl, 'toc'),
    version: attrOf(root, 'version') ?? '',
  }
}

function parseManifest(root: Element, opfPath: string): Map<string, EpubManifestItem> {
  const manifestEl = firstChild(root, 'manifest')
  if (manifestEl === null) throw new EpubImportError(`OPF 里没有 manifest（没有资源清单）：${opfPath}`)
  const out = new Map<string, EpubManifestItem>()
  for (const item of childElements(manifestEl, 'item')) {
    const id = attrOf(item, 'id')
    if (id === null || id.trim() === '') throw new EpubImportError(`OPF manifest 条目缺 id：${opfPath}`)
    if (out.has(id)) throw new EpubImportError(`OPF manifest 里 id 重复：${id}（${opfPath}）`)
    const href = attrOf(item, 'href')
    if (href === null || href.trim() === '') throw new EpubImportError(`OPF manifest 条目 ${id} 缺 href：${opfPath}`)
    const mediaType = attrOf(item, 'media-type')
    if (mediaType === null || mediaType.trim() === '') throw new EpubImportError(`OPF manifest 条目 ${id} 缺 media-type：${opfPath}`)
    out.set(id, {
      id,
      path: resolveEpubHref(opfPath, href).path,
      mediaType: normalizeMediaType(mediaType),
      properties: (attrOf(item, 'properties') ?? '').trim().split(/\s+/).filter((p) => p !== ''),
    })
  }
  return out
}

function parseSpine(
  spineEl: Element,
  manifest: ReadonlyMap<string, EpubManifestItem>,
  names: ReadonlySet<string>,
  opfPath: string,
): EpubSpineItem[] {
  const out: EpubSpineItem[] = []
  const seenIdrefs = new Set<string>()
  // 去重落在**解析后的路径**上：两个 id 指向同一 href 时，歧义与同一 idref 写两遍完全一样
  const seenPaths = new Map<string, string>()
  for (const itemref of childElements(spineEl, 'itemref')) {
    const idref = attrOf(itemref, 'idref')
    if (idref === null || idref.trim() === '') throw new EpubImportError(`OPF spine 的 itemref 缺 idref：${opfPath}`)
    const item = manifest.get(idref)
    if (item === undefined) throw new EpubImportError(`OPF spine 的 idref 不在 manifest 里：${idref}（${opfPath}）`)
    // 同一资源出现两次会让「第几章」与文档锚点目标都产生歧义，本仓明确拒绝（不猜哪一次才算）
    if (seenIdrefs.has(idref)) throw new EpubImportError(`OPF spine 里 idref 重复：${idref}（同一资源不得在阅读序列里出现两次）`)
    const previous = seenPaths.get(item.path)
    if (previous !== undefined) {
      throw new EpubImportError(`OPF spine 里 idref 重复：${previous} 与 ${idref} 指向同一路径 ${item.path}（同一资源不得在阅读序列里出现两次）`)
    }
    // manifest 写得出路径不等于归档里真有那份文档：悬空的 spine 项会留下读不出的「章节」，与导航目标同口径
    if (!names.has(item.path)) {
      throw new EpubImportError(`OPF spine 指向归档里不存在的文档：${item.path}（idref ${idref}；${opfPath}）`)
    }
    seenIdrefs.add(idref)
    seenPaths.set(item.path, idref)
    const linear = attrOf(itemref, 'linear') ?? 'yes'
    if (linear !== 'yes' && linear !== 'no') throw new EpubImportError(`OPF spine 的 linear 取值不是 yes/no：${linear}（${idref}）`)
    out.push({
      idref,
      path: item.path,
      linear: linear === 'yes',
      properties: (attrOf(itemref, 'properties') ?? '').trim().split(/\s+/).filter((p) => p !== ''),
    })
  }
  return out
}

/** 包声明层面就能判定的「不支持」：固定版式、主序列脚本。内容层面的检查（图片/链接/活动内容）归正文层 */
function assertSupported(
  metadata: Element | null,
  spineItems: readonly EpubSpineItem[],
  manifest: ReadonlyMap<string, EpubManifestItem>,
  opfPath: string,
  budget: XmlBudget,
): void {
  for (const meta of metadata === null ? [] : childElements(metadata, 'meta')) {
    // EPUB3：meta property="rendition:layout">pre-paginated
    if (attrOf(meta, 'property') === 'rendition:layout' && textOf(meta, budget).trim() === 'pre-paginated') {
      throw new EpubImportError(`EPUB 声明固定版式（rendition:layout=pre-paginated），本插件只支持流式排版：${opfPath}`)
    }
    // EPUB2（iBooks / Kindle 的写法）：meta name="fixed-layout" content="true"
    if (attrOf(meta, 'name') === 'fixed-layout' && attrOf(meta, 'content') === 'true') {
      throw new EpubImportError(`EPUB 声明固定版式（meta name="fixed-layout" content="true"），本插件只支持流式排版：${opfPath}`)
    }
  }
  for (const entry of spineItems) {
    // 逐文档的固定版式声明（itemref properties，包级 meta 的另一种写法）同样等于「这份文档排不动」：
    // 与 scripted 不同，这里**不**看 linear——包级形态一律拒整本，且补充文档（脚注/附录）也由读端渲染，
    // 放一份排不动的文档进来就是假报支持
    if (entry.properties.includes('rendition:layout-pre-paginated')) {
      throw new EpubImportError(`EPUB 文档声明为固定版式（itemref properties="rendition:layout-pre-paginated"），本插件只支持流式排版：${entry.path}`)
    }
    if (!entry.linear) continue   // 补充文档里的脚本不接进阅读流，不属于「主内容」
    const item = manifest.get(entry.idref)
    if (item !== undefined && item.properties.includes('scripted')) {
      throw new EpubImportError(`EPUB 主序列文档声明为 scripted（本插件不执行书内脚本）：${item.path}`)
    }
  }
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
  warnings: LocalImportWarning[],
): Promise<{ items: EpubNavItem[]; source: EpubNavigationSource }> {
  const navItem = [...opf.manifest.values()].find((item) => item.properties.includes('nav'))
  if (navItem !== undefined) {
    // 声明了导航文档：读不出 toc 就是坏目录，不能改走 NCX/spine 把问题掩盖过去
    const items = parseNavDocument(await readXmlText(archive, navItem.path, xmlBytes), navItem.path, names, domLimits)
    return { items, source: 'nav' }
  }
  if (opf.tocIdref !== null) {
    const ncx = opf.manifest.get(opf.tocIdref)
    if (ncx === undefined) throw new EpubImportError(`OPF spine 的 toc 指向的 idref 不在 manifest 里：${opf.tocIdref}`)
    if (ncx.mediaType !== NCX_MEDIA_TYPE) throw new EpubImportError(`OPF spine 的 toc 指向的不是 NCX（media-type=${ncx.mediaType}）：${ncx.path}`)
    const items = parseNcx(await readXmlText(archive, ncx.path, xmlBytes), ncx.path, names, domLimits)
    if (opf.version.startsWith('3')) {
      warnings.push({
        code: WARN_NAV_DEGRADED,
        message: `EPUB3 包没有可用的 nav 文档，退用 spine 指向的 NCX 目录：${ncx.path}`,
        resource: ncx.path,
      })
    }
    return { items, source: 'ncx' }
  }
  warnings.push({
    code: WARN_NAV_SYNTHESIZED,
    message: 'EPUB 既没有 nav 文档也没有 NCX 目录，已按 spine 顺序生成平面目录（条目名取文档名）',
    resource: null,
  })
  return { items: opf.spine.map((path) => ({ label: epubBaseName(path), target: { path, fragment: null }, children: [] })), source: 'spine' }
}

/** EPUB3 的 nav 文档：只取 toc 那一棵（landmarks / page-list 不是正文目录） */
function parseNavDocument(text: string, navPath: string, names: ReadonlySet<string>, domLimits: XmlLimits): EpubNavItem[] {
  const budget = xmlBudget(`EPUB3 导航文档 ${navPath}`, domLimits)
  const root = parseXml(text, budget)
  if (localName(root.name) !== 'html') throw new EpubImportError(`manifest 标为 nav 的文档不是 XHTML（根元素是 ${root.name}）：${navPath}`)
  const toc = descendants(root, 'nav', budget).find(isTocNav)
  if (toc === undefined) throw new EpubImportError(`导航文档里没有 toc 导航（landmarks / page-list 不算正文目录）：${navPath}`)
  const list = firstChild(toc, 'ol')
  if (list === null) throw new EpubImportError(`toc 导航里没有 ol 列表：${navPath}`)
  const items = parseNavList(list, navPath, budget)
  if (items.length === 0) throw new EpubImportError(`toc 导航里没有条目：${navPath}`)
  assertTargetsExist(items, names, navPath)
  return items
}

/** toc nav 的两种写法：`epub:type="toc"`（前缀任意）或 `role="doc-toc"` */
function isTocNav(el: Element): boolean {
  const type = attrOf(el, 'type')
  if (type !== null && type.split(/\s+/).includes('toc')) return true
  const role = attrOf(el, 'role')
  return role !== null && role.split(/\s+/).includes('doc-toc')
}

function parseNavList(ol: Element, navPath: string, budget: XmlBudget): EpubNavItem[] {
  const items: EpubNavItem[] = []
  for (const li of childElements(ol, 'li')) {
    const anchor = firstChild(li, 'a')
    const labelEl = anchor ?? firstChild(li, 'span')
    if (labelEl === null) throw new EpubImportError(`导航条目缺 a/span 标题：${navPath}`)
    // 无 href 的条目（含只有标题的 span）是分组标题：target 为 null，子条目照读
    const href = anchor === null ? null : attrOf(anchor, 'href')
    const target = href === null || href.trim() === '' ? null : resolveEpubHref(navPath, href)
    const children: EpubNavItem[] = []
    for (const nested of childElements(li, 'ol')) children.push(...parseNavList(nested, navPath, budget))
    items.push({ label: textOf(labelEl, budget).trim(), target, children })
  }
  return items
}

/** EPUB2 的 NCX：navPoint 可以既带 content 又有子 navPoint（父节点自己也是可跳转的目标） */
function parseNcx(text: string, ncxPath: string, names: ReadonlySet<string>, domLimits: XmlLimits): EpubNavItem[] {
  const budget = xmlBudget(`EPUB2 NCX ${ncxPath}`, domLimits)
  const root = parseXml(text, budget)
  if (localName(root.name) !== 'ncx') throw new EpubImportError(`spine 的 toc 指向的不是 NCX 文档（根元素是 ${root.name}）：${ncxPath}`)
  const navMap = firstDescendant(root, 'navMap', budget)
  if (navMap === null) throw new EpubImportError(`NCX 里没有 navMap：${ncxPath}`)
  const items = childElements(navMap, 'navPoint').map((point) => parseNavPoint(point, ncxPath, budget))
  if (items.length === 0) throw new EpubImportError(`NCX 的 navMap 里没有 navPoint：${ncxPath}`)
  assertTargetsExist(items, names, ncxPath)
  return items
}

function parseNavPoint(point: Element, ncxPath: string, budget: XmlBudget): EpubNavItem {
  const navLabel = firstChild(point, 'navLabel')
  if (navLabel === null) throw new EpubImportError(`NCX navPoint 缺 navLabel：${ncxPath}`)
  const textEl = firstChild(navLabel, 'text')
  const content = firstChild(point, 'content')
  const src = content === null ? null : attrOf(content, 'src')
  if (src === null || src.trim() === '') throw new EpubImportError(`NCX navPoint 缺 content/src：${ncxPath}`)
  return {
    label: textOf(textEl ?? navLabel, budget).trim(),
    target: resolveEpubHref(ncxPath, src),
    children: childElements(point, 'navPoint').map((child) => parseNavPoint(child, ncxPath, budget)),
  }
}

/** 导航目标必须命中归档里真实存在的条目：坏目标不许冒充成功（锚点是否命中由正文层判） */
function assertTargetsExist(items: readonly EpubNavItem[], names: ReadonlySet<string>, navPath: string): void {
  for (const item of items) {
    if (item.target !== null && !names.has(item.target.path)) {
      throw new EpubImportError(`导航目标指向归档里不存在的文档：${item.target.path}（导航：${navPath}）`)
    }
    assertTargetsExist(item.children, names, navPath)
  }
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
  if (localName(root.name) !== 'encryption') throw new EpubImportError(`加密清单的根元素不是 encryption（是 ${root.name}）：${path}`)
  const out: string[] = []
  for (const data of descendants(root, 'EncryptedData', budget)) {
    for (const ref of descendants(data, 'CipherReference', budget)) {
      const uri = attrOf(ref, 'URI') ?? attrOf(ref, 'uri')
      if (uri === null || uri.trim() === '') throw new EpubImportError(`加密清单的 CipherReference 缺 URI：${path}`)
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
  if (localName(root.name) !== 'container') throw new EpubImportError(`OCF 容器的根元素不是 container（是 ${root.name}）：${containerPath}`)
  const rootfiles = descendants(root, 'rootfile', budget)
  if (rootfiles.length === 0) throw new EpubImportError(`OCF 容器里没有 rootfile：${containerPath}`)
  const supported = rootfiles.filter((el) => mediaTypeOf(el) === OPF_MEDIA_TYPE)
  if (supported.length === 0) {
    const seen = [...new Set(rootfiles.map((el) => mediaTypeOf(el) ?? '(缺 media-type)'))].join('、')
    throw new EpubImportError(`OCF 容器里没有受支持的 rootfile（要求 media-type=${OPF_MEDIA_TYPE}，实际有：${seen}）：${containerPath}`)
  }
  const fullPath = attrOf(supported[0], 'full-path')
  if (fullPath === null || fullPath.trim() === '') throw new EpubImportError(`OCF rootfile 缺 full-path：${containerPath}`)
  const opfPath = rootRelativeHref(containerPath, fullPath)
  if (!names.has(opfPath)) throw new EpubImportError(`OCF rootfile 指向归档里不存在的文件：${opfPath}（${containerPath}）`)
  return opfPath
}

// ── XML 读取 ───────────────────────────────────────────────────────────────────

/** 读一份 XML 并解码；解码失败补上**书内位置**（单说「不是合法 UTF-8」无从知道是哪一份文档） */
async function readXmlText(archive: EpubArchive, name: string, xmlBytes: number): Promise<string> {
  const bytes = await archive.read(name, xmlBytes)
  try {
    return decodeEpubXml(bytes)
  } catch (e) {
    if (e instanceof EpubImportError) throw new EpubImportError(`${name}：${e.message}`)
    throw e
  }
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
