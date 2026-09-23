import { describe, expect, it } from 'vitest'
import * as cheerio from 'cheerio'
import type { Element } from 'domhandler'
import { combine, reverseList } from '../../src/engine/combine.js'
import type { EngineValue } from '../../src/engine/types.js'
import { UnsupportedRuleError } from '../../src/engine/errors.js'

describe('|| 首个非空', () => {
  it('miss 跳过，空 list 跳过', () => {
    expect(combine([{ kind: 'miss', detail: 'x' }, { kind: 'value', text: '乙' }], 'first'))
      .toEqual({ kind: 'value', text: '乙' })
    expect(combine([{ kind: 'list', items: [] }, { kind: 'value', text: '乙' }], 'first'))
      .toEqual({ kind: 'value', text: '乙' })
  })
  it('全 miss → miss', () => {
    expect(combine([{ kind: 'miss', detail: 'a' }, { kind: 'miss', detail: 'b' }], 'first').kind).toBe('miss')
  })
  it('全空 list（无 miss）→ 空 list，不折叠成 miss', () => {
    expect(combine([{ kind: 'list', items: [] }, { kind: 'list', items: [] }], 'first'))
      .toEqual({ kind: 'list', items: [] })
  })
  it('matches 透传', () => {
    const m: EngineValue = { kind: 'matches', rows: [['a', 'b']] }
    expect(combine([{ kind: 'miss', detail: 'x' }, m], 'first')).toEqual(m)
  })
})

describe('&& 合并', () => {
  it('全 value → \\n 连接的 value', () => {
    expect(combine([{ kind: 'value', text: '甲' }, { kind: 'value', text: '乙' }], 'and'))
      .toEqual({ kind: 'value', text: '甲\n乙' })
  })
  it('混合 → 摊平 list；miss 分支静默跳过（legado 语义：&& 是多规则取并集，非全命中）', () => {
    expect(combine([{ kind: 'value', text: '甲' }, { kind: 'list', items: ['乙', '丙'] }], 'and'))
      .toEqual({ kind: 'list', items: ['甲', '乙', '丙'] })
    // legado AnalyzeByJSoup：`if (!temp.isNullOrEmpty()) results.add(temp)`——miss 分支不参与合并
    expect(combine([{ kind: 'value', text: '甲' }, { kind: 'miss', detail: 'x' }], 'and'))
      .toEqual({ kind: 'value', text: '甲' })
  })
  it('全 miss/空 → miss', () => {
    expect(combine([{ kind: 'miss', detail: 'a' }, { kind: 'list', items: [] }], 'and').kind).toBe('miss')
  })
  it('matches 透传（不摊平、不丢弃）', () => {
    const m: EngineValue = { kind: 'matches', rows: [['a', 'b']] }
    expect(combine([m], 'and')).toEqual(m)
  })
  it('多分支混合 matches → UnsupportedRuleError（宁炸不猜，不得用 Miss 冒充失败）', () => {
    const m: EngineValue = { kind: 'matches', rows: [['a', 'b']] }
    expect(() => combine([m, m], 'and')).toThrow(UnsupportedRuleError)
  })
  it('&& 列表用途合并节点集（对面 getElements 的 addAll），不再把节点丢成空列表', () => {
    // 对面列表路径每个分支产出 Elements，`&&` 走 `elements.addAll(es)` —— 节点是**在场的数据**。
    // 本仓此前在合并里只认 value/list 两种 kind，节点分支什么也不贡献：
    // `tag.li&&tag.ul`（3 个 li + 1 个 ul）合并成空 List ⇒ 目录整块消失，且不带任何错误。
    const $ = cheerio.load('<ul><li>A</li><li>B</li><li>C</li></ul>')
    const a: EngineValue = { kind: 'nodes', nodes: $('li') }
    const b: EngineValue = { kind: 'nodes', nodes: $('ul') }
    const v = combine([a, b], 'and', { usage: 'list' })
    expect(v.kind).toBe('nodes')
    if (v.kind !== 'nodes') return
    expect(v.nodes.toArray().map((n) => (n as Element).name)).toEqual(['li', 'li', 'li', 'ul'])
  })
  it('&& 列表用途混节点与字符串 → UnsupportedRuleError（宁炸，不静默丢其中一侧）', () => {
    const $ = cheerio.load('<ul><li>A</li></ul>')
    expect(() => combine([{ kind: 'nodes', nodes: $('li') }, { kind: 'value', text: '乙' }], 'and', { usage: 'list' }))
      .toThrow(UnsupportedRuleError)
  })
})

describe('%% 交叉合并', () => {
  it('驱动长度 = **首个参与分支**的长度（对面 results[0].indices），更长分支的尾项不产出', () => {
    // 本仓此前循环到 maxLen，把 b2x 也带出来：对面 `for (i in results[0].indices)` 只走第一支的长度，
    // 尾项**被丢弃**——交叉合并的产物长度由第一支决定，这是规则作者用来对齐条数的机制。
    const v = combine([
      { kind: 'list', items: ['a1', 'a2'] },
      { kind: 'list', items: ['b1', 'b2', 'b2x'] },
      { kind: 'list', items: ['c1'] },
    ], 'zip')
    expect(v).toEqual({ kind: 'list', items: ['a1', 'b1', 'c1', 'a2', 'b2'] })
  })
  it('首支为空时由下一个非空支驱动（取值路径 results 只收非空分支）', () => {
    expect(combine([
      { kind: 'list', items: [] },
      { kind: 'list', items: ['b1', 'b2'] },
      { kind: 'value', text: 'c1' },
    ], 'zip')).toEqual({ kind: 'list', items: ['b1', 'c1', 'b2'] })
  })
  it('列表用途：节点集交叉合并后仍是节点集；首支为空 ⇒ 整体为空（对面 elementsList[0]）', () => {
    const $ = cheerio.load('<ul><li class="a">A1</li><li class="a">A2</li><li class="b">B1</li><li class="b">B2</li></ul>')
    const v = combine([{ kind: 'nodes', nodes: $('li.a') }, { kind: 'nodes', nodes: $('li.b') }], 'zip', { usage: 'list' })
    expect(v.kind).toBe('nodes')
    if (v.kind !== 'nodes') return
    expect(v.nodes.toArray().map((n) => $(n).text())).toEqual(['A1', 'B1', 'A2', 'B2'])
    // 对面列表路径把**每个**分支结果都收进 elementsList（空的也收），驱动长度取 elementsList[0]
    const emptyFirst = combine([
      { kind: 'nodes', nodes: $('li.nope') },
      { kind: 'nodes', nodes: $('li.b') },
    ], 'zip', { usage: 'list' })
    expect(emptyFirst.kind).toBe('miss')
  })
  it('miss 分支静默跳过（legado 语义：results 只收非空分支）', () => {
    expect(combine([{ kind: 'list', items: ['a'] }, { kind: 'miss', detail: 'x' }], 'zip'))
      .toEqual({ kind: 'list', items: ['a'] })
  })
  it('全 miss → miss', () => {
    expect(combine([{ kind: 'miss', detail: 'a' }, { kind: 'miss', detail: 'b' }], 'zip').kind).toBe('miss')
  })
  it('zip 遇 matches（AllInOne 2-D）→ UnsupportedRuleError（宁炸不猜）', () => {
    expect(() => combine([{ kind: 'list', items: ['a'] }, { kind: 'matches', rows: [['x']] }], 'zip'))
      .toThrow(UnsupportedRuleError)
  })
})

describe('反序', () => {
  it('list 反序，value 不动', () => {
    expect(reverseList({ kind: 'list', items: ['a', 'b', 'c'] })).toEqual({ kind: 'list', items: ['c', 'b', 'a'] })
    expect(reverseList({ kind: 'value', text: 'x' })).toEqual({ kind: 'value', text: 'x' })
  })
  it('matches 行反序，miss 原样', () => {
    expect(reverseList({ kind: 'matches', rows: [['a'], ['b']] }))
      .toEqual({ kind: 'matches', rows: [['b'], ['a']] })
    expect(reverseList({ kind: 'miss', detail: 'x' })).toEqual({ kind: 'miss', detail: 'x' })
  })
  it('nodes 节点集反序', () => {
    const $ = cheerio.load('<ul><li id="a">一</li><li id="b">二</li><li id="c">三</li></ul>')
    const v = reverseList({ kind: 'nodes', nodes: $('li') })
    expect(v.kind).toBe('nodes')
    if (v.kind !== 'nodes') return
    expect(v.nodes.toArray().map((n) => (n as Element).attribs.id)).toEqual(['c', 'b', 'a'])
  })
})
