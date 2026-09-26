import { describe, expect, it } from 'vitest'
import { absUrlKeepOption, canonUrl, splitUrlOption, stripUrlOption } from '../../src/services/request.js'

// 章节/下一页 URL 的 `,{option}` 后缀语义（URL 部分绝对化、选项后缀原样接回）：
// URL 部分绝对化、选项后缀原文接回、抓取时由 assembleRequest 解释——
// 此前目录落库前 strip 选项 → POST/charset 型章节端点全部退化成裸 GET。

describe('URL 选项后缀（splitUrlOption / absUrlKeepOption / canonUrl）', () => {
  it('切分：严格 JSON 形态', () => {
    expect(splitUrlOption('https://x.com/c/1.html,{"webView":true}'))
      .toEqual({ url: 'https://x.com/c/1.html', suffix: ',{"webView":true}' })
  })
  it('切分：单引号 JSON 形态（真实源大量存在）', () => {
    const r = splitUrlOption("/c/2.html,{'method':'POST','body':'a=1'}")
    expect(r.url).toBe('/c/2.html')
    expect(r.suffix).toBe(",{'method':'POST','body':'a=1'}")
  })
  it('正文里的 {a,b} 不误剥；无选项原样', () => {
    expect(splitUrlOption('https://x.com/read/{a,b}')).toEqual({ url: 'https://x.com/read/{a,b}', suffix: null })
    expect(stripUrlOption('https://x.com/c/1.html')).toBe('https://x.com/c/1.html')
  })
  it('选项尾段不是合法 JSON 也切分（legado 无条件 substringBefore(paramPattern) 口径）', () => {
    // 弯引号形态 `,{webView:“true”}`（真实源 @js 拼接）此前不剥 → 整串进 URL → 章节 404
    const r = splitUrlOption('/c/4.html,{webView:“true”}')
    expect(r).toEqual({ url: '/c/4.html', suffix: ',{webView:“true”}' })
    const malformed = splitUrlOption('/c/5.html,{not json}')
    expect(malformed).toEqual({ url: '/c/5.html', suffix: ',{not json}' })
  })
  it('绝对化并保留选项（章节 URL 组装口径）', () => {
    expect(absUrlKeepOption('/c/2.html,{"method":"POST","body":"cid={{id}}"}', 'https://x.com/c/1.html'))
      .toBe('https://x.com/c/2.html,{"method":"POST","body":"cid={{id}}"}')
    expect(absUrlKeepOption('/c/3.html', 'https://x.com/c/1.html')).toBe('https://x.com/c/3.html')
  })
  it('canonUrl：比对口径剥选项 + 归一化', () => {
    expect(canonUrl('https://x.com/c/1.html,{"webView":true}')).toBe(canonUrl('https://x.com/c/1.html'))
    expect(canonUrl('/c/2.html', 'https://x.com/c/1.html')).toBe('https://x.com/c/2.html')
  })
})
