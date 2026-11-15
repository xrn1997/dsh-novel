import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import type {
  SpeechCapabilities,
  SpeechProviderCapabilities,
  SpeechProviderId,
  SpeechRequest,
  SpeechSynthesisService,
} from 'dsh-xiaomi-tts/host-api'
import type { Fetcher } from '../../src/services/fetcher.js'
import { TtsAudioCache } from '../../src/services/tts-cache.js'
import { TtsEngineRegistry } from '../../src/services/tts-engines.js'
import { TtsService } from '../../src/services/tts.js'
import type { NormalizedSpeechSynthesis } from '../../src/services/tts.js'
import { CORDIS_SYNTHESIS_TIMEOUT_MS, normalizeSpeechSynthesis } from '../../src/services/tts-cordis.js'
import { TtsSynthesisError } from '../../src/services/errors.js'
import { setLogSink } from '../../src/services/log.js'
import { must, pick } from '../support/fixture.js'
import { makeTempDir, trackService } from '../temp-dir.js'

/**
 * cordis `speechSynthesis` 源：宿主语音服务的私有契约 → 插件归一形状，再经
 * TtsService 的 cordis 分流落到缓存与源清单。
 *
 * 服务替身只实现被消费的几面（`capabilities` / `synthesize`，外加用例显式给的
 * `currentProvider`），其余成员一律「不应被调用」：谁能碰服务、碰哪一面，由这里钉住。
 * 类型只经 type-only import 从服务包的 host-api 进测试与适配器——运行时连那个包都不需要
 * 存在（包名见 `package.json`，来历见 `README.md`）。
 */

const AUDIO = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00])
const VOICES = [
  { id: 'female_0033_b', name: '知性女声' },
  { id: 'male_0004_a', name: '沉稳男声' },
]
const CORDIS_ENGINE_ID = 'cordis:speechSynthesis'

/** 一家供应商的能力声明：模型能力位（`voiceRate`）按用例给，音色表按需，就绪态按用例改。 */
function providerCapabilities(opts: {
  id: SpeechProviderId
  model: string
  voiceRate: boolean
  voices?: { id: string; name: string }[]
  ready?: boolean
  configured?: boolean
  unavailableReason?: string
}): SpeechProviderCapabilities {
  return {
    id: opts.id,
    configured: opts.configured ?? true,
    ready: opts.ready ?? true,
    ...(opts.unavailableReason === undefined ? {} : { unavailableReason: opts.unavailableReason }),
    selectedModel: opts.model,
    selectedVoice: opts.voices?.[0]?.id ?? '',
    maxTextLength: 1000,
    models: [{
      id: opts.model,
      voices: opts.voices ?? [],
      customVoice: false,
      voiceDesign: false,
      speechInstruction: true,
      audioTags: false,
      voiceRate: opts.voiceRate,
      streaming: true,
      duplex: false,
    }],
  }
}

/** capabilities 的当前有效供应商 + 所选模型（音色表按这一格取）：小米没有 voiceRate 参数。 */
function capabilitiesWith(voices: { id: string; name: string }[]): SpeechCapabilities {
  return {
    provider: 'xiaomi',
    formats: ['wav', 'mp3'],
    providers: [providerCapabilities({ id: 'xiaomi', model: 'mimo-v2', voiceRate: false, voices })],
  }
}

/** 豆包风格：当前供应商的所选模型声明支持 voiceRate（宿主契约值域 0.5–2）。 */
function doubaoCapabilities(): SpeechCapabilities {
  return {
    provider: 'doubao',
    formats: ['wav', 'mp3'],
    providers: [providerCapabilities({ id: 'doubao', model: 'doubao-tts', voiceRate: true, voices: VOICES })],
  }
}

/** 外部接管：`capabilities().provider` 仍是内置（豆包，模型声明支持 voiceRate），但
 *  `currentProvider()` 指向 `external:*`——有效供应商是外部提供方，宿主对它一律拒 voiceRate。 */
function externalTakeoverCapabilities(): SpeechCapabilities {
  return {
    provider: 'doubao',
    formats: ['wav', 'mp3'],
    providers: [
      providerCapabilities({ id: 'doubao', model: 'doubao-tts', voiceRate: true, voices: VOICES }),
      providerCapabilities({ id: 'external:test', model: 'external-model', voiceRate: false }),
    ],
  }
}

interface SpeechMock {
  service: SpeechSynthesisService
  requests: SpeechRequest[]
}

/** 宿主服务替身：只留 capabilities / synthesize，其余成员被调用即响亮失败。
 *  `currentProvider` 是宿主契约里的**可选**方法：只在用例显式提供时存在，未提供时就是 undefined
 *  （不改成必有的抛错桩——适配器要真的兼容「旧宿主没有这个方法」这条来路）。 */
function mockSpeechService(opts: {
  capabilities?: SpeechCapabilities
  currentProvider?: () => SpeechProviderId
} = {}): SpeechMock {
  const requests: SpeechRequest[] = []
  const unused = (): never => { throw new Error('测试替身：该方法不应被调用') }
  const service: SpeechSynthesisService = {
    registerProvider: unused,
    engineState: unused,
    subscribeEngine: unused,
    configureProvider: unused,
    resolveProvider: unused,
    streamPcm: unused,
    capabilities: () => opts.capabilities ?? capabilitiesWith(VOICES),
    synthesize: async (request) => {
      requests.push(request)
      return {
        data: AUDIO,
        text: request.text,
        provider: 'xiaomi',
        format: 'wav',
        contentType: 'audio/wav',
      }
    },
    ...(opts.currentProvider === undefined ? {} : { currentProvider: opts.currentProvider }),
    exportAudio: unused,
    registerDelivery: unused,
    hasDelivery: unused,
    setDeliveryEnabled: unused,
    isAutomaticDeliveryEnabled: unused,
    setAutomaticDeliveryEnabled: unused,
    deliver: unused,
  }
  return { service, requests }
}

/** cordis 源不走 HTTP：fetcher 一旦被碰即失败（合成支走 getter，不是出站请求）。 */
async function serviceWith(
  speechSynthesis: () => NormalizedSpeechSynthesis | undefined,
): Promise<TtsService> {
  const dir = await makeTempDir('novel-tts-cordis-')
  const engines = trackService(await TtsEngineRegistry.load(dir))
  const fetcher: Fetcher = {
    fetchPage: async () => { throw new Error('cordis 源不应发出站请求') },
  }
  return new TtsService({
    // 与 reading.ts 的 create 同形：缓存实例在装配处注入（cordis 支不走出站请求，缓存照常）
    cache: new TtsAudioCache(path.join(dir, 'cache', 'tts'), 10_000_000),
    engines,
    fetcher,
    jsTimeoutMs: 2_000,
    speechSynthesis,
  })
}

async function rejectionOf(fn: () => Promise<unknown>): Promise<TtsSynthesisError> {
  try {
    await fn()
  } catch (e) {
    if (e instanceof TtsSynthesisError) return e
    throw e
  }
  throw new Error('预期抛 TtsSynthesisError，实际成功返回')
}

/** 请求里除取消位之外的那几格，显式投影：`signal` 每次现造且只问「在不在」，混进
 *  `toStrictEqual` 会逼着用例写 `expect.any`（那会带上 `any` 类型，把断言变成不设防的）。
 *  字段缺席与 `undefined` 是两回事，投影也照这个口径只收在场的那几格。 */
function spokenOf(request: SpeechRequest): { text: string; voice?: string; voiceRate?: number } {
  return {
    text: request.text,
    ...(request.voice === undefined ? {} : { voice: request.voice }),
    ...(request.voiceRate === undefined ? {} : { voiceRate: request.voiceRate }),
  }
}

/** 每一发都带了取消位（适配器的不变式：合成必须可被调用方中止）。 */
function expectAllCancellable(requests: readonly SpeechRequest[]): void {
  expect(requests.length).toBeGreaterThan(0)
  expect(requests.every((request) => request.signal instanceof AbortSignal)).toBe(true)
}

describe('normalizeSpeechSynthesis：host-api 契约 → 插件归一形状', () => {
  it('当前有效模型不支持 voiceRate（小米）：rate 不落成请求字段；text / voice 照映射，未给的字段不传', async () => {
    const mock = mockSpeechService()
    const normalized = normalizeSpeechSynthesis(mock.service)

    const out = await normalized.synthesize({ text: '你好，世界', voice: 'female_0033_b', rate: 1.2 })
    expect(out.data).toBe(AUDIO)
    expect(out.contentType).toBe('audio/wav')
    // 缺能力位时整个 voiceRate 字段缺席（不是发 1）；toStrictEqual 顺带钉住「一个字段都不许多」
    expect(mock.requests.map(spokenOf)).toStrictEqual([{ text: '你好，世界', voice: 'female_0033_b' }])
    expectAllCancellable(mock.requests)

    await normalized.synthesize({ text: '只有正文' })
    // 缺席的可选字段不落成 `voice: undefined`——host-api 的 exactOptional 口径同样只认缺席
    expect(spokenOf(pick(mock.requests, 1))).toStrictEqual({ text: '只有正文' })
  })

  it('当前有效模型支持 voiceRate（豆包风格）：按宿主契约 0.5–2 夹取，1.2 原样', async () => {
    const mock = mockSpeechService({ capabilities: doubaoCapabilities() })
    const normalized = normalizeSpeechSynthesis(mock.service)

    await normalized.synthesize({ text: '太快', rate: 2.5 })
    await normalized.synthesize({ text: '太慢', rate: 0.3 })
    await normalized.synthesize({ text: '原样', rate: 1.2 })
    expect(mock.requests.map(spokenOf)).toStrictEqual([
      { text: '太快', voiceRate: 2 },
      { text: '太慢', voiceRate: 0.5 },
      { text: '原样', voiceRate: 1.2 },
    ])
    expectAllCancellable(mock.requests)
  })

  it('外部接管（currentProvider 优先于 capabilities().provider）：voiceRate 整字段缺席', async () => {
    const mock = mockSpeechService({
      capabilities: externalTakeoverCapabilities(),
      currentProvider: () => 'external:test',
    })
    const normalized = normalizeSpeechSynthesis(mock.service)

    // capabilities().provider 是豆包（模型声明支持），但有效供应商被外部接管：契约一律拒 voiceRate
    await normalized.synthesize({ text: '接管', rate: 1.5 })
    expect(mock.requests.map(spokenOf)).toStrictEqual([{ text: '接管' }])
    expectAllCancellable(mock.requests)
  })

  it('能力位读不出（有效供应商 / 所选模型不在清单里）→ 按不支持处理，字段缺席', async () => {
    const missingProvider = mockSpeechService({
      capabilities: { ...doubaoCapabilities(), provider: 'breeze' },
    })
    await normalizeSpeechSynthesis(missingProvider.service).synthesize({ text: '缺供应商', rate: 1.2 })
    expect(missingProvider.requests.map(spokenOf)).toStrictEqual([{ text: '缺供应商' }])
    expectAllCancellable(missingProvider.requests)

    const orphanModel = doubaoCapabilities()
    const missingModel = mockSpeechService({
      capabilities: {
        ...orphanModel,
        providers: orphanModel.providers.map((p) => ({ ...p, selectedModel: 'not-listed' })),
      },
    })
    await normalizeSpeechSynthesis(missingModel.service).synthesize({ text: '缺模型', rate: 1.2 })
    expect(missingModel.requests.map(spokenOf)).toStrictEqual([{ text: '缺模型' }])
    expectAllCancellable(missingModel.requests)
  })

  it('capabilities 的音色表进 voices；所选模型没有音色 → 缺席（UI 不渲染音色行）', () => {
    const mock = mockSpeechService()
    expect(normalizeSpeechSynthesis(mock.service).voices).toStrictEqual(VOICES)

    const bare = mockSpeechService({ capabilities: capabilitiesWith([]) })
    expect(normalizeSpeechSynthesis(bare.service).voices).toBeUndefined()
  })

  it('调用方取消随请求进宿主服务：中止后不再为没人听的段付上游钱，拒绝的是取消理由不是上游失败', async () => {
    // 不配合的服务（认不认 signal 都不在我们的控制里）也必须被取消落定：这一发永不 settle，
    // 只有取消那条腿能把它收掉——收掉的理由是调用方给的，不是我们编的。
    let seen: SpeechRequest | undefined
    const slow: SpeechSynthesisService = {
      ...mockSpeechService().service,
      synthesize: (request) => {
        seen = request
        return new Promise<never>(() => {})
      },
    }
    const reason = new Error('这一段不要了')
    const caller = new AbortController()

    const pending = normalizeSpeechSynthesis(slow).synthesize(
      { text: '取消的一段', rate: 1 }, { signal: caller.signal })
    expect(seen?.signal?.aborted, '发出时还不该中止').toBe(false)

    caller.abort(reason)
    expect(seen?.signal?.aborted, '取消要落到递给服务的那只信号上').toBe(true)
    await expect(pending).rejects.toBe(reason)
  })

  it('已取消的调用一个字节都不发：服务一次都不被碰（与出站请求同一条纪律）', async () => {
    const mock = mockSpeechService()
    const caller = new AbortController()
    caller.abort(new Error('出发前就废了'))

    await expect(normalizeSpeechSynthesis(mock.service)
      .synthesize({ text: '不会发生的合成' }, { signal: caller.signal })).rejects.toBeTruthy()
    expect(mock.requests, '取消了还发等于说谎').toHaveLength(0)
  })

  it('宿主服务永不落定：到死线按 TTS_UPSTREAM 拒绝，并把这一发的取消位一起落下去', async () => {
    vi.useFakeTimers()
    try {
      // 卡住的服务：synthesize 交出永不落定的 promise（HTTP 支有 fetcher 的请求超时，这里没有）
      let stuckSignal: AbortSignal | undefined
      const stuck: SpeechSynthesisService = {
        ...mockSpeechService().service,
        synthesize: (request) => {
          stuckSignal = request.signal
          return new Promise<never>(() => {})
        },
      }
      const pending = normalizeSpeechSynthesis(stuck).synthesize({ text: '卡住的一段', rate: 1 })
      let state = 'pending'
      void pending.then(() => { state = 'resolved' }, () => { state = 'rejected' })

      await vi.advanceTimersByTimeAsync(CORDIS_SYNTHESIS_TIMEOUT_MS - 1)
      expect(state, '死线之前不该落定').toBe('pending')
      expect(stuckSignal?.aborted, '死线之前不该中止服务那一侧').toBe(false)

      await vi.advanceTimersByTimeAsync(1)
      await expect(pending).rejects.toMatchObject({
        name: 'TtsSynthesisError',
        code: 'TTS_UPSTREAM',
      })
      await expect(pending).rejects.toThrow(String(CORDIS_SYNTHESIS_TIMEOUT_MS))
      // 本地死线之外还要把取消递到服务手里：否则我们只是不等了，上游照样把整段念完并计费
      expect(stuckSignal?.aborted, '死线到点要连带中止服务那一侧').toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('cordis 源经 TtsService：源清单与合成分流', () => {
  it('有效供应商未就绪（没配密钥）：清单不列这一行，健康读数点名原因，合成按具名不可用失败', async () => {
    const caps: SpeechCapabilities = {
      provider: 'xiaomi',
      formats: ['wav', 'mp3'],
      providers: [providerCapabilities({
        id: 'xiaomi', model: 'mimo-v2', voiceRate: false, voices: VOICES,
        configured: false, ready: false, unavailableReason: 'api-key-not-configured',
      })],
    }
    const mock = mockSpeechService({ capabilities: caps })
    const svc = await serviceWith(() => normalizeSpeechSynthesis(mock.service))

    expect(svc.sources().some((s) => s.kind === 'cordis'), '清单承诺只列此刻可用的源').toBe(false)
    expect(svc.sourcesView().hostSpeech).toEqual({ state: 'not-ready', reason: 'api-key-not-configured' })

    const err = await rejectionOf(() => svc.synthesize({ engineId: CORDIS_ENGINE_ID, text: '一段', rate: 1 }))
    expect(err.code).toBe('TTS_ENGINE_UNAVAILABLE')
    expect(err.message, '原因码要跟着进消息，读的人才有的放矢').toContain('api-key-not-configured')
    expect(mock.requests, '未就绪不该先把请求打到服务').toHaveLength(0)
  })

  it('能力清单里读不出有效供应商 → 按不可用处理（缺读不是可用），但不编一个原因码', async () => {
    const caps: SpeechCapabilities = { provider: 'xiaomi', formats: ['wav'], providers: [] }
    const svc = await serviceWith(() => normalizeSpeechSynthesis(mockSpeechService({ capabilities: caps }).service))
    expect(svc.sourcesView().hostSpeech).toEqual({ state: 'not-ready' })
    const err = await rejectionOf(() => svc.synthesize({ engineId: CORDIS_ENGINE_ID, text: '一段', rate: 1 }))
    expect(err.code).toBe('TTS_ENGINE_UNAVAILABLE')
  })

  it('就绪报 ready、服务不在场报 absent：两件事不折叠成同一个读数', async () => {
    const live = await serviceWith(() => normalizeSpeechSynthesis(mockSpeechService().service))
    expect(live.sourcesView().hostSpeech).toEqual({ state: 'ready' })
    expect(live.sources().some((s) => s.kind === 'cordis')).toBe(true)

    const none = await serviceWith(() => undefined)
    expect(none.sourcesView().hostSpeech).toEqual({ state: 'absent' })
  })

  it('getter 返 undefined → sources() 无 cordis 行，cordis 合成抛 TTS_ENGINE_MISSING', async () => {
    const svc = await serviceWith(() => undefined)

    expect(svc.sources().some((s) => s.kind === 'cordis')).toBe(false)
    const err = await rejectionOf(() => svc.synthesize({ engineId: CORDIS_ENGINE_ID, text: '未缓存的一段', rate: 1 }))
    expect(err.code).toBe('TTS_ENGINE_MISSING')
  })

  it('服务读数抛错：只除名 cordis，内置 / 浏览器源仍在；在场读不出按未就绪报，不冒充没装', async () => {
    const warnings: string[] = []
    setLogSink({
      info: () => undefined,
      warn: (...args: unknown[]) => { warnings.push(args.map(String).join(' ')) },
      error: () => undefined,
    })
    try {
      const svc = await serviceWith(() => { throw new Error('capabilities boom') })
      expect(svc.sources().map((s) => s.kind), '一个可选服务失败不拖垮其余源')
        .toEqual(['builtin', 'browser'])
      // 「装了但读不出」与「没装」是两个主语：折叠成一个空会让用户去重装插件（ADR-0083）
      expect(svc.sourcesView().hostSpeech, '在场读不出 = 未就绪，不是缺席')
        .toEqual({ state: 'not-ready' })
      const err = await rejectionOf(() => svc.synthesize({
        engineId: CORDIS_ENGINE_ID, text: '服务读不出的一段', rate: 1,
      }))
      expect(err.code, '不是「引擎不存在」（那是 400），是此刻不可用').toBe('TTS_ENGINE_UNAVAILABLE')
      expect(warnings.some((line) => line.includes('宿主朗读服务读数失败')), '失败要留痕，不静默').toBe(true)
    } finally {
      setLogSink(console)
    }
  })

  it('getter 在场 → 源行带适配后的音色表；合成按映射后的请求走服务并落缓存', async () => {
    const mock = mockSpeechService()
    const svc = await serviceWith(() => normalizeSpeechSynthesis(mock.service))

    expect(must(svc.sources().find((s) => s.kind === 'cordis'), 'cordis 源')).toStrictEqual({
      id: CORDIS_ENGINE_ID,
      kind: 'cordis',
      voices: VOICES,
    })

    const receipt = await svc.synthesize({
      engineId: CORDIS_ENGINE_ID, text: '第一段', rate: 1.2, voice: 'female_0033_b',
    })
    expect(receipt.key).toMatch(/^[0-9a-f]{32}$/)
    expect(mock.requests.map(spokenOf)).toStrictEqual([{ text: '第一段', voice: 'female_0033_b' }])
    expectAllCancellable(mock.requests)
  })

  it('回执报出播放端要补的倍率：服务端念到它的上限，剩下的归播放端', async () => {
    const mock = mockSpeechService({ capabilities: doubaoCapabilities() })
    const svc = await serviceWith(() => normalizeSpeechSynthesis(mock.service))

    // 宿主只收 0.5–2：用户要的 3.0 里服务端负责 2.0，播放端补 1.5（旧行为是悄悄停在 2.0）
    const fast = await svc.synthesize({ engineId: CORDIS_ENGINE_ID, text: '超出夹取的一段', rate: 3 })
    expect(pick(mock.requests, 0).voiceRate).toBe(2)
    expect(fast.playbackRate).toBeCloseTo(1.5)

    const within = await svc.synthesize({ engineId: CORDIS_ENGINE_ID, text: '范围内的一段', rate: 1.4 })
    expect(pick(mock.requests, 1).voiceRate).toBe(1.4)
    expect(within.playbackRate, '服务端全做到了就不许再补').toBe(1)
  })

  it('服务端没有语速参数（小米 / 外部接管）：整段语速由播放端补', async () => {
    const mock = mockSpeechService()
    const svc = await serviceWith(() => normalizeSpeechSynthesis(mock.service))

    const slow = await svc.synthesize({ engineId: CORDIS_ENGINE_ID, text: '慢一点', rate: 0.8 })
    expect(pick(mock.requests, 0).voiceRate, '不支持时整字段缺席').toBeUndefined()
    expect(slow.playbackRate).toBeCloseTo(0.8)

    const plain = await svc.synthesize({ engineId: CORDIS_ENGINE_ID, text: '原速', rate: 1 })
    expect(plain.playbackRate, '原速必须恰好是 1，不是 0.9999').toBe(1)
  })

  it('播放中服务卸装：源除名、下一段抛缺席；已缓存的段照常服务（缓存先于 getter）', async () => {
    const mock = mockSpeechService()
    // 与组合根同形：每次调用重查并重新归一（服务可能中途缺席）
    let live: SpeechSynthesisService | undefined = mock.service
    const svc = await serviceWith(() => (live === undefined ? undefined : normalizeSpeechSynthesis(live)))

    const first = await svc.synthesize({ engineId: CORDIS_ENGINE_ID, text: '已缓存的一段', rate: 1 })

    live = undefined
    expect(svc.sources().some((s) => s.kind === 'cordis')).toBe(false)
    const err = await rejectionOf(() => svc.synthesize({ engineId: CORDIS_ENGINE_ID, text: '另一段', rate: 1 }))
    expect(err.code).toBe('TTS_ENGINE_MISSING')

    // 缓存是既定事实：服务缺席不影响已合成过的段（播放层续播的腿）
    expect(await svc.synthesize({ engineId: CORDIS_ENGINE_ID, text: '已缓存的一段', rate: 1 })).toEqual(first)
    expect(mock.requests).toHaveLength(1)
  })
})

describe('跨插件类型的边界', () => {
  it('编译期：host-api 的 SpeechSynthesisService 可被 normalizeSpeechSynthesis 消费', () => {
    // 纯类型面断言：参数或返回形状漂移时 tsc 在这一行红，运行期什么也不发生
    const accepts: (svc: SpeechSynthesisService) => NormalizedSpeechSynthesis = normalizeSpeechSynthesis
    expect(typeof accepts).toBe('function')
  })

  it('适配器对 dsh-xiaomi-tts 只有 type-only import（运行时零依赖，构建期被擦除）', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../src/services/tts-cordis.ts', import.meta.url)), 'utf8')
    const imported = staticImportsOf(source).filter((i) => i.specifier.startsWith('dsh-xiaomi-tts'))
    expect(imported).toStrictEqual([{ specifier: 'dsh-xiaomi-tts/host-api', typeOnly: true }])
  })
})

/** 静态 import 的（specifier, 是否 type-only）清单：与 tests/layering.test.ts 同一判读法。 */
function staticImportsOf(source: string): { specifier: string; typeOnly: boolean }[] {
  const file = ts.createSourceFile('tts-cordis.ts', source, ts.ScriptTarget.Latest, true)
  return file.statements.filter(ts.isImportDeclaration).map((d) => ({
    specifier: ts.isStringLiteral(d.moduleSpecifier) ? d.moduleSpecifier.text : '',
    typeOnly: d.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword,
  }))
}
