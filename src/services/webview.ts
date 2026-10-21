import { chromium } from 'playwright-core'
import type { Browser, BrowserContext } from 'playwright-core'
import { splitUserAgent } from './fetcher.js'
import { isDirectProxy, parseProxyUrl, proxyUrlWithScheme } from './proxy.js'
import { readValue, type ValueSource } from './value-source.js'

export interface WebViewOptions {
  /** 出站代理（与 fetcher 同一值源；空/direct = 直连） */
  proxyUrl?: ValueSource<string | null>
  timeoutMs?: number
  headers?: Record<string, string>
  userAgent?: string
  /** 在页面里执行的 JS；返回值作为页面正文（webJs 选项） */
  webJs?: string
  /** 进浏览器前注入的 HTTP jar cookies（浏览器 cookie 桥） */
  cookies?: WebViewCookie[]
}

export interface WebViewCookie {
  name: string
  value: string
  domain: string
  path: string
  /** 毫秒时间戳；缺省 = 会话 cookie（与 CookieJar 同口径） */
  expires?: number
  secure?: boolean
}

export interface WebViewPage {
  html: string
  finalUrl: string
  status: number
  headers: Record<string, string>
  cookies: WebViewCookie[]
}

/** 源级头的作用域：同 host 或父子域，且端口不变（http→https 与 m.→www 重定向仍带）。
 *  公共后缀表未接，与 CookieJar 同口径；第三方子资源（不同站点/端口）不带头。 */
export function sameSiteForHeaders(aUrl: string, bUrl: string): boolean {
  let a: URL
  let b: URL
  try { a = new URL(aUrl); b = new URL(bUrl) } catch { return false }
  if (a.port !== b.port) return false
  const ha = a.hostname.toLowerCase()
  const hb = b.hostname.toLowerCase()
  return ha === hb || ha.endsWith(`.${hb}`) || hb.endsWith(`.${ha}`)
}

/** Playwright 的 evaluate 没有超时参数：页面里的脚本死循环只能由外层竞速终止。 */
async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms) }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Playwright 要 server + 凭据两段；direct 判定与 scheme 补齐复用 services/proxy.ts 的单点。
 *  形状校验也走 `parseProxyUrl`：坏代理必须点名，不能静默退回直连（与 fetcher 同口径）。 */
export function proxyConfig(raw: string | null | undefined): { server: string; username?: string; password?: string } | undefined {
  if (raw === null || raw === undefined || isDirectProxy(raw)) return undefined
  const u = new URL(proxyUrlWithScheme(parseProxyUrl(raw)))
  return {
    server: `${u.protocol}//${u.host}`,
    ...(u.username === '' ? {} : { username: decodeURIComponent(u.username) }),
    ...(u.password === '' ? {} : { password: decodeURIComponent(u.password) }),
  }
}

/**
 * 真浏览器 WebView：用本机已装的 Edge/Chrome（playwright-core，不下载浏览器）。
 * `webView:true` 页面抓取与 `webJs` 页面内执行都走这里；浏览器 cookie 由 context 自管，
 * 返回给调用方以便与 HTTP jar 合并。无浏览器时如实抛错，不静默退回普通请求。
 */
export class WebViewRuntime {
  private browser: Browser | null = null
  private launching: Promise<Browser> | null = null

  constructor(private readonly opts: WebViewOptions = {}) {}

  private async launch(): Promise<Browser> {
    if (this.browser !== null) return this.browser
    if (this.launching !== null) return this.launching
    const tryLaunch = async (channel: string): Promise<Browser> =>
      chromium.launch({ channel, headless: true, args: ['--disable-dev-shm-usage', '--no-first-run'] })
    this.launching = (async () => {
      const errors: string[] = []
      for (const channel of ['msedge', 'chrome']) {
        try {
          this.browser = await tryLaunch(channel)
          return this.browser
        } catch (e) {
          errors.push(`${channel}: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`)
        }
      }
      throw new Error(`WebView 不可用：未找到可启动的 Edge/Chrome（${errors.join('；')}）`)
    })()
    try {
      return await this.launching
    } finally {
      this.launching = null
    }
  }

  async fetch(url: string, opts: WebViewOptions = {}): Promise<WebViewPage> {
    const browser = await this.launch()
    const proxy = proxyConfig(readValue(this.opts.proxyUrl ?? null))
    // UA 归 context.userAgent：塞进 extraHTTPHeaders 会被浏览器默认 UA 覆盖/并存
    const { headers: extraHeaders, userAgent: headerUserAgent } = splitUserAgent(opts.headers ?? {})
    const userAgent = opts.userAgent ?? headerUserAgent
    const context: BrowserContext = await browser.newContext({
      ...(userAgent === undefined ? {} : { userAgent }),
      ...(proxy === undefined ? {} : { proxy }),
    })
    const timeoutMs = opts.timeoutMs ?? this.opts.timeoutMs ?? 30_000
    try {
      // 源级头只随**目标站点**出站：extraHTTPHeaders 会发给页面加载的每个第三方子资源，
      // Cookie/Authorization 这类头不能这样漏。同 host/父子域（含 http→https、m.→www 重定向）
      // 才合并请求头，第三方子资源原样走。
      if (extraHeaders !== undefined && Object.keys(extraHeaders).length > 0) {
        const scoped = Object.fromEntries(
          Object.entries(extraHeaders).map(([k, v]) => [k.toLowerCase(), v]),
        )
        await context.route('**/*', async (route) => {
          const requestUrl = route.request().url()
          if (sameSiteForHeaders(requestUrl, url)) {
            await route.continue({ headers: { ...route.request().headers(), ...scoped } })
          } else {
            await route.continue()
          }
        })
      }
      if (opts.cookies !== undefined && opts.cookies.length > 0) {
        // Playwright 的 expires 是秒；本仓接口用毫秒（与 CookieJar 同口径）
        await context.addCookies(opts.cookies.map((c) => ({
          name: c.name, value: c.value, domain: c.domain, path: c.path,
          ...(c.expires === undefined ? {} : { expires: Math.floor(c.expires / 1000) }),
          ...(c.secure === true ? { secure: true } : {}),
        })))
      }
      const page = await context.newPage()
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
      let html = await page.content()
      if (opts.webJs !== undefined && opts.webJs.trim() !== '') {
        // 上游 webJs 是脚本体（常见 `return`）；用页面上下文的 Function 执行，返回值即正文。
        // evaluate 自身没有超时（页面里的死循环会一直挂住），与导航共用同一个预算。
        const value = await withTimeout(
          page.evaluate((code) => new Function(code)(), opts.webJs),
          timeoutMs,
          `webJs 执行超时 ${timeoutMs}ms：${url}`,
        )
        html = typeof value === 'string' ? value : (JSON.stringify(value) ?? '')
      }
      // 取 context 的全部 cookie（不是只看当前 URL）：重定向/脚本为其他路径设置的 cookie 也要回灌
      const cookies = await context.cookies()
      return {
        html,
        finalUrl: page.url(),
        status: response?.status() ?? 0,
        headers: response?.headers() ?? {},
        cookies: cookies.map((c) => ({
          name: c.name, value: c.value, domain: c.domain, path: c.path,
          ...(c.expires > 0 ? { expires: Math.round(c.expires * 1000) } : {}),
          ...(c.secure ? { secure: true } : {}),
        })),
      }
    } finally {
      await context.close().catch(() => undefined)
    }
  }

  async dispose(): Promise<void> {
    // 启动在途时先等它落地，否则 dispose 拿到的 browser 还是 null，启动完成后浏览器进程成孤儿
    await this.launching?.catch(() => undefined)
    const browser = this.browser
    this.browser = null
    if (browser !== null) await browser.close().catch(() => undefined)
  }
}
