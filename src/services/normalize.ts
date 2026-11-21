import { appendTail, withImplicitText } from '../engine/grammar.js'
import { parseExploreKinds, usableKind } from './explore-url.js'
import {
  EXPLORE_GATE_SUBS, EXPLORE_LEGADO_SUBS, EXPLORE_NATIVE_SUBS, NATIVE_MAP, NATIVE_TEXT_FIELDS,
  REHYDRATE_PHASES, RULE_FIELD_SPECS, RULE_FIELDS, VACANT_RULE_FIELDS, dialectMapOf, legadoContainersOf,
  wholeSetEnabled,
} from './rule-fields.js'
import type { RehydrateMode, RuleFieldsOf, RuleFieldSpec } from './rule-fields.js'
import type { NormalizedRules, NovelSource, SourceContentKind } from './types.js'

export interface NormalizeIssue { field: string; message: string }
export interface NormalizeResult {
  ok: boolean
  /** 必填缺失（bookSourceName/bookSourceUrl/ruleContent；非文本源的 bookSourceType 也记在这里） */
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
  // 对象方言先展平进合并视图（平铺字段优先，对象只填空缺；raw 不动）。Native 判别：顶层 name+url
  // 且无 bookSourceName → 原生格式；两形态字段并存时对象方言优先（与「顶层含 bookSourceUrl → 脚本格式」互补）。
  const r = isNativeSource(obj) ? flattenNative(obj, warnings) : flattenDialect(obj, warnings)
  const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null)

  const nameRaw = str(r.bookSourceName); if (!nameRaw) missing.push({ field: 'bookSourceName', message: '缺书源名称' })
  const baseUrl = str(r.bookSourceUrl); if (!baseUrl) missing.push({ field: 'bookSourceUrl', message: '缺书源地址' })
  // bookSourceType：非文本源与认不出的编码一律拒绝——图片/音频/文件源规则体系完全不同，落到
  // ruleContent 校验会报「缺正文规则」，语义误导；认不出不等于文本（矩阵行 `c-book-source-type`）。
  const type = kindOfSourceValue(r.bookSourceType)
  if (type !== 'text') {
    missing.push({ field: 'bookSourceType', message:
      `类型 ${JSON.stringify(r.bookSourceType)}（${SOURCE_KIND_LABEL[type]}）——本插件仅支持文本源（0）` })
  }
  const ruleContent = str(r.ruleContent); if (!ruleContent) missing.push({ field: 'ruleContent', message: '缺正文规则（ruleContent 需为字符串，或对象形态下含非空 content 子字段）' })
  // 四类「进不了库」收成一道门：缺名 / 缺址 / 非文本源 / 缺正文规则；合成一个条件也让编译器跟上非空证明。
  if (nameRaw === null || baseUrl === null || type !== 'text' || ruleContent === null || missing.length > 0) {
    return { ok: false, missing, warnings }
  }
  // 名称前缀图标剥离：书源包惯用分组图标打头，本插件分组已独立成列，名字再带一遍是重复。
  const name = stripLeadingIcons(nameRaw)

  const rules = blankRules()
  // 平铺方言的键与模型键同名：逐键过 str（缺省落 null），名单仍由字段表派生（见 rule-fields.ts）
  Object.assign(rules, Object.fromEntries(RULE_FIELDS.map((f) => [f, str(r[f])])))
  rules.searchUrl = normalizeSearchUrl(r.searchUrl, warnings)
  // header 单字段两形态：`@js:`/`<js>` → headerRule；JSON 对象/串 → header。两者互斥，规则形态不产生「非法 JSON」警告。
  rules.headerRule = normalizeHeaderRule(r.header)
  rules.header = rules.headerRule === null ? normalizeHeader(r.header, warnings) : null
  // ruleExploreKinds 不是字符串（分类入口数组），故不进 RULE_FIELDS 循环。两个方言共用这一处落位：
  // 原生走 flattenNative 的 ruleFind.kinds，legado 走 flattenDialect 解 exploreUrl。消费者按
  // `rules.ruleExploreKinds.length` 读分类面，缺键即 TypeError，故两档都恒落一个数组（脏值与缺键都不进模型）。
  rules.ruleExploreKinds = Array.isArray(r.ruleExploreKinds)
    ? (r.ruleExploreKinds as Array<{ title: string; url: string }>)
    : []
  // 表里落位方式为 `explicit` 的行不进平铺循环：exploreUrl 是发现入口声明串（解析归 explore-url.ts），
  // jsLib 是源级脚本库，章节 flag 是逐章折布尔的规则；其余规则字段由 `rule-fields.ts` 字段表列出、走上面的循环。
  rules.exploreUrl = str(r.exploreUrl)
  rules.jsLib = str(r.jsLib)
  rules.ruleChapterIsVip = str(r.ruleChapterIsVip)
  rules.ruleChapterIsVolume = str(r.ruleChapterIsVolume)
  rules.ruleChapterIsPay = str(r.ruleChapterIsPay)
  rules.ruleChapterUpdateTime = str(r.ruleChapterUpdateTime)

  const groupsRaw = r.bookSourceGroup
  const groups = typeof groupsRaw === 'string'
    ? splitGroups(groupsRaw)
    : Array.isArray(groupsRaw) ? groupsRaw.filter((g): g is string => typeof g === 'string') : []

  return {
    ok: true, missing, warnings,
    source: {
      name, baseUrl,
      enabled: typeof r.enabled === 'boolean' ? r.enabled : true,
      groups, type, raw, rules,
    },
  }
}

/**
 * 规则集的全键底盘：**每个模型键都显式列出**，少一格是编译错——漏填由编译器把关，不靠空对象 + 断言。
 * 值一律取「没有这条规则」形态（null / 空表），随后按字段表与显式分支覆盖；底盘本身从不作为结果交出。
 */
function blankRules(): NormalizedRules {
  return {
    searchUrl: null, exploreUrl: null,
    ruleExploreUrl: null,
    ruleExploreKinds: [],
    ruleExploreList: null, ruleExploreName: null, ruleExploreAuthor: null, ruleExploreBookUrl: null,
    ruleExploreCoverUrl: null, ruleExploreIntro: null, ruleExploreKind: null, ruleExploreLastChapter: null,
    ruleExploreWordCount: null,
    probeKeyword: null,
    ruleBookList: null, ruleBookName: null, ruleAuthor: null,
    ruleBookUrl: null, ruleCoverUrl: null, ruleIntro: null,
    ruleLastChapter: null, ruleTocUrl: null,
    ruleKind: null, ruleWordCount: null,
    bookUrlPattern: null,
    ruleChapterList: null,
    ruleChapterName: null, ruleChapterUrl: null,
    ruleChapterIsVip: null, ruleChapterIsVolume: null, ruleChapterIsPay: null, ruleChapterUpdateTime: null,
    ruleDetailName: null, ruleDetailAuthor: null,
    ruleDetailCoverUrl: null, ruleDetailIntro: null,
    ruleDetailLastChapter: null,
    ruleDetailKind: null, ruleDetailWordCount: null,
    ruleDetailInit: null,
    ruleContent: null,
    ruleContentSubContent: null,
    nextTocUrl: null, nextPageUrl: null,
    header: null, loginUrl: null,
    headerRule: null,
    jsLib: null,
  }
}

/** 内容形态中文名（只服务导入拒绝文案——列表不渲染 type）。Record 由编译器强制穷尽，故它同时是**值域见证**：
 *  `rehydrateStoredSource` 用 `Object.hasOwn` 判旧数据 type 还在不在域内（只看自有键，`in` 会把原型键当合法）。 */
const SOURCE_KIND_LABEL: Record<SourceContentKind, string> = {
  text: '文本', image: '图片', audio: '音频', file: '文件', unknown: '未知',
}

/** 分组串拆分：分隔形态有 `,` / `\` / `，`（全角）三种，一律兼容 + trim + 去空段 + 段内去重。
 *  只按 `\` 拆会让逗号粘连把多组并成一个假组名（钉子：tests/services/normalize.test.ts；矩阵 `c-identity`）。
 *  模块私有：导入侧与存量收敛共用；对外不是能力面（矩阵 impl 锚只要求符号在场）。 */
function splitGroups(raw: string): string[] {
  const out: string[] = []
  for (const part of raw.split(/[\\,，]/)) {
    const g = part.trim()
    if (g !== '' && !out.includes(g)) out.push(g)
  }
  return out
}

/** 名称前缀图标剥离：只剥开头连续的装饰符号段——\p{So}\p{Sk} 覆盖 ⚡📂🎬，FE0F/200D 是 emoji 组合件；
 *  括号是 Po/Ps 不在列，尾部/中部不动。剥完为空（整名都是图标）→ 保留原名（宁丑不空）。 */
function stripLeadingIcons(name: string): string {
  const stripped = name.replace(/^[\s\p{So}\p{Sk}\uFE0F\u200D]+/u, '').trimStart()
  return stripped === '' ? name : stripped
}

/** 书源内容形态取值（书源格式定义：0/-1/缺省=文本，**1=音频，2=图片，3=文件**——读反会让漫画/短剧源混进聚合搜索）：
 *  -1=ALL 按文本放行。**唯一映射表**：导入拒绝文案与存量重推共用这一份。认不出 → 'unknown'（读不懂不等于文本）。
 *  模块私有（矩阵 impl 锚只要求符号在场）。 */
const CONTENT_KIND_OF: Record<number, SourceContentKind> = {
  0: 'text', [-1]: 'text', 1: 'audio', 2: 'image', 3: 'file',
}

/** bookSourceType 原始值 → 内容形态。**认得出才算数**：0/-1/缺省=文本，1/2/3=音频/图片/文件，其余 unknown。
 *  `typeof` 那道闸必需：数值键会强转，`CONTENT_KIND_OF['0']` 竟返回 'text'。导入预检与存量重推共用此单点。 */
function kindOfSourceValue(v: unknown): SourceContentKind {
  if (v === undefined || v === null) return 'text'
  return typeof v === 'number' ? CONTENT_KIND_OF[v] ?? 'unknown' : 'unknown'
}

/** raw.bookSourceType → 内容形态（quiet 版，供存量重推）：缺省/0/-1 → 'text'，其余按映射或 'unknown'；
 *  已被误标成文本入库的条目在此收敛；raw 不是对象 → undefined（别动）。 */
function contentTypeOfRaw(raw: unknown): SourceContentKind | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  return kindOfSourceValue((raw as Record<string, unknown>).bookSourceType)
}

/** raw → 单个模型字段的派生值：与 `normalizeSource` 共用**同一份**展平实现，只是不跑准入（补推不许拒掉存量源）。
 *  返回：非空串 / null（派生到空）/ undefined（raw 不是对象，调用方别动）。新增需存量收敛的字段**只加调用点**，
 *  不再写第二个读 raw 的函数（第二份解释会与导入侧口径不同、补推恒覆盖 → 把正确值改写落盘）。 */
function deriveRuleField(raw: unknown, field: string): string | null | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const r = isNativeSource(raw)
    ? flattenNative(raw as Record<string, unknown>, [])
    : flattenDialect(raw as Record<string, unknown>, [])
  const v = r[field]
  return typeof v === 'string' && v.length > 0 ? v : null
}

/** raw.bookUrlPattern（书源格式的**顶层**字段，不在任何 rule 对象里）：存量重推口——旧数据的 rules 没这个键，
 *  不重推则嗅探对老源永不生效。raw 非对象 → undefined（不动）；空白 → null。 */
function rawRulePattern(raw: unknown): string | null | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const v = (raw as Record<string, unknown>).bookUrlPattern
  return typeof v === 'string' && v.trim() !== '' ? v : null
}

/** 存量重推用的四个模型键：**模式 `missing` 的字段就是这份名单**（表是唯一登记处），容器与子字段名取自
 *  同一行的 legado 路径——平铺方言写在 raw 顶层，对象/Native 方言住在容器里。 */
const BOOK_META_KEYS = RULE_FIELD_SPECS.flatMap((s) => (
  s.rehydrate === 'missing'
    ? [{ container: s.legadoObject, nested: s.legadoKey, model: s.model }]
    : []
))

/** raw 的分类 / 字数四项（存量重推口）：分类与字数只从 `rules` 取值，存量的 rules 可能没这四个键 → 老库永远
 *  null，这个读口补那一格。读口复用导入时的同一套材料：容器走 `ruleContainer`，容器与键名取自字段表的
 *  legado 路径，Native 的裸选择器补隐式 `@text`（`withImplicitText`，与 flattenNative 同口径）。raw 非对象 → undefined。 */
function rawBookMetaFields(raw: unknown): Record<string, string | null> | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const r = raw as Record<string, unknown>
  const native = isNativeSource(raw)
  const out: Record<string, string | null> = {}
  for (const { container, nested, model } of BOOK_META_KEYS) {
    const box = ruleContainer(r[container])
    const inBox = 'obj' in box ? box.obj[nested] : undefined
    const v = typeof inBox === 'string' ? inBox : (typeof r[model] === 'string' ? r[model] : undefined)
    const trimmed = v === undefined || v.trim() === '' ? null : v
    out[model] = trimmed !== null && native ? withImplicitText(trimmed) : trimmed
  }
  return out
}

/** 发现面键：表里 `vacant` 档的模型键 + 分类入口数组（`ruleExploreKinds` 是数组不进表——ADR-0044）。
 *  键集由表派生；表改档，本类型与 `rawExploreFields` 的返回对象一起变。 */
type ExploreField = RuleFieldsOf<'vacant'> | 'ruleExploreKinds'

/** 原生 `ruleFind` → 发现面取值（导入侧 `flattenNative` 与存量侧 `rawExploreFields` 跑同一份 flatten，不会分叉）。
 *  只交材料、不产留痕——`sawChildren` 回给调用方点名（导入与补推的留痕渠道不同）。口径：整套覆盖的启用
 *  只看闸行 native 子字段非空（`EXPLORE_GATE_SUBS`；逐字段回落会读成半套）、kinds 去空白后非空、children 非空要报。 */
function nativeExploreFields(f: Record<string, unknown>): {
  values: Record<string, string>
  kinds: Array<{ title: string; url: string }>
  sawChildren: boolean
} {
  const values: Record<string, string> = {}
  const put = (field: string, v: unknown): void => {
    if (typeof v === 'string' && v.length > 0) values[field] = v
  }
  put('ruleExploreUrl', f.url)
  const kinds: Array<{ title: string; url: string }> = []
  let sawChildren = false
  for (const entry of Array.isArray(f.kinds) ? f.kinds : []) {
    const k = usableKind(entry)
    if (k === null) continue
    kinds.push(k)
    const children = (entry as Record<string, unknown>).children
    if (Array.isArray(children) && children.length > 0) sawChildren = true
  }
  const own = f.ruleSearch
  if (typeof own === 'object' && own !== null && !Array.isArray(own)) {
    const o = own as Record<string, unknown>
    // 闸与子字段名都读规则字段表派生（两方言共读一张表）；f.url 与 sawChildren 留显式：它们不是条目子字段。
    if (wholeSetEnabled(o[EXPLORE_GATE_SUBS.native])) {
      for (const [sub, field] of Object.entries(EXPLORE_NATIVE_SUBS)) put(field, o[sub])
    }
  }
  return { values, kinds, sawChildren }
}

/** 发现面字符串键 = 表里模式 `vacant` 的字段（`ruleExploreKinds` 是数组，另落）。这一族既是存量补推的「可填」名单，
 *  也是本函数要读的字段清单。名单与 `ExploreField` 双向钉在 tests/services/rule-fields.test.ts 的 `vacant` 档：表改档而这里没跟当场红。 */
type ExploreStringField = Exclude<ExploreField, 'ruleExploreKinds'>
const EXPLORE_STRING_MODELS: readonly ExploreStringField[] = VACANT_RULE_FIELDS

/** 发现面十一键（存量按 raw 补推，触发点 `SourceRegistry.load`，与 `rawBookMetaFields` 同族）：存量 rules 里这一族
 *  是空的源在书城**整个是空的**，这个读口把它们从 raw 现推回来。两方言共用**导入侧那一次 flatten**（方言判定、
 *  字符串化容器、平铺/嵌套优先级、Native 隐式 `@text` 全在那一份里），不要在这里再调一次 flatten 或手工补终端。
 *  「raw 里读不出发现面」给全 null + `[]`，「raw 不是对象」返回 undefined：前者是「这源没分类」，后者是「这里没读」。
 *  warnings 传空数组：留痕是导入那一次的事，补推每次启动都跑，再刷一遍只会淹掉真正的导入问题。 */
export function rawExploreFields(raw: unknown): Pick<NormalizedRules, ExploreField> | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const view = isNativeSource(raw)
    ? flattenNative(raw as Record<string, unknown>, [])
    : flattenDialect(raw as Record<string, unknown>, [])
  const vacantNulls = Object.fromEntries(EXPLORE_STRING_MODELS.map((model) => [model, null])) as Record<ExploreStringField, string | null>
  const out: Pick<NormalizedRules, ExploreField> = { ruleExploreKinds: [], ...vacantNulls }
  for (const k of Object.keys(out) as ExploreField[]) {
    const got = view[k]
    if (k === 'ruleExploreKinds') {
      // 键恒落一个数组：脏形状（非数组）留在这一格里由调用方那一步收敛，不在此处冒充分类
      if (Array.isArray(got)) out.ruleExploreKinds = got as NormalizedRules['ruleExploreKinds']
    } else if (typeof got === 'string' && got.length > 0) {
      (out as unknown as Record<string, string>)[k] = got
    }
  }
  return out
}

/** 发现开关（书源格式的 `enabledExplore`）：**只有显式 false 才算关**。缺省是开——原生方言的 raw 根本没这个键，
 *  「没写」不等于「关掉」；raw 不是对象同样返回 true（读不动就不据此把源藏起来）。 */
export function rawExploreEnabled(raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null) return true
  return (raw as Record<string, unknown>).enabledExplore !== false
}

/** 规则容器的三态解析结果：拿到对象 / 明确缺席（静默）/ 看着像容器但读不出来（点名）。 */
type Container = { obj: Record<string, unknown> } | { absent: true } | { unreadable: string }
/**
 * 规则容器解析（书源格式里**每一个** rule 对象都允许 JSON 对象或一段 JSON **字符串**——公开分享里常这么存；
 * 对非对象容器直接 continue 会让规则全丢，表现成「缺正文规则」，读起来像源坏了而不是格式没接）。
 * 判定边界刻意收窄：只有**以 `{` 开头**的字符串才是容器候选——`ruleContent` 还有平铺形态（值就是规则串），
 * 不以 `{` 开头的串照旧当规则用；`"null"` 与非串非对象按缺席静默。解析不出对象 → `unreadable`（原文截断点名），
 * 不拿坏 JSON 冒充规则串；展平后还必须 `delete` 该键，否则坏串会以规则串身份活到求值期。
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

/** 一次导入里每块容器只解析一遍（方言映射 / replaceRegex / ruleExplore 三处都要看它）。`containers` 是字段表的投影
 *  （四个通用容器 + `ruleExplore` 具名特例），表加一个新容器的行，这里自动跟着多一块。 */
function ruleContainers(
  raw: Record<string, unknown>,
  warnings: NormalizeIssue[],
  containers: readonly string[],
): Record<string, Record<string, unknown> | undefined> {
  const out: Record<string, Record<string, unknown> | undefined> = {}
  for (const field of containers) {
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

/** 合并视图这一格是否**已带可用的分类入口**（平铺 raw 自己写了非空数组）——「平铺优先」在数组键上的读法：
 *  判到条目级（脏数组与「没写」同一种值，由派生值接管；条目级的尺住 `explore-url.usableKind`，本函数只加「每条都过」）。 */
function isArrayOfKinds(v: unknown): boolean {
  return Array.isArray(v) && v.length > 0 && v.every((e) => usableKind(e) !== null)
}

/**
 * 对象方言展平：规则容器（表的投影——四个通用容器 + `ruleExplore` 具名特例）为对象或字符串化 JSON 时，
 * 把已映射子字段填进合并视图的目标位（平铺字段已占的位不覆盖——平铺优先）。未映射且非空的子字段、
 * ruleExplore 里没被消费的子字段都并进同一处 warning（同一类留痕全仓只开一条）。
 * ruleContent.replaceRegex 追加 `##regex##` 净化尾（语义：匹配替换为空串）。
 * `fieldSpecs` 导出只为钉子：给一张合成的表行集就能证明「表加一行 ⇒ 新容器下的字段也展平」。
 */
export function flattenDialect(
  raw: Record<string, unknown>,
  warnings: NormalizeIssue[],
  fieldSpecs: readonly RuleFieldSpec[] = RULE_FIELD_SPECS,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw }
  // 容器集合与子字段映射同从这批表行派生：映射的键就是通用容器，外加 ruleExplore 具名特例
  const dialectMap = dialectMapOf(fieldSpecs)
  const containers = ruleContainers(raw, warnings, legadoContainersOf(dialectMap))
  const setIfVacant = (field: string, value: unknown): void => {
    const cur = out[field]
    const occupied = typeof cur === 'string' && cur.length > 0
    if (!occupied && typeof value === 'string' && value.length > 0) out[field] = value
  }
  const unsupported: string[] = []
  for (const [objField, mapping] of Object.entries(dialectMap)) {
    const obj = containers[objField]
    // 字符串形态的容器值住这一键：它是容器原文不是平铺规则，不清掉会挡住 setIfVacant、甚至把整段 JSON 当规则串；
    // 读不出的坏串同清（坏 JSON 冒充规则串）。两半的另一半见 ruleContainer。
    if (typeof raw[objField] === 'string' && raw[objField].trim().startsWith('{')) Reflect.deleteProperty(out, objField)
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
  // checkKeyWord → 探针关键词：含 `http`/`::`/`++`/`--` 的值弃用回默认（与调试输入语法冲突）。
  if (typeof out.probeKeyword === 'string' && /http|::|\+\+|--/.test(out.probeKeyword)) {
    delete out.probeKeyword
  }
  // replaceRegex：仅当正文规则来自容器 content 时追加（对象或字符串化 JSON；纯字符串平铺不在此列）；
  // 拼串归 grammar.appendTail（round-trip 自校验，越界当场 warning）
  const contentObj = containers.ruleContent
  if (contentObj !== undefined) {
    const rr = contentObj.replaceRegex
    if (typeof rr === 'string' && rr.length > 0 && typeof out.ruleContent === 'string') {
      const t = appendTail(out.ruleContent, rr, '')
      if (t.warning !== null) warnings.push({ field: 'ruleContent.replaceRegex', message: t.warning })
      out.ruleContent = t.rule
    }
  }
  // ruleExplore：判据只看闸行（`EXPLORE_GATE_SUBS` 的 legado 子字段），子字段名与目标模型由表派生；
  // 为什么不逐字段回落住 `bridge.hitRuleOf`。这块里未被消费的**非空**子字段并入上面那圈 unsupported 点名。
  const explore = containers.ruleExplore
  if (explore !== undefined) {
    const wholeSet = wholeSetEnabled(explore[EXPLORE_GATE_SUBS.legado])
    if (wholeSet) {
      for (const [sub, field] of Object.entries(EXPLORE_LEGADO_SUBS)) setIfVacant(field, explore[sub])
    }
    // 未启用的那档整块一条都不被消费，故同样逐条点名（判据与上面那圈同一把尺：非空串才报）
    for (const [sub, v] of Object.entries(explore)) {
      const consumed = wholeSet && sub in EXPLORE_LEGADO_SUBS
      if (!consumed && typeof v === 'string' && v.length > 0) unsupported.push(`ruleExplore.${sub}`)
    }
  }
  // exploreUrl → 分类入口（唯一实现住 services/explore-url.ts）。js 档与读不出的形状都**如实为空 + 点名**：
  // 静默给空等于把「没接」写成「这源没分类」；那两条文案只答 exploreUrl 这一档（平铺自带入口时书城照样有入口）。
  const parsed = parseExploreKinds(out.exploreUrl)
  // 平铺优先也管这一格：raw 顶层自带分类入口、exploreUrl 却缺席或读不出的平铺源，被派生值无条件覆盖就是**静默清空**。
  // 在场是非空数组才让位；脏形状照旧被派生值接管，收敛成数组在 normalizeSource 落位处。
  if (!isArrayOfKinds(out.ruleExploreKinds)) out.ruleExploreKinds = parsed.kinds
  if (parsed.form === 'js') {
    warnings.push({ field: 'exploreUrl', message: '发现入口是脚本形态（@js:/<js>），本仓不执行脚本，该源在书城无分类入口' })
  } else if (parsed.form === 'unknown') {
    warnings.push({ field: 'exploreUrl', message: '发现入口读不出任何可用分类（声明的形状读不出条目，或形状本身认不出），该源在书城无分类入口' })
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
  const obj = parseObjectJson(v)
  if (obj === undefined) {
    warnings.push({ field: 'header', message: 'header 不是合法 JSON（严格与单引号两种都不行），已忽略' }); return null
  }
  return stringTableOf(obj)
}

/**
 * 「对象 JSON」的唯一宽松解析（**头与 URL 选项共用这一份**）：严格 JSON 优先，失败再按单引号交换试一次
 * （`{'a':'b'}` → `{"a":"b"}`），两种都不行或形状不是对象才失败。**只宽在引号形态，不猜结构**。
 * 为什么必须单点：头 JSON 必须两段解析（矩阵行 `b-header-js` / `b-header-static`），只做一步 `JSON.parse`
 * 会静默丢掉单引号头；`request.ts` 的选项 JSON 与头必须共用这一解析口。
 */
export function parseObjectJson(v: unknown): Record<string, unknown> | undefined {
  const tryParse = (t: string): Record<string, unknown> | undefined => {
    try {
      const parsed = JSON.parse(t) as unknown
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? parsed as Record<string, unknown> : undefined
    } catch { return undefined }
  }
  if (typeof v === 'object' && v !== null && !Array.isArray(v)) return v as Record<string, unknown>
  if (typeof v !== 'string') return undefined
  const t = v.trim()
  if (t === '') return undefined
  return tryParse(t) ?? tryParse(t.replace(/'/g, '"'))
}

/** 对象 → 字符串表（只收字符串值）——「哪些头条目活着」的唯一筛子：`normalizeHeader`、`rawHeaderFields` 与
 *  `request.ts` 的选项内嵌 headers 共用这一份，值类型口径改一处即三处同改。 */
export function stringTableOf(obj: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, val] of Object.entries(obj)) if (typeof val === 'string') out[k] = val
  return out
}

/** 存量补推用：按 raw 现读静态头表（规则形态与 `normalizeHeaderRule` 同一把尺）；undefined = 别动这一格。 */
function rawHeaderFields(raw: unknown): Record<string, string> | undefined {
  const v = (raw as { header?: unknown } | null | undefined)?.header
  if (jsHeaderCodeOf(v) !== null) return undefined
  const obj = parseObjectJson(v)
  if (obj === undefined) return undefined
  return stringTableOf(obj)
}

/** header 值是不是 js 规则形态；是 → 剥掉前缀后的脚本体，否 → null。判据 trim + 大小写不敏感，只有
 *  `@js:` 与 `<js>…</js>` 两种。**刻意不认裸 `js:`**：URL 模板侧的 `grammar.isJsForm` 认它，header 侧不认——
 *  宽窄差是两条语义，不是漂移。判别与剥前缀同住一处：判据放宽而剥法没跟，就成了「判了规则但求值必炸」。 */
export function jsHeaderCodeOf(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  if (/^@js:/i.test(t)) return t.slice(4)
  if (/^<js>/i.test(t)) {
    const close = t.lastIndexOf('<')
    return close > 4 ? t.slice(4, close) : t.slice(4)
  }
  return null
}

/** 动态请求头规则判别（**合并视图版**）：`jsHeaderCodeOf` 认得的形态 → 规则原文（前导空白原样存）；否则 null。 */
function normalizeHeaderRule(v: unknown): string | null {
  return typeof v === 'string' && jsHeaderCodeOf(v) !== null ? v : null
}

/** 动态请求头规则判别（**raw 源版**，存量重推）：raw.header 是规则字符串 → 原文；在场但非规则 → null；
 *  raw 不是对象 → undefined（别动）。规则形态不是「非法 JSON」——当坏 JSON 丢弃会让动态头不生效。 */
export function rawHeaderRule(raw: unknown): string | null | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  return normalizeHeaderRule((raw as Record<string, unknown>).header)
}

// ── Native（android-ebook 原生规则格式）────────────────────────────────

/** 判别：顶层字符串 name+url 且无 bookSourceName → Native。标准形态必带 bookSourceName，并存时标准形态优先。
 *  导出给请求层：Native 分页语义首页裁页码段（buildSearchRequest.trimFirstPage）依赖此判定。 */
export function isNativeSource(r: unknown): boolean {
  if (typeof r !== 'object' || r === null || Array.isArray(r)) return false
  const o = r as Record<string, unknown>
  return typeof o.name === 'string' && o.name.length > 0
    && typeof o.url === 'string' && o.url.length > 0
    && typeof o.bookSourceName !== 'string'
}

/**
 * Native → 合并视图（与 flattenDialect 同构的目标位）：按原生规则格式语义映射 name/url/headers/group、
 * 三个规则对象、ruleContent.nextPage/replaceRules[]；searchUrl 的 `{{keyword}}` 改写为 `{{key}}`；
 * `authorPrefix` 追加 `##^前缀##` 净化尾；取值字段裸选择器补隐式 `@text` 终端。ruleFind 见下。
 * v1 无排序/POST 面：ruleRank/pageUrl/reverse/charset 等如实聚合 warning（宁吵不瞒）。
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
  // authorPrefix：详情面作者规则追加 `##^前缀##` 尾（## 净化语义；前缀正则转义；拼串归 grammar.appendTail）
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
  // ruleFind（发现面）：url 模板 + kinds 分类入口；ruleSearch 是**整套**覆盖通用搜索规则（判据只看 list 非空）。
  // children 二级分类不接——如实进 warning，顶层那层照样落位。
  const find = raw.ruleFind
  if (typeof find === 'object' && find !== null && !Array.isArray(find)) {
    const mapped = nativeExploreFields(find as Record<string, unknown>)
    for (const [field, value] of Object.entries(mapped.values)) out[field] = value
    out.ruleExploreKinds = mapped.kinds   // 键恒落位：消费者按 .length 读分类面
    if (mapped.sawChildren) {
      warnings.push({ field: 'ruleFind.kinds', message: 'kinds[].children（二级分类）不接，已忽略' })
    }
  }
  // 顶层未支持字段（v1 无 POST/排序面；charset 由抓取链自动识别）
  const weight = raw.weight
  if (typeof weight === 'number' && weight !== 0) unsupported.push('weight')
  if (str(raw.charset) !== null) unsupported.push('charset')
  const method = str(raw.method)
  if (method !== null && method.toUpperCase() !== 'GET') unsupported.push('method')
  for (const f of ['body', 'searchMethod', 'searchBody'] as const) if (str(raw[f]) !== null) unsupported.push(f)
  // ruleRank 不认：排行榜是功能级缺口（不是分页缺口），本仓不接，只在这里如实登记为未支持字段
  for (const block of ['ruleRank'] as const) {
    const b = raw[block]
    if (typeof b === 'object' && b !== null && !Array.isArray(b)
      && Object.values(b as Record<string, unknown>).some((v) => str(v) !== null || Array.isArray(v) || (typeof v === 'object' && v !== null))) {
      unsupported.push(block)
    }
  }
  if (unsupported.length > 0) {
    warnings.push({ field: '(Native 未支持字段)', message: `已忽略不支持的字段：${unsupported.join('、')}` })
  }
  // 终端语义收口：取值字段裸选择器补隐式 @text（在净化尾追加之后——withImplicitText 只处理链体，尾部不动）
  for (const f of NATIVE_TEXT_FIELDS) {
    const v = out[f]
    if (typeof v === 'string' && v.length > 0) out[f] = withImplicitText(v)
  }
  return out
}

/** replaceRules[] → 逐条 appendTail（`##正则##替换` 尾；replacement 缺省空串=删除、enabled 缺省 true 跳过 false）。
 *  构词越界（pattern 含 ## 等）由 appendTail round-trip 拦下，进 normalize warnings。 */
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

/** 表里 `always` 档的读口：键集由 `RuleFieldsOf<'always'>` 收口——表加一行而这里没跟，`tsc`
 *  当场红。逐字段的 why 仍写在每个读口上。 */
const ALWAYS_READERS: Record<RuleFieldsOf<'always'>, (raw: unknown) => string | null | undefined> = {
  // ruleDetailInit 按 raw 重推：normalize 只在入库时映射 ruleBookInfo.init，存量缺此键 → 详情换根静默不生效、
  // tocUrl 模板 Miss → EmptyToc（矩阵行 `c-rule-book-info-init`）。raw 是真相、rules 是派生，定点补这一个字段，
  // 不整链重 normalize（那可能拒绝存量源）；**读路必须是导入侧那一份**（deriveRuleField）。
  ruleDetailInit: (raw) => deriveRuleField(raw, 'ruleDetailInit'),
  // headerRule 按 raw 重推：入库时若把 `@js:` header 当坏 JSON 丢弃，不重推则动态头永远不生效。
  headerRule: rawHeaderRule,
  // bookUrlPattern 按 raw 重推：存量 rules 缺键 → 声明了它的源搜索时只跑列表规则（补推后命中即按详情页解析）。
  bookUrlPattern: rawRulePattern,
}

/** 表里 `conditional` 档的读口：判据自带前置条件，故交整条源。 */
const CONDITIONAL_READERS: Record<RuleFieldsOf<'conditional'>, (s: NovelSource, mark: () => void) => void> = {
  // 静态头按 raw 补推（与 headerRule 成对）：单引号形态的头若被判成坏 JSON 丢弃，只改解析器不动存量则受害源的头仍然空。
  // 触发条件收窄到「规则形态为 null 且头表也是 null」：不覆盖任何已被判为有效的值（合法空对象派生出来是 {}）。
  header: (s, mark) => {
    if (s.rules.headerRule !== null || s.rules.header !== null) return
    const wantHeader = rawHeaderFields(s.raw)
    if (wantHeader !== undefined) { s.rules.header = wantHeader; mark() }
  },
}

/**
 * 存量收敛：把已落盘的 `sources.json` 条目按 raw 重新推导到当前模型形状，原地修改并返回是否有改动。
 * 触发点只有 `SourceRegistry.load`；覆盖策略（哪些字段恒覆盖、哪些只填缺席、哪些键必须恒在场）的材料面住
 * `rule-fields.ts` 的字段表——按**生产者数量**分档，这里只消费，不另列名单。幂等：收敛过一次后再进来不再改动。
 */
export function rehydrateStoredSource(s: NovelSource): boolean {
  // sources.json 是盘上 JSON：损坏条目 / 手改文件可以缺 `rules`——按过线原值验一遍（镜像钉死 ≠ 运行时必有）
  const rulesShape: unknown = s.rules
  if (typeof rulesShape !== 'object' || rulesShape === null) {
    throw new Error(`sources.json 条目缺少 rules 对象（id=${s.id}）：拒绝按空规则继续`)
  }
  let changed = false
  const mark = (): void => { changed = true }
  /** 「恒覆盖」收敛：raw 在就对齐；raw 不在只把缺席键补成 null（required 形状）。入参键类型取自表的 `always` 档，
   *  读口由 `ALWAYS_READERS` 以同一键集做 Record——表加一行而没补读口，`tsc` 当场红。 */
  const syncRule = (key: RuleFieldsOf<'always'>, want: string | null | undefined): void => {
    // 盘上老条目可以整键缺席（模型的 required 形状管不到已落盘的 JSON）：按过线原值读，缺席才补 null
    const current: unknown = s.rules[key]
    if (want !== undefined && current !== want) { s.rules[key] = want; mark() }
    else if (current === undefined) { s.rules[key] = null; mark() }
  }

  // enabled 缺省归一为 true、type 缺省归一为 'text'——存量可能没有这两格，否则参与集判据静默排除老源。
  if (typeof s.enabled !== 'boolean') { s.enabled = true; mark() }
  if (!Object.hasOwn(SOURCE_KIND_LABEL, s.type)) { s.type = 'text'; mark() }
  // type 按 raw.bookSourceType 重推：库里可能存有 1/2 误标的条目（漫画/短剧混进聚合搜索与文字书架）。
  // **认不出的编码 → 'unknown'**（退出参与集；不打 status——坏源那条道会被下一次重验洗白）。
  const derived = contentTypeOfRaw(s.raw)
  if (derived !== undefined && s.type !== derived) { s.type = derived; mark() }

  /** 各收敛段的 runner：段序由表的 `REHYDRATE_PHASES` 给（段号是模式的事实），这里只登记每段做什么。
   *  段内步序不在表里——`ruleExploreKinds` 不是字符串字段、不进表（`ADR-0044`），数组归一留在 vacant 段尾。 */
  const runners: Record<Exclude<RehydrateMode, 'none'>, () => void> = {
    // 恒覆盖档按表的行逐条走读口（表加一行而 ALWAYS_READERS 没补，tsc 红）；raw 非对象 → 读口回 undefined（不动）。
    always: () => {
      for (const spec of RULE_FIELD_SPECS) {
        if (spec.rehydrate === 'always') syncRule(spec.model, ALWAYS_READERS[spec.model](s.raw))
      }
    },
    // ruleExplore* 十一键按 raw 补推：发现面是后来才接的链路，存量 rules 里这一族是空的源在书城整个是空的。
    // 读口就是导入侧那一次 flatten（rawExploreFields）。**这一族（vacant 档）连「在场但为空」也算可填**，与
    // `missing` 档「只填缺席」不同：这一族的派生值只有一个来源，老库的 null/空数组不代表「读过」，按 raw 重推才是当前真相。
    // 派生值为空时不写，所以这一步单调且幂等；键恒在场由缺席那一支负责。
    vacant: () => {
      const wantExplore = rawExploreFields(s.raw)
      if (wantExplore !== undefined) {
        const rules = s.rules as unknown as Record<string, unknown>
        for (const [k, v] of Object.entries(wantExplore)) {
          const cur = rules[k]
          const vacant = cur === undefined || cur === null
            || (Array.isArray(cur) && (cur as unknown[]).length === 0)
          const hasValue = Array.isArray(v) ? (v as unknown[]).length > 0 : v !== null
          if (hasValue && vacant) { rules[k] = v; mark() }
          else if (cur === undefined) { rules[k] = v; mark() }
        }
      }
      // 键恒在场是 required 形状的合同，且**必须在本段补推之后**：消费按 `rules.ruleExploreKinds.length` 读分类面，
      // raw 不是对象 / 没有发现面 / 键上躺着脏形状都靠这一步收敛成空数组；反过来会把按 raw 推出来的分类清掉。
      if (!Array.isArray(s.rules.ruleExploreKinds)) {
        s.rules.ruleExploreKinds = []; mark()
      }
    },
    // 条件档同样按表走读口（键集由 RuleFieldsOf<'conditional'> 收口，表加一行这里没补 tsc 红）。
    conditional: () => {
      for (const spec of RULE_FIELD_SPECS) {
        if (spec.rehydrate === 'conditional') CONDITIONAL_READERS[spec.model](s, mark)
      }
    },
    // kind / wordCount 按 raw 补推（`missing` 档）：这两个字段后来才接进取值链路，老数据的 rules 没这四个键。
    // **只补 `undefined` 的键、不覆盖已有值**——新源由 normalize 正确派生，这里再读一遍是第二条路，覆盖会把对的改成错的。
    missing: () => {
      const wantMeta = rawBookMetaFields(s.raw)
      if (wantMeta !== undefined) {
        for (const [k, v] of Object.entries(wantMeta)) {
          const rules = s.rules as unknown as Record<string, string | null | undefined>
          if (rules[k] === undefined) { rules[k] = v; mark() }
        }
      }
    },
  }
  for (const phase of REHYDRATE_PHASES) runners[phase]()

  // groups 拆分迁移与 name 前缀图标迁移（幂等）：组合串按 splitGroups 收敛、装饰前缀按 stripLeadingIcons 剥掉。
  if (Array.isArray(s.groups)) {
    const migrated = s.groups.flatMap(splitGroups)
    if (migrated.length !== s.groups.length || migrated.some((g, i) => g !== s.groups[i])) {
      s.groups = migrated; mark()
    }
  }
  if (typeof s.name === 'string') {
    const cleanName = stripLeadingIcons(s.name)
    if (cleanName !== s.name) { s.name = cleanName; mark() }
  }
  // AI 搜索标记是用户偏好而非书源格式字段：存量缺键 / 非布尔一律按「未选中」收敛（缺省关闭）。
  if (typeof s.aiSearch !== 'boolean') { s.aiSearch = false; mark() }
  return changed
}
