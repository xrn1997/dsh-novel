import { describe, expect, it } from 'vitest'
import {
  appendTail, isJsForm, parseTails, splitVarExpr, withImplicitText,
} from '../../src/engine/grammar.js'

/**
 * 规则文法：构词与解析同属一处——round-trip 性质测试钉死
 * 「normalize 拼出来的正是 parse 认的」（此前靠注释跨半同步）。
 */

describe('parseTails（## 尾解析——构词的回程口径）', () => {
  it('链体 + 两两配对的替换步', () => {
    expect(parseTails('@css:.x@text##a##b##c##d')).toEqual({
      chain: '@css:.x@text',
      replaces: [{ pattern: 'a', flags: '', replacement: 'b' }, { pattern: 'c', flags: '', replacement: 'd' }],
      onlyOne: false,
    })
  })
  it('### OnlyOne：剥尾部一个 #，标志位独立', () => {
    const r = parseTails('##:author"[^"]+"([^"]*)##$1###')
    expect(r.chain).toBe('')
    expect(r.replaces).toEqual([{ pattern: ':author"[^"]+"([^"]*)', flags: '', replacement: '$1' }])
    expect(r.onlyOne).toBe(true)
  })
  it('奇数残项：尾部 ## 的切分残留——非空按「pattern 换空串」收编，空串忽略', () => {
    expect(parseTails('x##p##').replaces).toEqual([{ pattern: 'p', flags: '', replacement: '' }])
    expect(parseTails('x##p').replaces).toEqual([{ pattern: 'p', flags: '', replacement: '' }])
    expect(parseTails('x##p##r##').replaces).toEqual([{ pattern: 'p', flags: '', replacement: 'r' }])
  })
  it('无尾：chain 即全串', () => {
    expect(parseTails(' class.a@text ')).toEqual({ chain: 'class.a@text', replaces: [], onlyOne: false })
  })
})

describe('appendTail（构词）→ parseTails round-trip 性质：构词→解析 ≡ 原三元组', () => {
  // 三种方言拼串形态（normalize 三个现场）逐一体验
  const dialectCases: Array<[string, string, string]> = [
    ['@css:#content@textNodes', '广告\\S*', ''],                     // 替换规则（replaceRegex）→ ##正则##
    ['.con@text', '天才一秒记住.*?地址', '请收藏本站.*?地址'],         // Native replaceRules[]
    ['.booktxt p a[href^="/zuozhe"]@text', '^作者\\(a\\)：', ''],      // Native authorPrefix → ##^前缀##
  ]
  for (const [rule, pattern, replacement] of dialectCases) {
    it(`round-trip：${JSON.stringify(pattern)} → ${JSON.stringify(replacement)}`, () => {
      const r = appendTail(rule, pattern, replacement)
      expect(r.warning).toBeNull()
      expect(r.rule).toBe(`${rule}##${pattern}##${replacement}`)
      const base = parseTails(rule)
      const back = parseTails(r.rule)
      expect(back.chain).toBe(base.chain)
      expect(back.replaces).toEqual([...base.replaces, { pattern, flags: '', replacement }])
      expect(back.onlyOne).toBe(false)
    })
  }
  it('round-trip：多步顺序追加（Native replaceRules 多条）', () => {
    let rule = '.con@text'
    for (const [p, rep] of [['a.*', ''], ['b', 'c'], ['d', '']] as Array<[string, string]>) {
      rule = appendTail(rule, p, rep).rule
    }
    expect(parseTails(rule).replaces).toEqual([
      { pattern: 'a.*', flags: '', replacement: '' },
      { pattern: 'b', flags: '', replacement: 'c' },
      { pattern: 'd', flags: '', replacement: '' },
    ])
  })
})

describe('appendTail 构词期越界：当场 warning，不产出求值期谜之结果', () => {
  it('pattern 含 ## → 破坏两两配对，rule 不动 + warning', () => {
    const r = appendTail('@css:#c@text', 'a##b', 'c')
    expect(r.rule).toBe('@css:#c@text')
    expect(r.warning).toMatch(/越界/)
  })
  it('replacement 含 ## → 同样破坏配对，rule 不动 + warning', () => {
    const r = appendTail('@css:#c@text', 'a', 'b##c')
    expect(r.rule).toBe('@css:#c@text')
    expect(r.warning).toMatch(/越界/)
  })
  it('pattern 以 # 结尾 → 与拼接的 ## 粘连（a# + ## = ###），回程配对错位', () => {
    const r = appendTail('@css:#c@text', 'a#', 'b')
    expect(r.rule).toBe('@css:#c@text')
    expect(r.warning).toMatch(/越界/)
  })
  it('追加到 OnlyOne（### 结尾）规则 → 新尾被整规则 onlyOne 标志误伤，warning', () => {
    const r = appendTail('x##p##r###', 'a', 'b')
    expect(r.rule).toBe('x##p##r###')
    expect(r.warning).toMatch(/越界/)
  })
  it('replacement 以 # 结尾 → 不粘连配对，回程无损，放行', () => {
    const r = appendTail('x', 'p', 'r#')
    expect(r.warning).toBeNull()
    expect(parseTails(r.rule).replaces).toEqual([{ pattern: 'p', flags: '', replacement: 'r#' }])
  })
  it('pattern 以 # 开头 → 与前导 ## 粘连成 ###，但 split 非重叠扫仍回读出 (#p→r)，round-trip 无损，放行', () => {
    const r = appendTail('x', '#p', 'r')
    expect(r.warning).toBeNull()
    expect(parseTails(r.rule).replaces).toEqual([{ pattern: '#p', flags: '', replacement: 'r' }])
  })
  it('pattern/replacement 含单个 #（不粘连边界）→ 放行', () => {
    const r = appendTail('x', 'a#b', 'c#d')
    expect(r.warning).toBeNull()
    expect(parseTails(r.rule).replaces).toEqual([{ pattern: 'a#b', flags: '', replacement: 'c#d' }])
  })
})

describe('withImplicitText（隐式终端构词——Native 取值字段语义）', () => {
  it('链体裸选择器补 @text；已有 @ 的分支不动', () => {
    expect(withImplicitText('.itemtxt h3 a')).toBe('.itemtxt h3 a@text')
    expect(withImplicitText('tag.h1@text')).toBe('tag.h1@text')
  })
  it('|| 每个分支各自补', () => {
    expect(withImplicitText('.left||.right')).toBe('.left@text||.right@text')
    expect(withImplicitText('.left@href||.right')).toBe('.left@href||.right@text')
  })
  it('## 净化尾不动（只处理链体）', () => {
    expect(withImplicitText('.con##广告##')).toBe('.con@text##广告##')
    expect(withImplicitText('.booktxt p a[href^=\'/zuozhe\']@text##^作者：##'))
      .toBe('.booktxt p a[href^=\'/zuozhe\']@text##^作者：##')
  })
  it('JS 区域不被 || 撕开（构词与解析对同一文法的认知一致）', () => {
    expect(withImplicitText('<js>return a||b</js>')).toBe('<js>return a||b</js>')
    expect(withImplicitText('@js:return a||b')).toBe('@js:return a||b')
    expect(withImplicitText('js:return a||b')).toBe('js:return a||b')
    // JS 区域与非 JS 分支混用：只给非 JS 分支补 @text
    expect(withImplicitText('.left||<js>return a||b</js>')).toBe('.left@text||<js>return a||b</js>')
  })
})

describe('词法单点：isJsForm / splitVarExpr（template.ts 与搜索面共用同一事实）', () => {
  it('isJsForm：@js: / js: / <js> 开头（容前导空白），其余形态 false', () => {
    expect(isJsForm('@js:key+"x"')).toBe(true)
    expect(isJsForm('  <js>key</js>')).toBe(true)
    expect(isJsForm('JS:key')).toBe(true)
    expect(isJsForm('/search?q={{key}}')).toBe(false)
    expect(isJsForm('$.data.list')).toBe(false)
  })
  it('splitVarExpr：|| 拆分——变量名 trim、缺省值原文（与 interpolateUrl 既有口径逐字一致）', () => {
    expect(splitVarExpr('key')).toEqual({ name: 'key', fallback: null })
    expect(splitVarExpr('key||默认')).toEqual({ name: 'key', fallback: '默认' })
    expect(splitVarExpr(' key ||默认')).toEqual({ name: 'key', fallback: '默认' })
    expect(splitVarExpr('key||')).toEqual({ name: 'key', fallback: '' })
  })
})
