/**
 * 元素影子宿主面（`__elem.*`）：沙箱元素包装对象（Element/Elements 最小仿真）的宿主侧求值。
 * 这条通道是 `JAVA_PROTOCOL` 之外的第二条宿主面——op 名册、宿主实现、片段解析缓存与沙箱侧 wrapper 源
 * 片段同住这里：加一个 op 只动这一个 module 与它的测试（否则 op 名散在 BOOTSTRAP 串与宿主 switch 里，
 * 既无名册也无直接单测）。接口只有「op 名 + JSON → JSON」；沙箱语义仍归 `ADR-0004`。
 */
import { isTag } from 'domhandler'
import type { Element } from 'domhandler'
import { loadHtml, nodeText } from './dom.js'
import { textOf } from './js-utils.js'

/** op 名册：**唯一来源**。宿主分派按它收窄（漏分支 = 编译错），沙箱侧 wrapper 片段的 op 字面量由测试逐一对表。 */
export const ELEM_OPS = ['attr', 'text', 'html', 'select', 'split', 'remove'] as const
export type ElemOp = (typeof ELEM_OPS)[number]

const ELEM_OP_SET: ReadonlySet<string> = new Set(ELEM_OPS)

/** 线上来的 op 名先过名册；认不出一律点名，不落到 `switch` 的兜底当未知分支。 */
function elemOpOf(op: string): ElemOp {
  if (ELEM_OP_SET.has(op)) return op as ElemOp
  throw new Error(`未知元素桥操作：${op}`)
}

export interface ElemPayload { html?: unknown; name?: unknown; rule?: unknown }

/** 片段解析的**单条缓存**：一条 `els.get(i).text()` / `.attr(x).html()` 链会对同一段片段发起多次宿主
 *  操作，每次都重跑 `loadHtml` 等于把整段 HTML 全量解析 N 遍。只做单条、不做 Map：键是攻击者可控的
 *  HTML 串，留清单就是留内存增长口；RPC 同步进出，同一次调用内不存在交错。 */
let lastElemHtml = ''
let lastElemApi: ReturnType<typeof loadHtml> | null = null

/** __elem.* 宿主实现：入参 {html, name?/rule?}，出参纯 JSON */
export function elemHostOp(op: string, payload: ElemPayload): unknown {
  const known = elemOpOf(op)
  const html = typeof payload.html === 'string' ? payload.html : ''
  let api = lastElemApi
  if (api === null || html !== lastElemHtml) {
    api = loadHtml(html)
    lastElemApi = api
    lastElemHtml = html
  }
  const $ = api
  const firstEl = (): Element | null => {
    for (const n of $('*').toArray()) if (isTag(n)) return n
    return null
  }
  switch (known) {
    case 'attr': {
      const name = textOf(payload.name ?? '')
      const el = firstEl()
      if (el === null || name === '') return ''
      const own = el.attribs[name] ?? ''
      if (own !== '') return own
      return $(el).find(`[${name}]`).first().attr(name) ?? ''
    }
    case 'text': {
      const root = $.root().get(0)
      return root === undefined ? '' : nodeText(root)
    }
    case 'html': {
      const el = firstEl()
      return el === null ? '' : $(el).html() ?? ''
    }
    case 'select': {
      const rule = textOf(payload.rule ?? '')
      if (rule === '') return []
      try {
        return $(rule).toArray().map((n) => $.html(n))
      } catch (e) {
        throw new Error(`选择器无法解析：${rule}（${(e as Error).message}）`, { cause: e })
      }
    }
    case 'split': {
      // 片段的顶层元素集（Elements.toArray 口径）。parse5 把片段挂进 body，直接取
      // root().children() 只会得到一个 html——那会让 toc 模板脚本的 result.toArray() 恒为 1 个
      // 「元素」，其 text() 反而是整段拼接（size/get/each 全错位）。
      const body = $('body')
      const kids = body.length > 0 ? body.children() : $.root().children()
      return kids.toArray().filter((n) => isTag(n)).map((n) => $.html(n))
    }
    case 'remove': {
      // 元素桥的摘除回写：remove() 只把节点从**父**上摘掉、子树跟着节点走——el.select(...).remove()
      // 把 el 自己摘走后，el.html() 仍要读到没被命中的内容。做法：先按原形状记下顶层节点，摘完再
      // 串化它们（节点还在，串化即为净化后的片段）。文档级片段串化整份文档，其余串化 body 顶层子节点。
      const rule = textOf(payload.rule ?? '')
      const isDoc = /^\s*(?:<!doctype\s|<html[\s>])/i.test(html)
      const top = (isDoc ? $.root().contents() : $('body').contents()).toArray()
      if (rule !== '') {
        try {
          $(rule).remove()
        } catch (e) {
          throw new Error(`选择器无法解析：${rule}（${(e as Error).message}）`, { cause: e })
        }
      }
      return isDoc ? $.html() : top.map((n) => $(n).toString()).join('')
    }
    default: {
      const exhaustive: never = known
      throw new Error(`未知元素桥操作：${String(exhaustive)}`)
    }
  }
}

/** 沙箱侧 wrapper 源片段：插进 `js-sandbox.ts` 的 BOOTSTRAP 模板串，定义 `elemOps` / `wrapElems` / `mkElem`
 *  并把 `__mkElem__` / `__wrapElems__` 挂到全局。插入位置：**先于** pkg 片段（其 `Jsoup.parse` 引用 `mkElem`）。
 *  生成文本被当**文本**插值，故不得含反引号或美元花括号；片段只可引用 BOOTSTRAP 作用域的 `g`/`call`/`ser`/`msg`。 */
export function elemWrapperSource(): string {
  return `
  // ── 元素包装对象（脚本侧 Element/Elements 表面的最小仿真）──────────────────
  // 输入脚本有 result.attr('href')、result.select('.x').first().text()、java.getElements(r).toArray()
  // 等形态：String 对象包装（字符串方法照常可用：match/replace/indexOf/模板串），
  // 属性/文本/选择器方法经 __elem.* 宿主调用（cheerio 求值，同步桥）。
  const elemOps = function (op, payload) {
    try { return JSON.parse(call('__elem.' + op, ser(payload))) } catch (e) { throw new Error(msg(e)) }
  }
  // owner = { box, rule }：这个集合是「哪个片段的哪条选择器」选出来的。元素桥的片段住在
  // box.html 里（不是构造时常量），select().remove() 把摘除后的片段回写进 owner.box——
  // 产出它的那个元素此后所有读法（html/text/select/String）都看见净化后的树。
  const wrapElems = function (arr, owner) {
    const out = []
    for (let i = 0; i < arr.length; i++) out.push(mkElem(String(arr[i])))
    // 集合助手挂成**不可枚举**：按脚本侧的集合 API，result.toArray() 给的是数组、for (i in list) 只遍历下标；
    // toc 模板脚本正是 for-in 形态，可枚举的助手会被当元素遍历（list[i].text is not a function）。
    // （BOOTSTRAP 是模板字符串，注释里不能出现反引号。）
    const all = function () { return mkElem(out.join('\\n')) }   // 聚合口径共用元素桥（attr=首个、text=拼接）
    const helpers = {
      toArray: function () { return out.slice() },
      size: function () { return out.length },
      get: function (i) { return out[i] !== undefined ? out[i] : mkElem('') },
      eq: function (i) { return out[i] !== undefined ? out[i] : mkElem('') },
      first: function () { return out.length > 0 ? out[0] : mkElem('') },
      last: function () { return out.length > 0 ? out[out.length - 1] : mkElem('') },
      each: function (fn) { for (var i = 0; i < out.length; i++) fn(out[i], i); return out },
      // 脚本侧 Elements 的聚合读法：attr/text/html/select 走整段拼接后的元素桥
      attr: function (n) { return all().attr(n) },
      text: function () { return all().text() },
      html: function () { return out.length > 0 ? out[0].html() : '' },
      select: function (rule) { return wrapElems(all().select(rule)) },
      selectFirst: function (rule) { return all().selectFirst(rule) },
      hasClass: function (c) { return all().hasClass(c) },
      hasAttr: function (n) { var a = all().attr(n); return a !== '' && a !== undefined },
      // 集合的 remove()：没有 owner 的集合（临时聚合）背后没有可回写的片段 → 如实抛——
      // 静默 no-op 等于把脏节点当已净化交给正文。
      remove: function () {
        if (owner === undefined || owner === null) {
          throw new Error('remove() 需要可回写的宿主片段：本桥只支持 元素.select(规则).remove() 形态')
        }
        owner.box.html = elemOps('remove', { html: owner.box.html, rule: owner.rule })
        return out
      },
      toString: function () { return out.join('') },   // Elements.toString() = 各元素 outerHtml 拼接、无分隔
    }
    for (const k in helpers) Object.defineProperty(out, k, { value: helpers[k], enumerable: false, writable: true })
    return out
  }
  // 元素集包装：列表路径上的 result 是元素**集合**（Elements）而非单个 Element——size()/get()/each()
  // 按顶层元素数算，不是恒 1；同时保留 String 对象身份（match/replace/模板串照常可用）。
  // 片段住 box 而非构造常量：活文档树上的摘除要能被后续读法看见。
  const mkElem = function (raw) {
    const box = { html: String(raw) }
    const s = new String(box.html)
    s.toString = function () { return box.html }
    s.valueOf = function () { return box.html }
    s.attr = function (name) { return elemOps('attr', { html: box.html, name: String(name) }) }
    s.text = function () { return elemOps('text', { html: box.html }) }
    s.html = function () { return elemOps('html', { html: box.html }) }
    s.select = function (rule) { return wrapElems(elemOps('select', { html: box.html, rule: String(rule) }), { box: box, rule: String(rule) }) }
    s.selectFirst = function (rule) { return s.select(rule).first() }
    s.hasClass = function (c) {
      var cls = String(s.attr('class') || '')
      return (' ' + cls + ' ').indexOf(' ' + String(c) + ' ') > -1
    }
    s.toArray = function () { return wrapElems(elemOps('split', { html: box.html })) }
    s.size = function () { return s.toArray().length }
    s.get = function (i) { var a = s.toArray(); return a[i] !== undefined ? a[i] : mkElem('') }
    s.eq = function (i) { return s.get(i) }
    s.first = function () { var a = s.toArray(); return a.length > 0 ? a[0] : mkElem('') }
    s.last = function () { var a = s.toArray(); return a.length > 0 ? a[a.length - 1] : mkElem('') }
    s.each = function (fn) { var a = s.toArray(); for (var i = 0; i < a.length; i++) fn(a[i], i); return s }
    return s
  }
  g.__mkElem__ = mkElem
  g.__wrapElems__ = wrapElems
`
}
