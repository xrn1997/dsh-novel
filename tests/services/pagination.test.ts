import { describe, expect, it } from 'vitest'
import { followPages } from '../../src/services/pagination.js'
import { listValue } from '../../src/services/bridge.js'
import { evaluate } from '../../src/engine/index.js'
import type { Page, SubRuleEval } from '../../src/services/bridge.js'

// 3 页站点：/p1 /p2 /p3，每页 2 条目 + a.next；/p3 无 next
function site(): Map<string, Page> {
  const pages = new Map<string, Page>()
  const p = (n: number, next: string | null) => {
    pages.set(`https://x.com/p${n}`, {
      url: `https://x.com/p${n}`,
      body: `<div class="it">条${n}A</div><div class="it">条${n}B</div>` + (next ? `<a class="next" href="${next}">下一</a>` : ''),
    })
  }
  p(1, '/p2'); p(2, '/p3'); p(3, null)
  return pages
}
const subEval: SubRuleEval = async (rule, ctx, facet) => evaluate(rule, { html: ctx.html, baseUrl: ctx.baseUrl }, facet)
const extract = async (page: Page): Promise<string[]> =>
  listValue(await evaluate('@css:.it@textNodes', { html: page.body, baseUrl: page.url }, 'toc'), 'toc') ?? []
const keyOf = (s: string) => s

/** 多候选形态的公共现场：入口页（书籍详情页形态）自带「首页」条目，`.nx` 里列出 q1/q2 两个候选。
 *  多候选三连用例共用——各写一份的复制体一漂，测的就不再是同一种入口形态。 */
const candidateEntry = (): [string, Page] => ['https://x.com/p1', {
  url: 'https://x.com/p1',
  body: '<div class="it">首页</div><div class="nx"><a href="/q1">A</a><a href="/q2">B</a></div>',
}]

describe('followPages 翻页闸（停止判据次序）', () => {
  it('正常跟完 3 页 → end，items 不重复', async () => {
    const pages = site()
    const r = await followPages('https://x.com/p1', async (u) => pages.get(u)!, extract, 'tag.a.next@href', keyOf, { maxPages: 10 }, 'toc', subEval)
    expect(r.pages).toBe(3)
    expect(r.stoppedBy).toBe('end')
    expect(r.items).toEqual(['条1A', '条1B', '条2A', '条2B', '条3A', '条3B'])
  })
  it('回环（越界页重复首页内容）→ loop 停，重复条目不收', async () => {
    const pages = site()
    pages.set('https://x.com/p3', { url: 'https://x.com/p3', body: pages.get('https://x.com/p1')!.body }) // p3 复制 p1 内容
    const r = await followPages('https://x.com/p1', async (u) => pages.get(u)!, extract, 'tag.a.next@href', keyOf, { maxPages: 10 }, 'toc', subEval)
    expect(r.stoppedBy).toBe('loop')
    expect(r.pages).toBe(3)
    expect(new Set(r.items).size).toBe(r.items.length)
  })
  it('零新增（空页）→ zero-new 停，不追 next', async () => {
    const pages = new Map<string, Page>([
      ['https://x.com/p1', { url: 'https://x.com/p1', body: '<div class="it">A</div><a class="next" href="/p2">x</a>' }],
      ['https://x.com/p2', { url: 'https://x.com/p2', body: '<p>这页没有任何条目</p><a class="next" href="/p3">x</a>' }],
      ['https://x.com/p3', { url: 'https://x.com/p3', body: '<div class="it">C</div>' }],
    ])
    const r = await followPages('https://x.com/p1', async (u) => pages.get(u)!, extract, 'tag.a.next@href', keyOf, { maxPages: 10 }, 'toc', subEval)
    expect(r.stoppedBy).toBe('zero-new')
    expect(r.pages).toBe(2) // p2 空页即停，不进 p3
    expect(r.items).toEqual(['A'])
  })
  it('上限闸 cap', async () => {
    const mk = (n: number): Page => ({ url: `https://x.com/p${n}`, body: `<div class="it">条${n}</div><a class="next" href="/p${n + 1}">x</a>` })
    const r = await followPages('https://x.com/p1', async (u) => Promise.resolve(mk(Number(u.match(/p(\d+)/)![1]))), extract, 'tag.a.next@href', keyOf, { maxPages: 3 }, 'toc', subEval)
    expect(r.stoppedBy).toBe('cap')
    expect(r.pages).toBe(3)
    expect(r.items).toEqual(['条1', '条2', '条3'])
  })
  // 末页「下一页」常指向下一章（笔趣阁 `.prenext`）——跟进去就把后续章节拼成本章（实测 50 章 / 35846 字）
  it('串章闸：候选下一页不属本章 → chapter-boundary 停，不取那一页', async () => {
    const pages = new Map<string, Page>([
      ['https://x.com/c/1', { url: 'https://x.com/c/1', body: '<div class="it">本章正文</div><a class="next" href="/c/2">下一章</a>' }],
      ['https://x.com/c/2', { url: 'https://x.com/c/2', body: '<div class="it">下一章正文</div>' }],
    ])
    const r = await followPages('https://x.com/c/1', async (u) => pages.get(u)!, extract, 'tag.a.next@href', keyOf,
      { maxPages: 10, sameChapterBase: 'https://x.com/c/1' }, 'content', subEval)
    expect(r.stoppedBy).toBe('chapter-boundary')
    expect(r.pages).toBe(1)
    expect(r.items).toEqual(['本章正文'])
  })
  it('串章闸：本章续页（前缀形态）照常跟进', async () => {
    const pages = new Map<string, Page>([
      ['https://x.com/c/1.html', { url: 'https://x.com/c/1.html', body: '<div class="it">第一页</div><a class="next" href="/c/1p2.html">下一页</a>' }],
      ['https://x.com/c/1p2.html', { url: 'https://x.com/c/1p2.html', body: '<div class="it">第二页</div>' }],
    ])
    const r = await followPages('https://x.com/c/1.html', async (u) => pages.get(u)!, extract, 'tag.a.next@href', keyOf,
      { maxPages: 10, sameChapterBase: 'https://x.com/c/1.html' }, 'content', subEval)
    expect(r.stoppedBy).toBe('end')
    expect(r.pages).toBe(2)
    expect(r.items).toEqual(['第一页', '第二页'])
  })
})

describe('followPages 目录知识闸 + 列表 next + 部分重叠不停（legado 对齐）', () => {
  it('stopUrls：候选 == 目录里其他章节 URL → chapter-boundary（legado 防串章正判据）', async () => {
    const pages = new Map<string, Page>([
      ['https://x.com/c/1', { url: 'https://x.com/c/1', body: '<div class="it">本章正文</div><a class="next" href="/c/2">下一章</a>' }],
      ['https://x.com/c/2', { url: 'https://x.com/c/2', body: '<div class="it">下一章正文</div>' }],
    ])
    const r = await followPages('https://x.com/c/1', async (u) => pages.get(u)!, extract, 'tag.a.next@href', keyOf,
      { maxPages: 10, stopUrls: new Set(['https://x.com/c/2']) }, 'content', subEval)
    expect(r.stoppedBy).toBe('chapter-boundary')
    expect(r.pages).toBe(1)
    expect(r.items).toEqual(['本章正文'])
  })
  it('stopUrls：非页码键分页地址不在目录里 → 照常跟进（路径启发式会误拦的形态）', async () => {
    const pages = new Map<string, Page>([
      ['https://x.com/read.php?id=1&cid=10', { url: 'https://x.com/read.php?id=1&cid=10', body: '<div class="it">第一页</div><a class="next" href="/read.php?id=1&cid=10&page=2">下一页</a>' }],
      ['https://x.com/read.php?id=1&cid=10&page=2', { url: 'https://x.com/read.php?id=1&cid=10&page=2', body: '<div class="it">第二页</div>' }],
    ])
    // 目录知识：下一章是 cid=11——分页地址 cid=10&page=2 不在其中 → 放行
    const r = await followPages('https://x.com/read.php?id=1&cid=10', async (u) => pages.get(u)!, extract, 'tag.a.next@href', keyOf,
      { maxPages: 10, stopUrls: new Set(['https://x.com/read.php?id=1&cid=11']) }, 'content', subEval)
    expect(r.stoppedBy).toBe('end')
    expect(r.pages).toBe(2)
    expect(r.items).toEqual(['第一页', '第二页'])
  })
  it('两闸同供时目录知识优先：stopUrls 在场则路径启发式完全不参与（2026-09 审查复议维持原裁决）', async () => {
    // 审查建议「stopSet 未命中时再走收窄到路径变化的启发式」——本用例正是那个形态：入口
    // `/book/1/1.html`、续页 `/book/1/2.html`（路径不同且非前缀，启发式判不同章 → 会漏页），
    // 只有目录知识知道 `/3.html` 才是下一章。钉在这里，防以后被悄悄改回双闸。
    const pages = new Map<string, Page>([
      ['https://x.com/book/1/1.html', { url: 'https://x.com/book/1/1.html', body: '<div class="it">第一页</div><a class="next" href="/book/1/2.html">下一页</a>' }],
      ['https://x.com/book/1/2.html', { url: 'https://x.com/book/1/2.html', body: '<div class="it">第二页</div><a class="next" href="/book/1/3.html">下一章</a>' }],
      ['https://x.com/book/1/3.html', { url: 'https://x.com/book/1/3.html', body: '<div class="it">下一章正文</div>' }],
    ])
    const r = await followPages('https://x.com/book/1/1.html', async (u) => pages.get(u)!, extract, 'tag.a.next@href', keyOf,
      {
        maxPages: 10,
        sameChapterBase: 'https://x.com/book/1/1.html',
        stopUrls: new Set(['https://x.com/book/1/3.html']),
      }, 'content', subEval)
    expect(r.pages).toBe(2)
    expect(r.items).toEqual(['第一页', '第二页'])
    expect(r.stoppedBy).toBe('chapter-boundary')
  })
  it('next 规则列表语义：多候选全部抓取且不递归翻页（legado getStringList 口径）', async () => {
    const pages = new Map<string, Page>([
      candidateEntry(),
      ['https://x.com/q1', { url: 'https://x.com/q1', body: '<div class="it">页A</div><a class="next" href="/q9">深层</a>' }],
      ['https://x.com/q2', { url: 'https://x.com/q2', body: '<div class="it">页B</div><a class="next" href="/q9">深层</a>' }],
      ['https://x.com/q9', { url: 'https://x.com/q9', body: '<div class="it">不该被抓</div>' }],
    ])
    const r = await followPages('https://x.com/p1', async (u) => pages.get(u)!, extract, '.nx a@href', keyOf,
      { maxPages: 10 }, 'toc', subEval)
    expect(r.pages).toBe(3)
    expect(r.items).toEqual(['首页', '页A', '页B'])   // q9 不抓（多候选不递归）
    expect(r.stoppedBy).toBe('end')
  })
  /**
   * 多候选模式的「零新增」不是一条全局闸。真机形态：目录入口页（书籍详情页）自己就列着第 1 页，
   * 而翻页规则同时把 index_1（与入口页同内容）和 index_2…index_N 一起列出来。
   * 曾按链式那侧的语义把「整页零新增」判成回环 → `break` 掉整个循环 → 队列里其余候选一起被丢掉：
   * 笔趣阁 165 章读成 100、第一小说 1839 章读成 100、阳光中文网 1586 章读成 100。
   * 对面那侧多候选是逐条并发全抓、条目最后统一去重，没有这道早停。
   * 链式单候选的 loop / zero-new 两态不变（由上面的「回环」与「零新增」两条钉子守着）。
   */
  it('多候选：某一候选与入口页整页重复 → 其余候选照抓（不得中止整轮）', async () => {
    const pages = new Map<string, Page>([
      candidateEntry(),
      ['https://x.com/q1', { url: 'https://x.com/q1', body: '<div class="it">首页</div>' }],  // 与入口页同内容
      ['https://x.com/q2', { url: 'https://x.com/q2', body: '<div class="it">页B</div>' }],
    ])
    const r = await followPages('https://x.com/p1', async (u) => pages.get(u)!, extract, '.nx a@href', keyOf,
      { maxPages: 10 }, 'toc', subEval)
    expect(r.items).toEqual(['首页', '页B'])
    expect(r.pages).toBe(3)
    expect(r.stoppedBy).toBe('end')
  })
  it('多候选：某一候选是空页 → 其余候选照抓，也不追它的 next', async () => {
    const pages = new Map<string, Page>([
      candidateEntry(),
      ['https://x.com/q1', { url: 'https://x.com/q1', body: '<a class="next" href="/q9">x</a>' }],  // 零条目
      ['https://x.com/q2', { url: 'https://x.com/q2', body: '<div class="it">页B</div>' }],
      ['https://x.com/q9', { url: 'https://x.com/q9', body: '<div class="it">不该被抓</div>' }],
    ])
    const r = await followPages('https://x.com/p1', async (u) => pages.get(u)!, extract, '.nx a@href', keyOf,
      { maxPages: 10 }, 'toc', subEval)
    expect(r.items).toEqual(['首页', '页B'])
    expect(r.stoppedBy).toBe('end')
  })
  it('页间部分重复不判到底：条目去重、继续追 next（legado 目录翻页只按 URL 防环）', async () => {
    const pages = new Map<string, Page>([
      ['https://x.com/t1', { url: 'https://x.com/t1', body: '<div class="it">A</div><div class="it">B</div><a class="next" href="/t2">n</a>' }],
      ['https://x.com/t2', { url: 'https://x.com/t2', body: '<div class="it">B</div><div class="it">C</div><a class="next" href="/t3">n</a>' }],
      ['https://x.com/t3', { url: 'https://x.com/t3', body: '<div class="it">D</div>' }],
    ])
    const r = await followPages('https://x.com/t1', async (u) => pages.get(u)!, extract, 'tag.a.next@href', keyOf,
      { maxPages: 10 }, 'toc', subEval)
    expect(r.stoppedBy).toBe('end')
    expect(r.pages).toBe(3)
    expect(r.items).toEqual(['A', 'B', 'C', 'D'])   // 此前「出现重复即停」会截断在 t1（只出 A、B）
  })
  it('URL 防环：同地址重复出现只抓一次', async () => {
    let fetches = 0
    const page = (u: string, body: string, next: string | null): Page => ({
      url: u, body: `<div class="it">${body}</div>` + (next ? `<a class="next" href="${next}">n</a>` : ''),
    })
    const r = await followPages('https://x.com/a', async (u) => {
      fetches++
      return u === 'https://x.com/a'
        ? page(u, '甲', '/b')
        : page(u, '乙', '/a')   // b 的下一页指回 a
    }, extract, 'tag.a.next@href', keyOf, { maxPages: 10 }, 'toc', subEval)
    expect(r.items).toEqual(['甲', '乙'])
    expect(fetches).toBe(2)     // a 不因回指被二次抓取
  })
})
