import { describe, expect, it } from 'vitest'
import { nextChapterIndex, nextLoadTarget } from '../../src/client/reader-load.js'

describe('nextChapterIndex（前向窗口：视口章之后第一个未载章）', () => {
  it('目录未就绪（空表）→ -1', () => {
    expect(nextChapterIndex([], 0)).toBe(-1)
  })
  it('全未载 → 从头开始（0）', () => {
    expect(nextChapterIndex([null, null, null], 0)).toBe(0)
  })
  it('视口章自己未载 → 就是要它', () => {
    expect(nextChapterIndex([null, null, null], 1)).toBe(1)
  })
  it('已载前缀 → 视口章之后第一个未载章', () => {
    expect(nextChapterIndex(['a', 'b', null, null], 1)).toBe(2)
  })
  it('目录直达跳章 → 从跳到的章继续往下读（不回头补前面的洞）', () => {
    expect(nextChapterIndex([null, null, 'c', null, null], 2)).toBe(3)
  })
  it('倒退跳章后预取跟着视口走，不跟最大已载章（旧口径会取到 51，用户读第 11 章末尾接上第 51 章）', () => {
    const chapters: Array<string | null> = new Array(60).fill(null)
    chapters[0] = 'a'; chapters[1] = 'b'; chapters[10] = 'k'; chapters[50] = 'y'
    expect(nextChapterIndex(chapters, 10)).toBe(11)
  })
  it('读尽 → -1', () => {
    expect(nextChapterIndex(['a', 'b'], 1)).toBe(-1)
  })
  it('已载判据只问「在不在」：图文对象与文字串同等对待（载哪一章与正文形态无关）', () => {
    const rich = { kind: 'rich', documentId: 'd0', nodes: [] }
    const text = { kind: 'text', text: '正文' }
    expect(nextChapterIndex([rich, text, null], 1)).toBe(2)
    expect(nextChapterIndex([rich, text], 1)).toBe(-1)
    expect(nextLoadTarget(0, 500, { chapters: [rich, null], loading: null, from: 0 })).toBe(1)
  })
})

describe('nextLoadTarget（哨兵进预取区才加载——旧口径 scrollHeight/scrollTop 已废弃）', () => {
  // 旧口径 `scrollHeight - scrollTop - clientHeight < 2 屏` 在宿主内容撑高布局下两个方向都失效：
  // 阅读器容器 clientHeight == scrollHeight（97541 实测）永不滚动；912 章占位块又把 scrollHeight
  // 撑成整本书高（97579 实测）→ 真滚了也只在全书末尾触发。新签名里没有 scrollHeight/scrollTop，
  // 判据换成「未载边界哨兵相对视口的 top」——类型层面就堵住旧口径回归。
  const chapters = ['a', null, null]

  it('在途有章 → 不加载（单在途槽，滚动风暴去重）', () => {
    expect(nextLoadTarget(0, 500, { chapters, loading: 1, from: 0 })).toBeNull()
  })
  it('读尽 → 不加载', () => {
    expect(nextLoadTarget(0, 500, { chapters: ['a', 'b'], loading: null, from: 1 })).toBeNull()
  })
  it('哨兵进「视口底 +2 屏」→ 加载下一未载章；恰好 2 屏 → 不加载（严格小于，口径与历史实现同源）', () => {
    expect(nextLoadTarget(1500, 500, { chapters, loading: null, from: 0 })).toBeNull()   // 1500 == 500 * (1+2)
    expect(nextLoadTarget(1499, 500, { chapters, loading: null, from: 0 })).toBe(1)
    expect(nextLoadTarget(0, 500, { chapters, loading: null, from: 0 })).toBe(1)         // 哨兵在视口顶：首屏没填满，继续补
  })
  it('已滚过哨兵（top 为负）→ 仍然加载（用户跳过头了，把正文跟上）', () => {
    expect(nextLoadTarget(-2000, 500, { chapters, loading: null, from: 0 })).toBe(1)
  })
})
