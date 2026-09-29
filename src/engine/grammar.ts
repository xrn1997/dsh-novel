import type { ReplaceStep } from './types.js'

/**
 * 规则文法：同一文法的构词与解析同属一处——此前构词散在三个
 * 跨半 module、没有任何东西验证「normalize 拼出来的正是 parse 认的」，文法一改全靠注释同步。
 *
 * 本 module 持有：`##` 尾的解析（parseTails）与构词（appendTail）、Native 隐式终端构词
 * （withImplicitText）、URL 模板 JS 形态判定（isJsForm）与 `{{…}}` 变量词法（splitVarExpr）。
 * parse.ts 消费解析口，normalize/search-template/template 消费构词与词法口。
 *
 * 构词期越界不进求值期：appendTail 用 parseTails 回读比对（round-trip 自校验），粘连/OnlyOne
 * 误伤当场返回 warning（进 normalize warnings），不产出求值期谜之结果。
 */

export interface ParsedTails {
  chain: string
  replaces: ReplaceStep[]
  onlyOne: boolean
}

/**
 * 解析口：剥 `##` 替换尾（OnlyOne `###` 先记标志再剥尾部一个 #）→ 链体 + 两两配对的替换步；
 * 奇数残项非空按「只有 pattern、替换为空串」收编，空串忽略。替换尾切分的唯一实现
 * （parseRule 第一步即经它），构词侧的 round-trip 自校验对照的就是它。
 */
export function parseTails(rule: string): ParsedTails {
  const trimmed = rule.trim()
  const onlyOne = trimmed.endsWith('###')
  const s = onlyOne ? trimmed.slice(0, -1) : trimmed
  const parts = s.split('##')
  const chain = parts[0]
  const restSegs = parts.slice(1)
  const replaces: ReplaceStep[] = []
  for (let i = 0; i < restSegs.length; i += 2) {
    if (i + 1 < restSegs.length) {
      replaces.push({ pattern: restSegs[i], flags: '', replacement: restSegs[i + 1] })
    } else if (restSegs[i] !== '') {
      replaces.push({ pattern: restSegs[i], flags: '', replacement: '' })
    }
  }
  return { chain, replaces, onlyOne }
}

export interface TailResult {
  rule: string
  /** 构词期越界（粘连/OnlyOne 误伤等）→ 原 rule 不动 + 文案；调用方进 normalize warnings */
  warning: string | null
}

/**
 * 构词口：追加一个 `##pattern##replacement` 替换尾（净化语义的唯一拼串点）。round-trip 自校验：
 * 拼串后用 parseTails 回读，与「原解析 + 新增一步」逐字段比对；不等即构词越界（pattern 含 `##`、
 * 与分隔符 `#` 粘连、OnlyOne 误伤等），当场拒绝并给 warning——宁可少一步净化，不产出求值期谜之结果。
 */
export function appendTail(rule: string, pattern: string, replacement: string): TailResult {
  const composed = `${rule}##${pattern}##${replacement}`
  const base = parseTails(rule)
  const back = parseTails(composed)
  const want = [...base.replaces, { pattern, flags: '', replacement }]
  const same = back.chain === base.chain
    && back.onlyOne === base.onlyOne
    && back.replaces.length === want.length
    && back.replaces.every((r, i) => r.pattern === want[i].pattern && r.replacement === want[i].replacement)
  if (!same) {
    return {
      rule,
      warning: `净化尾构词越界：pattern「${pattern}」/replacement「${replacement}」与「##」文法粘连，`
        + `回程解析（${back.replaces.map((r) => `${r.pattern}→${r.replacement}`).join('、')}）≠ 构词意图——该尾已跳过`,
    }
  }
  return { rule: composed, warning: null }
}

/**
 * JS 段区域探测（构词与解析**共用**：此前构词侧裸 `split('||')` 会把 JS 体内的 `||` 当连接符撕开，
 * 而解析侧整体跳过，两侧对同一文法认知不一致）。返回区域结束位置（不含）；不在 JS 段起点 → null。
 *  `<js>…</js>`：块整体是一个段——块内 ||/&&/%%/@ 是 JS 代码，不是连接符/段界（任意位置可起块）；
 *  `js:`（链首或段界 @ 后）：js 只能是末段 → 吃到链尾（真实源 @js 代码里大量 ||/&&/字符串 @）。
 */
export function jsRegionEnd(s: string, i: number): number | null {
  // 前缀比对只看定宽窗口（大小写不敏感），不做 `slice(i).toLowerCase()` 整串拷贝——
  // 本函数被 splitTop / splitElements / hasJsRegion 按位调用，整串拷贝是 O(n²) 之源。
  // 等价性：prefix 里的字母只有 j/s，ASCII 大小写折叠与整串 toLowerCase 在这些字符上同效。
  if (startsWithAt(s, '<js>', i)) {
    for (let j = i + 4; j + 5 <= s.length; j++) if (startsWithAt(s, '</js>', j)) return j + 5
    return null
  }
  // 段首判定：链首，或前一字符是段界 @（@@ 是字面 @，不起段）
  const atSegStart = i === 0 || (s[i - 1] === '@' && s[i - 2] !== '@')
  if (atSegStart && startsWithAt(s, 'js:', i)) return s.length
  return null
}

/** 定宽窗口的大小写不敏感前缀比对（jsRegionEnd 专用；prefix 恒为小写字面量） */
function startsWithAt(s: string, prefix: string, i: number): boolean {
  if (i + prefix.length > s.length) return false
  for (let k = 0; k < prefix.length; k++) {
    const a = s.charCodeAt(i + k)
    const b = prefix.charCodeAt(k)
    if (a === b || (a >= 65 && a <= 90 && a + 32 === b)) continue
    return false
  }
  return true
}

/**
 * `@put:{…}` 区域终点（`@put:{…}` 在任何切分之前先剥离，所以体内 `@` 不是段界——曾被
 * splitElements 撕段、解析期当场抛错）。吃到第一个 `}` 为止：不嵌套，值里带 `}` 的规则本就不合法，
 * 不另造更宽的判据。只在段首成立（链首或前一字符是段界 `@`；`@@` 是字面 @，不起段）。
 */
export function putRegionEnd(s: string, i: number): number | null {
  const atSegStart = i === 0 || (s[i - 1] === '@' && s[i - 2] !== '@')
  if (!atSegStart) return null
  const rest = s.slice(i)
  if (!/^put:/i.test(rest)) return null
  const open = rest.indexOf('{')
  if (open === -1) return null
  const close = rest.indexOf('}', open)
  return close === -1 ? null : i + close + 1
}

/** `{{…}}` 模板区（插值发生在任何 `@` 切分**之前**，故区内的 `@` 不是段界）。
 *  返回内容终点（第一个闭合 `}` 处，`{{$.x}}` 的表达式是 `$.x`）与整区终点（`}}` 之后）；
 *  未闭合 → null（调用方按字面处理，不猜）。引号内的花括号不计深。
 *  **唯一一份花括号扫描**：`literal.splitLiteral` 与 `parse.splitElements` 都从这里取。 */
export interface BraceRegion { contentEnd: number; end: number }

export function braceRegion(s: string, i: number): BraceRegion | null {
  if (!s.startsWith('{{', i)) return null
  let depth = 2
  let j = i + 2
  let quote: string | null = null
  let contentEnd = -1
  while (j < s.length) {
    const ch = s[j]
    if (quote !== null) {
      if (ch === '\\') { j += 2; continue }
      if (ch === quote) quote = null
    } else if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch
    } else if (ch === '{') {
      depth++
    } else if (ch === '}') {
      if (depth === 2) contentEnd = j
      depth--
    }
    if (depth === 0) return contentEnd === -1 ? null : { contentEnd, end: j + 1 }
    j++
  }
  return null
}

/** 该分支是否含 JS 区域（`<js>…</js>` 或 `js:`/`@js:` 末段）——构词侧据此不再补隐式 `@text`
 *  （JS 已是终端），解析侧据此豁免行模板判定（脚本里的 `'$1'` 是正则反向引用，不是行组）。
 *  两处共用这一份——此前 parse.ts 抄了一份逐字副本，同一支规则可能在一处豁免、另一处不豁免。 */
export function hasJsRegion(s: string): boolean {
  let i = 0
  while (i < s.length) {
    const end = jsRegionEnd(s, i)
    if (end !== null) return true
    i++
  }
  return false
}

/**
 * 构词口：链体每个 `||` 分支无 `@` 且不含 JS 区域 → 补 `@text` 终端（Native 取值字段语义——
 * 裸选择器即「取元素文本」，真实源常用写法）；`##` 净化尾不动（只处理链体）。
 * `||` 切分跳过 JS 区域（复用 jsRegionEnd）——`<js>return a||b</js>` 不得被撕成
 * `<js>return a@text||b</js>@text`（正文规则一旦命中即整本书读不出正文且不报错）。
 */
export function withImplicitText(rule: string): string {
  const chainEnd = rule.indexOf('##')
  const chain = chainEnd === -1 ? rule : rule.slice(0, chainEnd)
  const rest = chainEnd === -1 ? '' : rule.slice(chainEnd)
  const branches: string[] = []
  let start = 0
  let i = 0
  while (i < chain.length) {
    const jsEnd = jsRegionEnd(chain, i)
    if (jsEnd !== null) { i = jsEnd; continue }
    if (chain.startsWith('||', i)) {
      branches.push(chain.slice(start, i))
      i += 2
      start = i
      continue
    }
    i++
  }
  branches.push(chain.slice(start))
  return branches.map((b) => (b.includes('@') || hasJsRegion(b) ? b : `${b}@text`)).join('||') + rest
}

/** URL 模板 JS 形态判定：`@js:` / `js:` / `<js>` 开头（容前导空白）。
 *  形态面的消费方是搜索面块扫描（`search-template.ts` 的 `URL_JS_BLOCK_RE`，与本判定同判据）；
 *  本函数是这条词法事实的**登记处**（整串判定暂无生产调用方）。 */
export function isJsForm(template: string): boolean {
  return /^\s*(?:@?js:|<js>)/i.test(template)
}

/**
 * XPath 形态判定（**规则语言侧**单点，parse.classifySegment 的 XPath 分支用）：
 * `@xpath:`/`xpath:` 显式前缀，或 `//`/`.//`/`/` 开头**且不含插值区**
 * （`{{…}}`/`{$.…}` 是 URL 模板不是 XPath——插值优先于前缀判定，矩阵 `a-xpath-prefix-vs-url-template`）。
 * tocUrl 位的静态 URL 短路闸（`reading.tocUrlOf`）**另有一份两档口径**、结论刻意不同：
 * 规则语言里 `/static/list.html` 是 XPath 形态，tocUrl 位上它是站点相对静态 URL（URL 读法优先），
 * 而 `//` 家族在 tocUrl 位一律按绝对 XPath 不短路——歧义前缀的两处裁决与理由见矩阵
 * `b-toc-url-xpath-vs-url`（此处是规则文法，别拿去当短路闸）。
 */
export function isXPathForm(rule: string): boolean {
  const raw = rule.trim()
  if (/^@?xpath:/i.test(raw)) return true
  if (raw.includes('{{') || raw.includes('{$')) return false
  return raw.startsWith('//') || raw.startsWith('.//') || raw.startsWith('/')
}

export interface VarExpr {
  /** `||` 前的变量名（trim） */
  name: string
  /** `||` 后的缺省值（原文，无 `||` → null） */
  fallback: string | null
}

/** `{{inner}}` 词法拆分：变量名 + 缺省值。template.interpolateUrl 与 isPlaceholderExpr
 *  共用此拆分——此前两边各写一份拆分逻辑，文法一改靠注释同步。 */
export function splitVarExpr(inner: string): VarExpr {
  const orIdx = inner.indexOf('||')
  return orIdx === -1
    ? { name: inner.trim(), fallback: null }
    : { name: inner.slice(0, orIdx).trim(), fallback: inner.slice(orIdx + 2) }
}
