import { isEngineError } from '../engine/index.js'
import type { JobState } from '../shared/wire.js'
import { LocalArtifactNotFoundError, LocalFileTooLargeError, LocalImportError } from './localbooks.js'
import { EpubImportError } from './epub/errors.js'

/** 书源不存在（API 层映射 404）。不要用裸 Error + 中文前缀匹配来分类：分类权会活在文案作者手里；本类走 instanceof 作唯一判据。 */
export class SourceNotFoundError extends Error {
  readonly sourceId: string
  constructor(sourceId: string) {
    super(`源不存在: ${sourceId}`)
    this.name = new.target.name
    this.sourceId = sourceId
  }
}

/** 目录中没有第 N 章（API 层映射 404 NotFound）；total 随身带出，报错即说清边界 */
export class ChapterNotFoundError extends Error {
  readonly chapterIndex: number
  readonly total: number
  constructor(chapterIndex: number, total: number) {
    super(`目录中没有第 ${chapterIndex} 章（共 ${total} 章）`)
    this.name = new.target.name
    this.chapterIndex = chapterIndex
    this.total = total
  }
}

/** 书源缺规则导致某一面无法执行（API 层映射 422，wire 错误码 'RuleMissing'——与探针的 RuleMissing 同一词汇）。不要退回裸 Error：那会映射成 500。 */
export class RuleMissingError extends Error {
  /** 缺的是哪一面的规则（facet 词汇：toc / content …） */
  readonly facet: string
  /** 缺的规则名（如 ruleChapterList / ruleContent）——报错即点名 */
  readonly rule: string
  constructor(facet: string, rule: string, message: string) {
    super(message)
    this.name = new.target.name
    this.facet = facet
    this.rule = rule
  }
}

/** 出站请求失败（超时/网络层异常/HTTP 非 2xx）；引擎错误类不重定义、不包装（instanceof 直通） */
export class FetchError extends Error {
  readonly url: string
  readonly status?: number

  constructor(message: string, opts: { url: string; status?: number }) {
    super(message)
    this.name = new.target.name
    this.url = opts.url
    if (opts.status !== undefined) this.status = opts.status
  }
}

/** 声明的 charset 解不出（iconv-lite 不认识）；宁可报「这页编码解不出」，不拿乱码冒充正文 */
export class DecodeError extends Error {
  readonly url: string
  readonly charset: string

  constructor(message: string, opts: { url: string; charset: string }) {
    super(message)
    this.name = new.target.name
    this.url = opts.url
    this.charset = opts.charset
  }
}

/** 失败原话里的地址替身：保留「这里原来有一个地址」这一事实，不回显地址本身。 */
const REDACTED_URL = '（地址已省略）'

/** 把地址从一句话里摘掉：只摘这一串字面（失败原话里嵌的就是请求时用的那个串）。 */
function withoutUrl(message: string, url: string): string {
  return url === '' ? message : message.split(url).join(REDACTED_URL)
}

/** 出站失败的脱敏副本：`FetchError` / `DecodeError` 的文案与 `url` 字段都内嵌这次请求的地址，而地址可能带凭据（朗读模板能把登录态
 *  求值进 URL；订阅地址可能带签名 token）。错误信封与日志都不是新的读口：只摘地址，换回同类错误（类目、HTTP 状态、charset 照留）。
 *  其余异常原样交回。 */
export function redactOutboundError(e: unknown, url: string): unknown {
  if (e instanceof FetchError) {
    return new FetchError(withoutUrl(e.message, url), {
      url: REDACTED_URL,
      ...(e.status === undefined ? {} : { status: e.status }),
    })
  }
  if (e instanceof DecodeError) {
    return new DecodeError(withoutUrl(e.message, url), { url: REDACTED_URL, charset: e.charset })
  }
  return e
}

/** 调用方给的参数本身不成立（API 层映射 400）——**值域**判据，不是 body 形状判据（形状归路由自检的 `ApiError`）。两者分开是因为值域要护
 *  每一个调用方：门面动词被 HTTP 面与工具面同时调用，门长在路由里只护一半（工具面可直接写入 Infinity → JSON.stringify 落盘成 null）。 */
export class InvalidRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

/** 书不在架上（API 层映射 400）：**更新路径**的缺席语义——打补丁 / 写进度 / 存听书位置都要求书已在架。删除路径的缺席是幂等成功，不是本类：
 *  同一个「按 key 点的目标不存在」，两个动词两种后果。HTTP 那句可行动文案归 `api/dispatch.ts`。 */
export class BookNotOnShelfError extends Error {
  readonly bookKey: string
  constructor(bookKey: string) {
    super(`书架里没有这本书: ${bookKey}`)
    this.name = new.target.name
    this.bookKey = bookKey
  }
}

/** 运行中重复提交任务：路由层映射 409。类住在错误分类学单点；不要反向 import（errors → import-job 会与探针状态单点合成值环）。 */
export class JobRunningError extends Error {
  constructor(running: JobState) {
    super(`已有任务在运行（${running.kind === 'import' ? '导入' : '验证'} ${running.done}/${running.total}）`)
    this.name = 'JobRunningError'
  }
}

/** 本地书服务未挂载（API 层映射 503）——门面动词在 local part 缺席时抛出，路由层不再各自判 `opts.local === undefined`。 */
export class LocalNotMountedError extends Error {
  constructor() {
    super('本地书服务未挂载')
    this.name = new.target.name
  }
}

/** 段合成失败的四种终局：code 即 wire 错误码，与 HTTP 状态一一分档——引擎缺席是调用方的选择问题（400），上游失败与坏响应是网关问题
 *  （502）；引擎此刻不可用（服务自报没配好）是它自己的配置问题（503）。类住在分类学单点（而不是 tts-request.ts）：`api/wire` 的 classify
 *  投影要用它，而 tts-request → fetcher → errors 的值边会让「类住 tts-request」变成值环。 */
export type TtsSynthesisErrorCode =
  | 'TTS_ENGINE_MISSING' | 'TTS_ENGINE_UNAVAILABLE' | 'TTS_UPSTREAM' | 'TTS_BAD_RESPONSE'

export class TtsSynthesisError extends Error {
  readonly code: TtsSynthesisErrorCode

  constructor(code: TtsSynthesisErrorCode, message: string) {
    super(message)
    this.name = new.target.name
    this.code = code
  }
}

/** 听书服务未挂载（API 层映射 503）：与本地书同一档。到场形态只有一种——直装缝不带听书部件。注册表损坏是另一条半径（见 `TtsEnginesDegradedError`）。 */
export class TtsNotMountedError extends Error {
  constructor() {
    super('听书服务未挂载')
    this.name = new.target.name
  }
}

/** 朗读引擎订阅注册表降级（API 层映射 503，消息带原因）：`tts-engines.json` 读不出时订阅那一格整体不可用——源清单照常、段合成与缓存读照常，
 *  只有五个订阅动词抛它。与 `TtsNotMountedError` 分开是两个主语：那是部件根本没装配（缺席），这是部件在场、订阅数据坏（降级）。 */
export class TtsEnginesDegradedError extends Error {
  /** 降级原因（注册表加载失败的原话）：报错即说清坏在哪，不给一句无名的 503 */
  readonly reason: string
  constructor(reason: string) {
    super(`朗读引擎订阅注册表不可用：${reason}`)
    this.name = new.target.name
    this.reason = reason
  }
}

// ── 错误分类学单点 ────────────────────────────────────────────────────────
// 「类 → 类目」的知识只在这里编码一次；HTTP 状态映射与探针错误码是它的小投影，各写一份会让加一个错误类要动两个模块。

/** 错误类目：规则求值 / 缺规则 / 网络抓取 / 资源缺席 / 本地导入两态 / 未挂载与降级 / 任务互斥 / 段合成三分档 / 其他。错误类自己不带
 *  HTTP status——错误→HTTP 的 egress 只剩 classify 一处，路由侧不写逐类 catch。 */
export type ErrorCategory =
  | 'rule-eval' | 'rule-missing' | 'fetch' | 'not-found'
  | 'bad-request'
  | 'local-import' | 'local-too-large' | 'unavailable' | 'job-running'
  | 'tts-engine-missing' | 'tts-engine-unavailable' | 'tts-upstream' | 'tts-bad-response'
  | 'other'

/** 段合成 code → 类目。表即穷尽闸：`TtsSynthesisErrorCode` 加一档而不登记 → tsc 红，不会静默落进 `other`。 */
const TTS_CATEGORY_OF: Record<TtsSynthesisErrorCode, ErrorCategory> = {
  TTS_ENGINE_MISSING: 'tts-engine-missing',
  TTS_ENGINE_UNAVAILABLE: 'tts-engine-unavailable',
  TTS_UPSTREAM: 'tts-upstream',
  TTS_BAD_RESPONSE: 'tts-bad-response',
}

/** 分类单点：异常 → 类目。分类权在类型上，不在文案上（改错别字不改类目）。 */
export function classify(e: unknown): ErrorCategory {
  // 引擎三类（UnsupportedRuleError/RuleEvalError/JsSandboxError）——规则问题
  if (isEngineError(e)) return 'rule-eval'
  if (e instanceof RuleMissingError) return 'rule-missing'
  if (e instanceof FetchError || e instanceof DecodeError) return 'fetch'
  if (e instanceof SourceNotFoundError || e instanceof ChapterNotFoundError) return 'not-found'
  // 本地产物缺席与「源不存在」「章不存在」同一读数：404。判定放在 local-import 之前：**更窄的判据先问**——顺序错了会把 404 读成 400。
  if (e instanceof LocalArtifactNotFoundError) return 'not-found'
  if (e instanceof InvalidRequestError || e instanceof BookNotOnShelfError) return 'bad-request'
  if (e instanceof LocalImportError || e instanceof EpubImportError) return 'local-import'
  if (e instanceof LocalFileTooLargeError) return 'local-too-large'
  if (e instanceof LocalNotMountedError || e instanceof TtsNotMountedError || e instanceof TtsEnginesDegradedError) return 'unavailable'
  if (e instanceof JobRunningError) return 'job-running'
  // 段合成三分档：状态码随 code 分（引擎缺席 400 / 上游 502），不是「一个类一条边」
  if (e instanceof TtsSynthesisError) return TTS_CATEGORY_OF[e.code]
  return 'other'
}
