import type { ChapterContent, ContentNode } from '../shared/wire.js'

/**
 * 规范图文 → 纯文本的**唯一投影**（scripts 与设计口径见 docs/design/services.md「本地书身份」）。
 *
 * 为什么必须唯一：文字面（getChapter 的返回、TXT 导出、六个 AI 工具）与图文面（阅读器）
 * 是同一批内容的两个出口——各写一份投影，同一本书的导出与 AI 读到的正文就会分叉。
 *
 * 两个分支的口径：
 * ① `text` **逐字通过**：服务层交给这里的文字已经收过口（contentToText + normalizeChapterText），
 *    再解释一次会把小说里合法的尖括号当标签吃掉，还会把 `&amp;` 这类字面量解成实体；
 * ② `rich` **只遍历本树**：不追链接目标（脚注/目录互指会绕着圈把整本书重复输出），
 *    不输出资源 ID、节点 ID 与任何存储路径（wire 与 AI 输出都不该出现本地存储标识）。
 *
 * 结构映射（本仓的正文契约：按 `\n` 分段）：
 * - 块级元素（见 BLOCK_TAGS）各自落一行，行内元素只留文字；
 * - 表格行以 `\n` 分隔、同一行的单元格以制表符分隔（列关系在纯文本里只能这样保）；
 * - `<br>`（break）在块内落成换行；分隔线（rule）**不发明字符**，但它与块级元素一样是边界：
 *   `a<hr/>b` 收行成 `a\nb`，不把两侧文本静默并成一段；
 * - 图片输出 `[图片：替代文字]`，无替代文字输出 `[图片]`；
 * - 预格式文本（pre）子树逐字保留（内部空白与换行原样）；
 * - **块级元素出现在行内上下文**（链接/行内元素的内容里——XHTML5 的 `<a>` 是透明内容模型，
 *   块级子节点是合法书写）时，它仍然按**块自己的投影**取值：pre 逐字、表格行制表符分列。
 *   这条不是可选优化：把子树当行内片段摊平会让这两种结构静默失真（实测 `甲\t乙` 变 `甲乙`、
 *   pre 的缩进换行被折成一行），而导出与 AI 读到的正文正是这条投影的输出。
 *
 * **行规约（源码空白折叠成单空格、逐行 trim、丢弃空行）由投影自己承担，不交给 normalizeChapterText**：
 * 文字面直接取本函数的输出（getChapter、TXT 导出、AI 工具），rich 文字根本不经过
 * normalizeChapterText；而它本身是逐行 trim，交过去会让 pre 的缩进一起丢。反过来，
 * 投影里不做规约同样不行——真实 EPUB 的漂亮排版 XHTML（`<p>\n  正文\n</p>`）会把缩进与
 * 首空行原样带进文字面。所以：非 pre 内容按上面的规约收口；pre 子树整棵绕过这条。
 *
 * 规约里**空白折叠**那条的边界是「源码排版」与「硬断行」：源码文字节点里的空白（换行、
 * 制表符、连续空格）是排版，不是断行——`<p>say<em>\n  hi\n</em> there</p>` 浏览器渲染成
 * `say hi there` 一行，文字面按源码换行断句就会裂成三行（与渲染不一致，导出与 AI 读到的
 * 就是错的）。所以非 pre 的源码空白先折成单空格，只有 `<br>`（break）、块级边界（含行内上下文里
 * 的块级子节点）这些**渲染上的硬断行**才断行；pre 子树两样都不做。折叠与行规约同口径
 * （含 NBSP 与全角空格）见 SOURCE_WS。
 */

/** 块级元素：边界即换行（浏览器渲染语义）。b/i 与结构容器在导入期已规范为 strong/em/div */
const BLOCK_TAGS: ReadonlySet<string> = new Set([
  'p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote',
  'pre', 'ul', 'ol', 'li', 'table', 'caption', 'thead', 'tbody', 'tfoot', 'tr',
])

/** 单元格：表格行内的列边界（见 rowText） */
const CELL_TAGS: ReadonlySet<string> = new Set(['td', 'th'])

/** 源码里的**可折叠**空白：HTML 渲染把连续空白折成一个空格，文字面照渲染走（头注「空白折叠」）。
 *  `\s` 本身就含 NBSP 与全角空格。对标的引擎口径是 `src/engine/dom.ts` 的 `nodeText`（`htmlToText`
 *  那一条出口）——同文件里还有第二条：`cleanText` 只折全角空格与 ASCII 空白，**不**折 NBSP，
 *  别拿它当参照（引擎内部本来就有两条，引哪条要点名）。 */
const SOURCE_WS = /\s+/g

export function chapterContentToText(content: ChapterContent): string {
  // text 分支恒等：不给它套 contentToText/htmlToText（头注 ①）
  return content.kind === 'text' ? content.text : flowText(content.nodes, false)
}

/** 行规约：行内空白折成单空格、逐行去首尾空白、丢弃空行（头注「行规约」）。只在非 pre 的行上调用。
 *  折叠在这里收第二次是必要的，不是重复劳动：源码空白按节点折（`SOURCE_WS`），相邻两个节点各带
 *  一段空白时折完会留下两个空格（`say<em> hi </em> there`），跨节点的连续空白只有拼行后才看得出。
 *  也因此它对已折过的输入是幂等的。 */
function collapseLines(block: string): string {
  return block
    .split('\n')
    .map((line) => line.replace(SOURCE_WS, ' ').trim())
    .filter((line) => line !== '')
    .join('\n')
}

/**
 * 行内上下文产出的一段：`soft` 是要并入当前行的可折叠文本；`block` 是**已定形的块文本**
 * （pre 的逐字内容、表格行、块级子树的投影），它必须自成一行/一列。
 *
 * 为什么要分两种而不是把一切都拼成字符串：`\t`（表格列分界）与 pre 的缩进都在 `SOURCE_WS` 里，
 * 折一次就没了。块文本在它自己的投影里已经定形，再进外层行的规约就是把列关系与逐字空白吃掉。
 */
type Segment = { kind: 'soft'; text: string } | { kind: 'block'; text: string }

/** 块级节点 → 块文本：表格行以制表符分列，其余按自己的子树走块序列
 *  （pre 子树内一律逐字，块级边界照样断行）。行内上下文与块序列共用这一处判据。 */
function blockSegment(node: Extract<ContentNode, { kind: 'element' }>, verbatim: boolean): Segment {
  return {
    kind: 'block',
    text: node.tag === 'tr' ? rowText(node, verbatim) : flowText(node.children, verbatim || node.tag === 'pre'),
  }
}

/** 行上下文（块序列）→ 文本：行内内容拼成一行，块级元素各自成行，行间以 `\n` 相连。
 *  `verbatim`（在 pre 子树内）为真时不做行规约，空白与换行逐字带出。 */
function flowText(nodes: readonly ContentNode[], verbatim: boolean): string {
  const parts: string[] = []
  let inline = ''
  /** 收当前行：非 pre 折空白、trim 并丢空行（块级边界与源码排版缩进都不留痕），pre 逐字保留 */
  const flush = (): void => {
    const line = verbatim ? inline : collapseLines(inline)
    if (line !== '') parts.push(line)
    inline = ''
  }
  /** 落一段：软文本并入当前行；块文本先收行、再原样入列（不再过行规约） */
  const put = (seg: Segment): void => {
    if (seg.kind === 'soft') { inline += seg.text; return }
    flush()
    if (seg.text.trim() !== '') parts.push(seg.text)
  }
  for (const node of nodes) {
    // 分隔线不产生字符，但收行：块级边界不能把两侧文本静默并成一段（头注「结构映射」）
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
  return parts.join('\n')
}

/**
 * 单个行内节点 → 片段序列：叶子（文本 / 图片 / 换行）落成软文本，链接与行内元素**继续下钻**
 * 自己的子树——下钻的是片段序列而不是字符串，所以子树里的块级节点仍按块取值（见 `Segment`）。
 *
 * 片段不是行，自身不做行规约（行首尾空白由外层行统一处理）——在片段上 trim 会吃掉渲染上真实
 * 存在的空格（`说<em> 话 </em>吧` → `说话吧`），与把两段文本静默并起来是同一类事。
 */
function inlineSegments(node: ContentNode, verbatim: boolean): Segment[] {
  // 分隔线在行内同样是**边界**（`a<hr/>b` 收行成 `a\nb`），空块文本只收行、不发明字符
  if (node.kind === 'rule') return [{ kind: 'block', text: '' }]
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

/** 表格行：单元格以制表符分界（同一行的列在纯文本里保持同行）。
 *  行内直接文本（非规范 XHTML，或源码排版缩进）不成列：纯空白丢弃，其余**整体并入末列**——
 *  它没有别的落点，静默丢弃等于丢正文；即使出现在首个单元格之前也归末列（不为它猜列序）。
 *
 *  制表符在**各单元格各自收口之后**才拼上，拼好的整行不再过行规约：`\t` 属于 `SOURCE_WS`，
 *  再折一次会把列分界吃成空格（列关系在纯文本里只有这一种表达）。调用方（flowText）因此
 *  对 tr 的返回值直接入列，不套 collapseLines。 */
function rowText(row: Extract<ContentNode, { kind: 'element' }>, verbatim: boolean): string {
  const cells: string[] = []
  let stray = ''
  for (const child of row.children) {
    if (child.kind === 'element' && CELL_TAGS.has(child.tag)) {
      cells.push(flowText(child.children, verbatim))
      continue
    }
    stray += segmentsToText(inlineSegments(child, verbatim))
  }
  const tail = verbatim ? stray : collapseLines(stray)
  if (tail !== '') cells.push(tail)
  return cells.join('\t')
}

/** 片段序列 → 一段文本（块段两侧各留一个换行，好在行规约里断开）。只给**没有别的落点**的杂散
 *  内容用（表格行里单元格之外、或非规范 XHTML 的文字）；正常路径由 `flowText` 逐段落位。 */
function segmentsToText(segments: readonly Segment[]): string {
  let out = ''
  for (const seg of segments) out += seg.kind === 'soft' ? seg.text : `\n${seg.text}\n`
  return out
}
