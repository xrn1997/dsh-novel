import { describe, expect, it } from 'vitest'
import type { IncomingMessage } from 'node:http'
import { PassThrough } from 'node:stream'
import { isTrustedRequest, readJsonBody, errorStatusOf, ApiError } from '../../src/api/wire.js'
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
