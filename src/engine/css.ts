import type { Cheerio, CheerioAPI } from 'cheerio'
import type { AnyNode } from 'domhandler'
import type { EngineValue, Facet, Segment, SegmentLoc } from './types.js'
import { RegexDeadlineError, RuleEvalError } from './errors.js'
import { guardedFilter } from './regex-guard.js'
import { containsText, reducePicked, selectStepWithSelf, textOf } from './select.js'

type CssSegment = Extract<Segment, { kind: 'css' }>

/**
 * `[attr~=regex]` 是**正则匹配**，不是标准 CSS 的「属性值按空白分词后含该词」——`[href~=/read/\d+]`
 * 这类只有正则读法讲得通，按标准 CSS 读会恒不命中、目录 0 章。求值前把 `~=` 谓词摘出来：选择器里改写
 * 成 `[attr]`，再按正则逐元素筛。正则非法 → 与「选择器写错」同档如实 RuleEvalError，不静默零命中。
 */
const JSOUP_ATTR_RE = /\[([\w:.-]+)~=([^\]]*)\]/g

/**
 * 文本伪类 `:contains(文本)` / `:containsOwn(文本)`（脚本侧方言）：**字面包含、忽略大小写**，后者只看元素自己
 * 的直接文本节点。cheerio 的 `:contains` 区分大小写、且没有 `:containsOwn`，故两者都在求值前摘出来自己筛：
 * 摘掉后原位置补 `*`（紧贴基础选择器时什么都不留），再逐个比文本。空参数如实抛错；无引号形态不跨 `)`。
 * 文本包含与 own/descendant 取文本的口径归 `select.ts`，与 `text.x` 共用。
 */
const JSOUP_TEXT_RE = /:(contains|containsOwn)\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi

type TextFilter = { own: boolean; text: string }
type AttrFilter = { attr: string; re: RegExp }

interface ParsedSelector { plain: string; textFilters: TextFilter[]; attrFilters: AttrFilter[] }

/**
 * 选择器 → 谓词摘除结果，**按选择器原文缓存**（同一段规则每页/每条目都要评一次，摘除只依赖文本）。只缓存
 * 成功解析——失败仍每次现抛。键来自规则文本，有限集，不设上限。
 */
const parsedSelectors = new Map<string, ParsedSelector>()

function parseSelector(selector: string, loc: SegmentLoc, facet: Facet): ParsedSelector {
  const hit = parsedSelectors.get(selector)
  if (hit !== undefined) return hit
  const textFilters: TextFilter[] = []
  // 摘掉伪类后补什么取决于它前面是什么：紧贴基础选择器（`.tag:contains(x)`）时必须**什么都不留**
  // （补 `*` 会变成 `.tag *` = 后代，把元素自己排除在候选之外）；裸形态（开头、组合符或逗号后）补 `*`。
  let plain = selector.replace(JSOUP_TEXT_RE, (_m, name: string, dq?: string, sq?: string, bare?: string, off?: number) => {
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
 * @css 选择器段求值：在当前节点集内选（命中集含当前元素自身，见 `selectStepWithSelf`）；链首由 fromRoot 走
 * 等价直达。cheerio 底层引擎对非法选择器抛错 → 包成 RuleEvalError；**本层自己抛的 RuleEvalError 原样上抛**
 * ——再包一层会让消息自嵌套。`!` 排除、位置后缀与空态裁决走 reducePicked 单点（与 default 选择段同口径）；
 * css 显式形态无位置后缀，隐式 CSS 回落（a.0/.odd.0）按携带的后缀取位。
 */
export function evalCss(
  seg: CssSegment,
  $: CheerioAPI,
  cur: Cheerio<AnyNode>,
  loc: SegmentLoc,
  facet: Facet,
  fromRoot = false,
): EngineValue {
  const { plain, textFilters, attrFilters } = parseSelector(seg.selector, loc, facet)
  let picked: Cheerio<AnyNode>
  try {
    picked = $(selectStepWithSelf($, cur, plain, fromRoot))
  } catch (e) {
    if (e instanceof RuleEvalError) throw e
    throw new RuleEvalError(`CSS 选择器无法解析：${seg.selector}（${(e as Error).message}）`, { ...loc, facet, hits: 0 })
  }
  for (const f of attrFilters) {
    // 用户正则走死线守卫（一批一次 vm 往返）：灾难回溯只许废掉这条选择器，不许钉住主线程
    let kept: AnyNode[]
    try {
      kept = guardedFilter(picked.toArray(), f.re, (el) => $(el).attr(f.attr))
    } catch (e) {
      if (!(e instanceof RegexDeadlineError)) throw e
      throw new RuleEvalError(
        `CSS 属性正则求值超时（疑似灾难性回溯）：${seg.selector}（[${f.attr}~=…]）`,
        { ...loc, facet, hits: 0 },
      )
    }
    const keep = new Set(kept)
    picked = picked.filter((_i, el) => keep.has(el))
  }
  // 逐元素取文本只在真用到时做（`:contains` 常见形态 f.own=false，只看 $el.text()）——先算 own 再判
  // 用不用是每候选元素三次数组分配的白费。
  for (const f of textFilters) {
    picked = picked.filter((_i, el) => containsText(textOf($, el, f.own ? 'own' : 'descendant'), f.text))
  }
  const reduced = reducePicked(picked.toArray(), seg.exclude, seg.index ?? null)
  if (!reduced.ok) {
    // reason 只有三态（`PickedOutcome`）：zero / excluded / oob——本层没有「切片」取位；不要新增第四态。
    const detail =
      reduced.reason === 'zero' ? `css 选择器 ${seg.selector} 零命中`
        : reduced.reason === 'excluded' ? `css 选择器 ${seg.selector} 排除 ${JSON.stringify(seg.exclude)} 后为空`
          : `位置 ${JSON.stringify(seg.index)} 越界`
    return { kind: 'miss', detail }
  }
  return { kind: 'nodes', nodes: $(reduced.items) }
}
