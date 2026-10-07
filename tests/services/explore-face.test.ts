import { describe, expect, it } from 'vitest'
import { createFetcher } from '../../src/services/fetcher.js'
import { normalizeSource } from '../../src/services/normalize.js'
import { fetchKindPage } from '../../src/services/explore-face.js'
import type { NovelSource } from '../../src/services/types.js'

const LIST_HTML = '<html><body><div class="item"><h3><a href="/book/1">剑起长安</a></h3>' +
  '<p><a href="/zuozhe/a">青衫客</a><span>玄幻</span></p></div></body></html>'

/** 原生方言源：name+url 无 bookSourceName → 走 flattenNative */
function source(over: Record<string, unknown> = {}): NovelSource {
  const raw = {
    name: 'S', url: 'https://s.com',
    searchUrl: '/so/{{keyword}}/{{page}}',
    ruleSearch: { list: '.item', name: 'h3 a', author: 'p a', bookUrl: 'h3 a@href', coverUrl: 'img@src', kind: 'p span' },
    ruleBookInfo: { name: '.booktxt h1' },
    ruleToc: { list: '#list li', name: 'a', url: 'a@href' },
    ruleContent: { content: '.con' },
    ruleFind: { url: '/{{kind}}/{{page}}', kinds: [{ title: '玄幻', url: 'xuanhuan' }] },
    ...over,
  }
  const n = normalizeSource(raw)
  if (!n.ok) throw new Error(`桩源应能规范化：${JSON.stringify(n.missing)}`)
  return { id: 'i', status: 'unverified', importedAt: 0, ...n.source! } as NovelSource
}

/** legado 方言源：带 `bookSourceName` ⇒ 不走 Native 判别，发现面来自 `exploreUrl` + `ruleExplore` */
function legadoSource(over: Record<string, unknown> = {}): NovelSource {
  const raw = {
    bookSourceName: 'L', bookSourceUrl: 'https://s.com',
    searchUrl: '/so/{{key}}/{{page}}',
    ruleSearch: { bookList: '.item', name: 'h3 a', author: 'p a', bookUrl: 'h3 a@href' },
    ruleContent: { content: '.con' },
    exploreUrl: '玄幻::/list/xh/{{page}}.html',
    ruleExplore: { bookList: '.item', name: 'h3 a', bookUrl: 'h3 a@href' },
    ...over,
  }
  const n = normalizeSource(raw)
  if (!n.ok) throw new Error(`桩源应能规范化：${JSON.stringify(n.missing)}`)
  return { id: 'l', status: 'unverified', importedAt: 0, ...n.source! } as NovelSource
}
const html = (text: string): Response => new Response(text, { headers: { 'content-type': 'text/html; charset=utf-8' } })

describe('explore-face：单源一次分类抓取', () => {
  it('{{kind}} 换成分类 slug，{{page}} 走首页裁页（地址是裸路径，不带 /1）', async () => {
    const seen: string[] = []
    const f = createFetcher({ fetchImpl: async (input) => { seen.push(String(input)); return html(LIST_HTML) } })
    const r = await fetchKindPage(source(), 'xuanhuan', f)
    expect(r.ok).toBe(true)
    expect(seen[0]).toBe('https://s.com/xuanhuan')
  })

  it('ruleExploreList 为空 → 回落通用搜索规则取条目', async () => {
    const f = createFetcher({ fetchImpl: async () => html(LIST_HTML) })
    const r = await fetchKindPage(source(), 'xuanhuan', f)
    if (!r.ok) throw new Error('应能取到条目')
    expect(r.hits).toHaveLength(1)
    expect(r.hits[0].title).toBe('剑起长安')
    expect(r.hits[0].author).toBe('青衫客')
    expect(r.hits[0].url).toBe('https://s.com/book/1')
  })

  // explore-own 那一支在这份文件里从未真正产出过条目（其余各条都走回落那侧），于是它整支被写坏
  // ——比如把整套换成通用搜索规则——没有一条用例会红。这条给它一个真命中：通用两件套在这张页面上
  // 都命不中，能出条目就只可能是发现面自己那套规则跑过了；书名断言再钉住「哪个位置取哪个字段」。
  it('ruleExploreList 有命中 → 由发现面自己那套规则取到条目（通用规则在这张页面上命不中）', async () => {
    const own = {
      ruleSearch: { list: '.nothing', name: '.nomatch', bookUrl: '.nomatch@href' },
      ruleFind: { url: '/{{kind}}/{{page}}', kinds: [{ title: '玄幻', url: 'x' }], ruleSearch: { list: '.item', name: 'h3 a' } },
    }
    const f = createFetcher({ fetchImpl: async () => html(LIST_HTML) })
    const r = await fetchKindPage(source(own), 'x', f)
    if (!r.ok) throw new Error('应能取到条目')
    expect(r.hits).toHaveLength(1)
    expect(r.hits[0].title).toBe('剑起长安')
  })

  // 这一条只钉列表规则那一侧（列表命中 0 → 空 List，不是 Miss）。它对「整套切换」没有区分力：
  // 列表规则一条都命中不了，书名规则无论来自哪一套都没跑过，逐字段回落在这里产出一模一样的结果。
  it('ruleExploreList 非空 → 整套用它（通用规则不参与）', async () => {
    const own = { ruleFind: { url: '/{{kind}}/{{page}}', kinds: [{ title: '玄幻', url: 'x' }], ruleSearch: { list: '.nothing', name: 'h3 a' } } }
    const f = createFetcher({ fetchImpl: async () => html(LIST_HTML) })
    const r = await fetchKindPage(source(own), 'x', f)
    if (!r.ok) throw new Error('应能取到条目')
    expect(r.hits).toEqual([])                    // .nothing 命中 0 → 空列表（不是 miss）
  })

  it('缺 ruleFind.url → RuleMissing（结果形态，不是异常）', async () => {
    const f = createFetcher({ fetchImpl: async () => html(LIST_HTML) })
    const r = await fetchKindPage(source({ ruleFind: { kinds: [{ title: '玄幻', url: 'x' }] } }), 'x', f)
    expect(r).toEqual({ ok: false, code: 'RuleMissing', message: expect.stringContaining('发现规则缺失') })
  })

  // 发现面的列表规则命中条目、书名规则却匹配不到：整套切换下这本书的标题读不出来，它是**空分类**
  // （解析到空集合 = 空 List），不是规则缺失。通用书名规则在页面里是命得中的——一旦书名那一侧
  // 单独回落通用规则，这里就会冒出一本标题取自另一套规则的书，所以本断言专治逐字段回落。
  it('发现面列表有命中而书名规则读不出 → 空数组，不回落通用书名规则', async () => {
    const own = { ruleFind: { url: '/{{kind}}/{{page}}', kinds: [{ title: '玄幻', url: 'x' }], ruleSearch: { list: '.item', name: '.nomatch' } } }
    const f = createFetcher({ fetchImpl: async () => html(LIST_HTML) })
    const r = await fetchKindPage(source(own), 'x', f)
    if (!r.ok) throw new Error('空分类是正常空结果，不该是失败形态')
    expect(r.hits).toEqual([])
  })

  // 发现面整套启用却缺书名规则：如实点名规则缺失，而不是造出没有标题的书目（对面会静默给 0 本）。
  // 逐字段回落在这里同样会红——它回落到通用书名规则，于是「规则缺失」变成了一次带条目的正常返回。
  it('发现面整套启用但缺书名规则 → RuleMissing（如实点名，不产出空书名条目）', async () => {
    const own = { ruleFind: { url: '/{{kind}}/{{page}}', kinds: [{ title: '玄幻', url: 'x' }], ruleSearch: { list: '.item' } } }
    const f = createFetcher({ fetchImpl: async () => html(LIST_HTML) })
    const r = await fetchKindPage(source(own), 'x', f)
    expect(r).toEqual({ ok: false, code: 'RuleMissing', message: expect.stringContaining('发现规则缺失') })
  })

  it('page=2 → 地址带页码段（首页裁页不误伤后续页）', async () => {
    const seen: string[] = []
    const f = createFetcher({ fetchImpl: async (input) => { seen.push(String(input)); return html(LIST_HTML) } })
    const r = await fetchKindPage(source(), 'xuanhuan', f, undefined, undefined, 2)
    expect(r.ok).toBe(true)
    expect(seen[0]).toBe('https://s.com/xuanhuan/2')      // 不是 /xuanhuan、也不是 /xuanhuan/2 被裁掉
  })

  it('legado 形态：源级模板缺席时用该分类自带的地址当模板，页码由它自己带', async () => {
    const seen: string[] = []
    const f = createFetcher({ fetchImpl: async (input) => { seen.push(String(input)); return html(LIST_HTML) } })
    const s = legadoSource()
    expect(s.rules.ruleExploreUrl).toBeNull()          // 前提（不是装饰）：这份桩没写源级模板，兜底那一档才轮得到
    const r = await fetchKindPage(s, '/list/xh/{{page}}.html', f, undefined, undefined, 2)
    expect(r.ok).toBe(true)
    expect(seen[0]).toBe('https://s.com/list/xh/2.html')
  })
  it('legado 形态：模板以 /{{page}} 结尾时首页**不裁**（裁页是 Native 分页语义，不是通用语义）', async () => {
    const seen: string[] = []
    const f = createFetcher({ fetchImpl: async (input) => { seen.push(String(input)); return html(LIST_HTML) } })
    await fetchKindPage(legadoSource(), '/top/{{page}}', f)
    expect(seen[0]).toBe('https://s.com/top/1')        // 原生方言在这一位会裁成 /top（见本文件第一条用例）
  })

  // 矩阵行 `d-explore-fallback-search-rule` 的分母全是 legado 方言的源，而整套回落原先只有原生桩钉着
  // ——legado 侧一条用例都没有，把这一路写坏（例如给它单独拼半套）没有一条用例会红。这条给它一个真
  // 命中：条目三件全取自通用搜索规则，发现面那一侧一条规则都没落位。
  it('legado 形态：ruleExplore 整块缺席 → 条目整套走通用搜索规则（回落判据两方言同一条）', async () => {
    const seen: string[] = []
    const f = createFetcher({ fetchImpl: async (input) => { seen.push(String(input)); return html(LIST_HTML) } })
    const s = legadoSource({
      ruleExplore: undefined,
      // 通用侧写全终端：legado 方言没有隐式 @text（那是原生方言的终端语义），不写就拿回整段元素
      ruleSearch: { bookList: '.item', name: 'h3 a@text', author: 'p a@text', bookUrl: 'h3 a@href' },
    })
    expect(s.rules.ruleExploreList).toBeNull()          // 前提：发现面那一套一条都没落位
    const r = await fetchKindPage(s, '/list/xh/{{page}}.html', f)
    if (!r.ok) throw new Error('回落应产出条目')
    expect(r.hits).toHaveLength(1)
    expect(r.hits[0].title).toBe('剑起长安')
    expect(r.hits[0].author).toBe('青衫客')
    expect(r.hits[0].url).toBe('https://s.com/book/1')
    expect(seen[0]).toBe('https://s.com/list/xh/1.html')   // 页码由入口自带的那份模板给，首页不裁
  })

  // 裁页的判据是**本次用的是哪份模板**，不是**这源是哪一方言**：平铺 raw 顶层写了 `ruleExploreUrl`
  // 时，模型字段就有值、跑的是源级那份原生分页模板；按方言判则首页不裁，`/1` 被发上网——
  // 正是裁页要防的那类 404。这条在「方言判据」下必红，是那条判据的反例钉桩。
  it('非原生方言但源级模板在场 → 首页仍裁（用的就是源级那份模板，与方言无关）', async () => {
    const seen: string[] = []
    const f = createFetcher({ fetchImpl: async (input) => { seen.push(String(input)); return html(LIST_HTML) } })
    const s = legadoSource({ ruleExploreUrl: '/flat/{{kind}}/{{page}}' })
    expect(s.rules.ruleExploreUrl).toBe('/flat/{{kind}}/{{page}}')   // 前提：非原生方言也能有源级模板
    const r = await fetchKindPage(s, 'xh', f)
    expect(r.ok).toBe(true)
    expect(seen[0]).toBe('https://s.com/flat/xh')
  })
})
