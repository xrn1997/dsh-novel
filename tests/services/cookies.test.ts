import { describe, expect, it } from 'vitest'
import { CookieJar } from '../../src/services/cookies.js'

describe('CookieJar', () => {
  it('host-only cookie is sent to the same host only', () => {
    const jar = new CookieJar()
    jar.absorb('https://a.test/x', ['sid=1; Path=/'])
    expect(jar.headerFor('https://a.test/y')).toBe('sid=1')
    expect(jar.headerFor('https://b.test/y')).toBe('')
    expect(jar.headerFor('https://sub.a.test/y')).toBe('')
  })

  it('domain cookie is sent to the domain and its subdomains', () => {
    const jar = new CookieJar()
    jar.absorb('https://a.test/x', ['sid=1; Domain=.a.test; Path=/'])
    expect(jar.headerFor('https://a.test/y')).toBe('sid=1')
    expect(jar.headerFor('https://sub.a.test/y')).toBe('sid=1')
    expect(jar.headerFor('https://b.test/y')).toBe('')
  })

  it('path matching uses a path boundary and sends longer paths first', () => {
    const jar = new CookieJar()
    jar.absorb('https://a.test/', ['root=1; Path=/'])
    jar.absorb('https://a.test/', ['deep=2; Path=/api'])
    expect(jar.headerFor('https://a.test/api/books')).toBe('deep=2; root=1')
    expect(jar.headerFor('https://a.test/apix')).toBe('root=1')
  })

  it('same-path cookies keep creation order (not alphabetical)', () => {
    const jar = new CookieJar()
    jar.absorb('https://a.test/', ['b=1; Path=/'])
    jar.absorb('https://a.test/', ['a=2; Path=/'])
    expect(jar.headerFor('https://a.test/')).toBe('b=1; a=2')
  })

  it('replaces the same name on the same domain/path and deletes on Max-Age=0', () => {
    const jar = new CookieJar()
    jar.absorb('https://a.test/', ['sid=1; Path=/'])
    jar.absorb('https://a.test/', ['sid=2; Path=/'])
    expect(jar.headerFor('https://a.test/')).toBe('sid=2')
    jar.absorb('https://a.test/', ['sid=; Max-Age=0; Path=/'])
    expect(jar.headerFor('https://a.test/')).toBe('')
  })

  it('expired cookies are not sent and are removed', () => {
    const jar = new CookieJar()
    jar.absorb('https://a.test/', ['old=1; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/'])
    expect(jar.headerFor('https://a.test/')).toBe('')
    expect(jar.entries()).toHaveLength(0)
  })

  it('Secure cookies are only sent over https', () => {
    const jar = new CookieJar()
    jar.absorb('https://a.test/', ['sid=1; Secure; Path=/'])
    expect(jar.headerFor('https://a.test/')).toBe('sid=1')
    expect(jar.headerFor('http://a.test/')).toBe('')
  })

  it('Max-Age wins over Expires regardless of attribute order', () => {
    const jar = new CookieJar()
    jar.absorb('https://a.test/', ['sid=1; Max-Age=3600; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/'])
    expect(jar.headerFor('https://a.test/')).toBe('sid=1')
    expect(jar.entries()[0]!.expires).toBeGreaterThan(Date.now())
  })

  it('rejects a single-label Domain (public-suffix guard for the shared jar)', () => {
    const jar = new CookieJar()
    jar.absorb('https://evil.com/', ['sid=1; Domain=com; Path=/'])
    expect(jar.entries()).toHaveLength(0)
    expect(jar.headerFor('https://good.com/')).toBe('')
  })

  it('rejects control characters in name/value (no header injection)', () => {
    const jar = new CookieJar()
    jar.absorb('https://a.test/', ['sid=x\r\nX-Injected: 1; Path=/'])
    expect(jar.entries()).toHaveLength(0)
    expect(jar.headerFor('https://a.test/')).toBe('')
  })

  it('removeSessionCookies only clears session cookies', () => {
    const jar = new CookieJar()
    jar.absorb('https://a.test/', ['s=1'])
    jar.absorb('https://a.test/', ['p=2; Max-Age=3600'])
    jar.removeSessionCookies()
    expect(jar.headerFor('https://a.test/')).toBe('p=2')
  })

  it('单域容量闸：超出 180 条按插入序淘汰最旧的', () => {
    const jar = new CookieJar()
    for (let i = 0; i < 200; i++) jar.absorb('https://a.test/', [`c${i}=v; Path=/`])
    const entries = jar.entries()
    expect(entries).toHaveLength(180)
    expect(entries.some((e) => e.name === 'c0')).toBe(false)      // 最旧的被裁
    expect(entries.some((e) => e.name === 'c199')).toBe(true)     // 最新的在
  })

  it('总量容量闸：跨域累计超 3300 条时淘汰最旧的', () => {
    const jar = new CookieJar()
    // 19 个域 × 180 条 = 3420 > 3300；每域都不超单域上限
    for (let d = 0; d < 19; d++) {
      for (let i = 0; i < 180; i++) jar.absorb(`https://d${d}.test/`, [`c${i}=v; Path=/`])
    }
    expect(jar.entries()).toHaveLength(3300)
    // 3420 − 3300 = 120 条最早插入的被挤出，全部来自第一个域
    expect(jar.entries().filter((e) => e.domain === 'd0.test')).toHaveLength(60)
    expect(jar.entries().filter((e) => e.domain === 'd18.test')).toHaveLength(180)
  })
})
