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
  'searchUrl', 'exploreUrl', 'probeKeyword', 'bookUrlPattern',
  'ruleBookList', 'ruleBookName', 'ruleAuthor', 'ruleBookUrl',
  'ruleCoverUrl', 'ruleIntro', 'ruleLastChapter', 'ruleKind', 'ruleWordCount',
  'ruleDetailKind', 'ruleDetailWordCount', 'ruleTocUrl', 'ruleChapterName',
  'ruleChapterUrl', 'ruleContent', 'nextTocUrl', 'nextPageUrl', 'loginUrl',
] as const

/** 对象方言子字段 → 模型字段映射（书源 JSON 的嵌套导出形态）。
 * 搜索上下文（ruleSearch）落搜索面字段；详情上下文（ruleBookInfo）落 ruleDetail*——
 * 实测 508/541 两上下文规则不同，混用会造垃圾标题（open item ③ 同款陷阱）。 */
const DIALECT_MAP: Record<string, Record<string, string>> = {
  ruleSearch: {
    bookList: 'ruleBookList', name: 'ruleBookName', author: 'ruleAuthor', bookUrl: 'ruleBookUrl',
    coverUrl: 'ruleCoverUrl', intro: 'ruleIntro', lastChapter: 'ruleLastChapter',
    kind: 'ruleKind', wordCount: 'ruleWordCount',
    checkKeyWord: 'probeKeyword',
  },
  ruleBookInfo: {
    init: 'ruleDetailInit',
    name: 'ruleDetailName', author: 'ruleDetailAuthor', coverUrl: 'ruleDetailCoverUrl',
    intro: 'ruleDetailIntro', lastChapter: 'ruleDetailLastChapter', tocUrl: 'ruleTocUrl',
    kind: 'ruleDetailKind', wordCount: 'ruleDetailWordCount',
  },
  ruleToc: {
    chapterList: 'ruleChapterList', chapterName: 'ruleChapterName', chapterUrl: 'ruleChapterUrl',
    nextTocUrl: 'nextTocUrl',
  },
  ruleContent: {
    content: 'ruleContent', nextContentUrl: 'nextPageUrl',
  },
}

/** Native（android-ebook 原生规则格式）子字段 → 模型字段映射。
 * 与上面的对象方言同构但键名不同：list/name/url 三件套、ruleContent.nextPage/replaceRules[]。 */
const NATIVE_MAP: Record<string, Record<string, string>> = {
  ruleSearch: {
    list: 'ruleBookList', name: 'ruleBookName', author: 'ruleAuthor', bookUrl: 'ruleBookUrl',
    coverUrl: 'ruleCoverUrl', intro: 'ruleIntro', lastChapter: 'ruleLastChapter',
    kind: 'ruleKind', wordCount: 'ruleWordCount',
  },
  ruleBookInfo: {
    init: 'ruleDetailInit',
    name: 'ruleDetailName', author: 'ruleDetailAuthor', coverUrl: 'ruleDetailCoverUrl',
    intro: 'ruleDetailIntro', lastChapter: 'ruleDetailLastChapter', tocUrl: 'ruleTocUrl',
    kind: 'ruleDetailKind', wordCount: 'ruleDetailWordCount',
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
  // Native 判别（与「顶层含 bookSourceUrl → 脚本格式」的判别互补）：顶层 name+url 且无
  // bookSourceName → android-ebook 原生规则格式，走 Native 映射；两形态字段并存时对象方言优先。
  const r = isNativeSource(obj) ? flattenNative(obj, warnings) : flattenDialect(obj, warnings)
  const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null)

  const nameRaw = str(r.bookSourceName); if (!nameRaw) missing.push({ field: 'bookSourceName', message: '缺书源名称' })
  // 名称前缀图标剥离（修复 2026-09-16）：真实书源包惯用分组图标打头（「⚡📂听小说APP」——图标就是
  // 它自己分组的图标，给阅读端界面看的）；本插件分组已独立成列，名字再带一遍是重复。
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
  // header 单字段两形态：`@js:`/`<js>` 规则 → headerRule；
  // JSON 对象/JSON 串 → header。两者互斥（同一 raw.header 二选一），规则形态不再是「非法 JSON」警告。
  rules.headerRule = normalizeHeaderRule(r.header)
  rules.header = rules.headerRule === null ? normalizeHeader(r.header, warnings) : null
  // ruleDetail*/ruleChapterList 非 RULE_FIELDS 成员（平铺方言无此字段名），单独落位
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
 *  下拉/筛选全错位。兼容三种分隔符：`,`（主流）/`\`（旧阅读端写法）/`，`（全角）；
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

/** 书源内容形态取值（由书源格式定义：0/-1/缺省=文本，**1=音频，2=图片，3=文件**——
 *  此前本仓把 1/2 读反成 image/audio，漫画/短剧源被误标后混进聚合搜索与文字书架，书架诊断实证）：
 *  0/-1/缺省=文本（-1=ALL 在源里罕见，按文本放行）。
 *  **唯一映射表**：normalize 的拒绝文案与 SourceRegistry.load 的存量重推共用这一份，
 *  不存在第二份编码抄本（wire 单点纪律）。认不出的值 → 'unknown'：读不懂不等于文本。 */
export const CONTENT_KIND_OF: Record<number, SourceContentKind> = {
  0: 'text', [-1]: 'text', 1: 'audio', 2: 'image', 3: 'file',
}

/** bookSourceType 原始值 → 内容形态。**认得出才算数**：0/-1/缺省=文本，1/2/3=音频/图片/文件，
 *  其余一律 unknown（该字段在书源格式里是 Int，非 number 的形态本身就不是合法编码——不必再分
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

/** raw → 单个模型字段的派生值：与 `normalizeSource` 共用**同一份**展平实现（方言识别、字符串化
 *  容器、平铺/嵌套优先级、Native 隐式 `@text` 全在导入侧那一份里），只是不跑准入（缺必填 / 非文本
 *  源照样读得出该字段——补推不许顺手拒掉存量源）。
 *  返回：派生到的非空串 / null（raw 是对象但派生到空）/ undefined（raw 不是对象，调用方别动）。
 *  新增需要存量收敛的规则字段时**只加调用点**，不要再写第二个读 raw 的函数：`SourceRegistry.load`
 *  的 ⑥ 原先自带一份自解释（只认对象容器、容器优先于平铺，两处都与导入侧不同），而补推是恒覆盖，
 *  于是那条路会把导入侧派生的正确值改写掉并落盘——读数上看不出来（2026-09 审查实证）。
 *  `rawBookMetaFields` 是这条纪律之前的产物：它自带优先级，故只能只填缺席键。 */
export function deriveRuleField(raw: unknown, field: string): string | null | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const r = isNativeSource(raw)
    ? flattenNative(raw as Record<string, unknown>, [])
    : flattenDialect(raw as Record<string, unknown>, [])
  const v = (r as Record<string, unknown>)[field]
  return typeof v === 'string' && v.length > 0 ? v : null
}

/** raw.bookUrlPattern（书源格式的**顶层**字段，不在任何 rule 对象里）：
 *  `SourceRegistry.load` 的存量重推口——旧数据的 rules 没这个键，不重推则嗅探对老源永不生效。
 *  raw 非对象 → undefined（不动）；空白 → null。 */
export function rawRulePattern(raw: unknown): string | null | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const v = (raw as Record<string, unknown>).bookUrlPattern
  return typeof v === 'string' && v.trim() !== '' ? v : null
}

/** 存量重推用的四个模型键（键名直接取自 DIALECT_MAP，不再抄第二份映射）：
 *  平铺方言的 raw 顶层键与模型键同名（`ruleKind` 等），对象/Native 方言住在容器里。 */
const BOOK_META_KEYS = [
  { container: 'ruleSearch', nested: 'kind', model: DIALECT_MAP.ruleSearch.kind },
  { container: 'ruleSearch', nested: 'wordCount', model: DIALECT_MAP.ruleSearch.wordCount },
  { container: 'ruleBookInfo', nested: 'kind', model: DIALECT_MAP.ruleBookInfo.kind },
  { container: 'ruleBookInfo', nested: 'wordCount', model: DIALECT_MAP.ruleBookInfo.wordCount },
] as const

/** raw 的分类 / 字数四项（供 `SourceRegistry.load` 存量重推，与 `rawHeaderRule` /
 *  `rawRulePattern` 同族）。这两个字段是后来才接进取值链路的，存量 rules
 *  没这四个键 → 源里读得出的分类/字数对老库**永远是 null**（真机读数实证：接入后审计
 *  字段到货率 0/82 源，缺的就是这一步）。
 *  读口复用导入时的同一套材料：容器走 `ruleContainer`（字符串化容器照解析，不另立规矩）、
 *  键名走 `DIALECT_MAP`、Native 的裸选择器补隐式 `@text`（`withImplicitText`，与 flattenNative 同口径）。
 *  raw 不是对象 → undefined（调用方别动）。 */
export function rawBookMetaFields(raw: unknown): Record<string, string | null> | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const r = raw as Record<string, unknown>
  const native = isNativeSource(raw)
  const out: Record<string, string | null> = {}
  for (const { container, nested, model } of BOOK_META_KEYS) {
    const box = ruleContainer(r[container])
    const inBox = 'obj' in box ? (box.obj as Record<string, unknown>)[nested] : undefined
    const v = typeof inBox === 'string' ? inBox : (typeof r[model] === 'string' ? r[model] as string : undefined)
    const trimmed = v === undefined || v.trim() === '' ? null : v
    out[model] = trimmed !== null && native ? withImplicitText(trimmed) : trimmed
  }
  return out
}

/** 规则容器的三态解析结果：拿到对象 / 明确缺席（静默）/ 看着像容器但读不出来（点名）。 */
type Container = { obj: Record<string, unknown> } | { absent: true } | { unreadable: string }
/**
 * 规则容器解析（书源格式里**每一个** rule 对象都允许两种形态：JSON 对象，或一段 JSON
 * **字符串**——公开书源分享里常这么存；本仓此前对非对象容器直接 continue，这类源导入后
 * 搜索/目录/正文规则全丢，表现成「RuleMissing / 缺正文规则」，读起来像源坏了而不是格式没接）。
 *
 * 判定边界刻意收窄：只有**以 `{` 开头**的字符串才是容器候选。`ruleContent` 这一键位还有本仓支持的
 * 平铺形态（值就是规则串），不以 `{` 开头的串一律照旧当规则用；`"null"`（序列化侧会把缺席
 * 对象写成这个字面量）与非串非对象都按缺席静默处理。
 * 解析不出对象 → `unreadable`（原文截断带回点名）：本仓不拿一段坏 JSON 冒充规则串——
 * `ruleContainer` 与展平后的 `delete` 是一件事的两半，缺了后者
 * 那段坏串会以「规则串」身份活到求值期（`ruleContent` 这个键名本身就是规则位），既不是本仓要的
 * 缺席，也让一块坏字符串连带废掉整源导入。
 */
function ruleContainer(v: unknown): Container {
  if (typeof v === 'object' && v !== null && !Array.isArray(v)) return { obj: v as Record<string, unknown> }
  if (typeof v !== 'string') return { absent: true }
  const t = v.trim()
  if (!t.startsWith('{')) return { absent: true }
  try {
    const p = JSON.parse(t) as unknown
    if (p !== null && typeof p === 'object' && !Array.isArray(p)) return { obj: p as Record<string, unknown> }
  } catch { /* 落到下面的 unreadable */ }
  return { unreadable: t.slice(0, 60) }
}

/** 一次导入里每块容器只解析一遍（DIALECT_MAP / replaceRegex / ruleExplore 三处都要看它） */
function ruleContainers(raw: Record<string, unknown>, warnings: NormalizeIssue[]): Record<string, Record<string, unknown> | undefined> {
  const out: Record<string, Record<string, unknown> | undefined> = {}
  for (const field of ['ruleSearch', 'ruleExplore', 'ruleBookInfo', 'ruleToc', 'ruleContent']) {
    const c = ruleContainer(raw[field])
    if ('obj' in c) out[field] = c.obj
    else {
      out[field] = undefined
      if ('unreadable' in c) {
        warnings.push({ field, message: `看着像字符串化的规则容器但读不出对象（不是合法 JSON 或不是对象），整块按缺席处理：${c.unreadable}` })
      }
    }
  }
  return out
}

/**
 * 对象方言展平：五个规则字段（ruleSearch/ruleExplore/ruleBookInfo/ruleToc/ruleContent）
 * 为对象时（**或为字符串化的 JSON**，见 ruleContainer），把已映射子字段填进合并视图的目标位
 * （平铺字段已占的位不覆盖——平铺优先）。
 * 未映射且非空的子字段如实聚合 warning（宁吵不瞒）；ruleExplore 整块 v1 未支持（无 explore 面）。
 * ruleContent.replaceRegex 追加 `##regex##` 净化尾（语义：匹配替换为空串）。
 */
function flattenDialect(raw: Record<string, unknown>, warnings: NormalizeIssue[]): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw }
  const containers = ruleContainers(raw, warnings)
  const setIfVacant = (field: string, value: unknown): void => {
    const cur = out[field]
    const occupied = typeof cur === 'string' && cur.length > 0
    if (!occupied && typeof value === 'string' && value.length > 0) out[field] = value
  }
  const unsupported: string[] = []
  for (const [objField, mapping] of Object.entries(DIALECT_MAP)) {
    const obj = containers[objField]
    // 字符串形态的容器值本身住在这一键上（`ruleContent: '{"content":"…"}'`）——它是容器原文，
    // 不是平铺规则；不清掉就会挡住 setIfVacant，甚至把整段 JSON 当规则串用下去。
    // **读不出的那种同样要清**（`ruleContent: '{"content":'`）：那才是「拿一段坏 JSON 冒充规则串」——
    // 这个键名本身就是规则位，留着它等于给正文面塞一条永远炸的规则，而读数上却像「有规则」。
    if (typeof raw[objField] === 'string' && raw[objField].trim().startsWith('{')) delete out[objField]
    if (obj === undefined) continue
    for (const [sub, v] of Object.entries(obj)) {
      const field = mapping[sub]
      if (field !== undefined) {
        if (typeof v === 'string' && v.length > 0) setIfVacant(field, v)
      } else if (typeof v === 'string' && v.length > 0) {
        unsupported.push(`${objField}.${sub}`)   // 非空才点名（书源导出空字段一大片，全列是噪音）
      }
    }
  }
  // checkKeyWord → 探针关键词：含 `http`/`::`/`++`/`--` 的值弃用回默认
  // （那些串与调试输入语法冲突）。同口径丢弃，探针自然回落通用词序列。
  if (typeof out.probeKeyword === 'string' && /http|::|\+\+|--/.test(out.probeKeyword)) {
    delete out.probeKeyword
  }
  // replaceRegex：仅当正文规则来自容器 content 时追加（容器 = 对象形态或字符串化的 JSON，
  // 见 ruleContainer；纯字符串的平铺 ruleContent 不在此列）；拼串归 grammar.appendTail
  // （round-trip 自校验，越界当场 warning）
  const contentObj = containers.ruleContent
  if (contentObj !== undefined) {
    const rr = contentObj.replaceRegex
    if (typeof rr === 'string' && rr.length > 0 && typeof out.ruleContent === 'string') {
      const t = appendTail(out.ruleContent, rr, '')
      if (t.warning !== null) warnings.push({ field: 'ruleContent.replaceRegex', message: t.warning })
      out.ruleContent = t.rule
    }
  }
  // ruleExplore：v1 无发现面，整块不映射——有非空子字段就如实报
  const explore = containers.ruleExplore
  if (explore !== undefined) {
    const nonEmpty = Object.entries(explore)
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
 *  （判别大小写不敏感）→ 返回规则原文；否则 null。 */
function normalizeHeaderRule(v: unknown): string | null {
  if (typeof v !== 'string') return null
  return v.startsWith('@js:') || v.startsWith('<js>')
    || v.startsWith('@JS:') || v.startsWith('@Js:') || v.toUpperCase().startsWith('<JS>')
    ? v : null
}

/** 动态请求头规则判别（**raw 源版**，供 SourceRegistry.load 存量重推）：
 *  raw.header 是规则字符串 → 原文；raw 在场但非规则 → null；raw 不是对象 → undefined（调用方别动）。
 *  规则形态**不是**「非法 JSON」——它是书源的合法 header 形态，旧版 normalize 当坏 JSON
 *  丢弃（顶点小说 4004 的根因），存量靠 load 第七条迁移按 raw 重推。 */
export function rawHeaderRule(raw: unknown): string | null | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  return normalizeHeaderRule((raw as Record<string, unknown>).header)
}

// ── Native（android-ebook 原生规则格式）────────────────────────────────

/** 判别：顶层字符串 name+url 且无 bookSourceName → Native。
 * 标准形态的源必带 bookSourceName，畸形源并存两形态时标准形态优先（先认）。
 * 导出给请求层：Native 分页语义首页裁页码段（buildSearchRequest.trimFirstPage）依赖此判定。 */
export function isNativeSource(r: unknown): boolean {
  if (typeof r !== 'object' || r === null || Array.isArray(r)) return false
  const o = r as Record<string, unknown>
  return typeof o.name === 'string' && o.name.length > 0
    && typeof o.url === 'string' && o.url.length > 0
    && typeof o.bookSourceName !== 'string'
}

/** Native 取值字段（终端语义=取元素文本）：裸选择器补隐式 `@text`。
 * 对象方言规则显式写 `@text`/`@textNodes` 终端；Native 方言裸选择器即「取文本」
 * （android-ebook 原生规则格式的常用模式），不补的话引擎链终点剩节点集、服务层按规约抛错。
 * list/attr 字段不在列（ruleBookList/ruleChapterList 要节点集、coverUrl/bookUrl 要属性）。 */
const NATIVE_TEXT_FIELDS = [
  'ruleBookName', 'ruleAuthor', 'ruleIntro', 'ruleLastChapter', 'ruleKind', 'ruleWordCount',
  'ruleDetailName', 'ruleDetailAuthor', 'ruleDetailIntro', 'ruleDetailLastChapter',
  'ruleDetailKind', 'ruleDetailWordCount',
  'ruleChapterName', 'ruleContent',
] as const

/** 链体每段（`||` 分支）无 `@` → 补 `@text`；`##` 净化尾不动（只处理链体）。
 *  实现归 grammar.withImplicitText（构词与解析同属一处）。 */

/**
 * Native → 合并视图（与 flattenDialect 同构的目标位）：按 android-ebook 原生规则格式语义映射
 * name/url/headers/group、三个规则对象的 list 三件套、ruleContent.nextPage/replaceRules[]；
 * searchUrl 占位符 `{{keyword}}` 改写为内部 `{{key}}`（`{{page}}` 同名不动）；
 * `authorPrefix` 追加 `##^前缀##` 净化尾到详情面作者规则（正则转义）；
 * 取值字段裸选择器补隐式 `@text` 终端（NATIVE_TEXT_FIELDS）。
 * v1 无发现/排序/POST 面：ruleFind/ruleRank/pageUrl/reverse/charset 等如实聚合 warning（宁吵不瞒）。
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
  // authorPrefix：详情面作者规则追加 `##^前缀##` 尾（## 净化语义；前缀正则转义；
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

/** replaceRules[] → 逐条 appendTail（##正则##替换 尾；语义：pattern 匹配正则、
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
