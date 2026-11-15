import type { SpeechCapabilities, SpeechSynthesisService } from 'dsh-xiaomi-tts/host-api'
import { CORDIS_TTS_ENGINE_ID } from '../shared/wire.js'
import type { TtsVoice } from '../shared/wire.js'
import { TtsSynthesisError } from './errors.js'
import { abortReasonOf } from './tts-cancel.js'
import type { NormalizedSpeechSynthesis } from './tts.js'

/**
 * 可选消费宿主 `speechSynthesis` 服务的适配器：把那份服务的宿主契约翻成插件自有的
 * `NormalizedSpeechSynthesis`（住 `tts.ts`）。合成面只认归一形状；这份私有契约的翻译全在
 * 本文件，换服务/换契约不动合成链。本支的缓存键材料 `cordisCacheIdentity` 也住这里——
 * 它与字段映射同侧，映射口径一变就得一起看。
 *
 * 边界：服务包的类型只经 type-only import 进来（devDependency）——运行时零依赖，服务缺席时
 * 插件照样装载（`ctx.get` 返回 undefined 走缺席分支），构建期类型被整体擦除。宁可装一整包
 * 换这一份类型声明：契约由发布物本身背书，手抄一份窄镜像就是给同一契约造第二个主人，
 * 而它变了不会有任何东西变红。包名与来历见 `package.json` 与 `README.md`。
 *
 * 字段映射以已装服务包的类型声明为准（`SpeechRequest`）：
 * - `text` → `text`；
 * - `voice` → `voice`（可选模型/音色覆盖；缺席 = 用服务保存的选择）；
 * - `rate` → `voiceRate`：**只发当前有效供应商所选模型声明支持的那一档**——能力位为 false
 *   或读不出 provider / 模型时整字段缺席（不发 1 冒充）；支持时按宿主契约夹到 0.5–2。
 *   插件自己的语速域（`shared/wire.ts` 的 `TTS_RATE`，0.5–3）是播放层的事，两者不是一把尺；
 * - `format` 不传：服务按自身配置给 WAV 或 MP3，音频字节与 contentType 原样带回；
 * - `signal` 每次现造一只（见 `guardSynthesis`）：调用方的取消位与本地死线汇成一条，服务那一侧
 *   据此终止上游请求——取消不只在本地「不等了」。
 */

/**
 * 宿主 `voiceRate` 的值域 0.5–2：出处是服务包的公开契约（发布物里的 `open-api.md` 请求字段表，
 * 与类型声明里的 `SpeechModelCapabilities.voiceRate` 能力位；服务包与来历见 `README.md`）。
 * **这是宿主契约的翻译侧**：插件语速 0.5–3 与它不是同一份域，`rate → voiceRate` 的夹取只住
 * 本文件，别在别处再夹一次。
 */
const HOST_VOICE_RATE = { min: 0.5, max: 2 } as const

/**
 * 宿主服务一次合成的等待上限（毫秒）。HTTP 支的耐心由 fetcher 的请求超时收口；服务支没有出站
 * 请求，也就没有第二个人替它收口——服务方卡住时播放层会一直等下去，连败与重试都不会动。
 * 数上与出站请求的缺省耐心对齐（两支对「多久算卡住」同一直觉），但它是**本支自己的常量**：
 * 服务合成不是一次出站请求，不跟 `searchTimeoutMs` 那格配置走。导出给测试引（用例用假计时器
 * 驱动一个永不落定的服务）。
 */
export const CORDIS_SYNTHESIS_TIMEOUT_MS = 15_000

/** 一次服务合成的守卫：调用方的取消位与本支自己的死线**汇成一只信号**递给服务。
 *  两条腿都必须落到服务那一侧——只拒本地 Promise 等于「我们不等了」，而上游照样把整段念完
 *  并计费（宿主契约把 `signal` 写成了宿主插件的取消入口，用的就是这一处）。
 *  拒绝理由的归属：调用方取消 → 交回它的 `reason`（那不是一个上游失败，是一次作废，理由的类型
 *  纪律由 `abortReasonOf` 收口）；死线到点 → `TTS_UPSTREAM` 带毫秒数；服务自己的拒绝 → 是 Error
 *  就借它的原话，不是 Error 也包成 Error（Promise 拒绝理由的类型纪律与上层「原话借来看」同一口径）。 */
async function guardSynthesis<T>(caller: AbortSignal | undefined, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  // 已取消的调用一个字节都不发：合成有副作用（上游计费），取消了还发等于说谎
  if (caller !== undefined && caller.aborted) throw abortReasonOf(caller)
  const ctrl = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let abortByCaller: (() => void) | undefined
  // 取消这条腿不依赖服务配合：认 signal 的服务自己终止上游；不认的也不能把我们吊到死线为止。
  const cancelled = new Promise<never>((_, reject) => {
    if (caller === undefined) return
    abortByCaller = (): void => {
      ctrl.abort(caller.reason)
      reject(abortReasonOf(caller))
    }
    caller.addEventListener('abort', abortByCaller, { once: true })
  })
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctrl.abort()
      reject(new TtsSynthesisError(
        'TTS_UPSTREAM', `宿主朗读服务合成超时（${CORDIS_SYNTHESIS_TIMEOUT_MS}ms）`))
    }, CORDIS_SYNTHESIS_TIMEOUT_MS)
  })
  try {
    const work = run(ctrl.signal)
    // 死线或取消之后服务那一发仍可能迟到拒绝：这一份 promise 已经没人等了，给它一条静默的出路
    work.catch(() => undefined)
    return await Promise.race([work, cancelled, deadline])
  } catch (e) {
    if (caller?.aborted === true) throw abortReasonOf(caller)
    throw e instanceof Error ? e : new Error(String(e))
  } finally {
    // 三条腿都在 settle 时收干净：留下的监听器会让下一次取消拒绝一条已经没人等的 promise
    if (timer !== undefined) clearTimeout(timer)
    if (caller !== undefined && abortByCaller !== undefined) caller.removeEventListener('abort', abortByCaller)
  }
}

/** **有效供应商**的唯一解读者：外部接管优先，回落到保存的内置配置（宿主契约里
 *  `currentProvider()` 才是「这次合成会交给谁」，`capabilities().provider` 只是保存值）。
 *  音色表、语速能力位、就绪态三格全部按它取——三处各读各的会让界面摆出发不出去的音色。
 *  方法是可选的（旧宿主没有），缺席才信 `capabilities().provider`。 */
function effectiveProviderId(svc: SpeechSynthesisService, caps: SpeechCapabilities): string {
  return svc.currentProvider?.() ?? caps.provider
}

/**
 * capabilities 的哪一格是「音色表」：**有效供应商所选模型**的 voices。
 * 不 flatten 全体供应商：`synthesize` 不显式给 provider/model 时服务用的正是这份选择，
 * 列别的模型的音色会让用户选到发不出去的 id。所选模型不在清单里（如浏览器本地兜底）
 * 就照实没有音色表——缺席不是空表，UI 不渲染音色行。
 */
function voicesOf(svc: SpeechSynthesisService, caps: SpeechCapabilities): TtsVoice[] {
  const provider = caps.providers.find((p) => p.id === effectiveProviderId(svc, caps))
  if (provider === undefined) return []
  const model = provider.models.find((m) => m.id === provider.selectedModel)
  if (model === undefined) return []
  return model.voices.map((v) => ({ id: v.id, name: v.name }))
}

/** 这一源**此刻能不能合成**：读有效供应商那一格的 `ready`（宿主的本地校验读数——密钥格式、
 *  音色齐不齐，不等于上游账户与额度已验证）。读不出那一格按不可用处理：源清单承诺
 * 「列出的都在此刻可用」，缺读不是可用。原因码原样带（宿主给什么报什么，本仓不编码）。 */
function readinessOf(
  svc: SpeechSynthesisService, caps: SpeechCapabilities,
): { ready: boolean; unavailableReason?: string } {
  const provider = caps.providers.find((p) => p.id === effectiveProviderId(svc, caps))
  if (provider === undefined) return { ready: false }
  return provider.ready
    ? { ready: true }
    : { ready: false, ...(provider.unavailableReason === undefined ? {} : { unavailableReason: provider.unavailableReason }) }
}

/**
 * 当前有效供应商所选模型是否接受服务端语速。有效供应商取**外部接管优先**：`currentProvider`
 * 在宿主侧先看外部接管、再回保存的内置配置，且它是可选方法（旧宿主没有），缺席时才信
 * `capabilities().provider`。能力位读不出（providers 清单里没有该供应商 / 所选模型不在该供应商
 * 的模型清单里）按不支持处理——缺失不是「支持」。
 *
 * 外部接管一律不支持：宿主契约把 `voiceRate` 归 `external-option-unsupported`
 * （open-api.md 的外部提供方段落），发过去只会让整条合成请求 400。
 */
function voiceRateSupported(svc: SpeechSynthesisService, caps: SpeechCapabilities): boolean {
  const providerId = effectiveProviderId(svc, caps)
  if (providerId.startsWith('external:')) return false
  const provider = caps.providers.find((p) => p.id === providerId)
  if (provider === undefined) return false
  const model = provider.models.find((m) => m.id === provider.selectedModel)
  return model?.voiceRate === true
}

/** `rate` → `voiceRate` 的唯一映射：不支持或缺 `rate` → 缺席（不是发 1——那会把插件缺省语速
 *  冒充成用户指定的服务端参数）；支持才发，并在宿主契约的值域上夹取。夹取而非拒收：插件滑杆
 *  的 0.5–3 是用户可选的域，宿主收的是「这次请多快」，夹到边界比整段合成失败更接近意图。 */
function voiceRateOf(
  svc: SpeechSynthesisService, caps: SpeechCapabilities, rate: number | undefined,
): number | undefined {
  if (rate === undefined || !voiceRateSupported(svc, caps)) return undefined
  return Math.min(HOST_VOICE_RATE.max, Math.max(HOST_VOICE_RATE.min, rate))
}

/**
 * cordis 支的缓存键材料（`TtsSynthesisPlan.identity` 的那一位）。**键材料与 rate→voiceRate
 * 映射同侧**：取的是映射的输入（原始音色与语速），服务换口径（映射改写请求）时这里必须
 * 跟着看——语义若不再由「原始参数」决定，就得改键，否则请求变了却命中旧字节。本支没有 URL，
 * 用服务身份串当哨兵顶上：它不是 http(s) 地址，不可能与任何真实引擎的 url 撞键。
 *
 * 键只收**原始 rate + voice + 服务身份，不掺 capabilities**：能力位是服务端此刻的能力，不是
 * 这次请求的内容；而且服务缺席时已缓存段仍必须命中（缓存先于 getter，`ADR-0077` 的半径）。
 * 代价是键可能比实际请求多算——不支持 voiceRate 的模型下各 rate 落到同一个请求，夹取时边界外
 * 的 rate 也落到同一个值，但键仍按原始 rate 各存一份。多算只多占缓存、不改变正确性：每份字节
 * 都与自己那份键对应的请求一致。
 *
 * 取参数不取结果：同一份参数服务端自己决定是否改变音频（`ADR-0069`）；headers 与本支无关，
 * HTTP 支那一位同样不收 headers。
 */
export function cordisCacheIdentity(req: { voice?: string; rate: number }): string {
  return JSON.stringify([CORDIS_TTS_ENGINE_ID, req.voice ?? null, req.rate])
}

/** 服务 → 归一形状。`voices` 在归一化时读一次 `capabilities()`（本地读数，不发上游请求）；
 *  服务对象本身不被缓存——组合根的 getter 每次调用重查并重新调用本函数。
 *  每一发都带取消位（`guardSynthesis`）：这条支没有出站请求，耐心与中止都只能自己给。
 *  `appliedRate` 报的是**这次真发出去的那档**（没发 `voiceRate` = 原速 1）；补速的算术归合成面
 *  （用户要的 ÷ 这一格），本文件不替它算——两个支各自只产「我做了什么」这一份事实。 */
export function normalizeSpeechSynthesis(svc: SpeechSynthesisService): NormalizedSpeechSynthesis {
  const caps = svc.capabilities()
  const voices = voicesOf(svc, caps)
  const readiness = readinessOf(svc, caps)
  return {
    ...readiness,
    ...(voices.length === 0 ? {} : { voices }),
    async synthesize(req, opts) {
      // 能力位每次现读：服务可能在播放中途切供应商 / 被外部接管，读数只是本地快照、不发上游
      // 请求（与组合根 getter 每次重查同一条纪律）；不缓存服务对象，这一份读数同样不缓存。
      const live = svc.capabilities()
      const voiceRate = voiceRateOf(svc, live, req.rate)
      const audio = await guardSynthesis(opts?.signal, (signal) => svc.synthesize({
        text: req.text,
        ...(req.voice === undefined ? {} : { voice: req.voice }),
        ...(voiceRate === undefined ? {} : { voiceRate }),
        signal,
      }))
      return {
        data: audio.data,
        contentType: audio.contentType,
        appliedRate: voiceRate ?? 1,
      }
    },
  }
}

