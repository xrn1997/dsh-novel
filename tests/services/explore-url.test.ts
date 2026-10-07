import { describe, expect, it } from 'vitest'
import { exploreKindsFormOf, parseExploreKinds } from '../../src/services/explore-url.js'

describe('exploreUrl 形态判定（优先级 js → JSON → 含 :: 的文本）', () => {
  it('缺席与「去空白后为空」→ empty', () => {
    expect(exploreKindsFormOf(undefined)).toBe('empty')
    expect(exploreKindsFormOf(null)).toBe('empty')
    expect(exploreKindsFormOf('   \n  ')).toBe('empty')
  })
  it('非串的在场值 → unknown（在场但读不出形态，不替源主宣布「没有分类」）', () => {
    expect(exploreKindsFormOf(42)).toBe('unknown')
    expect(exploreKindsFormOf([{ title: '玄幻', url: '/x' }])).toBe('unknown')
    expect(exploreKindsFormOf({ 玄幻: '/x' })).toBe('unknown')
  })
  it('三种前缀各归一档，且优先级写死', () => {
    expect(exploreKindsFormOf('@js:\nresult')).toBe('js')
    expect(exploreKindsFormOf('<js>result</js>')).toBe('js')
    expect(exploreKindsFormOf('  [{"title":"玄幻","url":"/x"}]')).toBe('json')
    expect(exploreKindsFormOf('{"玄幻":"/x"}')).toBe('json')
    expect(exploreKindsFormOf('玄幻::/xuanhuan/{{page}}.html')).toBe('text')
  })
  it('js 档大小写不敏感、允许前导空白（作者手写的大小写与模板换行都算同一形态）', () => {
    expect(exploreKindsFormOf('@JS:result')).toBe('js')
    expect(exploreKindsFormOf('<JS>x</JS>')).toBe('js')
    expect(exploreKindsFormOf('   @js:result')).toBe('js')
    expect(exploreKindsFormOf('\n\n<js>x</js>')).toBe('js')
  })
  it('优先级歧义串两头都按写死的次序归档：js 抢在 JSON 前、JSON 抢在文本前', () => {
    expect(exploreKindsFormOf('@js:[{"title":"a","url":"/b"}]')).toBe('js')
    expect(exploreKindsFormOf('[{"title":"a::b","url":"/c"}]')).toBe('json')
  })
  it('既不是三档、又不是空 → unknown（认不出不猜）', () => {
    expect(exploreKindsFormOf('https://e.com/classify')).toBe('unknown')
  })
})

describe('parseExploreKinds 两档解析', () => {
  it('文本档：分隔符是 (&&|\\n)+，可混用可连续；每条只取 :: 的前两段', () => {
    const { kinds, form } = parseExploreKinds('玄幻::/a\n\n&&都市::/b&&仙侠::/c')
    expect(form).toBe('text')
    expect(kinds).toEqual([
      { title: '玄幻', url: '/a' }, { title: '都市', url: '/b' }, { title: '仙侠', url: '/c' },
    ])
  })
  it('文本档：第三段及之后丢弃、标题或地址为空丢该条、两端空白剥掉', () => {
    const { kinds } = parseExploreKinds(' 名 ::/u::多余\n无地址\n::/only-url\n有址::')
    expect(kinds).toEqual([{ title: '名', url: '/u' }])
  })
  it('文本档：一条都不认 → unknown（与 JSON 档同一把尺，不静默给空冒充「没有分类」）', () => {
    expect(parseExploreKinds('玄幻::')).toEqual({ kinds: [], form: 'unknown' })
    expect(parseExploreKinds('::')).toEqual({ kinds: [], form: 'unknown' })
  })
  it('文本档：CRLF 换行——分隔只认 \\n，行尾的 \\r 靠取值 trim 吃掉（这条依赖要钉住）', () => {
    const { kinds, form } = parseExploreKinds('玄幻::/a\r\n都市::/b')
    expect(form).toBe('text')
    expect(kinds).toEqual([{ title: '玄幻', url: '/a' }, { title: '都市', url: '/b' }])
  })
  it('JSON 档：数组取 title+url 双非空的项，style 等其余键忽略', () => {
    const { kinds, form } = parseExploreKinds(JSON.stringify([
      { title: '短剧榜', url: 'https://e.com/r?page={{page}}', style: { layout_flexGrow: 1 } },
      { title: '', url: '/skip-me' }, { title: '缺址' }, { notTitle: '形状不对', url: '/x' },
    ]))
    expect(form).toBe('json')
    expect(kinds).toEqual([{ title: '短剧榜', url: 'https://e.com/r?page={{page}}' }])
  })
  it('JSON 档：两档同一把尺——trim 后才判空，存的也是 trim 后的值', () => {
    const { kinds, form } = parseExploreKinds('[{"title":"  ","url":"/a"},{"title":"名","url":"  /u  "}]')
    expect(form).toBe('json')
    expect(kinds).toEqual([{ title: '名', url: '/u' }])
  })
  it('JSON 档：空数组是空集合（json + 空 kinds），不是「形状在场却一条不认」', () => {
    expect(parseExploreKinds('[]')).toEqual({ kinds: [], form: 'json' })
    expect(parseExploreKinds('  [ ]  ')).toEqual({ kinds: [], form: 'json' })
  })
  it('JSON 档：以 [ 或 { 开头但读不出数组 → unknown（不猜结构、不当成空）', () => {
    expect(parseExploreKinds('[{坏 JSON').form).toBe('unknown')
    expect(parseExploreKinds('{"玄幻":"/x"}').form).toBe('unknown')
    expect(parseExploreKinds('["纯字符串"]').form).toBe('unknown')
  })
  it('JSON 档：项是 null 只丢该项、不炸（红检：删掉 parseJsonKinds 里那道 null 守卫即抛 TypeError 而不是落 unknown）', () => {
    expect(parseExploreKinds('[null]').form).toBe('unknown')
    expect(parseExploreKinds('[{"title":"名","url":"/u"},null]')).toEqual({
      kinds: [{ title: '名', url: '/u' }], form: 'json',
    })
  })
  it('非串的在场值走 unknown 的早返回：不进 JSON 档兜底、也不炸在 trim 上', () => {
    expect(parseExploreKinds([{ title: '玄幻', url: '/x' }])).toEqual({ kinds: [], form: 'unknown' })
    expect(parseExploreKinds(42)).toEqual({ kinds: [], form: 'unknown' })
  })
  it('js 档不执行脚本：如实给空入口并把 form 交回调用方留痕', () => {
    expect(parseExploreKinds('@js:\nresult')).toEqual({ kinds: [], form: 'js' })
  })
})
