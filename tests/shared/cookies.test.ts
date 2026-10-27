import { describe, expect, it } from 'vitest'
import { parseCookieString } from '../../src/shared/cookies.js'

/**
 * cookie 串解析的钉子（规则的唯一住址与「为什么跨半只准一份」写在 `src/shared/cookies.ts` 头上）。
 * 这条语法只有一份实现：Node 半的登录脚本产出路与浏览器半的手工输入路都从本模块取用，
 * 所以这里一份钉子就够——不存在「改了另一边没改」的分叉面。
 */
describe('parseCookieString：宽松 k=v; 串', () => {
  it('a=1; b=2 形态；无 = 的段与空段跳过、不炸', () => {
    expect(parseCookieString('token=abc; sid=def')).toEqual({ token: 'abc', sid: 'def' })
    expect(parseCookieString(' a = 1 ;; junk ;x=2 ')).toEqual({ a: '1', x: '2' })
    expect(parseCookieString('')).toEqual({})
    expect(parseCookieString('=nokey; ok=1')).toEqual({ ok: '1' })
  })
  it('值里含 = 只切第一个（cookie 值可以是 base64/URL）', () => {
    expect(parseCookieString('t=a=b=c')).toEqual({ t: 'a=b=c' })
  })
})
