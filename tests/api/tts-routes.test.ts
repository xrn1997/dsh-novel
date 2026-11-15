import { promises as fs } from 'node:fs'
import path from 'node:path'
import iconv from 'iconv-lite'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { ReadingService } from '../../src/services/reading.js'
import { setLogSink } from '../../src/services/log.js'
import { bodies, NOVEL_API_PREFIX, paramOps, ROUTES, ttsAudioUrl } from '../../src/shared/wire.js'
import { PLAY_UNIT_MAX } from '../../src/shared/chapter-text.js'
import type { TtsEngineImportReceipt, SynthesisReceipt, TtsEnginePublic, TtsSourcesView } from '../../src/shared/wire.js'
import { makeTempDir, trackService } from '../temp-dir.js'
import { must } from '../support/fixture.js'
import { errorOf, requestUrl, startServer, valueOf } from './helpers.js'

/**
 * 听书路由面：源清单 / 段合成 / 音频读口 / 引擎订阅 CRUD。
 * fetch 全部由计调用替身承接（零出网）；音频字节用一段 8 字节 WAV 头当内容事实。
 */

const WAV = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0x04, 0x00, 0x00, 0x00])
const BAIDU_TTS = 'https://fanyi.baidu.com/gettts'
const SUBSCRIPTION_URL = 'https://engines.example/list.json'
const GBK_SUBSCRIPTION_URL = 'https://engines.example/gbk.json'
const FAIL_URL = 'https://engines.example/fail'
const JSON_URL = 'https://engines.example/json'
const AUDIO_URL = 'https://tts.example/speak'
/** 慢引擎：只在中止时才落定（真实上游的合成可以跑到几十秒，这里不陪跑） */
const HANG_URL = 'https://tts.example/hang'
/** 模板会把登录态求值进查询串：上游收到的地址里带凭据，失败原话也就会带 */
const TOKEN_URL = 'https://tts.example/token'

type FetchCall = { url: string; init: RequestInit | undefined }
const calls: FetchCall[] = []

function pageOf(body: BodyInit, contentType: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': contentType } })
}

let svc: ReadingService, base: string, close: () => Promise<void>

beforeAll(async () => {
  const dir = await makeTempDir('novel-tts-api-')
  svc = trackService(await ReadingService.create({
    dir,
    fetchImpl: async (input, init) => {
      const url = requestUrl(input)
      calls.push({ url, init })
      if (url === HANG_URL) {
        // 与真 undici 同一条纪律：认取消位，中止时按取消理由落定（不认就测不到「上游停下」）
        const signal = init?.signal
        return new Promise<Response>((_, reject) => {
          if (signal === undefined || signal === null) return
          signal.addEventListener('abort', () => {
            const reason: unknown = signal.reason
            reject(reason instanceof Error ? reason : new Error(String(reason)))
          }, { once: true })
        })
      }
      if (url.startsWith(BAIDU_TTS) || url === AUDIO_URL) return pageOf(WAV, 'audio/mpeg')
      if (url === FAIL_URL || url.startsWith(TOKEN_URL)) return pageOf('upstream exploded', 'text/plain', 500)
      if (url === JSON_URL) return pageOf('{"error":"quota"}', 'application/json')
      if (url === SUBSCRIPTION_URL) {
        return pageOf(JSON.stringify([{ id: 'http:from-url', name: 'URL 订阅', url: AUDIO_URL }]), 'application/json')
      }
      if (url === GBK_SUBSCRIPTION_URL) {
        // GBK 编码的订阅：硬解 UTF-8 会得到乱码的引擎名与 URL 并「导入成功」
        return pageOf(
          Uint8Array.from(iconv.encode(JSON.stringify([{ id: 'http:gbk', name: '中文订阅', url: AUDIO_URL }]), 'gbk')),
          'application/json; charset=gbk',
        )
      }
      return pageOf('not found', 'text/plain', 404)
    },
  }))
  ;({ base, close } = await startServer(svc))
})
afterAll(async () => { await svc.flush(); await close() })

/** /novel-api 下的绝对地址（路径构造器不含前缀——前缀归 wire 单点） */
const at = (path: string): string => `${base}${NOVEL_API_PREFIX}/${path}`

async function send(path: string, method: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
  return fetch(at(path), {
    method,
    ...(signal === undefined ? {} : { signal }),
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  })
}

describe('听书源清单与合成', () => {
  it('GET tts/sources → 内置与浏览器直出恒在场（开箱即用的两行）', async () => {
    const list = (await valueOf<TtsSourcesView>(await fetch(at(ROUTES.ttsSources.path)))).sources
    expect(list.map((s) => s.id)).toEqual(['builtin:baidu', 'browser:local'])
    // 插件自有源不投展示名（名字归客户端文案单点）
    expect(list.some((s) => s.name !== undefined)).toBe(false)
  })

  it('POST tts/synthesize → 回执信封；上游请求带百度口的 lan/text/spd 形态', async () => {
    const receipt = await valueOf<SynthesisReceipt>(await send(
      ROUTES.ttsSynthesize.path, 'POST',
      bodies.ttsSynthesize({ engineId: 'builtin:baidu', text: '你好，世界', rate: 1 }),
    ))
    expect(receipt.key).toMatch(/^[0-9a-f]{32}$/)
    const call = calls.find((c) => c.url.startsWith(BAIDU_TTS))
    expect(call).toBeDefined()
    const url = new URL(call?.url ?? BAIDU_TTS)
    expect(url.searchParams.get('lan')).toBe('zh')
    expect(url.searchParams.get('text')).toBe('你好，世界')
    expect(url.searchParams.get('spd')).toBe('5')
  })

  it('GET tts/audio → 200 二进制：content-type / length / nosniff，字节与上游一致', async () => {
    const receipt = await valueOf<SynthesisReceipt>(await send(
      ROUTES.ttsSynthesize.path, 'POST',
      bodies.ttsSynthesize({ engineId: 'builtin:baidu', text: '第二段', rate: 1 }),
    ))
    const res = await fetch(`${base}${ttsAudioUrl(receipt.key)}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('audio/mpeg')
    expect(res.headers.get('content-length')).toBe(String(WAV.length))
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    // 读口按整份回，不支持分段：把口径写成头，别让浏览器一直试探 Range
    expect(res.headers.get('accept-ranges')).toBe('none')
    expect(Buffer.from(await res.arrayBuffer())).toEqual(Buffer.from(WAV))
  })

  it('未知 / 非法 key → 404 且发生在发头之前（不是空音频、也不是二进制头）', async () => {
    for (const key of ['0'.repeat(32), '../shelf']) {
      const res = await fetch(`${base}${ttsAudioUrl(key)}`)
      expect(res.status, key).toBe(404)
      expect(res.headers.get('content-type'), key).toContain('application/json')
      expect(res.headers.get('x-content-type-options'), key).toBeNull()
      expect((await errorOf(res)).code, key).toBe('NotFound')
    }
  })

  it('缺 key → 400；方法不对 → 405', async () => {
    expect((await fetch(at(ROUTES.ttsAudio.path))).status).toBe(400)
    expect((await send(ROUTES.ttsAudio.path, 'POST')).status).toBe(405)
  })
})

describe('引擎订阅 CRUD', () => {
  it('导入 JSON → 回执（坏条逐条剪除）；列表面板可读且不含凭据', async () => {
    const receipt = await valueOf<TtsEngineImportReceipt>(await send(
      ROUTES.ttsEnginesImport.path, 'POST',
      bodies.ttsEnginesImport({
        json: JSON.stringify([
          { id: 'http:alpha', name: '订阅一', url: AUDIO_URL },
          { nope: 1 },
        ]),
      }),
    ))
    expect(receipt).toMatchObject({ added: 1, updated: 0 })
    expect(receipt.failed).toHaveLength(1)
    expect(receipt.failed[0]?.index).toBe(1)

    const list = await valueOf<TtsEnginePublic[]>(await fetch(at(ROUTES.ttsEngines.path)))
    const row = list.find((e) => e.id === 'http:alpha')
    expect(row).toMatchObject({ name: '订阅一', url: AUDIO_URL, hasAuth: false })
    // 源清单里也出现（kind 是订阅引擎的展示分类，名字是订阅数据本身）
    const sources = (await valueOf<TtsSourcesView>(await fetch(at(ROUTES.ttsSources.path)))).sources
    expect(sources.find((s) => s.id === 'http:alpha')).toMatchObject({ kind: 'http', name: '订阅一' })
  })

  it('PUT tts/engines/:id：id 含 `:` 编码成段后仍命中；凭据只写不读', async () => {
    const target = paramOps.ttsEnginePut.at('http:alpha')
    expect(target.path).toBe('tts/engines/http%3Aalpha')
    const updated = await valueOf<TtsEnginePublic>(await send(target.path, target.method,
      bodies.ttsEnginePut({
        name: '订阅一改', url: AUDIO_URL, contentType: 'audio/mpeg',
        auth: { cookies: { sid: 'secret-cookie' }, loginInfo: { u: 'alice' } },
      })))
    expect(updated).toMatchObject({ id: 'http:alpha', name: '订阅一改', contentType: 'audio/mpeg', hasAuth: true })
    expect(JSON.stringify(updated)).not.toContain('secret-cookie')
    expect(JSON.stringify(updated)).not.toContain('alice')
  })

  it('DELETE tts/engines/:id → removed 布尔（幂等）', async () => {
    const target = paramOps.ttsEngineDelete.at('http:alpha')
    expect((await valueOf<{ removed: boolean }>(await send(target.path, target.method))).removed).toBe(true)
    expect((await valueOf<{ removed: boolean }>(await send(target.path, target.method))).removed).toBe(false)
  })

  it('GBK 编码的订阅按声明解码导入：引擎名与 URL 不留乱码', async () => {
    const receipt = await valueOf<TtsEngineImportReceipt>(await send(
      ROUTES.ttsEnginesImport.path, 'POST', bodies.ttsEnginesImport({ url: GBK_SUBSCRIPTION_URL }),
    ))
    expect(receipt).toMatchObject({ added: 1, failed: [] })
    const list = await valueOf<TtsEnginePublic[]>(await fetch(at(ROUTES.ttsEngines.path)))
    const gbk = list.find((e) => e.id === 'http:gbk')
    expect(gbk?.name).toBe('中文订阅')
    expect(gbk?.url).toBe(AUDIO_URL)
  })

  it('导入给 url 时经同一个组合根 fetcher 拉取（json 路不发请求）', async () => {
    const before = calls.length
    const receipt = await valueOf<TtsEngineImportReceipt>(await send(
      ROUTES.ttsEnginesImport.path, 'POST', bodies.ttsEnginesImport({ url: SUBSCRIPTION_URL }),
    ))
    expect(receipt).toMatchObject({ added: 1, updated: 0 })
    expect(calls.length).toBe(before + 1)
    expect(calls.at(-1)?.url).toBe(SUBSCRIPTION_URL)

    const list = await valueOf<TtsEnginePublic[]>(await fetch(at(ROUTES.ttsEngines.path)))
    expect(list.some((e) => e.id === 'http:from-url')).toBe(true)

    const quiet = calls.length
    const empty = await valueOf<TtsEngineImportReceipt>(await send(
      ROUTES.ttsEnginesImport.path, 'POST', bodies.ttsEnginesImport({ json: '[]' }),
    ))
    expect(empty).toEqual({ added: 0, updated: 0, failed: [] })
    expect(calls.length).toBe(quiet)
  })

  it('import 的 body 形状：json/url 必须恰一，url 必须是 http(s)', async () => {
    for (const body of [{}, { json: '[]', url: SUBSCRIPTION_URL }, { url: 'file:///etc/passwd' }]) {
      const res = await send(ROUTES.ttsEnginesImport.path, 'POST', body)
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect((await errorOf(res)).code).toBe('BadRequest')
    }
  })

  it('PUT 的 body 形状：缺 name/url → 400（值域归注册表，形状归 wire 读口）', async () => {
    const res = await send(paramOps.ttsEnginePut.path('http:shape'), 'PUT', { name: '只有名字' })
    expect(res.status).toBe(400)
    expect((await errorOf(res)).code).toBe('BadRequest')
  })

  it('PUT 的 voices 在场但形状不符 → 400（写口不静默丢用户刚提交的表）', async () => {
    const res = await send(paramOps.ttsEnginePut.path('http:voices-bad'), 'PUT', {
      name: '坏音色表', url: AUDIO_URL, voices: [{ id: 'v1' }],
    })
    expect(res.status).toBe(400)
    expect((await errorOf(res)).message).toContain('voices')
  })

  it('PUT 的 voices 空数组 = 清掉；导出/列表里不再带这张表', async () => {
    const put = await send(paramOps.ttsEnginePut.path('http:voices-clear'), 'PUT', {
      name: '清音色', url: AUDIO_URL, voices: [{ id: 'v1', name: '音色一' }],
    })
    expect(put.status).toBe(200)
    const cleared = await send(paramOps.ttsEnginePut.path('http:voices-clear'), 'PUT', {
      name: '清音色', url: AUDIO_URL, voices: [],
    })
    expect(cleared.status).toBe(200)
    const list = await valueOf<TtsEnginePublic[]>(await fetch(at(ROUTES.ttsEngines.path)))
    expect(list.find((e) => e.id === 'http:voices-clear')?.voices).toBeUndefined()
  })

  it('合成的值域门在门面：超长文本 / 越界语速 → 400（不是把上游打一发再失败）', async () => {
    const tooLong = await send(ROUTES.ttsSynthesize.path, 'POST',
      bodies.ttsSynthesize({ engineId: 'builtin:baidu', text: '字'.repeat(PLAY_UNIT_MAX + 1), rate: 1 }))
    expect(tooLong.status).toBe(400)
    expect((await errorOf(tooLong)).message).toContain(String(PLAY_UNIT_MAX))

    const badRate = await send(ROUTES.ttsSynthesize.path, 'POST',
      bodies.ttsSynthesize({ engineId: 'builtin:baidu', text: '你好', rate: 9 }))
    expect(badRate.status).toBe(400)
    expect((await errorOf(badRate)).message).toContain('语速')

    const blank = await send(ROUTES.ttsSynthesize.path, 'POST',
      bodies.ttsSynthesize({ engineId: 'builtin:baidu', text: '   ', rate: 1 }))
    expect(blank.status).toBe(400)
  })
})

describe('TtsSynthesisError → HTTP（不泄漏堆栈）', () => {
  it('引擎不存在 → 400 TTS_ENGINE_MISSING', async () => {
    const res = await send(ROUTES.ttsSynthesize.path, 'POST',
      bodies.ttsSynthesize({ engineId: 'builtin:nope', text: 'x', rate: 1 }))
    expect(res.status).toBe(400)
    const err = await errorOf(res)
    expect(err.code).toBe('TTS_ENGINE_MISSING')
    expect(err.message).toContain('朗读引擎不存在')
    expect(err).not.toHaveProperty('stack')
    expect(err.message).not.toContain('    at ')
  })

  it('客户端断连 → 中止在途合成：上游那一发拿到取消，断连的响应不写错误信封', async () => {
    const put = await send(paramOps.ttsEnginePut.path('http:hang'), 'PUT',
      bodies.ttsEnginePut({ name: '慢引擎', url: HANG_URL }))
    expect(put.ok, '引擎登记本身要成功，否则这条测不到东西').toBe(true)
    const client = new AbortController()
    const res = send(ROUTES.ttsSynthesize.path, 'POST',
      bodies.ttsSynthesize({ engineId: 'http:hang', text: '没人等的一段', rate: 1 }), client.signal)
    void res.catch(() => undefined)                 // 客户端自己取消：这条拒绝没人消费
    await vi.waitFor(() => {
      expect(calls.some((c) => c.url === HANG_URL), '上游请求应已发出').toBe(true)
    })

    client.abort()
    await expect(res).rejects.toThrowError()
    const upstream = must(calls.find((c) => c.url === HANG_URL), '上游那一发')
    expect(upstream.init?.signal, '取消位要跟着出站请求下传').toBeInstanceOf(AbortSignal)
    // 服务端收到断连要跑一拍（'close' 是 socket 事件，不比客户端的 reject 早）
    await vi.waitFor(() => {
      expect(upstream.init?.signal?.aborted, '浏览器走了，上游也要停下').toBe(true)
    })
    // 再跑一拍让服务端那侧的收尾落定：往已断开的响应写信封会抛 WriteAfterEnd，
    // 那条未处理拒绝会被 vitest 当场抓住——跑到这里没红，就是这一发安静地作废了
    await new Promise((resolve) => { setTimeout(resolve, 20) })
  })

  it('上游非 2xx → 502 TTS_UPSTREAM', async () => {
    await send(paramOps.ttsEnginePut.path('http:fail'), 'PUT',
      bodies.ttsEnginePut({ name: '失败引擎', url: FAIL_URL }))
    const res = await send(ROUTES.ttsSynthesize.path, 'POST',
      bodies.ttsSynthesize({ engineId: 'http:fail', text: 'x', rate: 1 }))
    expect(res.status).toBe(502)
    const err = await errorOf(res)
    expect(err.code).toBe('TTS_UPSTREAM')
    expect(err.message).toContain('失败引擎')
    expect(err).not.toHaveProperty('stack')
    expect(err.message).not.toContain('    at ')
  })

  it('上游失败不泄漏求值后的 URL：loginInfo 进了模板求值，信封消息只留状态事实', async () => {
    const token = 'SECRET-ROUTE-TOKEN-9c1d'
    await send(paramOps.ttsEnginePut.path('http:token'), 'PUT',
      bodies.ttsEnginePut({
        name: '带凭据引擎',
        url: `${TOKEN_URL}?key={{source.getLoginInfoMap().get("appkey")}}`,
        auth: { cookies: {}, loginInfo: { appkey: token } },
      }))
    const res = await send(ROUTES.ttsSynthesize.path, 'POST',
      bodies.ttsSynthesize({ engineId: 'http:token', text: 'x', rate: 1 }))
    expect(res.status).toBe(502)
    const err = await errorOf(res)
    expect(err.code).toBe('TTS_UPSTREAM')
    expect(err.message).toContain('带凭据引擎')
    expect(err.message, '状态事实照留').toContain('500')
    // 自证泄漏面：上游真收到了带凭据的地址（否则这条钉子测不到东西）
    expect(calls.some((c) => c.url.includes(token)), '凭据确实被求值进了请求地址').toBe(true)
    expect(err.message, '错误信封不是凭据的新读口').not.toContain(token)
  })

  it('上游给非音频响应 → 502 TTS_BAD_RESPONSE，且不落缓存（重试仍发请求）', async () => {
    await send(paramOps.ttsEnginePut.path('http:json'), 'PUT',
      bodies.ttsEnginePut({ name: 'JSON 引擎', url: JSON_URL }))
    const before = calls.filter((c) => c.url === JSON_URL).length
    for (let i = 0; i < 2; i++) {
      const res = await send(ROUTES.ttsSynthesize.path, 'POST',
        bodies.ttsSynthesize({ engineId: 'http:json', text: 'x', rate: 1 }))
      expect(res.status).toBe(502)
      expect((await errorOf(res)).code).toBe('TTS_BAD_RESPONSE')
    }
    expect(calls.filter((c) => c.url === JSON_URL).length).toBe(before + 2)
  })
})

describe('tts-engines.json 损坏 → 只降订阅那一格，不拖垮插件树挂载', () => {
  it('create 成功；源清单 / 内置合成 / 缓存读口照常，订阅动词 503 带原因；阅读 / 书架照常', async () => {
    const dir = await makeTempDir('novel-tts-corrupt-')
    await fs.writeFile(path.join(dir, 'tts-engines.json'), '{oops', 'utf8')
    const errors: string[] = []
    const upstream: string[] = []
    setLogSink({ info: () => {}, warn: () => {}, error: (...a) => { errors.push(a.map(String).join(' ')) } })
    // 注册表损坏若冒泡，create 会 reject（此前整个插件树不挂载）；这里必须成功返回
    const degraded = trackService(await ReadingService.create({
      dir,
      fetchImpl: async (input) => {
        const url = requestUrl(input)
        upstream.push(url)
        return url.startsWith(BAIDU_TTS) ? pageOf(WAV, 'audio/mpeg') : pageOf('not found', 'text/plain', 404)
      },
    }).finally(() => { setLogSink(console) }))
    // 不静默吞：损坏以 error 级留痕，且点名「注册表加载失败」这一事实
    expect(errors.some((line) => line.includes('朗读引擎注册表加载失败'))).toBe(true)

    const { base: b, close: c } = await startServer(degraded)
    const at2 = (route: string): string => `${b}${NOVEL_API_PREFIX}/${route}`
    const send2 = (route: string, method: string, body?: unknown): Promise<Response> =>
      fetch(at2(route), {
        method,
        ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      })
    try {
      // 阅读面（搜索计划 / 书架）照常可用（原断言保留）
      expect((await fetch(at2(ROUTES.searchPlan.path))).status).toBe(200)
      expect((await fetch(at2(ROUTES.shelf.path))).status).toBe(200)

      // 源清单 200：只列不依赖订阅数据的行（内置 + 浏览器直出），订阅行缺席而不是整片 503
      const sources = (await valueOf<TtsSourcesView>(await fetch(at2(ROUTES.ttsSources.path)))).sources
      expect(sources.map((s) => s.id)).toEqual(['builtin:baidu', 'browser:local'])

      // 内置合成可用：回执信封照发，上游真被打了一发
      const receipt = await valueOf<SynthesisReceipt>(await send2(
        ROUTES.ttsSynthesize.path, 'POST',
        bodies.ttsSynthesize({ engineId: 'builtin:baidu', text: '降级段', rate: 1 }),
      ))
      expect(receipt.key).toMatch(/^[0-9a-f]{32}$/)
      expect(upstream.filter((u) => u.startsWith(BAIDU_TTS))).toHaveLength(1)
      // 同段再合成 = 缓存命中照常回执（不重打上游——字节是既定事实，与订阅无关）
      const again = await valueOf<SynthesisReceipt>(await send2(
        ROUTES.ttsSynthesize.path, 'POST',
        bodies.ttsSynthesize({ engineId: 'builtin:baidu', text: '降级段', rate: 1 }),
      ))
      expect(again.key).toBe(receipt.key)
      expect(upstream.filter((u) => u.startsWith(BAIDU_TTS))).toHaveLength(1)
      // 音频读口照常出字节
      const audio = await fetch(`${b}${ttsAudioUrl(receipt.key)}`)
      expect(audio.status).toBe(200)
      expect(Buffer.from(await audio.arrayBuffer())).toEqual(Buffer.from(WAV))

      // 订阅 id 在降级下仍按「引擎不存在」分档（400，不是 500）
      const missing = await send2(ROUTES.ttsSynthesize.path, 'POST',
        bodies.ttsSynthesize({ engineId: 'http:whatever', text: 'x', rate: 1 }))
      expect(missing.status).toBe(400)
      expect((await errorOf(missing)).code).toBe('TTS_ENGINE_MISSING')

      // 五个订阅动词 → 503 且消息带原因（坏在哪一句说得清，不是无名的 Unavailable）
      const engines = await fetch(at2(ROUTES.ttsEngines.path))
      expect(engines.status).toBe(503)
      const err = await errorOf(engines)
      expect(err.code).toBe('Unavailable')
      expect(err.message).toContain('tts-engines.json')
      // 503 文案不抄数据根的绝对路径：降级原因是给浏览器看的事实，不是磁盘布局。
      expect(err.message).not.toContain(dir)
      for (const [route, method, body] of [
        [ROUTES.ttsEnginesImport.path, 'POST', bodies.ttsEnginesImport({ json: '[]' })],
        [ROUTES.ttsEnginesImport.path, 'POST', bodies.ttsEnginesImport({ url: SUBSCRIPTION_URL })],
        [paramOps.ttsEnginePut.path('http:x'), 'PUT', bodies.ttsEnginePut({ name: 'n', url: 'http://x.example/tts' })],
        [paramOps.ttsEngineDelete.path('http:x'), 'DELETE', undefined],
      ] as const) {
        const res = await send2(route, method, body)
        expect(res.status, `${method} ${route}`).toBe(503)
        expect((await errorOf(res)).code, `${method} ${route}`).toBe('Unavailable')
      }
      // 降级不打网络：订阅导入（URL 支）在出站之前就落 503
      expect(upstream.filter((u) => u === SUBSCRIPTION_URL)).toHaveLength(0)
    } finally {
      await c()
    }
  })
})
