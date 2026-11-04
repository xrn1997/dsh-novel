import { describe, expect, it } from 'vitest'
import { isSameChapterPage, stripExtension } from '../../src/services/chapter-page.js'

// 用例对齐 android-ebook 的 ChapterPageMatcherTest（原生书源同款防串章闸）——同形取舍一起搬过来，
// 钉死「宁漏页不串章」（分页后缀、章号递增、跨站、混键），
// 免得后续改动在无人察觉时把「宁漏页不串章」翻成「串章」
describe('stripExtension', () => {
  it('去结尾扩展名；无扩展名原样', () => {
    expect(stripExtension('/c/1.html')).toBe('/c/1')
    expect(stripExtension('/c/1')).toBe('/c/1')
  })
})

describe('isSameChapterPage（候选下一页是否仍属入口章）', () => {
  it('本章分页后缀形态 → 同章（`-2` / `_2` / `p2` / 扩展名有无混用）', () => {
    const same: Array<[string, string]> = [
      ['https://x.com/5/3943720-2', 'https://x.com/5/3943720'],
      ['https://x.com/5/3943720-2.html', 'https://x.com/5/3943720'],
      ['https://x.com/5/3943720_2.html', 'https://x.com/5/3943720.html'],
      ['https://x.com/book/1234-15-2.html', 'https://x.com/book/1234-15.html'],
      ['https://x.com/c/1p2.html', 'https://x.com/c/1.html'],      // 本书源测试用形态：入口 + 后缀
      ['https://x.com/5/3943720', 'https://x.com/5/3943720'],      // 同页重复链接
    ]
    for (const [url, base] of same) expect(isSameChapterPage(url, base), url).toBe(true)
  })

  it('下一章链接 → 拦下（末页「下一页」的经典形态，跟进即串章）', () => {
    const diff: Array<[string, string]> = [
      ['https://x.com/5/3943721', 'https://x.com/5/3943720'],
      ['https://x.com/book/1234-16.html', 'https://x.com/book/1234-15.html'],
      ['https://x.com/book/1234-16', 'https://x.com/book/1234-15.html'],
      ['https://www.bqquge.org/531/406543', 'https://www.bqquge.org/531/406542'],   // 数字 URL 章号递增即下一章
      ['https://x.com/ch/100-2', 'https://x.com/ch/100-1'],        // 形态不可区分 → 宁漏页
      ['https://x.com/read?cid=2', 'https://x.com/read?cid=1'],     // 非页码键的另一篇内容（串章形态）
      ['https://x.com/read?cid=1&page=2', 'https://x.com/read?cid=1'], // 混键 → 判不准，拦下
      ['https://other.com/5/3943720-2', 'https://x.com/5/3943720'],  // 跨站
    ]
    for (const [url, base] of diff) expect(isSameChapterPage(url, base), url).toBe(false)
  })

  it('标准页码查询分页 → 放行（路径相同 + 只由页码键构成）', () => {
    expect(isSameChapterPage('https://x.com/5/3943720?page=2', 'https://x.com/5/3943720')).toBe(true)
    expect(isSameChapterPage('https://x.com/5/3943720.html?p=3', 'https://x.com/5/3943720.html')).toBe(true)
    // 入口自带查询时按整串比对（同章续页会原样带上入口查询）
    expect(isSameChapterPage('https://x.com/read?cid=1&page=2', 'https://x.com/read?cid=1&page=1')).toBe(false)
  })

  it('非法 URL → 拦下（判不准不跟进）', () => {
    expect(isSameChapterPage('http://[::bad', 'https://x.com/5/3943720')).toBe(false)
  })
})
