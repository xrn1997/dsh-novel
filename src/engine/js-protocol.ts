/**
 * JavaBridge 协议表（根治「JavaBridge 协议知识散四处」）。
 *
 * 病灶：加一个 java 方法曾要同步改 4 处——①JavaBridge interface ②BOOTSTRAP 的 sync/async 名单
 * ③makeHostCall 的 switch 分派 ④makeJavaBridge 的实现。本文件把 ①③④ 收成**一张表**：
 * 每行 = 方法名 · sync/async · 沙箱挂载点 · 宿主实现（inline 闭包）。
 *
 * - **JavaBridge 类型从表推导**（mapped type）——不存在独立手写 interface，缺登记/多登记在
 *   类型面就不存在；表即唯一登记点。
 * - **BOOTSTRAP 名单从表派生**：SANDBOX_MOUNTS 由表过滤生成，经 evalJs 的 __init__ JSON
 *   注入沙箱，引导脚本按清单挂 sync 包装（ajax 为 async 走引导层特制包装，不进 sync 名单）。
 * - **分派从表查**：invokeJavaMethod 按名查行调实现，无逐案 switch。
 *
 * 加一个方法 = 本表加一行（含实现）——BOOTSTRAP/分派/类型面全部自动跟随。
 *
 * 纪律：本文件**不进** engine barrel（src/engine/index.ts）——仅由 js-sandbox 内部引用。
 *
 * 设计文档：docs/design/engine.md
 */
import crypto from 'node:crypto'
import type { EngineValue, EvalContext, Facet, SegmentLoc } from './types.js'
import { JsSandboxError } from './errors.js'
import { URL_OPTION_SPLIT } from './template.js'
import type { EvaluateRef, SourceSession } from './js-sandbox.js'
import { getRuleVar } from './variables.js'
import {
  absolutizeUrl,
  base64Decode,
  base64Encode,
  digestBase64,
  digestHex,
  engineValueToString,
  engineValueToStrings,
  fmtTime,
  hMacBase64,
  hMacHex,
  hexDecodeToString,
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
  /** cookie/源变量的按源隔离键（ctx.source ?? ctx.baseUrl ?? ''） */
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

interface JavaMethod<N extends string, F extends HostFn> {
  readonly name: N
  /** sync（缺省）：宿主同步返回；async：返回 Promise（当前仅 ajax） */
  readonly mode?: 'async'
  readonly mount: Mount
  /** 宿主实现工厂：闭包捕获 deps；返回的函数即桥方法（内部自带 String()/Number() 防御转换） */
  readonly make: (d: BridgeDeps) => F
}

function method<N extends string, F extends HostFn>(
  name: N,
  mount: Mount,
  make: (d: BridgeDeps) => F,
  mode?: 'async',
): JavaMethod<N, F> {
  return mode === undefined ? { name, mount, make } : { name, mode, mount, make }
}

/** java.getString* 的递归求值（evaluateRef 未注入 → 宁炸不猜）
 *  第三参 content 是**对面的 mContent**：显式给值即以它为基（`mContent ?: this.content`），
 *  null/undefined 回落到本仓的 contentBase ?? result（java.setContent 那条路）。 */
function evalRule(d: BridgeDeps, rule: string, content?: unknown): EngineValue {
  if (!d.evaluateRef) {
    throw new JsSandboxError(`java 递归求值需要引擎接线（evaluateRef 未注入，规则: ${JSON.stringify(rule)}）`, {
      ...d.loc,
      facet: d.facet,
      script: d.code,
    })
  }
  const base = content === undefined || content === null ? d.contentBase ?? d.result : content
  return d.evaluateRef(rule, base)
}

/** getString / getStringList 的实参分派：对面是**两个重载**，位置语义不同。
 *  · `getString(rule, unescape)` —— 第二参布尔就是「要不要再做一次 HTML 反转义」；
 *  · `getString(rule, mContent, isUrl)` —— 第二参是基内容、第三参才是 isUrl。
 *  本仓此前只有一个 `(rule, isUrl?)` 签名：`true` 被当未实现直接抛，`false` 不抛但把
 *  「不要反转义」静默反做（对面 `false` 出原文、本仓出解码后的值）。 */
function parseGetStringArgs(arg2?: unknown, arg3?: unknown): { content?: unknown; isUrl: boolean; unescape: boolean } {
  if (typeof arg2 === 'boolean') return { content: undefined, isUrl: false, unescape: arg2 }
  return { content: arg2, isUrl: arg3 === true, unescape: true }
}

const jar = (d: BridgeDeps): Map<string, string> => d.session.cookieJar(d.sourceKey)
const sourceVars = (d: BridgeDeps): Map<string, string> => d.session.sourceVars(d.sourceKey)
const sourceCache = (d: BridgeDeps): Map<string, string> => d.session.cacheStore(d.sourceKey)

/**
 * JavaBridge 协议表：**唯一登记点**。行序即文档序（与 legado 宿主 API 分组一致）。
 * 添加方法只改此处一行（含实现）——类型面/BOOTSTRAP 名单/宿主分派全部派生跟随。
 */
export const JAVA_PROTOCOL = [
  // ── 网络 ────────────────────────────────────────────────────────────
  method('ajax', { obj: 'java' }, (d) => (url: unknown): Promise<string> => {
    const fetchFn = d.ctx.fetch
    if (!fetchFn) {
      throw new JsSandboxError('该源未提供网络能力（ctx.fetch 缺失）', { ...d.loc, facet: d.facet, script: d.code })
    }
    // 参数规约对齐 Rhino 的 String 形参强制转换：`java.ajax(result)` 传进来的常是上一段的
    // 值——JSONPath 给单元素数组时，对面按 toString 拼成那条 URL（`['https://x']` → `https://x`），
    // 本仓此前把原值直接交给请求组装层，炸成 `template.replace is not a function`
    // （灯读文学 detail init 段实证：既没线索，结果也和对面不同）。
    // null/undefined 不猜成字符串 "null" 去打站点：对面拿它 new URL 也是抛，本仓点名参数缺失。
    if (url === null || url === undefined) {
      throw new JsSandboxError('java.ajax 参数为空（脚本传进 null/undefined）', { ...d.loc, facet: d.facet, script: d.code })
    }
    // 如实失败：ajax 这里不挂任何 rejection 防线——主线程形态已改为在发起宿主调用前抛哨兵
    // （由 evalJs 换 worker 重跑），worker 形态同步返回，两条路都不产生悬空 Promise。
    // 进程级 ensureUnhandledGuard 是常驻最后防线，管的是脚本**自建**又 fire-and-forget 的
    // 异步工作。见 js-sandbox 的 BOOTSTRAP 注释与 docs/design/engine.md。
    return fetchFn(String(url)).then((r) => r?.body ?? '')
  }, 'async'),
  // java.connect：对面返回 `StrResponse{url, body}`（对象，脚本写 `connect(u).body`），
  // 与 ajax 只差一层壳。两点**刻意分歧**：
  // ① 对面第二/三参接 header JSON 与 callTimeout——本仓 ctx.fetch 没有请求头通道（头由请求
  //    组装层按源规则统一装配），传了非空 header 就点名，不静默丢掉脚本的意图；
  // ② 对面 `runCatching` 把异常塞进 body（StrResponse(url, stackTraceStr)）——错误文本冒充
  //    正文是本仓定义的最高罪，失败照旧抛出。见矩阵 `h-java-connect`。
  method('connect', { obj: 'java' }, (d) => async (url: unknown, header?: unknown): Promise<{ url: string; body: string }> => {
    const fetchFn = d.ctx.fetch
    if (!fetchFn) {
      throw new JsSandboxError('该源未提供网络能力（ctx.fetch 缺失）', { ...d.loc, facet: d.facet, script: d.code })
    }
    if (url === null || url === undefined) {
      throw new JsSandboxError('java.connect 参数为空（脚本传进 null/undefined）', { ...d.loc, facet: d.facet, script: d.code })
    }
    if (typeof header === 'string' && header.trim() !== '') {
      throw new JsSandboxError(
        `java.connect 的 header 参数在本仓没有通道（请求头由源规则经请求组装层装配）：${header.slice(0, 60)}`,
        { ...d.loc, facet: d.facet, script: d.code },
      )
    }
    const u = String(url)
    return fetchFn(u).then((r) => ({ url: u, body: r?.body ?? '' }))
  }, 'async'),
  // java.post：对面 `help/JsExtensions.kt:post(urlStr, body, headers, timeout)` → Jsoup 的
  // Connection.Response（**对象**，脚本写 `res.body()` / `res.cookies()`）。独立书源合集现量 9 源在用
  // （解析面普查第 23 批：本库 214 源一条都没有，所以此前从未暴露）。
  // 宿主侧返回数据面，`.body()` 那层壳在 BOOTSTRAP 里包（跨 worker 只走 JSON，不传函数）。
  // 与 connect 同两条刻意分歧：本仓没有源级 header 之外的通道时**不静默丢**——这里 headers 是
  // 对面签名里就有的参数，故照收并叠到源级头之上；对面 `timeout` 第四参本仓走进程级超时，忽略之。
  method('post', { obj: 'java' }, (d) => async (
    url: unknown, body?: unknown, headersArg?: unknown,
  ): Promise<{ url: string; body: string; contentType?: string; statusCode: number; cookies: Record<string, string> }> => {
    const postFn = d.ctx.fetchPost
    if (!postFn) {
      throw new JsSandboxError('该源未提供 POST 网络能力（ctx.fetchPost 缺失）', { ...d.loc, facet: d.facet, script: d.code })
    }
    if (url === null || url === undefined) {
      throw new JsSandboxError('java.post 参数为空（脚本传进 null/undefined）', { ...d.loc, facet: d.facet, script: d.code })
    }
    // 对面形参是 Map<String,String>：脚本常给 JSON 串（`'{"Content-Type":"..."}'`）， Rhino 侧
    // 由 Gson 转；本仓两种都收，认不出的形状点名而不是当 header 发出去。
    let hdrs: Record<string, string> | undefined
    if (typeof headersArg === 'string' && headersArg.trim() !== '') {
      try { hdrs = JSON.parse(headersArg) as Record<string, string> } catch {
        throw new JsSandboxError(`java.post 的 header 参数不是 JSON：${headersArg.slice(0, 60)}`, { ...d.loc, facet: d.facet, script: d.code })
      }
    } else if (headersArg !== null && typeof headersArg === 'object' && headersArg !== undefined) {
      hdrs = headersArg as Record<string, string>
    }
    return postFn(String(url), body === null || body === undefined ? '' : String(body), hdrs)
  }, 'async'),
  // java.getWebViewUA：对面返回 WebView 的默认 UA。本仓没有 WebView —— 返回**我们实际发出去的
  // 那条 UA**：对拼 headers 的脚本可用，但它不是设备/内核真实的 WebView UA，属**近似**（矩阵
  // `h-java-webview-ua` 记着这条差）。ctx.userAgent 未接线时点名抛错，绝不编一个串冒充。
  method('getWebViewUA', { obj: 'java' }, (d) => (): string => {
    if (!d.ctx.userAgent) {
      throw new JsSandboxError('java.getWebViewUA 取不到出站 UA（ctx.userAgent 未接线）', { ...d.loc, facet: d.facet, script: d.code })
    }
    return d.ctx.userAgent()
  }),
  // ── 沙箱变量（java.get/put）─────────────────────────────────────────
  method('get', { obj: 'java' }, (d) => (key: string): string | undefined =>
    getRuleVar(d.ctx, String(key))),
  method('put', { obj: 'java' }, (d) => (key: string, value: unknown): void => {
    d.ctx.vars ??= {}
    d.ctx.vars[String(key)] = String(value)
  }),
  // ── 递归求值（对面两个重载：二参布尔 = unescape 开关，三参布尔 = isUrl 绝对化）────────
  method('getString', { obj: 'java' }, (d) => (rule: unknown, arg2?: unknown, isUrlArg?: unknown): string => {
    const { content, isUrl, unescape } = parseGetStringArgs(arg2, isUrlArg)
    let s = engineValueToString(evalRule(d, String(rule), content))
    // 对面次序：先 unescapeHtml4（缺省 true、且只在含 '&' 时做），再按 isUrl 决定返回形态
    if (unescape) s = unescapeHtml4(s)
    if (isUrl) {
      // 对面的 isUrl **不发请求**：空白回退 baseUrl，否则按 redirectUrl 绝对化
      // （本仓 base 取 EvalContext.baseUrl，差异记在矩阵 h-abs-urls）
      return s.trim() === '' ? d.ctx.baseUrl ?? '' : absolutizeUrl(d.ctx.baseUrl, s)
    }
    return s
  }),
  method('getStringList', { obj: 'java' }, (d) => (rule: unknown, content?: unknown, isUrlArg?: unknown): string[] => {
    const list = engineValueToStrings(evalRule(d, String(rule), content))
    if (isUrlArg !== true) return list
    // 对面 getStringList 的 isUrl 分支：逐项绝对化，非空且未见过才收（去重按产出序）
    const out: string[] = []
    for (const item of list) {
      const abs = absolutizeUrl(d.ctx.baseUrl, item)
      if (abs !== '' && !out.includes(abs)) out.push(abs)
    }
    return out
  }),
  method('getElements', { obj: 'java' }, (d) => (rule: string): Array<{ html: string; text: string }> => {
    const v = evalRule(d, String(rule))
    if (v.kind === 'nodes') {
      return v.nodes.toArray().map((_, i) => ({ html: v.nodes.eq(i).toString(), text: v.nodes.eq(i).text() }))
    }
    // 非节点集产物（jsonpath/js 的 value/list）按条目如实映射——legado getElements 对 JSON 数据
    // 求值的形态（`java.getElements('$.data[*].comicList[*]')`）：条目文本即 html 上下文
    if (v.kind === 'list') return v.items.map((it) => ({ html: it, text: it }))
    if (v.kind === 'value') return [{ html: v.text, text: v.text }]
    return []
  }),
  method('getElement', { obj: 'java' }, (d) => (rule: string): { html: string; text: string } | null => {
    const v = evalRule(d, String(rule))
    // 非 nodes 或空选择集 → null（旧行为 = getElements(rule)[0] ?? null）
    if (v.kind === 'miss') return null
    if (v.kind !== 'nodes') {
      const items = v.kind === 'list' ? v.items : v.kind === 'value' ? [v.text] : []
      return items.length === 0 ? null : { html: items[0], text: items[0] }
    }
    if (v.nodes.length === 0) return null
    return { html: v.nodes.eq(0).toString(), text: v.nodes.eq(0).text() }
  }),
  method('setContent', { obj: 'java' }, (d) => (content: unknown): void => {
    // legado：后续 getString* 以设定内容为基，而非上一段 result
    d.contentBase = content === null || content === undefined ? null : String(content)
  }),
  // ── 纯工具（实现走 js-utils，可直测）────────────────────────────────
  method('timeFormat', { obj: 'java' }, () => (ts: number | string): string => fmtTime(ts, false)),
  method('timeFormatUTC', { obj: 'java' }, () => (ts: number | string): string => fmtTime(ts, true)),
  method('base64Encode', { obj: 'java' }, () => (s: string): string => base64Encode(String(s))),
  method('base64Decode', { obj: 'java' }, () => (s: string): string => base64Decode(String(s))),
  method('md5Encode', { obj: 'java' }, () => (s: string): string => md5Hex(String(s))),
  method('md5Encode16', { obj: 'java' }, () => (s: string): string => md5Hex16(String(s))),
  // ── 摘要 / HMAC 族（对面 JsEncodeUtils 的「消息摘要/散列消息鉴别码」段，实参都是 data 在前）──
  method('digestHex', { obj: 'java' }, () => (data: string, algorithm: string): string =>
    digestHex(String(data), String(algorithm))),
  method('digestBase64Str', { obj: 'java' }, () => (data: string, algorithm: string): string =>
    digestBase64(String(data), String(algorithm))),
  // 名字大写 H 是**对面的原样**（`JsEncodeUtils.HMacHex/HMacBase64` 靠 @Suppress("FunctionName")
  // 保住这个畸形名）——脚本里怎么写就得怎么 callable，改名等于把这条 API 弄没
  method('HMacHex', { obj: 'java' }, () => (data: string, algorithm: string, key: string): string =>
    hMacHex(String(data), String(algorithm), String(key))),
  method('HMacBase64', { obj: 'java' }, () => (data: string, algorithm: string, key: string): string =>
    hMacBase64(String(data), String(algorithm), String(key))),
  // 章节标题中文数字规整（legado JsExtensions.toNumChapter；真实源用它把「第五百章」写成「第500章」）
  method('toNumChapter', { obj: 'java' }, () => (s: string): string => toNumChapter(String(s))),
  method('encodeURI', { obj: 'java' }, () => (s: string): string => uriEncode(String(s))),
  method('hexDecodeToString', { obj: 'java' }, () => (hex: string): string => hexDecodeToString(String(hex))),
  // ── AES 解密桥（legado java.aesBase64DecodeToString：真实源正文解密形态
  //    `java.aesBase64DecodeToString(data, key, transformation, iv)`——key/iv 为 utf8 字符串，
  //    PKCS5Padding ≡ PKCS7，Node crypto 原生支持）──
  method('aesBase64DecodeToString', { obj: 'java' }, (d) =>
    (data: string, key: string, transformation?: string, iv?: string): string =>
      aesDecryptB64(String(data), String(key), String(transformation ?? 'AES/CBC/PKCS5Padding'), String(iv ?? ''), d)),
  // ── cookie 垫片（挂 cookie.getCookie/setCookie/removeCookie）─────────
  method('cookieGet', { obj: 'cookie', as: 'getCookie' }, (d) => (name: string): string | null =>
    jar(d).get(String(name)) ?? null),
  method('cookieSet', { obj: 'cookie', as: 'setCookie' }, (d) => (name: string, value: string): void => {
    jar(d).set(String(name), String(value))
  }),
  method('cookieRemove', { obj: 'cookie', as: 'removeCookie' }, (d) => (name: string): void => {
    jar(d).delete(String(name))
  }),
  // ── 源级状态（挂 source.getVariable/setVariable/get/put 与 cache.*）─────
  // 对面是**三处存储**（data/entities/BaseSource.kt：sourceVariable_<s> 单串槽 / v_<s>_<key> 键值表；
  // CacheManager 全局表）。本仓三张表按源建档、互不串味——旧实现把前两处塞进同一张 Map，
  // setVariable 先 clear() 整表（清空 source.put 写过的键）且把 getVariable 做成整表 JSON 壳。
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
    return v          // 对面 put 返回写入的值（脚本有 `var x = source.put(k,v)` 的连写形态）
  }),
  // ── cache 垫片（legado CacheManager 最小仿真：按源隔离的进程内键值表，
  //    真实源 `cache.put('kkmh', …)` 搜索面写、目录面 `cache.get('kkmh')` 读的跨面形态）──
  method('cacheGet', { obj: 'cache', as: 'get' }, (d) => (key: string): string | null =>
    sourceCache(d).get(String(key)) ?? null),
  method('cachePut', { obj: 'cache', as: 'put' }, (d) => (key: string, value: unknown): void => {
    sourceCache(d).set(String(key), value === null || value === undefined ? '' : String(value))
  }),
  method('cacheDelete', { obj: 'cache', as: 'delete' }, (d) => (key: string): void => {
    sourceCache(d).delete(String(key))
  }),
  // ── cache 内存三别名（legado CacheManager.putMemory/getFromMemory/deleteMemory）──
  // legado 里 put = 内存+磁盘双写、putMemory 仅写内存 LRU、get 先内存后磁盘——本仓的 cache
  // 垫片**本来就是进程内键值表**（没有第二层磁盘存储），三个内存别名与 get/put/delete 同存储：
  // 语义差异（内存 vs SQLite）在这里不存在，别名只为真实源脚本的调用名而在。
  // 真机实证：novel.cooks.tw 目录脚本 `cache.putMemory('articleid', …)` 此前报 not a function。
  method('cachePutMemory', { obj: 'cache', as: 'putMemory' }, (d) => (key: string, value: unknown): void => {
    sourceCache(d).set(String(key), value === null || value === undefined ? '' : String(value))
  }),
  method('cacheGetFromMemory', { obj: 'cache', as: 'getFromMemory' }, (d) => (key: string): string | null =>
    sourceCache(d).get(String(key)) ?? null),
  method('cacheDeleteMemory', { obj: 'cache', as: 'deleteMemory' }, (d) => (key: string): void => {
    sourceCache(d).delete(String(key))
  }),
  // ── 纯工具（续）────────────────────────────────────────────────────
  // legado JsExtensions.randomUUID：UUID.randomUUID().toString()（小写带连字符）——
  // `@js` 动态请求头生成 device id 的真实形态（顶点小说 header 规则实证）
  method('randomUUID', { obj: 'java' }, () => (): string => crypto.randomUUID()),
  // ── 字节组（legado JsExtensions：strToBytes/hex·base64 ToByteArray）──
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
  // ── 文件下载（legado JsExtensions.downloadFile / readTxtFile）────────
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
  }, 'async'),
  method('readTxtFile', { obj: 'java' }, () => (path: string, charset?: string): string => {
    const bytes = FILE_STORE.get(String(path))
    if (bytes === undefined) {
      throw new JsSandboxError(`readTxtFile：文件不存在（只支持本进程 downloadFile 的产物，未暴露真实文件系统）：${String(path)}`, { facet: 'rule', segmentIndex: -1, segmentRaw: String(path).slice(0, 200), script: '' })
    }
    return javaDecode(bytes, charset ?? 'UTF-8')
  }),
] as const

/** downloadFile 暂存表：条数上限（Map 插入序淘汰最旧）+ 单文件字节上限。如实说清它挡的是什么：
 *  这两道闸限的是**条目数与单文件大小**，不是总常驻字节——64 × 64MB 的最坏情况仍达 4GB，
 *  要收总盘子得再加一道字节计数淘汰；当前没加，因为真实源下载的是 KB 级密钥图。 */
const FILE_STORE = new Map<string, Uint8Array>()
const FILE_STORE_CAP = 64
const FILE_BYTES_CAP = 64 * 1024 * 1024

function storeFile(path: string, bytes: Uint8Array): void {
  if (bytes.byteLength > FILE_BYTES_CAP) {
    throw new JsSandboxError(`downloadFile：文件超过 ${FILE_BYTES_CAP / 1024 / 1024}MB 上限`, { facet: 'rule', segmentIndex: -1, segmentRaw: path, script: '' })
  }
  if (FILE_STORE.size >= FILE_STORE_CAP) {
    const oldest = FILE_STORE.keys().next().value
    if (oldest !== undefined) FILE_STORE.delete(oldest)
  }
  FILE_STORE.set(path, bytes)
}

/** AES 解密（base64 密文 → utf8 明文）：transformation 形如 `AES/CBC/PKCS5Padding`；
 *  模式不识别 / 密钥或 IV 长度不合法 → 宁炸（JsSandboxError 带定位，不返回假明文） */
function aesDecryptB64(data: string, key: string, transformation: string, iv: string, d: BridgeDeps): string {
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
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8')
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
  /** java 对象上的同步方法名（async 行不进——ajax 走引导层特制包装） */
  javaSync: JAVA_PROTOCOL.flatMap((r) => (r.mount.obj === 'java' && r.mode !== 'async' ? [r.name] : [])),
  /** cookie 对象：{ name: 宿主调用名, key: 脚本属性名 } */
  cookie: JAVA_PROTOCOL.flatMap((r) => (r.mount.obj === 'cookie' ? [{ name: r.name, key: r.mount.as }] : [])),
  /** source 对象（__src__）：{ name: 宿主调用名, key: 脚本属性名 } */
  source: JAVA_PROTOCOL.flatMap((r) => (r.mount.obj === 'source' ? [{ name: r.name, key: r.mount.as }] : [])),
  /** cache 对象（legado CacheManager 最小仿真）：{ name: 宿主调用名, key: 脚本属性名 } */
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
