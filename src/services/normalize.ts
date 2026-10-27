import { appendTail, withImplicitText } from '../engine/grammar.js'
import { parseExploreKinds, usableKind } from './explore-url.js'
import { DIALECT_MAP, NATIVE_MAP, NATIVE_TEXT_FIELDS, RULE_FIELD_SPECS, RULE_FIELDS, VACANT_RULE_FIELDS } from './rule-fields.js'
import type { RuleFieldsOf } from './rule-fields.js'
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

/** legado `ruleExplore` 的条目子字段 → 发现面模型字段（`bookList` 是整套启用的判据，故不在循环里）。
 *  与原生侧 `nativeExploreFields` 那组 `put` 同名单——两侧落的是同一批模型键。 */
const RULE_EXPLORE_MAP: Record<string, string> = {
  name: 'ruleExploreName', author: 'ruleExploreAuthor', bookUrl: 'ruleExploreBookUrl',
  coverUrl: 'ruleExploreCoverUrl', intro: 'ruleExploreIntro', kind: 'ruleExploreKind',
  lastChapter: 'ruleExploreLastChapter', wordCount: 'ruleExploreWordCount',
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
  // 名称前缀图标剥离：真实书源包惯用分组图标打头（「⚡📂听小说APP」——图标是它自己分组的图标，
  // 给阅读端界面看的）；本插件分组已独立成列，名字再带一遍是重复。
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
  // JSON 对象/JSON 串 → header。两者互斥（同一 raw.header 二选一），规则形态不产生「非法 JSON」警告。
  rules.headerRule = normalizeHeaderRule(r.header)
  rules.header = rules.headerRule === null ? normalizeHeader(r.header, warnings) : null
  // ruleExploreKinds 不是字符串（分类入口数组），故不进 RULE_FIELDS 循环。**两个方言共用这一处落位**：
  // 原生走 flattenNative 的 ruleFind.kinds，legado 走 flattenDialect 解 exploreUrl（平铺 raw 自带
  // 那一格时照原样收，判据同住 flattenDialect）；
  // 消费者按 `rules.ruleExploreKinds.length` 读分类面，缺键即 TypeError，所以两档都恒落一个数组
  // （没落位的那档即空数组——脏值与缺键都不许进模型）。
  rules.ruleExploreKinds = Array.isArray(r.ruleExploreKinds)
    ? (r.ruleExploreKinds as Array<{ title: string; url: string }>)
    : []
  // 表里的特殊字段不进平铺循环，各留一块落位：
  // exploreUrl 是发现入口的声明串（解析归 flattenDialect 与 `explore-url.ts`），不是取值规则；
  // jsLib 是源级脚本库，只存在于平铺 raw；章节 flag 是逐章折布尔的规则，落位与那条下游口径
  // （`online-reading.isTrueRuleValue`）放在一起读。其余规则字段（含详情面与目录列表）都由
  // `rule-fields.ts` 的字段表列出、走上面的循环。
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
      name: name!, baseUrl: baseUrl!,
      enabled: typeof r.enabled === 'boolean' ? r.enabled : true,
      groups, type, raw, rules,
    },
  }
}

/** 内容形态中文名（只服务导入拒绝文案——列表不渲染 type）。Record 由编译器强制穷尽，
 *  故它同时是**值域见证**：`rehydrateStoredSource` 用 `Object.hasOwn(SOURCE_KIND_LABEL, type)` 判旧数据
 *  的 type 还在不在域内（只看自有键——用 `in` 会把 `toString` 这类原型键也当成合法形态），
 *  不再手写第三份形态清单。 */
const SOURCE_KIND_LABEL: Record<SourceContentKind, string> = {
  text: '文本', image: '图片', audio: '音频', file: '文件', unknown: '未知',
}

/** 分组串拆分：一个源可属多个分组，兼容三种分隔符 `,`（主流导出）/`\`（旧阅读端写法）/
 *  `，`（全角）+ trim + 去空段 + 段内去重。只按 `\` 拆会让逗号粘连把多组并成一个假组名。
 *  存量脏数据由 SourceRegistry.load 迁移收敛。 */
export function splitGroups(raw: string): string[] {
  const out: string[] = []
  for (const part of raw.split(/[\\,，]/)) {
    const g = part.trim()
    if (g !== '' && !out.includes(g)) out.push(g)
  }
  return out
}

/** 名称前缀图标剥离：只剥「开头连续的装饰符号段」——\p{So}\p{Sk} 覆盖 ⚡📂🎬 等全部杂项符号，
 *  FE0F(变体选择符)/200D(ZWJ) 是 emoji 组合件；【】等括号是 Po/Ps 不在列（可能是名字本体装饰），
 *  尾部/中部不动。剥完为空（整名都是图标）→ 保留原名（宁丑不空）。 */
function stripLeadingIcons(name: string): string {
  const stripped = name.replace(/^[\s\p{So}\p{Sk}\uFE0F\u200D]+/u, '').trimStart()
  return stripped === '' ? name : stripped
}

/** 书源内容形态取值（由书源格式定义：0/-1/缺省=文本，**1=音频，2=图片，3=文件**——把 1/2
 *  读反会让漫画/短剧源被误标后混进聚合搜索与文字书架）：-1=ALL 在源里罕见，按文本放行。
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

/** raw.bookSourceType → 内容形态（quiet 版，供 `rehydrateStoredSource` 存量重推）：
 *  缺省/0/-1 → 'text'，其余（1/2/3 与认不出的值）→ 对应形态或 'unknown'——旧数据当年按
 *  文本入库的误标在此按 raw 重推收敛出去，不再当文本源参搜；raw 不是对象 → undefined（别动）。 */
function contentTypeOfRaw(raw: unknown): SourceContentKind | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  return kindOfSourceValue((raw as Record<string, unknown>).bookSourceType)
}

/** raw → 单个模型字段的派生值：与 `normalizeSource` 共用**同一份**展平实现（方言识别、字符串化
 *  容器、平铺/嵌套优先级、Native 隐式 `@text` 全在导入侧那一份里），只是不跑准入（缺必填 / 非文本
 *  源照样读得出该字段——补推不许顺手拒掉存量源）。
 *  返回：派生到的非空串 / null（raw 是对象但派生到空）/ undefined（raw 不是对象，调用方别动）。
 *  新增需要存量收敛的规则字段时**只加调用点**，不要再写第二个读 raw 的函数
 *  （第二份解释会与导入侧口径不同、补推恒覆盖 → 把正确值改写落盘，读数上看不出来）。
 *  `rawBookMetaFields` 自带优先级，故只能只填缺席键。 */
function deriveRuleField(raw: unknown, field: string): string | null | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const r = isNativeSource(raw)
    ? flattenNative(raw as Record<string, unknown>, [])
    : flattenDialect(raw as Record<string, unknown>, [])
  const v = (r as Record<string, unknown>)[field]
  return typeof v === 'string' && v.length > 0 ? v : null
}

/** raw.bookUrlPattern（书源格式的**顶层**字段，不在任何 rule 对象里）：
 *  `rehydrateStoredSource` 的存量重推口（触发点仍是 `SourceRegistry.load`）——旧数据的 rules
 *  没这个键，不重推则嗅探对老源永不生效。raw 非对象 → undefined（不动）；空白 → null。 */
function rawRulePattern(raw: unknown): string | null | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const v = (raw as Record<string, unknown>).bookUrlPattern
  return typeof v === 'string' && v.trim() !== '' ? v : null
}

/** 存量重推用的四个模型键：**模式 `missing` 的字段就是这份名单**（表是唯一登记处），容器与
 *  子字段名取自同一行的 legado 路径——平铺方言把同一个键写在 raw 顶层（下面回落到 `r[model]`），
 *  对象/Native 方言住在容器里。 */
const BOOK_META_KEYS = RULE_FIELD_SPECS.flatMap((s) => (
  s.rehydrate === 'missing' && s.legadoObject !== undefined && s.legadoKey !== undefined
    ? [{ container: s.legadoObject, nested: s.legadoKey, model: s.model }]
    : []
))

/** raw 的分类 / 字数四项（供 `rehydrateStoredSource` 存量重推，与 `rawHeaderRule` /
 *  `rawRulePattern` 同族）。这两个字段后接进取值链路，存量 rules 没这四个键 → 源里读得出的
 *  分类/字数对老库**永远是 null**（缺这一步时审计到货率为零）。
 *  读口复用导入时的同一套材料：容器走 `ruleContainer`（字符串化容器照解析，不另立规矩）、
 *  容器与键名取自规则字段表的 legado 路径（与 `flattenDialect` 同一批行）、Native 的裸选择器补
 *  隐式 `@text`（`withImplicitText`，与 flattenNative 同口径）。
 *  raw 不是对象 → undefined（调用方别动）。 */
function rawBookMetaFields(raw: unknown): Record<string, string | null> | undefined {
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

/** 发现面十一键（键名直接取自 `NormalizedRules`，不另立一份同名字段表）。 */
type ExploreField =
  | 'ruleExploreUrl' | 'ruleExploreKinds' | 'ruleExploreList' | 'ruleExploreName'
  | 'ruleExploreAuthor' | 'ruleExploreBookUrl' | 'ruleExploreCoverUrl' | 'ruleExploreIntro'
  | 'ruleExploreKind' | 'ruleExploreLastChapter' | 'ruleExploreWordCount'

/** 原生 `ruleFind` → 发现面取值（由导入侧 `flattenNative` 调用；存量补推侧 `rawExploreFields`
 *  跑的是同一个 flatten，两条路因此不可能分叉）。这个函数只交材料、不产留痕——`sawChildren` 回给
 *  调用方点名，因为导入与补推的留痕渠道不同。口径三条（判据只在能分叉的地方钉死）：整套覆盖的
 *  启用判据只看 `ruleSearch` 的 list 非空（逐字段回落会把对面本该用通用规则的源读成半套）、
 *  kinds 只收标题与地址**去空白后**非空的顶层项、`children` 非空要如实报。
 *  非对象形态的 `ruleFind` 不在此列（同 `ruleRank` 一族：静默忽略）。 */
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
    if (typeof o.list === 'string' && o.list.length > 0) {
      put('ruleExploreList', o.list)
      put('ruleExploreName', o.name); put('ruleExploreAuthor', o.author)
      put('ruleExploreBookUrl', o.bookUrl); put('ruleExploreCoverUrl', o.coverUrl)
      put('ruleExploreIntro', o.intro); put('ruleExploreKind', o.kind)
      put('ruleExploreLastChapter', o.lastChapter); put('ruleExploreWordCount', o.wordCount)
    }
  }
  return { values, kinds, sawChildren }
}

/** 发现面字符串键 = 表里模式 `vacant` 的字段（`ruleExploreKinds` 是数组，另落）。
 *  这一族既是存量补推的「可填」名单，也是本函数要读的字段清单——两处不再各列一份。
 *  名单与 `ExploreField` 那十键双向钉在 `tests/services/rule-fields.test.ts` 的 `vacant` 档：
 *  表把某行改出这一档，这个返回对象就少一个键（书城整族读空、`tsc` 不响），那条钉子当场红。 */
type ExploreStringField = Exclude<ExploreField, 'ruleExploreKinds'>
const EXPLORE_STRING_MODELS: readonly ExploreStringField[] = VACANT_RULE_FIELDS

/** 发现面十一键（供 `rehydrateStoredSource` 存量按 raw 补推，触发点 `SourceRegistry.load`，
 *  与 `rawBookMetaFields` / `rawRulePattern` 同族）。存量 rules 里这一族是空的源，在书城**整个是空的**（kinds 一条不剩、条目规则缺席只能退回
 *  通用搜索规则），这个读口就是把它们从 raw 现推回来。
 *  两方言共用**导入侧那一次 flatten**：方言判定、字符串化容器、平铺/嵌套优先级、Native 的隐式
 *  `@text` 终端全在那一份里。不要在本函数再调一次 `nativeExploreFields` 或手工补终端：
 *  那是同一条解释的第二份抄本——加字段时两处会分叉，而 legado 方言整个读不到。
 *  「raw 里读不出发现面」如实给全 null + `[]`，与「raw 不是对象」的 undefined 是分开的两档：
 *  前者是「这源没分类」，后者是「这里没读」，不许在返回值里折叠。
 *  warnings 传空数组：留痕是导入那一次的事，补推每次启动都跑，同一批点名再刷一遍只会淹掉真正
 *  的导入问题（与 `deriveRuleField` 同口径）。 */
export function rawExploreFields(raw: unknown): Pick<NormalizedRules, ExploreField> | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const view = (isNativeSource(raw)
    ? flattenNative(raw as Record<string, unknown>, [])
    : flattenDialect(raw as Record<string, unknown>, [])
  ) as Record<string, unknown>
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

/** 发现开关（书源格式的 `enabledExplore`，供书城参与判据读）：**只有显式 false 才算关**。
 *  缺省是开——原生方言的 raw 根本没这个键，「没写」不等于「把发现关掉」；raw 不是对象同样返回 true
 *  （读不动开关就不据此把源藏起来，宁展示不隐藏）。与 `contentTypeOfRaw` / `rawHeaderRule` 同族：
 *  raw → 模型位，缺省不拒。 */
export function rawExploreEnabled(raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null) return true
  return (raw as Record<string, unknown>).enabledExplore !== false
}

/** 规则容器的三态解析结果：拿到对象 / 明确缺席（静默）/ 看着像容器但读不出来（点名）。 */
type Container = { obj: Record<string, unknown> } | { absent: true } | { unreadable: string }
/**
 * 规则容器解析（书源格式里**每一个** rule 对象都允许两种形态：JSON 对象，或一段 JSON
 * **字符串**——公开书源分享里常这么存；对非对象容器直接 continue，会让这类源导入后规则全丢，
 * 表现成「缺正文规则」，读起来像源坏了而不是格式没接）。
 *
 * 判定边界刻意收窄：只有**以 `{` 开头**的字符串才是容器候选——`ruleContent` 这一键位还有本仓
 * 支持的平铺形态（值就是规则串），不以 `{` 开头的串一律照旧当规则用；`"null"` 与非串非对象按
 * 缺席静默处理。解析不出对象 → `unreadable`（原文截断带回点名）：不拿一段坏 JSON 冒充规则串。
 * `ruleContainer` 与展平后的 `delete` 是一件事的两半，缺了后者坏串会以「规则串」身份活到求值期，
 * 既不是缺席也让整源导入连带废掉。
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

/** 合并视图这一格是否**已带可用的分类入口**（平铺 raw 自己写了非空数组）——「平铺优先」那条尺在
 *  数组键上的读法：这条族里只有它是数组，走不了 `setIfVacant`，判据却必须是同一条。
 *  判到条目级而不是只判容器：脏数组（`[{}]`、`[42]`）与「没写」在这条尺上是同一种值——都不算在场，
 *  照旧由派生值接管（与「非数组照旧被派生值接管」同一条裁法，不另立第二种）。条目级的尺住
 *  `explore-url.usableKind`，本函数只加「每条都过」这一层。 */
function isArrayOfKinds(v: unknown): boolean {
  return Array.isArray(v) && v.length > 0 && v.every((e) => usableKind(e) !== null)
}

/**
 * 对象方言展平：五个规则字段（ruleSearch/ruleExplore/ruleBookInfo/ruleToc/ruleContent）
 * 为对象时（**或为字符串化的 JSON**，见 ruleContainer），把已映射子字段填进合并视图的目标位
 * （平铺字段已占的位不覆盖——平铺优先）。
 * 未映射且非空的子字段如实聚合 warning（宁吵不瞒），`ruleExplore` 里没被消费的子字段也并进
 * 这一处点名——同一类留痕全仓只开一条。
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
    // 字符串形态的容器值住在这一键上——它是容器原文不是平铺规则，不清掉会挡住 setIfVacant、
    // 甚至把整段 JSON 当规则串用下去；读不出的坏串同清（那才是「坏 JSON 冒充规则串」，
    // 这个键名本身就是规则位）。两半的另一半见 ruleContainer。
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
  // ruleExplore：判据只看 bookList，为什么不逐字段回落住在 `explore-face.rulesFor`（整套切换的
  // 实现那一侧）；这块里没被消费的**非空**子字段并入上面那圈 unsupported 的点名，不另开一条。
  const explore = containers.ruleExplore
  if (explore !== undefined) {
    const wholeSet = typeof explore.bookList === 'string' && explore.bookList.length > 0
    if (wholeSet) {
      setIfVacant('ruleExploreList', explore.bookList)
      for (const [sub, field] of Object.entries(RULE_EXPLORE_MAP)) setIfVacant(field, explore[sub])
    }
    // 未启用的那档整块一条都不被消费，故同样逐条点名（判据与上面那圈同一把尺：非空串才报）
    for (const [sub, v] of Object.entries(explore)) {
      const consumed = wholeSet && (sub === 'bookList' || sub in RULE_EXPLORE_MAP)
      if (!consumed && typeof v === 'string' && v.length > 0) unsupported.push(`ruleExplore.${sub}`)
    }
  }
  // exploreUrl → 分类入口（解析与形态判定的唯一实现住在 services/explore-url.ts）。
  // js 档与读不出的形状都**如实为空 + 点名**：静默给空就等于把「没接」写成「这源没分类」。
  // 那两条文案只答 **exploreUrl 这一档**：平铺 raw 自带分类入口时书城照样有入口，别把文案读成整源判定。
  const parsed = parseExploreKinds(out.exploreUrl)
  // 平铺优先这条尺也管这一格。值不是串、不走 setIfVacant，但规则是同一条：raw 顶层自带分类入口、
  // exploreUrl 却缺席或读不出的平铺源，被派生值无条件覆盖就是**静默清空**（改动前它进得了书城，
  // 清空还一处留痕都不留）。在场是非空数组才让位；在场是脏形状（非数组）照旧被派生值接管，
  // 收敛成数组那一步在 normalizeSource 落位处，与「缺键」同档。
  if (!isArrayOfKinds(out.ruleExploreKinds)) out.ruleExploreKinds = parsed.kinds
  if (parsed.form === 'js') {
    warnings.push({ field: 'exploreUrl', message: '发现入口是脚本形态（@js:/<js>），本期不执行脚本，该源在书城无分类入口' })
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
 * 「对象 JSON」的唯一宽松解析（**头与 URL 选项共用这一份**）：严格 JSON 优先，失败再按
 * 单引号交换试一次（`{'a':'b'}` → `{"a":"b"}`——真实源大量存在），两种都不行或形状不是对象
 * 才判失败。**只宽在引号形态，不猜结构**：补逗号、去尾逗号、剥注释都不做。
 *
 * 为什么要单点：对面把头 JSON 做成**两段解析**（严格 → 宽松），口径与出处记在矩阵行
 * `b-header-js` / `b-header-static`；头若只做一步 `JSON.parse`，单引号形态的头会静默丢。
 * `request.ts` 的选项 JSON 与头必须共用这一解析口，不允许第二处宽松解析。
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

/** 对象 → 字符串表（只收字符串值；非串值丢弃）——「哪些头条目活着」的唯一筛子：
 *  `normalizeHeader`、`rawHeaderFields` 与 `request.ts` 的选项内嵌 headers 共用这一份，
 *  值类型口径（现在是「只收 string」）改一处即三处同改。 */
export function stringTableOf(obj: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, val] of Object.entries(obj)) if (typeof val === 'string') out[k] = val
  return out
}

/** 存量补推用：按 raw 现读静态头表（规则形态 `@js:`/`<js>` 返回 undefined = 别动这一格） */
function rawHeaderFields(raw: unknown): Record<string, string> | undefined {
  const v = (raw as { header?: unknown } | null | undefined)?.header
  if (typeof v === 'string' && /^\s*(@js:|<js>)/i.test(v)) return undefined
  const obj = parseObjectJson(v)
  if (obj === undefined) return undefined
  return stringTableOf(obj)
}

/** 动态请求头规则判别（**合并视图版**，normalize 入库时用）：header 值是 `@js:`/`<js>` 规则
 *  （判别大小写不敏感）→ 返回规则原文；否则 null。 */
function normalizeHeaderRule(v: unknown): string | null {
  if (typeof v !== 'string') return null
  return v.startsWith('@js:') || v.startsWith('<js>')
    || v.startsWith('@JS:') || v.startsWith('@Js:') || v.toUpperCase().startsWith('<JS>')
    ? v : null
}

/** 动态请求头规则判别（**raw 源版**，供 `rehydrateStoredSource` 存量重推，触发点 `SourceRegistry.load`）：
 *  raw.header 是规则字符串 → 原文；raw 在场但非规则 → null；raw 不是对象 → undefined（调用方别动）。
 *  规则形态**不是**「非法 JSON」——它是书源的合法 header 形态；把它当坏 JSON 丢弃会让动态头
 *  不生效，存量靠 load 迁移按 raw 重推。 */
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

/**
 * Native → 合并视图（与 flattenDialect 同构的目标位）：按 android-ebook 原生规则格式语义映射
 * name/url/headers/group、三个规则对象的 list 三件套、ruleContent.nextPage/replaceRules[]；
 * searchUrl 占位符 `{{keyword}}` 改写为内部 `{{key}}`（`{{page}}` 同名不动）；
 * `authorPrefix` 追加 `##^前缀##` 净化尾到详情面作者规则（正则转义）；
 * 取值字段裸选择器补隐式 `@text` 终端（NATIVE_TEXT_FIELDS）。
 * ruleFind（发现面）：url 模板 + kinds 分类入口 + ruleSearch 整套覆盖（映射见下）。
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
  // ruleFind（发现面）：url 模板 + kinds 分类入口；ruleSearch 是**整套**覆盖通用搜索规则
  // （判据只看 list 非空，见 NormalizedRules 的注释）。children 二级分类本期不做——如实进 warning，
  // 不静默丢（顶层那层照样落位）。
  const find = raw.ruleFind
  if (typeof find === 'object' && find !== null && !Array.isArray(find)) {
    const mapped = nativeExploreFields(find as Record<string, unknown>)
    for (const [field, value] of Object.entries(mapped.values)) out[field] = value
    out.ruleExploreKinds = mapped.kinds   // 键恒落位：消费者按 .length 读分类面
    if (mapped.sawChildren) {
      warnings.push({ field: 'ruleFind.kinds', message: 'kinds[].children（二级分类）本期不支持，已忽略' })
    }
  }
  // 顶层未支持字段（v1 无 POST/排序面；charset 由抓取链自动识别）
  const weight = raw.weight
  if (typeof weight === 'number' && weight !== 0) unsupported.push('weight')
  if (str(raw.charset) !== null) unsupported.push('charset')
  const method = str(raw.method)
  if (method !== null && method.toUpperCase() !== 'GET') unsupported.push('method')
  for (const f of ['body', 'searchMethod', 'searchBody'] as const) if (str(raw[f]) !== null) unsupported.push(f)
  // ruleRank 仍然不认：对面已把整条排行榜声明链撤了（那是功能级缺口，不是分页缺口），本仓跟着不接
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

/** 表里 `always` 档的读口：键集由 `RuleFieldsOf<'always'>` 收口——表加一行而这里没跟，`tsc`
 *  当场红。逐字段的 why 仍写在每个读口上。 */
const ALWAYS_READERS: Record<RuleFieldsOf<'always'>, (raw: unknown) => string | null | undefined> = {
  // ruleDetailInit 按 raw 重推（init 换根映射的存量收敛）：normalize 只在入库时映射 ruleBookInfo.init，
  // 存量 rules 缺此键 → 详情换根静默不生效、tocUrl 模板 Miss 回退详情页地址 → EmptyToc（真机实证）。
  // raw 是真相、rules 是派生；定点补这一个字段，不整链重 normalize（那可能拒绝存量源）。
  // **读路必须是导入侧那一份**（deriveRuleField 直接跑 flattenDialect/flattenNative）：恒覆盖
  // 配第二份解释会把对的改成错的。
  ruleDetailInit: (raw) => deriveRuleField(raw, 'ruleDetailInit'),
  // headerRule 按 raw 重推：入库时若把 `@js:` header 当坏 JSON 丢弃（rules.header=null、原文只活在
  // raw 里），不重推则动态头永远不生效。
  headerRule: rawHeaderRule,
  // bookUrlPattern 按 raw 重推：详情页嗅探字段是后来才读的，存量 rules 缺键 → 声明了它的源
  // 搜索时照旧只跑列表规则（补推后命中即按详情页解析）。
  bookUrlPattern: rawRulePattern,
}

/** 表里 `conditional` 档的读口：判据自带前置条件，故交整条源。 */
const CONDITIONAL_READERS: Record<RuleFieldsOf<'conditional'>, (s: NovelSource, mark: () => void) => void> = {
  // 静态头按 raw 补推（与 headerRule 成对）：单引号形态的头若被判成坏 JSON 丢弃，只改解析器
  // 不动存量则受害源的头仍然是空的（现量见矩阵行 `b-header-static`）。
  // 触发条件刻意收窄到「规则形态为 null 且头表也是 null」：只有这种形状需要补推，
  // 不会覆盖任何今天被判为有效的值（合法空对象 `{}` 派生出来是 {}，不是 null）。
  header: (s, mark) => {
    if (s.rules.headerRule !== null || s.rules.header !== null) return
    const wantHeader = rawHeaderFields(s.raw)
    if (wantHeader !== undefined) { s.rules.header = wantHeader; mark() }
  },
}

/**
 * 存量收敛：把已落盘的 `sources.json` 条目按 raw 重新推导到当前模型形状，原地修改并返回是否有改动。
 * 触发点只有 `SourceRegistry.load`；「哪些字段恒覆盖、哪些只填缺席、哪些键必须恒在场、谁必须排在谁
 * 之后」逐条写在实现它的那一格上面。覆盖策略的材料面住 `rule-fields.ts` 的字段表：每个字段归哪一档
 * （按**生产者数量**分档）由那一行的模式列登记，这里只消费，不另列名单。
 * 幂等：收敛过一次后再进来不再产生改动。
 */
export function rehydrateStoredSource(s: NovelSource): boolean {
  if (typeof s.rules !== 'object' || s.rules === null) {
    throw new Error(`sources.json 条目缺少 rules 对象（id=${String(s.id)}）：拒绝按空规则继续`)
  }
  let changed = false
  const mark = (): void => { changed = true }
  /** 「恒覆盖」收敛：raw 在就对齐；raw 不在只把缺席键补成 null（required 形状）。
   *  入参键类型取自表的 `always` 档，读口由 `ALWAYS_READERS` 以同一键集做 Record——
   *  表加一行而没补读口，`tsc` 当场红。逐字段的 why 住各读口上。 */
  const syncRule = (key: RuleFieldsOf<'always'>, want: string | null | undefined): void => {
    if (want !== undefined && s.rules[key] !== want) { s.rules[key] = want; mark() }
    else if (s.rules[key] === undefined) { s.rules[key] = null; mark() }
  }

  // enabled 缺省归一为 true——早期数据无此字段，缺省即「启用」，否则参与集判据
  // （`services/participation.ts` 的 `participates`）静默排除老源；type 缺省归一为 'text'——
  // 早期数据无此字段（当时 bookSourceType 根本没读）。
  if (typeof s.enabled !== 'boolean') { s.enabled = true; mark() }
  if (!Object.hasOwn(SOURCE_KIND_LABEL, s.type)) { s.type = 'text'; mark() }
  // type 按 raw.bookSourceType 重推——旧映射把 1/2 读反，漫画/短剧源被误标 text 混进聚合搜索与
  // 文字书架；**认不出的编码 → 'unknown'**（读不懂不等于文本源，退出参与集；不打 status——
  // 探针按搜索面判 verified，坏源那条道会被下一次重验洗白）。
  const derived = contentTypeOfRaw(s.raw)
  if (derived !== undefined && s.type !== derived) { s.type = derived; mark() }

  // 恒覆盖档按表的行逐条走读口：表加一行而 ALWAYS_READERS 没补，`tsc` 当场红。
  // raw 非对象 → 读口回 undefined（不动）；raw 在场：键恒落成 string | null（required 形状）。
  for (const spec of RULE_FIELD_SPECS) {
    if (spec.rehydrate === 'always') syncRule(spec.model, ALWAYS_READERS[spec.model](s.raw))
  }

  // ruleExplore* 十一键按 raw 补推（与上面几条同族的存量收敛）：发现面是后来才接的链路，
  // 存量 rules 里这一族是空的源在书城**整个是空的**（kinds 一条不剩、条目规则缺席只能退回
  // 通用搜索规则）。读口就是导入侧那一次 flatten（rawExploreFields），不另立第二条规则解释。
  // **这一族（表里的 `vacant` 档）连「在场但为空」也算可填**，与下面 kind/wordCount 那族 `missing` 档「只填缺席」不同。差别不在宽容，
  // 在生产者数量：这一族的派生值只有那份映射一个来源，老库里躺着 null 与空数组不代表
  // 「读过且为空」，只代表那一版还没接 legado——按 raw 重推才是它的当前真相。那两族有两条读路、
  // 优先级本就不同（导入侧平铺优先、重推侧容器优先），覆盖会把对的改成错的。
  // 派生值为空时不写，所以这一步单调且幂等；键恒在场（required 形状的合同）仍由缺席那一支负责。
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
  // 键恒在场是 required 形状的合同，且**必须在上面那段之后**：消费者按
  // `rules.ruleExploreKinds.length` 读分类面，raw 不是对象 / raw 里没有发现面 / 键上躺着脏形状
  // （非数组）都靠这一步收敛成空数组；反过来的顺序会把按 raw 推出来的分类清掉。
  if (!Array.isArray(s.rules.ruleExploreKinds)) {
    s.rules.ruleExploreKinds = []; mark()
  }

  // 条件档同样按表走读口（键集由 RuleFieldsOf<'conditional'> 收口）：表加一行而
  // CONDITIONAL_READERS 没补，`tsc` 当场红。
  for (const spec of RULE_FIELD_SPECS) {
    if (spec.rehydrate === 'conditional') CONDITIONAL_READERS[spec.model](s, mark)
  }

  // kind / wordCount 按 raw 补推（表里的 `missing` 档；与上面几条同族的存量收敛）：这两个字段后来才接进取值链路，
  // 老数据的 rules 根本没这四个键 → 不补推则读得出的分类/字数对已入库的源永远是 null。
  // **与上面三条的差别**：只补 `undefined` 的键、不覆盖已有值——新入库的源由 normalize 正确派生
  // （含字符串化容器那条路径），这里再按 raw 读一遍是第二条路，覆盖会把对的改成错的。
  const wantMeta = rawBookMetaFields(s.raw)
  if (wantMeta !== undefined) {
    for (const [k, v] of Object.entries(wantMeta)) {
      const rules = s.rules as unknown as Record<string, string | null | undefined>
      if (rules[k] === undefined) { rules[k] = v; mark() }
    }
  }

  // groups 拆分迁移——早期只按 `\` 拆，真实导出的逗号粘连组合串按 splitGroups 收敛成多段（幂等）；
  // name 前缀图标迁移——书源包惯用的分组装饰前缀按 stripLeadingIcons 剥掉（幂等）。
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
  return changed
}
