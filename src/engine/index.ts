/**
 * engine 公开面（收窄）：显式列服务半依赖的引擎 API——evaluate（含 trace 变体）、URL 插值 + 选项分界式、
 * 错误类与判别、核心类型。`export *` 会把 parse/select/css/xpath 的内部细节变成事实上的对外承诺。
 * 内部 module 的深路径直引是既有消费点与**自测 seam**；服务半新增消费点先问「这是引擎公开面吗」。
 */
export { evaluate, evaluateWithTrace } from './evaluate.js'
export type { TraceStep, TraceResult } from './evaluate.js'
export { isPutOnlyRule } from './parse.js'
export { interpolateUrl, isPlaceholderExpr, expandPageAngleList, scanTemplateSegments, URL_OPTION_SPLIT } from './template.js'
export type { TemplateSegment } from './template.js'
export { isEngineError } from './errors.js'
export { EngineError, UnsupportedRuleError, RuleEvalError, JsSandboxError } from './errors.js'
export type { EngineValue, EvalContext, Facet, RuleUsage } from './types.js'
export type { SourceSession } from './session.js'
