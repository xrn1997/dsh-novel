import { describe, expect, it } from 'vitest'
import { applyReplaces } from '../../src/engine/replace.js'
import type { EngineValue, ReplaceStep } from '../../src/engine/types.js'
import { RuleEvalError } from '../../src/engine/errors.js'

const step = (pattern: string, replacement = '', flags = ''): ReplaceStep => ({ pattern, flags, replacement })

describe('applyReplaces 净化（## 替换）', () => {
  it('净化：循环替换，逐项作用', () => {
    const v = { kind: 'list', items: ['第一 章　起 点', '第二章 转折'] } as const
    expect(applyReplaces(v as unknown as EngineValue, [step('\\s+', '', 'g')], false))
      .toEqual({ kind: 'list', items: ['第一章起点', '第二章转折'] })
  })

  it('净化作用于 Value.text', () => {
    expect(applyReplaces({ kind: 'value', text: 'a b c' }, [step('\\s+', '-')], false))
      .toEqual({ kind: 'value', text: 'a-b-c' })
  })

  it('OnlyOne 先截取首个匹配、再在该匹配内替换（对面 replaceRegex 的 replaceFirst 分支）', () => {
    // 先取**首个匹配**的那一小段，替换再作用在该小段上——产物就是那一小段
    // （不是「原文里只改第一处」）。此前本仓按后者实现：'aXaX' → 'a-aX'（错值，
    // 净化尾因此留下本该被裁掉的尾巴）。
    const v = { kind: 'value', text: 'aXaX' } as const
    expect(applyReplaces(v as unknown as EngineValue, [step('X', '-')], true))
      .toEqual({ kind: 'value', text: '-' })
    const list = { kind: 'list', items: ['aXaX', 'bXbX'] } as const
    expect(applyReplaces(list as unknown as EngineValue, [step('X', '-')], true))
      .toEqual({ kind: 'list', items: ['-', '-'] })
  })

  it('OnlyOne 无匹配 → 空串（对面 `else -> ""`，不保留原文）', () => {
    expect(applyReplaces({ kind: 'value', text: 'abc' }, [step('X', '-')], true))
      .toEqual({ kind: 'value', text: '' })
  })

  it('OnlyOne 的捕获组引用在截取的匹配内解析', () => {
    // 'xabyab' 首个匹配是 'ab'，在其内 $2$1 → 'ba'（保留原文两处的那条旧实现给不出这个值）
    expect(applyReplaces({ kind: 'value', text: 'xabyab' }, [step('(a)(b)', '$2$1')], true))
      .toEqual({ kind: 'value', text: 'ba' })
  })

  it('OnlyOne 下即使 flags 带 g 也在匹配内只配首处（剥 g 的那一侧改成截取语义）', () => {
    expect(applyReplaces({ kind: 'value', text: 'aXaX' }, [step('X', '-', 'g')], true))
      .toEqual({ kind: 'value', text: '-' })
  })

  it('多个替换步按顺序串联（前一步结果喂给下一步）', () => {
    expect(applyReplaces({ kind: 'value', text: 'a,b;c' }, [step(',', ';'), step('c', 'd')], false))
      .toEqual({ kind: 'value', text: 'a;b;d' })
  })

  it('替换串 $1 等用 JS 原生捕获组语义', () => {
    expect(applyReplaces({ kind: 'value', text: '第3章' }, [step('第(\\d+)章', 'Chapter $1')], false))
      .toEqual({ kind: 'value', text: 'Chapter 3' })
  })

  it('替换结果变空串的项保留（净化不删条目）', () => {
    expect(applyReplaces({ kind: 'list', items: ['abc', 'xyz'] }, [step('abc')], false))
      .toEqual({ kind: 'list', items: ['', 'xyz'] })
    expect(applyReplaces({ kind: 'value', text: 'abc' }, [step('abc')], false))
      .toEqual({ kind: 'value', text: '' })
  })

  it('replaces 为空 → 原值透传（同引用）', () => {
    const v: EngineValue = { kind: 'value', text: 'x' }
    expect(applyReplaces(v, [], false)).toBe(v)
  })

  it('miss / matches 透传（不替换、同引用）', () => {
    const m = { kind: 'miss', detail: 'd' } as const
    expect(applyReplaces(m as unknown as EngineValue, [step('a', 'b')], false)).toBe(m)
    const matches = { kind: 'matches', rows: [['a', 'b']] } as const
    expect(applyReplaces(matches as unknown as EngineValue, [step('a', 'b')], false)).toBe(matches)
  })

  it('非法正则 → RuleEvalError 且带段定位（hits=0，段定位指向该替换步）', () => {
    expect(() => applyReplaces({ kind: 'value', text: 'x' }, [step('a', 'b'), step('(', 'y')], false))
      .toThrow(RuleEvalError)
    try {
      applyReplaces({ kind: 'value', text: 'x' }, [step('a', 'b'), step('(', 'y')], false)
      expect.unreachable('应当抛出 RuleEvalError')
    } catch (e) {
      expect(e).toBeInstanceOf(RuleEvalError)
      const err = e as RuleEvalError
      expect(err.hits).toBe(0)
      expect(err.segmentIndex).toBe(1) // 第 2 个替换步
      expect(err.message).toContain('(') // 消息提及非法 pattern
    }
  })
})

describe('interp 查表只认自有键（不许顺原型链捞 Object.prototype 成员）', () => {
  const b = { baseUrl: 'https://x.com' } as Record<string, string>
  // 插值作用在 pattern/replacement 串上（替换规则先插值再当正则），
  // 所以钉子把 {{键}} 放进 replacement——放进正文文本是测不到 interpolate 的。
  it.each(['toString', 'constructor', '__proto__', 'hasOwnProperty', 'valueOf'])('%s 保持字面', (key) => {
    const replacement = `前{{${key}}}后`
    expect(applyReplaces({ kind: 'value', text: 'X' }, [step('X', replacement)], false, undefined, b))
      .toEqual({ kind: 'value', text: replacement })
  })
  it('真在 bindings 里的键照常插值（收紧不许顺手把正路堵死）', () => {
    expect(applyReplaces({ kind: 'value', text: 'X' }, [step('X', '{{baseUrl}}')], false, undefined, b))
      .toEqual({ kind: 'value', text: 'https://x.com' })
  })
})
