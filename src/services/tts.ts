import { BROWSER_TTS_ENGINE_ID, CORDIS_TTS_ENGINE_ID, TTS_DEFAULTS, TTS_RESERVED_ID_PREFIX } from '../shared/wire.js'
import type { SynthesisReceipt, SynthesisRequest, TtsSourceInfo, TtsSourcesView, TtsVoice } from '../shared/wire.js'
import type { FetchedPage, Fetcher } from './fetcher.js'
import { TtsSynthesisError, redactOutboundError } from './errors.js'
import { fetchInitOf } from './request.js'
import type { RequestPlan } from './request.js'
import { TtsAudioCache, ttsCacheKey } from './tts-cache.js'
import type { AudioResource } from './tts-cache.js'
import { abortReasonOf } from './tts-cancel.js'
import type { TtsEngineRegistry } from './tts-engines.js'
import { log } from './log.js'
import { cordisCacheIdentity } from './tts-cordis.js'
import { assertAudioContentType, planTtsRequest, ruleCarriesSpeechRate } from './tts-request.js'
import type { HttpTtsEngine } from './types.js'
import { readValue, type ValueSource } from './value-source.js'


/**
 * 合成链路：一段正文 → 合成计划（`TtsSynthesisPlan`：identity + produce）→ 上游音频字节 → 音频缓存。
 * 三类引擎源归一在合成面：内置/注册表引擎走与书源同一条 URL 规则链；cordis 服务经 `NormalizedSpeechSynthesis`
 * 的归一形状消费；浏览器直出不在本服务里（客户端直接出声），只在源清单里占一行。
 *
 * 计划先于缓存：缓存键按**实际请求**算（同一 spd 档内的两个语速、模板不消费的音色都该复用旧字节），命中即回执；
 * 未命中才执行 produce。求值失败先于缓存命中——配置坏了不能拿旧字节冒充可用。单段失败只抛给调用方。
 */

/**
 * 内置朗读引擎（恰一条）：免鉴权的公开合成口（GET，`spd` 只用 1–7 整数档），不需要凭据；`builtin:` 前缀是
 * 身份的一部分——合成面按前缀从这张表取，不落注册表、不可编辑。
 *
 * 语速映射：`speakSpeed = rate * 10 - 5`（rate 1 → 5）。端点只有 7 档，这里把「rate 1 → spd 5」钉在中点：
 * 慢速半段（0.5–1）用满 1–5，快速半段（1–3）用 5–7，滑杆两端都有可听变化。
 *
 * **这一条没有音色表**（`voices` 缺席 → 界面不渲染音色行）：`per` 被端点整个忽略——实测同一段文本在
 * `per=0/1/3/4` 下返回逐字节相同的 mp3，而 `spd=1/5/7` 字节数各不相同。摆一张选了不改变任何事的音色表
 * 就是假控件：换缓存键、重发上游请求，出声却一模一样。要换音色请用浏览器本地语音或订阅引擎。
 */
export const BUILTIN_TTS_ENGINES: readonly HttpTtsEngine[] = [
  {
    id: TTS_DEFAULTS.engineId,
    name: '百度',
    url: 'https://fanyi.baidu.com/gettts?lan=zh&text={{java.encodeURI(speakText)}}&spd={{String(Math.min(7, Math.max(1, speakSpeed <= 5 ? 1 + Math.round((speakSpeed / 5) * 4) : 5 + Math.round((speakSpeed - 5) / 20 * 2))))}}&source=web',
    contentType: 'audio/mpeg',
  },
]

/**
 * 插件自有的语音合成归一形状：只认「文本 + 音色 + 语速 → 音频字节 + contentType」。适配器（cordis 服务的私有
 * 契约 → 这一份）住 `tts-cordis.ts`；本文件不 import 外部包，换服务/换契约只改适配器。
 */
export interface NormalizedSpeechSynthesis {
  /** 源声明的音色表；缺席 = 该源没有音色列表（UI 不渲染音色行） */
  voices?: TtsVoice[]
  /** 此刻能不能合成（服务方对自己配置的本地校验读数）：为假时这一源不进清单，合成按 `TTS_ENGINE_UNAVAILABLE` 具名失败。 */
  ready: boolean
  /** 未就绪的原因码（服务方原话）；`ready` 为真或读数缺席时不带 */
  unavailableReason?: string
  /** `opts.signal` = 调用方的取消位：先经合并槽转交（同键在途只发一发上游，最后一员退场才中止），
   *  适配器再把这一发与自己的死线汇成一条交给服务，取消即终止上游。 */
  synthesize(req: {
    text: string
    voice?: string
    rate?: number
  }, opts?: { signal?: AbortSignal }): Promise<{ data: Buffer; contentType?: string; appliedRate: number }>
}

/** 宿主语音服务的一次读数：**缺席**（没装）与**在场但读不出**（装了却读不出自己的状态）是两件事，修法完全不同（`ADR-0083`）。后者按未就绪处理，不冒充缺席。 */
type SpeechReadout =
  | { kind: 'absent' }
  | { kind: 'unreadable' }
  | { kind: 'service'; service: NormalizedSpeechSynthesis }

/**
 * 单段合成响应的字节上限（8 MiB）。**这个数是唯一主人**。上限必须在**读进内存之前**生效（`maxBytes` 在流上
 * 边读边计）：坏端点回大二进制时，先 `arrayBuffer()` 再判等于先付内存再拒绝。超限按上游失败（502）报，带上限值。
 */
export const TTS_AUDIO_MAX_BYTES = 8 * 1024 * 1024

export interface TtsServiceDeps {
  /** 段音频缓存：实例由装配处注入（数据根与容量上限是组合根的事实，与 `PageCache` 同一处装配）。 */
  cache: TtsAudioCache
  engines: TtsEngineRegistry
  fetcher: Fetcher
  jsTimeoutMs: ValueSource<number>
  /** cordis 服务读数：**每次用到时重查**（服务可能动态卸装）；缺席 = 该源当前不可用。 */
  speechSynthesis: () => NormalizedSpeechSynthesis | undefined
}

/**
 * 一次合成的计划：**identity 与 produce 同住一处**。identity 是缓存键「实际请求」那一位，由知道请求内容的那一支
 * 产出（HTTP 是求值后的 method/url/body，cordis 是服务身份 + 音色 + 语速；headers 不入键，`ADR-0069`）；produce
 * 才碰引擎出字节。分开手拼就会漂移——键说请求没变、produce 却发了别的请求。命中路径只读 identity、不执行 produce。
 */
export interface TtsSynthesisPlan {
  /** 缓存键的「实际请求」那一位（材料与产生它的请求在同侧产出） */
  identity: string
  /** 未命中才执行：出音频字节、mediaType 与 `appliedRate`（这份字节里引擎自己应用了多少语速，1 = 原速）。
   *  `signal` = 合并槽的取消位：等待方全员退场才中止，不替没人听的段落把整段念完。 */
  produce(signal: AbortSignal | undefined): Promise<{ bytes: Buffer; mediaType: string; appliedRate: number }>
}

/** 一次合成要去的源：HTTP 模板或 cordis 服务。键材料不在这层手拼——HTTP 支在 `planHttp` 随请求求值产出，cordis 支在 `cordisCacheIdentity` 产出。 */
type SynthesisTarget =
  | { kind: 'http'; engine: HttpTtsEngine }
  | { kind: 'cordis' }

/** 源清单行：列出的源都在此刻可用（不可用的不出现在清单里，而不是灰着造禁用态）。插件自有源不投展示名——标签归客户端文案单点；只有订阅引擎带 `name`。 */
function sourceInfo(id: string, kind: TtsSourceInfo['kind'], voices?: TtsSourceInfo['voices']): TtsSourceInfo {
  return { id, kind, ...(voices === undefined ? {} : { voices }) }
}

/** 原始异常 → 可读消息（上游错误只借它的原话，不外泄它的类型） */
function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** 播放端还要补的倍率 = 用户要的 ÷ 这份字节里引擎真做的那档（乘回去按千分位收浮点尾巴）。判据是**字节的应用量**，不是「第一次请求时的能力」：同一段字节会被不同倍率重放，补速必须跟着这次的请求走。 */
function residualOf(requested: number, applied: number): number {
  return Math.round((requested / applied) * 1000) / 1000
}

/** 在途合成槽（按缓存键合并并发请求）：所有等待方共用一发 `produce`，各自按自己的请求语速算补速，
 *  只有全部等待方都取消时才真正中止上游（单方取消只自己退场，`ADR-0082`）。 */
interface InFlightSynthesis {
  ctrl: AbortController
  waiters: number
  promise: Promise<{ key: string; appliedRate: number }>
}

export class TtsService {
  private readonly deps: TtsServiceDeps
  private readonly inFlight = new Map<string, InFlightSynthesis>()

  constructor(deps: TtsServiceDeps) {
    this.deps = deps
  }

  /**
   * 合成一段：targetOf → 造计划 → 查缓存 → 命中即回执；未命中经 `coalescedProduce` 合并同键在途请求、出字节入缓存。失败只抛给调用方。
   * `opts.signal` 每一跳之前先问一次（已取消就一个请求都不发），并经合并槽下传给 produce——跳段 / 停止 / 断连靠它掐掉没人等的在途合成。
   */
  async synthesize(p: SynthesisRequest, opts?: { signal?: AbortSignal }): Promise<SynthesisReceipt> {
    const signal = opts?.signal
    if (signal !== undefined && signal.aborted) throw abortReasonOf(signal)
    const target = this.targetOf(p.engineId)
    const plan = target.kind === 'cordis'
      ? this.planCordis(p)
      : await this.planHttp(target.engine, p)
    const key = ttsCacheKey({ engineId: p.engineId, request: plan.identity, text: p.text })
    // 命中只读侧车（`appliedRate` 是这份字节的事实）：打不开流，也不拿「引擎此刻能做什么」重算。
    const cached = await this.deps.cache.meta(key)
    // 补速按**这次请求**算，不按第一次写进侧车的那一格：模板不消费语速时键与 rate 无关，同一份字节会被不同倍率重放。
    if (cached !== null) return { key, playbackRate: residualOf(p.rate, cached.appliedRate) }
    // 查缓存的窗口里被取消：磁盘上的字节是既定事实，但没必要再为一段没人听的内容发一次合成
    if (signal !== undefined && signal.aborted) throw abortReasonOf(signal)
    const synthesized = await this.coalescedProduce(key, plan, signal)
    return { key: synthesized.key, playbackRate: residualOf(p.rate, synthesized.appliedRate) }
  }

  /** 按缓存键合并同键在途合成（预取与主播放撞车时只发一发上游）；只有所有等待方都退场才真正 abort 上游。 */
  private async coalescedProduce(
    key: string, plan: TtsSynthesisPlan, signal: AbortSignal | undefined,
  ): Promise<{ key: string; appliedRate: number }> {
    let job = this.inFlight.get(key)
    if (job === undefined || job.ctrl.signal.aborted) {
      const ctrl = new AbortController()
      const promise = (async (): Promise<{ key: string; appliedRate: number }> => {
        const audio = await plan.produce(ctrl.signal)
        await this.deps.cache.put(key, audio.bytes, audio.mediaType, audio.appliedRate)
        return { key, appliedRate: audio.appliedRate }
      })()
      const created: InFlightSynthesis = { ctrl, waiters: 0, promise }
      this.inFlight.set(key, created)
      // 无人等的那一侧失败由等待方 race 各自接走：finally 会透传原拒绝，必须在末尾收口以免悬成未处理拒绝。
      void promise.finally(() => {
        if (this.inFlight.get(key) === created) this.inFlight.delete(key)
      }).catch(() => undefined)
      job = created
    }
    job.waiters += 1
    let released = false
    const release = (abortReason?: Error): void => {
      if (released) return
      released = true
      job.waiters -= 1
      if (job.waiters === 0) {
        if (this.inFlight.get(key) === job) this.inFlight.delete(key)
        if (abortReason !== undefined) job.ctrl.abort(abortReason)
      }
    }
    if (signal === undefined) {
      try {
        return await job.promise
      } finally {
        release()
      }
    }
    let onAbort: (() => void) | undefined
    const cancelled = new Promise<never>((_, reject) => {
      const abort = (): void => {
        const reason = abortReasonOf(signal)
        release(reason)
        reject(reason)
      }
      if (signal.aborted) {
        abort()
        return
      }
      onAbort = abort
      signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      return await Promise.race([job.promise, cancelled])
    } finally {
      if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
      release()
    }
  }

  /** 音频读口（路由层凭合成回执的 key 取字节）；未知/非法 key → null（404，不是空音频）。 */
  async openAudio(key: string): Promise<AudioResource | null> {
    return this.deps.cache.open(key)
  }

  /**
   * 引擎源清单 + 宿主服务健康：**同一次读数算出来**，不分两次问。次序：内置 → 浏览器直出兜底 → 注册表每条订阅 →
   * cordis（仅当 getter 此刻返回服务且服务自报就绪）。展示名只有订阅源自带；不可用的 cordis 不进清单——清单的
   * 承诺是「列出的都在此刻可用」，它为什么不在由 `hostSpeech` 说（缺席与未就绪是两件事）。
   */
  sourcesView(): TtsSourcesView {
    const listed: TtsSourceInfo[] = [
      ...BUILTIN_TTS_ENGINES.map((e) => sourceInfo(e.id, 'builtin', e.voices)),
      sourceInfo(BROWSER_TTS_ENGINE_ID, 'browser'),
      ...this.deps.engines.list().map((e): TtsSourceInfo => ({
        ...sourceInfo(e.id, 'http', e.voices),
        name: e.name,
      })),
    ]
    const readout = this.speechReadout()
    if (readout.kind === 'absent') return { sources: listed, hostSpeech: { state: 'absent' } }
    // 在场但读不出：不是「没装」，按未就绪报（没有原因码——服务连自己的状态都没交出来）。
    if (readout.kind === 'unreadable') return { sources: listed, hostSpeech: { state: 'not-ready' } }
    const service = readout.service
    if (!service.ready) {
      const reason = service.unavailableReason
      return {
        sources: listed,
        hostSpeech: { state: 'not-ready', ...(reason === undefined ? {} : { reason }) },
      }
    }
    listed.push({
      ...sourceInfo(CORDIS_TTS_ENGINE_ID, 'cordis'),
      ...(service.voices === undefined ? {} : { voices: service.voices }),
    })
    return { sources: listed, hostSpeech: { state: 'ready' } }
  }

  /** 清单那一半（合成面的分流与测试都只看行）。 */
  sources(): TtsSourceInfo[] {
    return this.sourcesView().sources
  }

  /** 宿主语音服务的可选读数。服务中途卸装是约定；读数本身抛错也只算**这一源**不可用——不能让一个可选服务的失败
   *  把内置 / 浏览器源的清单一起打成 500。但「读不出」不等于「不在场」，按未就绪报（`ADR-0083`）。 */
  private speechReadout(): SpeechReadout {
    try {
      const service = this.deps.speechSynthesis()
      return service === undefined ? { kind: 'absent' } : { kind: 'service', service }
    } catch (e) {
      log.warn('宿主朗读服务读数失败，本次按未就绪处理：', e)
      return { kind: 'unreadable' }
    }
  }

  /** engineId → 源。`builtin:` 只认内置表（注册表里即便有同名 id 也不顶替内置身份）；cordis 是固定身份；其余按注册表。未知 → TTS_ENGINE_MISSING（调用方据 code 映射 400）。 */
  private targetOf(engineId: string): SynthesisTarget {
    // 保留前缀的判据只住 wire（`TTS_RESERVED_ID_PREFIX`）：这里只引用，不抄字面量。
    if (engineId.startsWith(TTS_RESERVED_ID_PREFIX)) {
      const engine = BUILTIN_TTS_ENGINES.find((e) => e.id === engineId)
      if (engine === undefined) {
        throw new TtsSynthesisError('TTS_ENGINE_MISSING', `朗读引擎不存在：${engineId}`)
      }
      return { kind: 'http', engine }
    }
    if (engineId === CORDIS_TTS_ENGINE_ID) return { kind: 'cordis' }
    const engine = this.deps.engines.get(engineId)
    if (engine === null) {
      throw new TtsSynthesisError('TTS_ENGINE_MISSING', `朗读引擎不存在：${engineId}`)
    }
    return { kind: 'http', engine }
  }

  /** HTTP 支的计划：请求求值一次，键材料（求值后的 method/url/body）与 produce 在同一处产出——命中时只读键材料，不再求值。 */
  private async planHttp(engine: HttpTtsEngine, p: SynthesisRequest): Promise<TtsSynthesisPlan> {
    const plan = await planTtsRequest(
      engine,
      { text: p.text, rate: p.rate, ...(p.voice === undefined ? {} : { voice: p.voice }) },
      { fetcher: this.deps.fetcher, jsTimeoutMs: readValue(this.deps.jsTimeoutMs) },
    )
    // 语速归谁：规则里写了 `speakSpeed` 就是引擎自己念的，这份字节记作「引擎应用了请求的那一档」；没写就是原速，
    // 记 1 并把整段倍率交给播放端——否则滑杆就是个假控件。
    const appliedRate = ruleCarriesSpeechRate(engine) ? p.rate : 1
    return {
      identity: JSON.stringify([plan.method, plan.url, plan.body ?? null]),
      produce: async (signal) => ({
        ...(await this.fetchHttp(engine, plan, signal)),
        appliedRate,
      }),
    }
  }

  /** cordis 支的计划：键材料取自映射侧的 `cordisCacheIdentity`；产出此刻不碰服务——getter 每次重查留在 produce 里。 */
  private planCordis(p: SynthesisRequest): TtsSynthesisPlan {
    return {
      identity: cordisCacheIdentity(p),
      produce: (signal) => this.synthesizeCordis(p, signal),
    }
  }

  /** HTTP 支出站：计划已求值，这里只发请求并校验「响应必须是音频」。 */
  private async fetchHttp(
    engine: HttpTtsEngine, plan: RequestPlan, signal: AbortSignal | undefined,
  ): Promise<{ bytes: Buffer; mediaType: string }> {
    let page: FetchedPage
    try {
      // 上限随请求下传而不是读回来再量：fetchPage 在流上边读边计，超限即取消连接。
      page = await this.deps.fetcher.fetchPage(plan.url, {
        ...fetchInitOf(plan),
        maxBytes: TTS_AUDIO_MAX_BYTES,
        ...(signal === undefined ? {} : { signal }),
      })
    } catch (e) {
      if (e instanceof TtsSynthesisError) throw e
      // 取消不是上游失败：抓取层在取消时抛的就是 `signal.reason`，按同一份类型纪律交回——连败计数与错误信封都不该把作废当「引擎坏了」的证据。
      if (signal !== undefined && signal.aborted) throw abortReasonOf(signal)
      // 请求失败属「上游」那一档：原始异常类型不外泄，原话带上——用户要看得到「HTTP 500」「请求超时」「响应超过上限」
      // 这类可行动的原因。地址除外：模板能把登录态求值进 URL，先经 `redactOutboundError` 摘掉，只留状态/超时/上限事实。
      // 引擎名用实体自己的 `name`；服务端错误原文一律中文、由 `describeError` 原样上屏，不另做投影。
      throw new TtsSynthesisError(
        'TTS_UPSTREAM', `朗读引擎请求失败（${engine.name}）：${messageOf(redactOutboundError(e, plan.url))}`)
    }
    return {
      bytes: page.raw,
      mediaType: assertAudioContentType(page.raw, page.contentType ?? '', engine.contentType),
    }
  }

  /** cordis 支：getter 每次重查（中途卸装 → 本次缺席）；字节与 HTTP 响应过同一条「必须是音频」判据，共用同一份缓存。
   *  取消位交给适配器的 `guardSynthesis`，这一层只分流、不另造取消径。 */
  private async synthesizeCordis(
    p: SynthesisRequest, signal: AbortSignal | undefined,
  ): Promise<{ bytes: Buffer; mediaType: string; appliedRate: number }> {
    const readout = this.speechReadout()
    if (readout.kind === 'absent') {
      throw new TtsSynthesisError('TTS_ENGINE_MISSING', `朗读服务缺席：${CORDIS_TTS_ENGINE_ID}`)
    }
    if (readout.kind === 'unreadable') {
      // 在场读不出：不是「没这个引擎」（400），是此刻不可用（503）——与未就绪同一档，不拿注定失败的上游请求当报错。
      throw new TtsSynthesisError(
        'TTS_ENGINE_UNAVAILABLE', '宿主朗读服务读数失败，暂时不可用：到该插件里检查配置')
    }
    const service = readout.service
    if (!service.ready) {
      // 服务自报还没配好（缺密钥、音色不齐…）：先把原因码上屏，再谈合成——原因码原样带（服务方的稳定码）。
      const reason = service.unavailableReason
      throw new TtsSynthesisError('TTS_ENGINE_UNAVAILABLE',
        `宿主朗读服务未就绪${reason === undefined ? '' : `（${reason}）`}：到该插件里配好供应商再来`)
    }
    let result: { data: Buffer; contentType?: string; appliedRate: number }
    try {
      result = await service.synthesize({
        text: p.text,
        ...(p.voice === undefined ? {} : { voice: p.voice }),
        rate: p.rate,
      }, { ...(signal === undefined ? {} : { signal }) })
    } catch (e) {
      // 取消不是上游失败（`ADR-0082` 决定 5）：包成 TTS_UPSTREAM 会把一次作废记成引擎连败的证据。
      if (signal !== undefined && signal.aborted) throw abortReasonOf(signal)
      if (e instanceof TtsSynthesisError) throw e
      throw new TtsSynthesisError('TTS_UPSTREAM', `朗读服务合成失败：${messageOf(e)}`)
    }
    return {
      bytes: result.data,
      mediaType: assertAudioContentType(result.data, result.contentType ?? ''),
      // 适配器报「服务端真发出去的那一档」（没发 voiceRate = 原速 1）：差额由合成面按请求算
      appliedRate: result.appliedRate,
    }
  }
}
