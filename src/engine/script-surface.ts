import type { EvalContext } from './types.js'

/**
 * 脚本可见性清单：`EvalContext` 的每个字段都必须在下面有一行归属。
 *
 * 为什么要有这张表：脚本能看到什么必须同时对齐三处消费面——`EvalContext` 的字段、`initOf` 的
 * JSON 键、BOOTSTRAP 的 `g.*` 全局名；任何一处漏投影都不会报错，只是脚本读到 undefined 后走默认分支。
 * 表用 `Record<keyof EvalContext, …>` 声明，漏一个字段 tsc 当场报；运行期再抽 key 断言，挡住表退化。
 *
 * 两档归属：
 * - `visible`：进 init，按 `key` 落 JSON 键；有 `global` 的由 BOOTSTRAP 物化。
 * - `excluded`：宿主能力或求值层内部数据，脚本不直接看见（经 `java.*` 桥或沙箱派生）。
 *
 * `materialize` 标「全局不是简单赋值」：book/chapter 要补方法面，source 是 `__src__` 的别名；
 * 它们仍在这张表里登记，但不能由 `scriptGlobals()` 生成一行 `g.x = d.x`。
 */
export type ScriptFieldSpec =
  | { readonly init: 'excluded'; readonly why: string }
  | {
    readonly init: 'visible'
    readonly key: string
    readonly value: (ctx: EvalContext) => unknown
    /** 脚本全局名；`materialize` 在场时由 BOOTSTRAP 另行物化 */
    readonly global?: string
    readonly materialize?: true
  }

/** 页原文：html 优先；纯 JSON 页给序列化文本（与 host.result 的首段口径同源）。
 *  `json` 可能是解析后的对象（JSONPath 求值链）——`String(obj)` 会得到 `[object Object]`，
 *  脚本里的 `JSON.parse(src)` 随即失败；串原样，对象走 JSON.stringify。 */
const srcOf = (ctx: EvalContext): string => {
  if (ctx.html !== undefined) return ctx.html
  if (ctx.json === undefined) return ''
  return typeof ctx.json === 'string' ? ctx.json : JSON.stringify(ctx.json)
}

export const SCRIPT_FIELDS: Readonly<Record<keyof EvalContext, ScriptFieldSpec>> = {
  html: { init: 'visible', key: 'src', global: 'src', value: srcOf },
  json: { init: 'visible', key: 'src', value: srcOf },
  baseUrl: { init: 'visible', key: 'baseUrl', global: 'baseUrl', value: (c) => c.baseUrl ?? '' },
  source: {
    init: 'visible', key: 'source', global: 'source', materialize: true,
    value: (c) => c.source ?? '',
  },
  sourceComment: { init: 'visible', key: 'sourceComment', value: (c) => c.sourceComment ?? '' },
  sourceName: { init: 'visible', key: 'sourceName', value: (c) => c.sourceName ?? '' },
  vars: {
    init: 'excluded',
    why: '求值层内部：@get/@put 的本次调用表，脚本经 g.__d__.vars 不可见',
  },
  sourceVar: {
    init: 'excluded',
    why: '宿主能力：沙箱从 SourceSession 派生 sourceVar，按源隔离的读链不走 init',
  },
  fetch: { init: 'excluded', why: '宿主能力：经 java.ajax / java.get 同步桥出站' },
  userAgent: { init: 'excluded', why: '宿主能力：经 java.userAgent() 读取' },
  fetchRaw: { init: 'excluded', why: '宿主能力：经 java.downloadFile 同步桥出站' },
  fetchPost: { init: 'excluded', why: '宿主能力：经 java.post 同步桥出站' },
  fetchHead: { init: 'excluded', why: '宿主能力：经 java.head 同步桥出站' },
  fetchGet: { init: 'excluded', why: '宿主能力：经 java.get 双参同步桥出站' },
  fetchConn: { init: 'excluded', why: '宿主能力：经 java.net.URL.openConnection 同步桥出站' },
  jsTimeoutMs: { init: 'excluded', why: '宿主预算：超时由外层 race 控制，不交给脚本' },
  jsLib: { init: 'excluded', why: '宿主能力：jsLib 先于每段 @js 在同上下文执行，不经 init' },
  book: {
    init: 'visible', key: 'book', global: 'book', materialize: true,
    value: (c) => c.book ?? {},
  },
  chapter: {
    init: 'visible', key: 'chapter', global: 'chapter', materialize: true,
    value: (c) => c.chapter ?? {},
  },
  loginInfo: { init: 'visible', key: 'loginInfo', value: (c) => c.loginInfo ?? {} },
  loginHeader: { init: 'visible', key: 'loginHeader', value: (c) => c.loginHeader ?? '' },
  evalWebJs: { init: 'excluded', why: '宿主能力：@webjs 经真浏览器执行' },
  deviceId: { init: 'visible', key: 'deviceId', value: (c) => c.deviceId ?? '' },
  webView: { init: 'excluded', why: '宿主能力：java.webView 经真浏览器执行' },
  session: { init: 'excluded', why: '宿主能力：源状态会话由沙箱持有，不经 init' },
  httpCookies: { init: 'excluded', why: '宿主能力：cookie jar 读口经协议表挂载' },
  regexRow: { init: 'excluded', why: '解析期数据：AllInOne 行在 parseRule 之前绑定，不进脚本 init' },
}

/** 可见字段的 init 键：BOOTSTRAP 的复杂物化也从这张表取键，不再手写第二份 `d.book` 名单。 */
export function scriptKeyOf(field: keyof EvalContext): string {
  const spec = SCRIPT_FIELDS[field]
  if (spec.init !== 'visible') throw new Error(`脚本字段 ${field} 没有 init 键`)
  return spec.key
}

/** 物化字段的脚本全局名（book / chapter / source）；BOOTSTRAP 物化时用。 */
export function scriptGlobalOf(field: keyof EvalContext): string {
  const spec = SCRIPT_FIELDS[field]
  if (spec.init !== 'visible' || spec.global === undefined) throw new Error(`脚本字段 ${field} 没有全局名`)
  return spec.global
}

/** 普通脚本全局：BOOTSTRAP 只读这张派生表，不再手写第二份全局名单。
 *  book/chapter/source 有自定义物化，登记在 SCRIPT_FIELDS 但不在此列。 */
export function scriptGlobals(): Array<{ name: string; key: string }> {
  const out: Array<{ name: string; key: string }> = []
  for (const spec of Object.values(SCRIPT_FIELDS)) {
    if (spec.init !== 'visible') continue
    if (spec.global === undefined || spec.materialize !== undefined) continue
    out.push({ name: spec.global, key: spec.key })
  }
  return out
}

/** 按清单生成 init 的普通字段；result / mounts 等求值期字段由 js-sandbox 另行拼装。 */
export function scriptInitOf(ctx: EvalContext): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const spec of Object.values(SCRIPT_FIELDS)) {
    if (spec.init !== 'visible') continue
    out[spec.key] = spec.value(ctx)
  }
  return out
}
