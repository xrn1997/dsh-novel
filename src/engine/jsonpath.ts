import type { EngineValue, Facet, SegmentLoc } from './types.js'
import { UnsupportedRuleError } from './errors.js'

/**
 * JSONPath 子集（口径：自实现，禁 npm 依赖）。
 *
 * 支持：`$`、`.name`、`..name`（递归下降，按文档序收集）、`[n]`（下标，**负数从尾数**）、
 * `[a:b]`（半开切片 [a,b)，负数从尾数）、`[*]`（全部）、`[]`（与 `[*]` 同义）、
 * 以及真实源里的冗余点形态 `.[*]`（`[` 前允许一个 `.`）。
 *
 * 明确拒绝（宁炸不猜 → UnsupportedRuleError，段级定位）：
 * 过滤器 `[?(…)]`、脚本 `[(…)]`、`@`/`&` 特殊符号、以及任何不匹配上述语法的内容。
 *
 * 结果映射（取值规约：**取位失败 → Miss；解析到空集合 → 空 List**）：
 * - 路径零命中 / 解析到 null/undefined / 下标越界 / 切片裁空 → Miss；
 * - 空数组、键存在且值为 `[]`（空集合已解析）→ List{items:[]}（合法空，区别于 Miss）；
 * - 非空数组 → List；直接标量（string/number/bool）→ Value。
 * 元素转字符串：字符串原样；对象/数组 JSON.stringify；number/bool → String()。
 *
 * 设计文档：docs/design/engine.md
 */

type Token =
  | { kind: 'child'; name: string }
  | { kind: 'descend'; name: string }
  | { kind: 'index'; value: number }
  | { kind: 'slice'; from: number | null; to: number | null }
  | { kind: 'wildcard' }

const NAME_CHAR = /[\w$]/

function reject(path: string, loc: SegmentLoc, facet: Facet, reason: string): never {
  throw new UnsupportedRuleError(`JSONPath 子集不支持该语法：${reason}（路径: ${JSON.stringify(path)}）`, { ...loc, facet })
}

/** 手写 tokenizer：逐字符扫描，认不出的一律拒绝 */
function tokenize(path: string, loc: SegmentLoc, facet: Facet): Token[] {
  if (path === '') reject(path, loc, facet, '空路径')
  if (path[0] === '@') reject(path, loc, facet, '@ 特殊符号')
  if (path[0] !== '$') reject(path, loc, facet, '路径必须以 $ 开头')

  const tokens: Token[] = []
  let i = 1
  while (i < path.length) {
    const c = path[i]
    if (c === '.') {
      if (path[i + 1] === '.') {
        // `..name` 递归下降（名字必填；`..*` 不在子集内）
        i += 2
        const start = i
        while (i < path.length && NAME_CHAR.test(path[i])) i++
        if (i === start) reject(path, loc, facet, `递归下降缺少属性名（位置 ${start}）`)
        tokens.push({ kind: 'descend', name: path.slice(start, i) })
        continue
      }
      i++
      if (path[i] === '[') continue // 冗余点：`.[` —— 吃掉点，下轮走括号分支
      if (path[i] === '*') { // `.*` 属性通配（真实源形态：$.data.* / $.comics.*——取对象全部值）
        i++
        tokens.push({ kind: 'wildcard' })
        continue
      }
      const start = i
      while (i < path.length && NAME_CHAR.test(path[i])) i++
      if (i === start) reject(path, loc, facet, `点后缺少属性名（位置 ${start}）`)
      tokens.push({ kind: 'child', name: path.slice(start, i) })
      continue
    }
    if (c === '[') {
      const end = path.indexOf(']', i + 1)
      if (end === -1) reject(path, loc, facet, `方括号未闭合（位置 ${i}）`)
      const inner = path.slice(i + 1, end)
      i = end + 1
      if (inner === '*' || inner === '') { tokens.push({ kind: 'wildcard' }); continue }
      if (inner.includes('?')) reject(path, loc, facet, `过滤器 [?()] 不支持`)
      if (inner.startsWith('(') || inner.includes('(')) reject(path, loc, facet, `脚本表达式 [()] 不支持`)
      if (/^-?\d+$/.test(inner)) { tokens.push({ kind: 'index', value: Number(inner) }); continue }
      if (/^(-?\d+)?:(-?\d+)?$/.test(inner)) {
        const [a, b] = inner.split(':')
        tokens.push({ kind: 'slice', from: a === '' ? null : Number(a), to: b === '' ? null : Number(b) })
        continue
      }
      reject(path, loc, facet, `下标内容不合法：${JSON.stringify(inner)}`)
    }
    if (c === '@') reject(path, loc, facet, '@ 特殊符号')
    if (c === '&') reject(path, loc, facet, '& 特殊符号')
    reject(path, loc, facet, `意外字符 ${JSON.stringify(c)}（位置 ${i}）`)
  }
  return tokens
}

function isObjectLike(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

/** 递归下降：文档序（先 key 命中、再深入各值），命中值非 null 才收集 */
function descend(node: unknown, name: string, out: unknown[]): void {
  if (Array.isArray(node)) {
    for (const el of node) descend(el, name, out)
    return
  }
  if (!isObjectLike(node)) return
  for (const [k, v] of Object.entries(node)) {
    if (k === name && v !== null && v !== undefined) out.push(v)
    descend(v, name, out)
  }
}

/** 单段作用于当前值列表；解析到 null/undefined 的分支直接丢弃（最终体现为 Miss） */
function applyToken(cur: unknown[], tok: Token): unknown[] {
  const out: unknown[] = []
  for (const v of cur) {
    switch (tok.kind) {
      case 'child': {
        if (!isObjectLike(v)) break
        const got = (v as Record<string, unknown>)[tok.name]
        if (got !== null && got !== undefined) out.push(got)
        break
      }
      case 'descend':
        descend(v, tok.name, out)
        break
      case 'index': {
        if (!Array.isArray(v)) break
        const i = tok.value < 0 ? v.length + tok.value : tok.value   // 负数从尾数（与 select.applyIndex 同口径）
        if (i < 0 || i >= v.length) break
        const got = v[i]
        if (got !== null && got !== undefined) out.push(got)
        break
      }
      case 'slice': {
        if (!Array.isArray(v)) break
        const from0 = tok.from === null ? 0 : tok.from
        const to0 = tok.to === null ? v.length : tok.to
        const from = from0 < 0 ? v.length + from0 : from0           // 负 from/to 从尾数
        const to = to0 < 0 ? v.length + to0 : to0
        for (const el of v.slice(Math.max(from, 0), Math.max(to, 0))) {
          if (el !== null && el !== undefined) out.push(el)
        }
        break
      }
      case 'wildcard': {
        if (Array.isArray(v)) {
          for (const el of v) if (el !== null && el !== undefined) out.push(el)
          break
        }
        // `.*` 属性通配作用于对象：取全部值（data 为对象时取其值集合）
        if (isObjectLike(v)) {
          for (const el of Object.values(v)) if (el !== null && el !== undefined) out.push(el)
        }
        break
      }
    }
  }
  return out
}

/** 元素钉死规则：字符串原样；对象/数组 JSON.stringify；number/bool → String() */
function stringifyElement(v: unknown): string {
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return JSON.stringify(v)
}

function toValue(v: unknown): EngineValue {
  if (v === null || v === undefined) return { kind: 'miss', detail: 'JSONPath 解析到 null' }
  if (Array.isArray(v)) return { kind: 'list', items: v.map(stringifyElement) }
  if (isObjectLike(v)) return { kind: 'value', text: JSON.stringify(v) }
  return { kind: 'value', text: stringifyElement(v) }
}

/**
 * 求值一条 JSONPath 子集路径：
 * `$` 起始，逐 token 走 `EvalContext.json` 值。
 * 零命中 / 取到 null / 下标越界 / 切片裁空 → Miss；空数组（键存在且值为 []）→ List{[]}；
 * 非空数组 → List；直接标量 → Value。
 */
export function evalJsonPath(path: string, data: unknown, loc: SegmentLoc, facet: Facet): EngineValue {
  const tokens = tokenize(path, loc, facet)
  let cur: unknown[] = [data]
  for (const tok of tokens) {
    const prev = cur
    cur = applyToken(cur, tok)
    // 取位失败 → Miss；解析到空集合 → 空 List（取值规约，与 select.reducePicked 同口径）：
    // 切片裁空是「取位失败」→ Miss；通配 [*] 打在空数组上是「解析到空集合」→ 空 List。
    if (cur.length === 0 && prev.some(Array.isArray)) {
      if (tok.kind === 'slice') return { kind: 'miss', detail: `JSONPath 切片裁空：${path}` }
      if (tok.kind === 'wildcard') return { kind: 'list', items: [] }
    }
  }
  if (cur.length === 0) return { kind: 'miss', detail: `JSONPath 零命中：${path}` }
  // 集合型末段（[*] / [a:b] / ..name）恒产 List——哪怕只收一个（真实源 `.[*]` 钉死）
  const last = tokens[tokens.length - 1]
  const collection = last !== undefined && (last.kind === 'wildcard' || last.kind === 'slice' || last.kind === 'descend')
  if (collection || cur.length > 1) return { kind: 'list', items: cur.map(stringifyElement) }
  return toValue(cur[0])
}
