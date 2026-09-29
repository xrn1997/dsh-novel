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
    return picked === undefined || picked === '' ? null : withScheme(picked)
  }
  return withScheme(text)
}

/** 环境变量形态（大小写两形态都认，首个非空者胜） */
export function proxyFromEnv(env: Record<string, string | undefined>): string | null {
  for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) {
    const v = env[key]?.trim()
    if (v !== undefined && v !== '') return withScheme(v)
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
    return configured.toLowerCase() === 'direct' ? null : withScheme(configured)
  }
  return proxyFromEnv(opts.env) ?? opts.systemProxy
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

function withScheme(hostPort: string): string {
  return /^[a-z][\w+.-]*:\/\//i.test(hostPort) ? hostPort : `http://${hostPort}`
}

function runReg(args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('reg', args, { windowsHide: true, timeout: 3000 }, (err, stdout) => {
      resolve(err ? null : stdout)
    })
  })
}
