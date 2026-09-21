import { RuleEvalError } from '../engine/index.js'
import { isJsForm, isPureVarExpr } from '../engine/grammar.js'
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

/** searchUrl 是否 JS 形态（兼容别名——判定实现归 grammar.isJsForm） */
export const isJsSearchUrl = isJsForm

/** legado replaceKeyPageJs 口径：URL 模板（含 POST body）内 `{{...}}` 全部按 JS 求值——
 *  `{{java.encodeURI(key)}}`、`{{page*2}}`、`{{java.base64Encode("/s?k="+key)}}` 等形态
 *  （此前只做纯变量替换，JS 表达式被原样拼进 URL 必炸）。纯变量形态不动。 */
export async function preEvaluateUrlJs(
  source: NovelSource, template: string, key: string, page: number, fetcher: Fetcher, jsTimeoutMs?: number,
): Promise<string> {
  if (!template.includes('{{') || !template.includes('}}')) return template
  const re = /\{\{([^{}]*)\}\}/g
  // parts：字符串片段与待求值表达式交错存放（字符串直通、表达式异步求值后回填）
  const parts: Array<{ kind: 'text'; text: string } | { kind: 'js'; expr: string }> = []
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(template)) !== null) {
    if (m.index > last) parts.push({ kind: 'text', text: template.slice(last, m.index) })
    if (isPureVarExpr(m[1])) {
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

/** searchUrl 统一解析入口：JS 形态先沙箱求值出模板，再预求值 {{...}} JS 表达式
 *  （两步都可能产出 `url,{json}` 选项串——交由 assembleRequest 的 parseUrlOption 统一收口）。 */
export async function resolveSearchTemplate(
  source: NovelSource, template: string, key: string, page: number, fetcher: Fetcher, jsTimeoutMs?: number,
): Promise<string> {
  const base = isJsSearchUrl(template)
    ? await resolveJsSearchTemplate(source, template, key, page, fetcher, jsTimeoutMs)
    : template
  return preEvaluateUrlJs(source, base, key, page, fetcher, jsTimeoutMs)
}

/** JS 形态 searchUrl → URL 模板串：沙箱脚本求值（legado 口径：完成值即结果，key/page 为全局变量），
 *  产出的模板再走 assembleRequest（可能自带 `url,{json}` 选项——parseUrlOption 统一收口）。
 *  求值失败（JsSandboxError/FetchError 等）如实上抛——宁炸不猜，不拿假 URL 发请求。 */
export async function resolveJsSearchTemplate(
  source: NovelSource, template: string, key: string, page: number, fetcher: Fetcher, jsTimeoutMs?: number,
): Promise<string> {
  const trimmed = template.trim()
  const code = trimmed.startsWith('<js>')
    ? trimmed.replace(/^<js>/i, '').replace(/<\/js>$/i, '')
    : trimmed.replace(/^@?\s*js:/i, '')
  const outcome = await runScript(scriptOf(source, code, key, page, fetcher, trimmed.slice(0, 200), jsTimeoutMs))
  const v = outcome.value
  const out = v.kind === 'value' ? v.text : v.kind === 'list' ? v.items.join('\n') : ''
  if (out.trim() === '') {
    throw new RuleEvalError('searchUrl @js 求值结果为空（脚本未产出 URL）', {
      facet: 'search', segmentIndex: -1, segmentRaw: trimmed.slice(0, 200), hits: 0,
    })
  }
  return out.trim()
}

// ── runScript 入参构造的单点（此前两处各写一遍近逐字的 host/ctx 双拼——已收口）────────

function scriptOf(
  source: NovelSource, code: string, key: string, page: number, fetcher: Fetcher, segmentRaw: string, jsTimeoutMs?: number,
): Parameters<typeof runScript>[0] {
  return {
    // 重叠字段（baseUrl/source/vars/fetch/jsLib/jsTimeoutMs）走 engineContextOf 单点——
    // runScript 面独有的字段（code/key/page/header/loc/facet/scriptForm）在此补齐
    ...engineContextOf(fetcher, source, {
      baseUrl: source.baseUrl, vars: { key, page: String(page) },
      ...(jsTimeoutMs === undefined ? {} : { jsTimeoutMs }),
    }),
    code,
    key,
    page,
    header: JSON.stringify(source.rules.header ?? {}),
    loc: { segmentIndex: -1, segmentRaw },
    facet: 'search',
    scriptForm: true,
  }
}
