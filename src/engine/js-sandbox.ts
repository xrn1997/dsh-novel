import vm from 'node:vm'
import { DEFAULT_JS_TIMEOUT_MS } from './types.js'
import type { EngineValue, EvalContext, Facet, SegmentLoc } from './types.js'
import type { SubRule } from './sub-rule.js'
import type { SourceSession } from './session.js'
import { JsSandboxError } from './errors.js'
import { acquireRejectionGuard } from './rejection-guard.js'
import { SANDBOX_MOUNTS, SYNC_AJAX_SENTINEL, SYNC_WORKER_RE, asyncBridgeSource, asyncMountSource, invokeJavaMethod } from './js-protocol.js'
import type { BridgeDeps } from './js-protocol.js'
import { messageOf, textOf } from './js-utils.js'
import { elemHostOp, elemWrapperSource } from './host-surface-elem.js'
import { pkgHostOp, pkgWrapperSource } from './host-surface-pkg.js'
import { scriptGlobals, scriptGlobalOf, scriptInitOf, scriptKeyOf } from './script-surface.js'

/** JavaBridge 协议的唯一登记点在 js-protocol.ts 的 JAVA_PROTOCOL 表；此处只 re-export 类型。 */
export type { JavaBridge } from './js-protocol.js'

/** 沙箱宿主注入面。桥恒由 evalJs 按协议表构造；不要在此加 `java` 覆盖点（会造出没有生产者的假 seam）。 */
export interface JsHost {
  /** 上一段结果的序列化串（Value.text / List.items.join('\n') / 页面原文） */
  result: string
  /** nodes/page：沙箱把 result 包成元素包装对象（`result.attr()` 等形态） */
  resultKind?: string
  /** 以宿主响应对象绑定 result（loginCheckJs：脚本读 result.url()/code()/body()） */
  resultHost?: import('./host-object.js').ResponseHost
  /** 以宿主 Map 绑定 result（登录按钮动作读 result.get(...)；与 resultHost 互斥） */
  resultMap?: Record<string, string>
  /** 上一段结果所在的路径：list → 元素集合（forEach/length/下标），value → 仍是字符串对象 */
  resultCtx?: 'list' | 'value'
  baseUrl: string
  source: string
  /** searchUrl @js 形态的沙箱全局变量 key/page */
  key?: string
  page?: number
  /** 源静态 header 的 JSON 串（输入脚本有 `JSON.parse(source.header)` 形态） */
  header?: string
  console?: { log: (...a: unknown[]) => void; error: (...a: unknown[]) => void }
}

/** 脚本形态缺省的唯一主人：`scriptForm` 未给即按脚本形态跑（完成值即结果，见 `EvalJsOptions`）。 */
const DEFAULT_SCRIPT_FORM = true

export interface EvalJsOptions {
  /** 脚本完成值语义：最后表达式的值即结果；顶层 return/await 编译失败时回落函数体形态 */
  scriptForm?: boolean
  /** 脚本可见的源会话；缺省进程级实例（跨调用存活），测试注入 createSourceSession() 隔离 */
  session?: SourceSession
}

/**
 * runScript：沙箱对**服务层与测试**的那一扇门（引擎内部走 `evalJs`，入参形状见 `JsCall`）。
 * 能力面就是 `EvalContext` 的全部位——不要在这里抄第二份清单：漏一格会让 `java.post` 抛 fetchPost 缺失。
 */
export interface RunScriptOptions extends EvalContext {
  code: string
  result?: string
  key?: string
  page?: number
  header?: string
  loc: SegmentLoc
  facet: Facet
  scriptForm?: boolean
  evaluateRef?: EvaluateRef
  session?: SourceSession
  /** loginCheckJs 的响应对象绑定（与规则链的 result 字符串互斥） */
  resultHost?: import('./host-object.js').ResponseHost
  /** 登录按钮动作的 loginInfo Map（与 resultHost / result 字符串互斥） */
  resultMap?: Record<string, string>
}

export function runScript(o: RunScriptOptions): Promise<JsOutcome> {
  // 能力位原样透传，只剥出 host/驱动专属格；`resultKind`/`resultCtx`/`console` 只由规则链的求值层构造。
  const { code, result, key, page, header, loc, facet, scriptForm, evaluateRef, session, resultHost, resultMap, ...ctx } = o
  const host: JsHost = {
    result: result ?? '',
    baseUrl: ctx.baseUrl ?? '',
    source: ctx.source ?? '',
    ...(key === undefined ? {} : { key }),
    ...(page === undefined ? {} : { page }),
    ...(header === undefined ? {} : { header }),
    ...(resultHost === undefined ? {} : { resultHost }),
    ...(resultMap === undefined ? {} : { resultMap }),
  }
  return evalJs({
    code, host, ctx, loc, facet,
    ...(evaluateRef === undefined ? {} : { evaluateRef }),
    opts: { scriptForm: scriptForm ?? DEFAULT_SCRIPT_FORM, ...(session === undefined ? {} : { session }) },
  })
}

export interface JsOutcome {
  value: EngineValue
  logs: string[]
}

/** 规则递归求值回调（由求值层注入，避免循环依赖）。用途不作第三参外传——要强制列表时由
 *  `subRuleOf` 的 `forceUsage` 在构造期定；baseUrl 由外层 EvalContext 经 `{...ctx, html}` 继承。 */
export type EvaluateRef = (sub: SubRule, data: unknown) => EngineValue

/** 求值层 → 沙箱的唯一调用描述符。字段按名传递；不要改回位置元组——加一格要同时改两处 yield 与
 *  driveSync 的下标。 */
export interface JsCall {
  code: string
  host: JsHost
  ctx: EvalContext
  loc: SegmentLoc
  facet: Facet
  evaluateRef?: EvaluateRef
  opts?: EvalJsOptions
}

/** 超时哨兵。必须作为 Promise rejection 的原因出门（`prefer-promise-reject-errors` 要 Error），两处判定按
 *  **同一性**比较、从不读文案——不要改成按 message 认。 */
const TIMEOUT = new Error('js-sandbox-timeout')

/** worker 那条 race 的宽限：`vm` 的 timeout 管不住「await 一个永不 settle 的 promise」，这一条管。必须**晚于**
 *  调用方预算到，否则跑满预算的脚本会被自己判死；多出的那截留给「主线程替 worker 服务宿主调用」的往返。
 *  主线程那条 race 没有这趟往返，用整额预算。只在这里定义，不要在 race 参数式里写裸数字。 */
const ASYNC_GRACE_MS = 5_000

/** worker 侧宿主往返死线的 terminate 落地余量：死线必须**严格晚于**外层 race
 *  （预算 + `ASYNC_GRACE_MS`），否则两个计时器同时响会产生第二错源。死线由调用方预算派生，
 *  组装在 `evalJsInWorker` 的 workerData（键 `rpcDeadlineMs`）。 */
const WORKER_RPC_MARGIN_MS = 5_000

const SIMPLE_GLOBALS = scriptGlobals().map((g) => `  g.${g.name} = d.${g.key}`).join('\n')

const BOOK_KEY = scriptKeyOf('book')
const CHAPTER_KEY = scriptKeyOf('chapter')
const SOURCE_KEY = scriptKeyOf('source')
const SOURCE_NAME_KEY = scriptKeyOf('sourceName')
const SOURCE_COMMENT_KEY = scriptKeyOf('sourceComment')
const BOOK_GLOBAL = scriptGlobalOf('book')
const CHAPTER_GLOBAL = scriptGlobalOf('chapter')
const SOURCE_GLOBAL = scriptGlobalOf('source')

/**
 * 沙箱引导脚本（在 vm 上下文内执行一次）。
 *
 * `book` / `chapter` 的全局只在这里物化一次：在本串之外补一句裸赋值会把 `mkHostObj` 给它们装的宿主方法面
 * 覆盖成普通对象（`tests/engine/js-sandbox.test.ts` 钉住）。
 *
 * 逃逸防御：宿主绝不把函数/对象直接交给用户代码——唯一入口 `__host_call__` 被本闭包捕获后即从全局锁死；
 * `java`/`console` 全是 vm realm 包装函数，双向 JSON 序列化，宿主错误只取 `.message` 后以本 realm 的 Error
 * 重抛，故沿 `.constructor` 或错误对象都够不到宿主 realm。V8 会把 CallSite 交给 `Error.prepareStackTrace`，
 * worker 的 CJS 宿主帧可经 `getThis()` 取到 `require`，故该属性必须锁死。vm 不是 OS 级安全沙箱（`ADR-0004`）。
 */
const BOOTSTRAP = `;(function (g) {
  'use strict'
  const call = g.__host_call__
  const d = JSON.parse(g.__init__)
  const hide = function (k) {
    try { delete g[k] } catch (e) {}
    try { Object.defineProperty(g, k, { value: 0, writable: false, configurable: false }) } catch (e) {}
  }
  hide('__host_call__')
  hide('__init__')
  // 沙箱 realm 的 Promise 打标：宿主侧的 unhandledRejection 防线靠它区分「脚本自建的悬空 promise」
  // 与「宿主/别的插件的真错误」。打在 Promise.prototype 上，异步函数用的 intrinsic %Promise%
  // 一样继承这个标（给构造器打标会漏掉 async 函数创建的那些）。不可写不可配置；用户代码即使
  // 拿到这个 symbol，也只能给自己的 promise 打标，碰不到宿主的对象。
  // key 与 rejection-guard.ts 的 SANDBOX_REALM_MARK 必须同一个串（本串是模板，不能 import）——
  // tests/engine/unhandled-guard.test.ts 直接读本文件源码钉住两处一致。
  try {
    Object.defineProperty(Promise.prototype, Symbol.for('dsh-novel.sandbox-realm'), {
      value: true, writable: false, configurable: false,
    })
  } catch (e) {}
  // V8 格式化错误栈时会回调 realm 里的 Error.prepareStackTrace，并把 CallSite 交给它；CallSite
  // 的 getThis()/getFunction() 能取到**宿主帧**的 this/函数——worker 的 CJS 宿主帧可据此
  // 直达 require。锁成不可写、不可配置，用户脚本改不掉；默认格式化仍给出
  // 字符串栈。vm 仍是纵深防御层，不是 OS 级安全沙箱。
  try {
    Object.defineProperty(Error, 'prepareStackTrace', { value: undefined, writable: false, configurable: false })
  } catch (e) {}
  // JSON.parse 对象幂等 wrap（两形态共存的兼容口径）：对象直传 JSON.parse 会被 ToString 成
  // "[object Object]" → SyntaxError → 目录全灭（JSON 页 result 按已解析对象绑定、而 init 脚本又写
  // JSON.parse(result)）。对已解析对象先 stringify 回原文再 parse（parse 的逆，深拷贝幂等），
  // 字符串/标量走原生不变。
  const nativeJsonParse = JSON.parse
  JSON.parse = function (text, reviver) {
    return nativeJsonParse.call(this,
      (typeof text === 'object' && text !== null) ? JSON.stringify(text) : text, reviver)
  }
  const ser = function (a) { return JSON.stringify(a) }
  const msg = function (e) { return (e && e.message) ? String(e.message) : String(e) }
  // 宿主对象物化器：跨 JSON 桥只传 __host 描述符，方法壳在这里统一包。
  // 判别字段与 src/engine/host-object.ts 同步；BOOTSTRAP 是模板字符串，不能 import。
  const utf8Bytes = function (s) {
    var out = []
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i)
      // 代理对按码点编成 4 字节（逐 UTF-16 单元编会得到 CESU-8，emoji 字节与 UTF-8 不一致）
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
        var d = s.charCodeAt(i + 1)
        if (d >= 0xdc00 && d <= 0xdfff) {
          var cp = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00)
          out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63))
          i++
          continue
        }
      }
      if (c < 0x80) out.push(c)
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63))
      else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
    }
    return out
  }
  const materialize = function (v) {
    if (v === null || typeof v !== 'object' || v.__host === undefined) return v
    if (v.__host === 'map') {
      const entries = v.entries || {}
      const m = {
        get: function (k) {
          k = String(k)
          return Object.prototype.hasOwnProperty.call(entries, k) ? entries[k] : null
        },
        put: function (k, val) { entries[String(k)] = String(val); return val },
        size: function () { return Object.keys(entries).length },
        containsKey: function (k) { return Object.prototype.hasOwnProperty.call(entries, String(k)) },
        keySet: function () { return Object.keys(entries) },
        entrySet: function () {
          return Object.keys(entries).map(function (k) { return { key: k, value: entries[k] } })
        },
        toString: function () { return JSON.stringify(entries) },
        // Map 作 java.post/connect 的头参数时经 JSON 桥交给宿主；没有 toJSON 时方法全是函数，
        // JSON.stringify 得到空对象——脚本意图被静默丢掉（源会拿空头去请求）。
        toJSON: function () { return entries },
      }
      return new Proxy(m, {
        get: function (t, p) {
          if (typeof p === 'string' && !(p in t)) {
            if (Object.prototype.hasOwnProperty.call(entries, p)) return entries[p]
            if (v.caseInsensitive === true) {
              const low = p.toLowerCase()
              if (Object.prototype.hasOwnProperty.call(entries, low)) return entries[low]
            }
          }
          return t[p]
        },
      })
    }
    if (v.__host === 'response') {
      const headers = v.headers || {}
      const lower = {}
      for (const k of Object.keys(headers)) lower[String(k).toLowerCase()] = headers[k]
      const headersMap = function () { return materialize({ __host: 'map', entries: lower, caseInsensitive: true }) }
      return {
        __host: 'response',
        __data: {
          url: v.url, statusCode: v.statusCode, headers: lower, body: v.body,
          contentType: v.contentType || '', charset: v.charset || '', cookies: v.cookies || {},
        },
        statusCode: function () { return v.statusCode },
        code: function () { return v.statusCode },
        statusMessage: function () { return v.statusMessage || '' },
        header: function (n) { const k = String(n).toLowerCase(); return lower[k] === undefined ? '' : lower[k] },
        headers: function (n) {
          if (arguments.length === 0) return headersMap()
          const k = String(n).toLowerCase()
          return lower[k] === undefined ? [] : [lower[k]]
        },
        body: function () { return v.body },
        bodyAsBytes: function () { return utf8Bytes(String(v.body)) },
        charset: function () { return v.charset || '' },
        contentType: function () { return v.contentType || '' },
        url: function () { return v.url },
        cookies: function () { return materialize({ __host: 'map', entries: v.cookies || {} }) },
        toString: function () { return v.body },
      }
    }
    return v
  }
  // 宿主错误必须在**本 realm** 换成 Error 再交给脚本：宿主 Error 的 constructor.constructor
  // 是宿主 Function，脚本一旦 catch 到就能拿回 process/require（node vm 实测）。所有直接
  // call 的桥都必须走这里，不能只包 invoke —— AES/Java 类桥是直调。
  const callHost = function (name, payload) {
    try { return call(name, payload) } catch (e) { throw new Error(msg(e)) }
  }
  const invoke = function (name, a) {
    return callHost(name, ser(a))
  }
  const sync = function (name) {
    return function () { return materialize(JSON.parse(invoke(name, [].slice.call(arguments)))) }
  }
${asyncBridgeSource()}
${elemWrapperSource()}
${pkgWrapperSource()}
  const log = function (kind) {
    return function () {
      try { call(kind, ser([].slice.call(arguments))) } catch (e) {}
    }
  }
  // async 行的挂载行由协议表生成（js-protocol.asyncMountSource）——新增异步方法只该动表；
  // 不要手写挂载列表，那会把「挂上了没有」交给记性。
  g.java = {
${asyncMountSource()}
    log: log('console.log'),
    toast: function(){}, longToast: function(){}, copyText: function(){},
    startBrowser: function(){}, open: function(){}, openUrl: function(){},
    // createSymmetricCrypto：链式解密形态（java.createSymmetricCrypto(t,k,iv).decryptStr(data)）——
    // 解密实现在协议表 aesBase64DecodeToString（Node crypto），此处只做链式外壳
    createSymmetricCrypto: function (transformation, key, iv) {
      return {
        decryptStr: function (data) {
          return JSON.parse(callHost('aesBase64DecodeToString', ser([String(data), String(key), String(transformation || 'AES/CBC/PKCS5Padding'), String(iv || '')])))
        },
        decrypt: function (data) {
          return JSON.parse(callHost('aesDecryptToBytes', ser([String(data), String(key), String(transformation || 'AES/CBC/PKCS5Padding'), String(iv || '')])))
        },
        encryptStr: function () { throw new Error('java.createSymmetricCrypto().encryptStr 不支持：v1 仅实现正文解密形态') },
      }
    },
  }
  // 同步方法名单从协议表派生（js-protocol.SANDBOX_MOUNTS，经 __init__ 注入）——
  // 加一个 java 方法只改表一行（async 行另带 bridge），此处零改动；async 行不走 sync()，不在名单内
  d.mounts.javaSync.forEach(function (n) { g.java[n] = sync(n) })
  // java.get 双形态：单参 = 源变量 getter（同步名单）；双参 = HTTP GET（脚本侧 Connection.Response
  // 形状）。按**实参个数**分派：
  // java.get(url, undefined) 仍是双参 HTTP，按值判会把显式空头误当变量 getter。
  // HTTP 形态走同步 worker，主线程先抛哨兵换道——与 ajax/downloadFile 同一套同步桥。
  const getVar = g.java.get
  g.java.get = function (key, headers) {
    if (arguments.length <= 1) return getVar(key)
    return getHttp.apply(null, arguments)
  }
  // Packages.java.util.UUID.randomUUID（Packages 互操作面；输入脚本有用它生成请求 id 的形态）
  g.Packages.java.util.UUID = { randomUUID: function () { return g.java.randomUUID() } }
  // getElements/getElement 返回值包成元素包装对象（.attr/.select/.toArray 可用）——
  // 宿主侧仍按 {html,text} JSON 序列化，包装在沙箱内完成
  ;['getElements', 'getElement'].forEach(function (n) {
    const rawFn = g.java[n]
    if (typeof rawFn !== 'function') return
    g.java[n] = function () {
      const r = rawFn.apply(null, arguments)
      if (r === null || r === undefined) return null
      if (Array.isArray(r)) return wrapElems(r.map(function (o) { return String(o && o.html !== undefined ? o.html : o) }))
      return mkElem(String(r && r.html !== undefined ? r.html : r))
    }
  })
  // 宿主桩名单：只放本仓真没有对应实现的名字（书源会调、但需安卓宿主/WebView/字体栈）。
  // 只列协议表没有真实现的名字；若把已有实现的方法列进来，本循环会把它覆盖成抛错桩，
  // 协议表测试仍绿而脚本一调就报「需要安卓宿主环境」。这条边界由
  // tests/legado-coverage/bridge-surface.test.ts 的「协议表真实现没被沙箱桩覆盖」钉住。
  ;['startBrowserAwait','refreshTocUrl','ajaxAll','createAsymmetricCrypto',
    'aesBase','queryTTF','queryBase','replaceFont',
    'createSign'].forEach(function (n) {
    g.java[n] = function () { throw new Error('java.' + n + ' 不支持：需要安卓宿主环境（WebView/加密/系统服务无法仿真）') }
  })
  // 设备 ID：本仓用数据根 generation 一次的稳定 ID——不随机冒充（脚本要的是宿主级稳定的设备 ID，
  // 每次调用都变会让按设备绑定的脚本逻辑失效）
  g.java.androidId = function () {
    if (!d.deviceId) throw new Error('java.androidId 需要宿主设备 ID（ctx.deviceId 未接线）')
    return d.deviceId
  }
  g.cookie = {}
  d.mounts.cookie.forEach(function (p) { g.cookie[p.key] = sync(p.name) })
  // CookieStore.mapToCookie(Map)：Map 形（response.cookies() 的产物）→ k=v; … 串；
  // 空表回 null。纯值变换，留在 vm 内，不进协议表。
  g.cookie.mapToCookie = function (map) {
    if (map === null || map === undefined) return null
    var keys = typeof map.keySet === 'function' ? map.keySet() : Object.keys(map)
    var parts = []
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i]
      var v = typeof map.get === 'function' ? map.get(k) : map[k]
      if (v !== null && v !== undefined) parts.push(String(k) + '=' + String(v))
    }
    return parts.length === 0 ? null : parts.join('; ')
  }
  // cache（进程内键值表最小仿真——按源隔离，搜索面写、目录面读的跨面形态）
  g.cache = {}
  d.mounts.cache.forEach(function (p) { g.cache[p.key] = sync(p.name) })
  const noHost = function (name) {
    return new Proxy({}, { get: function (t, p) {
      if (p === Symbol.toPrimitive || p === 'toString' || p === 'valueOf') return function () { return name }
      throw new Error(name + ' 不支持：需要安卓宿主环境')
    } })
  }
  g.android = noHost('android.*')
  // org.jsoup.Jsoup.parse 最小仿真（输入脚本有直接 org.jsoup.Jsoup.parse(result) 再
  // .select(...) 的形态；我们以 cheerio 元素包装等价承接 parse 入口，
  // 其余 org.* 仍如实报需要安卓宿主）
  g.org = new Proxy({ jsoup: { Jsoup: { parse: function (html) { return mkElem(String(html)) } } } }, {
    get: function (t, p) {
      if (p in t) return t[p]
      if (p === Symbol.toPrimitive || p === 'toString' || p === 'valueOf') return function () { return 'org.' + String(p) }
      throw new Error('org.' + String(p) + ' 不支持：需要安卓宿主环境')
    },
  })
  // 浏览器基础全局：部分书源脚本用 atob/btoa 处理二进制串（eval 已允许，这两个补上）
  g.atob = function (s) {
    var b = sync('base64DecodeToByteArray')(String(s))
    var out = ''
    for (var i = 0; i < b.length; i++) out += String.fromCharCode(b[i])
    return out
  }
  g.btoa = function (s) {
    var str = String(s)
    var b = []
    for (var i = 0; i < str.length; i++) b.push(str.charCodeAt(i) & 255)
    return sync('base64EncodeBytes')(b)
  }
  g.console = { log: log('console.log'), error: log('console.error') }
  g.__d__ = d
  g.__src__ = { key: d.${SOURCE_KEY}, bookSourceUrl: d.${SOURCE_KEY}, bookSourceName: d.${SOURCE_NAME_KEY} || '',
    // 脚本可见的源实体字段（脚本里 source 就是书源实体）；脚本不读的字段不进投影，面窄是刻意选择
    bookSourceComment: d.${SOURCE_COMMENT_KEY} || '', loginUrl: '',
    header: d.header || '{}',
    getKey: function () { return d.${SOURCE_KEY} },
    // 登录面投影：服务层供出 loginInfo；未接线时空。形状按 Map / String 给，
    // 让脚本的 info.get(...) / source.getLoginHeader() 不再因 TypeError 整段炸。
    getLoginHeader: function () { return d.loginHeader || '' },
    getLoginInfoMap: function () { return materialize({ __host: 'map', entries: d.loginInfo || {} }) },
    toString: function () { return d.${SOURCE_KEY} }, valueOf: function () { return d.${SOURCE_KEY} } }
  // 源变量垫片方法（getVariable/setVariable/get/put）同样从协议表派生
  d.mounts.source.forEach(function (p) { g.__src__[p.key] = sync(p.name) })
  g.result = d.resultHost !== null && d.resultHost !== undefined
    ? materialize(d.resultHost)
    : d.resultMap !== null && d.resultMap !== undefined
      ? materialize({ __host: 'map', entries: d.resultMap })
      : d.resultJson
    // JSON 页/条目：result 按解析后的对象绑定（字段访问形态）
    ? (function () { try { return JSON.parse(d.resultJson) } catch (e) { return d.result } })()
    : (d.resultKind === 'nodes' && d.resultCtx === 'list')
      // 列表路径：result 是**元素集合**——forEach/length/下标/size/get 全能用
      ? wrapElems(elemOps('split', { html: d.result }))
      : (d.resultKind === 'nodes' || (d.resultKind === 'page' && /<[a-zA-Z]/.test(d.result)))
        ? g.__mkElem__(d.result)
        : d.result
  // 函数体形态（代码里有顶层 return/await）的 result 首参取的是 __d__.result 原始串；loginCheckJs
  // 的 result 是响应对象，两种形态必须同值——故把原始串换回物化后的 host（脚本形态本来就看 g.result）。
  if ((d.resultHost !== null && d.resultHost !== undefined) || (d.resultMap !== null && d.resultMap !== undefined)) d.result = g.result
  // book/chapter 是服务层按面注入的**镜像**，这里补齐脚本要调的方法面（setType/getVariable 等）：
  // type 落回镜像自身字段（本次调用内可读，落库不在本层职责）；variable 用镜像自带的局部表，
  // 不与源级变量表混用——book 级与 source 级是两个存储，合并会把用户级开关串味。本仓没有 Book 级
  // 持久变量存储，跨一次规则调用不保留（取不到即空串走默认分支，与「从未设置」同形）。
  const mkHostObj = function (o) {
    const t = o && typeof o === 'object' ? o : {}
    const own = Object.create(null)
    t.getVariable = function (k) { const v = own[String(k)]; return v === undefined ? '' : v }
    t.putVariable = function (k, v) { own[String(k)] = String(v); return v }
    t.removeVariable = function (k) { delete own[String(k)] }
    t.getType = function () { return t.type === undefined ? 0 : t.type }
    t.setType = function (n) { t.type = n }
    t.getName = function () { return String(t.name ?? t.title ?? '') }
    t.getBookUrl = function () { return String(t.bookUrl ?? '') }
    t.getOrigin = function () { return String(t.origin ?? t.baseUrl ?? d.${SOURCE_KEY}) }
    // chapter.isVip()/isVolume()/isPay()（目录 ruleToc 标记折出的实体字段；非章节实体不挂也不冒充）
    if (t.vip !== undefined) t.isVip = function () { return t.vip === true }
    if (t.volume !== undefined) t.isVolume = function () { return t.volume === true }
    if (t.pay !== undefined) t.isPay = function () { return t.pay === true }
    return t
  }
  g.${BOOK_GLOBAL} = mkHostObj(d.${BOOK_KEY})
  g.${CHAPTER_GLOBAL} = mkHostObj(d.${CHAPTER_KEY})
${SIMPLE_GLOBALS}
  g.${SOURCE_GLOBAL} = g.__src__
  g.key = d.key
  g.page = d.page
})(globalThis)`

/**
 * 在 node:vm 受限上下文中执行用户 JS 片段（`js:` 前缀段 / `<js>…</js>` 内联段；切法见 parse.ts 的 `parseBranch`）。
 * - codeGeneration:{strings:true,wasm:false}：eval / Function 在 vm 内可用，但宿主入口 `__host_call__` 与宿主帧
 *   通道已锁；vm 是纵深防御层（矩阵 h-sandbox-escape-defense）。
 * - wrapper 为 async IIFE：顶层 `await` 可用；vm timeout 杀同步死循环，异步总时长由外层 Promise.race 硬超时约束。
 * - 返回值映射：string→Value；array→List；null/undefined/''→Miss；对象→JSON.stringify 的 Value。
 * - `console.log/error` 收进 logs；`java.ajax` 语义唯一（同步返回 body，主线程撞哨兵即换 worker）。
 * - 结束统一 flush 源状态：同一段脚本内的多次 set 合并为一次写入；落盘失败不打断求值。
 */
export async function evalJs(call: JsCall): Promise<JsOutcome> {
  try {
    return await evalJsCore(call)
  } finally {
    ;(call.opts?.session ?? call.ctx.session)?.flush?.()
  }
}

async function evalJsCore(call: JsCall): Promise<JsOutcome> {
  const { code, host, ctx, loc, facet, evaluateRef, opts } = call
  const logs: string[] = []
  const timeout = Math.max(1, ctx.jsTimeoutMs ?? DEFAULT_JS_TIMEOUT_MS)
  // 兜底挂防线：组合根已挂真 sink 时为空操作；离线直用引擎时由它保底。
  acquireRejectionGuard()
  const session = opts?.session ?? ctx.session ?? processSession
  // 变量读链的 source 层用 peek（非建档）而不是 sourceVars()——后者一调就建表，会改掉「从未设置」的语义。
  if (ctx.sourceVar === undefined) {
    const varKey = ctx.source ?? ctx.baseUrl ?? ''
    ctx.sourceVar = (k: string): string | undefined => session.peekSourceVars(varKey)?.get(k)
  }
  const deps: BridgeDeps = {
    ctx,
    code,
    loc,
    facet,
    result: host.result,
    session,
    sourceKey: ctx.source ?? ctx.baseUrl ?? '',
    evaluateRef,
    contentBase: null,
  }
  const hostCall = makeHostCall(deps, logs, host.console)
  // java.ajax 同步语义路由：命中 SYNC_WORKER_RE 即整段进 worker（SAB RPC 同步阻塞拿 body），无 ajax 的
  // 脚本走主线程 vm。**正则只是性能启发，不是语义开关**——认不出的等价写法由哨兵兜回 worker，语义一致。
  const jsLibCode = await resolveJsLib(ctx.jsLib, ctx, loc, facet)
  const useWorker = SYNC_WORKER_RE.test(jsLibCode + '\n' + code)
  // JSON 页/条目：上下文是合法 JSON 时按**解析后的对象**绑定 result——`result.data.list` 这类字段访问全靠它。
  const pageRaw = host.result
  const trimmedResult = pageRaw.trim()
  const resultJson = host.resultKind === 'page'
    && ((trimmedResult.startsWith('{') && trimmedResult.endsWith('}')) || (trimmedResult.startsWith('[') && trimmedResult.endsWith(']')))
    ? pageRaw : ''
  // init 按 syncAjax 参数化：哨兵路线让 worker 重跑时必须拿 syncAjax:true 那一份，复用主线程的 init 会让
  // worker 里的 ajax 包装再抛一次哨兵。
  const initOf = (syncAjax: boolean): string => JSON.stringify({
    ...scriptInitOf(ctx),
    result: pageRaw, resultKind: host.resultKind ?? '', resultJson,
    resultHost: host.resultHost ?? null,
    resultMap: host.resultMap ?? null,
    resultCtx: host.resultCtx ?? 'value',
    key: host.key ?? '', page: host.page ?? 1, header: host.header ?? '{}',
    syncAjax,
    // 沙箱挂载清单从协议表派生（见 js-protocol.SANDBOX_MOUNTS）
    mounts: SANDBOX_MOUNTS,
  })
  const init = initOf(useWorker)
  // wrapped 文本在这里一次构造，主线程与 worker 共用：在 WORKER_SRC 里再拼一遍等于养第二份。
  const wrapped = wrappedFormOf(code)
  if (useWorker) {
    return evalJsInWorker({
      bootstrap: BOOTSTRAP, init, code, wrapped, jsLib: jsLibCode, timeout,
      scriptForm: opts?.scriptForm ?? DEFAULT_SCRIPT_FORM, call: hostCall, logs, loc, facet,
    })
  }
  // 整段包一层哨兵捕获：BOOTSTRAP init / jsLib / 同步执行 / await 到的完成值四处都可能冒哨兵。
  try {
    let started: unknown
    try {
      // 求值序列（createContext → bootstrap → jsLib → started）收在共享体里，worker 经 toString() 注入同一份
      // ——两份实现 = 两套语义。
      started = runInContextVm(vm, {
        hostCall,
        bootstrap: BOOTSTRAP,
        init,
        jsLib: jsLibCode,
        code,
        wrapped,
        timeout,
        scriptForm: opts?.scriptForm ?? DEFAULT_SCRIPT_FORM,
      })
    } catch (e) {
      const t = e as { phase?: string; timedOut?: boolean }
      if (t.timedOut === true) throw jsTimeoutErr(timeout, code, loc, facet)
      throw jsErr(e, code, loc, facet, prefixOfPhase(t.phase))
    }

    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const ret = await Promise.race([
        started,
        new Promise<never>((_, reject) => {
          // 主线程这条 race 用**整额预算**、不加宽限：await 全在本 realm 推进，没有「等主线程替 worker 服务宿主
          // 调用」那趟往返；worker 那条才加 `ASYNC_GRACE_MS`。
          timer = setTimeout(() => reject(TIMEOUT), timeout)
          timer.unref()
        }),
      ])
      return { value: toEngineValue(ret), logs }
    } catch (e) {
      if (e === TIMEOUT || isVmTimeout(e)) throw jsTimeoutErr(timeout, code, loc, facet)
      if (e instanceof JsSandboxError) throw e
      throw jsErr(e, code, loc, facet, prefixOfPhase(undefined))
    } finally {
      if (timer) clearTimeout(timer)
      // unhandledRejection 防线常驻，不在此摘除（见 rejection-guard.ts）
    }
  } catch (e) {
    if (!needsSyncBridge(e)) throw e
    // 别名写法调 ajax（java["ajax"] / 解构 / 动态键）：主线程给不出同步语义，换 worker 重跑；日志已产生的丢弃。
    logs.length = 0
    return evalJsInWorker({
      bootstrap: BOOTSTRAP, init: initOf(true), code, wrapped, jsLib: jsLibCode, timeout,
      scriptForm: opts?.scriptForm ?? DEFAULT_SCRIPT_FORM, call: hostCall, logs, loc, facet,
    })
  }
}

/** A-a 共享求值体：createContext → bootstrap → jsLib → started（脚本/函数体两形态）。主线程直调；worker 经
 *  `toString()` 注入——两份实现 = 两套语义，故只留一份。**闭包自由是硬约束**：引用任何模块级符号
 *  （wrappedFormOf / jsErr / …）在 worker 里就是 ReferenceError（有钉子守住）。**export 明写为测试缝**。
 *  错误约定：bootstrap / jsLib / compile 三段 catch 挂 `phase` 与 `timedOut` 后 rethrow **原错误**；异步完成
 *  值抛错不打标。前缀映射住主线程侧（`prefixOfPhase`）。返回 `started` 不 await。
 *  **非严格模式（钉死）**：书源脚本按 sloppy 语义执行，`next = []` 这类未声明赋值就是写全局（读数住矩阵行
 *  `h-rhino-vs-vm`）。逃逸防御不靠严格模式，边界是 vm realm 隔离 + 宿主入口锁死。 */
export function runInContextVm(
  vmMod: typeof vm,
  deps: {
    hostCall: (name: string, argsJson: string) => string | Promise<string>
    bootstrap: string
    init: string
    jsLib: string
    code: string
    wrapped: string
    timeout: number
    scriptForm: boolean
  },
): unknown {
  // 本函数经 toString() 注入 worker（闭包自由）：串化只能就地定义，不许引用模块级符号。
  const asText = (v: unknown): string => String(v)
  const tag = (e: unknown, phase: 'bootstrap' | 'jsLib' | 'compile'): unknown => {
    if (e !== null && typeof e === 'object') {
      const t = e as { phase?: string; timedOut?: boolean }
      // 冻结/不可扩展的抛错对象在严格模式下赋值会抛 TypeError，那会盖掉原错误——打标失败就放弃标记
      try {
        t.phase = phase
        t.timedOut = /Script execution timed out/i.test(asText((e as { message?: unknown }).message ?? e))
      } catch { /* 打标只是旁注，原错误照原样 rethrow */ }
    }
    return e
  }
  const context = vmMod.createContext(
    { __host_call__: deps.hostCall, __init__: deps.init },
    { codeGeneration: { strings: true, wasm: false } },
  )

  try {
    vmMod.runInContext(deps.bootstrap, context, { timeout: deps.timeout })
  } catch (e) {
    throw tag(e, 'bootstrap')
  }

  // jsLib（源级全局函数库）：先于用户代码在同一上下文执行，函数定义落全局供用户 @js 直调。抛错如实上报
  // （jsLib 坏了整源的 js 都不可信）；两条路必须用同一份**已解析**文本。
  if (deps.jsLib.trim() !== '') {
    try {
      vmMod.runInContext(deps.jsLib, context, { timeout: deps.timeout })
    } catch (e) {
      throw tag(e, 'jsLib')
    }
  }

  // key/page/result/baseUrl/source/src/book/chapter 已由 bootstrap 注入为全局——wrapper 不再声明同名参数
  // （`let page = java.get("page")` 的重声明会撞 Identifier already declared）。
  let started: unknown
  try {
    if (deps.scriptForm) {
      // 脚本形态：完成值即结果；**编译期** SyntaxError（顶层 return/await）回落函数体形态。判别必须在编译期
      // （new Script 只编译不执行）：按运行时异常类名判会把运行时 SyntaxError 误当顶层 return，表达式脚本
      // 恒 Miss。跨 realm `instanceof SyntaxError` 不成立，按 constructor.name 判定。
      let asScript = true
      try {
        new vmMod.Script(deps.code)
      } catch (e) {
        if ((e as { constructor?: { name?: string } }).constructor?.name !== 'SyntaxError') throw e
        asScript = false
      }
      started = vmMod.runInContext(asScript ? deps.code : deps.wrapped, context, { timeout: deps.timeout })
    } else {
      started = vmMod.runInContext(deps.wrapped, context, { timeout: deps.timeout })
    }
  } catch (e) {
    throw tag(e, 'compile')
  }
  return started
}

/** 函数体形态（wrapped）文本：把用户代码包进 async IIFE，`return` 有处可去。主线程与 worker 共用。 */
function wrappedFormOf(code: string): string {
  return `;(async function (result, baseUrl, source, java, cookie, console) {\n${code}\n}).apply(undefined, [__d__.result, __d__.baseUrl, __src__, java, cookie, console])`
}

// ── java.ajax 同步桥（worker + SharedArrayBuffer RPC）────────────────────
//
// `java.ajax` 的语义是同步返回响应 body；Node 主线程 vm 无法阻塞 await，语义由桥给（worker 同步返回 /
// 主线程抛哨兵），不由正则给。两条路：① SYNC_WORKER_RE 认出 ajax 形态 → 直接路由进 worker；
// ② 认不出的等价写法撞哨兵 → 换 worker 重跑（请求没发出去，不多打站点）。worker 里 __host_call__ 把
// (name, argsJson) 写进请求 SAB 后 Atomics.wait 阻塞，主线程经 message 唤醒后异步服务，响应回写 + notify；
// SAB 上只有 JSON 字符串。超时双闸：worker 内 vm timeout 杀同步死循环，主线程 race 后 terminate。
// worker 代码以字符串交付（打包后无独立文件可解析），BOOTSTRAP/init/code/wrapped 全走 workerData。

// 路由谓词住协议表（js-protocol 的 `SYNC_WORKER_RE`）——此处只消费，不养第二份手写正则（见 ADR-0005）。
const SAB_REQ_BYTES = 4 * 1024 * 1024
const SAB_RESP_BYTES = 16 * 1024 * 1024

/** 完成值过界前的清洗（唯一实现）：null/undefined→null、String 对象→原文、function→String、object→JSON 兜底。
 *  **闭包自由**——与 runInContextVm 同款经 toString() 注入 worker。 */
export function sanitizeForPost(v: unknown): unknown {
  // 原值留一份 unknown 形 alias：下面把 v 收窄成对象后，兜底串化仍按**过线原值**口径走（循环引用 / 含
  // BigInt 的对象过不去 JSON，回退 String(original)）。
  const original: unknown = v
  if (v === null || v === undefined) return null
  const t = Object.prototype.toString.call(v)
  if (t === '[object String]') return String(original)
  if (typeof v === 'function') return String(original)
  if (typeof v === 'object') {
    try { return JSON.parse(JSON.stringify(v)) } catch { return String(original) }
  }
  return v
}

const WORKER_SRC = `
const { parentPort, workerData } = require('node:worker_threads')
const vm = require('node:vm')
const { bootstrap, init, code, wrapped, jsLib, timeout, scriptForm } = workerData
const reqSab = workerData.reqSab, respSab = workerData.respSab
const reqFlag = new Int32Array(workerData.reqFlagSab)
const respFlag = new Int32Array(workerData.respFlagSab)
const reqView = new Uint8Array(reqSab), respView = new Uint8Array(respSab)
const td = new TextDecoder(), te = new TextEncoder()
function hostCall(name, argsJson) {
  const payload = te.encode(JSON.stringify([name, argsJson]))
  if (payload.length + 4 > reqView.length) throw new Error('宿主调用参数超限（' + payload.length + ' 字节）')
  new DataView(reqSab).setInt32(0, payload.length, true)
  reqView.set(payload, 4)
  Atomics.store(reqFlag, 0, 1)
  parentPort.postMessage({ rpc: true })   // 唤醒主线程来服务（数据走 SAB，消息只做信号）
  Atomics.notify(reqFlag, 0)
  const deadline = Date.now() + workerData.rpcDeadlineMs
  while (Atomics.load(respFlag, 0) === 0) {
    if (Date.now() > deadline) throw new Error('宿主调用等待超时（' + Math.round(workerData.rpcDeadlineMs / 1000) + 's）')
    Atomics.wait(respFlag, 0, 0, 1000)
  }
  const len = new DataView(respSab).getInt32(0, true)
  const json = td.decode(respView.subarray(4, 4 + len))
  Atomics.store(respFlag, 0, 0)
  const parsed = JSON.parse(json)
  if (parsed !== null && typeof parsed === 'object' && parsed.__error) throw new Error(String(parsed.__error))
  return json
}
// 求值序列与主线程是**同一份实现**（runInContextVm / sanitizeForPost 闭包自由，宿主侧 toString()
// 注入——不再有 runAsScript / sanitize 的文本抄本）。错误的 phase / timedOut 标记由共享体打好，
// postFail 随 message/stack 一起带出边界，前缀映射住主线程 prefixOfPhase（两路同一张表）。
const runInContextVm = ${runInContextVm.toString()}
const sanitizeForPost = ${sanitizeForPost.toString()}
function postFail(e) {
  parentPort.postMessage({
    ok: false,
    message: e && e.message ? String(e.message) : String(e),
    stack: e && e.stack ? String(e.stack) : '',
    phase: e && e.phase,
    timedOut: e && e.timedOut,
  })
}
try {
  const started = runInContextVm(vm, { hostCall, bootstrap, init, jsLib, code, wrapped, timeout, scriptForm })
  Promise.resolve(started).then(
    function (ret) { parentPort.postMessage({ ok: true, ret: sanitizeForPost(ret) }) },
    function (e) { postFail(e) })
} catch (e) { postFail(e) }
`

interface WorkerRunArgs {
  bootstrap: string
  init: string
  code: string
  /** 函数体形态文本（wrappedFormOf 的产物）：主线程一次构造，worker 不在字符串里再拼一份 */
  wrapped: string
  jsLib: string
  timeout: number
  scriptForm: boolean
  call: (name: string, argsJson: string) => string | Promise<string>
  logs: string[]
  loc: SegmentLoc
  facet: Facet
}

async function evalJsInWorker(a: WorkerRunArgs): Promise<JsOutcome> {
  const { Worker } = await import('node:worker_threads')
  const reqSab = new SharedArrayBuffer(SAB_REQ_BYTES)
  const respSab = new SharedArrayBuffer(SAB_RESP_BYTES)
  const reqFlagSab = new SharedArrayBuffer(4)
  const respFlagSab = new SharedArrayBuffer(4)
  const respFlagArr = new Int32Array(respFlagSab)
  const worker = new Worker(WORKER_SRC, {
    eval: true,
    workerData: {
      bootstrap: a.bootstrap, init: a.init, code: a.code, wrapped: a.wrapped, jsLib: a.jsLib,
      timeout: a.timeout, scriptForm: a.scriptForm,
      // worker 侧死线必须严格晚于外层 race（timeout + ASYNC_GRACE_MS）才不产生第二错源
      rpcDeadlineMs: a.timeout + ASYNC_GRACE_MS + WORKER_RPC_MARGIN_MS,
      reqSab, respSab, reqFlagSab, respFlagSab,
    },
  })
  const serviceRpc = async (): Promise<void> => {
    let out: string
    try {
      // 帧解析也在 try 内：畸形帧必须以 {__error} 回包让 worker 从 Atomics.wait 醒来——否则会变成
      // unhandled rejection，worker 挂到外层 race 才被 terminate。
      const len = new DataView(reqSab).getInt32(0, true)
      const [name, argsJson] = JSON.parse(new TextDecoder().decode(new Uint8Array(reqSab).subarray(4, 4 + len))) as [string, string]
      const r = await a.call(name, argsJson)
      out = typeof r === 'string' ? r : JSON.stringify(r)
    } catch (e) {
      out = JSON.stringify({ __error: e instanceof Error ? e.message : String(e) })
    }
    let payload = new TextEncoder().encode(out)
    if (payload.length + 4 > SAB_RESP_BYTES) {
      payload = new TextEncoder().encode(JSON.stringify({ __error: `宿主响应超限（${payload.length} 字节）` }))
    }
    new DataView(respSab).setInt32(0, payload.length, true)
    new Uint8Array(respSab).set(payload, 4)
    Atomics.store(respFlagArr, 0, 1)
    Atomics.notify(respFlagArr, 0)
  }
  try {
    const result = await new Promise<{ ok: boolean; ret?: unknown; message?: string; stack?: string; phase?: string; timedOut?: boolean }>((resolve, reject) => {
      const timer = setTimeout(() => reject(TIMEOUT), a.timeout + ASYNC_GRACE_MS)
      timer.unref()
      worker.on('message', (m: { ok: boolean; ret?: unknown; message?: string; stack?: string; phase?: string; timedOut?: boolean; rpc?: boolean }) => {
        if (m.rpc === true) { void serviceRpc(); return }
        clearTimeout(timer)
        resolve(m)
      })
      // worker 边界不做 Error 归一：脚本 realm 里 `throw` 的任何值都原样进这个事件。过界前走 `jsErr` 唯一转换口
      // ——就地包新 Error 会把脚本自己的那一行洗成宿主帧。
      worker.on('error', (e: unknown) => { clearTimeout(timer); reject(jsErr(e, a.code, a.loc, a.facet, prefixOfPhase(undefined))) })
      worker.on('exit', (code) => { clearTimeout(timer); reject(new Error(`js worker 提前退出（code ${code}）`)) })
    })
    if (!result.ok) {
      // 超时：优先共享体打的 timedOut 标（bootstrap/jsLib/compile 三段同步超时），无标再按
      // message 正则兜底（超时 code 留在对端 realm，只有 message 过得来）。两路必须报同一种错。
      if (result.timedOut ?? /Script execution timed out/i.test(result.message ?? '')) {
        throw jsTimeoutErr(a.timeout, a.code, a.loc, a.facet)
      }
      // 前缀按共享体的 phase 标从同一张表选——无标（异步完成值抛错）落「脚本执行抛错」。
      throw jsErr({ message: result.message, stack: result.stack }, a.code, a.loc, a.facet, prefixOfPhase(result.phase))
    }
    return { value: toEngineValue(result.ret), logs: a.logs }
  } catch (e) {
    if (e === TIMEOUT) throw jsTimeoutErr(a.timeout, a.code, a.loc, a.facet)
    if (e instanceof JsSandboxError) throw e
    throw jsErr(e, a.code, a.loc, a.facet, prefixOfPhase(undefined))
  } finally {
    void worker.terminate()
  }
}

function toEngineValue(ret: unknown): EngineValue {
  if (ret === null || ret === undefined || ret === '') return { kind: 'miss', detail: 'js 返回空' }
  // 元素包装对象（String 对象——脚本 `return result` 形态）按原文产出，不走 JSON.stringify 加引号
  if (Object.prototype.toString.call(ret) === '[object String]') {
    const s = textOf(ret)
    return s === '' ? { kind: 'miss', detail: 'js 返回空' } : { kind: 'value', text: s }
  }
  if (Array.isArray(ret)) return { kind: 'list', items: ret.map(serializeJsElement) }
  if (typeof ret === 'object') return { kind: 'value', text: JSON.stringify(ret) }
  return { kind: 'value', text: textOf(ret) }
}

/** js 数组产物的元素字符串化：字符串原样；带 html 字段的元素取 inner html；其余对象
 *  JSON.stringify（与 jsonpath 元素口径一致，后继 `$.x` 规则能对条目 JSON 求值） */
function serializeJsElement(x: unknown): string {
  if (typeof x === 'string') return x
  if (Object.prototype.toString.call(x) === '[object String]') return textOf(x)
  if (x !== null && typeof x === 'object') {
    const html = (x as { html?: unknown }).html
    if (typeof html === 'string') return html
    return JSON.stringify(x)
  }
  return textOf(x)
}

/** 协议响应恒为 JSON 串：`JSON.stringify` 类型面声明返回 string，但 undefined / function / symbol 实参运行期
 *  返回 undefined——桥必须回一条脚本能 JSON.parse 的串，故兜底 'null'。 */
function jsonText(v: unknown): string {
  const text: unknown = JSON.stringify(v)
  return typeof text === 'string' ? text : 'null'
}

/** 引导层载荷（`__elem.*` / `__pkg.*` 的实参）：BOOTSTRAP 恒送 JSON 对象，非对象按空载荷走。 */
function wireRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {}
}

/** 宿主侧唯一入口：与引导层约定 (name, argsJson) → JSON 字符串（ajax 为 Promise<string>）。方法分派查
 *  协议表，无逐案 switch；console.* 是日志通道、不属 java 协议，在此特判。 */
function makeHostCall(
  deps: BridgeDeps,
  logs: string[],
  hostConsole?: JsHost['console'],
): (name: string, argsJson: string) => string | Promise<string> {
  return (name: string, argsJson: string): string | Promise<string> => {
    if (name === 'console.log' || name === 'console.error') {
      const parsed: unknown = JSON.parse(argsJson)
      const arr: unknown[] = Array.isArray(parsed) ? parsed : [parsed]
      logs.push(arr.join(' '))
      if (name === 'console.log') hostConsole?.log(...arr)
      else hostConsole?.error(...arr)
      return 'null'
    }
    // 元素包装对象的宿主侧求值（__elem.*）：cheerio 在宿主 realm 求值，返回纯 JSON。不进协议表——它是
    // 沙箱包装对象的内部桥、不是 java.* 面，与 console.* 同为特判通道
    if (name.startsWith('__elem.')) {
      const payload: unknown = JSON.parse(argsJson)
      return jsonText(elemHostOp(name.slice('__elem.'.length), wireRecord(payload)))
    }
    // Packages.* 的宿主重活（__pkg.*）：PNG 解码 / AES-CBC / HMAC / 字节→串——它是 Packages 包路径面、
    // 不是 java.* 方法，故不进协议表，返回纯 JSON
    if (name.startsWith('__pkg.')) {
      const payload: unknown = JSON.parse(argsJson)
      return jsonText(pkgHostOp(name.slice('__pkg.'.length), wireRecord(payload), deps.ctx))
    }
    const parsed: unknown = JSON.parse(argsJson)
    const args: unknown[] = Array.isArray(parsed) ? parsed : [parsed]
    const out = invokeJavaMethod(deps, name, args)
    if (out instanceof Promise) return out.then(jsonText)
    return jsonText(out)
  }
}

/** cookie 垫片存储：按源隔离的脚本键值表。它**不是**请求层的 CookieJar——域/路径/过期匹配归
 *  `services/cookies.ts`。存储本体归 SourceSession，这里只是进程级缺省实例的后仓。 */
const COOKIE_JARS = new Map<string, Map<string, string>>()

/** 源级状态的四张进程级表：COOKIE_JARS、SOURCE_VARS（source.put/get）、SOURCE_STRINGS（setVariable 的单串槽）、
 *  CACHE_STORES（cache 垫片）。四者必须分开——合并会让 setVariable 顺手 clear() 整表。生产组合根注入
 *  `services/source-session.ts` 的 `FileSourceSession`（矩阵 `h-source-variable-persistence`）。 */
const SOURCE_VARS = new Map<string, Map<string, string>>()

const SOURCE_STRINGS = new Map<string, string>()
const CACHE_STORES = new Map<string, Map<string, string>>()

function keyedStore(get: () => Map<string, Map<string, string>>): (sourceKey: string) => Map<string, string> {
  return (sourceKey: string): Map<string, string> => {
    const all = get()
    let m = all.get(sourceKey)
    if (m === undefined) { m = new Map(); all.set(sourceKey, m) }
    return m
  }
}

/** 表的会话装配（进程级与隔离实例只差在取哪一组 Map） */
function sessionOf(
  jars: Map<string, Map<string, string>>,
  vars: Map<string, Map<string, string>>,
  strings: Map<string, string>,
  caches: Map<string, Map<string, string>>,
): SourceSession {
  return {
    cookieJar: keyedStore(() => jars),
    sourceVars: keyedStore(() => vars),
    peekSourceVars: (sourceKey) => vars.get(sourceKey),
    sourceString: (sourceKey) => strings.get(sourceKey) ?? '',
    setSourceString: (sourceKey, value) => {
      // setVariable(null) 即删除（清空即回「从未设置」），不是存 "null"
      if (value === null) strings.delete(sourceKey)
      else strings.set(sourceKey, value)
    },
    cacheStore: keyedStore(() => caches),
  }
}

/** 进程级缺省会话（生产） */
export const processSession: SourceSession = sessionOf(COOKIE_JARS, SOURCE_VARS, SOURCE_STRINGS, CACHE_STORES)

/** 全新隔离会话（测试）：与进程级实例、与其他隔离实例互不可见 */
export function createSourceSession(): SourceSession {
  return sessionOf(
    new Map<string, Map<string, string>>(), new Map<string, Map<string, string>>(),
    new Map<string, string>(), new Map<string, Map<string, string>>(),
  )
}

function jsErr(e: unknown, code: string, loc: SegmentLoc, facet: Facet, prefix: string): JsSandboxError {
  const msg = messageOf(e)
  const frame = e !== null && typeof e === 'object' ? (e as { stack?: unknown }).stack : undefined
  const line = parseLineFromStack(typeof frame === 'string' ? frame : '')
  // 行号缺席就整键不建（errors.ts 按「有没有这个键」决定消息里带不带「第 N 行」；`line ?` 对 undefined
  // 与缺席同判）
  return new JsSandboxError(`${prefix}：${msg}`, { ...loc, facet, script: code, ...(line === undefined ? {} : { line }) })
}

/** 共享体错误标 → 错误前缀（两处共读一份）。只有「脚本超时」进 `tests/content-audit-classify.ts` 的
 *  `CODE_ANCHORS`。 */
function prefixOfPhase(phase: string | undefined): string {
  if (phase === 'bootstrap') return '沙箱初始化失败'
  if (phase === 'jsLib') return 'jsLib 执行失败'
  if (phase === 'compile') return '脚本编译/同步执行失败'
  return '脚本执行抛错'
}

function jsTimeoutErr(timeout: number, code: string, loc: SegmentLoc, facet: Facet): JsSandboxError {
  return new JsSandboxError(`脚本超时（>${timeout}ms）`, { ...loc, facet, script: code })
}

function isVmTimeout(e: unknown): boolean {
  return (e as NodeJS.ErrnoException | undefined)?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT'
}

/** 主线程那臂的哨兵值住 js-protocol（抛它的那几段由 `asyncBridgeSource` 生成），这里只认它。内层 catch
 *  会把它包成 JsSandboxError，但 jsErr 是 `${prefix}：${msg}` 拼接、原文仍在 message 里，故按子串判定。 */
function needsSyncBridge(e: unknown): boolean {
  const message = e !== null && typeof e === 'object' ? (e as { message?: unknown }).message : undefined
  return textOf(message ?? '').includes(SYNC_AJAX_SENTINEL)
}

function parseLineFromStack(stack: string): number | undefined {
  // wrapper 首行偏移 1：从 <anonymous>:N:M 提取 N
  const withCol = stack.match(/<anonymous>:(\d+):\d+/)
  if (withCol) return Math.max(1, Number(withCol[1]) - 1)
  const noCol = stack.match(/<anonymous>:(\d+)\b/)
  if (noCol) return Math.max(1, Number(noCol[1]) - 1)
  // 无行号信息 → undefined。不要兜底成 1：那会**谎报「第 1 行」**（errors 侧 `loc.line ?` 据此省略）。
  return undefined
}

// ── jsLib 两形态（裸文本 / URL 字典）───────────────────────────────
// 裸 JS 文本，或 `{"名字":"https://…/x.js"}` URL 字典（下载后按 URL 原文缓存）。解析发生在 evalJs 顶部
// ——SYNC_WORKER_RE 因此能看到下载后的库代码，库含 java.ajax 的源才会被送进 worker。
const JSLIB_URL_CACHE_MAX = 32
const jsLibUrlCache = new Map<string, string>()

/** 值是 URL 字典才返回清单；否则 null（裸 JS 文本里 `{` 开头的对象字面量不当字典解析） */
function jsLibUrlDict(jsLib: string): string[] | null {
  if (!jsLib.trim().startsWith('{')) return null
  let obj: unknown
  try { obj = JSON.parse(jsLib) } catch { return null }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return null
  const values = Object.values(obj as Record<string, unknown>)
  if (values.length === 0 || !values.every((v) => typeof v === 'string' && /^https?:\/\//i.test(v))) return null
  return values as string[]
}

async function resolveJsLib(
  jsLib: string | undefined, ctx: EvalContext, loc: SegmentLoc, facet: Facet,
): Promise<string> {
  if (jsLib === undefined || jsLib.trim() === '') return ''
  const urls = jsLibUrlDict(jsLib)
  if (urls === null) return jsLib
  if (ctx.fetch === undefined) {
    throw new JsSandboxError('jsLib 是 URL 字典但本源未提供网络能力（ctx.fetch 缺失）', { ...loc, facet, script: jsLib.slice(0, 200) })
  }
  const parts: string[] = []
  for (const url of urls) {
    let body = jsLibUrlCache.get(url)
    if (body === undefined) {
      try {
        body = (await ctx.fetch(url)).body
      } catch (e) {
        // 下载失败如实抛：少一层库会让后面的脚本报「xxx is not a function」，把库缺失伪装成脚本错误
        throw new JsSandboxError(`jsLib 下载失败：${url}（${e instanceof Error ? e.message : String(e)}）`, { ...loc, facet, script: jsLib.slice(0, 200) })
      }
      if (jsLibUrlCache.size >= JSLIB_URL_CACHE_MAX) jsLibUrlCache.delete(jsLibUrlCache.keys().next().value as string)
      jsLibUrlCache.set(url, body)
    }
    parts.push(body)
  }
  return parts.join('\n')
}
