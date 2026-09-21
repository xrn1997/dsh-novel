import { appendTail, withImplicitText } from '../engine/grammar.js'
import type { NormalizedRules, SourceContentKind } from './types.js'

export interface NormalizeIssue { field: string; message: string }
export interface NormalizeResult {
  ok: boolean
  /** 必填缺失（bookSourceName/bookSourceUrl/ruleContent） */
  missing: NormalizeIssue[]
  /** header 解析失败、searchUrl 形态不支持等 */
  warnings: NormalizeIssue[]
  /** ok 时存在；id/importedAt/status 由 SourceRegistry 生成 */
  source?: {
    name: string; baseUrl: string; enabled: boolean; groups: string[]
    type: SourceContentKind
    raw: unknown; rules: NormalizedRules
  }
}

const RULE_FIELDS = [
  'searchUrl', 'exploreUrl', 'ruleBookList', 'ruleBookName', 'ruleAuthor', 'ruleBookUrl',
  'ruleCoverUrl', 'ruleIntro', 'ruleLastChapter', 'ruleTocUrl', 'ruleChapterName',
  'ruleChapterUrl', 'ruleContent', 'nextTocUrl', 'nextPageUrl', 'loginUrl',
] as const

/** 对象方言子字段 → 模型字段映射（legado 嵌套导出形态）。
 * 搜索上下文（ruleSearch）落搜索面字段；详情上下文（ruleBookInfo）落 ruleDetail*——
 * 实测 508/541 两上下文规则不同，混用会造垃圾标题（open item ③ 同款陷阱）。 */
const DIALECT_MAP: Record<string, Record<string, string>> = {
  ruleSearch: {
    bookList: 'ruleBookList', name: 'ruleBookName', author: 'ruleAuthor', bookUrl: 'ruleBookUrl',
    coverUrl: 'ruleCoverUrl', intro: 'ruleIntro', lastChapter: 'ruleLastChapter',
  },
  ruleBookInfo: {
    init: 'ruleDetailInit',
    name: 'ruleDetailName', author: 'ruleDetailAuthor', coverUrl: 'ruleDetailCoverUrl',
    intro: 'ruleDetailIntro', lastChapter: 'ruleDetailLastChapter', tocUrl: 'ruleTocUrl',
  },
  ruleToc: {
    chapterList: 'ruleChapterList', chapterName: 'ruleChapterName', chapterUrl: 'ruleChapterUrl',
    nextTocUrl: 'nextTocUrl',
  },
  ruleContent: {
    content: 'ruleContent', nextContentUrl: 'nextPageUrl',
  },
}

/** Native（android-ebook 原生规则格式）子字段 → 模型字段映射（legado 规则文档（android-ebook））。
 * 与 legado 方言同构但键名不同：list/name/url 三件套、ruleContent.nextPage/replaceRules[]。 */
const NATIVE_MAP: Record<string, Record<string, string>> = {
  ruleSearch: {
    list: 'ruleBookList', name: 'ruleBookName', author: 'ruleAuthor', bookUrl: 'ruleBookUrl',
    coverUrl: 'ruleCoverUrl', intro: 'ruleIntro', lastChapter: 'ruleLastChapter',
  },
  ruleBookInfo: {
    init: 'ruleDetailInit',
    name: 'ruleDetailName', author: 'ruleDetailAuthor', coverUrl: 'ruleDetailCoverUrl',
    intro: 'ruleDetailIntro', lastChapter: 'ruleDetailLastChapter', tocUrl: 'ruleTocUrl',
  },
  ruleToc: {
    list: 'ruleChapterList', name: 'ruleChapterName', url: 'ruleChapterUrl', nextPage: 'nextTocUrl',
  },
}

/** Native 子字段由映射表之外的专门逻辑处理（不点名 unsupported）：authorPrefix → ##净化尾 */
const NATIVE_HANDLED_SUBS: Record<string, ReadonlySet<string>> = {
  ruleBookInfo: new Set(['authorPrefix']),
}

export function normalizeSource(raw: unknown): NormalizeResult {
  const missing: NormalizeIssue[] = []
  const warnings: NormalizeIssue[] = []
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, missing: [{ field: '(根)', message: '书源必须是 JSON 对象' }], warnings }
  }
  const obj = raw as Record<string, unknown>
  // 对象方言先展平进一个合并视图（平铺字段优先，对象只填空缺；raw 不动）
  // Native 判别（与安卓端「顶层含 bookSourceUrl → 脚本格式」互补）：顶层 name+url 且无
  // bookSourceName → android-ebook 原生规则格式，走 Native 映射；两形态字段并存时 legado 优先。
  const r = isNativeSource(obj) ? flattenNative(obj, warnings) : flattenDialect(obj, warnings)
  const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null)

  const nameRaw = str(r.bookSourceName); if (!nameRaw) missing.push({ field: 'bookSourceName', message: '缺书源名称' })
  // 名称前缀图标剥离（修复 2026-09-16）：上游书源包惯用分组图标打头（「⚡📂听小说APP」——图标就是
  // 它自己分组的图标，给 legado 界面看的）；本插件分组已独立成列，名字再带一遍是重复。
  const name = nameRaw === null ? null : stripLeadingIcons(nameRaw)
  const baseUrl = str(r.bookSourceUrl); if (!baseUrl) missing.push({ field: 'bookSourceUrl', message: '缺书源地址' })
  // bookSourceType：非文本源点名拒绝——图片/音频/文件源规则体系完全不同，落到 ruleContent 校验
  // 会报「缺正文规则」，语义误导（它不是缺规则，是本插件不支持）。认不出的编码同样拒绝：
  // 读不懂不等于文本，宁可不入库也不拿它当文本源参搜（书架诊断实证：误标 text 的短剧源混进了文字书架）。
  const type = kindOfSourceValue(r.bookSourceType)
  if (type !== 'text') {
    missing.push({ field: 'bookSourceType', message:
      `类型 ${JSON.stringify(r.bookSourceType)}（${SOURCE_KIND_LABEL[type]}）——本插件仅支持文本源（0）` })
  }
  const ruleContent = str(r.ruleContent); if (!ruleContent) missing.push({ field: 'ruleContent', message: '缺正文规则（ruleContent 需为字符串，或对象形态下含非空 content 子字段）' })
  if (missing.length > 0) return { ok: false, missing, warnings }

  const rules = {} as NormalizedRules
  for (const f of RULE_FIELDS) (rules as unknown as Record<string, unknown>)[f] = str(r[f])
  rules.searchUrl = normalizeSearchUrl(r.searchUrl, warnings)
  // header 单字段两形态（legado BaseSource.getHeaderMap 口径）：`@js:`/`<js>` 规则 → headerRule；
  // JSON 对象/JSON 串 → header。两者互斥（同一 raw.header 二选一），规则形态不再是「非法 JSON」警告。
  rules.headerRule = normalizeHeaderRule(r.header)
  rules.header = rules.headerRule === null ? normalizeHeader(r.header, warnings) : null
  // ruleDetail*/ruleChapterList 非 RULE_FIELDS 成员（legado 平铺无此字段名），单独落位
  rules.ruleDetailName = str(r.ruleDetailName)
  rules.ruleDetailAuthor = str(r.ruleDetailAuthor)
  rules.ruleDetailCoverUrl = str(r.ruleDetailCoverUrl)
  rules.ruleDetailIntro = str(r.ruleDetailIntro)
  rules.ruleDetailLastChapter = str(r.ruleDetailLastChapter)
  rules.ruleDetailInit = str(r.ruleDetailInit)
  rules.ruleChapterList = str(r.ruleChapterList)
  rules.jsLib = str(r.jsLib)

  const groupsRaw = r.bookSourceGroup
  const groups = typeof groupsRaw === 'string'
    ? splitGroups(groupsRaw)
    : Array.isArray(groupsRaw) ? groupsRaw.filter((g): g is string => typeof g === 'string') : []

  return {
    ok: true, missing, warnings,
    source: {
      name: name!, baseUrl: baseUrl!,
      enabled: typeof r.enabled === 'boolean' ? r.enabled : true,
      groups, type, raw, rules,
    },
  }
}

/** 内容形态中文名（只服务导入拒绝文案——列表不渲染 type）。Record 由编译器强制穷尽，
 *  故它同时是**值域见证**：`SourceRegistry.load` 用 `type in SOURCE_KIND_LABEL` 判旧数据的
 *  type 还在不在域内，不再手写第三份形态清单。 */
export const SOURCE_KIND_LABEL: Record<SourceContentKind, string> = {
  text: '文本', image: '图片', audio: '音频', file: '文件', unknown: '未知',
}

/** 分组串拆分（修复 2026-09-16：一个源可属多个分组，此前只按 `\` 拆——真实导出用的是
 *  半角逗号 `,`（实测本库 201 源全为逗号、零个反斜杠），逗号粘连把多组并成一个假组名，
 *  下拉/筛选全错位。兼容三种分隔符：`,`（主流）/`\`（阅读 App 文档口径）/`，`（全角）；
 *  trim + 去空段 + 段内去重。存量脏数据由 SourceRegistry.load 迁移收敛。 */
export function splitGroups(raw: string): string[] {
  const out: string[] = []
  for (const part of raw.split(/[\\,，]/)) {
    const g = part.trim()
    if (g !== '' && !out.includes(g)) out.push(g)
  }
  return out
}

/** 名称前缀图标剥离（修复 2026-09-16）：只剥「开头连续的装饰符号段」——\p{So}\p{Sk} 覆盖
 *  ⚡📂🎬 等全部杂项符号，FE0F(变体选择符)/200D(ZWJ) 是 emoji 组合件。实测本库 55 个前缀、
 *  0 个尾部、0 个中部——只剥前缀零误伤；【】等括号是 Po/Ps 不在列（可能是名字本体装饰）。
 *  剥完为空（整名都是图标）→ 保留原名（宁丑不空）。 */
export function stripLeadingIcons(name: string): string {
  const stripped = name.replace(/^[\s\p{So}\p{Sk}\uFE0F\u200D]+/u, '').trimStart()
  return stripped === '' ? name : stripped
}

/** legado bookSourceType → 内容形态（真值锚点：legado-with-MD3 `constant/BookSourceType.kt`
 *  「1 音频、2 图片、3 文件」；此前本仓把 1/2 读反成 image/audio——漫画/短剧源被误标后混进
 *  聚合搜索与文字书架，书架诊断实证）：0/-1/缺省=文本（-1=ALL 在源里罕见，按文本放行）。
 *  **唯一映射表**：normalize 的拒绝文案与 SourceRegistry.load 的存量重推共用这一份，
 *  不存在第二份编码抄本（wire 单点纪律）。认不出的值 → 'unknown'：读不懂不等于文本。 */
export const CONTENT_KIND_OF: Record<number, SourceContentKind> = {
  0: 'text', [-1]: 'text', 1: 'audio', 2: 'image', 3: 'file',
}

/** bookSourceType 原始值 → 内容形态。**认得出才算数**：0/-1/缺省=文本，1/2/3=音频/图片/文件，
 *  其余一律 unknown（legado 侧该字段是 Int，非 number 的形态本身就不是合法编码——不必再分
 *  「表外值」与「脏值」两类）。`typeof` 那道闸是必需的：数值键会强转，`CONTENT_KIND_OF['0']`
 *  竟返回 'text'。导入预检与存量重推共用此单点，两侧「读不懂」的判据不分岔。 */
function kindOfSourceValue(v: unknown): SourceContentKind {
  if (v === undefined || v === null) return 'text'
  return typeof v === 'number' ? CONTENT_KIND_OF[v] ?? 'unknown' : 'unknown'
}

/** raw.bookSourceType → 内容形态（quiet 版，供 SourceRegistry.load 存量重推）：
 *  缺省/0/-1 → 'text'，其余（1/2/3 与认不出的值）→ 对应形态或 'unknown'——旧数据当年按
 *  文本入库的误标在此按 raw 重推收敛出去，不再当文本源参搜；raw 不是对象 → undefined（别动）。 */
export function contentTypeOfRaw(raw: unknown): SourceContentKind | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  return kindOfSourceValue((raw as Record<string, unknown>).bookSourceType)
}

/** raw 的详情初始化规则原文（quiet 版，供 SourceRegistry.load 存量重推——normalize 只在
 *  入库时映射 `ruleBookInfo.init → ruleDetailInit`，存量 rules 是旧版派生、缺此键，
 *  缺键则详情换根静默不生效、tocUrl 模板 Miss 回退 → EmptyToc（QQ 源真机判别实证）。
 *  返回：init 原文 / 'null'（raw 在场但没有 init）/ undefined（raw 不是对象，调用方别动）。 */
export function rawRuleDetailInit(raw: unknown): string | null | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const r = raw as Record<string, unknown>
  const info = r.ruleBookInfo
  const init = typeof info === 'object' && info !== null
    ? (info as Record<string, unknown>).init
    : r.ruleDetailInit
  if (typeof init === 'string' && init.trim() !== '') return init
  return null
}

/**
 * 对象方言展平：五个规则字段（ruleSearch/ruleExplore/ruleBookInfo/ruleToc/ruleContent）
 * 为对象时，把已映射子字段填进合并视图的目标位（平铺字段已占的位不覆盖——平铺优先）。
 * 未映射且非空的子字段如实聚合 warning（宁吵不瞒）；ruleExplore 整块 v1 未支持（无 explore 面）。
 * ruleContent.replaceRegex 追加 `##regex##` 净化尾（legado 语义：匹配替换为空串）。
 */
function flattenDialect(raw: Record<string, unknown>, warnings: NormalizeIssue[]): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw }
  const setIfVacant = (field: string, value: unknown): void => {
    const cur = out[field]
    const occupied = typeof cur === 'string' && cur.length > 0
    if (!occupied && typeof value === 'string' && value.length > 0) out[field] = value
  }
  const unsupported: string[] = []
  for (const [objField, mapping] of Object.entries(DIALECT_MAP)) {
    const obj = raw[objField]
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) continue
    for (const [sub, v] of Object.entries(obj)) {
      const field = mapping[sub]
      if (field !== undefined) {
        if (typeof v === 'string' && v.length > 0) setIfVacant(field, v)
      } else if (typeof v === 'string' && v.length > 0) {
        unsupported.push(`${objField}.${sub}`)   // 非空才点名（legado 导出空字段一大片，全列是噪音）
      }
    }
  }
  // replaceRegex：仅当正文规则来自对象 content 时追加（本分支即「raw.ruleContent 是对象」——不存在
  // 「对象 content 被平铺 ruleContent 顶掉」的形态，同一键不可能又对象又平铺字符串）；
  // 拼串归 grammar.appendTail（round-trip 自校验，越界当场 warning）
  const contentObj = raw.ruleContent
  if (typeof contentObj === 'object' && contentObj !== null && !Array.isArray(contentObj)) {
    const rr = (contentObj as Record<string, unknown>).replaceRegex
    if (typeof rr === 'string' && rr.length > 0 && typeof out.ruleContent === 'string') {
      const t = appendTail(out.ruleContent, rr, '')
      if (t.warning !== null) warnings.push({ field: 'ruleContent.replaceRegex', message: t.warning })
      out.ruleContent = t.rule
    }
  }
  // ruleExplore：v1 无发现面，整块不映射——有非空子字段就如实报
  const explore = raw.ruleExplore
  if (typeof explore === 'object' && explore !== null && !Array.isArray(explore)) {
    const nonEmpty = Object.entries(explore as Record<string, unknown>)
      .filter(([, v]) => typeof v === 'string' && v.length > 0).map(([k]) => k)
    if (nonEmpty.length > 0) {
      warnings.push({ field: 'ruleExplore', message: `v1 无发现（explore）面，规则未启用：${nonEmpty.join('、')}` })
    }
  }
  if (unsupported.length > 0) {
    warnings.push({ field: '(未支持子字段)', message: `已忽略不支持的子字段：${unsupported.join('、')}` })
  }
  return out
}

function normalizeSearchUrl(v: unknown, warnings: NormalizeIssue[]): string | null {
  if (typeof v === 'string' && v.length > 0) return v
  if (v !== undefined && v !== null) {
    warnings.push({ field: 'searchUrl', message: 'v1 仅支持字符串 URL 模板，此源搜索不可用' })
  }
  return null
}

function normalizeHeader(v: unknown, warnings: NormalizeIssue[]): Record<string, string> | null {
  if (v == null) return null
  let obj: unknown = v
  if (typeof v === 'string') {
    try { obj = JSON.parse(v) } catch {
      warnings.push({ field: 'header', message: 'header 不是合法 JSON，已忽略' }); return null
    }
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    warnings.push({ field: 'header', message: 'header 形态不是对象，已忽略' }); return null
  }
  const out: Record<string, string> = {}
  for (const [k, val] of Object.entries(obj)) if (typeof val === 'string') out[k] = val
  return out
}

/** 动态请求头规则判别（**合并视图版**，normalize 入库时用）：header 值是 `@js:`/`<js>` 规则
 *  （BaseSource.getHeaderMap 的 `startsWith("@js:", true)` 考证）→ 返回规则原文；否则 null。 */
function normalizeHeaderRule(v: unknown): string | null {
  if (typeof v !== 'string') return null
  return v.startsWith('@js:') || v.startsWith('<js>')
    || v.startsWith('@JS:') || v.startsWith('@Js:') || v.toUpperCase().startsWith('<JS>')
    ? v : null
}

/** 动态请求头规则判别（**raw 源版**，供 SourceRegistry.load 存量重推）：
 *  raw.header 是规则字符串 → 原文；raw 在场但非规则 → null；raw 不是对象 → undefined（调用方别动）。
 *  规则形态**不是**「非法 JSON」——它是 legado 的合法 header 形态，旧版 normalize 当坏 JSON
 *  丢弃（顶点小说 4004 的根因），存量靠 load 第七条迁移按 raw 重推。 */
export function rawHeaderRule(raw: unknown): string | null | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  return normalizeHeaderRule((raw as Record<string, unknown>).header)
}

// ── Native（android-ebook 原生规则格式）────────────────────────────────

/** 判别：顶层字符串 name+url 且无 bookSourceName → Native。
 * legado 标准源必带 bookSourceName，畸形源并存两形态时 legado 优先（标准形态先认）。
 * 导出给请求层：Native 分页语义首页裁页码段（buildSearchRequest.trimFirstPage）依赖此判定。 */
export function isNativeSource(r: unknown): boolean {
  if (typeof r !== 'object' || r === null || Array.isArray(r)) return false
  const o = r as Record<string, unknown>
  return typeof o.name === 'string' && o.name.length > 0
    && typeof o.url === 'string' && o.url.length > 0
    && typeof o.bookSourceName !== 'string'
}

/** Native 取值字段（终端语义=取元素文本）：裸选择器补隐式 `@text`。
 * legado 规则显式写 `@text`/`@textNodes` 终端；Native 方言裸选择器即「取文本」
 * （legado 规则文档（android-ebook）常用模式表），不补的话引擎链终点剩节点集、服务层按规约抛错。
 * list/attr 字段不在列（ruleBookList/ruleChapterList 要节点集、coverUrl/bookUrl 要属性）。 */
const NATIVE_TEXT_FIELDS = [
  'ruleBookName', 'ruleAuthor', 'ruleIntro', 'ruleLastChapter',
  'ruleDetailName', 'ruleDetailAuthor', 'ruleDetailIntro', 'ruleDetailLastChapter',
  'ruleChapterName', 'ruleContent',
] as const

/** 链体每段（`||` 分支）无 `@` → 补 `@text`；`##` 净化尾不动（只处理链体）。
 *  实现归 grammar.withImplicitText（构词与解析同属一处）。 */

/**
 * Native → 合并视图（与 flattenDialect 同构的目标位）：按 legado 规则文档（android-ebook）语义映射
 * name/url/headers/group、三个规则对象的 list 三件套、ruleContent.nextPage/replaceRules[]；
 * searchUrl 占位符 `{{keyword}}` 改写为内部 `{{key}}`（`{{page}}` 同名不动）；
 * `authorPrefix` 追加 `##^前缀##` 净化尾到详情面作者规则（正则转义）；
 * 取值字段裸选择器补隐式 `@text` 终端（NATIVE_TEXT_FIELDS）。
 * v1 无发现/排序/POST 面：ruleFind/ruleRank/kind/pageUrl/reverse/charset 等如实聚合 warning（宁吵不瞒）。
 */
function flattenNative(raw: Record<string, unknown>, warnings: NormalizeIssue[]): Record<string, unknown> {
  const out: Record<string, unknown> = {
    bookSourceName: raw.name, bookSourceUrl: raw.url,
  }
  const unsupported: string[] = []
  const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null)
  const put = (field: string, v: unknown): void => { const s = str(v); if (s !== null) out[field] = s }
  // 子字段映射：已映射位照搬；未映射且「非空/启用」的点名（空串与 false 是默认值，不报）
  for (const [objField, mapping] of Object.entries(NATIVE_MAP)) {
    const obj = raw[objField]
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) continue
    const handled = NATIVE_HANDLED_SUBS[objField]
    for (const [sub, v] of Object.entries(obj)) {
      const field = mapping[sub]
      if (field !== undefined) put(field, v)
      else if (handled?.has(sub) !== true && (str(v) !== null || v === true)) unsupported.push(`${objField}.${sub}`)
    }
  }
  if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled
  put('bookSourceGroup', raw.group)
  if (raw.headers !== undefined) out.header = raw.headers // normalizeHeader 兼容对象/JSON 字符串两形态
  const searchUrl = str(raw.searchUrl)
  if (searchUrl !== null) out.searchUrl = searchUrl.replace(/\{\{\s*keyword\s*\}\}/g, '{{key}}')
  // ruleContent：content 基底 + replaceRules[] 逐条 appendTail（##正则##替换 尾）；nextPage → nextPageUrl
  const content = raw.ruleContent
  if (typeof content === 'object' && content !== null && !Array.isArray(content)) {
    const e = content as Record<string, unknown>
    const base = str(e.content)
    if (base !== null) out.ruleContent = nativeReplaceTails(base, e.replaceRules, warnings)
    put('nextPageUrl', e.nextPage)
    if (str(e.image) !== null) unsupported.push('ruleContent.image')
  } else {
    put('ruleContent', content) // 字符串形态直通
  }
  // authorPrefix：详情面作者规则追加 `##^前缀##` 尾（legado ##净化语义；前缀正则转义；
  // 拼串归 grammar.appendTail——越界当场 warning 不产出）
  const info = raw.ruleBookInfo
  if (typeof info === 'object' && info !== null && !Array.isArray(info)) {
    const prefix = str((info as Record<string, unknown>).authorPrefix)
    const author = str(out.ruleDetailAuthor)
    if (prefix !== null && author !== null) {
      const t = appendTail(author, `^${escapeRegex(prefix)}`, '')
      if (t.warning !== null) warnings.push({ field: 'ruleBookInfo.authorPrefix', message: t.warning })
      out.ruleDetailAuthor = t.rule
    }
  }
  // 顶层未支持字段（v1 无 POST/排序面；charset 由抓取链自动识别）
  const weight = raw.weight
  if (typeof weight === 'number' && weight !== 0) unsupported.push('weight')
  if (str(raw.charset) !== null) unsupported.push('charset')
  const method = str(raw.method)
  if (method !== null && method.toUpperCase() !== 'GET') unsupported.push('method')
  for (const f of ['body', 'searchMethod', 'searchBody'] as const) if (str(raw[f]) !== null) unsupported.push(f)
  for (const block of ['ruleFind', 'ruleRank'] as const) {
    const b = raw[block]
    if (typeof b === 'object' && b !== null && !Array.isArray(b)
      && Object.values(b as Record<string, unknown>).some((v) => str(v) !== null || Array.isArray(v) || (typeof v === 'object' && v !== null))) {
      unsupported.push(block)
    }
  }
  if (unsupported.length > 0) {
    warnings.push({ field: '(Native 未支持字段)', message: `已忽略不支持的字段：${unsupported.join('、')}` })
  }
  // 终端语义收口：取值字段裸选择器补隐式 @text（在 authorPrefix/replaceRules 净化尾追加之后——
  // withImplicitText 只处理链体，尾部不动）
  for (const f of NATIVE_TEXT_FIELDS) {
    const v = out[f]
    if (typeof v === 'string' && v.length > 0) out[f] = withImplicitText(v)
  }
  return out
}

/** replaceRules[] → 逐条 appendTail（##正则##替换 尾；安卓语义：pattern 匹配正则、
 *  replacement 缺省空串=删除、enabled 缺省 true 跳过 false）。构词越界（pattern 含 ## 等）
 *  由 appendTail round-trip 拦下，进 normalize warnings（宁吵不瞒）。 */
function nativeReplaceTails(base: string, v: unknown, warnings: NormalizeIssue[]): string {
  if (!Array.isArray(v)) return base
  let rule = base
  for (const item of v) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
    const o = item as Record<string, unknown>
    const pattern = typeof o.pattern === 'string' && o.pattern.length > 0 ? o.pattern : null
    if (pattern === null || o.enabled === false) continue
    const replacement = typeof o.replacement === 'string' ? o.replacement : ''
    const t = appendTail(rule, pattern, replacement)
    if (t.warning !== null) warnings.push({ field: 'ruleContent.replaceRules', message: t.warning })
    rule = t.rule
  }
  return rule
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
