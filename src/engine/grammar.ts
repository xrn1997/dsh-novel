import type { ReplaceStep } from './types.js'

/**
 * 规则文法（CONTEXT.md「规则文法」）：同一文法的构词与解析同属一处——
 * 此前构词散在 services/normalize 三个方言分支（模板串硬拼 `##` 尾 / 隐式 `@text`），
 * 词法判定在 search-template 复读 template.ts 的 `||` 拆分，解析只在 engine/parse——
 * 没有任何东西验证「normalize 拼出来的正是 parse 认的」，文法一改至少三个跨半 module 靠注释同步。
 *
 * 本 module 持有：`##` 尾的解析（parseTails）与构词（appendTail）、Native 隐式终端
 * 构词（withImplicitText）、URL 模板 JS 形态判定（isJsForm）与 `{{…}}` 变量词法
 * （splitVarExpr / isPureVarExpr）。parse.ts 消费解析口，normalize/search-template/
 * template 消费构词与词法口。
 *
 * 构词期越界不进求值期：appendTail 用 parseTails 回读比对（round-trip 自校验）——
 * pattern/replacement 含 `##`、与拼接边界 `#` 粘连、追加到 OnlyOne 规则等情况当场
 * 返回 warning（调用方进 normalize warnings），而不是产出求值期谜之结果。
 *
 * 设计文档：docs/design/engine.md
 */

export interface ParsedTails {
  chain: string
  replaces: ReplaceStep[]
  onlyOne: boolean
}

/**
 * 解析口：剥 `##` 替换尾（OnlyOne `###` 先记标志再剥尾部一个 #）→ 链体 + 两两配对的
 * 替换步；奇数残项（尾部 `##` 的切分残留）非空按「只有 pattern、替换为空串」收编，
 * 空串忽略。engine/parse 的 splitReplaces 唯一实现——此前构词侧无从对照的就是它。
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
 * 构词口：追加一个 `##pattern##replacement` 替换尾（legado 净化语义的唯一拼串点——
 * normalize 三个方言分支此前各拼各的）。round-trip 自校验：拼串后用 parseTails 回读，
 * 与「原解析 + 新增一步」逐字段比对；不等即构词越界（如 pattern 含 `##` 拆出多余配对、
 * pattern 以 `#` 结尾与分隔符粘连致回程错位、规则原以 `###` 结尾时新尾被 OnlyOne 误伤），
 * 当场拒绝并给 warning——宁可少一步净化，不产出求值期谜之结果。
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
 * JS 段区域探测（构词与解析**共用**，parser 的 splitTop/splitElements 与本文件的
 * withImplicitText 同源——此前构词侧裸 `split('||')` 会把 JS 体内的 `||` 当连接符撕开，
 * 而解析侧却把 JS 区域整体跳过，两侧对同一文法认知不一致）：
 * 返回区域结束位置（不含）；不在 JS 段起点 → null。
 *  `<js>…</js>`：块整体是一个段——块内 ||/&&/%%/@ 是 JS 代码，不是连接符/段界（任意位置可起块）；
 *  `js:`（链首或段界 @ 后）：js 只能是末段 → 吃到链尾（真实源 @js 代码里大量 ||/&&/字符串 @）。
 */
export function jsRegionEnd(s: string, i: number): number | null {
  const restLow = s.slice(i).toLowerCase()
  if (restLow.startsWith('<js>')) {
    const close = s.toLowerCase().indexOf('</js>', i + 4)
    return close === -1 ? null : close + 5
  }
  // 段首判定：链首，或前一字符是段界 @（@@ 是字面 @，不起段）
  const atSegStart = i === 0 || (s[i - 1] === '@' && s[i - 2] !== '@')
  if (atSegStart && restLow.startsWith('js:')) return s.length
  return null
}

/**
 * `@put:{…}` 区域终点（legado `splitPutRule` 口径：`@put:(\{[^}]+?\})` 在**任何**切分之前先剥离，
 * 所以体内 `@` 不是段界）。真实源 `ruleBookInfo.init` 的主导形态
 * `@put:{n:"[property$=book_name]@content", …}` 六个体内 `@` 曾被 splitElements 撕成七段，
 * 当场解析期抛错（2026-09 真机审计）。吃到第一个 `}` 为止——legado 的正则同样不嵌套，
 * 值里带 `}` 的规则在 legado 那边也是残规则，不另造更宽的判据。
 * 只在段首成立（链首或前一字符是段界 `@`；`@@` 是字面 @，不起段）。
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

/** `{{…}}` 模板区（legado `makeUpRule` 在任何 `@` 切分**之前**插值，故区内的 `@` 不是段界）。
 *  返回内容终点（第一个闭合 `}` 处，`{{$.x}}` 的表达式是 `$.x`）与整区终点（`}}` 之后）；
 *  未闭合 → null（调用方按字面处理，不猜）。引号内的花括号不计深——对面 `chompCodeBalanced` 同口径。
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

/** 该分支是否含 JS 区域（`<js>…</js>` 或 `js:`/`@js:` 末段）——是则不再补隐式 `@text`（JS 已是终端） */function hasJsRegion(s: string): boolean {
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
 * 裸选择器即「取元素文本」，legado 规则文档（android-ebook）常用模式表）；`##` 净化尾不动（只处理链体）。
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

/** URL 模板 JS 形态判定：`@js:` / `js:` / `<js>` 开头（容前导空白）——searchUrl 真实源 61/642 */
export function isJsForm(template: string): boolean {
  return /^\s*(?:@?js:|<js>)/i.test(template)
}

export interface VarExpr {
  /** `||` 前的变量名（trim） */
  name: string
  /** `||` 后的缺省值（原文，无 `||` → null） */
  fallback: string | null
}

/** `{{inner}}` 词法拆分：变量名 + 缺省值。template.interpolateUrl 与搜索面 isPureVarExpr
 *  共用此拆分——此前两边各写一份 `indexOf('||')`，文法一改靠注释同步。 */
export function splitVarExpr(inner: string): VarExpr {
  const orIdx = inner.indexOf('||')
  return orIdx === -1
    ? { name: inner.trim(), fallback: null }
    : { name: inner.slice(0, orIdx).trim(), fallback: inner.slice(orIdx + 2) }
}

/** 纯变量形态：变量名是标识符（`{{key}}` / `{{key||fallback}}`）——其余按 JS 求值
 *  （legado replaceKeyPageJs 口径：`{{java.encodeURI(key)}}` 等在搜索面预求值）。 */
export function isPureVarExpr(inner: string): boolean {
  return /^[\w$]+$/.test(splitVarExpr(inner).name)
}
