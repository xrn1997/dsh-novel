import { describe, expect, it } from 'vitest'
import { createFetcher } from '../../src/services/fetcher.js'
import { normalizeSource } from '../../src/services/normalize.js'
import { assembleRequest } from '../../src/services/request.js'
import type { NovelSource } from '../../src/services/types.js'
import { fakeSourceRequest } from './fake-source-request.js'

/** 假件的两条口径钉：它由真缝 `createSourceRequest` 装配，故源静态头与 headerRule 都按真缝行为生效。
 *  这两条在旧假件（自持一条 charset-only 的组合）上都红——那是假件向真缝靠拢的已声明差异。 */

function src(over: Record<string, unknown> = {}): NovelSource {
  const raw = {
    bookSourceName: 'S', bookSourceUrl: 'https://s.com',
    searchUrl: 'https://s.com/search?q={{key}}',
    ruleBookList: '@css:.b', ruleBookName: 'tag.a@text', ruleBookUrl: 'tag.a@href',
    ruleContent: '@css:#c@text',
    ...over,
  }
  const n = normalizeSource(raw)
  if (!n.ok) throw new Error(`桩源应能规范化：${JSON.stringify(n.missing)}`)
  return { id: 'i', status: 'unverified', importedAt: 0, ...n.source! } as NovelSource
}

const html = (text: string): Response =>
  new Response(text, { headers: { 'content-type': 'text/html; charset=utf-8' } })

describe('fakeSourceRequest（由 createSourceRequest 装配）', () => {
  it('源静态头并入请求（与真缝同口径）', async () => {
    let headers: Record<string, string> | undefined
    const f = createFetcher({
      fetchImpl: async (_input, init) => { headers = init?.headers as Record<string, string>; return html('ok') },
    })
    const s = src({ header: '{"X-Source":"1"}' })
    const { text } = await fakeSourceRequest(f).fetchText(s, assembleRequest('https://s.com/x', {}, s.baseUrl))
    expect(text).toBe('ok')
    expect(headers?.['X-Source']).toBe('1')
  })

  it('headerRule 只求值一次：动态头经本缝求值并进请求', async () => {
    const seen: string[] = []
    let mainHeaders: Record<string, string> | undefined
    const f = createFetcher({
      fetchImpl: async (input, init) => {
        const url = String(input)
        seen.push(url)
        if (url.endsWith('/h')) {
          return new Response('{"X-Dyn":"1"}', { headers: { 'content-type': 'application/json' } })
        }
        mainHeaders = init?.headers as Record<string, string>
        return html('ok')
      },
    })
    const s = src({ header: `@js:java.ajax('https://s.com/h')` })
    await fakeSourceRequest(f).fetchText(s, assembleRequest('https://s.com/x', {}, s.baseUrl))
    expect(mainHeaders?.['X-Dyn']).toBe('1')
    // 头规则只求值一次：它自己的 java.ajax 不许回头再触发头规则
    expect(seen.filter((u) => u.endsWith('/h'))).toHaveLength(1)
    expect(seen).toContain('https://s.com/x')
  })
})
