import type { EngineValue, Facet, Segment, SegmentLoc } from './types.js'
import { RuleEvalError } from './errors.js'
import { guardedMatchAll, RegexDeadlineError } from './regex-guard.js'

/**
 * AllInOne 整页正则（口径：二维不压平）。
 *
 * 语义钉死：
 * - 对整页文本全局扫描（自动补 `g`；已有 `g` 不重复加）。
 * - 每个匹配 → 一行 `rows`，行内是 **group 0（整段）+ 捕获组 1..n**；
 *   无捕获组 → 单元素行 `[fullMatch]`（整段即全部）；未参与的 `(x)?` 组落 `''`。
 * - 产物 `rows: string[][]` 永不压平——字段映射按组号由调用方做
 *   （`service`/工具层的条目取值走 `bridge.rowParts`：条目 = 组 1..n，
 *   group 0 只供字段规则的 `$n` 绑定用，见 `regex-row.ts`）。
 * - 零匹配 → `List{items:[]}`（AllInOne 整页扫不到的合法零条目，
 *   区别于段级 Miss）。
 * - 非法正则 → RuleEvalError（hits=0，段级定位，消息含坏 pattern）。
 * - `-` 反序前缀由 parse/evaluate 层处理，首 `:` 已由 parse 层剥掉，
 *   此处不参与。
 * - 零长度匹配强制 `lastIndex++` 前进，防死循环。
 */
/**
 * 行内标志前缀（正则的行内标志写法 `(?s)` / `(?i)` / `(?si)`——JS 无行内标志语法）：
 * 出现在模式开头时剥掉并转成 JS flags（s=dotAll、i、m、u；其余字符不剥，编译期如实报错）。
 * 真实源有 `:(?s)(\d+)" class="…` 形态；直接交给 RegExp 会报 Invalid group，故前缀必须先剥掉再编译。
 */
const INLINE_FLAG_RE = /^\(\?([imsu]+)\)/

export function evalAllInOne(
  seg: Extract<Segment, { kind: 'allinone' }>,
  page: string,
  loc: SegmentLoc,
  facet: Facet,
): EngineValue {
  let pattern = seg.pattern
  let flags = seg.flags
  const inline = INLINE_FLAG_RE.exec(pattern)
  if (inline !== null) {
    pattern = pattern.slice(inline[0].length)
    for (const c of inline[1]) if (!flags.includes(c)) flags += c
  }
  let re: RegExp
  try {
    re = new RegExp(pattern, flags.includes('g') ? flags : `g${flags}`)
  } catch (e) {
    throw new RuleEvalError(
      `AllInOne 正则非法：${(e as Error).message}（模式: ${JSON.stringify(seg.pattern)}）`,
      { ...loc, facet, hits: 0 },
    )
  }

  // 整页扫描走死线守卫：合法但病态的正则（灾难回溯）只许废掉这一条规则，
  // 不许把主线程钉住（见 regex-guard 的取舍）；行口径与旧的内联循环一致
  let rows: string[][]
  try {
    rows = guardedMatchAll(re, page)
  } catch (e) {
    if (!(e instanceof RegexDeadlineError)) throw e
    throw new RuleEvalError(
      `AllInOne 正则求值超时（疑似灾难性回溯）：${seg.pattern}`,
      { ...loc, facet, hits: 0 },
    )
  }
  return rows.length > 0 ? { kind: 'matches', rows } : { kind: 'list', items: [] }
}
