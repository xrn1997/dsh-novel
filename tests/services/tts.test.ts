import { describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { buffer } from 'node:stream/consumers'
import { FetchError } from '../../src/services/errors.js'
import type { FetchedPage, FetchInit, Fetcher } from '../../src/services/fetcher.js'
import { UnsupportedRuleError } from '../../src/engine/errors.js'
import { TtsAudioCache } from '../../src/services/tts-cache.js'
import { TtsEngineRegistry } from '../../src/services/tts-engines.js'
import { TtsSynthesisError } from '../../src/services/errors.js'
import { BUILTIN_TTS_ENGINES, TTS_AUDIO_MAX_BYTES, TtsService } from '../../src/services/tts.js'
import type { NormalizedSpeechSynthesis, TtsServiceDeps } from '../../src/services/tts.js'
import { makeTempDir, trackService } from '../temp-dir.js'
import { must, pick } from '../support/fixture.js'

/**
 * 合成服务：缓存命中 → 回执；未命中 → 内置/注册表 HTTP 引擎或 cordis 服务 → 音频字节 → 入缓存。
 * 所有用例的 fetcher 都是计调用的桩，没有一个字节出网。
 */

type FetchCall = { url: string; init: FetchInit | undefined }

function mockFetcher(respond: (call: FetchCall) => FetchedPage | Error): { fetcher: Fetcher; calls: FetchCall[] } {
  const calls: FetchCall[] = []
  const fetcher: Fetcher = {
    async fetchPage(url, init) {
      const call = { url, init }
      calls.push(call)
      const out = respond(call)
      if (out instanceof Error) throw out
      return out
    },
  }
  return { fetcher, calls }
}

function pageOf(raw: Buffer, contentType: string): FetchedPage {
  return {
    raw,
    finalUrl: 'http://tts.baidu.com/text2audio',
    contentType,
    charset: undefined,
    status: 200,
    setCookie: [],
  }
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

interface Setup {
  dir: string
  engines: TtsEngineRegistry
  svc: TtsService
}

async function setup(opts: {
  fetcher: Fetcher
  speechSynthesis?: () => NormalizedSpeechSynthesis | undefined
}): Promise<Setup> {
  const dir = await makeTempDir('novel-tts-')
  const engines = trackService(await TtsEngineRegistry.load(dir))
  const svc = new TtsService({
    // 与 reading.ts 的 create 同形：缓存实例在装配处注入，路径与容量上限不在依赖面
    cache: new TtsAudioCache(path.join(dir, 'cache', 'tts'), 10_000_000),
    engines,
    fetcher: opts.fetcher,
    jsTimeoutMs: 2_000,
    speechSynthesis: opts.speechSynthesis ?? (() => undefined),
  })
  return { dir, engines, svc }
}

const WAV = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x01])

describe('TtsService 合成与缓存', () => {
  it('内置百度引擎：请求走百度翻译合成口，音频入缓存；同参重放命中缓存不发请求', async () => {
    const mock = mockFetcher(() => pageOf(WAV, 'audio/mpeg'))
    const { dir, svc } = await setup({ fetcher: mock.fetcher })

    const first = await svc.synthesize({ engineId: 'builtin:baidu', text: '你好，世界', rate: 1 })
    expect(first.key).toMatch(/^[0-9a-f]{32}$/)

    const call = pick(mock.calls, 0)
    expect(call.url).toBe('https://fanyi.baidu.com/gettts?lan=zh&text=%E4%BD%A0%E5%A5%BD%EF%BC%8C%E4%B8%96%E7%95%8C&spd=5&source=web')
    expect(call.init?.method).toBeUndefined()
    expect(call.init?.body).toBeUndefined()

    // 缓存住数据根的 cache/tts 下（与 PageCache 的 cache/toc、cache/content 并列）
    expect(await fs.readFile(path.join(dir, 'cache', 'tts', `${first.key}.bin`))).toEqual(WAV)

    const second = await svc.synthesize({ engineId: 'builtin:baidu', text: '你好，世界', rate: 1 })
    expect(second).toEqual(first)
    expect(mock.calls).toHaveLength(1)

    const res = must(await svc.openAudio(first.key), '音频读口')
    expect(res.mediaType).toBe('audio/mpeg')
    expect(res.bytes).toBe(WAV.length)
    expect(await buffer(res.stream)).toEqual(WAV)
  })

  it('百度口：换 rate 是另一段请求（spd 是键材料，只收 1–7 整数档）', async () => {
    const mock = mockFetcher(() => pageOf(WAV, 'audio/mpeg'))
    const { svc } = await setup({ fetcher: mock.fetcher })
    const normal = await svc.synthesize({ engineId: 'builtin:baidu', text: '你好，世界', rate: 1 })
    const fast = await svc.synthesize({ engineId: 'builtin:baidu', text: '你好，世界', rate: 2 })
    expect(fast.key).not.toBe(normal.key)
    expect(mock.calls).toHaveLength(2)
    expect(pick(mock.calls, 1).url).toContain('&spd=6&')
  })

  it('语速映射落在百度口收的 1–7 整数档', async () => {
    const mock = mockFetcher(() => pageOf(WAV, 'audio/mpeg'))
    const { svc } = await setup({ fetcher: mock.fetcher })
    for (const rate of [0.5, 0.8, 1.2, 1.5, 3]) {
      await svc.synthesize({ engineId: 'builtin:baidu', text: '你好', rate })
    }
    const spds = mock.calls.map((call) => Number(new URL(call.url).searchParams.get('spd')))
    // rate 1 → 5 钉在中点；低速半段用满 1–4，高速半段用 5–7。
    expect(spds).toEqual([1, 3, 5, 6, 7])
    expect(spds.every((n) => Number.isInteger(n) && n >= 1 && n <= 7)).toBe(true)
  })

  it('同 spd 档内的语速共用缓存键：请求没变就不重复合成', async () => {
    const mock = mockFetcher(() => pageOf(WAV, 'audio/mpeg'))
    const { svc } = await setup({ fetcher: mock.fetcher })
    const a = await svc.synthesize({ engineId: 'builtin:baidu', text: '你好', rate: 1 })
    const b = await svc.synthesize({ engineId: 'builtin:baidu', text: '你好', rate: 1.1 })
    expect(b.key).toBe(a.key)
    expect(mock.calls).toHaveLength(1)
  })

  it('内置引擎不消费音色：模板里没有 speakVoice，换音色不改实际请求、不换键、不重复合成', async () => {
    const mock = mockFetcher(() => pageOf(WAV, 'audio/mpeg'))
    const { svc } = await setup({ fetcher: mock.fetcher })
    const female = await svc.synthesize({ engineId: 'builtin:baidu', text: '你好', rate: 1 })
    const male = await svc.synthesize({ engineId: 'builtin:baidu', text: '你好', rate: 1, voice: '1' })
    // 缓存键按**实际请求**算（ADR-0069）：端点不读音色，请求就没变，旧字节即答案。
    expect(male.key).toBe(female.key)
    expect(mock.calls).toHaveLength(1)
    expect(pick(mock.calls, 0).url).not.toContain('per=')
  })

  it('identity 变化 ⟺ 实际请求变化：POST body 随语速变 → 换键并重新合成', async () => {
    const mock = mockFetcher(() => pageOf(WAV, 'audio/mpeg'))
    const { engines, svc } = await setup({ fetcher: mock.fetcher })
    engines.put('http:post', {
      name: 'POST 体',
      url: 'http://x.test/tts,{"method":"POST","body":"spd={{String(speakSpeed)}}&t={{java.encodeURI(speakText)}}"}',
      contentType: 'audio/mpeg',
    })
    const slow = await svc.synthesize({ engineId: 'http:post', text: '你好', rate: 1 })
    const fast = await svc.synthesize({ engineId: 'http:post', text: '你好', rate: 3 })
    // URL 同一个，两次请求只差 body：body 是键材料（method/url/body 那一位）
    expect(fast.key).not.toBe(slow.key)
    expect(mock.calls).toHaveLength(2)
    expect(pick(mock.calls, 0).init?.body).toBe('spd=5&t=%E4%BD%A0%E5%A5%BD')
    expect(pick(mock.calls, 1).init?.body).toBe('spd=25&t=%E4%BD%A0%E5%A5%BD')
  })

  it('静态 header 变更 identity 不变（ADR-0069 钉住现状：headers 不入键，将来不许顺手加进去）', async () => {
    const mock = mockFetcher(() => pageOf(WAV, 'audio/mpeg'))
    const { engines, svc } = await setup({ fetcher: mock.fetcher })
    const url = 'http://x.test/tts?t={{speakText}}'
    engines.put('http:hdr', { name: '静态头', url, contentType: 'audio/mpeg', header: '{"X-Api-Key":"K-1"}' })
    const first = await svc.synthesize({ engineId: 'http:hdr', text: '你好', rate: 1 })

    // 同一引擎换静态头：出站请求的头变了，键材料（method/url/body）没变 → 同一段缓存照常命中
    engines.put('http:hdr', { name: '静态头', url, contentType: 'audio/mpeg', header: '{"X-Api-Key":"K-2"}' })
    const second = await svc.synthesize({ engineId: 'http:hdr', text: '你好', rate: 1 })
    expect(second).toEqual(first)
    expect(mock.calls).toHaveLength(1)

    // 不入键 ≠ 不发：换个正文走未命中，断言出站带的已是新头
    const miss = await svc.synthesize({ engineId: 'http:hdr', text: '另一段', rate: 1 })
    expect(miss.key).not.toBe(first.key)
    expect(pick(mock.calls, 1).init?.headers?.['X-Api-Key']).toBe('K-2')
  })

  it('求值失败先于缓存命中：同参改坏模板后，旧字节不许冒充可用', async () => {
    const mock = mockFetcher(() => pageOf(WAV, 'audio/mpeg'))
    const { engines, svc } = await setup({ fetcher: mock.fetcher })
    engines.put('http:eval', { name: '先求值', url: 'http://x.test/tts?t={{speakText}}', contentType: 'audio/mpeg' })
    await svc.synthesize({ engineId: 'http:eval', text: '你好', rate: 1 })

    // 相对地址 = 坏配置（HttpTTS 没有可解析基准）：计划必须在查缓存之前就炸
    engines.put('http:eval', { name: '先求值', url: '/tts?t={{speakText}}', contentType: 'audio/mpeg' })
    await expect(svc.synthesize({ engineId: 'http:eval', text: '你好', rate: 1 })).rejects.toThrow(UnsupportedRuleError)
    expect(mock.calls).toHaveLength(1)  // 既没发新请求，也没把缓存里的旧回执端出来
  })

  it('cordis identity 随 voice / rate 变：键材料就是发给服务的那份参数', async () => {
    const speechCalls: Array<{ text: string; voice?: string; rate?: number }> = []
    const speech: NormalizedSpeechSynthesis = {
      ready: true,
      async synthesize(req) {
        speechCalls.push(req)
        return { data: Buffer.from([9, 9]), contentType: 'audio/mpeg', appliedRate: 1 }
      },
    }
    const { svc } = await setup({
      fetcher: mockFetcher(() => pageOf(WAV, 'audio/wav')).fetcher,
      speechSynthesis: () => speech,
    })

    const base = await svc.synthesize({ engineId: 'cordis:speechSynthesis', text: '你好', rate: 1, voice: 'v1' })
    const otherVoice = await svc.synthesize({ engineId: 'cordis:speechSynthesis', text: '你好', rate: 1, voice: 'v2' })
    const otherRate = await svc.synthesize({ engineId: 'cordis:speechSynthesis', text: '你好', rate: 1.2, voice: 'v1' })
    expect(otherVoice.key).not.toBe(base.key)
    expect(otherRate.key).not.toBe(base.key)
    expect(speechCalls).toHaveLength(3)  // 三个键各合成一次，没被互相吞掉
  })

  it('编译期：缓存由装配处注入——dir / cacheMaxBytes 不在 TtsServiceDeps 的依赖面', () => {
    // 若这两个键回流，下面的类型从 true 塌成 never，tsc 直接红（构造处改签名是机械的，依赖面不是）
    type Injected = Extract<keyof TtsServiceDeps, 'dir' | 'cacheMaxBytes'> extends never ? true : never
    const injected: Injected = true
    expect(injected).toBe(true)
  })

  it('订阅引擎消费 speakVoice：换音色改请求、换键并重新合成', async () => {
    const mock = mockFetcher(() => pageOf(WAV, 'audio/mpeg'))
    const { engines, svc } = await setup({ fetcher: mock.fetcher })
    engines.put('http:voice', {
      name: '带音色', url: 'http://x.test/tts?t={{java.encodeURI(speakText)}}&p={{speakVoice}}',
      contentType: 'audio/mpeg',
    })
    const plain = await svc.synthesize({ engineId: 'http:voice', text: '你好', rate: 1 })
    const male = await svc.synthesize({ engineId: 'http:voice', text: '你好', rate: 1, voice: '1' })
    expect(male.key).not.toBe(plain.key)
    expect(mock.calls).toHaveLength(2)
    expect(pick(mock.calls, 1).url).toContain('&p=1')
  })

  it('注册表引擎按 id 取用；未知 id → TTS_ENGINE_MISSING 且不触网', async () => {
    const mock = mockFetcher(() => pageOf(Buffer.from([1, 2, 3]), 'audio/mpeg'))
    const { engines, svc } = await setup({ fetcher: mock.fetcher })
    engines.put('http:1', { name: '甲', url: 'http://x.test/tts?t={{speakText}}', contentType: 'audio/mpeg' })

    await svc.synthesize({ engineId: 'http:1', text: '你好', rate: 1 })
    expect(pick(mock.calls, 0).url).toBe('http://x.test/tts?t=%E4%BD%A0%E5%A5%BD')

    const missing = await rejectionOf(() => svc.synthesize({ engineId: 'http:404', text: '你好', rate: 1 }))
    expect(missing.code).toBe('TTS_ENGINE_MISSING')
    expect(missing.message).toContain('http:404')
    expect(mock.calls).toHaveLength(1)
  })

  it('上游 JSON 错误页 → TTS_BAD_RESPONSE，留上游原话，不写缓存', async () => {
    const mock = mockFetcher(() => pageOf(Buffer.from('{"error":"无效的 token"}'), 'application/json; charset=utf-8'))
    const { dir, svc } = await setup({ fetcher: mock.fetcher })

    const err = await rejectionOf(() => svc.synthesize({ engineId: 'builtin:baidu', text: '你好', rate: 1 }))
    expect(err.code).toBe('TTS_BAD_RESPONSE')
    expect(err.message).toContain('无效的 token')
    await expect(fs.readdir(path.join(dir, 'cache', 'tts'))).rejects.toThrow()

    // 不缓存：同参再来一次仍要重新请求
    const again = await rejectionOf(() => svc.synthesize({ engineId: 'builtin:baidu', text: '你好', rate: 1 }))
    expect(again.code).toBe('TTS_BAD_RESPONSE')
    expect(mock.calls).toHaveLength(2)
  })

  it('上游 200 但 0 字节音频 → TTS_BAD_RESPONSE，不落缓存（否则那段永久静默）', async () => {
    const mock = mockFetcher(() => pageOf(Buffer.alloc(0), 'audio/mpeg'))
    const { dir, svc } = await setup({ fetcher: mock.fetcher })

    const err = await rejectionOf(() => svc.synthesize({ engineId: 'builtin:baidu', text: '你好', rate: 1 }))
    expect(err.code).toBe('TTS_BAD_RESPONSE')
    expect(err.message).toContain('0 字节')
    await expect(fs.readdir(path.join(dir, 'cache', 'tts'))).rejects.toThrow()

    // 没有「清缓存」入口（ADR-0068）：入缓存前挡住才修得好，同参再来一次仍要重新请求
    const again = await rejectionOf(() => svc.synthesize({ engineId: 'builtin:baidu', text: '你好', rate: 1 }))
    expect(again.code).toBe('TTS_BAD_RESPONSE')
    expect(mock.calls).toHaveLength(2)
  })

  it('引擎请求失败 → TTS_UPSTREAM（上游错误类型不外泄给路由面）', async () => {
    const url = 'http://tts.baidu.com/text2audio'
    const mock = mockFetcher(() => new FetchError(`请求失败 500: ${url}`, { url, status: 500 }))
    const { svc } = await setup({ fetcher: mock.fetcher })
    const err = await rejectionOf(() => svc.synthesize({ engineId: 'builtin:baidu', text: '你好', rate: 1 }))
    expect(err.code).toBe('TTS_UPSTREAM')
    expect(err.message).toContain('百度')
    expect(err.message).toContain('500')
  })

  it('上游失败原话不回显求值后的 URL：模板把 loginInfo 求进地址，消息只留状态事实', async () => {
    const token = 'SECRET-LOGIN-TOKEN-7f2a'
    // fetcher 的原话与 TTS 请求面走的是同一个串：失败消息里的地址就是这次真发出去的那个
    const mock = mockFetcher((call) => new FetchError(`请求失败 500: ${call.url}`, { url: call.url, status: 500 }))
    const { engines, svc } = await setup({ fetcher: mock.fetcher })
    engines.put('http:auth', {
      name: '带凭据',
      url: 'http://x.test/tts?token={{source.getLoginInfoMap().get("appkey")}}',
      contentType: 'audio/mpeg',
      auth: { cookies: {}, loginInfo: { appkey: token } },
    })

    const err = await rejectionOf(() => svc.synthesize({ engineId: 'http:auth', text: '你好', rate: 1 }))
    expect(err.code).toBe('TTS_UPSTREAM')
    // 先自证泄漏面存在：凭据确实被求值进了这次请求的地址（否则下面那条断言测不到东西）
    expect(must(mock.calls[0], '上游请求').url).toContain(token)
    expect(err.message, '错误消息不是凭据的新读口').not.toContain(token)
    expect(err.message, '可行动的状态事实照留').toContain('500')
  })

  it('合成响应的字节上限随请求下传：外部订阅回大二进制时在读进内存之前就被拦下', async () => {
    const mock = mockFetcher(() => pageOf(WAV, 'audio/mpeg'))
    const { svc } = await setup({ fetcher: mock.fetcher })
    await svc.synthesize({ engineId: 'builtin:baidu', text: '你好', rate: 1 })
    expect(pick(mock.calls, 0).init?.maxBytes).toBe(TTS_AUDIO_MAX_BYTES)
  })

  it('超限响应按上游失败报（502），原话带上限值、不落缓存', async () => {
    const url = 'http://x.test/tts'
    const mock = mockFetcher(() => new FetchError(
      `响应超过大小上限 ${TTS_AUDIO_MAX_BYTES} 字节: ${url}`, { url, status: 200 }))
    const { dir, svc } = await setup({ fetcher: mock.fetcher })
    const err = await rejectionOf(() => svc.synthesize({ engineId: 'builtin:baidu', text: '你好', rate: 1 }))
    expect(err.code).toBe('TTS_UPSTREAM')
    expect(err.message).toContain(String(TTS_AUDIO_MAX_BYTES))
    await expect(fs.readdir(path.join(dir, 'cache', 'tts'))).rejects.toThrow()
  })

  it('取消位下传到抓取层：已取消的调用一个出站请求都不发，在途取消不冒充上游失败', async () => {
    const reason = new Error('这一段不要了')
    let seenSignal: AbortSignal | undefined
    const calls: string[] = []
    const fetcher: Fetcher = {
      // 与真实抓取层同一条纪律：认取消位，中止时抛 signal.reason（不是 FetchError、不是超时）
      fetchPage: (url, init) => {
        calls.push(url)
        seenSignal = init?.signal
        const signal = init?.signal
        return new Promise<never>((_, reject) => {
          if (signal === undefined) return
          signal.addEventListener('abort', () => {
            const reason: unknown = signal.reason
            reject(reason instanceof Error ? reason : new Error(String(reason)))
          }, { once: true })
        })
      },
    }
    const { svc } = await setup({ fetcher })

    const caller = new AbortController()
    const pending = svc.synthesize(
      { engineId: 'builtin:baidu', text: '在途的一段', rate: 1 }, { signal: caller.signal })
    // 求值有 await（模板链），等那一发真出去再判取消位
    await vi.waitFor(() => { expect(seenSignal, '请求应已发出').toBeDefined() })
    expect(seenSignal?.aborted, '发出时还不该中止').toBe(false)
    caller.abort(reason)
    expect(seenSignal?.aborted, '取消要落到那一发请求的取消位上').toBe(true)
    // 一次作废不是上游失败：错误信封与连败计数都不该收到它当证据
    await expect(pending).rejects.toBe(reason)

    // 出发前就废了：一个请求都不发（合成有副作用，取消了还发等于说谎）
    const done = new AbortController()
    done.abort(reason)
    await expect(svc.synthesize(
      { engineId: 'builtin:baidu', text: '不会发生的合成', rate: 1 }, { signal: done.signal })).rejects.toBe(reason)
    expect(calls, '已取消的调用不该发出站请求').toHaveLength(1)
  })

  it('取消理由的类型纪律：非 Error 的 reason 也包成 Error，原话不丢，且不算上游失败', async () => {
    const mock = mockFetcher(() => pageOf(WAV, 'audio/mpeg'))
    const { svc } = await setup({ fetcher: mock.fetcher })

    // 规范允许 abort(reason) 收任何值：上层只认 Error，出口这一层负责收口
    const before = new AbortController()
    before.abort('用户按了停止')
    let err: unknown = null
    try {
      await svc.synthesize({ engineId: 'builtin:baidu', text: '出发前就废了', rate: 1 }, { signal: before.signal })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message, '原话不丢').toBe('用户按了停止')
    expect(err, '取消不包成 TTS_UPSTREAM').not.toBeInstanceOf(TtsSynthesisError)
    expect(mock.calls, '已取消的调用一个请求都不发').toHaveLength(0)
  })

  it('cordis 支的取消同样是作废：抛调用方给的理由，不借服务自己的错误、也不包成上游失败', async () => {
    let seen: AbortSignal | undefined
    const speech: NormalizedSpeechSynthesis = {
      ready: true,
      synthesize: (_req, opts) => {
        seen = opts?.signal
        const signal = opts?.signal
        return new Promise((_resolve, reject) => {
          // 服务那一侧被取消时也拒绝了：这一段文本不该被借用
          signal?.addEventListener('abort', () => reject(new Error('服务侧的说法')), { once: true })
        })
      },
    }
    const { svc } = await setup({
      fetcher: mockFetcher(() => pageOf(WAV, 'audio/wav')).fetcher,
      speechSynthesis: () => speech,
    })
    const reason = new Error('这一段不要了')
    const caller = new AbortController()
    const pending = svc.synthesize(
      { engineId: 'cordis:speechSynthesis', text: '在途的一段', rate: 1 }, { signal: caller.signal })
    await vi.waitFor(() => { expect(seen, '请求应已交给服务').toBeDefined() })
    caller.abort(reason)
    await expect(pending).rejects.toBe(reason)
  })

  it('回执报告播放端要补的倍率：模板消费 speakSpeed → 1；不消费 → 整段语速归播放端', async () => {
    const mock = mockFetcher(() => pageOf(WAV, 'audio/mpeg'))
    const { engines, svc } = await setup({ fetcher: mock.fetcher })
    // 内置百度口：模板里写着 spd={{…speakSpeed…}}，语速是引擎念的
    const builtin = await svc.synthesize({ engineId: 'builtin:baidu', text: '引擎自己念快', rate: 1.7 })
    expect(builtin.playbackRate, '字节里已掺了语速，播放端不许再乘一遍').toBe(1)

    // 订阅引擎不写 speakSpeed：这一发请求里根本没有语速这件事，倍率只能由播放端补
    engines.put('http:flat', { name: '不吃语速', url: 'http://x.test/say?text={{speakText}}', contentType: 'audio/mpeg' })
    const flat = await svc.synthesize({ engineId: 'http:flat', text: '没人念快', rate: 1.7 })
    expect(flat.playbackRate).toBeCloseTo(1.7)
    expect(flat.key).not.toBe(builtin.key)
  })

  it('同一份字节跨倍率重放：补速按这次的请求算，不按第一次写下的那一格（ADR-0081 的不变式）', async () => {
    const mock = mockFetcher(() => pageOf(WAV, 'audio/mpeg'))
    const { engines, svc } = await setup({ fetcher: mock.fetcher })
    engines.put('http:flat', { name: '不吃语速', url: 'http://x.test/say?text={{speakText}}', contentType: 'audio/mpeg' })

    const slow = await svc.synthesize({ engineId: 'http:flat', text: '重放的一段', rate: 1 })
    const fast = await svc.synthesize({ engineId: 'http:flat', text: '重放的一段', rate: 2.4 })
    // 模板不消费语速：请求没变，键也就没变——同一份字节要按新倍率重新算差额
    expect(fast.key).toBe(slow.key)
    expect(slow.playbackRate).toBe(1)
    expect(fast.playbackRate, '拖了滑杆就得按新倍率补，命中的旧回执不许冒充').toBeCloseTo(2.4)
    expect(mock.calls, '换倍率不重新合成：滑杆从「重合成一章」变成「立即生效」').toHaveLength(1)

    const back = await svc.synthesize({ engineId: 'http:flat', text: '重放的一段', rate: 1 })
    expect(back.playbackRate, '回到原速就是 1，不是残留的 2.4').toBe(1)
    expect(mock.calls).toHaveLength(1)
  })

  it('openAudio：未知/非法键 → null', async () => {
    const { svc } = await setup({ fetcher: mockFetcher(() => pageOf(WAV, 'audio/wav')).fetcher })
    expect(await svc.openAudio('f'.repeat(32))).toBeNull()
    expect(await svc.openAudio('../../shelf.json')).toBeNull()
  })
})

describe('TtsService sources()', () => {
  it('内置 + 浏览器直出 + 注册表引擎；cordis 缺席不列', async () => {
    const { engines, svc } = await setup({ fetcher: mockFetcher(() => pageOf(WAV, 'audio/wav')).fetcher })
    engines.put('http:1', { name: '甲', url: 'http://x.test/tts' })
    const sources = svc.sources()
    // 展示名只属于订阅数据：http 行带订阅名；插件自有源（内置/浏览器）不带 name（归 client 文案）。
    // 内置行也不带 voices：端点不读音色（见 `BUILTIN_TTS_ENGINES` 的实测注），界面因此不渲染音色行。
    expect(sources).toStrictEqual([
      { id: 'builtin:baidu', kind: 'builtin' },
      { id: 'browser:local', kind: 'browser' },
      { id: 'http:1', name: '甲', kind: 'http' },
    ])
    expect(sources.filter((s) => s.kind !== 'http').every((s) => !('name' in s))).toBe(true)
    expect(BUILTIN_TTS_ENGINES).toHaveLength(1)
    expect(pick(BUILTIN_TTS_ENGINES, 0).id).toBe('builtin:baidu')
  })

  it('cordis 源：在场时列出音色表并走 getter 合成；卸装后除名、未缓存段缺席', async () => {
    const speechCalls: Array<{ text: string; voice?: string; rate?: number }> = []
    const speech: NormalizedSpeechSynthesis = {
      ready: true,
      voices: [{ id: 'v1', name: '音色一' }],
      async synthesize(req) {
        speechCalls.push(req)
        return { data: Buffer.from([9, 9]), contentType: 'audio/mpeg', appliedRate: 1 }
      },
    }
    let current: NormalizedSpeechSynthesis | undefined = speech
    const { svc } = await setup({
      fetcher: mockFetcher(() => pageOf(WAV, 'audio/wav')).fetcher,
      speechSynthesis: () => current,
    })

    // 音色名是服务数据，照实透传；源自身的展示名不落服务端（客户端按 kind/id 取词）。
    expect(must(svc.sources().find((s) => s.kind === 'cordis'), 'cordis 源')).toStrictEqual({
      id: 'cordis:speechSynthesis',
      kind: 'cordis',
      voices: [{ id: 'v1', name: '音色一' }],
    })

    const receipt = await svc.synthesize({ engineId: 'cordis:speechSynthesis', text: '你好', rate: 1.2, voice: 'v1' })
    expect(receipt.key).toMatch(/^[0-9a-f]{32}$/)
    expect(speechCalls).toEqual([{ text: '你好', rate: 1.2, voice: 'v1' }])

    // 同一段命中缓存，服务不再被调用
    await svc.synthesize({ engineId: 'cordis:speechSynthesis', text: '你好', rate: 1.2, voice: 'v1' })
    expect(speechCalls).toHaveLength(1)

    // 服务卸装：源列表除名；没缓存的段按 TTS_ENGINE_MISSING 失败（getter 每次调用重查）
    current = undefined
    expect(svc.sources().some((s) => s.kind === 'cordis')).toBe(false)
    const err = await rejectionOf(() => svc.synthesize({ engineId: 'cordis:speechSynthesis', text: '另一段', rate: 1 }))
    expect(err.code).toBe('TTS_ENGINE_MISSING')
  })
})
