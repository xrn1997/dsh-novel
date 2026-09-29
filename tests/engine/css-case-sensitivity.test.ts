/**
 * **钉住本仓 CSS 求值「大小写敏感」这一现状**（矩阵 `a-css-case-insensitive-match`，open）。
 * 给 open 行钉测试是因为这条分歧**改与不改都是决定**，两种都必须是有意识的：本仓把选择器原样交
 * cheerio，对面走 jsoup——**jsoup 对类名与属性值忽略大小写**（2026-09-28 本机 JDK 实测），同一张
 * fixture 上对面 `.Foo` 多命中一个元素。
 * 两条断言**成对**：`.Foo` 与 `.foo` 各只能命中一个，谁改成不敏感就双双拿到 2 个 → 全红——同时
 * 排除「整体小写化」与「整体大写化」两种偷懒实现。
 */
import { describe, expect, it } from 'vitest'
import { evaluate } from '../../src/engine/evaluate.js'

const HTML = '<div id="v1" class="Foo BAR" data-kind="Chapter">a</div>'
  + '<div id="v2" class="foo bar" data-kind="chapter">b</div>'

const ids = (v: any): string[] => (v?.kind === 'nodes' ? v.nodes.toArray().map((e: any) => e.attribs?.id) : [])

describe('CSS 类名与属性值的大小写敏感性（本仓 = 敏感；对面 jsoup = 不敏感）', () => {
  it('.Foo 只命中 class 里真有 Foo 的那个元素', async () => {
    const v = await evaluate('.Foo', { html: HTML }, 'toc')
    expect(ids(v)).toEqual(['v1'])
  })

  it('.foo 只命中 class 里真有 foo 的那个元素（与上一条合起来挡住"整体忽略大小写"的改动）', async () => {
    const v = await evaluate('.foo', { html: HTML }, 'toc')
    expect(ids(v)).toEqual(['v2'])
  })

  it('[data-kind=Chapter] 与 =chapter 各自只命中一个', async () => {
    expect(ids(await evaluate('[data-kind=Chapter]', { html: HTML }, 'toc'))).toEqual(['v1'])
    expect(ids(await evaluate('[data-kind=chapter]', { html: HTML }, 'toc'))).toEqual(['v2'])
  })
})
