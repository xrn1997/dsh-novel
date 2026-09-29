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

/**
 * 绝对 XPath 形态的 tocUrl：`//…` 既像 URL（协议相对形态）又是 XPath 的绝对形态。
 *
 * 库内 `若夏` / `思兔阅读` / `爱丽丝书屋` 的 `ruleBookInfo.tocUrl` 都是这种规则。旧实现的
 * 「静态 URL 短路」（`^(https?:)?//` 命中 → `absUrl(...) ?? bookUrl`）把它们当 URL：`absUrl`
 * 对这种串解不出 → **回退 bookUrl**，于是目录请求打到书籍页、一条章节也列不出。
 * 真机读数（2026-09-28，经本地代理）：若夏 `getDetail().tocUrl` 恒为 bookUrl、`getToc` 0 章、
 * 审计把它分在 `EmptyToc` 桶里；而这条规则单独求值是好的（`…/chapter/123313`）。
 */
describe('tocUrl 是绝对 XPath 规则时不许被当静态 URL', () => {
  const RULE = "//*[@property='og:novel:read_url']/@content@js:result.replace('/book/','/chapter/')"
  const HTML = '<html><head><meta property="og:novel:read_url" content="https://www.heiyan.com/book/123313"></head></html>'

  it('绝对 XPath 规则照常求值（不再拿 bookUrl 冒充）', async () => {
    const url = await tocUrlOf(RULE, null, BOOK, async () => HTML, subEval)
    expect(url).toBe('https://www.heiyan.com/chapter/123313')
  })

  it('真静态 URL（无插值且能绝对化）仍走短路——不因本修改去抓详情页', async () => {
    const url = await tocUrlOf('/static/list.html', null, BOOK,
      async () => { throw new Error('静态 URL 不该触发详情页抓取') }, subEval)
    expect(url).toBe('https://api.example.com/static/list.html')
  })

  it('裸标签绝对 XPath（`//div/a/@href`）同样不短路——new URL 解得出野地址不代表它是 URL', async () => {
    // 二段收口的回归形态（矩阵 b-toc-url-xpath-vs-url）：`new URL` 会把 `//div/a/@href` 解成
    // `https://div/a/@href`（host 被认成标签名），「absUrl 解得出才短路」这道闸拦不住它——
    // `//` 家族在 tocUrl 位一律按绝对 XPath 不短路（单 `/` 仍走「解得出才短路」，见上面那条钉子）。
    const html = '<html><body><div><a href="/chapter/1">第一章</a></div></body></html>'
    const url = await tocUrlOf('//div/a/@href', null, BOOK, async () => html, subEval)
    expect(url).toBe('https://api.example.com/chapter/1')
  })
})
