import { describe, expect, it } from 'vitest'
import {
  isDirectProxy, normalizeProxyServer, normalizeProxyUrl, parseProxyUrl, proxyFromEnv, proxyUrlWithScheme,
  redactProxyUrl, resolveProxyUrl,
} from '../../src/services/proxy.js'

describe('normalizeProxyServer（系统/环境代理串归一）', () => {
  it('host:port → 补 http://', () => {
    expect(normalizeProxyServer('127.0.0.1:7897')).toBe('http://127.0.0.1:7897')
  })
  it('分协议形态取 https= 优先，退化 http=', () => {
    expect(normalizeProxyServer('http=1.2.3.4:8080;https=1.2.3.4:8443')).toBe('http://1.2.3.4:8443')
    expect(normalizeProxyServer('http=1.2.3.4:8080')).toBe('http://1.2.3.4:8080')
  })
  it('已带 scheme 原样保留（socks5 等交给 undici 判）', () => {
    expect(normalizeProxyServer('socks5://127.0.0.1:1080')).toBe('socks5://127.0.0.1:1080')
  })
  it('空串 / 无 http(s) 段 → null', () => {
    expect(normalizeProxyServer('   ')).toBeNull()
    expect(normalizeProxyServer('ftp=1.2.3.4:21')).toBeNull()
  })
})

describe('proxyFromEnv（环境变量形态）', () => {
  it('HTTPS_PROXY 优先，大小写两形态都认，ALL_PROXY 兜底', () => {
    expect(proxyFromEnv({ HTTPS_PROXY: 'http://a:1', HTTP_PROXY: 'http://b:2' })).toBe('http://a:1')
    expect(proxyFromEnv({ https_proxy: '127.0.0.1:7897' })).toBe('http://127.0.0.1:7897')
    expect(proxyFromEnv({ ALL_PROXY: 'http://c:3' })).toBe('http://c:3')
  })
  it('空环境 → null', () => {
    expect(proxyFromEnv({})).toBeNull()
  })
})

describe('resolveProxyUrl（优先级收口：config > 环境变量 > 系统代理 > 直连）', () => {
  const env = { HTTPS_PROXY: 'http://env:1' }
  it('三级依次生效', () => {
    expect(resolveProxyUrl({ configProxy: 'http://cfg:9', env, systemProxy: 'http://sys:3' })).toBe('http://cfg:9')
    expect(resolveProxyUrl({ env, systemProxy: 'http://sys:3' })).toBe('http://env:1')
    expect(resolveProxyUrl({ env: {}, systemProxy: 'http://sys:3' })).toBe('http://sys:3')
  })
  it("config 'direct' 强制直连（压过环境变量与系统代理）", () => {
    expect(resolveProxyUrl({ configProxy: 'direct', env, systemProxy: 'http://sys:3' })).toBeNull()
  })
  it('都没有 → null（直连）', () => {
    expect(resolveProxyUrl({ env: {}, systemProxy: null })).toBeNull()
  })
})

/** 抛错文案：形状闸该炸却没炸时立刻红，别让「没抛」冒充「文案干净」 */
function messageOf(fn: () => void): string {
  try {
    fn()
  } catch (e) {
    return (e as Error).message
  }
  throw new Error('期望抛出，实际没有')
}

describe('parseProxyUrl（配置/写回前的形状闸）', () => {
  it('空串 / direct / 裸主机 / http(s) 接受', () => {
    expect(parseProxyUrl('')).toBe('')
    expect(parseProxyUrl(' direct ')).toBe('direct')
    expect(parseProxyUrl('127.0.0.1:7897')).toBe('127.0.0.1:7897')
    expect(parseProxyUrl('http://127.0.0.1:7897')).toBe('http://127.0.0.1:7897')
    expect(parseProxyUrl('https://proxy.example.com:443')).toBe('https://proxy.example.com:443')
  })
  it('坏串 / 非 http(s) 协议拒绝', () => {
    expect(() => parseProxyUrl('http://bad host')).toThrow(/代理地址非法/)
    expect(() => parseProxyUrl('ftp://127.0.0.1:21')).toThrow(/只支持 http\(s\)/)
    expect(() => parseProxyUrl('http://')).toThrow(/代理地址非法/)
  })
  it('坏地址回显脱敏：userinfo 密码不进报错文案', () => {
    for (const bad of ['http://user:s3cret@bad host', 'ftp://user:s3cret@127.0.0.1:21']) {
      const message = messageOf(() => parseProxyUrl(bad))
      expect(message).toContain('***@')
      expect(message).not.toContain('s3cret')
    }
    expect(messageOf(() => parseProxyUrl('http://user:pass@bad host'))).not.toContain('pass')
    expect(redactProxyUrl('http://user:pass@host:8080/x')).toBe('http://***@host:8080/x')
    expect(redactProxyUrl('user:pass@host:8080')).toBe('***@host:8080')
    expect(redactProxyUrl('http://host:8080/x')).toBe('http://host:8080/x')
  })
  it('密码里带 / 的 schema 可达形态也要脱敏（authority 边界的首个 / 不能当终点）', () => {
    // config schema 放行 `http://user:pa/ss@host` / `user:pa/ss@host`，而它们解析必炸；
    // 按「scheme 后首个 / 之前找 @」切会把唯一的 @ 挡在边界外，整串原样回显——密码进日志。
    for (const bad of ['http://user:pa/ss@host', 'user:pa/ss@host']) {
      const message = messageOf(() => parseProxyUrl(bad))
      expect(message).toContain('***@')
      expect(message).not.toContain('pa/ss')
      expect(message).not.toContain('user:pa')
    }
  })
})

describe('redactProxyUrl（报错回显前的脱敏）', () => {
  it('遮到最后一个 @：斜杠密码不因 authority 边界漏出', () => {
    expect(redactProxyUrl('http://user:pa/ss@host')).toBe('http://***@host')
    expect(redactProxyUrl('user:pa/ss@host')).toBe('***@host')
  })
  it('报错路径上宁可多遮：query 里的 @ 一并折掉', () => {
    expect(redactProxyUrl('http://host:8080?x=a@b')).toBe('http://***@b')
  })
})

describe('proxyUrlWithScheme / normalizeProxyUrl（建 dispatcher 前的形态归一）', () => {
  it('裸 host:port 补 http://，带 scheme 原样，首尾空白吃掉', () => {
    expect(proxyUrlWithScheme('127.0.0.1:7897')).toBe('http://127.0.0.1:7897')
    expect(proxyUrlWithScheme(' https://proxy.example:443 ')).toBe('https://proxy.example:443')
  })
  it('null / 空白 / direct（含首尾空白）→ 直连；其余 → 带 scheme 的 URL', () => {
    expect(isDirectProxy(null)).toBe(true)
    expect(isDirectProxy('  ')).toBe(true)
    expect(isDirectProxy(' DIRECT ')).toBe(true)
    expect(isDirectProxy('http://a:1')).toBe(false)
    expect(normalizeProxyUrl(null)).toBeNull()
    expect(normalizeProxyUrl(' direct ')).toBeNull()
    expect(normalizeProxyUrl('127.0.0.1:7897')).toBe('http://127.0.0.1:7897')
    expect(normalizeProxyUrl(' http://a:1 ')).toBe('http://a:1')
  })
})
