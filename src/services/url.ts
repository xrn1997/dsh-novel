/**
 * URL 纯工具（从 bridge.ts 迁出——absUrl 是请求组装与链接规约的公共依赖，
 * 放在 bridge 会让 request/engine-fetch/bridge 三方成环：bridge→engineFetch→request→bridge）。
 */

/** URL 绝对化：空 / javascript: / 值内部含空白（多值拼接的产物）/ new URL 解析失败 → null（不猜）。
 *
 * 「内部含空白」这一条不是防御性冗余，是钉死过的真机事故：属性终端把条目里多个 `<a>` 的同一个
 * href 收成多值后，上层以 `\n` 拼接，而 `new URL()` 会**静默吃掉**换行 ——
 * `/book/4242/\n/book/4242/` 变成 `https://www.aaccoo.com/book/4242//book/4242/`，
 * 一个看着合法、实际指向不存在路径的 URL（久久小说 / 成人小说网 / 逆鳞小说 等 6+ 源同型）。
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
