import { describe, expect, it } from 'vitest'
import { ReadingService } from '../../src/services/reading.js'
import { makeTempDir, trackService } from '../temp-dir.js'

const NATIVE = {
  name: 'S', url: 'https://s.com',
  searchUrl: '/so/{{keyword}}/{{page}}',
  ruleSearch: { list: '.item', name: 'h3 a', author: 'p a', bookUrl: 'h3 a@href' },
  ruleBookInfo: { name: '.booktxt h1' },
  ruleToc: { list: '#list li', name: 'a', url: 'a@href' },
  ruleContent: { content: '.con' },
  ruleFind: { url: '/{{kind}}/{{page}}', kinds: [{ title: '玄幻', url: 'xuanhuan' }] },
}
const LIST_HTML = '<html><body><div class="item"><h3><a href="/book/1">剑起长安</a></h3>' +
  '<p><a href="/zuozhe/a">青衫客</a></p></div></body></html>'

async function settle(svc: ReadingService): Promise<void> {
  for (let i = 0; i < 100 && svc.exploreJobSnapshot()?.phase === 'running'; i++) await new Promise((r) => setTimeout(r, 5))
}

describe('门面：分类浏览', () => {
  it('词表来自参与源；一轮跑完给出归并书单；再次进入命中进程内快照不再请求', async () => {
    const dir = await makeTempDir('novel-explore-')
    let fetches = 0
    const svc = trackService(await ReadingService.create({
      dir,
      fetchImpl: (async () => { fetches++; return new Response(LIST_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } }) }) as never,
    }))
    await svc.importOne(NATIVE)

    expect(svc.exploreKinds().kinds).toEqual([{ title: '玄幻', sources: 1 }])

    svc.startExploreJob('玄幻')
    await settle(svc)
    expect(svc.exploreJobSnapshot()?.phase).toBe('done')
    expect(svc.exploreJobSnapshot()?.books.map((b) => b.name)).toEqual(['剑起长安'])
    expect(fetches).toBe(1)

    svc.startExploreJob('玄幻')
    await settle(svc)
    expect(fetches).toBe(1)                    // 缓存命中：零请求
  })

  // 快照与续页同处一条链上（Important 缺陷的老家）：续页的累积**不许写回本轮收到的那个组**——编排层
  // 命中快照时 emit 的正是缓存持有的那个对象，原地塞进第 2 页的新书＝把累积写回快照。后果不是「多几
  // 本书」而是**静默不可达**：同一分类在 TTL 内再进一轮，第 1 页端出整段并集而页码写「已 1 页」，
  // 且第 2 页的取数变成缓存命中、内容已在并集里 ⇒ 零新增 ⇒ 被冤判到底，其后各页再也点不出来。
  it('TTL 内再进同一分类：第 1 页仍是首页那一份（续页的累积不写回快照），且仍有页可续', async () => {
    const dir = await makeTempDir('novel-explore4-')
    const seen: string[] = []
    const PAGE2_HTML = '<html><body><div class="item"><h3><a href="/book/2">长夜行</a></h3>' +
      '<p><a href="/zuozhe/b">乙</a></p></div></body></html>'
    const svc = trackService(await ReadingService.create({
      dir,
      fetchImpl: (async (input: unknown) => {
        const url = String(input)
        seen.push(url)
        return new Response(url.endsWith('/2') ? PAGE2_HTML : LIST_HTML,
          { headers: { 'content-type': 'text/html; charset=utf-8' } })
      }) as never,
    }))
    await svc.importOne(NATIVE)

    svc.startExploreJob('玄幻')
    await settle(svc)
    expect(svc.loadMoreExploreJob()).not.toBeNull()
    await settle(svc)
    expect(seen).toEqual(['https://s.com/xuanhuan', 'https://s.com/xuanhuan/2'])
    expect(svc.exploreJobSnapshot()?.books.map((b) => b.name)).toEqual(['剑起长安', '长夜行'])

    svc.startExploreJob('玄幻')                 // 同一分类、TTL 内：首页那条命中快照，零请求
    await settle(svc)
    const s = svc.exploreJobSnapshot()
    expect(s?.books.map((b) => b.name)).toEqual(['剑起长安'])   // 首页那一份，不是并集
    expect(s).toMatchObject({ page: 1, hasMore: true })         // 还有页可续：不许被上一轮的累积读成到底
    expect(seen).toHaveLength(2)                               // 首页仍是缓存命中
  })

  it('没有这一类的源 → total 为 0，跑完是空书单而不是错误', async () => {
    const dir = await makeTempDir('novel-explore2-')
    const svc = trackService(await ReadingService.create({ dir, fetchImpl: (async () => new Response('', { status: 404 })) as never }))
    await svc.importOne(NATIVE)
    svc.startExploreJob('不存在的一类')
    await settle(svc)
    expect(svc.exploreJobSnapshot()?.total).toBe(0)
    expect(svc.exploreJobSnapshot()?.books).toEqual([])
  })

  // 快照键用的是哪一份指纹，前两条用例分不出来（规则一字未改时两份指纹都不动）——这里动一条
  // **只被 `exploreEpoch` 收、而 `rulesEpoch` 不看**的发现面书目规则：抓取地址与列表规则
  // 一字未改，所以槽位 `KindCacheKey.kind` 不动，唯一能让第二轮重新发请求的就是代际。
  it('作者改了发现规则 → 同一分类不再命中旧快照（换规则自然失效，不必等 TTL）', async () => {
    const dir = await makeTempDir('novel-explore3-')
    let fetches = 0
    const svc = trackService(await ReadingService.create({
      dir,
      fetchImpl: (async () => { fetches++; return new Response(LIST_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } }) }) as never,
    }))
    await svc.importOne(NATIVE)
    svc.startExploreJob('玄幻')
    await settle(svc)
    expect(fetches).toBe(1)

    await svc.importOne({ ...NATIVE, ruleSearch: { ...NATIVE.ruleSearch, coverUrl: 'img@src' } })
    svc.startExploreJob('玄幻')
    await settle(svc)
    expect(fetches).toBe(2)
  })
})
