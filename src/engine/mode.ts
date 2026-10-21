import type { EvalContext } from './types.js'

/**
 * 整条规则是否按 JSONPath 取值（对照 legado AnalyzeRule 的 isJSON 分派）：
 * 显式段前缀各有自己的取值器，**整条规则模式不接管**——接管会把 `@json:$.a` 的前缀原样交给
 * JSONPath tokenizer（`@` 被拒）或在 `json:$.a` 前补出 `$.json:$.a`（冒号被拒）。
 * 模板、链段与 URL 不是一条整段 JSONPath；`$.` / `$[` 起头时走 JSONPath；
 * 其余由内容决定（ctx.json 在场，或 html 本身是 JSON）。
 * 只回答「整条规则走不走 JSONPath」，段内语法归 parse.classifySegment。
 */
export function isJsonRule(raw: string, ctx: EvalContext): boolean {
  const rule = raw.trim()
  if (rule === '') return false
  // 显式前缀（@ 可有可无）由 parse.classifySegment 解释；`@webjs:`/`@@`/`<js>` 同理
  if (/^(?:@?(?:json|js|css|xpath|put|get):|@@|<js>|@webjs:)/i.test(rule)) return false
  if (rule.includes('{{') || rule.includes('{$.') || rule.includes('@') || /<js>/i.test(rule)) return false
  // URL 模板/相对地址（`/books?bookId={$.id}`、`https://…`）不是整条 JSONPath
  if (rule.startsWith('/') || rule.includes('://')) return false
  if (rule.startsWith('$.') || rule.startsWith('$[')) return true
  return isJsonContent(ctx)
}

function isJsonContent(ctx: EvalContext): boolean {
  if (ctx.json !== undefined) return true
  const text = ctx.html?.trimStart() ?? ''
  return text.startsWith('{') || text.startsWith('[')
}
