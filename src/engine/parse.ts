import type { Branch, Facet, IndexSpec, ParsedRule, RuleUsage, Segment } from './types.js'
import { UnsupportedRuleError } from './errors.js'
import { braceRegion, jsRegionEnd, parseTails, putRegionEnd } from './grammar.js'
import { isLiteralForm } from './literal.js'

/**
 * parseRule 词法流水线（纯词法：字符串 → ParsedRule AST，零 IO）。
 *
 * 切分次序（钉死）：
 *   ② 剥 ## 替换尾（含 OnlyOne ###）
 *   ③ 剥链首 - 反序前缀
 *   ① AllInOne：剥完上面两步后仍以 : 开头 → 整链是一个 allinone 段
 *   ④ 分支切分（|| / && / %%，左到右，混用抛错）
 *   ⑤⑥ 段切分与识别（globalIndex 全规则连续编号，写进错误定位）
 *   ⑦ 链尾 (jsCode) 形态与 js 末位限制
 */

// default 段白名单（选择段 + 取值段；白名单之外一律 UnsupportedRuleError——
// 含裸词（无点号简单词），解析期必炸，不留给 eval 兜底）
const KNOWN_MODES = new Set([
  'text', 'textAll', 'ownText', 'html', 'all', 'href', 'src', 'content', 'textNodes',
  'class', 'id', 'tag', 'child', 'children',
])

const COMBINATOR_TOKENS = ['||', '&&', '%%'] as const
type CombToken = (typeof COMBINATOR_TOKENS)[number]
const COMBINATOR_MAP: Record<CombToken, ParsedRule['combinator']> = {
  '||': 'first', '&&': 'and', '%%': 'zip',
}

/** 解析期共享状态：facet 用于错误面，counter 是全规则连续段号，usage 决定链尾未知词语义 */
interface ParseCtx { facet: Facet; counter: number; usage: RuleUsage }

export function parseRule(rule: string, facet: Facet = 'rule', usage: RuleUsage = 'list'): ParsedRule {
  // ② 剥 ## 替换尾（含 OnlyOne ###）——文法口 parseTails 单点（grammar.ts：构词与解析同属一处）
  const { chain, replaces, onlyOne } = parseTails(rule)

  // ③ - 反序前缀（只看链首，段内负索引不受影响）
  let reverse = false
  let rest = chain
  if (rest.startsWith('-')) {
    reverse = true
    rest = rest.slice(1).trimStart()
  }
  // ③b 列表用途的 `+` 前缀：对面在**列表入口**（model/webBook/BookList.kt 与
  //  model/webBook/BookChapterList.kt 的 bookList/chapterList）先剥 `-` 置反序、再剥 `+`（剥完不做事），
  //  剥完照常 getElements——所以 `+tag.li` 在对面出的是整个列表。本仓不剥时它会落成 CSS/属性段
  //  ⇒ 恒 Miss ⇒ 列表与目录一条都不出。只在 list 用途剥：取值路径对面没有这条剥除，不扩大豁免。
  if (usage === 'list' && rest.startsWith('+')) {
    rest = rest.slice(1).trimStart()
  }

  // ① AllInOne：剥完替换尾与反序前缀后仍以 : 开头 → 整链一个 allinone 段
  if (rest.startsWith(':')) {
    const segment: Segment = { kind: 'allinone', pattern: rest.slice(1), flags: '' }
    return {
      branches: [{ segments: [segment], raws: [rest] }],
      combinator: 'first', reverse, replaces, onlyOne, usage,
    }
  }

  // 独立净化形态（## 开头）或剥空：branches 为空，求值时对 all 结果替换
  if (rest === '') {
    return { branches: [], combinator: 'first', reverse, replaces, onlyOne, usage }
  }

  // ④ 分支切分 + 混用检测（组合符切分跳过 JS 段与 `{{…}}` 模板区——其中的 ||/&&/%% 是代码/表达式，不是连接符）
  const parts = splitTop(rest)
  const seen = new Set(parts.slice(1).map(p => p.comb))
  if (seen.size > 1) {
    throw new UnsupportedRuleError('一条规则混用了多个连接符（|| / && / %%）', { facet, segmentIndex: 0, segmentRaw: rule })
  }
  const combinator: ParsedRule['combinator'] =
    seen.size === 1 ? COMBINATOR_MAP[[...seen][0] as CombToken] : 'first'

  // ⑤⑥ 段切分与识别。**空白分支照对面吞掉**：`RuleAnalyzer.splitRule` 不过滤空串，`A&&&&B` 产出
  // `["A","","B"]`，而空规则取值是 `getElements("")` → 空列表，合并时自然不贡献——等价于丢分支，
  // 不是整条失败。全空（`&&`、纯空白）与上面 `rest === ''` 同路：零分支，求值即空。
  const ctx: ParseCtx = { facet, counter: 0, usage }
  const branches = parts
    .map(p => parseBranch(p.text, ctx))
    .filter((b): b is Branch => b !== null)
  return { branches, combinator, reverse, replaces, onlyOne, usage }
}

// ── ④ 分支切分 ─────────────────────────────────────────────────────────

interface TopPart { text: string; comb: CombToken | null }

/** 按 || / && / %% 从左到右切分（算符不嵌套；JS 段整体跳过——块内的算符是 JS 代码不是连接符；
 *  `{{…}}` 模板区同样整体跳过——区内的 `&&`/`||` 属于插值表达式，legado 的 makeUpRule 在
 *  splitRule 之前先完成插值，故这些算符从不到达切分器。JS 区域探测与括号区扫描分别住在
 *  grammar.ts（jsRegionEnd / braceRegion），此处只消费）。 */
function splitTop(s: string): TopPart[] {
  const parts: TopPart[] = []
  let start = 0
  let pending: CombToken | null = null
  let i = 0
  while (i < s.length) {
    const jsEnd = jsRegionEnd(s, i)
    if (jsEnd !== null) { i = jsEnd; continue }
    const brace = braceRegion(s, i)
    if (brace !== null) { i = brace.end; continue }
    const tok = COMBINATOR_TOKENS.find(t => s.startsWith(t, i))
    if (tok) {
      parts.push({ text: s.slice(start, i), comb: pending })
      pending = tok
      i += tok.length
      start = i
    } else {
      i++
    }
  }
  parts.push({ text: s.slice(start), comb: pending })
  return parts
}

// ── ⑤⑥ 段切分与识别 ───────────────────────────────────────────────────

/** 按 @ 切分分支段：单个 @ 是段边界；连续 @@ 是字面 @（@@ 显式声明形态——
 *  段内剥一个 @ 后按常规识别）。首个元素若是空串则跳过（链首 @ 的边界残留）。
 *  XPath 主导规则（//、.//、/、@XPath: 开头——274 条真实规则形态）：谓词里的 `[@id]` 与
 *  斜杠属性步 `/@href` 不是段边界（前者在括号深度内、后者按对面口径留在 path 里），
 *  但**裸 @ 终端**（`//div[1]@html`、`//a@js:`）是下一级规则——切，切完回归普通模式。 */
const XPATH_HEAD = /^(@xpath:|\/\/|\.\/\/|\/)/i

function splitElements(s: string): string[] {
  const out: string[] = []
  let cur = ''
  // 括号/引号深度：XPath 主导链里 `[@id="x"]` 的 @ 是选择器的一部分，不是段界——
  // 对面 RuleAnalyzer.splitRule 用 chompBalanced 拉出 `[...]`/`(...)` 平衡组后才在 @ 处切。
  let depth = 0
  let quote = ''
  let xpathPending = XPATH_HEAD.test(s)
  let i = 0
  while (i < s.length) {
    // JS 区域整体跳过：<js>…</js> 块内与 @js: 链尾段内的 @ 是 JS 代码，不是段界。
    // `<js>` 可出现在任意位置（真实源有 `text<js>…</js>` 无 @ 直接衔接的形态）：
    // 块起始即隐式段界——cur 先独立成段，块本身起新段；块结束若紧跟内容（非 @）同样断段。
    const jsEnd = jsRegionEnd(s, i)
    if (jsEnd !== null) {
      if (cur !== '') { out.push(cur); cur = '' }
      cur = s.slice(i, jsEnd)
      i = jsEnd
      if (i < s.length && s[i] !== '@') {
        out.push(cur)
        cur = ''
      }
      continue
    }
    // `@put:{…}` 整体是一段：体内 `@` 是值里的选择器/终端，不是段界（grammar.putRegionEnd）
    const putEnd = putRegionEnd(s, i)
    if (putEnd !== null) {
      if (cur !== '') { out.push(cur); cur = '' }
      cur = s.slice(i, putEnd)
      i = putEnd
      if (i < s.length && s[i] !== '@') {
        out.push(cur)
        cur = ''
      }
      continue
    }
    // `{{…}}` 模板区整体留在当前段：区内的 `@`（`{{@@h1@text}}` 这类真源形态）不是段界——
    // legado 的 makeUpRule 在任何 `@` 切分之前先插值。扫描与 literal 共用 grammar.braceRegion。
    const brace = braceRegion(s, i)
    if (brace !== null) {
      cur += s.slice(i, brace.end)
      i = brace.end
      continue
    }
    if (s[i] === '@') {
      if (s[i + 1] === '@') { cur += '@'; i += 2; continue }
      // 吃掉两个 @：只进一位会让第二个 @ 变成段界，于是 `@@css:.x`（legado「@@<rule> 强制按
      // Default 处理」形态）被切成 ['@', 'css:.x'] 两段，第一段认不出就抛错——链首形态必炸。
      if (xpathPending && !(i > 0 && depth === 0 && quote === '' && s[i - 1] !== '/')) {
        cur += s[i] // 谓词 @class / 属性步 /@href：字面保留
        i++
        continue
      }
      out.push(cur)
      cur = ''
      xpathPending = false
      i++
    } else {
      if (quote !== '') { if (s[i] === quote) quote = '' }
      else if (s[i] === '"' || s[i] === "'") quote = s[i]
      else if (s[i] === '[' || s[i] === '(') depth++
      else if (s[i] === ']' || s[i] === ')') depth--
      cur += s[i]
      i++
    }
  }
  out.push(cur)
  // 空白段丢掉：`</js>` 后残留的 `\n`、`@` 边界留下的空串都不该成为段——对面 RuleAnalyzer.trim
  // 跳过 `<'!'` 字符、列表切分 filterNot isBlank，同一份认知。
  return out.filter((el) => el.trim() !== '')
}

/** 空白分支（对面 splitRule 不滤空串、但空规则取值即空列表）→ 返回 null，由调用方丢掉 */
function parseBranch(text: string, ctx: ParseCtx): Branch | null {
  const els = splitElements(text)
  if (els.length === 0) return null
  const segments: Segment[] = []
  const raws: string[] = []
  for (let i = 0; i < els.length; i++) {
    const el = els[i]
    const isLast = i === els.length - 1

    // 链尾没有「(jsCode) 表达式形态」这一切法——对面从不切它：`SourceRule.init` 里 `/` 开头
    // 整条就是 Mode.XPath（`/text()` 原样进 XPath 求值），`RuleAnalyzer.splitRule` 遇到
    // `(` 是 **跳过平衡组**（`findToAny('[', '(')` + `chompBalanced`）而不是切分点；
    // Default 链末段落进 `getResultLast` 的 `else -> attr(lastRule)`，取不到属性就是空。
    // 本仓曾有 detectTailJs，实测把耽美小说 `ruleToc.chapterName: "/text()"` 切成
    // `/text` + `()` 两段（`() ` 当脚本编译 → Unexpected token），而全库 158 源需要它的为 0。
    const seg = classifySegment(el, ctx, isLast)
    segments.push(seg)
    raws.push(el)
    ctx.counter++
  }
  return { segments, raws }
}

/** `!` 排除语法切分（官方文档：!是排除，序号用 : 隔开，0 是第1个，-1 最后一个）。
 *  只对选择段（css/default）合法；js 段代码里的 `!0`（布尔取反）在前缀识别时已先行返回，不受影响。 */
const EXCLUDE_RE = /^(.+?)!(-?\d+(?::-?\d+)*)$/

function splitExclude(el: string): { base: string; exclude: number[] | undefined } {
  const m = EXCLUDE_RE.exec(el)
  if (m === null) return { base: el, exclude: undefined }
  return { base: m[1], exclude: m[2].split(':').map(Number) }
}

function classifySegment(el: string, ctx: ParseCtx, isLast: boolean): Segment {
  // 段内前后空白修剪（真实源 `<js>…</js>\n$.[*]` 的段间换行——不 trim 的话 `.` 开头判定全失效）；
  // raws 仍记原文（错误定位不丢原文形态）
  let raw = el.trim()
  if (raw.startsWith('@')) raw = raw.slice(1) // @@ 显式声明形态：剥一个 @

  // 特殊前缀大小写不敏感（真实源有 @CSS:/@JS: 大写形态）
  const low = raw.toLowerCase()
  if (low.startsWith('css:')) {
    const { base, exclude } = splitExclude(raw.slice(4))
    return exclude === undefined ? { kind: 'css', selector: base } : { kind: 'css', selector: base, exclude }
  }
  if (low.startsWith('json:')) return { kind: 'jsonpath', path: normalizeJsonPath(raw.slice(5)) }
  if (raw.startsWith('$')) return { kind: 'jsonpath', path: raw }
  // XPath：@XPath:/@xpath: 前缀 或 //、.//、/ 开头（274 条真实规则形态）
  if (low.startsWith('xpath:')) return { kind: 'xpath', path: raw.slice(6) }
  // `/` 开头**但含插值区（`{{…}}` 或 `{$.…}`）→ 是 URL 模板不是 XPath**：插值优先于前缀判定，
  // 落到下方 isLiteralForm 成为字面段。真机实证两例：顶点小说 tocUrl `/…/{{$.novelId}}/chapters`、
  // 悦读小说 ruleBookUrl `/books?bookId={$.bookId}`（对面 `{$.rule}` 是内嵌 JSONPath——
  // AnalyzeByJSonPath.innerRule），两者此前都被本分支抢先截走 →「XPath 步骤不支持」。
  // 显式 @xpath: 前缀仍优先（上一行已先行返回）。
  const interpolated = raw.includes('{{') || raw.includes('{$')
  if ((raw.startsWith('//') || raw.startsWith('.//') || raw.startsWith('/')) && !interpolated) {
    return { kind: 'xpath', path: raw }
  }
  if (low.startsWith('js:')) return { kind: 'js', code: raw.slice(3), form: 'at-js' }
  if (low.startsWith('put:')) return { kind: 'put', pairsRaw: raw.slice(4) }
  if (low.startsWith('get:')) {
    // 花括号形态（legado evalPattern `@get:\{[^}]+?\}`）：真实源详情面整条规则就是 `@get:{n}`
    const name = raw.slice(4).trim().replace(/^\{(.*)\}$/, '$1').trim()
    return { kind: 'getvar', name }
  }
  if (low.startsWith('<js>')) {
    if (!raw.toLowerCase().endsWith('</js>')) {
      throw new UnsupportedRuleError('内联 js 段缺少 </js> 结束标记', { facet: ctx.facet, segmentIndex: ctx.counter, segmentRaw: el })
    }
    return { kind: 'js', code: raw.slice(4, -5), form: 'inline' }
  }
  // 模板字面段（URL 模板 / {{…}} 插值 / {$.path} 内嵌）——识别判据单点在 engine/literal.ts
  if (isLiteralForm(raw)) return { kind: 'literal', raw }
  // 其余段：先切 ! 排除，再走 default 识别（含隐式 CSS 回落、属性终端）
  const { base, exclude } = splitExclude(raw)
  return classifyDefault(base, exclude, el, ctx, isLast)
}

/** `Json:` 前缀路径归一：真实源有 `Json:data.list`（无 $ 前缀）形态——legado 的 JSONPath
 *  从根起算，无 $ 视为根相对路径补 `$.`（data.list → $.data.list）；@ 开头保持原样如实报错。 */
function normalizeJsonPath(path: string): string {
  const p = path.trim()
  if (p.startsWith('$') || p.startsWith('@')) return p
  return p.startsWith('[') ? `$${p}` : `$.${p}`
}

/** 常见 HTML 标签名（「元素.类」形态判定依据——首词是标签即 CSS 组合选择器） */
const HTML_TAGS = new Set([
  'a', 'abbr', 'address', 'article', 'aside', 'audio', 'b', 'base', 'bdi', 'bdo', 'blockquote', 'body',
  'br', 'button', 'canvas', 'caption', 'cite', 'code', 'col', 'colgroup', 'data', 'datalist', 'dd',
  'del', 'details', 'dfn', 'dialog', 'div', 'dl', 'dt', 'em', 'embed', 'fieldset', 'figcaption',
  'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header', 'hgroup', 'hr',
  'html', 'i', 'iframe', 'img', 'input', 'ins', 'kbd', 'label', 'legend', 'li', 'link', 'main',
  'map', 'mark', 'menu', 'meta', 'meter', 'nav', 'noscript', 'object', 'ol', 'optgroup', 'option',
  'output', 'p', 'param', 'picture', 'pre', 'progress', 'q', 'rp', 'rt', 'ruby', 's', 'samp',
  'script', 'section', 'select', 'slot', 'small', 'source', 'span', 'strong', 'style', 'sub',
  'summary', 'sup', 'table', 'tbody', 'td', 'template', 'textarea', 'tfoot', 'th', 'thead', 'time',
  'title', 'tr', 'track', 'u', 'ul', 'var', 'video', 'wbr',
])

/** 隐式 CSS 判定（官方简写考证：class.x≡.x、id.x≡#x；社区知识库：裸词=tag 选择器，
 *  `class.xxx@li@a@text` ≡ `.xxx li a@text`）：`#id` / `.class` 简写、裸 tag 词（li/a/div）、
 *  tag+属性（div[itemscope]）、**tag.类 组合**（li.chapter——189 条真实规则，首词是合法标签名）、
 *  **tag+伪类/组合**（a:contains(在线阅读)、li:first-child a——Jsoup/legado 常用，css-select 原生求值）、
 *  **纯属性选择器**（[class="col-12 col-md-6"]）、**后代/子代组合链**（tbody>tr、dd>h3>a、div span）。
 *  首词非标签的词.词形态（weirdsyntax.x）与 default 方言歧义——仍抛错（宁炸不猜边界）。 */
/**
 * CSS 标识词（jsoup / cheerio 都接受非 ASCII 与自造 tag 名）与「词.词」链判定：
 * 每一段都是合法 CSS 标识符 ⇒ 整段可交给选择器求值。数字开头的段**不算**（那是对面的索引形态）。
 */
const CSS_IDENT = /^[\p{L}_][\p{L}\p{N}_-]*$/u
function isCssWordChain(name: string, sep: string): boolean {
  const parts = name.split(sep)
  return parts.length > 0 && parts.every(p => CSS_IDENT.test(p))
}

function isImplicitCss(name: string): boolean {
  if (name.startsWith('#') || name.startsWith('.')) return true
  if (/^[a-zA-Z][\w-]*(?:\[[^\]]*\])*$/.test(name)) return true
  // 纯属性选择器：[class="col-12 col-md-6"]（无前导标签）
  if (name.startsWith('[') && name.endsWith(']')) return true
  // 选择器特征字符（真实源 `ul#ncp3_ul li`、`*[href*=book/chapter]`、`a[href*="_"]`、
  // `li[style~=width:100%;]`）：含 #/[/>+=~ 等即按 CSS 交给 css-select 求值——
  // 解析不了在求值层如实 RuleEvalError，不再在解析期误报「无法识别的段类型」
  if (name.startsWith('*')) return true
  if (/[#[\]>+~=,]/.test(name)) return true
  // tag.类 组合（li.chapter / a.list-group-item）：**对面兜底口径**——`ElementsSingle.getElementsSingle`
  // 的 else 分支是 `temp.select(beforeRule)`，白名单外的段在对面的无名不是"认不出"，而是整段交给
  // jsoup 当 CSS 选择器。故首词不必是合法 HTML 标签：`clasd.T-R-T-B2-Box1`（真源错字，2 源）、
  // 中文 tag（`text下一页`，1 源）都按 CSS 走，命中与否由文档决定，零命中就是 Miss（对面同款）。
  if (isCssWordChain(name, '.')) return true
  const dotIdx = name.indexOf('.')
  if (dotIdx > 0) {
    const head = name.slice(0, dotIdx).toLowerCase()
    if (HTML_TAGS.has(head)) return true
  }
  // tag+伪类/空白组合（a:contains(x) / li:first-child a）：同一基准——首词是合法标签名 → CSS；
  // 非标签首词（nonsense:x）依旧拒绝。伪类求值失败由 css-select 在求值层如实报错。
  if (/^[a-zA-Z][\w-]*[:\s>]/.test(name)) {
    const head = /^[a-zA-Z][\w-]*/.exec(name)?.[0].toLowerCase() ?? ''
    if (HTML_TAGS.has(head)) return true
  }
  return false
}

/** 段尾位置后缀剥离（选择器段共用）：从最后一个 . 起找第一个可解析为 IndexSpec 的后缀 */
function splitIndexSuffix(raw: string): { base: string; index: IndexSpec | null } {
  for (let i = raw.length - 1; i > 0; i--) {
    if (raw[i] !== '.') continue
    const parsed = parseIndexSuffix(raw.slice(i + 1))
    if (parsed) return { base: raw.slice(0, i), index: parsed }
  }
  return { base: raw, index: null }
}

/** 属性名形态（legado getResultLast else 分支：链尾未知提取指令 = HTML 属性名，如 onclick/value/_src）。
 *  含 `.` 的「词.词」不在此列——nonsense.x 仍按宁炸不猜抛错（doctrine 不变）。 */
function isAttrName(name: string): boolean {
  return /^[@a-zA-Z_][-\w:]*$/.test(name)
}

/** 方括号索引形态（legado ElementsSingle `[it,it,…]` / `[!it,…]`）：`li[-1:0]`、`tag.a[!0]`。
 *  内容只认整数 / `a:b[:c]` 区间 / 逗号 / `!`（含字母即不匹配——CSS 属性选择器不误伤）。
 *  v1 口径：单条目（闭区间 + step 自动，负数从尾数）与 `!` 整数排除收；**多条目按对面语义
 *  收成并集**（去重、越界丢弃、最终按文档序过滤，见 `parseBracketEntry` 的 multi 分支）。 */
const BRACKET_RE = /^(.+?)\[(!?)([-\d:\s,]+)\]$/

/** 单个方括号条目 → IndexSpec（认不出 → null，交回常规识别，与单条目同口径） */
function parseBracketEntry(e: string): IndexSpec | null {
  if (/^-?\d+$/.test(e)) return { kind: 'index', value: Number(e) }
  const sm = /^(-?\d*):(-?\d*)(?::(-?\d+))?$/.exec(e)
  if (sm === null || (sm[1] === '' && sm[2] === '')) return null
  const from = sm[1] === '' ? 0 : Number(sm[1])
  const to = sm[2] === '' ? Number.MAX_SAFE_INTEGER : Number(sm[2]) // 开放端 → applyIndex 钳到边界
  const step = sm[3] === undefined ? undefined : Number(sm[3])
  return step === undefined ? { kind: 'range', from, to } : { kind: 'range', from, to, step }
}

function splitBracketSuffix(
  raw: string,
): { base: string; index: IndexSpec | null; exclude?: number[] } | null {
  const m = BRACKET_RE.exec(raw)
  if (m === null) return null
  const base = m[1]
  const entries = m[3].split(',').map((s) => s.trim()).filter((s) => s !== '')
  if (entries.length === 0) return null
  if (m[2] === '!') {
    const nums: number[] = []
    for (const e of entries) {
      if (!/^-?\d+$/.test(e)) return null // 排除区间形态 v1 不支持 → 交回常规识别（求值层如实报错）
      nums.push(Number(e))
    }
    return { base, index: null, exclude: nums }
  }
  if (entries.length > 1) {
    // 多条目并集（legado ElementsSingle：条目收进去重 Set，越界的静默丢弃，最终按文档序过滤）
    const specs: IndexSpec[] = []
    for (const e of entries) {
      const spec = parseBracketEntry(e)
      if (spec === null) return null
      specs.push(spec)
    }
    return { base, index: { kind: 'multi', entries: specs } }
  }
  return { base, index: parseBracketEntry(entries[0]) }
}

function classifyDefault(raw: string, exclude: number[] | undefined, el: string, ctx: ParseCtx, isLast: boolean): Segment {
  // 方括号索引（legado `[a:b]`/`[!0]` 形态）优先于点号后缀：`li[-1:0]` → css `li` + range
  const bracket = splitBracketSuffix(raw)
  const target = bracket === null ? raw : bracket.base
  const bracketExclude = bracket?.exclude
  const effExclude = exclude ?? bracketExclude

  // 位置后缀：从最后一个 . 起，取第一个能解析为 IndexSpec 的后缀；
  // 都不成立则整串是名称（class.note.clearfix → arg 'note.clearfix'，不许在第一个 . 截断）
  const { base: rawName, index: dotIndex } = splitIndexSuffix(target)
  // 尾点号剥离（legado ElementsSingle 口径）：`tag.li.!0:1:-1` 的 !排除 切走后 base 是 `tag.li.`——
  // legado 对 beforeRule 是 split(".") 后**逐段取用**，尾部空串自然丢弃；我们把 `li.` 整段当
  // arg 喂给 css-select 就炸「Expected name, found .」（看书源 nextTocUrl 实证）。只剥**尾部**
  // 连续点号：中段点仍是名称/选择器的一部分（class.note.clearfix 语义不动）。
  const name = rawName.replace(/\.+$/, '')
  const index = bracket?.index ?? dotIndex

  const dot = name.indexOf('.')
  const mode = dot === -1 ? name : name.slice(0, dot)
  const arg = dot === -1 ? null : name.slice(dot + 1)

  if (KNOWN_MODES.has(mode)) {
    if (effExclude !== undefined && index !== null) {
      throw new UnsupportedRuleError('位置索引与 ! 排除语法不并存（legado 二选一）', { facet: ctx.facet, segmentIndex: ctx.counter, segmentRaw: el })
    }
    return effExclude === undefined ? { kind: 'default', mode, arg, index } : { kind: 'default', mode, arg, index, exclude: effExclude }
  }

  // 属性终端（CONTEXT.md「属性终端」）：**取值用途 + 链尾**的未知提取指令 = HTML 属性名——
  // legado AnalyzeByJSoup.getResultLast 的 else 分支 `element.attr(lastRule)`（空值丢弃、去重在求值层）。
  // 此前这类段（真实源 ruleBookUrl `@onclick`、`_src`、`value`）落进隐式 CSS 按标签选择器求值
  // → 恒零命中 → Miss → 「搜索能搜到但书目 URL 全空」。列表用途（getElements 口径）链尾未知词
  // 仍是选择器（css），与 legado ElementsSingle else 分支同口径。
  if (ctx.usage === 'value' && isLast && isAttrName(name)) {
    if (effExclude !== undefined && index !== null) {
      throw new UnsupportedRuleError('位置索引与 ! 排除语法不并存（legado 二选一）', { facet: ctx.facet, segmentIndex: ctx.counter, segmentRaw: el })
    }
    return effExclude === undefined ? { kind: 'default', mode: 'attr', arg: name, index } : { kind: 'default', mode: 'attr', arg: name, index, exclude: effExclude }
  }

  // 隐式 CSS 回落（官方简写 + 考证：#page/.txt-list/li/a/div[itemscope] 都是选择器）。
  // 位置后缀随 css 段带走（`a.0` = 选择 a 再取第 0 个——真实源高频形态，
  // 此前被并进选择器 `a.0` 当 class 选择 → 恒零命中 → 首条书名为空）。
  // 无索引时不带 index 字段（AST 精确形态，toEqual 口径）
  if (isImplicitCss(name)) {
    if (effExclude !== undefined && index !== null) {
      throw new UnsupportedRuleError('位置索引与 ! 排除语法不并存（legado 二选一）', { facet: ctx.facet, segmentIndex: ctx.counter, segmentRaw: el })
    }
    const seg: Segment = { kind: 'css', selector: name }
    if (effExclude !== undefined) seg.exclude = effExclude
    if (index !== null) seg.index = index
    return seg
  }

  // 纯索引段（`kind: "0"` 这类，3 源）**未实现**：对面 `beforeRule` 为空 ⇒ `temp.children()` 再取索引，
  // 但本仓的 `children` 在根上下文上已与对面分叉（见矩阵 `a-bare-index-segment` 与 engine.md 开口）——
  // 不把这个映射接在一个可疑的基座上，先修 `children` 再放行。此处继续走解析期抛错（宁炸不猜）。
  // 白名单之外、又不构成选择器形态（含空格/非法字符，如 'weird head.x'）→ 解析期抛（宁炸不猜）
  throw new UnsupportedRuleError('无法识别的段类型（default 段白名单之外）', { facet: ctx.facet, segmentIndex: ctx.counter, segmentRaw: el })
}

/** 位置后缀解析：`all` | 整数（含负） | 冒号分隔的**索引列表**（`0:2` = 第0与第2个）
 *  对面 `ElementsSingle.findIndexSet` 的 legacy 分支对 `.`/`:`/`!` 一律「取下一个数字进集合」，
 *  冒号不是区间运算符——本仓曾把它读成半开切片（`.0:2` 出 [0,1) = A、B，对面出 A、C），
 *  且 `-1:10:2` 这种对面合法的写法整个被当选择器炸掉。 */
function parseIndexSuffix(suffix: string): IndexSpec | null {
  if (suffix === 'all') return { kind: 'all' }
  if (/^-?\d+$/.test(suffix)) return { kind: 'index', value: Number(suffix) }
  const nums = suffix.split(':')
  if (nums.length > 1 && nums.every((n) => /^-?\d+$/.test(n))) {
    return { kind: 'multi', entries: nums.map((n) => ({ kind: 'index', value: Number(n) })) }
  }
  return null
}

/**
 * 这条规则是否**只设变量**（全链只有 `@put` 段，没有任何取值段）。
 * 为什么服务层要问引擎这句话：legado 的 `splitPutRule` 在任何切分之前把 `@put:{…}` 剥掉，
 * 剥完为空 ⇒ `getElement` 取不到新根（`AnalyzeByJSoup.getElements` 对空规则返空集），
 * 于是「纯 @put 的 ruleBookInfo.init」= 只设变量、不换根。本仓若把它当「零命中」报错，
 * 就是拿合法形状冒充规则失效——本机库 4 源（万象书城/夜伴书屋/圣墟小说/全本小说）的详情面
 * 整片是这个写法。判据归引擎（文法问题），服务层只消费结论。
 */
export function isPutOnlyRule(rule: string, facet: Facet = 'rule'): boolean {
  const parsed = parseRule(rule, facet)
  return parsed.branches.length > 0
    && parsed.branches.every((b) => b.segments.length > 0 && b.segments.every((s) => s.kind === 'put'))
}
