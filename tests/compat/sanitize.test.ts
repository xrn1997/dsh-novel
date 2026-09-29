import { describe, expect, it } from 'vitest'
import { sanitize } from './sanitize.js'

/**
 * 脱敏门禁（`compat/README.md` 的「脱敏规程」）的钉子。**这之前它没有测试**——而它是
 * `compat/fixtures/` 入库的唯一机器门禁。2026-09-28 真采第一条真源时暴露它的盲区：
 * 正则要求键后紧跟 `:`，于是真页面上最常见的 **JSON 带引号键** `"token":"68d2…"`
 * （企鹅小说的 Cloudflare beacon 就是这一形态）**整条不触发**；`Authorization: Bearer …`
 * 那种头形态也漏（`authorization`/`bearer` 不在键名单里）。
 */
describe('compat 脱敏两刀', () => {
  it('JSON 带引号键（真页面形态）：值是脱掉的', () => {
    const html = `data-cf-beacon='{"version":"2024.11.0","token":"68d2a5dba3f44d37862ee6b5ef1f6e73","r":1}'`
    const out = sanitize(html)
    expect(out).not.toContain('68d2a5dba3f44d37862ee6b5ef1f6e73')
    expect(out).toContain('[REDACTED]')
  })

  it('无引号键的两种写法（双引号值与单引号值）都脱', () => {
    expect(sanitize('token: "abcdefghijklmnop"')).toBe('token: "[REDACTED]"')
    expect(sanitize("api_key: 'abcdefghijklmnop'")).toBe("api_key: '[REDACTED]'")
  })

  it('HTTP 头形态（`Authorization: Bearer …`）脱掉整段凭据', () => {
    const out = sanitize('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0')
    expect(out).toContain('[REDACTED]')
    expect(out).not.toContain('eyJhbGciOiJIUzI1NiJ9')
  })

  it('env 行形态（`token=…` 无引号）脱掉', () => {
    const out = sanitize('token=abcdefghijklmnopqrst')
    expect(out).toContain('[REDACTED]')
    expect(out).not.toContain('abcdefghijklmnopqrst')
  })

  it('password input 的 value 脱掉，input 其余属性留着（页面结构不破）', () => {
    const out = sanitize('<input type="password" name="pw" value="hunter2hunter2">')
    expect(out).toContain('value="[REDACTED]"')
    expect(out).toContain('name="pw"')
    expect(out).not.toContain('hunter2hunter2')
  })

  it('负向：正文里提到「token」但没有像凭据的值，不动它（不无差别乱改）', () => {
    const html = '<p>本章的 token 一词出现两次，token 只是术语。</p>'
    expect(sanitize(html)).toBe(html)
  })
})
