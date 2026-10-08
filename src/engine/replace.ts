import type { EngineValue, Facet, ReplaceStep } from './types.js'
import { RuleEvalError } from './errors.js'

/**
 * `##` 替换求值（净化 + OnlyOne，语义钉死）：
 * - 净化（循环替换）：对 `Value.text` 与 `List.items` 逐项、按 `replaces` 顺序依次应用；
 * - `OnlyOne`（`###`）：**先取首个匹配、再在该匹配内替换**，
 *   无匹配 → 空串；非 OnlyOne：全局替换（补 `g`）。替换串 `$1` 等用 JS 原生语义
 *   （OnlyOne 下捕获组在截出的那段内解析）；
 * - 非法正则 → `RuleEvalError`（hits=0，段定位指向该替换步，消息含坏 pattern）；
 * - `replaces` 为空 → 原值透传；`miss` / `matches` → 原样透传（不做替换）；
 * - **空 pattern（含插值后为空）整步跳过**——对面每一处替换都门在「正则非空」上；
 * - 替换结果变空串的项**保留**（净化不删条目，「取到空」口径不适用在替换层）；
 * - `nodes` 在此层透传原样（求值链应先取值再替换）；
 * - **插值**：pattern / replacement 里的 `{{点路径}}`
 *   （如 `{{chapter.title}}`、`{{book.name}}`）先按 bindings 查表替换再编译正则——
 *   真实源 `##…|{{chapter.title}}|…##` 去章标题行全靠它；查不到的保持原文字面（不猜）。
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
  const compiled: { re: RegExp; replacement: string }[] = []
  for (let i = 0; i < replaces.length; i++) {
    const step = replaces[i]
    const flags = onlyOne
      ? step.flags.replace('g', '')
      : step.flags + (step.flags.includes('g') ? '' : 'g')
    const pattern = interpolate(step.pattern, interp)
    // 空正则整步跳过：对面每一处替换都门在「正则非空」上。JS 的空正则配 `g`
    // 在每个字符位都匹配，无条件执行会让 replacement 被插进每一个字符之间——真库
    // `class.font_max@html####本章未完.*##` 这类「第 2 段为空、第 3 段才是正则」的写法
    // 因此把 6.5KB 的一页灌成 732,311 字符并写进缓存。读数在矩阵行 `a-replace-tail`；
    // 「只有一对 `##` + 第 4 段开关」是另一条分叉，仍待裁（`a-replace-tail-single-pair`）。
    if (pattern === '') continue
    const replacement = interpolate(step.replacement, interp)
    try {
      compiled.push({ re: new RegExp(pattern, flags), replacement })
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
    for (const { re, replacement } of compiled) {
      if (onlyOne) {
        // OnlyOne 口径：拿到首个匹配后，替换**作用在那一段上**，产物即那一段——
        // 不是「原文里只改第一处」；无匹配给空串。re 已剥 g（非全局），
        // exec 与段内 replace 都停在首个匹配，捕获组引用因此在匹配内解析。
        const m = re.exec(out)
        out = m === null ? '' : m[0].replace(re, replacement)
      } else {
        out = out.replace(re, replacement)
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
 *  只认自有键：`interp[path]` 顺原型链会让 `{{toString}}` 回报函数源码
 *  （钉子 `tests/engine/replace.test.ts` 的 `describe('interp 查表只认自有键…')`）。 */
function interpolate(s: string, interp?: Record<string, string>): string {
  if (interp === undefined || !s.includes('{{')) return s
  return s.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (m, path: string) =>
    (Object.hasOwn(interp, path) ? interp[path] : m))
}
