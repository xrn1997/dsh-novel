import type { Cheerio, CheerioAPI } from 'cheerio'
import { isTag } from 'domhandler'
import type { AnyNode, Element, Text } from 'domhandler'
import type { EngineValue, Facet, IndexSpec, Segment, SegmentLoc } from './types.js'
import { RuleEvalError, UnsupportedRuleError } from './errors.js'
import { cleanText, isNodeValue, nodeText } from './dom.js'

type DefaultSegment = Extract<Segment, { kind: 'default' }>

const SELECT_MODES = ['class', 'id', 'tag', 'child', 'children'] as const
const GET_MODES = ['text', 'textAll', 'ownText', 'html', 'all', 'href', 'src', 'content', 'textNodes'] as const

/** 该 default 段是否是**取值段**（终端，不再向下选）：mode 属 GET_MODES/attr 且不带参数——
 *  `text.<串>` 那种带参数的「按文本选元素」是选择段。链首未起链时取哪个上下文，由此决定
 *  （evaluate 的 default 分支消费）。 */
export function isGetValueSegment(seg: DefaultSegment): boolean {
  return seg.arg === null && (seg.mode === 'attr' || (GET_MODES as readonly string[]).includes(seg.mode))
}

/**
 * 位置后缀统一口径：
 * - null / all → 整个数组
 * - index：第 n 个（负数从尾数）；越界 → 该位置不入选
 * - multi：条目**逐个**展开、去重靠 Set、**保持写入序**（对面 `for (pcInt in indexSet)`）；
 *   越界者静默丢弃（对面 `if (it in 0 until len)`）
 * - 取位结果为空 → 'miss'（选择失败语义，不抛、也不回退全集）
 *
 * 设计文档：docs/design/engine.md
 */
/** 索引条目 → **位置**集合（越界位置按 legado 口径静默丢弃；`multi` 的并集在此展开） */
function positionsFor(len: number, index: IndexSpec): number[] {
  if (index.kind === 'all') return [...Array(len).keys()]
  if (index.kind === 'index') {
    const i = index.value < 0 ? len + index.value : index.value
    return i < 0 || i >= len ? [] : [i]
  }
  if (index.kind === 'multi') {
    // legado ElementsSingle：条目收进 `MutableSet<Int>`（去重、越界静默丢弃），
    // 取位时按**插入序**遍历（LinkedHashSet）——写序影响结果，不是「按文档序过滤」。
    const set = new Set<number>()
    for (const spec of index.entries) for (const p of positionsFor(len, spec)) set.add(p)
    return [...set]
  }
  if (index.kind === 'range') {
    // 方括号区间（legado ElementsSingle 口径）：闭区间 + 负数从尾数 + 端点越界钳到边界；
    // step 缺省按方向自动（from>to → -1，即倒序取）——`[-1:0]` = 整表倒序
    if (len === 0) return []
    const norm = (v: number): number => (v < 0 ? len + v : v)
    const from = Math.min(len - 1, Math.max(0, norm(index.from)))
    const to = Math.min(len - 1, Math.max(0, norm(index.to)))
    const step = index.step !== undefined && index.step !== 0 ? index.step : (from > to ? -1 : 1)
    const out: number[] = []
    for (let i = from; step > 0 ? i <= to : i >= to; i += step) out.push(i)
    return out
  }
  // 形态穷尽由编译器把住：新增 IndexSpec 形态而忘了在这里落位 ⇒ 下面这行编译不过
  // （不留「认不出就当空集合」的兜底——那正是本仓定的「空结果冒充失败」）。
  const impossible: never = index
  throw new UnsupportedRuleError(`未知索引形态 ${JSON.stringify(impossible)}`, {
    facet: 'rule', segmentIndex: -1, segmentRaw: '位置后缀',
  })
}

export function applyIndex<T>(arr: T[], index: IndexSpec | null): T[] | 'miss' {
  if (index === null || index.kind === 'all') return arr
  const out = positionsFor(arr.length, index).map((i) => arr[i])
  // 取位为空 = 「选择失败」语义 → Miss（空 List 不是节点集，中链必抛「上游结果不是节点集」）
  return out.length === 0 ? 'miss' : out
}

/**
 * `!` 排除口径（官方文档：!是排除，0 是第1个，-1 最后一个，: 隔开多值）：
 * 从结果集去掉指定位置的元素；越界位置静默忽略（排除语义是过滤，不是定位）。
 */
export function applyExclude<T>(arr: T[], exclude: number[] | undefined): T[] {
  if (exclude === undefined || exclude.length === 0) return arr
  const drop = new Set(exclude.map((v) => (v < 0 ? arr.length + v : v)))
  return arr.filter((_, i) => !drop.has(i))
}

/** 选择失败原因（规约单点） */
export type PickedOutcome<T> =
  | { ok: true; items: T[] }
  | { ok: false; reason: 'zero' | 'excluded' | 'oob' }

/**
 * 选择结果后处理单点（规约单点）：exclude 过滤 → index 取位 → 空态裁决，唯一实现
 * （default 选择段与 css 段同源——此前两处各写一份且已语义分叉：同一种取位在两段给两种结果，
 * 而空 List 不是节点集、中链必抛「上游结果不是节点集」）。
 * 口径：三态皆「选择失败」语义，调用方按 reason 组 Miss detail；
 * 「合法零条目（空 List）」只属于取值段（getValue：元素在、取值全空）。legado：先排除再取位。
 */
export function reducePicked<T>(
  arr: T[], exclude: number[] | undefined, index: IndexSpec | null,
): PickedOutcome<T> {
  if (arr.length === 0) return { ok: false, reason: 'zero' }
  const excluded = applyExclude(arr, exclude)
  if (excluded.length === 0) return { ok: false, reason: 'excluded' }
  const applied = applyIndex(excluded, index)
  if (applied === 'miss') return { ok: false, reason: 'oob' }
  return { ok: true, items: applied }
}

/**
 * default 段求值：选择段（class/id/tag/child/children）产出节点集；
 * 取值段（text/textAll/ownText/html/all/href/src/content/textNodes/attr）产出字符串值。
 * `text.<串>` / `ownText.<串>`（**带参数**）是选择段——legado 默认方言「按文本选元素」：
 * AnalyzeByJSoup.getElementsSingle 的 `"text" -> temp.getElementsContainingOwnText(rules[1])`
 * （不带参数的 `text` 才是取值终端）。真实源 `text.下一页@href`、`text.章节目录@href` 全靠它——
 * 此前带参数的 text 被当取值段忽略参数，产出整页文本后 `@href` 落空（实测 27 源目录/正文全灭）。
 * 第 2 参 $（CheerioAPI）用于重建节点集与逐节点取值。
 */
export function evalDefault(
  seg: DefaultSegment,
  $: CheerioAPI,
  cur: Cheerio<AnyNode>,
  loc: SegmentLoc,
  facet: Facet,
): EngineValue {
  if (!isNodeValue(cur)) {
    throw new RuleEvalError('上游结果不是节点集，无法继续选择', { ...loc, facet, hits: 0 })
  }

  // 按文本选元素（选择段语义）：text.x = 含该文本的元素（legado 口径：own text 包含、忽略大小写）；
  // ownText.x 是对称形态（legado 默认方言无此选择语义、会落 CSS 恒零命中——我们给「后代文本包含」，
  // 与 ownText 终端的「直系」口径互为镜像，实测无源依赖、按更有用的方向实现）
  if ((seg.mode === 'text' || seg.mode === 'ownText') && seg.arg !== null && seg.arg !== '') {
    const picked = textContaining($, cur, seg.arg, seg.mode === 'text' ? 'own' : 'descendant')
    return pickNodes(seg, $, picked.toArray(), loc, facet, `${seg.mode}.${seg.arg}`)
  }

  if (!(SELECT_MODES as readonly string[]).includes(seg.mode)) {
    if (seg.mode === 'attr' || (GET_MODES as readonly string[]).includes(seg.mode)) {
      return getValue(seg, $, cur, loc, facet)
    }
    // classifySegment（parse）已挡掉未知 mode，此处兜底
    throw new RuleEvalError('未知 default 段模式', { ...loc, facet, hits: 0 })
  }

  let picked: Cheerio<AnyNode>
  try {
    switch (seg.mode) {
      // legado `class.x y` = getElementsByClassName("x y") = 同时含所有类 → CSS `.x.y` 链
      // （此前直译 `.x y` 后代选择器 → 恒零命中——真实源 class.col-12 col-md-6 3 源）
      case 'class': picked = cur.find('.' + (seg.arg ?? '').trim().split(/\s+/).filter(Boolean).join('.')); break
      case 'id': picked = cur.find('#' + seg.arg); break
      case 'tag': picked = cur.find(seg.arg!); break
      case 'child': picked = cur.children(seg.arg!); break
      default: picked = cur.children(); break // children
    }
  } catch (e) {
    // 隐式回落的选择器形态非法（如 tag 名含 . 等）→ 包成 RuleEvalError 带段定位（错误分类不泄漏裸 Error）
    throw new RuleEvalError(`选择器无法解析：${seg.mode}.${seg.arg ?? ''}（${(e as Error).message}）`, { ...loc, facet, hits: 0 })
  }

  return pickNodes(seg, $, picked.toArray(), loc, facet, `${seg.mode}.${seg.arg ?? ''}`)
}

/** 选择结果 → reducePicked 裁决 → nodes/Miss（选择段与文本选择段共用一份空态口径） */
function pickNodes(
  seg: DefaultSegment, $: CheerioAPI, pickedArr: AnyNode[],
  loc: SegmentLoc, facet: Facet, label: string,
): EngineValue {
  const reduced = reducePicked(pickedArr, seg.exclude, seg.index)
  if (!reduced.ok) {
    const detail =
      reduced.reason === 'zero' ? `选择 ${label} 未命中节点`
        : reduced.reason === 'excluded' ? `选择 ${label} 排除 ${JSON.stringify(seg.exclude)} 后为空`
          : `位置 ${JSON.stringify(seg.index)} 全部越界（原集合 ${pickedArr.length} 项）`
    return { kind: 'miss', detail }
  }
  return { kind: 'nodes', nodes: $(reduced.items) }
}

/**
 * 按文本选元素：候选 = 当前节点集的全部后代元素（含自身，文档序），
 * own 口径 = 元素**直系文本**包含 needle（Jsoup getElementsContainingOwnText 同款，忽略大小写）；
 * descendant 口径 = 全部后代文本包含 needle。
 */
function textContaining(
  $: CheerioAPI, cur: Cheerio<AnyNode>, needle: string, scope: 'own' | 'descendant',
): Cheerio<AnyNode> {
  const candidates: AnyNode[] = []
  const seen = new Set<AnyNode>()
  // cur 的节点子树互相重叠（链首 $('*') 就是全集）——逐节点下钻必须去重，
  // 否则同一元素被祖先子树反复收集（`text.下一页@href` 实测一个 href 出 5 份）
  const visit = (n: AnyNode): void => {
    if (seen.has(n)) return
    seen.add(n)
    if (isTag(n)) candidates.push(n)
    const kids = (n as Element).children
    if (kids !== undefined) for (const c of kids) visit(c as AnyNode)
  }
  for (const n of cur.toArray()) visit(n)
  const low = needle.toLowerCase()
  const hit = candidates.filter((el) => {
    const text = scope === 'own' ? directText($, el) : $(el).text()
    return text.toLowerCase().includes(low)
  })
  return $(hit)
}

/**
 * 取值段：单节点 → Value；多节点 → List；零节点/取位失败 → Miss；取到空（合法零条目）→ 空 List。
 * 空态/取位裁决复用 reducePicked 单点：此前本函数自写一份排除+applyIndex+空态逻辑，
 * 与选择段分叉——切片裁空在选择段给 Miss、取值段给空 List（同一 `x.5:9` 后缀两种结果）。
 * 现与选择段同口径：zero/excluded/oob/sliced 一律「取位失败」→ Miss；
 * 「合法零条目（元素在、取值全空）」仍是空 List（见函数末尾 texts.length === 0 分支）。
 */
function getValue(
  seg: DefaultSegment,
  $: CheerioAPI,
  cur: Cheerio<AnyNode>,
  loc: SegmentLoc,
  facet: Facet,
): EngineValue {
  const arr = cur.toArray()
  const reduced = reducePicked(arr, seg.exclude, seg.index)
  if (!reduced.ok) {
    const detail =
      reduced.reason === 'zero' ? '取值时上游节点集为空'
        : reduced.reason === 'excluded' ? `取值排除 ${JSON.stringify(seg.exclude)} 后为空`
          : `位置 ${JSON.stringify(seg.index)} 全部越界（原集合 ${arr.length} 项）`
    return { kind: 'miss', detail }
  }
  const applied = reduced.items

  // attr 终端（CONTEXT.md「属性终端」）：legado getResultLast else 分支 `element.attr(name)`——
  // 元素自身属性，空则向下兜底第一个含该属性的后代（与 href/src 同口径，html/body 包装不兜底）；
  // **空值丢弃 + 去重**（legado 同款）。真实源 ruleBookUrl `@onclick`、`@value`、`@_src` 全靠它。
  if (seg.mode === 'attr') {
    const name = seg.arg ?? ''
    const seen = new Set<string>()
    const out: string[] = []
    for (const el of applied) {
      const v = attrFallback($, el, name)
      if (v === '' || seen.has(v)) continue
      seen.add(v)
      out.push(v)
    }
    if (out.length === 0) return { kind: 'list', items: [] } // 元素在、取值全空 → 空 List（非 Miss）
    if (applied.length === 1 && arr.length === 1) return { kind: 'value', text: out[0] }
    return { kind: 'list', items: out }
  }

  // textNodes：全部后代文本节点的文本列表（逐文本节点输出一条）
  if (seg.mode === 'textNodes') {
    const items: string[] = []
    for (const el of applied) {
      const textNodes: Text[] = []
      collectTextNodes(el, textNodes)
      for (const node of textNodes) {
        const t = cleanText(node.data)
        if (t !== '') items.push(t)
      }
    }
    return { kind: 'list', items }
  }

  const texts: string[] = []
  // 属性型终端（href/src/content）与 attr 同一条对面口径：`getResultLast` 的 else 分支
  // `if (url.isBlank() || textS.contains(url)) continue` —— **空值丢弃 + 去重**。漏去重的后果不是
  // 难看而是错数据：真源 ruleBookUrl `tag.a@href` 在一个条目里 4 个 <a> 指向同一 href，收 4 份后
  // 服务层 firstValue 以 \n 拼接，`new URL()` 吃掉换行 → 书 URL 变成路径重复（久久小说/成人小说网
  // 真机实证）。text/html/all 等**具名**分支对面不去重（重复的章节名、正文段是合法内容），故只这一组去重。
  const dedupe = seg.mode === 'href' || seg.mode === 'src' || seg.mode === 'content'
  const seenVal = new Set<string>()
  for (const el of applied) {
    const t = extract($, el, seg.mode)
    if (t === '') continue
    if (dedupe) {
      if (seenVal.has(t)) continue
      seenVal.add(t)
    }
    texts.push(t)
  }
  if (texts.length === 0) return { kind: 'list', items: [] } // 取到空（合法零条目），区别于 Miss
  if (applied.length === 1 && arr.length === 1) return { kind: 'value', text: texts[0] }
  return { kind: 'list', items: texts }
}

/** 深度优先收集全部后代文本节点（含元素内层，如 <b> 内文本） */
function collectTextNodes(node: AnyNode, out: Text[]): void {
  if (node.type === 'text') {
    out.push(node as Text)
    return
  }
  const children = (node as Element).children
  if (children) for (const c of children) collectTextNodes(c as AnyNode, out)
}

/** 直系文本节点合并（排除后代元素内的文本） */
function directText($: CheerioAPI, el: AnyNode): string {
  return $(el).contents().filter((_, node) => node.type === 'text').text()
}

/** 属性取值兜底单点：自身属性 →（html/body 除外）第一个含该属性的后代 */
function attrFallback($: CheerioAPI, el: AnyNode, name: string, fallbackSel?: string): string {
  const own = (el as Element).attribs?.[name] ?? ''
  if (own !== '') return own
  const tag = (el as Element).name
  if (tag === 'html' || tag === 'body') return ''
  if (fallbackSel !== undefined) return $(el).find(fallbackSel).first().attr(name) ?? ''
  // 属性名可含冒号（`isAttrName` 放行 `xlink:href` 这类命名空间形态），拼成 CSS 属性选择器会
  // 炸成逃逸错误分类的裸 Error——按「第一个含该属性的后代」口径直接遍历取值。
  for (const node of $(el).find('*').toArray()) {
    const v = (node as Element).attribs?.[name]
    if (v !== undefined && v !== '') return v
  }
  return ''
}

function extract($: CheerioAPI, el: AnyNode, mode: string): string {
  switch (mode) {
    // text：**全部后代文本**（legado/Jsoup `element.text()` 口径），块级边界落成换行。
    // 此前实现按「严格直系文本」收（与 ownText 同义），实测打不动真实源：
    // 笔趣阁正文规则 `.con@text` 而 `.con` 里全是 <p> 子元素 → 直系文本为空 → 正文零命中。
    // legado 侧 li/div 容器取文本同样是后代文本（JvSoup .text()），android-ebook 同源语义。
    case 'text':
      return nodeText(el)
    // ownText：严格直系文本节点（排除后代元素内的文本，如 <p>外<b>内</b>尾</p> → 外尾）。
    // 与 text 的区别就在这里（legado 的 ownText 语义），无直系文本 → 空，不做后代兜底。
    case 'ownText':
      return cleanText(directText($, el))
    case 'textAll':
      return cleanText($(el).text())
    case 'html':
      return $(el).html() ?? ''
    case 'all':
      return $.html(el) ?? ''
    // 原样属性值（相对 URL 的绝对化由 service 层负责，引擎不拼）。
    // legado 口径：自身属性为空时向下兜底——href/src 取第一个含该属性的后代，
    // content 取第一个 meta 的 content（钉死语义：li 上 @href → 内层 a 的 href）。
    // 但 html/body 是片段加载的人造包装（非用户规则所指）：链首 $('*') 上下文里它们的
    // 兜底会与目标元素自身属性重复出多份同值（@href ×3 → \n 拼接 → URL 解析剥换行拼接成事故），
    // 包装元素一律不兜底——目标元素自身仍在节点集里正常取值。
    case 'href':
    case 'src':
      return attrFallback($, el, mode)
    case 'content':
      return attrFallback($, el, 'content', 'meta[content]')
    default:
      return cleanText($(el).text())
  }
}
