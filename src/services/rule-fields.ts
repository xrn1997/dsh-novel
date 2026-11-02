import type { NormalizedRules } from './types.js'

/**
 * 规则字段集：一个模型键一行；通用容器字段写明它在两方言里的路径，外加 Native 隐式终端标记、
 * 存量收敛的覆盖模式，以及两列行级登记（同一事实的另一键、发现面整套启用的闸）。导入循环、
 * 两方言通用展平、隐式终端清单、发现面两方言子字段名、条目装配的字段位与存量收敛的档位 / 段序
 * 都从这张表派生——字段的事实只写一次（裁决与被否方案见 `ADR-0044`）。
 * 为什么必须守住这一处：这类字段一旦散在几份名单里，漏掉任一处都只表现为「某个字段死活是 null」，
 * 从哪条日志里都查不到原因。发现面条目字段是边界——`ruleExplore` 与 Native `ruleFind` 的整套
 * 落位与展平实现仍住 normalize 的显式分支，条目装配侧的整套切换住 `bridge.hitRuleOf`；表为它们
 * 登记的是模型键、隐式终端、覆盖模式与配对目标，方言子字段名由配对目标的方言列反推，仍不登记在
 * 发现面行上。
 *
 * 边界：`ruleExploreKinds` 是数组不是字符串，不在这张表里（落位住 normalize 的显式分支）；表里
 * 的特殊字段（`searchUrl` / `exploreUrl` 源级声明、header 两形态、jsLib、章节 flag）各有自己的
 * 落位分支，由 `RULE_FIELDS` 过滤掉，不进平铺循环。字段**怎么收口**（首项/整块/布尔折叠）仍由
 * 各自的调用点与 `bridge` 的投影函数决定——那是行为，不是登记事实，表里不抄第二份。
 */

/** 存量收敛的覆盖模式，按**生产者数量**分档（不合并成一种「有值就写」）。
 *  - `always`：单一读口恒覆盖（导入与重推跑同一份 raw 解释，覆盖不会把对的改成错的）；
 *  - `vacant`：发现面那族，派生值只有一份来源，老库里的 null 与空数组不代表「读过且为空」；
 *  - `missing`：分类/字数那族，有两条读路且优先级不同（导入侧平铺优先、重推侧容器优先），只填缺席键；
 *  - `conditional`：静态头，只有「规则形态与头表都为空」这一种存量形状才补推；
 *  - `none`：入库时落位，存量不重推。 */
export type RehydrateMode = 'always' | 'vacant' | 'missing' | 'conditional' | 'none'

/** 存量收敛的段序（表级映射，不逐行登记）：段号是「谁必须排在谁之后」的事实——逐行重复段号
 *  就是 `rehydrateStoredSource` 的第二份段序抄本。间距留 10，将来插段不必重编。
 *  导出只为钉子（`rule-fields.test.ts` 逐格对段号）；生产段序走同文件的 `REHYDRATE_PHASES`。 */
export const REHYDRATE_PHASE: Record<Exclude<RehydrateMode, 'none'>, number> = {
  always: 10, vacant: 20, conditional: 30, missing: 40,
}

/** 按段号升序的段序清单：`rehydrateStoredSource` 照它依次跑 runner 表（不按对象插入序赌）。 */
export const REHYDRATE_PHASES: readonly Exclude<RehydrateMode, 'none'>[] =
  (Object.keys(REHYDRATE_PHASE) as Array<Exclude<RehydrateMode, 'none'>>)
    .sort((a, b) => REHYDRATE_PHASE[a] - REHYDRATE_PHASE[b])

export interface RuleFieldSpec {
  model: keyof NormalizedRules
  /** legado 对象方言的容器与子字段（平铺方言的键与模型键同名，走容器缺席那一支） */
  legadoObject?: string
  legadoKey?: string
  /** android-ebook 原生规则格式的容器与子字段 */
  nativeObject?: string
  nativeKey?: string
  /** Native 方言的裸选择器即「取文本」：展平后由 `grammar.withImplicitText` 补终端 */
  nativeImplicitText?: boolean
  /** 同一事实的另一键：只登记在派生侧（header ↔ headerRule、详情面 / 发现面 → 通用搜索面），
   *  不双向登记。发现面的两方言子字段名经本列反推（见 `EXPLORE_LEGADO_SUBS` / `EXPLORE_NATIVE_SUBS`），
   *  所以发现面行仍不登记方言路径（`ADR-0044`）。 */
  pairWith?: keyof NormalizedRules
  /** 本行即发现面整套启用的闸（`ruleExploreList` 唯一）：判据只看它是否非空串。 */
  wholeSetGate?: true
  rehydrate: RehydrateMode
}

export const RULE_FIELD_SPECS = [
  // 搜索上下文（ruleSearch）落搜索面字段，详情上下文（ruleBookInfo）落 ruleDetail*——两上下文的
  // 规则不同，混用会把搜索条目规则套到详情页造垃圾标题；详情面的回落只在
  // `bridge.detailFieldsFromContext` 一处。平铺方言的键与模型键同名，直通同一个展平视图。
  //
  // ── 搜索面（ruleSearch 容器）──────────────────────────────────────
  { model: 'ruleBookList', legadoObject: 'ruleSearch', legadoKey: 'bookList', nativeObject: 'ruleSearch', nativeKey: 'list', rehydrate: 'none' },
  { model: 'ruleBookName', legadoObject: 'ruleSearch', legadoKey: 'name', nativeObject: 'ruleSearch', nativeKey: 'name', nativeImplicitText: true, rehydrate: 'none' },
  { model: 'ruleAuthor', legadoObject: 'ruleSearch', legadoKey: 'author', nativeObject: 'ruleSearch', nativeKey: 'author', nativeImplicitText: true, rehydrate: 'none' },
  { model: 'ruleBookUrl', legadoObject: 'ruleSearch', legadoKey: 'bookUrl', nativeObject: 'ruleSearch', nativeKey: 'bookUrl', rehydrate: 'none' },
  { model: 'ruleCoverUrl', legadoObject: 'ruleSearch', legadoKey: 'coverUrl', nativeObject: 'ruleSearch', nativeKey: 'coverUrl', rehydrate: 'none' },
  { model: 'ruleIntro', legadoObject: 'ruleSearch', legadoKey: 'intro', nativeObject: 'ruleSearch', nativeKey: 'intro', nativeImplicitText: true, rehydrate: 'none' },
  { model: 'ruleLastChapter', legadoObject: 'ruleSearch', legadoKey: 'lastChapter', nativeObject: 'ruleSearch', nativeKey: 'lastChapter', nativeImplicitText: true, rehydrate: 'none' },
  { model: 'ruleKind', legadoObject: 'ruleSearch', legadoKey: 'kind', nativeObject: 'ruleSearch', nativeKey: 'kind', nativeImplicitText: true, rehydrate: 'missing' },
  { model: 'ruleWordCount', legadoObject: 'ruleSearch', legadoKey: 'wordCount', nativeObject: 'ruleSearch', nativeKey: 'wordCount', nativeImplicitText: true, rehydrate: 'missing' },
  // 探针关键词：legado 的 `checkKeyWord` 是词不是规则（不补 Native 隐式终端，Native 也没有这个键）
  { model: 'probeKeyword', legadoObject: 'ruleSearch', legadoKey: 'checkKeyWord', rehydrate: 'none' },

  // ── 详情面（ruleBookInfo 容器；平铺方言的详情字段由展平写入同名键）─────────
  { model: 'ruleDetailInit', legadoObject: 'ruleBookInfo', legadoKey: 'init', nativeObject: 'ruleBookInfo', nativeKey: 'init', rehydrate: 'always' },
  { model: 'ruleDetailName', legadoObject: 'ruleBookInfo', legadoKey: 'name', nativeObject: 'ruleBookInfo', nativeKey: 'name', nativeImplicitText: true, pairWith: 'ruleBookName', rehydrate: 'none' },
  { model: 'ruleDetailAuthor', legadoObject: 'ruleBookInfo', legadoKey: 'author', nativeObject: 'ruleBookInfo', nativeKey: 'author', nativeImplicitText: true, pairWith: 'ruleAuthor', rehydrate: 'none' },
  { model: 'ruleDetailCoverUrl', legadoObject: 'ruleBookInfo', legadoKey: 'coverUrl', nativeObject: 'ruleBookInfo', nativeKey: 'coverUrl', pairWith: 'ruleCoverUrl', rehydrate: 'none' },
  { model: 'ruleDetailIntro', legadoObject: 'ruleBookInfo', legadoKey: 'intro', nativeObject: 'ruleBookInfo', nativeKey: 'intro', nativeImplicitText: true, pairWith: 'ruleIntro', rehydrate: 'none' },
  { model: 'ruleDetailLastChapter', legadoObject: 'ruleBookInfo', legadoKey: 'lastChapter', nativeObject: 'ruleBookInfo', nativeKey: 'lastChapter', nativeImplicitText: true, pairWith: 'ruleLastChapter', rehydrate: 'none' },
  { model: 'ruleTocUrl', legadoObject: 'ruleBookInfo', legadoKey: 'tocUrl', nativeObject: 'ruleBookInfo', nativeKey: 'tocUrl', rehydrate: 'none' },
  { model: 'ruleDetailKind', legadoObject: 'ruleBookInfo', legadoKey: 'kind', nativeObject: 'ruleBookInfo', nativeKey: 'kind', nativeImplicitText: true, pairWith: 'ruleKind', rehydrate: 'missing' },
  { model: 'ruleDetailWordCount', legadoObject: 'ruleBookInfo', legadoKey: 'wordCount', nativeObject: 'ruleBookInfo', nativeKey: 'wordCount', nativeImplicitText: true, pairWith: 'ruleWordCount', rehydrate: 'missing' },

  // ── 目录面（ruleToc 容器；章节 flag 是特殊字段，见 RULE_FIELDS 的过滤）───
  { model: 'ruleChapterList', legadoObject: 'ruleToc', legadoKey: 'chapterList', nativeObject: 'ruleToc', nativeKey: 'list', rehydrate: 'none' },
  { model: 'ruleChapterName', legadoObject: 'ruleToc', legadoKey: 'chapterName', nativeObject: 'ruleToc', nativeKey: 'name', nativeImplicitText: true, rehydrate: 'none' },
  { model: 'ruleChapterUrl', legadoObject: 'ruleToc', legadoKey: 'chapterUrl', nativeObject: 'ruleToc', nativeKey: 'url', rehydrate: 'none' },
  { model: 'ruleChapterIsVip', legadoObject: 'ruleToc', legadoKey: 'isVip', rehydrate: 'none' },
  { model: 'ruleChapterIsVolume', legadoObject: 'ruleToc', legadoKey: 'isVolume', rehydrate: 'none' },
  { model: 'ruleChapterIsPay', legadoObject: 'ruleToc', legadoKey: 'isPay', rehydrate: 'none' },
  { model: 'ruleChapterUpdateTime', legadoObject: 'ruleToc', legadoKey: 'updateTime', rehydrate: 'none' },
  { model: 'nextTocUrl', legadoObject: 'ruleToc', legadoKey: 'nextTocUrl', nativeObject: 'ruleToc', nativeKey: 'nextPage', rehydrate: 'none' },

  // ── 正文面（ruleContent 容器）──────────────────────────────────────
  // ruleContent 的 Native 落位是显式分支（content + replaceRules[] 拼净化尾 + nextPage 改名），
  // 故本行只登记 legado 路径与隐式终端标记：塞进 Native 映射会让 nextPage/image 被重复点名。
  { model: 'ruleContent', legadoObject: 'ruleContent', legadoKey: 'content', nativeImplicitText: true, rehydrate: 'none' },
  // Native 的 `ruleContent.nextPage` 同住那条显式分支（与 replaceRules 在同一个容器里处理）
  { model: 'nextPageUrl', legadoObject: 'ruleContent', legadoKey: 'nextContentUrl', rehydrate: 'none' },
  { model: 'ruleContentSubContent', legadoObject: 'ruleContent', legadoKey: 'subContent', rehydrate: 'none' },

  // ── 发现面（legado ruleExplore / Native ruleFind 同落这批模型键）─────────
  // 这一族的来源不是两方言的通用容器映射（判据只看整套的 list 是否非空），故没有方言路径列；
  // 配对目标给出「回落时读哪个通用搜索面键」与「方言子字段叫什么」，整套切换的落位仍住 normalize
  // 的显式分支。`ruleExploreUrl` 是模板不是条目字段，故不配对。
  { model: 'ruleExploreUrl', rehydrate: 'vacant' },
  { model: 'ruleExploreList', pairWith: 'ruleBookList', wholeSetGate: true, rehydrate: 'vacant' },
  { model: 'ruleExploreName', pairWith: 'ruleBookName', nativeImplicitText: true, rehydrate: 'vacant' },
  { model: 'ruleExploreAuthor', pairWith: 'ruleAuthor', nativeImplicitText: true, rehydrate: 'vacant' },
  { model: 'ruleExploreBookUrl', pairWith: 'ruleBookUrl', rehydrate: 'vacant' },
  { model: 'ruleExploreCoverUrl', pairWith: 'ruleCoverUrl', rehydrate: 'vacant' },
  { model: 'ruleExploreIntro', pairWith: 'ruleIntro', nativeImplicitText: true, rehydrate: 'vacant' },
  { model: 'ruleExploreKind', pairWith: 'ruleKind', nativeImplicitText: true, rehydrate: 'vacant' },
  { model: 'ruleExploreLastChapter', pairWith: 'ruleLastChapter', nativeImplicitText: true, rehydrate: 'vacant' },
  { model: 'ruleExploreWordCount', pairWith: 'ruleWordCount', nativeImplicitText: true, rehydrate: 'vacant' },

  // ── 源级字段（不在任何规则容器里）──────────────────────────────────
  { model: 'bookUrlPattern', rehydrate: 'always' },
  { model: 'header', rehydrate: 'conditional', pairWith: 'headerRule' },
  // 动态头与静态头同源（同一 raw 键的两形态），模型键分开落位
  { model: 'headerRule', rehydrate: 'always' },
  { model: 'searchUrl', rehydrate: 'none' },
  { model: 'exploreUrl', rehydrate: 'none' },
  { model: 'loginUrl', rehydrate: 'none' },
  { model: 'jsLib', rehydrate: 'none' },
] as const satisfies readonly RuleFieldSpec[]

/** 不进平铺循环的字段：各有自己的解析/落位分支（见 `normalizeSource`）。
 *  章节 flag 留在显式块里——它们不是取值字段，而是逐章按 `isTrue` 折布尔的规则，落位与那条
 *  下游口径（`online-reading.isTrueRuleValue`）放在一起读。 */
const SPECIAL: ReadonlySet<keyof NormalizedRules> = new Set([
  'searchUrl', 'exploreUrl', 'header', 'headerRule', 'jsLib',
  'ruleChapterIsVip', 'ruleChapterIsVolume', 'ruleChapterIsPay', 'ruleChapterUpdateTime',
])

/** 平铺循环的字段名单：平铺方言的展平视图键与模型键同名，导入时逐键读 `str`，缺省落 null。 */
export const RULE_FIELDS: readonly (keyof NormalizedRules)[] = RULE_FIELD_SPECS
  .filter((s) => !SPECIAL.has(s.model))
  .map((s) => s.model)

/** 对象方言的「容器 → 子字段 → 模型键」表；同一行既供展平，也供存量重推取容器与子字段名。
 *  两方言映射都由同一张表派生——加字段只写一行，不存在「映射改了、展平没改」的分叉。 */
function groupedBy(
  objectOf: (spec: RuleFieldSpec) => string | undefined,
  keyOf: (spec: RuleFieldSpec) => string | undefined,
): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {}
  for (const spec of RULE_FIELD_SPECS) {
    const object = objectOf(spec)
    const key = keyOf(spec)
    if (object === undefined || key === undefined) continue
    const box = out[object] ?? (out[object] = {})
    box[key] = spec.model
  }
  return out
}

export const DIALECT_MAP: Record<string, Record<string, string>> =
  groupedBy((s) => s.legadoObject, (s) => s.legadoKey)

export const NATIVE_MAP: Record<string, Record<string, string>> =
  groupedBy((s) => s.nativeObject, (s) => s.nativeKey)

/** Native 裸选择器要补隐式 `@text` 的字段：list/URL 位不在列（它们要节点集或属性）。 */
export const NATIVE_TEXT_FIELDS: readonly string[] = RULE_FIELD_SPECS
  .filter((s) => 'nativeImplicitText' in s && s.nativeImplicitText)
  .map((s) => s.model)

/** 某覆盖模式下的模型键。存量收敛的读口用它在**编译期**声明自己收哪一档：非本档的键写不进那个
 *  读口，本档某行被删或改档也会让老读口当场红。`always` / `conditional` 的读口是
 *  `Record<本类型, …>`——表加一行而读口没补，`tsc` 当场红；`vacant` / `missing` 由通用派生读口
 *  自动接住，`none` 不需要读口。 */
export type RuleFieldsOf<M extends RehydrateMode> =
  Extract<(typeof RULE_FIELD_SPECS)[number], { rehydrate: M }>['model']

/** `vacant` 档的模型键清单：窄化用表的行类型（`rehydrate` 是字面量，改档即换列），所以这里既没有
 *  第二份名单、也没有 `as`。消费侧拿到的就是本档的键集，不是整张 `NormalizedRules`。 */
type VacantFieldSpec = Extract<(typeof RULE_FIELD_SPECS)[number], { rehydrate: 'vacant' }>
export const VACANT_RULE_FIELDS: readonly RuleFieldsOf<'vacant'>[] = RULE_FIELD_SPECS
  .filter((s): s is VacantFieldSpec => s.rehydrate === 'vacant')
  .map((s) => s.model)

// ── 派生读口：全部由上面这批行与三列推出，不另立名单 ──────────────────────

/** 按模型键取表行：配对目标必须查得到，查不到即表坏了——模块加载期就炸，不留到某次发现面
 *  请求才表现为「字段死活是 null」。 */
function specOf(model: keyof NormalizedRules): RuleFieldSpec {
  const found = RULE_FIELD_SPECS.find((s) => s.model === model)
  if (found === undefined) {
    throw new Error(`规则字段表缺 ${model} 这一行：配对目标必须落在表内`)
  }
  return found
}

/** 同一事实的另一键（只收登记在派生侧的行）。目标行自身不带本列，配对因此不成链。 */
const pairOf: Partial<Record<keyof NormalizedRules, keyof NormalizedRules>> = {}
for (const spec of RULE_FIELD_SPECS) {
  if ('pairWith' in spec) pairOf[spec.model] = spec.pairWith
}
export const PAIR_OF: Readonly<Partial<Record<keyof NormalizedRules, keyof NormalizedRules>>> = pairOf

type GateSpec = Extract<(typeof RULE_FIELD_SPECS)[number], { wholeSetGate: true }>
/** 整套闸的行：恰好一行。两行闸就是两套启用判据各自为政，宁可当场炸也不让它们悄悄并存。 */
function gateSpec(): GateSpec {
  const gates = RULE_FIELD_SPECS.filter((s): s is GateSpec => 'wholeSetGate' in s)
  const only = gates[0]
  if (only === undefined || gates.length !== 1) {
    throw new Error(`规则字段表的 wholeSetGate 必须恰好一行（现在 ${gates.length} 行）`)
  }
  return only
}
const GATE: GateSpec = gateSpec()
/** 发现面整套启用的判据所在字段（闸行的模型键）。 */
export const WHOLE_SET_FIELD: keyof NormalizedRules = GATE.model

/** 取某一行的方言子字段名：发现面的方言子字段名一律经配对目标的方言列反推（表不为发现面行
 *  登记方言路径）。缺列即表坏了——加载期炸。 */
function dialectSubOf(spec: RuleFieldSpec, dialect: 'legado' | 'native'): string {
  const key = dialect === 'legado' ? spec.legadoKey : spec.nativeKey
  if (key === undefined) {
    throw new Error(`规则字段表里 ${spec.model} 没有 ${dialect} 子字段：反推不出发现面方言名`)
  }
  return key
}

/** 闸行配对目标的方言子字段名（legado `bookList` / Native `list`）：两方言的展平与
 *  `nativeExploreFields` 都读它，不再各写一个字面量。 */
const gateTarget = specOf(GATE.pairWith)
export const EXPLORE_GATE_SUBS: { legado: string; native: string } = {
  legado: dialectSubOf(gateTarget, 'legado'),
  native: dialectSubOf(gateTarget, 'native'),
}

/** 发现面条目行 → 它的配对目标（`ruleExploreUrl` 是模板，没有配对，天然不在列）。 */
const EXPLORE_PAIRS: ReadonlyArray<{ model: keyof NormalizedRules; target: RuleFieldSpec }> =
  RULE_FIELD_SPECS.flatMap((s) => (
    s.rehydrate === 'vacant' && 'pairWith' in s ? [{ model: s.model, target: specOf(s.pairWith) }] : []
  ))

function subMapOf(dialect: 'legado' | 'native'): Record<string, keyof NormalizedRules> {
  const out: Record<string, keyof NormalizedRules> = {}
  for (const { model, target } of EXPLORE_PAIRS) {
    const key = dialectSubOf(target, dialect)
    // 子字段名撞车时后写覆盖前写：两行发现面字段会悄悄挤进同一个方言键，读起来却像表是对的
    if (out[key] !== undefined) {
      throw new Error(
        `规则字段表里发现面 ${dialect} 子字段 ${key} 被两行登记（${out[key]} 与 ${model}）`,
      )
    }
    out[key] = model
  }
  return out
}

/** 发现面两方言的子字段名 → 模型键（九项，含闸行）：两方言的展平各循环自己那份，
 *  子字段名不再各抄一份。键顺序即表的行序。 */
export const EXPLORE_LEGADO_SUBS: Readonly<Record<string, keyof NormalizedRules>> = subMapOf('legado')
export const EXPLORE_NATIVE_SUBS: Readonly<Record<string, keyof NormalizedRules>> = subMapOf('native')

/** 发现面回落分支读的九个通用书目字段：配对目标的反向索引，按表行序——次序就是
 *  `exploreEpoch` 的入键次序，换个顺序等于换指纹。 */
const EXPLORE_TARGETS: ReadonlySet<keyof NormalizedRules> = new Set(EXPLORE_PAIRS.map((p) => p.target.model))
export const EXPLORE_FALLBACK_FIELDS: readonly (keyof NormalizedRules)[] = RULE_FIELD_SPECS
  .filter((s) => EXPLORE_TARGETS.has(s.model))
  .map((s) => s.model)

// ── 条目装配的字段位（G1 深门）：通用搜索面那八行按既有列窄出，不新增名单 ──────────

type SearchRow = Extract<(typeof RULE_FIELD_SPECS)[number], { legadoObject: 'ruleSearch' }>

/** 逐条目装配的八个字段位：`ruleSearch` 容器里除列表（`ruleBookList`）与探针词
 *  （`probeKeyword`）之外的模型键。槽名即模型键——发现面的字段位经 `pairWith` 反推到同一批。
 *  导出只为钉子：生产的整套映射走 `EXPLORE_OF_GENERIC`（同由本清单派生）。 */
export type HitFieldModel = Exclude<SearchRow['model'], 'ruleBookList' | 'probeKeyword'>

export const HIT_FIELD_MODELS: readonly HitFieldModel[] = RULE_FIELD_SPECS
  .filter((s): s is SearchRow => 'legadoObject' in s && s.legadoObject === 'ruleSearch')
  .filter((s): s is SearchRow & { model: HitFieldModel } =>
    s.model !== 'ruleBookList' && s.model !== 'probeKeyword')
  .map((s) => s.model)

/** 通用搜索键 → 发现面键：发现面行的 `pairWith` 反向索引，键集恰为八个字段位 + `ruleBookList`。
 *  `hitRuleOf` 的整套切换只查这一处，不逐字段回落（`ADR-0027`）。九项一一对应，
 *  缺一项或撞一项都在模块加载期炸——不留到某次分类页请求才表现为「这一格死活是 null」。 */
const GENERIC_HIT: ReadonlyArray<HitFieldModel | 'ruleBookList'> = [...HIT_FIELD_MODELS, 'ruleBookList']
const exploreOfGeneric: Partial<Record<HitFieldModel | 'ruleBookList', keyof NormalizedRules>> = {}
for (const { model, target } of EXPLORE_PAIRS) {
  const key = GENERIC_HIT.find((k) => k === target.model)
  if (key === undefined) {
    throw new Error(
      `规则字段表里发现面字段 ${model} 的配对目标 ${target.model} 不在条目装配的字段位里`,
    )
  }
  if (exploreOfGeneric[key] !== undefined) {
    throw new Error(`规则字段表里 ${key} 被两行发现面字段配对（${exploreOfGeneric[key]} 与 ${model}）`)
  }
  exploreOfGeneric[key] = model
}
for (const key of GENERIC_HIT) {
  if (exploreOfGeneric[key] === undefined) {
    throw new Error(`规则字段表缺 ${key} 的发现面配对：整套启用时这一格会读空`)
  }
}
export const EXPLORE_OF_GENERIC: Readonly<Partial<Record<HitFieldModel | 'ruleBookList', keyof NormalizedRules>>> =
  exploreOfGeneric

/** 整套启用的唯一判据：非空串。空串与缺席同档（导入侧的字符串归一本就把空串折成 null）——
 *  两方言展平、`nativeExploreFields` 与发现面的整套切换共读这一把尺。 */
export function wholeSetEnabled(v: unknown): boolean {
  return typeof v === 'string' && v.length > 0
}
