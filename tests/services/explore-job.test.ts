import { describe, expect, it } from 'vitest'
import { ExploreJobs } from '../../src/services/explore-job.js'
import type { JobHost } from '../../src/services/import-job.js'
import type { SearchGroup } from '../../src/shared/wire.js'

/** 分类轮次持有者：读面是**全量快照**而非游标增量——归并会修订已发出的条目
 *  （第二个源带回同一本书要给那条加 origin、`sourceCount` 跟着变），
 *  append-only 的 `added/next` 装不下这种修订。与 `search-job` 的差别仅此一处。 */

const g = (sourceId: string, title: string, author: string | null): SearchGroup => ({
  sourceId, sourceName: sourceId, status: 'verified',
  hits: [{ title, author, url: `https://${sourceId}/${title}`, coverUrl: null, intro: null, lastChapterName: null, kind: null, wordCount: null }],
})

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
