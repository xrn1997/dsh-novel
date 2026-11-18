// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ROUTES, TTS_DEFAULTS, ttsAudioUrl } from '../../src/shared/wire.js'
import type { RouteTarget, ShelfEntry, WriteMethod } from '../../src/shared/wire.js'
import { apiGet, apiSend } from '../../src/client/api.js'
import { panelShelf } from '../../src/client/panel-shelf.js'
import {
  TTS_MAX_CONSECUTIVE_FAILURES,
  pauseListening,
  playFromReadingPosition,
  resetTtsPlayer,
  resumeListening,
  seekParagraph,
  setListenEngine,
  setListenRate,
  setListenTimer,
  setListenVoice,
  setListenVolume,
  setTtsDefaults,
  skipChapter,
  skipParagraph,
  startListening,
  stopListening,
  ttsPlayer,
} from '../../src/client/tts/player.js'
import type { StartListeningInput } from '../../src/client/tts/player.js'
import {
  estimateParagraphIndex,
  setReadingProbe,
} from '../../src/client/tts/reading-position.js'

/**
 * 常驻播放层（字节型）的行为网：真模块 + mock 掉 `/novel-api` 与 `Audio` 构造器。
 * 假的 Audio 只演播放器真正消费的那一面：`src` / `volume` / `play` / `pause` / `onended`，
 * 以及停播时松开缓冲的那一对（`removeAttribute` + `load`）；
 * 测试用 `fireEnded()` 模拟「这一段播完」，用 `paused` 判断哪一只是当前播放器（预载那只不动）。
 */
vi.mock('../../src/client/api.js', () => ({
  apiGet: vi.fn(),
  apiSend: vi.fn(),
}))

class FakeAudio {
  static instances: FakeAudio[] = []
  private srcValue = ''
  /** 赋过 src 的序列：预载 404 之后，下一次起播必须重新赋一次 `src`（同键不重设就会对着
   *  一个 errored 元素再 play，浏览器只会再拒）。 */
  srcSets: string[] = []
  volume = 1
  preload = ''
  paused = true
  currentTime = 0
  /** `fireError` 之后介质进入错误态：不重新赋 src 的 `play()` 会拒绝（真浏览器同此）。 */
  errored = false
  onended: (() => void) | null = null
  onerror: (() => void) | null = null
  onplaying: (() => void) | null = null
  constructor() { FakeAudio.instances.push(this) }
  get src(): string { return this.srcValue }
  set src(value: string) {
    this.srcValue = value
    this.srcSets.push(value)
    this.errored = false
  }
  play = vi.fn(async () => {
    if (audioFails || this.errored) throw new Error('media error')
    this.paused = false
    this.onplaying?.()
  })
  pause = vi.fn(() => { this.paused = true })
  /** 停播时播放层会摘 src 松开缓冲（`removeAttribute` + `load` 那一对，不是赋空串） */
  removeAttribute = vi.fn()
  load = vi.fn()
  fireEnded(): void {
    this.paused = true
    this.onended?.()
  }

  fireError(): void {
    this.paused = true
    this.errored = true
    this.onerror?.()
  }
}

/** 一份书内测试夹具：章名 + 每章正文段落（正文以 \n 拼成 ChapterContent.text） */
interface Fixture {
  names: string[]
  texts: string[][]
}

let fixture: Fixture
/** 合成文本 → 失败码：命中即让这一次 POST synthesize 拒绝（错误形状随用例） */
let synthFailures: Map<string, string>
let synthKeys: Map<string, string>
/** 合成闸：命中文本的请求先挂在 Promise 上，用例放手后才继续（模拟在途预取）。 */
let synthGate: Map<string, Promise<void>>
/** 这些章号的正文 GET 失败（模拟跳章时章正文拉不到） */
let chapterFailures: Set<number>
let synthCount: number
let shelfReads: ShelfEntry[]
/** 介质永远起不来（play 拒绝）：演「每一段音频都没开口」。 */
let audioFails: boolean

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

function keyOf(text: string): string {
  return must(synthKeys.get(text), `synth key for ${text}`)
}

interface SynthCall { text: string; engineId: string; rate: number; voice: string | null }

function synthCalls(): SynthCall[] {
  const send = vi.mocked(apiSend)
  return send.mock.calls
    .filter(([target]) => target.path === ROUTES.ttsSynthesize.path)
    .map(([, body]) => {
      const record = (body ?? {}) as Record<string, unknown>
      return {
        text: typeof record.text === 'string' ? record.text : '',
        engineId: typeof record.engineId === 'string' ? record.engineId : '',
        rate: typeof record.rate === 'number' ? record.rate : 0,
        voice: typeof record.voice === 'string' ? record.voice : null,
      }
    })
}

function synthTexts(): string[] {
  return synthCalls().map((c) => c.text)
}

interface ShelfPutCall { path: string; body: Record<string, unknown> }

function shelfPuts(): ShelfPutCall[] {
  const send = vi.mocked(apiSend)
  return send.mock.calls
    .filter(([target]) => target.path.startsWith('shelf/'))
    .map(([target, body]) => ({ path: target.path, body: (body ?? {}) as Record<string, unknown> }))
}

function activeAudio(): FakeAudio {
  return must(FakeAudio.instances.find((a) => !a.paused), 'playing audio element')
}

/** 让在途 Promise 链（mock 的异步 api + 预取）走完；不改时钟 */
async function microtasks(count = 30): Promise<void> {
  for (let i = 0; i < count; i += 1) await Promise.resolve()
}

function start(over: Partial<StartListeningInput> = {}): Promise<void> {
  return startListening({
    sourceId: 's1', bookKey: 'b1', title: '书一', chapterIndex: 0, paragraphIndex: 0,
    ...over,
  })
}

function shelfEntry(over: Partial<ShelfEntry> = {}): ShelfEntry {
  return {
    sourceId: 's1', bookKey: 'b1', title: '书一', sourceName: null,
    progress: { chapterIndex: 0, offsetRatio: 0, updatedAt: 0 },
    addedAt: 0,
    ...over,
  }
}

beforeEach(() => {
  resetTtsPlayer()
  setReadingProbe(null)
  FakeAudio.instances = []
  vi.stubGlobal('Audio', FakeAudio)
  vi.clearAllMocks()
  fixture = {
    names: ['第一章', '第二章'],
    texts: [['第一段。', '第二段。', '第三段。'], ['第二章第一段。', '第二章第二段。']],
  }
  synthFailures = new Map()
  synthKeys = new Map()
  synthGate = new Map()
  chapterFailures = new Set()
  synthCount = 0
  shelfReads = []
  audioFails = false

  vi.mocked(apiGet).mockImplementation(async (path: string) => {
    if (path.startsWith('navigation')) {
      return {
        chapters: fixture.names.map((name, i) => ({ name, url: `u${i}` })),
        items: [],
      }
    }
    if (path.startsWith('chapter')) {
      const index = indexOfPath(path)
      if (chapterFailures.has(index)) throw Object.assign(new Error('章节取不到'), { code: 'NetworkError' })
      return { kind: 'text', text: must(fixture.texts[index], `chapter ${index}`).join('\n') }
    }
    if (path === ROUTES.shelf.path) return shelfReads
    throw new Error(`unexpected GET ${path}`)
  })
  vi.mocked(apiSend).mockImplementation(async (target: RouteTarget<WriteMethod>, body?: unknown) => {
    if (target.path === ROUTES.ttsSynthesize.path) {
      const text = textOf(body)
      const failure = synthFailures.get(text)
      if (failure !== undefined) throw Object.assign(new Error(failure), { code: failure })
      const gate = synthGate.get(text)
      if (gate !== undefined) await gate
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

describe('常驻播放层：起播与自动推进', () => {
  it('startListening 拉章、切播放单元，并从指定段起播', async () => {
    await start()
    const st = ttsPlayer.get()
    expect(st.active).toBe(true)
    expect(st.bookKey).toBe('b1')
    expect(st.sourceId).toBe('s1')
    expect(st.title).toBe('书一')
    expect(st.chapterIndex).toBe(0)
    expect(st.chapterNames[st.chapterIndex]).toBe('第一章')
    expect(st.paragraphCount).toBe(3)
    expect(st.paragraphIndex).toBe(0)
    expect(st.playing).toBe(true)
    expect(st.mode).toBe('bytes')
    expect(st.engineId).toBe(TTS_DEFAULTS.engineId)
    expect(st.rate).toBe(TTS_DEFAULTS.rate)
    expect(st.volume).toBe(TTS_DEFAULTS.volume)
    expect(st.timerEndAt).toBeNull()
    expect(st.halt, '正常起播不公布停因').toBeNull()
    expect(synthTexts()[0]).toBe('第一段。')
    expect(activeAudio().src).toBe(ttsAudioUrl(keyOf('第一段。')))
    expect(activeAudio().volume).toBe(TTS_DEFAULTS.volume)
  })

  it('段播完自动 advance，并预取同章后 2 段（预取命中不重复合成）', async () => {
    fixture = {
      names: ['第一章', '第二章'],
      texts: [
        ['p0。', 'p1。', 'p2。', 'p3。', 'p4。', 'p5。', 'p6。', 'p7。'],
        ['n0。', 'n1。'],
      ],
    }
    await start()
    await microtasks()
    expect(synthTexts().sort()).toEqual(['p0。', 'p1。', 'p2。'].sort())

    activeAudio().fireEnded()
    await microtasks()
    const st = ttsPlayer.get()
    expect(st.paragraphIndex).toBe(1)
    expect(st.playing).toBe(true)
    expect(synthTexts().filter((t) => t === 'p1。')).toHaveLength(1)
    expect(synthTexts()).toContain('p3。')
    expect(activeAudio().src).toBe(ttsAudioUrl(keyOf('p1。')))
  })

  it('进末 3 段时预取下一章前 N 段（N 读活动缺省快照）', async () => {
    fixture = {
      names: ['第一章', '第二章'],
      texts: [['a。', 'b。', 'c。', 'd。'], ['n0。', 'n1。', 'n2。']],
    }
    setTtsDefaults({ prefetchParagraphs: 2 })
    await start({ paragraphIndex: 1 })
    await microtasks(40)
    expect(synthTexts()).toContain('n0。')
    expect(synthTexts()).toContain('n1。')
    expect(synthTexts()).not.toContain('n2。')
    const chapterReads = vi.mocked(apiGet).mock.calls.filter(([path]) => path.startsWith('chapter'))
    expect(chapterReads.some(([path]) => /[?&]index=1(?:&|$)/.test(path))).toBe(true)
  })

  it('手动跳章后在途的下一章预取不再继续（旧目标只留在途那一发）', async () => {
    fixture = {
      names: ['第一章', '第二章', '第三章'],
      texts: [['a。', 'b。'], ['c。', 'd。', 'e。', 'f。'], ['m0。', 'm1。']],
    }
    setTtsDefaults({ prefetchParagraphs: 2 })
    let release = (): void => { throw new Error('m0 gate 未就绪') }
    synthGate.set('m0。', new Promise<void>((resolve) => { release = resolve }))
    await start({ chapterIndex: 1, paragraphIndex: 1 })
    await microtasks(40)
    // 末 3 段触发下一章预取；m0 在途时用户跳走。
    void skipChapter(-1)
    await microtasks(40)
    release()
    await microtasks(40)
    expect(synthTexts()).toContain('m0。')
    expect(synthTexts()).not.toContain('m1。')
  })

  it('位置落盘同节拍写 listen 与 progress 两笔，各走各的 body', async () => {
    await start()
    activeAudio().fireEnded()
    await microtasks()
    void skipParagraph(1)
    await microtasks()
    setListenRate(1.5)
    pauseListening()
    void skipChapter(1)
    await microtasks()
    stopListening()

    const puts = shelfPuts()
    const listenPuts = puts.filter((put) => 'listen' in put.body)
    const progressPuts = puts.filter((put) => 'progress' in put.body)
    expect(listenPuts.length).toBeGreaterThan(0)
    expect(progressPuts, '每一笔位置落盘都同时写共用位置').toHaveLength(listenPuts.length)
    for (const put of puts) {
      expect(Object.keys(put.body), put.path).toHaveLength(1)
      if ('listen' in put.body) {
        const listen = put.body.listen as Record<string, unknown>
        expect(Object.keys(listen).sort()).toEqual(
          ['chapterIndex', 'engineId', 'paragraphIndex', 'rate', 'voice', 'volume'],
        )
      } else {
        expect(Object.keys(put.body)).toEqual(['progress'])
        expect(Object.keys(put.body.progress as Record<string, unknown>).sort())
          .toEqual(['chapterIndex', 'offsetRatio'])
      }
    }
    // 停止时已在第二章首段：最后一笔共用位置是章 1、章内 0
    expect(must(progressPuts.at(-1), '末笔 progress').body.progress).toEqual({
      chapterIndex: 1, offsetRatio: 0,
    })
  })
})

describe('常驻播放层：存档越界与失败半径', () => {
  it('存档章/段越界 clamp 到末章末段，不抛错', async () => {
    await start({ chapterIndex: 99, paragraphIndex: 99 })
    const st = ttsPlayer.get()
    expect(st.active).toBe(true)
    expect(st.chapterIndex).toBe(1)
    expect(st.chapterNames[st.chapterIndex]).toBe('第二章')
    expect(st.paragraphCount).toBe(2)
    expect(st.paragraphIndex).toBe(1)
    expect(st.playing).toBe(true)
  })

  it('负下标同样夹回章首段首', async () => {
    await start({ chapterIndex: -5, paragraphIndex: -3 })
    const st = ttsPlayer.get()
    expect(st.chapterIndex).toBe(0)
    expect(st.paragraphIndex).toBe(0)
  })

  it('单段合成失败：跳过该段、不报停因；下一段成功即清零连败计数', async () => {
    synthFailures.set('第一段。', 'TTS_UPSTREAM')
    await start()
    await microtasks()
    const st = ttsPlayer.get()
    expect(st.halt, '单段失败不到阈值：不上报停因').toBeNull()
    expect(st.paragraphIndex).toBe(1)
    expect(st.playing).toBe(true)
    expect(st.consecutiveFailures).toBe(0)
  })

  it('合成在途时换引擎：旧一发作废，当前段按新引擎重新合成', async () => {
    let release = (): void => { throw new Error('合成闸未就绪') }
    synthGate.set('第一段。', new Promise<void>((resolve) => { release = resolve }))
    const started = start()
    await microtasks()
    expect(ttsPlayer.get().loading, '当前段正在合成').toBe(true)
    await setListenEngine('http:other')
    release()
    await started
    await microtasks()
    expect(synthCalls().filter((c) => c.text === '第一段。').map((c) => c.engineId))
      .toEqual([TTS_DEFAULTS.engineId, 'http:other'])
    const st = ttsPlayer.get()
    expect(st.engineId).toBe('http:other')
    expect(st.playing).toBe(true)
  })

  it(`连续 ${TTS_MAX_CONSECUTIVE_FAILURES} 段失败即暂停（不再往下跳）`, async () => {
    fixture = {
      names: ['第一章'],
      texts: [['p0。', 'p1。', 'p2。', 'p3。', 'p4。', 'p5。']],
    }
    for (const text of must(fixture.texts[0], 'texts')) synthFailures.set(text, 'TTS_UPSTREAM')
    await start()
    await vi.waitFor(() => expect(ttsPlayer.get().consecutiveFailures).toBe(TTS_MAX_CONSECUTIVE_FAILURES))
    const st = ttsPlayer.get()
    expect(st.playing).toBe(false)
    expect(st.halt, '到线暂停要公布停因与次数').toEqual({
      reason: 'consecutive-failures', failures: TTS_MAX_CONSECUTIVE_FAILURES,
    })
    expect(st.paragraphIndex).toBe(4)
  })

  it('连败计数跨章累计：失败串穿过章界仍到线暂停，不把整本走完', async () => {
    fixture = {
      names: ['第一章', '第二章'],
      texts: [['a0。', 'a1。', 'a2。'], ['b0。', 'b1。', 'b2。']],
    }
    for (const text of fixture.texts.flat()) synthFailures.set(text, 'TTS_UPSTREAM')
    await start()
    await vi.waitFor(() => expect(ttsPlayer.get().consecutiveFailures).toBe(TTS_MAX_CONSECUTIVE_FAILURES))
    const st = ttsPlayer.get()
    // 5 次失败 = 第一章 3 段 + 第二章 2 段；章界不清零，故停在第二章第 2 段（到线后不再前进）
    expect(st.chapterIndex).toBe(1)
    expect(st.paragraphIndex).toBe(1)
    expect(st.playing).toBe(false)
    // 停因随失败串一起公布：次数是整趟会话的连败（跨章不清零）
    expect(st.halt).toEqual({
      reason: 'consecutive-failures', failures: TTS_MAX_CONSECUTIVE_FAILURES,
    })
    // 到线即停：第二章第 3 段没发合成请求，也没有第三趟章正文读取
    expect(synthTexts()).toEqual(['a0。', 'a1。', 'a2。', 'b0。', 'b1。'])
    const chapterReads = vi.mocked(apiGet).mock.calls
      .filter(([path]) => path.startsWith('chapter'))
      .map(([path]) => indexOfPath(path))
    expect(chapterReads).toEqual([0, 1])
  })

  it('空目录起播 reject 带结构化 code（message 只放码，不是界面人话）', async () => {
    fixture = { names: [], texts: [] }
    await expect(start()).rejects.toMatchObject({
      name: 'TtsPlayerError',
      code: 'TTS_CHAPTERS_EMPTY',
      message: 'TTS_CHAPTERS_EMPTY',
    })
    expect(ttsPlayer.get().active).toBe(false)
  })

  it('音频元素 error：先自愈一次（重取回执再起播），第二次仍失败才按段失败跳过', async () => {
    await start()
    const stale = activeAudio().onerror
    const key = activeAudio().src
    activeAudio().fireError()
    await microtasks()
    let st = ttsPlayer.get()
    expect(st.halt, '第一次读不出不记失败：先重取一次').toBeNull()
    expect(st.paragraphIndex, '仍在同一段').toBe(0)
    expect(st.playing, '重新起播').toBe(true)
    // 内容寻址：同段同参重合成仍是同一枚键，读口再取一次即可
    expect(activeAudio().src).toBe(key)

    activeAudio().fireError()
    await microtasks()
    st = ttsPlayer.get()
    expect(st.paragraphIndex, '第二次仍失败才跳过这一段').toBe(1)
    expect(st.paragraphIndex).toBe(1)
    expect(st.playing).toBe(true)
    // 同一段迟到的那条监听不再记第二次：token 已随推进抬升
    stale?.()
    await microtasks()
    expect(ttsPlayer.get().halt, '一次失败不到阈值，不公布停因').toBeNull()
  })

  it('瞬时 404：自愈重赋 src 才再起播（同键跳过重设就会对着 errored 元素再 play）', async () => {
    await start()
    const element = activeAudio()
    const key = element.src
    element.fireError()
    await microtasks()

    const st = ttsPlayer.get()
    expect(st.halt, '第一次读不出不记失败：先自愈').toBeNull()
    expect(st.playing, '重新赋 src 后起播成功').toBe(true)
    expect(activeAudio().src).toBe(key)
    // 内容寻址：同段同参数重合成仍是同一枚键；能再起播靠的是自愈前把槽键作废、重新赋 src
    expect(activeAudio().srcSets.filter((assigned) => assigned === key), '同键也重赋了 src')
      .toHaveLength(2)
  })

  it('预载 404：预载槽 error 清键与预载记录，下一段重新赋 src 起播（不静默跳过）', async () => {
    fixture = { names: ['第一章', '第二章'], texts: [['a0。', 'a1。', 'a2。'], ['n0。']] }
    await start()
    await microtasks()
    const bUrl = ttsAudioUrl(keyOf('a1。'))
    const preloadSlot = must(FakeAudio.instances[1], '预载槽')
    expect(preloadSlot.src, '第二段已预载到另一只槽').toBe(bUrl)
    preloadSlot.fireError()
    await microtasks()
    expect(ttsPlayer.get().halt, '预载失败不是当前段的失败').toBeNull()
    expect(ttsPlayer.get().paragraphIndex).toBe(0)

    activeAudio().fireEnded()                 // a0。播完 → 推进到 a1。
    await microtasks()
    const st = ttsPlayer.get()
    expect(st.paragraphIndex, '推进到第二段').toBe(1)
    expect(st.halt, '第二段照常起播，不静默跳过').toBeNull()
    expect(st.playing).toBe(true)
    const assigned = FakeAudio.instances.flatMap((audio) => audio.srcSets)
      .filter((value) => value === bUrl)
    expect(assigned.length, '预载 404 之后重新赋过 src').toBeGreaterThanOrEqual(2)
  })

  it('每段音频都失败（play 拒绝 / error 终态）：连败到阈值即暂停，不静默把整本走完', async () => {
    fixture = {
      names: ['第一章', '第二章'],
      texts: [['p0。', 'p1。', 'p2。', 'p3。', 'p4。', 'p5。'], ['n0。']],
    }
    audioFails = true                       // 介质永远起不来：每次 play 都拒绝
    await expect(start()).resolves.toBeUndefined()
    await vi.waitFor(() => {
      expect(ttsPlayer.get().consecutiveFailures, '起播即清零的旧口径会让这里永远是 1')
        .toBe(TTS_MAX_CONSECUTIVE_FAILURES)
    })
    const st = ttsPlayer.get()
    expect(st.halt, '每段都失败：到线公布停因').toEqual({
      reason: 'consecutive-failures', failures: TTS_MAX_CONSECUTIVE_FAILURES,
    })
    expect(st.paragraphIndex, '到线停在第五段').toBe(4)
    expect(st.playing).toBe(false)
    expect(st.active, '是暂停不是停止').toBe(true)
    expect(st.chapterIndex, '没有走到下一章').toBe(0)
    // 每段一次自愈：首段被重合成过一次（自愈前作废槽键、重新赋 src 才可能再起播）
    expect(synthTexts().filter((text) => text === 'p0。')).toHaveLength(2)
  })

  it('引擎中途缺席（TTS_ENGINE_MISSING）走同一失败径，播放层不炸', async () => {
    // 第一段成功起播之后引擎才缺席：预取那一发静默失败，真正播到它时才留痕并跳过
    synthFailures.set('第二段。', 'TTS_ENGINE_MISSING')
    await expect(start()).resolves.toBeUndefined()
    activeAudio().fireEnded()
    await microtasks()
    const st = ttsPlayer.get()
    expect(st.halt, '一次失败不到阈值：不公布停因').toBeNull()
    // 跳过失败的那一段后下一段真开口：连败计数从那一刻清零（失联的那段只由「段号跳过」留痕）
    expect(st.consecutiveFailures, '下一段真开口后连败清零').toBe(0)
    expect(st.playing).toBe(true)
    expect(st.paragraphIndex).toBe(2)
  })
})

describe('常驻播放层：位置落盘与定时', () => {
  it('pause 立即 flush 防抖中的位置（listen + progress 各一笔，不等 2s）', async () => {
    vi.useFakeTimers()
    try {
      await start()
      expect(shelfPuts()).toHaveLength(0)
      pauseListening()
      expect(shelfPuts()).toHaveLength(2)
      vi.advanceTimersByTime(5000)
      expect(shelfPuts()).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stop 立即 flush 并把 active 置回 false', async () => {
    vi.useFakeTimers()
    try {
      await start()
      stopListening()
      expect(shelfPuts()).toHaveLength(2)
      expect(ttsPlayer.get().active).toBe(false)
      expect(ttsPlayer.get().playing).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('停播松开音频缓冲，暂停不松（暂停要能原地续播）', async () => {
    await start()
    const played = activeAudio()
    expect(played.src, '播的是音频读口那枚 URL').toContain('tts/audio')

    pauseListening()
    expect(played.load, '暂停不能把这一段丢掉').not.toHaveBeenCalled()

    stopListening()
    // 摘 src 用 removeAttribute + load：赋空串会被浏览器当成一次空 URL 加载并报错
    expect(played.removeAttribute).toHaveBeenCalledWith('src')
    expect(played.load).toHaveBeenCalled()
  })

  it('pagehide 触发 flush（关页前的最后一笔位置）', async () => {
    vi.useFakeTimers()
    try {
      await start()
      expect(shelfPuts()).toHaveLength(0)
      window.dispatchEvent(new Event('pagehide'))
      expect(shelfPuts()).toHaveLength(2)
      const listen = must(
        shelfPuts().find((put) => 'listen' in put.body), 'pagehide 的 listen 落盘',
      ).body.listen as Record<string, unknown>
      expect(listen.chapterIndex).toBe(0)
      expect(listen.paragraphIndex).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('定时到点暂停（timerEndAt 读得出口径，到点后清空）', async () => {
    vi.useFakeTimers()
    try {
      await start()
      setListenTimer(1)
      expect(ttsPlayer.get().timerEndAt).not.toBeNull()
      vi.advanceTimersByTime(60_000)
      expect(ttsPlayer.get().playing).toBe(false)
      expect(ttsPlayer.get().timerEndAt).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it("'chapter' 定时在本章末尾暂停，不进入下一章", async () => {
    fixture = { names: ['第一章', '第二章'], texts: [['a。', 'b。'], ['n0。', 'n1。']] }
    await start()
    setListenTimer('chapter')
    expect(ttsPlayer.get().timerEndAt).toBeNull()
    activeAudio().fireEnded()
    await microtasks()
    expect(ttsPlayer.get().paragraphIndex).toBe(1)
    expect(ttsPlayer.get().playing).toBe(true)
    activeAudio().fireEnded()
    await microtasks()
    const st = ttsPlayer.get()
    expect(st.playing).toBe(false)
    expect(st.chapterIndex).toBe(0)
    expect(st.timerEndAt).toBeNull()
  })
})

describe('常驻播放层：跳章、回退链与从阅读位置起播', () => {
  it('skipChapter 跨边界载入新章并从头播', async () => {
    await start()
    void skipChapter(1)
    await microtasks()
    const st = ttsPlayer.get()
    expect(st.chapterIndex).toBe(1)
    expect(st.chapterNames[st.chapterIndex]).toBe('第二章')
    expect(st.paragraphCount).toBe(2)
    expect(st.paragraphIndex).toBe(0)
    expect(st.playing).toBe(true)
    expect(synthTexts()).toContain('第二章第一段。')
  })

  it('手动跳章时章正文拉不到：字节型旧音频当场停住、状态不撒谎、错误码交回调用方', async () => {
    await start()
    const playing = activeAudio()
    chapterFailures.add(1)
    // 手动导航的失败半径是整个动作：抛 TTS_CHAPTER_LOAD 让界面翻人话，不留在按了没反应
    await expect(skipChapter(1)).rejects.toMatchObject({ code: 'TTS_CHAPTER_LOAD' })
    await microtasks()
    const st = ttsPlayer.get()
    expect(st.loading, '失败后不许永挂加载中').toBe(false)
    expect(st.playing, '界面不假装在放').toBe(false)
    expect(st.chapterIndex, '失败不挪章').toBe(0)
    // playSeq 已抬、旧槽回调全部作废：旧音频若还在响，就是「界面说暂停、耳朵里还在念上一章」
    expect(playing.paused, '旧音频必须闭嘴').toBe(true)
  })

  it('自动推进到下一章时章正文拉不到：按自动推进收口成暂停（不抛给用户）', async () => {
    fixture = { names: ['第一章', '第二章'], texts: [['a。'], ['never。']] }
    await start()
    chapterFailures.add(1)
    activeAudio().fireEnded()
    await microtasks()
    const st = ttsPlayer.get()
    expect(st.playing).toBe(false)
    expect(st.loading).toBe(false)
    expect(st.chapterIndex, '自动推进失败不挪章').toBe(0)
  })

  it('skipParagraph 在同章内移动；末段再往后跨章', async () => {
    await start({ paragraphIndex: 0 })
    void skipParagraph(1)
    await microtasks()
    expect(ttsPlayer.get().paragraphIndex).toBe(1)
    await start({ paragraphIndex: 2 })
    void skipParagraph(1)
    await microtasks()
    expect(ttsPlayer.get().chapterIndex).toBe(1)
    expect(ttsPlayer.get().paragraphIndex).toBe(0)
  })

  it('往后跳到已预载的下一段：只许出声一只，旧槽必须闭嘴', async () => {
    await start({ paragraphIndex: 0 })
    await microtasks()
    // 预载把第 2 段接进另一只槽（不发声），此刻出声的仍是第 1 段那一只
    expect(FakeAudio.instances.filter((a) => !a.paused)).toHaveLength(1)
    void skipParagraph(1)
    await microtasks()
    expect(ttsPlayer.get().paragraphIndex).toBe(1)
    // 换槽起播不许留下两只同时在念：叠音比慢半拍更糟
    const playing = FakeAudio.instances.filter((a) => !a.paused)
    expect(playing).toHaveLength(1)
    expect(playing[0]?.src).toBe(ttsAudioUrl(keyOf('第二段。')))
  })

  it('回退链三级：广播缺省 < 本书 listen 存档 < 显式传入', async () => {
    // 第三级：活动缺省快照
    setTtsDefaults({ engineId: 'http:served', rate: 1.25, volume: 0.45 })
    await start()
    expect(ttsPlayer.get()).toMatchObject({
      engineId: 'http:served', voice: null, rate: 1.25, volume: 0.45,
    })

    // 第二级：本书 listen 存档（服务端读面）
    shelfReads = [shelfEntry({
      listen: {
        chapterIndex: 0, paragraphIndex: 0, engineId: 'http:book', voice: 'vb',
        rate: 1.6, volume: 0.3,
      },
    })]
    await start()
    expect(ttsPlayer.get()).toMatchObject({
      engineId: 'http:book', voice: 'vb', rate: 1.6, volume: 0.3,
    })

    // 第一级：显式传入覆盖存档（voice: null 是显式「不用音色」，不是缺席）
    await start({ engineId: 'http:explicit', voice: null, rate: 2, volume: 1 })
    expect(ttsPlayer.get()).toMatchObject({
      engineId: 'http:explicit', voice: null, rate: 2, volume: 1,
    })
  })

  it('resume: archive 以服务端存档续听；读面失败如实抛，不退化成当前章 0 段', async () => {
    resetTtsPlayer()
    shelfReads = [shelfEntry({
      listen: {
        chapterIndex: 1, paragraphIndex: 1, engineId: 'http:book', voice: 'vb',
        rate: 1.6, volume: 0.3,
      },
    })]
    await start({ chapterIndex: 0, paragraphIndex: 0, resume: 'archive' })
    expect(ttsPlayer.get()).toMatchObject({
      chapterIndex: 1, paragraphIndex: 1, engineId: 'http:book', voice: 'vb',
    })
  })

  it('续听只认服务端存档：面板投影里的旧 listen 不参与（听→停→再听同面板）', async () => {
    // 面板投影是挂载期快照（旧位置或缺 listen）；服务端才是存档真相。
    panelShelf.set({
      books: [shelfEntry({
        listen: {
          chapterIndex: 0, paragraphIndex: 0, engineId: null, voice: null,
          rate: 1, volume: 1,
        },
      })],
      error: null,
      landed: new Set(),
    })
    shelfReads = [shelfEntry({
      listen: {
        chapterIndex: 1, paragraphIndex: 1, engineId: 'http:book', voice: null,
        rate: 1.4, volume: 0.6,
      },
    })]
    await start({ chapterIndex: 0, paragraphIndex: 0, resume: 'archive' })
    expect(ttsPlayer.get()).toMatchObject({
      chapterIndex: 1, paragraphIndex: 1, engineId: 'http:book', rate: 1.4, volume: 0.6,
    })
  })

  it('resume: position 显式位置优先于存档', async () => {
    shelfReads = [shelfEntry({
      listen: {
        chapterIndex: 1, paragraphIndex: 1, engineId: 'http:book', voice: 'vb',
        rate: 1.6, volume: 0.3,
      },
    })]
    await start({ chapterIndex: 0, paragraphIndex: 2, resume: 'position' })
    expect(ttsPlayer.get()).toMatchObject({ chapterIndex: 0, paragraphIndex: 2 })
  })

  it('setListen* 改动随下一笔位置落盘写回本书 listen；换引擎清掉旧音色 id', async () => {
    await start()
    setListenRate(1.5)
    setListenVoice('v2')
    setListenVolume(0.4)
    await setListenEngine('http:other')
    pauseListening()
    const listen = must(
      shelfPuts().find((put) => 'listen' in put.body), 'setListen* 的 listen 落盘',
    ).body.listen as Record<string, unknown>
    expect(listen).toMatchObject({
      // 音色 id 不跨引擎互通：换源后回该源缺省，不把上一家的 id 送进新引擎
      engineId: 'http:other', voice: null, rate: 1.5, volume: 0.4,
    })
  })

  it('startListening 换书先停旧会话并 flush 旧书位置', async () => {
    await start({ bookKey: 'b1', title: '书一' })
    await start({ bookKey: 'b2', title: '书二' })
    const puts = shelfPuts()
    // 旧书的最后一笔位置：listen + progress 各一条，两条都落在旧书键上
    expect(puts).toHaveLength(2)
    expect(puts.every((put) => put.path === `shelf/${encodeURIComponent('b1')}`)).toBe(true)
    expect(puts.filter((put) => 'listen' in put.body)).toHaveLength(1)
    expect(puts.filter((put) => 'progress' in put.body)).toHaveLength(1)
    expect(ttsPlayer.get().bookKey).toBe('b2')
    expect(ttsPlayer.get().title).toBe('书二')
    const chapterReads = vi.mocked(apiGet).mock.calls.filter(([path]) => path.startsWith('chapter'))
    expect(chapterReads.some(([path]) => path.includes(`url=${encodeURIComponent('b2')}`))).toBe(true)
  })

  it('跳段后旧音频的 ended 不推进新段：合成在途时旧槽还在响，不能被它带着走', async () => {
    fixture = {
      names: ['第一章'],
      texts: [['p0。', 'p1。', 'p2。', 'p3。', 'p4。']],
    }
    let release = (): void => { throw new Error('p3 gate 未就绪') }
    synthGate.set('p3。', new Promise<void>((resolve) => { release = resolve }))
    await start({ paragraphIndex: 0 })
    await microtasks()
    const old = activeAudio()
    seekParagraph(3)
    await microtasks()
    expect(ttsPlayer.get().paragraphIndex).toBe(3)
    // 新段合成还没回来：旧音频仍在响，它的 ended 带的是旧播放代际
    old.fireEnded()
    await microtasks()
    expect(ttsPlayer.get().paragraphIndex, '旧槽的 ended 不许把用户刚选的段跳过').toBe(3)
    release()
    await microtasks()
    expect(ttsPlayer.get().paragraphIndex).toBe(3)
  })

  it('空章没有可朗读段：自动推进跨过它，播到下一可读章', async () => {
    fixture = {
      names: ['第一章', '空章', '第三章'],
      texts: [['a。'], [], ['c。']],
    }
    await start({ paragraphIndex: 0 })
    await microtasks()
    activeAudio().fireEnded()
    await microtasks(40)
    expect(ttsPlayer.get().chapterIndex).toBe(2)
    expect(ttsPlayer.get().paragraphIndex).toBe(0)
    expect(ttsPlayer.get().playing).toBe(true)
    expect(activeAudio().src).toBe(ttsAudioUrl(keyOf('c。')))
  })

  it('空章里按上一段 / 下一段 = 跳章，不留在「按了没反应」的画面', async () => {
    fixture = {
      names: ['第一章', '空章', '第三章'],
      texts: [['a。'], [], ['c。']],
    }
    await start({ chapterIndex: 1, paragraphIndex: 0 })
    await microtasks()
    expect(ttsPlayer.get().paragraphCount).toBe(0)
    void skipParagraph(1)
    await microtasks(40)
    expect(ttsPlayer.get().chapterIndex).toBe(2)
    expect(ttsPlayer.get().playing).toBe(true)
  })

  it('playFromReadingPosition：有 probe 用 probe', async () => {
    await start({ paragraphIndex: 0 })
    setReadingProbe(() => ({ chapterIndex: 1, paragraphIndex: 1 }))
    await playFromReadingPosition()
    await microtasks()
    expect(ttsPlayer.get().chapterIndex).toBe(1)
    expect(ttsPlayer.get().paragraphIndex).toBe(1)
    expect(ttsPlayer.get().chapterNames[ttsPlayer.get().chapterIndex]).toBe('第二章')
  })

  it('playFromReadingPosition：无 probe 用服务端书架进度 + 段比例换算', async () => {
    await start({ paragraphIndex: 0 })
    shelfReads = [shelfEntry({ progress: { chapterIndex: 0, offsetRatio: 0.5, updatedAt: 3 } })]
    await playFromReadingPosition()
    await microtasks()
    expect(ttsPlayer.get().chapterIndex).toBe(0)
    // 3 段、章内 50% → 第 1 段（0 基）
    expect(ttsPlayer.get().paragraphIndex).toBe(1)
  })

  it('playFromReadingPosition：没进架的书如实报错，不演「按了没反应」', async () => {
    await start({ paragraphIndex: 0 })
    shelfReads = []
    setReadingProbe(null)
    await expect(playFromReadingPosition()).rejects.toThrow('TTS_NOT_ON_SHELF')
  })

  it('playFromReadingPosition：目录为空与 startSession 同一条码，不在这里静默退让', async () => {
    await start({ paragraphIndex: 0 })
    shelfReads = [shelfEntry({ progress: { chapterIndex: 0, offsetRatio: 0.5, updatedAt: 3 } })]
    setReadingProbe(null)
    fixture.names = []
    fixture.texts = []
    await expect(playFromReadingPosition()).rejects.toThrow('TTS_CHAPTERS_EMPTY')
  })

  it('playFromReadingPosition：目录读失败时旧会话照常在放，错误照报（不先停后取）', async () => {
    await start({ paragraphIndex: 0 })
    setReadingProbe(() => ({ chapterIndex: 1, paragraphIndex: 1 }))
    vi.mocked(apiGet).mockImplementation(async (path: string) => {
      if (path.startsWith('navigation')) throw new Error('目录读失败')
      throw new Error(`unexpected GET ${path}`)
    })
    await expect(playFromReadingPosition()).rejects.toThrow('目录读失败')
    const st = ttsPlayer.get()
    expect(st.active, '一次取目录失败不该把正在放的声音连会话一起停掉').toBe(true)
    expect(st.playing).toBe(true)
    expect(st.chapterIndex, '失败也不该改动现场').toBe(0)
  })

  it('playFromReadingPosition：定时档位跟着换起播点走，不被顺手抹掉', async () => {
    await start({ paragraphIndex: 0 })
    setListenTimer(15)
    setReadingProbe(() => ({ chapterIndex: 1, paragraphIndex: 1 }))
    await playFromReadingPosition()
    await microtasks()
    expect(ttsPlayer.get().chapterIndex).toBe(1)
    expect(ttsPlayer.get().timerChoice, '同一本书换起播点不是新会话').toBe(15)
    expect(ttsPlayer.get().timerEndAt, '换起播点后定时重新武装').not.toBeNull()
  })

  it('章正文在途时按继续不接：界面已是新章时不许旧章那段继续出声', async () => {
    await start({ chapterIndex: 0, paragraphIndex: 0 })
    await microtasks()
    const realGet = vi.mocked(apiGet).getMockImplementation()
    if (realGet === undefined) throw new Error('apiGet 缺实现')
    let release = (): void => { throw new Error('章正文闸未就绪') }
    vi.mocked(apiGet).mockImplementation(async (path: string) => {
      if (path.startsWith('chapter') && indexOfPath(path) === 1) {
        await new Promise<void>((resolve) => { release = resolve })
      }
      return realGet(path)
    })
    void skipChapter(1)
    await microtasks()
    expect(ttsPlayer.get().loading).toBe(true)
    // 此刻 st.paragraphIndex 还是上一章的那一个：照它起播就是「读数已换章、声音还是旧段」
    resumeListening()
    await microtasks()
    expect(ttsPlayer.get().playing).toBe(false)
    release()
    await microtasks(40)
    expect(ttsPlayer.get().chapterIndex).toBe(1)
    expect(ttsPlayer.get().playing).toBe(true)
    expect(activeAudio().src).toBe(ttsAudioUrl(keyOf('第二章第一段。')))
  })

  it('resume 续上暂停时的当前段（不重新合成、不从头换段）', async () => {
    await start()
    await microtasks()
    const element = activeAudio()
    pauseListening()
    expect(ttsPlayer.get().playing).toBe(false)
    const before = synthTexts().length
    resumeListening()
    await microtasks()
    expect(ttsPlayer.get().playing).toBe(true)
    expect(synthTexts().length).toBe(before)
    expect(element.paused).toBe(false)
  })
})

describe('阅读位置换算', () => {
  it('章内比例 → 段下标：两端对齐、越界夹紧、空段归 0', () => {
    expect(estimateParagraphIndex(0, 3)).toBe(0)
    expect(estimateParagraphIndex(1, 3)).toBe(2)
    expect(estimateParagraphIndex(0.5, 3)).toBe(1)
    expect(estimateParagraphIndex(-1, 3)).toBe(0)
    expect(estimateParagraphIndex(2, 3)).toBe(2)
    expect(estimateParagraphIndex(0.4, 1)).toBe(0)
    expect(estimateParagraphIndex(0.4, 0)).toBe(0)
    expect(estimateParagraphIndex(Number.NaN, 3)).toBe(0)
  })
})
