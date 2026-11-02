/**
 * `/novel-api` 的路由匹配机械：路由身份的两条腿（path 与 method）在这里并成一个判定，
 * 产出穷尽的 `Match` 联合——`dispatch.ts` 拿它查分发表，405/404 的落点也由它的三个出口决定。
 *
 * 本文件不认识 service、不认识 ApiError、不认识信封：它是纯机械（判据住注释，表住
 * `shared/wire.ts`），接线与传输语义都在消费侧。
 */

import { paramOps, ROUTES } from '../shared/wire.js'

/** 静态路由名（`ROUTES` 的键集）。加/删一条静态路由时，消费侧的 `HANDLERS` 缺接即 tsc 红。 */
export type RouteName = keyof typeof ROUTES

/** 参数路由名（`paramOps` 的键集）。同理：消费侧 `PARAM_HANDLERS` 缺接即 tsc 红。 */
export type ParamRouteName = keyof typeof paramOps

/** 匹配结果（穷尽联合）：
 *  - `hit` / `param-hit`：路径与方法都对上；`params` 是 `:` 段的**原值**（百分号未解码——
 *    解码及其 400 归消费侧的路径段解码助手，不在这里）；
 *  - `method-mismatch`：这条路径认得、方法不对（消费侧落 405）；`expectedMethod` 是它要的方法，
 *    `pathForMessage` 是给人看的路径（静态 = 表里的 path；参数 = 模式路径串）；
 *  - `null`：任何表都没认出这条路径（消费侧落「未知路由」404）。 */
export type Match =
  | { kind: 'hit'; route: RouteName; params: readonly string[] }
  | { kind: 'param-hit'; route: ParamRouteName; params: readonly string[] }
  | { kind: 'method-mismatch'; expectedMethod: string; pathForMessage: string }
  | null

/** 参数路由的模式路径串（`:` 开头的段收任意值）：与匹配共用同一份，
 *  `pathForMessage` 因此不会与「匹配认什么」各说各的。 */
export const PARAM_PATTERN_PATHS: Record<ParamRouteName, string> = {
  sourceProbe: 'sources/:id/probe', sourceEnabled: 'sources/:id/enabled',
  sourceAuth: 'sources/:id/auth', sourceDelete: 'sources/:id',
  shelfPut: 'shelf/:key', shelfDelete: 'shelf/:key',
}

/** 静态路由没有参数位，命中的 params 恒为空（共享一份，不逐次新建） */
const NO_PARAMS: readonly string[] = []

/** 匹配次序（判据，改这里先改本注释与 `tests/api/routes.test.ts` 的 matchRoute 用例）：
 *  ① 静态表按 path 精确匹配：切出的段并回去对 `ROUTES.*.path` 逐条等值；静态路径一旦对上，
 *     方法即刻定案——对上是 `hit`，对不上是 `method-mismatch`，**不再往下看参数表**；
 *  ② 静态表没对上才走参数模式：段数相等 + 字面段全等 + `:` 段收任意值，按表内声明序优先
 *     （`sources/:id` 与 `sources/:id/probe` 由段数与字面段自然分家；`shelf/:key` 的 PUT/DELETE
 *     两变体按方法匹配，方法全不中时取**先出现的变体**做 `method-mismatch`）；
 *  ③ 静态优先于参数（`POST sources/import` 不会落 `sources/:id`；`DELETE sources/import` 也因此
 *     报「需 POST」而不是当成删源）。
 *  两边都没认出 → null。带垃圾尾段的路径在这里天然落 null：段数或字面段对不上任何表项。 */
export function matchRoute(method: string, segs: readonly string[]): Match {
  const path = segs.join('/')
  // ① 静态：路径对上即定案（方法不符也不落到参数表——判据③的另一半）
  for (const [name, target] of Object.entries(ROUTES)) {
    if (target.path !== path) continue
    return target.method === method
      ? { kind: 'hit', route: name as RouteName, params: NO_PARAMS }
      : { kind: 'method-mismatch', expectedMethod: target.method, pathForMessage: target.path }
  }
  // ② 参数模式：按表内声明序（对象键序即声明序），同模式路径的多个方法变体逐一试
  let mismatch: Match = null
  for (const name of Object.keys(paramOps) as ParamRouteName[]) {
    const patternSegs = PARAM_PATTERN_PATHS[name].split('/')
    if (patternSegs.length !== segs.length) continue
    const params: string[] = []
    let same = true
    for (let i = 0; i < patternSegs.length; i++) {
      const literal = patternSegs[i]
      if (literal.startsWith(':')) params.push(segs[i])
      else if (literal !== segs[i]) { same = false; break }
    }
    if (!same) continue
    if (paramOps[name].method === method) return { kind: 'param-hit', route: name, params }
    if (mismatch === null) {
      mismatch = { kind: 'method-mismatch', expectedMethod: paramOps[name].method, pathForMessage: PARAM_PATTERN_PATHS[name] }
    }
  }
  return mismatch
}
