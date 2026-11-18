// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ROUTES, TTS_DEFAULTS, ttsAudioUrl } from '../../src/shared/wire.js'
import type { RouteTarget, ShelfEntry, WriteMethod } from '../../src/shared/wire.js'
import { apiGet, apiSend } from '../../src/client/api.js'
import { resetPanelShelf } from '../../src/client/panel-shelf.js'
import {
  TTS_MAX_CONSECUTIVE_FAILURES,
  browserTtsVoices,
  awaitDirectVoices,
  DIRECT_VOICES_WAIT_MS,
  pauseListening,
  resetTtsPlayer,
  resumeListening,
  setListenEngine,
  setListenTimer,
  skipChapter,
  skipParagraph,
  startListening,
  stopListening,
  ttsPlayer,
} from '../../src/client/tts/player.js'
import type { StartListeningInput } from '../../src/client/tts/player.js'

/**
 * 浏览器直出型分支的行为网：真播放层 + mock 掉 `/novel-api`、`Audio` 与 `speechSynthesis`。
 *
 * 假的 `speechSynthesis` 只演播放层消费的那一面：`getVoices` / `speak` / `cancel`；`cancel`
 * 会像真浏览器那样给在播 utterance 补一发 `canceled` 错误。自撤（暂停/跳段/换引擎）的补发
 * 事件靠播放代际（`playSeq`）作废；带活 token 的 `canceled` / `interrupted` 是平台侧中断，
 * 走失败径。两面都各有用例钉住。
 */
vi.mock('../../src/client/api.js', () => ({
  apiGet: vi.fn(),
  apiSend: vi.fn(),
}))

class FakeAudio {
  static instances: FakeAudio[] = []
  src = ''
  volume = 1
  preload = ''
  paused = true
  currentTime = 0
  onended: (() => void) | null = null
  onplaying: (() => void) | null = null
  constructor() { FakeAudio.instances.push(this) }
  play = vi.fn(async () => { this.paused = false; this.onplaying?.() })
  pause = vi.fn(() => { this.paused = true })
  /** 停播时播放层会摘 src 松开缓冲（`removeAttribute` + `load` 那一对，不是赋空串） */
  removeAttribute = vi.fn()
  load = vi.fn()
}

class FakeVoice {
  readonly voiceURI: string
  readonly name: string
  /** 真平台每支音色都带语区（`zh-CN` / `en-US` 这类）：音色行的可读性靠它，替身不演就量不到。 */
  readonly lang: string
  constructor(voiceURI: string, name: string, lang = 'zh-CN') {
    this.voiceURI = voiceURI
    this.name = name
    this.lang = lang
  }
}

class FakeUtterance {
  static instances: FakeUtterance[] = []
  readonly text: string
  voice: FakeVoice | null = null
  rate = 1
  volume = 1
  onstart: (() => void) | null = null
  onend: (() => void) | null = null
  onerror: ((event: { error: string }) => void) | null = null
  constructor(text: string) {
    this.text = text
    FakeUtterance.instances.push(this)
  }
}

class FakeSpeechSynthesis {
  voices: FakeVoice[] = []
  active: FakeUtterance | null = null
  /** 真平台的自报读数：开口兜底问的就是这两个（慢 ≠ 没开口）。 */
  speaking = false
  pending = false
  private readonly voicesChanged = new Set<() => void>()
  getVoices = vi.fn((): FakeVoice[] => this.voices)
  speak = vi.fn((utterance: FakeUtterance): void => { this.active = utterance; this.speaking = true })
  cancel = vi.fn((): void => {
    const active = this.active
    this.active = null
    this.speaking = false
    active?.onerror?.({ error: 'canceled' })
  })
  addEventListener = vi.fn((type: string, listener: () => void): void => {
    if (type === 'voiceschanged') this.voicesChanged.add(listener)
  })
  removeEventListener = vi.fn((type: string, listener: () => void): void => {
    if (type === 'voiceschanged') this.voicesChanged.delete(listener)
  })
  /** 像真平台那样广播「语音表变了」：等待中的 `awaitDirectVoices` 靠这一发收口。 */
  emitVoicesChanged(): void {
    for (const listener of [...this.voicesChanged]) listener()
  }
}

interface Fixture {
  names: string[]
  texts: string[][]
}

let fixture: Fixture
let synth: FakeSpeechSynthesis
let synthKeys: Map<string, string>
let synthCount: number
let shelfReads: ShelfEntry[]
/** 非空时，读第二章正文要先等它放行（用来把「上一模式在途的预取」停在切换之前）。 */
let chapterGate: Promise<void> | null

function must<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) throw new Error(`missing ${what}`)
  return value
}

function indexOfPath(path: string): number {
  const m = /[?&]index=(\d+)/.exec(path)
  return m === null ? 0 : Number(m[1])
}

function textOf(body: unknown): string {
  const record = body as { text?: unknown } | null
  return typeof record?.text === 'string' ? record.text : ''
}

interface SynthCall { text: string; engineId: string }

function synthCalls(): SynthCall[] {
  const send = vi.mocked(apiSend)
  return send.mock.calls
    .filter(([target]) => target.path === ROUTES.ttsSynthesize.path)
    .map(([, body]) => {
      const record = (body ?? {}) as Record<string, unknown>
      return {
        text: typeof record.text === 'string' ? record.text : '',
        engineId: typeof record.engineId === 'string' ? record.engineId : '',
      }
    })
}

function shelfPuts(): Record<string, unknown>[] {
  const send = vi.mocked(apiSend)
  return send.mock.calls
    .filter(([target]) => target.path.startsWith('shelf/'))
    .map(([, body]) => (body ?? {}) as Record<string, unknown>)
}

function lastListen(): Record<string, unknown> {
  const put = must(
    [...shelfPuts()].reverse().find((body) => 'listen' in body), 'shelfPut listen',
  )
  return must(put.listen, 'listen') as Record<string, unknown>
}

function playingAudio(): FakeAudio | null {
  return FakeAudio.instances.find((a) => !a.paused) ?? null
}

async function microtasks(count = 30): Promise<void> {
  for (let i = 0; i < count; i += 1) await Promise.resolve()
}

function start(over: Partial<StartListeningInput> = {}): Promise<void> {
  return startListening({
    sourceId: 's1', bookKey: 'b1', title: '书一', chapterIndex: 0, paragraphIndex: 0,
    ...over,
  })
}

function startDirect(over: Partial<StartListeningInput> = {}): Promise<void> {
  return start({ engineId: 'browser:local', ...over })
}

/** 最新一段交给浏览器的 utterance（生成顺序即播放顺序）。 */
function lastUtterance(): FakeUtterance {
  return must(FakeUtterance.instances.at(-1), 'utterance')
}

function speakNow(): void {
  lastUtterance().onstart?.()
}

beforeEach(() => {
  resetTtsPlayer()
  resetPanelShelf()
  FakeAudio.instances = []
  FakeUtterance.instances = []
  vi.stubGlobal('Audio', FakeAudio)
  synth = new FakeSpeechSynthesis()
  synth.voices = [new FakeVoice('v1', '甲声'), new FakeVoice('v2', '乙声')]
  vi.stubGlobal('speechSynthesis', synth)
  vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance)
  vi.clearAllMocks()
  fixture = {
    names: ['第一章', '第二章'],
    texts: [['第一段。', '第二段。', '第三段。'], ['第二章第一段。', '第二章第二段。']],
  }
  synthKeys = new Map()
  synthCount = 0
  shelfReads = []
  chapterGate = null

  vi.mocked(apiGet).mockImplementation(async (path: string) => {
    if (path.startsWith('navigation')) {
      return {
        chapters: fixture.names.map((name, i) => ({ name, url: `u${i}` })),
        items: [],
      }
    }
    if (path.startsWith('chapter')) {
      const index = indexOfPath(path)
      if (index === 1 && chapterGate !== null) await chapterGate
      return { kind: 'text', text: must(fixture.texts[index], `chapter ${index}`).join('\n') }
    }
    if (path === ROUTES.shelf.path) return shelfReads
    throw new Error(`unexpected GET ${path}`)
  })
  vi.mocked(apiSend).mockImplementation(async (target: RouteTarget<WriteMethod>, body?: unknown) => {
    if (target.path === ROUTES.ttsSynthesize.path) {
      const text = textOf(body)
      let key = synthKeys.get(text)
      if (key === undefined) {
        synthCount += 1
        key = `k${synthCount}`
        synthKeys.set(text, key)
      }
      return { key, mediaType: 'audio/mpeg' }
    }
    if (target.path.startsWith('shelf/')) return {}
    throw new Error(`unexpected ${target.method} ${target.path}`)
  })
})

describe('直出型引擎：起播与 utterance 映射', () => {
  it('browser:local 起播 → mode=direct；零合成请求、零 Audio、逐段交给浏览器', async () => {
    await startDirect()
    const st = ttsPlayer.get()
    expect(st.active).toBe(true)
    expect(st.mode).toBe('direct')
    expect(st.engineId).toBe('browser:local')
    expect(st.paragraphIndex).toBe(0)
    expect(st.playing).toBe(false)
    expect(st.loading).toBe(true)
    expect(synthCalls()).toHaveLength(0)
    expect(FakeAudio.instances).toHaveLength(0)
    expect(synth.speak).toHaveBeenCalledTimes(1)
    expect(lastUtterance().text).toBe('第一段。')
  })

  it('utterance 参数映射：文本、按 voiceURI 选中的音色、语速、音量', async () => {
    await startDirect({ voice: 'v2', rate: 1.5, volume: 0.35 })
    const utterance = lastUtterance()
    expect(utterance.text).toBe('第一段。')
    expect(utterance.voice).toBe(synth.voices[1])
    expect(utterance.rate).toBe(1.5)
    expect(utterance.volume).toBe(0.35)
  })

  it('会话没选音色、或所选 id 不在浏览器音色表 → 回浏览器缺省（voice 不设）', async () => {
    await startDirect({ voice: null })
    expect(lastUtterance().voice).toBeNull()
    await startDirect({ voice: 'not-a-browser-voice' })
    expect(lastUtterance().voice).toBeNull()
  })

  /** 音色行的可读性在投影里就定掉：带语区、按 voiceURI 去重。
   *  去重不是美化——`voiceOf` 按 id 只取第一支，同 id 的第二行在界面上选得中却永远命中第一支。 */
  it('browserTtsVoices 投成 {id: voiceURI, name, lang}，并按 voiceURI 去重', () => {
    synth.voices = [
      new FakeVoice('v1', '甲声', 'zh-CN'),
      new FakeVoice('v2', '乙声', 'en-US'),
      new FakeVoice('v2', '乙声（远端）', 'en-GB'),
    ]
    expect(browserTtsVoices()).toEqual([
      { id: 'v1', name: '甲声', lang: 'zh-CN' },
      { id: 'v2', name: '乙声', lang: 'en-US' },
    ])
  })

  it('换到「这台设备没有可用音色」的直出源：等过语音表才拒，选择不生效', async () => {
    await start({ engineId: 'builtin:baidu' })
    synth.voices = []
    // 平台交表了，表是空的（真机上 voiceschanged 已发过）——这时才该判「没有语音」
    setTimeout(() => { synth.emitVoicesChanged() }, 10)
    await expect(setListenEngine('browser:local')).rejects.toMatchObject({ code: 'TTS_NO_VOICES' })
    // 源级的事实按源级半径报：不能留给逐段尝试（那会连跳五段再无声暂停，一句人话都出不来）
    expect(ttsPlayer.get()).toMatchObject({ engineId: 'builtin:baidu', mode: 'bytes' })
  })

  it('开口事件一个都不来（Chromium 吞 speak）：兜底把 loading 收口并记一次段失败', async () => {
    vi.useFakeTimers()
    try {
      await startDirect()
      expect(ttsPlayer.get().loading).toBe(true)
      // 平台自报没在念、队列也空，事件却一个都没落地
      synth.speaking = false
      synth.pending = false
      await vi.advanceTimersByTimeAsync(2000)
      const st = ttsPlayer.get()
      // 会话没有停在「这一句永远没开口」上：留痕、推进，读数也不再假装在放
      expect(st.halt, '一次失败不到阈值：不公布停因').toBeNull()
      expect(st.paragraphIndex, '失败的那一段留痕后推进').toBe(1)
      expect(st.playing).toBe(false)
      expect(st.consecutiveFailures).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('兜底不抢慢平台的活：平台自报还在念 / 队列还有活 → 不动读数，等它的事件', async () => {
    vi.useFakeTimers()
    try {
      await startDirect()
      synth.speaking = true
      await vi.advanceTimersByTimeAsync(2000)
      expect(ttsPlayer.get().loading).toBe(true)
      expect(ttsPlayer.get().halt).toBeNull()
      synth.speaking = false
      lastUtterance().onstart?.()
      expect(ttsPlayer.get().playing).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('onstart 记段并清零连败；onend 推进段并按 listen + progress 落盘', async () => {
    await startDirect()
    speakNow()
    expect(ttsPlayer.get()).toMatchObject({
      paragraphIndex: 0, playing: true, loading: false, consecutiveFailures: 0,
    })

    lastUtterance().onend?.()
    await microtasks()
    expect(ttsPlayer.get().paragraphIndex).toBe(1)
    expect(lastUtterance().text).toBe('第二段。')
    expect(synth.speak).toHaveBeenCalledTimes(2)

    speakNow()
    pauseListening()
    expect(ttsPlayer.get().playing).toBe(false)
    const puts = shelfPuts()
    expect(puts.some((body) => 'listen' in body)).toBe(true)
    expect(puts.filter((body) => 'progress' in body).at(-1)?.progress).toEqual({
      chapterIndex: 0, offsetRatio: 0.5,
    })
    expect(lastListen()).toMatchObject({
      engineId: 'browser:local', paragraphIndex: 1, rate: TTS_DEFAULTS.rate,
      voice: null, volume: TTS_DEFAULTS.volume,
    })
  })

  it('直出型不预取：进末段也不读下一章正文、不发合成请求', async () => {
    fixture = { names: ['第一章', '第二章'], texts: [['p0。', 'p1。', 'p2。', 'p3。'], ['n0。']] }
    await startDirect({ paragraphIndex: 1 })
    speakNow()
    lastUtterance().onend?.()
    await microtasks(50)
    expect(synthCalls()).toHaveLength(0)
    const chapterReads = vi.mocked(apiGet).mock.calls
      .filter(([path]) => path.startsWith('chapter'))
      .map(([path]) => indexOfPath(path))
    expect(chapterReads).toEqual([0])
  })
})

describe('直出型引擎：失败半径与结构化错误', () => {
  it('utterance.onerror 走同一失败径：跳过该段；下一段开口清零连败', async () => {
    await startDirect()
    speakNow()
    lastUtterance().onerror?.({ error: 'synthesis-failed' })
    await microtasks()
    expect(ttsPlayer.get()).toMatchObject({
      halt: null, paragraphIndex: 1, consecutiveFailures: 1, playing: false,
    })
    expect(lastUtterance().text).toBe('第二段。')
    speakNow()
    expect(ttsPlayer.get().consecutiveFailures).toBe(0)
  })

  it(`连续 ${TTS_MAX_CONSECUTIVE_FAILURES} 段 utterance 失败即暂停（不再往下开口）`, async () => {
    fixture = {
      names: ['第一章'],
      texts: [['p0。', 'p1。', 'p2。', 'p3。', 'p4。', 'p5。']],
    }
    await startDirect()
    for (let i = 0; i < TTS_MAX_CONSECUTIVE_FAILURES; i += 1) {
      lastUtterance().onerror?.({ error: 'synthesis-failed' })
      await microtasks(5)
    }
    const st = ttsPlayer.get()
    expect(st.consecutiveFailures).toBe(TTS_MAX_CONSECUTIVE_FAILURES)
    expect(st.halt, '到线暂停要公布停因与次数').toEqual({
      reason: 'consecutive-failures', failures: TTS_MAX_CONSECUTIVE_FAILURES,
    })
    expect(st.paragraphIndex).toBe(4)
    expect(st.playing).toBe(false)
    expect(FakeUtterance.instances).toHaveLength(TTS_MAX_CONSECUTIVE_FAILURES)
    expect(synthCalls()).toHaveLength(0)
  })

  it.each(['interrupted', 'canceled'])(
    '平台侧中断（%s）落在仍持活 token 的段上：走失败径记痕并跳过，不留假播放',
    async (reason) => {
      await startDirect()
      speakNow()
      expect(ttsPlayer.get().playing).toBe(true)
      lastUtterance().onerror?.({ error: reason })
      await microtasks()
      expect(ttsPlayer.get()).toMatchObject({
        halt: null, paragraphIndex: 1, consecutiveFailures: 1, playing: false,
      })
      expect(lastUtterance().text).toBe('第二段。')
      expect(synth.speak).toHaveBeenCalledTimes(2)
    },
  )

  it('开口事件被吞的 onend 照样推进：不把会话永远挂在 loading 上', async () => {
    await startDirect()
    expect(ttsPlayer.get()).toMatchObject({ paragraphIndex: 0, playing: false, loading: true })
    lastUtterance().onend?.()
    await microtasks()
    expect(ttsPlayer.get().paragraphIndex).toBe(1)
    expect(lastUtterance().text).toBe('第二段。')
    expect(synth.speak).toHaveBeenCalledTimes(2)
  })

  it('自撤补发的 canceled 撞在旧 token 上：暂停与跳段都不记失败', async () => {
    await startDirect()
    speakNow()
    pauseListening()
    expect(ttsPlayer.get()).toMatchObject({
      halt: null, consecutiveFailures: 0, paragraphIndex: 0,
    })
    resumeListening()
    await microtasks()
    speakNow()
    void skipParagraph(1)
    await microtasks()
    expect(ttsPlayer.get()).toMatchObject({
      paragraphIndex: 1, halt: null, consecutiveFailures: 0,
    })
    expect(lastUtterance().text).toBe('第二段。')
  })

  it('getVoices() 等过语音表仍为空 → startListening reject（code 与 message 都只放码）', async () => {
    synth.voices = []
    setTimeout(() => { synth.emitVoicesChanged() }, 10)
    await expect(startDirect()).rejects.toMatchObject({
      name: 'TtsPlayerError',
      code: 'TTS_NO_VOICES',
      message: 'TTS_NO_VOICES',
    })
    expect(ttsPlayer.get().active).toBe(false)
    expect(synth.speak).not.toHaveBeenCalled()
    expect(synthCalls()).toHaveLength(0)
  })

  it('语音表迟到（首读为空、voiceschanged 才给）→ 起播等这一拍，不误报设备没有语音', async () => {
    synth.voices = []
    setTimeout(() => {
      synth.voices = [new FakeVoice('v1', '甲声')]
      synth.emitVoicesChanged()
    }, 10)
    await startDirect()
    expect(ttsPlayer.get()).toMatchObject({ active: true, mode: 'direct', engineId: 'browser:local' })
    expect(synth.speak).toHaveBeenCalledTimes(1)
    expect(lastUtterance().text).toBe('第一段。')
  })

  it('等语音表到点仍为空 → false（不把起播永远挂住）', async () => {
    synth.voices = []
    vi.useFakeTimers()
    try {
      const waiting = awaitDirectVoices()
      await vi.advanceTimersByTimeAsync(DIRECT_VOICES_WAIT_MS)
      await expect(waiting).resolves.toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('平台没有 speechSynthesis 同样抛 TTS_NO_VOICES', async () => {
    vi.stubGlobal('speechSynthesis', undefined)
    await expect(startDirect()).rejects.toMatchObject({ code: 'TTS_NO_VOICES' })
    expect(ttsPlayer.get().active).toBe(false)
  })
})

describe('直出型引擎：暂停/继续/跳段/定时/停止', () => {
  it('pause 取消 utterance（不是暂停队列）、playing 置假并立即落盘', async () => {
    await startDirect()
    speakNow()
    pauseListening()
    expect(synth.cancel).toHaveBeenCalled()
    expect(ttsPlayer.get()).toMatchObject({ playing: false, loading: false, paragraphIndex: 0 })
    expect(lastListen()).toMatchObject({ paragraphIndex: 0 })
  })

  it('resume 从当前段开头重新开口：不换段、不合成', async () => {
    await startDirect()
    speakNow()
    pauseListening()
    const before = synth.speak.mock.calls.length
    resumeListening()
    await microtasks()
    expect(ttsPlayer.get()).toMatchObject({ paragraphIndex: 0, playing: false, loading: true })
    expect(synth.speak.mock.calls.length).toBe(before + 1)
    expect(lastUtterance().text).toBe('第一段。')
    speakNow()
    expect(ttsPlayer.get()).toMatchObject({ playing: true, paragraphIndex: 0 })
    expect(synthCalls()).toHaveLength(0)
  })

  it('skipParagraph 取消当前 utterance 并开口新段', async () => {
    await startDirect()
    speakNow()
    void skipParagraph(1)
    await microtasks()
    expect(ttsPlayer.get().paragraphIndex).toBe(1)
    expect(lastUtterance().text).toBe('第二段。')
    expect(synth.speak).toHaveBeenCalledTimes(2)
    expect(synthCalls()).toHaveLength(0)
  })

  it('skipChapter 先撤掉当前 utterance，等新章正文回来再开口', async () => {
    let release: (() => void) | null = null
    chapterGate = new Promise<void>((resolve) => { release = resolve })
    await startDirect()
    speakNow()
    void skipChapter(1)
    expect(synth.cancel).toHaveBeenCalled()
    expect(ttsPlayer.get()).toMatchObject({ playing: false, loading: true })
    must<() => void>(release, 'gate release')()
    await microtasks(50)
    expect(ttsPlayer.get().chapterIndex).toBe(1)
    expect(lastUtterance().text).toBe('第二章第一段。')
    expect(synthCalls()).toHaveLength(0)
  })

  it('定时到点暂停并取消在播 utterance', async () => {
    vi.useFakeTimers()
    try {
      await startDirect()
      speakNow()
      setListenTimer(1)
      vi.advanceTimersByTime(60_000)
      expect(ttsPlayer.get()).toMatchObject({ playing: false, timerEndAt: null })
      expect(synth.cancel).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stop 取消在播 utterance、整份复位（保留引擎选择）', async () => {
    await startDirect()
    speakNow()
    stopListening()
    expect(synth.cancel).toHaveBeenCalled()
    expect(ttsPlayer.get()).toMatchObject({
      active: false, playing: false, engineId: 'browser:local', mode: 'direct',
    })
  })

  it('直出型全程位置落盘写 listen 与 progress 两笔', async () => {
    await startDirect()
    speakNow()
    lastUtterance().onend?.()
    await microtasks()
    speakNow()
    void skipParagraph(1)
    await microtasks()
    pauseListening()

    const puts = shelfPuts()
    const listens = puts.filter((put) => 'listen' in put)
    const progresses = puts.filter((put) => 'progress' in put)
    expect(listens.length).toBeGreaterThan(0)
    expect(progresses, '每一笔位置落盘都同时写共用位置').toHaveLength(listens.length)
    for (const put of puts) {
      expect(Object.keys(put)).toHaveLength(1)
    }
    for (const put of listens) {
      const listen = must(put.listen, 'listen') as Record<string, unknown>
      expect(Object.keys(listen).sort()).toEqual(
        ['chapterIndex', 'engineId', 'paragraphIndex', 'rate', 'voice', 'volume'],
      )
      expect(listen.engineId).toBe('browser:local')
    }
    for (const put of progresses) {
      const progress = put.progress as Record<string, unknown>
      expect(Object.keys(progress).sort()).toEqual(['chapterIndex', 'offsetRatio'])
    }
  })
})

describe('直出型引擎：字节↔直出切换', () => {
  beforeEach(() => {
    fixture = { names: ['第一章'], texts: [['唯一段。']] }
  })

  it('bytes→direct：停 Audio、当前段改由 utterance 出声，零新增合成', async () => {
    await start()
    await microtasks()
    expect(ttsPlayer.get().mode).toBe('bytes')
    expect(playingAudio()).not.toBeNull()
    expect(synthCalls()).toHaveLength(1)

    await setListenEngine('browser:local')
    await microtasks()
    const st = ttsPlayer.get()
    expect(st.mode).toBe('direct')
    expect(st.paragraphIndex).toBe(0)
    expect(st.halt).toBeNull()
    expect(st.consecutiveFailures).toBe(0)
    expect(playingAudio()).toBeNull()
    expect(lastUtterance().text).toBe('唯一段。')
    expect(synthCalls()).toHaveLength(1)
    speakNow()
    expect(ttsPlayer.get().playing).toBe(true)
  })

  it('direct→bytes：取消 utterance、当前段重新合成起播，位置与失败计数不被破坏', async () => {
    await startDirect()
    speakNow()
    expect(ttsPlayer.get().playing).toBe(true)

    await setListenEngine(TTS_DEFAULTS.engineId)
    await microtasks()
    const st = ttsPlayer.get()
    expect(st.mode).toBe('bytes')
    expect(st.engineId).toBe(TTS_DEFAULTS.engineId)
    expect(st.paragraphIndex).toBe(0)
    expect(st.halt).toBeNull()
    expect(st.consecutiveFailures).toBe(0)
    expect(synth.cancel).toHaveBeenCalled()
    expect(synthCalls().map((c) => c.text)).toEqual(['唯一段。'])
    expect(playingAudio()).not.toBeNull()
    expect(must(playingAudio(), 'audio').src).toBe(ttsAudioUrl(must(synthKeys.get('唯一段。'), 'key')))
  })

  it('开口前的 onstart 还没回来就换引擎：旧 utterance 被撤、当前段按新模式重起', async () => {
    await startDirect()
    expect(ttsPlayer.get().playing).toBe(false)
    await setListenEngine(TTS_DEFAULTS.engineId)
    await microtasks()
    const st = ttsPlayer.get()
    expect(st.mode).toBe('bytes')
    expect(st.paragraphIndex).toBe(0)
    expect(synth.cancel).toHaveBeenCalled()
    expect(synthCalls()).toHaveLength(1)
    expect(playingAudio()).not.toBeNull()
  })

  it('切换直出后，上一模式在途的预取不再以浏览器引擎发合成请求', async () => {
    fixture = { names: ['第一章', '第二章'], texts: [['a。', 'b。', 'c。'], ['n0。', 'n1。']] }
    let release: (() => void) | null = null
    chapterGate = new Promise<void>((resolve) => { release = resolve })
    await start({ paragraphIndex: 2 })
    await setListenEngine('browser:local')
    must<() => void>(release, 'gate release')()
    await microtasks(80)
    const calls = synthCalls()
    expect(calls.filter((c) => c.engineId === 'browser:local')).toHaveLength(0)
    expect(calls.map((c) => c.text)).toEqual(['c。'])
  })
})
