import { describe, expect, it } from 'vitest'
import { bindRegexRow } from '../../src/engine/regex-row.js'
import { parseRule } from '../../src/engine/parse.js'
import { evaluate } from '../../src/engine/evaluate.js'

/**
 * AllInOne 行 → 字段规则文本的 `$n` 绑定（矩阵行 `a-allinone-group-zero` 的实现钉子）。
 *
 * 书源在 AllInOne（整页正则）模式下列出条目后，**同一条目的字段规则是行模板**：
 * `chapterName = $2$3`、`chapterUrl = https://…/$1`——`$n` 取当前行的第 n 组，
 * `$0` 取整段匹配。两条口径（对读记录与出处见矩阵行 `a-allinone-group-zero`）：
 * ① 只扫 `##` 之前的支文本（替换尾里的 `$n` 是替换段的组引用）；
 * ② 含 `$\d` 的支整体进正则模式，绑定后的**原文**就是值（不再按规则解析）。
 */
describe('AllInOne 行绑定 $n', () => {
  const row = ['整段匹配', 'g1', 'g2', 'g3']

  it('$0 取整段、$n 取第 n 组', () => {
    expect(bindRegexRow('$0', row)).toBe('整段匹配')
    expect(bindRegexRow('$1', row)).toBe('g1')
    expect(bindRegexRow('$2$3', row)).toBe('g2g3')
  })

  it('嵌在文本里也替换（URL 模板形态）', () => {
    expect(bindRegexRow('https://a.heiyan.com/ajax/chapter/content/$1', row))
      .toBe('https://a.heiyan.com/ajax/chapter/content/g1')
  })

  it('越界组落空串（行短于引用组号）', () => {
    expect(bindRegexRow('[$9]', row)).toBe('[]')
    expect(bindRegexRow('$0$1', ['只有整段'])).toBe('只有整段')
  })

  it('两位组号', () => {
    const wide = Array.from({ length: 12 }, (_, i) => `v${i}`)
    expect(bindRegexRow('$10', wide)).toBe('v10')
  })

  it('没有 $n 的规则原样返回（纯净选择器不受影响）', () => {
    expect(bindRegexRow('class.list@tag.a@text', row)).toBe('class.list@tag.a@text')
    expect(bindRegexRow('', row)).toBe('')
  })

  // 对面只在 `##` **之前**的支文本上扫 `$\d`（splitRegex 只看 ruleStrArray[0]），
  // 故替换尾里的 `$1` 仍是「替换段的捕获组引用」，不是行组引用。
  it('替换尾里的 $n 不是行组引用（只扫 `##` 之前的支文本）', () => {
    const kinds = parseRule('class.a@text##pat##$1', 'rule', 'value').branches[0].segments.map((s) => s.kind)
    expect(kinds).not.toContain('regexRow')
  })

  it('js 区域豁免：脚本里的 $1 是正则反向引用，不是行组', () => {
    const kinds = parseRule("js:result.replace(/(\\d+)/, '$1')", 'rule', 'value').branches[0].segments.map((s) => s.kind)
    expect(kinds).not.toContain('regexRow')
  })

  it('行模板段：有行给绑定后的原文，没有行给原文（对面 makeUpRule 的两种落点）', async () => {
    const row = ['整段匹配', 'g1', 'g2', 'g3']
    expect(await evaluate('$2$3', { html: 'x', regexRow: row }, 'toc', 'value'))
      .toEqual({ kind: 'value', text: 'g2g3' })
    expect(await evaluate('$2$3', { html: 'x' }, 'toc', 'value'))
      .toEqual({ kind: 'value', text: '$2$3' })
  })

  it('行模板 + ## 尾：先绑行、再生效替换（对面 makeUpRule → replaceRegex 的顺序）', async () => {
    const row = ['m', 'a1', 'a2']
    expect(await evaluate('$1##a##A', { html: 'x', regexRow: row }, 'toc', 'value'))
      .toEqual({ kind: 'value', text: 'A1' })
  })
})
