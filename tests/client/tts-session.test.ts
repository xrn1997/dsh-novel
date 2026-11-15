import { describe, expect, it, vi } from 'vitest'
import { BROWSER_TTS_ENGINE_ID, TTS_DEFAULTS } from '../../src/shared/wire.js'
import type { ListenState, SynthesisRequest } from '../../src/shared/wire.js'
import {
  ListenSession, PARAMS_RESTART_DEBOUNCE_MS, TTS_MAX_CONSECUTIVE_FAILURES,
} from '../../src/client/tts/listen-session.js'
import type { Debounced, ListenPlatform } from '../../src/client/tts/listen-session.js'
import { setReadingProbe } from '../../src/client/tts/reading-position.js'
import type {
  BytesListenOutput, BytesSegment, DirectListenOutput, OutputHandlers,
} from '../../src/client/tts/output-contract.js'
import { DirectOutput } from '../../src/client/tts/direct-output.js'
import type { DirectSpeechFace, PlatformUtterance } from '../../src/client/tts/direct-output.js'
import { last, must } from '../support/fixture.js'

/**
 * 听书会话的实例行为网：`new ListenSession(假平台 + 假输出)` 驱动，**不 stub 任何全局、
 * 不 mock `api.js`**——平台缝就是这台会话与外界的全部接触面，环境自建在这里根本够不着。
 *
 * 钉五件事：起播推进到下一段（位置落盘走平台注入的防抖，推轮子不等墙钟）；单段失败留痕
 * 跳过、连败到线暂停；参数变更作废旧回执并按新参数重取当前段；定时到点暂停；直出型开口
 * 无事件走兜底失败径（这一例用真 `DirectOutput` + 假 speech 面，兜底定时同样走平台计时）。
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

  /** 字节型假输出：只记账，出声与否由用例拨弄回调。缺省 `start` 立刻回报真开口（等价于
   *  `onplaying` 落地）；`failOnStart` = 每次都把「这一段没成」回报给会话（演音频 404 / 拒绝）。 */
  class FakeBytesOutput implements BytesListenOutput {
    starts: { seg: BytesSegment; handlers: OutputHandlers }[] = []
    preloaded: string | null = null
    heldKey: string | null = null
    pauseCount = 0
    stopCount = 0
    releaseCount = 0
    invalidateCount = 0
    volumes: number[] = []
    failOnStart = false

    start(seg: BytesSegment, handlers: OutputHandlers): void {
      this.starts.push({ seg, handlers })
      this.heldKey = seg.key
      if (this.failOnStart) handlers.fail()
      else handlers.start?.()
    }

    pause(): void { this.pauseCount += 1 }
    stop(): void { this.stopCount += 1; this.heldKey = null }
    release(): void { this.releaseCount += 1; this.heldKey = null }
    setVolume(volume: number): void { this.volumes.push(volume) }
    preload(key: string): void { this.preloaded = key }
    dropPreload(): void { this.preloaded = null }
    holds(key: string): boolean { return this.heldKey === key }
    invalidate(): void { this.invalidateCount += 1; this.heldKey = null; this.preloaded = null }
  }

  /** 直出型假输出（不用真适配器的用例里占位）。 */
  class FakeDirectOutput implements DirectListenOutput {
    start(): void { /* 占位 */ }
    pause(): void { /* 占位 */ }
    stop(): void { /* 占位 */ }
    release(): void { /* 占位 */ }
    setVolume(): void { /* 占位 */ }
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
    bytes: FakeBytesOutput
    outputs: ListenPlatform['outputs']
    saves: { bookKey: string; listen: ListenState }[]
    progressSaves: { bookKey: string; chapterIndex: number; offsetRatio: number }[]
    synthCalls: SynthesisRequest[]
    fixture: { names: string[]; texts: string[][] }
    failSynth: (text: string) => void
    /** 挂起某段的合成请求，返回放行函数（模拟合成在途的窗口）。 */
    holdSynth: (text: string) => () => void
    /** 挂起某章的正文拉取，返回放行函数（模拟章正文在途的窗口）。 */
    holdFetch: (index: number) => () => void
    /** 让某章的正文拉取直接失败（模拟换起播点时的网络抖动）。 */
    failFetch: (index: number) => void
    /** 挂起下一次「等平台语音表」，返回放行函数（模拟直出源起播在途的窗口）。 */
    holdVoices: () => (ready: boolean) => void
  }

  function makeHarness(): Harness {
    const clock = new FakeClock()
    const after = (ms: number, cb: () => void): (() => void) => clock.after(ms, cb)
    const speech = makeFakeSpeech()
    const bytes = new FakeBytesOutput()
    const outputs: ListenPlatform['outputs'] = { bytes, direct: new FakeDirectOutput() }
    const fixture = {
      names: ['第一章', '第二章'],
      texts: [['第一段。', '第二段。', '第三段。'], ['第二章第一段。']],
    }
    const saves: Harness['saves'] = []
    const progressSaves: Harness['progressSaves'] = []
    const synthCalls: SynthesisRequest[] = []
    const failing = new Set<string>()
    const holds = new Map<string, Promise<void>>()
    const fetchHolds = new Map<number, Promise<void>>()
    const fetchFailures = new Set<number>()
    let voiceHold: Promise<boolean> | null = null
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
      synthesize: async (req) => {
        synthCalls.push(req)
        const hold = holds.get(req.text)
        if (hold !== undefined) await hold
        if (failing.has(req.text)) throw new Error('synth 说这一段不成')
        return { key: `k:${req.engineId}:${req.rate}:${req.voice ?? ''}:${req.text}`, mediaType: 'audio/mpeg' }
      },
      outputs,
      awaitDirectVoices: async () => {
        const held = voiceHold
        voiceHold = null
        if (held !== null) return held
        return speech.face.voices().length > 0
      },
      now: () => clock.now,
      after,
      watchPageHide: () => () => { /* 假平台不挂宿主事件 */ },
      debounce: <A extends unknown[]>(fn: (...args: A) => void, ms: number): Debounced<A> => fakeDebounce(clock, fn, ms),
    }
    return {
      session: new ListenSession(platform),
      clock, speech, bytes, outputs, saves, progressSaves, synthCalls, fixture,
      failSynth: (text) => { failing.add(text) },
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

  it('起播推进到下一段；位置落盘走平台注入的防抖，推轮子即落、不等墙钟', async () => {
    const h = makeHarness()
    await start(h)
    expect(h.session.state.get()).toMatchObject({
      active: true, chapterIndex: 0, chapterName: '第一章',
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

  it('单段失败留痕并跳过；连败到 TTS_MAX_CONSECUTIVE_FAILURES 即暂停', async () => {
    const h = makeHarness()
    h.fixture.texts[0] = ['p0。', 'p1。', 'p2。', 'p3。', 'p4。', 'p5。']
    for (const text of must(h.fixture.texts[0], '六段')) h.failSynth(text)
    await start(h)
    await vi.waitFor(() => {
      expect(h.session.state.get().consecutiveFailures).toBe(TTS_MAX_CONSECUTIVE_FAILURES)
    })
    const st = h.session.state.get()
    expect(st.failedParagraphs).toEqual([0, 1, 2, 3, 4])
    expect(st.paragraphIndex, '到线停在最后一段，不再往下跳').toBe(4)
    expect(st.playing).toBe(false)
    expect(h.bytes.starts, '一次都没出声').toHaveLength(0)
  })

  it('参数变更作废旧回执：当前段按新引擎重新合成、按新键起播', async () => {
    const h = makeHarness()
    await start(h)
    const oldKey = must(h.bytes.starts[0], '首段').seg.key
    expect(h.synthCalls.filter((c) => c.text === '第一段。').map((c) => c.engineId))
      .toEqual([TTS_DEFAULTS.engineId])

    await h.session.setListenEngine('http:other')
    await microtasks()
    expect(h.synthCalls.filter((c) => c.text === '第一段。').map((c) => c.engineId))
      .toEqual([TTS_DEFAULTS.engineId, 'http:other'])
    const replay = last(h.bytes.starts)
    expect(replay.seg.key, '旧键作废，新引擎的新键才起播').not.toBe(oldKey)
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
    expect(seg.seg.volume, '起播音量在守卫后活读：入口快照会把刚拖到的值盖回去').toBe(0.42)
    expect(h.session.state.get().volume).toBe(0.42)
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
    h.outputs.direct = new DirectOutput(h.speech.face, (ms, cb) => h.clock.after(ms, cb))
    await h.session.startListening({
      sourceId: 's1', bookKey: 'b1', title: '书一', chapterIndex: 0, paragraphIndex: 0,
      engineId: BROWSER_TTS_ENGINE_ID,
    })
    const before = h.session.state.get()
    expect(before).toMatchObject({ mode: 'direct', loading: true, playing: false })
    expect(h.speech.speaks, '交出去了，事件一个都不来').toBe(1)

    h.clock.advance(2000)
    const st = h.session.state.get()
    expect(st.failedParagraphs, '被吞的那一段要留痕').toEqual([0])
    expect(st.paragraphIndex, '留痕后推进').toBe(1)
    expect(st.consecutiveFailures).toBe(1)
    expect(st.playing).toBe(false)

    // 迟到的开口事件撞在旧发上：不推进也不二次留痕
    must(h.speech.handlers[0], '首段的事件面').onEnd()
    expect(h.session.state.get()).toMatchObject({ paragraphIndex: 1, failedParagraphs: [0] })
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
    expect(st.failedParagraphs, '五段各记一次失败').toEqual([0, 1, 2, 3, 4])
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
    h.fixture.texts[0] = ['A0。', 'A1。', 'A2。', 'A3。', 'A4。']
    h.fixture.texts[1] = ['B0。', 'B1。', 'B2。', 'B3。', 'B4。']
    await start(h)                              // 第一章 A0 起播（预取只暖 A1/A2）
    const release = h.holdSynth('A3。')          // 挂起第一章 index3 的合成（预取窗外）
    h.session.seekParagraph(3)
    await microtasks()
    expect(h.session.state.get().loading, '第一章 A3 合成在途').toBe(true)

    void h.session.jumpToChapter(1)                  // 跳第二章：清 receipts、起播 B0
    await microtasks()
    expect(h.session.state.get()).toMatchObject({ chapterIndex: 1, paragraphIndex: 0 })
    expect(last(h.bytes.starts).seg.key).toContain('B0。')

    release()                                   // 旧章 index3 的合成迟到落地
    await microtasks()

    h.session.seekParagraph(3)                  // 第二章 index3 应合成 B3，不命中旧章回执
    await microtasks()
    expect(last(h.bytes.starts).seg.key, '旧章回执不得污染新章同号段').toContain('B3。')
  })

  it('字节型换段即归零段进度：合成在途也不把上一段比例投到新段', async () => {
    const h = makeHarness()
    h.fixture.texts[0] = ['p0。', 'p1。', 'p2。', 'p3。', 'p4。']
    await start(h)
    const progress = must(h.bytes.starts[0], '首段').handlers.progress
    must(progress, '进度事件面')(3, 10)   // 首段已出声一会儿
    expect(h.session.progress.get()).toEqual({ position: 3, duration: 10 })

    const release = h.holdSynth('p3。')          // p3 在预取窗外（只暖 p1/p2）
    h.session.seekParagraph(3)                   // 跳到 p3，合成在途
    await microtasks()
    expect(h.session.state.get()).toMatchObject({ paragraphIndex: 3, loading: true })
    expect(h.session.progress.get(), '换段即归零，不等合成落地').toEqual({ position: 0, duration: 0 })
    release()
    await microtasks()
  })

  it('合成在途照跳、章正文在途不接：`loading` 与 `chapterLoading` 是两件事', async () => {
    const h = makeHarness()
    h.fixture.texts[0] = ['p0。', 'p1。', 'p2。', 'p3。']
    await start(h)
    const releaseSynth = h.holdSynth('p3。')     // p3 在预取窗外（只暖 p1/p2）
    h.session.seekParagraph(3)
    await microtasks()
    expect(h.session.state.get()).toMatchObject({
      paragraphIndex: 3, loading: true, chapterLoading: false,
    })

    // 合成在途窗口里再跳一次照跳：playSeq 会把在途那一发作废，不该按了没反应
    h.session.seekParagraph(2)
    await microtasks()
    expect(h.session.state.get().paragraphIndex, '合成在途不吞跳段').toBe(2)

    // 章正文在途：段域还是上一章的读数，跳段 / 滑杆都不接
    const releaseFetch = h.holdFetch(1)
    const jumping = h.session.jumpToChapter(1)
    await microtasks()
    expect(h.session.state.get().chapterLoading, '章正文在途').toBe(true)
    h.session.seekParagraph(0)
    await h.session.skipParagraph(1)
    expect(h.session.state.get().paragraphIndex, '章正文在途不接跳段').toBe(2)

    releaseFetch()
    await jumping
    await microtasks()
    expect(h.session.state.get()).toMatchObject({ chapterIndex: 1, chapterLoading: false })
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
    expect(h.session.state.get()).toMatchObject({ chapterIndex: 0, chapterLoading: true })

    h.session.pauseListening()                      // 载入在途按暂停
    expect(h.session.state.get()).toMatchObject({ playing: false, loading: false, chapterLoading: true })
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
      chapterIndex: 1, paragraphIndex: 0, playing: false, loading: false, chapterLoading: false,
    })
    // 暂停期间不自动起播新章：只数「出声」——下一章的预取（暖缓存）不受暂停影响，不算播放
    expect(h.bytes.starts.every((s) => !s.seg.key.includes('第二章第一段。')), '暂停期间不自动起播新章').toBe(true)

    h.session.resumeListening()                     // 载入收口之后这一次才有效
    await microtasks()
    expect(last(h.bytes.starts).seg.key).toContain('第二章第一段。')
    expect(h.session.state.get()).toMatchObject({ chapterIndex: 1, playing: true })
  })

  it('换起播点先取数后停旧会话：正文拉不到时旧会话照常放着', async () => {
    const h = makeHarness()
    await start(h)
    const oldKey = last(h.bytes.starts).seg.key
    const oldStarts = h.bytes.starts.length
    h.failFetch(1)

    await expect(h.session.startListening({
      sourceId: 's1', bookKey: 'b1', title: '书一', chapterIndex: 1, paragraphIndex: 0,
    })).rejects.toThrow()

    expect(h.session.state.get(), '旧会话没被停掉').toMatchObject({
      active: true, chapterIndex: 0, playing: true,
    })
    expect(h.bytes.starts.length, '没有多起一段').toBe(oldStarts)
    expect(last(h.bytes.starts).seg.key).toBe(oldKey)
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
})
