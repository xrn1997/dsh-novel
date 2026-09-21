import { describe, expect, it } from 'vitest'
import { evaluate } from '../../src/engine/index.js'
import type { EvalContext } from '../../src/engine/index.js'

/**
 * 回归钉子（novel.cooks.tw 目录真机实证的两个静默 bug）：
 * ① JSON 页 result 按对象绑定（字段访问口径），`JSON.parse(result)` 形态的真实源
 *    对象 ToString 成 "[object Object]" → 运行时 SyntaxError；
 * ② runAsScript 把**运行时** SyntaxError 误判成顶层 return 语法错回落 wrapped IIFE
 *    → 表达式脚本无 return → 完成值 undefined → 整段静默 Miss（init 脚本经 evaluate 链路取空）。
 * 修复：BOOTSTRAP 对 JSON.parse 做对象幂等 wrap + runAsScript 改**编译期**判别 SyntaxError。
 */
const PAGE = JSON.stringify({ code: 200, data: { articleid: 362912, articlename: '斗破苍穹' } })
const ctx = (): EvalContext => ({ html: PAGE, baseUrl: 'https://novel.cooks.tw' })

describe('JSON.parse 对象幂等 + 编译期 SyntaxError 判别', () => {
  it('JSON 页 result 是对象（字段访问形态仍工作——既定口径不动）', async () => {
    const v = await evaluate('@js:result.data.articleid', ctx(), 'detail', 'list')
    expect(v).toEqual({ kind: 'value', text: '362912' })
  })
  it('JSON.parse(result) 形态：对象幂等 wrap 后 roundtrip 成功', async () => {
    const v = await evaluate('@js:JSON.stringify(JSON.parse(result))', ctx(), 'detail', 'list')
    expect(v.kind).toBe('value')
    expect((v as { text: string }).text).toContain('362912')
  })
  it('cooks.tw init 脚本经 evaluate 链路（此前恒 Miss）', async () => {
    const INIT = `@js:\n(function(result){\n    result = JSON.parse(result);\n    const data = result.data;\n    let articleid = data.articleid;\n    cache.putMemory('articleid', articleid);\n    return data;\n})(result);`
    const v = await evaluate(INIT, ctx(), 'detail', 'list')
    expect(v.kind).toBe('value')
    expect((v as { text: string }).text).toContain('362912')
  })
  it('运行时 SyntaxError（JSON.parse 坏串）→ 如实上抛 JsSandboxError，不再静默 Miss', async () => {
    await expect(evaluate('@js:JSON.parse("{bad")', ctx(), 'detail', 'list')).rejects.toThrow()
  })
  it('顶层 return 形态仍回落 wrapped（编译期判别不误伤既有形态）', async () => {
    const v = await evaluate('@js:if (result) { return "ret-ok"; }', ctx(), 'detail', 'list')
    expect(v).toEqual({ kind: 'value', text: 'ret-ok' })
  })
})
