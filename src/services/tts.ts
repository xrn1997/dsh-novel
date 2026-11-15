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
 * 三类引擎源在合成面归一：
 * - 内置 / 注册表引擎：声明式 HTTP 模板，走与书源同一条 URL 规则链；
 * - cordis 服务：经 `NormalizedSpeechSynthesis` 的归一形状消费（适配器是另一半的事）；
 * - 浏览器直出：不在本服务里（客户端直接出声），只在源清单里占一行。
 *
 * 计划先于缓存：缓存键按**实际请求**算（同一 spd 档内的两个语速、模板不消费的音色都
 * 该复用旧字节），命中即回执、不发合成请求；未命中才执行 produce。求值失败先于缓存命中——
 * 配置坏了不能拿旧字节冒充可用。单段失败只抛给调用方（一段失败只影响那一段），本层不吞错误、
 * 不做静默降级。
 */

/**
 * 内置朗读引擎（恰一条）。走免鉴权的公开合成口（GET，`spd` 只收 1–7 的整数档），
 * 所以这一条不需要用户配凭据；`builtin:` 前缀是身份的一部分——合成面按前缀从这张表取，
 * 不落注册表、不可编辑。
 *
 * 语速映射：`speakSpeed = rate * 10 - 5`（rate 1 → 5）。端点只有 7 个整数档，这里把
 * 「rate 1 → spd 5」钉在中点：慢速半段（rate 0.5–1）用满 1–5，快速半段（rate 1–3）用 5–7，
 * 滑杆两端的行程都有可听变化。
 *
 * **这一条没有音色表**（`voices` 缺席 → 界面不渲染音色行）：`gettts` 口只认
 * `lan` / `text` / `spd` / `source`，`per` 被整个忽略——2026-11-13 实测同一段文本在
 * `per=0/1/3/4`（以及带 `ctp` / `tok` / `cuid` / `pitch` 的形态）下返回**逐字节相同**的
 * mp3，而 `spd=1/5/7` 的字节数各不相同，即「参数进去了、端点不读」。摆一张选了不改变
 * 任何事的音色表就是假控件：它换缓存键、重发上游请求，出声却一模一样——比「没有这个能力」
 * 更坏。要换音色请用浏览器本地语音或订阅引擎（`speakVoice` 绑定照旧对它们生效）。
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
 * 插件自有的语音合成归一形状：只认「文本 + 音色 + 语速 → 音频字节 + contentType」。
 * 适配器（cordis 服务的私有契约 → 这一份）住 `tts-cordis.ts`；本文件不 import 任何外部包，
 * 合成服务只消费归一形状与它的键材料 `cordisCacheIdentity`，换服务/换契约只改适配器。
 */
export interface NormalizedSpeechSynthesis {
  /** 源声明的音色表；缺席 = 该源没有音色列表（UI 不渲染音色行） */
  voices?: TtsVoice[]
  /** 此刻能不能合成（服务方对自己配置的本地校验读数）：为假时这一源不进清单，
   *  合成按 `TTS_ENGINE_UNAVAILABLE` 具名失败——不拿一次注定失败的上游请求当报错。 */
  ready: boolean
  /** 未就绪的原因码（服务方原话）；`ready` 为真或读数缺席时不带 */
  unavailableReason?: string
  /** `opts.signal` = 调用方的取消位：适配器把它与本支的死线汇成一条交给服务，取消即终止上游。 */
  synthesize(req: {
    text: string
    voice?: string
    rate?: number
  }, opts?: { signal?: AbortSignal }): Promise<{ data: Buffer; contentType?: string; appliedRate: number }>
}

/**
 * 宿主语音服务的一次读数：**缺席**（服务不在场）与**在场但读不出**是两件事——前者是没装，
 * 后者是装了却读不出它自己的状态，修法完全不同（`ADR-0083`）。后者按未就绪处理，不冒充缺席。
 */
type SpeechReadout =
  | { kind: 'absent' }
  | { kind: 'unreadable' }
  | { kind: 'service'; service: NormalizedSpeechSynthesis }

/**
 * 单段合成响应的字节上限（8 MiB）。**这个数是唯一主人**：合成链只在这里定「多大的响应算引擎失常」。
 * 上限必须在**读进内存之前**生效（`Fetcher.fetchPage` 的 `maxBytes` 在流上边读边计）——订阅引擎
 * 来自外部数据（`tts/engines/import` 的 URL 支），坏/恶意端点回大二进制时，先 `arrayBuffer()`
 * 再判大小等于先付内存再拒绝。超限按上游失败（502）报，原话带上限值：换源 / 修订阅是可行动的事实。
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
 * 一次合成的计划：**identity 与 produce 同住一处**。identity 是缓存键「实际请求」那一位，
 * 由知道请求内容的那一支 adapter 产出（HTTP 是求值后的 method/url/body，cordis 是服务身份 +
 * 音色 + 语速；headers 不入键，`ADR-0069`）；produce 才碰引擎 / 服务出字节。两者分开手拼
 * 就会漂移——键说请求没变、produce 却发了别的请求。命中路径只读 identity、不执行 produce，
 * 引擎此刻不在场也照样回执。
 */
export interface TtsSynthesisPlan {
  /** 缓存键的「实际请求」那一位（材料与产生它的请求在同侧产出） */
  identity: string
  /** 未命中才执行：出音频字节、mediaType 与 `appliedRate`（这份字节里引擎自己应用了多少语速，
   *  1 = 原速）；失败照合成面的错误语义抛（不吞、不降级）。
   *  `signal` 原样下传给那一支出站的请求 / 服务调用：调用方不要了，就不该有人替它把整段念完。 */
  produce(signal: AbortSignal | undefined): Promise<{ bytes: Buffer; mediaType: string; appliedRate: number }>
}

/** 一次合成要去的源：HTTP 模板（连到哪份引擎）或 cordis 服务。键材料不在这层手拼——
 *  HTTP 支在 `planHttp` 里随请求求值产出，cordis 支在 `cordisCacheIdentity` 产出，
 *  这里只带分流所需的身份。 */
type SynthesisTarget =
  | { kind: 'http'; engine: HttpTtsEngine }
  | { kind: 'cordis' }

/** 源清单行：本服务列出的源都在此刻可用（不可用/缺席的源不出现在清单里，而不是灰着造禁用态）。
 *  插件自有源（内置 / 浏览器直出 / cordis）不投展示名：标签归客户端文案单点，按 kind/id 取词；
 *  只有订阅来的注册表引擎（`kind: 'http'`）带 `name`，那是订阅数据本身。 */
function sourceInfo(id: string, kind: TtsSourceInfo['kind'], voices?: TtsSourceInfo['voices']): TtsSourceInfo {
  return { id, kind, ...(voices === undefined ? {} : { voices }) }
}

/** 原始异常 → 可读消息（上游错误只借它的原话，不外泄它的类型） */
function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * 播放端还要补的倍率 = 用户要的 ÷ 这份字节里引擎真做的那档。乘回去必须等于用户要的（按千分位
 * 收浮点尾巴）。判据是**字节的应用量**，不是「第一次请求时的能力」：同一段字节被不同倍率重放时
 * （模板不消费语速，键与 rate 无关），补速必须跟着这次的请求走，否则第二次播放就慢了。
 */
function residualOf(requested: number, applied: number): number {
  return Math.round((requested / applied) * 1000) / 1000
}

export class TtsService {
  private readonly deps: TtsServiceDeps

  constructor(deps: TtsServiceDeps) {
    this.deps = deps
  }

  /**
   * 合成一段：targetOf → 造计划 → 查缓存 → 命中即回执（不执行 produce）；未命中 produce
   * 出字节再入缓存。失败只抛给调用方——单段失败只影响那一段，本层不吞、不返回空音频。
   * `opts.signal` 是调用方的取消位：每一跳之前先问一次（已取消就一个请求都不发），
   * 并下传给 produce——播放层跳段 / 停止、浏览器断连都靠它把在途合成掐掉。
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
    // 补速按**这次请求**算，不按第一次写进侧车的那一格：模板不消费语速时键与 rate 无关，同一份
    // 字节会被不同倍率重放——差额跟着请求走才对得上耳朵，滑杆才不会一调就撒谎。
    if (cached !== null) return { key, playbackRate: residualOf(p.rate, cached.appliedRate) }
    // 查缓存的窗口里被取消：磁盘上的字节是既定事实，但没必要再为一段没人听的内容发一次合成
    if (signal !== undefined && signal.aborted) throw abortReasonOf(signal)
    const audio = await plan.produce(signal)
    await this.deps.cache.put(key, audio.bytes, audio.mediaType, audio.appliedRate)
    return { key, playbackRate: residualOf(p.rate, audio.appliedRate) }
  }

  /** 音频读口（路由层凭合成回执的 key 取字节）；未知/非法 key → null（404，不是空音频）。 */
  async openAudio(key: string): Promise<AudioResource | null> {
    return this.deps.cache.open(key)
  }

  /**
   * 引擎源清单 + 宿主服务健康：**同一次读数算出来**，不分两次问（两次快照之间引擎换了
   * 口径，清单与健康就会各说一套）。清单那一半的次序是：内置（开箱即用，不落注册表）
   * → 浏览器直出兜底 → 注册表里的每条订阅 → cordis（仅当 getter 此刻返回服务**且服务自报就绪**）。
   * 展示名只有订阅源自带（引擎实体的 `name`）；插件自有源不带名，由客户端按 kind/id 取词。
   * 不可用的 cordis 不进清单——清单的承诺是「列出的都在此刻可用」；它为什么不在，
   * 由 `hostSpeech` 那一格说（缺席与未就绪是两件事，修法不同）。
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

  /** 宿主语音服务的可选读数。服务中途卸装是约定；读数本身抛错也只算**这一源**不可用——
   *  不能让一个可选服务的 capabilities 失败把内置 / 浏览器源的清单一起打成 500。
   *  但「读不出」不等于「不在场」：服务对象在场、它的状态读不出来时按未就绪报（`ADR-0083`），
   *  让用户去检查配置，而不是把一次重装插件当成修法。 */
  private speechReadout(): SpeechReadout {
    try {
      const service = this.deps.speechSynthesis()
      return service === undefined ? { kind: 'absent' } : { kind: 'service', service }
    } catch (e) {
      log.warn('宿主朗读服务读数失败，本次按未就绪处理：', e)
      return { kind: 'unreadable' }
    }
  }

  /**
   * engineId → 源。`builtin:` 只认内置表（注册表里即便有同名 id 也不顶替内置身份）；
   * cordis 是固定身份；其余按注册表。未知 → TTS_ENGINE_MISSING（调用方据 code 映射 400）。
   */
  private targetOf(engineId: string): SynthesisTarget {
    // 保留前缀的判据只住 wire（`TTS_RESERVED_ID_PREFIX`）：这里只引用，不抄一份字面量——
    // 改前缀时不必回来改第二处。
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

  /** HTTP 支的计划：请求求值一次，键材料（求值后的 method/url/body）与 produce 在同一处
   *  产出——命中时只读键材料，不再求值第二次。 */
  private async planHttp(engine: HttpTtsEngine, p: SynthesisRequest): Promise<TtsSynthesisPlan> {
    const plan = await planTtsRequest(
      engine,
      { text: p.text, rate: p.rate, ...(p.voice === undefined ? {} : { voice: p.voice }) },
      { fetcher: this.deps.fetcher, jsTimeoutMs: readValue(this.deps.jsTimeoutMs) },
    )
    // 语速归谁：规则里写了 `speakSpeed` 就是引擎自己念的（内置口是 1–7 档，订阅模板各说各的），
    // 这份字节记作「引擎应用了请求的那一档」；没写就是原速的一段，记 1 并把整段倍率交给播放端
    // ——否则滑杆就是个假控件。
    const appliedRate = ruleCarriesSpeechRate(engine) ? p.rate : 1
    return {
      identity: JSON.stringify([plan.method, plan.url, plan.body ?? null]),
      produce: async (signal) => ({
        ...(await this.fetchHttp(engine, plan, signal)),
        appliedRate,
      }),
    }
  }

  /** cordis 支的计划：键材料取自映射侧的 `cordisCacheIdentity`（与 rate→voiceRate 映射同侧），
   *  产出此刻不碰服务——getter 每次重查留在 produce 里，命中路径不触引擎 / 服务。 */
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
      // 取消不是上游失败：抓取层在取消时抛的就是 `signal.reason`，按同一份类型纪律交回——连败
      // 计数与错误信封都不该把一次作废当成「引擎坏了」的证据。
      if (signal !== undefined && signal.aborted) throw abortReasonOf(signal)
      // 请求失败属「上游」那一档：原始异常类型不外泄给路由面，原话带上——
      // 用户要看得到「HTTP 500」「请求超时」「响应超过大小上限」这类可行动的原因。
      // 地址除外：模板能把登录态求值进 URL（凭据只写不读，错误信封与日志都不是新的读口），
      // 所以先经 `redactOutboundError` 摘掉求值后的地址，只留状态 / 超时 / 上限这些事实。
      // 引擎名用实体自己的 `name`：订阅名是用户数据，内置那条是上游品牌名；服务端错误原文
      // 一律中文、由 `describeError` 原样上屏（服务端理由不属客户端文案单点），不另做投影。
      throw new TtsSynthesisError(
        'TTS_UPSTREAM', `朗读引擎请求失败（${engine.name}）：${messageOf(redactOutboundError(e, plan.url))}`)
    }
    return {
      bytes: page.raw,
      mediaType: assertAudioContentType(page.raw, page.contentType ?? '', engine.contentType),
    }
  }

  /** cordis 支：getter 每次重查（中途卸装 → 本次缺席）；服务返回字节 + 可选 contentType，
   *  与 HTTP 响应过同一条「必须是音频」的判据，因此共用同一份缓存。取消位交给适配器的
   *  `guardSynthesis`（它与本支死线汇成一条信号），这一层只分流、不另造一条取消径。 */
  private async synthesizeCordis(
    p: SynthesisRequest, signal: AbortSignal | undefined,
  ): Promise<{ bytes: Buffer; mediaType: string; appliedRate: number }> {
    const readout = this.speechReadout()
    if (readout.kind === 'absent') {
      throw new TtsSynthesisError('TTS_ENGINE_MISSING', `朗读服务缺席：${CORDIS_TTS_ENGINE_ID}`)
    }
    if (readout.kind === 'unreadable') {
      // 在场读不出：不是「没这个引擎」（400），是此刻不可用（503）——与未就绪同一档，
      // 且不拿一次注定失败的上游请求当报错（服务在，但连自己的状态都交不出来）。
      throw new TtsSynthesisError(
        'TTS_ENGINE_UNAVAILABLE', '宿主朗读服务读数失败，暂时不可用：到该插件里检查配置')
    }
    const service = readout.service
    if (!service.ready) {
      // 服务自报还没配好（缺密钥、音色不齐…）：先把原因码上屏，再谈合成——拿一次注定失败的
      // 上游请求当报错，既花钱也说不清是谁的问题。原因码原样带（服务方的稳定码，不是本仓编的）。
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
      // 取消不是上游失败（`ADR-0082` 决定 5）：调用方已经不要这一发了，理由原样交回。包成
      // TTS_UPSTREAM 会把一次作废记成引擎连败的证据——与 HTTP 支同一个出口、同一条纪律。
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
