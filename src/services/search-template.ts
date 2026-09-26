import { RuleEvalError } from '../engine/index.js'
import { isPlaceholderExpr } from '../engine/index.js'
import { runScript } from '../engine/js-sandbox.js'
import { engineContextOf } from './bridge.js'
import type { Fetcher } from './fetcher.js'
import type { NovelSource } from './types.js'

/**
 * searchUrl 的 JS 形态解析（真实源 61/642：`@js:` / `<js>` 开头，沙箱求值出 URL 模板）。
 * 从 request.ts 迁出：request.ts 现在只持有「模板 → 请求计划」的纯组装语义，
 * 本模块持有「模板怎么来的」（沙箱求值），依赖方向 request ← engine-fetch ← 本模块，无环。
 * JS 形态与纯变量词法判定归 engine/grammar（与 interpolateUrl 共用同一份 || 拆分）。
 */

/** URL 模板（含 POST body）内 `{{...}}` 全部按 JS 求值——
 *  `{{java.encodeURI(key)}}`、`{{page*2}}`、`{{java.base64Encode("/s?k="+key)}}` 等形态
 *  （此前只做纯变量替换，JS 表达式被原样拼进 URL 必炸）。**只有真正的变量占位不动**：
 *  占位判定是「标识符 **且** 在 vars 里或带 `||` 兜底」（`template.isPlaceholderExpr`）——
 *  jsLib 定义的全局（`{{host}}`）也走 JS 求值（每段 `{{…}}` 无例外地过沙箱）。 */
export async function preEvaluateUrlJs(
  source: NovelSource, template: string, key: string, page: number, fetcher: Fetcher, jsTimeoutMs?: number,
): Promise<string> {
  if (!template.includes('{{') || !template.includes('}}')) return template
  const vars = { key, page }
  const re = /\{\{([^{}]*)\}\}/g
  // parts：字符串片段与待求值表达式交错存放（字符串直通、表达式异步求值后回填）
  const parts: Array<{ kind: 'text'; text: string } | { kind: 'js'; expr: string }> = []
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(template)) !== null) {
    if (m.index > last) parts.push({ kind: 'text', text: template.slice(last, m.index) })
    if (isPlaceholderExpr(m[1], vars)) {
      // 纯变量占位原样保留，交给后续 interpolateUrl（保持既有编码口径）
      parts.push({ kind: 'text', text: m[0] })
    } else {
      parts.push({ kind: 'js', expr: m[1] })
    }
    last = m.index + m[0].length
  }
  if (last < template.length) parts.push({ kind: 'text', text: template.slice(last) })
  if (!parts.some((p) => p.kind === 'js')) return template
  let out = ''
  for (const part of parts) {
    if (part.kind === 'text') { out += part.text; continue }
    const outcome = await runScript(scriptOf(source, part.expr, key, page, fetcher, `{{${part.expr}}}`.slice(0, 200), jsTimeoutMs))
    const v = outcome.value
    out += v.kind === 'value' ? v.text : v.kind === 'list' ? v.items.join('\n') : ''
  }
  return out
}

/** searchUrl 统一解析入口：URL 模板里的 js 块先求值，再预求值 {{...}} JS 表达式
 *  （两步都可能产出 `url,{json}` 选项串——交由 assembleRequest 的 parseUrlOption 统一收口）。 */
export async function resolveSearchTemplate(
  source: NovelSource, template: string, key: string, page: number, fetcher: Fetcher, jsTimeoutMs?: number,
): Promise<string> {
  const base = await resolveJsSearchTemplate(source, template, key, page, fetcher, jsTimeoutMs)
  return preEvaluateUrlJs(source, base, key, page, fetcher, jsTimeoutMs)
}

/** URL 模板里的 js 块形态：`<js>…</js>` 闭区间可出现在**任意位置**，`@js:` 吃到**串尾**
 *  ——两者都按 findAll 定位（不是「整串是 js」的前缀判定）。 */
const URL_JS_BLOCK_RE = /<js>([\s\S]*?)<\/js>|@js:([\s\S]*)/gi

/** js 块求值的累积器：块可在任意位置；块间的字面文本参与拼接——文本里**没有** `@result` 占位时
 *  它整体**取代**累积值（啦啦小说网 `<js>清 cookie</js>/search/?…` 正靠这条：块只做副作用，
 *  URL 是尾巴那截字面文本），有 `@result` 时把当前累积值插进去；每个块拿到的 `result` 全局
 *  就是当时的累积值。
 *
 *  为什么是这个口径（而不是「前缀形态」那条旧口径）：
 *  ① 内嵌形态整串进沙箱 → 真机报 `Unexpected token '<'`（啦啦小说网）；
 *  ② 尾部 `@js:` 形态连 `,{…}` 选项一起当 URL 发 → 选项被静默丢掉 + 0 命中（全本同人小说网）。
 *  顺序也有讲究：js 块先于 `{{...}}` 预求值（块求值在前、表达式求值在后），
 *  故 js 代码里的 `{{…}}` 不预先插值，而是留在 js **产物**上再被 preEvaluateUrlJs 处理。 */
export async function resolveJsSearchTemplate(
  source: NovelSource, template: string, key: string, page: number, fetcher: Fetcher, jsTimeoutMs?: number,
): Promise<string> {
  const blocks = [...template.matchAll(URL_JS_BLOCK_RE)]
  if (blocks.length === 0) return template
  let start = 0
  let result = template
  for (const m of blocks) {
    const at = m.index ?? 0
    if (at > start) {
      const text = template.slice(start, at).trim()
      if (text !== '') result = text.replace(/@result/g, result)
    }
    const code = nonEmpty(m[2]) ?? nonEmpty(m[1]) ?? ''
    const outcome = await runScript(scriptOf(source, code, key, page, fetcher, m[0].slice(0, 200), jsTimeoutMs, result))
    const v = outcome.value
    result = v.kind === 'value' ? v.text : v.kind === 'list' ? v.items.join('\n') : ''
    start = at + m[0].length
  }
  if (template.length > start) {
    const text = template.slice(start).trim()
    if (text !== '') result = text.replace(/@result/g, result)
  }
  if (result.trim() === '') {
    throw new RuleEvalError('searchUrl @js 求值结果为空（脚本未产出 URL）', {
      facet: 'search', segmentIndex: -1, segmentRaw: template.slice(0, 200), hits: 0,
    })
  }
  return result.trim()
}

/** 空串与 undefined 同义（`groupValues[2].ifEmpty { groupValues[1] }` 的「未匹配则退到前一分支」） */
function nonEmpty(v: string | undefined): string | undefined {
  return v === undefined || v === '' ? undefined : v
}

// ── runScript 入参构造的单点（此前两处各写一遍近逐字的 host/ctx 双拼——已收口）────────

function scriptOf(
  source: NovelSource, code: string, key: string, page: number, fetcher: Fetcher, segmentRaw: string,
  jsTimeoutMs?: number, result = '',
): Parameters<typeof runScript>[0] {
  return {
    // 重叠字段（baseUrl/source/vars/fetch/jsLib/jsTimeoutMs）走 engineContextOf 单点——
    // runScript 面独有的字段（code/key/page/header/result/loc/facet/scriptForm）在此补齐
    ...engineContextOf(fetcher, source, {
      baseUrl: source.baseUrl, vars: { key, page: String(page) },
      ...(jsTimeoutMs === undefined ? {} : { jsTimeoutMs }),
    }),
    code,
    key,
    page,
    // `result` 是 URL js 块的累积值（逐块传入）——`{{…}}` 预求值路径用不着（给空串）
    result,
    header: JSON.stringify(source.rules.header ?? {}),
    loc: { segmentIndex: -1, segmentRaw },
    facet: 'search',
    scriptForm: true,
  }
}
