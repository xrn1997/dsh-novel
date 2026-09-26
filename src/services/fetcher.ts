import iconv from 'iconv-lite'
import { ProxyAgent } from 'undici'
import { DecodeError, FetchError } from './errors.js'
import type { NovelSource } from './types.js'

export interface FetchedPage {
  raw: Buffer
  finalUrl: string
  /** Content-Type 头原文（无则 undefined） */
  contentType: string | undefined
  /** 从 Content-Type 提取的 charset（无则 undefined） */
  charset: string | undefined
  /** HTTP 状态码。守门 fetcher 对非 2xx 抛 FetchError，所以在成功返回的页里它恒为 2xx/3xx；
   *  它存在的理由是 `java.post(...).statusCode()`（响应对象要能给出这一项，缺它就只能编一个）。 */
  status: number
  /** 响应 `Set-Cookie` 头原文数组（无则空数组）——`java.post(...).cookies()` 的数据源。
   *  本仓**不**实现 cookie jar 自动回带（见矩阵 `b-cookie-jar`）：这里只给脚本自己读。 */
  setCookie: string[]
}

export interface FetcherOptions {
  fetchImpl?: typeof globalThis.fetch
  timeoutMs?: number
  /** 出站代理（见 services/proxy.ts：Node 的 fetch 不读系统代理）；null/缺省 = 直连 */
  proxyUrl?: string | null
}

export interface Fetcher {
  fetchPage(url: string, init?: {
    headers?: Record<string, string>; method?: string; body?: string
    /** 本次调用的超时覆盖（缺省 = createFetcher 的 timeoutMs）；超时 abort + FetchError */
    timeoutMs?: number
  }): Promise<FetchedPage>
}

/** fetch 的 init 加上 undici 扩展位（dispatcher）——标准 lib.dom 类型里没有这个键 */
type FetchInit = RequestInit & { dispatcher?: unknown }
type FetchLike = (url: string, init?: FetchInit) => Promise<Response>

const DEFAULT_TIMEOUT_MS = 15000
const CHARSET_RE = /charset=([^;\s"']+)/i
/** 嗅探用：`<meta charset=…>`（HTML5）与 `<meta http-equiv content="…charset=…">`（遗留形态） */
const META_CHARSET_RE = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i
const META_CONTENT_CHARSET_RE = /<meta[^>]+content\s*=\s*["'][^"']*charset=([\w-]+)/i

/** 缺省请求头：Node fetch 默认不带 User-Agent——站点 WAF 按 UA 过滤直接 403（实测 26 源）。
 *  带浏览器 UA 是常态；调用方显式声明的同名头永远优先。 */
const DEFAULT_HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
}

/**
 * 本源**实际发出去**的 User-Agent：源静态头 / auth 头覆盖 → 缺省 UA 打底。
 * **大小写不敏感**（HTTP 头名本就不敏感）：`user-agent` 与 `User-Agent` 是同一条头，
 * 只按原样查键会让声明了小写形态的源（现库 2/214）被误报成缺省 UA。
 * 唯一消费者是 `java.getWebViewUA()` 的 ctx 接线（本仓以"我们真发的这条"承接
 * 「浏览器默认 UA」的语义；见矩阵 `h-java-webview-ua`）。同步取值，不含 `@js:` 动态头——那是 fetch 时才算的，
 * 脚本要的通常是"给我一个能用的 UA"，不是"给我一个和下一个请求逐字节一致的头"。
 */
export function effectiveUserAgent(source: Pick<NovelSource, 'rules' | 'auth'>): string {
  for (const [k, v] of Object.entries(headerOf(source))) {
    if (k.toLowerCase() === 'user-agent') return v
  }
  return DEFAULT_HEADERS['User-Agent'] ?? ''
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
 * 绝不把未分类异常漏给上层。
 */
export function createFetcher(opts?: FetcherOptions): Fetcher {
  const fetchImpl = (opts?.fetchImpl ?? globalThis.fetch) as FetchLike
  const defaultTimeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  // 代理走 undici 的 ProxyAgent（dispatcher）：Node 的 fetch 不认系统代理，有代理才通的站点
  // 直连会被站点 302/重置（实测笔趣阁）——浏览器能开、读者打不开的根因
  const dispatcher = opts?.proxyUrl === undefined || opts?.proxyUrl === null || opts.proxyUrl === ''
    ? undefined
    : new ProxyAgent(opts.proxyUrl)

  return {
    async fetchPage(url: string, init?: {
      headers?: Record<string, string>; method?: string; body?: string; timeoutMs?: number
    }): Promise<FetchedPage> {
      const timeoutMs = init?.timeoutMs ?? defaultTimeoutMs
      const ctrl = new AbortController()
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          ctrl.abort()
          reject(new FetchError(`请求超时 ${timeoutMs}ms: ${url}`, { url }))
        }, timeoutMs)
      })
      try {
        const res = await Promise.race([
          fetchImpl(url, {
            headers: mergeHeaders(init?.headers),
            ...(init?.method === undefined ? {} : { method: init.method }),
            ...(init?.body === undefined ? {} : { body: init.body }),
            signal: ctrl.signal,
            ...(dispatcher === undefined ? {} : { dispatcher }),
          }),
          timeout,
        ])
        if (!res.ok) {
          throw new FetchError(`请求失败 ${res.status}: ${url}`, { url, status: res.status })
        }
        const contentType = res.headers.get('content-type') ?? undefined
        const charset = contentType?.match(CHARSET_RE)?.[1]?.toLowerCase()
        return {
          raw: Buffer.from(await res.arrayBuffer()),
          finalUrl: res.url || url,
          contentType,
          charset,
          status: res.status,
          setCookie: typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [],
        }
      } catch (e) {
        if (e instanceof FetchError) throw e
        // fetchImpl 遵从 signal 中止时也会走到这里，同按超时归类
        if (e instanceof Error && e.name === 'AbortError') {
          throw new FetchError(`请求超时 ${timeoutMs}ms: ${url}`, { url })
        }
        throw new FetchError(`网络错误: ${url}（${String(e)}）`, { url })
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
    },
  }
}

/**
 * Buffer 层显式解码链（禁默认 UTF-8 硬解）：
 * ⓪ 声明覆盖（searchUrl 选项 charset，优先级最高）→
 * ① Content-Type charset → ② 缺位且内容（去 BOM/前导空白后）是 HTML/XML 开头 → 前 1024 字节 latin1 嗅探 meta
 * → ③ 兜底 UTF-8。声明的 charset 解不出 → DecodeError（宁可报错，不拿乱码冒充正文）。
 */
export function decodeBody(page: FetchedPage, declaredCharset?: string): string {
  // 空串声明（`charset=` 空值，真实源存在）视为缺位，走后续嗅探链而不是必炸
  const cs = nonEmpty(declaredCharset) ?? nonEmpty(page.charset) ?? sniffCharset(page.raw)
  if (!iconv.encodingExists(cs)) {
    throw new DecodeError(`无法解码 charset=${cs}: ${page.finalUrl}`, { url: page.finalUrl, charset: cs })
  }
  return iconv.decode(page.raw, cs)
}

/**
 * 抓取 + 解码 + 落地地址的单点（原 search-face.fetchTimed 迁入，超时改由 fetcher 自身收口——
 * 此前 fetchTimed 在 fetcher 之外再竞速一个**不 abort** 的定时器，与 fetcher 内部超时并存两套，
 * 错误文案却一字不差）。调用方只学这一个入口；charset 为选项声明的解码优先级。
 */
export async function fetchTextPage(
  fetcher: Fetcher, url: string,
  init: { headers?: Record<string, string>; method?: string; body?: string; timeoutMs?: number },
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
