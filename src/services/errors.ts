import { isEngineError } from '../engine/index.js'
import { LocalFileTooLargeError, LocalImportError } from './localbooks.js'
import { JobRunningError } from './import-job.js'

/**
 * 书源不存在（API 层映射 404 NotFound）。
 * 此前是裸 Error + api/wire.ts 的中文前缀匹配（`message.startsWith('源不存在')`）——
 * 分类权活在文案作者手里，改错别字即改 HTTP 状态码；类型化后 instanceof 是唯一判据。
 */
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

/**
 * 书源缺规则导致某一面无法执行（API 层映射 422，wire 错误码 'RuleMissing'——
 * 与搜索面/探针的 RuleMissing 结果形态同一词汇；此前是裸 Error → 500 InternalError，
 * 用户看到的是「服务器内部错误」而不是「这源缺规则」）。
 */
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

/** 调用方给的参数本身不成立（API 层映射 400 BadRequest）——**值域**判据，不是 body 形状判据：
 *  形状（缺字段、类型不对、JSON 不合法）归路由自检的 `ApiError`，值域（非空、非负整数、比例在
 *  [0,1]）归本类。两者分开是因为值域要护的是**每一个调用方**：门面动词被 HTTP 面与 agent 工具面
 *  同时调用，门长在路由里等于只护了一半（工具面可直接写入 Infinity —— JSON.stringify 落盘成
 *  null 的静默数据损坏）。 */
export class InvalidRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

/** 本地书服务未挂载（API 层映射 503 Unavailable）——门面动词在 local part 缺席时抛出，
 *  路由层不再各自判 `opts.local === undefined`（判据归门面） */
export class LocalNotMountedError extends Error {
  constructor() {
    super('本地书服务未挂载')
    this.name = new.target.name
  }
}

// ── 错误分类学单点 ────────────────────────────────────────────────────────
// 「类 → 类目」的知识只在这里编码一次；HTTP 状态映射（api/wire.errorStatusOf）与
// 探针错误码（search-face.searchErrorCodeOf）是它的小投影。此前同一分类学
// 在两个 destination 各写一份（且 RuleMissing 有异常/结果两条路径）——加一个错误类
// 要动两个模块加一份自觉。

/** 错误类目：规则求值 / 缺规则 / 网络抓取 / 资源缺席 / 本地导入两态 / 本地未挂载 / 任务互斥 / 其他。
 *  LocalImportError 不再自带 status、JobRunningError 的 409 特判包装与本地书面的
 *  路由侧 catch 全部收进本表——错误→HTTP 的 egress 只剩 classify 一处。 */
export type ErrorCategory =
  | 'rule-eval' | 'rule-missing' | 'fetch' | 'not-found'
  | 'bad-request'
  | 'local-import' | 'local-too-large' | 'unavailable' | 'job-running'
  | 'other'

/** 分类单点：异常 → 类目。分类权在类型上，不在文案上（改错别字不改类目）。 */
export function classify(e: unknown): ErrorCategory {
  // 引擎三类（UnsupportedRuleError/RuleEvalError/JsSandboxError）——规则问题
  if (isEngineError(e)) return 'rule-eval'
  if (e instanceof RuleMissingError) return 'rule-missing'
  if (e instanceof FetchError || e instanceof DecodeError) return 'fetch'
  if (e instanceof SourceNotFoundError || e instanceof ChapterNotFoundError) return 'not-found'
  if (e instanceof InvalidRequestError) return 'bad-request'
  if (e instanceof LocalImportError) return 'local-import'
  if (e instanceof LocalFileTooLargeError) return 'local-too-large'
  if (e instanceof LocalNotMountedError) return 'unavailable'
  if (e instanceof JobRunningError) return 'job-running'
  return 'other'
}
