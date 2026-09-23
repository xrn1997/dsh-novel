import { describe, expect, it } from 'vitest'
import { createSourceSession, runScript } from '../../src/engine/js-sandbox.js'

const loc = { segmentIndex: -1, segmentRaw: '(source-session)' }

/**
 * 源会话：
 * cookie 垫片与源变量此前是模块级进程 Map——「按源隔离」只写在注释里，跨源污染类用例
 * 写不出来（写一次污染整模块）。现在经 RunScriptOptions.session 显式注入：
 * 生产缺省进程级实例（跨调用存活，行为不变），测试注入 createSourceSession() 隔离实例。
 */

const cookieOf = async (session: ReturnType<typeof createSourceSession>, source: string, name: string): Promise<string> => {
  const out = await runScript({ code: `cookie.getCookie(${JSON.stringify(name)}) ?? "(未设)"`, source, session, loc, facet: 'rule' })
  return out.value.kind === 'value' ? out.value.text : '(未设)'
}

describe('源会话：脚本可见状态经 session 注入', () => {
  it('同 session 跨源隔离：源 A 写的 cookie 对源 B 不可见', async () => {
    const session = createSourceSession()
    await runScript({ code: 'cookie.setCookie("token", "A-token"); "ok"', source: 'https://a.com', session, loc, facet: 'rule' })
    expect(await cookieOf(session, 'https://a.com', 'token')).toBe('A-token')
    expect(await cookieOf(session, 'https://b.com', 'token')).toBe('(未设)')   // 隔离断言（此前写不出来的用例）
  })

  it('实例隔离：两个 session 互不可见——跨源污染测试第一次可写', async () => {
    const s1 = createSourceSession()
    const s2 = createSourceSession()
    await runScript({ code: 'cookie.setCookie("token", "v1"); "ok"', source: 'https://a.com', session: s1, loc, facet: 'rule' })
    expect(await cookieOf(s1, 'https://a.com', 'token')).toBe('v1')
    expect(await cookieOf(s2, 'https://a.com', 'token')).toBe('(未设)')       // 换实例即全新状态（可重置）
  })

  it('同源跨调用存活（生产语义保留）：分两次调用，后一次读回', async () => {
    const session = createSourceSession()
    await runScript({ code: 'cookie.setCookie("token", "v"); "ok"', source: 'https://a.com', session, loc, facet: 'rule' })
    expect(await cookieOf(session, 'https://a.com', 'token')).toBe('v')
  })

  it('源变量按 session/源建档：A 源写的键值与串槽，B 源与新实例都读不到', async () => {
    const session = createSourceSession()
    const other = createSourceSession()
    await runScript({
      // 对面是两处存储（v_<source>_<key> 与 sourceVariable_<source>），本仓三张表都按源建档
      code: 'source.put("dom", "x.com"); source.setVariable("SLOT"); "ok"',
      source: 'https://a.com', session, loc, facet: 'rule',
    })
    const read = async (s: typeof session, source: string): Promise<string> => {
      const out = await runScript({ code: 'source.get("dom") + "|" + source.getVariable()', source, session: s, loc, facet: 'rule' })
      return out.value.kind === 'value' ? out.value.text : '(未设)'
    }
    expect(await read(session, 'https://a.com')).toBe('x.com|SLOT')
    expect(await read(session, 'https://b.com')).toBe('|')       // 换源即空（缺键 "" 与未设串槽 ""）
    expect(await read(other, 'https://a.com')).toBe('|')          // 换实例即全新状态（可重置）
  })

  it('缺省 session = 进程级实例：不传 session 时既有行为不变（跨调用存活）', async () => {
    // 唯一源键避免与同进程其他用例串扰；不传 session 即进程级缺省
    const src = 'https://default-proc-session.example'
    await runScript({ code: 'cookie.setCookie("t", "v"); "ok"', source: src, loc, facet: 'rule' })
    const out = await runScript({ code: 'cookie.getCookie("t") ?? "(未设)"', source: src, loc, facet: 'rule' })
    expect(out.value).toEqual({ kind: 'value', text: 'v' })
  })
})
