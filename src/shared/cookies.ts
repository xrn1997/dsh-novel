/**
 * cookie 串的宽松 `k=v; k=v` 解析：跨半唯一住址。两条来源共用这一条语法——Node 半的登录脚本
 * （`loginUrl` 的 JS 形态）产出的一段 cookie 串，与浏览器半登录面板里用户手工粘贴的那一段。
 * 两半各写一遍就是给同一条语法两个主人：改「怎么切第一个 `=`」时要改两处，漏一处就是一半悄悄换规则。
 *
 * 零运行时依赖（本文件会被整个 inline 进 client bundle，纯度门同样适用于它）。
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
