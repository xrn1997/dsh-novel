import { describe, expect, it } from 'vitest'
import * as cheerio from 'cheerio'
import { evalDefault } from '../../src/engine/select.js'

const html = `<div id="wrap"><ul class="list">
  <li class="item"><a href="/b/1">第一章 起点</a><span class="date">2024-01-01</span></li>
  <li class="item"><a href="/b/2">第二章 转折</a><span class="date">2024-01-02</span></li>
  <li class="item odd"><a href="/b/3">第三章 高潮</a><span class="date">2024-01-03</span></li>
</ul><div id="meta"><p>作者：甲</p><p>字数：10万</p></div></div>`

// 修正说明：evalDefault 的第 2 个参数是 $（CheerioAPI），
// 供函数内部重建节点集 / 逐节点取值。
const $ = cheerio.load(html)
const root = () => $('#wrap') as any
const loc = (i: number, raw: string) => ({ segmentIndex: i, segmentRaw: raw })

describe('链首裸取值终端的上下文（真源 ruleToc.chapterName = "text"）', () => {
  it('整篇取一次文本，不是逐祖先各出一份', async () => {
    const { evaluate } = await import('../../src/engine/evaluate.js')
    const v = await evaluate('text', { html: '<div id="c"><a href="/1.html">第1章 蜕变</a></div>' }, 'toc')
    const items = v.kind === 'list' ? v.items : v.kind === 'value' ? [v.text] : []
    expect(items).toEqual(['第1章 蜕变'])
  })
})

describe('default 选择段', () => {
  it('class / tag / id / child / children', () => {
    const v = evalDefault({ kind: 'default', mode: 'class', arg: 'item', index: null }, $, root(), loc(0, 'class.item'), 'toc')
    expect(v.kind).toBe('nodes'); expect((v as any).nodes).toHaveLength(3)
    const v2 = evalDefault({ kind: 'default', mode: 'id', arg: 'meta', index: null }, $, root(), loc(1, 'id.meta'), 'toc')
    expect((v2 as any).nodes).toHaveLength(1)
    const v3 = evalDefault({ kind: 'default', mode: 'child', arg: 'ul', index: null }, $, root(), loc(2, 'child.ul'), 'toc')
    expect((v3 as any).nodes).toHaveLength(1)
    const v4 = evalDefault({ kind: 'default', mode: 'tag', arg: 'li', index: null }, $, root(), loc(3, 'tag.li'), 'toc')
    expect((v4 as any).nodes).toHaveLength(3)
    const v5 = evalDefault({ kind: 'default', mode: 'children', arg: null, index: null }, $, root(), loc(4, 'children'), 'toc')
    expect((v5 as any).nodes).toHaveLength(2)
  })
  it('零命中选择 → Miss', () => {
    const v = evalDefault({ kind: 'default', mode: 'class', arg: 'nope', index: null }, $, root(), loc(0, 'class.nope'), 'toc')
    expect(v.kind).toBe('miss')
  })
  it('位置索引：正/负/越界', () => {
    const at = (index: any) => evalDefault({ kind: 'default', mode: 'class', arg: 'item', index }, $, root(), loc(0, 'x'), 'toc')
    expect((at({ kind: 'index', value: 0 }) as any).nodes).toHaveLength(1)
    expect((at({ kind: 'index', value: -1 }) as any).nodes[0].attribs.class).toContain('odd')
    expect(at({ kind: 'index', value: 5 }).kind).toBe('miss')     // 越界不抛 → Miss
    expect(at({ kind: 'index', value: -9 }).kind).toBe('miss')   // 负数越界同样 → Miss
  })
  it('切片半开区间，越界裁剪', () => {
    const v = evalDefault({ kind: 'default', mode: 'class', arg: 'item', index: { kind: 'slice', from: 1, to: 99 } }, $, root(), loc(0, 'x'), 'toc')
    expect((v as any).nodes).toHaveLength(2)                       // [1,99) → 裁到末尾
    const neg = evalDefault({ kind: 'default', mode: 'class', arg: 'item', index: { kind: 'slice', from: -2, to: null } }, $, root(), loc(0, 'x'), 'toc')
    expect((neg as any).nodes).toHaveLength(2)                     // 负 from 从尾数
  })
  it('切片裁空（原集合非空）→ Miss（选择失败语义——空 List 不是节点集，中链必抛）', () => {
    const v = evalDefault({ kind: 'default', mode: 'class', arg: 'item', index: { kind: 'slice', from: 5, to: 99 } }, $, root(), loc(0, 'x'), 'toc')
    expect(v.kind).toBe('miss')
  })
})

describe('default 取值段', () => {
  it('单节点 href → Value；多节点 → List', () => {
    const lis = evalDefault({ kind: 'default', mode: 'class', arg: 'item', index: { kind: 'index', value: 0 } }, $, root(), loc(0, 'class.item.0'), 'toc') as any
    const href = evalDefault({ kind: 'default', mode: 'href', arg: null, index: null }, $, lis.nodes, loc(1, 'href'), 'toc')
    expect(href).toEqual({ kind: 'value', text: '/b/1' })          // 原样属性值，引擎不拼绝对 URL
    // 链首 $('*') 上下文（片段求值的 @href 裸规则）：html/body 包装元素不向下兜底——
    // 否则三份同值 → \n 拼接 → URL 解析剥换行拼成 /x.html/x.html/x.html 事故（真实源回归）
    const $frag = cheerio.load('<a href="/read/49/45792/1.html">内容简介</a>')
    const fragAll = $frag('*') as any
    const fragHref = evalDefault({ kind: 'default', mode: 'href', arg: null, index: null }, $frag, fragAll, loc(1, 'href'), 'toc')
    expect(fragHref).toEqual({ kind: 'list', items: ['/read/49/45792/1.html'] }) // 单值，无包装元素重复
    // li 上 @href → 内层 a 的兜底语义保留（钉死）
    const $li = cheerio.load('<li><a href="/x/2">章</a></li>')
    const liOnly = $li('li') as any
    const liHref = evalDefault({ kind: 'default', mode: 'href', arg: null, index: null }, $li, liOnly, loc(1, 'href'), 'toc')
    expect(liHref).toEqual({ kind: 'value', text: '/x/2' })
    const all = evalDefault({ kind: 'default', mode: 'class', arg: 'item', index: null }, $, root(), loc(0, 'class.item'), 'toc') as any
    // 章节名在 <a> 内：显式 select 到 tag.a 再取 text（推荐写法，源里也这么写）
    const as = evalDefault({ kind: 'default', mode: 'tag', arg: 'a', index: null }, $, all.nodes, loc(1, 'tag.a'), 'toc') as any
    const texts = evalDefault({ kind: 'default', mode: 'text', arg: null, index: null }, $, as.nodes, loc(2, 'text'), 'toc')
    expect(texts).toEqual({ kind: 'list', items: ['第一章 起点', '第二章 转折', '第三章 高潮'] })
    // 直接对 li 取 text：legado/Jsoup 口径 = 全部后代文本，故 <a> 与 <span> 的文本都在（粘连：
    // Jsoup 只在块级元素间补空格，行内元素之间不补——这里与 legado 同形，想要纯章名就 select 到 a）
    const liText = evalDefault({ kind: 'default', mode: 'text', arg: null, index: null }, $, all.nodes, loc(1, 'text'), 'toc')
    expect(liText).toEqual({ kind: 'list', items: ['第一章 起点2024-01-01', '第二章 转折2024-01-02', '第三章 高潮2024-01-03'] })
  })
  it('零节点取值 → Miss', () => {
    const none = $('.nope') as any
    const v = evalDefault({ kind: 'default', mode: 'text', arg: null, index: null }, $, none, loc(0, 'text'), 'toc')
    expect(v.kind).toBe('miss')
  })
  it('取值段位置索引越界 → Miss（不回退全集）', () => {
    const all = evalDefault({ kind: 'default', mode: 'class', arg: 'item', index: null }, $, root(), loc(0, 'class.item'), 'toc') as any
    const v = evalDefault({ kind: 'default', mode: 'text', arg: null, index: { kind: 'index', value: 9 } }, $, all.nodes, loc(1, 'text'), 'toc')
    expect(v.kind).toBe('miss')
  })
  it('取值段切片裁空 → Miss（与选择段同口径；此前分叉给空 List）', () => {
    const all = evalDefault({ kind: 'default', mode: 'class', arg: 'item', index: null }, $, root(), loc(0, 'class.item'), 'toc') as any
    const v = evalDefault({ kind: 'default', mode: 'text', arg: null, index: { kind: 'slice', from: 5, to: 9 } }, $, all.nodes, loc(1, 'text'), 'toc')
    expect(v.kind).toBe('miss')
  })
  it('text 清洗：全角空格与连续空白', () => {
    const $p = cheerio.load('<p>你　好\n\n  世界</p>')
    const v = evalDefault({ kind: 'default', mode: 'text', arg: null, index: null }, $p, $p('p') as any, loc(0, 'text'), 'content')
    expect(v).toEqual({ kind: 'value', text: '你 好 世界' })
  })
  it('html（内层）/ all（outerHTML）/ content（属性原样）', () => {
    const li = evalDefault({ kind: 'default', mode: 'class', arg: 'item', index: { kind: 'index', value: 0 } }, $, root(), loc(0, 'x'), 'toc') as any
    const h = evalDefault({ kind: 'default', mode: 'html', arg: null, index: null }, $, li.nodes, loc(1, 'html'), 'toc')
    expect(h).toEqual({ kind: 'value', text: '<a href="/b/1">第一章 起点</a><span class="date">2024-01-01</span>' })
    const a = evalDefault({ kind: 'default', mode: 'all', arg: null, index: null }, $, li.nodes, loc(2, 'all'), 'toc') as any
    expect(a.text).toContain('<li class="item">')
    expect(a.text).toContain('</li>')
    const $m = cheerio.load('<meta name="d" content="C1">')
    const c = evalDefault({ kind: 'default', mode: 'content', arg: null, index: null }, $m, $m('meta') as any, loc(3, 'content'), 'detail')
    expect(c).toEqual({ kind: 'value', text: 'C1' })
  })
  it('属性缺失取到空 → List{[]}（合法空，区别于 Miss）', () => {
    const span = $('#wrap .date') as any
    const v = evalDefault({ kind: 'default', mode: 'src', arg: null, index: null }, $, span, loc(0, 'src'), 'toc')
    expect(v).toEqual({ kind: 'list', items: [] })
  })
  it('text 取后代文本（li 内的 <a> 也算）；ownText 严格直系 → List{[]}', () => {
    // legado/Jsoup 口径：element.text() 含全部后代；ownText 才是直系。
    // （曾按「text 亦直系」实现——真实源打不动：笔趣阁正文 `.con@text` 而 .con 里全是 <p>）
    const all = evalDefault({ kind: 'default', mode: 'class', arg: 'item', index: null }, $, root(), loc(0, 'class.item'), 'toc') as any
    const t = evalDefault({ kind: 'default', mode: 'text', arg: null, index: null }, $, all.nodes, loc(1, 'text'), 'toc')
    expect(t).toEqual({ kind: 'list', items: ['第一章 起点2024-01-01', '第二章 转折2024-01-02', '第三章 高潮2024-01-03'] })
    const own = evalDefault({ kind: 'default', mode: 'ownText', arg: null, index: null }, $, all.nodes, loc(2, 'ownText'), 'toc')
    expect(own).toEqual({ kind: 'list', items: [] })
  })
  it('对 Value 套选择段 → RuleEvalError', () => {
    const val: any = { kind: 'value', text: 'x' }
    expect(() => evalDefault({ kind: 'default', mode: 'class', arg: 'a', index: null }, $, val, loc(0, 'class.a'), 'toc')).toThrow(/不是节点集/)
  })
})

// 第 4 组断言：text / textAll / textNodes / ownText 四者差别
describe('text / textAll / textNodes / ownText 区分', () => {
  const $p = cheerio.load('<p>外<b>内</b>尾</p>')
  const p = () => $p('p') as any
  const get = (mode: string) => evalDefault({ kind: 'default', mode, arg: null, index: null }, $p, p(), loc(0, mode), 'content')

  it('text 取全部后代文本（legado/Jsoup element.text() 口径）', () => {
    expect(get('text')).toEqual({ kind: 'value', text: '外内尾' })
  })
  it('ownText 只取直系文本节点（排除 <b> 内文本）', () => {
    expect(get('ownText')).toEqual({ kind: 'value', text: '外尾' })
  })
  it('textAll 取全部后代文本（归一为单行，与 text 只差分段）', () => {
    expect(get('textAll')).toEqual({ kind: 'value', text: '外内尾' })
  })
  it('textNodes 取全部文本节点的文本列表', () => {
    expect(get('textNodes')).toEqual({ kind: 'list', items: ['外', '内', '尾'] })
  })
  it('text 块级边界落成换行（正文按 \\n 分段；cheerio .text() 会拼成一整行）', () => {
    const $c = cheerio.load('<div class="con"><h1>第2章 斗气大陆</h1><p>月如银盘，漫天繁星。</p><p>山崖之颠。</p></div>')
    const v = evalDefault({ kind: 'default', mode: 'text', arg: null, index: null }, $c, $c('.con') as any, loc(0, 'text'), 'content')
    // 笔趣阁（bqquge）真实形态：.con 里全是 <p> —— 直系文本为空，只有后代文本有内容
    expect(v).toEqual({ kind: 'value', text: '第2章 斗气大陆\n月如银盘，漫天繁星。\n山崖之颠。' })
  })
})
