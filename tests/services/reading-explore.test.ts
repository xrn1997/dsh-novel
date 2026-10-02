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
