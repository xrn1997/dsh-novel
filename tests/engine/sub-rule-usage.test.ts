import { describe, expect, it } from 'vitest'
import { subRuleOf } from '../../src/engine/sub-rule.js'

describe('subRuleOf（子规则用途判据与求值体）', () => {
  it('显式取值尾 → value，裸选择/混合分支 → list', () => {
    const cases = [
      ['tag.a@href', 'value'],
      ['tag.a@onclick', 'value'],
      ['@tag.a@onclick', 'value'],
      ['@onclick', 'value'],
      [' @text', 'value'],
      ['\t@onclick', 'value'],
      ['-@text', 'value'],              // 剥掉反序前缀后仍是单分支显式 @ 头
      ['+div@text', 'list'],
      ['@css:div.item@text', 'value'],
      ['//div[@id]@text', 'value'],
      ['tag.a@href##x##y', 'value'],
      ['{{@css:a@text}}', 'value'],     // 整条规则就是一个模板区：按字面段收尾
      ['js:return result', 'value'],
      ['div.item', 'list'],
      ['@css:div.item', 'list'],
      ['//div[@id]', 'list'],
      ['@css:p', 'list'],
      ['a@text||b@text', 'value'],
      ['a@text||b', 'list'],
      ['@text||@html', 'list'],         // 多分支里的单段 @ 头不单独升级（ADR-0007）
    ] as const
    for (const [rule, usage] of cases) expect(subRuleOf(rule, 'rule').usage, rule).toBe(usage)
  })

  it('forceUsage 覆盖判据：getElements/getElement 恒 list，规则文本原样保留', () => {
    const sub = subRuleOf('tag.a@href', 'rule', 'list')
    expect(sub.usage).toBe('list')
    expect(sub.rule).toBe('tag.a@href')
  })
})
