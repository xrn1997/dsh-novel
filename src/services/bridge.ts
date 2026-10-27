import render from 'dom-serializer'
import { isPutOnlyRule, RuleEvalError } from '../engine/index.js'
import type { EngineValue, Facet, RuleUsage } from '../engine/index.js'
import { absUrl, absUrlKeepOption, stripUrlOption } from './url.js'
import { formatIntro } from './content.js'
import type { SearchHit } from '../shared/wire.js'
import type { NovelSource } from './types.js'

/** 页面快照（URL + 解码后正文 + 可选解析好的 JSON）——门面层传给字段求值的输入。
 *  `url` 是**实际落地**地址（跟随重定向后，相对链接按其解析——浏览器语义）；
 *  `requestedUrl` 只作诊断（两者不同＝被跳转走了，报错里点名，站点整站 302 一眼可见）。 */
export interface Page { url: string; requestedUrl?: string; body: string; json?: unknown }

/** 条目片段上的子规则求值器：与引擎内部 evaluateRef 同构（片段即 html 上下文）。
 *  usage（取值用途）：'value'（getString 口径——链尾未知词 = HTML 属性名）/ 'list'（getElements
 *  口径——链尾未知词 = 选择器）。服务层按规则用途显式传，缺省沿用引擎的 'list'。 */
export interface SubRuleEval {
  (rule: string, ctx: ItemContextPartial, facet: Facet, usage?: RuleUsage): Promise<EngineValue>
}

/** 条目求值上下文：字段规则在**一个条目**上求值时的输入。
 *  `regexRow` 只在 AllInOne 条目上出现（`itemContextsOf`）——字段规则文本里的 `$n`
 *  按它绑定（`engine/regex-row.ts`），其余条目形态没有行。 */
export interface ItemContext { html: string; baseUrl: string; regexRow?: string[] }

/** SubRuleEval 的入参形态：html/json 都可缺（详情 init 换根给 json、目录条目给 html） */
interface ItemContextPartial { html?: string; json?: unknown; baseUrl: string; regexRow?: string[] }

/** matches 行 → **条目组**。行是 `[group 0(整段), 组 1..n]`（`engine/allinone.ts`），
 *  条目取组 1..n；无捕获组时整段即条目。group 0 只供给字段规则的 `$n` 绑定，
 *  **不**参与条目取值——否则条目上下文会混进整段、字段规则在重复内容上求值。 */
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

/** **URL 位**的值规约：与 `firstValue` 只差一处——`list` 取**首项**而不是 `join('\n')`。
 *
 *  对面「URL 取值」那一支一律取 `list[0]`，多值 join 只服务非 URL 取值（对读证据与实测读数：
 *  矩阵行 `b-url-value-first-item`）。URL 位不要用 join：一个条目里多个 `<a>` 会把地址拼成多行串，
 *  被 `absUrl` 换行守卫判死 → **整条书目丢地址**（表现不是报错而是「搜到了打不开」）。
 *  URL 里不可能有换行——join 在 URL 位上永远是错的，这不是口径分歧。 */
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

/** 逐条目求值上下文（列表页 / 目录页共用）：html 直接取自 `extractItems`（同源同序是**构造**保证：
 *  同一次派生、同一下标），AllInOne 条目额外带行（`$n` 绑定用），其余形态只有 html/baseUrl。 */
export function itemContextsOf(v: EngineValue, baseUrl: string): ItemContext[] {
  return extractItems(v).map((html, i) => ({
    html,
    baseUrl,
    ...(v.kind === 'matches' ? { regexRow: v.rows[i] } : {}),
  }))
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

/** 辅助元数据字段的口径：**读不出来 = 留空，书目照收**。
 *  走这条的恰是这五项：kind / wordCount / lastChapter / intro / coverUrl；**裸奔的是
 *  name / author / bookUrl / tocUrl**（那四个空即丢条目、炸即整次失败）。所以一条坏掉的简介规则
 *  **不会**让整页书目消失。 */
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

/** 辅助字段里的「文本」两件（最新章节 / 简介）：值规约同 `fieldOf`，
 *  差别只在读取抛错时留空而不是带走整组书目（口径见 `metaFieldOf`）；封面这类 **URL 位**走 `auxUrlFieldOf`。 */
export function auxFieldOf(
  subEval: SubRuleEval, rule: string | null, ctx: ItemContext, facet: Facet,
): Promise<string | null> {
  return metaFieldOf(subEval, rule, ctx, facet, (v) => firstValue(v, facet))
}

/** **URL 字段**的取值：与 `fieldOf` 同一处差别——规约走 `firstUrlValue`（list 取首项）。
 *  书地址 / 封面 / 目录页 / 章地址这些位上的产物马上就要进 `absUrl*`，多行串必被它的换行守卫判死。 */
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

/** 分类（多值列表 join(',') 后截前 1000 个 UTF-16 code unit）：
 *  **多命中是逗号串，不是首值**——`class.tags a@text`、`$.categoryNames[*]className` 这类规则
 *  的产物是「玄幻,都市」，取首值只剩「玄幻」，与规则写法不符。截断按 UTF-16 code unit 计，
 *  与 JS `String.prototype.slice` 同单位。 */
export function kindFieldOf(
  subEval: SubRuleEval, rule: string | null, ctx: ItemContext, facet: Facet,
): Promise<string | null> {
  return metaFieldOf(subEval, rule, ctx, facet, (v) => {
    const items = listValue(v, facet)
    return items === null ? null : items.join(',').slice(0, 1000)
  })
}

/** 字数格式化（在**解析层**调用——存进 book 的已经是格式化后的串，不是「只在 UI 格式化」）：
 *  整串是 `-?[0-9]+` 才转换；>10000 → 除一万保留一位 +「万字」，≤10000 → 原数 +「字」，
 *  ≤0 → 空；认不出数字则原样给回（「120万字」「连载中」这些站点文案本来就是字符串）。
 *  `words * 1.0f` 的 Float 中间态用 `Math.fround` 复现（超大字数下两边取整一致）。 */
export function formatWordCount(wc: string | null): string | null {
  if (wc === null) return null
  if (!/^-?[0-9]+$/.test(wc)) return wc
  const words = Number.parseInt(wc, 10)
  if (!(words > 0)) return ''
  if (words <= 10000) return `${words}字`
  return `${formatHalfEven(Math.fround(words) / 10000)}万字`
}

/** Java `DecimalFormat("#.#")`：最多一位小数、整数不留 `.0`、恰好一位时去掉尾零（1.50→"1.5"、
 *  1.0001→"1"），舍入为 HALF_EVEN（`1.25`→`1.2`、`1.35`→`1.4`）。 */
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

/** 详情上下文解析（`ruleBookInfo.init` 口径：init 先求值，其结果**整体替换**后续详情规则的求值上下文
 *  **与 html**——内容单点全换）：
 *  JSON 产物 → html 与 ctx.json **同步换根**（只换 json 会让 `{{result.…}}` 模板插值 Miss
 *  → tocUrl 回退详情页 → 目录空；换根后的 result/content 就是 init 产物本身）；
 *  非 JSON 文本/HTML 片段 → 作为 html 上下文（同前）。
 *  init 非空但零命中 → 默认 RuleEvalError 点名 ruleDetailInit——不拿整页冒充上下文（静默降级会让
 *  详情字段全 Miss 伪装成「源什么都没有」）。
 *  `onEmptyInit: 'no-context'` 给「这页**可能**是详情页」的嗅探路径用（见 detailFieldsOf 同名参数）：
 *  init 取空即内容置空，后续字段自然全空 → 没有书目，而不是整次搜索失败。 */
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
  // 纯 `@put` 的 init（本机详情面的主导写法之一，现量见矩阵 `c-rule-book-info-init`）：
  // **只设变量、不换根**——剥掉 `@put` 后
  // 规则为空，取不到新根；打成「零命中」等于把这条合法规则判成失效（引擎 isPutOnlyRule 给结论）。
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

/** init 换根之后的七字段取值段（`detailFieldsOf` / `detailReadOf` 共用这一份回落链与档位）：
 *  `ruleDetail*` 优先、平铺方言回退同名共用字段（原 v1 行为）；封面按 base 绝对化、
 *  简介按详情面口径净化（`<usehtml>`/`<md>`/`<useweb>` 前缀原样保留，其余 format + 5000 截断）。 */
async function detailFieldsFromContext(
  s: NovelSource, subEval: SubRuleEval, dctx: { html: string; json?: unknown }, baseUrl: string,
): Promise<DetailFields> {
  const { rules } = s
  const ctx = { html: dctx.html, json: dctx.json, baseUrl }
  const [title, author, cover, intro, last, kind, wordCount] = await Promise.all([
    fieldOf(subEval, rules.ruleDetailName ?? rules.ruleBookName, ctx, 'detail'),
    fieldOf(subEval, rules.ruleDetailAuthor ?? rules.ruleAuthor, ctx, 'detail'),
    auxUrlFieldOf(subEval, rules.ruleDetailCoverUrl ?? rules.ruleCoverUrl, ctx, 'detail'),
    auxFieldOf(subEval, rules.ruleDetailIntro ?? rules.ruleIntro, ctx, 'detail'),
    auxFieldOf(subEval, rules.ruleDetailLastChapter ?? rules.ruleLastChapter, ctx, 'detail'),
    kindFieldOf(subEval, rules.ruleDetailKind ?? rules.ruleKind, ctx, 'detail'),
    wordCountFieldOf(subEval, rules.ruleDetailWordCount ?? rules.ruleWordCount, ctx, 'detail'),
  ])
  return {
    title, author,
    coverUrl: cover === null ? null : absUrl(cover, baseUrl),
    intro: intro === null ? null : formatIntro(intro, { keepDirective: true }),
    lastChapterName: last,
    kind, wordCount,
  }
}

/** 详情页七字段的读取（**只要字段**的两个消费点）：搜索面的 **info 形态**
 *  （`bookUrlPattern` 命中 / 列表为空回落）与探针。`getDetail` 不走它——那条路要字段 + tocUrl，
 *  由 `detailReadOf` 用**同一次** init 求值一并交出（旧组合在本函数与 tocUrlOf 里各求一次 init）。
 *
 *  `onEmptyInit: 'no-book'` 正是为搜索面准备的：那里的「这是详情页」只是**嗅探出来的猜测**
 *  （守卫是「书名为空即没有书目」——init 取空 → 书名 Miss → 无书目）。让它在搜索面抛错，
 *  会把一次正常的「这个词没搜到东西」升级成整源搜索失败（真机源的 `$.data` 在结果响应里取空）。 */
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

/** tocUrl 的**无需详情上下文**那一半：非 null 规则里的真静态 URL 直接绝对化；
 *  返回 null = 这条规则要拿到详情上下文后过引擎（`tocUrlFromContext`）。
 *
 *  静态 URL 短路的歧义前缀按两档分（边界与钉子：矩阵行 `b-toc-url-xpath-vs-url`）：
 *  ① `//`/`.//` 开头（非插值）= 绝对 XPath **绝不短路**——「absUrl 解得出」分不开它与协议相对
 *     地址（裸标签 XPath 会被 `new URL` 解成 `https://div/a/@href` 野地址）；
 *  ② 单 `/` 开头（非插值）= 站点相对静态 URL，**解得出才短路**（单 `/` 纯路径 XPath 与它同形
 *     不可分——现量 0 条，残余如实记在矩阵行）。
 *  与 grammar.isXPathForm 的结论**不同是口径而非漂移**：规则语言里 `/static/list.html` 是 XPath
 *  形态，tocUrl 位上它是静态 URL（URL 读法在能绝对化时优先）。 */
export function staticTocUrl(ruleTocUrl: string, bookUrl: string): string | null {
  const urlShaped = /^(https?:)?\/\//i.test(ruleTocUrl) || ruleTocUrl.startsWith('/')
  const absoluteXPath = ruleTocUrl.startsWith('//') || ruleTocUrl.startsWith('.//')
  if (!urlShaped || absoluteXPath || ruleTocUrl.includes('{')) return null
  // 走到这里必无插值段（`{` 判过），interpolateUrl 恒等 → 直接绝对化。
  return absUrl(ruleTocUrl, stripUrlOption(bookUrl))
}

/** tocUrl 的**详情上下文**那一半（`tocUrlOf` 与 `detailReadOf` 共用）：规则按 init 换根后的上下文
 *  过引擎求值，URL 位按 `firstUrlValue` 取首项（引擎 literal 口径：任一插值段 Miss → 整段 Miss）。
 *  绝对化**只作用在 URL 部分**，`,{option}` 原样接回（与搜索结果 bookUrl、章节 URL 同一层处理）：
 *  先 absUrl 等于让 `new URL()` 先碰选项串——换行被吃、`{` 被百分号编码，`",{` 形状一坏、
 *  抓取层就再也切不到选项 → 整串当路径发出去（两条 POST 型 tocUrl 源实证，矩阵行
 *  `b-url-option-on-toc-url`）。取不到 → 回退 bookUrl **全串**（目录就在本书地址上，抓取仍按选项发）。 */
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

/** 详情面的**一次**完整读取（`ReadingService.getDetail` 的唯一入口）：init 只求值一次，
 *  七字段与 tocUrl 共用这一份上下文——旧组合（`detailFieldsOf` + `tocUrlOf`）各求一次 init，
 *  纯规则白白重算，js 形态的 init 还会**双打站点**。
 *  info / 探针仍走 `detailFieldsOf`：那条路只要字段，不付 tocUrl 求值。
 *
 *  init 空命中按默认口径抛（这里是详情面，不是搜索面的嗅探猜测）；tocUrl 的 null 回退与静态
 *  短路与 `tocUrlOf` 同一判据（`staticTocUrl`）——静态 URL 的源连 tocUrl 规则都不求值。 */
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

/** 一套条目规则（逐条目装配的输入位；键名即装配槽位，不落模型字段）。
 *  聚合搜索用通用搜索那一套，发现面用 `explore-face.rulesFor` 整套切换后的那一份——
 *  **规则的来源不在这条轴上**，来源各异而槽位同一，正是要收成一个主人的理由。 */
export interface HitRules {
  /** 恒非空是调用方的责任：搜索面缺它整体 `RuleMissing`，发现面缺它单条 `RuleMissing`，
   *  两条链路都在循环之外如实报「没有书名规则」——装配层不许拿空规则冒充书名。 */
  name: string
  author: string | null; url: string | null
  cover: string | null; intro: string | null; last: string | null
  kind: string | null; wordCount: string | null
}

/** 逐条目取值装配（**一条命中**的唯一主人）：一套条目规则 + 一个条目上下文 + 落地地址 →
 *  一条书目，或 null（这一条不成书）。
 *
 *  为什么必须有主人：聚合搜索与发现面各写过一份同形的循环——同样八位读数（一条书名 + 七个字段位）、
 *  同样的 `Promise.all` 槽序、同样的书名非空尺、同样的选项保留绝对化与简介净化。两份抄本被记为
 *  「规则来源不同」，来源确实不同，但那不是装配的分野：两处求值传的面都是 `'search'`，
 *  槽位与档位在这两条链路上从来是同一套。档位一旦调整（哪一项从「丢条目」改成「丢字段」）
 *  要在两处各自发现，而它只在一处有理由。
 *
 *  档位分野仍只住 `metaFieldOf` 一处：书名非空才算书目、作者/书地址是裸奔项、其余五项坏规则
 *  只丢该字段。简介走搜索面口径（净化 + 截断，**不认**渲染指令前缀——那是详情面
 *  `detailFieldsFromContext` 给 `keepDirective` 的那一支）。
 *  面不进 interface：它恒为 `'search'`，只进错误定位不改求值语义（与 `docs/adr/0007` 那条
 *  「只有用途一个轴能改变形状」是同一件事的两面）。
 *
 *  抛错穿透：作者/书地址读不出来会抛（裸奔项），归成哪一类错由调用方决定——搜索面按组归错误码，
 *  发现面按源归，编排方在循环之外吞。装配层不自立第二套吞错口径，也不许把 Miss 折成空串。 */
export async function hitFieldsOf(
  rules: HitRules, subEval: SubRuleEval, ctx: ItemContext, landedUrl: string,
): Promise<SearchHit | null> {
  const title = firstValue(await subEval(rules.name, ctx, 'search', 'value'), 'search')
  if (title === null || title.trim() === '') return null
  const [author, href, cover, intro, last, kind, wordCount] = await Promise.all([
    fieldOf(subEval, rules.author, ctx, 'search'),
    urlFieldOf(subEval, rules.url, ctx, 'search'),
    auxUrlFieldOf(subEval, rules.cover, ctx, 'search'),
    auxFieldOf(subEval, rules.intro, ctx, 'search'),
    auxFieldOf(subEval, rules.last, ctx, 'search'),
    kindFieldOf(subEval, rules.kind, ctx, 'search'),
    wordCountFieldOf(subEval, rules.wordCount, ctx, 'search'),
  ])
  return {
    title, author,
    // 书地址保留 `,{option}` 后缀落库（URL 即请求规格——米读类 POST API 源的 book_id 藏在选项
    // body 里，剥掉即身份残废；与章节 URL「保留选项」同源，见 url.absUrlKeepOption）
    url: href === null ? null : absUrlKeepOption(href, landedUrl),
    coverUrl: cover === null ? null : absUrl(cover, landedUrl),
    intro: intro === null ? null : formatIntro(intro),
    lastChapterName: last, kind, wordCount,
  }
}
