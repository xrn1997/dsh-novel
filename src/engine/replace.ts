import type { EngineValue, Facet, ReplaceStep } from './types.js'
import { RegexDeadlineError, RuleEvalError } from './errors.js'
import { guardedOnlyOneReplace, guardedReplace } from './regex-guard.js'

/**
 * `##` 替换求值（净化 + OnlyOne，语义钉死）：净化对 `Value.text` 与 `List.items` 逐项、按 `replaces`
 * 顺序依次应用。`OnlyOne`（`###`）**先取首个匹配、再在该匹配内替换**，无匹配 → 空串；非 OnlyOne 全局
 * 替换（补 `g`），替换串 `$1` 等用 JS 原生语义。非法正则 → `RuleEvalError`（hits=0，段定位指向该替换步）；
 * `replaces` 为空 → 原值透传；`miss` / `matches` / `nodes` → 原样透传（求值链应先取值再替换）。
 * **空 pattern（含插值后为空）整步跳过**；替换结果变空串的项**保留**（净化不删条目）。
 * **插值**：pattern / replacement 里的 `{{点路径}}` 先按 bindings 查表替换再编译正则——去章标题行依赖
 * 这条（`##…|{{chapter.title}}|…##`）；查不到的保持原文字面（不猜）。
 */
export function applyReplaces(
  v: EngineValue,
  replaces: ReplaceStep[],
  onlyOne: boolean,
  loc?: { facet?: Facet },
  interp?: Record<string, string>,
): EngineValue {
  if (v.kind === 'miss' || v.kind === 'matches') return v
  if (replaces.length === 0) return v
  if (v.kind === 'nodes') return v

  // 预编译全部正则：任一步非法立即抛错（段定位指向该步），不半途替换
  const compiled: { re: RegExp; replacement: string; index: number; raw: string }[] = []
  for (let i = 0; i < replaces.length; i++) {
    const step = replaces[i]
    if (step === undefined) continue
    const flags = onlyOne
      ? step.flags.replace('g', '')
      : step.flags + (step.flags.includes('g') ? '' : 'g')
    const pattern = interpolate(step.pattern, interp)
    // 空正则整步跳过（钉子见 tests/engine/replace.test.ts）：JS 的空正则配 `g` 在每个字符位都匹配，
// 无条件执行会把 replacement 插进每个字符之间，`class.font@html####本章未完.*##` 这类「第 2 段为空、
// 第 3 段才是正则」的写法会把整页灌成插串的超长文本并写进缓存（读数在矩阵行 `a-replace-tail`）。
    if (pattern === '') continue
    const replacement = interpolate(step.replacement, interp)
    try {
      compiled.push({ re: new RegExp(pattern, flags), replacement, index: i, raw: `${step.pattern}##${step.replacement}` })
    } catch {
      throw new RuleEvalError(`## 替换正则非法: ${pattern}`, {
        facet: loc?.facet ?? 'rule',
        segmentIndex: i,
        segmentRaw: `${step.pattern}##${step.replacement}`,
        hits: 0,
      })
    }
  }

  const runOne = (text: string): string => {
    let out = text
    for (const { re, replacement, index, raw } of compiled) {
      try {
        // 执行走死线守卫：合法但病态的正则只许把这一条替换判死，不许把主线程钉住（见 regex-guard）
        out = onlyOne ? guardedOnlyOneReplace(re, out, replacement) : guardedReplace(re, out, replacement)
      } catch (e) {
        if (!(e instanceof RegexDeadlineError)) throw e
        throw new RuleEvalError(`## 替换正则求值超时（疑似灾难性回溯）: ${re.source}`, {
          facet: loc?.facet ?? 'rule', segmentIndex: index, segmentRaw: raw, hits: 0,
        })
      }
    }
    return out
  }

  switch (v.kind) {
    case 'value': return { kind: 'value', text: runOne(v.text) }
    case 'list': return { kind: 'list', items: v.items.map(runOne) }
    default: return v
  }
}

/** `{{点路径}}` 查表插值；bindings 缺席或**自有键**查不到 → 原文保留（不猜、不炸）。
 *  只认自有键：`interp[path]` 顺原型链会让 `{{toString}}` 回报函数源码（钉子用例）。 */
function interpolate(s: string, interp?: Record<string, string>): string {
  if (interp === undefined || !s.includes('{{')) return s
  return s.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (m, path: string) => {
    const hit = Object.hasOwn(interp, path) ? interp[path] : undefined
    return hit ?? m
  })
}
