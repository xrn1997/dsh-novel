/**
 * URL 纯工具（从 bridge.ts 迁出——absUrl 是请求组装与链接规约的公共依赖，
 * 放在 bridge 会让 request/engine-fetch/bridge 三方成环：bridge→engineFetch→request→bridge）。
 * 选项后缀那一族同住这里：装配书目的一侧（bridge）也要按同一口径绝对化并保留 `,{option}`，
 * 而它不能 import request——同一个环。
 */
import { URL_OPTION_SPLIT } from '../engine/index.js'

/** URL 绝对化：空 / javascript: / 值内部含空白（多值拼接的产物）/ new URL 解析失败 → null（不猜）。
 *
 * 「内部含空白」这一条不是防御性冗余，是钉死过的真机事故：属性终端把条目里多个 `<a>` 的同一个
 * href 收成多值后，上层以 `\n` 拼接，而 `new URL()` 会**静默吃掉**换行——两截路径拼成一个
 * 看着合法、实际不存在的 URL（多源同型，证据见矩阵行 `b-url-value-first-item`）。
 * 宁可 null（上层按「URL 取不到」如实报错），不产出冒充成功的错 URL。
 * 只拦 WHATWG 解析器会**吃掉**的制表/换行符（`\t\n\r`）——空格不在此列：空格会被百分号编码成
 * `%20`（浏览器同行为），拦空格会打死书名里真带空格的源（英文小说一类）。 */
export function absUrl(href: string | null | undefined, base: string): string | null {
  if (href === null || href === undefined) return null
  const h = href.trim()
  if (h === '' || /^\s*javascript:/i.test(h)) return null
  if (/[\t\n\r]/.test(h)) return null
  try {
    return new URL(h, base).toString()
  } catch {
    return null
  }
}

/** URL 尾部 `,{option}` 后缀切分（章节/下一页 URL 常带——嗅探语义）。
 *  只认「逗号 + 完整 JSON 对象收尾」形态（严格 JSON 或单引号形态），正文里的 `{a,b}` 不误剥。
 *  `suffix` 是**原文**（含逗号），绝对化后原样接回——选项语义由 assembleRequest 在抓取时解释。 */
export function splitUrlOption(href: string): { url: string; suffix: string | null } {
  const m = URL_OPTION_SPLIT.exec(href)
  if (m === null) return { url: href, suffix: null }
  // 同 parseUrlOption 的切分口径（命中即无条件取串首部分，不做尾段 JSON 校验）：
  // 命中即切、**不校验尾段是不是合法 JSON**——后缀原文保留给抓取时的 assembleRequest
  // 解释（解析失败 → 无选项 + warn，URL 已干净）；`{a,b}` 形态不受影响（逗号后不是 `{`，正则不命中）。
  return { url: href.slice(0, m.index).trimEnd(), suffix: href.slice(m.index) }
}

/** URL 尾部的 `,{"webView":true}` 选项后缀剥离（兼容入口——语义即 splitUrlOption().url）。
 *  `webView:true` 已由源请求缝执行；这里只剥选项文本，选项语义归 assembleRequest。 */
export function stripUrlOption(href: string): string {
  return splitUrlOption(href).url
}

/** 绝对化并保留选项后缀（章节/下一页 URL 的组装口径：
 *  URL 部分按 baseUrl 绝对化，`",{option}"` 接回）。不要先 strip 再绝对化：POST/charset
 *  选项会在目录落库时被丢弃，API 型章节端点（POST body 模板）会全部退化成裸 GET。 */
export function absUrlKeepOption(href: string, base: string): string | null {
  const { url, suffix } = splitUrlOption(href)
  const abs = absUrl(url, base)
  if (abs === null) return null
  return suffix === null ? abs : abs + suffix
}
