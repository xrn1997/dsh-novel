import iconv from 'iconv-lite'
import { ProxyAgent } from 'undici'
import { DecodeError, FetchError } from './errors.js'
import { normalizeProxyUrl, parseProxyUrl, redactProxyUrl } from './proxy.js'
import type { NovelSource } from './types.js'
import { readValue, type ValueSource } from './value-source.js'
import type { CookieJar } from './cookies.js'
import type { SourceSession } from '../engine/index.js'

export interface FetchedPage {
  raw: Buffer
  finalUrl: string
  /** Content-Type 头原文（无则 undefined） */
  contentType: string | undefined
  /** 从 Content-Type 提取的 charset（无则 undefined） */
  charset: string | undefined
  /** HTTP 状态码。守门 fetcher 缺省对非 2xx 抛 FetchError，所以在成功返回的页里它恒为 2xx/3xx；
   *  `manual: true`（`java.head` 的重定向探测）例外——那时这一项就是要读的状态本身，可为任意码。
   *  它存在的理由是 `java.post(...).statusCode()`（响应对象要能给出这一项，缺它就只能编一个）。 */
  status: number
  /** 响应 `Set-Cookie` 头原文数组（无则空数组）——`java.post(...).cookies()` 的数据源。
   *  除脚本读取外，配置了 jar 时 fetchPage 已自动落库（见矩阵 `b-cookie-jar`）。 */
  setCookie: string[]
  /** 响应头表（小写键名）——`java.head` 的 `.headers()` 数据源；手工构造的测试页可缺省。 */
  headers?: Record<string, string>
  /** loginCheckJs 替换过正文：raw 是本仓按 UTF-8 重编码的，原始 charset 不再适用。
   *  `decodeBody` 据此忽略调用方声明的 charset（登录脚本产出的是 JS 字符串，不是站点字节）。 */
  replaced?: boolean
}

export interface FetcherOptions {
  fetchImpl?: typeof globalThis.fetch
  timeoutMs?: number
  /** 出站代理（见 services/proxy.ts：Node 的 fetch 不读系统代理）；null / '' / direct = 直连。
   *  可以是活 getter——每次请求前读当前值，配置页改了代理不必重建 fetcher。 */
  proxyUrl?: ValueSource<string | null>
  /** 域/路径感知的 cookie jar（跨源共享，上游 CookieStore 同粒度）：请求缺省带同一 host/path
   *  的 cookie，响应 Set-Cookie 自动落库。显式 Cookie 头优先（源规则/auth 合并后的头照旧占优）。
   *  jar 在构造时给；门面只读不再写回（见 reading.from）。 */
  cookieJar?: CookieJar
  /** 宿主设备 ID（androidId 的稳定替代）；由构造方给，门面不再写回 */
  deviceId?: string
  /** 源级状态会话；由构造方给，门面不再写回 */
  sourceSession?: SourceSession
}

/** 一次抓取的 init 形状：接口与实现共用这一份，新增字段不再需要两处同步。 */
export interface FetchInit {
  headers?: Record<string, string>
  method?: string
  body?: string
  /** 本次调用的超时覆盖（缺省 = createFetcher 的 timeoutMs）；超时 abort + FetchError */
  timeoutMs?: number
  /** HEAD 探测姿态：redirect:'manual' 且非 2xx 不抛——要的就是 3xx 的状态与头（`java.head`） */
  manual?: boolean
  /** 不跟重定向但 >=400 仍抛（`java.get` 的 jsoup followRedirects(false) 口径） */
  noFollow?: boolean
  /** 规则 URL 选项声明的 charset（`fetchInitOf` 带入；loginCheckJs 读原页时按它解码） */
  declaredCharset?: string
  /** 非 2xx 的额外重试次数（只重拿到响应的 HTTP 错；连接/超时不重） */
  retry?: number
  /** 真浏览器抓取（由源级 fetcher 外观消费；基础 fetcher 忽略） */
  webView?: boolean
  webJs?: string
  /** 非 2xx 也返回页面（源请求缝给 loginCheck 看 403/503 正文；未替换时由该缝补抛） */
  allowError?: boolean
}

export interface Fetcher {
  /** 真浏览器能力（源级外观/组合根可挂；引擎 `@webjs:` 从它取 evalWebJs） */
  webview?: {
    fetch(url: string, opts?: { webJs?: string }): Promise<{ html: string }>
  }
  /** 宿主设备 ID（androidId 的稳定替代；数据根 device-id 生成一次） */
  deviceId?: string
  /** 源级状态会话（可落盘；引擎脚本从 EvalContext.session 取） */
  sourceSession?: SourceSession
  /** 域/路径感知的 HTTP cookie jar（引擎脚本经 Packages CookieManager/CookieStore 读写同一张表） */
  cookieJar?: CookieJar
  fetchPage(url: string, init?: FetchInit): Promise<FetchedPage>
  /** 关掉当前出站 dispatcher（代理连接池）。卸载时调用；之后再抓取会按当前 proxyUrl 重建。 */
  dispose?(): void
}

/** fetch 的 init 加上 undici 扩展位（dispatcher）——标准 lib.dom 类型里没有这个键 */
type FetchImplInit = RequestInit & { dispatcher?: unknown }
type FetchLike = (url: string, init?: FetchImplInit) => Promise<Response>

/** 出站默认耐心（缺省 15s）。**这个数是唯一主人**：缺省装配处 `src/config.ts` 的 schema `.default()`
 *  与 reading.from() 的回退都引它——多请求目录脚本一轮要连打数个请求，窄超时必炸，缺省给得比一般 HTTP 客户端宽。 */
export const DEFAULT_TIMEOUT_MS = 15_000
const CHARSET_RE = /charset=([^;\s"']+)/i
/** 嗅探用：`<meta charset=…>`（HTML5）与 `<meta http-equiv content="…charset=…">`（遗留形态） */
const META_CHARSET_RE = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i
const META_CONTENT_CHARSET_RE = /<meta[^>]+content\s*=\s*["'][^"']*charset=([\w-]+)/i

/** 缺省请求头：Node fetch 默认不带 User-Agent——站点 WAF 按 UA 过滤直接 403。
 *  带浏览器 UA 是常态；调用方显式声明的同名头永远优先。 */
const DEFAULT_HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
}

/** User-Agent 归 context.userAgent：塞进 extraHTTPHeaders 会被浏览器默认 UA 覆盖/并存。
 *  请求头拆分归这一处——源请求缝与 WebView 都读同一份判据。 */
export function splitUserAgent(headers: Record<string, string>): { headers: Record<string, string>; userAgent?: string } {
  const out: Record<string, string> = {}
  let userAgent: string | undefined
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === 'user-agent') userAgent = v
    else out[k] = v
  }
  return userAgent === undefined ? { headers: out } : { headers: out, userAgent }
}

/**
 * 本源**实际发出去**的 User-Agent：源静态头 / auth 头覆盖 → 缺省 UA 打底。
 * **大小写不敏感**（HTTP 头名本就不敏感）：`user-agent` 与 `User-Agent` 是同一条头，
 * 只按原样查键会让声明了小写形态的源被误报成缺省 UA。
 * 唯一消费者是 `java.getWebViewUA()` 的 ctx 接线（本仓以"我们真发的这条"承接
 * 「浏览器默认 UA」的语义；见矩阵 `h-java-webview-ua`）。同步取值，不含 `@js:` 动态头——那是 fetch 时才算的，
 * 脚本要的通常是"给我一个能用的 UA"，不是"给我一个和下一个请求逐字节一致的头"。
 */
export function effectiveUserAgent(source: Pick<NovelSource, 'rules' | 'auth'>): string {
  const { userAgent } = splitUserAgent(headerOf(source))
  return userAgent ?? DEFAULT_HEADERS['User-Agent'] ?? ''
}

/**
 * 出站头合并单点：缺省头打底，调用方声明同名头时**按大小写不敏感的同一性覆盖**。
 * 裸 `{...DEFAULT_HEADERS, ...init}` 会让 `user-agent` 与缺省 `User-Agent` 并存，undici 把重名
 * 合成一条 `"默认, 源"` 的畸形头（本机实测：服务端收到 `user-agent: "DEFAULT, SOURCE"`），
 * 源声明的 UA / Accept 就此失效——比覆盖更坏。同表内的重名（如 auth 声明的 `cookie`）同样归并。
 */
function mergeHeaders(init?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = { ...DEFAULT_HEADERS }
  for (const [k, v] of Object.entries(init ?? {})) {
    for (const key of Object.keys(out)) {
      if (key !== k && key.toLowerCase() === k.toLowerCase()) delete out[key]
    }
    out[k] = v
  }
  return out
}

/**
 * 守门抓取器：唯一出站口。超时/网络层失败/HTTP 非 2xx 分别类型化为 FetchError，
 * 绝不把未分类异常漏给上层。`allowError` 是源请求缝给 loginCheckJs 看错误页的窄例外：
 * 最终错误页由该缝在脚本未替换时补抛（manual 的 HEAD 探测另有放行语义）。
 */
export function createFetcher(opts?: FetcherOptions): Fetcher {
  const fetchImpl = (opts?.fetchImpl ?? globalThis.fetch) as FetchLike
  const defaultTimeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  // 代理走 undici 的 ProxyAgent（dispatcher）：Node 的 fetch 不认系统代理，有代理才通的站点
  // 直连会被站点 302/重置——「浏览器能开、插件打不开」的根因。
  // 配置页可在运行中改 proxyUrl，所以每请求重读、**按 URL 复用**：同 URL 重建等于每次抓取
  // 丢掉代理连接池；换 URL 必须关旧，否则旧代理的连接池常驻到进程退出。
  let lastProxy: string | null | undefined
  let dispatcher: ProxyAgent | undefined
  const currentDispatcher = (): ProxyAgent | undefined => {
    const next = normalizeProxyUrl(readValue(opts?.proxyUrl ?? null))
    if (next === lastProxy) return dispatcher
    const previous = dispatcher
    dispatcher = undefined
    // 旧实例一关，缓存键必须同时作废：否则「A 通 → B 坏 → 换回 A」时，A 会被当成「未变化的当前值」，
    // 请求拿到 undefined 的 dispatcher 静默走直连——代理恰是直连不通时的刚需，悄悄换路比炸更难查。
    lastProxy = undefined
    if (previous !== undefined) void previous.close().catch(() => undefined)
    if (next === null) {
      lastProxy = null
      return undefined
    }
    try {
      dispatcher = new ProxyAgent(parseProxyUrl(next))
    } catch (e) {
      // 坏地址成 FetchError 而不是裸 TypeError；回显整体先脱敏——userinfo 里的密码不许进日志
      //（错误对象常被整个交给 logger，url 字段是同一回声面；内层文案也可能带着原始地址）。
      const shown = redactProxyUrl(next)
      const detail = e instanceof Error ? e.message : String(e)
      throw new FetchError(`代理地址非法: ${shown}（${redactProxyUrl(detail)}）`, { url: shown })
    }
    // 缓存键只在构建成功后落地：失败不记账，坏地址才会每次都炸，而不是被当成「当前值」静默直连。
    lastProxy = next
    return dispatcher
  }

  // jar / deviceId / sourceSession 走**对象字段**而不是建厂闭包：脚本面与请求面必须读到同一实例
  //（jar 还要求构造方与门面给的是同一张，见 reading.from）。
  const api: Fetcher = {
    ...(opts?.cookieJar === undefined ? {} : { cookieJar: opts.cookieJar }),
    ...(opts?.deviceId === undefined ? {} : { deviceId: opts.deviceId }),
    ...(opts?.sourceSession === undefined ? {} : { sourceSession: opts.sourceSession }),
    async fetchPage(url: string, init?: FetchInit): Promise<FetchedPage> {
      const timeoutMs = init?.timeoutMs ?? defaultTimeoutMs
      const activeDispatcher = currentDispatcher()
      const attempts = Math.max(0, Math.floor(init?.retry ?? 0))
      for (let attempt = 0; ; attempt++) {
        const ctrl = new AbortController()
        let timer: ReturnType<typeof setTimeout> | undefined
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            ctrl.abort()
            reject(new FetchError(`请求超时 ${timeoutMs}ms: ${url}`, { url }))
          }, timeoutMs)
        })
        try {
          const outHeaders = mergeHeaders(init?.headers)
          if (api.cookieJar !== undefined && !Object.keys(outHeaders).some(k => k.toLowerCase() === 'cookie')) {
            const cookie = api.cookieJar.headerFor(url)
            if (cookie !== '') outHeaders.Cookie = cookie
          }
          const res = await Promise.race([
            fetchImpl(url, {
              headers: outHeaders,
              ...(init?.method === undefined ? {} : { method: init.method }),
              ...(init?.body === undefined ? {} : { body: init.body }),
              ...(init?.manual === true || init?.noFollow === true ? { redirect: 'manual' as const } : {}),
              signal: ctrl.signal,
              ...(activeDispatcher === undefined ? {} : { dispatcher: activeDispatcher }),
            }),
            timeout,
          ])
          // 守门口径：缺省非 2xx 即 FetchError；manual（HEAD 探测——看的就是 3xx 的 Location）放行；
          // noFollow（java.get）只放行 3xx，>=400 照 jsoup 的 execute() 抛；allowError 把最终错误页
          // 交给 loginCheckJs 先看正文，补抛由源请求缝在「脚本没替换」时做。
          const failed = init?.manual === true ? false : init?.noFollow === true ? res.status >= 400 : !res.ok
          if (failed) {
            if (attempt < attempts) continue
            if (init?.allowError !== true) {
              throw new FetchError(`请求失败 ${res.status}: ${url}`, { url, status: res.status })
            }
          }
          const contentType = res.headers.get('content-type') ?? undefined
          const charset = contentType?.match(CHARSET_RE)?.[1]?.toLowerCase()
          const setCookie = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []
          const finalUrl = res.url || url
          api.cookieJar?.absorb(finalUrl, setCookie)
          return {
            raw: Buffer.from(await res.arrayBuffer()),
            finalUrl,
            contentType,
            charset,
            status: res.status,
            setCookie,
            headers: Object.fromEntries(res.headers.entries()),
          }
        } catch (e) {
          if (e instanceof FetchError) {
            // 上游 retry 只作用于「拿到响应但状态码不成功」；无 status 的网络/超时错直接抛
            if (e.status !== undefined && attempt < attempts) continue
            throw e
          }
          // fetchImpl 遵从 signal 中止时也会走到这里，同按超时归类
          if (e instanceof Error && e.name === 'AbortError') {
            throw new FetchError(`请求超时 ${timeoutMs}ms: ${url}`, { url })
          }
          throw new FetchError(`网络错误: ${url}（${String(e)}）`, { url })
        } finally {
          if (timer !== undefined) clearTimeout(timer)
        }
      }
    },
    dispose() {
      const previous = dispatcher
      dispatcher = undefined
      // 作废缓存键：dispose 之后调用方若还在抓取，要按当前值重建而不是复用已关闭的实例。
      lastProxy = undefined
      // close 的拒绝在拆除路径上不可处理（连接池已不归任何人），吞掉只为不让它变成 unhandled rejection。
      if (previous !== undefined) void previous.close().catch(() => undefined)
    },
  }
  return api
}

/**
 * Buffer 层显式解码链（禁默认 UTF-8 硬解）：
 * ⓪ 声明覆盖（searchUrl 选项 charset，优先级最高）→
 * ① Content-Type charset → ② 缺位且内容（去 BOM/前导空白后）是 HTML/XML 开头 → 前 1024 字节 latin1 嗅探 meta
 * → ③ 兜底 UTF-8。声明的 charset 解不出 → DecodeError（宁可报错，不拿乱码冒充正文）。
 */
export function decodeBody(page: FetchedPage, declaredCharset?: string): string {
  // 空串声明（`charset=` 空值，真实源存在）视为缺位，走后续嗅探链而不是必炸。
  // 被 loginCheck 替换过的正文是按 UTF-8 重编码的，声明的 charset（如 GBK 源）对它不成立——
  // 用声明值解会把替换正文解成乱码；此时按 page.charset（替换时置 utf-8）走。
  const declared = page.replaced === true ? undefined : declaredCharset
  const cs = nonEmpty(declared) ?? nonEmpty(page.charset) ?? sniffCharset(page.raw)
  if (!iconv.encodingExists(cs)) {
    throw new DecodeError(`无法解码 charset=${cs}: ${page.finalUrl}`, { url: page.finalUrl, charset: cs })
  }
  return iconv.decode(page.raw, cs)
}

/**
 * 抓取 + 解码 + 落地地址的单点；调用方只学这一个入口；charset 为选项声明的解码优先级。
 * 超时收口在 fetcher 自身（曾在这里再竞速一个**不 abort** 的定时器，两套超时并存、文案相同）。
 */
export async function fetchTextPage(
  fetcher: Fetcher, url: string,
  init: FetchInit,
  declaredCharset?: string,
): Promise<{ text: string; landedUrl: string }> {
  const page = await fetcher.fetchPage(url, init)
  return { text: decodeBody(page, declaredCharset), landedUrl: page.finalUrl }
}

function nonEmpty(s: string | undefined): string | undefined {
  return s === undefined || s.trim() === '' ? undefined : s.trim()
}

function sniffCharset(raw: Buffer): string {
  const head = stripBom(raw).toString('latin1').trimStart().toLowerCase()
  if (
    head.startsWith('<!doctype') ||
    head.startsWith('<html') ||
    head.startsWith('<head') ||
    head.startsWith('<?xml')
  ) {
    const probe = raw.subarray(0, 1024).toString('latin1')
    const hit = probe.match(META_CHARSET_RE)?.[1] ?? probe.match(META_CONTENT_CHARSET_RE)?.[1]
    if (hit !== undefined) return hit.toLowerCase()
  }
  return 'utf-8'
}

function stripBom(buf: Buffer): Buffer {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3)
  if (buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))) {
    return buf.subarray(2)
  }
  return buf
}

/**
 * 出站请求头合并：源静态 rules.header 打底 → 非 expired 的 auth.headers 覆盖同名
 * → Cookie 段合并（静态 Cookie 按段收集去重，auth.cookies 名占优、在后）。
 */
export function headerOf(source: Pick<NovelSource, 'rules' | 'auth'>): Record<string, string> {
  const out: Record<string, string> = { ...source.rules.header }
  const auth = source.auth !== undefined && !source.auth.expired ? source.auth : undefined
  if (auth?.headers !== undefined) {
    for (const [k, v] of Object.entries(auth.headers)) out[k] = v
  }

  const authCookies = auth?.cookies ?? {}
  const segs: string[] = []
  const seen = new Set<string>()
  const staticCookie = out.Cookie
  if (staticCookie !== undefined) {
    for (const seg of staticCookie.split(';')) {
      const trimmed = seg.trim()
      if (trimmed === '') continue
      const eq = trimmed.indexOf('=')
      const name = (eq >= 0 ? trimmed.slice(0, eq) : trimmed).trim()
      if (name in authCookies || seen.has(name)) continue // auth 名占优；静态同名段丢弃
      seen.add(name)
      segs.push(trimmed)
    }
  }
  for (const [k, v] of Object.entries(authCookies)) segs.push(`${k}=${v}`)
  if (segs.length > 0) out.Cookie = segs.join('; ')
  return out
}
