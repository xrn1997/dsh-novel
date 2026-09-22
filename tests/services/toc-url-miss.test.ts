import { describe, expect, it } from 'vitest'
import { tocUrlOf } from '../../src/services/reading.js'
import { evaluate } from '../../src/engine/index.js'
import type { SubRuleEval } from '../../src/services/bridge.js'

/**
 * 「插值取不到就不发残 URL」这条口径在 tocUrl 出口上是否真的成立。
 *
 * 正文链路审计里有几条源的**目录请求地址里带着没被替换的字面 `{{$.x}}`**
 * （米读小说 toc 404 打到 `…/chapter_list/100/%7B%7B$.book_id%7D%7D.txt`），
 * 而本仓口径写明：任一插值段 Miss → 整段 Miss → 门面回退 bookUrl，
 * 「拿它发请求比报错更坏」。字面花括号进了网络，说明那条规则串在某条路径上
 * **根本没被当模板求值**。这两条钉子分别钉「命中」与「取不到」两种情形。
 */

const subEval: SubRuleEval = (rule, ctx, facet, usage) =>
  evaluate(rule, { html: ctx.html ?? '', json: ctx.json, baseUrl: ctx.baseUrl }, facet, usage ?? 'value')

const BOOK = 'https://api.example.com/fiction/book/42'

describe('tocUrl 模板插值的两种情形', () => {
  it('detail JSON 里有该键 → 插值出真实地址', async () => {
    const url = await tocUrlOf(
      'https://api.example.com/book/chapter_list/100/{{$.book_id}}.txt', null, BOOK,
      async () => JSON.stringify({ book_id: '9g7' }), subEval,
    )
    expect(url).toBe('https://api.example.com/book/chapter_list/100/9g7.txt')
  })

  it('detail JSON 里没有该键 → 回退 bookUrl，绝不把字面 {{…}} 发出去', async () => {
    const url = await tocUrlOf(
      'https://api.example.com/book/chapter_list/100/{{$.book_id}}.txt', null, BOOK,
      async () => JSON.stringify({ other: 1 }), subEval,
    )
    expect(url).toBe(BOOK)
    expect(url).not.toContain('{{')
  })
})
