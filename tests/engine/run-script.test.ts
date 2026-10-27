import { describe, expect, it } from 'vitest'
import { runScript } from '../../src/engine/js-sandbox.js'
import { JsSandboxError } from '../../src/engine/errors.js'

const loc = { segmentIndex: -1, segmentRaw: '(test)' }

/** runScript：evalJs 的单对象入口——host/ctx 重叠字段在 engine 内合并，
 *  调用方只学一个形状，不各拼一份上下文。 */
describe('runScript', () => {
  it('完成值即结果（scriptForm 缺省 true：legado @js 口径）', async () => {
    const out = await runScript({ code: '1 + 1', loc, facet: 'search' })
    expect(out.value).toMatchObject({ kind: 'value', text: '2' })
  })

  it('key/page/header 经沙箱全局可见（searchUrl @js 形态的变量位；header 走 source.header 形态）', async () => {
    const out = await runScript({
      code: 'key + "|" + page + "|" + JSON.parse(source.header).Referer',
      key: '书', page: 2, header: JSON.stringify({ Referer: 'https://s.com' }),
      loc, facet: 'search',
    })
    expect(out.value).toMatchObject({ kind: 'value', text: '书|2|https://s.com' })
  })

  it('result = 上一段结果（缺省空串起步）', async () => {
    const withResult = await runScript({ code: 'result + "!"', result: 'abc', loc, facet: 'rule' })
    expect(withResult.value).toMatchObject({ kind: 'value', text: 'abc!' })
    const fresh = await runScript({ code: 'result', loc, facet: 'rule' })
    expect(fresh.value).toMatchObject({ kind: 'miss' })   // 空 result → Miss（引擎既有口径）
  })

  it('jsLib 先于用户代码执行（源级全局函数库）', async () => {
    const out = await runScript({
      code: 'hello("世界")',
      jsLib: 'function hello(n) { return "你好," + n }',
      loc, facet: 'search',
    })
    expect(out.value).toMatchObject({ kind: 'value', text: '你好,世界' })
  })

  it('脚本抛错 → JsSandboxError（宁炸不猜，如实上抛）', async () => {
    await expect(runScript({ code: 'throw new Error("boom")', loc, facet: 'search' }))
      .rejects.toBeInstanceOf(JsSandboxError)
  })
})
