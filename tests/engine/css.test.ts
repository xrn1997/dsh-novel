import { describe, expect, it } from 'vitest'
import * as cheerio from 'cheerio'
import { evalCss } from '../../src/engine/css.js'
import { RuleEvalError } from '../../src/engine/errors.js'

// fixture 与 select.test.ts 同源：3 个 li.clearfix（第 3 个 odd），章节名在 a.name 内
const html = `<div id="wrap"><ul class="list">
  <li class="item clearfix"><a class="name" href="/b/1">第一章 起点</a><span class="date">2024-01-01</span></li>
  <li class="item clearfix"><a class="name" href="/b/2">第二章 转折</a><span class="date">2024-01-02</span></li>
  <li class="item odd clearfix"><a class="name" href="/b/3">第三章 高潮</a><span class="date">2024-01-03</span></li>
</ul><div id="meta"><p>作者：甲</p><p>字数：10万</p></div></div>`

const $ = cheerio.load(html)
const root = () => $('#wrap') as any
const seg = (selector: string) => ({ kind: 'css', selector }) as const
const loc = (i: number, raw: string) => ({ segmentIndex: i, segmentRaw: raw })

describe('@css 选择器段', () => {
  it('命中 3 个 li.clearfix → nodes', () => {
    const v = evalCss(seg('li.clearfix'), $, root(), loc(0, '@css:li.clearfix'), 'toc')
    expect(v.kind).toBe('nodes')
    expect((v as any).nodes).toHaveLength(3)
  })
  it('零命中 .nope → Miss（detail 提到零命中与选择器）', () => {
    const v = evalCss(seg('.nope'), $, root(), loc(0, '@css:.nope'), 'toc')
    expect(v.kind).toBe('miss')
    expect((v as any).detail).toContain('零命中')
    expect((v as any).detail).toContain('.nope')
  })
  it('在当前节点集内选（含当前元素自身），不做全文档查找', () => {
    const meta = $('#meta') as any
    const v = evalCss(seg('li'), $, meta, loc(0, '@css:li'), 'toc')
    expect(v.kind).toBe('miss') // li 都在 #meta 之外，#meta 自己也不是 li
    const inWrap = evalCss(seg('li'), $, root(), loc(1, '@css:li'), 'toc')
    expect((inWrap as any).nodes).toHaveLength(3)
  })
  it('子组合器 + 伪类：.list>li:nth-child(2) → 1 个且是第二章', () => {
    const v = evalCss(seg('.list>li:nth-child(2)'), $, root(), loc(0, '@css:.list>li:nth-child(2)'), 'toc')
    expect(v.kind).toBe('nodes')
    expect((v as any).nodes).toHaveLength(1)
    expect($(v.kind === 'nodes' ? (v.nodes as any)[0] : null).find('a').attr('href')).toBe('/b/2')
  })
  it('属性伪类：.name[href$="2"] → 1 个', () => {
    const v = evalCss(seg('.name[href$="2"]'), $, root(), loc(0, '@css:.name[href$="2"]'), 'toc')
    expect(v.kind).toBe('nodes')
    expect((v as any).nodes).toHaveLength(1)
    expect((v as any).nodes.text()).toBe('第二章 转折')
  })
  it('命中产物可用 $ 继续消费（nodes 重建）', () => {
    const v = evalCss(seg('.date'), $, root(), loc(0, '@css:.date'), 'toc') as any
    expect(v.nodes).toHaveLength(3)
    expect(v.nodes.eq(0).text()).toBe('2024-01-01')
  })
  it('非法选择器 @css:@@@ → RuleEvalError（message 提到选择器，hits=0，段级定位）', () => {
    let caught: unknown
    try {
      evalCss(seg('@@@'), $, root(), loc(2, '@css:@@@'), 'toc')
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(RuleEvalError)
    const err = caught as RuleEvalError
    expect(err.message).toContain('选择器')
    expect(err.message).toContain('@@@')
    expect(err.hits).toBe(0)
    expect(err.segmentIndex).toBe(2)
    expect(err.facet).toBe('toc')
  })
})

/**
 * @css 链步含当前元素自身——本仓与对面 jsoup 的真实分叉，2026-10-08 由真机 404 追出。
 *
 * 病态：`<a class="page-link">` 这种「类名长在标签自己身上」的写法，规则 `.page-link@a@href`
 * 的中间步是一条裸词 CSS 选择器。对面 `Element.select` 的命中集**含当前元素**（本机实测：
 * `self.select("a")` = 1；版本成色写在矩阵 `a-default-step-self-inclusion`，不在这里重复），
 * 本仓 `cur.find()` 只给后代 = 0 → 整条链读空 → 目录翻页规则后面的脚本拿 `undefined` 拼出下一页
 * 地址 → 404 把整棵目录带走。裁决与代价见 `docs/adr/0029`，
 * 读数在矩阵行 `a-default-step-self-inclusion`。
 */
describe('@css 链步含当前元素自身', () => {
  const PL_HTML = '<div id="pg"><ul class="pages">'
    + '<li class="pi"><a class="page-link">1/2</a></li>'
    + '<li class="pi"><a class="page-link" href="/107/107609/index_1.html">1</a></li>'
    + '<li class="pi"><a class="page-link" href="/107/107609/index_2.html">2</a></li>'
    + '</ul></div>'
  const p$ = cheerio.load(PL_HTML)

  it('裸词步 a 在当前集全是 a.page-link 时入选（对面同形）', () => {
    const v = evalCss(seg('a'), p$, p$('.page-link') as any, loc(0, '@css:a'), 'toc')
    expect(v.kind).toBe('nodes')
    expect((v as any).nodes).toHaveLength(3)
  })
  it('整条链 .page-link@a@href 读出两条真地址（事故现场的最小复现）', async () => {
    const { evaluate } = await import('../../src/engine/evaluate.js')
    const v = await evaluate('.page-link@a@href', { html: PL_HTML, baseUrl: 'http://www.miaobige.cc/107/107609/' }, 'toc', 'value')
    expect(v.kind).toBe('list')
    expect(v.kind === 'list' ? v.items : []).toEqual(['/107/107609/index_1.html', '/107/107609/index_2.html'])
  })
  it('自身与后代同时命中时，自身排在全部后代之前', () => {
    const nested = cheerio.load('<div id="w" class="box">外<div class="box" id="i">内</div></div>')
    const v = evalCss(seg('.box'), nested, nested('#w') as any, loc(0, '@css:.box'), 'toc') as any
    expect(v.nodes.toArray().map((n: any) => n.attribs.id)).toEqual(['w', 'i'])
  })
  it('自身不匹配时行为不变：仍只出后代、仍文档序', () => {
    const v = evalCss(seg('.page-link'), p$, p$('ul.pages') as any, loc(0, '@css:.page-link'), 'toc') as any
    expect(v.nodes).toHaveLength(3)
  })
})

describe('! 排除语法（求值层：官方「!是排除，0 是第1个，负数为倒数」）', () => {
  const segEx = (selector: string, exclude: number[]) => ({ kind: 'css', selector, exclude }) as any
  it('li!0 → 3 个 li 去掉第 1 个 = 2 个', () => {
    const v = evalCss(segEx('li', [0]), $, root(), loc(0, 'li!0'), 'toc')
    expect(v.kind).toBe('nodes')
    expect((v as any).nodes).toHaveLength(2)
    expect((v as any).nodes.eq(0).text()).toContain('第二章')
  })
  it('负数排除：li!-1 去掉最后一个', () => {
    const v = evalCss(segEx('li', [-1]), $, root(), loc(0, 'li!-1'), 'toc')
    expect((v as any).nodes).toHaveLength(2)
    expect((v as any).nodes.eq(1).text()).toContain('第二章')
  })
  it('多值排除 li!0:2 → 只剩第 2 个', () => {
    const v = evalCss(segEx('li', [0, 2]), $, root(), loc(0, 'li!0:2'), 'toc')
    expect((v as any).nodes).toHaveLength(1)
    expect((v as any).nodes.text()).toContain('第二章')
  })
  it('排除后为空 → Miss（不是崩溃）', () => {
    const v = evalCss(segEx('li', [0, 1, 2]), $, root(), loc(0, 'li!0:1:2'), 'toc')
    expect(v.kind).toBe('miss')
  })
})

/**
 * jsoup 的 `[attr~=regex]`——库里 26 处这么写：`[property~=category|status|update_time]`、
 * `[property~=las?test_chapter_name]`、`[property~=image]`、`[href~=/read/\d+]`、
 * `[style~=width:100%;]`（`s?` 的可选与 `a|b|c` 的择一只有**正则**读法讲得通）。
 * 标准 CSS 的 `~=` 是「属性值按空白分词后含该词」，拿它比 `og:novel:category` 恒不命中；
 * 本仓选择器引擎走标准 CSS，故在求值前把 `~=` 谓词摘出来按正则筛（jsoup 的口径）。
 */
describe('jsoup 的 [attr~=regex]（正则匹配，不是 CSS 的词表包含）', () => {
  const h = `<html><head>
    <meta property="og:novel:category" content="都市">
    <meta property="og:novel:latest_chapter_name" content="第9章 收尾">
    <meta property="og:image" content="https://x/cover.jpg">
  </head><body><ul><li><a href="/read/123.html">第一章</a><a href="/other/1.html">别的</a></li></ul></body></html>`
  const $h = cheerio.load(h)
  const hroot = () => $h('html') as any

  it('择一正则（category|status|update_time）命中', () => {
    const v = evalCss(seg('meta[property~=category|status|update_time]'), $h, hroot(), loc(0, 'meta[property~=…]'), 'detail')
    expect(v.kind).toBe('nodes')
    expect((v as any).nodes).toHaveLength(1)
    expect((v as any).nodes.attr('content')).toBe('都市')
  })

  it('可选字符正则（las?test_chapter_name）命中', () => {
    const v = evalCss(seg('meta[property~=las?test_chapter_name]'), $h, hroot(), loc(0, 'meta[property~=…]'), 'detail')
    expect((v as any).nodes.attr('content')).toBe('第9章 收尾')
  })

  it('路径正则（a[href~=/read/\\d+]）只留命中项', () => {
    // 用 String.raw 保住正则里的 `\d`（普通字符串里 `'\d'` 会被 JS 吃成 `d`）
    const sel = String.raw`a[href~=/read/\d+]`
    const v = evalCss(seg(sel), $h, hroot(), loc(0, 'a[href~=…]'), 'toc')
    expect((v as any).nodes).toHaveLength(1)
    expect((v as any).nodes.attr('href')).toBe('/read/123.html')
  })

  it('正则不匹配 → 零命中 Miss（不是把属性值当词表比）', () => {
    const v = evalCss(seg('meta[property~=og:novel:title]'), $h, hroot(), loc(0, 'meta[property~=…]'), 'detail')
    expect(v.kind).toBe('miss')
  })

  it('非法正则 → RuleEvalError（选择器写错如实报，不静默零命中）', () => {
    expect(() => evalCss(seg('meta[property~=(]'), $h, hroot(), loc(0, 'meta[property~=(]'), 'detail')).toThrow(RuleEvalError)
  })
})
