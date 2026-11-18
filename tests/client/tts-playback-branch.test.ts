import { describe, expect, it, vi } from 'vitest'
import type {
  BranchHost, BytesListenOutput, BytesSegment, DirectListenOutput, DirectSegment,
  OutputHandlers, PlaybackBranch,
} from '../../src/client/tts/output-contract.js'
import { BytesBranch, DirectBranch, createListenBranches } from '../../src/client/tts/playback-branches.js'

/**
 * 两条出声分支的契约钉子：准备单元、能力声明、静音另一条分支、重来的许可都住分支实现，
 * 会话只消费结局。这里用假介质面直接驱动分支，不挂 store、不碰 DOM——分支本该这样被测。
 */

function handlers(): OutputHandlers & { preparedCount: number; startCount: number; doneCount: number; failCount: number } {
  const h = {
    preparedCount: 0,
    startCount: 0,
    doneCount: 0,
    failCount: 0,
    prepared: () => { h.preparedCount += 1 },
    start: () => { h.startCount += 1 },
    done: () => { h.doneCount += 1 },
    fail: () => { h.failCount += 1 },
  }
  return h
}

function bytesOutput(): BytesListenOutput & {
  starts: { seg: BytesSegment; handlers: OutputHandlers }[]
  pauses: number
  preloads: string[]
  dropPreloads: number
  invalidations: number
  volumes: number[]
  heldKeys: Set<string>
} {
  const out = {
    starts: [] as { seg: BytesSegment; handlers: OutputHandlers }[],
    pauses: 0,
    preloads: [] as string[],
    dropPreloads: 0,
    invalidations: 0,
    volumes: [] as number[],
    heldKeys: new Set<string>(),
    start(seg: BytesSegment, hs: OutputHandlers) {
      out.starts.push({ seg, handlers: hs })
      out.heldKeys.add(seg.key)
    },
    pause() { out.pauses += 1 },
    stop() { /* 记录用 */ },
    release() { /* 记录用 */ },
    setVolume(volume: number) { out.volumes.push(volume) },
    preload(key: string) { out.preloads.push(key) },
    dropPreload() { out.dropPreloads += 1 },
    holds(key: string) { return out.heldKeys.has(key) },
    invalidate() { out.invalidations += 1; out.heldKeys.clear() },
  }
  return out
}

function directOutput(): DirectListenOutput & {
  starts: { seg: DirectSegment; handlers: OutputHandlers }[]
  pauses: number
  stops: number
  releases: number
} {
  const out = {
    starts: [] as { seg: DirectSegment; handlers: OutputHandlers }[],
    pauses: 0,
    stops: 0,
    releases: 0,
    start(seg: DirectSegment, hs: OutputHandlers) { out.starts.push({ seg, handlers: hs }) },
    pause() { out.pauses += 1 },
    stop() { out.stops += 1 },
    release() { out.releases += 1 },
    setVolume() { /* 直出型没有活介质 */ },
  }
  return out
}

function host(receipt: () => Promise<{ key: string; playbackRate: number } | null>): BranchHost & {
  voiceCalls: number
} {
  const h = {
    voiceCalls: 0,
    receipt: async () => receipt(),
    voice: () => { h.voiceCalls += 1; return { voice: 'v1', rate: 1.5, volume: 0.4 } },
  }
  return h
}

function job(text = '第一段。', signal = new AbortController().signal) {
  return { index: 0, text, signal }
}

/** 另一条分支的假面：本文件只关心「有没有被叫停」，其余接口不会被调到。 */
function peer(pause: () => void = () => { /* 假面 */ }): PlaybackBranch {
  return { pause } as unknown as PlaybackBranch
}

describe('能力声明：两条分支自己说能提供什么', () => {
  it('字节型：段内计时 / 预取 / 回执续播 / 介质自愈 / 引擎源音色表', () => {
    const bytes = new BytesBranch(bytesOutput(), () => { throw new Error('本用例不静音') })
    expect(bytes.capabilities).toEqual({
      segmentProgress: true,
      prefetch: true,
      receiptResume: true,
      selfHeal: true,
      voiceTable: 'engine',
    })
    expect(bytes.ready(), '字节型没有源级前置条件').toBe(true)
    expect(bytes.held(), '合成在途由会话的 synthToken 判，介质不占在放').toBe(false)
  })

  it('直出型：没有段内计时 / 预取 / 回执续播，音色表来自平台', () => {
    const direct = new DirectBranch(directOutput(), {
      awaitVoices: async () => true,
      peer: () => { throw new Error('本用例不静音') },
    })
    expect(direct.capabilities).toEqual({
      segmentProgress: false,
      prefetch: false,
      receiptResume: false,
      selfHeal: false,
      voiceTable: 'platform',
    })
  })
})

describe('字节型分支：准备 = 求回执 + 静音另一条分支 + 交给两槽介质', () => {
  it('回执到手才起播：键 / 补速 / 活读音量一起交给介质；先静音另一条分支', async () => {
    const output = bytesOutput()
    const peerPauses: string[] = []
    const quietPeer = peer(() => { peerPauses.push('bytes') })
    const branch = new BytesBranch(output, () => quietPeer)
    const hs = handlers()
    const hostCalls = host(async () => ({ key: 'k1', playbackRate: 1.5 }))
    const outcome = await branch.start(job(), hs, hostCalls)
    expect(outcome).toBe('started')
    expect(peerPauses, '出声前让另一条分支闭嘴').toEqual(['bytes'])
    expect(hostCalls.voiceCalls, '音量活读一次').toBe(1)
    expect(output.starts).toHaveLength(1)
    expect(output.starts[0]?.seg).toEqual({ key: 'k1', volume: 0.4, playbackRate: 1.5, resume: false })
    expect(hs.preparedCount, '已交给介质：准备期 loading 到此收口').toBe(1)
  })

  it('静音对侧的时序 = 自己出声那一刻：回执在途旧声音继续（无死腔），落地先静音对侧再交介质', async () => {
    const output = bytesOutput()
    const events: string[] = []
    const origStart = output.start.bind(output)
    output.start = (seg, hs) => { events.push('交介质'); origStart(seg, hs) }
    const quietPeer = peer(() => { events.push('对侧静音') })
    const branch = new BytesBranch(output, () => quietPeer)
    const hs = handlers()
    let releaseReceipt: (r: { key: string; playbackRate: number } | null) => void =
      () => { throw new Error('回执闸未就绪') }
    const hostCalls = host(() => new Promise((resolve) => { releaseReceipt = resolve }))

    const started = branch.start(job(), hs, hostCalls)
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    // 合成等待里不给用户死腔：旧声音（直出对侧或上一段字节）继续到新声音就绪
    expect(events, '回执在途对侧不静音').toEqual([])

    releaseReceipt({ key: 'k1', playbackRate: 1 })
    expect(await started).toBe('started')
    // 落地后先静音对侧再交介质：两句叠音比一句不响更难解释（时序即契约，别调换）
    expect(events).toEqual(['对侧静音', '交介质'])
  })

  it('回执为 null（这一发已作废）→ cancelled，不碰介质', async () => {
    const output = bytesOutput()
    const branch = new BytesBranch(output, () => peer(() => { throw new Error('不该静音') }))
    const hs = handlers()
    const outcome = await branch.start(job(), hs, host(async () => null))
    expect(outcome).toBe('cancelled')
    expect(output.starts).toHaveLength(0)
    expect(hs.preparedCount).toBe(0)
  })

  it('取消不是失败：合成抛错时看取消位——已取消 → cancelled，未取消 → failed', async () => {
    const output = bytesOutput()
    const branch = new BytesBranch(output, () => peer())
    const aborted = new AbortController()
    aborted.abort()
    expect(await branch.start(job('p。', aborted.signal), handlers(), host(async () => { throw new Error('上游说没成') })))
      .toBe('cancelled')
    expect(await branch.start(job(), handlers(), host(async () => { throw new Error('上游说没成') })))
      .toBe('failed')
    expect(output.starts).toHaveLength(0)
  })

  it('回执续播：介质里还有这段字节才接上（resume 键），不在回 false 让会话重新起播', () => {
    const output = bytesOutput()
    const branch = new BytesBranch(output, () => peer())
    expect(branch.resume({ key: 'k1', volume: 0.4, playbackRate: 1.5 }, handlers())).toBe(false)
    expect(output.starts, '没字节时不许假装续上').toHaveLength(0)

    output.heldKeys.add('k1')
    expect(branch.resume({ key: 'k1', volume: 0.4, playbackRate: 1.5 }, handlers())).toBe(true)
    expect(output.starts[0]?.seg, '续播不重设播放头、倍率取回执那一格')
      .toEqual({ key: 'k1', volume: 0.4, playbackRate: 1.5, resume: true })
  })

  it('载入在途继续放旧字节；预载面与失效面直接落到介质', () => {
    const output = bytesOutput()
    const branch = new BytesBranch(output, () => peer())
    branch.yieldForLoad()
    expect(output.pauses, '字节型旧音频由起播时换槽接替').toBe(0)
    branch.preload('k2')
    branch.dropPreload()
    branch.invalidate()
    branch.pause()
    expect(output.preloads).toEqual(['k2'])
    expect(output.dropPreloads).toBe(1)
    expect(output.invalidations).toBe(1)
    expect(output.pauses).toBe(1)
  })
})

describe('直出型分支：准备 = 过音色参数 + 交 utterance', () => {
  it('起一段先静音另一条分支与自己，再按活读参数开口；held 认「已进平台队列」', () => {
    const output = directOutput()
    const peerPauses: number[] = []
    const direct = new DirectBranch(output, {
      awaitVoices: async () => true,
      peer: () => peer(() => { peerPauses.push(1) }),
    })
    const hs = handlers()
    expect(direct.start(job('念我。'), hs, host(async () => null))).toBe('started')
    expect(peerPauses, '另一条分支先闭嘴').toHaveLength(1)
    expect(output.pauses, '自己的旧 utterance 也撤掉').toBe(1)
    expect(output.starts[0]?.seg).toEqual({ text: '念我。', voice: 'v1', rate: 1.5, volume: 0.4 })
    expect(hs.preparedCount, '直出型不调 prepared：loading 等平台真开口').toBe(0)
    expect(direct.held(), 'onstart 之前也算占着介质').toBe(true)

    // 平台真开口 / 播完：事实穿给会话，held 随事件收口
    output.starts[0]?.handlers.start?.()
    expect(hs.startCount).toBe(1)
    output.starts[0]?.handlers.done()
    expect(hs.doneCount).toBe(1)
    expect(direct.held()).toBe(false)
  })

  it('介质失败也走会话的失败径：active 收口后交 fail', () => {
    const output = directOutput()
    const direct = new DirectBranch(output, {
      awaitVoices: async () => true,
      peer: () => peer(),
    })
    const hs = handlers()
    direct.start(job(), hs, host(async () => null))
    output.starts[0]?.handlers.fail()
    expect(hs.failCount).toBe(1)
    expect(direct.held()).toBe(false)
  })

  it('介质在 start 里同步报 fail：收口不许被「已交给平台」的置位盖回去', () => {
    const output = directOutput()
    const direct = new DirectBranch(output, {
      awaitVoices: async () => true,
      peer: () => peer(),
    })
    // 准备期就被平台拦下：start 还没返回，fail 已经同步回调（不是所有实现都等异步事件）
    output.start = (_seg, hs) => { hs.fail() }
    const hs = handlers()
    direct.start(job(), hs, host(async () => null))
    expect(hs.failCount).toBe(1)
    expect(direct.held(), '失败已收口：不许再声称占着介质').toBe(false)
  })

  it('源级闸门直接问平台语音表：等不到就是这台设备此刻不能用这条分支', async () => {
    const direct = new DirectBranch(directOutput(), {
      awaitVoices: async () => false,
      peer: () => peer(),
    })
    await expect(direct.ready()).resolves.toBe(false)
  })

  it('换章载入当场让位（旧 utterance 不该念上一章）；没有回执续播、没有预载面', () => {
    const output = directOutput()
    const direct = new DirectBranch(output, {
      awaitVoices: async () => true,
      peer: () => peer(),
    })
    direct.start(job(), handlers(), host(async () => null))
    expect(direct.held()).toBe(true)
    direct.yieldForLoad()
    expect(direct.held()).toBe(false)
    expect(output.pauses).toBe(2)
    expect(direct.resume(), '直出型没有回执续播：续播从本段开头重开口').toBe(false)
    direct.invalidate()
    expect(output.releases, 'invalidate 不碰介质').toBe(0)
  })
})

describe('分支组：按模式取分支 + 两条介质一起收口', () => {
  it('branch(mode) 给对应分支；stopAll / releaseAll 落到两条介质', async () => {
    const bytes = bytesOutput()
    const direct = directOutput()
    const group = createListenBranches({ bytes, direct }, async () => true)
    expect(group.branch('bytes')).toBeInstanceOf(BytesBranch)
    expect(group.branch('direct')).toBeInstanceOf(DirectBranch)

    // 字节型起播会静音另一条分支（直出型分支的 pause → 介质 pause）
    await (group.branch('bytes') as BytesBranch).start(
      job(), handlers(), host(async () => ({ key: 'k1', playbackRate: 1 })),
    )
    expect(direct.pauses).toBe(1)

    // 暂停同样收口到两条：只暂停当前分支会漏掉「切引擎窗口里旧介质还在响」那一格
    group.pauseAll()
    expect(bytes.pauses).toBe(1)
    expect(direct.pauses).toBe(2)          // 起播静音 1 次 + pauseAll 1 次
    group.stopAll()
    expect(direct.stops).toBe(1)
    group.releaseAll()
    expect(direct.releases).toBe(1)
    const bytesStop = vi.spyOn(bytes, 'stop')
    group.stopAll()
    expect(bytesStop).toHaveBeenCalledTimes(1)
  })
})
