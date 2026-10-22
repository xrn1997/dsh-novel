import { describe, expect, it } from 'vitest'
import { evaluate, evaluateWithTrace } from '../../src/engine/evaluate.js'

/**
 * 同步环路真实覆盖：「evaluate → evalJs → java.getString → evaluateRef(真身)
 * → runParsedSync」整环此前只有 fake evaluateRef 的间接测试（js-sandbox.test.ts 全注入假回调）——
 * 本文件用 evaluate() 直接跑真环路，钉死同步 runner 的既有语义，供双 runner 收拢重构作行为表征。
 */
const HTML = '<html><body><h1>标题甲</h1><p>段一</p><p>段二</p><div class="c"><a href="/1.html">章壹</a></div></body></html>'

describe('java.getString 真实环路（沙箱宿主桥 → evaluateRef 真身 → 同步 runner）', () => {
  it('getString：子规则在真实 DOM 上同步求值并回传脚本', async () => {
    const v = await evaluate('<js>return java.getString("@css:h1@text")</js>', { html: HTML, baseUrl: 'https://a.com' }, 'search')
    expect(v).toEqual({ kind: 'value', text: '标题甲' })
  })

  it('getStringList：子规则多值回传（列表语义穿宿主桥）', async () => {
    const v = await evaluate('<js>return java.getStringList("@css:p@text").join("|")</js>', { html: HTML, baseUrl: '' }, 'search')
    expect(v).toEqual({ kind: 'value', text: '段一|段二' })
  })

  it('getStringList：裸选择子规则留在 list 口径（取内容，不取 outerHTML）', async () => {
    const v = await evaluate('<js>return java.getStringList("@css:h1").join("|")</js>', { html: HTML, baseUrl: '' }, 'search')
    expect(v).toEqual({ kind: 'value', text: '标题甲' })
  })

  it('子规则链式求值（选择→取值两段链）经真身跑通', async () => {
    const v = await evaluate('<js>return java.getString(".c a@text")</js>', { html: HTML, baseUrl: '' }, 'toc')
    expect(v).toEqual({ kind: 'value', text: '章壹' })
  })

  it('子规则零命中 → getString 空串（Miss 序列化为 ""，与 bridge 口径一致）', async () => {
    const v = await evaluate('<js>return java.getString("@css:.none@text")</js>', { html: HTML, baseUrl: '' }, 'search')
    expect(v.kind).toBe('miss')
  })

  it('{{规则}} 按取值用途解析链尾未知词（属性终端）', async () => {
    const v = await evaluate('{{@tag.a@onclick}}', {
      html: '<a onclick="go()">x</a>', baseUrl: 'https://a.com',
    })
    expect(v).toEqual({ kind: 'value', text: 'go()' })
  })

  it('@put 的值按取值用途解析（属性终端）', async () => {
    const ctx = { html: '<a onclick="go()">x</a>', baseUrl: 'https://a.com', vars: {} as Record<string, string> }
    await evaluate('@put:{x:tag.a@onclick}', ctx)
    expect(ctx.vars.x).toBe('go()')
  })

  it('@put 与模板的裸选择保持 inner 内容（与 getString 同口径）', async () => {
    const ctx = { html: HTML, baseUrl: '', vars: {} as Record<string, string> }
    await evaluate('@put:{x://div}', ctx)
    expect(ctx.vars.x).toContain('章壹')
    expect(ctx.vars.x).not.toContain('<div')
    const v = await evaluate('{{//div}}', { html: HTML, baseUrl: '' })
    expect(v.kind).toBe('value')
    if (v.kind === 'value') {
      expect(v.text).toContain('章壹')
      expect(v.text).not.toContain('<div')
    }
  })

  it('子规则内含 js 段 → 宁炸不猜（同步宿主桥不支持递归 await）', async () => {
    await expect(evaluate('<js>return java.getString("@js: 1")</js>', { html: HTML, baseUrl: '' }, 'search'))
      .rejects.toThrow(/不支持 js 段/)
  })

  it('trace 形态走同一环路（collect 与同步 runner 无耦合）', async () => {
    const r = await evaluateWithTrace('<js>return java.getString("@css:h1@text")</js>', { html: HTML, baseUrl: '' }, 'search')
    expect(r.value).toEqual({ kind: 'value', text: '标题甲' })
    expect(r.steps).toHaveLength(1)
    expect(r.steps[0].segmentKind).toBe('js')
  })
})
