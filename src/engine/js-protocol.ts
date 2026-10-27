/**
 * JavaBridge 协议表：**唯一登记点**。每行 = 方法名 · sync/async · 沙箱挂载点 · 宿主实现（inline 闭包）。
 * 类型面、BOOTSTRAP 名单与宿主分派全部从表派生：
 * JavaBridge 类型用 mapped type 推导（不存在第二份手写 interface）、SANDBOX_MOUNTS 供引导脚本挂载、
 * invokeJavaMethod 按名查行分派。加一个 **sync** 方法 = 本表加一行；加一个 **async** 方法 = 一行 +
 * 一个 `bridge` 判别（壳形态 / 挂载名 / 路由探针——桥壳源码与 `g.java` 挂载由表生成）。
 * 纪律：本文件不进 engine barrel——仅由 js-sandbox 内部引用。
 */
import crypto from 'node:crypto'
import type { EngineValue, EvalContext, Facet, SegmentLoc } from './types.js'
import { JsSandboxError } from './errors.js'
import { responseOf } from './host-object.js'
import type { ResponseHost } from './host-object.js'
import { URL_OPTION_SPLIT } from './template.js'
import { subRuleOf } from './sub-rule.js'
import type { SubRule } from './sub-rule.js'
import type { EvaluateRef } from './js-sandbox.js'
import type { SourceSession } from './session.js'
import { createFileStore } from './stores.js'
import { getRuleVar } from './variables.js'
import { parseCookieString } from '../shared/cookies.js'
import {
  absolutizeUrl,
  base64Decode,
  base64Encode,
  base64EncodeBytes,
  digestBase64,
  digestHex,
  engineValueToString,
  engineValueToStrings,
  fmtTime,
  hMacBase64,
  hMacHex,
  hexDecodeToString,
  hexEncodeToString,
  javaDecode,
  javaEncode,
  md5Hex,
  md5Hex16,
  toNumChapter,
  unescapeHtml4,
  uriEncode,
} from './js-utils.js'

/** 协议实现的全部闭包依赖——每次求值构造一个（原 makeJavaBridge 的参数与可变态收进一个对象） */
export interface BridgeDeps {
  ctx: EvalContext
  /** 用户脚本原文（错误定位用） */
  code: string
  loc: SegmentLoc
  facet: Facet
  /** 上一段结果序列化（host.result）——getString* 的默认基内容 */
  result: string
  session: SourceSession
  /** cookie/源变量的按源隔离键（source 优先，缺则 baseUrl，再缺为空串） */
  sourceKey: string
  evaluateRef: EvaluateRef | undefined
  /** setContent 覆盖基内容（null = 未覆盖 → 用 result） */
  contentBase: string | null
}

/** 沙箱侧挂载点：java 对象（属性名=方法名）/ cookie·source·cache 对象（as 为脚本可见属性名） */
type Mount =
  | { readonly obj: 'java' }
  | { readonly obj: 'cookie'; readonly as: string }
  | { readonly obj: 'source'; readonly as: string }
  | { readonly obj: 'cache'; readonly as: string }

/** 表行 make 的返回签名约束（仅约束形状；具体参数类型逐行精确声明，供 JavaBridge 推导） */
type HostFn = (...args: never[]) => unknown

/** 异步行在沙箱侧的同步桥壳形态（`asyncBridgeSource` 按它生成 BOOTSTRAP 内那段源码）：
 *  · `body`：数据面就是 body 串（ajax / downloadFile）；
 *  · `response`：数据面是 `__host:'response'` 描述符，需 `materialize` 包成响应方法壳；
 *  · `raw`：数据面本身即脚本要的形状（webView / urlConn）；
 *  · `connect`：额外包 `raw()/url()` 同值的连接壳。 */
export type BridgeShape = 'body' | 'response' | 'raw' | 'connect'

/** 仅 async 行必填：沙箱侧怎么挂、怎么被路由认出。 */
export interface AsyncBridgeSpec {
  shim: BridgeShape
  /** 直接挂在 `g.java` 上的属性名；null = 只经别的入口到达（`java.get` 双参 / `URL.openConnection`） */
  mountAs: string | null
  /** 证明该行的可达写法会被 `SYNC_WORKER_RE` 认出的脚本片段（测试逐行钉住；漏列即红——
   *  认不出时主线程抛哨兵，脚本自己的 try/catch 会把它吞成 undefined）。 */
  routeProbe: string
}

interface JavaMethod<N extends string, F extends HostFn> {
  readonly name: N
  /** sync（缺省）：宿主同步返回；async：返回 Promise（沙箱侧由 `bridge` 生成同步桥） */
  readonly mode?: 'async'
  /** 仅 async 行必填：沙箱侧同步桥的壳形态、直接挂载名、路由探针 */
  readonly bridge?: AsyncBridgeSpec
  readonly mount: Mount
  /** 宿主实现工厂：闭包捕获 deps；返回的函数即桥方法（内部自带 String()/Number() 防御转换） */
  readonly make: (d: BridgeDeps) => F
}

function method<N extends string, F extends HostFn>(
  name: N,
  mount: Mount,
  make: (d: BridgeDeps) => F,
  mode?: 'async',
  bridge?: AsyncBridgeSpec,
): JavaMethod<N, F> {
  return {
    name,
    ...(mode === undefined ? {} : { mode }),
    ...(bridge === undefined ? {} : { bridge }),
    mount,
    make,
  }
}

/** java.getString* 的递归求值（evaluateRef 未注入 → 宁炸不猜）。求值体（文本 + 已定用途）由
 *  调用点经 `subRuleOf` 构造——「恒列表」的桥方法（getElements/getElement）交 `forceUsage`，
 *  其余按规则本身判。`content` 是**显式基内容**：给了就以它为基（优先于上一段结果），
 *  null/undefined 回落到本仓的 contentBase ?? result（java.setContent 那条路）。 */
function evalRule(d: BridgeDeps, sub: SubRule, content?: unknown): EngineValue {
  if (!d.evaluateRef) {
    throw new JsSandboxError(`java 递归求值需要引擎接线（evaluateRef 未注入，规则: ${JSON.stringify(sub.rule)}）`, {
      ...d.loc,
      facet: d.facet,
      script: d.code,
    })
  }
  const base = content === undefined || content === null ? d.contentBase ?? d.result : content
  return d.evaluateRef(sub, base)
}

/** getString / getStringList 共用的子规则求值入口：串化 + 用途判据一处收口（两个桥方法只差
 *  结果侧的串化/绝对化，求值这一段不许各写一份——用途判据一改这里只动一处）。 */
function evalSubRule(d: BridgeDeps, rule: unknown, content?: unknown): EngineValue {
  return evalRule(d, subRuleOf(String(rule), d.facet), content)
}

/** getString / getStringList 的实参分派：**三个重载形态**的位置语义不同（按实参类型分派）。
 *  · `getString(rule)` —— 缺省：反转义做、不做绝对化；
 *  · `getString(rule, unescape)` —— 第二参布尔就是「要不要再做一次 HTML 反转义」；
 *  · `getString(rule, content, isUrl)` —— 第二参是基内容、第三参才是 isUrl。
 *  三个形态靠实参类型分派；不要把第二参的布尔一律当 isUrl——二参形态里它是 unescape。 */
function parseGetStringArgs(arg2?: unknown, arg3?: unknown): { content?: unknown; isUrl: boolean; unescape: boolean } {
  if (typeof arg2 === 'boolean') return { content: undefined, isUrl: false, unescape: arg2 }
  return { content: arg2, isUrl: arg3 === true, unescape: true }
}

/** 脚本网络方法的 header 实参：JSON 串或对象字面量两形态；认不出就点名，不静默丢意图。 */
function parseHeaderArg(d: BridgeDeps, method: string, arg: unknown): Record<string, string> | undefined {
  if (arg === null || arg === undefined) return undefined
  if (typeof arg === 'string' && arg.trim() === '') return undefined
  if (typeof arg === 'string') {
    try { return JSON.parse(arg) as Record<string, string> } catch {
      throw new JsSandboxError(`${method} 的 header 参数不是 JSON：${arg.slice(0, 60)}`, { ...d.loc, facet: d.facet, script: d.code })
    }
  }
  if (typeof arg === 'object') return arg as Record<string, string>
  throw new JsSandboxError(`${method} 的 header 参数形状不支持：${typeof arg}`, { ...d.loc, facet: d.facet, script: d.code })
}

const jar = (d: BridgeDeps): Map<string, string> => d.session.cookieJar(d.sourceKey)
const sourceVars = (d: BridgeDeps): Map<string, string> => d.session.sourceVars(d.sourceKey)
const sourceCache = (d: BridgeDeps): Map<string, string> => d.session.cacheStore(d.sourceKey)

/**
 * JavaBridge 协议表：**唯一登记点**。行序即文档序（网络 / 变量 / 递归求值 / 工具 / 垫片分组）。
 * 添加方法只改此处一行（含实现）——类型面/BOOTSTRAP 名单/宿主分派全部派生跟随。
 */
export const JAVA_PROTOCOL = [
  // ── 网络 ────────────────────────────────────────────────────────────
  method('ajax', { obj: 'java' }, (d) => (url: unknown): Promise<string> => {
    const fetchFn = d.ctx.fetch
    if (!fetchFn) {
      throw new JsSandboxError('该源未提供网络能力（ctx.fetch 缺失）', { ...d.loc, facet: d.facet, script: d.code })
    }
    // 参数规约按 String 形参强制转换：`java.ajax(result)` 传进来的常是上一段的值——JSONPath 给
    // 单元素数组时按 toString 拼成那条 URL；直接把原值交给请求组装层会在 template.replace 处抛
    // 「is not a function」。null/undefined 不猜成 "null" 去打站点，点名参数缺失。
    if (url === null || url === undefined) {
      throw new JsSandboxError('java.ajax 参数为空（脚本传进 null/undefined）', { ...d.loc, facet: d.facet, script: d.code })
    }
    // 如实失败：ajax 这里不挂任何 rejection 防线——主线程在发起宿主调用前抛哨兵（evalJs 换
    // worker 重跑）、worker 同步返回，两条路都不产生悬空 Promise；进程级 ensureUnhandledGuard
    // 是常驻最后防线，管的是脚本自建的异步工作。见 js-sandbox 的 BOOTSTRAP 注释。
    return fetchFn(String(url)).then((r) => r?.body ?? '')
  }, 'async', {
    shim: 'body',
    mountAs: 'ajax',
    routeProbe: 'java.ajax("https://m.example.com")',
  }),
  // java.connect：返回带结果对象的响应，与 ajax 只差一层壳。三点刻意取舍：
  // ① header JSON 经 parseHeaderArg 叠到源级头之后（与 post 同口径）；callTimeout 走进程级超时；
  // ② 不把异常塞进 body——错误文本冒充正文是最高罪（见矩阵 `h-java-connect`）；
  // ③ `url` 给落地地址（重定向后末次请求），`raw().request().url()` 与 `.url` 同源同值。
  method('connect', { obj: 'java' }, (d) => async (url: unknown, header?: unknown): Promise<{ url: string; body: string }> => {
    const fetchFn = d.ctx.fetch
    if (!fetchFn) {
      throw new JsSandboxError('该源未提供网络能力（ctx.fetch 缺失）', { ...d.loc, facet: d.facet, script: d.code })
    }
    if (url === null || url === undefined) {
      throw new JsSandboxError('java.connect 参数为空（脚本传进 null/undefined）', { ...d.loc, facet: d.facet, script: d.code })
    }
    const hdrs = parseHeaderArg(d, 'java.connect', header)
    const u = String(url)
    return fetchFn(u, hdrs).then((r) => ({ url: r?.finalUrl ?? u, body: r?.body ?? '' }))
  }, 'async', {
    shim: 'connect',
    mountAs: 'connect',
    routeProbe: 'java.connect("https://m.example.com")',
  }),
  // java.post：脚本以 POST 发请求、拿响应对象（`res.body()` / `res.cookies()`）。宿主侧返回数据面，
  // `.body()` 那层壳在 BOOTSTRAP 里包（跨 worker 只走 JSON）。headers 照收并叠到源级头之上
  // （同名后者覆盖）；`timeout` 一类实参走进程级超时，忽略之。
  method('post', { obj: 'java' }, (d) => async (
    url: unknown, body?: unknown, headersArg?: unknown,
  ): Promise<ResponseHost> => {
    const postFn = d.ctx.fetchPost
    if (!postFn) {
      throw new JsSandboxError('该源未提供 POST 网络能力（ctx.fetchPost 缺失）', { ...d.loc, facet: d.facet, script: d.code })
    }
    if (url === null || url === undefined) {
      throw new JsSandboxError('java.post 参数为空（脚本传进 null/undefined）', { ...d.loc, facet: d.facet, script: d.code })
    }
    const hdrs = parseHeaderArg(d, 'java.post', headersArg)
    const r = await postFn(String(url), body === null || body === undefined ? '' : String(body), hdrs)
    return responseOf({ ...r })
  }, 'async', {
    shim: 'response',
    mountAs: 'post',
    routeProbe: 'java.post("https://m.example.com", "a=1")',
  }),
  // java.get 的 HTTP 重载：上游 JsExtensions.get(url, headers) 返回 Connection.Response。
  // 单参变量 getter 仍走下面的 get 行；BOOTSTRAP 按实参个数分派（显式 undefined 仍是双参 HTTP）。
  method('getHttp', { obj: 'java' }, (d) => async (
    url: unknown, headersArg?: unknown,
  ): Promise<ResponseHost> => {
    const getFn = d.ctx.fetchGet
    if (!getFn) {
      throw new JsSandboxError('该源未提供 GET 网络能力（ctx.fetchGet 缺失）', { ...d.loc, facet: d.facet, script: d.code })
    }
    if (url === null || url === undefined) {
      throw new JsSandboxError('java.get 参数为空（脚本传进 null/undefined）', { ...d.loc, facet: d.facet, script: d.code })
    }
    const hdrs = parseHeaderArg(d, 'java.get', headersArg)
    return responseOf({ ...(await getFn(String(url), hdrs)) })
  }, 'async', {
    shim: 'response',
    mountAs: null,
    routeProbe: 'java.get("https://m.example.com", {})',
  }),
  // java.net.URL.openConnection 的宿主口：跟重定向、可 GET/POST，返回原始字节。
  // 安全重开裁决：走 ctx.fetchConn（同一守门 fetcher），不给脚本开裸 socket。
  method('urlConn', { obj: 'java' }, (d) => async (
    req: unknown,
  ): Promise<{ url: string; statusCode: number; headers: Record<string, string>; cookies: Record<string, string>; bytes: number[] }> => {
    const connFn = d.ctx.fetchConn
    if (!connFn) {
      throw new JsSandboxError('该源未提供 URL 连接能力（ctx.fetchConn 缺失）', { ...d.loc, facet: d.facet, script: d.code })
    }
    if (req === null || typeof req !== 'object') {
      throw new JsSandboxError('java.net.URL.openConnection 参数为空或非对象', { ...d.loc, facet: d.facet, script: d.code })
    }
    const r = await connFn(req as { url: string; method?: string; headers?: Record<string, string>; body?: string })
    return { url: r.url, statusCode: r.statusCode, headers: r.headers, cookies: r.cookies, bytes: Array.from(r.body) }
  }, 'async', {
    shim: 'raw',
    mountAs: null,
    routeProbe: 'new java.net.URL("https://m.example.com").openConnection()',
  }),
  // java.getWebViewUA：本仓的 WebView 只服务 webView 源；普通请求走 HTTP 客户端，故这里给的是
  // 我们实际发出去的那条 UA（不是浏览器/WebView 内核 UA，属近似；矩阵 `h-java-webview-ua` 记差）。
  // ctx.userAgent 未接线时点名抛错，绝不编一个串冒充。
  method('getWebViewUA', { obj: 'java' }, (d) => (): string => {
    if (!d.ctx.userAgent) {
      throw new JsSandboxError('java.getWebViewUA 取不到出站 UA（ctx.userAgent 未接线）', { ...d.loc, facet: d.facet, script: d.code })
    }
    return d.ctx.userAgent()
  }),
  // 部分源借 `getUserAgent() === getWebViewUA()` 做「这是源阅还是阅读」的特性探测
  // （Linpx / 兽人小说站 jsLib）；本仓两者同源，故给同一个值，探测落到「非源阅」分支。
  method('getUserAgent', { obj: 'java' }, (d) => (): string => {
    if (!d.ctx.userAgent) {
      throw new JsSandboxError('java.getUserAgent 取不到出站 UA（ctx.userAgent 未接线）', { ...d.loc, facet: d.facet, script: d.code })
    }
    return d.ctx.userAgent()
  }),
  // java.webView(url)：真浏览器取渲染后 HTML（Android WebView 的安全替代）
  method('webView', { obj: 'java' }, (d) => async (url: unknown): Promise<string> => {
    const fn = d.ctx.webView
    if (!fn) {
      throw new JsSandboxError('java.webView 需要真浏览器 WebView（ctx.webView 未接线）', { ...d.loc, facet: d.facet, script: d.code })
    }
    if (url === null || url === undefined) {
      throw new JsSandboxError('java.webView 参数为空（脚本传进 null/undefined）', { ...d.loc, facet: d.facet, script: d.code })
    }
    return fn(String(url))
  }, 'async', {
    shim: 'raw',
    mountAs: 'webView',
    routeProbe: 'java.webView("https://m.example.com")',
  }),
  // java.head(url, headers[, timeout])：HEAD 请求、**不跟重定向**（对面 followRedirects(false)），
  // 数据面 = { url, statusCode, headers }；`.headers()` 方法壳在 BOOTSTRAP 里包（同 post，跨桥只走
  // JSON）。脚本用它读 `res.headers()["location"]` 取图片直链（Linpx/兽人小说站 jsLib）。
  method('head', { obj: 'java' }, (d) => async (
    url: unknown, headersArg?: unknown,
  ): Promise<ResponseHost> => {
    const headFn = d.ctx.fetchHead
    if (!headFn) {
      throw new JsSandboxError('该源未提供 HEAD 请求能力（ctx.fetchHead 缺失）', { ...d.loc, facet: d.facet, script: d.code })
    }
    if (url === null || url === undefined) {
      throw new JsSandboxError('java.head 参数为空（脚本传进 null/undefined）', { ...d.loc, facet: d.facet, script: d.code })
    }
    const hdrs = parseHeaderArg(d, 'java.head', headersArg)
    const r = await headFn(String(url), hdrs)
    return responseOf({ url: r.url, statusCode: r.statusCode, headers: r.headers, cookies: r.cookies ?? {}, body: '' })
  }, 'async', {
    shim: 'response',
    mountAs: 'head',
    routeProbe: 'java.head("https://m.example.com")',
  }),
  // ── 沙箱变量（java.get/put）─────────────────────────────────────────
  // 未设 → **空串**（变量读的收口是「本表 → 大变量表 → 空串」三级回落）。不要返回 undefined：
  // 过 JSON 桥会变成 null，`String(java.get('x'))` 得到字面量 "null" 拼进密钥/URL，静默错值。
  method('get', { obj: 'java' }, (d) => (key: string): string =>
    getRuleVar(d.ctx, String(key)) ?? ''),
  method('put', { obj: 'java' }, (d) => (key: string, value: unknown): void => {
    d.ctx.vars ??= {}
    d.ctx.vars[String(key)] = String(value)
  }),
  // ── 递归求值（实参类型分派，见 parseGetStringArgs：二参布尔 = unescape 开关，三参布尔 = isUrl 绝对化）──────────
  method('getString', { obj: 'java' }, (d) => (rule: unknown, arg2?: unknown, isUrlArg?: unknown): string => {
    const { content, isUrl, unescape } = parseGetStringArgs(arg2, isUrlArg)
    let s = engineValueToString(evalSubRule(d, rule, content))
    // 次序：先 unescapeHtml4（缺省 true、且只在含 '&' 时做），再按 isUrl 决定返回形态
    if (unescape) s = unescapeHtml4(s)
    if (isUrl) {
      // isUrl **不发请求**：空白回退 baseUrl，否则按落地地址（重定向后末次请求的 URL）绝对化
      // （本仓 base 取 EvalContext.baseUrl，差异记在矩阵 h-abs-urls）
      return s.trim() === '' ? d.ctx.baseUrl ?? '' : absolutizeUrl(d.ctx.baseUrl, s)
    }
    return s
  }),
  method('getStringList', { obj: 'java' }, (d) => (rule: unknown, content?: unknown, isUrlArg?: unknown): string[] => {
    const list = engineValueToStrings(evalSubRule(d, rule, content))
    if (isUrlArg !== true) return list
    // isUrl 分支：逐项绝对化，非空且未见过才收（去重按产出序）
    const out: string[] = []
    for (const item of list) {
      const abs = absolutizeUrl(d.ctx.baseUrl, item)
      if (abs !== '' && !out.includes(abs)) out.push(abs)
    }
    return out
  }),
  method('getElements', { obj: 'java' }, (d) => (rule: string): Array<{ html: string; text: string }> => {
    const v = evalRule(d, subRuleOf(String(rule), d.facet, 'list'))
    if (v.kind === 'nodes') {
      return v.nodes.toArray().map((_, i) => ({ html: v.nodes.eq(i).toString(), text: v.nodes.eq(i).text() }))
    }
    // 非节点集产物（jsonpath/js 的 value/list）按条目如实映射——JSON 数据求值时
    // （`java.getElements('$.data[*].comicList[*]')`）条目文本即 html 上下文
    if (v.kind === 'list') return v.items.map((it) => ({ html: it, text: it }))
    if (v.kind === 'value') return [{ html: v.text, text: v.text }]
    return []
  }),
  method('getElement', { obj: 'java' }, (d) => (rule: string): { html: string; text: string } | null => {
    const v = evalRule(d, subRuleOf(String(rule), d.facet, 'list'))
    // 非 nodes 或空选择集 → null（取首项，取不到即 null）
    if (v.kind === 'miss') return null
    if (v.kind !== 'nodes') {
      const items = v.kind === 'list' ? v.items : v.kind === 'value' ? [v.text] : []
      return items.length === 0 ? null : { html: items[0], text: items[0] }
    }
    if (v.nodes.length === 0) return null
    return { html: v.nodes.eq(0).toString(), text: v.nodes.eq(0).text() }
  }),
  method('setContent', { obj: 'java' }, (d) => (content: unknown): void => {
    // 后续 getString* 以设定内容为基，而非上一段 result
    d.contentBase = content === null || content === undefined ? null : String(content)
  }),
  // ── 纯工具（实现走 js-utils，可直测）────────────────────────────────
  method('timeFormat', { obj: 'java' }, () => (ts: number | string): string => fmtTime(ts, false)),
  method('timeFormatUTC', { obj: 'java' }, () => (ts: number | string): string => fmtTime(ts, true)),
  method('base64Encode', { obj: 'java' }, () => (s: string): string => base64Encode(String(s))),
  method('base64EncodeBytes', { obj: 'java' }, () => (bytes: number[]): string => base64EncodeBytes(bytes)),
  method('base64Decode', { obj: 'java' }, () => (s: string): string => base64Decode(String(s))),
  method('md5Encode', { obj: 'java' }, () => (s: string): string => md5Hex(String(s))),
  method('md5Encode16', { obj: 'java' }, () => (s: string): string => md5Hex16(String(s))),
  // ── 摘要 / HMAC 族（实参都是 data 在前）────────────────────────────────
  method('digestHex', { obj: 'java' }, () => (data: string, algorithm: string): string =>
    digestHex(String(data), String(algorithm))),
  method('digestBase64Str', { obj: 'java' }, () => (data: string, algorithm: string): string =>
    digestBase64(String(data), String(algorithm))),
  // 名字大写 H 是**原样保留的畸形名**（`HMacHex` / `HMacBase64`）——脚本里怎么写就得怎么
  // callable，改名等于把这条 API 弄没
  method('HMacHex', { obj: 'java' }, () => (data: string, algorithm: string, key: string): string =>
    hMacHex(String(data), String(algorithm), String(key))),
  method('HMacBase64', { obj: 'java' }, () => (data: string, algorithm: string, key: string): string =>
    hMacBase64(String(data), String(algorithm), String(key))),
  // 章节标题中文数字规整（真实源用它把「第五百章」写成「第500章」）
  method('toNumChapter', { obj: 'java' }, () => (s: string): string => toNumChapter(String(s))),
  method('encodeURI', { obj: 'java' }, () => (s: string): string => uriEncode(String(s))),
  method('hexDecodeToString', { obj: 'java' }, () => (hex: string): string => hexDecodeToString(String(hex))),
  method('hexEncodeToString', { obj: 'java' }, () => (utf8: string): string => hexEncodeToString(String(utf8))),
  // ── AES 解密桥（真实源正文解密形态
  //    `java.aesBase64DecodeToString(data, key, transformation, iv)`——key/iv 为 utf8 字符串，
  //    PKCS5Padding ≡ PKCS7，Node crypto 原生支持）──
  method('aesBase64DecodeToString', { obj: 'java' }, (d) =>
    (data: string, key: string, transformation?: string, iv?: string): string =>
      aesDecryptB64(String(data), String(key), String(transformation ?? 'AES/CBC/PKCS5Padding'), String(iv ?? ''), d)),
  // `createSymmetricCrypto(...).decrypt(data)` 的宿主口：返回**字节**（number[]），脚本常再接
  // `java.bytesToStr(decrypted)`（对面 SymmetricCrypto.decrypt 返 ByteArray；见 js-sandbox 的链式壳）。
  method('aesDecryptToBytes', { obj: 'java' }, (d) =>
    (data: string, key: string, transformation?: string, iv?: string): number[] =>
      Array.from(aesDecryptB64Buffer(String(data), String(key), String(transformation ?? 'AES/CBC/PKCS5Padding'), String(iv ?? ''), d))),
  // ── cookie 垫片（挂 cookie.getCookie/setCookie/removeCookie）─────────
  method('cookieGet', { obj: 'cookie', as: 'getCookie' }, (d) => (name: string): string | null =>
    jar(d).get(String(name)) ?? null),
  method('cookieSet', { obj: 'cookie', as: 'setCookie' }, (d) => (name: string, value: string): void => {
    jar(d).set(String(name), String(value))
  }),
  method('cookieRemove', { obj: 'cookie', as: 'removeCookie' }, (d) => (name: string): void => {
    jar(d).delete(String(name))
  }),
  // cookie.replaceCookie(url, cookieString)：对面按 url 取旧表、合并新串再写回（CookieStore.kt）；
  // 本仓垫片是按源键值表（无域），故只做「新串逐对覆盖」——与对面在单表内的可观测结果一致。
  method('cookieReplace', { obj: 'cookie', as: 'replaceCookie' }, (d) => (_url: string, raw: string): void => {
    const j = jar(d)
    for (const [k, v] of Object.entries(parseCookieString(String(raw)))) j.set(k, v)
  }),
  // java.getCookie(tag[, key])：对面按 url-tag 读 CookieStore；本仓 jar 按**源**隔离（name→value），
  // tag 不进判据——无 key 时取整表拼 cookie 串（近似，矩阵 `h-java-getcookie` 记差）。
  method('getCookie', { obj: 'java' }, (d) => (_tag: string, key?: unknown): string => {
    const j = jar(d)
    if (key !== undefined && key !== null && String(key) !== '') return j.get(String(key)) ?? ''
    const parts: string[] = []
    for (const [k, v] of j) parts.push(`${k}=${v}`)
    return parts.join('; ')
  }),
  // ── 源级状态（挂 source.getVariable/setVariable/get/put 与 cache.*）─────
  // 口径是**三处独立存储**：单串槽 / 键值表 / 缓存表，按源建档、互不串味；不要合并成一张 Map，
  // 否则 setVariable 会清掉键值表或缓存（见 SourceSession 注释）。
  method('sourceGetVariable', { obj: 'source', as: 'getVariable' }, (d) => (): string =>
    d.session.sourceString(d.sourceKey)),
  method('sourceSetVariable', { obj: 'source', as: 'setVariable' }, (d) => (value: string | null): void => {
    d.session.setSourceString(d.sourceKey, value === null || value === undefined ? null : String(value))
  }),
  method('sourceVarGet', { obj: 'source', as: 'get' }, (d) => (key: string): string =>
    sourceVars(d).get(String(key)) ?? ''),
  method('sourceVarPut', { obj: 'source', as: 'put' }, (d) => (key: string, value: string): string => {
    const v = String(value)
    sourceVars(d).set(String(key), v)
    return v          // put 返回写入的值（脚本有 `var x = source.put(k,v)` 的连写形态）
  }),
  // ── cache 垫片（最小仿真：按源隔离的进程内键值表，
  //    真实源 `cache.put('kkmh', …)` 搜索面写、目录面 `cache.get('kkmh')` 读的跨面形态）──
  method('cacheGet', { obj: 'cache', as: 'get' }, (d) => (key: string): string | null =>
    sourceCache(d).get(String(key)) ?? null),
  method('cachePut', { obj: 'cache', as: 'put' }, (d) => (key: string, value: unknown): void => {
    sourceCache(d).set(String(key), value === null || value === undefined ? '' : String(value))
  }),
  method('cacheDelete', { obj: 'cache', as: 'delete' }, (d) => (key: string): void => {
    sourceCache(d).delete(String(key))
  }),
  // ── cache 内存三别名（putMemory/getFromMemory/deleteMemory）──
  // 内存/磁盘分层在本仓不存在：cache 垫片就是进程内键值表，三个别名与 get/put/delete 同存储；
  // 它们只为真实源脚本的调用名而存在，不要按「另一层缓存」实现。
  method('cachePutMemory', { obj: 'cache', as: 'putMemory' }, (d) => (key: string, value: unknown): void => {
    sourceCache(d).set(String(key), value === null || value === undefined ? '' : String(value))
  }),
  method('cacheGetFromMemory', { obj: 'cache', as: 'getFromMemory' }, (d) => (key: string): string | null =>
    sourceCache(d).get(String(key)) ?? null),
  method('cacheDeleteMemory', { obj: 'cache', as: 'deleteMemory' }, (d) => (key: string): void => {
    sourceCache(d).delete(String(key))
  }),
  // ── 纯工具（续）────────────────────────────────────────────────────
  // randomUUID：小写带连字符的 UUID（crypto.randomUUID()）——
  // `@js` 动态请求头生成 device id 的真实形态
  method('randomUUID', { obj: 'java' }, () => (): string => crypto.randomUUID()),
  // ── 字节组（strToBytes / hex·base64 ToByteArray）─────────────────────
  // 脚本侧字节统一用 number[]（0-255）承载：JSON 可序列化（跨 SAB RPC 安全）、`& 0xff` 语义不变。
  method('strToBytes', { obj: 'java' }, () => (s: string, charset?: string): number[] =>
    Array.from(javaEncode(String(s), charset ?? 'UTF-8'))),
  method('hexDecodeToByteArray', { obj: 'java' }, () => (hex: string): number[] => {
    const clean = String(hex).trim()
    if (clean === '' ) return []
    if (clean.length % 2 !== 0 || /[^0-9a-fA-F]/.test(clean)) {
      throw new JsSandboxError(`hexDecodeToByteArray：非法 hex 串（长度 ${clean.length}）`, { facet: 'rule', segmentIndex: -1, segmentRaw: clean.slice(0, 64), script: '' })
    }
    return Array.from(Buffer.from(clean, 'hex'))
  }),
  method('base64DecodeToByteArray', { obj: 'java' }, () => (b64: string): number[] =>
    Array.from(Buffer.from(String(b64), 'base64'))),
  // bytesToStr：与 strToBytes 互逆（真实源 AES 解密链 `java.bytesToStr(crypto.decrypt(x))`——
  // 丁丁/盗版顶点/笔趣阁三源章节 URL）。默认 charset = UTF-8（对面 `String(bytes, charset("UTF-8"))`）。
  method('bytesToStr', { obj: 'java' }, () => (bytes: unknown, charset?: unknown): string => {
    if (!Array.isArray(bytes) && !(bytes instanceof Uint8Array)) {
      throw new JsSandboxError(`bytesToStr 参数不是字节数组（${typeof bytes}）`, { facet: 'rule', segmentIndex: -1, segmentRaw: String(bytes).slice(0, 64), script: '' })
    }
    const buf = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes as number[])
    const cs = charset === undefined || charset === null || String(charset) === '' ? 'UTF-8' : String(charset)
    return javaDecode(buf, cs)
  }),
  // ── 文件下载（downloadFile / readTxtFile）───────────────────────────
  // **进程内暂存**（非真实磁盘）：downloadFile 取字节存表、readTxtFile 取表解码——
  // 刻意**不暴露真实文件系统**（书源脚本可读任意本地路径 = 数据外泄面）；
  // 路径形态 `/dsh-cache/<md5>.<ext>` 对脚本是不透明令牌（只被传回 readTxtFile）。
  // downloadFile 需要网络 → async 行：主线程抛哨兵换 worker 同步桥（与 java.ajax 同款）。
  method('downloadFile', { obj: 'java' }, (d) => async (url: string): Promise<string> => {
    const raw = d.ctx.fetchRaw
    if (!raw) {
      throw new JsSandboxError('该源未提供二进制抓取能力（ctx.fetchRaw 缺失）', { ...d.loc, facet: d.facet, script: d.code })
    }
    const u = String(url)
    // 选项后缀 `,{…}` 不参与文件名推断——分界式与 services/request.ts 同源（engine/template.ts
    // 的 URL_OPTION_SPLIT；此处只剥不解释，抓取本身由 engineFetchRaw 经 assembleRequest 解释）
    const cut = URL_OPTION_SPLIT.exec(u)
    const clean = (cut === null ? u : u.slice(0, cut.index)).trimEnd()
    const ext = (clean.split(/[?#]/)[0].match(/\.[A-Za-z0-9]{1,6}$/) ?? ['.bin'])[0]
    const bytes = await raw(u)
    const path = `/dsh-cache/${md5Hex(u)}${ext}`
    storeFile(path, bytes)
    return path
  }, 'async', {
    shim: 'body',
    mountAs: 'downloadFile',
    routeProbe: 'java.downloadFile("https://m.example.com/a.png")',
  }),
  method('readTxtFile', { obj: 'java' }, () => (path: string, charset?: string): string => {
    const bytes = fileStore.get(String(path))
    if (bytes === undefined) {
      throw new JsSandboxError(`readTxtFile：文件不存在（只支持本进程 downloadFile 的产物，未暴露真实文件系统）：${String(path)}`, { facet: 'rule', segmentIndex: -1, segmentRaw: String(path).slice(0, 200), script: '' })
    }
    return javaDecode(bytes, charset ?? 'UTF-8')
  }),
] as const

/** downloadFile 暂存表（进程级）：条数与单文件上限的算式住 `stores.ts` 的 `createFileStore`。 */
const fileStore = createFileStore({ entries: 64, bytes: 64 * 1024 * 1024 })

function storeFile(path: string, bytes: Uint8Array): void {
  try {
    fileStore.put(path, bytes)
  } catch (e) {
    // 错误形状保持原样：JsSandboxError 带段级定位，文案以 downloadFile 前缀起头
    throw new JsSandboxError(`downloadFile：${(e as Error).message}`, {
      facet: 'rule', segmentIndex: -1, segmentRaw: path, script: '',
    })
  }
}

/** AES 解密（base64 密文 → utf8 明文）：transformation 形如 `AES/CBC/PKCS5Padding`；
 *  模式不识别 / 密钥或 IV 长度不合法 → 宁炸（JsSandboxError 带定位，不返回假明文） */
function aesDecryptB64(data: string, key: string, transformation: string, iv: string, d: BridgeDeps): string {
  return aesDecryptB64Buffer(data, key, transformation, iv, d).toString('utf8')
}

/** 同上但返回**原始字节**（`createSymmetricCrypto(...).decrypt` 与 `aesDecryptToBytes` 的口） */
function aesDecryptB64Buffer(data: string, key: string, transformation: string, iv: string, d: BridgeDeps): Buffer {
  const parts = transformation.toUpperCase().split('/')
  const cipher = parts[0] ?? 'AES'
  const mode = (parts[1] ?? 'CBC').toLowerCase()
  const fail = (msg: string): never => {
    throw new JsSandboxError(msg, { ...d.loc, facet: d.facet, script: d.code })
  }
  if (cipher !== 'AES' || (mode !== 'cbc' && mode !== 'ecb')) {
    return fail(`AES 变换不支持：${transformation}（v1 仅 AES/CBC|ECB + PKCS5/7Padding）`)
  }
  const keyBuf = Buffer.from(key, 'utf8')
  if (![16, 24, 32].includes(keyBuf.length)) {
    return fail(`AES 密钥长度不合法（${keyBuf.length} 字节，需 16/24/32）`)
  }
  const ivBuf = mode === 'ecb' ? null : Buffer.from(iv, 'utf8')
  if (ivBuf !== null && ivBuf.length !== 16) {
    return fail(`AES CBC 的 IV 长度不合法（${ivBuf.length} 字节，需 16）`)
  }
  try {
    const algo = `aes-${keyBuf.length * 8}-${mode}`
    const decipher = crypto.createDecipheriv(algo, keyBuf, ivBuf)
    decipher.setAutoPadding(true)
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()])
  } catch (e) {
    return fail(`AES 解密失败：${String((e as Error)?.message ?? e)}`)
  }
}

type AnyJavaMethod = (typeof JAVA_PROTOCOL)[number]

/** JavaBridge 接口**从表推导**（名称→精确函数签名）——不存在第二份手写 interface */
export type JavaBridge = { [E in AnyJavaMethod as E['name']]: ReturnType<E['make']> }

const PROTOCOL_INDEX = new Map<string, AnyJavaMethod>()
for (const row of JAVA_PROTOCOL) PROTOCOL_INDEX.set(row.name, row)

/** 沙箱引导用挂载清单（从表派生）：引导脚本按此挂 sync 包装，不再手写名单 */
export const SANDBOX_MOUNTS = {
  /** java 对象上的同步方法名（async 行不走 `sync()` 转发，见 javaAsyncMounts） */
  javaSync: JAVA_PROTOCOL.flatMap((r) => (r.mount.obj === 'java' && r.mode !== 'async' ? [r.name] : [])),
  /** java 对象上的异步方法：{ name: 宿主调用名, target: 脚本属性名 }（由 `asyncMountSource` 生成挂载行）。
   *  别名（webViewGetSource）只能在此登记——表里只有宿主方法名，没有这个脚本拼写。 */
  javaAsyncMounts: [
    ...JAVA_PROTOCOL.flatMap((r) =>
      r.mode === 'async' && r.bridge?.mountAs != null ? [{ name: r.name, target: r.bridge.mountAs }] : []),
    { name: 'webView', target: 'webViewGetSource' },
  ],
  /** cookie 对象：{ name: 宿主调用名, key: 脚本属性名 } */
  cookie: JAVA_PROTOCOL.flatMap((r) => (r.mount.obj === 'cookie' ? [{ name: r.name, key: r.mount.as }] : [])),
  /** source 对象（__src__）：{ name: 宿主调用名, key: 脚本属性名 } */
  source: JAVA_PROTOCOL.flatMap((r) => (r.mount.obj === 'source' ? [{ name: r.name, key: r.mount.as }] : [])),
  /** cache 对象（最小仿真的按源进程内键值表）：{ name: 宿主调用名, key: 脚本属性名 } */
  cache: JAVA_PROTOCOL.flatMap((r) => (r.mount.obj === 'cache' ? [{ name: r.name, key: r.mount.as }] : [])),
}

/**
 * 宿主分派（表查，无逐案 switch）：返回 JSON 可序列化的值；async 行返回 Promise。
 * 参数为引导层 JSON.parse 出的原始数组——实现内部自行防御转换（与旧 switch 逐案
 * String()/Number() 的行为一致）。
 */
export function invokeJavaMethod(d: BridgeDeps, name: string, rawArgs: readonly unknown[]): unknown | Promise<unknown> {
  const row = PROTOCOL_INDEX.get(name)
  if (row === undefined) {
    throw new JsSandboxError(`未知 java 方法: ${name}`, { facet: 'rule', segmentIndex: -1, segmentRaw: name, script: name })
  }
  // 受控的唯一收窄点：表行 make 的精确签名服务类型面推导；宿主分派处按 JSON 原始参数调用。
  const fn = row.make(d) as (...args: unknown[]) => unknown
  return fn(...rawArgs)
}

/** 主线程那一臂抛的哨兵：`asyncBridgeSource` 把它写进每个 async 桥，路由侧（js-sandbox 的
 *  `needsSyncBridge`）按同一个值换 worker 重跑。**抛与认只许一个主人**——值抄成第二份时，
 *  改一头另一头跟不上，认不出哨兵等于脚本直接拿到一条错误而不是换道重跑（口径见 `docs/adr/0005`）。 */
export const SYNC_AJAX_SENTINEL = '__dsh_sync_ajax_required__'

/** 异步行的沙箱侧同步桥源码——插进 `js-sandbox.ts` 的 `BOOTSTRAP` 模板串。生成逻辑住这，
 *  js-sandbox 不得手抄桥段：加一行 async 方法只该动表，手抄会让「挂载」与「路由」两处失去闸。
 *  输出被当**文本**插进模板串，故不得含反引号或 `${`。
 *
 *  生成文本的自由标识符**只许**这四个，且全部由 BOOTSTRAP 的作用域供出：`d.syncAjax`（worker /
 *  主线程分支开关）、`invoke`（序列化 + 宿主调用）、`msg`（错误取消息）、`materialize`（响应描述符
 *  物化）。生成器自己闭包里多引一个名字，插进模板串后是脚本运行期的 ReferenceError，不是编译错。 */
export function asyncBridgeSource(): string {
  const THROW = `throw new Error(${JSON.stringify(SYNC_AJAX_SENTINEL)})`
  return JAVA_PROTOCOL.flatMap((r) => {
    if (r.mode !== 'async' || r.bridge === undefined) return []
    const call = `invoke(${JSON.stringify(r.name)}, [].slice.call(arguments))`
    // 主线程分支一律在**发起宿主调用之前**抛哨兵：evalJs 捕获后换 worker 重跑同一段，请求没
    // 发出去、不多打站点。不要在这里返回 Promise——ajax 的同步语义会静默变成异步。
    const head = `  const ${r.name} = d.syncAjax ? function () {`
    const tail = `  } : function () { ${THROW} }`
    switch (r.bridge.shim) {
      // ajax / downloadFile：worker 直出数据面（响应 body 串 / 暂存路径串）。
      case 'body':
        return [`${head}\n    const r = ${call}\n    try { return JSON.parse(r) } catch (e) { throw new Error(msg(e)) }\n${tail}`]
      // post / head（及经双参 `java.get` 到达的 getHttp）：宿主给 `__host:'response'` 描述符，
      // materialize 统一包成 statusCode/header/headers/body/cookies 方法壳。
      case 'response':
        return [`${head}\n    let r\n    try { r = JSON.parse(${call}) } catch (e) { throw new Error(msg(e)) }\n    return materialize(r)\n${tail}`]
      // webView / urlConn：数据面本身就是脚本要的形状，不包壳。
      case 'raw':
        return [`${head}\n    let r\n    try { r = JSON.parse(${call}) } catch (e) { throw new Error(msg(e)) }\n    return r\n${tail}`]
      // connect：`raw()` 与 `url()` 是**同一值**（跟随重定向后的末次请求地址）——raw 壳直接
      // 复用数据面的 url，不额外跨桥带字段；`connect(so).raw().request().url()` 取的就是落地地址。
      case 'connect':
        return [`${head}\n    const raw = ${call}\n    let r\n    try { r = JSON.parse(raw) } catch (e) { throw new Error(msg(e)) }\n    return {\n      url: r.url,\n      body: r.body,\n      raw: function () {\n        return { request: function () { return { url: function () { return r.url } } } }\n      },\n    }\n${tail}`]
      default: {
        // 表里新增 `BridgeShape` 成员而生成器没跟上时，编译期就红；运行时再兜一次，
        // 免得漏产一行桥壳（脚本拿到 undefined）被当成「这个方法本来就不支持」。
        const _never: never = r.bridge.shim
        throw new Error(`未处理的 async 桥形态：${String(_never)}`)
      }
    }
  }).join('\n')
}

/** `g.java = { … }` 里的异步挂载行（源码文本，BOOTSTRAP 内插值）。必须是源码而非运行时循环：
 *  那些 `const <name>` 在引导闭包里，不是 `g` 的属性。 */
export function asyncMountSource(): string {
  return SANDBOX_MOUNTS.javaAsyncMounts.map((m) => `    ${m.target}: ${m.name},`).join('\n')
}

/** 逐行的路由探针：`SYNC_WORKER_RE` 必须认出每一种可达写法（测试消费；认不出即空结果冒充失败）。 */
export function asyncRouteProbes(): { name: string; probe: string }[] {
  return JAVA_PROTOCOL.flatMap((r) =>
    r.mode === 'async' && r.bridge !== undefined ? [{ name: r.name, probe: r.bridge.routeProbe }] : [])
}
