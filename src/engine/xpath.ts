import type { Cheerio, CheerioAPI } from 'cheerio'
import type { AnyNode, Element, Text } from 'domhandler'
import type { EngineValue, Facet, Segment, SegmentLoc } from './types.js'
import { RuleEvalError, UnsupportedRuleError } from './errors.js'
import { cleanText } from './dom.js'

type XPathSegment = Extract<Segment, { kind: 'xpath' }>

/**
 * XPath 子集求值器（630 源 274 条 XPath 规则的实测语法边界驱动）：
 * - 路径：`//` 与 `.//`（上下文内后代——条目作用域语义）/ `/`（子步）；
 * - 节点测试：元素名 / `*` / `text()` / `@attr`（仅限末段——中段属性步宁炸不猜）；
 * - 轴：child（默认）/ parent（`..`）/ following-sibling / preceding-sibling；其他轴（ancestor 等）不支持。
 *   `preceding-sibling` 为逆向轴，位置谓词按逆文档序编号（XPath 1.0 §2.4）：`[1]`=最近前序兄弟。
 * - 谓词：位置数字、`@attr='v'`、`text()='v'`、`contains(...)`、`starts-with(...)`、`not(...)`、
 *   `position()` 比较、子元素存在（`[dd[a]]`）、相对路径存在性（`[.//a]`、`[a/@href]`
 *   ——XPath 的节点集谓词，非空即真）、`and`/`or` 组合；
 * - 函数白名单外（count/sum 等）→ UnsupportedRuleError。
 * 实现：直接在 domhandler 节点树上求值（cheerio 底层 DOM）——HTML→XML 重解析会错位。
 * 近似说明：谓词里的 text() 用元素 textContent（拼接后代文本）——真实样本全落此口径。
 */
export function evalXPath(
  seg: XPathSegment,
  $: CheerioAPI,
  cur: Cheerio<AnyNode>,
  loc: SegmentLoc,
  facet: Facet,
): EngineValue {
  let steps: Step[]
  try {
    steps = parseXPath(seg.path)
  } catch (e) {
    if (e instanceof UnsupportedRuleError) throw e
    throw new RuleEvalError(`XPath 无法解析：${seg.path}（${(e as Error).message}）`, { ...loc, facet, hits: 0 })
  }

  let candidates: AnyNode[] = cur.toArray()
  for (let si = 0; si < steps.length; si++) {
    const step = steps[si]
    const isLast = si === steps.length - 1
    // 末段提取步：@attr 读候选元素自身属性；text() 取候选的文本子节点——不是过滤
    const lastTest = isLast ? step.test : null
    if (lastTest !== null && lastTest.kind === 'attr') {
      const attrName = lastTest.name
      const values = candidates
        .map((n) => (n as Element).attribs?.[attrName] ?? '')
        .filter((v) => v !== '')
      return valuesList(values)
    }
    if (lastTest !== null && lastTest.kind === 'text') {
      const values: string[] = []
      const collect = (n: AnyNode): void => {
        for (const ch of nodeChildren(n)) {
          if (ch.type === 'text') {
            const t = cleanText((ch as Text).data ?? '')
            if (t !== '') values.push(t)
          } else if (step.axis === 'descendant') collect(ch) // //text() = 后代全部文本；/text() = 仅直系
        }
      }
      for (const c of candidates) collect(c)
      return valuesList(values)
    }
    candidates = stepForward(candidates, step)
  }
  // 理论不可达（末段必为提取或元素）——防御：空 → Miss
  if (candidates.length === 0) return { kind: 'miss', detail: `XPath ${seg.path} 零命中` }
  return { kind: 'nodes', nodes: $(candidates as Element[]) }
}

function valuesList(values: string[]): EngineValue {
  if (values.length === 0) return { kind: 'miss', detail: 'XPath 取值为空' }
  if (values.length === 1) return { kind: 'value', text: values[0] }
  return { kind: 'list', items: values }
}

// ── 解析（词法：路径 → 步骤序列）────────────────────────────────────────

type Test =
  | { kind: 'elem'; name: string }
  | { kind: 'star' }
  | { kind: 'text' }
  | { kind: 'attr'; name: string }
type Axis = 'child' | 'descendant' | 'parent' | 'fwd' | 'bwd'
interface Step { axis: Axis; test: Test; preds: Predicate[] }

type Predicate =
  | { kind: 'pos'; op: '=' | '>' | '<' | '>=' | '<='; rhs: number | 'last' }
  | { kind: 'attrExists'; attr: string }
  | { kind: 'textExists' }
  | { kind: 'elemExists'; name: string }
  | { kind: 'attrEq'; attr: string; lit: string }
  | { kind: 'textEq'; lit: string }
  | { kind: 'fn'; fn: 'contains' | 'starts-with'; target: 'text' | { attr: string }; lit: string }
  | { kind: 'not'; inner: Predicate }
  | { kind: 'and'; parts: Predicate[] }
  | { kind: 'or'; parts: Predicate[] }
  | { kind: 'pathExists'; steps: Step[] }

function parseXPath(path: string): Step[] {
  const p = path.trim()
  if (p === '' || p === '//') throw new UnsupportedRuleError('XPath 路径为空', { facet: 'rule', segmentIndex: -1, segmentRaw: path })
  // 起始形态：// 或 .// → 上下文内后代起步；/ → 子步起步；裸元素名等 → 子步起步
  let rest: string
  let firstAxis: Axis
  if (p.startsWith('.//') || p.startsWith('//')) { rest = p.replace(/^\.?\/\//, ''); firstAxis = 'descendant' }
  else if (p.startsWith('/')) { rest = p.slice(1); firstAxis = 'child' }
  else { rest = p; firstAxis = 'child' }
  if (rest === '') throw new UnsupportedRuleError('XPath 路径为空', { facet: 'rule', segmentIndex: -1, segmentRaw: path })
  const tokens = splitBySteps(rest)
  return tokens.map((t, i) => {
    if (t.text === '') throw new UnsupportedRuleError('XPath 含空步骤', { facet: 'rule', segmentIndex: -1, segmentRaw: path })
    return parseStep(t.text, i === 0 ? firstAxis : t.axis)
  })
}

/** 按 / 与 // 切步骤（括号深度感知——谓词内的 / 不切）。
 *  返回的 axis 是「该步前方分隔符」的轴（首步占位 child，由 parseXPath 覆盖）。 */
function splitBySteps(s: string): Array<{ text: string; axis: Axis }> {
  const texts: string[] = []
  const axesAfter: Axis[] = []   // axesAfter[k] = 第 k 个分隔符的轴
  let depth = 0
  let start = 0
  let i = 0
  while (i < s.length) {
    const c = s[i]
    if (c === '[') depth++
    else if (c === ']') depth--
    else if (c === '/' && depth === 0) {
      texts.push(s.slice(start, i))
      const isDouble = s[i + 1] === '/'
      axesAfter.push(isDouble ? 'descendant' : 'child')
      i += isDouble ? 2 : 1
      start = i
      continue
    }
    i++
  }
  texts.push(s.slice(start))
  // 平移：out[k].axis = 第 k-1 个分隔符的轴（首步无分隔符——占位 child）
  return texts.map((text, k) => ({ text, axis: k === 0 ? 'child' : axesAfter[k - 1] }))
}

const AXIS_NAMES: Record<string, Axis> = { 'following-sibling': 'fwd', 'preceding-sibling': 'bwd' }

function parseStep(token: string, axis: Axis): Step {
  // 谓词提取（尾部 [..] 链，括号配平切）
  const preds: Predicate[] = []
  let body = token
  while (body.endsWith(']')) {
    let depth = 0
    let open = -1
    for (let i = body.length - 1; i >= 0; i--) {
      if (body[i] === ']') depth++
      else if (body[i] === '[') {
        depth--
        if (depth === 0) { open = i; break }
      }
    }
    if (open === -1) throw new Error(`谓词括号不配平: ${token}`)
    preds.unshift(parsePredicate(body.slice(open + 1, -1)))
    body = body.slice(0, open)
  }
  let test = body
  let effAxis = axis
  // 父步 `..`：axis 换成 parent，节点测试用 `*`（文档根不是元素，自然被 filter 掉 → 零命中而非猜成 html）
  if (body === '..') return { axis: 'parent', test: { kind: 'star' }, preds }
  const dbl = test.indexOf('::')
  if (dbl !== -1) {
    const name = test.slice(0, dbl)
    const mapped = AXIS_NAMES[name]
    if (mapped === undefined) {
      throw new UnsupportedRuleError(`XPath 轴不支持: ${name}::（子集：child/parent(..)/following-sibling/preceding-sibling）`, {
        facet: 'rule', segmentIndex: -1, segmentRaw: token,
      })
    }
    effAxis = mapped
    test = test.slice(dbl + 2)
  }
  // 属性步仅限末段由 evalXPath 事后检查（解析层不区分末段——调用链上下文未知）
  return { axis: effAxis, test: parseTest(test, token), preds }
}

function parseTest(test: string, token: string): Test {
  if (test === '*') return { kind: 'star' }
  if (test === 'text()') return { kind: 'text' }
  if (test.startsWith('@')) {
    const name = test.slice(1)
    if (!/^[A-Za-z_][\w.-]*$/.test(name)) throw new Error(`非法属性名: ${test}`)
    return { kind: 'attr', name }
  }
  if (/^[A-Za-z_][\w.-]*$/.test(test)) return { kind: 'elem', name: test }
  throw new UnsupportedRuleError(`XPath 步骤不支持: ${token}（子集：元素/*/text()/@attr）`, {
    facet: 'rule', segmentIndex: -1, segmentRaw: token,
  })
}

// ── 谓词解析与求值 ─────────────────────────────────────────────────────

function parsePredicate(content: string): Predicate {
  const orSplit = splitTop(content, ' or ')
  if (orSplit.length > 1) return { kind: 'or', parts: orSplit.map(parsePredicate) }
  const andSplit = splitTop(content, ' and ')
  if (andSplit.length > 1) return { kind: 'and', parts: andSplit.map(parsePredicate) }
  const c = content.trim()
  if (c === '') throw new Error('空谓词')
  if (c.startsWith('not(') && c.endsWith(')')) return { kind: 'not', inner: parsePredicate(c.slice(4, -1)) }
  // position()/last() 比较
  const pos = /^position\(\)\s*(=|>=|<=|>|<)\s*(last\(\)|\d+)$/.exec(c)
  if (pos) {
    const rhs = pos[2] === 'last()' ? 'last' : Number(pos[2])
    return { kind: 'pos', op: pos[1] as '=' | '>' | '<' | '>=' | '<=', rhs }
  }
  if (c === 'last()') return { kind: 'pos', op: '=', rhs: 'last' }
  if (/^\d+$/.test(c)) return { kind: 'pos', op: '=', rhs: Number(c) }
  // contains / starts-with
  const fn = /^(contains|starts-with)\s*\((.+)\)$/.exec(c)
  if (fn) {
    const inner = splitTop(fn[2], ',')
    if (inner.length !== 2) throw new Error(`函数参数不是二元: ${fn[1]}`)
    const target = inner[0].trim()
    const lit = parseLiteral(inner[1].trim())
    if (target === 'text()') return { kind: 'fn', fn: fn[1] as 'contains' | 'starts-with', target: 'text', lit }
    if (target.startsWith('@')) return { kind: 'fn', fn: fn[1] as 'contains' | 'starts-with', target: { attr: target.slice(1) }, lit }
    throw new UnsupportedRuleError(`XPath 函数目标不支持: ${target}（仅 text()/@attr）`, { facet: 'rule', segmentIndex: -1, segmentRaw: content })
  }
  // @attr='v' / @attr（存在）
  const attrEq = /^@([\w.-]+)\s*=\s*(.+)$/.exec(c)
  if (attrEq) return { kind: 'attrEq', attr: attrEq[1], lit: parseLiteral(attrEq[2].trim()) }
  if (/^@[\w.-]+$/.test(c)) return { kind: 'attrExists', attr: c.slice(1) }
  // text()='v' / text()（存在）
  const textEq = /^text\(\)\s*=\s*(.+)$/.exec(c)
  if (textEq) return { kind: 'textEq', lit: parseLiteral(textEq[1].trim()) }
  if (c === 'text()') return { kind: 'textExists' }
  // 子元素存在（[dd[a]]）
  if (/^[A-Za-z_][\w.-]*$/.test(c)) return { kind: 'elemExists', name: c }
  // 相对路径存在性谓词（XPath 1.0 的节点集谓词：**非空即真**）。真机实证 li[.//a]
  // （搬山人小说网 ruleChapterList：卷里「有链接的 li」才是章节行）。属性步按属性节点
  // 存在性判（testNode 的 attr 分支就是「该元素有这个属性」），故 [a/@href] 同样成立。
  // `//` 起步在谓词里是**文档根**绝对轴，本求值器手里只有上下文节点，不猜成后代——如实抛。
  if (c.startsWith('//')) {
    throw new UnsupportedRuleError(`谓词路径起步不支持: ${content}（谓词内 // 要从文档根取，本求值器只在上下文节点内走轴）`, {
      facet: 'rule', segmentIndex: -1, segmentRaw: content,
    })
  }
  if (c.startsWith('.//') || c.startsWith('./') || (/^[A-Za-z_@*]/.test(c) && c.includes('/'))) {
    return { kind: 'pathExists', steps: parseXPath(c.startsWith('./') ? c.slice(1) : c) }
  }
  // 白名单外函数（count/sum 等）→ 宁炸不猜
  if (/^[A-Za-z-]+\s*\(/.test(c)) {
    throw new UnsupportedRuleError(`XPath 函数不支持: ${c.split('(')[0].trim()}（子集：contains/starts-with/not/position/last）`, {
      facet: 'rule', segmentIndex: -1, segmentRaw: content,
    })
  }
  throw new Error(`谓词无法识别: ${content}`)
}

function parseLiteral(s: string): string {
  if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) return s.slice(1, -1)
  throw new Error(`字面量必须带引号: ${s}`)
}

/** 顶层切分（引号与括号深度感知——函数参数/嵌套谓词内的分隔不切）；单段原样返回 */
function splitTop(s: string, sep: string): string[] {
  const out: string[] = []
  let depth = 0
  let quote = ''
  let start = 0
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quote !== '') { if (c === quote) quote = ''; continue }
    if (c === "'" || c === '"') { quote = c; continue }
    if (c === '(' || c === '[') depth++
    else if (c === ')' || c === ']') depth--
    if (depth === 0 && s.startsWith(sep, i)) {
      out.push(s.slice(start, i))
      i += sep.length - 1
      start = i + 1
    }
  }
  if (out.length === 0) return [s]
  out.push(s.slice(start))
  return out.map((x) => x.trim()).filter((x) => x !== '')
}

// ── 求值 ───────────────────────────────────────────────────────────────

function nodeChildren(n: AnyNode): AnyNode[] {
  const kids = (n as Element).children
  return kids ? [...kids] : []
}

function descendants(n: AnyNode): AnyNode[] {
  const out: AnyNode[] = []
  const walk = (node: AnyNode): void => {
    for (const c of nodeChildren(node)) { out.push(c); walk(c) }
  }
  walk(n)
  return out
}

function axisPool(ctx: AnyNode, axis: Axis): AnyNode[] {
  switch (axis) {
    case 'child': return nodeChildren(ctx)
    case 'descendant': return descendants(ctx)
    case 'parent': {
      const p = (ctx as Element).parent
      return p ? [p] : []
    }
    case 'fwd': {
      const parent = (ctx as Element).parent
      if (parent === null) return []
      const sibs = nodeChildren(parent)
      const i = sibs.indexOf(ctx)
      return i === -1 ? [] : sibs.slice(i + 1)
    }
    case 'bwd': {
      const parent = (ctx as Element).parent
      if (parent === null) return []
      const sibs = nodeChildren(parent)
      const i = sibs.indexOf(ctx)
      // preceding-sibling 是**逆向轴**：XPath 1.0 §2.4 规定其位置按逆文档序编号——
      // 池按逆文档序（最近的在前），谓词位置才与规范一致（`[1]`=最近者，`[last()]`=最远者）。
      // 此前按文档序切片（slice(0,i)）+ 文档序编号 → `[1]`/`[last()]` 双双与规范相反。
      return i === -1 ? [] : sibs.slice(0, i).reverse()
    }
  }
}

function testNode(n: AnyNode, test: Test): boolean {
  switch (test.kind) {
    case 'text': return n.type === 'text'
    case 'attr': return n.type === 'tag' && (n as Element).attribs?.[test.name] !== undefined
    case 'star': return n.type === 'tag'
    case 'elem': return n.type === 'tag' && (n as Element).tagName?.toLowerCase() === test.name.toLowerCase()
  }
}

function applyPredicates(nodes: AnyNode[], preds: Predicate[]): AnyNode[] {
  if (preds.length === 0) return nodes
  return nodes.filter((n, i) => preds.every((p) => evalPredicate(p, n, i + 1, nodes.length)))
}

/** 走一步（主链与谓词内相对路径共用这份实现——两处各写一遍必然漂移）：
 *  取轴 → 节点测试 → **按父分组**过谓词（真 XPath 语义：//dd[2] = 每父第 2 个 dd，不是全局第 2 个）→ 去重。 */
function stepForward(candidates: AnyNode[], step: Step): AnyNode[] {
  const next: AnyNode[] = []
  const seen = new Set<AnyNode>()
  for (const ctx of candidates) {
    const pool = axisPool(ctx, step.axis)
    const matched = pool.filter((n) => testNode(n, step.test))
    const groups = new Map<AnyNode, AnyNode[]>()
    for (const n of matched) {
      const p = (n as Element).parent ?? n
      const g = groups.get(p)
      if (g === undefined) groups.set(p, [n])
      else g.push(n)
    }
    for (const group of groups.values()) {
      for (const n of applyPredicates(group, step.preds)) {
        if (!seen.has(n)) { seen.add(n); next.push(n) }
      }
    }
  }
  return next
}

/** 谓词内相对路径的命中集（existence 判据 = 非空）。
 *  属性步特判：XPath 的 `a/@href` 选的是 a **自己的**属性节点，不是「a 的子节点里测试 href」
 *  ——属性不在子节点链上。故属性步按「当前集合中该属性存在者」过滤，不沿轴移动。
 *  （主链上的属性步由 evalXPath 的末段提取分支处理，同一口径。） */
function pathHits(ctx: AnyNode, steps: Step[]): AnyNode[] {
  let cur: AnyNode[] = [ctx]
  for (const step of steps) {
    cur = step.test.kind === 'attr'
      ? applyPredicates(cur.filter((n) => testNode(n, step.test)), step.preds)
      : stepForward(cur, step)
    if (cur.length === 0) return cur
  }
  return cur
}

/** 谓词内 text() 口径：元素 textContent（拼接后代文本 trim）——近似已文档化（真实样本全落此口径） */
function predText(n: AnyNode): string {
  if (n.type === 'text') return cleanText((n as Text).data ?? '')
  return cleanText(textContentOf(n))
}

function textContentOf(n: AnyNode): string {
  let out = ''
  for (const c of nodeChildren(n)) out += c.type === 'text' ? (c as Text).data : textContentOf(c)
  return out
}

function evalPredicate(p: Predicate, n: AnyNode, pos: number, size: number): boolean {
  switch (p.kind) {
    case 'pos': {
      const rhs = p.rhs === 'last' ? size : p.rhs
      switch (p.op) {
        case '=': return pos === rhs
        case '>': return pos > rhs
        case '<': return pos < rhs
        case '>=': return pos >= rhs
        case '<=': return pos <= rhs
      }
      return false
    }
    case 'attrExists': return n.type === 'tag' && (n as Element).attribs?.[p.attr] !== undefined
    case 'textExists': return predText(n) !== ''
    case 'elemExists': return nodeChildren(n).some((c) => c.type === 'tag' && (c as Element).tagName?.toLowerCase() === p.name.toLowerCase())
    case 'pathExists': return pathHits(n, p.steps).length > 0
    case 'attrEq': return n.type === 'tag' && ((n as Element).attribs?.[p.attr] ?? '') === p.lit
    case 'textEq': return predText(n) === p.lit
    case 'fn': {
      const subject = p.target === 'text'
        ? predText(n)
        : (n.type === 'tag' ? (n as Element).attribs?.[p.target.attr] ?? '' : '')
      return p.fn === 'contains' ? subject.includes(p.lit) : subject.startsWith(p.lit)
    }
    case 'not': return !evalPredicate(p.inner, n, pos, size)
    case 'and': return p.parts.every((x) => evalPredicate(x, n, pos, size))
    case 'or': return p.parts.some((x) => evalPredicate(x, n, pos, size))
  }
}
