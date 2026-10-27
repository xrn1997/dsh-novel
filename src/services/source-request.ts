import type { Page } from './bridge.js'
import type { CookieJar } from './cookies.js'
import { FetchError } from './errors.js'
import { decodeBody, fetchTextPage, headerOf, splitUserAgent } from './fetcher.js'
import type { Fetcher } from './fetcher.js'
import { applyLoginCheck, loginCheckOf } from './login-check.js'
import { parseConcurrentRate, RateLimiter } from './rate-limit.js'
import { assembleRequest, fetchInitOf } from './request.js'
import type { RequestPlan } from './request.js'
import { createSourceEval } from './source-eval.js'
import type { NovelSource } from './types.js'
import type { WebViewCookie, WebViewOptions, WebViewPage, WebViewRuntime } from './webview.js'

/** 源请求执行缝的依赖。`webview` 只要 `fetch`（假实现不必造整个运行时）；
 *  `jsTimeoutMs` 是活配置读口——沙箱预算随配置页热改，装配期抄快照会让改动等到重启。 */
export interface SourceRequestDeps {
  fetcher: Fetcher
  webview: Pick<WebViewRuntime, 'fetch'>
  cookieJar: CookieJar
  jsTimeoutMs: () => number
  /** 测试注入假时钟；缺省按 source.raw.concurrentRate 建 */
  rateLimiterFor?: (source: NovelSource) => RateLimiter
}

/** 一次出站抓取的两个消费面：只要正文与落点，或要整页（面层再拿去求值规则）。 */
export interface SourceRequest {
  fetcherFor(source: NovelSource): Fetcher
  fetchText(source: NovelSource, plan: RequestPlan, opts?: { timeoutMs?: number }): Promise<{ text: string; landedUrl: string }>
  fetchPage(source: NovelSource, plan: RequestPlan, opts?: { timeoutMs?: number }): Promise<Page>
}

/**
 * 源请求执行缝：一次出站抓取「动态头 → 限速 → webview/HTTP → loginCheck」顺序的**唯一**装配点。
 *
 * 为什么要有这一层：这套顺序必须只有一个装配点。若散在各面（搜索/发现/目录/正文各调
 * `resolveHeaders`，只有阅读门面的源级外观带限速与 loginCheck），真浏览器抓取会绕开限速、
 * 头部由每个调用方自己求值，头规则脚本里的一次网络调用还可能回头再求值头规则。
 * 要发请求的调用方只交 (source, plan)，不自己拼这份顺序。
 *
 * 三条不变量（本 module 的存在理由，改动前先读）：
 * - **真浏览器也过限速**：限速与动态头是共同前置，不挂在 HTTP 那一支上。引擎面
 *   （`@webjs:` / `java.webView`）从 `fetcherFor(source).webview` 取浏览器，与读面共用同一只
 *   按源令牌桶；浏览器与 HTTP jar 的双向桥也归这一层（secure/expires 随 cookie 一起过桥）。
 *   引擎裸 `webView` 没有 RequestPlan，带源**静态头与 UA** 打底；动态头只在读面与脚本 HTTP
 *   出站（`source-eval.ts` 的 `engineContextOf` 惰性 provider）求值。
 * - **loginCheck 只作用于 HTTP**：对面把它当 HTTP 响应的后置处理；替真浏览器页面重试/替换
 *   会把浏览器拿到的正文换成 HTTP 的。loginCheck 的替页与重试都走内部 raw 执行，
 *   所以重试仍受限速与动态头约束，但不会再次触发 loginCheck。
 * - **错误页也要过 loginCheck**：源声明 loginCheckJs 时，4xx/5xx 先以 allowError 返回页面给脚本
 *   看正文（Cloudflare 403/503 正是需求方）；脚本不替换时由本缝补抛 FetchError。`manual` 的
 *   HEAD 探测仍按原语义放行任意状态码。
 * - **头规则只求值一次**：`initFor` 经 `fetcherFor` 求值一次后经 init 带入请求——头规则脚本自己的
 *   出站因此也受限速与 loginCheck 约束；`source-eval.ts` 的 `resolveHeaders` 给它脚本里的 `java.ajax`
 *   打的是**静态头**，不回头再求值头规则。`fetcherFor` 交给引擎脚本时不再解析——脚本侧的头由
 *   `engineContextOf` 的惰性 provider 提供，外观再解析就等于每个脚本请求叠加一次求值。
 *
 * **解码不归本缝**：它只按计划选 charset（`charsetOf`），解码本身归 `fetcher.decodeBody`
 * （`fetchTextPage` 与 `SourceRequest.fetchPage` 共用那条单点）。顺序里「动态头」排在「限速」前也是实序：
 * init 先求值，真正出站的那一步才 `acquire`。
 */
export function createSourceRequest(deps: SourceRequestDeps): SourceRequest {
  // 桶按「源 id + 当前 concurrentRate」认：改源规则会换掉源对象，只按 id 缓存会让新速率等到重启
  const limiters = new Map<string, { rateKey: string; limiter: RateLimiter }>()
  const limiterFor = (source: NovelSource): RateLimiter => {
    if (deps.rateLimiterFor !== undefined) return deps.rateLimiterFor(source)
    const raw = source.raw
    const rate = raw !== null && typeof raw === 'object'
      ? (raw as Record<string, unknown>).concurrentRate
      : undefined
    const rateKey = typeof rate === 'string' ? rate.trim() : String(rate ?? '')
    const cached = limiters.get(source.id)
    if (cached !== undefined && cached.rateKey === rateKey) return cached.limiter
    const limiter = new RateLimiter(parseConcurrentRate(rate))
    limiters.set(source.id, { rateKey, limiter })
    return limiter
  }

  /** 一次浏览器抓取：限速 + cookie 双向桥。读面与引擎面（`@webjs:` / `java.webView`）共用这一层；
   *  不要从基础 fetcher 直接取浏览器——那会绕限速，并各自抄一遍 cookie 回灌。 */
  const webviewFor = (source: NovelSource): Pick<WebViewRuntime, 'fetch'> => ({
    fetch: async (url: string, opts: WebViewOptions = {}): Promise<WebViewPage> => {
      await limiterFor(source).acquire()
      // 引擎面裸调 webView 时也得带源静态头与 UA；读面已在 opts 里带齐（动态头 + UA），同名后者优先
      const base = splitUserAgent(headerOf(source))
      const headers = { ...base.headers, ...(opts.headers ?? {}) }
      const userAgent = opts.userAgent ?? base.userAgent
      const page = await deps.webview.fetch(url, {
        ...opts,
        headers,
        cookies: opts.cookies ?? browserCookiesOf(deps.cookieJar),
        ...(userAgent === undefined ? {} : { userAgent }),
      })
      absorbWebviewCookies(deps.cookieJar, page)
      return page
    },
  })

  /** 内部 raw 执行：限速 + webview/HTTP；不跑 loginCheck（避免自递归），也不解析动态头
   *  （`initFor` 求值后经 init 带入；脚本侧由引擎的惰性 provider 带入） */
  const rawFetcherFor = (source: NovelSource): Fetcher => {
    const webview = webviewFor(source)
    return {
      fetchPage: async (url, init) => {
        const merged = { ...init, headers: { ...(init?.headers ?? {}) } }
        if (merged.webView === true || merged.webJs !== undefined) {
          // 浏览器抓取是页面导航（GET）；带 POST/HEAD 的计划若静默当 GET 发，等于改脚本意图
          const webviewMethod = merged.method?.toUpperCase()
          if (webviewMethod !== undefined && webviewMethod !== 'GET') {
            throw new Error(`webView 只支持 GET，收到 ${merged.method}：${url}`)
          }
          const { headers, userAgent } = splitUserAgent(merged.headers)
          const page = await webview.fetch(url, {
            headers,
            cookies: browserCookiesOf(deps.cookieJar),
            ...(userAgent === undefined ? {} : { userAgent }),
            ...(merged.timeoutMs === undefined ? {} : { timeoutMs: merged.timeoutMs }),
            ...(merged.webJs === undefined ? {} : { webJs: merged.webJs }),
          })
          return {
            raw: Buffer.from(page.html, 'utf8'),
            finalUrl: page.finalUrl,
            contentType: 'text/html',
            charset: 'utf-8',
            status: page.status,
            setCookie: [],
            headers: page.headers,
          }
        }
        await limiterFor(source).acquire()
        return deps.fetcher.fetchPage(url, merged)
      },
      // 引擎脚本（@webjs:/java.webView）也从这层取浏览器：同一令牌桶、同一 cookie 桥
      webview,
      ...(deps.fetcher.deviceId === undefined ? {} : { deviceId: deps.fetcher.deviceId }),
      ...(deps.fetcher.sourceSession === undefined ? {} : { sourceSession: deps.fetcher.sourceSession }),
      // 与旧源级外观同面：交给脚本的 adapter 也保留关出站 dispatcher 的能力位
      dispose: () => deps.fetcher.dispose?.(),
      cookieJar: deps.cookieJar,
    }
  }

  const fetcherFor = (source: NovelSource): Fetcher => {
    const raw = rawFetcherFor(source)
    return {
      ...raw,
      // 脚本侧动态头由 engineContextOf 的惰性 provider 解析；本外观必须不再解析——再解析一次
      // 会让每个脚本请求叠加一次头规则求值（头规则里的 java.ajax 会回头再求值头规则）
      fetchPage: async (url, init) => {
        // 真浏览器页面原样返回（loginCheck 只作用于 HTTP 分支）
        if (init?.webView === true || init?.webJs !== undefined) return raw.fetchPage(url, init)
        // 没有 loginCheck 的源保持守门错误：不把 4xx 正文读进内存再抛
        if (loginCheckOf(source) === '') return raw.fetchPage(url, init)
        // loginCheck 的需求方正是 Cloudflare 403/503 拦截页：先放行最终错误页给它看正文；
        // 脚本没替换响应时，这里补回守门错误（manual 的 HEAD 探测仍按原语义放行任意状态码）。
        const page = await raw.fetchPage(url, { ...init, allowError: true })
        const checked = await applyLoginCheck(raw, source, page, init, { jsTimeoutMs: deps.jsTimeoutMs() })
        if (checked === page && page.status >= 400 && init?.manual !== true) {
          throw new FetchError(`请求失败 ${page.status}: ${url}`, { url, status: page.status })
        }
        return checked
      },
    }
  }

  /** 一次出站的前置：动态头求值 + 计划 → init。头规则脚本自己的出站也走本缝（限速/loginCheck）。 */
  const initFor = async (source: NovelSource, plan: RequestPlan, opts?: { timeoutMs?: number }) => {
    // 动态头每请求求值一次；头规则脚本里的 java.ajax 同样过本缝的限速与 loginCheck。
    // 不递归：source-eval 的 resolveHeaders 给这些脚本出站打的是静态头，不会再求值头规则。
    const dynamic = await createSourceEval(fetcherFor(source), source, { jsTimeoutMs: deps.jsTimeoutMs() }).headers()
    return { ...fetchInitOf(plan, dynamic), ...(opts?.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }) }
  }

  /** webview 的 html 已是 UTF-8 JS 字符串：不按 URL 选项的 charset 二次解码 */
  const charsetOf = (plan: RequestPlan): string | undefined =>
    plan.webView || plan.webJs !== undefined ? 'utf-8' : plan.charset

  return {
    fetcherFor,
    async fetchText(source, plan, opts) {
      // 文本面复用「抓取 + 解码」的单点 `fetchTextPage`，本缝不再抄第二遍组合
      return fetchTextPage(fetcherFor(source), plan.url, await initFor(source, plan, opts), charsetOf(plan))
    },
    async fetchPage(source, plan, opts) {
      const page = await fetcherFor(source).fetchPage(plan.url, await initFor(source, plan, opts))
      return { url: page.finalUrl, requestedUrl: plan.url, body: decodeBody(page, charsetOf(plan)) }
    },
  }
}

/** 读面的一次文本抓取：URL（可带 `,{option}` 后缀）→ 请求计划 → 守门源请求。
 *  门面（详情页）与在线阅读（tocUrl 回退 / 子正文地址）共用这一条——书 URL 与目录地址
 *  可能是 POST 型 API 端点，裸抓带选项的 URL 会得 405；选项语义与解码仍归
 *  `assembleRequest` 与 `SourceRequest.fetchText` 两个单点。 */
export async function fetchSourceText(
  request: SourceRequest, source: NovelSource, url: string, opts?: { timeoutMs?: number },
): Promise<string> {
  const plan = assembleRequest(url, {}, source.baseUrl)
  const { text } = await request.fetchText(source, plan, opts)
  return text
}

/** 浏览器 → JAR 的单点（组合根给基础 fetcher 挂的兜底能力也走这一份）。
 *  **按 cookie 自己的域落**：浏览器 context 里可能同时有重定向前后几个域的 cookie，
 *  拿最终 URL 的 host 当缺省域会把别的域的 host-only cookie 种到最终站点上。 */
export function absorbWebviewCookies(jar: CookieJar, page: WebViewPage): void {
  for (const c of page.cookies) {
    const host = c.domain.replace(/^\./, '')
    const scheme = c.secure === true ? 'https' : 'http'
    jar.absorb(`${scheme}://${host}${c.path.startsWith('/') ? c.path : '/'}`, [setCookieOfWebviewCookie(c)])
  }
}

/** JAR → 浏览器：保留 secure/expires（只带 name/value/domain/path 会把安全持久 cookie 降级成
 *  非安全会话 cookie，回灌后可能经 http 发出）。expires 用毫秒，webview 侧转成 Playwright 的秒。 */
function browserCookiesOf(jar: CookieJar): WebViewCookie[] {
  return jar.entries().map((e) => ({
    name: e.name, value: e.value,
    // Playwright 用前导点区分域 cookie 与 host-only；CookieJar 把点剥了，这里要按 hostOnly 补回，
    // 否则域 cookie 进浏览器会退化成 host-only（子域收不到）。
    domain: e.hostOnly ? e.domain : `.${e.domain}`,
    path: e.path,
    ...(e.expires === null ? {} : { expires: e.expires }),
    ...(e.secure ? { secure: true } : {}),
  }))
}

/** 浏览器 → JAR：Playwright 的 domain 带前导点表示域 cookie，不带点是 host-only；
 *  据此决定是否写 Domain 属性，别把 host-only 一律升成域 cookie。 */
function setCookieOfWebviewCookie(c: WebViewCookie): string {
  const parts = [`${c.name}=${c.value}`, `Path=${c.path}`]
  if (c.domain.startsWith('.')) parts.push(`Domain=${c.domain}`)
  if (c.secure === true) parts.push('Secure')
  if (c.expires !== undefined && c.expires > 0) parts.push(`Expires=${new Date(c.expires).toUTCString()}`)
  return parts.join('; ')
}
