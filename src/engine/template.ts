import { splitVarExpr } from './grammar.js'

/** URL 与 `,{json}` 选项的分界：逗号后紧跟花括号即选项
 *  起点，故 URL 自身含逗号时不受影响；逗号两侧允许空白——真实源大量写 `, {...}` 带空格，
 *  不许空格会把选项串并进 URL（此前 165 条源的 POST/charset 选项全部失效）。
 *  **单点**：服务半 `services/request.ts` 的选项切分与引擎 `engine/js-protocol.ts` 的
 *  downloadFile 去后缀共用此式。放引擎侧是因为 `js-protocol` 不能 import services（分层禁环），
 *  而两处各抄一份已经漂移过一次（downloadFile 那份少了前导 `\s*`，带空格的 URL 会把尾空格
 *  带进扩展名推断）。 */
export const URL_OPTION_SPLIT = /\s*,\s*(?=\{)/

export function interpolateUrl(
  template: string,
  vars: Record<string, string | number>,
): string {
  return template.replace(/\{\{([^{}]*)\}\}/g, (whole, inner: string) => {
    // 词法拆分归 grammar.splitVarExpr 单点（模板侧与搜索面共用同一份，不各写一个 || 拆分）
    const { name, fallback } = splitVarExpr(inner)
    // 不是占位形态（JS 表达式 / 取不到的标识符）→ 本函数不动它：搜索面已按 JS 求值过
    if (!isPlaceholderExpr(inner, vars)) return whole
    if (Object.hasOwn(vars, name)) return encodeURIComponent(String(vars[name]))
    return fallback ?? whole
  })
}

/** `{{内部}}` 是不是「变量占位」（词法是标识符，且**在 vars 里**或带 `||` 兜底）——
 *  interpolateUrl 与搜索面 preEvaluateUrlJs 共用这一条：前者照它做编码，后者照它决定
 *  「原样留给编码」还是「当 JS 表达式进沙箱」。
 *
 *  为什么必须判 vars 而不是只看词法（旧口径就是只看词法，`2026-09-26` 得间小说实证）：
 *  源级 jsLib 定义的全局变量在模板里也是裸标识符（`{{host}}`），插值期对**每一段** `{{…}}`
 *  都过 JS 求值（引擎里装着 jsLib）——一律当占位会让这类模板把字面花括号
 *  发上网（`%7B%7Bhost%7D%7D` → 404）。 */
export function isPlaceholderExpr(inner: string, vars: Record<string, string | number>): boolean {
  const { name, fallback } = splitVarExpr(inner)
  return /^[\w$]+$/.test(name) && (Object.hasOwn(vars, name) || fallback !== null)
}

/** 页码角列表形态：`<(.*?)>` */
const PAGE_ANGLE_LIST = /<(.*?)>/g

/**
 * `<a,b,c>` 按页取值。口径逐条钉死：
 * - **`page` 为 null 就不动**——没参与翻页时尖括号原样留在 URL 上；
 * - `pages = 内容.split(',')`，`page < pages.length` 取 `pages[page-1]`，**越界取末项**（= 到底）；
 * - 取出的项只剥首尾控制符/空白；
 * - 每个匹配**全量**替换该匹配串（替换全部出现，不是只替第一个）。
 * 真源实证：恩京的书房 `/<,page/{{page}}/>?s={{key}}` —— page=1 时按本口径换成**空串**，
 * 本仓此前原样带尖括号发出去（保真差，非坏源）。
 */
export function expandPageAngleList(url: string, page: number | null | undefined): string {
  if (page === null || page === undefined) return url
  const matches = [...url.matchAll(PAGE_ANGLE_LIST)]
  let out = url
  for (const m of matches) {
    const pages = m[1].split(',')
    const picked = page < pages.length ? pages[page - 1] : pages[pages.length - 1]
    out = out.split(m[0]).join((picked ?? '').replace(/^[\s\x00-\x1F]+|[\s\x00-\x1F]+$/g, ''))
  }
  return out
}
