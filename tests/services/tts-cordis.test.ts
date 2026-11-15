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

/** 一家供应商的能力声明：模型能力位（`voiceRate`）按用例给，音色表按需。 */
function providerCapabilities(opts: {
  id: SpeechProviderId
  model: string
  voiceRate: boolean
  voices?: { id: string; name: string }[]
}): SpeechProviderCapabilities {
  return {
    id: opts.id,
    configured: true,
    ready: true,
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

describe('normalizeSpeechSynthesis：host-api 契约 → 插件归一形状', () => {
  it('当前有效模型不支持 voiceRate（小米）：rate 不落成请求字段；text / voice 照映射，未给的字段不传', async () => {
    const mock = mockSpeechService()
    const normalized = normalizeSpeechSynthesis(mock.service)

    const out = await normalized.synthesize({ text: '你好，世界', voice: 'female_0033_b', rate: 1.2 })
    expect(out.data).toBe(AUDIO)
    expect(out.contentType).toBe('audio/wav')
    // 缺能力位时整个 voiceRate 字段缺席（不是发 1）；toStrictEqual 顺带钉住「一个字段都不许多」
    expect(mock.requests).toStrictEqual([{ text: '你好，世界', voice: 'female_0033_b' }])

    await normalized.synthesize({ text: '只有正文' })
    // 缺席的可选字段不落成 `voice: undefined`——host-api 的 exactOptional 口径同样只认缺席
    expect(pick(mock.requests, 1)).toStrictEqual({ text: '只有正文' })
  })

  it('当前有效模型支持 voiceRate（豆包风格）：按宿主契约 0.5–2 夹取，1.2 原样', async () => {
    const mock = mockSpeechService({ capabilities: doubaoCapabilities() })
    const normalized = normalizeSpeechSynthesis(mock.service)

    await normalized.synthesize({ text: '太快', rate: 2.5 })
    await normalized.synthesize({ text: '太慢', rate: 0.3 })
    await normalized.synthesize({ text: '原样', rate: 1.2 })
    expect(mock.requests).toStrictEqual([
      { text: '太快', voiceRate: 2 },
      { text: '太慢', voiceRate: 0.5 },
      { text: '原样', voiceRate: 1.2 },
    ])
  })

  it('外部接管（currentProvider 优先于 capabilities().provider）：voiceRate 整字段缺席', async () => {
    const mock = mockSpeechService({
      capabilities: externalTakeoverCapabilities(),
      currentProvider: () => 'external:test',
    })
    const normalized = normalizeSpeechSynthesis(mock.service)

    // capabilities().provider 是豆包（模型声明支持），但有效供应商被外部接管：契约一律拒 voiceRate
    await normalized.synthesize({ text: '接管', rate: 1.5 })
    expect(mock.requests).toStrictEqual([{ text: '接管' }])
  })

  it('能力位读不出（有效供应商 / 所选模型不在清单里）→ 按不支持处理，字段缺席', async () => {
    const missingProvider = mockSpeechService({
      capabilities: { ...doubaoCapabilities(), provider: 'breeze' },
    })
    await normalizeSpeechSynthesis(missingProvider.service).synthesize({ text: '缺供应商', rate: 1.2 })
    expect(missingProvider.requests).toStrictEqual([{ text: '缺供应商' }])

    const orphanModel = doubaoCapabilities()
    const missingModel = mockSpeechService({
      capabilities: {
        ...orphanModel,
        providers: orphanModel.providers.map((p) => ({ ...p, selectedModel: 'not-listed' })),
      },
    })
    await normalizeSpeechSynthesis(missingModel.service).synthesize({ text: '缺模型', rate: 1.2 })
    expect(missingModel.requests).toStrictEqual([{ text: '缺模型' }])
  })

  it('capabilities 的音色表进 voices；所选模型没有音色 → 缺席（UI 不渲染音色行）', () => {
    const mock = mockSpeechService()
    expect(normalizeSpeechSynthesis(mock.service).voices).toStrictEqual(VOICES)

    const bare = mockSpeechService({ capabilities: capabilitiesWith([]) })
    expect(normalizeSpeechSynthesis(bare.service).voices).toBeUndefined()
  })

  it('宿主服务永不落定：到死线按 TTS_UPSTREAM 拒绝（服务支没有请求超时，耐心只能自己定）', async () => {
    vi.useFakeTimers()
    try {
      // 卡住的服务：synthesize 交出永不落定的 promise（HTTP 支有 fetcher 的请求超时，这里没有）
      const stuck: SpeechSynthesisService = {
        ...mockSpeechService().service,
        synthesize: () => new Promise<never>(() => {}),
      }
      const pending = normalizeSpeechSynthesis(stuck).synthesize({ text: '卡住的一段', rate: 1 })
      let state = 'pending'
      void pending.then(() => { state = 'resolved' }, () => { state = 'rejected' })

      await vi.advanceTimersByTimeAsync(CORDIS_SYNTHESIS_TIMEOUT_MS - 1)
      expect(state, '死线之前不该落定').toBe('pending')

      await vi.advanceTimersByTimeAsync(1)
      await expect(pending).rejects.toMatchObject({
        name: 'TtsSynthesisError',
        code: 'TTS_UPSTREAM',
      })
      await expect(pending).rejects.toThrow(String(CORDIS_SYNTHESIS_TIMEOUT_MS))
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('cordis 源经 TtsService：源清单与合成分流', () => {
  it('getter 返 undefined → sources() 无 cordis 行，cordis 合成抛 TTS_ENGINE_MISSING', async () => {
    const svc = await serviceWith(() => undefined)

    expect(svc.sources().some((s) => s.kind === 'cordis')).toBe(false)
    const err = await rejectionOf(() => svc.synthesize({ engineId: CORDIS_ENGINE_ID, text: '未缓存的一段', rate: 1 }))
    expect(err.code).toBe('TTS_ENGINE_MISSING')
  })

  it('服务读数抛错：只除名 cordis，内置 / 浏览器源仍在；合成按缺席失败并留痕', async () => {
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
      const err = await rejectionOf(() => svc.synthesize({
        engineId: CORDIS_ENGINE_ID, text: '服务读不出的一段', rate: 1,
      }))
      expect(err.code).toBe('TTS_ENGINE_MISSING')
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
    expect(mock.requests).toStrictEqual([{ text: '第一段', voice: 'female_0033_b' }])
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
