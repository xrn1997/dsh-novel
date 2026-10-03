import { describe, expect, it } from 'vitest'
import { ExploreJobs, MAX_EXPLORE_PAGES } from '../../src/services/explore-job.js'
import type { JobHost } from '../../src/services/import-job.js'
import type { SearchGroup, SearchHit } from '../../src/shared/wire.js'

/** 分类轮次持有者：读面是**全量快照**而非游标增量——归并会修订已发出的条目
 *  （第二个源带回同一本书要给那条加 origin、`sourceCount` 跟着变），
 *  append-only 的 `added/next` 装不下这种修订。与 `search-job` 的差别仅此一处。 */

const hit = (title: string, author: string | null, url: string | null): SearchHit => ({
  title, author, url, coverUrl: null, intro: null, lastChapterName: null, kind: null, wordCount: null,
})

const g = (sourceId: string, title: string, author: string | null): SearchGroup => ({
  sourceId, sourceName: sourceId, status: 'verified',
  hits: [hit(title, author, `https://${sourceId}/${title}`)],
})

/** 组形状的入口（无地址的命中要自己凑：去重退路键那一侧得能被钉住） */
const group = (sourceId: string, hits: SearchHit[]): SearchGroup =>
  ({ sourceId, sourceName: sourceId, status: 'verified', hits })

/** 记 specs 与 done 结算的假宿主（与 search-job 测试同形，各自内联：测试桩不是生产逻辑） */
function fakeHost(): { host: JobHost; kinds: string[]; labels: string[]; settled: string[] } {
  const kinds: string[] = []
  const labels: string[] = []
  const settled: string[] = []
  const host: JobHost = {
    start: (spec) => {
      kinds.push(spec.kind); labels.push(spec.label)
      void spec.run().done.then((o) => { settled.push(o.status) })
      return `${spec.kind}-${kinds.length}`
    },
  }
  return { host, kinds, labels, settled }
}

const tick = async (): Promise<void> => { await new Promise((r) => setTimeout(r, 5)) }

describe('ExploreJobs', () => {
  it('跑完后快照是归并后的全量书单，失败源进 failures', async () => {
    const jobs = new ExploreJobs()
    jobs.start('玄幻', 2, async (emit) => {
      emit(g('A', '剑起长安', '青衫客'))
      emit({ ...g('B', '剑起长安', '青衫客'), sourceId: 'B' })
      emit({ sourceId: 'C', sourceName: 'C', status: 'broken', hits: [], error: { code: 'FetchError', message: '超时' } })
    })
    await new Promise((r) => setTimeout(r, 0))
    const s = jobs.snapshot()
    expect(s?.phase).toBe('done')
    expect(s?.books).toHaveLength(1)
    expect(s?.books[0].sourceCount).toBe(2)
    expect(s?.failures).toEqual([{ sourceId: 'C', sourceName: 'C', code: 'FetchError', message: '超时' }])
  })

  it('取消：phase=failed 且 cancelled=true（停止不是失败）', async () => {
    const jobs = new ExploreJobs()
    jobs.start('玄幻', 1, (_emit, shouldStop) => new Promise((res) => {
      const tick = setInterval(() => { if (shouldStop()) { clearInterval(tick); res(null) } }, 1)
    }))
    expect(jobs.cancel('用户停止')).toBe(true)
    const s = jobs.snapshot()
    expect(s?.phase).toBe('failed')
    expect(s?.cancelled).toBe(true)
  })

  it('新一轮替换上一轮（旧结果不再可读）', () => {
    const jobs = new ExploreJobs()
    jobs.start('玄幻', 0, async () => null)
    const first = jobs.snapshot()?.id
    jobs.start('都市', 0, async () => null)
    expect(jobs.snapshot()?.id).not.toBe(first)
    expect(jobs.snapshot()?.kind).toBe('都市')
  })
})

describe('ExploreJobs 读面与生命周期', () => {
  it('在跑时快照也归并（读时归并：第二个源带回同一本书，下一次快照自然合上）', async () => {
    const jobs = new ExploreJobs()
    let emit: (g: SearchGroup) => void = () => {}
    let finish: () => void = () => {}
    jobs.start('玄幻', 3, (e) => { emit = e; return new Promise<void>((res) => { finish = res }) })
    emit(g('A', '剑起长安', '青衫客'))
    expect(jobs.snapshot()).toMatchObject({ phase: 'running', done: 1, books: [{ name: '剑起长安', sourceCount: 1 }] })
    emit({ ...g('B', '剑起长安', '青衫客'), sourceId: 'B' })
    const mid = jobs.snapshot()
    expect(mid?.books).toHaveLength(1)
    expect(mid?.books[0].sourceCount).toBe(2)      // 已发出的那条被修订，而不是多出第二条
    expect(mid?.done).toBe(2)
    finish()
    await tick()
    expect(jobs.snapshot()?.phase).toBe('done')
  })

  it('从未提交过 → null；终态后过保留期 → null（「结果已过期」绝不伪装成「这一类没有书」）', async () => {
    let t = 1000
    const jobs = new ExploreJobs({ now: () => t })
    expect(jobs.snapshot()).toBeNull()
    jobs.start('玄幻', 0, async () => null)
    await tick()
    expect(jobs.snapshot()?.phase).toBe('done')
    t += 5 * 60_000 + 1
    expect(jobs.snapshot()).toBeNull()
  })

  it('运行器同步抛错：整轮立即落 failed 并带上是哪句错的，不留 running 空轮', () => {
    const jobs = new ExploreJobs()
    jobs.start('玄幻', 1, () => { throw new Error('计划为空') })
    const s = jobs.snapshot()
    expect(s?.phase).toBe('failed')
    expect(s?.error).toBe('计划为空')
    expect(s?.cancelled).toBe(false)              // 抛错不是用户停止
  })

  it('运行器 reject：落 failed，error 取 rejection 的 message', async () => {
    const jobs = new ExploreJobs()
    jobs.start('玄幻', 1, async () => { throw new Error('抓取失败') })
    await tick()
    expect(jobs.snapshot()).toMatchObject({ phase: 'failed', error: '抓取失败' })
  })

  it('已结束后 cancel 返回 false（no-op，不是第二次终态）', async () => {
    const jobs = new ExploreJobs()
    jobs.start('玄幻', 0, async () => null)
    await tick()
    expect(jobs.cancel('晚了')).toBe(false)
    expect(jobs.snapshot()).toMatchObject({ phase: 'done', cancelled: false })
  })
})

describe('ExploreJobs 登记给宿主 ctx.jobs', () => {
  it('kind novel-explore、label 带分类名与源数；自然收尾 completed、被取消 killed', async () => {
    const h = fakeHost()
    const jobs = new ExploreJobs({ host: h.host })
    jobs.start('玄幻', 3, async () => null)
    expect(h.kinds).toEqual(['novel-explore'])
    expect(h.labels[0]).toContain('玄幻')
    expect(h.labels[0]).toContain('3')
    await tick()
    expect(h.settled).toEqual(['completed'])
    jobs.start('都市', 2, () => new Promise<void>(() => {}))   // 只能被取消收手
    expect(jobs.cancel('不看了')).toBe(true)
    await tick()
    expect(h.settled).toEqual(['completed', 'killed'])
  })

  it('续页那一批的 label 不报源数：这一批只打在没到底的源上，照抄整轮的 total 就是报大了', async () => {
    const h = fakeHost()
    const jobs = new ExploreJobs({ host: h.host })
    jobs.start('玄幻', 3, async (emit) => { emit(g('A', '一', '甲')) })
    await tick()
    jobs.advance('玄幻', async (emit) => { emit(g('A', '二', '乙')) })
    await tick()
    expect(h.labels[0]).toContain('3')            // 第 1 页一个源都不跳：那个数就是它真正在问的数
    expect(h.labels[1]).toContain('第 2 页')
    expect(h.labels[1]).not.toContain('家书源')    // 宁可不说，也不说一个比真正在问的大一号的数
  })

  it('新一轮替换在跑的那轮：旧轮以 killed 结算给宿主，不留两条在途任务', async () => {
    const h = fakeHost()
    const jobs = new ExploreJobs({ host: h.host })
    jobs.start('玄幻', 1, () => new Promise<void>(() => {}))
    jobs.start('都市', 1, async () => null)
    await tick()
    expect(h.settled).toEqual(['killed', 'completed'])
  })
})

/** SSE 通道（`GET explore/list/job-stream`）的地基：持有者只发「变了」信号，快照由订阅者自取 */
describe('ExploreJobs.subscribe', () => {
  it('新一轮 / 每次 emit / 终态各响一次；退订后新的一轮不再打扰', async () => {
    const jobs = new ExploreJobs()
    let emit: (g: SearchGroup) => void = () => {}
    let finish: () => void = () => {}
    const seen: number[] = []
    const off = jobs.subscribe(() => { seen.push(jobs.snapshot()?.done ?? -1) })
    jobs.start('玄幻', 2, (e) => { emit = e; return new Promise<void>((res) => { finish = res }) })
    emit(g('A', '剑起长安', '青衫客'))
    finish()
    await tick()
    expect(seen).toEqual([0, 1, 1])                // 开场 + 新增分组 + 终态那一次必须响（SSE 据此收尾关流）
    off()
    jobs.start('都市', 0, async () => null)
    expect(seen).toHaveLength(3)
  })
})

/** 同轮续页：续页**不是**新一轮——浏览器半靠「同一轮 id + 整帧替换」这个读模型过日子，
 *  换 id 等于把它的列表清空重来。累积因此必须住在服务端：跨页去重与「零新增即到底」都要跨页记忆，
 *  而客户端刻意什么都不握。 */
describe('ExploreJobs 同轮续页', () => {
  it('advance：同一轮 id，第 2 页的新条目并进同一源的那一组、page 变 2', async () => {
    const jobs = new ExploreJobs()
    const page1 = g('A', '剑起长安', '青衫客')      // 留个引用：交进来的组不归持有者所有（见下面那条断言）
    const first = jobs.start('玄幻', 2, async (emit) => {
      emit(page1)
      emit(g('B', '都市之王', '甲'))
    })
    await tick()
    expect(jobs.snapshot()).toMatchObject({ id: first.jobId, page: 1, phase: 'done', hasMore: true })

    // 第 2 页只有 A 发了组（B 被 skip / 还在途——**没发组的源不许被补一个空组**）
    const again = jobs.advance('玄幻', async (emit) => { emit(g('A', '新书一', '乙')) })
    expect(again.jobId).toBe(first.jobId)          // 同一轮：不换 id
    await tick()

    const s = jobs.snapshot()
    expect(s).toMatchObject({ id: first.jobId, page: 2, phase: 'done', done: 2, hasMore: true })
    // 并进同一组：A 的新书紧挨着 A 第 1 页那条（组内顺序），且只有两个组（done 没涨）
    expect(s?.books.map((b) => b.name)).toEqual(['剑起长安', '新书一', '都市之王'])
    expect(s?.books.find((b) => b.name === '新书一')?.origins.map((o) => o.sourceId)).toEqual(['A'])
    // B 这一页没发组 ⇒ 它的累积（lastNew）一个字都没被碰：按 targets 推着合并会把它清零成「到底」
    expect(jobs.exhaustedSourceIds()).toEqual([])
    // **交进来的组一个字段都不许被改**：缓存组合下这个对象就是快照持有的那一份，原地塞进第 2 页的
    // 新书＝把累积写回快照（下一轮第 1 页端出整段并集、页码却写「已 1 页」，且第 2 页变成零新增）
    expect(page1.hits.map((h) => h.title)).toEqual(['剑起长安'])
  })

  it('某源第 2 页零新增即到底；全部源到底后 hasMore 变 false', async () => {
    const jobs = new ExploreJobs()
    jobs.start('玄幻', 2, async (emit) => {
      emit(g('A', '一', '甲'))
      emit(group('B', [hit('二', '乙', null)]))     // 无地址的命中：去重退路键是「书名 + NUL + 作者」
    })
    await tick()
    expect(jobs.snapshot()?.hasMore).toBe(true)

    jobs.advance('玄幻', async (emit) => {
      emit(g('A', '三', '丙'))
      emit(group('B', [hit('二', '乙', null)]))     // 与第 1 页同一条 ⇒ 零新增
    })
    await tick()
    const mid = jobs.snapshot()
    expect(mid).toMatchObject({ page: 2, hasMore: true })       // A 还在出新的 ⇒ 还能再点
    expect(jobs.exhaustedSourceIds()).toEqual(['B'])
    expect(mid?.books.filter((b) => b.origins.some((o) => o.sourceId === 'A'))).toHaveLength(2)

    jobs.advance('玄幻', async (emit) => { emit(g('A', '三', '丙')) })   // A 也零新增
    await tick()
    expect(jobs.exhaustedSourceIds().sort()).toEqual(['A', 'B'])
    expect(jobs.snapshot()?.hasMore).toBe(false)   // 全部到底：按钮该收掉，别再拿「还有更多」骗人
  })

  it('页数触到上限 → hasMore 为 false（兜底：翻页不是无底洞）', async () => {
    expect(MAX_EXPLORE_PAGES).toBe(10)             // 上限值本身是契约（改它要连这条一起改）
    const jobs = new ExploreJobs()
    jobs.start('玄幻', 1, async (emit) => { emit(g('A', '第1页', '甲')) })
    await tick()
    for (let p = 2; p <= MAX_EXPLORE_PAGES; p++) {
      jobs.advance('玄幻', async (emit) => { emit(g('A', `第${p}页`, '甲')) })
      await tick()
    }
    // 每一页都真有新书（没有一个源到底）——唯独页码到了上限
    expect(jobs.exhaustedSourceIds()).toEqual([])
    expect(jobs.snapshot()).toMatchObject({ page: MAX_EXPLORE_PAGES, hasMore: false })
  })

  it('没有可续的轮次 / 在途那批还没收手 / 分类不符：如实抛错，不做无效起跑', async () => {
    const jobs = new ExploreJobs()
    expect(() => jobs.advance('玄幻', async () => null)).toThrow('没有可续页的分类轮次')
    jobs.start('玄幻', 1, () => new Promise<void>(() => {}))          // 只能被取消收手：一直 running
    expect(() => jobs.advance('玄幻', async () => null)).toThrow('还在抓')
    expect(() => jobs.advance('都市', async () => null)).toThrow('分类不符')
  })

  it('在途那一批让 hasMore 为 false：契约只说「现在能不能点」（客户端自己用 running 显加载态）', async () => {
    const jobs = new ExploreJobs()
    let finish: () => void = () => {}
    jobs.start('玄幻', 1, (emit) => {
      emit(g('A', '剑起长安', '青衫客'))
      return new Promise<void>((res) => { finish = res })
    })
    expect(jobs.snapshot()).toMatchObject({ phase: 'running', hasMore: false })
    finish()
    await tick()
    expect(jobs.snapshot()).toMatchObject({ phase: 'done', hasMore: true })
  })

  it('某源第 2 页抓取失败：错误进 failures、上一页的累积原样留着、这个源不算到底（下次续页仍会打它）', async () => {
    const jobs = new ExploreJobs()
    jobs.start('玄幻', 1, async (emit) => { emit(g('A', '剑起长安', '青衫客')) })
    await tick()
    expect(jobs.snapshot()?.failures).toEqual([])

    const boom = { code: 'FetchError', message: '第 2 页超时' }
    jobs.advance('玄幻', async (emit) => {
      emit({ sourceId: 'A', sourceName: 'A', status: 'verified', hits: [], error: boom })
    })
    await tick()
    const s = jobs.snapshot()
    expect(s?.failures).toEqual([{ sourceId: 'A', sourceName: 'A', ...boom }])   // 失败如实摊开，不伪装成「没有更多」
    expect(s?.books.map((b) => b.name)).toEqual(['剑起长安'])                     // 上一页的累积一个字都没丢
    expect(s?.hasMore).toBe(true)
    expect(jobs.exhaustedSourceIds()).toEqual([])                                // 失败≠到底：这个源仍在续页目标里

    // 再点一次（目标里仍有 A）：新增落进同一组，且这一页的成功把那一次失败覆盖掉
    jobs.advance('玄幻', async (emit) => { emit(g('A', '新书一', '乙')) })
    await tick()
    const after = jobs.snapshot()
    expect(after?.failures).toEqual([])
    expect(after?.books.map((b) => b.name)).toEqual(['剑起长安', '新书一'])
  })

  it('第 1 页就失败的源：如实进 failures，且这一轮对它记到底（一条也没累积）；换一轮重新派生目标即重试', async () => {
    const jobs = new ExploreJobs()
    jobs.start('玄幻', 1, async (emit) => {
      emit({ sourceId: 'A', sourceName: 'A', status: 'verified', hits: [], error: { code: 'FetchError', message: '首页超时' } })
    })
    await tick()
    expect(jobs.snapshot()?.failures)
      .toEqual([{ sourceId: 'A', sourceName: 'A', code: 'FetchError', message: '首页超时' }])
    expect(jobs.exhaustedSourceIds()).toEqual(['A'])   // 一条都没累积：这一轮对它没有内容可续
    expect(jobs.snapshot()?.hasMore).toBe(false)

    // 换一轮：目标清单由注册表重新派生，上一轮的「到底」不跨轮传染
    jobs.start('玄幻', 1, async (emit) => { emit(g('A', '剑起长安', '青衫客')) })
    await tick()
    expect(jobs.snapshot()).toMatchObject({ page: 1, failures: [], hasMore: true })
    expect(jobs.snapshot()?.books.map((b) => b.name)).toEqual(['剑起长安'])
  })

  it('取消在途那一批后再续页：陈旧批次既不能接着吐组、也不能结算它已不再拥有的新一轮', async () => {
    const jobs = new ExploreJobs()
    let staleEmit: (g: SearchGroup) => void = () => {}
    let staleStop: () => boolean = () => true
    let staleFinish: () => void = () => {}
    jobs.start('玄幻', 2, (emit, shouldStop) => {
      staleEmit = emit; staleStop = shouldStop
      return new Promise<void>((res) => { staleFinish = res })      // 挂在途：只有测试放行才收手
    })
    expect(jobs.cancel('用户停止')).toBe(true)                       // 取消只落终态：在途请求不撤回，运行器仍在

    let pageFinish: () => void = () => {}
    jobs.advance('玄幻', (emit) => {
      emit(g('A', '新书一', '乙'))
      return new Promise<void>((res) => { pageFinish = res })
    })
    expect(jobs.snapshot()).toMatchObject({ phase: 'running', page: 2 })

    expect(staleStop()).toBe(true)                                  // 它已不再拥有这一轮：不会顺着 shouldStop 接着跑
    staleEmit(g('B', '幽灵书', '丙'))                                 // 迟到的分组不许落进新一轮
    staleFinish()                                                   // 它的收尾也不许替新批次结算
    await tick()
    expect(jobs.snapshot()).toMatchObject({ phase: 'running', page: 2 })
    expect(jobs.snapshot()?.books.map((b) => b.name)).toEqual(['新书一'])

    pageFinish()
    await tick()
    expect(jobs.snapshot()).toMatchObject({ phase: 'done', page: 2 })
  })
})

