import { isPlaceholderExpr, scanTemplateSegments, URL_OPTION_SPLIT } from '../engine/index.js'
import { RegexDeadlineError, UnsupportedRuleError } from '../engine/errors.js'
import { engineValueToString } from '../engine/js-utils.js'
import { guardedTest } from '../engine/regex-guard.js'
import type { Facet, SegmentLoc } from '../engine/types.js'
import { TtsSynthesisError } from './errors.js'
import type { Fetcher } from './fetcher.js'
import { headerOf, overlayHeaders } from './fetcher.js'
import { parseObjectJson, stringTableOf } from './normalize.js'
import { assembleRequest, KNOWN_OPTION_KEYS, parseUrlOption } from './request.js'
import type { RequestPlan } from './request.js'
import { createSourceEval } from './source-eval.js'
import type { EvalSource, SourceEval } from './source-eval.js'
import type { HttpTtsEngine } from './types.js'

/**
 * legado HttpTTS 的请求求值：URL 规则（`{{…}}` 占位 / JS 段 / `,{JSON options}`）→ `RequestPlan`，
 * 外加「响应必须是音频」的判定。
 *
 * 依赖只向下走（assembleRequest / SourceEval / 引擎纯工具 / Fetcher），所以朗读合成链的
 * 错误类 `TtsSynthesisError` 的**家**是分类学单点 `services/errors.ts`（本文件只 import，不转发）；
 *  放高层（合成服务）会与它成环。脚本求值走服务半唯一的那扇门（`createSourceEval` 的
 *  `runScript`），本文件不另拼 `JsHost`。
 *
 * 语义口径（`speakText` / `speakSpeed` 是 legado AnalyzeUrl 的绑定，`speakVoice` 是本仓新增）：
 * - `speakText` = 本段正文；`speakSpeed = rate * 10 - 5`（rate 1.0 → 5，legado 的 5–50 刻度）；
 *   `speakVoice` = 本段音色 id（缺省空串）。
 * - `{{…}}` 里的**纯占位**（标识符且在 vars 里）原样留给 `assembleRequest` 编码；其余一律当
 *   JS 表达式进沙箱（`{{java.encodeURI(speakText)}}`、`{{String((speakSpeed+5)/10+4)}}`）。
 *   JS 段以函数参数绑定这三个名字（沙箱的全局清单不含 vars，且本仓不给朗读新开桥参数）。
 * - 引擎 `auth` 经 `engineContextOf` 的登录面投影，脚本里 `source.getLoginInfoMap()` 可读。
 * - 引擎 `header` 是静态头表 JSON；与凭据头一起打底，URL 选项的 headers 覆盖同名。
 *
 * 认不出的语法**解析期抛** `UnsupportedRuleError`（带段级定位），不猜：
 * `@js:` / `<js>` 块形态（朗读面当前只接 `{{…}}`）、坏选项 JSON（assembleRequest 会宽容地
 * 当无选项处理——对朗读引擎那等于丢掉 method/body）、相对 URL（HttpTTS 没有可解析的基准）、
 * 不是头表 JSON 的 `header`。
 */

/** 朗读面没有自己的 Facet 词汇；用现有最贴近值 `'rule'`（与 tts-engines 的导入裁决同口径）。 */
const TTS_FACET: Facet = 'rule'

/** 段级定位里的原文上限（与 search-template 的 `segmentRaw` 同一耐心）。 */
const SEGMENT_RAW_LIMIT = 200

/** 求值后文本的定位占位：模板里的 `{{java.getLoginInfoMap()…}}` 会把凭据求值进 URL / 选项，
 *  错误信封（`segment.segmentRaw`）与日志都不该回显它——凭据只写不读是订阅面的投影纪律，
 *  错误消息不是新的读口。原文（模板本身）仍是公开投影，照原样保留。 */
const SEALED_SEGMENT = '（求值后原文已省略）'

/** HttpTTS 请求求值读入的语音参数。`voice` 绑定成 `speakVoice`（缺省空串）：模板可写
 *  `{{speakVoice}}` 纯占位或 `{{String(speakVoice || "0")}}` 这类表达式；不消费它的引擎不受影响。 */
export interface TtsSpeechParams {
  text: string
  rate: number
  voice?: string
}

export interface TtsRequestDeps {
  fetcher: Fetcher
  jsTimeoutMs: number
}

function locOf(segmentIndex: number, segmentRaw: string): SegmentLoc {
  return { segmentIndex, segmentRaw: segmentRaw.slice(0, SEGMENT_RAW_LIMIT) }
}

function unsupported(message: string, segmentIndex: number, segmentRaw: string): UnsupportedRuleError {
  return new UnsupportedRuleError(message, { facet: TTS_FACET, ...locOf(segmentIndex, segmentRaw) })
}

/** 求值后文本的拒收：定位给占位不给原文（理由见 `SEALED_SEGMENT`）。 */
function unsupportedSealed(message: string, segmentIndex = 0): UnsupportedRuleError {
  return unsupported(message, segmentIndex, SEALED_SEGMENT)
}

/** 书源 URL 链里认得出、但朗读面当前没接的 js 块形态（`@js:`/裸 `js:` 串首、任意位置
 *  的 `<js>…</js>`）。当字面 URL 发出去是猜，故显式拒收。 */
function jsBlockOf(template: string): string | null {
  const closed = /<js>[\s\S]*?<\/js>/i.exec(template)
  if (closed !== null) return closed[0]
  if (/<js>/i.test(template)) return template
  if (/^\s*@?js:/i.test(template)) return template
  return null
}

/** URL 尾部 `,{…}` 选项段的合法性：切分式与 `assembleRequest` 同一把尺（`URL_OPTION_SPLIT`），
 *  合法性判据用同一份 `parseObjectJson`。本函数只在「链会宽容放行」的形态上炸：
 *  切出了选项但解析不出对象、键不在链的实现集里（书源面读不到只留 warn，朗读面照做会发错请求）、
 *  或者要求真浏览器出站（本请求面只有 HTTP）。返回选项原文（无选项 → null）。 */
function checkedOptionText(template: string, evaluated = false): string | null {
  const split = URL_OPTION_SPLIT.exec(template)
  if (split === null) return null
  const optionText = template.slice(split.index + split[0].length)
  // 求值后的选项串可能承载模板从登录态取来的凭据：这类定位只给占位。
  const reject = (message: string): UnsupportedRuleError =>
    evaluated ? unsupportedSealed(message) : unsupported(message, 0, optionText)
  const obj = parseObjectJson(optionText)
  if (obj === undefined) {
    throw reject('朗读引擎 url 的选项不是合法 JSON 对象（不按「无选项」猜）')
  }
  const unknown = Object.keys(obj).filter((k) => !KNOWN_OPTION_KEYS.includes(k))
  if (unknown.length > 0) {
    throw reject(`朗读引擎 url 选项含本链未实现的键：${unknown.join('、')}`)
  }
  if (obj.webView === true || obj.webJs !== undefined) {
    throw reject('朗读引擎 url 选项的 webView/webJs 需要真浏览器出站，朗读请求面只有 HTTP')
  }
  return optionText
}

/** 引擎静态头（legado HttpTTS 的 `header`：JSON 头表字符串）。缺省 = 空表；
 *  有值但不是对象 JSON → 解析期炸（不静默按无头发请求）。 */
function staticHeadersOf(engine: HttpTtsEngine): Record<string, string> {
  if (engine.header === undefined || engine.header.trim() === '') return {}
  const parsed = parseObjectJson(engine.header)
  if (parsed === undefined) {
    throw unsupported('朗读引擎 header 不是合法 JSON 头表', 0, engine.header)
  }
  return stringTableOf(parsed)
}

/** 引擎 → 求值缝可吃的最小源形状。`baseUrl` 同时是脚本可见的 `source` 身份（`source.key`）：
 *  朗读引擎没有可供相对解析的地址，用引擎 id 作按引擎隔离的源键；脚本里的 `baseUrl` 全局
 *  由 `runScript` 的 `baseUrl` 入参给（空串——没有页面基准）。 */
function evalSourceOf(engine: HttpTtsEngine, headers: Record<string, string>): EvalSource {
  return {
    baseUrl: engine.id,
    name: engine.name,
    raw: engine,
    rules: { jsLib: engine.jsLib ?? null, header: headers, headerRule: null },
    ...(engine.auth === undefined ? {} : { auth: engine.auth }),
  }
}

/** 一段 `{{expr}}` 的沙箱求值。绑定用函数参数而不是沙箱全局：`speakText`/`speakSpeed`/
 *  `speakVoice` 是朗读面专属输入，`EvalContext.vars` 刻意不投影成全局（script-surface 的
 *  excluded 清单），也不该为一个消费面加宽桥参数名册。
 *  执行走**服务半唯一的脚本门**（`SourceEval.runScript` → `js-sandbox.runScript`）：能力面装配
 *  只在 `engineContextOf` 一处，本消费面不另拼 `JsHost`（`docs/architecture.md` §2.1）。
 *  `scriptForm: false`：代码带顶层 `return`；表达式编译不过时如实抛（script 形态会回落函数体
 *  形态、把错表达式读成空串——那是「空结果冒充失败」）。 */
async function evalSegment(o: {
  expr: string
  segmentIndex: number
  segmentRaw: string
  text: string
  speed: number
  voice: string
  header: Record<string, string>
  ev: SourceEval
}): Promise<string> {
  const code = `return (function (speakText, speakSpeed, speakVoice) { return (${o.expr}) })`
    + `(${JSON.stringify(o.text)}, ${JSON.stringify(o.speed)}, ${JSON.stringify(o.voice)})`
  const outcome = await o.ev.runScript(code, {
    // 朗读引擎没有可供相对解析的页面基准；`source` 身份由求值缝按 `EvalSource.baseUrl`（引擎 id）装。
    baseUrl: '',
    facet: TTS_FACET,
    vars: { speakText: o.text, speakSpeed: String(o.speed), speakVoice: o.voice },
    // 脚本可见的 `source.header` 是源静态头（不含凭据头，同书源口径）
    header: JSON.stringify(o.header),
    loc: locOf(o.segmentIndex, o.segmentRaw),
    scriptForm: false,
  })
  // EngineValue → 单串的唯一实现住 `engine/js-utils.ts`：缺 kind 分支等于静默丢结果
  return engineValueToString(outcome.value, 'inner')
}

/** `{{…}}` 全量预求值：纯占位原样保留（交给 assembleRequest 的编码口径），其余进沙箱。 */
async function evaluateTemplate(o: {
  template: string
  vars: { speakText: string; speakSpeed: number; speakVoice: string }
  header: Record<string, string>
  ev: SourceEval
}): Promise<string> {
  const parts = scanTemplateSegments(o.template)
  if (!parts.some((p) => p.kind === 'expr')) return o.template
  let out = ''
  let segmentIndex = 0
  for (const part of parts) {
    if (part.kind === 'text') {
      out += part.text
      continue
    }
    const index = segmentIndex
    segmentIndex += 1
    if (isPlaceholderExpr(part.expr, o.vars)) {
      out += part.raw
      continue
    }
    out += await evalSegment({
      expr: part.expr,
      segmentIndex: index,
      segmentRaw: part.raw,
      text: o.vars.speakText,
      speed: o.vars.speakSpeed,
      voice: o.vars.speakVoice,
      header: o.header,
      ev: o.ev,
    })
  }
  return out
}

/** HttpTTS 没有 baseUrl 字段：相对地址没有可解析的基准（猜一个域名比炸更坏）。
 *  `url` 是**求值后**的地址，可能带着模板刚从登录态取来的凭据：消息只说事实（不是绝对地址 /
 *  协议不支持），不把地址本身回显到错误信封或日志。 */
function assertAbsoluteHttpUrl(url: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw unsupportedSealed('朗读引擎 url 不是绝对地址（HttpTTS 没有相对解析基准）')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw unsupportedSealed(`朗读引擎 url 协议不支持：${parsed.protocol}`)
  }
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some((k) => k.toLowerCase() === name)
}

/** 摘掉同名头（大小写不敏感，重建表而不是动态 delete）。 */
function withoutHeader(headers: Record<string, string>, name: string): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([k]) => k.toLowerCase() !== name))
}

/**
 * URL 规则 → 可执行请求计划（纯求值，不发请求）。
 * 步骤：结构校验 → `{{…}}` 沙箱预求值 → 选项复验 → `assembleRequest` → 绝对地址校验 →
 * 静态头/凭据头打底（选项头覆盖同名）。
 */
export async function planTtsRequest(
  engine: HttpTtsEngine,
  p: TtsSpeechParams,
  deps: TtsRequestDeps,
): Promise<RequestPlan> {
  const template = engine.url.trim()
  if (template === '') throw unsupported('朗读引擎 url 为空', 0, engine.url)
  const jsBlock = jsBlockOf(template)
  if (jsBlock !== null) {
    throw unsupported('朗读引擎 url 的 js 块形态（@js:/<js>）本链未接；请把表达式写进 {{…}}', 0, jsBlock)
  }
  checkedOptionText(template)

  const staticHeaders = staticHeadersOf(engine)
  const source = evalSourceOf(engine, staticHeaders)
  const baseHeaders = headerOf(source)   // 静态头打底 + 凭据头/凭据 cookie（同名凭据占优）
  const ev = createSourceEval(deps.fetcher, source, { jsTimeoutMs: deps.jsTimeoutMs })
  const vars = { speakText: p.text, speakSpeed: p.rate * 10 - 5, speakVoice: p.voice ?? '' }
  const evaluated = await evaluateTemplate({
    template,
    vars,
    header: staticHeaders,   // 脚本可见的 source.header 是源静态头（不含凭据头，同书源口径）
    ev,
  })
  // JS 段可能产出新的选项串、也可能把原选项写成坏 JSON：按求值后的文本再验一次
  checkedOptionText(evaluated, true)

  const plan = assembleRequest(evaluated, vars, null)
  assertAbsoluteHttpUrl(plan.url)
  // assembleRequest 在「有 body 且计划里没有 content-type」时补表单默认头。若 Content-Type 来自
  // 引擎静态头/凭据头（而不是 URL 选项），那句默认头会盖掉显式声明——按「选项头占优、静态头是
  // 基线」的同名覆盖序，先摘掉默认头，再叠基线。
  const optionHeaders = parseUrlOption(evaluated).option?.headers ?? {}
  if (plan.body !== undefined && !hasHeader(optionHeaders, 'content-type') && hasHeader(baseHeaders, 'content-type')) {
    plan.headers = withoutHeader(plan.headers, 'content-type')
  }
  plan.headers = overlayHeaders(baseHeaders, plan.headers)
  return plan
}

/** 上游响应体的摘要：错误页正文通常是 JSON/HTML 的人类可读消息，截短并压平空白即可读；
 *  它只进错误消息（不进响应头/日志结构），不承载判据。 */
const DIGEST_BYTES = 512
const DIGEST_CHARS = 200

function upstreamDigest(raw: Buffer): string {
  const text = raw.subarray(0, DIGEST_BYTES).toString('utf8').replace(/\s+/g, ' ').trim()
  return text.length > DIGEST_CHARS ? `${text.slice(0, DIGEST_CHARS)}…` : text
}

/** Content-Type → mediaType（参数剥掉、小写）。 */
function mediaTypeOf(contentType: string): string {
  const semi = contentType.indexOf(';')
  return (semi < 0 ? contentType : contentType.slice(0, semi)).trim().toLowerCase()
}

/** 「错误信息」的响应类型（legado 口径）：json/text/xml 一定是错误页，不是音频。
 *  `+json` / `+xml` 后缀（application/problem+json 一类）同算文本。 */
function isTextualMediaType(mediaType: string): boolean {
  return mediaType === 'application/json' || mediaType.endsWith('+json')
    || mediaType === 'application/xml' || mediaType.endsWith('+xml')
    || mediaType === 'application/javascript'
    || mediaType.startsWith('text/')
}

/** 引擎声明（legado 的 `contentType` 是正则）与响应 mediaType 的比对。
 *  声明不是合法正则 = 引擎配置坏了，任何响应都过不了这道校验：照 BAD_RESPONSE 如实报，
 *  不退回字面比较（那会让坏声明悄悄变成另一种判据）。
 *  执行走**用户正则的唯一死线实现** `engine/regex-guard.ts`：订阅可从 URL 导入，声明是外部数据，
 *  病态模式不许在主线程上钉住事件循环（`ADR-0050`）。超时与坏声明同档——都是引擎配置坏了，
 *  如实报 BAD_RESPONSE，不把超时静默读成「不匹配」。 */
function assertDeclared(mediaType: string, declared: string): void {
  const pattern = declared.trim()
  let re: RegExp
  try {
    re = new RegExp(pattern, 'i')
  } catch {
    throw new TtsSynthesisError('TTS_BAD_RESPONSE', `朗读引擎声明的 contentType 不是合法正则：${pattern}`)
  }
  let matched: boolean
  try {
    matched = guardedTest(re, mediaType)
  } catch (e) {
    if (!(e instanceof RegexDeadlineError)) throw e
    throw new TtsSynthesisError(
      'TTS_BAD_RESPONSE', `朗读引擎声明的 contentType 正则求值超时（疑似灾难性回溯）：${pattern}`)
  }
  if (!matched) {
    throw new TtsSynthesisError(
      'TTS_BAD_RESPONSE', `朗读响应类型与引擎声明不符（响应 ${mediaType}，声明 ${pattern}）`)
  }
}

/**
 * 响应必须是音频：零字节、JSON/text 响应（错误页）或与引擎声明不符 → `TTS_BAD_RESPONSE`，
 * 消息带上游正文摘要（用户要看得到「无效的 token」这类站点原话）。
 * 缺 Content-Type 不是「声明不符」（没有可比的类型）：返回中性的 `application/octet-stream`，
 * 不把缺席读成某个具体音频类型。返回 mediaType 供缓存侧车与音频读口的 content-type 使用。
 */
export function assertAudioContentType(raw: Buffer, contentType: string, declared?: string): string {
  const mediaType = mediaTypeOf(contentType)
  // 零字节必须在入缓存前炸掉：回执一旦指向一段空音频，读口就永远给它发空字节——音频缓存没有
  // 「清缓存」入口（`ADR-0068`），那一段此后每次命中都是静默，正是本仓最忌的空结果冒充可用。
  if (raw.byteLength === 0) {
    throw new TtsSynthesisError('TTS_BAD_RESPONSE', `朗读引擎返回 0 字节音频（${mediaType === '' ? '未声明类型' : mediaType}）`)
  }
  if (isTextualMediaType(mediaType)) {
    throw new TtsSynthesisError(
      'TTS_BAD_RESPONSE', `朗读响应不是音频（${mediaType}）：${upstreamDigest(raw)}`)
  }
  if (mediaType === '') return 'application/octet-stream'
  if (declared !== undefined && declared.trim() !== '') assertDeclared(mediaType, declared)
  return mediaType
}
