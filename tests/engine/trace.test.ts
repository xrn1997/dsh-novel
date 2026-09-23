import { describe, expect, it } from 'vitest'
import { evaluate, evaluateWithTrace } from '../../src/engine/index.js'
import type { EvalContext } from '../../src/engine/index.js'
import { parseRule } from '../../src/engine/parse.js'   // 内部 seam 直引（卡10 barrel 收窄：parse 不再是对外承诺）

const searchHtml = `<div><ul>
  <li class="book"><a class="name" href="/book/1">凡人修仙传</a><span class="author">忘语</span></li>
  <li class="book"><a class="name" href="/book/2">仙逆</a><span class="author">耳根</span></li>
</ul></div>`

describe('evaluateWithTrace 端到端', () => {
  it('bookList→name 链，trace 每段一行', async () => {
    const t = await evaluateWithTrace('@css:li.book@css:.name@text', { html: searchHtml }, 'search')
    expect(t.value).toEqual({ kind: 'list', items: ['凡人修仙传', '仙逆'] })
    expect(t.steps.map(s => s.segmentKind)).toEqual(['css', 'css', 'default'])
    expect(t.steps[0].hits).toBe(2)
    expect(t.steps[2].preview).toContain('凡人')
  })
  it('|| 短路：首分支 miss 走次分支', async () => {
    const t = await evaluateWithTrace('@css:.nope@text||@css:.name@text', { html: searchHtml }, 'search')
    expect(t.value).toEqual({ kind: 'list', items: ['凡人修仙传', '仙逆'] })
    expect(t.steps[0].error?.code).toBeUndefined()   // css 零命中是 miss，不是 error——miss 在 steps 里以 hits=0 呈现
    expect(t.steps[0].hits).toBe(0)
  })
  it('链尾 (…) 不当 js 改写（对面从不切它：这条形态与 text下一页 同族，如实失败）', async () => {
    // 对面 `SourceRule.init` 只在 @js:/<js>/@XPath:/@Json: 等前缀上定模式，`RuleAnalyzer.splitRule`
    // 遇 `(` 是跳过平衡组；Default 链末段整串落进 `getResultLast` 的 `else -> attr(lastRule)` → 取空。
    // 本仓曾把 (…) 当链尾 js 表达式（detectTailJs），实测会把耽美小说 `/text()` 切碎；已移除。
    // 移除后这条形态落到「认不出的末段」——与 `text下一页` 同族，抛错而不是静默改写值。
    await expect(evaluateWithTrace('class.name@text(result.replace(/凡人/,"某凡"))', { html: searchHtml }, 'search'))
      .rejects.toThrow(/text\(result\.replace/)
  })
  it('段级错误定位：未知语法在 trace 中带索引与原文（取"构不成选择器"的形态——`词.词` 已按对面兜底交 CSS）', async () => {
    await expect(evaluateWithTrace('@css:.x@weird$.thing', { html: searchHtml }, 'toc')).rejects.toThrow(/段1/)
  })
  it('AllInOne + 反序', async () => {
    const page = '<a href="/c/1.html">第一章</a><a href="/c/2.html">第二章</a>'
    const t = await evaluateWithTrace('-:href="(/c/[^"]*)">([^<]*)', { html: page }, 'toc')
    expect((t.value as any).rows[0][1]).toBe('第二章')
    expect(t.reverse).toBe(true)
  })
  it('独立净化形态：##a##b 以整页原文为基值', async () => {
    const t = await evaluateWithTrace('##搜索.*手机访问|##', { html: '<p>正文</p>搜索.手机访问' }, 'content')
    // 基值 = ctx.html 原文，净化后原样给出（不再走 DOM all 分支）
    expect(t.value).toEqual({ kind: 'value', text: '<p>正文</p>' })
  })
  it('独立净化：无 html 时以 String(ctx.json) 为基值', async () => {
    const t = await evaluateWithTrace('##X##|##', { json: 'X净化Y' }, 'content')
    expect(t.value).toEqual({ kind: 'value', text: '|净化Y' })
  })
  it('纯 @js 首段在 JSON-only 页：result 取整页原文（pageText），非空', async () => {
    // 订正：首段 @js 曾只见 ctx.html ?? ''，JSON 源（无 html）拿到空 result
    const t = await evaluateWithTrace('@js:return result.length>0?"有内容":"空"', { json: { a: 1 } }, 'content')
    expect(t.value).toEqual({ kind: 'value', text: '有内容' })
  })
})

describe('@put / @get 链语义', () => {
  it('@put 是副作用段：写 vars 且链值透传，后续取值照常', async () => {
    const ctx: EvalContext = { html: searchHtml }
    const v = await evaluate('class.book@put:{x:"1"}@css:.name@text', ctx, 'search')
    expect(v).toEqual({ kind: 'list', items: ['凡人修仙传', '仙逆'] })
    expect(ctx.vars?.x).toBe('1')
  })
  it('@get 产出存储值（合法替换链值）', async () => {
    const ctx: EvalContext = { html: searchHtml, vars: { bid: '123' } }
    expect(await evaluate('@get:bid', ctx, 'search')).toEqual({ kind: 'value', text: '123' })
  })
})

describe('evaluate 总装（引擎语义复查）', () => {
  it('Miss ≠ 空列表：css 零命中链透传 Miss；取位失败（索引越界）也是 Miss；合法零条目才是空 List', async () => {
    const miss = await evaluate('@css:.nope@text', { html: searchHtml }, 'search')
    expect(miss.kind).toBe('miss')
    // 取值段索引全越界 = 取位失败 → Miss（与选择段 reducePicked 同口径；此前误判「合法空 List」）。
    // 用单个 .name 的确定页面：`.5:9` 对面逐个越界 → 集合空 → Miss。
    const empty = await evaluate('@css:.name@text.5:9', { html: '<p class="name">甲</p>' }, 'search')
    expect(empty.kind).toBe('miss')
    // 合法零条目：元素在、取值全空（属性缺失/ownText 无直系文本）→ 空 List
    const legit = await evaluate('@css:.name@ownText', { html: '<p class="name"></p>' }, 'search')
    expect(legit).toEqual({ kind: 'list', items: [] })
  })
  it('越界不抛：位置索引越界 → Miss', async () => {
    const v = await evaluate('@css:.name@text.5', { html: searchHtml }, 'search')
    expect(v.kind).toBe('miss')
  })
  it('AllInOne 二维产物不压平：matches.rows 原样透出', async () => {
    const page = '<a href="/c/1.html">第一章</a><a href="/c/2.html">第二章</a>'
    const v = (await evaluate(':href="(/c/[^"]*)">([^<]*)', { html: page }, 'toc')) as any
    expect(v.kind).toBe('matches')
    expect(v.rows).toEqual([
      ['/c/1.html', '第一章'],
      ['/c/2.html', '第二章'],
    ])
  })
  it('jsonpath 中链：节点集上游如实求值错；Value 上游按 JSON 求值（上游修复后 legado 语义）', async () => {
    // 节点集不是 JSON → 求值期如实 RuleEvalError（此前在解析期以「非分支首位」预拒——
    // legado fork 对 JS 返回对象不分发 Mode 的快捷路径是上游已修复的 bug，TS 按修复后语义走）
    await expect(evaluate('@css:.name@json:$..x', { html: searchHtml, json: {} }, 'search'))
      .rejects.toThrow(/无法按 JSON 求值/)
    // 「js 返回对象再取字段」形态现在合法：<js> 产出 JSON 文本 → 中链 jsonpath 按 JSON 求值
    const v = await evaluate('<js>JSON.stringify({a:{b:7}})</js>$.a.b', { html: '' }, 'search')
    expect(v).toEqual({ kind: 'value', text: '7' })
  })
  it('选择段接在取值结果上 → RuleEvalError（不是节点集）', async () => {
    await expect(evaluate('@css:.name@text@css:.x', { html: searchHtml }, 'search'))
      .rejects.toThrow(/不是节点集/)
  })
  it('evaluate(ParsedRule) 直通不重 parse：改 AST 后结果随动', async () => {
    const parsed = parseRule('@css:.name@text', 'search')
    // 若直通路径重 parse（原始串 .name），结果仍是 name 列表；改 AST 为 .author 后结果必须变
    parsed.branches[0].segments[0] = { kind: 'css', selector: '.author' }
    parsed.branches[0].raws[0] = 'css:.author'
    const v = await evaluate(parsed, { html: searchHtml })
    expect(v).toEqual({ kind: 'list', items: ['忘语', '耳根'] })
  })
})

describe('JSONPath 对 JSON 文本（html 回退）——搜索链路只传 html 不传 json 的真实场景', () => {
  // legado 口径：isJSON = content.toString().isJson() → JsonPath.parse(content)。
  // 我们的搜索链路只喂 ctx.html（JSON 源的 body 是 JSON 字符串、ctx.json 缺席），
  // 引擎必须在 ctx.json 缺席时回退解析 ctx.html，否则所有 $. 规则对 JSON API 源恒 Miss。
  const apiBody = '{"data":[{"name":"凡人修仙传","author":"忘语"},{"name":"仙逆","author":"耳根"}]}'

  it('$.data[*] 对 html 里的 JSON 文本求值（json 缺席回退）', async () => {
    // jsonpath 段必须首位；List 终值即每条 JSON.stringify 后的字符串
    const v = await evaluate('$.data[*]', { html: apiBody }, 'search')
    expect(v).toEqual({ kind: 'list', items: ['{"name":"凡人修仙传","author":"忘语"}', '{"name":"仙逆","author":"耳根"}'] })
  })

  it('ctx.json 显式给时仍优先（回退不覆盖显式）', async () => {
    const v = await evaluate('$.data[*]', { html: '<p>非JSON</p>', json: { data: [{ name: 'A' }] } }, 'search')
    expect(v).toEqual({ kind: 'list', items: ['{"name":"A"}'] })
  })

  it('html 非 JSON 文本 → JSONPath 如实 Miss（不误解析、不抛）', async () => {
    const v = await evaluate('$.data', { html: '<div>普通HTML</div>' }, 'search')
    expect(v.kind).toBe('miss')
  })

  it('html 是非法 JSON（{ 开头但解析失败）→ Miss 不抛', async () => {
    const v = await evaluate('$.data', { html: '{"data": [破损' }, 'search')
    expect(v.kind).toBe('miss')
  })
})

describe('对面兜底口径的行为面（解析过≠取对值：钉的是求值结果）', () => {
  const boxHtml = '<div><span class="T-R-T-B2-Box1">甲</span><clasd class="T-R-T-B2-Box1">乙</clasd><p>丙</p></div>'
  it('`词.词` 当 CSS 求值：非标签首词一样命中元素（对面 select 同款）', async () => {
    const t = await evaluateWithTrace('clasd.T-R-T-B2-Box1@text', { html: boxHtml }, 'detail', 'value')
    expect(t.value).toEqual({ kind: 'value', text: '乙' })
  })
  it('中文 tag 选择器零命中 → Miss（对面同样取空，但本仓不再在解析期判死整条）', async () => {
    const t = await evaluateWithTrace('option@value||text下一页@href', { html: '<option value="V1">x</option>' }, 'toc', 'value')
    expect(t.value).toEqual({ kind: 'value', text: 'V1' })
  })
})
