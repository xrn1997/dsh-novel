import { describe, expect, it, vi } from 'vitest'
import { BROWSER_TTS_ENGINE_ID, TTS_DEFAULTS } from '../../src/shared/wire.js'
import type { ListenState, SynthesisRequest } from '../../src/shared/wire.js'
import {
  ListenSession, PARAMS_RESTART_DEBOUNCE_MS, TTS_MAX_CONSECUTIVE_FAILURES,
} from '../../src/client/tts/listen-session.js'
import type { Debounced, ListenPlatform, TtsDefaults } from '../../src/client/tts/listen-session.js'
import { setReadingProbe } from '../../src/client/tts/reading-position.js'
import type {
  BranchHost, BranchStartOutcome, ListenBranches, OutputHandlers, PlaybackBranch, SegmentJob,
} from '../../src/client/tts/output-contract.js'
import { DirectBranch } from '../../src/client/tts/playback-branches.js'
import { DirectOutput } from '../../src/client/tts/direct-output.js'
import type { DirectSpeechFace, PlatformUtterance } from '../../src/client/tts/direct-output.js'
import { last, must } from '../support/fixture.js'

/**
 * 听书会话的实例行为网：`new ListenSession(假平台 + 假输出)` 驱动，**不 stub 任何全局、
 * 不 mock `api.js`**——平台缝就是这台会话与外界的全部接触面，环境自建在这里根本够不着。
 *
 * 钉这些事：起播推进到下一段（位置落盘走平台注入的防抖，推轮子不等墙钟）；单段失败留痕
 * 跳过、连败到线暂停；参数变更作废旧回执并按新参数重取当前段；定时到点暂停；直出型开口
 * 无事件走兜底失败径（这一例用真 `DirectOutput` + 假 speech 面，兜底定时同样走平台计时）；
 * 插件收口（`dispose`）无条件放介质（`ADR-0092`：放音 / 暂停 / 已停三种状态各恰好放一次）；
 * 收口先 flush 最后一笔位置，并作废取数 / 等语音表在途的起播（`ADR-0092`：卸载终点之后
 * 不许长出新会话）；同段在途合成合流（跳段只退自己那一票，`ADR-0082`）；同章自适应预取
 * 窗口与并发上限；出声槽预载不发起重复合成；跨章预取交接（正文 / 参数对不上就作废重取，
 * `ADR-0102`）。
 */
describe('ListenSession 实例：假平台 + 假输出', () => {
  /** 平台的手表：延时全走这盘轮子。测试推轮子走时间，不碰全局计时器、不等墙钟。 */
  class FakeClock {
    now = 1_700_000_000_000
    private timers: { at: number; cb: () => void; cancelled: boolean }[] = []

    after(ms: number, cb: () => void): () => void {
      const entry = { at: this.now + ms, cb, cancelled: false }
      this.timers.push(entry)
      return () => { entry.cancelled = true }
    }

    /** 推进 ms：到点的回调按时刻序放行，回调里新排的 timer 参与同一轮。 */
    advance(ms: number): void {
      const until = this.now + ms
      for (;;) {
        const due = this.timers
          .filter((t) => !t.cancelled && t.at <= until)
          .sort((a, b) => a.at - b.at)[0]
        if (due === undefined) break
        this.timers = this.timers.filter((t) => t !== due)
        this.now = Math.max(this.now, due.at)
        due.cb()
      }
      this.now = until
    }
  }

  /** 用平台计时注入搭的防抖（生产平台用 `client/util.ts` 的 `debounce`，同一形状）。 */
  function fakeDebounce<A extends unknown[]>(clock: FakeClock, fn: (...args: A) => void, ms: number): Debounced<A> {
    let pending: A | null = null
    let cancelTimer: (() => void) | null = null
    const wrapped = (...args: A): void => {
      pending = args
      cancelTimer?.()
      cancelTimer = clock.after(ms, () => {
        cancelTimer = null
        const p = pending
        pending = null
        if (p !== null) fn(...p)
      })
    }
    wrapped.flush = (): void => {
      cancelTimer?.()
      cancelTimer = null
      const p = pending
      pending = null
      if (p !== null) fn(...p)
    }
    wrapped.cancel = (): void => {
      cancelTimer?.()
      cancelTimer = null
      pending = null
    }
    return wrapped
  }

  /** 字节型假分支：只记账，出声时机由用例拨弄回调。缺省 `start` 立刻回报真开口并结束准备期
   *  （等价于 `onplaying` 落地）；`failOnStart` = 介质异步回报「这一段没成」（演音频 404 / 拒绝）。
   *  准备策略（求回执）照真分支：回执归会话，分支只消费——这正是 `ADR-0081` / `ADR-0082` 的锚点。 */
  class FakeBytesBranch implements PlaybackBranch {
    readonly capabilities = {
      segmentProgress: true,
      prefetch: true,
      receiptResume: true,
      selfHeal: true,
      voiceTable: 'engine' as const,
    }

    /** `volume` = 分支在起播那一刻从 `BranchHost.voice()` **活读**到的音量（真分支把它交给介质；
     *  会话「合成在途改音量、出声用新值」这条口径靠它钉，不靠读会话自己的 state）。 */
    starts: { job: SegmentJob; receipt: { key: string; playbackRate: number } | null; handlers: OutputHandlers; volume: number }[] = []
    preloaded: string | null = null
    preloads: string[] = []
    pauseCount = 0
    stopCount = 0
    releaseCount = 0
    invalidateCount = 0
    dropPreloadCount = 0
    volumes: number[] = []
    failOnStart = false

    ready(): true { return true }

    async start(job: SegmentJob, handlers: OutputHandlers, host: BranchHost): Promise<BranchStartOutcome> {
      // 字节型的准备：先求回执（缓存与代际归会话）；取消不是失败（ADR-0082 决定 5）。
      let receipt: { key: string; playbackRate: number } | null
      try {
        receipt = await host.receipt(job)
      } catch {
        return job.signal.aborted ? 'cancelled' : 'failed'
      }
      if (receipt === null) return 'cancelled'
      this.preloaded = null
      this.starts.push({ job, receipt, handlers, volume: host.voice().volume })
      if (this.failOnStart) {
        // 介质没开口：异步到达，与真适配器的 play 拒绝同形
        queueMicrotask(() => { handlers.fail() })
        return 'started'
      }
      handlers.prepared?.()
      handlers.start?.()
      return 'started'
    }

    /** 本假分支没有介质槽：续播一律交回会话重新起播。 */
    resume(): boolean { return false }

    yieldForLoad(): void { /* 字节型旧音频继续放 */ }

    pause(): void { this.pauseCount += 1 }

    stop(): void { this.stopCount += 1 }

    release(): void { this.releaseCount += 1 }

    setVolume(volume: number): void { this.volumes.push(volume) }

    invalidate(): void { this.invalidateCount += 1 }

    preload(key: string): void {
      if (this.preloaded !== key) this.preloads.push(key)
      this.preloaded = key
    }

    dropPreload(): void { this.dropPreloadCount += 1; this.preloaded = null }

    held(): boolean { return false }
  }

  /** 假 speech 面：喂给真 `DirectOutput`——开口后一个事件都不回，演被平台整支吞掉的开口。 */
  interface FakeSpeech {
    face: DirectSpeechFace
    utterances: (PlatformUtterance & { text: string })[]
    handlers: { onStart(): void; onEnd(): void; onError(): void }[]
    speaks: number
    /** 改下一次读数给出的音色表（起播闸门的假平台读数）。 */
    setVoices(voices: { voiceURI: string }[]): void
  }

  function makeFakeSpeech(): FakeSpeech {
    const utterances: FakeSpeech['utterances'] = []
    const handlers: FakeSpeech['handlers'] = []
    let voices: { voiceURI: string }[] = [{ voiceURI: 'v1' }]
    let speaks = 0
    const face: DirectSpeechFace = {
      voices: () => voices,
      newUtterance: (text, handlersOfSegment) => {
        const u = { text, voice: null, rate: 1, volume: 1 }
        utterances.push(u)
        handlers.push(handlersOfSegment)
        return u
      },
      speak: () => { speaks += 1 },
      cancel: () => { /* 假平台不补发 canceled */ },
      speaking: () => false,
      pending: () => false,
    }
    return {
      face, utterances, handlers, get speaks() { return speaks },
      setVoices: (next) => { voices = next },
    }
  }

  interface Harness {
    session: ListenSession
    clock: FakeClock
    speech: FakeSpeech
    bytes: FakeBytesBranch
    /** 两条分支的组：用例可替换其中一条（真直出分支换假语音面等）。 */
    branches: { bytes: PlaybackBranch; direct: PlaybackBranch }
    saves: { bookKey: string; listen: ListenState }[]
    progressSaves: { bookKey: string; chapterIndex: number; offsetRatio: number }[]
    synthCalls: SynthesisRequest[]
    /** 每一发合成请求拿到的取消位（按文本索引）：播放层取不取消，看这里。 */
    synthSignals: Map<string, AbortSignal | undefined>
    fixture: { names: string[]; texts: string[][] }
    failSynth: (text: string) => void
    /** 只让下一次针对该文本的合成失败，之后恢复成功（演瞬时网络抖动）。 */
    failSynthOnce: (text: string) => void
    /** 某引擎的回执报多少补速（会话只搬运，不自己算）。 */
    setSynthPlaybackRate: (engineId: string, rate: number) => void
    /** 挂起某段的合成请求，返回放行函数（模拟合成在途的窗口）。 */
    holdSynth: (text: string) => () => void
    /** 挂起某章的正文拉取，返回放行函数（模拟章正文在途的窗口）。 */
    holdFetch: (index: number) => () => void
    /** 让某章的正文拉取直接失败（模拟换起播点时的网络抖动）。 */
    failFetch: (index: number) => void
    /** 挂起下一次「等平台语音表」，返回放行函数（模拟直出源起播在途的窗口）。 */
    holdVoices: () => (ready: boolean) => void
    setReaderPresent: (present: boolean) => void
    /** 听书缺省喂值：合进平台 `defaults()` 读口的来源袋（读时求值，下一次取值即见）。 */
    setTtsDefaults: (p: Partial<TtsDefaults>) => void
  }

  function makeHarness(): Harness {
    const clock = new FakeClock()
    const after = (ms: number, cb: () => void): (() => void) => clock.after(ms, cb)
    const speech = makeFakeSpeech()
    const bytes = new FakeBytesBranch()
    const fixture = {
      names: ['第一章', '第二章'],
      texts: [['第一段。', '第二段。', '第三段。'], ['第二章第一段。']],
    }
    const saves: Harness['saves'] = []
    const progressSaves: Harness['progressSaves'] = []
    const synthCalls: SynthesisRequest[] = []
    const synthSignals = new Map<string, AbortSignal | undefined>()
    const synthRates = new Map<string, number>()
    const failing = new Set<string>()
    const failOnce = new Set<string>()
    const holds = new Map<string, Promise<void>>()
    const fetchHolds = new Map<number, Promise<void>>()
    const fetchFailures = new Set<number>()
    let voiceHold: Promise<boolean> | null = null
    let readerPresent = false
    /** 听书缺省来源袋：`defaults()` 每次现读（读时求值），袋里没有的格落 wire 缺省。 */
    const ttsDefaults: Partial<TtsDefaults> = {}
    /** 源级闸门的平台读数：直出分支的 `ready()` 直接问它（真适配器的 `awaitDirectVoices` 等价物）。 */
    const awaitVoices = async (): Promise<boolean> => {
      const held = voiceHold
      voiceHold = null
      if (held !== null) return held
      return speech.face.voices().length > 0
    }
    const branches: Harness['branches'] = {
      bytes,
      direct: new DirectBranch(new DirectOutput(speech.face, (ms, cb) => clock.after(ms, cb)), {
        awaitVoices,
        peer: () => branches.bytes,
      }),
    }
    const listenBranches: ListenBranches = {
      branch: (mode) => (mode === 'direct' ? branches.direct : branches.bytes),
      held: () => branches.direct.held() || branches.bytes.held(),
      pauseAll: () => { branches.bytes.pause(); branches.direct.pause() },
      stopAll: () => { branches.direct.stop(); branches.bytes.stop() },
      releaseAll: () => { branches.direct.release(); branches.bytes.release() },
    }
    const platform: ListenPlatform = {
      fetchChapters: async () => fixture.names.map((name, i) => ({ name, url: `u${i}` })),
      fetchUnits: async (_sourceId, _bookKey, index) => {
        const hold = fetchHolds.get(index)
        if (hold !== undefined) await hold
        if (fetchFailures.has(index)) throw new Error(`fetch 说第 ${index} 章不成`)
        return must(fixture.texts[index], `第 ${index} 章正文`)
      },
      shelfEntryOf: async () => null,
      saveListen: async (bookKey, listen) => { saves.push({ bookKey, listen }) },
      saveProgress: async (bookKey, chapterIndex, offsetRatio) => {
        progressSaves.push({ bookKey, chapterIndex, offsetRatio })
      },
      readerPresent: () => readerPresent,
      synthesize: async (req, opts) => {
        synthCalls.push(req)
        synthSignals.set(req.text, opts?.signal)
        const hold = holds.get(req.text)
        if (hold !== undefined) await hold
        if (failing.has(req.text)) throw new Error('synth 说这一段不成')
        if (failOnce.delete(req.text)) throw new Error('synth 瞬时失败一次')
        return {
          key: `k:${req.engineId}:${req.rate}:${req.voice ?? ''}:${req.text}`,
          mediaType: 'audio/mpeg',
          // 回执报的是「服务端做到哪、播放端补多少」，与请求里的 rate 是两个数：这里按引擎给
          playbackRate: synthRates.get(req.engineId) ?? 1,
        }
      },
      branches: listenBranches,
      now: () => clock.now,
      after,
      watchPageHide: () => () => { /* 假平台不挂宿主事件 */ },
      debounce: <A extends unknown[]>(fn: (...args: A) => void, ms: number): Debounced<A> => fakeDebounce(clock, fn, ms),
      defaults: () => ({ ...TTS_DEFAULTS, ...ttsDefaults }),
    }
    return {
      session: new ListenSession(platform),
      clock, speech, bytes, branches, saves, progressSaves, synthCalls, synthSignals, fixture,
      setSynthPlaybackRate: (engineId, rate) => { synthRates.set(engineId, rate) },
      failSynth: (text) => { failing.add(text) },
      failSynthOnce: (text) => { failOnce.add(text) },
      holdSynth: (text) => {
        let release = (): void => { throw new Error('合成闸未就绪') }
        holds.set(text, new Promise<void>((resolve) => { release = resolve }))
        return release
      },
      holdFetch: (index) => {
        let release = (): void => { throw new Error('正文闸未就绪') }
        fetchHolds.set(index, new Promise<void>((resolve) => { release = resolve }))
        return release
      },
      failFetch: (index) => { fetchFailures.add(index) },
      holdVoices: () => {
        let release: (ready: boolean) => void = () => { throw new Error('语音闸未就绪') }
        voiceHold = new Promise<boolean>((resolve) => { release = resolve })
        return release
      },
      setReaderPresent: (present) => { readerPresent = present },
      setTtsDefaults: (p) => { Object.assign(ttsDefaults, p) },
    }
  }

  function start(h: Harness): Promise<void> {
    return h.session.startListening({
      sourceId: 's1', bookKey: 'b1', title: '书一', chapterIndex: 0, paragraphIndex: 0,
    })
  }

  /** 让在途 Promise 链（假平台的合成与推进）走完；不改时钟。 */
  async function microtasks(count = 30): Promise<void> {
    for (let i = 0; i < count; i += 1) await Promise.resolve()
  }

  it('停止即取消在途合成：那一发拿到取消位，作废不记成段失败', async () => {
    const h = makeHarness()
    const release = h.holdSynth('第一段。')
    const started = start(h)
    await microtasks()
    const signal = must(h.synthSignals.get('第一段。'), '会话要把取消位递到合成面')
    expect(signal.aborted).toBe(false)

    h.session.stopListening()
    expect(signal.aborted, '停止要让在途那一发作废').toBe(true)

    release()
    await started
    expect(h.session.state.get()).toMatchObject({
      active: false, consecutiveFailures: 0, halt: null,
    })
  })

  it('暂停不在取消位之列：在途合成不被掐掉（续播要接的正是它）', async () => {
    const h = makeHarness()
    const release = h.holdSynth('第一段。')
    const started = start(h)
    await microtasks()
    const signal = must(h.synthSignals.get('第一段。'), '首段合成在途')
    expect(signal.aborted).toBe(false)

    h.session.pauseListening()
    expect(signal.aborted, '暂停只是先不听，不该把已经发出的合成作废').toBe(false)

    release()
    await started
    await microtasks()
  })

  it('跳段只作废当前段那一发：同章预取不受牵连，跳回去仍命中暖好的回执', async () => {
    const h = makeHarness()
    h.fixture.texts[0] = ['p0。', 'p1。', 'p2。', 'p3。', 'p4。', 'p5。']
    await start(h)                                // p0 起播，顺带暖 p1..p4
    await microtasks()
    const prefetched = ['p1。', 'p2。'].map((text) => must(h.synthSignals.get(text), `${text} 的预取`))
    expect(prefetched.every((s) => !s.aborted)).toBe(true)

    const release = h.holdSynth('p5。')
    h.session.seekParagraph(5)                    // p5 在同章最大预取窗外，合成在途
    await microtasks()
    const inFlight = must(h.synthSignals.get('p5。'), 'p5 那一发')
    expect(inFlight.aborted).toBe(false)

    h.session.seekParagraph(2)                    // 再跳走：没人听的是 p5 这一发
    expect(inFlight.aborted, '跳段要把这一发停在上游').toBe(true)
    expect(prefetched.every((s) => !s.aborted), '同章预取不该被跳段连坐').toBe(true)

    await microtasks()
    expect(h.synthCalls.filter((c) => c.text === 'p2。'), '跳回已暖好的段不该重新合成').toHaveLength(1)
    expect(last(h.bytes.starts).receipt?.key, '用的是预取时存下的回执').toContain('p2。')

    release()
    await microtasks()
  })

  it('换语速取消旧参数那一发，按新参数重取的那只取消位是活的', async () => {
    const h = makeHarness()
    const release = h.holdSynth('第一段。')
    const started = start(h)
    await microtasks()
    const stale = must(h.synthSignals.get('第一段。'), '首段合成在途')

    h.session.setListenRate(1.5)
    expect(stale.aborted, '旧参数那一发不再有人等').toBe(true)

    release()
    await started
    h.clock.advance(PARAMS_RESTART_DEBOUNCE_MS)
    await microtasks()
    const fresh = must(h.synthSignals.get('第一段。'), '按新参数重取')
    expect(fresh).not.toBe(stale)
    expect(fresh.aborted).toBe(false)
    expect(must(h.synthCalls.at(-1), '最后一发合成').rate).toBe(1.5)
  })

  it('跳章取消上一章的在途预取：迟到的字节不为没人听的章继续合成', async () => {
    const h = makeHarness()
    const releaseAhead = h.holdSynth('第二段。')     // 起播后的同章预取挂在这一段上
    await start(h)
    await microtasks()
    const ahead = must(h.synthSignals.get('第二段。'), '预取应已发出')
    expect(ahead.aborted).toBe(false)

    await h.session.jumpToChapter(1)
    await microtasks()
    expect(ahead.aborted, '换章即作废上一章的预取').toBe(true)
    releaseAhead()
  })

  it('回执报的补速原样交给出声层：语速归谁由服务端说了算，会话不自己算', async () => {
    const h = makeHarness()
    h.setSynthPlaybackRate('builtin:baidu', 1.5)
    await start(h)
    expect(must(h.bytes.starts[0], '首段出声').receipt?.playbackRate).toBe(1.5)

    // 推进下一段：同一引擎的补速跟着走（漏一次就等于那段悄悄回到 1.0x）
    must(h.bytes.starts[0], '首段').handlers.done()
    await microtasks()
    expect(must(h.bytes.starts[1], '第二段').receipt?.playbackRate).toBe(1.5)
  })

  it('起播推进到下一段；位置落盘走平台注入的防抖，推轮子即落、不等墙钟', async () => {
    const h = makeHarness()
    await start(h)
    expect(h.session.state.get()).toMatchObject({
      active: true, chapterIndex: 0, chapterNames: ['第一章', '第二章'],
      paragraphIndex: 0, paragraphText: '第一段。', playing: true, mode: 'bytes',
    })
    expect(must(h.synthCalls[0], '首段合成').text).toBe('第一段。')
    expect(h.bytes.starts).toHaveLength(1)
    expect(h.saves, '防抖窗内不落盘').toHaveLength(0)

    must(h.bytes.starts[0], '首段').handlers.done()
    await microtasks()
    expect(h.session.state.get()).toMatchObject({ paragraphIndex: 1, paragraphText: '第二段。', playing: true })
    expect(h.bytes.starts, '推进即起下一段').toHaveLength(2)

    h.clock.advance(2000)
    const saved = must(h.saves[0], '防抖到点的落盘')
    expect(saved.bookKey).toBe('b1')
    expect(saved.listen).toMatchObject({ chapterIndex: 0, paragraphIndex: 1 })
    // 同一节拍也写共用消费位置：3 段里的第 1 段按两端对齐 = 章内 0.5
    expect(must(h.progressSaves[0], '防抖到点的进度落盘')).toEqual({
      bookKey: 'b1', chapterIndex: 0, offsetRatio: 0.5,
    })
  })

  it('暂停立即 flush：listen 与 progress 同一个出口各写一笔', async () => {
    const h = makeHarness()
    await start(h)
    h.session.pauseListening()
    expect(h.saves).toHaveLength(1)
    expect(h.progressSaves).toEqual([{ bookKey: 'b1', chapterIndex: 0, offsetRatio: 0 }])
  })

  it('阅读器子树在场：播放层只写 listen，progress 归阅读会话（ADR-0093）', async () => {
    const h = makeHarness()
    h.setReaderPresent(true)
    await start(h)
    h.clock.advance(2000)
    expect(h.saves, 'listen 照常落盘').toHaveLength(1)
    expect(h.progressSaves, 'progress 不由播放层写').toHaveLength(0)

    h.session.setListenVolume(0.4)                    // 排一笔待落盘
    h.session.pauseListening()                        // 暂停 flush 它
    expect(h.saves.length, '暂停 flush 仍写 listen').toBe(2)
    expect(h.progressSaves, '暂停 flush 也不越权写 progress').toHaveLength(0)

    // 阅读器撤场：下一笔落盘由播放层补 progress，书架游标才跟得上。
    h.setReaderPresent(false)
    h.session.setListenVolume(0.6)
    h.clock.advance(2000)
    expect(h.progressSaves).toHaveLength(1)
  })

  it('单段失败留痕并跳过；连败到 TTS_MAX_CONSECUTIVE_FAILURES 即暂停', async () => {
    const h = makeHarness()
    h.fixture.texts[0] = ['p0。', 'p1。', 'p2。', 'p3。', 'p4。', 'p5。']
    for (const text of must(h.fixture.texts[0], '六段')) h.failSynth(text)
    await start(h)
    await vi.waitFor(() => {
      expect(h.session.state.get().consecutiveFailures).toBe(TTS_MAX_CONSECUTIVE_FAILURES)
    })
    const st = h.session.state.get()
    expect(st.halt, '到线暂停要公布停因与次数').toEqual({
      reason: 'consecutive-failures', failures: TTS_MAX_CONSECUTIVE_FAILURES,
    })
    expect(st.paragraphIndex, '到线停在最后一段，不再往下跳').toBe(4)
    expect(st.playing).toBe(false)
    expect(h.bytes.starts, '一次都没出声').toHaveLength(0)
  })

  it('参数变更作废旧回执：当前段按新引擎重新合成、按新键起播', async () => {
    const h = makeHarness()
    await start(h)
    const oldKey = must(h.bytes.starts[0], '首段').receipt?.key
    expect(h.synthCalls.filter((c) => c.text === '第一段。').map((c) => c.engineId))
      .toEqual([TTS_DEFAULTS.engineId])

    await h.session.setListenEngine('http:other')
    await microtasks()
    expect(h.synthCalls.filter((c) => c.text === '第一段。').map((c) => c.engineId))
      .toEqual([TTS_DEFAULTS.engineId, 'http:other'])
    const replay = last(h.bytes.starts)
    expect(replay.receipt?.key, '旧键作废，新引擎的新键才起播').not.toBe(oldKey)
    expect(h.session.state.get()).toMatchObject({ engineId: 'http:other', mode: 'bytes', playing: true })
  })

  it('起播音量活读：合成在途改音量，出声用新值，不被入口快照盖回', async () => {
    const h = makeHarness()
    const release = h.holdSynth('第一段。')
    const starting = start(h)
    await microtasks()
    expect(h.session.state.get().loading, '合成在途').toBe(true)
    expect(h.bytes.starts, '音频还没起').toHaveLength(0)

    h.session.setListenVolume(0.42)
    release()
    await starting
    await microtasks()
    const seg = must(h.bytes.starts[0], '首段')
    expect(seg.handlers, '首段已交给分支').toBeDefined()
    expect(seg.volume, '出声那一发拿的是合成在途改后的新音量，不是入口快照').toBe(0.42)
  })

  it('暂停收口两条介质：切引擎窗口里旧介质还在响时，按暂停不能只掐新分支', async () => {
    const h = makeHarness()
    await start(h)
    const bytesPause = vi.spyOn(h.branches.bytes, 'pause')
    const directPause = vi.spyOn(h.branches.direct, 'pause')
    h.session.pauseListening()
    // 直出切字节时旧 utterance 要等合成回执落地才被对侧静音；这期间按暂停必须两条都收口，
    // 否则屏幕说暂停、旧声音还在念（回归：只暂停当前分支）
    expect(directPause, '另一条介质也要暂停').toHaveBeenCalled()
    expect(bytesPause, '当前介质当然要暂停').toHaveBeenCalled()
  })

  it('失败收口：切引擎后合成落空，旧介质不许替失败的段继续响（读数说停就不许再响）', async () => {
    const h = makeHarness()
    await h.session.startListening({
      sourceId: 's1', bookKey: 'b1', title: '书一', chapterIndex: 0, paragraphIndex: 0,
      engineId: BROWSER_TTS_ENGINE_ID,
    })
    expect(h.branches.direct.held(), '直出型旧 utterance 进了平台队列').toBe(true)

    h.failSynth('第一段。')
    h.holdSynth('第二段。')                       // 重试那一发挂起：连败计数不被「真开口清零」抹掉
    await h.session.setListenEngine('e-bytes')      // 切字节引擎：按新参数重取当前段，合成落空
    await microtasks()

    expect(h.session.state.get().consecutiveFailures, '落空记一格连败').toBe(1)
    expect(h.branches.direct.held(), '失败收口：读数写「不在放」，旧 utterance 不许继续念').toBe(false)
  })

  it('定时到点暂停：档位与到点时刻读平台时钟，推轮子即收口', async () => {
    const h = makeHarness()
    await start(h)
    const armed = h.clock.now
    h.session.setListenTimer(1)
    expect(h.session.state.get()).toMatchObject({ timerChoice: 1, timerEndAt: armed + 60_000 })

    h.clock.advance(60_000)
    expect(h.clock.now).toBe(armed + 60_000)
    expect(h.session.state.get()).toMatchObject({
      playing: false, timerEndAt: null, timerChoice: null,
    })
  })

  it('直出型开口无事件：兜底到点问平台，答「没在念」即走失败径留痕推进', async () => {
    const h = makeHarness()
    await h.session.startListening({
      sourceId: 's1', bookKey: 'b1', title: '书一', chapterIndex: 0, paragraphIndex: 0,
      engineId: BROWSER_TTS_ENGINE_ID,
    })
    const before = h.session.state.get()
    expect(before).toMatchObject({ mode: 'direct', loading: true, playing: false })
    expect(h.speech.speaks, '交出去了，事件一个都不来').toBe(1)

    h.clock.advance(2000)
    const st = h.session.state.get()
    expect(st.halt, '一次失败不到阈值：不公布停因').toBeNull()
    expect(st.paragraphIndex, '留痕后推进').toBe(1)
    expect(st.consecutiveFailures).toBe(1)
    expect(st.playing).toBe(false)

    // 迟到的开口事件撞在旧发上：不推进也不二次留痕
    must(h.speech.handlers[0], '首段的事件面').onEnd()
    expect(h.session.state.get()).toMatchObject({ paragraphIndex: 1, halt: null })
  })

  it('直出源起播先等平台语音表：等不到才报 TTS_NO_VOICES，等待里有表就起播', async () => {
    const h = makeHarness()
    const direct = {
      sourceId: 's1', bookKey: 'b1', title: '书一', chapterIndex: 0, paragraphIndex: 0,
      engineId: BROWSER_TTS_ENGINE_ID,
    }
    h.speech.setVoices([])
    await expect(h.session.startListening(direct)).rejects.toMatchObject({ code: 'TTS_NO_VOICES' })
    expect(h.session.state.get().active, '没有语音就不建会话').toBe(false)

    // 平台稍后把表交出来（真机上的 voiceschanged 路径）：同一次起播不再误报
    h.speech.setVoices([{ voiceURI: 'v1' }])
    await h.session.startListening(direct)
    expect(h.session.state.get()).toMatchObject({ active: true, mode: 'direct' })
  })

  it('每段音频都没开口（404 / play 被拒）：连败到阈值就暂停，不静默把整本走完', async () => {
    const h = makeHarness()
    h.fixture.texts[0] = ['p0。', 'p1。', 'p2。', 'p3。', 'p4。', 'p5。']
    h.bytes.failOnStart = true
    await start(h)
    await vi.waitFor(() => {
      expect(h.session.state.get().consecutiveFailures).toBe(TTS_MAX_CONSECUTIVE_FAILURES)
    })
    const st = h.session.state.get()
    expect(st.halt, '到线暂停要公布停因与次数').toEqual({
      reason: 'consecutive-failures', failures: TTS_MAX_CONSECUTIVE_FAILURES,
    })
    expect(st.paragraphIndex, '到线停在第五段，不再往下跳').toBe(4)
    expect(st.playing).toBe(false)
    expect(st.active, '是暂停不是停止：控制面还在').toBe(true)
    expect(st.chapterIndex, '没有一路试到下一章').toBe(0)
    // 每段一次自愈 + 一次落败 = 两次起播尝试；起播即清零的旧口径会让计数永远回到 1。
    expect(h.bytes.starts).toHaveLength(TTS_MAX_CONSECUTIVE_FAILURES * 2)
    expect(h.bytes.invalidateCount, '每段自愈一次：先作废槽键').toBe(TTS_MAX_CONSECUTIVE_FAILURES)
  })

  it('直出源起播在途时换书：等待落空的那一发被作废，不抛 TTS_NO_VOICES、不抢新会话', async () => {
    const h = makeHarness()
    h.speech.setVoices([])
    const release = h.holdVoices()
    const pending = h.session.startListening({
      sourceId: 's1', bookKey: 'b1', title: '书一', engineId: BROWSER_TTS_ENGINE_ID,
    })
    await microtasks()
    // 换书：第二发在等待窗口里起飞并落地（字节型没有语音表闸）
    await h.session.startListening({ sourceId: 's1', bookKey: 'b2', title: '书二' })
    const startsBefore = h.bytes.starts.length
    expect(h.session.state.get()).toMatchObject({ active: true, bookKey: 'b2', playing: true })

    release(false)
    await expect(pending, '作废的起播不许把等待落空演成设备错误').resolves.toBeUndefined()
    await microtasks()
    expect(h.session.state.get(), '新会话不被旧发停掉').toMatchObject({ active: true, bookKey: 'b2' })
    expect(h.bytes.starts, '旧发也不再起一段').toHaveLength(startsBefore)
  })

  it('直出源起播在途时停止：等待落空同样不抛假错误', async () => {
    const h = makeHarness()
    await start(h)                                  // 先有可停的会话现场
    h.speech.setVoices([])
    const release = h.holdVoices()
    const pending = h.session.startListening({
      sourceId: 's1', bookKey: 'b2', title: '书二', engineId: BROWSER_TTS_ENGINE_ID,
    })
    await microtasks()
    h.session.stopListening()
    expect(h.session.state.get().active).toBe(false)

    release(false)
    await expect(pending).resolves.toBeUndefined()
    expect(h.session.state.get().active, '停止之后不许被作废的起播复活').toBe(false)
  })

  it('跳章后旧章合成迟到：旧回执不写进新章，同号段不念错章', async () => {
    const h = makeHarness()
    h.fixture.texts[0] = ['A0。', 'A1。', 'A2。', 'A3。', 'A4。', 'A5。']
    h.fixture.texts[1] = ['B0。', 'B1。', 'B2。', 'B3。', 'B4。', 'B5。']
    await start(h)                              // 第一章 A0 起播
    const release = h.holdSynth('A5。')          // 挂起第一章 index5 的合成（预取窗外）
    h.session.seekParagraph(5)
    await microtasks()
    expect(h.session.state.get().loading, '第一章 A5 合成在途').toBe(true)

    void h.session.jumpToChapter(1)                  // 跳第二章：清 receipts、起播 B0
    await microtasks()
    expect(h.session.state.get()).toMatchObject({ chapterIndex: 1, paragraphIndex: 0 })
    expect(last(h.bytes.starts).receipt?.key).toContain('B0。')

    release()                                   // 旧章 index5 的合成迟到落地
    await microtasks()

    h.session.seekParagraph(5)                  // 第二章 index5 应合成 B5，不命中旧章回执
    await microtasks()
    expect(last(h.bytes.starts).receipt?.key, '旧章回执不得污染新章同号段').toContain('B5。')
  })

  it('字节型换段即归零段进度：合成在途也不把上一段比例投到新段', async () => {
    const h = makeHarness()
    h.fixture.texts[0] = ['p0。', 'p1。', 'p2。', 'p3。', 'p4。', 'p5。']
    await start(h)
    const progress = must(h.bytes.starts[0], '首段').handlers.progress
    must(progress, '进度事件面')(3, 10)   // 首段已出声一会儿
    expect(h.session.progress.get()).toEqual({ position: 3, duration: 10 })

    const release = h.holdSynth('p5。')          // p5 在同章最大预取窗外
    h.session.seekParagraph(5)                   // 跳到 p5，合成在途
    await microtasks()
    expect(h.session.state.get()).toMatchObject({ paragraphIndex: 5, loading: true })
    expect(h.session.progress.get(), '换段即归零，不等合成落地').toEqual({ position: 0, duration: 0 })
    release()
    await microtasks()
  })

  it('合成在途照跳、章正文在途不接：`loading` 与章正文在途是两回事', async () => {
    const h = makeHarness()
    h.fixture.texts[0] = ['p0。', 'p1。', 'p2。', 'p3。', 'p4。', 'p5。']
    await start(h)
    const releaseSynth = h.holdSynth('p5。')     // p5 在同章最大预取窗外
    h.session.seekParagraph(5)
    await microtasks()
    expect(h.session.state.get()).toMatchObject({
      paragraphIndex: 5, loading: true,
    })

    // 合成在途窗口里再跳一次照跳：playSeq 会把在途那一发作废，不该按了没反应
    h.session.seekParagraph(2)
    await microtasks()
    expect(h.session.state.get().paragraphIndex, '合成在途不吞跳段').toBe(2)

    // 章正文在途：段域还是上一章的读数，跳段 / 滑杆都不接
    const releaseFetch = h.holdFetch(1)
    const jumping = h.session.jumpToChapter(1)
    await microtasks()
    expect(h.session.state.get().loading, '章正文在途：读数是 loading').toBe(true)
    h.session.seekParagraph(0)
    await h.session.skipParagraph(1)
    expect(h.session.state.get().paragraphIndex, '章正文在途不接跳段').toBe(2)

    releaseFetch()
    await jumping
    await microtasks()
    expect(h.session.state.get()).toMatchObject({ chapterIndex: 1, loading: false })
    releaseSynth()
    await microtasks()
  })

  it('自动跨空章时用户暂停：不被下一可读章吞掉（空章载入期间 playSeq 被抬即停住）', async () => {
    const h = makeHarness()
    h.fixture.names = ['第一章', '第二章', '第三章']
    h.fixture.texts = [['A0。'], [], ['C0。']]   // 第二章是空章（只有图 / 分隔符，无可朗读单元）
    await start(h)                              // 第一章 A0 起播
    const release = h.holdFetch(1)              // 挂起空章（第二章）的正文拉取
    must(h.bytes.starts[0], '首段').handlers.done()   // A0 播完 → finishChapter 自动推进到第二章
    await microtasks()
    expect(h.session.state.get().loading, '空章正文在途').toBe(true)

    h.session.pauseListening()                  // 用户在空章载入期间按暂停
    release()                                   // 空章正文落地（空）
    await microtasks()

    const st = h.session.state.get()
    expect(st.playing, '暂停不被空章自动推进吞掉').toBe(false)
    expect(st.chapterIndex, '停在空章，不自动跳到第三章起播').toBe(1)
    expect(h.synthCalls.some((c) => c.text === 'C0。'), '第三章不该被自动起播').toBe(false)
  })

  it('章正文在途按暂停再按继续：不拿上一章续播，也不把新章进度写坏', async () => {
    const h = makeHarness()
    await start(h)                                  // 第一章首段起播
    const release = h.holdFetch(1)                  // 挂起第二章正文
    const jumping = h.session.jumpToChapter(1)
    await microtasks()
    expect(h.session.state.get()).toMatchObject({ chapterIndex: 0, loading: true })

    h.session.pauseListening()                      // 载入在途按暂停
    expect(h.session.state.get()).toMatchObject({ playing: false, loading: false })
    const startsBefore = h.bytes.starts.length
    const writesBefore = h.progressSaves.length

    h.session.resumeListening()                     // 守卫：章正文在途不接 resume
    await microtasks()
    expect(h.bytes.starts.length, '不拿上一章的段域续播').toBe(startsBefore)
    expect(h.progressSaves.length, '不写新章进度').toBe(writesBefore)

    release()
    await jumping
    await microtasks()
    // 载入落地时 playSeq 已因暂停抬过：停在新章段首，不自动起播
    expect(h.session.state.get()).toMatchObject({
      chapterIndex: 1, paragraphIndex: 0, playing: false, loading: false,
    })
    // 暂停期间不自动起播新章：只数「出声」——下一章的预取（暖缓存）不受暂停影响，不算播放
    expect(h.bytes.starts.every((s) => !s.receipt?.key.includes('第二章第一段。')), '暂停期间不自动起播新章').toBe(true)

    h.session.resumeListening()                     // 载入收口之后这一次才有效
    await microtasks()
    expect(last(h.bytes.starts).receipt?.key).toContain('第二章第一段。')
    expect(h.session.state.get()).toMatchObject({ chapterIndex: 1, playing: true })
  })

  it('换起播点先取数后停旧会话：正文拉不到时旧会话照常放着', async () => {
    const h = makeHarness()
    await start(h)
    const oldKey = last(h.bytes.starts).receipt?.key
    const oldStarts = h.bytes.starts.length
    h.failFetch(1)

    await expect(h.session.startListening({
      sourceId: 's1', bookKey: 'b1', title: '书一', chapterIndex: 1, paragraphIndex: 0,
    })).rejects.toThrow()

    expect(h.session.state.get(), '旧会话没被停掉').toMatchObject({
      active: true, chapterIndex: 0, playing: true,
    })
    expect(h.bytes.starts.length, '没有多起一段').toBe(oldStarts)
    expect(last(h.bytes.starts).receipt?.key).toBe(oldKey)
  })

  it('语速滑杆逐档只重取最后一发：状态即时，重合成等防抖窗', async () => {
    const h = makeHarness()
    await start(h)
    // 只数当前段的重取：参数变更会作废旧预取，重取后顺带按新参数重发预取是另一件事
    const restartsOfCurrent = (): number => h.synthCalls.filter((c) => c.text === '第一段。').length
    const before = restartsOfCurrent()
    h.session.setListenRate(1.5)
    h.session.setListenRate(1.8)
    h.session.setListenRate(2)
    expect(h.session.state.get().rate).toBe(2)
    expect(restartsOfCurrent(), '窗内不逐档重合成').toBe(before)

    h.clock.advance(PARAMS_RESTART_DEBOUNCE_MS)
    await microtasks()
    expect(restartsOfCurrent(), '停手后只发一发').toBe(before + 1)
    expect(h.synthCalls.filter((c) => c.text === '第一段。').at(-1)?.rate).toBe(2)
  })

  it('「从阅读位置起播」复位定时按原到点时刻，不把倒计时重新充满', async () => {
    const h = makeHarness()
    await start(h)
    setReadingProbe(() => ({ chapterIndex: 0, paragraphIndex: 1 }))
    try {
      const armedAt = h.clock.now
      h.session.setListenTimer(15)
      expect(h.session.state.get().timerEndAt).toBe(armedAt + 15 * 60_000)

      h.clock.advance(5 * 60_000)                  // 已听 5 分钟
      await h.session.playFromReadingPosition()
      await microtasks()
      expect(h.session.state.get()).toMatchObject({
        timerChoice: 15,
        timerEndAt: armedAt + 15 * 60_000,
        paragraphIndex: 1,
      })

      h.clock.advance(10 * 60_000 - 1)             // 距原到点还剩 1ms：仍在放
      expect(h.session.state.get().playing).toBe(true)
      h.clock.advance(1)                           // 跨过原到点即收口
      expect(h.session.state.get().playing).toBe(false)
    } finally {
      setReadingProbe(null)
    }
  })

  it('插件收口无条件放介质：放音、暂停、用户已停三种状态各恰好放一次', async () => {
    // 读数不是「介质已停」的证明（`ADR-0092`）：以为「stopListening 就够了」、把 `releaseAll`
    // 从 `dispose` 里删掉的 refactor 必须在这里红。数两条分支的 `release`——放介质一步的全部
    // 可观测面；「恰好一次」两个方向都钉：不许漏放，也不许收两次口。

    // ① 放音中卸载：位置防抖窗里还有最后一笔，收口要先把这一笔冲出去
    const playing = makeHarness()
    await start(playing)
    const playingSaves = playing.saves.length
    const playingProgress = playing.progressSaves.length
    const playingBytes = vi.spyOn(playing.branches.bytes, 'release')
    const playingDirect = vi.spyOn(playing.branches.direct, 'release')
    playing.session.dispose()
    expect(playingBytes, '放音中收口：字节介质放掉').toHaveBeenCalledTimes(1)
    expect(playingDirect, '放音中收口：直出介质放掉').toHaveBeenCalledTimes(1)
    expect(playing.saves.length, '收口先 flush 最后一笔听书位置').toBe(playingSaves + 1)
    expect(playing.saves.at(-1)).toMatchObject({
      bookKey: 'b1', listen: { chapterIndex: 0, paragraphIndex: 0 },
    })
    expect(playing.progressSaves.length, '同一节拍也写共用消费位置').toBe(playingProgress + 1)
    expect(playing.progressSaves.at(-1)).toEqual({
      bookKey: 'b1', chapterIndex: 0, offsetRatio: 0,
    })

    // ② 暂停中卸载：读数已说「不在放」，介质照样要放（暂停中的 Audio 槽不留）
    const paused = makeHarness()
    await start(paused)
    paused.session.pauseListening()
    expect(paused.session.state.get().playing, '前置：读数已不在放').toBe(false)
    const pausedBytes = vi.spyOn(paused.branches.bytes, 'release')
    const pausedDirect = vi.spyOn(paused.branches.direct, 'release')
    paused.session.dispose()
    expect(pausedBytes, '暂停中收口：字节介质放掉').toHaveBeenCalledTimes(1)
    expect(pausedDirect, '暂停中收口：直出介质放掉').toHaveBeenCalledTimes(1)

    // ③ 用户已停再卸载：stopListening 在这条路上早退，放介质一步不能跟着免掉；
    //    停止时已 flush 过位置，收口不许再补一笔重复写
    const stopped = makeHarness()
    await start(stopped)
    stopped.session.stopListening()
    expect(stopped.session.state.get().active, '前置：用户已停，会话已收').toBe(false)
    const stoppedSaves = stopped.saves.length
    const stoppedBytes = vi.spyOn(stopped.branches.bytes, 'release')
    const stoppedDirect = vi.spyOn(stopped.branches.direct, 'release')
    stopped.session.dispose()
    expect(stoppedBytes, '已停后收口：字节介质放掉').toHaveBeenCalledTimes(1)
    expect(stoppedDirect, '已停后收口：直出介质放掉').toHaveBeenCalledTimes(1)
    expect(stopped.saves.length, '已 flush 过的位置不重复写').toBe(stoppedSaves)
  })

  it('卸载撞在起播取数窗口：数据回来只退场，不许再起播（ADR-0092）', async () => {
    // `stopListening` 在「还没有活会话」时早退，取数在途正是这一格；收口必须自己抬代际，
    // 否则数据回来后 `startSession` 照常建 run、起播——卸载终点之后长出没人能停的声音。
    const h = makeHarness()
    const release = h.holdFetch(0)
    const started = start(h)
    h.session.dispose()
    release()
    await started
    await microtasks()

    expect(h.session.state.get().active, '卸载终点之后不许长出新会话').toBe(false)
    expect(h.bytes.starts, '也不许去起播').toHaveLength(0)
    expect(h.synthCalls, '更不许替幽灵会话合成').toEqual([])
    expect(h.bytes.releaseCount, '介质照样收口').toBe(1)
  })

  it('卸载撞在等语音表窗口：放行后也不许开口（ADR-0092）', async () => {
    const h = makeHarness()
    const release = h.holdVoices()
    const started = h.session.startListening({
      sourceId: 's1', bookKey: 'b1', title: '书一', chapterIndex: 0, paragraphIndex: 0,
      engineId: BROWSER_TTS_ENGINE_ID,
    })
    h.session.dispose()
    release(true)
    await started
    await microtasks()

    expect(h.session.state.get().active, '卸载终点之后不许长出新会话').toBe(false)
    expect(h.speech.utterances, '也不许把 utterance 交给平台').toHaveLength(0)
  })

  it('慢网推进到在途预取段：主播放直接复用在途请求不重发，跳走只退本段等待不连坐预取', async () => {
    const h = makeHarness()
    h.fixture.texts[0] = ['p0。', 'p1。', 'p2。', 'p3。', 'p4。', 'p5。']
    const releaseP1 = h.holdSynth('p1。')
    await start(h)
    await microtasks()
    expect(h.synthCalls.filter((c) => c.text === 'p1。')).toHaveLength(1)
    const p1Signal = must(h.synthSignals.get('p1。'), 'p1 预取取消位')

    // p0 播完推进到 p1，此时 p1 预取仍在路上：主播放复用同一发，不发出第二次请求
    must(h.bytes.starts[0], 'p0').handlers.done()
    await microtasks()
    expect(h.session.state.get()).toMatchObject({ paragraphIndex: 1, loading: true })
    expect(h.synthCalls.filter((c) => c.text === 'p1。'), '不重复合成在途预取段').toHaveLength(1)

    // 在等待 p1 时跳往 p5：只作废本次主播放等待，p1 的后台预取保持存活（ADR-0082）
    const releaseP5 = h.holdSynth('p5。')
    h.session.seekParagraph(5)
    await microtasks()
    expect(p1Signal.aborted, '跳段不连坐同章预取').toBe(false)

    releaseP1()
    await microtasks()
    // 跳回 p1 直接命中暖好的回执
    h.session.seekParagraph(1)
    await microtasks()
    expect(h.synthCalls.filter((c) => c.text === 'p1。')).toHaveLength(1)
    expect(last(h.bytes.starts).receipt?.key).toContain('p1。')

    releaseP5()
    await microtasks()
  })

  it('合成在途暂停再续播：复用同一发在途合成，已落地回执也不重合成', async () => {
    const h = makeHarness()
    const releaseP0 = h.holdSynth('第一段。')
    const started = start(h)
    await microtasks()
    expect(h.synthCalls.filter((c) => c.text === '第一段。')).toHaveLength(1)

    // 暂停后立即续播：p0 仍在途，应直接合流，不重发第二发请求
    h.session.pauseListening()
    h.session.resumeListening()
    await microtasks()
    expect(h.synthCalls.filter((c) => c.text === '第一段。'), '续播合流在途请求').toHaveLength(1)

    releaseP0()
    await started
    await microtasks()
    expect(h.session.state.get().playing).toBe(true)
    expect(last(h.bytes.starts).receipt?.key).toContain('第一段。')

    // 若在暂停期间合成正好落地，再次续播同样直接命中已存回执
    const h2 = makeHarness()
    const release2 = h2.holdSynth('第一段。')
    const started2 = start(h2)
    await microtasks()
    h2.session.pauseListening()
    release2()
    await started2
    await microtasks()
    h2.session.resumeListening()
    await microtasks()
    expect(h2.synthCalls.filter((c) => c.text === '第一段。'), '暂停期间落地的回执直接复用').toHaveLength(1)
    expect(h2.session.state.get().playing).toBe(true)
  })

  it('连续推进每段都触发下段出声槽预载；主播放等回执时不抢槽覆盖待播段', async () => {
    const h = makeHarness()
    h.fixture.texts[0] = ['p0。', 'p1。', 'p2。', 'p3。']
    h.setTtsDefaults({ prefetchParagraphs: 0 })
    await start(h)
    await microtasks()
    expect(h.bytes.preloads).toEqual(['k:builtin:baidu:1::p1。'])

    must(h.bytes.starts[0], 'p0').handlers.done()
    await microtasks()
    expect(h.bytes.preloads).toEqual([
      'k:builtin:baidu:1::p1。',
      'k:builtin:baidu:1::p2。',
    ])

    must(h.bytes.starts[1], 'p1').handlers.done()
    await microtasks()
    expect(h.bytes.preloads, 'p2 起每段都必须同步预载下一段').toEqual([
      'k:builtin:baidu:1::p1。',
      'k:builtin:baidu:1::p2。',
      'k:builtin:baidu:1::p3。',
    ])

    // 验证 synthToken !== null 时不抢槽：p0 等待 p1 期间如果 p2 先落地，p2 不得在 p1 起播前覆盖预载槽
    const h2 = makeHarness()
    h2.fixture.texts[0] = ['p0。', 'p1。', 'p2。']
    const releaseP1 = h2.holdSynth('p1。')
    const releaseP2 = h2.holdSynth('p2。')
    await start(h2)
    await microtasks()
    must(h2.bytes.starts[0], 'p0').handlers.done()
    await microtasks()
    // 此时 p1 仍在等待回执（synthToken !== null），先放行 p2
    releaseP2()
    await microtasks()
    expect(h2.bytes.preloads, '主播放等回执期间不得覆盖待播预载槽').toEqual([])

    releaseP1()
    await microtasks()
    expect(h2.bytes.preloads, 'p1 起播完成才预载 p2').toEqual(['k:builtin:baidu:1::p2。'])
  })

  it('跨章预取不自掐并完整交接：章末预载下章首段、在途第二段续跑、跳往他章才取消', async () => {
    const h = makeHarness()
    h.fixture.names = ['第一章', '第二章', '第三章']
    h.fixture.texts = [['a0。', 'a1。'], ['b0。', 'b1。', 'b2。'], ['c0。']]
    h.setTtsDefaults({ prefetchParagraphs: 2 })
    const releaseB1 = h.holdSynth('b1。')
    await start(h)
    await microtasks()
    // 仍在 a0（倒数第二段）：出声预载槽应先服务同章下一段 a1；同时下一章 b0 已暖好、b1 在途挂住
    expect(h.bytes.preloaded).toBe('k:builtin:baidu:1::a1。')
    expect(h.synthCalls.filter((c) => c.text === 'b0。')).toHaveLength(1)
    const b1Signal = must(h.synthSignals.get('b1。'), 'b1 预取信号')
    expect(b1Signal.aborted).toBe(false)

    // 推进到 a1（末段）：此时立即把已暖好的下章首段 b0 挂入出声预载槽
    must(h.bytes.starts[0], 'a0').handlers.done()
    await microtasks()
    expect(h.bytes.preloaded, '末段在播时即预载下章首段').toBe('k:builtin:baidu:1::b0。')
    const dropsBeforeCross = h.bytes.dropPreloadCount
    must(h.bytes.starts[1], 'a1').handlers.done()
    await microtasks(40)

    expect(h.session.state.get()).toMatchObject({ chapterIndex: 1, paragraphIndex: 0, playing: true })
    expect(b1Signal.aborted, '自动跨入目标章时在途 b1 不许被掐').toBe(false)
    expect(h.bytes.dropPreloadCount, '已预载的下章首段保留不作废').toBe(dropsBeforeCross)
    expect(h.synthCalls.filter((c) => c.text === 'b0。'), 'b0 不重复合成').toHaveLength(1)

    releaseB1()
    await microtasks(40)
    expect(h.synthCalls.filter((c) => c.text === 'b1。'), 'b1 不重复合成').toHaveLength(1)
    expect(h.bytes.preloads.at(-1), 'b1 完成后立即预载进槽').toBe('k:builtin:baidu:1::b1。')

    // 若跳往并非正在预取的目标章，则旧的 nextChapter 必须立即取消
    const hJump = makeHarness()
    hJump.fixture.names = ['第一章', '第二章', '第三章']
    hJump.fixture.texts = [['a0。'], ['b0。', 'b1。'], ['c0。']]
    hJump.setTtsDefaults({ prefetchParagraphs: 2 })
    const releaseJumpB0 = hJump.holdSynth('b0。')
    await start(hJump)
    await microtasks()
    const jumpB0Signal = must(hJump.synthSignals.get('b0。'), '第二章 b0 预取信号')
    await hJump.session.jumpToChapter(2)
    expect(jumpB0Signal.aborted, '跳到别的章时取消原下一章预取').toBe(true)
    releaseJumpB0()
  })

  it('跨章交接要求正文一致：目标章正文变了就作废旧预取、按新正文重取', async () => {
    const h = makeHarness()
    h.fixture.names = ['第一章', '第二章']
    h.fixture.texts = [['a0。', 'a1。'], ['b0。', 'b1。']]
    h.setTtsDefaults({ prefetchParagraphs: 2 })
    await start(h)
    await microtasks(40)
    const prefetchedB0 = must(h.synthSignals.get('b0。'), 'b0 预取信号')
    expect(prefetchedB0.aborted).toBe(false)

    // 预取落地后源侧正文变了：旧 receipts 属于旧正文，交接必须拒绝（`sameUnits` 是这条判据的唯一守卫）
    h.fixture.texts[1] = ['B0新。', 'B1新。']
    must(h.bytes.starts[0], 'a0').handlers.done()
    await microtasks(40)
    must(h.bytes.starts[1], 'a1').handlers.done()
    await microtasks(40)

    expect(h.session.state.get()).toMatchObject({ chapterIndex: 1, paragraphIndex: 0 })
    expect(prefetchedB0.aborted, '正文对不上：旧预取当场作废').toBe(true)
    expect(h.synthCalls.filter((c) => c.text === 'B0新。'), '按新正文重新合成').toHaveLength(1)
    expect(h.synthCalls.filter((c) => c.text === 'b0。'), '旧正文只发过预取那一发').toHaveLength(1)
    expect(h.bytes.starts.at(-1)?.receipt?.key, '起播用的是新正文的字节')
      .toBe('k:builtin:baidu:1::B0新。')
  })

  it('下一章预取段数改成 0：已发起的下一章预取当场作废，不等到下一次换章', async () => {
    const h = makeHarness()
    h.fixture.names = ['第一章', '第二章']
    h.fixture.texts = [['a0。', 'a1。'], ['b0。', 'b1。']]
    h.setTtsDefaults({ prefetchParagraphs: 2 })
    await start(h)
    await microtasks(40)
    const prefetchedB0 = must(h.synthSignals.get('b0。'), 'b0 预取信号')
    expect(prefetchedB0.aborted).toBe(false)

    h.setTtsDefaults({ prefetchParagraphs: 0 })
    must(h.bytes.starts[0], 'a0').handlers.done()
    await microtasks(40)
    expect(prefetchedB0.aborted, '0 档：已发起的下一章预取当场作废').toBe(true)

    must(h.bytes.starts[1], 'a1').handlers.done()
    await microtasks(40)
    expect(h.session.state.get()).toMatchObject({ chapterIndex: 1, paragraphIndex: 0 })
    expect(h.synthCalls.filter((c) => c.text === 'b0。'), '跨章按需重新合成').toHaveLength(2)
  })

  it('预取偶发失败不锁死且不在同段自旋：停留期间不重试，推进到下一段补预取成功', async () => {
    const h = makeHarness()
    h.fixture.texts[0] = ['p0。', 'p1。', 'p2。', 'p3。']
    h.setTtsDefaults({ prefetchParagraphs: 0 })
    h.failSynthOnce('p2。')
    await start(h)
    await microtasks(40)

    // p2 在 p0 期间失败一次，不应在 p0 期间死循环重发
    expect(h.synthCalls.filter((c) => c.text === 'p2。')).toHaveLength(1)

    // 推进到 p1：触发新一轮 pumpPrefetch，此时应补试 p2 并成功入槽
    must(h.bytes.starts[0], 'p0').handlers.done()
    await microtasks(40)
    expect(h.synthCalls.filter((c) => c.text === 'p2。'), '推进后补试失败的预取段').toHaveLength(2)
    expect(h.bytes.preloads.at(-1)).toBe('k:builtin:baidu:1::p2。')
  })

  it('同章自适应预取与并发上限：长段只预取 2 段，短对话延至 4 段且并发不超过 2', async () => {
    const longText = (prefix: string): string => `${prefix}${'这是一段长度超过四十字的正常小说正文内容用于测试。'.repeat(2)}`
    const hLong = makeHarness()
    hLong.fixture.texts[0] = [longText('L0'), longText('L1'), longText('L2'), longText('L3'), longText('L4')]
    hLong.setTtsDefaults({ prefetchParagraphs: 0 })
    await start(hLong)
    await microtasks(40)
    expect(hLong.synthCalls.map((c) => c.text)).toEqual([
      hLong.fixture.texts[0][0],
      hLong.fixture.texts[0][1],
      hLong.fixture.texts[0][2],
    ])

    const hShort = makeHarness()
    hShort.fixture.texts[0] = ['p0', 'p1', 'p2', 'p3', 'p4', 'p5']
    hShort.setTtsDefaults({ prefetchParagraphs: 0 })
    const r1 = hShort.holdSynth('p1')
    const r2 = hShort.holdSynth('p2')
    const r3 = hShort.holdSynth('p3')
    const r4 = hShort.holdSynth('p4')
    await start(hShort)
    await microtasks()
    // 并发上限为 2：先只发起紧邻的 p1、p2，p3/p4 排队等待
    expect(hShort.synthCalls.map((c) => c.text)).toEqual(['p0', 'p1', 'p2'])

    r1()
    await microtasks()
    expect(hShort.synthCalls.map((c) => c.text), '空出一个槽位后按升序补发 p3').toEqual(['p0', 'p1', 'p2', 'p3'])

    r2()
    await microtasks()
    expect(hShort.synthCalls.map((c) => c.text), '短句最多延至后 4 段（不含 p5）').toEqual(['p0', 'p1', 'p2', 'p3', 'p4'])

    r3()
    r4()
    await microtasks()
    expect(hShort.synthCalls.map((c) => c.text)).not.toContain('p5')
  })
})
