/**
 * engine 公开面（收窄）：显式列出服务半依赖的引擎 API——
 * evaluate 求值入口（含 trace 变体）、URL 插值 + URL 选项分界式、错误类与判别、核心类型。
 * 此前 `export *` 把 parse/select/css/xpath/… 的内部细节全部泄漏成「对外承诺」，
 * 而 request/content/index 三处又绕过 barrel 直取 js-sandbox/dom——barrel 两头不是 interface。
 *
 * 收窄后：内部 module（parse/grammar/replace/variables/…）保留深路径直引作**自测 seam**
 * （tests 直引是测试需要，不是对外承诺）；服务半新消费点先问「这是引擎公开面吗」。
 */
export { evaluate, evaluateWithTrace } from './evaluate.js'
export type { TraceStep, TraceResult } from './evaluate.js'
export { interpolateUrl, URL_OPTION_SPLIT } from './template.js'
export { isEngineError } from './errors.js'
export { EngineError, UnsupportedRuleError, RuleEvalError, JsSandboxError } from './errors.js'
export type { EngineValue, EvalContext, Facet, RuleUsage } from './types.js'
