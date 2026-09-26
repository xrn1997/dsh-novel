import { describe, expect, it } from 'vitest'
import { parseRule } from '../../src/engine/parse.js'
import { UnsupportedRuleError } from '../../src/engine/errors.js'

describe('② ## 替换尾剥离', () => {
  it('净化形态：取值规则 + 两个替换步', () => {
    const p = parseRule('@css:.articleDiv p@textNodes##搜索.*手机访问|##')
    expect(p.branches[0].segments).toHaveLength(2)
    expect(p.replaces).toEqual([{ pattern: '搜索.*手机访问|', flags: '', replacement: '' }])
    expect(p.onlyOne).toBe(false)
  })
  it('OnlyOne 形态以 ### 结尾', () => {
    const p = parseRule('##:author"[^"]+"([^"]*)##$1###')
    expect(p.onlyOne).toBe(true)
    expect(p.replaces).toEqual([{ pattern: ':author"[^"]+"([^"]*)', flags: '', replacement: '$1' }])
    // 以 ## 开头 → 前面没有取值规则，词法层记为「独立净化」（branches 为空，求值时对 all 结果替换）
    expect(p.branches).toHaveLength(0)
  })
  it('连续多个替换步', () => {
    const p = parseRule('all##a##b##c##d')
    expect(p.replaces).toHaveLength(2)
  })
})

describe('③ - 反序前缀', () => {
  it('链首 - 剥为 reverse 标志，且不误伤负索引', () => {
    const p = parseRule('-class.item@text')
    expect(p.reverse).toBe(true)
    expect(p.branches[0].segments[0]).toEqual({ kind: 'default', mode: 'class', arg: 'item', index: null })
    const p2 = parseRule('class.item.-1@text')   // 段内负索引不是反序
    expect(p2.reverse).toBe(false)
    expect((p2.branches[0].segments[0] as any).index).toEqual({ kind: 'index', value: -1 })
  })
})

describe('④⑤ 分支与段切分', () => {
  it('|| 切分两分支', () => {
    const p = parseRule('class.odd.0@tag.a.0@text||tag.dd.0@tag.h1@text')
    expect(p.combinator).toBe('first')
    expect(p.branches).toHaveLength(2)
    expect(p.branches[1].segments[0]).toEqual({ kind: 'default', mode: 'tag', arg: 'dd', index: { kind: 'index', value: 0 } })
  })
  it('&& → and，%% → zip', () => {
    // 组合符分支测试用白名单词（text）作操作数——裸词透传例外已废除
    expect(parseRule('text&&text').combinator).toBe('and')
    expect(parseRule('text%%text').combinator).toBe('zip')
  })
  it('混用算符抛 UnsupportedRuleError', () => {
    expect(() => parseRule('a||b&&c')).toThrow(UnsupportedRuleError)
  })
})

describe('⑥ 段识别', () => {
  it('default 选择与取值段', () => {
    const s = parseRule('@css:.x@class.odd.2@text').branches[0].segments
    expect(s[1]).toEqual({ kind: 'default', mode: 'class', arg: 'odd', index: { kind: 'index', value: 2 } })
    expect(s[2]).toEqual({ kind: 'default', mode: 'text', arg: null, index: null })
  })
  it('位置后缀：all / 负索引 / 冒号索引列表（对面 indexDefault 逐个收集，冒号不是区间符）', () => {
    const segs = parseRule('tag.a.all@tag.a.-2@tag.a.1:5').branches[0].segments
    expect((segs[0] as any).index).toEqual({ kind: 'all' })
    expect((segs[1] as any).index).toEqual({ kind: 'index', value: -2 })
    expect((segs[2] as any).index).toEqual({
      kind: 'multi',
      entries: [{ kind: 'index', value: 1 }, { kind: 'index', value: 5 }],
    })
  })
  it('css / jsonpath / AllInOne 识别', () => {
    expect(parseRule('@css:li.clearfix').branches[0].segments[0].kind).toBe('css')
    expect(parseRule('$.info.Datas').branches[0].segments[0]).toEqual({ kind: 'jsonpath', path: '$.info.Datas' })
    expect(parseRule('$.chapter.body').branches[0].segments[0].kind).toBe('jsonpath')
    const a = parseRule(':href="(/read[^"]*html)">([^<]*)').branches[0].segments[0] as any
    expect(a.kind).toBe('allinone')
    expect(a.pattern).toBe('href="(/read[^"]*html)">([^<]*)')
  })
  it('put / getvar 识别', () => {
    expect(parseRule('@put:{bid:"123"}').branches[0].segments[0]).toEqual({ kind: 'put', pairsRaw: '{bid:"123"}' })
    // 体内 @ 不是段界（`@put:{…}` 在任何切分之前先整块剥离）——
    // 真实源 ruleBookInfo.init 形态 @put:{n:"[property$=x]@content", …} 曾被撕成六段
    const put = parseRule('@put:{n:"[property$=book_name]@content", a:"[property$=author]@content"}@get:n')
    expect(put.branches[0].segments[0]).toEqual({
      kind: 'put',
      pairsRaw: '{n:"[property$=book_name]@content", a:"[property$=author]@content"}',
    })
    expect(put.branches[0].segments[1]).toEqual({ kind: 'getvar', name: 'n' })

    expect(parseRule('@get:bid').branches[0].segments[0]).toEqual({ kind: 'getvar', name: 'bid' })
    // 花括号形态（`@get:{…}` 也是合法写法——真实源详情面整条规则就是 `@get:{n}`）
    expect(parseRule('@get:{n}').branches[0].segments[0]).toEqual({ kind: 'getvar', name: 'n' })
  })
  it('js 三种形态；@js: 吞链尾、<js> 块可非末位', () => {
    const s = parseRule('@css:.x@text@js:result.replace(/a/,"b")').branches[0].segments
    expect(s[2]).toMatchObject({ kind: 'js', form: 'at-js' })
    const s2 = parseRule('<js>result + "!"</js>').branches[0].segments[0]
    expect(s2).toMatchObject({ kind: 'js', form: 'inline' })
    // @js: 在链首 → 吞掉整条链（代码里的 @ / || / && 是 JS 代码不是段界/连接符——真实源形态）
    const s3 = parseRule('@js:var k = key || "";\nreturn k + "@" + page;').branches[0].segments
    expect(s3).toHaveLength(1)
    expect(s3[0]).toMatchObject({ kind: 'js', form: 'at-js' })
    // <js> 块后接选择段（无 @ 分隔）→ 块独立成段，后续起新段（真实源 `<js>…</js>.card-body` 形态）
    const s4 = parseRule('<js>result.replace(/x/,"")</js>.card-body').branches[0].segments
    expect(s4).toHaveLength(2)
    expect(s4[0]).toMatchObject({ kind: 'js', form: 'inline' })
    expect(s4[1]).toMatchObject({ kind: 'css', selector: '.card-body' })
  })
  it('不认识的段抛错且带段索引与原文（用构不成选择器的形态：含 `$`）', () => {
    try { parseRule('@css:.x@frobnicate$.thing', 'toc'); expect.unreachable() }
    catch (e) {
      expect(e).toBeInstanceOf(UnsupportedRuleError)
      expect((e as UnsupportedRuleError).segmentIndex).toBe(1)
      expect((e as UnsupportedRuleError).segmentRaw).toBe('frobnicate$.thing')
      expect((e as UnsupportedRuleError).facet).toBe('toc')
    }
  })
  it('白名单外的段在**解析期**定性：构成选择器的即 css 段，构不成的仍当场抛（都不留到 eval 才炸）', () => {
    // 白名单外的段交 CSS 选择：`nonsense.x` 落到选择器上是
    // 「tag=nonsense + class=x」，不是认不出。本仓此前抛错、把读得出的规则判死。
    const ok = parseRule('nonsense.x', 'toc')
    expect(ok.branches[0].segments[0]).toMatchObject({ kind: 'css', selector: 'nonsense.x' })
    // 真认不出的（`$` 不是 CSS 标识符字符）依旧在解析期 UnsupportedRuleError——
    // 被否决的替代方案「裸词透传留到求值期」仍然成立：错误类与阶段都不能挪。
    try { parseRule('nonsense$.x', 'toc'); expect.unreachable() }
    catch (e) {
      expect(e).toBeInstanceOf(UnsupportedRuleError)
      expect((e as UnsupportedRuleError).segmentIndex).toBe(0)
      expect((e as UnsupportedRuleError).segmentRaw).toBe('nonsense$.x')
      expect((e as UnsupportedRuleError).facet).toBe('toc')
    }
  })
})

// ── 真实源方言扩展（官方文档+社区知识库考证；616 broken 归因驱动）──────────

describe('大小写不敏感特殊前缀（真实源有 @CSS:/@JS: 大写形态）', () => {
  it('@CSS: / @Json: / @JS: 与小写同义', () => {
    expect(parseRule('@CSS:table.x tr').branches[0].segments[0].kind).toBe('css')
    expect(parseRule('@JSON:$.a.b').branches[0].segments[0].kind).toBe('jsonpath')
    expect(parseRule('@css:.x@JS:result+"!"').branches[0].segments[1]).toMatchObject({ kind: 'js', form: 'at-js' })
  })
})

describe('隐式 CSS 回落（官方简写：class.x≡.x、id.x≡#x；社区考证裸词=tag 选择器）', () => {
  it('#id / .class 简写 → css 段', () => {
    expect(parseRule('#page@div[itemscope]').branches[0].segments[0]).toEqual({ kind: 'css', selector: '#page' })
    expect(parseRule('.txt-list@li').branches[0].segments[0]).toEqual({ kind: 'css', selector: '.txt-list' })
  })
  it('裸 tag 词（li/a/div）→ css 段（class.list@a ≡ .list a——59 条失败的根因）', () => {
    expect(parseRule('class.list@a').branches[0].segments[1]).toEqual({ kind: 'css', selector: 'a' })
    expect(parseRule('li').branches[0].segments[0]).toEqual({ kind: 'css', selector: 'li' })
  })
  it('tag+属性选择器 → css 段', () => {
    expect(parseRule('div[itemscope]@text').branches[0].segments[0]).toEqual({ kind: 'css', selector: 'div[itemscope]' })
  })
  it('tag.类 组合 → css 段（189 条真实规则；首词是合法 HTML 标签）', () => {
    expect(parseRule('li.chapter').branches[0].segments[0]).toEqual({ kind: 'css', selector: 'li.chapter' })
    expect(parseRule('div.ncp3li_title@text').branches[0].segments[0]).toEqual({ kind: 'css', selector: 'div.ncp3li_title' })
    expect(parseRule('a.list-group-item||a[href*=x]').branches[0].segments[0]).toEqual({ kind: 'css', selector: 'a.list-group-item' })
  })
  it('tag+伪类/空白组合 → css 段（a:contains(x)、li:first-child a——Jsoup/legado 常用）', () => {
    expect(parseRule('a:contains(在线阅读)@href').branches[0].segments[0])
      .toEqual({ kind: 'css', selector: 'a:contains(在线阅读)' })
    expect(parseRule('li:first-child a').branches[0].segments[0])
      .toEqual({ kind: 'css', selector: 'li:first-child a' })
    expect(parseRule('div:has(img)@text').branches[0].segments[0])
      .toEqual({ kind: 'css', selector: 'div:has(img)' })
  })
  it('词.词形态按对面兜底交 CSS（首词不是合法标签也算——`weirdsyntax.x`）', () => {
    expect(parseRule('weirdsyntax.x@text', 'content', 'value').branches[0].segments[0])
      .toMatchObject({ kind: 'css', selector: 'weirdsyntax.x' })
  })
  it('非标签首词的伪类形态仍炸（nonsense:x——宁炸不猜边界不外扩）', () => {
    expect(() => parseRule('nonsense:x@text')).toThrow(UnsupportedRuleError)
  })
})

describe('隐式 CSS 新形态（642 源重探归因驱动）', () => {
  it('选择器 + 位置后缀 → css 段带 index（a.0 = 选 a 再取第 0 个——16 条首条书名为空的根因）', () => {
    expect(parseRule('a.0@text').branches[0].segments[0])
      .toEqual({ kind: 'css', selector: 'a', index: { kind: 'index', value: 0 } })
    expect(parseRule('class.odd.0@tag.a@text').branches[0].segments[0])
      .toEqual({ kind: 'default', mode: 'class', arg: 'odd', index: { kind: 'index', value: 0 } })
    expect(parseRule('td.1:3').branches[0].segments[0])
      .toEqual({
        kind: 'css', selector: 'td',
        index: { kind: 'multi', entries: [{ kind: 'index', value: 1 }, { kind: 'index', value: 3 }] },
      })
  })
  it('后代/子代组合链 → css 段（tbody>tr、dd>h3>a、li.chapter span——Jsoup 常用）', () => {
    expect(parseRule('tbody>tr@text').branches[0].segments[0])
      .toEqual({ kind: 'css', selector: 'tbody>tr' })
    expect(parseRule('dd>h3>a@text').branches[0].segments[0])
      .toEqual({ kind: 'css', selector: 'dd>h3>a' })
    expect(parseRule('li.chapter span').branches[0].segments[0])
      .toEqual({ kind: 'css', selector: 'li.chapter span' })
  })
  it('纯属性选择器 → css 段（[class="col-12 col-md-6"]）', () => {
    expect(parseRule('[class="col-12 col-md-6"]@text').branches[0].segments[0])
      .toEqual({ kind: 'css', selector: '[class="col-12 col-md-6"]' })
  })
  it('选择器特征字符 → css 段（含 `#` `[` `>` `+` `~` `=` `,` 或 `*` 开头即交 css-select 求值）', () => {
    // 放宽的是「哪串字符像选择器」，不是「认不出也不报」：解析不了的形态在求值层如实
    // RuleEvalError（带段定位），不再在解析期误报「无法识别的段类型」
    for (const raw of ['ul#ncp3_ul li', 'a[href*="_"]', 'li[style~=width:100%;]', '*[href]', 'div,span']) {
      expect(parseRule(`${raw}@text`).branches[0].segments[0], raw).toEqual({ kind: 'css', selector: raw })
    }
  })
  it('放宽的边界：无选择器特征的未知串仍在解析期抛（宁炸不猜不外扩）', () => {
    expect(() => parseRule('nonsense span@text')).toThrow(UnsupportedRuleError)  // 空白组合但首词非标签
  })
  it('词.词形态（`tplData.books`）不再判死：对面 select 兜底，命中与否交给文档', () => {
    expect(parseRule('tplData.books@text', 'content', 'value').branches[0].segments[0])
      .toMatchObject({ kind: 'css', selector: 'tplData.books' })
  })
})

describe('! 排除语法（官方：!是排除，序号用 : 隔开，-1 为倒数）', () => {
  it('li!0 → css li + 排除第 1 个', () => {
    expect(parseRule('.txt-list@li!0').branches[0].segments[1]).toEqual({ kind: 'css', selector: 'li', exclude: [0] })
  })
  it('class.x!0:2 多值排除 + 负数', () => {
    const s = parseRule('class.item!0:2@text').branches[0].segments[0] as any
    expect(s).toMatchObject({ mode: 'class', arg: 'item', exclude: [0, 2] })
    const s2 = parseRule('tag.a!-1').branches[0].segments[0] as any
    expect(s2.exclude).toEqual([-1])
  })
})

describe('XPath 识别（// 开头与 @XPath:/@xpath: 前缀——274 条真实规则）', () => {
  it('// 路径 → xpath 段', () => {
    expect(parseRule('//div[@id="x"]/a/@href').branches[0].segments[0])
      .toEqual({ kind: 'xpath', path: '//div[@id="x"]/a/@href' })
  })
  it('@XPath: 前缀（大小写不敏感）→ xpath 段；.// 相对路径保留', () => {
    expect(parseRule('@XPath:.//a/text()').branches[0].segments[0])
      .toEqual({ kind: 'xpath', path: './/a/text()' })
    expect(parseRule('@xpath://dd[2]/text()').branches[0].segments[0])
      .toEqual({ kind: 'xpath', path: '//dd[2]/text()' })
  })
  it('xpath 段与 ## 替换尾组合（真实样本：…text()##作者：）', () => {
    const p = parseRule('//span[@class="a"]/text()##作者：')
    expect(p.branches[0].segments[0].kind).toBe('xpath')
    expect(p.replaces).toEqual([{ pattern: '作者：', flags: '', replacement: '' }])
  })
})

describe('连接符与段界的区域感知（2026-09 全库普查 10/2360 残留里的两条）', () => {
  it('`{{…}}` 内的 `||` 不是连接符：整段留在模板里（英文小说 ruleContent 形态）', () => {
    const p = parseRule('{{@css:.text-content1 .c-en@text||.text-content1@text}}', 'content')
    expect(p.branches).toHaveLength(1)
    expect(p.branches[0].segments[0].kind).toBe('literal')
  })
  it('`{{…}}` 内的 `&&` 同样不切（米读小说 intro 多模板形态）', () => {
    const p = parseRule('前{{a@text}}中{{b@text&&c@text}}后', 'content')
    expect(p.branches).toHaveLength(1)
  })
  it('`</js>` 与 ## 尾之间的孤立换行不成段（世界名著网 ruleBookUrl 实证形态）', () => {
    const p = parseRule('tag.a.0@href\n<js>java.ajax(result)</js>\n##window.location.replace\\("([^"]+)"\\);##$1###', 'detail', 'value')
    expect(p.branches[0].segments.map((s) => s.kind)).toEqual(['default', 'default', 'js'])
  })
  it('连接符切出的**空白分支**被丢弃（对面 splitRule 不过滤空串，空规则取值即空列表，合并时不贡献）', () => {
    // 真源形态（解析面普查第 22 批抓到的 ruleBookInfo.kind）：多行 && 串里夹了 `&&&&`
    const p = parseRule(
      'class.info@class.small@tag.span.4@text&&\nclass.info@class.small@tag.span.1@text&&&&\nclass.info@class.small@tag.span.2@text##分类：|状态：|更新时间：',
      'detail',
      'value',
    )
    expect(p.combinator).toBe('and') // 组合符判定不受丢空影响
    expect(p.branches).toHaveLength(3) // 第四段（`&&&&` 之后到换行）是空白 → 丢
    expect(p.replaces).toHaveLength(1)
  })
  it('整条为空 / 全空白分支 → 与 `rest === \'\'` 同路：零分支，不炸（对面 `getElements("")` 得空列表）', () => {
    for (const r of ['&&', '||', '  \n  ', '%%']) {
      const p = parseRule(r, 'detail', 'value')
      expect(p.branches, r).toEqual([])
    }
  })
  it('`@html##re##`（空替换尾）不被空白段过滤吃掉——真源剥 HTML 注释形态', () => {
    const p = parseRule('.chapter-content@html##<!--[\\s\\S]*?-->##', 'content', 'value')
    const b = p.branches[0]
    expect(b.segments.map((s) => s.kind)).toEqual(['css', 'default'])
    expect(p.replaces).toHaveLength(1)
    expect(p.replaces[0]).toMatchObject({ pattern: '<!--[\\s\\S]*?-->', replacement: '' })
  })
})

describe('XPath 主导链的裸 @ 终端（对面 splitRule 括号感知后在 @ 处切；本仓此前整链吞进 path）', () => {
  it('`//a[@id="x"]/div[1]@html` → xpath 段 + html 终端段（谓词里的 @ 不算段界）', () => {
    const p = parseRule('//a[@id="x"]/div[1]@html', 'content', 'value')
    const segs = p.branches[0].segments
    expect(segs.map((s) => s.kind)).toEqual(['xpath', 'default'])
    expect((segs[0] as any).path).toBe('//a[@id="x"]/div[1]')
  })
  it('斜杠属性步 `//a/@href` 仍整体留在 xpath 段内（求值层已有属性提取，切了反而多一段）', () => {
    const p = parseRule('//a/@href', 'search', 'value')
    expect(p.branches[0].segments.map((s) => s.kind)).toEqual(['xpath'])
  })
  it('`//text()@js:` 混链：js 段照旧切开（SEG_PREFIX 形态不受本条改动影响）', () => {
    const p = parseRule('//div[text()="x"]/text()@js:result+"字"', 'detail', 'value')
    expect(p.branches[0].segments.map((s) => s.kind)).toEqual(['xpath', 'js'])
  })
})

describe('覆盖矩阵补钉：既有抛错口径此前无标题级钉子', () => {
  it('位置索引与 ! 排除并存 → 解析期抛错', () => {
    expect(() => parseRule('class.item.0!1')).toThrow(/位置索引与 ! 排除语法不并存/)
    expect(() => parseRule('class.item.0:2!1')).toThrow(/位置索引与 ! 排除语法不并存/)
  })
  it('@@ 段内剥一个 @ 后按常规识别', () => {
    const p = parseRule('@@css:.x')
    expect(p.branches[0].segments[0]).toEqual({ kind: 'css', selector: '.x' })
  })
})

describe('链尾 (…) 不是 js 形态（对面从不切它）', () => {
  /**
   * 两条依据：① 规则形态判定里 `ruleStr.startsWith("/")` 即整条按 XPath，并把 **原文**当 rule
   * （`/text()` 从头到尾没被再切）；② 分段找分隔符时括号是**平衡组**，跳过而非在 `(` 处切开。
   * Default 链的末尾段是属性读（取不到属性就是空）。
   * 本仓曾把「末元素以 ) 结尾」当 js 表达式形态（`detectTailJs`），真机实证它把
   * 耽美小说 `ruleToc.chapterName: "/text()"` 切成 `/text` + `()` 两段，`() ` 当脚本编译
   * 当场 Unexpected token。全库普查（158 源）里需要这条形态的源为 **0**。
   */
  it('/text() 整条是一个 XPath 段，不产生 js 段', () => {
    const p = parseRule('/text()', 'toc', 'value')
    expect(p.branches[0].segments.length).toBe(1)
    expect(p.branches[0].segments[0].kind).toBe('xpath')
    expect(p.branches[0].segments.some((s) => s.kind === 'js')).toBe(false)
  })

  it('带谓词的 XPath 链尾 text() 同样不切（//select/option/text()）', () => {
    const p = parseRule('//select[@id="s"]/option/text()', 'toc', 'value')
    expect(p.branches[0].segments.length).toBe(1)
    expect(p.branches[0].segments[0]).toMatchObject({ kind: 'xpath' })
  })

  it('@js: 自己带的 (…) 代码不受影响（整串仍是 js 段）', () => {
    const p = parseRule('@js:(function(){return 1})()', 'detail', 'value')
    expect(p.branches[0].segments.length).toBe(1)
    expect(p.branches[0].segments[0]).toMatchObject({ kind: 'js' })
  })
})

describe('单斜杠开头仍是 XPath（与对面 SourceRule.init 同判据）', () => {
  /**
   * 两处判据各管一层，容易混：
   * - **顶层规则** `ruleStr.startsWith("/")` 即整条按 XPath——所以 `/text()`、`/p/text()` 这类
   *   单斜杠规则是 XPath，不是本仓多做的事。
   * - **`{{…}}` 内表达式**的规则/JS 二分只管那一层，那里才只认 `//`。
   * 本仓 classifyExpr 与之逐字对齐（`@` / `$.` / `$[` / `//`），单斜杠在插值里按 JS 走。
   * 现库量：以 `./` 或 `.//` 开头的顶层规则 **0 源**（本仓额外接受 `.//` 是更宽的一侧，无源依赖）；
   * 以单斜杠开头的规则串 84 条，全部是 URL 形态（`{{…}}` 或选项后缀已先行豁免）。
   */
  it('/p/text() 一条 XPath 段，不切成两段也不当默认方言', () => {
    const p = parseRule('/p/text()', 'toc', 'value')
    expect(p.branches[0].segments.length).toBe(1)
    expect(p.branches[0].segments[0]).toMatchObject({ kind: 'xpath', path: '/p/text()' })
  })

  it('.//a 作为顶层规则同样按 XPath 求值（本仓比对面宽的哪一侧写清楚）', () => {
    const p = parseRule('.//a', 'toc', 'value')
    expect(p.branches[0].segments[0]).toMatchObject({ kind: 'xpath', path: './/a' })
  })
})

describe('对面兜底口径：白名单外的段交 CSS、裸索引段等于 children 索引（ElementsSingle 的 else 分支）', () => {
  it('`词.词` 首词不是合法标签 → 当 CSS 选择器，不再解析期抛（真源错字 clasd.T-R-T-B2-Box1）', () => {
    const p = parseRule('clasd.T-R-T-B2-Box1@text', 'detail', 'value')
    expect(p.branches[0].segments.map(s => s.kind)).toEqual(['css', 'default'])
  })
  it('纯数字段仍解析期抛（对面是 children 索引，本仓故意不接：`children` 根上下文另有分叉）', () => {
    // 见矩阵 a-bare-index-segment：等 children/根上下文修好再放行本形态，避免两个缺陷叠加
    expect(() => parseRule('0', 'detail', 'value')).toThrow(UnsupportedRuleError)
  })
  it('`option@value||text下一页@href` 整条可解析：第二支按 tag 选择器求值，不再连坐炸掉能用的第一支', () => {
    const p = parseRule('option@value||text下一页@href', 'toc', 'value')
    expect(p.branches).toHaveLength(2)
    expect(p.combinator).toBe('first')
  })
  it('构不成选择器语法的段仍然抛（放宽不等于全放过）', () => {
    expect(() => parseRule('weird head.x@text', 'detail', 'value')).toThrow(UnsupportedRuleError)
    expect(() => parseRule('nonsense$x@text', 'detail', 'value')).toThrow(UnsupportedRuleError)
  })
})
