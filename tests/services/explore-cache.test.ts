import { describe, expect, it } from 'vitest'
import { createFetcher } from '../../src/services/fetcher.js'
import { normalizeSource } from '../../src/services/normalize.js'
import { EXPLORE_CACHE_TTL_MS, KindCache } from '../../src/services/explore-cache.js'
import { fetchExploreGroup } from '../../src/services/explore.js'
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

/** 单源执行体的缺省组合：无缓存、代际恒 7 —— 单条用例只改自己关心的那一件。
 *  代际在这里就是常量：执行体只收**调用方算好的**代际值，不认识规则形状，所以这一层不必替
 *  `exploreEpoch` 作证（那一份由 cache-epoch 的用例钉）。 */
const cfg = (cache?: KindCache): Parameters<typeof fetchExploreGroup>[3] =>
  ({ timeoutMs: 5_000, cache, epoch: 7 })

describe('fetchExploreGroup：单源一页的缓存语义', () => {
  // 命中那一轮交回的必须是**缓存持有的那个对象本身**，不是它的等价抄本：`explore-job` 的
  // 「绝不原地改交进来的组」就是照这条写的。一旦执行体改成进出各拷一份，持有者那侧的约定立刻
  // 落空——而 toEqual 会把这种实现整个放过（两份内容一样），所以这条只能钉到 toBe。
  it('同键第二轮零请求，且交回的就是缓存持有的那个组', async () => {
    let fetches = 0
    const f = createFetcher({ fetchImpl: async () => { fetches++; return html(LIST_HTML) } })
    const cache = new KindCache()
    const at = 1_000
    const once = { ...cfg(cache), now: () => at }
    const first = await fetchExploreGroup(source(), 'xuanhuan', f, once)
    const second = await fetchExploreGroup(source(), 'xuanhuan', f, once)
    expect(first.hits.map((h) => h.title)).toEqual(['剑起长安'])
    expect(fetches).toBe(1)
    expect(second).toBe(first)
    expect(cache.get({ sourceId: 'i', kind: 'xuanhuan', epoch: 7, page: 1 }, at)).toBe(first)
  })

  // `page` 同时喂着**请求地址**与**快照槽位**两处：这条缝没有任何类型能替人把住（执行体的 page
  // 可选、`fetchKindPage` 的页码实参也带缺省），所以两处都得由断言点名——**地址停在首页**说明
  // page 没被透传下去（退回不带页码的调用就是这种红法）；**第 2 页的快照落进首页槽位**说明键里的
  // 页被写死。两种不同的懈，一条断言盖不住另一条。
  it('page 打在请求地址上，也切出两个互不命中的槽位', async () => {
    const seen: string[] = []
    let fetches = 0
    const f = createFetcher({ fetchImpl: async (input) => { fetches++; seen.push(String(input)); return html(LIST_HTML) } })
    const cache = new KindCache()
    const at = 1_000
    const p1 = { ...cfg(cache), now: () => at }
    const p2 = { ...cfg(cache), page: 2, now: () => at }
    const first = await fetchExploreGroup(source(), 'xuanhuan', f, p1)
    const second = await fetchExploreGroup(source(), 'xuanhuan', f, p2)
    // 首页地址在这里既是「第 1 页的写法」也是证据：它没带上页码段。
    expect(seen).toEqual(['https://s.com/xuanhuan', 'https://s.com/xuanhuan/2'])
    expect(fetches).toBe(2)
    // 各归各槽：第二轮两页都命中自己的那一份，一个包都不发。
    expect(await fetchExploreGroup(source(), 'xuanhuan', f, p1)).toBe(first)
    expect(await fetchExploreGroup(source(), 'xuanhuan', f, p2)).toBe(second)
    expect(fetches).toBe(2)
  })

  // 把一次偶发故障钉死到 TTL 结束——这是「只缓存成功」那条裁决的代价形状，所以两侧都得看见：
  // 上抛这一支走 catch，仍要以带 error 的组交回（执行体不抛是 `ExploreSnapshot` 错误泳道的前提）。
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
    const bad = await fetchExploreGroup(source(), 'xuanhuan', f, cfg(cache))
    expect(bad.error?.code).toBe('FetchError')      // 错误码投影是 searchErrorCodeOf 的活
    expect(bad.hits).toEqual([])
    const good = await fetchExploreGroup(source(), 'xuanhuan', f, cfg(cache))
    expect(fetches).toBe(2)
    expect(good.error).toBeUndefined()
    expect(good.hits.map((h) => h.title)).toEqual(['剑起长安'])
  })

  // 规则缺失是**结果形态**（不像上抛那样走 catch 分支），所以「只缓存成功」必须在结果那一侧单独钉
  // 一次：否则失败组照旧进快照，同一槽位的下一次进入会端出旧的失败。
  it('规则缺失的结果也不进快照：修好规则后同一槽位重新抓', async () => {
    let fetches = 0
    const f = createFetcher({ fetchImpl: async () => { fetches++; return html(LIST_HTML) } })
    const cache = new KindCache()
    const missing = source({ ruleFind: { kinds: [{ title: '玄幻', url: 'xuanhuan' }] } })
    const first = await fetchExploreGroup(missing, 'xuanhuan', f, cfg(cache))
    expect(first.error?.code).toBe('RuleMissing')
    expect(fetches).toBe(0)                        // 规则缺失在发请求之前就定了，一个包都没发
    const second = await fetchExploreGroup(source(), 'xuanhuan', f, cfg(cache))
    expect(fetches).toBe(1)
    expect(second.error).toBeUndefined()
    expect(second.hits.map((h) => h.title)).toEqual(['剑起长安'])
  })

  it('规则代际变了就是未命中（换键，不是删缓存）', async () => {
    let fetches = 0
    const f = createFetcher({ fetchImpl: async () => { fetches++; return html(LIST_HTML) } })
    const cache = new KindCache()
    const at = 1_000
    await fetchExploreGroup(source(), 'xuanhuan', f, { ...cfg(cache), now: () => at })
    await fetchExploreGroup(source(), 'xuanhuan', f, { ...cfg(cache), epoch: 8, now: () => at })
    expect(fetches).toBe(2)
    // 旧代际那一份仍在槽里：换键不删缓存，规则回滚也还能命中（这一层不替人做清理）。
    expect(cache.get({ sourceId: 'i', kind: 'xuanhuan', epoch: 7, page: 1 }, at)).not.toBeNull()
  })

  // 时效判据用的时钟是**调用方注入的那个**：实现里若写死真实时钟，下面这条会拿它去比刚存下的
  // `at: 0`，条目被判成过期而重抓——绿不绿取决于跑它的那天是几号。越界那一读顺带把槽删掉，但删除
  // 本身在这层没有对外读数（删与不删都读成 null），能被看见的只有「判成未命中」，所以钉的是它。
  it('时钟走注入的 now：TTL 边界内命中、越界即未命中并重抓', async () => {
    let fetches = 0
    const f = createFetcher({ fetchImpl: async () => { fetches++; return html(LIST_HTML) } })
    const cache = new KindCache()
    const stored = group('i')
    cache.put({ sourceId: 'i', kind: 'xuanhuan', epoch: 7, page: 1 }, stored, 0)
    const fresh = await fetchExploreGroup(source(), 'xuanhuan', f,
      { ...cfg(cache), now: () => EXPLORE_CACHE_TTL_MS })
    expect(fetches).toBe(0)
    expect(fresh).toBe(stored)
    const stale = await fetchExploreGroup(source(), 'xuanhuan', f,
      { ...cfg(cache), now: () => EXPLORE_CACHE_TTL_MS + 1 })
    expect(fetches).toBe(1)
    expect(stale.hits.map((h) => h.title)).toEqual(['剑起长安'])
  })

  // 缓存是可选件：缺省时这一层**不留任何跨调用的记忆**。单测直调执行体、以及没接快照的那条组合
  // 走的都是这条路——别让「反正有个默认值」把它接回某个隐式全局。
  it('不传 cache 时永不命中：同键两次各打一次', async () => {
    let fetches = 0
    const f = createFetcher({ fetchImpl: async () => { fetches++; return html(LIST_HTML) } })
    const first = await fetchExploreGroup(source(), 'xuanhuan', f, cfg())
    const second = await fetchExploreGroup(source(), 'xuanhuan', f, cfg())
    expect(fetches).toBe(2)
    expect(second).not.toBe(first)
    expect(second).toEqual(first)
  })
})
