import { describe, expect, it } from 'vitest'
import { UnsupportedRuleError } from '../../src/engine/errors.js'
import type { Fetcher } from '../../src/services/fetcher.js'
import { TtsSynthesisError } from '../../src/services/errors.js'
import { assertAudioContentType, planTtsRequest } from '../../src/services/tts-request.js'
import type { HttpTtsEngine } from '../../src/services/types.js'

/**
 * HttpTTS 请求求值：URL 规则 → RequestPlan（不打网络）+ 音频响应校验。
 * fetcher 只在 JS 段真的调 java.ajax 时才出站；本文件所有用例都不该触网。
 */
const fetcher: Fetcher = {
  fetchPage: async () => { throw new Error('请求计划求值不应触网') },
}
const deps = { fetcher, jsTimeoutMs: 2_000 }

/** legado 内置百度口的形状（brief 原样）：JS 段在 POST body 里。 */
const baidu: HttpTtsEngine = {
  id: '-100',
  name: '百度',
  url: 'http://tts.baidu.com/text2audio,{"method":"POST","body":"tex={{java.encodeURI(speakText)}}&spd={{String((speakSpeed+5)/10+4)}}"}',
  contentType: 'audio/wav',
}

/** 抛出的 TtsSynthesisError（非该类型即测试夹具失效，原样抛）。 */
function synthesisErrorOf(fn: () => void): TtsSynthesisError {
  try {
    fn()
  } catch (e) {
    if (e instanceof TtsSynthesisError) return e
    throw e
  }
  throw new Error('预期抛 TtsSynthesisError，实际成功返回')
}

/** 异步 rejection 的取值（判别类与段级定位用）。 */
async function rejectionOf(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn()
  } catch (e) {
    return e
  }
  throw new Error('预期抛错，实际成功返回')
}

/** 收窄到 UnsupportedRuleError（其余异常是夹具失效，原样抛）。 */
function unsupportedOf(e: unknown): UnsupportedRuleError {
  if (e instanceof UnsupportedRuleError) return e
  throw e
}

describe('planTtsRequest：URL 规则求值', () => {
  it('百度 POST 形态：method/URL/body 正确，{{JS}} 段经沙箱求值', async () => {
    const plan = await planTtsRequest(baidu, { text: '你好，世界', rate: 1 }, deps)
    expect(plan.method).toBe('POST')
    expect(plan.url).toBe('http://tts.baidu.com/text2audio')
    expect(plan.body).toBe('tex=%E4%BD%A0%E5%A5%BD%EF%BC%8C%E4%B8%96%E7%95%8C&spd=5')
    expect(plan.headers['Content-Type']).toBe('application/x-www-form-urlencoded')
  })

  it('{{speakText}}/{{speakSpeed}} 是纯占位：speakSpeed = rate*10-5（1.0→5），文本按 URL 编码', async () => {
    const engine: HttpTtsEngine = {
      id: 'e1', name: '占位', url: 'http://x.test/tts?spd={{speakSpeed}}&t={{speakText}}',
    }
    const slow = await planTtsRequest(engine, { text: '你好', rate: 1 }, deps)
    expect(slow.url).toBe('http://x.test/tts?spd=5&t=%E4%BD%A0%E5%A5%BD')
    const fast = await planTtsRequest(engine, { text: '你好', rate: 3 }, deps)
    expect(fast.url).toBe('http://x.test/tts?spd=25&t=%E4%BD%A0%E5%A5%BD')
  })

  it('{{speakVoice}} 绑定：纯占位与 JS 段都能读音色；缺省音色是空串', async () => {
    const engine: HttpTtsEngine = {
      id: 'e1', name: '音色', url: 'http://x.test/tts?v={{speakVoice}}&t={{java.encodeURI(speakVoice)}}',
    }
    const withVoice = await planTtsRequest(engine, { text: '你好', rate: 1, voice: '1' }, deps)
    expect(withVoice.url).toBe('http://x.test/tts?v=1&t=1')
    const noVoice = await planTtsRequest(engine, { text: '你好', rate: 1 }, deps)
    expect(noVoice.url).toBe('http://x.test/tts?v=&t=')
  })

  it('engine.auth.loginInfo 在 JS 里经 source.getLoginInfoMap() 可读', async () => {
    const engine: HttpTtsEngine = {
      id: '-29',
      name: '阿里云',
      url: 'http://x.test/tts?appkey={{source.getLoginInfoMap().get("appkey")}}',
      auth: { cookies: {}, loginInfo: { appkey: 'APPKEY-1' } },
    }
    const plan = await planTtsRequest(engine, { text: 't', rate: 1 }, deps)
    expect(plan.url).toBe('http://x.test/tts?appkey=APPKEY-1')
  })

  it('engine.header 静态头进计划；声明了 Content-Type 时不被表单默认头压掉', async () => {
    const engine: HttpTtsEngine = {
      id: 'e2',
      name: '静态头',
      url: 'http://x.test/tts,{"method":"POST","body":"t={{speakText}}"}',
      header: '{"X-Api-Key":"K-1","Content-Type":"application/json"}',
    }
    const plan = await planTtsRequest(engine, { text: '你好', rate: 1 }, deps)
    expect(plan.headers['X-Api-Key']).toBe('K-1')
    expect(plan.headers['Content-Type']).toBe('application/json')
  })

  it('凭据的 headers/cookies 与书源同一条合并口径进计划', async () => {
    const engine: HttpTtsEngine = {
      id: 'e3',
      name: '凭据',
      url: 'http://x.test/tts?t={{speakText}}',
      auth: { cookies: { sid: 'S-1' }, headers: { Authorization: 'Bearer T-1' } },
    }
    const plan = await planTtsRequest(engine, { text: 'x', rate: 1 }, deps)
    expect(plan.headers.Authorization).toBe('Bearer T-1')
    expect(plan.headers.Cookie).toBe('sid=S-1')
  })

  it('相对 URL（HttpTTS 没有可解析的基准）→ UnsupportedRuleError，不猜基准', async () => {
    const engine: HttpTtsEngine = { id: 'e4', name: '相对', url: '/tts?t={{speakText}}' }
    const err = unsupportedOf(await rejectionOf(() => planTtsRequest(engine, { text: 'x', rate: 1 }, deps)))
    expect(err.message).toContain('不是绝对地址')
    // 定位是**求值后**的文本：只给占位，不回显地址（可能带着模板从登录态取来的凭据）
    expect(err.segmentRaw).toBe('（求值后原文已省略）')
    expect(err.message).not.toContain('/tts?t=')
  })

  it('求值后的地址不回显：模板把登录态求进 URL 时，错误里也没有那把凭据', async () => {
    const engine: HttpTtsEngine = {
      id: 'e4b',
      name: '凭据注入',
      url: '{{source.getLoginInfoMap().get("appkey")}}/tts',
      auth: { cookies: {}, loginInfo: { appkey: 'SECRET-APPKEY' } },
    }
    const err = unsupportedOf(await rejectionOf(() => planTtsRequest(engine, { text: 'x', rate: 1 }, deps)))
    expect(err.message).toContain('不是绝对地址')
    expect(err.message).not.toContain('SECRET-APPKEY')
    expect(err.segmentRaw).not.toContain('SECRET-APPKEY')
  })

  it('URL 选项不是合法 JSON → UnsupportedRuleError（不静默当无选项发出去）', async () => {
    const engine: HttpTtsEngine = {
      id: 'e5', name: '坏选项', url: 'http://x.test/tts,{"method":"POST"',
    }
    const err = unsupportedOf(await rejectionOf(() => planTtsRequest(engine, { text: 'x', rate: 1 }, deps)))
    expect(err.segmentIndex).toBe(0)
    expect(err.segmentRaw).toContain('"method"')
  })

  it('URL 选项含本链未实现的键 → UnsupportedRuleError（书源面的 warn+忽略在朗读面会发错请求）', async () => {
    const engine: HttpTtsEngine = {
      id: 'e5b', name: '未实现键', url: 'http://x.test/tts,{"method":"POST","bodyJs":"return 1"}',
    }
    const err = unsupportedOf(await rejectionOf(() => planTtsRequest(engine, { text: 'x', rate: 1 }, deps)))
    expect(err.message).toContain('bodyJs')
  })

  it('URL 选项要求真浏览器（webView/webJs）→ UnsupportedRuleError（本请求面只有 HTTP）', async () => {
    const engine: HttpTtsEngine = {
      id: 'e5c', name: 'webView', url: 'http://x.test/tts,{"webView":true}',
    }
    const err = unsupportedOf(await rejectionOf(() => planTtsRequest(engine, { text: 'x', rate: 1 }, deps)))
    expect(err.message).toContain('webView')
  })

  it('js 块形态（@js:）本链未接 → UnsupportedRuleError（不把脚本当 URL 原样发）', async () => {
    const engine: HttpTtsEngine = {
      id: 'e6', name: 'js 块', url: '@js:"http://x.test/tts?t=" + speakText',
    }
    const err = unsupportedOf(await rejectionOf(() => planTtsRequest(engine, { text: 'x', rate: 1 }, deps)))
    expect(err.segmentRaw).toContain('@js:')
  })

  it('engine.header 不是合法头表 JSON → UnsupportedRuleError', async () => {
    const engine: HttpTtsEngine = {
      id: 'e7', name: '坏头', url: 'http://x.test/tts?t={{speakText}}', header: 'User-Agent: x',
    }
    const err = unsupportedOf(await rejectionOf(() => planTtsRequest(engine, { text: 'x', rate: 1 }, deps)))
    expect(err.segmentRaw).toContain('User-Agent')
  })
})

describe('assertAudioContentType：响应必须是音频', () => {
  it('JSON 错误页 → TTS_BAD_RESPONSE，消息带上游正文摘要', () => {
    const err = synthesisErrorOf(() =>
      assertAudioContentType(Buffer.from('{"error":"无效的 token"}'), 'application/json; charset=utf-8'))
    expect(err.code).toBe('TTS_BAD_RESPONSE')
    expect(err.message).toContain('无效的 token')
  })

  it('text/html 错误页 → TTS_BAD_RESPONSE', () => {
    const err = synthesisErrorOf(() =>
      assertAudioContentType(Buffer.from('<html>403 forbidden</html>'), 'text/html'))
    expect(err.code).toBe('TTS_BAD_RESPONSE')
    expect(err.message).toContain('403 forbidden')
  })

  it('零字节音频 → TTS_BAD_RESPONSE（空字节一旦入缓存就再也修不回来）', () => {
    const err = synthesisErrorOf(() => assertAudioContentType(Buffer.alloc(0), 'audio/mpeg'))
    expect(err.code).toBe('TTS_BAD_RESPONSE')
    expect(err.message).toContain('0 字节')
  })

  it('音频响应返回归一化 mediaType（参数剥掉、小写）', () => {
    expect(assertAudioContentType(Buffer.from([0xff, 0xfb, 0x90]), 'Audio/MPEG; charset=binary', 'audio/.*'))
      .toBe('audio/mpeg')
    expect(assertAudioContentType(Buffer.from([1, 2, 3]), 'audio/wav')).toBe('audio/wav')
  })

  it('与引擎声明的 contentType 不符（按 legado 的正则口径）→ TTS_BAD_RESPONSE', () => {
    const err = synthesisErrorOf(() =>
      assertAudioContentType(Buffer.from([0x4f, 0x67, 0x67, 0x53]), 'audio/ogg', 'audio/wav'))
    expect(err.code).toBe('TTS_BAD_RESPONSE')
    expect(err.message).toContain('audio/ogg')
    expect(err.message).toContain('audio/wav')
  })

  it('引擎声明不是合法正则 → TTS_BAD_RESPONSE（坏声明不悄悄换判据）', () => {
    const err = synthesisErrorOf(() =>
      assertAudioContentType(Buffer.from([1, 2]), 'audio/wav', 'audio/('))
    expect(err.code).toBe('TTS_BAD_RESPONSE')
    expect(err.message).toContain('audio/(')
  })

  it('引擎声明是病态正则 → 死线守卫收口成 TTS_BAD_RESPONSE（不钉住主线程）', () => {
    // `(a+)+$` 对「长 a 串 + 收尾不匹配」是经典灾难性回溯；媒体类型串由引擎侧控制、可以很长。
    // 判据是「超时被如实报成 BAD_RESPONSE」，而不是「跑完发现不匹配」——后者会先钉住主线程。
    const err = synthesisErrorOf(() =>
      assertAudioContentType(Buffer.from([1, 2]), `audio/${'a'.repeat(30)}!`, '(a+)+$'))
    expect(err.code).toBe('TTS_BAD_RESPONSE')
    expect(err.message).toContain('超时')
  })

  it('缺 Content-Type → 中性 application/octet-stream（缺席不是「声明不符」，不编具体音频类型）', () => {
    expect(assertAudioContentType(Buffer.from([1, 2, 3]), '')).toBe('application/octet-stream')
    expect(assertAudioContentType(Buffer.from([1, 2, 3]), '', 'audio/wav')).toBe('application/octet-stream')
  })
})
