/**
 * **jsoup 的文本伪类：`:contains(…)` 忽略大小写、`:containsOwn(…)` 只看元素自己的文本。**
 * 两条都是**对读对面依赖的那个库实测**得到的形状（2026-09-28 本机 JDK 跑 jsoup；版本成色写在
 * 矩阵 `a-css-jsoup-text-pseudos`，不在这里重复）：
 * - `:contains` 在 jsoup 不分大小写、cheerio 分——这条有真实需求方（现量重算走 `DSH_PARSE_CENSUS=1`），
 *   所以按对面语义放宽；
 * - `:containsOwn` cheerio 根本不认识（如实 RuleEvalError），jsoup 有：只比元素直接文本节点。
 *
 * 放宽的代价：同一选择器可能多命中、取位（`.0`）随之变——所以「改选择语义要连带重跑引擎全测 +
 * 一轮真链路审计」（README 那条门的口径）。
 */
import { describe, expect, it } from 'vitest'
import { evaluate } from '../../src/engine/evaluate.js'

const HTML = '<div class="wrap"><ul>'
  + '<li>第一章 Abc</li><li>第二章 xyz</li><li>第三章</li>'
  + '</ul><span class="tag">标题 <b>藏在子节点</b></span></div>'

const hitTags = async (rule: string, html = HTML): Promise<string[]> => {
  const v = await evaluate(rule, { html }, 'toc')
  return v.kind === 'nodes' ? v.nodes.toArray().map((e: any) => String(e.tagName)) : []
}

const hitCount = async (rule: string, html = HTML): Promise<number> => {
  const v = await evaluate(rule, { html }, 'toc')
  return v.kind === 'nodes' ? v.nodes.length : -1
}

describe('jsoup 文本伪类（:contains 不敏感 / :containsOwn 只看自身文本）', () => {
  it(':contains 忽略大小写——同一个词的大写与小写命中同一批元素', async () => {
    expect(await hitCount('.wrap li:contains(Abc)')).toBe(1)
    // 这一条是本次修复的正身：区分大小写时下面这行会零命中 → Miss
    expect(await hitCount('.wrap li:contains(abc)')).toBe(1)
  })

  it(':contains 的引号形态与无引号形态同解', async () => {
    expect(await hitCount('.wrap li:contains("abc")')).toBe(1)
  })

  it(':containsOwn 只看元素自己的文本，子节点里的字不算', async () => {
    // 「藏在子节点」在 <b> 里：查 .tag 的 containsOwn 不该命中，查 b 才命中
    expect(await hitCount('.tag:containsOwn(藏在子节点)')).toBe(-1) // -1 = 非 nodes（Miss）
    expect(await hitCount('.tag b:containsOwn(藏在子节点)')).toBe(1)
    // 自身直接文本才作数
    expect(await hitCount('.tag:containsOwn(标题)')).toBe(1)
    // 取到的必须是 .tag 自己（不是它的某个后代）：条数一样时只有标签名能暴露"选错了元素"。
    expect(await hitTags('.tag:containsOwn(标题)')).toEqual(['span'])
  })

  it(':contains 穿透子节点（与 containsOwn 相对），且命中的是父元素本身', async () => {
    expect(await hitCount('.tag:contains(藏在子节点)')).toBe(1)
    expect(await hitTags('.tag:contains(藏在子节点)')).toEqual(['span'])
  })

  it('零命中仍是 Miss，不静默给空集合冒充成功', async () => {
    expect(await hitCount('.wrap li:contains(没有这个词)')).toBe(-1)
  })

  it('正则式特殊字符按字面比（对面是文本包含，不是正则）', async () => {
    // 对面 jsoup 的 :contains 是**字面**包含；把 `(` 当正则会把这条读成非法/零命中
    const html = '<div class="wrap"><p>价 (议价) 元</p><p>别</p></div>'
    expect(await hitCount('p:contains("(议价)")', html)).toBe(1)
  })
})
