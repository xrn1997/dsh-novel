/**
 * 「已知开口」节的解析单点：coverage 的裁决型措辞判据与 citation-liveness 的编号活性判据
 * 共用这一份。此前各写一份且**已经不一致**（一份取最后一个标题、一份取第一个子串命中；
 * 一份在下一个标题处停、一份扫到文件尾——后续章节的编号会被误算进开口编号表），
 * 而这两条判据的分工恰恰是防「静默指错东西」，解析器先漂就全白防。
 */

/** 把某份文档「已知开口」那一节解析成编号条目（含缩进续行聚合）。
 *  「已知开口」这个词也出现在目录与正文提及里 ⇒ 取**最后一个标题行**命中；
 *  条目只认**顶层**编号行（`N. …`），缩进续行并入上一条正文——那是条目展开，不是新条目。
 *  找不到节 → null（调用方自己决定是抛还是记「没有这节」）。 */
export function parseOpenItems(text: string): Array<{ num: string; body: string }> | null {
  const lines = text.split(/\r?\n/)
  let start = -1
  for (let i = 0; i < lines.length; i++) if (/^#{2,4} .*已知开口/.test(lines[i])) start = i
  if (start < 0) return null
  const items: Array<{ num: string; body: string }> = []
  let cur: { num: string; body: string } | null = null
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{2,4} /.test(lines[i])) break
    const m = lines[i].match(/^(\d+)\.\s+(.*)$/)
    if (m) { if (cur) items.push(cur); cur = { num: m[1], body: m[2] }; continue }
    if (cur && /^\s{2,}\S/.test(lines[i])) cur.body += ' ' + lines[i].trim()
  }
  if (cur) items.push(cur)
  return items
}
