import { htmlToText, looksLikeHtml } from '../engine/dom.js'

/**
 * 正文文本收口（服务层）。书源常以 `@html` 收正文，而本插件的正文契约是**纯文本**：阅读器按 `\n` 分段、导出写 .txt、工具回文本。
 * 不转换就会把标签当正文打出来（矩阵行 `g-html-to-text`）。HTML→文本的实现在引擎层（`htmlToText`）——这里只保留「像不像 HTML」
 * 的判定与幂等收口：判定用白名单标签，纯文本正文原样直通；转换幂等，缓存里已写入的带标签正文也能就地自愈（幂等靠「解码后仍像
 * HTML 就同趟转完」：预转义 HTML 串解出标签来却直接返回，会让第二次收口把段落当标签吞掉）。
 * 两个正文面口径：**img 保留**（仅 img，输出为独立行地址——图片型章节不再整章零命中）；**实体解码**（转纯文本后整串再解一次，
 * 未知实体原样保留）。
 */
export { htmlToText, looksLikeHtml }

/** 正文取值收口：像 HTML 就转纯文本（img 保留为地址行），否则解码实体后原样返回（幂等） */
export function contentToText(raw: string): string {
  if (looksLikeHtml(raw)) return htmlToText(raw, { keepImages: true })
  const decoded = decodeBasicEntities(raw)
  // 预转义 HTML 串解码后才像 HTML——同一趟转成纯文本，否则缓存出边界再收口时会被当标签吞掉段落。
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

// ── 简介（展示文本）─────────────────────────────────────────────────────

/** Java 正则里的 `\s` 是 **ASCII 空白**（不含 U+3000），JS 的 `\s` 含它——直接照抄会让段首缩进行为不同。这里一律用显式字符类。 */
const AW = '[ \t\n\r\f\v]'
/** 换行连同前后 ASCII 空白（`\s*\n+\s*` 的显式展开）；全局替换，故带 g */
const NL_RUN = new RegExp(AW + '*\\n+' + AW + '*', 'g')
/** 串首空白（**额外含全角空格**）：若先把换行换成「换行 + 缩进」、再给串首补缩进，首行就成四个全角空格；本仓按「先清空再统一补
 *  两个全角空格」的终态出（`formatIntro` 的有意偏差，只裁空白不动文字）。 */
const LEAD_WS = /^[\s\u3000]+/
/** 串尾空白——本仓额外含全角空格，见 formatIntro 的「有意偏差」 */
const TAIL_WS = /[\s\u3000]+$/

/** 渲染指令前缀（`usehtml`/`useweb`/`md`）：命中即**整段原样保留**，交给渲染层；本仓没有那三种渲染器，保留前缀的意义在于「不把书源的
 *  交互标记与样式源码当纯文本净化掉」（矩阵行 `e-intro-special-prefix`）。 */
const INTRO_DIRECTIVE = new RegExp('^<(?:usehtml|useweb|md)>', 'i')

/**
 * 简介净化——正则流水线（顺序固定）+ 截 5000 字：实体/NBSP 归空格、零宽字符删除、块级标签换行、注释与其余标签删除、换行前后
 * 空白折叠成「换行 + 两个全角空格」、串首同补缩进、串尾空白删除。两处**有意偏差**（只裁/补空白）：① 串尾再收一次空白（含全角空格）
 * ——Java `\s` 不认全角空格，照搬的产物会以「换行 + 缩进」收尾；② 串首缩进统一成两个全角空格（补缩进会叠成四个）。
 * 两个取值点的差别：**搜索结果**恒净化（**不认**渲染指令前缀）；**详情页**才先判前缀、命中就原样保留——`keepDirective` 由调用方按面传。
 */
export function formatIntro(raw: string, opts?: { keepDirective?: boolean }): string {
  const trimmed = raw.trimStart()
  if (opts?.keepDirective === true && INTRO_DIRECTIVE.test(trimmed)) return trimmed
  const out = trimmed
    .replace(/(&nbsp;)+/g, ' ')
    .replace(/(&ensp;|&emsp;)/g, ' ')
    .replace(/(&thinsp;|&zwnj;|&zwj;|\u2009|\u200c|\u200d)/g, '')
    .replace(/<\/?(?:div|p|br|hr|h\d|article|dd|dl)[^>]*>/g, '\n')
    .replace(/<!--[^>]*-->/g, '')
    .replace(/<\/?[a-zA-Z]+(?=[ >])[^<>]*>/g, '')
    .replace(NL_RUN, '\n　　')
    .replace(LEAD_WS, '　　')
    .replace(TAIL_WS, '')
    .slice(0, 5000)
  return out
}

