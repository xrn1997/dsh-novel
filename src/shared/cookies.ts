/**
 * cookie 串 `k=v; k=v` 的宽松解析：跨半唯一住址（Node 登录脚本与浏览器登录面板共用这一条语法）。
 * 两半各写一遍时，改「怎么切第一个 `=`」漏一处就是一半悄悄换规则。零运行时依赖（inline 进 client bundle）。
 */
export function parseCookieString(raw: string): Record<string, string> {
  const cookies: Record<string, string> = {}
  for (const seg of raw.split(';')) {
    const t = seg.trim()
    if (t === '') continue
    const eq = t.indexOf('=')
    if (eq > 0) cookies[t.slice(0, eq).trim()] = t.slice(eq + 1).trim()   // 无 = 的段跳过，不炸
  }
  return cookies
}
