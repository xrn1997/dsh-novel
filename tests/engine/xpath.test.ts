import { describe, expect, it } from 'vitest'
import { load } from 'cheerio'
import { evalXPath } from '../../src/engine/xpath.js'
import { UnsupportedRuleError } from '../../src/engine/errors.js'

// 样本取自真实源包（630 源 274 条 XPath 规则的代表性形态）；fixture 规整化以钉死语义
const html = `<html><body>
<div id="sitebox">
  <dl class="book"><dt><a href="/book/1/">书一</a></dt><dd class="info">作者甲</dd></dl>
  <dl class="book"><dt><a href="/book/2/">书二</a></dt><dd class="info">作者乙</dd></dl>
  <dl class="book"><dt><a href="/book/3/">书三</a></dt><dd class="info">作者丙</dd></dl>
</div>
<div id="ddbox"><dd class="d">dd甲</dd><dd class="d">dd乙</dd><dd class="d">dd丙</dd></div>
<div id="infobox"><dd class="info">朋甲</dd><dd class="info">朋乙</dd><dd class="info">朋丙</dd></div>
<ul class="vodlist"><li class="v1"><a href="/v/1">影一</a></li><li class="v2"><a href="/v/2">影二</a></li></ul>
<div id="allchapter">
  <dd><a href="/c/1.html">第一章 起点</a></dd>
  <dd><a href="/c/2.html">第二章 转折</a></dd>
  <dd><a href="/c/3.html">第三章 高潮</a></dd>
</div>
<div class="bookbox"><span class="bookname"><a href="/b/9">斗罗大陆</a></span>
  <span class="author">作者：唐家三少</span><span class="update">简介：玄幻大作</span></div>
<meta property="og:novel:author" content="唐家三少"/>
<meta property="og:title" content="斗罗大陆"/>
<div id="pagelist"><input value="/p=1"/><input value="/p=2"/><input value="/p=3"/></div>
<a id="next" href="/toc/2.html">下一页</a>
<a href="/read/9.html">阅读</a>
<div id="content"><p>第一段正文</p><p>第二段正文</p><span>尾段</span></div>
<ul class="novel_list"><li class="novel_li">甲</li><li class="other">乙</li></ul>
<div id="reader"><div class="hint"><span>上一章</span></div><div class="bar"><div class="row"><div class="cell"><a id="pgnext" href="/p/2">下页</a></div></div></div></div>
<ul class="vols"><li class="deep">甲<span><b><a href="/v/7">链</a></b></span></li><li class="flat">乙<span>无链接</span></li></ul>
<ul class="pages"><li><a id="pgcur" href="/p/1">本页</a></li><li><a href="/v/8">影八</a></li><li><a href="/v/9">影九</a></li></ul>
</body></html>`

const $ = load(html)
const root = () => $.root().children().first() as any
const L = { segmentIndex: 0, segmentRaw: '//x' }
const evalX = (path: string, cur?: any) => evalXPath({ kind: 'xpath', path }, $, cur ?? root(), L, 'search' as const)

const texts = (v: any): string[] => (v.kind === 'list' ? v.items : v.kind === 'value' ? [v.text] : [])

describe('XPath 子集：路径与末段（真实样本）', () => {
  it(' //*[@id="sitebox"]/dl —— id 谓词 + 子步 → nodes', () => {
    const v = evalX('//*[@id="sitebox"]/dl')
    expect(v.kind).toBe('nodes')
    expect((v as any).nodes).toHaveLength(3)
  })
  it(' //dt/a/@href —— 末段属性提取（从候选元素读属性，不是过滤子节点）', () => {
    expect(texts(evalX('//dt/a/@href'))).toEqual(['/book/1/', '/book/2/', '/book/3/'])
  })
  it(' //dd[2]/text() —— 位置谓词按父分组（真 XPath 语义：每父第 2 个 dd）', () => {
    // #ddbox 与 #infobox 各有 3 个 dd → 各取第 2；dl/allchapter 内单 dd 无第 2
    expect(texts(evalX('//dd[2]/text()'))).toEqual(['dd乙', '朋乙'])
  })
  it(' //*[@id="content"]/p/text() —— 多节点多文本', () => {
    expect(texts(evalX('//*[@id="content"]/p/text()'))).toEqual(['第一段正文', '第二段正文'])
  })
  it(' //*[@id="content"]//text() —— 双斜杠取全部后代文本', () => {
    expect(texts(evalX('//*[@id="content"]//text()'))).toEqual(['第一段正文', '第二段正文', '尾段'])
  })
  it(' //*[contains(@class, "bookname")]/a/text() —— contains + 文本', () => {
    expect(texts(evalX('//*[contains(@class, "bookname")]/a/text()'))).toEqual(['斗罗大陆'])
  })
  it(' //ul[contains(@class,"vodlist")]/li —— 元素末段 → nodes（可继续链）', () => {
    const v = evalX('//ul[contains(@class,"vodlist")]/li')
    expect(v.kind).toBe('nodes')
    expect((v as any).nodes).toHaveLength(2)
  })
  it(' //a[text()="阅读"]/@href —— text() 等值谓词', () => {
    expect(texts(evalX('//a[text()="阅读"]/@href'))).toEqual(['/read/9.html'])
  })
  it(' //*[@id="pagelist"]/*[position()>1]/@value —— 通配 + position()', () => {
    expect(texts(evalX('//*[@id="pagelist"]/*[position()>1]/@value'))).toEqual(['/p=2', '/p=3'])
  })
  it(' //*[@id="allchapter"]//dd[a] —— 后代步 + 子元素存在谓词', () => {
    const v = evalX('//*[@id="allchapter"]//dd[a]')
    expect((v as any).nodes).toHaveLength(3)
  })
  it(' //a[contains(text(), "下一页")]/@href —— contains(text())', () => {
    expect(texts(evalX('//a[contains(text(), "下一页")]/@href'))).toEqual(['/toc/2.html'])
  })
  it(' //*[@id="next" and contains(text(), "下一页")]/@href —— and 组合', () => {
    expect(texts(evalX('//*[@id="next" and contains(text(), "下一页")]/@href'))).toEqual(['/toc/2.html'])
  })
  it(' //meta[@property="og:novel:author"]/@content —— meta 属性', () => {
    expect(texts(evalX('//meta[@property="og:novel:author"]/@content'))).toEqual(['唐家三少'])
  })
  it(' .//a/text() —— 相对路径在上下文节点内作用域（条目内取值）', () => {
    const item = evalX('//ul[@class="novel_list"]/li') as any
    const v = evalXPath({ kind: 'xpath', path: './/a/text()' }, $, item.nodes.eq(0), L, 'toc')
    // li 内无 a → Miss（作用域正确，不外溢到全文档）
    expect(v.kind).toBe('miss')
    const dt = evalX('//dl') as any
    const v2 = evalXPath({ kind: 'xpath', path: './/a/@href' }, $, dt.nodes.eq(0), L, 'toc')
    expect(texts(v2)).toEqual(['/book/1/'])
  })
})

describe('XPath 子集：轴与函数（真实样本低频形态）', () => {
  it(' following-sibling 轴', () => {
    expect(texts(evalX('//dd[contains(@class,"info") and contains(text(),"朋")][1]/following-sibling::dd[1]/text()'))).toEqual(['朋乙'])
  })
  it(' preceding-sibling 轴（逆向轴：位置按逆文档序编号——[1]=最近前序）', () => {
    // 真 XPath：//dd[..#3]/preceding-sibling::dd[1] = 最近的前序兄弟「朋乙」；[last()] = 最远的「朋甲」
    expect(texts(evalX('//dd[contains(@class,"info") and contains(text(),"朋")][3]/preceding-sibling::dd[1]/text()'))).toEqual(['朋乙'])
    expect(texts(evalX('//dd[contains(@class,"info") and contains(text(),"朋")][3]/preceding-sibling::dd[last()]/text()'))).toEqual(['朋甲'])
  })
  it(' starts-with / not / position()=last()', () => {
    expect(texts(evalX('//a[starts-with(@href, "/book/2")]/@href'))).toEqual(['/book/2/'])
    // 所有 dd 都有 class 的容器（#ddbox/#infobox）无命中；#allchapter 的 dd 无 class → 命中 3
    const v = evalX('//dd[not(@class)]')
    expect(v.kind).toBe('nodes')
    expect((v as any).nodes).toHaveLength(3)
    // position()=last() 按父分组：每个 dt 的最后一个 a（各 dt 仅一个 a）→ 全部
    expect(texts(evalX('//dt/a[position()=last()]/@href'))).toEqual(['/book/1/', '/book/2/', '/book/3/'])
  })
  it(' 单引号/双引号字面量等价', () => {
    expect(texts(evalX("//meta[@property='og:title']/@content"))).toEqual(['斗罗大陆'])
  })
})

describe('XPath：与引擎链协作', () => {
  it(' xpath 段产出 nodes 可被后续 css/取值段消费（混链形态）', async () => {
    const { evaluate } = await import('../../src/engine/index.js')
    const v = await evaluate('//ul[contains(@class,"vodlist")]@css:li>a@text', { html: $.html()! }, 'toc' as any)
    expect(v.kind === 'list' || v.kind === 'value').toBe(true)
    expect(v.kind === 'value' ? v.text : (v as any).items.join(',')).toContain('影一')
  })
  it(' ## 替换尾与 XPath 组合（真实样本：作者：xx##作者：）', async () => {
    const { evaluate } = await import('../../src/engine/index.js')
    const v = await evaluate('//span[contains(@class,"author")]/text()##作者：', { html: $.html()! }, 'search' as any)
    expect(v.kind === 'list' || v.kind === 'value').toBe(true)
    expect(v.kind === 'value' ? v.text : (v as any).items.join('')).toContain('唐家三少')
    expect(v.kind === 'value' ? v.text : (v as any).items.join('')).not.toContain('作者：')
  })
})

describe('XPath 父步 `..`（真机新暴露：本机库 2 源 4 条规则、两种形态，2026-09 步骤普查）', () => {
  // 真源原文：//a[text()="下一页"]/../../../preceding-sibling::div[1]（正文）
  //          //a[text()="下一页"]/../following-sibling::li/a（目录）
  it(' 三级父步后接逆向兄弟轴：preceding-sibling::div[1] = 最近前序兄弟', () => {
    const v = evalX('//a[@id="pgnext"]/../../../preceding-sibling::div[1]')
    expect(v.kind).toBe('nodes')
    expect((v as any).nodes.text().trim()).toBe('上一章')
  })
  it(' 两级父步后接正向兄弟轴再接子步 → 该 li 之后的兄弟 li 的 a（节点集，目录面形态）', () => {
    const v = evalX('//a[@id="pgcur"]/../following-sibling::li/a')
    expect(v.kind).toBe('nodes')
    expect((v as any).nodes.toArray().map((n: any) => n.attribs.href)).toEqual(['/v/8', '/v/9'])
  })
  it(' 单父步取父元素；父步后接属性末段 = 提取父的属性', () => {
    expect((evalX('//a[@id="pgnext"]/..') as any).nodes.attr('class')).toBe('cell')
    expect(texts(evalX('//a[@id="pgnext"]/../@class'))).toEqual(['cell'])
  })
  it(' 攀过文档根：文档节点不是元素 → 零命中 Miss（不猜成 html）', () => {
    expect(evalX('//a[@id="next"]/../../..').kind).toBe('miss')
  })
  it(' 父步上的谓词按分组生效：..[1] 仍取到父（单元素组第 1 个）', () => {
    expect((evalX('//a[@id="pgnext"]/..[1]') as any).nodes.attr('class')).toBe('cell')
  })
})

describe('XPath：宁炸不猜的边界', () => {
  it(' 未支持函数（count/sum 等）→ UnsupportedRuleError', () => {
    expect(() => evalX('//dd[count(a)>0]')).toThrow(UnsupportedRuleError)
  })
  it(' 未支持轴（ancestor 等）→ UnsupportedRuleError', () => {
    expect(() => evalX('//a[1]/ancestor::div/@id')).toThrow(UnsupportedRuleError)
  })
  it(' 属性步在末段 = 提取（文档序全量）', () => {
    const v = evalX('//a/@href')   // 文档序：sitebox(3) → vodlist(2) → allchapter(3) → bookbox(1) → next/阅读(2) → reader/pages(3)
    expect(texts(v)).toEqual(['/book/1/', '/book/2/', '/book/3/', '/v/1', '/v/2', '/c/1.html', '/c/2.html', '/c/3.html', '/b/9', '/toc/2.html', '/read/9.html', '/p/2', '/v/7', '/p/1', '/v/8', '/v/9'])
  })
  it(' 空路径/畸形 → UnsupportedRuleError', () => {
    expect(() => evalX('//')).toThrow(UnsupportedRuleError)
    expect(() => evalX('//dd[unclosed')).toThrow(UnsupportedRuleError)
  })
})

describe('相对路径存在性谓词（li[.//a] 一类，真源 搬山人小说网 ruleChapterList）', () => {
  const vols = '//ul[@class=\'vols\']'
  it('.//a 命中「后代里有 a」的 li（直系谓词 [a] 命不中，差的就是这一层）', () => {
    const v = evalX(`${vols}/li[.//a]`)
    expect(v.kind).toBe('nodes')
    expect((v as any).nodes.length).toBe(1)
    expect((v as any).nodes.text()).toContain('甲')
    expect(evalX(`${vols}/li[a]`).kind).toBe('miss')
  })
  it('谓词里的路径可以带属性步：[.//a/@href] = 后代里有带 href 的 a', () => {
    const v = evalX(`${vols}/li[.//a/@href]`)
    expect(v.kind).toBe('nodes')
    expect((v as any).nodes.length).toBe(1)
  })
  it('与 and/@attr 组合照常走（谓词树递归复用同一求值）', () => {
    const v = evalX(`${vols}/li[.//a and @class]`)
    expect((v as any).nodes.length).toBe(1)
    expect(evalX(`${vols}/li[not(.//a)]`).kind).toBe('nodes')
  })
  it('谓词内 // 起步如实抛（文档根绝对轴不在本求值器的上下文里）', () => {
    expect(() => evalX(`${vols}/li[//a]`)).toThrow(/谓词路径起步不支持/)
  })
})
