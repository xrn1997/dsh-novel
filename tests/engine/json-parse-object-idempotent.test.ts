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

/**
 * 同一族 bug 的**另一条路**（2026-09 审查实证）：上面那条编译期判别只修在主线程的 `runAsScript`
 * 里，worker 的 WORKER_SRC 仍按「执行 code → 捕获到 SyntaxError 就重跑 wrapped」判别。
 * 编译期 SyntaxError（顶层 return）在两条路上都不执行脚本，所以只有**运行时** SyntaxError
 * 会暴露分叉：worker 已经把脚本跑了一遍（ajax 已发出去）才拿到异常，重跑 = 站点两趟 +
 * 非幂等写入两遍；若第二遍恰好不抛，wrapped 形态无 return → 完成值 undefined → **静默 Miss**
 * ——本仓定的最高罪（空结果冒充失败）。fetch 计数自证真走了 worker 那条路。
 */
/** 走 worker 路的上下文：fetch 计数自证真进了 worker（主线程那条路不碰 fetch）。 */
function workerCtx(counts: { fetch: number }): EvalContext {
  return {
    html: '', baseUrl: 'https://x.com', source: 'https://x.com',
    fetch: async () => { counts.fetch++; return { body: 'BODY' } },
  }
}

describe('worker 路与主线程同口径（运行时 SyntaxError 不靠重跑判别）', () => {
  it('运行时 SyntaxError → 如实上抛，脚本只执行一遍（fetch 计数为 1）', async () => {
    const counts = { fetch: 0 }
    const run = evaluate('@js:java.ajax("https://x.com/p"); JSON.parse("{bad"); "done"',
      workerCtx(counts), 'detail', 'list')
    await expect(run).rejects.toThrow()
    expect(counts.fetch).toBe(1)
  })

  it('脚本自带状态、第二遍不抛时，也不许把首遍的运行时 SyntaxError 洗成 Miss', async () => {
    const counts = { fetch: 0 }
    const code = 'java.ajax("https://x.com/p");'
      + ' source.put("attempt", String(Number(source.get("attempt") || "0") + 1));'
      + ' if (source.get("attempt") === "1") JSON.parse("{bad"); "done";'
    const run = evaluate('@js:' + code, workerCtx(counts), 'detail', 'list')
    await expect(run).rejects.toThrow()
    expect(counts.fetch).toBe(1)
  })

  it('worker 路的顶层 return 仍回落 wrapped，且回落不多打站点', async () => {
    const counts = { fetch: 0 }
    const v = await evaluate('@js:java.ajax("https://x.com/p"); return "ret-ok"',
      workerCtx(counts), 'detail', 'list')
    expect(v).toEqual({ kind: 'value', text: 'ret-ok' })
    expect(counts.fetch).toBe(1)
  })
})
