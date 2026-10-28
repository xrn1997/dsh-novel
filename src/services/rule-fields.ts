import type { NormalizedRules } from './types.js'

/**
 * 规则字段集：一个模型键一行；通用容器字段写明它在两方言里的路径，外加 Native 隐式终端标记与
 * 存量收敛的覆盖模式。导入循环、两方言通用展平、隐式终端清单与存量收敛的档位都从这张表派生——
 * 字段的事实只写一次（裁决与被否方案见 `ADR-0044`）。
 * 为什么必须守住这一处：这类字段一旦散在几份名单里，漏掉任一处都只表现为「某个字段死活是 null」，
 * 从哪条日志里都查不到原因。发现面条目字段是边界——`ruleExplore` 与 Native `ruleFind` 的整套
 * 启用/展平判据仍住 normalize 的显式分支，表只为它们登记模型键、隐式终端与覆盖模式，
 * 不登记方言路径。
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
  { model: 'ruleDetailName', legadoObject: 'ruleBookInfo', legadoKey: 'name', nativeObject: 'ruleBookInfo', nativeKey: 'name', nativeImplicitText: true, rehydrate: 'none' },
  { model: 'ruleDetailAuthor', legadoObject: 'ruleBookInfo', legadoKey: 'author', nativeObject: 'ruleBookInfo', nativeKey: 'author', nativeImplicitText: true, rehydrate: 'none' },
  { model: 'ruleDetailCoverUrl', legadoObject: 'ruleBookInfo', legadoKey: 'coverUrl', nativeObject: 'ruleBookInfo', nativeKey: 'coverUrl', rehydrate: 'none' },
  { model: 'ruleDetailIntro', legadoObject: 'ruleBookInfo', legadoKey: 'intro', nativeObject: 'ruleBookInfo', nativeKey: 'intro', nativeImplicitText: true, rehydrate: 'none' },
  { model: 'ruleDetailLastChapter', legadoObject: 'ruleBookInfo', legadoKey: 'lastChapter', nativeObject: 'ruleBookInfo', nativeKey: 'lastChapter', nativeImplicitText: true, rehydrate: 'none' },
  { model: 'ruleTocUrl', legadoObject: 'ruleBookInfo', legadoKey: 'tocUrl', nativeObject: 'ruleBookInfo', nativeKey: 'tocUrl', rehydrate: 'none' },
  { model: 'ruleDetailKind', legadoObject: 'ruleBookInfo', legadoKey: 'kind', nativeObject: 'ruleBookInfo', nativeKey: 'kind', nativeImplicitText: true, rehydrate: 'missing' },
  { model: 'ruleDetailWordCount', legadoObject: 'ruleBookInfo', legadoKey: 'wordCount', nativeObject: 'ruleBookInfo', nativeKey: 'wordCount', nativeImplicitText: true, rehydrate: 'missing' },

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
  // 落位与整套切换判据住 normalize 的显式分支。
  { model: 'ruleExploreUrl', rehydrate: 'vacant' },
  { model: 'ruleExploreList', rehydrate: 'vacant' },
  { model: 'ruleExploreName', nativeImplicitText: true, rehydrate: 'vacant' },
  { model: 'ruleExploreAuthor', nativeImplicitText: true, rehydrate: 'vacant' },
  { model: 'ruleExploreBookUrl', rehydrate: 'vacant' },
  { model: 'ruleExploreCoverUrl', rehydrate: 'vacant' },
  { model: 'ruleExploreIntro', nativeImplicitText: true, rehydrate: 'vacant' },
  { model: 'ruleExploreKind', nativeImplicitText: true, rehydrate: 'vacant' },
  { model: 'ruleExploreLastChapter', nativeImplicitText: true, rehydrate: 'vacant' },
  { model: 'ruleExploreWordCount', nativeImplicitText: true, rehydrate: 'vacant' },

  // ── 源级字段（不在任何规则容器里）──────────────────────────────────
  { model: 'bookUrlPattern', rehydrate: 'always' },
  { model: 'header', rehydrate: 'conditional' },
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
