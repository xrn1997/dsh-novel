import render from 'dom-serializer'
import { isPutOnlyRule, RuleEvalError } from '../engine/index.js'
import type { EngineValue, Facet, RuleUsage } from '../engine/index.js'
import { absUrl, absUrlKeepOption, stripUrlOption } from './url.js'
import { formatIntro } from './content.js'
import { EXPLORE_OF_GENERIC, PAIR_OF, WHOLE_SET_FIELD, wholeSetEnabled } from './rule-fields.js'
import type { HitFieldModel } from './rule-fields.js'
import type { SearchHit } from '../shared/wire.js'
import type { NormalizedRules, NovelSource } from './types.js'

/** 页面快照（URL + 解码后正文 + 可选 JSON）。`url` 是**实际落地**地址（相对链接按它解析）；`requestedUrl` 只作诊断（两者不同＝被跳转走了）。 */
export interface Page { url: string; requestedUrl?: string; body: string; json?: unknown }

/** 条目片段上的子规则求值器：与引擎内部 evaluateRef 同构。usage（取值用途）两种语义的判据归 `engine/types.ts` 的 `RuleUsage`——'value' 把链尾未知词读属性名、'list' 读成选择器。 */
export interface SubRuleEval {
  (rule: string, ctx: ItemContextPartial, facet: Facet, usage?: RuleUsage): Promise<EngineValue>
}

/** 条目求值上下文。`regexRow` 只在 AllInOne 条目上出现，字段规则文本里的 `$n` 按它绑定（`engine/regex-row.ts`），其余形态没有行。 */
export interface ItemContext { html: string; baseUrl: string; regexRow?: string[] }

/** SubRuleEval 的入参形态：html/json 都可缺（详情 init 换根给 json、目录条目给 html） */
interface ItemContextPartial { html?: string; json?: unknown; baseUrl: string; regexRow?: string[] }

/** matches 行 → **条目组**。行是 `[group 0(整段), 组 1..n]`（`engine/allinone.ts`），条目取组 1..n；无捕获组时整段即条目。group 0 只供字段规则的 `$n` 绑定，**不**参与条目取值。 */
function rowParts(r: readonly string[]): readonly string[] {
  return r.length > 1 ? r.slice(1) : r
}

/** 值规约（链终点取值）：miss→null；value→text；list→join('\n')；matches→取每行首列 join。 */
export function firstValue(v: EngineValue, facet: Facet = 'rule'): string | null {
  switch (v.kind) {
    case 'miss': return null
    case 'value': return v.text
    case 'list': return v.items.join('\n')
    case 'matches': return v.rows.map((r) => rowParts(r)[0] ?? '').join('\n')
    case 'nodes': throw nodesError(v, facet)
  }
}

/** **URL 位**的值规约：与 `firstValue` 只差一处——`list` 取**首项**而不是 `join('\n')`。URL 位一律取 `list[0]`，
 *  多值 join 只服务非 URL 取值（矩阵行 `b-url-value-first-item`）：一个条目里多个 `<a>` 会拼成多行串，被 `absUrl`
 *  换行守卫判死 → **整条书目丢地址**（表现不是报错而是「搜到了打不开」）。URL 里不可能有换行。
 */
export function firstUrlValue(v: EngineValue, facet: Facet = 'rule'): string | null {
  if (v.kind === 'list') return v.items[0] ?? ''
  return firstValue(v, facet)
}

/** 多值规约：miss→null；value→[text]；list→items；matches→每行首列。 */
export function listValue(v: EngineValue, facet: Facet = 'rule'): string[] | null {
  switch (v.kind) {
    case 'miss': return null
    case 'value': return [v.text]
    case 'list': return v.items
    case 'matches': return v.rows.map((r) => rowParts(r)[0] ?? '')
    case 'nodes': throw nodesError(v, facet)
  }
}

/** 列表页条目提取：nodes→逐节点 HTML 片段；list→逐项；matches→行 join('\t')；miss→[]（零结果合法）。 */
export function extractItems(v: EngineValue): string[] {
  switch (v.kind) {
    case 'miss': return []
    case 'value': return [v.text]
    case 'list': return [...v.items]
    case 'matches': return v.rows.map((r) => rowParts(r).join('\t'))
    // encodeEntities:'utf8'：默认选项把 CJK 全部编码成 &#x…; 数字实体；'utf8' 只转义 &<> 保留可读原文
    case 'nodes': return v.nodes.toArray().map((n) => render(n, { encodeEntities: 'utf8' }))
  }
}

/** 逐条目求值上下文（列表页 / 目录页共用）：html 取自 `extractItems`（同源同序是**构造**保证），AllInOne 条目额外带行。 */
export function itemContextsOf(v: EngineValue, baseUrl: string): ItemContext[] {
  return extractItems(v).map((html, i) => ({
    html,
    baseUrl,
    ...(v.kind === 'matches' ? { regexRow: v.rows[i] } : {}),
  }))
}

/** 「列表规则 → 条目上下文」的唯一读口：**求值用途定档与条目派生合在门内**，调用方不再出现链尾值。
 *
 *  这不是转发壳（`ADR-0036` deletion test）：删掉它，每个调用方都得记得把用途传成 `'list'` 再自己派生条目——
 *  用途传错不炸，只是把选择器当属性名读出一条安静的空结果。`itemContextsOf` 仍是公开读口（online-reading 走它）。
 */
export async function listContextsOf(
  subEval: SubRuleEval, rule: string, page: { html: string; baseUrl: string }, facet: Facet,
): Promise<ItemContext[]> {
  return itemContextsOf(await subEval(rule, page, facet, 'list'), page.baseUrl)
}

/** 链终点不该剩节点集：带 facet 与节点数的段级错误（segmentIndex -1 = 服务层规约层） */
function nodesError(v: Extract<EngineValue, { kind: 'nodes' }>, facet: Facet): RuleEvalError {
  return new RuleEvalError('结果不是取值而是节点集', {
    facet,
    segmentIndex: -1,
    segmentRaw: '(服务层规约)',
    hits: v.nodes.length,
  })
}

/** 字段子规则求值 + 规约：rule null → null（源没这条信息）。usage 缺省 'value'——字段规则都是取值用途 */
export async function fieldOf(
  subEval: SubRuleEval, rule: string | null, ctx: ItemContext, facet: Facet,
): Promise<string | null> {
  if (rule === null) return null
  return firstValue(await subEval(rule, ctx, facet, 'value'), facet)
}

/** 辅助元数据字段的口径：**读不出来 = 留空，书目照收**。走这条的是 kind/wordCount/lastChapter/intro/coverUrl；**裸奔的是 name/author/bookUrl/tocUrl**（空即丢条目、炸即整次失败）。 */
async function metaFieldOf<T>(
  subEval: SubRuleEval, rule: string | null, ctx: ItemContext, facet: Facet,
  read: (v: EngineValue) => T | null,
): Promise<T | null> {
  if (rule === null) return null
  try {
    return read(await subEval(rule, ctx, facet, 'value'))
  } catch {
    return null
  }
}

/** 辅助字段里的「文本」两件（最新章节 / 简介）：规约同 `fieldOf`，读取抛错时留空；封面这类 **URL 位**走 `auxUrlFieldOf`。 */
export function auxFieldOf(
  subEval: SubRuleEval, rule: string | null, ctx: ItemContext, facet: Facet,
): Promise<string | null> {
  return metaFieldOf(subEval, rule, ctx, facet, (v) => firstValue(v, facet))
}

/** **URL 字段**的取值：规约走 `firstUrlValue`（list 取首项）——这些位的产物马上进 `absUrl*`，多行串必被换行守卫判死。 */
export async function urlFieldOf(
  subEval: SubRuleEval, rule: string | null, ctx: ItemContext, facet: Facet,
): Promise<string | null> {
  if (rule === null) return null
  return firstUrlValue(await subEval(rule, ctx, facet, 'value'), facet)
}

/** URL 位的辅助字段（封面）：`urlFieldOf` 的规约 + `metaFieldOf` 的「读不出来留空」。 */
export function auxUrlFieldOf(
  subEval: SubRuleEval, rule: string | null, ctx: ItemContext, facet: Facet,
): Promise<string | null> {
  return metaFieldOf(subEval, rule, ctx, facet, (v) => firstUrlValue(v, facet))
}

/** 分类（多值 join(',') 后截前 1000 个 UTF-16 code unit）：**多命中是逗号串，不是首值**——取首值只剩「玄幻」，与 `class.tags a@text` 这类规则写法不符。 */
export function kindFieldOf(
  subEval: SubRuleEval, rule: string | null, ctx: ItemContext, facet: Facet,
): Promise<string | null> {
  return metaFieldOf(subEval, rule, ctx, facet, (v) => {
    const items = listValue(v, facet)
    return items === null ? null : items.join(',').slice(0, 1000)
  })
}

/** 字数格式化（在**解析层**调用，存进 book 的已是格式化后的串）：整串 `-?[0-9]+` 才转换；>10000 → 除一万保留一位 +「万字」，≤10000 → 原数 +「字」，≤0 → 空；认不出数字原样给回。`Math.fround` 复现 `words * 1.0f`。 */
export function formatWordCount(wc: string | null): string | null {
  if (wc === null) return null
  if (!/^-?[0-9]+$/.test(wc)) return wc
  const words = Number.parseInt(wc, 10)
  if (!(words > 0)) return ''
  if (words <= 10000) return `${words}字`
  return `${formatHalfEven(Math.fround(words) / 10000)}万字`
}

/** Java `DecimalFormat("#.#")`：最多一位小数、整数不留 `.0`、去尾零，舍入 HALF_EVEN（`1.25`→`1.2`、`1.35`→`1.4`）。 */
function formatHalfEven(value: number): string {
  const scaled = value * 10
  // 浮点噪声先归到 1e-9，再对 .5 走偶数舍入
  const nearest = Math.round(scaled * 1e9) / 1e9
  const rounded = Math.abs(nearest % 1) === 0.5
    ? (Math.trunc(nearest) % 2 === 0 ? Math.trunc(nearest) : Math.trunc(nearest) + (nearest > 0 ? 1 : -1))
    : Math.round(nearest)
  const text = (rounded / 10).toString()
  return text.endsWith('.0') ? text.slice(0, -2) : text
}

/** 字数（先按取值口径读出串，再交给 `formatWordCount`；读取抛错同样留空）。 */
export async function wordCountFieldOf(
  subEval: SubRuleEval, rule: string | null, ctx: ItemContext, facet: Facet,
): Promise<string | null> {
  return metaFieldOf(subEval, rule, ctx, facet, (v) => formatWordCount(firstValue(v, facet)))
}

/** 详情上下文解析（`ruleBookInfo.init` 口径：init 先求值，其结果**整体替换**后续详情规则的上下文**与 html**）：
 *  JSON 产物 → html 与 ctx.json **同步换根**（只换 json 会让 `{{result.…}}` Miss → tocUrl 回退详情页 → 目录空）；
 *  非 JSON 文本 → 作为 html 上下文。init 非空但零命中 → 默认点名 ruleDetailInit，不拿整页冒充上下文。
 *  `onEmptyInit: 'no-context'` 给嗅探路径用（见 detailFieldsOf）：init 取空即内容置空，后续字段全空 → 没有书目。
 */
export async function detailContextOf(
  ruleDetailInit: string | null | undefined, html: string, baseUrl: string, subEval: SubRuleEval,
  opts: { onEmptyInit: 'no-context' },
): Promise<{ html: string; json?: unknown } | null>
export async function detailContextOf(
  ruleDetailInit: string | null | undefined, html: string, baseUrl: string, subEval: SubRuleEval,
  opts?: { onEmptyInit?: 'error' },
): Promise<{ html: string; json?: unknown }>
export async function detailContextOf(
  ruleDetailInit: string | null | undefined, html: string, baseUrl: string, subEval: SubRuleEval,
  opts?: { onEmptyInit?: 'error' | 'no-context' },
): Promise<{ html: string; json?: unknown } | null> {
  // 存量 sources.json 可能缺 ruleDetailInit 键——缺席与 null 同路，按缺规则直通
  if (ruleDetailInit == null || ruleDetailInit.trim() === '') return { html }
  // 纯 `@put` 的 init（现量见矩阵 `c-rule-book-info-init`）：**只设变量、不换根**——打成「零命中」等于把合法规则判成失效。
  if (isPutOnlyRule(ruleDetailInit)) {
    await subEval(ruleDetailInit, { html, baseUrl }, 'detail', 'list')
    return { html }
  }
  const v = await subEval(ruleDetailInit, { html, baseUrl }, 'detail', 'list')
  const parts = extractItems(v)
  if (parts.length === 0) {
    if (opts?.onEmptyInit === 'no-context') return null
    throw new RuleEvalError(`详情初始化规则未取到上下文（段 ruleDetailInit: ${ruleDetailInit}）`, {
      facet: 'detail', segmentIndex: 0, segmentRaw: ruleDetailInit, hits: 0,
    })
  }
  const text = parts.join('\n')
  // JSON 产物：html 同步换成产物文本（内容全换口径——result/pageText 与 json 同源）
  try { return { html: text, json: JSON.parse(text) as unknown } } catch { return { html: text } }
}

/** 详情页七字段的取值面：`detailFieldsOf` 的返回形状；`detailReadOf` 返回 `DetailRead`、把它放在 `.fields`。 */
export interface DetailFields {
  title: string | null; author: string | null; coverUrl: string | null
  intro: string | null; lastChapterName: string | null
  kind: string | null; wordCount: string | null
}

/** 详情页**一次**读取的结果（`detailReadOf` 的返回形状）：字段与 tocUrl 出自同一份 init 上下文。 */
export interface DetailRead { fields: DetailFields; tocUrl: string }

/** 详情行的回落读法：本行缺席才读它的配对键（`PAIR_OF` 那一列，七行不再各写 `ruleDetailX ?? ruleX`）。配对目标都是文本字段；表若被改成指向数组/头表，按「没有这条信息」读。 */
function pairedRuleOf(rules: NormalizedRules, model: keyof NormalizedRules): string | null {
  const own = rules[model]
  if (typeof own === 'string') return own
  const pair = PAIR_OF[model]
  const fallback = pair === undefined ? null : rules[pair]
  return typeof fallback === 'string' ? fallback : null
}

/** init 换根之后的七字段取值段（`detailFieldsOf` / `detailReadOf` 共用）：`ruleDetail*` 优先、平铺方言回退同名共用字段；封面按 base 绝对化、简介按详情面口径净化。 */
async function detailFieldsFromContext(
  s: NovelSource, subEval: SubRuleEval, dctx: { html: string; json?: unknown }, baseUrl: string,
): Promise<DetailFields> {
  const { rules } = s
  const ctx = { html: dctx.html, json: dctx.json, baseUrl }
  const [title, author, cover, intro, last, kind, wordCount] = await Promise.all([
    fieldOf(subEval, pairedRuleOf(rules, 'ruleDetailName'), ctx, 'detail'),
    fieldOf(subEval, pairedRuleOf(rules, 'ruleDetailAuthor'), ctx, 'detail'),
    auxUrlFieldOf(subEval, pairedRuleOf(rules, 'ruleDetailCoverUrl'), ctx, 'detail'),
    auxFieldOf(subEval, pairedRuleOf(rules, 'ruleDetailIntro'), ctx, 'detail'),
    auxFieldOf(subEval, pairedRuleOf(rules, 'ruleDetailLastChapter'), ctx, 'detail'),
    kindFieldOf(subEval, pairedRuleOf(rules, 'ruleDetailKind'), ctx, 'detail'),
    wordCountFieldOf(subEval, pairedRuleOf(rules, 'ruleDetailWordCount'), ctx, 'detail'),
  ])
  return {
    title, author,
    coverUrl: cover === null ? null : absUrl(cover, baseUrl),
    intro: intro === null ? null : formatIntro(intro, { keepDirective: true }),
    lastChapterName: last,
    kind, wordCount,
  }
}

/** 详情页七字段的读取（**只要字段**的两个消费点）：搜索面的 info 形态与探针。`getDetail` 不走它——那条路要
 *  字段 + tocUrl，由 `detailReadOf` 用**同一次** init 求值一并交出，否则一次详情读会把 init 求两遍。
 *  `onEmptyInit: 'no-book'` 为搜索面准备：那里的「这是详情页」只是嗅探猜测，抛错会把「没搜到」升级成整源失败。
 */
export async function detailFieldsOf(
  s: NovelSource, subEval: SubRuleEval, html: string, baseUrl: string,
  opts: { onEmptyInit: 'no-book' },
): Promise<DetailFields | null>
export async function detailFieldsOf(
  s: NovelSource, subEval: SubRuleEval, html: string, baseUrl: string,
  opts?: { onEmptyInit?: 'error' },
): Promise<DetailFields>
export async function detailFieldsOf(
  s: NovelSource, subEval: SubRuleEval, html: string, baseUrl: string,
  opts?: { onEmptyInit?: 'error' | 'no-book' },
): Promise<DetailFields | null> {
  const dctx = opts?.onEmptyInit === 'no-book'
    ? await detailContextOf(s.rules.ruleDetailInit, html, baseUrl, subEval, { onEmptyInit: 'no-context' })
    : await detailContextOf(s.rules.ruleDetailInit, html, baseUrl, subEval)
  if (dctx === null) return null
  return detailFieldsFromContext(s, subEval, dctx, baseUrl)
}

/** tocUrl 的**无需详情上下文**那一半：非 null 规则里的真静态 URL 直接绝对化；返回 null = 要拿到详情上下文后过引擎。
 *  静态 URL 短路的歧义前缀按两档分（矩阵行 `b-toc-url-xpath-vs-url`）：① `//`/`.//` 开头**绝不短路**——absUrl 解得出
 *  分不开它与协议相对地址（裸标签 XPath 会被解成 `https://div/a/@href` 野地址）；② 单 `/` 开头=站点相对 URL，
 *  **解得出才短路**（纯路径 XPath 与它同形不可分，残余记在矩阵行）。URL 读法在能绝对化时优先于 XPath 形态。
 */
export function staticTocUrl(ruleTocUrl: string, bookUrl: string): string | null {
  const urlShaped = /^(https?:)?\/\//i.test(ruleTocUrl) || ruleTocUrl.startsWith('/')
  const absoluteXPath = ruleTocUrl.startsWith('//') || ruleTocUrl.startsWith('.//')
  if (!urlShaped || absoluteXPath || ruleTocUrl.includes('{')) return null
  // 走到这里必无插值段（`{` 判过），interpolateUrl 恒等 → 直接绝对化。
  return absUrl(ruleTocUrl, stripUrlOption(bookUrl))
}

/** tocUrl 的**详情上下文**那一半（`tocUrlOf` 与 `detailReadOf` 共用）：规则按 init 换根后的上下文过引擎，URL 位按
 *  `firstUrlValue` 取首项。绝对化**只作用在 URL 部分**，`,{option}` 原样接回：先 absUrl 等于让 `new URL()` 先碰选项串
 *  （换行被吃、`{` 被编码 → 抓取层切不到选项，整串当路径发出去）。取不到 → 回退 bookUrl 全串（抓取仍按选项发）。
 */
export async function tocUrlFromContext(
  ruleTocUrl: string, dctx: { html: string; json?: unknown }, bookUrl: string, subEval: SubRuleEval,
): Promise<string> {
  // 解析 base 剥 `,{option}`（选项不属于链接解析域）
  const base = stripUrlOption(bookUrl)
  const v = await subEval(ruleTocUrl, { html: dctx.html, json: dctx.json, baseUrl: base }, 'detail', 'value')
  const href = firstUrlValue(v, 'detail')
  if (href === null) return bookUrl
  return absUrlKeepOption(href, base) ?? bookUrl
}

/** 详情面的**一次**完整读取（`getDetail` 的唯一入口）：init 只求值一次，七字段与 tocUrl 共用这一份上下文——拆成两个
 *  动词各求一次 init，js 形态会**双打站点**。info / 探针仍走 `detailFieldsOf`（只要字段，不付 tocUrl 求值）。
 *  init 空命中按默认口径抛；tocUrl 的 null 回退与静态短路同 `tocUrlOf` 的判据。
 */
export async function detailReadOf(
  s: NovelSource, subEval: SubRuleEval, html: string, bookUrl: string,
): Promise<DetailRead> {
  const base = stripUrlOption(bookUrl)
  const dctx = await detailContextOf(s.rules.ruleDetailInit, html, base, subEval)
  const fields = await detailFieldsFromContext(s, subEval, dctx, base)
  const ruleTocUrl = s.rules.ruleTocUrl
  if (ruleTocUrl === null) return { fields, tocUrl: bookUrl }
  const tocUrl = staticTocUrl(ruleTocUrl, bookUrl) ?? await tocUrlFromContext(ruleTocUrl, dctx, bookUrl, subEval)
  return { fields, tocUrl }
}

/** 条目规则的来源档：聚合搜索恒 `'search'`；发现面 `'explore'` 在整套启用（闸行非空）时换到 `pairWith` 派生的发现面键，闸关照读通用搜索键——整档一刀切（`ADR-0027`）。 */
export type HitRuleSource = 'search' | 'explore'

/** 发现面键的取值面：配对目标都是搜索面那批文本字段，`keyof NormalizedRules` 的宽值域收到「规则串或没有」。 */
function textRuleOf(rules: NormalizedRules, model: keyof NormalizedRules): string | null {
  const value = rules[model]
  return typeof value === 'string' ? value : null
}

/** 规则来源档的唯一读口：门内解规则集（含整套闸），调用方只交源与档；缺书名规则不在此折成空结果（由 hitFieldsOf 抛防御错）。 */
export function hitRuleOf(
  source: NovelSource, ruleSource: HitRuleSource, model: HitFieldModel | 'ruleBookList',
): string | null {
  const { rules } = source
  if (ruleSource === 'search' || !wholeSetEnabled(rules[WHOLE_SET_FIELD])) return rules[model]
  const explore = EXPLORE_OF_GENERIC[model]
  if (explore === undefined) {
    // 加载期已检查九项齐全；运行期走到这里只可能是表被改坏，宁可当场炸也不悄悄回读通用键
    throw new Error(`规则字段表缺 ${model} 的发现面配对：整套启用时读不到这一格`)
  }
  return textRuleOf(rules, explore)
}

/** 逐条目取值装配（**一条命中**的唯一主人）：源 + 规则来源档 + 一个条目上下文 + 落地地址 → 一条书目，或 null。
 *
 *  规则集由 `hitRuleOf` 在门内解，字段位是 `rule-fields.ts` 表派生的八个模型键；调用方不再各交规则对象，也不再传
 *  usage / facet——面恒 `'search'`、用途恒 `'value'`。档位分野仍只住 `metaFieldOf` 一处：书名非空才算书目、作者/
 *  书地址裸奔、其余五项坏规则只丢该字段；简介走搜索面口径（不认渲染指令前缀）。
 *  **缺书名规则抛 `RuleEvalError` 而不折成空结果**：调用方都在循环外按 `RuleMissing` 拦过，这里是防御合同。
 *  抛错穿透：裸奔项读不出来会抛，归成哪一类错由调用方决定——装配层不自立第二套吞错口径，也不许把 Miss 折成空串。
 */
export async function hitFieldsOf(
  source: NovelSource, ruleSource: HitRuleSource, subEval: SubRuleEval,
  ctx: ItemContext, landedUrl: string,
): Promise<SearchHit | null> {
  const nameRule = hitRuleOf(source, ruleSource, 'ruleBookName')
  if (nameRule === null) {
    throw new RuleEvalError('缺书名规则：条目装配不收无标题书目', {
      facet: 'search', segmentIndex: 0, segmentRaw: '(缺书名规则)', hits: 0,
    })
  }
  const title = firstValue(await subEval(nameRule, ctx, 'search', 'value'), 'search')
  if (title === null || title.trim() === '') return null
  const [author, href, cover, intro, last, kind, wordCount] = await Promise.all([
    fieldOf(subEval, hitRuleOf(source, ruleSource, 'ruleAuthor'), ctx, 'search'),
    urlFieldOf(subEval, hitRuleOf(source, ruleSource, 'ruleBookUrl'), ctx, 'search'),
    auxUrlFieldOf(subEval, hitRuleOf(source, ruleSource, 'ruleCoverUrl'), ctx, 'search'),
    auxFieldOf(subEval, hitRuleOf(source, ruleSource, 'ruleIntro'), ctx, 'search'),
    auxFieldOf(subEval, hitRuleOf(source, ruleSource, 'ruleLastChapter'), ctx, 'search'),
    kindFieldOf(subEval, hitRuleOf(source, ruleSource, 'ruleKind'), ctx, 'search'),
    wordCountFieldOf(subEval, hitRuleOf(source, ruleSource, 'ruleWordCount'), ctx, 'search'),
  ])
  return {
    title, author,
    // 书地址保留 `,{option}` 后缀落库（URL 即请求规格——POST 型 API 源的 book_id 藏在选项 body 里，剥掉即身份残废）
    url: href === null ? null : absUrlKeepOption(href, landedUrl),
    coverUrl: cover === null ? null : absUrl(cover, landedUrl),
    intro: intro === null ? null : formatIntro(intro),
    lastChapterName: last, kind, wordCount,
  }
}

/** 逐条目装配：列表上下文 → 书目。空标题与坏字段的处置全在 `hitFieldsOf`，这里只收结果；聚合搜索与发现面共用这一份。 */
export async function hitsOfContexts(
  source: NovelSource, ruleSource: HitRuleSource, subEval: SubRuleEval,
  contexts: readonly ItemContext[], landedUrl: string,
): Promise<SearchHit[]> {
  const hits: SearchHit[] = []
  for (const ctx of contexts) {
    const hit = await hitFieldsOf(source, ruleSource, subEval, ctx, landedUrl)
    if (hit !== null) hits.push(hit)
  }
  return hits
}
