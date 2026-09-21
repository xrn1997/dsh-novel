import { describe, expect, it } from 'vitest'
import { evaluate } from '../../src/engine/index.js'
import type { EvalContext } from '../../src/engine/index.js'

// 回归钉子：`/` 开头且含 `{{}}` 的 URL 模板此前被 XPath 分支抢先截走（真机实证：
// 顶点小说 tocUrl 插值步报「XPath 步骤不支持: {{$.novelId}}」）——插值优先于前缀判定。
describe('URL 模板插值 vs XPath 前缀（classifySegment 判定次序）', () => {
  const ctx: EvalContext = { json: { novelId: 12345 }, baseUrl: 'http://api.anwaben.com' }

  it('整条 URL 模板（http 开头 + {{}}）', async () => {
    const v = await evaluate('http://api.wzyjxf.com/novel/{{$.novelId}}/chapters', ctx, 'rule', 'value')
    expect(v).toEqual({ kind: 'value', text: 'http://api.wzyjxf.com/novel/12345/chapters' })
  })
  it('纯插值形态 {{$.novelId}}', async () => {
    const v = await evaluate('{{$.novelId}}', ctx, 'rule', 'value')
    expect(v).toEqual({ kind: 'value', text: '12345' })
  })
  it('相对路径形态 /novel/{{$.novelId}}/chapters', async () => {
    const v = await evaluate('/novel/{{$.novelId}}/chapters', ctx, 'rule', 'value')
    expect(v).toEqual({ kind: 'value', text: '/novel/12345/chapters' })
  })
})
