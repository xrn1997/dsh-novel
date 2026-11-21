import type { ChapterContent, ContentNode } from './wire.js'

/**
 * 正文投影与播放单元切分：文字面在 Node 半与浏览器半之间的唯一口径（导出、AI 工具、阅读器与播放层共用）。
 * 播放层按 `splitParagraphs` 切单元，屏上段号是这批单元的对位面（`playUnitStarts` / `playUnitStartsByNode`）。
 * 零运行时依赖（只 type-only import `./wire.js`）；本文件 inline 进 client bundle，纯度门管这一条。
 *
 * 两个分支：① `text` 行内逐字通过，只做空白行规约（`normalizeChapterText`，幂等），不解释尖括号、
 * 不解实体——再解释一次会吃掉小说里合法的标签字样；② `rich` 只遍历本树，不追链接目标（会绕圈重复整本），
 * 不输出资源/节点 ID 与任何存储路径。
 *
 * 结构映射（正文契约按 `\n` 分段）：块级元素各自落一行，行内只留文字；表格行以 `\n` 分隔、单元格以制表符
 * 分列；`<br>` 落成换行；分隔线不发明字符但同样收行（`a<hr/>b` → `a\nb`）；图片输出 `[图片：替代文字]`
 * 或 `[图片]`；pre 子树逐字保留。块级元素出现在行内上下文时仍按块自己的投影取值（钉子见
 * `tests/shared/chapter-text.test.ts` 的「链接里套 pre」）。
 *
 * rich 分支的行规约（源码空白折单空格、逐行 trim、丢空行）由投影自己承担：rich 不过 `normalizeChapterText`，
 * 而逐行 trim 会丢 pre 缩进；投影里不规约又会把排版 XHTML 的缩进带进文字面。故非 pre 收口、pre 整棵绕过。
 * 折叠边界是「源码排版 vs 硬断行」：只有 `<br>` 与块级边界才断行；pre 两样都不做。口径见 `SOURCE_WS`。
 */

/** 块级元素：边界即换行（浏览器渲染语义）。b/i 与结构容器在导入期已规范为 strong/em/div */
const BLOCK_TAGS: ReadonlySet<string> = new Set([
  'p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote',
  'pre', 'ul', 'ol', 'li', 'table', 'caption', 'thead', 'tbody', 'tfoot', 'tr',
])

/** 单元格：表格行内的列边界（见 rowLines） */
const CELL_TAGS: ReadonlySet<string> = new Set(['td', 'th'])

/** 源码的可折叠空白：HTML 渲染把连续空白折成一个空格；`\s` 含 NBSP 与全角空格。对照口径是
 *  `src/engine/dom.ts` 的 `nodeText`，不是 `cleanText`（后者不折 NBSP）。 */
const SOURCE_WS = /\s+/g

/** 一条已定形的行（行内无换行）+ 起始块节点 id（null = 行内内容/硬断行/分隔线起头）。
 *  行携带块身份，才能让文字面、播放单元与段号共用同一份清单。 */
export interface ChapterContentLine {
  readonly text: string
  readonly nodeId: string | null
}

/** 正文 → 行清单（文字面与阅读器段号的共同来源）；text 分支无块身份。 */
export function chapterContentLines(content: ChapterContent): ChapterContentLine[] {
  if (content.kind === 'text') {
    const text = normalizeChapterText(content.text)
    return text === '' ? [] : text.split('\n').map((line) => ({ text: line, nodeId: null }))
  }
  return flowLines(content.nodes, false)
}

export function chapterContentToText(content: ChapterContent): string {
  // text 分支只做空白行规约：不套 contentToText/htmlToText（头注 ①）
  if (content.kind === 'text') return normalizeChapterText(content.text)
  return flowLines(content.nodes, false).map((line) => line.text).join('\n')
}

/** 正文文字的行规约：逐行 trim → 去首尾空行 → 相邻空行折叠一个；对已规约文本幂等，只动空白与换行。 */
export function normalizeChapterText(raw: string): string {
  const lines = raw.split('\n').map((l) => l.trim())
  while (lines.length > 0 && lines[0] === '') lines.shift()
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  const out: string[] = []
  for (const l of lines) {
    if (l === '' && out[out.length - 1] === '') continue
    out.push(l)
  }
  return out.join('\n')
}

/** 行规约：行内空白折单空格、逐行 trim、丢空行，只在非 pre 行调用。跨节点的连续空白只有拼行后才看得出，故折第二次是必要的。 */
function collapseLines(block: string): string {
  return block
    .split('\n')
    .map((line) => line.replace(SOURCE_WS, ' ').trim())
    .filter((line) => line !== '')
    .join('\n')
}

/** 行内上下文的一段：`soft` 并入当前行的可折叠文本；`block` 是已定形的块行清单（pre 逐字、表格行、块级子树）。
 *  块行须以清单传递，否则列关系与逐字空白会被外层规约吃掉。 */
type Segment =
  | { kind: 'soft'; text: string }
  | { kind: 'block'; lines: ChapterContentLine[] }

/** 块级节点 → 块行清单：表格行制表符分列，其余按子树块序列；行内上下文与块序列共用这一处判据。 */
function blockSegment(node: Extract<ContentNode, { kind: 'element' }>, verbatim: boolean): Segment {
  const lines = node.tag === 'tr'
    ? rowLines(node, verbatim)
    : flowLines(node.children, verbatim || node.tag === 'pre')
  // 块投影的首行「始于」这个块；更内层块已认领时不动——嵌套共用一行时段号归内层（真正承载锚点的元素）。
  const first = lines[0]
  if (first !== undefined && first.nodeId === null) lines[0] = { text: first.text, nodeId: node.id }
  return { kind: 'block', lines }
}

/** 块序列 → 行清单：行内内容拼成一行，块级元素各自成行；pre 子树内 `verbatim` 不做行规约。 */
function flowLines(nodes: readonly ContentNode[], verbatim: boolean): ChapterContentLine[] {
  const lines: ChapterContentLine[] = []
  let inline = ''
  /** 收当前行：非 pre 折空白、trim 并丢空行（块级边界与源码排版缩进都不留痕），pre 逐字保留 */
  const flush = (): void => {
    const line = verbatim ? inline : collapseLines(inline)
    // 逐字内容里的换行是行边界（pre 的换行原样带出），行规约过的内容已无空行
    if (line !== '') for (const text of line.split('\n')) lines.push({ text, nodeId: null })
    inline = ''
  }
  /** 落一段：软文本并入当前行；块行先收行、再原样入列（不再过行规约） */
  const put = (seg: Segment): void => {
    if (seg.kind === 'soft') { inline += seg.text; return }
    flush()
    // 纯空白的块整份不收（与收行同一条「空行不是内容」）；有内容的块连它内部的空行一起保留
    if (seg.lines.some((line) => line.text.trim() !== '')) lines.push(...seg.lines)
  }
  for (const node of nodes) {
    if (node.kind === 'rule') {
      flush()
      continue
    }
    if (node.kind === 'element' && BLOCK_TAGS.has(node.tag)) {
      put(blockSegment(node, verbatim))
      continue
    }
    for (const seg of inlineSegments(node, verbatim)) put(seg)
  }
  flush()
  return lines
}

/** 行内节点 → 片段序列：叶子落软文本，链接与行内元素继续下钻，故子树里的块级节点仍按块取值。
 *  片段自身不 trim（行首尾空白归外层），否则会吃掉渲染上真实存在的空格。 */
function inlineSegments(node: ContentNode, verbatim: boolean): Segment[] {
  // 分隔线在行内同样是**边界**（`a<hr/>b` 收行成 `a\nb`），空块行只收行、不发明字符
  if (node.kind === 'rule') return [{ kind: 'block', lines: [] }]
  if (node.kind === 'element' && BLOCK_TAGS.has(node.tag)) return [blockSegment(node, verbatim)]
  if (node.kind === 'text') return [{ kind: 'soft', text: verbatim ? node.text : node.text.replace(SOURCE_WS, ' ') }]
  if (node.kind === 'image') {
    // 判空与输出用同一个 trim：`alt: ' 地图 '` 的输出里不留源文件的排版空白
    const alt = node.alt.trim()
    return [{ kind: 'soft', text: alt === '' ? '[图片]' : `[图片：${alt}]` }]
  }
  if (node.kind === 'break') return [{ kind: 'soft', text: '\n' }]   // 硬断行，但仍是行内文本
  // 链接与（非块级）元素：只留文字——链接的 target 是跳转意图，不在这里展开（头注 ②）；role 同理
  const out: Segment[] = []
  let soft = ''
  const pushSoft = (): void => { if (soft !== '') { out.push({ kind: 'soft', text: soft }); soft = '' } }
  for (const child of node.children) {
    for (const seg of inlineSegments(child, verbatim)) {
      if (seg.kind === 'soft') { soft += seg.text; continue }
      pushSoft()
      out.push(seg)
    }
  }
  pushSoft()
  return out
}

/** 表格行：单元格以制表符分界；行内杂散文字（非规范 XHTML）纯空白丢弃、其余整体并入末列（不为它猜列序）。
 *  制表符在各格收口后拼上，整行不再过行规约。 */
function rowLines(row: Extract<ContentNode, { kind: 'element' }>, verbatim: boolean): ChapterContentLine[] {
  const cells: ChapterContentLine[][] = []
  let stray = ''
  for (const child of row.children) {
    if (child.kind === 'element' && CELL_TAGS.has(child.tag)) {
      cells.push(flowLines(child.children, verbatim))
      continue
    }
    stray += segmentsToText(inlineSegments(child, verbatim))
  }
  const tail = verbatim ? stray : collapseLines(stray)
  if (tail !== '') cells.push(tail.split('\n').map((text) => ({ text, nodeId: null })))
  return joinCells(cells)
}

/** 单元格行清单 → 整行清单：与 `cells.join('\t')` 同形——分隔符接上一格末行、下一格首行并入同一行；
 *  空单元格仍占一个分隔符；合并行沿用前一格的起始块身份。 */
function joinCells(cells: readonly ChapterContentLine[][]): ChapterContentLine[] {
  const out: ChapterContentLine[] = []
  const append = (sep: string, text: string, nodeId: string | null): void => {
    const last = out.at(-1)
    if (last === undefined) out.push({ text: sep + text, nodeId })
    else out[out.length - 1] = { text: last.text + sep + text, nodeId: last.nodeId }
  }
  for (const [index, cell] of cells.entries()) {
    const sep = index === 0 ? '' : '\t'
    const head = cell[0]
    if (head === undefined) { append(sep, '', null); continue }
    append(sep, head.text, head.nodeId)
    out.push(...cell.slice(1))
  }
  return out
}

/** 片段序列 → 一段文本（块两侧留换行）；只给没有别的落点的杂散内容用。 */
function segmentsToText(segments: readonly Segment[]): string {
  let out = ''
  for (const seg of segments) {
    out += seg.kind === 'soft' ? seg.text : `\n${seg.lines.map((line) => line.text).join('\n')}\n`
  }
  return out
}

// ── 播放单元切分（听书）──────────────────────────────────────────────────────

/** 播放单元上限（code point 计）：按 UTF-16 码元切会把 emoji 代理对切坏。 */
export const PLAY_UNIT_MAX = 300

/** 句界：超长段在这些字符后二次切开，分隔符留在前片末尾；只收全角句读，半角 `.` 在数字/缩写里太常见。 */
const SENTENCE_END: ReadonlySet<string> = new Set(['。', '！', '？', '；', '…'])

/** 纯空白/标点/符号段不送引擎（legado notReadAloudRegex 口径）。用字符类而非 `\s|\p{C}|…` 交替：
 *  成员重叠会把近匹配串逼成指数回溯——内容可触发的卡死。 */
const NOT_READ_ALOUD = /^[\s\p{C}\p{P}\p{Z}\p{S}]+$/u

/** 正文 → 播放单元：按 `\n` 切段、trim、滤空与纯标点段，超限再切；顺序即播放顺序，切分只动边界不动字。 */
export function splitParagraphs(text: string): string[] {
  const units: string[] = []
  for (const line of text.split('\n')) {
    const para = line.trim()
    if (para === '' || NOT_READ_ALOUD.test(para)) continue
    units.push(...splitLongParagraph(para))
  }
  return units
}

/** 超长段 → ≤ PLAY_UNIT_MAX 的单元：优先句界拼满整句，无句界或一句超限才按 code point 硬切。 */
function splitLongParagraph(para: string): string[] {
  const cps = Array.from(para)
  if (cps.length <= PLAY_UNIT_MAX) return [para]
  const units: string[] = []
  let pending: string[] = []
  for (const piece of sentencePieces(cps)) {
    if (pending.length + piece.length <= PLAY_UNIT_MAX) {
      pending.push(...piece)
      continue
    }
    if (pending.length > 0) {
      units.push(pending.join(''))
      pending = []
    }
    for (let i = 0; i < piece.length; i += PLAY_UNIT_MAX) {
      const chunk = piece.slice(i, i + PLAY_UNIT_MAX)
      if (i + PLAY_UNIT_MAX < piece.length) units.push(chunk.join(''))
      else pending = chunk
    }
  }
  if (pending.length > 0) units.push(pending.join(''))
  return units
}

/** 按句界把 code point 序列切成一串候选片：句界字符留在片尾，末尾没有句界的残片自成一单元 */
function sentencePieces(cps: readonly string[]): string[][] {
  const pieces: string[][] = []
  let start = 0
  for (const [i, ch] of cps.entries()) {
    if (!SENTENCE_END.has(ch)) continue
    pieces.push(cps.slice(start, i + 1))
    start = i + 1
  }
  if (start < cps.length) pieces.push(cps.slice(start))
  return pieces
}

/**
 * 行清单 → 起段号：第 i 项 = 第 i 行之前已占的播放单元数。尺就是 `splitParagraphs`，屏上段号
 * （data-pidx、跟读高亮、从本段听、探针起播）与播放层单元序号共用它；空行与纯标点行占 0 格。
 * 消费点：`ChapterBody` 文字章段号（另加剥章名前缀）与 `ReaderView` 取剥掉行数的前缀。
 */
export function playUnitStarts(lines: readonly { text: string }[]): number[] {
  const starts: number[] = []
  let next = 0
  for (const line of lines) {
    starts.push(next)
    next += splitParagraphs(line.text).length
  }
  return starts
}

/**
 * 行清单 → 块起段号：每个 `nodeId` 首次出现那一行的起段号；无块身份的行不收。段号按行数而非文档序，
 * 同一块占多行时只认起行；起段号仍由 `playUnitStarts` 一份产出，这里只按块身份挑行。
 */
export function playUnitStartsByNode(lines: readonly ChapterContentLine[]): Map<string, number> {
  const byNode = new Map<string, number>()
  // 行清单与起段号同趟等长，按下标对位取：挑行的活只在这里，累计的活只在 playUnitStarts
  playUnitStarts(lines).forEach((start, index) => {
    const nodeId = lines[index]?.nodeId ?? null
    if (nodeId !== null && !byNode.has(nodeId)) byNode.set(nodeId, start)
  })
  return byNode
}
