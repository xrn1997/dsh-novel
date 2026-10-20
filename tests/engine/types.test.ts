import { describe, expect, it } from 'vitest'
import type { EngineValue } from '../../src/engine/types.js'
import { UnsupportedRuleError, RuleEvalError, JsSandboxError } from '../../src/engine/errors.js'

function render(v: EngineValue): string {
  return v.kind === 'miss' ? '<miss>' : JSON.stringify(v)
}

describe('EngineValue 形状', () => {
  it('miss 与空 list 是两种值', () => {
    const miss: EngineValue = { kind: 'miss', detail: 'x' }
    const empty: EngineValue = { kind: 'list', items: [] }
    expect(miss.kind).not.toBe(empty.kind)
    expect(render(miss)).not.toBe(render(empty))
  })
  it('matches 是二维的', () => {
    const m: EngineValue = { kind: 'matches', rows: [['a', 'b'], ['c']] }
    expect(m.rows[0]).toHaveLength(2)
  })
})

describe('错误类型都带段级定位', () => {
  it('UnsupportedRuleError 携带 (facet, 段索引, 原文)', () => {
    const e = new UnsupportedRuleError('未知段类型', { facet: 'search', segmentIndex: 2, segmentRaw: 'weird.x' })
    expect(e.name).toBe('UnsupportedRuleError')
    expect(e.facet).toBe('search')
    expect(e.segmentIndex).toBe(2)
    expect(e.segmentRaw).toBe('weird.x')
    expect(e.message).toContain('weird.x')
  })
  it('RuleEvalError 携带命中数', () => {
    const e = new RuleEvalError('零命中', { facet: 'toc', segmentIndex: 0, segmentRaw: 'class.a', hits: 0 })
    expect(e.hits).toBe(0)
  })
  it('JsSandboxError 携带脚本原文与行号', () => {
    const e = new JsSandboxError('boom', { facet: 'content', segmentIndex: 1, segmentRaw: '@js:x.y', script: 'x.y', line: 1 })
    expect(e.script).toBe('x.y')
    expect(e.line).toBe(1)
    expect(e.message).toContain('第1行')
  })
})
