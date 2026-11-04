import { describe, expect, it } from 'vitest'
import { applyReplaces } from '../../src/engine/replace.js'
import type { EngineValue, ReplaceStep } from '../../src/engine/types.js'
import { RuleEvalError } from '../../src/engine/errors.js'
import { valueTextOf } from './value.js'

const step = (pattern: string, replacement = '', flags = ''): ReplaceStep => ({ pattern, flags, replacement })

describe('applyReplaces 净化（## 替换）', () => {
  it('净化：循环替换，逐项作用', () => {
    const v: EngineValue = { kind: 'list', items: ['第一 章　起 点', '第二章 转折'] }
    expect(applyReplaces(v, [step('\\s+', '', 'g')], false))
      .toEqual({ kind: 'list', items: ['第一章起点', '第二章转折'] })
  })

  it('净化作用于 Value.text', () => {
    expect(applyReplaces({ kind: 'value', text: 'a b c' }, [step('\\s+', '-')], false))
      .toEqual({ kind: 'value', text: 'a-b-c' })
  })

  /**
   * 空 pattern 的替换步**整步跳过**——每一处替换都门在「正则非空」上，
   * 空串正则根本不执行。改这里注意：别无条件执行空正则——JS 配 `g` 时在每个字符位置都匹配，
   * 于是 `class.font_max@html####本章未完.*##` 那条尾（`##` 尾的第 2 段是空串、第 3 段才是正则）
   * 把 6.5KB 的一页灌成 **732,311 字符**并写进缓存（一章变半本书）。
   * 这条与 `##` 的「只有一对 + 第 4 段开关」那条分叉是两件事，后者仍登记在矩阵行
   * `a-replace-tail-single-pair`。
   */
  describe('空 pattern 整步跳过（「正则非空」那道门）', () => {
    it('全局净化：空 pattern 不执行，原文一字不动', () => {
      expect(applyReplaces({ kind: 'value', text: 'a b c' }, [step('', 'X')], false))
        .toEqual({ kind: 'value', text: 'a b c' })
    })
    it('OnlyOne：空 pattern 不得把整段替换成空串或replacement', () => {
      expect(applyReplaces({ kind: 'value', text: 'a b c' }, [step('', 'X')], true))
        .toEqual({ kind: 'value', text: 'a b c' })
    })
    it('多步里只跳空的那一步，其余照常作用', () => {
      expect(applyReplaces({ kind: 'value', text: 'a b c' }, [step('', 'X'), step('\\s+', '-')], false))
        .toEqual({ kind: 'value', text: 'a-b-c' })
    })
    it('插值后为空同样跳过（`{{…}}` 查到空串 = 空正则 = 不执行）', () => {
      expect(applyReplaces({ kind: 'value', text: 'a b c' }, [step('{{t}}', 'X')], false, undefined, { t: '' }))
        .toEqual({ kind: 'value', text: 'a b c' })
    })
    it('事故形状：`####正则##` 那条尾作用于整页时不得放大文本', async () => {
      const { evaluate } = await import('../../src/engine/evaluate.js')
      const html = '<div id="c" class="font_max"><p>正文第一句。</p><p>本章未完，点击下一页继续阅读。</p></div>'
      const bare = await evaluate('class.font_max@html', { html, baseUrl: 'http://x/1.html' }, 'content', 'value')
      const tailed = await evaluate('class.font_max@html####本章未完.*##', { html, baseUrl: 'http://x/1.html' }, 'content', 'value')
      expect(bare.kind).toBe('value')
      expect(tailed.kind).toBe('value')
      // 空 pattern 那步被跳过 ⇒ 与不带尾同形（这条源上同样不该发生替换）
      expect(valueTextOf(tailed)).toBe(valueTextOf(bare))
    })
  })

  it('OnlyOne 先截取首个匹配、再在该匹配内替换（首匹配截取，不整串扫）', () => {
    // 先取**首个匹配**的那一小段，替换再作用在该小段上——产物就是那一小段
    // （不是「原文里只改第一处」；按后者读会得错值，净化尾因此留下本该被裁掉的尾巴）。
    const v: EngineValue = { kind: 'value', text: 'aXaX' }
    expect(applyReplaces(v, [step('X', '-')], true))
      .toEqual({ kind: 'value', text: '-' })
    const list: EngineValue = { kind: 'list', items: ['aXaX', 'bXbX'] }
    expect(applyReplaces(list, [step('X', '-')], true))
      .toEqual({ kind: 'list', items: ['-', '-'] })
  })

  it('OnlyOne 无匹配 → 空串（不保留原文）', () => {
    expect(applyReplaces({ kind: 'value', text: 'abc' }, [step('X', '-')], true))
      .toEqual({ kind: 'value', text: '' })
  })

  it('OnlyOne 的捕获组引用在截取的匹配内解析', () => {
    // 'xabyab' 首个匹配是 'ab'，在其内 $2$1 → 'ba'（保留原文两处就给不出这个值）
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
    const m: EngineValue = { kind: 'miss', detail: 'd' }
    expect(applyReplaces(m, [step('a', 'b')], false)).toBe(m)
    const matches: EngineValue = { kind: 'matches', rows: [['a', 'b']] }
    expect(applyReplaces(matches, [step('a', 'b')], false)).toBe(matches)
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

describe('applyReplaces 死线（灾难回溯）', () => {
  it('合法但病态的尾正则 → RuleEvalError 带段定位（不再钉住主线程）', () => {
    // `^(?:a+)+$` 对「长 a + b」是指数级回溯：宁可在死线内判死这一条规则
    const text = `${'a'.repeat(40)}b`
    const err = (() => {
      try {
        applyReplaces({ kind: 'value', text }, [step('', ''), step('^(?:a+)+$', 'x')], false, { facet: 'content' })
      } catch (e) { return e }
      return null
    })()
    expect(err).toBeInstanceOf(RuleEvalError)
    expect((err as RuleEvalError).message).toContain('求值超时')
    expect((err as RuleEvalError).segmentIndex).toBe(1)
  })
})
