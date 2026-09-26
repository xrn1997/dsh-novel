import { braceRegion } from './grammar.js'

/**
 * 模板字面段（CONTEXT.md「模板字面段」）的识别与切分——构词（normalize/服务层拼串）与
 * 解析（parse/evaluate 消费）共用同一份认知，唯一实现住这里。
 *
 * 口径：规则串里出现 `{{expr}}` 时逐段插值——expr 以 `@`/`$.`/`$[`/`//` 开头按**规则递归求值**，
 * 否则按 **JS 表达式**求值（绑定 result/baseUrl/book/chapter/key/page…）；
 * 插值后整段不构成选择器 → 原样作为字面串产出。`{$.path}`（单括号）是 JSONPath 内嵌形态
 * （平衡括号切分）。
 *
 * 为什么单独成段：真实源大量形态是「URL 模板」型规则——`http://api/novel/{{$.novelId}}`、
 * `{{baseUrl}}catalog/`、`https://...?id={{(baseUrl.match(...)||['',''])[1]}}`——它们不是
 * 选择器也不是取值终端，按旧口径全部在解析期抛「无法识别的段类型」（实测 15+ 源）。
 */

export interface LiteralPart {
  /** text=字面文本；js=JS 表达式（沙箱求值）；rule=规则串（引擎递归求值）；jsonpath=JSONPath（单括号内嵌）；getvar=@get 变量 */
  kind: 'text' | 'js' | 'rule' | 'jsonpath' | 'getvar'
  text: string
}

/** 这一段是不是模板字面段（parse 分类判据单点） */
export function isLiteralForm(raw: string): boolean {
  if (raw.includes('{{')) return true
  if (/^https?:\/\//i.test(raw)) return true
  if (/\{\$[^{}]+\}/.test(raw)) return true // `{$.path}` 单括号 JSONPath 内嵌
  return false
}

/** `{{...}}` 平衡括号切分（引号内的花括号不计深） */
export function splitLiteral(raw: string, opts?: { doubleBraceOnly?: boolean }): LiteralPart[] {
  // doubleBraceOnly：js 段代码文本的插值口径——只认 `{{…}}`。JS 自己就有模板字面量
  // `${expr}` 与对象字面量 `{{…}}`（少见），把单括号 `{$…}` 当插值点会把脚本里的
  // `${$.id}`（map 回调参数 `$` 的属性）撕成 JSONPath（真机实证：中文书城
  // ruleToc.chapterList 因此整段 Miss、目录 0 章）。js 段代码文本的插值统一只认双花括号，
  // 与本口径一致。
  const doubleOnly = opts?.doubleBraceOnly === true
  const parts: LiteralPart[] = []
  let buf = ''
  let i = 0
  const flushText = (): void => {
    if (buf !== '') { parts.push({ kind: 'text', text: buf }); buf = '' }
  }
  while (i < raw.length) {
    // @get:{key} / @get:key 形态（求值期的变量插值点）
    if (!doubleOnly && raw.startsWith('@get:', i)) {
      let name = ''
      let j: number
      if (raw[i + 5] === '{') {
        const end = raw.indexOf('}', i + 6)
        if (end === -1) { buf += raw.slice(i); i = raw.length; continue }
        name = raw.slice(i + 6, end); j = end + 1
      } else {
        const m = /^@get:([\w.-]+)/.exec(raw.slice(i))
        if (m === null) { buf += raw[i]; i++; continue }
        name = m[1]; j = i + m[0].length
      }
      flushText(); parts.push({ kind: 'getvar', text: name }); i = j; continue
    }
    if (raw.startsWith('{{', i)) {
      // 括号扫描归 grammar.braceRegion（与 parse 的段切分共用同一份认知——两处各写一份时，
      // 段切分先把区内的 `@` 当段界，`{{@@规则}}` 就永远进不到字面段，这里曾长期错报「无法识别的段类型」）
      const region = braceRegion(raw, i)
      if (region === null) { buf += raw.slice(i); i = raw.length; continue } // 未闭合：按字面（不猜）
      const expr = raw.slice(i + 2, region.contentEnd).trim()
      flushText()
      parts.push(classifyExpr(expr))
      i = region.end
      continue
    }
    // 单括号 JSONPath 内嵌：{$.path}
    const single = doubleOnly ? null : /^\{\$([^{}]+)\}/.exec(raw.slice(i))
    if (single !== null) {
      flushText(); parts.push({ kind: 'jsonpath', text: `$${single[1]}` }); i += single[0].length; continue
    }
    buf += raw[i]; i++
  }
  flushText()
  return parts
}

/** `{{expr}}` 内容分类（`@`/`$.`/`$[`/`//` 开头按规则，否则 JS） */
function classifyExpr(expr: string): LiteralPart {
  if (expr === '') return { kind: 'text', text: '' }
  if (expr.startsWith('@') || expr.startsWith('$.') || expr.startsWith('$[') || expr.startsWith('//')) {
    return { kind: 'rule', text: expr }
  }
  return { kind: 'js', text: expr }
}
