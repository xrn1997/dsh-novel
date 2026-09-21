import { htmlToText, looksLikeHtml } from '../engine/dom.js'

/**
 * 正文文本收口（服务层）。
 *
 * legado 源常以 `@html` 收正文（元素 HTML 原样返回），而本插件的正文契约是**纯文本**：
 * 阅读器按 `\n` 分段渲染 `<p>`、导出写 .txt、agent 工具直接回文本。不转换就会把标签
 * 当正文打出来——久久小说网 `#view_content_txt@html` 实测：2603 字里 21 个 `<p>` 原样落库。
 *
 * HTML→文本 的实现在引擎层（engine/dom.ts 的 htmlToText/nodeText）——引擎的 `@text` 段用
 * 同一套口径（块级边界换行），这里只保留「像不像 HTML」的判定与幂等收口。
 * 判定用白名单标签（见 engine/dom.ts）：纯文本正文原样直通，小说里的 `<系统提示>`
 * 这类尖括号内容不会被误判。转换幂等：产物不含标签，二次调用必然直通——缓存里旧版
 * 写入的带标签正文也能就地自愈。幂等靠的是「解码后仍像 HTML 就同趟转完」：预转义
 * HTML 串（`&lt;p&gt;…`）解出标签来却直接返回，会让第二次收口把段落当标签吞掉。
 *
 * 两个正文面口径（对齐 legado BookContent/HtmlFormatter）：
 * - **img 保留**（HtmlFormatter.formatKeepImg「仅 img 保留」）：`<img src>` 输出为独立行的
 *   图片地址——漫画/图片型章节（ruleContent 产出 `<img>` 串）不再整章零命中报错；
 * - **实体解码**（legado 正文在 HtmlFormatter 后整体 unescapeHtml4）：JSON API 源的正文串
 *   常带 `&nbsp;`/`&#8220;` 等预转义实体，非 HTML 形态时就地解码（白名单实体 + 数字实体，
 *   未知实体原样保留——不猜）。
 */
export { htmlToText, looksLikeHtml }

/** 正文取值收口：像 HTML 就转纯文本（img 保留为地址行），否则解码实体后原样返回（幂等） */
export function contentToText(raw: string): string {
  if (looksLikeHtml(raw)) return htmlToText(raw, { keepImages: true })
  const decoded = decodeBasicEntities(raw)
  // 预转义 HTML 串（JSON API 源正文形态）解码后才像 HTML——同一趟转成纯文本，否则产物含标签，
  // 缓存出边界再收一次口时会被当标签吞掉段落（幂等口径见头注）。
  return looksLikeHtml(decoded) ? htmlToText(decoded, { keepImages: true }) : decoded
}

/** 常见 HTML 实体白名单 + 数字实体（未知实体原样保留——不猜） */
const NAMED_ENTITIES: Record<string, string> = {
  nbsp: '\u00a0', ensp: '\u2002', emsp: '\u2003', thinsp: '\u2009',
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  ldquo: '\u201c', rdquo: '\u201d', lsquo: '\u2018', rsquo: '\u2019',
  mdash: '\u2014', ndash: '\u2013', hellip: '\u2026', middot: '\u00b7',
  copy: '\u00a9', reg: '\u00ae', times: '\u00d7', divide: '\u00f7',
  laquo: '\u00ab', raquo: '\u00bb', bull: '\u2022', dagger: '\u2020',
}

function decodeBasicEntities(s: string): string {
  if (!/&[#a-zA-Z]/.test(s)) return s
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]{1,8});/g, (m, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? safeFromCodePoint(code) : m
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? safeFromCodePoint(code) : m
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? m
  })
}

function safeFromCodePoint(code: number): string {
  try { return String.fromCodePoint(code) } catch { return '' }
}
