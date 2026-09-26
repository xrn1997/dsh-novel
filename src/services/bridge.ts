import render from 'dom-serializer'
import { evaluate, isPutOnlyRule, RuleEvalError } from '../engine/index.js'
import type { EngineValue, Facet, RuleUsage } from '../engine/index.js'
// runScript 深引（与 search-template 同口径）：header 规则求值走沙箱完成值语义，
// 引擎 barrel 刻意不收 runScript（公开面只有 evaluate）——服务半第二个深引消费点。
import { runScript } from '../engine/js-sandbox.js'
import { engineFetch, engineFetchPost, engineFetchRaw } from './engine-fetch.js'
import { headerOf, effectiveUserAgent } from './fetcher.js'
import type { Fetcher } from './fetcher.js'
import { absUrl } from './url.js'
import { formatIntro } from './content.js'
import type { NovelSource } from './types.js'

// 兼容 re-export：absUrl 迁至 url.ts（拆 request↔bridge 环）、engineFetch 迁至 engine-fetch.ts
// （请求组装语义归 request.assembleRequest）——既有 import 路径保持可用。
export { absUrl }
export { engineFetch } from './engine-fetch.js'

/** 页面快照（URL + 解码后正文 + 可选解析好的 JSON）——门面层传给字段求值的输入。
 *  `url` 是**实际落地**地址（跟随重定向后，相对链接按其解析——浏览器语义）；
 *  `requestedUrl` 只作诊断（两者不同＝被跳转走了，报错里点名，站点整站 302 一眼可见）。 */
export interface Page { url: string; requestedUrl?: string; body: string; json?: unknown }

/** 条目片段上的子规则求值器：与引擎内部 evaluateRef 同构（片段即 html 上下文）。
 *  usage（取值用途）：'value'（getString 口径——链尾未知词 = HTML 属性名）/ 'list'（getElements
 *  口径——链尾未知词 = 选择器）。服务层按规则用途显式传，缺省沿用引擎的 'list'。 */
export interface SubRuleEval {
  (rule: string, ctx: { html?: string; json?: unknown; baseUrl: string }, facet: Facet, usage?: RuleUsage): Promise<EngineValue>
}

/** 值规约（链终点取值）：miss→null；value→text；list→join('\n')；matches→取每行首列 join。 */
export function firstValue(v: EngineValue, facet: Facet = 'rule'): string | null {
  switch (v.kind) {
    case 'miss': return null
    case 'value': return v.text
    case 'list': return v.items.join('\n')
    case 'matches': return v.rows.map((r) => r[0] ?? '').join('\n')
    case 'nodes': throw nodesError(v, facet)
  }
}

/** 多值规约：miss→null；value→[text]；list→items；matches→每行首列。 */
export function listValue(v: EngineValue, facet: Facet = 'rule'): string[] | null {
  switch (v.kind) {
    case 'miss': return null
    case 'value': return [v.text]
    case 'list': return v.items
    case 'matches': return v.rows.map((r) => r[0] ?? '')
    case 'nodes': throw nodesError(v, facet)
  }
}

/** 列表页条目提取：nodes→逐节点 HTML 片段；list→逐项；matches→行 join('\t')；miss→[]（零结果合法）。 */
export function extractItems(v: EngineValue): string[] {
  switch (v.kind) {
    case 'miss': return []
    case 'value': return [v.text]
    case 'list': return [...v.items]
    case 'matches': return v.rows.map((r) => r.join('\t'))
    // encodeEntities:'utf8'：默认选项把 CJK 全部编码成 &#x…; 数字实体；'utf8' 只转义 &<> 保留可读原文
    case 'nodes': return v.nodes.toArray().map((n) => render(n, { encodeEntities: 'utf8' }))
  }
}

/** 源级求值上下文组装单点：「引擎上下文该有哪些字段」的唯一实现——
 *  fetch（守门 + auth 头合并）/ source / vars / jsLib 全在此拼装；面（facet）只决定
 *  html/json/baseUrl 的取值。此前 makeSubEval 与 search-template.scriptOf 各拼一份，
 *  runLogin 手拼漏 jsLib/vars（@js 登录调 jsLib 函数只在登录那一刻炸 not defined），
 *  tocUrlOf 连 source/fetch 都没有。新面接入 = 传参数，不 = 再手拼一份字段。 */
export function engineContextOf(
  fetcher: Fetcher, source: NovelSource,
  opts: {
    baseUrl: string; html?: string; json?: unknown; vars?: Record<string, string>
    /** `book` 变量（脚本可见的书籍身份——目录/正文面常见 `book.bookUrl`） */
    book?: Record<string, unknown>
    /** `chapter` 变量（章节身份：title/index/url） */
    chapter?: Record<string, unknown>
    /** js 沙箱预算透传（EvalContext.jsTimeoutMs；缺省时引擎回退 DEFAULT_JS_TIMEOUT_MS） */
    jsTimeoutMs?: number
  },
): {
  html?: string; json?: unknown; baseUrl: string; source: string
  vars?: Record<string, string>
  fetch: ReturnType<typeof engineFetch>
  fetchRaw: ReturnType<typeof engineFetchRaw>
  fetchPost: ReturnType<typeof engineFetchPost>
  /** java.getWebViewUA 用（口径见 src/engine/types.ts 的 EvalContext.userAgent） */
  userAgent?: () => string
  jsLib?: string
  book?: Record<string, unknown>; chapter?: Record<string, unknown>; jsTimeoutMs?: number
} {
  return {
    ...(opts.html === undefined ? {} : { html: opts.html }),
    ...(opts.json === undefined ? {} : { json: opts.json }),
    baseUrl: opts.baseUrl,
    source: source.baseUrl,
    ...(opts.vars === undefined ? {} : { vars: opts.vars }),
    // 头走惰性 provider：`@js` 动态头每请求现算（头规则在请求期求值，不缓存结果）；
    // 规则求值自身用的静态头在 resolveHeaders 内单独构造——不递归回 provider。
    fetch: engineFetch(fetcher, () => resolveHeaders(fetcher, source, { jsTimeoutMs: opts.jsTimeoutMs })),
    fetchRaw: engineFetchRaw(fetcher, () => resolveHeaders(fetcher, source, { jsTimeoutMs: opts.jsTimeoutMs })),
    // java.post 的出站口：与 ajax/connect 同一个守门 fetcher（不开第二出口），差别只有 POST + 脚本头
    fetchPost: engineFetchPost(fetcher, () => resolveHeaders(fetcher, source, { jsTimeoutMs: opts.jsTimeoutMs })),
    // java.getWebViewUA 的口径：本仓真发出去的那条 UA（同步取，与 fetch 同一套静态头解析）
    userAgent: () => effectiveUserAgent(source),
    ...(source.rules.jsLib === null ? {} : { jsLib: source.rules.jsLib }),
    ...(opts.book === undefined ? {} : { book: opts.book }),
    ...(opts.chapter === undefined ? {} : { chapter: opts.chapter }),
    ...(opts.jsTimeoutMs === undefined ? {} : { jsTimeoutMs: opts.jsTimeoutMs }),
  }
}

/**
 * 请求头解析（源级动态头口径）：静态 header 直答；`headerRule`
 * （`@js:`/`<js>` 动态头）经沙箱求值得到 JSON 头表，再叠 auth/cookie（与静态形态同序：auth 在后占优）。
 *
 * 失败语义是「warn 后回退静态头」：规则求值抛错、产物不是合法 JSON 对象，都只降级不取消请求
 * （动态头缺失 = 站点按无 device 鉴权处理，下游自然报错——不吞请求也不炸整条链，回退后照常发出去）。
 * **不递归**：规则脚本自身的 fetch 用静态头（provider 不进场），
 * 否则头规则里一次 java.ajax 就会重新求值头规则。
 */
export async function resolveHeaders(
  fetcher: Fetcher, source: NovelSource, opts?: { jsTimeoutMs?: number },
): Promise<Record<string, string>> {
  const rule = source.rules.headerRule
  const staticHeaders = headerOf(source)
  if (rule == null || rule.trim() === '') return staticHeaders
  // 规则前缀剥离（`@js:` 去前 4 字符；`<js>…</js>` 取两标记之间的内容）
  let code = rule
  if (/^@js:/i.test(rule)) code = rule.slice(4)
  else if (/^<js>/i.test(rule)) {
    const close = rule.lastIndexOf('<')
    code = close > 4 ? rule.slice(4, close) : rule.slice(4)
  }
  try {
    const outcome = await runScript({
      code,
      baseUrl: source.baseUrl,
      source: source.baseUrl,
      // 规则脚本自身的网络能力：静态头打底（见上：不递归）
      fetch: engineFetch(fetcher, staticHeaders),
      fetchRaw: engineFetchRaw(fetcher, staticHeaders),
      jsLib: source.rules.jsLib ?? undefined,
      jsTimeoutMs: opts?.jsTimeoutMs,
      loc: { segmentIndex: 0, segmentRaw: rule },
      facet: 'rule',
      scriptForm: true,
    })
    const text = firstValue(outcome.value, 'rule')
    if (text === null || text === '') throw new Error('动态头规则产物为空')
    const parsed: unknown = JSON.parse(text) // 非 JSON（脚本产出坏串）→ 落到下方 catch
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('动态头规则产物不是 JSON 对象')
    }
    const dynamic: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed)) if (typeof v === 'string') dynamic[k] = v
    return { ...dynamic, ...staticHeaders }
  } catch (e) {
    console.warn(`[dsh-novel] 动态头规则求值失败，回退静态头（${source.name}）：`,
      e instanceof Error ? e.message : String(e))
    return staticHeaders
  }
}

/** 缝合器：源级 SubRuleEval——上下文组装走 engineContextOf 单点。
 *  第三参兼容两形态：`Record<string,string>`（历史 vars 形态）或 opts 对象（vars/book/chapter）。 */
export function makeSubEval(
  fetcher: Fetcher, source: NovelSource,
  optsOrVars?: Record<string, string> | { vars?: Record<string, string>; book?: Record<string, unknown>; chapter?: Record<string, unknown>; jsTimeoutMs?: number },
): SubRuleEval {
  const opts = optsOrVars === undefined
    ? {}
    : isVarsShaped(optsOrVars) ? { vars: optsOrVars } : optsOrVars
  return (rule, ctx, facet, usage) =>
    evaluate(rule, engineContextOf(fetcher, source, {
      baseUrl: ctx.baseUrl, html: ctx.html, json: ctx.json,
      ...(opts.vars === undefined ? {} : { vars: opts.vars }),
      ...(opts.book === undefined ? {} : { book: opts.book }),
      ...(opts.chapter === undefined ? {} : { chapter: opts.chapter }),
      ...(opts.jsTimeoutMs === undefined ? {} : { jsTimeoutMs: opts.jsTimeoutMs }),
    }), facet, usage ?? 'list')
}

/** 历史 vars 形态判别：全值 string 的对象按 vars 处理（与 opts 对象的键不重叠——vars/book/chapter/jsTimeoutMs） */
function isVarsShaped(
  v: Record<string, string> | { vars?: Record<string, string>; book?: Record<string, unknown>; chapter?: Record<string, unknown>; jsTimeoutMs?: number },
): v is Record<string, string> {
  const keys = Object.keys(v)
  return keys.length > 0 && keys.every((k) => !['vars', 'book', 'chapter', 'jsTimeoutMs'].includes(k))
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
  subEval: SubRuleEval, rule: string | null, ctx: { html: string; baseUrl: string }, facet: Facet,
): Promise<string | null> {
  if (rule === null) return null
  return firstValue(await subEval(rule, ctx, facet, 'value'), facet)
}

/** 辅助元数据字段的口径：**读不出来 = 留空，书目照收**。
 *  走这条的恰是这五项：kind / wordCount / lastChapter / intro / coverUrl；**裸奔的是
 *  name / author / bookUrl / tocUrl**（那四个空即丢条目、炸即整次失败）。所以一条坏掉的简介规则
 *  **不会**让整页书目消失。 */
async function metaFieldOf<T>(
  subEval: SubRuleEval, rule: string | null, ctx: { html: string; baseUrl: string }, facet: Facet,
  read: (v: EngineValue) => T | null,
): Promise<T | null> {
  if (rule === null) return null
  try {
    return read(await subEval(rule, ctx, facet, 'value'))
  } catch {
    return null
  }
}

/** 辅助字段五件里的「单值」三件（最新章节 / 简介 / 封面）：值规约同 `fieldOf`，
 *  差别只在读取抛错时留空而不是带走整组书目（口径见 `metaFieldOf`）。 */
export function auxFieldOf(
  subEval: SubRuleEval, rule: string | null, ctx: { html: string; baseUrl: string }, facet: Facet,
): Promise<string | null> {
  return metaFieldOf(subEval, rule, ctx, facet, (v) => firstValue(v, facet))
}

/** 分类（多值列表 join(',') 后截前 1000 个 UTF-16 code unit）：
 *  **多命中是逗号串，不是首值**——`class.tags a@text`、`$.categoryNames[*]className` 这类规则
 *  的产物是「玄幻,都市」，取首值只剩「玄幻」，与规则写法不符。截断按 UTF-16 code unit 计，
 *  与 JS `String.prototype.slice` 同单位。 */
export function kindFieldOf(
  subEval: SubRuleEval, rule: string | null, ctx: { html: string; baseUrl: string }, facet: Facet,
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
  subEval: SubRuleEval, rule: string | null, ctx: { html: string; baseUrl: string }, facet: Facet,
): Promise<string | null> {
  return metaFieldOf(subEval, rule, ctx, facet, (v) => formatWordCount(firstValue(v, facet)))
}

/** 详情上下文解析（`ruleBookInfo.init` 口径：init 先求值，其结果**整体替换**后续详情规则的求值上下文
 *  **与 html**——内容单点全换）：
 *  JSON 产物 → html 与 ctx.json **同步换根**（此前 html 留原页只换 json：`{{result.articleid}}`
 *  这类 tocUrl 模板的 result=pageText=原页 → 插值 Miss → tocUrl 回退详情页 → 目录空，
 *  novel.cooks.tw 真机实证——换根后的 result/content 就是 init 产物本身）；
 *  非 JSON 文本/HTML 片段 → 作为 html 上下文（同前）。
 *  init 非空但零命中 → 默认 RuleEvalError 点名 ruleDetailInit——不拿整页冒充上下文（宁炸不猜：
 *  静默降级会让详情字段全 Miss 伪装成「源什么都没有」，QQ 类正版 API 源实测形态）。
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
  // `== null`：存量 sources.json 可能缺 ruleDetailInit 键（undefined）——按缺规则直通
  if (ruleDetailInit == null || ruleDetailInit.trim() === '') return { html }
  // 纯 `@put` 的 init（本机 4 源的详情面主导写法）：**只设变量、不换根**——剥掉 `@put` 后
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

/** 详情页五字段（详情面字段规则的取值段）：init 换根 → 书名/作者/封面/简介/
 *  最新章节，`ruleDetail*` 优先、平铺方言回退同名共用字段（原 v1 行为）。封面按 base 绝对化、
 *  简介按详情面口径净化（`<usehtml>`/`<md>`/`<useweb>` 前缀原样保留，其余 format + 5000 截断）。
 *
 *  两个消费点共用这一份：`ReadingService.getDetail`（详情面）与搜索面的 **info 形态**
 *  （`bookUrlPattern` 命中 / 列表为空回落——两处走同一套字段口径）。第二处若各写一份
 *  `ruleDetailName ?? ruleBookName` 的回落链，两上下文的分野就会开始各自漂移（那是本仓定过的重复罪）。
 *
 *  `onEmptyInit: 'no-book'` 正是为第二处准备的：那里的「这是详情页」只是**嗅探出来的猜测**
 *  （守卫是「书名为空即没有书目」——init 取空 → 书名 Miss → 无书目）。让它在搜索面
 *  抛错，会把一次正常的「这个词没搜到东西」升级成整源搜索失败（第 19 批真机抓回：快手趣阁
 *  `$.data` 在结果响应里取空 → 本仓若报 RuleEvalError 即升级成失败）。 */
/** 详情页七字段的取值面（`detailFieldsOf` 的返回形状） */
export interface DetailFields {
  title: string | null; author: string | null; coverUrl: string | null
  intro: string | null; lastChapterName: string | null
  kind: string | null; wordCount: string | null
}

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
  const { rules } = s
  const dctx = opts?.onEmptyInit === 'no-book'
    ? await detailContextOf(rules.ruleDetailInit, html, baseUrl, subEval, { onEmptyInit: 'no-context' })
    : await detailContextOf(rules.ruleDetailInit, html, baseUrl, subEval)
  if (dctx === null) return null
  const ctx = { html: dctx.html, json: dctx.json, baseUrl }
  const [title, author, cover, intro, last, kind, wordCount] = await Promise.all([
    fieldOf(subEval, rules.ruleDetailName ?? rules.ruleBookName, ctx, 'detail'),
    fieldOf(subEval, rules.ruleDetailAuthor ?? rules.ruleAuthor, ctx, 'detail'),
    auxFieldOf(subEval, rules.ruleDetailCoverUrl ?? rules.ruleCoverUrl, ctx, 'detail'),
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
