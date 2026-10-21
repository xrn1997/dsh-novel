export interface CookieEntry {
  domain: string
  hostOnly: boolean
  path: string
  name: string
  value: string
  /** 毫秒时间戳；null = 会话 cookie（进程内生存） */
  expires: number | null
  secure: boolean
}

const keyOf = (domain: string, path: string, name: string): string => `${domain}\n${path}\n${name}`

function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true
  if (!requestPath.startsWith(cookiePath)) return false
  return cookiePath.endsWith('/') || requestPath[cookiePath.length] === '/'
}

function hostMatches(host: string, entry: CookieEntry): boolean {
  if (entry.hostOnly) return host === entry.domain
  return host === entry.domain || host.endsWith(`.${entry.domain}`)
}

/** 域/路径/过期/secure 的 cookie jar（RFC 6265 子集）。
 *  一张表跨源共享（上游 CookieStore 也是按域共享，两个同站源复用登录态）；脚本侧
 *  `source.cookieJar` 垫片仍按源隔离，两者不是同一张表。 */
export class CookieJar {
  private readonly store = new Map<string, CookieEntry>()

  absorb(url: string, setCookie: string[]): void {
    let parsed: URL
    try { parsed = new URL(url) } catch { return }
    const host = parsed.hostname.toLowerCase()
    for (const raw of setCookie) {
      const parts = raw.split(';').map(s => s.trim())
      if (parts.length === 0) continue
      const pair = parts[0]
      const eq = pair.indexOf('=')
      if (eq <= 0) continue
      const name = pair.slice(0, eq).trim()
      const value = pair.slice(eq + 1).trim()
      if (name === '') continue

      // 头注入防线：名字/值里的控制字符一律拒绝（Cookie 值来自站点响应，不许带 CR/LF 进请求头）
      if (/[\x00-\x1f\x7f]/.test(name) || /[\x00-\x1f\x7f]/.test(value)) continue

      let domain = host
      let hostOnly = true
      let path = '/'
      // Max-Age 与 Expires 按 RFC 6265 分开记：Max-Age 优先，且不受属性顺序影响
      // （旧实现后出现的 Expires 会覆盖先出现的 Max-Age，`Max-Age=3600; Expires=过去` 会被误删）
      let maxAgeExpires: number | null = null
      let expiresAt: number | null = null
      let domainAttr: string | null = null
      let secure = false

      for (const attr of parts.slice(1)) {
        const at = attr.indexOf('=')
        const key = (at < 0 ? attr : attr.slice(0, at)).trim().toLowerCase()
        const val = at < 0 ? '' : attr.slice(at + 1).trim()
        if (key === 'domain' && val !== '') {
          domainAttr = val.replace(/^\./, '').toLowerCase()
        } else if (key === 'path' && val !== '') {
          path = val.startsWith('/') ? val : '/'
        } else if (key === 'max-age') {
          const n = Number(val)
          if (Number.isFinite(n)) maxAgeExpires = Date.now() + n * 1000
        } else if (key === 'expires') {
          const t = Date.parse(val)
          if (Number.isFinite(t)) expiresAt = t
        } else if (key === 'secure') {
          secure = true
        }
      }
      if (domainAttr !== null) {
        // 公共后缀表没接；至少拒绝「单标签且不等于请求 host」的 Domain（`Domain=com` 会让一个源把
        // cookie 种给所有 .com 站点，而 jar 是跨源共享的）。`Domain=localhost` 这种 host 自身形态放行。
        // 多标签公共后缀（如 co.uk）仍是已知残留，记在矩阵 b-cookie-jar。
        if ((!domainAttr.includes('.') && domainAttr !== host) || /[\s\x00-\x1f\x7f]/.test(domainAttr)) continue
        domain = domainAttr
        hostOnly = false
      }
      const expires = maxAgeExpires ?? expiresAt

      if (!hostMatches(host, { domain, hostOnly, path, name, value, expires, secure })) continue
      const key = keyOf(domain, path, name)
      if (expires !== null && expires <= Date.now()) {
        this.store.delete(key)
        continue
      }
      this.store.set(key, { domain, hostOnly, path, name, value, expires, secure })
    }
  }

  headerFor(url: string): string {
    let parsed: URL
    try { parsed = new URL(url) } catch { return '' }
    const host = parsed.hostname.toLowerCase()
    const path = parsed.pathname === '' ? '/' : parsed.pathname
    const https = parsed.protocol === 'https:'
    const now = Date.now()
    const matched: CookieEntry[] = []
    for (const [key, entry] of this.store) {
      if (entry.expires !== null && entry.expires <= now) {
        this.store.delete(key)
        continue
      }
      if (!hostMatches(host, entry)) continue
      if (entry.secure && !https) continue
      if (!pathMatches(path, entry.path)) continue
      matched.push(entry)
    }
    // RFC 6265：路径长的先发；同长按创建顺序（Map 插入序，sort 稳定）——不按名字重排
    matched.sort((a, b) => b.path.length - a.path.length)
    return matched.map(e => `${e.name}=${e.value}`).join('; ')
  }

  entries(): CookieEntry[] {
    const now = Date.now()
    const out: CookieEntry[] = []
    for (const [key, entry] of this.store) {
      if (entry.expires !== null && entry.expires <= now) {
        this.store.delete(key)
        continue
      }
      out.push({ ...entry })
    }
    return out
  }

  /** CookieManager.removeSessionCookies 的口：清掉无过期时间的会话 cookie。 */
  removeSessionCookies(): void {
    for (const [key, entry] of this.store) if (entry.expires === null) this.store.delete(key)
  }
}
