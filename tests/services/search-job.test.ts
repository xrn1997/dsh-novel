import { describe, expect, it } from 'vitest'
import { SearchJobs } from '../../src/services/search-job.js'
import type { SearchJobRun } from '../../src/services/search-job.js'
import { SEARCH_HITS_CAP_PER_SOURCE, SEARCH_JOB_RETENTION_MS } from '../../src/shared/wire.js'
import type { SearchGroup, SearchHit } from '../../src/shared/wire.js'
import type { JobHost } from '../../src/services/import-job.js'

/** 搜索后台任务的持有者：整轮结果住服务端，读面给游标增量。它存在的理由是实测缺陷——
 *  浏览器半自持在途循环，切界面即丢结果（见 `docs/design/client.md` 已知开口）。 */

const hit = (i: number): SearchHit => ({
  title: `t${i}`, author: null, url: `https://x/${i}`, coverUrl: null, intro: null, lastChapterName: null,
  kind: null, wordCount: null,
})
const group = (src: string, hits: number): SearchGroup => ({
  sourceId: src, sourceName: src, status: 'verified',
  hits: Array.from({ length: hits }, (_, i) => hit(i)),
})

/** 可控运行器：测试自己决定何时 emit、何时收手、何时结束 */
function manualRun(): { run: SearchJobRun; emit: (g: SearchGroup) => void; finish: () => void; stopping: () => boolean } {
  let emit: (g: SearchGroup) => void = () => {}
  let stop = false
  let finish: () => void = () => {}
  const run: SearchJobRun = (e, shouldStop) => {
    emit = e
    return new Promise<void>((res) => { finish = () => { stop = shouldStop(); res() } })
  }
  return { run, emit: (g) => emit(g), finish: () => finish(), stopping: () => stop }
}

/** 记 specs 与 done 结算的假宿主（与 import-job 测试同形，各自内联：测试桩不是生产逻辑） */
function fakeHost(): { host: JobHost; kinds: string[]; labels: string[]; settled: string[] } {
  const kinds: string[] = []
  const labels: string[] = []
  const settled: string[] = []
  const host: JobHost = {
    start: (spec) => {
      kinds.push(spec.kind); labels.push(spec.label)
      const hooks = spec.run()
      void hooks.done.then((o) => { settled.push(o.status) })
      return `${spec.kind}-${kinds.length}`
    },
  }
  return { host, kinds, labels, settled }
}

const tick = async (): Promise<void> => { await new Promise((r) => setTimeout(r, 5)) }

describe('SearchJobs 读面快照', () => {
  it('running 中读增量：added/next 跟着游标走，游标超前只给空增量不报错', async () => {
    const m = manualRun()
    const jobs = new SearchJobs({ uuid: () => 'sj1' })
    jobs.start('斗罗', 3, m.run)
    const first = jobs.snapshot(0)
    expect(first).toMatchObject({ id: 'sj1', keyword: '斗罗', phase: 'running', total: 3, done: 0, next: 0 })
    expect(first?.added).toEqual([])
    m.emit(group('a', 1))
    m.emit(group('b', 2))
    const second = jobs.snapshot(first!.next)
    expect(second?.added.map((g) => g.sourceId)).toEqual(['a', 'b'])    // 完成序累积
    expect(second).toMatchObject({ done: 2, next: 2, phase: 'running' })
    expect(jobs.snapshot(99)?.added).toEqual([])                        // 超前游标：不抛，只给空增量
    expect(jobs.snapshot(99)?.next).toBe(2)
    m.finish()
    await tick()
    expect(jobs.snapshot(2)).toMatchObject({ phase: 'done', done: 2 })
    expect(typeof jobs.snapshot(0)?.finishedAt).toBe('number')
  })

  it('每源命中截断到上限（内存上限要有主），done 计数不受截断影响', async () => {
    const m = manualRun()
    const jobs = new SearchJobs()
    jobs.start('x', 1, m.run)
    m.emit(group('big', SEARCH_HITS_CAP_PER_SOURCE + 30))
    m.finish()
    await tick()
    const snap = jobs.snapshot(0)
    expect(snap?.added[0].hits).toHaveLength(SEARCH_HITS_CAP_PER_SOURCE)
    expect(snap?.done).toBe(1)
  })

  it('只留最近一轮：新提交即替换，旧任务读不出来', async () => {
    let n = 0
    const jobs = new SearchJobs({ uuid: () => `sj${++n}` })
    jobs.start('旧', 1, async () => {})
    await tick()
    jobs.start('新', 1, async () => {})
    expect(jobs.snapshot(0)).toMatchObject({ keyword: '新', id: 'sj2' })
  })

  it('结束后过保留期 → 读作「无任务」（null），不伪装成「搜了没命中」', async () => {
    let t = 1000
    const jobs = new SearchJobs({ now: () => t })
    jobs.start('x', 0, async () => {})
    await tick()
    expect(jobs.snapshot(0)?.phase).toBe('done')
    t += SEARCH_JOB_RETENTION_MS + 1
    expect(jobs.snapshot(0)).toBeNull()
  })

  it('停止（cancel）：标 cancelled、已 emit 的分组照旧可读、宿主仍结算 killed', async () => {
    const h = fakeHost()
    const jobs = new SearchJobs({ host: h.host })
    const m = manualRun()
    jobs.start('斗罗', 3, m.run)
    m.emit(group('a', 1))
    expect(jobs.cancel('用户停止了搜索')).toBe(true)
    const s = jobs.snapshot()
    expect(s?.cancelled).toBe(true)
    expect(s?.phase).toBe('failed')
    expect(s?.error).toContain('用户停止了搜索')
    expect(s?.added.map((g) => g.sourceId)).toEqual(['a'])   // 停止 ≠ 放弃：已经搜出来的还在
    await tick()
    expect(h.settled).toEqual(['killed'])                     // 宿主侧口径不变
    expect(jobs.cancel()).toBe(false)                        // 再点一次是空操作，不是第二次终态
  })

  it('cancel 立协作式旗：运行器下次取条目即收手，任务落 failed 且 error 说清被取消', async () => {
    let shouldStop: () => boolean = () => false
    let finish: () => void = () => {}
    const jobs = new SearchJobs()
    jobs.start('x', 5, (emit, ss) => { shouldStop = ss; return new Promise<void>((res) => { finish = res }) })
    expect(shouldStop()).toBe(false)
    expect(jobs.cancel('用户取消')).toBe(true)
    expect(shouldStop()).toBe(true)
    finish()
    await tick()
    expect(jobs.snapshot(0)).toMatchObject({ phase: 'failed' })
    expect(jobs.snapshot(0)?.error).toContain('已取消')
    expect(jobs.snapshot(0)?.error).toContain('用户取消')
    expect(jobs.cancel()).toBe(false)                                  // 已结束再取消 = no-op
  })
})

describe('SearchJobs 登记给宿主 ctx.jobs（与写任务同一口径）', () => {
  it('kind novel-search、label 带关键词；自然收尾 completed、被取消 killed', async () => {
    const h = fakeHost()
    const jobs = new SearchJobs({ host: h.host })
    const m = manualRun()
    jobs.start('斗罗', 1, m.run)
    expect(h.kinds).toEqual(['novel-search'])
    expect(h.labels[0]).toContain('斗罗')
    expect(jobs.snapshot()?.cancelled).toBe(false)           // 没停过就是 false：字段恒在，不靠缺键表达「否」
    m.emit(group('a', 1))
    m.finish()
    await tick()
    expect(h.settled).toEqual(['completed'])
    const never: SearchJobRun = () => new Promise<void>(() => {})      // 只能被取消收手
    jobs.start('斗罗2', 1, never)
    expect(jobs.cancel('换关键词了')).toBe(true)
    await tick()
    expect(h.settled).toEqual(['completed', 'killed'])
  })
})

/** SSE 通道（`GET search/job-stream`）的地基：持有者只发「变了」信号，游标归每条连接。
 *  信号不带数据是刻意的——多观察者各带各的游标读同一份持有物，谁都不替别人决定进度。 */
describe('SearchJobs.subscribe（推送加速器的事件口）', () => {
  it('新一轮 / 每次 emit / 终态各响一次；退订后新的一轮不再打扰', async () => {
    const jobs = new SearchJobs()
    const m = manualRun()
    const seen: Array<number | 'new'> = []
    let lastId = ''
    const off = jobs.subscribe((): void => {
      const s = jobs.snapshot()
      if (s !== null && s.id !== lastId) { lastId = s.id; seen.push('new') }
      seen.push(s?.done ?? -1)
    })
    jobs.start('斗罗', 2, m.run)
    expect(seen).toEqual(['new', 0])
    m.emit(group('a', 1))
    m.emit(group('b', 1))
    expect(seen).toEqual(['new', 0, 1, 2])
    m.finish()
    await tick()
    expect(seen).toEqual(['new', 0, 1, 2, 2])          // 终态那一次必须响：SSE 据此收尾关流
    off()
    jobs.start('斗罗2', 1, manualRun().run)
    expect(seen).toHaveLength(5)                       // 退订口真的退掉了
  })
})
