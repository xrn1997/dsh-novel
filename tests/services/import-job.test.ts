import { describe, expect, it } from 'vitest'
import { SourceRegistry } from '../../src/services/sources.js'
import type { ProbeResult } from '../../src/services/probe.js'
import { JobRunningError, SourceJobs, dedupKey } from '../../src/services/import-job.js'
import type { JobState } from '../../src/services/import-job.js'
import { makeTempDir } from '../temp-dir.js'

const raw = (n: string, url: string) => ({
  bookSourceName: n, bookSourceUrl: url, ruleContent: '@css:#c@text',
})
const okProbe: ProbeResult = { ok: true, itemCount: 1, firstTitle: 'x', probedAt: 0 }

async function mkJobs(
  probe = async (): Promise<ProbeResult> => okProbe,
): Promise<{ jobs: SourceJobs; registry: SourceRegistry }> {
  const dir = await makeTempDir('novel-job-')
  const registry = await SourceRegistry.load(dir)
  return { jobs: new SourceJobs({ registry, probe, uuid: () => `job-${Math.random()}` }), registry }
}

/** 轮询等任务收尾（与 API 测试同款口径） */
async function waitDone(jobs: SourceJobs): Promise<JobState> {
  for (let i = 0; i < 400; i++) {
    const j = jobs.status()
    if (j !== null && j.phase !== 'running') return j
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error('任务未在限时内结束')
}

describe('SourceJobs 单任务槽', () => {
  it('启动导入 → status 立即可见 running；结束后 phase done 且结果保留', async () => {
    const { jobs } = await mkJobs()
    const { jobId } = jobs.startImport([{ name: 'a.json', text: JSON.stringify([raw('A', 'https://a.com')]) }])
    const j0 = jobs.status()
    expect(j0).toMatchObject({ id: jobId, kind: 'import', phase: 'running' })
    const j = await waitDone(jobs)
    expect(j.phase).toBe('done')
    expect(j.total).toBe(1)
    expect(j.done).toBe(1)
    expect(typeof j.finishedAt).toBe('number')
    expect(jobs.status()).toBe(j)                      // done 后结果保留（重开 UI 可查）
  })
  it('running 中再提交（任何 kind）→ JobRunningError；收尾后可再开', async () => {
    let release = (): void => {}
    const gate = new Promise<void>((r) => { release = r })
    const { jobs } = await mkJobs(async () => { await gate; return okProbe })
    jobs.startBatchProbe(['x'])                        // 探针挂起 → running 持续
    expect(() => jobs.startImport([{ name: 'a', text: '{}' }])).toThrowError(JobRunningError)
    expect(() => jobs.startBatchProbe(['y'])).toThrowError(JobRunningError)
    release()
    await waitDone(jobs)
    expect(jobs.startImport([{ name: 'a.json', text: JSON.stringify(raw('A', 'https://a.com')) }]).jobId).toBeTypeOf('string')
  })
  it('issues 超 200 截断（内存不膨胀），计数不受影响', async () => {
    const { jobs } = await mkJobs()
    const items = Array.from({ length: 250 }, (_, i) => ({ nope: i }))   // 全部 normalize 失败
    jobs.startImport([{ name: 'a.json', text: JSON.stringify(items) }])
    const j = await waitDone(jobs)
    expect(j.counts.failed).toBe(250)
    expect(j.issues).toHaveLength(200)
  })
  it('从未启动任务的实例：status null', async () => {
    const { jobs } = await mkJobs()
    expect(jobs.status()).toBe(null)
  })
})

describe('导入流水线 + 去重', () => {
  it('坏文件不拖垮任务：其余文件照常导入，fileErrors 点名；导入不探针（unverified 钉死）', async () => {
    const { jobs, registry } = await mkJobs()
    jobs.startImport([
      { name: 'bad.json', text: 'not json' },
      { name: 'good.json', text: JSON.stringify([raw('A', 'https://a.com')]) },
    ])
    const j = await waitDone(jobs)
    expect(j.fileErrors).toEqual([{ file: 'bad.json', error: 'JSON 解析失败' }])
    expect(j.counts.ok).toBe(1)
    expect(registry.list()).toHaveLength(1)
    expect(registry.list()[0].status).toBe('unverified')
  })
  it('BOM 剥离 + 对象/数组混拼', async () => {
    const { jobs, registry } = await mkJobs()
    jobs.startImport([
      { name: 'a.json', text: '\uFEFF' + JSON.stringify(raw('A', 'https://a.com')) },
      { name: 'b.json', text: JSON.stringify([raw('B', 'https://b.com'), raw('C', 'https://c.com')]) },
    ])
    const j = await waitDone(jobs)
    expect(j.counts.ok).toBe(3)
    expect(registry.list().map((s) => s.name).sort()).toEqual(['A', 'B', 'C'])
  })
  it('批内重复：留第一条，其余 dupSkipped + issues 点名（尾斜杠归一后仍判重）', async () => {
    const { jobs, registry } = await mkJobs()
    jobs.startImport([{ name: 'a.json', text: JSON.stringify([
      raw('First', 'https://dup.com'), raw('Second', 'https://dup.com/'), raw('Third', 'https://dup.com'),
    ]) }])
    const j = await waitDone(jobs)
    expect(j.counts).toMatchObject({ ok: 1, dupSkipped: 2 })
    expect(j.issues.filter((i) => i.kind === 'dup')).toHaveLength(2)
    expect(registry.list()).toHaveLength(1)
    expect(registry.list()[0].name).toBe('First')
  })
  it('与已有 verified 重复 → 保留已有跳过新条（以可用的为主）', async () => {
    const { jobs, registry } = await mkJobs()
    jobs.startImport([{ name: 'seed.json', text: JSON.stringify(raw('Old', 'https://dup.com')) }])
    await waitDone(jobs)
    await registry.edit((tx) => tx.setStatus(registry.list()[0].id, 'verified'))
    jobs.startImport([{ name: 'new.json', text: JSON.stringify(raw('New', 'https://dup.com')) }])
    const j = await waitDone(jobs)
    expect(j.counts).toMatchObject({ dupSkipped: 1, ok: 0 })
    expect(registry.list()).toHaveLength(1)
    expect(registry.list()[0].name).toBe('Old')
  })
  it('与已有 broken/unverified 重复 → 新条替换旧条，复用旧 id，status 复位', async () => {
    const { jobs, registry } = await mkJobs()
    jobs.startImport([{ name: 'seed.json', text: JSON.stringify(raw('Old', 'https://dup.com')) }])
    await waitDone(jobs)
    const oldId = registry.list()[0].id
    await registry.edit((tx) => tx.setStatus(oldId, 'broken', 'x'))
    jobs.startImport([{ name: 'new.json', text: JSON.stringify(raw('New', 'https://dup.com')) }])
    const j = await waitDone(jobs)
    expect(j.counts).toMatchObject({ replaced: 1, ok: 0 })
    expect(registry.list()).toHaveLength(1)
    expect(registry.list()[0]).toMatchObject({ id: oldId, name: 'New', status: 'unverified' })
  })
  it('同库历史多同键：替换时收敛为一条', async () => {
    const { jobs, registry } = await mkJobs()
    jobs.startImport([{ name: 'seed.json', text: JSON.stringify(raw('H1', 'https://dup.com')) }])
    await waitDone(jobs)
    jobs.startImport([{ name: 'seed2.json', text: JSON.stringify(raw('H3', 'https://dup.com/')) }])
    await waitDone(jobs)
    expect(registry.list().map((s) => s.name)).toEqual(['H3'])
  })
  it('缺字段条目：failed 计数 + 点名缺什么，后续好条目不受连坐', async () => {
    const { jobs } = await mkJobs()
    jobs.startImport([{ name: 'a.json', text: JSON.stringify([
      { bookSourceName: 'NoUrl' }, raw('Good', 'https://good.com'),
    ]) }])
    const j = await waitDone(jobs)
    expect(j.counts).toMatchObject({ ok: 1, failed: 1 })
    expect(j.issues[0]).toMatchObject({ kind: 'failed', name: 'NoUrl' })
    expect(j.issues[0].detail).toContain('bookSourceUrl')
  })
  it('dedupKey：trim + 去尾部斜杠，不改大小写', () => {
    expect(dedupKey(' https://a.com/ ')).toBe('https://a.com')
    expect(dedupKey('https://A.com')).toBe('https://A.com')       // 大小写不动
    expect(dedupKey('https://a.com//')).toBe('https://a.com')
  })
})

describe('批量验证任务', () => {
  it('并发探针：全部 verified，setStatus 生效', async () => {
    const { jobs, registry } = await mkJobs()
    jobs.startImport([{ name: 'a.json', text: JSON.stringify([
      raw('A', 'https://a.com'), raw('B', 'https://b.com'), raw('C', 'https://c.com'),
    ]) }])
    await waitDone(jobs)
    jobs.startBatchProbe(registry.list().map((s) => s.id))
    const j = await waitDone(jobs)
    expect(j).toMatchObject({ kind: 'batch-probe', total: 3 })
    expect(j.counts.ok).toBe(3)
    expect(registry.list().every((s) => s.status === 'verified')).toBe(true)
  })
  it('单条探针炸 → failed 计数 + issue 点名，其余不中断', async () => {
    let n = 0
    const { jobs, registry } = await mkJobs(async () => { n++; if (n === 2) throw new Error('boom'); return okProbe })
    jobs.startImport([{ name: 'a.json', text: JSON.stringify([
      raw('A', 'https://a.com'), raw('B', 'https://b.com'), raw('C', 'https://c.com'),
    ]) }])
    await waitDone(jobs)
    jobs.startBatchProbe(registry.list().map((s) => s.id))
    const j = await waitDone(jobs)
    expect(j.counts).toMatchObject({ ok: 2, failed: 1 })
    expect(j.issues.some((i) => i.kind === 'failed' && i.detail.includes('boom'))).toBe(true)
    expect(j.phase).toBe('done')                                // 单条异常不炸整任务
  })
  it('探针返回 not ok → 记 failed 并置 broken', async () => {
    const { jobs, registry } = await mkJobs(async () => ({ ok: false, itemCount: 0, firstTitle: null, error: { code: 'FetchError', message: '连接拒绝' }, probedAt: 0 }))
    jobs.startImport([{ name: 'a.json', text: JSON.stringify(raw('A', 'https://a.com')) }])
    await waitDone(jobs)
    jobs.startBatchProbe(registry.list().map((s) => s.id))
    const j = await waitDone(jobs)
    expect(j.counts).toMatchObject({ failed: 1, ok: 0 })
    expect(registry.list()[0].status).toBe('broken')
  })
  it('未知 id：issues 点名「源不存在」，total 只计有效 id', async () => {
    const { jobs } = await mkJobs()
    jobs.startBatchProbe(['ghost-1'])
    const j = await waitDone(jobs)
    expect(j.total).toBe(0)
    expect(j.issues.some((i) => i.detail.includes('源不存在'))).toBe(true)
  })
  it('并发上限 5：同时在飞 ≤5 且确实并发', async () => {
    let flying = 0, peak = 0
    const { jobs, registry } = await mkJobs(async () => {
      flying++; peak = Math.max(peak, flying)
      await new Promise((r) => setTimeout(r, 2))
      flying--; return okProbe
    })
    jobs.startImport([{ name: 'a.json', text: JSON.stringify(
      Array.from({ length: 12 }, (_, i) => raw(`S${i}`, `https://s${i}.com`)),
    ) }])
    await waitDone(jobs)
    jobs.startBatchProbe(registry.list().map((s) => s.id))
    await waitDone(jobs)
    expect(peak).toBeGreaterThan(1)
    expect(peak).toBeLessThanOrEqual(5)
  })
  it('运行中删源（洞3）：worker 重查不到 → 记「运行中被删除」跳过，不产生垃圾失败', async () => {
    let n = 0
    let victimId = ''
    const { jobs, registry } = await mkJobs(async () => {
      n++
      if (n === 1) void registry.edit((tx) => tx.remove(victimId))   // 第一发探针期间把第二个源删掉（edit 同步生效）
      await new Promise((r) => setTimeout(r, 5))
      return okProbe
    })
    jobs.startImport([{ name: 'a.json', text: JSON.stringify([
      raw('A', 'https://a.com'), raw('B', 'https://b.com'),
    ]) }])
    await waitDone(jobs)
    victimId = registry.list()[1].id
    jobs.startBatchProbe(registry.list().map((s) => s.id))
    const j = await waitDone(jobs)
    expect(j.phase).toBe('done')
    expect(j.issues.some((i) => i.detail.includes('运行中被删除'))).toBe(true)
    expect(j.issues.some((i) => i.detail.includes('undefined') || i.detail.includes('TypeError'))).toBe(false)
  })
  it('探针在途删掉被探源（最窄交错窗口）：setStatus 打在已删除 id 上 = 优雅 no-op，任务照常收尾、无幽灵源', async () => {
    // 用户拍板（2026）：验证在途允许删除，前提 = 无并发安全问题。本用例钉最窄的窗口——
    // worker 已通过重查、探针请求在途，此刻删除落在**被探源自己**头上；探针 resolve 后
    // worker 才写回 setStatus(已删除 id)。安全依据：sources.ts setStatus 首行
    // `if (!s) return false`（查不到即 no-op，不抛、不复活），edit recipe 同步执行原子。
    let n = 0
    let victimId = ''
    const { jobs, registry } = await mkJobs(async () => {
      n++
      if (n === 1) {                                 // 第一发探针（源 A 自己）在途期间删掉 A
        void registry.edit((tx) => tx.remove(victimId))   // edit recipe 同步生效（与「洞3」用例同款手法）
        await new Promise((r) => setTimeout(r, 5))
      }
      return okProbe
    })
    jobs.startImport([{ name: 'a.json', text: JSON.stringify([
      raw('A', 'https://a.com'), raw('B', 'https://b.com'),
    ]) }])
    await waitDone(jobs)
    victimId = registry.list()[0].id
    jobs.startBatchProbe(registry.list().map((s) => s.id))
    const j = await waitDone(jobs)
    expect(j.phase).toBe('done')                     // 单条交错不炸整任务
    expect(registry.list().map((s) => s.id)).not.toContain(victimId)   // no-op ≠ 复活：被删源保持删除
    expect(registry.list().some((s) => s.id !== victimId && s.status === 'verified')).toBe(true)   // B 不受牵连
    expect(j.issues.some((i) => i.detail.includes('TypeError'))).toBe(false)
  })
})
// ── 宿主后台任务注册表（ctx.jobs）接线：生命周期归宿主，counts 与单槽仍归本插件 ──
import type { JobHost, JobHostSpec } from '../../src/services/import-job.js'

type Settled = { status: string; detail?: string }
interface Tie { spec: JobHostSpec; cancel: (reason?: string) => void; done: Promise<Settled> }

/** 假注册表：记下每次 start 的 spec 与生产方交回的 hooks（宿主对我们说的话只有这两句） */
function fakeHost(): { host: JobHost; ties: Tie[] } {
  const ties: Tie[] = []
  const host: JobHost = {
    start: (spec) => {
      const hooks = spec.run()
      ties.push({ spec, cancel: hooks.cancel, done: hooks.done })
      return `${spec.kind}-${ties.length}`
    },
  }
  return { host, ties }
}

const filesOf = (n: number) => [{
  name: 'x.json',
  text: JSON.stringify(Array.from({ length: n }, (_, i) => raw(`S${i}`, `https://s${i}.com`))),
}]

describe('任务生命周期归 ctx.jobs（生产方接线 + 协作式取消）', () => {
  it('导入任务在宿主登记：kind novel-import、label 说清条数，收尾兑现 completed', async () => {
    const dir = await makeTempDir('novel-job-h1-')
    const registry = await SourceRegistry.load(dir)
    const { host, ties } = fakeHost()
    const jobs = new SourceJobs({ registry, probe: async () => okProbe, host })
    jobs.startImport([
      { name: 'a.json', text: JSON.stringify([raw('A', 'https://a.com')]) },
      { name: 'b.json', text: JSON.stringify([raw('B', 'https://b.com')]) },
    ])
    expect(ties).toHaveLength(1)
    expect(ties[0].spec.kind).toBe('novel-import')
    expect(ties[0].spec.label).toContain('2')                     // 宿主/模型看得见这活有多大
    const j = await waitDone(jobs)
    expect(j.phase).toBe('done')                                  // 自有 JobState 语义一字未改
    await expect(ties[0].done).resolves.toMatchObject({ status: 'completed' })
  })

  it('批量验证登记为 novel-probe；宿主 cancel 后在取下一条前收手，跑过的不抹除', async () => {
    const dir = await makeTempDir('novel-job-h2-')
    const registry = await SourceRegistry.load(dir)
    const { host, ties } = fakeHost()
    const seeder = new SourceJobs({ registry, probe: async () => okProbe, host })
    seeder.startImport(filesOf(8))                                // 8 源 > PROBE_CONCURRENCY 5
    await waitDone(seeder)
    const ids = registry.list().map((s) => s.id)
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })
    const jobs = new SourceJobs({ registry, probe: async () => { await gate; return okProbe }, host })
    jobs.startBatchProbe(ids)
    const tie = ties[ties.length - 1]
    expect(tie.spec.kind).toBe('novel-probe')
    await new Promise((r) => setTimeout(r, 5))
    tie.cancel('用户从宿主取消')                                    // 在途 5 发探针不打断，只拦后续取条目
    release()
    const j = await waitDone(jobs)
    expect(j.phase).toBe('failed')
    expect(j.error ?? '').toContain('已取消')
    expect(j.error ?? '').toContain('用户从宿主取消')
    expect(j.done).toBeLessThan(j.total)                          // 确实没跑完全部
    await expect(tie.done).resolves.toMatchObject({ status: 'killed' })
    expect(registry.list().some((s) => s.status === 'verified')).toBe(true)  // 跑过的那批保留
  })

  it('宿主缺席（单测直构 / 无 jobs 的组合）→ 任务照跑，不因缺注册表而炸', async () => {
    const { jobs } = await mkJobs()
    jobs.startImport(filesOf(1))
    expect((await waitDone(jobs)).phase).toBe('done')
  })
})
