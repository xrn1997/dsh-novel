import { describe, expect, it } from 'vitest'
import { formatIntro } from '../../src/services/content.js'

/**
 * **简介的展示文本规约**（净化 + 截断到 5000 字符）。
 *
 * 两个取值点用的是同一条净化，只有一处差别：
 * - 搜索结果：净化后截断到 5000 字符。
 * - 详情页：先 `trimStart` 判渲染指令前缀
 *   `<usehtml>` / `<md>` / `<useweb>`，命中就**原样保留**（否则 `<button>@onclick`
 *   等书源交互标记会被清理掉，交给渲染层按前缀选渲染器）；否则同样净化后截断。
 *
 * 本仓此前两侧都是**原样透出**：普通 HTML 简介带着一堆 `<div>`/`<span>` 标签进 UI，
 * 而指令前缀那条（现库 1 源：米读小说的整页 CSS + 卡片 HTML）也没有任何地方认识它。
 */

describe('formatIntro：对面 HtmlFormatter.format 的移植', () => {
  it('块级标签转换行，其余标签连属性一起删，注释删除', () => {
    const raw = '<div class="a">第一段</div><span>旁注</span><!--隐藏--><p>第二段</p>'
    expect(formatIntro(raw)).toBe('　　第一段\n　　旁注\n　　第二段')
  })

  it('nbsp / ensp / emsp 转空格，thinsp / zwnj / zwj 删除', () => {
    expect(formatIntro('甲&nbsp;&nbsp;乙&ensp;丙&#8203;丁')).toContain('甲 乙')
  })

  it('多段落之间只留一个换行，段首统一补两个全角空格', () => {
    const raw = '<p>  甲  </p>\n\n\n<p>乙</p>'
    expect(formatIntro(raw)).toBe('　　甲\n　　乙')
  })

  it('尾部换行与空白收掉（lastRegex 口径）', () => {
    expect(formatIntro('<p>甲</p>   \n  ')).toBe('　　甲')
  })

  it('截断到 5000 字符（对面 take(5000)）', () => {
    expect(formatIntro('甲'.repeat(6000)).length).toBe(5000)
  })
})

describe('formatIntro 的渲染指令前缀豁免（对面只在详情面豁免）', () => {
  const DIRECTIVE = '<useweb>\n<style>*{box-sizing:border-box}</style>\n<div class="card">简介正文</div>'

  it('keepDirective:true（详情面）→ trimStart 后原样保留，连前缀一起', () => {
    const out = formatIntro(DIRECTIVE, { keepDirective: true })
    expect(out).toBe(DIRECTIVE.trimStart())
    expect(out.startsWith('<useweb>')).toBe(true)
  })

  it('大小写与前导空白都算命中（对面 IGNORE_CASE + trimStart）', () => {
    expect(formatIntro('  \n <MD>\n# 标题', { keepDirective: true })).toBe('<MD>\n# 标题')
  })

  it('搜索面（keepDirective 缺省 false）不豁免：前缀也按普通 HTML 净化', () => {
    const out = formatIntro(DIRECTIVE)
    expect(out.startsWith('<useweb>')).toBe(false)
    expect(out).toContain('简介正文')
  })

  it('普通简介不受前缀判定影响', () => {
    expect(formatIntro('<p>少年林动</p>', { keepDirective: true })).toBe('　　少年林动')
  })
})
