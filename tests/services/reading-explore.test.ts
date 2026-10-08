import { describe, expect, it } from 'vitest'
import { MAX_EXPLORE_PAGES } from '../../src/services/explore-job.js'
import { ReadingService } from '../../src/services/reading.js'
import { makeTempDir, trackService } from '../temp-dir.js'
import { settleExploreRound } from '../explore-settle.js'

/** legado 方言的发现面夹具：`exploreUrl` 的「标题::URL」多行形态（解析单点 `parseExploreKinds`）。
 *  两类各带**自己**的整条分页模板，于是「同一源的两个类」天然是两个槽位——按源浏览要的就是这一档
 *  （数据面的裁决见 `docs/adr/0027`，浏览轴的见 `docs/adr/0028`）。
 *  规则一律显式写 `@text` 终端：补隐式文本是原生方言那一档的口径，对象方言不补。 */
const LEGADO = {
  bookSourceName: '站点甲', bookSourceUrl: 'https://s.com',
  searchUrl: '/so/{{key}}/{{page}}',
  ruleSearch: { bookList: '.item', name: 'h3 a@text', author: 'p a@text', bookUrl: 'h3 a@href' },
  ruleContent: { content: '.con' },
  exploreUrl: '玄幻::/list/xh/{{page}}.html\n都市::/list/ds/{{page}}.html',
}
const LIST_HTML = '<html><body><div class="item"><h3><a href="/book/1">剑起长安</a></h3>' +
  '<p><a href="/zuozhe/a">青衫客</a></p></div></body></html>'
const HTML = { headers: { 'content-type': 'text/html; charset=utf-8' } }

/** 一个可点的 legado 源 + 它的 id：点名要用 id，而 id 由导入侧生成，不硬编。 */
async function oneSource(): Promise<{ svc: ReadingService; id: string }> {
  const dir = await makeTempDir('novel-explore-')
  const svc = trackService(await ReadingService.create({
    dir,
    fetchImpl: (async () => new Response(LIST_HTML, HTML)) as never,
  }))
  await svc.importOne(LEGADO)
  return { svc, id: svc.listPublicSources()[0].id }
}

describe('门面：按源提交分类轮次', () => {
  it('词表按源给出、只给标题不给地址', async () => {
    const { svc } = await oneSource()
    expect(svc.exploreSources()).toMatchObject({
      sources: [{ name: '站点甲', kinds: ['玄幻', '都市'] }],
    })
    expect(JSON.stringify(svc.exploreSources())).not.toContain('/list/')   // 入口地址不外泄
  })

  it('点不到入口的源/类一律抛错，不给一个空轮次（空轮次会被读成「这一类没有书」）', async () => {
    const { svc, id } = await oneSource()
    expect(() => svc.startExploreJob('nope', '玄幻')).toThrow('该源没有可用的分类入口')
    expect(() => svc.startExploreJob(id, '没有这一类')).toThrow('该源没有可用的分类入口')
    expect(svc.exploreJobSnapshot()).toBeNull()                            // 抛错不留下任何一轮
  })

  // 参与判据（启用 ∧ 文本源 ∧ 有入口 ∧ 没关掉发现）的主人是 `participation.exploreParticipates`，
  // 点名那一步不许另立第二份「能不能进城」——被关掉的源在派生面隐身，硬报类名同样点不到。
  it('关掉发现的源点不到：派生面里没有它，报类名也抛（参与判据不复制第二份）', async () => {
    const dir = await makeTempDir('novel-explore-')
    const svc = trackService(await ReadingService.create({
      dir,
      fetchImpl: (async () => new Response(LIST_HTML, HTML)) as never,
    }))
    const off = await svc.importOne({ ...LEGADO, bookSourceName: '站点关', bookSourceUrl: 'https://off.com', enabledExplore: false })
    await svc.importOne({ ...LEGADO, bookSourceName: '站点开', bookSourceUrl: 'https://on.com' })
    expect(svc.exploreSources().sources.map((s) => s.name)).toEqual(['站点开'])
    expect(() => svc.startExploreJob(off.sourceId!, '玄幻')).toThrow('该源没有可用的分类入口')
  })

  it('快照带源身份与整帧书单；换类换轮，同类再进命中进程内快照、零请求', async () => {
    let fetches = 0
    const dir = await makeTempDir('novel-explore-')
    const svc = trackService(await ReadingService.create({
      dir,
      fetchImpl: (async () => { fetches++; return new Response(LIST_HTML, HTML) }) as never,
    }))
    await svc.importOne(LEGADO)
    const id = svc.listPublicSources()[0].id
    svc.startExploreJob(id, '玄幻')
    await settleExploreRound(svc)
    expect(svc.exploreJobSnapshot()).toMatchObject({
      sourceId: id, sourceName: '站点甲', kind: '玄幻', page: 1, phase: 'done',
    })
    expect(svc.exploreJobSnapshot()!.books.map((b) => b.name)).toEqual(['剑起长安'])
    expect(svc.exploreJobSnapshot()!.books[0].bookUrl).toContain('/book/1')
    svc.startExploreJob(id, '都市')          // 换类 = 换轮，另一份缓存槽
    await settleExploreRound(svc)
    expect(fetches).toBe(2)                  // 每类各打一次；同类的第二次才是命中
    svc.startExploreJob(id, '都市')
    await settleExploreRound(svc)
    expect(fetches).toBe(2)
  })

  it('续页只在这一轮还能打时发；到底即 null，路由据此回 409', async () => {
    const { svc, id } = await oneSource()
    svc.startExploreJob(id, '玄幻')
    await settleExploreRound(svc)
    for (let i = 0; i < MAX_EXPLORE_PAGES; i++) { svc.loadMoreExploreJob(); await settleExploreRound(svc) }
    expect(svc.exploreJobSnapshot()!.hasMore).toBe(false)
    expect(svc.loadMoreExploreJob()).toBeNull()
  })

  // 「点不到入口」在两个门面上是两种事实：提交时点名点不到要抛（用户主动点的，必须响亮），
  // 续页时点不到是**没得可加载**（轮次还显示着，路由回 409、客户端把按钮收掉）。
  // 源被删除正是后者——报成前者等于拿注册表的变动算成用户的操作失误。
  it('轮次还在显示而源已被删除：续页返回 null 而不是抛错，且不动这一轮的读数', async () => {
    const { svc, id } = await oneSource()
    svc.startExploreJob(id, '玄幻')
    await settleExploreRound(svc)
    expect(svc.exploreJobSnapshot()!.hasMore).toBe(true)
    await svc.removeSource(id)
    expect(svc.loadMoreExploreJob()).toBeNull()
    expect(svc.exploreJobSnapshot()).toMatchObject({ phase: 'done', page: 1, cancelled: false })
    expect(() => svc.startExploreJob(id, '玄幻')).toThrow('该源没有可用的分类入口')   // 同一条判据，另一种后果
  })

  // 「下一次续页照旧会打它」这条承诺在门面上只有一个可读数：**请求地址**。页号由持有者交给运行器，
  // 失败那一页不占号（口径住 `services/explore-job.ts` 的 `Held.page`），门面因此没有第二条算式可走。
  it('第 2 页没回来：再点续页重打第 2 页那一条地址，而不是第 3 页', async () => {
    const seen: string[] = []
    let breakNext = false
    const dir = await makeTempDir('novel-explore-')
    const svc = trackService(await ReadingService.create({
      dir,
      fetchImpl: (async (input: RequestInfo | URL) => {
        const url = String(input)
        seen.push(url)
        if (breakNext) { breakNext = false; throw new Error('站点断了') }
        return new Response(LIST_HTML, HTML)
      }) as never,
    }))
    await svc.importOne(LEGADO)
    const id = svc.listPublicSources()[0].id
    svc.startExploreJob(id, '玄幻')
    await settleExploreRound(svc)

    breakNext = true
    svc.loadMoreExploreJob()
    await settleExploreRound(svc)
    const failed = svc.exploreJobSnapshot()!
    expect(failed.page).toBe(1)                            // 没到手的这一页不占号
    expect(failed.hasMore).toBe(true)                      // 也不算到底：还能再点一次
    expect(failed.error).toContain('这一页没回来')
    expect(failed.books.map((b) => b.name)).toEqual(['剑起长安'])

    svc.loadMoreExploreJob()
    await settleExploreRound(svc)
    expect(seen[1]).not.toBe(seen[0])                      // 夹具里第 1、2 页确实是两个地址
    expect(seen[seen.length - 1]).toBe(seen[1])            // 重打的就是第 2 页那条
    const retried = svc.exploreJobSnapshot()!
    expect(retried.page).toBe(2)                           // 成功后才占号
    expect(retried.error).toBeUndefined()                  // 那次失败被到手的这一页清掉
    expect(retried.books.map((b) => b.name)).toEqual(['剑起长安'])   // 夹具每页给同一本书：去重后不翻倍
  })

  it('换源提交即替换整轮：旧轮在途的结果不写进新一轮', async () => {
    const { svc, id } = await oneSource()
    await svc.importOne({ ...LEGADO, bookSourceName: '站点乙', bookSourceUrl: 'https://t.com' })
    const id2 = svc.listPublicSources().find((s) => s.name === '站点乙')!.id
    svc.startExploreJob(id, '玄幻')
    svc.startExploreJob(id2, '都市')
    expect(svc.exploreJobSnapshot()).toMatchObject({ sourceId: id2, kind: '都市' })
  })
})
