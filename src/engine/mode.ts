import type { EvalContext } from './types.js'

/**
 * 整条规则是否按 JSONPath 取值：显式段前缀各有自己的取值器，**整条规则模式不接管**——接管会把
 * `@json:$.a` 的前缀原样交给 tokenizer（`@` 被拒）或在 `json:$.a` 前补出 `$.json:$.a`。模板、链段与 URL
 * 不是一条整段 JSONPath；`$.` / `$[` 起头走 JSONPath，其余由内容决定。只回答「整条规则走不走
 * JSONPath」，段内语法归 parse.classifySegment。
 */
export function isJsonRule(raw: string, ctx: EvalContext): boolean {
  const rule = raw.trim()
  if (rule === '') return false
  if (/^(?:@?(?:json|js|css|xpath|put|get):|@@|<js>|@webjs:)/i.test(rule)) return false
  if (rule.includes('{{') || rule.includes('{$.') || rule.includes('@') || /<js>/i.test(rule)) return false
  if (rule.startsWith('/') || rule.includes('://')) return false
  if (rule.startsWith('$.') || rule.startsWith('$[')) return true
  return isJsonContent(ctx)
}

function isJsonContent(ctx: EvalContext): boolean {
  if (ctx.json !== undefined) return true
  const text = ctx.html?.trimStart() ?? ''
  return text.startsWith('{') || text.startsWith('[')
}
