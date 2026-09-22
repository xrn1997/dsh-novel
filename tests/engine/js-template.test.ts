import { describe, expect, it } from 'vitest'
import { evaluate } from '../../src/engine/index.js'

/**
 * **js 段代码文本里的 `{{…}}` 要先被替换，再交给脚本执行**（对面 `SourceRule.makeUpRule`）。
 *
 * 对面段循环的顺序是 `putRule → makeUpRule(result) → 按 mode 分发`
 * （`model/analyzeRule/AnalyzeRule.kt` 的 getString：先 `sourceRule.makeUpRule(result)`，再
 * `Mode.Js -> evalJS(rule, result)`）——`makeUpRule` 重写的是**规则文本本身**，
 * 所以对 js 段里的字符串字面量同样生效。真实源大量靠这条拼 URL：
 * 米读小说的 `ruleBookInfo.tocUrl` 与 `ruleToc.chapterUrl` 都是
 * `@js: "https://…/chapter_list/100/{{$.book_id}}.txt"`（try/catch 选主备域名）。
 * 全库 158 源里 **28 源** 在 js 段里嵌 `{{…}}`。
 *
 * 本仓此前只对「模板字面段」做插值，js 段代码原样进沙箱 → 脚本返回**带字面花括号的残 URL**
 * 直接发出去（真机实证：米读小说 toc 404 打到
 * `…/chapter_list/100/%7B%7B$.book_id%7D%7D.txt`）。本仓既有口径写明「插值段 Miss → 整段 Miss，
 * 不发残 URL」，这里把同一条口径接到 js 段上。
 */

const CTX = { html: '', json: { book_id: '9g7', data: { id: 12 } }, baseUrl: 'https://x.com' }

describe('js 段代码里的 {{…}} 先插值再执行（makeUpRule 口径）', () => {
  it('JSONPath 内嵌段被替换进字符串字面量', async () => {
    const v = await evaluate('@js:"https://x.com/l/{{$.book_id}}.txt"', CTX, 'detail', 'value')
    expect(v).toEqual({ kind: 'value', text: 'https://x.com/l/9g7.txt' })
  })

  it('插值段取不到 → 整段 Miss：绝不把字面花括号交给网络', async () => {
    const v = await evaluate('@js:"https://x.com/l/{{$.nope}}.txt"',
      { html: '', json: { a: 1 }, baseUrl: 'https://x.com' }, 'detail', 'value')
    expect(v.kind).toBe('miss')
  })

  it('js 表达式形态的插值段同样先算（{{book.name}}）', async () => {
    const v = await evaluate('@js:"k={{book.name}}"',
      { html: '', json: {}, book: { name: '书甲' }, baseUrl: 'https://x.com' }, 'detail', 'value')
    expect(v).toEqual({ kind: 'value', text: 'k=书甲' })
  })

  it('没有内嵌段的 js 段行为不变（不被插值层碰过）', async () => {
    const v = await evaluate('@js:1+2', CTX, 'detail', 'value')
    expect(v).toEqual({ kind: 'value', text: '3' })
  })
})

describe('js 段代码里的 JS 模板字面量不被当插值点（中文书城回归钉）', () => {
  it('${$.x} 由脚本自己求值，不当成单括号 JSONPath 撕走', async () => {
    // 中文书城 ruleToc.chapterList 的真形态：JSON.parse(result).list.map($=>{ … `${$.bookid}` … })
    // ——`$` 是回调参数。若把 `{$…}` 当内嵌 JSONPath，这段会整段 Miss，目录 0 章。
    const code = '[{x:7}].map(function($){ return "u=" + `${$.x}!` })[0]'
    const v = await evaluate('@js:' + code,
      { html: '', json: { x: '不该被读到' }, baseUrl: 'https://x.com' }, 'toc', 'value')
    expect(v).toEqual({ kind: 'value', text: 'u=7!' })
  })

  it('同一条 js 代码里两种形态并存：双花括号插值、美元花括号留给脚本', async () => {
    const code = '"a={{$.book_id}}-" + [{x:"Z"}].map(function($){ return `${$.x}` })[0]'
    const v = await evaluate('@js:' + code, CTX, 'detail', 'value')
    expect(v).toEqual({ kind: 'value', text: 'a=9g7-Z' })
  })
})
