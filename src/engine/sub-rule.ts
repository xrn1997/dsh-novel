import { parseRule } from './parse.js'
import { hasExplicitValueHead, hasListEntryMarker, parseTails } from './grammar.js'
import { isValueTerminal } from './select.js'
import type { Facet, RuleUsage, Segment } from './types.js'

/** 子规则求值的用途判据（getString* / 模板规则插值 / @put 的值共用）：
 *  只有**每条非空分支都以显式取值段收尾**时才用 value——取值段决定链尾未知词按属性名，
 *  而纯选择分支必须留在 list，否则 finalize 会把节点串成 outerHTML（`java.getString("div.item")`
 *  读的是元素内容）。js / getvar / 字面段 / 行模板本身产出值，按 value 收尾。
 *  链首 `+` / `@` 两判归 `grammar.ts` 的 `hasListEntryMarker` / `hasExplicitValueHead`——
 *  判据与 parseRule ③/③b 的剥除都先经 `parseTails(rule).chain`（它会 trim），读的是同一条链。
 *  代价如实：判据要先把规则解析一遍（按 value），调用方再按定出的用途解析一次，纯词法两次、零 IO；
 *  engine 层不持内部状态，所以不做跨调用缓存，也不把 AST 递出去（递出去等于把解析形状交给两处）。 */
export function usageOfSubRule(rule: string, facet: Facet): RuleUsage {
  // 先取与 parseRule 同一条链（parseTails 会 trim）：拿原始串判链首会把 " @text" 与 "@text"
  // 分成两档，而主链对两者一视同仁。
  const chain = parseTails(rule).chain
  // `+` 是列表入口的标记；value 解析不剥它，按 value 求值会把整条规则读错。
  if (hasListEntryMarker(chain)) return 'list'
  let parsed
  try {
    parsed = parseRule(chain, facet, 'value')
  } catch {
    return 'list'   // 解析错误由真正的求值入口带段级定位抛出，这里不重复判死
  }
  const explicitPrefix = parsed.branches.length === 1 && hasExplicitValueHead(chain)
  let saw = false
  for (const branch of parsed.branches) {
    if (branch.segments.length === 0) continue
    saw = true
    if (!endsInExplicitValue(branch.segments[branch.segments.length - 1]!, branch.raws.length, explicitPrefix)) {
      return 'list'
    }
  }
  return saw ? 'value' : 'list'
}

/** 取值尾必须是**显式**的：default 取值段只有在分支确实被 `@` 切成多段，
 *  或整条单分支规则以显式 `@` 开头时才用 value；单段裸词（`b`）只是选择器的另一种读法。 */
function endsInExplicitValue(seg: Segment, rawCount: number, explicitPrefix: boolean): boolean {
  if (seg.kind === 'js' || seg.kind === 'getvar' || seg.kind === 'literal' || seg.kind === 'regexRow') return true
  return seg.kind === 'default' && (rawCount > 1 || explicitPrefix) && isValueTerminal(seg)
}
