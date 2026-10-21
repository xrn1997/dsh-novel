import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebViewRuntime, proxyConfig, sameSiteForHeaders } from '../../src/services/webview.js'
import { createSourceRequest } from '../../src/services/source-request.js'
import { createFetcher } from '../../src/services/fetcher.js'
import { CookieJar } from '../../src/services/cookies.js'
import { assembleRequest } from '../../src/services/request.js'
import { normalizeSource } from '../../src/services/normalize.js'
import type { NovelSource } from '../../src/services/types.js'

let server: http.Server
let base = ''

beforeAll(async () => {
  server = http.createServer((_req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.end('<html><body><div id="x">hello</div></body></html>')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe('WebView 代理解析（纯函数，不要真浏览器）', () => {
  it('坏代理点名（脱敏），不静默退回直连', () => {
    expect(() => proxyConfig('http://user:pa/ss@host')).toThrow(/代理地址非法/)
  })
  it('裸 host:port 补 scheme', () => {
    expect(proxyConfig('127.0.0.1:7897')).toEqual({ server: 'http://127.0.0.1:7897' })
  })
  it('源级头作用域：同站重定向仍带，第三方子资源不带头', () => {
    expect(sameSiteForHeaders('https://example.com/x', 'http://example.com/y')).toBe(true)
    expect(sameSiteForHeaders('https://m.example.com/x', 'https://example.com/')).toBe(true)
    expect(sameSiteForHeaders('http://127.0.0.1:1/x', 'http://127.0.0.1:2/')).toBe(false)
    expect(sameSiteForHeaders('https://evil.com/x', 'https://example.com/')).toBe(false)
  })
})

describe.skipIf(process.env.DSH_WEBVIEW !== '1')('WebViewRuntime（真浏览器）', () => {
  it('renders a page and runs webJs in the page context', async () => {
    const wv = new WebViewRuntime()
    try {
      const page = await wv.fetch(`${base}/`, {
        webJs: 'return document.getElementById("x").textContent',
      })
      expect(page.status).toBe(200)
      expect(page.html).toBe('hello')
    } finally {
      await wv.dispose()
    }
  }, 60_000)

  it('webJs 死循环按预算熔断（evaluate 自身没有超时参数）', async () => {
    const wv = new WebViewRuntime()
    try {
      await expect(wv.fetch(`${base}/`, { webJs: 'while(true){}', timeoutMs: 500 }))
        .rejects.toThrow(/webJs 执行超时/)
    } finally {
      await wv.dispose()
    }
  }, 30_000)

  it('源级头只随目标站点出站（不发给第三方子资源）', async () => {
    const sameSeen: string[] = []
    const otherSeen: string[] = []
    const same = http.createServer((req, res) => {
      if (req.url === '/hdr') {
        sameSeen.push(String(req.headers['x-secret'] ?? ''))
        res.end('ok')
        return
      }
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.end('<html><body>page</body></html>')
    })
    const other = http.createServer((req, res) => {
      otherSeen.push(String(req.headers['x-secret'] ?? ''))
      res.end('')
    })
    await new Promise<void>((resolve) => same.listen(0, '127.0.0.1', resolve))
    await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve))
    const sameUrl = `http://127.0.0.1:${(same.address() as AddressInfo).port}/`
    const otherUrl = `http://127.0.0.1:${(other.address() as AddressInfo).port}/leak`
    const wv = new WebViewRuntime()
    try {
      const page = await wv.fetch(sameUrl, {
        headers: { 'X-Secret': '1' },
        webJs: `return (async function () {
          await fetch('/hdr');
          await new Promise(function (resolve) {
            var i = new Image(); i.onload = i.onerror = resolve; i.src = ${JSON.stringify(otherUrl)};
          });
          return 'ok';
        })()`,
      })
      expect(page.html).toBe('ok')
      expect(sameSeen).toEqual(['1'])
      expect(otherSeen).toEqual([''])
    } finally {
      await wv.dispose()
      await new Promise((resolve) => same.close(resolve))
      await new Promise((resolve) => other.close(resolve))
    }
  }, 60_000)

  it('source-request cookie 桥：JAR→浏览器→JAR 双向生效', async () => {
    const echo = http.createServer((req, res) => {
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.setHeader('set-cookie', 'sid=abc; Path=/; Max-Age=3600')
      res.end(`<html><body><pre id="h">${req.headers.cookie ?? ''}</pre></body></html>`)
    })
    await new Promise<void>((resolve) => echo.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(echo.address() as AddressInfo).port}/`
    const wv = new WebViewRuntime()
    const jar = new CookieJar()
    try {
      jar.absorb(url, ['pre=1; Path=/'])
      const sr = createSourceRequest({
        fetcher: createFetcher({ fetchImpl: async () => new Response('') }),
        webview: wv,
        cookieJar: jar,
        jsTimeoutMs: () => 1000,
      })
      const normalized = normalizeSource({
        bookSourceName: '桥源', bookSourceUrl: url,
        ruleBookList: '@css:.b', ruleBookName: 'tag.a@text', ruleBookUrl: 'tag.a@href',
        ruleContent: '@css:#c@text',
      })
      const source: NovelSource = { ...normalized.source!, id: 'bridge', status: 'unverified', importedAt: 0 }
      const plan = { ...assembleRequest(url, {}, source.baseUrl), webView: true }
      const out = await sr.fetchText(source, plan)
      // JAR 里的 pre=1 进了浏览器；浏览器响应里的 sid=abc 又回了 jar
      expect(out.text).toContain('pre=1')
      expect(jar.headerFor(url)).toContain('sid=abc')
    } finally {
      await wv.dispose()
      await new Promise((resolve) => echo.close(resolve))
    }
  }, 60_000)
})
