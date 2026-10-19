/** 粘贴内容预检（客户端只做即时反馈，服务端 normalize 是权威——口径只松不严）：
 * 文件导入不经此——原文直通服务端后台任务；textarea 只留给小体量粘贴场景。 */

/** 条目预检结果：缺失字段点名（ruleContent 对象形态含非空 content 也算合法） */
export interface ItemCheck { index: number; name: string; missing: string[] }

/** 导入预检：ok = 结构可解析（对象或非空数组）→ 导入按钮可用；坏条目只提示不连坐——
 *  数组里第一条坏不该挡后面好源（服务端逐条 outcome 本就独立）。 */
export function validateSourceJson(text: string): { ok: boolean; total: number; bad: ItemCheck[] } {
  if (text.trim() === '') return { ok: false, total: 0, bad: [] }
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { return { ok: false, total: 0, bad: [] } }
  const items = Array.isArray(parsed) ? parsed : [parsed]
  if (items.length === 0) return { ok: false, total: 0, bad: [] }
  const bad: ItemCheck[] = []
  items.forEach((item, index) => {
    const r = item as Record<string, unknown> | null
    if (typeof r !== 'object' || r === null) {
      bad.push({ index, name: '(不是对象)', missing: ['(整条不是 JSON 对象)'] })
      return
    }
    const missing: string[] = []
    if (typeof r.bookSourceName !== 'string' || r.bookSourceName === '') missing.push('bookSourceName')
    if (typeof r.bookSourceUrl !== 'string' || r.bookSourceUrl === '') missing.push('bookSourceUrl')
    if (!hasContentRule(r.ruleContent)) missing.push('ruleContent')
    if (missing.length > 0) {
      bad.push({ index, name: typeof r.bookSourceName === 'string' && r.bookSourceName !== '' ? r.bookSourceName : `#${index + 1}`, missing })
    }
  })
  return { ok: true, total: items.length, bad }
}

/** ruleContent 合法形态：非空字符串，或对象形态（legado 嵌套方言）且 content 子字段非空 */
function hasContentRule(v: unknown): boolean {
  if (typeof v === 'string') return v.length > 0
  if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
    const c = (v as Record<string, unknown>).content
    return typeof c === 'string' && c.length > 0
  }
  return false
}
