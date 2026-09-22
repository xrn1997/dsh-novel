import type { Cheerio, CheerioAPI } from 'cheerio'
import type { AnyNode } from 'domhandler'
import type { Branch, EngineValue, EvalContext, Facet, ParsedRule, RuleUsage, Segment, SegmentLoc } from './types.js'
import { parseRule } from './parse.js'
import { evalCss } from './css.js'
import { evalDefault, isGetValueSegment } from './select.js'
import { evalJsonPath } from './jsonpath.js'
import { evalXPath } from './xpath.js'
import { evalAllInOne } from './allinone.js'
import { evalPut, evalGetVar, resolveJsonData } from './variables.js'
import { evalJs } from './js-sandbox.js'
import type { EvaluateRef, JsHost } from './js-sandbox.js'
import { combine, reverseList } from './combine.js'
import { applyReplaces } from './replace.js'
import { loadHtml } from './dom.js'
import { engineValueToString } from './js-utils.js'
import { splitLiteral } from './literal.js'

/** 设计文档：docs/design/engine.md */
import { JsSandboxError, RuleEvalError, UnsupportedRuleError, isEngineError } from './errors.js'

// ── trace 类型（冻结：服务层 / 工具面 / UI 只准用这套）──────────────────

export interface TraceStep {
  segmentIndex: number
  segmentRaw: string
  segmentKind: Segment['kind']
  /** 节点/条目数（Value 记 1、Miss 记 0）；js 段为 null */
  hits: number | null
  /** 取值预览（截断 80 字符） */
  preview: string
  jsLogs?: string[]
  error?: { code: 'UnsupportedRuleError' | 'RuleEvalError' | 'JsSandboxError'; message: string }
}

export interface TraceResult {
  value: EngineValue
  steps: TraceStep[]
  combinator: ParsedRule['combinator']
  reverse: boolean
}

// ── 公开接口 ───────────────────────────────────────────────────────────

/**
 * 总装求值：parse → 逐分支逐段求值 → 组合符合并 → 反序 → `##` 替换尾。
 * 收到 ParsedRule 时直通内部 runner，不重 parse。
 * 引擎语义：Miss 是值（透传/合并按组合符口径）；UnsupportedRuleError /
 * RuleEvalError / JsSandboxError 一律不吞，向上抛（trace 只由 evaluateWithTrace 收集）。
 */
export async function evaluate(
  rule: ParsedRule | string,
  ctx: EvalContext,
  facet: Facet = 'rule',
  usage: RuleUsage = 'list',
): Promise<EngineValue> {
  const parsed = typeof rule === 'string' ? parseRule(rule, facet, usage) : rule
  return runParsed(parsed, ctx, facet, null)
}

/** 带段级 trace 的求值：每段一行 Step；错误段 push error Step 后照抛（不认识的语法必须炸）。 */
export async function evaluateWithTrace(
  rule: string,
  ctx: EvalContext,
  facet: Facet = 'rule',
  usage: RuleUsage = 'list',
): Promise<TraceResult> {
  const parsed = parseRule(rule, facet, usage)
  const steps: TraceStep[] = []
  const value = await runParsed(parsed, ctx, facet, steps)
  return { value, steps, combinator: parsed.combinator, reverse: parsed.reverse }
}

// ── 运行时（每条规则一份；lazy 化 cheerio 与整页文本）───────────────────

interface Runtime {
  ctx: EvalContext
  facet: Facet
  /** 本条规则的用途（getElements / getString 两条路径的身份）——js 段 result 绑定形态按它分派 */
  usage: RuleUsage
  /** 懒加载的页面 DOM（jsonpath/js-only 规则不付 cheerio 成本） */
  $(): CheerioAPI
  /** 整页文本：ctx.html ?? String(ctx.json ?? '')（allinone / 独立净化用） */
  pageText(): string
  /** JSONPath 求值数据：ctx.json 优先；缺席且 html 是合法 JSON 时回退解析 html
   *  （legado `isJSON = content.toString().isJson()` → `JsonPath.parse(content)` 口径——
   *  搜索链路只传 html 不传 json，不回退的话所有 $. 规则对 JSON API 源恒 Miss） */
  jsonData(): unknown
  /** java.getString* 的递归求值回调（同步子规则接线口） */
  evaluateRef: EvaluateRef
}

function makeRuntime(ctx: EvalContext, facet: Facet, usage: RuleUsage): Runtime {
  let api: CheerioAPI | null = null
  let page: string | null = null
  let jsonParsed = false
  let jsonValue: unknown
  return {
    ctx,
    facet,
    usage,
    $: () => (api ??= loadHtml(ctx.html ?? '')),
    pageText: () => (page ??= ctx.html ?? String(ctx.json ?? '')),
    jsonData: () => {
      if (!jsonParsed) {
        jsonParsed = true
        jsonValue = resolveJsonData(ctx)
      }
      return jsonValue
    },
    // 子规则对「给定数据」求值：data 作为子规则的 html 上下文（与 host.result 同源）
    evaluateRef: (ruleStr, data) =>
      runParsedSync(parseRule(ruleStr, facet), { ...ctx, html: String(data ?? '') }, facet),
  }
}

/** JSONPath 求值数据解析已迁 variables.ts（resolveJsonData）——打破 evaluate ↔ variables 运行时环 */

/** 独立净化形态（##a##b，branches 为空）：基值 = 整页原文（ctx.html ?? String(ctx.json ?? ''）），
 * 不经 DOM——JSON 页（无 html）以序列化文本为基值净化 */
function standaloneBase(rt: Runtime): EngineValue {
  return { kind: 'value', text: rt.pageText() }
}

// ── 链语义单点（双 runner 收拢）──────────────────────────────────────
//
// 一条取值链的执行语义（链衔接、@put 副作用透传、js 段特判、trace 组装、错误步）只此一份，
// 以 generator 表达：非 js 段同步推进，js 段 yield 出完整 evalJs 入参给驱动器。两个驱动器
// 只负责喂结果，零链知识：
//  - 异步驱动（evaluate / evaluateWithTrace 主路径）：await evalJs 后回喂；
//  - 同步驱动（java.getString* 的 evaluateRef 专用——沙箱宿主桥是同步接口）：
//    遇第一次 yield 即「子规则内不支持 js 段」宁炸不猜。
// 此前 runParsed/runParsedSync 是 ~60 行逐条镜像的孪生：特判段（js/put）必须双写，
// 且同步环路（真实 evaluateRef）零测试（见 tests/engine/evaluate-sync-loop.test.ts）。

/** js 段调用：generator yield 给驱动器的完整 evalJs 入参（驱动器对段零知识） */
type JsCall = Parameters<typeof evalJs>
type JsOutcome = Awaited<ReturnType<typeof evalJs>>

function* ruleGen(
  parsed: ParsedRule, ctx: EvalContext, facet: Facet, collect: TraceStep[] | null,
): Generator<JsCall, EngineValue, JsOutcome> {
  const rt = makeRuntime(ctx, facet, parsed.usage)
  if (parsed.branches.length === 0) return finalize(parsed, [standaloneBase(rt)], facet, rt)
  const values: EngineValue[] = []
  let offset = 0 // 全规则连续段号（与 parse 的 counter 口径一致）
  for (const branch of parsed.branches) {
    values.push(yield* branchGen(branch, offset, rt, collect))
    offset += branch.segments.length
  }
  return finalize(parsed, values, facet, rt)
}

function* branchGen(
  branch: Branch, offset: number, rt: Runtime, collect: TraceStep[] | null,
): Generator<JsCall, EngineValue, JsOutcome> {
  let cur: EngineValue | null = null // null = 尚未起链（select 段落地时取根节点集 $('*')）
  for (let i = 0; i < branch.segments.length; i++) {
    const seg = branch.segments[i]
    const loc: SegmentLoc = { segmentIndex: offset + i, segmentRaw: branch.raws[i] }
    try {
      checkChainStart(seg, i, loc, rt.facet)
      if (seg.kind === 'js') {
        const prev: EngineValue | null = cur // 首段（prev=null）时 host.result 取整页原文
        // 驱动器经 gen.throw(e) 把 evalJs 失败投回此处——错误步与重抛走同一条 catch（单点）
        // scriptForm:true（legado @js 口径）：**最后一个表达式的值即结果**——此前链内 js 段
        // 走 wrapped async IIFE（无 return 的表达式形态恒 undefined → Miss），
        // 真实源 `$.id@js:"…"+result` 这类主导形态整批静默取空（正文链路审计归因）。
        // **对面 makeUpRule 在按 mode 分发之前重写规则文本**，故 js 段代码里的 `{{…}}` /
        // `{$…}` 先按当前链上下文插值（全库 158 源里 28 源靠它拼 URL：米读小说的
        // `@js:"https://…/chapter_list/100/{{$.book_id}}.txt"` 实证不插值就把字面花括号
        // 发上网，打到 404 残地址）。插值段 Miss → 整段 Miss，与模板字面段同一口径。
        let code = seg.code
        if (code.includes('{{')) {
          // **只认双花括号**：单括号 `{$…}` 在 js 文本里通常是 JS 模板字面量 `${expr}`
          // 的一部分（中文书城 ruleToc.chapterList 的 `${$.bookid}` 实证——把它当 JSONPath
          // 插值会让整段 Miss、目录 0 章），`@get:` 同理由脚本自己处理。
          const rewritten: EngineValue = yield* interpolateTemplate(code, cur, rt, loc, { doubleBraceOnly: true })
          if (rewritten.kind === 'miss') {
            cur = rewritten
            if (collect) collect.push(stepOf(seg, loc, rewritten))
            continue
          }
          code = engineValueToString(rewritten, 'inner')
        }
        const outcome: JsOutcome = yield [
          code,
          jsHostOf(prev, rt), rt.ctx, loc, rt.facet, rt.evaluateRef,
          { scriptForm: true },
        ]
        let out: EngineValue = outcome.value
        // 链上游是 List（多节点取值）→ js 串结果按 \n 拆回 List，保持链的「多条目」语义
        if (prev?.kind === 'list' && out.kind === 'value' && out.text.includes('\n')) {
          out = { kind: 'list', items: out.text.split('\n') }
        }
        cur = out
        if (collect) collect.push(stepOf(seg, loc, out, outcome.logs))
        continue
      }
      if (seg.kind === 'put') {
        // @put 是副作用段：写 ctx.vars 后链值透传，不替换 cur（legado 口径）。
        // 值按 getString 求值（legado putRule = put(key, getString(value))）：基内容 = 当前链值，
        // 未起链则是整页原文——真实源 `@put:{n:"[property$=x]@content"}` 作 ruleBookInfo.init 全靠这条。
        evalPut(seg.pairsRaw, rt.ctx, loc, rt.facet,
          (rule) => rt.evaluateRef(rule, cur === null ? rt.pageText() : engineValueToString(cur, 'inner')))
        if (collect) collect.push(putStepOf(loc, cur))
        continue
      }
      if (seg.kind === 'literal') {
        // 模板字面段：{{expr}} 插值（js 部分经驱动器求值）后整段产出 Value——链值被替换
        // （legado `else -> rule` 字面返回语义；`{{result}}` 引用当前链值）
        cur = yield* interpolateTemplate(seg.raw, cur, rt, loc)
        if (collect) collect.push(stepOf(seg, loc, cur))
        continue
      }
      cur = evalNonJs(seg, cur, rt, loc)
      if (collect) collect.push(stepOf(seg, loc, cur))
    } catch (e) {
      if (collect) collect.push(errorStepOf(e, seg, loc))
      throw e
    }
  }
  return cur ?? { kind: 'miss', detail: '空分支' }
}

/**
 * 模板内嵌段插值（**字面段与 js 段代码文本共用这一份**）：把 `{{expr}}` 与 `{$.path}`
 * 换成字符串后拼回原文。
 *
 * 对面顺序是 `putRule → makeUpRule(result) → 按 mode 分发`（`model/analyzeRule/AnalyzeRule.kt` getString），
 * `makeUpRule` 重写的是**规则文本本身**，所以对 `@js:` / `<js>` 代码里的字符串字面量同样生效。
 *
 * 任一插值段 Miss → 返回该 Miss（调用方整段失败）：把 Miss 折成空串会产出**语法合法的残 URL**
 * （`http://api/novel/{{$.id}}` → `http://api/novel/`），拿它发请求比报错更坏——
 * 真机实证：米读小说的 toc 请求打到 `…/chapter_list/100/` + 字面 `{{$.book_id}}` + `.txt`。
 */
function* interpolateTemplate(
  raw: string, cur: EngineValue | null, rt: Runtime, loc: SegmentLoc,
  opts?: { doubleBraceOnly?: boolean },
): Generator<JsCall, EngineValue, JsOutcome> {
  let out = ''
  let missPart: EngineValue | null = null
  for (const part of splitLiteral(raw, opts)) {
    let piece: EngineValue
    switch (part.kind) {
      case 'text': piece = { kind: 'value', text: part.text }; break
      case 'getvar': piece = evalGetVar(part.text, rt.ctx); break
      case 'jsonpath': piece = evalJsonPath(part.text, literalJsonData(rt, cur), loc, rt.facet); break
      case 'rule': {
        piece = runParsedSync(parseRule(part.text, rt.facet), literalSubCtx(rt, cur), rt.facet)
        break
      }
      case 'js': {
        const outcome: JsOutcome = yield [part.text, jsHostOf(cur, rt), rt.ctx, loc, rt.facet, rt.evaluateRef, { scriptForm: true }]
        piece = outcome.value
        break
      }
    }
    if (piece.kind === 'miss') { missPart = piece; break }
    out += engineValueToString(piece, 'inner')
  }
  return missPart ?? { kind: 'value', text: out }
}

/** 异步驱动：js 段 await evalJs 回喂；evalJs 失败经 gen.throw 投回 generator（错误步单点在内） */
async function driveAsync(gen: Generator<JsCall, EngineValue, JsOutcome>): Promise<EngineValue> {
  let step = gen.next()
  while (!step.done) {
    let outcome: JsOutcome
    try {
      outcome = await evalJs(...step.value)
    } catch (e) {
      gen.throw(e) // generator 的 catch 记错误步后照抛——此处必然再抛，下一行不可达
      throw e
    }
    step = gen.next(outcome)
  }
  return step.value
}

/** 同步驱动（evaluateRef 专用）：第一次 yield 即子规则含 js 段——宁炸不猜（语义与旧 runBranchSync 逐字一致） */
function driveSync(gen: Generator<JsCall, EngineValue, JsOutcome>, facet: Facet): EngineValue {
  const step = gen.next()
  if (!step.done) {
    const loc = step.value[3]
    throw new UnsupportedRuleError('子规则（java.getString 等递归求值）内不支持 js 段——沙箱宿主桥为同步接口', {
      segmentIndex: loc.segmentIndex,
      segmentRaw: loc.segmentRaw,
      facet,
    })
  }
  return step.value
}

async function runParsed(
  parsed: ParsedRule,
  ctx: EvalContext,
  facet: Facet,
  collect: TraceStep[] | null,
): Promise<EngineValue> {
  return driveAsync(ruleGen(parsed, ctx, facet, collect))
}

function runParsedSync(parsed: ParsedRule, ctx: EvalContext, facet: Facet): EngineValue {
  return driveSync(ruleGen(parsed, ctx, facet, null), facet)
}

// ── 非 js 段分派 + 链衔接状态机 ────────────────────────────────────────

function checkChainStart(seg: Segment, i: number, loc: SegmentLoc, facet: Facet): void {
  if (i === 0) return
  // jsonpath 中链合法（上游修复后 legado 语义——「js 返回对象再取字段」形态 `<js>{...}</js>$.a.b`：
  // fork 快捷路径不分发 Mode 导致这类源整体失败，TS 实现按上游分发语义走）
  if (seg.kind === 'allinone') {
    throw new UnsupportedRuleError('AllInOne 段必须是分支首位', { ...loc, facet })
  }
}

/** 链中段（不含 js/put/literal——三者在 branchGen 内联处理） */
type ChainSegment = Exclude<Segment, { kind: 'js' } | { kind: 'put' } | { kind: 'literal' }>

/** 非 js 段求值：选择段消费 nodes 链；Miss 穿透（选择/取值段对 Miss 上游原样透传） */
function evalNonJs(
  seg: ChainSegment,
  cur: EngineValue | null,
  rt: Runtime,
  loc: SegmentLoc,
): EngineValue {
  const $ = rt.$
  switch (seg.kind) {
    case 'css': {
      if (cur?.kind === 'miss') return cur // Miss 穿透：选择/取值段对 Miss 上游原样透传
      return evalCss(seg, $(), requireNodes(cur, rt, loc), loc, rt.facet)
    }
    case 'xpath': {
      if (cur?.kind === 'miss') return cur
      // 链首 → 文档根为上下文（`//` 语义全覆盖）；链中 → 上游节点集为作用域（`.//` 条目语义）
      const ctxNodes = cur === null ? $().root() : requireNodes(cur, rt, loc)
      return evalXPath(seg, $(), ctxNodes, loc, rt.facet)
    }
    case 'default': {
      if (cur?.kind === 'miss') return cur
      // 链首未起链：**取值段**以文档根为上下文取一次（legado `content.text()` 口径）。按 `$('*')`
      // 全集会让每个祖先各出一份——真源 `ruleToc.chapterName: "text"` 实测章名三遍。
      // 选择段（class/tag/`text.串`）仍从全集往下选。
      // 裸词终端在 JSON 条目上 = 属性读（见 jsonObjectOf）：`url` 与 `href`/`src` 两种形态
      const propName = seg.mode === 'attr' ? seg.arg
        : (seg.mode === 'href' || seg.mode === 'src') && seg.arg === null ? seg.mode
          : null
      const jsonBase = propName !== null && seg.index === null && !seg.exclude
        ? jsonObjectOf(cur, rt)
        : undefined
      if (jsonBase !== undefined) return evalJsonPath(`$.${propName}`, jsonBase, loc, rt.facet)
      const nodes = cur === null && isGetValueSegment(seg) ? $().root() : requireNodes(cur, rt, loc)
      return evalDefault(seg, $(), nodes, loc, rt.facet)
    }
    case 'jsonpath': {
      if (cur?.kind === 'miss') return cur
      if (cur === null) return evalJsonPath(seg.path, rt.jsonData(), loc, rt.facet)
      // 中链 jsonpath（上游修复后 legado 语义）：上游 Value → 按 JSON 解析后求值；
      // List → 逐项求值合并（「js 返回对象数组再取字段」形态）；节点集/正则结果 → 宁炸
      if (cur.kind === 'value') return evalJsonPath(seg.path, tryParseJson(cur.text), loc, rt.facet)
      if (cur.kind === 'list') {
        const items: string[] = []
        let misses = 0
        for (const it of cur.items) {
          const v = evalJsonPath(seg.path, tryParseJson(it), loc, rt.facet)
          if (v.kind === 'miss') { misses++; continue }            // 取位失败 → 该条目不贡献
          if (v.kind === 'list') { items.push(...v.items); continue } // 集合型 → 合并条目（空集合不贡献元素）
          items.push(engineValueToString(v, 'inner'))               // 命中即收：'' 是值，不是取位失败
        }
        // 取值规约（与 jsonpath 链首、select.reducePicked 同口径）：Miss 与空 List 绝不折叠。
        // 上游已是合法空 List → 逐项无物可求 → 空 List；非空上游逐项**全部**取位失败才是 Miss。
        if (cur.items.length === 0) return { kind: 'list', items: [] }
        return misses === cur.items.length
          ? { kind: 'miss', detail: 'jsonpath 中链逐项求值全部未命中' }
          : { kind: 'list', items }
      }
      throw new RuleEvalError('jsonpath 段上游是节点集/正则结果，无法按 JSON 求值', { ...loc, facet: rt.facet, hits: hitsOf(cur) })
    }
    case 'allinone':
      return evalAllInOne(seg, rt.pageText(), loc, rt.facet)
    case 'getvar':
      // @get 产出存储值（Value/Miss），合法替换链值
      return evalGetVar(seg.name, rt.ctx)
  }
}

/** 非 JSON 文本 → undefined（jsonpath 如实 Miss，不抛——与 resolveJsonData 的非法 JSON 口径一致） */
function tryParseJson(text: string): unknown {
  try { return JSON.parse(text) as unknown } catch { return undefined }
}

/** **裸词终端的 JSON 上下文**：对面按内容类型分派——`isJSON` 时整条规则走
 *  `AnalyzeByJSonPath.getString`（`model/analyzeRule/AnalyzeRule.kt`），于是真源里 `ruleChapterUrl: url`、
 *  `ruleBookUrl: url` 这类**不带 `$.` 的属性名**在 JSON 条目上是属性读。本仓条目上下文里
 *  JSON 条目以原文串落在 html（`services/reading.ts` 逐条 ctx），该段被当 HTML 属性终端在 DOM
 *  上找同名属性 → 恒 0 命中 → 逐章回退目录页 → 「未取到任何章节地址」RuleEvalError
 *  （2026-09 审计 3 源：麻豆传媒AI / 中文书城 / 全本小说型）。
 *  只在**当前内容本身是合法 JSON 对象**时改走 JSONPath；数组与 HTML 片段一律返回 undefined，
 *  因此 `img@_src` 这类 DOM 形态（对面同一条规则也只在字符串路径上取属性）不受影响。 */
function jsonObjectOf(cur: EngineValue | null, rt: Runtime): unknown {
  const text = cur === null ? rt.pageText() : cur.kind === 'value' ? cur.text : undefined
  if (text === undefined || !text.trimStart().startsWith('{')) return undefined
  const parsed = tryParseJson(text)
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined
}

/** 模板字面段的 JSON 数据源：链上有值 → 优先按上游文本解析（toc 条目 JSON 形态）；否则整页口径 */
function literalJsonData(rt: Runtime, cur: EngineValue | null): unknown {
  if (cur?.kind === 'value') return tryParseJson(cur.text)
  if (cur?.kind === 'list' && cur.items.length > 0) return tryParseJson(cur.items[0])
  return rt.jsonData()
}

/** 模板字面段里 `{{规则}}` 的子求值上下文：上游 Value → 其文本作为 html 上下文（条目片段语义） */
function literalSubCtx(rt: Runtime, cur: EngineValue | null): EvalContext {
  if (cur?.kind === 'value') return { ...rt.ctx, html: cur.text }
  return rt.ctx
}

/** 选择段上游解析：未起链 → 根节点集 $('*')；Miss → 原样穿透；
 *  Value（js 段产物/取值段产物）→ 按 HTML 解析为新上下文（legado String→JSoup 语义：
 *  `<js>…</js>@css:.x` 中 js 返回的字符串被当作新文档继续选择）；其余 → RuleEvalError */
function requireNodes(cur: EngineValue | null, rt: Runtime, loc: SegmentLoc): Cheerio<AnyNode> {
  if (cur === null) return rt.$()('*')
  if (cur.kind === 'miss') {
    // 上游 Miss 时由调用方（evalNonJs）提前短路，此分支仅兜底
    throw new RuleEvalError('上游结果是 Miss，无法继续选择', { ...loc, facet: rt.facet, hits: 0 })
  }
  if (cur.kind === 'value') {
    return loadHtml(cur.text).root()
  }
  if (cur.kind !== 'nodes') {
    throw new RuleEvalError('上游结果不是节点集，无法继续选择', { ...loc, facet: rt.facet, hits: 0 })
  }
  return cur.nodes
}

// ── 分支结果 → 组合 → 反序 → 替换尾 ─────────────────────────────────────

function finalize(parsed: ParsedRule, values: EngineValue[], facet: Facet, rt: Runtime): EngineValue {
  let value = combine(values, parsed.combinator, { facet, segmentIndex: -1, segmentRaw: '%%（组合符）' })
  if (parsed.reverse) value = reverseList(value)
  // 取值用途的链终点串化**先于** ## 替换（对面 replaceRegex 作用于已转成字符串的结果）
  if (rt.usage === 'value' && value.kind === 'nodes') value = nodesAsString(value.nodes)
  if (parsed.replaces.length > 0) {
    // `##` 尾的 `{{chapter.title}}` 类插值（legado makeUpRule：替换规则串同样先插值再当正则——
    // 真实源 `##...|{{chapter.title}}|...##` 去章标题行全靠它）；绑定缺位保持原文字面
    value = applyReplaces(value, parsed.replaces, parsed.onlyOne, { facet }, interpBindings(rt))
  }
  return value
}

/**
 * 取值用途的链终点节点集 → 字符串（对面 getString 出口从不因「剩节点集」而失败）：
 * 逐元素 **outerHTML**、以换行拼接——对面 XPath 模式在段内就把命中集按换行 join，
 * 每个节点转字符串取的是 jsoup `Element.toString()` = outerHtml；外层 `getString`
 * 兜底同样只 `toString()`（cheerio 的 `selection.toString()` = 逐个 outerHTML **无分隔**
 * 拼接，与对面 `Elements.toString()` 同形，但对面 XPath 的换行分隔在值面上更常见）。
 * 只在这一处发生：`nodes` 作为中间值仍是节点集（选择段接选择段照常），列表用途
 * （`ruleBookList`/`ruleChapterList`）也照旧交服务层逐条目求值。
 */
function nodesAsString(nodes: Cheerio<AnyNode>): EngineValue {
  const parts: string[] = []
  for (let i = 0; i < nodes.length; i++) parts.push(nodes.eq(i).toString())
  return { kind: 'value', text: parts.join('\n') }
}

/** 替换尾插值绑定：ctx 里的 book/chapter/vars/baseUrl（简单点路径查询，不进 JS 沙箱） */
function interpBindings(rt: Runtime): Record<string, string> {
  const b: Record<string, string> = {}
  const c = rt.ctx
  if (c.baseUrl !== undefined) b.baseUrl = c.baseUrl
  if (c.source !== undefined) b.source = c.source
  for (const [k, v] of Object.entries(c.vars ?? {})) b[k] = v
  const book = c.book ?? {}
  for (const [k, v] of Object.entries(book)) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') b[`book.${k}`] = String(v)
  }
  const chapter = c.chapter ?? {}
  for (const [k, v] of Object.entries(chapter)) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') b[`chapter.${k}`] = String(v)
  }
  if (typeof chapter.title === 'string') b.title = chapter.title
  return b
}

// ── trace 组装 ─────────────────────────────────────────────────────────

/** js 宿主注入：host.result = 上一段结果的序列化；首个段 → 整页原文（pageText：html ?? String(json)，与独立净化同口径）。
 *  resultKind 随行：nodes/page(html) 时沙箱把 result 包成元素包装对象（`result.attr()` 形态）。
 *  **列表用途下的 Miss 也报 nodes**：对面 getElements 路径上 `result` 恒是 org.jsoup.Elements，
 *  零命中只是**空集合**（`.toArray()` / `.size()` 照样在），而本仓若按原文字符串绑定，真源共用的
 *  toc 模板 `list = result.toArray()` 会当场炸成 JsSandboxError（废纸文学 / 新龙小说 / PO5），
 *  把一个「站点页面没有该结构」的站点侧事实误记成引擎侧失败。取值路径不变（String 语义）。 */
function jsHostOf(prev: EngineValue | null, rt: Runtime): JsHost {
  const kind = prev === null ? 'page' : prev.kind
  return {
    result: prev === null ? rt.pageText() : serialize(prev),
    resultKind: kind === 'miss' && rt.usage === 'list' ? 'nodes' : kind,
    resultCtx: rt.usage,
    baseUrl: rt.ctx.baseUrl ?? '',
    source: rt.ctx.source ?? '',
  }
}

function serialize(v: EngineValue): string {
  // 序列化单点归 js-utils；@js host.result 的 nodes 口径 = outerHTML（'outer'）——
  // 与 java.getString 的 innerHTML 口径由参数显式区分，不再各存一份实现。
  return engineValueToString(v, 'outer')
}

function hitsOf(v: EngineValue): number {
  switch (v.kind) {
    case 'value': return 1
    case 'list': return v.items.length
    case 'matches': return v.rows.length
    case 'nodes': return v.nodes.length
    case 'miss': return 0
  }
}

function previewOf(v: EngineValue): string {
  let s: string
  switch (v.kind) {
    case 'value': s = v.text; break
    case 'list': s = `${v.items.slice(0, 2).join(', ')}…(共${v.items.length}项)`; break
    case 'matches': s = (v.rows[0] ?? []).join('\t'); break
    case 'nodes': s = `${v.nodes.length}个节点`; break
    case 'miss': s = `miss: ${v.detail}`; break
  }
  return s.length > 80 ? s.slice(0, 80) : s
}

function stepOf(seg: Segment, loc: SegmentLoc, out: EngineValue, logs?: string[]): TraceStep {
  const step: TraceStep = {
    segmentIndex: loc.segmentIndex,
    segmentRaw: loc.segmentRaw,
    segmentKind: seg.kind,
    hits: seg.kind === 'js' ? null : hitsOf(out),
    preview: previewOf(out),
  }
  if (logs && logs.length > 0) step.jsLogs = logs
  return step
}

/** @put 步（副作用段）：链值透传——trace 显示透传态（pairs 原文见 segmentRaw） */
function putStepOf(loc: SegmentLoc, cur: EngineValue | null): TraceStep {
  return {
    segmentIndex: loc.segmentIndex,
    segmentRaw: loc.segmentRaw,
    segmentKind: 'put',
    hits: cur === null ? null : hitsOf(cur),
    preview: cur === null ? 'put 透传（链起点，无上游值）' : previewOf(cur),
  }
}

function errorStepOf(e: unknown, seg: Segment, loc: SegmentLoc): TraceStep {
  const code: NonNullable<TraceStep['error']>['code'] =
    e instanceof UnsupportedRuleError ? 'UnsupportedRuleError'
      : e instanceof JsSandboxError ? 'JsSandboxError'
        : 'RuleEvalError' // RuleEvalError 与其他异常统一按求值错呈现
  return {
    segmentIndex: loc.segmentIndex,
    segmentRaw: loc.segmentRaw,
    segmentKind: seg.kind,
    hits: e instanceof RuleEvalError ? e.hits : null,
    preview: '',
    error: { code, message: isEngineError(e) ? e.message : String((e as Error)?.message ?? e) },
  }
}
