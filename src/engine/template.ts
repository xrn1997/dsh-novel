import { splitVarExpr } from './grammar.js'

/** URL 与 `,{json}` 选项的分界（legado `AnalyzeUrl.paramPattern` 原文）：逗号后紧跟花括号即选项
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
    // 词法拆分归 grammar.splitVarExpr 单点（此前与搜索面 isPureVarExpr 各写一份 || 拆分）
    const { name, fallback } = splitVarExpr(inner)
    if (Object.hasOwn(vars, name)) return encodeURIComponent(String(vars[name]))
    if (fallback !== null) return fallback
    return whole
  })
}

/** 对面的页码角列表形态：`<(.*?)>`（`AnalyzeUrl` 的 `pagePattern`） */
const PAGE_ANGLE_LIST = /<(.*?)>/g

/**
 * `<a,b,c>` 按页取值（对面 `AnalyzeUrl.replaceKeyPageJs` 的 page 段）。口径逐条照抄：
 * - **`page` 为 null 就不动**（对面整段在 `page?.let{}` 里）——没参与翻页时尖括号原样留在 URL 上；
 * - `pages = 内容.split(',')`，`page < pages.size` 取 `pages[page-1]`，**越界取末项**（= 到底）；
 * - 取出的项 `trim { it <= ' ' }`（只剥首尾控制符/空白）；
 * - 每个匹配**全量**替换该匹配串（Kotlin `String.replace(String,String)` 替全部，不是只替第一个）。
 * 真源实证：恩京的书房 `/<,page/{{page}}/>?s={{key}}` —— page=1 时对面把它换成**空串**，
 * 本仓此前原样带尖括号发出去，两边发的 URL 不同（保真差，非坏源）。
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
