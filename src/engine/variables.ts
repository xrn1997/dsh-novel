import type { EngineValue, EvalContext, Facet, SegmentLoc } from './types.js'
import { UnsupportedRuleError } from './errors.js'
import { evalJsonPath } from './jsonpath.js'
import { engineValueToString } from './js-utils.js'

/**
 * JSONPath 求值数据解析（evaluate 的 Runtime 与 @put 共用）：ctx.json 优先；缺席且 html 是合法
 * JSON 时回退解析 html（legado `isJSON = content.toString().isJson()` → `JsonPath.parse(content)` 口径——
 * 搜索链路只传 html 不传 json，不回退的话所有 $. 规则对 JSON API 源恒 Miss）。
 * 住址从 evaluate 迁来：evaluate 值 import 本模块、本模块又值 import evaluate 形成唯一运行时环
 * ——本函数只依赖 EvalContext，搬来即打破环。
 */
export function resolveJsonData(ctx: EvalContext): unknown {
  if (ctx.json !== undefined) return ctx.json
  const text = ctx.html?.trim() ?? ''
  // 合法 JSON 才回退解析（对象/数组都算）；非 JSON 保持 undefined → JSONPath Miss（如实）
  if (text.startsWith('{') || text.startsWith('[')) {
    try { return JSON.parse(text) } catch { /* 非法 JSON → undefined */ }
  }
  return undefined
}

/**
 * `@put:` / `@get:` 变量（照 legado 文档口径）。
 *
 * `ctx.vars` 由调用方持有、跨规则共享（引擎零内部状态）。
 *
 * `@put:{k1:"v1", k2:"ruleOrJsonPath"}` 值语义（钉死，legado `putRule` = `put(key, getString(value))`）：
 *   - 规则形态的值 → **按子规则求值**（`subEval` 由 evaluate 的链上下文接线，基内容 = 当前链值，
 *     未起链则整页原文）：Value → 存文本、List → `\n` 拼接存（legado getString 从不返列表）、
 *     Miss → 不落盘（@get 自然 Miss，Miss≠空串）；
 *   - 以 `$.` 或 `@json:` 开头 → JSONPath（`$.` 前缀天然覆盖 `$..`；`@json:` 剥前缀后即路径），
 *     与子规则同一条 getString 出口；
 *   - 其余（`123`、`凡人修仙传,全本`、`pic`）不构成规则形态 → 字面存；**裸值**先按 legado
 *     LinkedTreeMap 口径对当前 JSON 条目做键访问（引号是显式字面量记号，不参与这层推断）。
 *   - js 形态的值（`<js>`/`@js:`）在同步子环路里求值不了 → 如实抛「子规则内不支持 js 段」，
 *     不静默取空；调用方未接线 subEval（直测/桥缺位）→ 抛错点名，不降级成字面存。
 *
 * pairs 解析（手写小 parser，不用 JSON.parse——legado 的值不保证是严格 JSON）：
 *   `{` 开头 `}` 结尾；顶层逗号切分（引号内逗号不切）；每项 `key:"value"` 或 `key:裸值`。
 *   引号有意义：带引号 = 显式字面量；裸值 = 先当 JSONPath（`$.`/`@json:`），否则按 legado
 *   口径对当前条目做**键访问**，键不在才字面存。（「值必须带双引号，否则抛错」是 v1 旧口径，
 *   实测 2 源直接炸，已废——但引号与裸值的这条分界必须保住，见 `evalPut` 的键访问分支。）
 *
 * `@get:name` → 读 `ctx.vars[name]`；未 put 过 / vars 未初始化 → Miss（detail 提到键名）。
 */

function reject(detail: string, pairsRaw: string, loc: SegmentLoc, facet: Facet): never {
  throw new UnsupportedRuleError(detail, { ...loc, facet })
}

/** 手写 pairs 解析：顶层逗号切分（引号内不切），每项 key:"value" 或 key:裸值
 *  （legado 真实源 `@put:{cid:ComicID}`、`@put:{img:pic}` 无引号形态——v1 曾要求必带引号，
 *  实测 2 源直接抛错；现两种形态都收：引号值处理转义，裸值读到顶层逗号为止） */
function parsePairs(pairsRaw: string, loc: SegmentLoc, facet: Facet): Array<[string, string, boolean]> {
  const s = pairsRaw.trim()
  if (!s.startsWith('{') || !s.endsWith('}')) {
    reject('@put 形态必须为 {key:"value", …}（{ 开头 } 结尾）', pairsRaw, loc, facet)
  }
  const inner = s.slice(1, -1)
  const pairs: Array<[string, string, boolean]> = []
  const n = inner.length
  let i = 0
  const skipWs = (): void => { while (i < n && /\s/.test(inner[i])) i++ }

  while (true) {
    skipWs()
    if (i >= n) break
    // key：读到冒号为止
    const kStart = i
    while (i < n && inner[i] !== ':' && inner[i] !== ',') i++
    const key = inner.slice(kStart, i).trim()
    if (key === '') reject('@put 键名为空', pairsRaw, loc, facet)
    if (i >= n || inner[i] !== ':') reject(`@put 键值对缺少冒号：${JSON.stringify(key)}`, pairsRaw, loc, facet)
    i++ // 吃掉 ':'
    skipWs()
    let value = ''
    let quoted = false                              // 值是否带双引号：显式字面量的唯一记号
    if (inner[i] === '"') {
      quoted = true
      i++ // 吃掉开引号
      let closed = false
      while (i < n) {
        const c = inner[i]
        if (c === '\\' && i + 1 < n) { value += inner[i + 1]; i += 2; continue } // \" 转义
        if (c === '"') { closed = true; i++; break }
        value += c
        i++
      }
      if (!closed) reject('@put 值引号未闭合', pairsRaw, loc, facet)
    } else {
      // 裸值：读到顶层逗号为止（key:value 形态——legado LinkedTreeMap 键访问/字面串）
      const vStart = i
      while (i < n && inner[i] !== ',') i++
      value = inner.slice(vStart, i).trim()
    }
    pairs.push([key, value, quoted])
    skipWs()
    if (i >= n) break
    if (inner[i] !== ',') reject(`@put 顶层逗号分隔处出现意外字符：${JSON.stringify(inner[i])}`, pairsRaw, loc, facet)
    i++ // 吃掉逗号；尾逗号由循环顶的 skipWs + break 收编
  }
  return pairs
}

/** 值是否构成规则形态（决定「按子规则求值」还是「字面存」）。判据刻意从宽在「含段界 @ / 组合符 /
 *  规则起始符」这三类记号上——它们不出现在真实源的普通字面值里；反过来 `123`、`凡人修仙传,全本`
 *  这类字面值不能被误打成规则（legado 对它们取不到东西，本仓按字面存是超集且如实）。 */
function isRuleFormValue(v: string): boolean {
  return /[@|]|\|\||&&|%%/.test(v) || /^[@/[<.#]/.test(v)
}

/**
 * `@put:` 段求值：解析 pairs 并写入 `ctx.vars`（未初始化则自动建）。
 * subEval = 子规则求值口（evaluate 接线，基内容 = 当前链值）；缺席时规则形态的值如实抛错。
 * 返回值：原样回显 pairsRaw（Value）——**仅供直测读取**；规则链里 @put 是副作用段，
 * evaluate 丢弃其返回并以透传的上游值为链值（legado 口径），故生产路径不消费该返回值。
 */
export function evalPut(
  pairsRaw: string, ctx: EvalContext, loc: SegmentLoc, facet: Facet,
  subEval?: (rule: string) => EngineValue,
): EngineValue {
  const pairs = parsePairs(pairsRaw, loc, facet)
  // 先全部求值进 staged，全成功才落盘 ctx.vars——中途抛错不留下半截写入
  const staged: Record<string, string> = {}
  /** getString 出口（legado put(key, getString(value))）：Value → 存文本、List → `\n` 拼接、
   *  Miss → 不落盘（@get 时自然 Miss；Miss≠空串） */
  const putString = (key: string, res: EngineValue): void => {
    if (res.kind === 'miss') return
    staged[key] = res.kind === 'list' ? res.items.join('\n') : engineValueToString(res, 'inner')
  }
  /** JSONPath 值：数据源与 JSONPath 段同口径（ctx.json 缺席时回退解析 ctx.html，legado isJSON 口径） */
  const putJsonPath = (key: string, path: string): void => {
    putString(key, evalJsonPath(path, resolveJsonData(ctx), loc, facet))
  }
  for (const [key, value, quoted] of pairs) {
    if (value.startsWith('$.')) {
      // JSONPath 规则（钉死 `$.` 起——`$..` 递归下降被 `$.` 前缀天然覆盖；裸 `$`、`$99` 等
      // 不以 `$.` 开头的值不构成 JSONPath 规则，落入下方判定）
      putJsonPath(key, value)
    } else if (value.startsWith('@json:')) {
      // @json: 前缀 = 数据源声明；剥掉后余下即对 ctx.json 的 JSONPath（与 parse.ts 的 json: 段口径一致）
      putJsonPath(key, value.slice('@json:'.length))
    } else if (isRuleFormValue(value)) {
      // 规则形态的值（`[property$=x]@content`、`//xpath`、`@css:`、`i@text`…）→ 按子规则求值。
      // legado 的 putRule 就是 getString；真实源 ruleBookInfo.init 的六键形态全靠这条
      // （2026-09 真机审计：曾被段切分撕开 + 被 v1 白名单拒掉）。
      if (!subEval) {
        reject(`@put 值是规则串但调用方未接线子规则求值口（evaluate 的 subEval）：${JSON.stringify(value)}`, pairsRaw, loc, facet)
      }
      putString(key, subEval(value))
    } else {
      // legado 口径（AnalyzeRule.getString 的 LinkedTreeMap 分支「键值直接访问」）：
      // **裸值** = 对当前 JSON 条目按键取值（`@put:{img:pic}` → vars.img = 条目.pic）；
      // 键不存在 / 非 JSON 上下文 → 字面存（比空串如实——@get 拿到原文可诊断）。
      // 带双引号的值是用户显式写的字面量，**不做这层推断**（`@put:{img:"pic"}` 存 'pic'）：
      // 引号是「我要字面量」的唯一记号，把它当裸值会让同一份数据两种结果互相覆盖（2026-09 审查）。
      const data = quoted ? null : resolveJsonData(ctx)
      if (value !== '' && data !== null && typeof data === 'object' && !Array.isArray(data)
        && Object.prototype.hasOwnProperty.call(data, value)) {
        const hit = (data as Record<string, unknown>)[value]
        if (typeof hit === 'string' || typeof hit === 'number' || typeof hit === 'boolean') {
          staged[key] = String(hit)
          continue
        }
      }
      staged[key] = value
    }
  }
  Object.assign(ctx.vars ??= {}, staged)
  return { kind: 'value', text: pairsRaw }
}

/**
 * 变量**读链**（对面 `AnalyzeRule.get`）：本次调用的 `vars`（ruleData/chapter 层）→ source 层，
 * 每级「空串则继续下找」（对面 `.takeIf { it.isNotEmpty() }`）。全空 → undefined，
 * 由调用方决定是 Miss 还是 ""（对面 get 返 ""，而 `@get:` 段保自有 Miss 口径）。
 * 自有键判定不能省：`ctx.vars?.[name]` 顺原型链会把 `Object.prototype.toString` 当变量值返回
 * （声明是 string 实为函数，一路带进正文），且永远算不上「未 put 过」。
 */
/**
 * 对面 `AnalyzeRule.get` 的完整口径：**先两个内建伪变量**（`bookName`→book.name、
 * `title`→chapter.title，且只在对应宿主存在时生效），再走四级读链。
 * 宿主缺席时不猜：`java.get("bookName")` 在搜索面（无 book）落回读链，与对面 `book?.let{}` 同形。
 */
export function getRuleVar(ctx: EvalContext, name: string): string | undefined {
  if (name === "bookName" && ctx.book !== undefined) return String(ctx.book.name ?? "")
  if (name === "title" && ctx.chapter !== undefined) return String(ctx.chapter.title ?? "")
  return getScopedVar(ctx, name)
}

export function getScopedVar(ctx: EvalContext, name: string): string | undefined {
  const vars = ctx.vars
  if (vars !== undefined && Object.hasOwn(vars, name) && vars[name] !== '') return vars[name]
  const fromSource = ctx.sourceVar?.(name)
  if (fromSource !== undefined && fromSource !== '') return fromSource
  return undefined
}

/** `@get:` 段求值：走读链；两层都没有该键（或都为空串）→ Miss（detail 提到键名） */
export function evalGetVar(name: string, ctx: EvalContext): EngineValue {
  const hit = getScopedVar(ctx, name)
  if (hit === undefined) return { kind: 'miss', detail: `变量未定义：${name}` }
  return { kind: 'value', text: hit }
}
