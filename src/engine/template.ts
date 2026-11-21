import { splitVarExpr } from './grammar.js'

/** URL 与 `,{json}` 选项的分界：逗号后紧跟花括号即选项起点，故 URL 自身含逗号时不受影响；逗号两侧允许
 *  空白。**单点**：`services/request.ts` 与 `js-protocol.ts` 的 downloadFile 去后缀共用此式（放引擎侧是
 *  因为 js-protocol 不能 import services；两处各抄一份会漂移）。 */
export const URL_OPTION_SPLIT = /\s*,\s*(?=\{)/

/** `{{…}}` 段扫描（**单点**）：模板拆成字面文本与 `{{expr}}` 段——`expr` 是花括号内的原文，`raw` 是整段
 *  匹配串（判「原样保留」的段要回它）。interpolateUrl 的逐段插值、搜索面 `preEvaluateUrlJs` 与朗读面
 *  模板预求值共用这一份拆分，不各扫一份。 */
export type TemplateSegment =
  | { kind: 'text'; text: string }
  | { kind: 'expr'; expr: string; raw: string }

export function scanTemplateSegments(template: string): TemplateSegment[] {
  const re = /\{\{([^{}]*)\}\}/g
  const segments: TemplateSegment[] = []
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(template)) !== null) {
    if (m.index > last) segments.push({ kind: 'text', text: template.slice(last, m.index) })
    segments.push({ kind: 'expr', expr: template.slice(m.index + 2, m.index + m[0].length - 2), raw: m[0] })
    last = m.index + m[0].length
  }
  if (last < template.length) segments.push({ kind: 'text', text: template.slice(last) })
  return segments
}

export function interpolateUrl(
  template: string,
  vars: Record<string, string | number>,
): string {
  let out = ''
  for (const seg of scanTemplateSegments(template)) {
    if (seg.kind === 'text') {
      out += seg.text
      continue
    }
    // 词法拆分归 grammar.splitVarExpr 单点（模板侧与搜索面共用同一份）
    const { name, fallback } = splitVarExpr(seg.expr)
    // 不是占位形态（JS 表达式 / 取不到的标识符）→ 本函数不动它：搜索面已按 JS 求值过
    if (!isPlaceholder(name, fallback, vars)) {
      out += seg.raw
      continue
    }
    out += Object.hasOwn(vars, name) ? encodeURIComponent(String(vars[name])) : (fallback ?? seg.raw)
  }
  return out
}

/** `{{内部}}` 是不是「变量占位」（词法是标识符，且**在 vars 里**或带 `||` 兜底）——interpolateUrl 与
 *  搜索面 preEvaluateUrlJs 共用这一条：前者照它做编码，后者照它决定「原样留给编码」还是「当 JS 表达式
 *  进沙箱」。必须判 vars 而不只看词法：源级 jsLib 定义的全局变量在模板里也是裸标识符（`{{host}}`），
 *  一律当占位会让这类模板把字面花括号发上网（404）。 */
export function isPlaceholderExpr(inner: string, vars: Record<string, string | number>): boolean {
  const { name, fallback } = splitVarExpr(inner)
  return isPlaceholder(name, fallback, vars)
}

/** 判定核心吃**已拆开的** name/fallback——interpolateUrl 拆过一次后直调这里。 */
function isPlaceholder(name: string, fallback: string | null, vars: Record<string, string | number>): boolean {
  return /^[\w$]+$/.test(name) && (Object.hasOwn(vars, name) || fallback !== null)
}

const PAGE_ANGLE_LIST = /<(.*?)>/g

/**
 * `<a,b,c>` 按页取值。口径逐条钉死：**`page` 为 null 就不动**（尖括号原样留在 URL 上）；
 * `page < pages.length` 取 `pages[page-1]`，否则**越界取末项**（= 到底）；取出的项只剥首尾控制符/空白；
 * 每个匹配**全量**替换。不要原样带尖括号发出去：page=1 按本口径应换成空串。
 */
export function expandPageAngleList(url: string, page: number | null | undefined): string {
  if (page === null || page === undefined) return url
  const matches = [...url.matchAll(PAGE_ANGLE_LIST)]
  let out = url
  for (const m of matches) {
    const inner = m[1]
    if (inner === undefined) continue
    const pages = inner.split(',')
    const picked = page < pages.length ? pages[page - 1] : pages[pages.length - 1]
    out = out.split(m[0]).join((picked ?? '').replace(/^[\s\x00-\x1F]+|[\s\x00-\x1F]+$/g, '')) // eslint-disable-line no-control-regex -- 控制字符正是清理对象
  }
  return out
}
