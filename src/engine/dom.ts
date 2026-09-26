import * as cheerio from 'cheerio'
import type { Cheerio } from 'cheerio'
import { isTag, isText } from 'domhandler'
import type { AnyNode, Element, Text } from 'domhandler'

/** cheerio.load 薄封装，供 select / css 段共用 */
export function loadHtml(html: string): cheerio.CheerioAPI {
  return cheerio.load(html)
}

/** 文本清洗：全角空格 　 → 半角空格、连续空白折叠为单空格、去首尾空白 */
export function cleanText(s: string): string {
  return s.replace(/\u3000/g, ' ').replace(/[ \t\r\n]+/g, ' ').trim()
}

/** 判定「上游结果是节点集」（Cheerio 集有 length 与 text()；普通 Value 对象没有） */
export function isNodeValue(v: unknown): v is Cheerio<AnyNode> {
  return typeof v === 'object' && v !== null && 'length' in (v as any) && typeof (v as any).text === 'function'
}

// ── 块级感知的纯文本（本插件的正文契约：按 \n 分段）─────────────────────
//
// 为什么不是 cheerio 的 .text()：它把整棵子树拼成一整行（`<p>a</p><p>b</p>` → `ab`），
// 阅读器/导出按 \n 分段就只剩一个巨型段落。本插件不丢字（信息量与「整块一行」一致），
// 只是把块级边界落成换行（可读性）。
// 另见 services/content.ts：@html 规则收回来的是 HTML 片段，同一套口径转纯文本。

/** 块级元素：边界即换行（浏览器渲染语义） */
const BLOCK_TAGS = new Set([
  'p', 'div', 'li', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'blockquote', 'section', 'article', 'aside', 'header', 'footer', 'nav', 'main',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'figure', 'figcaption',
  'dl', 'dt', 'dd', 'pre', 'hr', 'form', 'fieldset', 'address',
])

/** 行内元素：只留文本（单独列出用于「像不像 HTML」判定） */
const INLINE_TAGS = ['br', 'span', 'a', 'em', 'strong', 'b', 'i', 'u', 's', 'font', 'img', 'sub', 'sup', 'small', 'code', 'mark', 'wbr']

/** 非正文元素：整棵子树丢弃（脚本/样式/表单控件/文档头） */
const SKIP_TAGS = new Set([
  'script', 'style', 'noscript', 'template', 'iframe', 'svg', 'canvas', 'audio', 'video',
  'head', 'title', 'meta', 'link', 'base', 'input', 'button', 'select', 'textarea', 'option',
])

/**
 * 节点子树 → 纯文本：块级边界换行、行内标签只留文本、实体解码、逐行收敛空白（空行不留）。
 * 直接吃 domhandler 节点（cheerio 的活节点，不重新解析）。
 * `keepImages`（正文面专用：仅 img 保留，其余标签只留文本）：
 * `<img src>`（缺 src 取 data-src）输出为独立行的图片地址——漫画/图片章节不再整章零命中。
 */
export function nodeText(node: AnyNode, opts?: { keepImages?: boolean }): string {
  const keepImages = opts?.keepImages === true
  const lines: string[] = []
  let buf = ''
  /** 收当前行：nbsp/全角空格归一为空格、空白折叠、trim；空行不入列 */
  const flush = (): void => {
    const line = buf.replace(/[\u00a0\u3000]/g, ' ').replace(/\s+/g, ' ').trim()
    if (line !== '') lines.push(line)
    buf = ''
  }
  const visit = (n: AnyNode): void => {
    if (isText(n)) { buf += (n as Text).data; return }
    if (!isTag(n)) {
      // Document/片段容器（cheerio 的 root）：无标签语义，继续下钻子节点
      const kids = (n as { children?: AnyNode[] }).children
      if (kids !== undefined) for (const child of kids) visit(child)
      return
    }
    const el = n as Element
    const tag = el.name.toLowerCase()
    if (tag === 'img') {
      if (keepImages) {
        // img 取址三形态：src / data-src|src / 任意 data-*——
        // 懒加载漫画站大量只有 data-original/data-echo/data-page-image-url
        const a = el.attribs ?? {}
        const src = a.src ?? a['data-src'] ?? a['data-original'] ?? a['data-echo']
          ?? a['data-url'] ?? a['data-page-image-url'] ?? firstDataAttr(a)
        if (src.trim() !== '') { flush(); lines.push(src.trim()) }
      }
      return // 空元素：无子树
    }
    if (tag === 'noscript' && keepImages) {
      // 懒加载站点把真实 <img> 藏在 <noscript> 里（无 JS 客户端兜底）——SKIP_TAGS 会整棵丢弃，
      // 正文面 keepImages 口径下要取回它。但 domhandler 把 noscript 内容按 **raw text** 解析
      // （noscript.children 只有一个 text 节点、find('img') 为 0），直接下钻等于把字面
      // `<img src="…">` 当正文吐给读者——所以把那层文本再当 HTML 解析一次再走同一套行规约。
      const raw = el.children.map((c) => (isText(c) ? (c as Text).data : '')).join('')
      if (raw.trim() === '') return
      flush()
      const inner = loadHtml(raw).root().get(0)
      if (inner !== undefined) visit(inner)
      flush()
      return
    }
    if (SKIP_TAGS.has(tag)) return
    const block = BLOCK_TAGS.has(tag)
    if (block || tag === 'br') flush()                       // 换行点：先收上一行
    if (tag === 'br') return                                 // 空元素：无子树
    for (const child of el.children) visit(child)
    if (block) flush()                                       // 块级终点：收本块
  }
  visit(node)
  flush()
  return lines.join('\n')
}

/** 「这是一段 HTML 标记」判据：白名单标签名 + **真正的属性语法**（`<p>` / `</p>` / `<br/>` / `<p class="x">`）。
 *  属性段按 ASCII 属性名/值文法收，故 `<b 不是标签>` 这类正文里的尖括号内容不算标签——
 *  判错的方向选保守：漏判只是标签原样显示（源里本就少见），误判会吃掉正文文字。 */
const ATTR = String.raw`(?:\s+[a-zA-Z_:][-\w:.]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*`
const TAG_NAME = `(?:${[...BLOCK_TAGS, ...INLINE_TAGS].join('|')})`
const HTML_TAG_RE = new RegExp(`</?${TAG_NAME}${ATTR}\\s*/?>`, 'i')

/** 串里是否含真 HTML 标签（白名单口径） */
export function looksLikeHtml(s: string): boolean {
  return HTML_TAG_RE.test(s)
}

/** 任意 data-* 属性兜底（取第一个非空值） */
function firstDataAttr(attribs: Record<string, string>): string {
  for (const [k, v] of Object.entries(attribs)) {
    if (k.startsWith('data-') && v.trim() !== '') return v
  }
  return ''
}

/** HTML 片段 → 纯文本（块级边界换行；keepImages 见 nodeText） */
export function htmlToText(html: string, opts?: { keepImages?: boolean }): string {
  const $ = cheerio.load(html)
  const root = $.root().get(0)
  return root === undefined ? '' : nodeText(root, opts)
}
