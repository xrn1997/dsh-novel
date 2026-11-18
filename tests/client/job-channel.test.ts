// 通道不变量合成一份：三处观察者（搜索 / 分类 / 任务镜像）的**业务语义**留在各自的用例里
// （search-job-* 、explore-job、jobs-poll/jobs-verify），这里只钉通道仪式本身——两条通道不并跑、
// 迟到帧不污染、撤通道连 timer 一起。合成一份的理由：这些不变量此前在三份实现里各证一遍，
// 加第四种任务就要再证第四遍；现在只有一份实现，就只证一次。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createJobChannel } from '../../src/client/job-channel.js'
import type { JobChannelSpec } from '../../src/client/job-channel.js'

/** 帧形状只有一个身份字段：通道不认识业务字段，身份判据由 spec 给（与 wire 快照无关）。 */
interface Frame { id: string; n: number }
/** 轮次 token：同样只有一个身份字段，通道把它当不透明对象。 */
interface Round { id: string }

/** 让在途的异步链（读面 / 订阅）走到下一个稳定点：不碰任何 timer */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

/** 假订阅：每条流都挂住，用例自己决定送帧、正常结束还是失败；abort 时以失败收场（与真实现同口径）。 */
interface FakeStream {
  round: Round
  onFrame: (data: string) => void
  signal: AbortSignal
}
type Subscribe = NonNullable<JobChannelSpec<Frame, Round>['subscribe']>
const streamFleet = (): { streams: FakeStream[]; subscribe: Subscribe } => {
  const streams: FakeStream[] = []
  const subscribe: Subscribe = (round, onFrame, signal) => new Promise<void>((_resolve, reject) => {
    streams.push({ round, onFrame, signal })
    signal.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
  })
  return { streams, subscribe }
}

/** 读面替身：每次读挂在一枚 promise 上，用例按顺序放行（用来制造「在途那一发迟到」）。 */
interface PendingRead { round: Round; resolve: (job: Frame | null) => void; reject: (e: Error) => void }
type Read = JobChannelSpec<Frame, Round>['read']
const gatedReads = (): { reads: PendingRead[]; read: Read } => {
  const reads: PendingRead[] = []
  const read: Read = (round) => new Promise<Frame | null>((resolve, reject) => {
    reads.push({ round, resolve, reject })
  })
  return { reads, read }
}

/** 纯轮询 spec 的底：没有推送可用；身份恒真、读失败收手。各用例按需覆写。 */
const baseSpec = (over: Partial<JobChannelSpec<Frame, Round>> = {}): JobChannelSpec<Frame, Round> => ({
  read: async (round: Round) => ({ id: round.id, n: 1 }),
  apply: () => true,
  sameRound: () => true,
  onReadError: () => false,
  ...over,
})

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('任务观察通道：仪式的不变量（一份实现，一处证明）', () => {
  it('推送是加速器：流结束而本轮未终态 → 回落轮询；轮询落地才排下一拍', async () => {
    const subscribe: Subscribe = async () => { /* 连不上：立刻收场 */ }
    const read = vi.fn(async (round: Round) => ({ id: round.id, n: 1 }))
    const apply = vi.fn(() => true)
    const channel = createJobChannel<Frame, Round>(baseSpec({ subscribe, read, apply }), 100)
    channel.start({ id: 'r1' })
    await flush()
    expect(read).not.toHaveBeenCalled()               // 先走推送

    await vi.advanceTimersByTimeAsync(100)
    expect(read).toHaveBeenCalledTimes(1)             // 推送不可用 → 回落轮询的地基
    expect(read).toHaveBeenCalledWith({ id: 'r1' })
    expect(apply).toHaveBeenCalledTimes(1)
    expect(apply).toHaveBeenCalledWith({ id: 'r1' }, { id: 'r1', n: 1 })

    await vi.advanceTimersByTimeAsync(100)
    expect(read).toHaveBeenCalledTimes(2)             // 读完才排下一拍，不按固定间隔抢跑
    channel.stop()
  })

  it('终态自关流：apply 说收手 → 流被 abort、不再回落轮询、迟到的帧也不再应用', async () => {
    const { streams, subscribe } = streamFleet()
    const apply = vi.fn((_round: Round, job: Frame | null) => job !== null && job.n < 2)
    const read = vi.fn(async (round: Round) => ({ id: round.id, n: 1 }))
    const channel = createJobChannel<Frame, Round>(baseSpec({ subscribe, apply, read }), 100)
    channel.start({ id: 'r1' })
    await flush()
    expect(streams).toHaveLength(1)

    streams[0]?.onFrame(JSON.stringify({ job: { id: 'r1', n: 2 } }))   // 终态那一帧
    expect(apply).toHaveBeenCalledTimes(1)
    expect(streams[0]?.signal.aborted).toBe(true)     // 自己关流，不留着占连接

    streams[0]?.onFrame(JSON.stringify({ job: { id: 'r1', n: 3 } }))   // 终态之后的迟到帧
    await flush()
    expect(apply).toHaveBeenCalledTimes(1)            // 不再应用
    await vi.advanceTimersByTimeAsync(500)
    expect(read).not.toHaveBeenCalled()               // 也没有回落轮询
  })

  it('两条通道不并跑：start 接管先撤旧流再开新流；旧流的迟到帧不污染新一轮', async () => {
    const { streams, subscribe } = streamFleet()
    const applied: Array<Frame | null> = []
    const apply = vi.fn((_round: Round, job: Frame | null) => { applied.push(job); return true })
    const channel = createJobChannel<Frame, Round>(baseSpec({ subscribe, apply }), 100)
    channel.start({ id: 'A' })
    await flush()
    channel.start({ id: 'B' })                        // 换轮：接管通道
    await flush()
    expect(streams).toHaveLength(2)
    expect(streams[0]?.signal.aborted).toBe(true)     // 旧流撤掉
    expect(streams[1]?.round).toEqual({ id: 'B' })    // 新流盯的是新一轮

    streams[0]?.onFrame(JSON.stringify({ job: { id: 'A', n: 9 } }))   // 旧流迟到帧
    await flush()
    expect(applied).toEqual([])                       // 一轮都没应用：旧通道已没有所有权
    streams[1]?.onFrame(JSON.stringify({ job: { id: 'B', n: 1 } }))
    await flush()
    expect(applied).toEqual([{ id: 'B', n: 1 }])
    channel.stop()
  })

  it('迟到帧不污染：轮询那一发在途时换轮，它的回包落地也不许应用', async () => {
    const { reads, read } = gatedReads()
    const applied: Array<Frame | null> = []
    const apply = vi.fn((_round: Round, job: Frame | null) => { applied.push(job); return true })
    const channel = createJobChannel<Frame, Round>(baseSpec({ read, apply }), 100)
    channel.start({ id: 'A' })
    await flush()
    expect(reads).toHaveLength(1)                     // A 的第一拍已起飞（卡在闸上）

    channel.start({ id: 'B' })                        // 换轮：撤旧通道
    await flush()
    expect(reads).toHaveLength(2)                     // B 立刻读一拍

    reads[0]?.resolve({ id: 'A', n: 9 })              // A 的迟到回包
    await flush()
    expect(applied).toEqual([])                       // clearTimeout 撤不回它，代际让它认领失败

    reads[1]?.resolve({ id: 'B', n: 1 })
    await flush()
    expect(applied).toEqual([{ id: 'B', n: 1 }])
    channel.stop()
  })

  it('迟到的读失败也不报：那一发在途时换轮，它的 reject 落地不许触达 onReadError', async () => {
    const { reads, read } = gatedReads()
    const onReadError = vi.fn(() => true)
    const channel = createJobChannel<Frame, Round>(baseSpec({ read, onReadError }), 100)
    channel.start({ id: 'A' })
    await flush()
    expect(reads).toHaveLength(1)                     // A 的第一拍已起飞（卡在闸上）

    channel.start({ id: 'B' })                        // 换轮：撤旧通道
    await flush()

    reads[0]?.reject(new Error('旧通道的断线'))        // A 的迟到失败
    await flush()
    expect(onReadError, '连读失败都不许报：旧通道已没有所有权').not.toHaveBeenCalled()
    channel.stop()
  })

  it('撤通道连 timer 一起：stop 之后不再读、不再回调', async () => {
    const read = vi.fn(async (round: Round) => ({ id: round.id, n: 1 }))
    const apply = vi.fn(() => true)
    const channel = createJobChannel<Frame, Round>(baseSpec({ read, apply }), 100)
    channel.start({ id: 'r1' })
    await flush()
    expect(read).toHaveBeenCalledTimes(1)             // 纯轮询：挂载即读一拍
    await vi.advanceTimersByTimeAsync(100)
    expect(read).toHaveBeenCalledTimes(2)

    channel.stop()                                    // 只 clearTimeout 会留下一发已起飞的读
    await vi.advanceTimersByTimeAsync(500)
    expect(read).toHaveBeenCalledTimes(2)             // timer 一起撤：零新增
    expect(apply).toHaveBeenCalledTimes(2)            // 也不再有应用

    channel.stop()                                    // 幂等：重复收手不炸
    channel.start({ id: 'r2' })                       // 停过之后还能重新盯一轮
    await flush()
    expect(read).toHaveBeenCalledTimes(3)
    channel.stop()
  })

  it('身份不符：先撤通道、问一次恢复策略、按交回的新轮重开（旧帧一次都不应用）', async () => {
    const { streams, subscribe } = streamFleet()
    const applied: Array<Frame | null> = []
    const apply = vi.fn((_round: Round, job: Frame | null) => { applied.push(job); return true })
    const regain = vi.fn(async () => {
      expect(streams[0]?.signal.aborted, '问恢复策略前旧通道已撤').toBe(true)
      return { id: 'next' }
    })
    const channel = createJobChannel<Frame, Round>(baseSpec({
      subscribe, apply, regain, sameRound: (round, job) => job.id === round.id,
    }), 100)
    channel.start({ id: 'old' })
    await flush()
    expect(streams).toHaveLength(1)

    streams[0]?.onFrame(JSON.stringify({ job: { id: 'foreign', n: 1 } }))
    await flush()
    expect(regain).toHaveBeenCalledTimes(1)
    expect(regain).toHaveBeenCalledWith({ id: 'old' })
    expect(applied).toEqual([])                       // 别人的轮次一帧都没进业务
    expect(streams).toHaveLength(2)                   // 恢复策略交回新轮 → 通道从它重开
    expect(streams[0]?.signal.aborted).toBe(true)
    expect(streams[1]?.round).toEqual({ id: 'next' })

    streams[1]?.onFrame(JSON.stringify({ job: { id: 'foreign', n: 2 } }))   // 恢复期间旧帧再迟到
    await flush()
    expect(applied).toEqual([])
    channel.stop()
  })

  it('恢复在途时本页起了新通道：以那一次为准，挂起的 regain 回来不许把通道倒回', async () => {
    const { streams, subscribe } = streamFleet()
    const apply = vi.fn(() => true)
    let release: (round: Round | null) => void = () => { throw new Error('regain 未挂起') }
    const regain = vi.fn(() => new Promise<Round | null>((resolve) => { release = resolve }))
    const channel = createJobChannel<Frame, Round>(baseSpec({
      subscribe, apply, regain, sameRound: (round, job) => job.id === round.id,
    }), 100)
    channel.start({ id: 'old' })
    await flush()

    // 别人的轮次 → 通道先撤旧流，再挂起问恢复策略
    streams[0]?.onFrame(JSON.stringify({ job: { id: 'foreign', n: 1 } }))
    await flush()
    expect(regain).toHaveBeenCalledTimes(1)

    // 恢复还没回来，本页先提交了新的一轮（用户动作比恢复快）：新通道从这一刻起是权威
    channel.start({ id: 'mine' })
    await flush()
    expect(streams).toHaveLength(2)
    expect(streams[1]?.round).toEqual({ id: 'mine' })

    // 挂起的 regain 这才回来：它交回的是旧轮，代际判已无所有权，不许抢走刚起的那条通道
    release({ id: 'stale' })
    await flush()
    expect(streams).toHaveLength(2)
    expect(streams[1]?.round).toEqual({ id: 'mine' })
    expect(apply).not.toHaveBeenCalled()
    channel.stop()
  })

  it('身份不符但没有恢复策略：收手（撤通道、不开新流、不应用）', async () => {
    const { streams, subscribe } = streamFleet()
    const apply = vi.fn(() => true)
    const read = vi.fn(async (round: Round) => ({ id: round.id, n: 1 }))
    const channel = createJobChannel<Frame, Round>(baseSpec({
      subscribe, apply, read, sameRound: (round, job) => job.id === round.id,
    }), 100)
    channel.start({ id: 'old' })
    await flush()
    streams[0]?.onFrame(JSON.stringify({ job: { id: 'foreign', n: 1 } }))
    await flush()
    expect(apply).not.toHaveBeenCalled()
    expect(streams[0]?.signal.aborted).toBe(true)
    expect(streams).toHaveLength(1)                   // 不重开
    await vi.advanceTimersByTimeAsync(500)
    expect(read).not.toHaveBeenCalled()               // 也不回落轮询
  })

  it('读面失败的两条取舍：onReadError 返回 false 收手；返回 true 下一拍继续', async () => {
    const failing = vi.fn(async () => { throw new Error('读面不可用') })
    const stopApply = vi.fn(() => true)
    const stopped = createJobChannel<Frame, Round>(baseSpec({
      read: failing, apply: stopApply, onReadError: () => false,
    }), 100)
    stopped.start({ id: 'r1' })
    await flush()
    expect(failing).toHaveBeenCalledTimes(1)
    expect(stopApply).not.toHaveBeenCalled()          // 读失败不是一帧快照
    await vi.advanceTimersByTimeAsync(500)
    expect(failing).toHaveBeenCalledTimes(1)          // 收手：不再读

    const flaky = vi.fn(async () => { throw new Error('抖动') })
    const retried = createJobChannel<Frame, Round>(baseSpec({
      read: flaky, onReadError: () => true,
    }), 100)
    retried.start({ id: 'r1' })
    await flush()
    await vi.advanceTimersByTimeAsync(100)
    expect(flaky).toHaveBeenCalledTimes(2)            // 抖动继续：下一拍照读
    retried.stop()
  })

  it('坏帧不致命、null 快照照常交给 apply：流不因坏帧断开，null 的收手由业务回 false', async () => {
    const { streams, subscribe } = streamFleet()
    const apply = vi.fn((_round: Round, job: Frame | null) => job !== null)
    const channel = createJobChannel<Frame, Round>(baseSpec({ subscribe, apply }), 100)
    channel.start({ id: 'r1' })
    await flush()

    streams[0]?.onFrame('not json')
    streams[0]?.onFrame(JSON.stringify({ nope: 1 }))     // 没有 job 键：按坏帧跳过
    await flush()
    expect(apply).not.toHaveBeenCalled()
    expect(streams[0]?.signal.aborted).toBe(false)       // 坏帧不断流：下一帧或轮询兜底

    streams[0]?.onFrame(JSON.stringify({ job: null }))   // 服务端说这一轮没了
    await flush()
    expect(apply).toHaveBeenCalledWith({ id: 'r1' }, null)
    expect(streams[0]?.signal.aborted).toBe(true)        // 业务回 false = 收手
  })

  it('轮询路径上的身份不符也走恢复：新轮从读面重开', async () => {
    const { reads, read } = gatedReads()
    const apply = vi.fn(() => true)
    const regain = vi.fn(async () => ({ id: 'next' }))
    const channel = createJobChannel<Frame, Round>(baseSpec({
      read, apply, regain, sameRound: (round, job) => job.id === round.id,
    }), 100)
    channel.start({ id: 'old' })
    await flush()
    reads[0]?.resolve({ id: 'foreign', n: 1 })
    await flush()
    expect(regain).toHaveBeenCalledTimes(1)
    expect(reads).toHaveLength(2)                     // 新轮立刻读一拍
    expect(reads[1]?.round).toEqual({ id: 'next' })
    reads[1]?.resolve({ id: 'next', n: 1 })
    await flush()
    expect(apply).toHaveBeenCalledWith({ id: 'next' }, { id: 'next', n: 1 })
    channel.stop()
  })
})
