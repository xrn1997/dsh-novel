import { describe, expect, it } from 'vitest'
import { evaluate } from '../../src/engine/evaluate.js'
import { subRuleOf } from '../../src/engine/sub-rule.js'

const HTML = '<div class="a"><span>甲</span></div>'

describe('子规则求值体在三个入口同口径', () => {
  it('subRuleOf 把文本与已定用途绑在同一个值里', () => {
    expect(subRuleOf('div.a@text', 'search')).toEqual({ rule: 'div.a@text', usage: 'value' })
    expect(subRuleOf('div.a@text', 'search', 'list')).toEqual({ rule: 'div.a@text', usage: 'list' })
  })

  it('模板插值与 java 桥（evalRule → evaluateRef）对同一子规则取同一值', async () => {
    const template = await evaluate('{{@css:div.a@text}}', { html: HTML }, 'search')
    const bridge = await evaluate('<js>return java.getString("@css:div.a@text")</js>', { html: HTML }, 'search')
    expect(template).toEqual({ kind: 'value', text: '甲' })
    expect(bridge).toEqual(template)
  })

  it('列表入口把同一子规则的用途定成 list：取内容，不取 outerHTML', async () => {
    const list = await evaluate('<js>return java.getStringList("@css:div.a").join("|")</js>', { html: HTML }, 'search')
    expect(list).toEqual({ kind: 'value', text: '<span>甲</span>' })
  })

  it('@put 的值入口与模板/桥同口径：属性终端按 value 解析', async () => {
    const html = '<a onclick="go()">x</a>'
    const ctx = { html, vars: {} as Record<string, string> }
    await evaluate('@put:{x:tag.a@onclick}', ctx, 'search')
    const template = await evaluate('{{@tag.a@onclick}}', { html }, 'search')
    expect(ctx.vars.x).toBe('go()')
    expect(template).toEqual({ kind: 'value', text: ctx.vars.x })
  })
})
