import { describe, expect, it } from 'vitest'
import type { IncomingMessage } from 'node:http'
import { PassThrough } from 'node:stream'
import { fenceAllowlist, fenceDenialOf, isTrustedRequest, readJsonBody, errorStatusOf, ApiError } from '../../src/api/wire.js'
import type { FenceDenial } from '../../src/api/wire.js'
import type { ApiEnvelope, ApiErrorBody } from '../../src/shared/wire.js'
import { ChapterNotFoundError, DecodeError, FetchError, RuleMissingError, SourceNotFoundError } from '../../src/services/errors.js'
import { RuleEvalError, UnsupportedRuleError } from '../../src/engine/index.js'

const reqWith = (headers: Record<string, string>, remote = '127.0.0.1') =>
  ({ headers, socket: { remoteAddress: remote } }) as unknown as Pick<IncomingMessage, 'headers' | 'socket'>

describe('isTrustedRequest', () => {
  it('loopback + 无 referer → 放行（curl/本机工具）', () => {
    expect(isTrustedRequest(reqWith({ host: '127.0.0.1:3000' }))).toBe(true)
  })
  it('loopback + referer 同 host → 放行；不同 host → 拒', () => {
    expect(isTrustedRequest(reqWith({ host: '127.0.0.1:3000', referer: 'http://127.0.0.1:3000/web' }))).toBe(true)
    expect(isTrustedRequest(reqWith({ host: '127.0.0.1:3000', referer: 'http://evil.com/x' }))).toBe(false)
  })
  it('Origin 跨源 → 拒（no-referrer CSRF：Referer 可缺席，Origin 不会）', () => {
    expect(isTrustedRequest(reqWith({ host: '127.0.0.1:3000', origin: 'http://evil.com' }))).toBe(false)
    expect(isTrustedRequest(reqWith({ host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000' }))).toBe(true)
    expect(isTrustedRequest(reqWith({ host: '127.0.0.1:3000', origin: 'not a url' }))).toBe(false)
  })
  it('非 loopback → 拒', () => {
    expect(isTrustedRequest(reqWith({ host: 'h' }, '192.168.1.9'))).toBe(false)
  })
  it('Host 不是 loopback → 拒（DNS rebinding：Origin 与 Host 同为攻击者域名时同源判定天然成立）', () => {
    expect(isTrustedRequest(reqWith({ host: 'attacker.com:3000', origin: 'http://attacker.com:3000' }))).toBe(false)
    expect(isTrustedRequest(reqWith({ host: 'attacker.com:3000' }))).toBe(false)          // 无 Origin/Referer 也拒
    expect(isTrustedRequest(reqWith({ host: '127.0.0.1.evil.com:3000', referer: 'http://127.0.0.1.evil.com:3000/x' }))).toBe(false)
    expect(isTrustedRequest(reqWith({ host: 'localhost:3000' }))).toBe(true)
    expect(isTrustedRequest(reqWith({ host: '[::1]:3000' }))).toBe(true)
  })
  it('缺 Host → 拒（HTTP/1.1 必有；缺了就无从证明同源）', () => {
    expect(isTrustedRequest({ headers: {}, socket: { remoteAddress: '127.0.0.1' } } as unknown as Pick<IncomingMessage, 'headers' | 'socket'>)).toBe(false)
  })
})

/**
 * fence 的边界形态逐形钉死：这些形状不是臆想的边角，DNS rebinding 与「用户自己的别名域名」
 * 都长在这一批形状上。判据顺序（远端 → Host → Origin → Referer）与拒绝原因同住
 * `fenceDenialOf`，路由层只把原因翻成措辞——所以这里认的是**原因**，不是布尔。
 */
describe('fenceDenialOf：Host 名单的边界形态', () => {
  const cases: readonly { host: string; denial: FenceDenial | null; why: string }[] = [
    { host: 'localhost', denial: null, why: '三值名单内' },
    { host: 'localhost:80', denial: null, why: '默认端口按 RFC 允许出现在 Host 里' },
    { host: 'localhost:3000', denial: null, why: '带端口同理' },
    { host: 'LOCALHOST:3000', denial: null, why: '大小写归一' },
    { host: '127.0.0.1', denial: null, why: '三值名单内' },
    { host: '[::1]', denial: null, why: 'IPv6 带括号形态（WHATWG 序列化保留括号）' },
    { host: '[::1]:3000', denial: null, why: 'IPv6 带端口' },
    { host: 'localhost.', denial: 'host', why: '尾点是另一个名字，不猜它等价于 localhost' },
    { host: '127.0.0.2', denial: 'host', why: 'loopback 段的别的地址不是面板用的形态' },
    { host: '2130706433', denial: 'host', why: '十进制写的 127.0.0.1：会被 URL 归一进名单，只有 rebinding 工具发得出这种形状' },
    { host: '0x7f000001', denial: 'host', why: '十六进制同理' },
    { host: '0177.0.0.1', denial: 'host', why: '八进制同理' },
    { host: '0.0.0.0', denial: 'host', why: '不是 loopback' },
    { host: '::1', denial: 'host', why: 'IPv6 不加括号是非法 Host 形状（URL 解析不了）' },
    { host: 'attacker.com', denial: 'host', why: 'rebinding 主形态' },
    { host: '', denial: 'host', why: '空 Host 无从证明同源' },
    { host: 'localhost, localhost', denial: 'host', why: '重复 Host 头被 Node 折叠成这一串：解析不出就拒' },
  ]
  for (const c of cases) {
    it(`Host「${c.host}」→ ${c.denial ?? '放行'}（${c.why}）`, () => {
      expect(fenceDenialOf(reqWith({ host: c.host }))).toBe(c.denial)
    })
  }
  it('拒绝原因按判据顺序点名：远端 / Origin / Referer', () => {
    expect(fenceDenialOf(reqWith({ host: 'localhost' }, '192.168.1.9'))).toBe('remote')
    expect(fenceDenialOf(reqWith({ host: 'localhost:3000', origin: 'http://evil.com' }))).toBe('origin')
    expect(fenceDenialOf(reqWith({ host: 'localhost:3000', referer: 'http://evil.com/x' }))).toBe('referer')
    expect(fenceDenialOf(reqWith({ host: 'evil.com:3000', origin: 'http://evil.com:3000' }))).toBe('host')
  })
})

describe('fenceDenialOf：apiAllowHosts 逃生口', () => {
  it('列进来的别名放行，没列的照旧拒', () => {
    expect(fenceDenialOf(reqWith({ host: 'dsh.local:3000' }))).toBe('host')
    expect(fenceDenialOf(reqWith({ host: 'dsh.local:3000' }), { allowHosts: ['dsh.local'] })).toBe(null)
    expect(fenceDenialOf(reqWith({ host: 'other.local:3000' }), { allowHosts: ['dsh.local'] })).toBe('host')
  })
  it('别名条目按同一口径归一：大小写与端口都不参与比较', () => {
    expect(fenceDenialOf(reqWith({ host: 'DSH.Local:3000' }), { allowHosts: ['dsh.local:8080'] })).toBe(null)
  })
  it('别名只让开 Host 这一闸：Origin / Referer 的同源判定照旧', () => {
    expect(fenceDenialOf(reqWith({ host: 'dsh.local:3000', origin: 'http://evil.com' }), { allowHosts: ['dsh.local'] })).toBe('origin')
    expect(fenceDenialOf(reqWith({ host: 'dsh.local:3000', referer: 'http://dsh.local:3000/x' }), { allowHosts: ['dsh.local'] })).toBe(null)
  })
  it('解析不出来的条目只丢这一条，不把整闸放开', () => {
    const allowHosts = ['http://x.io', 'has space', 'dsh.local']
    expect(fenceDenialOf(reqWith({ host: 'dsh.local' }), { allowHosts })).toBe(null)
    expect(fenceDenialOf(reqWith({ host: 'x.io' }), { allowHosts })).toBe('host')
  })
  it('别名位也不接受被 URL 归一过的 IP 写法：名单里写了十进制 IP 也不放行', () => {
    expect(fenceDenialOf(reqWith({ host: '2130706433:3000' }), { allowHosts: ['2130706433'] })).toBe('host')
  })
  it('isTrustedRequest 与 fenceDenialOf 同判据（布尔面是投影，不是第二份实现）', () => {
    for (const host of ['localhost', '127.0.0.1:3000', 'dsh.local', '127.0.0.2']) {
      expect(isTrustedRequest(reqWith({ host }))).toBe(fenceDenialOf(reqWith({ host })) === null)
    }
  })
  it('默认端口两边都算缺席：`localhost:80` 与 `localhost` 是同一个源；非默认端口照旧要对上', () => {
    // 判据是「同一个源」而不是「同一串字」：Host 名单那一步认了 `:80`，同源那一步不能反过来拒它。
    expect(fenceDenialOf(reqWith({ host: 'localhost:80', origin: 'http://localhost:80' }))).toBe(null)
    expect(fenceDenialOf(reqWith({ host: 'localhost:80', origin: 'http://localhost' }))).toBe(null)
    expect(fenceDenialOf(reqWith({ host: 'localhost', origin: 'http://localhost:3000' }))).toBe('origin')
    expect(fenceDenialOf(reqWith({ host: 'localhost:3000', referer: 'http://localhost:3000/x' }))).toBe(null)
    expect(fenceDenialOf(reqWith({ host: 'localhost:3000', referer: 'http://localhost/x' }))).toBe('referer')
  })
  it('443 只在该源的 scheme 默认端口时算缺席：http://localhost:443 不被当成 http://localhost', () => {
    // Host 头不带 scheme（反代 TLS 终止时尤其如此），所以 Host 侧的 443 仍按缺席处理；
    // 但 Origin 自己带 scheme，`http://localhost:443` 是一个真实不同的源，不能合并。
    expect(fenceDenialOf(reqWith({ host: 'localhost', origin: 'http://localhost:443' }))).toBe('origin')
    expect(fenceDenialOf(reqWith({ host: 'localhost:443', origin: 'https://localhost' }))).toBe(null)
    expect(fenceDenialOf(reqWith({ host: 'localhost', origin: 'https://localhost' }))).toBe(null)
    expect(fenceDenialOf(reqWith({ host: 'localhost', origin: 'https://localhost:4443' }))).toBe('origin')
  })
  it('构造期名单可预计算：Set 直接复用且缺省名字仍在；脏值不许按字符拆成名单', () => {
    const prepared = fenceAllowlist(['dsh.local'])
    expect(fenceDenialOf(reqWith({ host: 'dsh.local' }), { allowHosts: prepared })).toBe(null)
    expect(fenceDenialOf(reqWith({ host: 'localhost' }), { allowHosts: prepared })).toBe(null)
    expect(fenceDenialOf(reqWith({ host: 'f' }), { allowHosts: 'foo' as never }), '字符串不是名单').toBe('host')
    expect(fenceDenialOf(reqWith({ host: 'f' }), { allowHosts: ['f', 42 as never] })).toBe(null)
    expect(fenceDenialOf(reqWith({ host: '4' }), { allowHosts: ['f', 42 as never] }), '非字符串条目只丢自己').toBe('host')
  })
})

describe('readJsonBody', () => {
  it('合法 JSON 解析', async () => {
    const s = new PassThrough()
    const p = readJsonBody(s as unknown as IncomingMessage, null)
    s.end('{"a":1}')
    expect(await p).toEqual({ a: 1 })
  })
  it('非法 JSON → ApiError 400', async () => {
    const s = new PassThrough()
    const p = readJsonBody(s as unknown as IncomingMessage, null)
    s.end('{bad')
    await expect(p).rejects.toMatchObject({ name: 'ApiError', status: 400, code: 'BadRequest' })
  })
  it('超 1MiB → ApiError 413', async () => {
    const s = new PassThrough()
    const p = readJsonBody(s as unknown as IncomingMessage, null)
    s.write('x'.repeat(1024 * 1024 + 1))
    await expect(p).rejects.toMatchObject({ status: 413, code: 'PayloadTooLarge' })
  })
})

describe('errorStatusOf 单点映射', () => {
  it('引擎三类 → 422 带 segment', () => {
    const e = new RuleEvalError('没取到', { facet: 'toc', segmentIndex: 2, segmentRaw: 'class.x', hits: 0 })
    const { status, body } = errorStatusOf(e)
    expect(status).toBe(422)
    expect(body.code).toBe('RuleEvalError')
    expect(body.segment).toEqual({ facet: 'toc', segmentIndex: 2, segmentRaw: 'class.x' })
  })
  it('UnsupportedRuleError → 422', () => {
    expect(errorStatusOf(new UnsupportedRuleError('x', { facet: 'search', segmentIndex: 0, segmentRaw: 'y' })).status).toBe(422)
  })
  it('FetchError/DecodeError → 502', () => {
    expect(errorStatusOf(new FetchError('boom', { url: 'https://a' })).status).toBe(502)
    expect(errorStatusOf(new DecodeError('bad charset', { url: 'https://a', charset: 'xx' })).status).toBe(502)
  })
  it('源不存在/章节不存在 → 404 NotFound（类型化失败，非文案匹配）', () => {
    expect(errorStatusOf(new SourceNotFoundError('abc'))).toMatchObject({ status: 404, body: { code: 'NotFound' } })
    expect(errorStatusOf(new ChapterNotFoundError(9, 42))).toMatchObject({ status: 404, body: { code: 'NotFound' } })
    // 回归钉死：裸 Error 写同样的中文句子**不再**被嗅探成 404——分类权在类型上，不在文案上
    expect(errorStatusOf(new Error('源不存在: abc'))).toMatchObject({ status: 500 })
    expect(errorStatusOf(new Error('目录中没有第 9 章'))).toMatchObject({ status: 500 })
  })
  it('缺规则 → 422 RuleMissing（与搜索面/探针同一错误码；此前裸 Error 落 500）', () => {
    const e = new RuleMissingError('content', 'ruleContent', '源「X」缺正文规则 ruleContent')
    expect(errorStatusOf(e)).toMatchObject({ status: 422, body: { code: 'RuleMissing' } })
    expect(errorStatusOf(e).body.message).toContain('缺正文规则')
  })
  it('ApiError 直通；其他 → 500', () => {
    expect(errorStatusOf(new ApiError('参数错', 400, 'BadRequest'))).toMatchObject({ status: 400 })
    expect(errorStatusOf(new Error('惊喜'))).toMatchObject({ status: 500, body: { code: 'InternalError' } })
  })
})

describe('wire 契约归位', () => {
  it('errorStatusOf 的 body 满足 shared ApiErrorBody（编译期契约 + 运行时抽查）', () => {
    const { body } = errorStatusOf(new RuleEvalError('没取到', { facet: 'content', segmentIndex: 1, segmentRaw: 'r', hits: 0 }))
    const typed: ApiErrorBody = body satisfies ApiErrorBody
    expect(typed.code).toBe('RuleEvalError')
    expect(typed.segment?.facet).toBe('content')
  })
  it('信封两形态满足 ApiEnvelope（成功 / 失败）', () => {
    const ok = { ok: true, value: 1 } satisfies ApiEnvelope<number>
    const err = { ok: false, error: { code: 'NotFound', message: 'x' } } satisfies ApiEnvelope<number>
    expect(ok.value).toBe(1)
    expect(err.error?.code).toBe('NotFound')
  })
})
