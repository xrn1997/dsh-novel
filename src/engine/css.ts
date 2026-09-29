import type { Cheerio, CheerioAPI } from 'cheerio'
import type { AnyNode } from 'domhandler'
import type { EngineValue, Facet, Segment, SegmentLoc } from './types.js'
import { RuleEvalError } from './errors.js'
import { containsText, reducePicked, textOf } from './select.js'

type CssSegment = Extract<Segment, { kind: 'css' }>

/**
 * jsoup 的 `[attr~=regex]`：**正则匹配**，不是标准 CSS 的「属性值按空白分词后含该词」。
 * `[property~=category|status|update_time]`、`[href~=/read/\d+]` 这类只有正则读法讲得通；走标准
 * CSS 拿属性值去比字面词恒不命中（曾致 `ruleToc.chapterList = a[href~=/read/\d+]` 零命中、目录 0 章）。
 * 求值前把 `~=` 谓词摘出来：选择器里改写成「只要有这个属性」（`[attr]`），再按正则逐元素筛。
 * 正则非法 → 与「选择器写错」同档，如实 RuleEvalError，不静默零命中。
 */
const JSOUP_ATTR_RE = /\[([\w:.-]+)~=([^\]]*)\]/g

/**
 * jsoup 的文本伪类 `:contains(文本)` 与 `:containsOwn(文本)`：**字面包含、忽略大小写**，
 * 后者只看元素自己的直接文本节点（子节点里的文字不算）。
 * cheerio 的 `:contains` 区分大小写、且根本没有 `:containsOwn`（底层选择器引擎直接抛
 * 「Unknown pseudo-class」），所以两件事都在求值前把伪类摘出来自己筛：摘掉后原位置补 `*`
 * （紧贴基础选择器时什么都不留，见 parseSelector 内注释），再对结果集逐个比文本。
 * 空参数如实抛错（不静默全命中）；引号形态允许括号、无引号形态不跨 `)`——与上游一致。
 * 文本包含判定与 own/descendant 取文本的口径归 `select.ts`（`containsText` / `textOf`），
 * 与 `text.x`/`ownText.x` 共用一份——各折各的大小写会让两种形态选出不同元素集。
 */
const JSOUP_TEXT_RE = /:(contains|containsOwn)\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi

type TextFilter = { own: boolean; text: string }
type AttrFilter = { attr: string; re: RegExp }

/** 摘完 jsoup 谓词的选择器：cheerio 吃的 `plain` + 待逐元素补筛的条件 */
interface ParsedSelector { plain: string; textFilters: TextFilter[]; attrFilters: AttrFilter[] }

/**
 * 选择器 → 谓词摘除结果，**按选择器原文缓存**：同一规则段每页/每条目都要评一次，
 * 而摘除只依赖选择器文本本身。只缓存成功解析——失败仍每次现抛（错误面带当下的 loc/facet）。
 * 缓存边界：键来自规则文本，有限集，不设上限。
 */
const parsedSelectors = new Map<string, ParsedSelector>()

function parseSelector(selector: string, loc: SegmentLoc, facet: Facet): ParsedSelector {
  const hit = parsedSelectors.get(selector)
  if (hit !== undefined) return hit
  const textFilters: TextFilter[] = []
  // 摘掉伪类后补什么，取决于它前面是什么：紧贴基础选择器（`.tag:contains(x)`）时必须**什么都不留**
  // （补 `*` 会变成 `.tag *` = 后代，把元素自己排除在候选之外，语义整个反了）；
  // 而裸形态（开头、组合符或逗号之后）要补 `*`，否则剩下一个悬空组合符。
  let plain = selector.replace(JSOUP_TEXT_RE, (m, name: string, dq?: string, sq?: string, bare?: string, off?: number) => {
    const text = (dq ?? sq ?? bare ?? '').trim()
    if (text === '') {
      throw new RuleEvalError(`CSS 选择器无法解析：${selector}（:${name}(…) 的参数为空）`, { ...loc, facet, hits: 0 })
    }
    textFilters.push({ own: name.toLowerCase() === 'containsown', text })
    const before = off && off > 0 ? selector[off - 1] : ''
    return before === '' || before === ' ' || before === '>' || before === '+' || before === '~' || before === ',' || before === '(' ? '*' : ''
  })
  const attrFilters: AttrFilter[] = []
  plain = plain.replace(JSOUP_ATTR_RE, (_m, attr: string, pattern: string) => {
    try {
      attrFilters.push({ attr, re: new RegExp(pattern) })
    } catch (e) {
      throw new RuleEvalError(
        `CSS 选择器无法解析：${plain}（[${attr}~=…] 的正则非法：${(e as Error).message}）`,
        { ...loc, facet, hits: 0 },
      )
    }
    return `[${attr}]`
  })
  const parsed: ParsedSelector = { plain, textFilters, attrFilters }
  parsedSelectors.set(selector, parsed)
  return parsed
}

/**
 * @css 选择器段求值：在当前节点集内 cur.find(SEL)（不做全文档查找）。
 * - cheerio 底层选择器引擎（nwsapi/css-select）对非法选择器抛错 → 包成 RuleEvalError
 *   （hits=0，说明是选择器写错而非语法外构造）；**本层自己抛的 RuleEvalError 原样上抛**——
 *   再包一层会让消息自嵌套（`CSS 选择器无法解析：sel（CSS 选择器无法解析：sel（…））`）。
 * - `!` 排除与位置后缀、空态裁决走 reducePicked 单点：零命中 / 排除后为空 / 取位越界（`oob`）
 *   一律 Miss（选择失败），与 default 选择段同口径——此前两处各写一份且已语义分叉。
 * css 显式形态无位置后缀（恒整集）；隐式 CSS 回落（a.0/.odd.0）可携带位置后缀，按其取位。
 */
export function evalCss(
  seg: CssSegment,
  $: CheerioAPI,
  cur: Cheerio<AnyNode>,
  loc: SegmentLoc,
  facet: Facet,
): EngineValue {
  const { plain, textFilters, attrFilters } = parseSelector(seg.selector, loc, facet)
  let picked: Cheerio<AnyNode>
  try {
    picked = cur.find(plain)
  } catch (e) {
    if (e instanceof RuleEvalError) throw e
    throw new RuleEvalError(`CSS 选择器无法解析：${seg.selector}（${(e as Error).message}）`, { ...loc, facet, hits: 0 })
  }
  for (const f of attrFilters) {
    picked = picked.filter((_i, el) => {
      const value = $(el).attr(f.attr)
      return value !== undefined && f.re.test(value)
    })
  }
  // 逐元素取文本只在真用到时做（`:contains` 常见形态是 f.own=false，只看 $el.text()）——
  // 先算 own 再看用不用是每候选元素三次数组分配的白费。
  for (const f of textFilters) {
    picked = picked.filter((_i, el) => containsText(textOf($, el, f.own ? 'own' : 'descendant'), f.text))
  }
  const reduced = reducePicked(picked.toArray(), seg.exclude, seg.index ?? null)
  if (!reduced.ok) {
    // reason 只有三态（`PickedOutcome`）：zero / excluded / oob——本层没有「切片」取位可言，
    // 曾有第四态随那个误读一起删（口径见 `select.ts` 的 reducePicked 与 CONTEXT.md「取值规约」）。
    const detail =
      reduced.reason === 'zero' ? `css 选择器 ${seg.selector} 零命中`
        : reduced.reason === 'excluded' ? `css 选择器 ${seg.selector} 排除 ${JSON.stringify(seg.exclude)} 后为空`
          : `位置 ${JSON.stringify(seg.index)} 越界`
    return { kind: 'miss', detail }
  }
  return { kind: 'nodes', nodes: $(reduced.items) }
}
