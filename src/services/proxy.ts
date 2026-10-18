import { execFile } from 'node:child_process'

/**
 * 出站代理（系统代理/环境变量的实用子集）。
 *
 * 为什么需要：本插件用 Node 的 fetch（undici）出站，而 **undici 不读系统代理**——WinINET/浏览器
 * 代理设置对它完全无效。于是「浏览器能开、读者打不开」这类型错位就出现了：实测有站对直连的
 * 外网出口一律 302 跳走，走本机代理即 200 真实章节页；表现为本插件里的「网络错误」或「正文零命中」。
 *
 * 取值优先级：`config.proxyUrl`（显式）> 环境变量 HTTPS_PROXY/HTTP_PROXY/ALL_PROXY
 * > Windows 系统代理（HKCU…Internet Settings，ProxyEnable=1 时取 ProxyServer）> 直连。
 * `proxyUrl: 'direct'` 显式直连（不想被系统代理接管时用）。
 *
 * 判定/归一都是纯函数（可单测），只有读注册表是薄壳。
 */

/** 归一 ProxyServer 串：`127.0.0.1:7897` / `http=…;https=…` / 已带 scheme 原样 → URL 串或 null */
export function normalizeProxyServer(raw: string): string | null {
  const text = raw.trim()
  if (text === '') return null
  if (text.includes('=')) {                       // 分协议形态（IE/系统代理常见）：优先 https=，退化 http=
    const parts = new Map<string, string>()
    for (const seg of text.split(';')) {
      const eq = seg.indexOf('=')
      if (eq <= 0) continue
      parts.set(seg.slice(0, eq).trim().toLowerCase(), seg.slice(eq + 1).trim())
    }
    const picked = parts.get('https') ?? parts.get('http')
    return picked === undefined || picked === '' ? null : proxyUrlWithScheme(picked)
  }
  return proxyUrlWithScheme(text)
}

/** 环境变量形态（大小写两形态都认，首个非空者胜） */
export function proxyFromEnv(env: Record<string, string | undefined>): string | null {
  for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) {
    const v = env[key]?.trim()
    if (v !== undefined && v !== '') return proxyUrlWithScheme(v)
  }
  return null
}

/** 优先级收口（纯函数）：config 显式 > 环境变量 > 系统代理 > 直连（null） */
export function resolveProxyUrl(opts: {
  configProxy?: string
  env: Record<string, string | undefined>
  systemProxy: string | null
}): string | null {
  const configured = opts.configProxy?.trim()
  if (configured !== undefined && configured !== '') {
    return isDirectProxy(configured) ? null : proxyUrlWithScheme(configured)
  }
  return proxyFromEnv(opts.env) ?? opts.systemProxy
}

/** 报错回显前的脱敏：代理 URL 的 userinfo（`user:pass@`）常带密码，校验错误若原样回显，
 *  一次配置笔误就让密码进日志。折到**最后一个** `@`：密码里带 `/` 时 authority 边界的首个 `/`
 *  会把唯一的 `@` 挡在边界外（`http://user:pa/ss@host` 正是这种），按边界切就整串漏出；
 *  query 里带 `@` 的地址会被多遮一段——报错路径上宁可多遮。 */
export function redactProxyUrl(raw: string): string {
  const scheme = /^[a-z][\w+.-]*:\/\//i.exec(raw)
  const start = scheme === null ? 0 : scheme[0].length
  const at = raw.lastIndexOf('@')
  return at < start ? raw : `${raw.slice(0, start)}***@${raw.slice(at + 1)}`
}

/** 补 scheme 的唯一实现：undici 的 ProxyAgent 只认带 scheme 的 URL，而配置页 schema / 环境变量 /
 *  系统代理都可能给出裸 host:port——裸值直接进构造器就是 `Invalid URL`，补齐只许住这一处。 */
export function proxyUrlWithScheme(raw: string): string {
  const text = raw.trim()
  return /^[a-z][\w+.-]*:\/\//i.test(text) ? text : `http://${text}`
}

/** 「不走代理」的唯一判据：null / 空白 / `direct`（大小写与首尾空白都不敏感）。配置页可能写
 *  `' direct '`，漏掉首尾空白就会把 `direct` 当地址交给 ProxyAgent 而炸。 */
export function isDirectProxy(raw: string | null | undefined): boolean {
  if (raw === null || raw === undefined) return true
  const text = raw.trim()
  return text === '' || text.toLowerCase() === 'direct'
}

/** 出站代理值 → 可直接建 ProxyAgent 的 URL（或 null = 直连）。这是 fetcher 每请求的前置归一：
 *  getter 的读数在运行中会变，直连标记与裸 host:port 都得在构造器之前收口。 */
export function normalizeProxyUrl(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null
  return isDirectProxy(raw) ? null : proxyUrlWithScheme(raw)
}

/** 建 dispatcher 前的代理形状闸：空串与 direct 放行；其余按 http(s) URL 解析（裸 host:port 补 http:// 再验）。
 *  比 schema 的段级 pattern 更严——`http://user:pa/ss@host` 这类 schema 放行的串在这里才被 URL 解析否掉。 */
export function parseProxyUrl(raw: string): string {
  const text = raw.trim()
  if (isDirectProxy(text)) return text
  const candidate = proxyUrlWithScheme(text)
  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    throw new TypeError(`代理地址非法: ${redactProxyUrl(raw)}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError(`代理地址只支持 http(s): ${redactProxyUrl(raw)}`)
  }
  if (parsed.hostname === '') throw new TypeError(`代理地址缺少主机: ${redactProxyUrl(raw)}`)
  return text
}

/** Windows 系统代理（注册表）：非 win32 / ProxyEnable≠1 / 读不到 → null */
export async function readSystemProxy(): Promise<string | null> {
  if (process.platform !== 'win32') return null
  const out = await runReg(['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'])
  if (out === null) return null
  if (!/ProxyEnable\s+REG_DWORD\s+0x1/i.test(out)) return null
  const matched = /ProxyServer\s+REG_SZ\s+(.+)/i.exec(out)
  return matched === null ? null : normalizeProxyServer(matched[1].trim())
}

function runReg(args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('reg', args, { windowsHide: true, timeout: 3000 }, (err, stdout) => {
      resolve(err ? null : stdout)
    })
  })
}
