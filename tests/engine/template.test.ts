import { describe, expect, it } from 'vitest'
import { interpolateUrl, isPlaceholderExpr, expandPageAngleList } from '../../src/engine/template.js'

describe('URL 模板插值', () => {
  it('基础替换', () => {
    expect(interpolateUrl('/search?q={{key}}&page={{page}}', { key: '凡人', page: 2 }))
      .toBe('/search?q=%E5%87%A1%E4%BA%BA&page=2')
  })
  it('|| 兜底', () => {
    expect(interpolateUrl('https://x/{{key||home}}', {})).toBe('https://x/home')
    expect(interpolateUrl('https://x/{{key||home}}', { key: 'a' })).toBe('https://x/a')
  })
  it('未知变量保留原文', () => {
    expect(interpolateUrl('/s?k={{key}}', {})).toBe('/s?k={{key}}')
  })
  it('特殊字符做 URI 编码', () => {
    expect(interpolateUrl('/s?q={{key}}', { key: 'a b&c' })).toBe('/s?q=a%20b%26c')
  })
  it('原型链成员名保留原文（`in` 走原型链会把 Object.prototype 成员当变量值）', () => {
    expect(interpolateUrl('/s?k={{toString}}', {})).toBe('/s?k={{toString}}')
    expect(interpolateUrl('/s?k={{constructor}}', {})).toBe('/s?k={{constructor}}')
    expect(interpolateUrl('/s?k={{__proto__}}', {})).toBe('/s?k={{__proto__}}')
  })
})

// 「是不是占位」= 标识符 **且** 在 vars 里或带 `||` 兜底——搜索面照它决定走 JS 求值还是原样编码。
// 只看词法（旧口径）会把源级 jsLib 定义的全局也当占位（`{{host}}` 得间小说实证：404）。
describe('isPlaceholderExpr', () => {
  it('vars 里的标识符与带 || 兜底的形态是占位', () => {
    expect(isPlaceholderExpr('key', { key: 'x', page: 1 })).toBe(true)
    expect(isPlaceholderExpr('key||home', {})).toBe(true)
  })
  it('裸标识符但不在 vars 里 → 不是占位（交给沙箱按 JS 求值，jsLib 全局靠这条）', () => {
    expect(isPlaceholderExpr('host', { key: 'x', page: 1 })).toBe(false)
    expect(isPlaceholderExpr('baseUrl', { key: 'x' })).toBe(false)
  })
  it('JS 表达式与原型链成员名都不是占位', () => {
    expect(isPlaceholderExpr('java.encodeURI(key)', { key: 'x' })).toBe(false)
    expect(isPlaceholderExpr('page*2', { page: 1 })).toBe(false)
    expect(isPlaceholderExpr('toString', {})).toBe(false)
  })
})

describe('expandPageAngleList（`<a,b,c>` 按页取值）', () => {
  it('page=1 取首项（真源恩京的书房：首项是空串 ⇒ 整段消失）', () => {
    expect(expandPageAngleList('/<,page/2/>?s=k', 1)).toBe('/?s=k')
  })
  it('page<N 取第 page 项；越界取末项（= 到底）', () => {
    expect(expandPageAngleList('/<,p2,p3/>', 2)).toBe('/p2')
    expect(expandPageAngleList('/<,p2,p3/>', 3)).toBe('/p3/')
    expect(expandPageAngleList('/<,p2,p3/>', 9)).toBe('/p3/')
  })
  it('page 为空（未参与翻页）⇒ 原样不动（对面整段在 page?.let 里）', () => {
    expect(expandPageAngleList('/<,p2/>', null)).toBe('/<,p2/>')
    expect(expandPageAngleList('/<,p2/>', undefined)).toBe('/<,p2/>')
  })
  it('多个不同匹配各自替换、同一匹配全量替换（Kotlin replace 替全部）', () => {
    expect(expandPageAngleList('/<a,b>/<a,b>/<c,d>', 2)).toBe('/b/b/d')
  })
  it('项两侧空白剥掉（trim { it <= \x27 \x27 }）', () => {
    expect(expandPageAngleList('/< x , y >', 2)).toBe('/y')
  })
})
