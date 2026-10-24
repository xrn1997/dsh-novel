import { evaluate } from '../engine/index.js'
import type { EngineValue, Facet, SourceSession } from '../engine/index.js'
import type { SegmentLoc } from '../engine/types.js'
// runScript 深引（服务半唯一入口）：header 规则求值走沙箱完成值语义；引擎 barrel
// 刻意不收 runScript（公开面只有 evaluate）——服务半要跑脚本一律经本文件的 SourceEval。
import { runScript } from '../engine/js-sandbox.js'
import type { ResponseHost } from '../engine/host-object.js'
import { engineFetch, engineFetchConn, engineFetchGet, engineFetchHead, engineFetchPost, engineFetchRaw } from './engine-fetch.js'
import type { HeadersInput } from './engine-fetch.js'
import { headerOf, effectiveUserAgent } from './fetcher.js'
import type { Fetcher } from './fetcher.js'
import { parseObjectJson, stringTableOf } from './normalize.js'
import { firstValue } from './bridge.js'
import type { SubRuleEval } from './bridge.js'
import { log } from './log.js'
import type { ShelfBook } from '../shared/wire.js'
import type { NovelSource } from './types.js'

/**
 * 源求值缝：一条书源上的**一次脚本/规则求值**只有这一处装配——能力位（fetch 族 / 浏览器 /
 * cookie / device / 源实体字段）、动态头求值、非递归与回退、脚本可见的 `book` 镜像；调用方只交
 * 规则与本次上下文（`chapter` 也由调用方构造后原样透传）。同一段脚本从哪个面进来都看到同一份能力面，
 * 接入新面 = 传参数，不是再手拼一份（裁决见 `docs/adr/0042-source-eval-single-seam.md`）。
 *
 * 消费面：搜索面 / 发现面 / 阅读门面（详情、登录）/ 在线阅读管线（目录、正文）/ 搜索模板 /
 *  源请求缝的头求值。调用方交规则与本次上下文（html / json / baseUrl / vars / book / chapter），
 *  面（facet）只决定错误定位，不改能力面；逐面 `book` 给哪些身份字段仍归调用方。
 */

/** 脚本可见 `book` 的**身份部分**：按面给的书籍身份 + 调用方手里的书架那条。
 *  逐面字段集的差异刻意保留在调用方（搜索面 info 形态只给身份两项，目录/正文面再补
 *  `tocUrl` 与书架字段）——收成全集会改变脚本可见字段，是行为变化不是重构。 */
export interface SourceEvalBookContext {
  bookUrl: string
  origin: string
  tocUrl?: string
  shelfBook?: ShelfBook
}

/** 脚本可见的 `book` 镜像（对面脚本里的 `book` 是书架上那本书）。三项身份由本仓按面给
 *  （`bookUrl`/`origin`/目录面的 `tocUrl`），其余字段取**书架那条**（`title` 映射成脚本读的 `name`）；
 *  书架没有的字段不注入（读到 undefined 与「未设置」同形，不编值）。
 *  逐面实读与缺口病史：矩阵行 `h-book-mirror-fields`。 */
export function bookMirrorOf(ctx: SourceEvalBookContext): Record<string, unknown> {
  const s = ctx.shelfBook
  return {
    bookUrl: ctx.bookUrl,
    origin: ctx.origin,
    ...(ctx.tocUrl === undefined ? {} : { tocUrl: ctx.tocUrl }),
    ...(s?.title === undefined ? {} : { name: s.title }),
    ...(s?.author === undefined ? {} : { author: s.author }),
    ...(s?.kind === undefined ? {} : { kind: s.kind }),
    ...(s?.intro === undefined ? {} : { intro: s.intro }),
    ...(s?.coverUrl === undefined ? {} : { coverUrl: s.coverUrl }),
    ...(s?.lastChapterName === undefined ? {} : { lastChapterName: s.lastChapterName }),
    ...(s?.wordCount === undefined ? {} : { wordCount: s.wordCount }),
  }
}

/** 一条源上的求值面：subEval（条目片段）/ evaluate（单条规则）/ runScript（服务半脚本入口）/ headers（请求头）。
 *  `createSourceEval` 的闭包持有 fetcher、源与 js 预算；每格的可选字段只在调用方有时才透传
 *  （缺席与空值两种值不折叠）。预算**只由构造时给**：配置页热改对下一次构造生效，调用方不逐次带预算。 */
export interface SourceEval {
  subEval(opts?: {
    vars?: Record<string, string>
    book?: SourceEvalBookContext
    chapter?: Record<string, unknown>
  }): SubRuleEval
  evaluate(rule: string, opts: {
    baseUrl: string
    vars?: Record<string, string>
    book?: SourceEvalBookContext
    chapter?: Record<string, unknown>
  }): Promise<EngineValue>
  runScript(code: string, opts: {
    baseUrl: string
    facet: Facet
    vars?: Record<string, string>
    book?: SourceEvalBookContext
    chapter?: Record<string, unknown>
    key?: string
    page?: number
    header?: string
    result?: string
    /** loginCheckJs 的响应对象绑定（与 result 字符串互斥） */
    resultHost?: ResponseHost
    /** 登录按钮动作的 loginInfo Map（与 resultHost 互斥） */
    resultMap?: Record<string, string>
    loc?: SegmentLoc
    scriptForm?: boolean
  }): ReturnType<typeof runScript>
  headers(): Promise<Record<string, string>>
}

/** 源 raw 里的字符串字段（缺 / 非串 → 空串）。本仓对源实体字段一律**按 raw 现读**、不落副本：
 *  脚本可见的 `source` 要的是导入时那份原文（改名 / 重推迁移都只动 raw 之外的投影）。 */
function rawStringField(raw: unknown, field: string): string {
  const v = raw === null || typeof raw !== 'object' ? undefined : (raw as Record<string, unknown>)[field]
  return typeof v === 'string' ? v : ''
}

/** 源级求值上下文组装单点：「引擎上下文该有哪些字段」的唯一实现——
 *  fetch（守门 + auth 头合并）/ source / vars / jsLib 全在此拼装；面（facet）只决定
 *  html/json/baseUrl 的取值（曾多处各拼一份，漏字段只在特定路径炸——新面接入 = 传参数，
 *  不 = 再手拼一份）。 */
export function engineContextOf(
  fetcher: Fetcher, source: NovelSource,
  opts: {
    baseUrl: string; html?: string; json?: unknown; vars?: Record<string, string>
    /** AllInOne 行的 `$n` 绑定用（只有「按整页正则列出的条目」链路带；见 engine/types.ts 的 EvalContext.regexRow） */
    regexRow?: string[]
    /** `book` 变量（脚本可见的书籍身份——目录/正文面常见 `book.bookUrl`） */
    book?: Record<string, unknown>
    /** `chapter` 变量（章节身份：title/index/url） */
    chapter?: Record<string, unknown>
    /** js 沙箱预算透传（EvalContext.jsTimeoutMs；缺省时引擎回退 DEFAULT_JS_TIMEOUT_MS） */
    jsTimeoutMs?: number
    /** 出站口的头来源：省略 = 动态头惰性 provider（默认）；给定 = 静态表（头规则脚本自身用，
     *  不递归回头规则）。六个出站口共用这一份装配，不再由调用方逐个覆盖。 */
    headers?: HeadersInput
    /** 登录面投影（source.getLoginInfoMap / getLoginHeader）：源 auth 或表单录入供出，缺省空。 */
    loginInfo?: Record<string, string>
    loginHeader?: string
  },
): {
  html?: string; json?: unknown; baseUrl: string; source: string
  vars?: Record<string, string>
  fetch: ReturnType<typeof engineFetch>
  fetchRaw: ReturnType<typeof engineFetchRaw>
  fetchPost: ReturnType<typeof engineFetchPost>
  fetchHead: ReturnType<typeof engineFetchHead>
  fetchGet: ReturnType<typeof engineFetchGet>
  fetchConn: ReturnType<typeof engineFetchConn>
  evalWebJs: (code: string, baseUrl?: string) => Promise<string>
  webView: (url: string) => Promise<string>
  deviceId?: string
  session?: SourceSession
  httpCookies?: {
    headerFor(url: string): string
    setCookie(url: string, raw: string): void
    removeSessionCookies(): void
  }
  loginInfo?: Record<string, string>
  loginHeader?: string
  /** java.getWebViewUA 用（口径见 src/engine/types.ts 的 EvalContext.userAgent） */
  userAgent?: () => string
  /** 脚本可见的源实体字段（见 src/engine/types.ts 的 EvalContext.sourceComment / sourceName） */
  sourceName: string
  sourceComment: string
  jsLib?: string
  book?: Record<string, unknown>; chapter?: Record<string, unknown>; jsTimeoutMs?: number
  regexRow?: string[]
} {
  const headers: HeadersInput = opts.headers
    ?? (() => resolveHeaders(fetcher, source, { jsTimeoutMs: opts.jsTimeoutMs }))
  return {
    ...(opts.html === undefined ? {} : { html: opts.html }),
    ...(opts.json === undefined ? {} : { json: opts.json }),
    ...(opts.regexRow === undefined ? {} : { regexRow: opts.regexRow }),
    baseUrl: opts.baseUrl,
    source: source.baseUrl,
    ...(opts.vars === undefined ? {} : { vars: opts.vars }),
    // 头走这里一份装配：省略 headers 入参 = 惰性 provider（`@js` 动态头每请求现算，头规则在请求期
    // 求值、不缓存）；头规则脚本自身由 resolveHeaders 传静态表进来，六个出站口共用它。
    fetch: engineFetch(fetcher, headers),
    fetchRaw: engineFetchRaw(fetcher, headers),
    // java.post 的出站口：与 ajax/connect 同一个守门 fetcher（不开第二出口），差别只有 POST + 脚本头
    fetchPost: engineFetchPost(fetcher, headers),
    // java.head 的出站口：同一守门 fetcher 的 HEAD 姿态（不跟重定向，脚本读 3xx 的直链头）
    fetchHead: engineFetchHead(fetcher, headers),
    // java.get(url, headers) 的出站口：GET + 不跟重定向，返回 Response 数据面
    fetchGet: engineFetchGet(fetcher, headers),
    // java.net.URL.openConnection 的出站口：跟重定向、原始字节；同一守门 fetcher
    fetchConn: engineFetchConn(fetcher, headers),
    // java.getWebViewUA 的口径：本仓真发出去的那条 UA（同步取，与 fetch 同一套静态头解析）
    userAgent: () => effectiveUserAgent(source),
    // 脚本可见的源实体字段：**按 raw 现读**，只投影脚本真读到的（对面脚本里的 source 是字段面
    // 很大的书源实体，本仓按现库需求逐字段接线——现量见矩阵行 `h-source-entity-fields`）。
    sourceName: source.name,
    sourceComment: rawStringField(source.raw, 'bookSourceComment'),
    ...(source.rules.jsLib === null ? {} : { jsLib: source.rules.jsLib }),
    ...(opts.book === undefined ? {} : { book: opts.book }),
    ...(opts.chapter === undefined ? {} : { chapter: opts.chapter }),
    ...(opts.jsTimeoutMs === undefined ? {} : { jsTimeoutMs: opts.jsTimeoutMs }),
    ...(opts.loginInfo !== undefined
      ? { loginInfo: opts.loginInfo }
      : source.auth !== undefined && !source.auth.expired && source.auth.loginInfo !== undefined
        ? { loginInfo: source.auth.loginInfo }
        : {}),
    ...(opts.loginHeader !== undefined
      ? { loginHeader: opts.loginHeader }
      : source.auth !== undefined && !source.auth.expired
        && source.auth.headers !== undefined && Object.keys(source.auth.headers).length > 0
        ? { loginHeader: JSON.stringify(source.auth.headers) }
        : {}),
    // 两个浏览器能力位始终在场（缺席时调用才点名）：能力位闸要求 ctx 的每个 d.ctx.* 都供得出
    evalWebJs: (code: string, baseUrl?: string) => {
      if (fetcher.webview === undefined) throw new Error('该源未提供 WebView 能力（fetcher.webview 缺失）')
      return fetcher.webview.fetch(baseUrl ?? source.baseUrl, { webJs: code }).then((p) => p.html)
    },
    webView: (url: string) => {
      if (fetcher.webview === undefined) throw new Error('该源未提供 WebView 能力（fetcher.webview 缺失）')
      return fetcher.webview.fetch(url).then((p) => p.html)
    },
    ...(fetcher.deviceId === undefined ? {} : { deviceId: fetcher.deviceId }),
    ...(fetcher.sourceSession === undefined ? {} : { session: fetcher.sourceSession }),
    ...(fetcher.cookieJar === undefined ? {} : {
      httpCookies: {
        headerFor: (url: string) => fetcher.cookieJar!.headerFor(url),
        // CookieManager/CookieStore.setCookie 收的是 **cookie 串**（`getCookie` 的原样回写，
        // 常见 `a=1; b=2`），不是 Set-Cookie 头；整串塞给 absorb 会把第二个键当成属性丢掉。
        setCookie: (url: string, raw: string) => {
          const pairs = raw.split(';').map((s) => s.trim()).filter((s) => s !== '')
            .filter((s) => !/^(?:path|domain|expires|max-age|secure|httponly|samesite)\s*=/i.test(s))
          if (pairs.length > 0) fetcher.cookieJar!.absorb(url, pairs)
        },
        removeSessionCookies: () => fetcher.cookieJar!.removeSessionCookies(),
      },
    }),
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
      ...engineContextOf(fetcher, source, {
        baseUrl: source.baseUrl,
        headers: staticHeaders,
        ...(opts?.jsTimeoutMs === undefined ? {} : { jsTimeoutMs: opts.jsTimeoutMs }),
      }),
      // 头规则脚本的六个出站口用静态头打底（不递归）；「不递归」现在是 engineContextOf 的一个入参，
      // 不再是六个键的手抄覆盖——手抄那份曾把 deviceId 漏在 headerRule 外面，且能力位闸看不见它。
      loc: { segmentIndex: 0, segmentRaw: rule },
      facet: 'rule',
      scriptForm: true,
    })
    const text = firstValue(outcome.value, 'rule')
    if (text === null || text === '') throw new Error('动态头规则产物为空')
    // 与静态头共用同一宽松度（严格 JSON → 单引号交换）与同一键值筛（stringTableOf）——
    // 「哪些头条目活着」的口径只住 normalize 一处
    const parsed = parseObjectJson(text)
    if (parsed === undefined) throw new Error('动态头规则产物不是对象 JSON')
    return { ...stringTableOf(parsed), ...staticHeaders }
  } catch (e) {
    log.warn(`动态头规则求值失败，回退静态头（${source.name}）：`,
      e instanceof Error ? e.message : String(e))
    return staticHeaders
  }
}

/** 源求值缝的构造器：闭包持有 fetcher / 源 / js 预算，调用方只交每次求值的上下文。
 *  预算只由构造时给——配置页热改只影响新构造的那份，调用方（源请求缝、在线阅读管线）
 *  每次出站都重新构造，故读到的是当次值。 */
export function createSourceEval(
  fetcher: Fetcher, source: NovelSource, opts?: { jsTimeoutMs?: number },
): SourceEval {
  const defaultBudget = opts?.jsTimeoutMs
  /** 引擎上下文单点：`book` 从调用方的 SourceEvalBookContext 塑形，其余原样透传。 */
  const ctxOf = (o: {
    baseUrl: string; html?: string; json?: unknown; regexRow?: string[]
    vars?: Record<string, string>; book?: SourceEvalBookContext; chapter?: Record<string, unknown>
  }) => engineContextOf(fetcher, source, {
    baseUrl: o.baseUrl,
    ...(o.html === undefined ? {} : { html: o.html }),
    ...(o.json === undefined ? {} : { json: o.json }),
    ...(o.regexRow === undefined ? {} : { regexRow: o.regexRow }),
    ...(o.vars === undefined ? {} : { vars: o.vars }),
    ...(o.book === undefined ? {} : { book: bookMirrorOf(o.book) }),
    ...(o.chapter === undefined ? {} : { chapter: o.chapter }),
    ...(defaultBudget === undefined ? {} : { jsTimeoutMs: defaultBudget }),
  })
  return {
    subEval(o) {
      const sub: SubRuleEval = (rule, ctx, facet, usage) => evaluate(rule, ctxOf({
        baseUrl: ctx.baseUrl, html: ctx.html, json: ctx.json,
        ...(ctx.regexRow === undefined ? {} : { regexRow: ctx.regexRow }),
        ...(o?.vars === undefined ? {} : { vars: o.vars }),
        ...(o?.book === undefined ? {} : { book: o.book }),
        ...(o?.chapter === undefined ? {} : { chapter: o.chapter }),
      }), facet, usage ?? 'list')
      return sub
    },
    evaluate(rule, o) {
      return evaluate(rule, ctxOf({
        baseUrl: o.baseUrl,
        ...(o.vars === undefined ? {} : { vars: o.vars }),
        ...(o.book === undefined ? {} : { book: o.book }),
        ...(o.chapter === undefined ? {} : { chapter: o.chapter }),
      }), 'rule')
    },
    runScript(code, o) {
      return runScript({
        ...ctxOf({
          baseUrl: o.baseUrl,
          ...(o.vars === undefined ? {} : { vars: o.vars }),
          ...(o.book === undefined ? {} : { book: o.book }),
          ...(o.chapter === undefined ? {} : { chapter: o.chapter }),
        }),
        code,
        ...(o.key === undefined ? {} : { key: o.key }),
        ...(o.page === undefined ? {} : { page: o.page }),
        ...(o.header === undefined ? {} : { header: o.header }),
        ...(o.result === undefined ? {} : { result: o.result }),
        ...(o.resultHost === undefined ? {} : { resultHost: o.resultHost }),
        ...(o.resultMap === undefined ? {} : { resultMap: o.resultMap }),
        loc: o.loc ?? { segmentIndex: 0, segmentRaw: code },
        facet: o.facet,
        ...(o.scriptForm === undefined ? {} : { scriptForm: o.scriptForm }),
      })
    },
    headers() {
      return resolveHeaders(fetcher, source, defaultBudget === undefined ? undefined : { jsTimeoutMs: defaultBudget })
    },
  }
}
