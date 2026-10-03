import { describe, expect, it } from 'vitest'
import { createFetcher } from '../../src/services/fetcher.js'
import { normalizeSource } from '../../src/services/normalize.js'
import { EXPLORE_CACHE_TTL_MS, KindCache } from '../../src/services/explore-cache.js'
import { runExploreKind } from '../../src/services/explore.js'
import type { NovelSource } from '../../src/services/types.js'
import type { SearchGroup } from '../../src/shared/wire.js'

const group = (id: string): SearchGroup => ({ sourceId: id, sourceName: id, status: 'verified', hits: [] })
const key = { sourceId: 'A', kind: '玄幻', epoch: 7, page: 1 }

describe('KindCache', () => {
  it('存进去取得到；TTL 内有效、过期即失效', () => {
    const c = new KindCache()
    c.put(key, group('A'), 1000)
    expect(c.get(key, 1000 + EXPLORE_CACHE_TTL_MS)).not.toBeNull()
    expect(c.get(key, 1000 + EXPLORE_CACHE_TTL_MS + 1)).toBeNull()
  })

  it('规则代际变了就取不到（换规则自然失效，不另造时效）', () => {
    const c = new KindCache()
    c.put(key, group('A'), 1000)
    expect(c.get({ ...key, epoch: 8 }, 1000)).toBeNull()
  })

  it('分类名与源不同即不同槽位', () => {
    const c = new KindCache()
    c.put(key, group('A'), 1000)
    expect(c.get({ ...key, kind: '都市' }, 1000)).toBeNull()
    expect(c.get({ ...key, sourceId: 'B' }, 1000)).toBeNull()
  })

  // 第 2 页与第 1 页是两份不同的快照：共用一个槽位会让「继续加载」端出首页那一组，
  // 用户看到的是同一批书被当成新的一页。
  it('同一 (源, 分类, 代际) 下第 1 页与第 2 页互不命中', () => {
    const c = new KindCache()
    c.put({ ...key, page: 1 }, group('A'), 1000)
    expect(c.get({ ...key, page: 2 }, 1000)).toBeNull()
  })
})

/** 原生方言源（同 tests/services/explore-face.test.ts 的桩）：ruleFind 声明一条分类入口，
 *  通用搜索规则兜住条目提取那一侧。 */
function source(over: Record<string, unknown> = {}): NovelSource {
  const n = normalizeSource({
    name: 'S', url: 'https://s.com',
    ruleSearch: { list: '.item', name: 'h3 a', author: 'p a', bookUrl: 'h3 a@href' },
    ruleBookInfo: { name: '.booktxt h1' },
    ruleToc: { list: '#list li', name: 'a', url: 'a@href' },
    ruleContent: { content: '.con' },
    ruleFind: { url: '/{{kind}}/{{page}}', kinds: [{ title: '玄幻', url: 'xuanhuan' }] },
    ...over,
  })
  if (!n.ok) throw new Error(`桩源应能规范化：${JSON.stringify(n.missing)}`)
  return { id: 'i', status: 'unverified', importedAt: 0, ...n.source! } as NovelSource
}
const LIST_HTML = '<html><body><div class="item"><h3><a href="/book/1">剑起长安</a></h3>' +
  '<p><a href="/zuozhe/a">青衫客</a></p></div></body></html>'
const html = (text: string): Response => new Response(text, { headers: { 'content-type': 'text/html; charset=utf-8' } })

/** 批循环的缺省组合：并行 5、无缓存、代际恒 7 —— 单条用例只改自己关心的那一件。 */
const cfg = (cache?: KindCache, epochOf = (): number => 7): Parameters<typeof runExploreKind>[2] =>
  ({ parallel: 5, timeoutMs: 5_000, cache, epochOf })

describe('runExploreKind：逐源批循环', () => {
  it('第二轮命中快照：零请求，且发的是存下来的那一组', async () => {
    let fetches = 0
    const f = createFetcher({ fetchImpl: async () => { fetches++; return html(LIST_HTML) } })
    const cache = new KindCache()
    const targets = [{ source: source(), kindUrl: 'xuanhuan' }]
    const first: SearchGroup[] = []
    await runExploreKind(targets, f, cfg(cache), (g) => { first.push(g) }, () => false)
    const second: SearchGroup[] = []
    await runExploreKind(targets, f, cfg(cache), (g) => { second.push(g) }, () => false)
    expect(first[0].hits.map((h) => h.title)).toEqual(['剑起长安'])
    expect(fetches).toBe(1)
    expect(second).toEqual(first)
  })

  it('规则代际变了就是未命中（换键，不是删缓存）', async () => {
    let fetches = 0
    const f = createFetcher({ fetchImpl: async () => { fetches++; return html(LIST_HTML) } })
    const cache = new KindCache()
    const targets = [{ source: source(), kindUrl: 'xuanhuan' }]
    await runExploreKind(targets, f, cfg(cache), () => {}, () => false)
    await runExploreKind(targets, f, cfg(cache, () => 8), () => {}, () => false)
    expect(fetches).toBe(2)
  })

  it('抓取上抛只把这一源记成 error 组，整轮不失败', async () => {
    const f = createFetcher({ fetchImpl: async () => { throw new Error('站点连不上') } })
    const out: SearchGroup[] = []
    await runExploreKind([{ source: source(), kindUrl: 'xuanhuan' }], f, cfg(),
      (g) => { out.push(g) }, () => false)
    expect(out).toHaveLength(1)
    expect(out[0].error?.code).toBe('FetchError')      // 错误码投影是 searchErrorCodeOf 的活
    expect(out[0].hits).toEqual([])
  })

  it('上抛的失败不进快照：一次偶发故障不把这一源钉死', async () => {
    let fetches = 0
    const f = createFetcher({
      fetchImpl: async () => {
        fetches++
        if (fetches === 1) throw new Error('抽一下')
        return html(LIST_HTML)
      },
    })
    const cache = new KindCache()
    const targets = [{ source: source(), kindUrl: 'xuanhuan' }]
    const bad: SearchGroup[] = []
    await runExploreKind(targets, f, cfg(cache), (g) => { bad.push(g) }, () => false)
    const good: SearchGroup[] = []
    await runExploreKind(targets, f, cfg(cache), (g) => { good.push(g) }, () => false)
    expect(bad[0].error).toBeDefined()
    expect(fetches).toBe(2)
    expect(good[0].hits.map((h) => h.title)).toEqual(['剑起长安'])
  })

  // 规则缺失是**结果形态**（不像上抛那样走 catch 分支），所以「只缓存成功」这条裁决
  // 必须在结果那一侧单独钉一次：否则失败组照旧进快照，同一槽位的下一次进入会端出旧的失败。
  it('规则缺失的结果也不进快照：修好规则后同一槽位重新抓', async () => {
    let fetches = 0
    const f = createFetcher({ fetchImpl: async () => { fetches++; return html(LIST_HTML) } })
    const cache = new KindCache()
    const missing = [{ source: source({ ruleFind: { kinds: [{ title: '玄幻', url: 'xuanhuan' }] } }), kindUrl: 'xuanhuan' }]
    const first: SearchGroup[] = []
    await runExploreKind(missing, f, cfg(cache), (g) => { first.push(g) }, () => false)
    expect(first[0].error?.code).toBe('RuleMissing')
    expect(fetches).toBe(0)                        // 规则缺失在发请求之前就定了，一个包都没发
    const second: SearchGroup[] = []
    await runExploreKind([{ source: source(), kindUrl: 'xuanhuan' }], f, cfg(cache),
      (g) => { second.push(g) }, () => false)
    expect(fetches).toBe(1)
    expect(second[0].error).toBeUndefined()
    expect(second[0].hits.map((h) => h.title)).toEqual(['剑起长安'])
  })

  it('时钟走 cfg.now：刚存下的条目算新鲜（时效不写死在实现里）', async () => {
    let fetches = 0
    const f = createFetcher({ fetchImpl: async () => { fetches++; return html(LIST_HTML) } })
    const cache = new KindCache()
    cache.put({ sourceId: 'i', kind: 'xuanhuan', epoch: 7, page: 1 }, group('i'), 0)
    const out: SearchGroup[] = []
    await runExploreKind([{ source: source(), kindUrl: 'xuanhuan' }], f,
      { ...cfg(cache), now: () => 5 }, (g) => { out.push(g) }, () => false)
    expect(fetches).toBe(0)                        // 用真实时钟去比 `at: 0` 会判成过期，于是这条会红
    expect(out[0]).toEqual(group('i'))
  })

  it('已停：不再开新源', async () => {
    let fetches = 0
    const f = createFetcher({ fetchImpl: async () => { fetches++; return html(LIST_HTML) } })
    const out: SearchGroup[] = []
    await runExploreKind(
      [{ source: source(), kindUrl: 'xuanhuan' }, { source: source(), kindUrl: 'dushi' }],
      f, { ...cfg(), parallel: 1 },
      (g) => { out.push(g) }, () => out.length > 0)  // 第一源一回来就停
    expect(fetches).toBe(1)
    expect(out).toHaveLength(1)
  })

  it('在途的不撤回：同一批里已开抓的那一条照旧出结果', async () => {
    let fetches = 0
    const f = createFetcher({ fetchImpl: async () => { fetches++; return html(LIST_HTML) } })
    const out: SearchGroup[] = []
    await runExploreKind(
      [{ source: source(), kindUrl: 'xuanhuan' }, { source: source(), kindUrl: 'dushi' }],
      f, { ...cfg(), parallel: 2 },
      (g) => { out.push(g) }, () => out.length > 0)
    expect(fetches).toBe(2)
    expect(out).toHaveLength(2)
  })

  // 已到底的源（`cfg.skip`）一个包都不发，也不出组：续页只该打在还有下一页的源上——它们若照旧发一次，
  // 这次请求的结果与首页那一组等价，续页面上就会把同一批书再摊一遍。
  it('已到底的源不再发请求，也不出组', async () => {
    let fetches = 0
    const seen: string[] = []
    const f = createFetcher({ fetchImpl: async (input) => { fetches++; seen.push(String(input)); return html(LIST_HTML) } })
    const out: SearchGroup[] = []
    await runExploreKind(
      [{ source: { ...source(), id: 'dead' }, kindUrl: 'xuanhuan' },
        { source: { ...source(), id: 'alive' }, kindUrl: 'dushi' }],
      f, { ...cfg(), skip: new Set(['dead']) },
      (g) => { out.push(g) }, () => false)
    expect(seen).toEqual(['https://s.com/dushi'])
    expect(fetches).toBe(1)
    expect(out.map((g) => g.sourceId)).toEqual(['alive'])
  })
})
