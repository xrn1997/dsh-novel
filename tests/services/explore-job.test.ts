import { describe, expect, it } from 'vitest'
import { ExploreJobs, MAX_EXPLORE_PAGES } from '../../src/services/explore-job.js'
import type { JobHost } from '../../src/services/import-job.js'
import type { SearchGroup, SearchHit } from '../../src/shared/wire.js'

/** 单源分类轮次的持有者：一轮 = **一个源 + 一个类**，跨页累积与「零新增即到底」的记忆都住在这里
 *  （浏览器半刻意什么都不握，读面是整帧替换的全量快照）。
 *  旧文件里那三族——按 sourceId 跨源累积、`skip` 的静默契约、「哪些源到底了」那份多源清单——
 *  测的都是「一轮打多个源」，浏览轴收成单源后它们的对象已不存在，随轴一起走。 */

const hit = (title: string, over: Partial<SearchHit> = {}): SearchHit => ({
  title, author: '甲', url: `https://s1/${title}`,
  coverUrl: null, intro: null, lastChapterName: null, kind: null, wordCount: null, ...over,
})

/** 组自带源身份（执行体交回的形状就是如此）；测试默认与提交时点名的那个源一致。
 *  无地址的命中要自己凑：去重退路键那一侧得能被钉住。 */
const group = (hits: SearchHit[], sourceId = 's1'): SearchGroup =>
  ({ sourceId, sourceName: sourceId, status: 'verified', hits })

const blankGroup: SearchGroup = { sourceId: 's1', sourceName: 's1', status: 'verified', hits: [] }

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

describe('ExploreJobs 单源轮次：跨页累积与到底判据', () => {
  it('单源跨页：同一轮累积、页码递增、快照整帧替换', async () => {
    const jobs = new ExploreJobs({ now: () => 1000, uuid: () => 'j1' })
    const r1 = jobs.start('s1', '玄幻', async (emit) => { emit(group([hit('a'), hit('b')])) })
    await tick()
    const first = jobs.snapshot()!
    expect(first.id).toBe('j1')
    expect(first.phase).toBe('done')
    expect(first.page).toBe(1)
    expect(first.sourceId).toBe('s1')
    expect(first.sourceName).toBe('s1')
    expect(first.books.map((b) => b.name)).toEqual(['a', 'b'])

    const r2 = jobs.advance('玄幻', async (emit) => { emit(group([hit('b'), hit('c')])) })
    expect(r2.jobId).toBe(r1.jobId)                       // 换页不换轮：客户端零累积的前提
    await tick()
    const snap = jobs.snapshot()!
    expect(snap.books.map((b) => b.name)).toEqual(['a', 'b', 'c'])   // 去重后并入
    expect(snap.page).toBe(2)
    expect(snap.hasMore).toBe(true)
  })

  it('本页零新增即这个源到底：hasMore 转 false（到底判据不自立第二个出口，读的就是这一条）', async () => {
    const jobs = new ExploreJobs({ now: () => 1000, uuid: () => 'j2' })
    jobs.start('s1', '玄幻', async (emit) => { emit(group([hit('a')])) })
    await tick()
    expect(jobs.snapshot()!.hasMore).toBe(true)
    jobs.advance('玄幻', async (emit) => { emit(group([hit('a')])) })   // 站点把上一页又给了一遍
    await tick()
    expect(jobs.snapshot()!.hasMore).toBe(false)
  })

  it('这一页抓取失败不算到底、也不许抹掉已累积的书单；下一次成功把它清掉', async () => {
    const jobs = new ExploreJobs({ now: () => 1000, uuid: () => 'j3' })
    jobs.start('s1', '玄幻', async (emit) => { emit(group([hit('a')])) })
    await tick()
    expect(jobs.snapshot()!.error).toBeUndefined()

    jobs.advance('玄幻', async (emit) => {
      emit({ ...blankGroup, error: { code: 'Timeout', message: '第 2 页超时' } })
    })
    await tick()
    const snap = jobs.snapshot()!
    expect(snap.books.map((b) => b.name)).toEqual(['a'])   // 已累积的一条都没被划掉
    expect(snap.hasMore).toBe(true)                        // 失败的一页不是到底那一页
    expect(snap.page).toBe(1)                              // 失败的那一页不占号（占号在成功并入那一拍，读数停在真到手的那页）
    expect(snap.phase).toBe('done')                        // 一轮跑完了：不是「失败的一轮」
    expect(snap.error).toContain('Timeout')                 // 但那一页没问到，必须看得见
    expect(snap.error).toContain('第 2 页超时')

    jobs.advance('玄幻', async (emit) => { emit(group([hit('z')])) })   // 下一次照旧打得出去
    await tick()
    const after = jobs.snapshot()!
    expect(after.books.map((b) => b.name)).toEqual(['a', 'z'])
    expect(after.page).toBe(2)                             // 占号发生在这一批成功并入的一刻
    expect(after.error).toBeUndefined()                    // 成功的一页把那次失败清掉
  })

  // 「下一次续页照旧会打它」这条承诺的唯一机械保证是**页码由持有者交出去**：运行器不该自己数页，
  // 门面也不该按读面页号 +1（那个数说的是「占到第几页」）。交出的页号因此是可断言的实参。
  it('页号交给运行器：失败那一批之后，下一次交出的仍是同一页', async () => {
    const jobs = new ExploreJobs({ now: () => 1000, uuid: () => 'j3c' })
    const handed: number[] = []
    jobs.start('s1', '玄幻', async (emit, _shouldStop, page) => {
      handed.push(page); emit(group([hit('a')]))
    })
    await tick()
    jobs.advance('玄幻', async (emit, _shouldStop, page) => {
      handed.push(page); emit({ ...blankGroup, error: { code: 'Timeout', message: '第 2 页超时' } })
    })
    await tick()
    expect(jobs.snapshot()!.page).toBe(1)
    jobs.advance('玄幻', async (emit, _shouldStop, page) => { handed.push(page); emit(group([hit('b')])) })
    await tick()
    expect(handed).toEqual([1, 2, 2])                      // 重打第 2 页，不是跳去第 3 页
    expect(jobs.snapshot()!.page).toBe(2)
    expect(jobs.snapshot()!.books.map((b) => b.name)).toEqual(['a', 'b'])
  })

  it('触到 MAX_EXPLORE_PAGES 上限即 hasMore false（上限是兜底，不是「没有更多」）', async () => {
    expect(MAX_EXPLORE_PAGES).toBe(10)                    // 上限值本身是契约（改它要连这条一起改）
    const jobs = new ExploreJobs({ now: () => 1000, uuid: () => 'j4' })
    jobs.start('s1', '玄幻', async (emit) => { emit(group([hit('p1')])) })
    await tick()
    for (let p = 2; p <= MAX_EXPLORE_PAGES; p++) {
      jobs.advance('玄幻', async (emit) => { emit(group([hit(`p${p}`)])) })
      await tick()
    }
    // 每一页都带回一本新书（这个源一页都没重复）——唯独页码到了上限：hasMore 为假说的是上限
    expect(jobs.snapshot()!.books).toHaveLength(MAX_EXPLORE_PAGES)
    const snap = jobs.snapshot()!
    expect(snap.page).toBe(MAX_EXPLORE_PAGES)
    expect(snap.hasMore).toBe(false)
  })

  it('换源提交即替换整轮：旧轮在途批次的结果一律弃', async () => {
    const jobs = new ExploreJobs({ now: () => 1000, uuid: () => 'j5' })
    let lateEmit: ((g: SearchGroup) => void) | null = null
    jobs.start('s1', '玄幻', (emit) => { lateEmit = emit; return new Promise<void>(() => {}) })
    jobs.start('s2', '都市', async (emit) => { emit(group([hit('新源的书')], 's2')) })
    lateEmit!(group([hit('旧源迟到的书')]))                // 旧批还在跑，它已不再拥有这一轮
    await tick()
    const snap = jobs.snapshot()!
    expect(snap.sourceId).toBe('s2')
    expect(snap.sourceName).toBe('s2')
    expect(snap.kind).toBe('都市')
    expect(snap.page).toBe(1)
    expect(snap.books.map((b) => b.name)).toEqual(['新源的书'])
  })

  it('绝不原地改交进来的那个组：命中缓存时它就是缓存持有的那一份，改它等于把累积写回快照', async () => {
    const jobs = new ExploreJobs()
    const page1 = group([hit('a')])
    jobs.start('s1', '玄幻', async (emit) => { emit(page1) })
    await tick()
    jobs.advance('玄幻', async (emit) => { emit(page1) })   // 同一个对象再交一次：缓存命中的形状
    await tick()
    expect(page1.hits.map((h) => h.title)).toEqual(['a'])   // 一个字段都没被改
    const snap = jobs.snapshot()!
    expect(snap.books.map((b) => b.name)).toEqual(['a'])    // 并进来的还是那一条，没翻倍
    expect(snap.page).toBe(2)
    expect(snap.hasMore).toBe(false)                       // 同一条 ⇒ 零新增 ⇒ 到底
  })

  it('去重按规范地址：主机的书写差异不构成第二本书', async () => {
    const jobs = new ExploreJobs()
    jobs.start('s1', '玄幻', async (emit) => { emit(group([hit('a')])) })
    await tick()
    jobs.advance('玄幻', async (emit) => { emit(group([hit('a', { url: 'https://S1/a' })])) })
    await tick()
    expect(jobs.snapshot()!.books.map((b) => b.name)).toEqual(['a'])
    expect(jobs.snapshot()!.hasMore).toBe(false)
  })

  it('没地址的命中退回「书名 + NUL + 作者」去重，并把 null 地址如实带进快照', async () => {
    const jobs = new ExploreJobs()
    jobs.start('s1', '玄幻', async (emit) => { emit(group([hit('a', { url: null })])) })
    await tick()
    expect(jobs.snapshot()!.books[0].bookUrl).toBeNull()   // 这个源没给入口：读与架都不给按钮
    jobs.advance('玄幻', async (emit) => { emit(group([hit('a', { url: null })])) })
    await tick()
    expect(jobs.snapshot()!.books.map((b) => b.name)).toEqual(['a'])
    expect(jobs.snapshot()!.hasMore).toBe(false)
  })

  it('这一类真的没货：空 hits 是 done 且没有 error，不与「这一页没问到」折叠成同一帧', async () => {
    const jobs = new ExploreJobs()
    jobs.start('s1', '玄幻', async (emit) => { emit(blankGroup) })
    await tick()
    const snap = jobs.snapshot()!
    expect(snap.phase).toBe('done')
    expect(snap.books).toEqual([])
    expect(snap.error).toBeUndefined()
    expect(snap.hasMore).toBe(false)
  })

  it('第 1 页就失败：错误看得见，这一轮对它无页可续；重新提交一轮照旧打得出去', async () => {
    const jobs = new ExploreJobs()
    jobs.start('s1', '玄幻', async (emit) => {
      emit({ ...blankGroup, error: { code: 'FetchError', message: '首页超时' } })
    })
    await tick()
    const s = jobs.snapshot()!
    expect(s.phase).toBe('done')                            // 整轮跑完了，只是那一页没问到
    expect(s.error).toContain('首页超时')
    expect(s.books).toEqual([])                             // 一条都没累积
    expect(s.hasMore).toBe(false)                           // 续页对它无页可续

    jobs.start('s1', '玄幻', async (emit) => { emit(group([hit('a')])) })
    await tick()
    expect(jobs.snapshot()).toMatchObject({ page: 1, hasMore: true })
    expect(jobs.snapshot()!.error).toBeUndefined()          // 上一轮那次失败不跨轮传染
  })

  it('书目就是站点给的那一条：不做任何合并，顺序与字段照原样', async () => {
    const jobs = new ExploreJobs()
    jobs.start('s1', '玄幻', async (emit) => {
      emit(group([
        { ...hit('剑起长安'), coverUrl: 'https://s1/c.jpg', kind: '玄幻', intro: '简介', wordCount: '3.2万字', lastChapterName: '第九章' },
        { ...hit('万古天河'), coverUrl: '' },
      ]))
    })
    await tick()
    const books = jobs.snapshot()!.books
    expect(books.map((b) => b.name)).toEqual(['剑起长安', '万古天河'])
    expect(books[0]).toEqual({
      name: '剑起长安', author: '甲', bookUrl: 'https://s1/剑起长安', coverUrl: 'https://s1/c.jpg',
      kind: '玄幻', lastChapter: '第九章', intro: '简介', wordCount: '3.2万字',
    })
    expect(books[1].coverUrl).toBe(null)                     // 空串收口成 null：键在场，值说「没给封面」
  })
})

describe('ExploreJobs 读面与生命周期', () => {
  it('从未提交过 → null；终态后过保留期 → null（「结果已过期」绝不伪装成「这一类没有书」）', async () => {
    let t = 1000
    const jobs = new ExploreJobs({ now: () => t })
    expect(jobs.snapshot()).toBeNull()
    jobs.start('s1', '玄幻', async () => null)
    await tick()
    expect(jobs.snapshot()?.phase).toBe('done')
    t += 5 * 60_000 + 1
    expect(jobs.snapshot()).toBeNull()
  })

  it('运行器同步抛错：整轮立即落 failed 并带上是哪句错的，不留 running 空轮', () => {
    const jobs = new ExploreJobs()
    jobs.start('s1', '玄幻', () => { throw new Error('计划为空') })
    const s = jobs.snapshot()
    expect(s?.phase).toBe('failed')
    expect(s?.error).toBe('计划为空')
    expect(s?.cancelled).toBe(false)                        // 抛错不是用户停止
  })

  it('运行器 reject：落 failed，error 取 rejection 的 message', async () => {
    const jobs = new ExploreJobs()
    jobs.start('s1', '玄幻', async () => { throw new Error('抓取失败') })
    await tick()
    expect(jobs.snapshot()).toMatchObject({ phase: 'failed', error: '抓取失败' })
  })

  it('取消：phase=failed 且 cancelled=true（停止不是失败）', async () => {
    const jobs = new ExploreJobs()
    jobs.start('s1', '玄幻', (_emit, shouldStop) => new Promise((res) => {
      const timer = setInterval(() => { if (shouldStop()) { clearInterval(timer); res(null) } }, 1)
    }))
    expect(jobs.cancel('用户停止')).toBe(true)
    const s = jobs.snapshot()
    expect(s?.phase).toBe('failed')
    expect(s?.cancelled).toBe(true)
  })

  it('已结束后 cancel 返回 false（no-op，不是第二次终态）', async () => {
    const jobs = new ExploreJobs()
    jobs.start('s1', '玄幻', async () => null)
    await tick()
    expect(jobs.cancel('晚了')).toBe(false)
    expect(jobs.snapshot()).toMatchObject({ phase: 'done', cancelled: false })
  })
})

describe('ExploreJobs 同轮续页的守卫', () => {
  it('没有可续的轮次 / 在途那批还没收手 / 分类不符：三种「续不动」都如实抛错，不做无效起跑', () => {
    const jobs = new ExploreJobs()
    expect(() => jobs.advance('玄幻', async () => null)).toThrow('没有可续页的分类轮次')
    jobs.start('s1', '玄幻', () => new Promise<void>(() => {}))          // 只能被取消收手：一直 running
    expect(() => jobs.advance('玄幻', async () => null)).toThrow('还在抓')
    expect(() => jobs.advance('都市', async () => null)).toThrow('轮次分类不符')
  })

  it('在途那一批让 hasMore 为 false：契约只说「现在能不能点」（客户端自己用 running 显加载态）', async () => {
    const jobs = new ExploreJobs()
    let finish: () => void = () => {}
    jobs.start('s1', '玄幻', (emit) => {
      emit(group([hit('a')]))
      return new Promise<void>((res) => { finish = res })
    })
    expect(jobs.snapshot()).toMatchObject({ phase: 'running', hasMore: false })
    finish()
    await tick()
    expect(jobs.snapshot()).toMatchObject({ phase: 'done', hasMore: true })
  })

  it('取消在途那一批后再续页：陈旧批次既不能接着吐组、也不能结算它已不再拥有的新一轮', async () => {
    const jobs = new ExploreJobs()
    let staleEmit: (g: SearchGroup) => void = () => {}
    let staleStop: () => boolean = () => true
    let staleFinish: () => void = () => {}
    jobs.start('s1', '玄幻', (emit, shouldStop) => {
      staleEmit = emit; staleStop = shouldStop
      return new Promise<void>((res) => { staleFinish = res })      // 挂在途：只有测试放行才收手
    })
    expect(jobs.cancel('用户停止')).toBe(true)                       // 取消只落终态：在途请求不撤回，运行器仍在

    let pageFinish: () => void = () => {}
    jobs.advance('玄幻', (emit) => {
      emit(group([hit('新书一')]))
      return new Promise<void>((res) => { pageFinish = res })
    })
    expect(jobs.snapshot()).toMatchObject({ phase: 'running', page: 2 })

    expect(staleStop()).toBe(true)                                  // 它已不再拥有这一轮：顺着 shouldStop 不会再跑
    staleEmit(group([hit('幽灵书')]))                                 // 迟到的组不许落进新一轮
    staleFinish()                                                   // 它的收尾也不许替新批次结算
    await tick()
    expect(jobs.snapshot()).toMatchObject({ phase: 'running', page: 2 })
    expect(jobs.snapshot()?.books.map((b) => b.name)).toEqual(['新书一'])

    pageFinish()
    await tick()
    expect(jobs.snapshot()).toMatchObject({ phase: 'done', page: 2 })
    expect(jobs.snapshot()?.books.map((b) => b.name)).toEqual(['新书一'])
  })
})

/** 轮次落定（被取消 / 已结束）之后，同一批迟到的组仍会走到持有者手里——协作式取消不撤回在途请求、
 *  代际也没变。两条口径要同时立住：**条目照旧并入**（结果保留是既有语义），**错误泳道不动**
 *  （迟到那一页的成败是页的事实，不许回头改写「这一轮为什么结束」那一句）。 */
describe('ExploreJobs 终态之后迟到的批次', () => {
  it('取消后同批迟到的组：页级失败不盖掉取消说明，条目照旧并入', () => {
    const jobs = new ExploreJobs()
    let late: (g: SearchGroup) => void = () => {}
    jobs.start('s1', '玄幻', (emit) => { late = emit; return new Promise<void>(() => {}) })
    expect(jobs.cancel('用户停止')).toBe(true)
    late({ ...blankGroup, error: { code: 'Timeout', message: '第 1 页超时' } })   // 迟到的失败组
    late(group([hit('幽灵书')]))                                                   // 同批迟到的成功组
    const s = jobs.snapshot()!
    expect(s.error).toBe('任务已取消：用户停止')            // 终态那句说的是这一轮为什么结束
    expect(s.cancelled).toBe(true)
    expect(s.phase).toBe('failed')
    expect(s.books.map((b) => b.name)).toEqual(['幽灵书'])   // 修复不许顺手把累积也停了
  })

  // 源名与错误泳道是同一条边界上的东西：它说的是「这一轮是哪个源」，属于**轮次**的结论，
  // 而不是条目。写在闸外时，终态后迟到的那一批照样能替这一轮报名——与「迟到批次不拥有这一轮的结论」
  // 自相矛盾，而读面（`ExploreSnapshot.sourceName`）正是界面那行源名的唯一出处。
  it('终态后迟到的组不改写轮次的源名：条并进来了，名字仍由这一轮自己说', () => {
    const jobs = new ExploreJobs()
    let late: (g: SearchGroup) => void = () => {}
    jobs.start('s1', '玄幻', (emit) => { late = emit; return new Promise<void>(() => {}) })
    expect(jobs.cancel('用户停止')).toBe(true)                 // 一轮在没有任何组时就落定了
    late({ ...group([hit('幽灵书')]), sourceName: '迟到批次的自我报名' })
    const s = jobs.snapshot()!
    expect(s.sourceName).toBe('')
    expect(s.books.map((b) => b.name)).toEqual(['幽灵书'])      // 条目照旧并入
  })

  it('有过页级失败 → 取消 → 同批迟到的成功组：取消说明不被清成「没有错误」', async () => {
    const jobs = new ExploreJobs()
    jobs.start('s1', '玄幻', async (emit) => { emit(group([hit('a')])) })
    await tick()
    jobs.advance('玄幻', async (emit) => {
      emit({ ...blankGroup, error: { code: 'Timeout', message: '第 2 页超时' } })
    })
    await tick()
    expect(jobs.snapshot()!.error).toContain('这一页没回来')     // 页泳道此刻就是这一轮的错误读数
    let late: (g: SearchGroup) => void = () => {}
    jobs.advance('玄幻', (emit) => { late = emit; return new Promise<void>(() => {}) })
    expect(jobs.cancel('用户停止')).toBe(true)
    expect(jobs.snapshot()!.error).toBe('任务已取消：用户停止')   // 新一批起跑时那句页级读数让位了
    late(group([hit('z')]))                                       // 那一批手里还攥着上一次失败的记录
    await tick()
    const s = jobs.snapshot()!
    expect(s.error).toBe('任务已取消：用户停止')
    expect(s.books.map((b) => b.name)).toEqual(['a', 'z'])
  })
})

describe('ExploreJobs 登记给宿主 ctx.jobs', () => {
  it('kind novel-explore、label 带分类名与页码；自然收尾 completed、被取消 killed', async () => {
    const h = fakeHost()
    const jobs = new ExploreJobs({ host: h.host })
    jobs.start('s1', '玄幻', async () => null)
    expect(h.kinds).toEqual(['novel-explore'])
    expect(h.labels[0]).toContain('玄幻')
    expect(h.labels[0]).toContain('第 1 页')
    expect(h.labels[0]).not.toContain('家书源')              // 单源下那是个恒为 1 的常数，报它不携带信息
    await tick()
    expect(h.settled).toEqual(['completed'])
    jobs.start('s1', '都市', () => new Promise<void>(() => {}))   // 只能被取消收手
    expect(jobs.cancel('不看了')).toBe(true)
    await tick()
    expect(h.settled).toEqual(['completed', 'killed'])
  })

  it('每一批各领一次登记，页码跟着批次走', async () => {
    const h = fakeHost()
    const jobs = new ExploreJobs({ host: h.host })
    jobs.start('s1', '玄幻', async (emit) => { emit(group([hit('a')])) })
    await tick()
    jobs.advance('玄幻', async (emit) => { emit(group([hit('b')])) })
    await tick()
    expect(h.labels).toEqual(['书城分类「玄幻」第 1 页', '书城分类「玄幻」第 2 页'])
    expect(h.settled).toEqual(['completed', 'completed'])
  })

  it('新一轮替换在跑的那轮：旧轮以 killed 结算给宿主，不留两条在途任务', async () => {
    const h = fakeHost()
    const jobs = new ExploreJobs({ host: h.host })
    jobs.start('s1', '玄幻', () => new Promise<void>(() => {}))
    jobs.start('s2', '都市', async () => null)
    await tick()
    expect(h.settled).toEqual(['killed', 'completed'])
    expect(jobs.snapshot()).toMatchObject({ sourceId: 's2', kind: '都市' })
  })
})

/** SSE 通道（`GET explore/list/job-stream`）的地基：持有者只发「变了」信号，快照由订阅者自取 */
describe('ExploreJobs.subscribe', () => {
  it('新一轮 / 每次 emit / 终态各响一次；退订后新的一轮不再打扰', async () => {
    const jobs = new ExploreJobs()
    let emit: (g: SearchGroup) => void = () => {}
    let finish: () => void = () => {}
    const seen: number[] = []
    const off = jobs.subscribe(() => { seen.push(jobs.snapshot()?.books.length ?? -1) })
    jobs.start('s1', '玄幻', (e) => { emit = e; return new Promise<void>((res) => { finish = res }) })
    emit(group([hit('a')]))
    finish()
    await tick()
    expect(seen).toEqual([0, 1, 1])                // 开场 + 新条目 + 终态那一次必须响（SSE 据此收尾关流）
    off()
    jobs.start('s1', '都市', async () => null)
    expect(seen).toHaveLength(3)
  })
})
