import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { withoutComments } from './without-comments.js'

/**
 * 注释高度守卫（可检测形）：**注释不抄代码表达式**。带运算符的表达式若在注释与同文件
 * 非注释代码里逐字同，就是把「怎么做」从代码搬进注释——还随代码漂成谎言。
 * 要指实现就指**符号锚**（函数/常量名、抛错消息原文、矩阵行 id）；要写就写为什么/口径。
 *
 * 判断形的「步骤叙述」不进门——那是词表活，只会逼出天天要改的豁免名单；归 AGENTS.md
 * 「高度规范」的自测问题（这句删掉，读者丢的是为什么还是怎么做）。范围：src/** 与
 * tests/** 的注释行；matrix.ts 是证据登记册（外部出处白名单）、docs 归引用锚纪律，都不在本门。
 * **本文件自排除**：合成样品的注释故意含抄写形，对自身扫描必然红——检测器靠样品做功能验证。
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SELF = 'tests/comment-altitude.test.ts'
const OP = /(===|!==|=>|\?\?|\?\.|==|&&|\|\||>=|<=)/

/** `/` 起正则字面量的上一个有效字符（除法前面几乎总是操作数、`)` 或 `]`，不在集合里就当除法
 *  逐字放过）。宁可漏认：漏认只退回逐字扫（与不开这档时同形），认错开档才会吞掉后面的真注释。 */
const REGEX_START = new Set(['', '\n', '=', '(', '[', ',', '!', '&', '|', '?', ':', '{', '}', ';',
  '+', '-', '*', '%', '~', '^', '<', '>'])

/** 取注释体：小词法扫描（字符串态里绝不产注释——XPath 串里的 `//*` 会让正则吞掉后面的真代码，
 *  而剥字符串又会把注释里的反引号锚一起剥掉）。**正则字面量整体跳过**：字符类里带反引号的指针
 *  正则会把字符串态带偏——后续模板串的开头反引号被当成串结束，串体按代码往下扫，其中的
 *  `…/*.md` 形态 glob 字面量又被当成块注释起点，整段真代码冒充注释体，抄写形跟着误伤。
 *  逐字比对的代码基用 withoutComments 原文（字符串保留——表达式抄写常逐字贴着代码串）。 */
function commentBodies(text: string): string[] {
  const out: string[] = []
  let i = 0
  let prev = ''
  while (i < text.length) {
    const two = text.slice(i, i + 2)
    if (two === '//') {
      const end = text.indexOf('\n', i)
      out.push(text.slice(i, end === -1 ? text.length : end))
      i = end === -1 ? text.length : end + 1
      prev = '\n'
    } else if (two === '/*') {
      const end = text.indexOf('*/', i + 2)
      out.push(text.slice(i, end === -1 ? text.length : end + 2))
      i = end === -1 ? text.length : end + 2
      prev = '/'
    } else if (text[i] === "'" || text[i] === '"' || text[i] === '`') {
      const quote = text[i]
      i++
      while (i < text.length && text[i] !== quote) i += text[i] === '\\' ? 2 : 1
      i++
      prev = quote
    } else if (text[i] === '/' && REGEX_START.has(prev)) {
      i++ // 进正则体
      let inClass = false
      while (i < text.length && text[i] !== '\n') {
        if (text[i] === '\\') { i += 2; continue }
        if (text[i] === '[') inClass = true
        else if (text[i] === ']') inClass = false
        else if (text[i] === '/' && !inClass) { i++; break }
        i++
      }
      while (i < text.length && /[a-z]/i.test(text[i])) i++ // 正则 flag
      prev = '/'
    } else {
      if (text[i] === '\n') prev = '\n'
      else if (!/\s/.test(text[i])) prev = text[i]
      i++
    }
  }
  return out
}

/** 注释体里与同文件代码逐字同的「抄写表达式」（带运算符、≥8 字符） */
function copiedExpressions(fileText: string): string[] {
  const code = withoutComments(fileText)
  const out: string[] = []
  for (const c of commentBodies(fileText)) {
    for (const m of c.matchAll(/`([^`]+)`/g)) {
      const span = m[1].trim()
      if (span.length >= 8 && OP.test(span) && code.includes(span)) out.push(span)
    }
    for (const m of c.replace(/`[^`]*`/g, '').matchAll(/[\w$.[\]()'" ]*(?:===|!==|==|>=|<=|\?\?|\?\.|=>|&&|\|\|)[\w$.[\]()'" ]*/g)) {
      const span = m[0].trim()
      if (span.length >= 8 && code.includes(span)) out.push(span)
    }
  }
  return [...new Set(out)]
}

// 合成样品：坏 = 注释抄了紧邻的分支条件；好 = 同一位置只写为什么。
const BAD_SAMPLE = [
  'function pick(rest: string): string[] {',
  '  // 空分支：rest === \'\' 时丢掉，不再向下',
  "  if (rest === '') return []",
  '  return [rest]',
  '}',
].join('\n')
const GOOD_SAMPLE = [
  'function pick(rest: string): string[] {',
  '  // 剥空即零分支：空规则取值是空列表，自然不贡献——等价于丢分支，不是整条失败',
  "  if (rest === '') return []",
  '  return [rest]',
  '}',
].join('\n')

describe('注释不抄代码表达式（高度规范的机器面）', () => {
  it('合成样品：抄写形必被抓住、只写为什么的放行（防检测器空转/误伤）', () => {
    expect(copiedExpressions(BAD_SAMPLE).length, '抄写形没被抓住，检测器已失效').toBeGreaterThan(0)
    expect(copiedExpressions(GOOD_SAMPLE), '好注释被误伤，判定式过宽').toEqual([])
  })

  // 回归样：正则里的反引号曾把字符串态带偏，下面模板串的串体被当代码扫、其中的 `/*` 成了
  // 假块注释起点——真代码冒充注释体，抄写形误伤（现场：矩阵指针门被自己文件里的代码打红）。
  it('字符类里带反引号的指针正则不把后续模板串误当注释体', () => {
    const pointerShape = [
      'const POINTER = /矩阵[`\'“"]?([a-z-]+)/g',
      'const where = `详见 docs/design/*.md 一侧`',
      'const open = COVERAGE.filter((r) => r.status === \'open\')',
    ].join('\n')
    const fakes = commentBodies(pointerShape).filter((b) => b.includes('*.md'))
    expect(fakes, '正则反引号带偏字符串态，模板串体被当成注释').toEqual([])
    expect(copiedExpressions(pointerShape), '误伤的注释体里抄写形跟着误报').toEqual([])
  })

  it('src/ 与 tests/ 的注释里没有抄写表达式（要指就指符号锚）', () => {
    const bad: string[] = []
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.tsx?$/.test(e.name) && !p.endsWith(SELF.replace(/\//g, '\\')) && !p.endsWith(SELF)) {
          for (const span of copiedExpressions(readFileSync(p, 'utf8'))) {
            bad.push(`${p.slice(ROOT.length).replace(/\\/g, '/')}：${span}`)
          }
        }
      }
    }
    walk(join(ROOT, 'src'))
    walk(join(ROOT, 'tests'))
    expect(bad, `注释抄了代码表达式（升到为什么/口径，或改指符号锚）：\n${bad.join('\n  ')}`).toEqual([])
  })
})
