import { describe, expect, it } from 'vitest'
import { evaluate } from '../../src/engine/index.js'

/**
 * **取值用途（usage='value'）下链尾剩节点集**的口径。
 *
 * legado 侧这条从不报错：`AnalyzeRule.getString` 走完段循环后无条件把结果转成字符串
 * （末尾 `if (result == null) result = ""` 再 `result.toString()`），而 XPath 模式在
 * **段内**就完成转换——`AnalyzeByXPath.getString` 取到的命中集按换行拼接，每个节点
 * `toString()` = jsoup `Element.toString()` = **outerHtml**。
 * 真实源靠它的两例（2026-09 正文链路审计）：爱丽丝书屋的 `ruleSearch.intro`
 * 选 `//p` 忘写 `/text()`、搬山人小说网的 `ruleSearch.intro` 选 `//div/p` 同样忘写
 * ——都是「选了元素当值用」的写法。
 *
 * 本仓原口径是在服务层 `firstValue` 抛 `RuleEvalError('结果不是取值而是节点集')`
 * （规约层，`segmentIndex: -1`），把一条能出值的规则记成引擎侧失败。现在按对面收敛：
 * 节点集在链终点按对面串化，抛错只留给真正的取位失败（Miss）。
 */

const page = `<div class="box">
  <p class="content-txt">第一段简介</p>
  <ul><li class="t">第一章</li><li class="t">第二章</li></ul>
</div>`

describe('取值用途的链终点节点集（legado getString 串化口径）', () => {
  it('XPath 段收尾且只命中一个元素 → 该元素 outerHTML（真源 intro 形态）', async () => {
    const v = await evaluate(`//p[@class='content-txt']`, { html: page }, 'search', 'value')
    expect(v).toEqual({ kind: 'value', text: '<p class="content-txt">第一段简介</p>' })
  })

  it('XPath 段收尾多命中 → 逐元素 outerHTML 以换行拼接（对面按换行 join）', async () => {
    const v = await evaluate(`//li[@class='t']`, { html: page }, 'search', 'value')
    expect(v).toEqual({ kind: 'value', text: '<li class="t">第一章</li>\n<li class="t">第二章</li>' })
  })

  it('列表用途（usage="list"）不变：仍以节点集收尾，供逐条目再求值', async () => {
    const v = await evaluate(`//li[@class='t']`, { html: page }, 'toc', 'list')
    expect(v.kind).toBe('nodes')
  })

  it('串化发生在 ## 替换之前（对面 replaceRegex 作用于已串化的结果）', async () => {
    const v = await evaluate(`//li[@class='t']##<[^>]*>##`, { html: page }, 'search', 'value')
    expect(v).toEqual({ kind: 'value', text: '第一章\n第二章' })
  })

  it('Miss 仍是 Miss：链上取位失败不会被串化成空 HTML', async () => {
    const v = await evaluate(`//p[@class='nope']`, { html: page }, 'search', 'value')
    expect(v.kind).toBe('miss')
  })
})
