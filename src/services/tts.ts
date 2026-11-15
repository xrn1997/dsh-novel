import { BROWSER_TTS_ENGINE_ID, CORDIS_TTS_ENGINE_ID, TTS_DEFAULTS, TTS_RESERVED_ID_PREFIX } from '../shared/wire.js'
import type { SynthesisReceipt, SynthesisRequest, TtsSourceInfo, TtsVoice } from '../shared/wire.js'
import type { FetchedPage, Fetcher } from './fetcher.js'
import { TtsSynthesisError, redactOutboundError } from './errors.js'
import { fetchInitOf } from './request.js'
import type { RequestPlan } from './request.js'
import { TtsAudioCache, ttsCacheKey } from './tts-cache.js'
import type { AudioResource } from './tts-cache.js'
import type { TtsEngineRegistry } from './tts-engines.js'
import { log } from './log.js'
import { cordisCacheIdentity } from './tts-cordis.js'
import { assertAudioContentType, planTtsRequest } from './tts-request.js'
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
  synthesize(req: {
    text: string
    voice?: string
    rate?: number
  }): Promise<{ data: Buffer; contentType?: string }>
}

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
  /** 未命中才执行：出音频字节与 mediaType；失败照合成面的错误语义抛（不吞、不降级） */
  produce(): Promise<{ bytes: Buffer; mediaType: string }>
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

export class TtsService {
  private readonly deps: TtsServiceDeps

  constructor(deps: TtsServiceDeps) {
    this.deps = deps
  }

  /**
   * 合成一段：targetOf → 造计划 → 查缓存 → 命中即回执（不执行 produce）；未命中 produce
   * 出字节再入缓存。失败只抛给调用方——单段失败只影响那一段，本层不吞、不返回空音频。
   */
  async synthesize(p: SynthesisRequest): Promise<SynthesisReceipt> {
    const target = this.targetOf(p.engineId)
    const plan = target.kind === 'cordis'
      ? this.planCordis(p)
      : await this.planHttp(target.engine, p)
    const key = ttsCacheKey({ engineId: p.engineId, request: plan.identity, text: p.text })
    // 命中只需知道「这条字节可读」：回执不带 mediaType（类型事实归音频读口的侧车），
    // 所以查 `has` 而不是打开再销毁一条流。
    if (await this.deps.cache.has(key)) return { key }
    const audio = await plan.produce()
    await this.deps.cache.put(key, audio.bytes, audio.mediaType)
    return { key }
  }

  /** 音频读口（路由层凭合成回执的 key 取字节）；未知/非法 key → null（404，不是空音频）。 */
  async openAudio(key: string): Promise<AudioResource | null> {
    return this.deps.cache.open(key)
  }

  /**
   * 引擎源清单：内置（开箱即用，不落注册表）→ 浏览器直出兜底 → 注册表里的每条订阅
   * → cordis（**仅当 getter 此刻返回服务**，并透传它的音色表）。
   * 顺序 = 展示顺序：兜底排在内置之后、订阅之前，cordis 作为可选增强排最后。
   * 展示名只有订阅源自带（引擎实体的 `name`）；插件自有源不带名，由客户端按 kind/id 取词。
   */
  sources(): TtsSourceInfo[] {
    const listed: TtsSourceInfo[] = [
      ...BUILTIN_TTS_ENGINES.map((e) => sourceInfo(e.id, 'builtin', e.voices)),
      sourceInfo(BROWSER_TTS_ENGINE_ID, 'browser'),
      ...this.deps.engines.list().map((e): TtsSourceInfo => ({
        ...sourceInfo(e.id, 'http', e.voices),
        name: e.name,
      })),
    ]
    const service = this.speechService()
    if (service !== undefined) {
      listed.push({
        ...sourceInfo(CORDIS_TTS_ENGINE_ID, 'cordis'),
        ...(service.voices === undefined ? {} : { voices: service.voices }),
      })
    }
    return listed
  }

  /** 宿主语音服务的可选读数：服务中途卸装是约定，读数本身抛错也只算这一源不可用——
   *  不能让一个可选服务的 capabilities 失败把内置 / 浏览器源的清单一起打成 500。 */
  private speechService(): NormalizedSpeechSynthesis | undefined {
    try {
      return this.deps.speechSynthesis()
    } catch (e) {
      log.warn('宿主朗读服务读数失败，本次按缺席处理：', e)
      return undefined
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
    return {
      identity: JSON.stringify([plan.method, plan.url, plan.body ?? null]),
      produce: () => this.fetchHttp(engine, plan),
    }
  }

  /** cordis 支的计划：键材料取自映射侧的 `cordisCacheIdentity`（与 rate→voiceRate 映射同侧），
   *  产出此刻不碰服务——getter 每次重查留在 produce 里，命中路径不触引擎 / 服务。 */
  private planCordis(p: SynthesisRequest): TtsSynthesisPlan {
    return {
      identity: cordisCacheIdentity(p),
      produce: () => this.synthesizeCordis(p),
    }
  }

  /** HTTP 支出站：计划已求值，这里只发请求并校验「响应必须是音频」。 */
  private async fetchHttp(
    engine: HttpTtsEngine, plan: RequestPlan,
  ): Promise<{ bytes: Buffer; mediaType: string }> {
    let page: FetchedPage
    try {
      // 上限随请求下传而不是读回来再量：fetchPage 在流上边读边计，超限即取消连接。
      page = await this.deps.fetcher.fetchPage(plan.url, {
        ...fetchInitOf(plan),
        maxBytes: TTS_AUDIO_MAX_BYTES,
      })
    } catch (e) {
      if (e instanceof TtsSynthesisError) throw e
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
   *  与 HTTP 响应过同一条「必须是音频」的判据，因此共用同一份缓存。 */
  private async synthesizeCordis(p: SynthesisRequest): Promise<{ bytes: Buffer; mediaType: string }> {
    const service = this.speechService()
    if (service === undefined) {
      throw new TtsSynthesisError('TTS_ENGINE_MISSING', `朗读服务缺席：${CORDIS_TTS_ENGINE_ID}`)
    }
    let result: { data: Buffer; contentType?: string }
    try {
      result = await service.synthesize({
        text: p.text,
        ...(p.voice === undefined ? {} : { voice: p.voice }),
        rate: p.rate,
      })
    } catch (e) {
      if (e instanceof TtsSynthesisError) throw e
      throw new TtsSynthesisError('TTS_UPSTREAM', `朗读服务合成失败：${messageOf(e)}`)
    }
    return { bytes: result.data, mediaType: assertAudioContentType(result.data, result.contentType ?? '') }
  }
}
