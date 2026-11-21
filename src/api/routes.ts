/**
 * `/novel-api` 路由匹配机械：path 与 method 并成一个 `Match` 判定，405/404 的落点由三个出口决定。
 * 纯机械：不认识 service / ApiError / 信封，表住 `shared/wire.ts`，接线在消费侧。
 */

import { paramOps, ROUTES } from '../shared/wire.js'

/** 静态路由名（`ROUTES` 键集）；消费侧 `HANDLERS` 漏接即 tsc 红。 */
export type RouteName = keyof typeof ROUTES

/** 参数路由名（`paramOps` 键集）；消费侧 `PARAM_HANDLERS` 漏接即 tsc 红。 */
export type ParamRouteName = keyof typeof paramOps

/** 匹配结果（穷尽联合）：`hit` / `param-hit` 的 params 是 `:` 段原值（百分号未解码，归消费侧解码）；
 *  `method-mismatch` 是路径认得、方法不对（消费侧 405）；`null` = 没认出（消费侧 404）。 */
export type Match =
  | { kind: 'hit'; route: RouteName; params: readonly string[] }
  | { kind: 'param-hit'; route: ParamRouteName; params: readonly string[] }
  | { kind: 'method-mismatch'; expectedMethod: string; pathForMessage: string }
  | null

/** 参数路由模式路径串：与匹配共用，`pathForMessage` 不会与「匹配认什么」各说各的。 */
export const PARAM_PATTERN_PATHS: Record<ParamRouteName, string> = {
  sourceProbe: 'sources/:id/probe', sourceEnabled: 'sources/:id/enabled',
  sourceAiSearch: 'sources/:id/ai-search',
  sourceAuth: 'sources/:id/auth', sourceDelete: 'sources/:id',
  shelfPut: 'shelf/:key', shelfDelete: 'shelf/:key',
  ttsEnginePut: 'tts/engines/:id', ttsEngineDelete: 'tts/engines/:id',
}

/** 静态路由无参数位：命中的 params 恒为空（共享一份）。 */
const NO_PARAMS: readonly string[] = []

/** 匹配次序（判据；改这里先改本注释与 `tests/api/routes.test.ts`）：
 *  ① 静态表精确匹配，路径对上即定案：方法对 → hit，不对 → method-mismatch，不再看参数表；
 *  ② 才走参数模式：段数相等 + 字面段全等 + `:` 段收任意值，按声明序；同路径多方法变体按方法匹配，
 *     全不中时取先出现的变体做 method-mismatch；
 *  ③ 静态优先于参数（`DELETE sources/import` 报「需 POST」而非当成删源）；都没认出 → null。 */
export function matchRoute(method: string, segs: readonly string[]): Match {
  const path = segs.join('/')
  // ① 静态：路径对上即定案（方法不符也不落到参数表）
  for (const [name, target] of Object.entries(ROUTES)) {
    if (target.path !== path) continue
    return target.method === method
      ? { kind: 'hit', route: name as RouteName, params: NO_PARAMS }
      : { kind: 'method-mismatch', expectedMethod: target.method, pathForMessage: target.path }
  }
  // ② 参数模式：按声明序逐一试，同模式路径的多个方法变体各自按方法匹配
  let mismatch: Match = null
  for (const name of Object.keys(paramOps) as ParamRouteName[]) {
    const patternSegs = PARAM_PATTERN_PATHS[name].split('/')
    if (patternSegs.length !== segs.length) continue
    // 段数先判等 ⇒ 两张表同下标同界；滤空只是让编译器跟上这条构造性证明，不是补缺省值。
    const literalsMatch = patternSegs.every((literal, i) => literal.startsWith(':') || literal === segs[i])
    if (!literalsMatch) continue
    const params = patternSegs
      .flatMap((literal, i) => (literal.startsWith(':') ? [segs[i]] : []))
      .filter((segment): segment is string => segment !== undefined)
    if (paramOps[name].method === method) return { kind: 'param-hit', route: name, params }
    if (mismatch === null) {
      mismatch = { kind: 'method-mismatch', expectedMethod: paramOps[name].method, pathForMessage: PARAM_PATTERN_PATHS[name] }
    }
  }
  return mismatch
}
