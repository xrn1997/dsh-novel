import type { Facet, SegmentLoc } from './types.js'

export interface ErrorLoc extends SegmentLoc { facet: Facet }

export class EngineError extends Error {
  readonly facet: Facet
  readonly segmentIndex: number
  readonly segmentRaw: string
  constructor(message: string, loc: ErrorLoc) {
    super(`[${loc.facet}#段${loc.segmentIndex}] ${message}（规则片段: ${JSON.stringify(loc.segmentRaw)}）`)
    this.name = new.target.name
    this.facet = loc.facet
    this.segmentIndex = loc.segmentIndex
    this.segmentRaw = loc.segmentRaw
  }
}

export class UnsupportedRuleError extends EngineError {}

export class RuleEvalError extends EngineError {
  readonly hits: number
  constructor(message: string, loc: ErrorLoc & { hits: number }) {
    super(`${message}（命中 ${loc.hits} 个）`, loc)
    this.hits = loc.hits
  }
}

export class JsSandboxError extends EngineError {
  readonly script: string
  readonly line: number | undefined
  constructor(message: string, loc: ErrorLoc & { script: string; line?: number }) {
    super(loc.line ? `${message}（第${loc.line}行）` : message, loc)
    this.script = loc.script
    this.line = loc.line
  }
}

/**
 * 用户正则求值超时（疑似灾难性回溯）。抛出点在 `engine/regex-guard.ts` 的死线守卫。
 * 归属裁决（它**故意不是** `EngineError` 子类，也不进 `engine/index.ts` 的公开面）：守卫层不知道段级定位，
 * 这里造不出 `ErrorLoc`。它是**求值边界上的中继错误**：每个消费点必须就地转译——引擎侧转成带定位的
 * `RuleEvalError`，服务侧转成留痕降级。服务面直取本类（`isEngineError` 不认它）；漏转的由进程级未处理
 * rejection 防线兜住（按「插件内部错误」升档）。
 */
export class RegexDeadlineError extends Error {
  readonly pattern: string
  /** 本次求值实际给的时间预算（随工作量放宽，见 `regex-guard.ts` 的 `deadlineFor`） */
  readonly deadlineMs: number
  constructor(pattern: string, deadlineMs: number) {
    super(`正则求值超时（${deadlineMs}ms，疑似灾难性回溯）: ${pattern}`)
    this.name = 'RegexDeadlineError'
    this.pattern = pattern
    this.deadlineMs = deadlineMs
  }
}

export function isEngineError(e: unknown): e is EngineError { return e instanceof EngineError }
