import { describe, expect, it } from 'vitest'
import { CONFIG_FIELDS } from '../../src/config.js'
import { GROUPS } from '../../src/client/config-groups.js'
import { SETTINGS_ZH } from '../../src/client/copy/settings.js'
import { must } from '../support/fixture.js'

/**
 * 配置页「界面隐身」的机器面：一个 volatile 字段要真能被看见，靠的是三份清单同时认它——
 * 配置缝的字段表（`CONFIG_FIELDS`）、中文文案字典（`SETTINGS_ZH`）与页面分区表（`GROUPS`）。
 * 少文案 = 行里露出键名；漏分区 = 字段在页面上根本不存在。三份各自齐全只是必要条件，
 * 走一个文件对读才算把「界面隐身」变成测试红（Node 侧的测试不受浏览器半分层方向约束）。
 */
const VOLATILE_NAMES = Object.entries(CONFIG_FIELDS)
  .filter(([, spec]) => spec.volatile)
  .map(([name]) => name)

describe('volatile 字段的文案与分区交叉校验', () => {
  it('字段表里有 volatile 字段（交叉校验不对着空集报绿）', () => {
    expect(VOLATILE_NAMES.length).toBeGreaterThan(0)
  })

  it('每个 volatile 字段在中文文案里都有 label 与 meaning', () => {
    const zh = SETTINGS_ZH as Record<string, string>
    for (const name of VOLATILE_NAMES) {
      for (const suffix of ['label', 'meaning']) {
        const key = `config.field.${name}.${suffix}`
        expect(zh[key], `缺文案键 ${key}`).toBeTypeOf('string')
        expect(must(zh[key], `文案键 ${key}`).trim(), `文案键 ${key} 是空串`).not.toBe('')
      }
    }
  })

  it('每个 volatile 字段恰落一个分区：无漏项、无重复', () => {
    const grouped = GROUPS.flatMap((group) => group.names)
    expect(new Set(grouped).size, `同一字段出现在多个分区：${grouped.join(', ')}`).toBe(grouped.length)
    expect([...grouped].sort()).toEqual([...VOLATILE_NAMES].sort())
  })
})
