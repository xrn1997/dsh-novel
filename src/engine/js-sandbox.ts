import vm from 'node:vm'
import crypto from 'node:crypto'
import { isTag } from 'domhandler'
import type { Element } from 'domhandler'
import { DEFAULT_JS_TIMEOUT_MS } from './types.js'
import type { EngineValue, EvalContext, Facet, SegmentLoc } from './types.js'
import { JsSandboxError } from './errors.js'
import { SANDBOX_MOUNTS, invokeJavaMethod } from './js-protocol.js'
import type { BridgeDeps } from './js-protocol.js'
import { loadHtml, nodeText } from './dom.js'
import { decodePngToArgb, javaDecode } from './js-utils.js'

/** JavaBridge 协议的唯一登记点在 js-protocol.ts 的 JAVA_PROTOCOL 表；此处只 re-export 类型。
 *  设计文档：docs/design/engine.md */
export type { JavaBridge } from './js-protocol.js'

/** 沙箱宿主注入面。（曾设 `java?: JavaBridge` 覆盖点，全仓零生产者的假 seam，已删除：桥始终由
 *  evalJs 内部按协议表构造。） */
export interface JsHost {
  /** 上一段结果序列化（Value.text / List.items.join('\n') / 页面原文） */
  result: string
  /** 上一段结果的值形态（nodes/page 时沙箱把 result 包成元素包装对象——`result.attr()` 等形态） */
  resultKind?: string
  /** 上一段结果所在的**路径**（列表取元素 / 取值取字符串）：list → 节点结果绑成元素**集合**
   *  （`forEach`/`length`/下标），value → 仍是字符串对象 */
  resultCtx?: 'list' | 'value'
  baseUrl: string
  source: string
  /** searchUrl @js 形态：搜索关键词与页码（沙箱全局变量 key/page） */
  key?: string
  page?: number
  /** 源静态 header 的 JSON 串（真实源 `JSON.parse(source.header)` 的形态） */
  header?: string
  console?: { log: (...a: unknown[]) => void; error: (...a: unknown[]) => void }
}

export interface EvalJsOptions {
  /** 脚本完成值语义：代码作为脚本执行，最后一个表达式的值即结果；
   *  顶层 return/await 触发 SyntaxError 时自动回落函数体（async IIFE）形态。 */
  scriptForm?: boolean
  /** 脚本可见的源会话状态（cookie 垫片/源变量）——缺省进程级实例（跨调用存活）；
   *  测试注入 createSourceSession() 隔离实例，跨源污染类用例第一次可写。 */
  session?: SourceSession
}

/**
 * runScript：evalJs 的单对象入口。evalJs 的 JsHost 与 EvalContext 字段重叠，调用方此前必须双拼
 * 两份上下文；本入口把重叠字段收进一个对象、host/ctx 在此合并构造。evalJs 保持原样（引擎内部仍用它）。
 */
export interface RunScriptOptions {
  code: string
  /** 上一段结果序列化（host.result）；缺省 ''（脚本起步无上游） */
  result?: string
  baseUrl?: string
  source?: string
  /** 沙箱全局变量（searchUrl @js 形态用 key/page；header 为源静态头 JSON 串） */
  key?: string
  page?: number
  header?: string
  vars?: Record<string, string>
  /** 脚本可见的源实体字段（透传给 EvalContext，见 engine/types.ts 的同名注释） */
  sourceComment?: string
  sourceName?: string
  fetch?: (url: string) => Promise<{ body: string; contentType?: string }>
  fetchRaw?: (url: string) => Promise<Uint8Array>
  jsLib?: string
  jsTimeoutMs?: number
  loc: SegmentLoc
  facet: Facet
  /** 缺省 true：完成值即结果 */
  scriptForm?: boolean
  evaluateRef?: EvaluateRef
  /** 脚本可见的源会话（cookie 垫片/源变量）：缺省进程级实例；测试注入 createSourceSession() */
  session?: SourceSession
}

export function runScript(o: RunScriptOptions): Promise<JsOutcome> {
  const ctx: EvalContext = {
    ...(o.baseUrl === undefined ? {} : { baseUrl: o.baseUrl }),
    ...(o.source === undefined ? {} : { source: o.source }),
    ...(o.vars === undefined ? {} : { vars: o.vars }),
    ...(o.fetch === undefined ? {} : { fetch: o.fetch }),
    ...(o.fetchRaw === undefined ? {} : { fetchRaw: o.fetchRaw }),
    ...(o.jsLib === undefined ? {} : { jsLib: o.jsLib }),
    ...(o.jsTimeoutMs === undefined ? {} : { jsTimeoutMs: o.jsTimeoutMs }),
    ...(o.sourceComment === undefined ? {} : { sourceComment: o.sourceComment }),
    ...(o.sourceName === undefined ? {} : { sourceName: o.sourceName }),
  }
  const host: JsHost = {
    result: o.result ?? '',
    baseUrl: o.baseUrl ?? '',
    source: o.source ?? '',
    ...(o.key === undefined ? {} : { key: o.key }),
    ...(o.page === undefined ? {} : { page: o.page }),
    ...(o.header === undefined ? {} : { header: o.header }),
  }
  return evalJs(o.code, host, ctx, o.loc, o.facet, o.evaluateRef,
    { scriptForm: o.scriptForm ?? true, ...(o.session === undefined ? {} : { session: o.session }) })
}

export interface JsOutcome {
  value: EngineValue
  logs: string[]
}

/** 规则递归求值回调（避免与求值层循环依赖，由求值层注入真实现）。
 *  两个参数：rule + data（data 作为子规则的 html 上下文）。baseUrl 由外层 EvalContext
 *  经 `{...ctx, html}` 继承（第三参 baseUrl? 曾是两处实现都丢弃的死参数，已删）。 */
export type EvaluateRef = (rule: string, data: unknown) => EngineValue

const TIMEOUT = Symbol('js-sandbox-timeout')

/** 进程级 unhandledRejection 防线（加载期常驻，幂等挂载一次）。
 *  脚本自建又 fire-and-forget 的异步工作，其 rejection 在 settle 之后才悬空触发（晚于 evalJs 返回），
 *  Node 20+ 默认当致命错误干掉整个 dsh 进程（探针逐源跑 @js 时命中一个 fire-and-forget 源就崩）。
 *  所以不能「evalJs 期间挂、finally 摘」——摘早了照样漏；加载期常驻拦住默认 throw，插件 dispose 才摘。 */
let guardInstalled = false
function unhandledGuardHandler(reason: unknown): void {
  console.warn('[dsh-novel] 沙箱脚本产生未处理的 rejection（已捕获，不影响进程）:',
    reason instanceof Error ? reason.message : reason)
}
/** 幂等挂载：多次调用只挂一次。返回卸载函数（插件 dispose 时调用）。 */
export function ensureUnhandledGuard(): () => void {
  if (!guardInstalled) {
    process.on('unhandledRejection', unhandledGuardHandler)
    guardInstalled = true
  }
  return () => {
    // 只在仍是已挂载状态时摘（防止重复 ensure 后误摘别人的）
    if (guardInstalled) {
      process.off('unhandledRejection', unhandledGuardHandler)
      guardInstalled = false
    }
  }
}

/**
 * 沙箱引导脚本（在 vm 上下文内执行一次）。
 *
 * 逃逸防御核心：宿主绝不把函数/对象直接交给用户代码——唯一入口 `__host_call__` 被本闭包捕获后
 * 即从全局锁死；暴露给用户的 `java`/`console` 全是 vm realm 包装函数，参数与返回值 JSON 双向序列化，
 * 宿主错误只取 `.message` 后以 vm realm Error 重抛。故用户代码沿 `.constructor` 或错误对象都够不到
 * 宿主 realm；vm realm 内 codeGeneration:{strings:false} 另使 eval / Function 构造器一律 EvalError。
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
  const invoke = function (name, a) {
    let r
    try { r = call(name, ser(a)) } catch (e) { throw new Error(msg(e)) }
    return r
  }
  const sync = function (name) {
    return function () { return JSON.parse(invoke(name, [].slice.call(arguments))) }
  }
  const ajax = d.syncAjax
    // worker 同步桥形态（脚本视角同步）：__host_call__ 经 SAB RPC 阻塞等待主线程
    // fetch 落地，JS 视角同步返回响应 body 字符串——java.ajax(url).match(...) 直接成立
    ? function () {
      const r = invoke('ajax', [].slice.call(arguments))
      try { return JSON.parse(r) } catch (e) { throw new Error(msg(e)) }
    }
    // 主线程形态：**没有同步桥就不猜异步语义**。ajax 语义是同步返回 body，主线程物理上无法阻塞；
    // 曾在此返回 Promise，等价写法静默换类型（已改抛哨兵）。现于**发起宿主调用之前**抛哨兵，
    // evalJs 捕获后换 worker 重跑同一段（请求没发出去，不多打站点）——正则只决定性能，不决定语义。
    // 全貌见本文件「java.ajax 同步桥」一节与 docs/design/engine.md。
    : function () { throw new Error('__dsh_sync_ajax_required__') }
  // java.downloadFile 同款网络同步语义（同步下载、返回路径）：worker 直通、主线程哨兵换道。
  const downloadFile = d.syncAjax
    ? function () {
      const r = invoke('downloadFile', [].slice.call(arguments))
      try { return JSON.parse(r) } catch (e) { throw new Error(msg(e)) }
    }
    : function () { throw new Error('__dsh_sync_ajax_required__') }
  // java.connect 与 ajax/downloadFile 同款网络同步语义（脚本侧是同步调用、拿到对象）：
  // worker 直通拿数据面，主线程抛哨兵换道——不在没有同步桥时返回 Promise 换类型。
  // 壳：raw() 与 url() 是**同一值**关系，脚本链 connect(so).raw().request().url() 取的就是落地地址
  // （跟随重定向后的末次请求）——故 raw 壳直接复用数据面的 url，不额外跨桥带字段。
  const connect = d.syncAjax
    ? function () {
      const raw = invoke('connect', [].slice.call(arguments))
      let r
      try { r = JSON.parse(raw) } catch (e) { throw new Error(msg(e)) }
      return {
        url: r.url,
        body: r.body,
        raw: function () {
          return { request: function () { return { url: function () { return r.url } } } }
        },
      }
    }
    : function () { throw new Error('__dsh_sync_ajax_required__') }
  // java.post：返回响应对象的**方法**壳（脚本写 res.body() / res.cookies()）。
  // 跨桥只走 JSON 数据，所以数据包在沙箱内包成方法对象——函数不外传，也不跨边界。
  // 刻意只给有真数据支撑的四个访问器：还有 header(name) 等，本仓没带响应头表，
  // 就不编一个空壳给脚本（宁缺毋假值）；调到不存在的名字会照实 TypeError。
  const post = d.syncAjax
    ? function () {
      let r
      try { r = JSON.parse(invoke('post', [].slice.call(arguments))) } catch (e) { throw new Error(msg(e)) }
      return {
        body: function () { return r.body },
        statusCode: function () { return r.statusCode },
        contentType: function () { return r.contentType === undefined ? '' : r.contentType },
        url: function () { return r.url },
        cookies: function () { return r.cookies === undefined ? {} : r.cookies },
      }
    }
    : function () { throw new Error('__dsh_sync_ajax_required__') }
  // ── Packages.*（书源脚本里的 Java 包路径仿真）─────────────────────
  // 真实源正文解密链用它组织 JVM/Android 类调用。重活（PNG 解码、AES、HMAC、charset 解码）走宿主
  // 调用 __pkg.*（JSON 序列化边界，与 __elem.* 同款纪律）；轻活（流/数组/包装）留在 vm realm 纯 JS。
  // 未知路径 → 如实报「不支持」。
  const pkgCall = function (op, payload) {
    try { return JSON.parse(call('__pkg.' + op, ser(payload))) } catch (e) { throw new Error(msg(e)) }
  }
  const mkBytesStream = function (bytes) {
    const buf = Array.isArray(bytes) ? bytes : []
    let pos = 0
    // 游标必须自增：没有它读循环恒在首字节死转（read 恒回首字节），
    // 而唯一出口是 js 超时——脚本表现为「目录脚本超时」而不是「我读错了」。
    // _bytes 仍是全量视图（BitmapFactory.decodeStream 侧按它取整包，见 pkgHostOp）。
    return {
      _bytes: buf,
      available: function () { return buf.length - pos },
      read: function () { return pos < buf.length ? buf[pos++] : -1 },
      toString: function () { return '[ByteArrayInputStream len=' + buf.length + ' pos=' + pos + ']' },
    }
  }
  g.Packages = {
    // Packages.org.jsoup.Jsoup.parse(html)：脚本里的 Java 包路径写法，与下方 g.org.jsoup.Jsoup.parse
    // 同一份实现（脚本两种写法在真实源里都有；BOOTSTRAP 是模板字符串，注释里不能出现反引号）。
    org: { jsoup: { Jsoup: { parse: function (html) { return mkElem(String(html)) } } } },
    java: {
      io: {
        ByteArrayInputStream: function (bytes) { return mkBytesStream(bytes) },
        ByteArrayOutputStream: function () {
          const b = []
          return {
            write: function (x) {
              if (Array.isArray(x)) { for (let i = 0; i < x.length; i++) b.push(x[i] & 0xff) }
              else b.push((+x) & 0xff)
            },
            toByteArray: function () { return b.slice() },
            size: function () { return b.length },
          }
        },
      },
      lang: {
        // new Packages.java.lang.String(bytes, 'UTF-8') → String(obj) 走 valueOf/toString 还原文本
        String: function (bytes, charset) {
          const s = JSON.parse(call('__pkg.b2s', ser({ bytes: bytes, charset: charset || 'UTF-8' })))
          return { toString: function () { return s }, valueOf: function () { return s } }
        },
      },
      util: {
        Arrays: {
          // Java copyOfRange 语义（负索引从尾数、越长补 0）——脚本用 (0,48)/(48,len) 两形态
          copyOfRange: function (arr, from, to) {
            const n = arr.length
            let f = from | 0, t = (to === undefined ? n : to) | 0
            if (f < 0) f += n
            if (t < 0) t += n
            if (f < 0) f = 0
            if (t < f) t = f
            const out = []
            for (let i = f; i < t; i++) out.push(i < n ? arr[i] & 0xff : 0)
            return out
          },
        },
      },
    },
    javax: {
      crypto: {
        Cipher: {
          ENCRYPT_MODE: 1,
          DECRYPT_MODE: 2,
          getInstance: function (trans) {
            // 注意：BOOTSTRAP 是模板字符串，正则字面量里的 \/ 会被模板层解转义成 / 截断正则——
            // 用 new RegExp 构造（同理此处任何含 / 的模式都不得用字面量）
            if (!new RegExp('^AES/CBC/PKCS[57]Padding$', 'i').test(String(trans))) {
              throw new Error('不支持的加密变换：' + trans + '（v1 实现 AES/CBC/PKCS5|7Padding）')
            }
            const st = { key: null, iv: null, mode: 1 }
            return {
              init: function (mode, keySpec, ivSpec) {
                st.mode = mode | 0
                st.key = keySpec && keySpec._bytes ? keySpec._bytes : null
                st.iv = ivSpec && ivSpec._bytes ? ivSpec._bytes : null
              },
              doFinal: function (data) {
                if (st.key === null || st.iv === null) throw new Error('Cipher 未 init')
                if ((st.mode | 0) !== 2) throw new Error('v1 仅实现解密（DECRYPT_MODE）')
                return JSON.parse(call('__pkg.aes', ser({ key: st.key, iv: st.iv, data: data })))
              },
            }
          },
        },
        Mac: {
          getInstance: function (algo) {
            const a = String(algo)
            if (!/^HmacSHA(1|256|512)$/.test(a)) throw new Error('不支持的 Mac 算法：' + algo)
            const st = { key: null, parts: [] }
            // Java 的 Mac 契约：update(byte[]) 累加、update(byte) 追加单字节、doFinal() 结算后复位、
            // doFinal(input) ≡ update(input) + doFinal()。认不出的字节载荷形态如实抛，不静默丢弃
            // （曾静默丢弃 → 零字节签名 → 站点拒给空/乱正文，是静默出错值而不是报错）。
            const push = function (v) {
              if (Array.isArray(v)) st.parts.push(v)
              else if (typeof v === 'number') st.parts.push([v])
              else throw new Error('Mac 不接受的字节载荷形态：' + (v === undefined ? 'undefined' : typeof v))
            }
            return {
              init: function (keySpec) { st.key = keySpec && keySpec._bytes ? keySpec._bytes : null; st.parts = [] },
              update: function (b) { push(b) },
              doFinal: function (input) {
                if (st.key === null) throw new Error('Mac 未 init')
                if (input !== undefined) push(input)
                let data = []
                for (const p of st.parts) data = data.concat(p)
                st.parts = []
                return JSON.parse(call('__pkg.hmac', ser({ algo: a, key: st.key, data: data })))
              },
            }
          },
        },
        spec: {
          SecretKeySpec: function (bytes, algo) {
            return { _bytes: Array.isArray(bytes) ? bytes : [], _algo: String(algo || 'AES') }
          },
          IvParameterSpec: function (bytes) {
            return { _bytes: Array.isArray(bytes) ? bytes : [] }
          },
        },
      },
    },
    android: {
      graphics: {
        BitmapFactory: {
          // PNG 解码全在宿主（node:zlib）；bitmap 包装对象持像素数组，getPixel 纯 vm 内取——
          // ARGB int 位移语义与 Java int 一致（脚本 (rgb>>16)&0xFF 取 R 通道成立）
          decodeStream: function (src) {
            const bytes = src && src._bytes ? src._bytes : src
            const r = pkgCall('png', { bytes: bytes })
            return {
              getWidth: function () { return r.width },
              getHeight: function () { return r.height },
              getPixel: function (x, y) {
                const xi = x | 0, yi = y | 0
                if (xi < 0 || yi < 0 || xi >= r.width || yi >= r.height) return 0
                return r.pixels[yi * r.width + xi]
              },
            }
          },
        },
      },
      // Packages.android.util.Base64.decode(text, flags) → 字节组。解码复用协议表里的
      // base64DecodeToByteArray（单一实现）。flags 在这里不构成可观测分支；与上游解码器的偏离与
      // 判据见 tests/engine/legado-gaps.test.ts 的 E-4，别在这儿再写一份判据。
      util: {
        Base64: { decode: sync('base64DecodeToByteArray') },
      },
    },
  }
  // 未知包路径**如实点名**（上游 Rhino 的 Packages 是惰性命名空间：取到名字不炸、用到才炸——本代理同语义）。
  // 曾是普通对象字面量：未实现路径取到 undefined → 抛裸 TypeError，既说不清是哪条包路径，也不在审计
  // 归因的任何锚点里。现库真量（2026-09-28 扫）：java.net 2 处、android.webkit / io.legado 各 1 处。
  // 注意：本段是 BOOTSTRAP 模板字符串的一部分——注释里不许出现反引号与美元花括号。
  var pkgUnknownPath = function (path) {
    var boom = function () { throw new Error('未知 Packages 包路径：' + path) }
    return new Proxy(boom, {
      get: function (t, k) {
        if (typeof k === 'symbol' || k === 'toString' || k === 'valueOf' || k === 'name' || k === 'length') return t[k]
        return pkgUnknownPath(path + '.' + String(k))
      },
      apply: boom,
      construct: boom,
    })
  }
  var pkgWrap = function (obj, path) {
    if (obj === null || typeof obj !== 'object') return obj
    return new Proxy(obj, {
      get: function (t, k) {
        if (typeof k === 'symbol' || k === 'toString' || k === 'valueOf') return t[k]
        var next = path === '' ? String(k) : path + '.' + String(k)
        if (k in t) {
          var v = t[k]
          return (v !== null && typeof v === 'object') ? pkgWrap(v, next) : v
        }
        return pkgUnknownPath(next)
      },
    })
  }
  g.Packages = pkgWrap(g.Packages, '')
  const log = function (kind) {
    return function () {
      try { call(kind, ser([].slice.call(arguments))) } catch (e) {}
    }
  }
  // ── 元素包装对象（jsoup Element/Elements 的最小仿真）──────────────
  // 真实源 result.attr('href')、result.select('.x').first().text()、java.getElements(r).toArray()
  // 等形态：String 对象包装（字符串方法照常可用：match/replace/indexOf/模板串），
  // 属性/文本/选择器方法经 __elem.* 宿主调用（cheerio 求值，同步桥）。
  const elemOps = function (op, payload) {
    try { return JSON.parse(call('__elem.' + op, ser(payload))) } catch (e) { throw new Error(msg(e)) }
  }
  // owner = { box, rule }：这个集合是「哪个片段的哪条选择器」选出来的。元素桥的片段住在
  // box.html 里（不是构造时常量），select().remove() 把摘除后的片段回写进 owner.box——
  // 产出它的那个元素此后所有读法（html/text/select/String）都看见净化后的树。
  const wrapElems = function (arr, owner) {
    const out = []
    for (let i = 0; i < arr.length; i++) out.push(mkElem(String(arr[i])))
    // 集合助手挂成**不可枚举**：上游 result.toArray() 给的是数组、for (i in list) 只遍历下标；
    // 真源 toc 模板正是 for-in 形态，可枚举的助手会被当元素遍历（list[i].text is not a function）。
    // （BOOTSTRAP 是模板字符串，注释里不能出现反引号。）
    const all = function () { return mkElem(out.join('\\n')) }   // 聚合口径共用元素桥（attr=首个、text=拼接）
    const helpers = {
      toArray: function () { return out.slice() },
      size: function () { return out.length },
      get: function (i) { return out[i] !== undefined ? out[i] : mkElem('') },
      eq: function (i) { return out[i] !== undefined ? out[i] : mkElem('') },
      first: function () { return out.length > 0 ? out[0] : mkElem('') },
      last: function () { return out.length > 0 ? out[out.length - 1] : mkElem('') },
      each: function (fn) { for (var i = 0; i < out.length; i++) fn(out[i], i); return out },
      // jsoup Elements 的聚合读法：attr/text/html/select 走整段拼接后的元素桥
      attr: function (n) { return all().attr(n) },
      text: function () { return all().text() },
      html: function () { return out.length > 0 ? out[0].html() : '' },
      select: function (rule) { return wrapElems(all().select(rule)) },
      hasAttr: function (n) { var a = all().attr(n); return a !== '' && a !== undefined },
      // 集合的 remove()：没有 owner 的集合（临时聚合）背后没有可回写的片段 → 如实抛——
      // 静默 no-op 等于把脏节点当已净化交给正文。
      remove: function () {
        if (owner === undefined || owner === null) {
          throw new Error('remove() 需要可回写的宿主片段：本桥只支持 元素.select(规则).remove() 形态')
        }
        owner.box.html = elemOps('remove', { html: owner.box.html, rule: owner.rule })
        return out
      },
      toString: function () { return out.join('') },   // Elements.toString() = 各元素 outerHtml 拼接、无分隔
    }
    for (const k in helpers) Object.defineProperty(out, k, { value: helpers[k], enumerable: false, writable: true })
    return out
  }
  // 元素集包装：列表路径上的 result 是元素**集合**（Elements）而非单个 Element——size()/get()/each()
  // 按顶层元素数算，不是恒 1；同时保留 String 对象身份（match/replace/模板串照常可用）。
  // 片段住 box 而非构造常量：活文档树上的摘除要能被后续读法看见。
  const mkElem = function (raw) {
    const box = { html: String(raw) }
    const s = new String(box.html)
    s.toString = function () { return box.html }
    s.valueOf = function () { return box.html }
    s.attr = function (name) { return elemOps('attr', { html: box.html, name: String(name) }) }
    s.text = function () { return elemOps('text', { html: box.html }) }
    s.html = function () { return elemOps('html', { html: box.html }) }
    s.select = function (rule) { return wrapElems(elemOps('select', { html: box.html, rule: String(rule) }), { box: box, rule: String(rule) }) }
    s.toArray = function () { return wrapElems(elemOps('split', { html: box.html })) }
    s.size = function () { return s.toArray().length }
    s.get = function (i) { var a = s.toArray(); return a[i] !== undefined ? a[i] : mkElem('') }
    s.eq = function (i) { return s.get(i) }
    s.first = function () { var a = s.toArray(); return a.length > 0 ? a[0] : mkElem('') }
    s.last = function () { var a = s.toArray(); return a.length > 0 ? a[a.length - 1] : mkElem('') }
    s.each = function (fn) { var a = s.toArray(); for (var i = 0; i < a.length; i++) fn(a[i], i); return s }
    return s
  }
  g.__mkElem__ = mkElem
  g.__wrapElems__ = wrapElems
  g.java = {
    ajax: ajax,
    // async 网络行（协议表 mode:'async' 不进 javaSync 名单）——与 ajax 同款手工挂载
    downloadFile: downloadFile,
    connect: connect,
    post: post,
    log: log('console.log'),
    toast: function(){}, longToast: function(){}, copyText: function(){},
    startBrowser: function(){}, open: function(){}, openUrl: function(){},
    // createSymmetricCrypto：链式解密形态（java.createSymmetricCrypto(t,k,iv).decryptStr(data)）——
    // 解密实现在协议表 aesBase64DecodeToString（Node crypto），此处只做链式外壳
    createSymmetricCrypto: function (transformation, key, iv) {
      return {
        decryptStr: function (data) {
          return JSON.parse(call('aesBase64DecodeToString', ser([String(data), String(key), String(transformation || 'AES/CBC/PKCS5Padding'), String(iv || '')])))
        },
        encryptStr: function () { throw new Error('java.createSymmetricCrypto().encryptStr 不支持：v1 仅实现正文解密形态') },
      }
    },
  }
  // 同步方法名单从协议表派生（js-protocol.SANDBOX_MOUNTS，经 __init__ 注入）——
  // 加一个 java 方法只改表一行，此处零改动；ajax 为 async 走上面的特制包装，不在名单内
  d.mounts.javaSync.forEach(function (n) { g.java[n] = sync(n) })
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
  // 曾把协议表已有真实现的摘要/HMAC 族误列在此、被本循环覆盖成抛错桩（协议表测试全绿而脚本一调就报
  // 「需要安卓宿主环境」）——现由普查面 C 钉住不许复发。
  ;['webView','startBrowserAwait','refreshTocUrl','ajaxAll','createAsymmetricCrypto',
    'aesBase','queryTTF','queryBase','replaceFont','androidId',
    'createSign'].forEach(function (n) {
    g.java[n] = function () { throw new Error('java.' + n + ' 不支持：需要安卓宿主环境（WebView/加密/系统服务无法仿真）') }
  })
  g.cookie = {}
  d.mounts.cookie.forEach(function (p) { g.cookie[p.key] = sync(p.name) })
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
  // org.jsoup.Jsoup.parse 最小仿真（真实源脚本直接 org.jsoup.Jsoup.parse(result) 再
  // .select(...)——安卓 classpath 里 Jsoup 可用；我们以 cheerio 元素包装等价承接 parse 入口，
  // 其余 org.* 仍如实报需要安卓宿主）
  g.org = new Proxy({ jsoup: { Jsoup: { parse: function (html) { return mkElem(String(html)) } } } }, {
    get: function (t, p) {
      if (p in t) return t[p]
      if (p === Symbol.toPrimitive || p === 'toString' || p === 'valueOf') return function () { return 'org.' + String(p) }
      throw new Error('org.' + String(p) + ' 不支持：需要安卓宿主环境')
    },
  })
  g.console = { log: log('console.log'), error: log('console.error') }
  g.__d__ = d
  g.__src__ = { key: d.source, bookSourceUrl: d.source, bookSourceName: d.sourceName || '',
    // 脚本可见的源实体字段（对面脚本里的 source 就是书源实体）；只投影现库真读到的那个
    bookSourceComment: d.sourceComment || '', loginUrl: '',
    header: d.header || '{}',
    getKey: function () { return d.source },
    // getLoginInfoMap：登录信息表（用户在 loginUi 录入的键值）。我们无 loginUi——
    // 返回空表如实仿真（脚本取不到配置走默认分支；不伪造假配置）
    getLoginInfoMap: function () { return {} },
    toString: function () { return d.source }, valueOf: function () { return d.source } }
  // 源变量垫片方法（getVariable/setVariable/get/put）同样从协议表派生
  d.mounts.source.forEach(function (p) { g.__src__[p.key] = sync(p.name) })
  g.result = d.resultJson
    // JSON 页/条目：result 按解析后的对象绑定（字段访问形态）
    ? (function () { try { return JSON.parse(d.resultJson) } catch (e) { return d.result } })()
    : (d.resultKind === 'nodes' && d.resultCtx === 'list')
      // 列表路径：result 是**元素集合**——forEach/length/下标/size/get 全能用
      ? wrapElems(elemOps('split', { html: d.result }))
      : (d.resultKind === 'nodes' || (d.resultKind === 'page' && /<[a-zA-Z]/.test(d.result)))
        ? g.__mkElem__(d.result)
        : d.result
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
    t.getOrigin = function () { return String(t.origin ?? t.baseUrl ?? d.source) }
    return t
  }
  g.book = mkHostObj(d.book)
  g.chapter = mkHostObj(d.chapter)
  g.baseUrl = d.baseUrl
  g.source = g.__src__
  g.key = d.key
  g.page = d.page
  g.src = d.src || ''
  g.book = d.book || {}
  g.chapter = d.chapter || {}
})(globalThis)`

/**
 * 在 node:vm 受限上下文中执行用户 JS 片段（`js:` 前缀段 / `<js>…</js>` 内联段两种形态；
 * 链尾没有 `(…)` 切法，见 parse.ts 的 `parseBranch`）。
 *
 * - 上下文 codeGeneration:{strings:false,wasm:false}：eval / Function 构造器一律 EvalError。
 * - wrapper 为 async IIFE：顶层 `await` 可用；单次 `vm.runInContext` 同时覆盖编译与同步段
 *   （vm timeout 杀死 while(true){} 这类同步死循环），异步总时长由外层 Promise.race 硬超时约束
 *   （timer 已 unref，不拖住事件循环）。
 * - 返回值映射：string→Value；array→List（元素 String()）；null/undefined/''→Miss；对象→JSON.stringify 的 Value。
 * - `console.log/error` 收集进返回的 logs（join(' ')），不外泄打印。
 * - `java.ajax` 语义唯一（同步返回 body）：主线程撞哨兵即换 worker 重跑同一段（见下方
 *   「java.ajax 同步桥」一节）；正则只决定性能，不决定语义——口径与残余见 docs/design/engine.md。
 */
export async function evalJs(
  code: string,
  host: JsHost,
  ctx: EvalContext,
  loc: SegmentLoc,
  facet: Facet,
  evaluateRef?: EvaluateRef,
  opts?: EvalJsOptions,
): Promise<JsOutcome> {
  const logs: string[] = []
  const timeout = Math.max(1, ctx.jsTimeoutMs ?? DEFAULT_JS_TIMEOUT_MS)
  // 幂等挂载进程级 unhandledRejection 防线（多次调用只挂一次；挂上后常驻至插件 dispose）
  ensureUnhandledGuard()
  const session = opts?.session ?? processSession
  // 变量读链的 source 层（四级读链的最外级）：与 source.get/put 同一张按源隔离的表。用 peek
  // （非建档）而不是 sourceVars()——后者一调就建表，会改掉「从未设置」的语义；惰性取值还顺带
  // 覆盖「同一次调用里先 source.put 再 java.get」的形态。
  if (ctx.sourceVar === undefined) {
    const varKey = ctx.source ?? ctx.baseUrl ?? ''
    ctx.sourceVar = (k: string): string | undefined => session.peekSourceVars(varKey)?.get(k)
  }
  const deps: BridgeDeps = {
    ctx,
    code,
    loc,
    facet,
    result: host.result ?? '',
    session,
    sourceKey: ctx.source ?? ctx.baseUrl ?? '',
    evaluateRef,
    contentBase: null,
  }
  const call = makeHostCall(deps, logs, host.console)
  // java.ajax 同步语义路由：命中 SYNC_WORKER_RE 即整段进 worker（SAB RPC 同步阻塞拿 body），
  // 无 ajax 的脚本仍走主线程 vm（零开销）。**正则只是性能启发，不是语义开关**——认不出的等价写法
  // 会先白跑主线程、再由哨兵兜回 worker（见 needsSyncBridge），语义一致。总口径见下方「同步桥」一节。
  const jsLibCode = await resolveJsLib(ctx.jsLib, ctx, loc, facet)
  const useWorker = SYNC_WORKER_RE.test(jsLibCode + '\n' + code)
  // JSON 页的 `result` 绑定：整页/条目上下文是合法 JSON 时按**解析后的对象**绑定——
  // `result.chapterTitle`、`result.data.list` 这类字段访问形态全靠它（曾恒为原文字符串 → 字段全
  // undefined → 目录脚本产空）。
  const pageRaw = host.result ?? ''
  const trimmedResult = pageRaw.trim()
  const resultJson = host.resultKind === 'page'
    && ((trimmedResult.startsWith('{') && trimmedResult.endsWith('}')) || (trimmedResult.startsWith('[') && trimmedResult.endsWith(']')))
    ? pageRaw : ''
  // init 按 syncAjax 参数化：worker 重跑（哨兵路线）必须拿 syncAjax:true 的那一份，
  // 复用主线程的 init 会让 worker 里的 ajax 包装再抛一次哨兵。
  const initOf = (syncAjax: boolean): string => JSON.stringify({
    result: pageRaw, resultKind: host.resultKind ?? '', resultJson,
    resultCtx: host.resultCtx ?? 'value',
    baseUrl: ctx.baseUrl ?? '', source: ctx.source ?? '',
    key: host.key ?? '', page: host.page ?? 1, header: host.header ?? '{}',
    // 源实体字段（脚本可见的 `source.bookSourceComment` / `source.bookSourceName`）：只投影脚本真读到的
    sourceComment: ctx.sourceComment ?? '', sourceName: ctx.sourceName ?? '',
    // 沙箱全局 `src` = 当前页面原文（html 优先；纯 JSON 页给序列化文本——与 host.result 的
    // 首段口径同源）。真实源 `JSON.parse(src)` / `src.match(...)` 全靠它。
    src: ctx.html ?? (ctx.json === undefined ? '' : String(ctx.json)),
    // `book` / `chapter` 变量：目录/正文面脚本常见 `book.bookUrl`、`chapter.title`——
    // 服务层按面注入（缺席给空对象：脚本读字段得 undefined，与「未设置」同形）
    book: ctx.book ?? {}, chapter: ctx.chapter ?? {},
    syncAjax,
    // 沙箱挂载清单从协议表派生（见 js-protocol.SANDBOX_MOUNTS）
    mounts: SANDBOX_MOUNTS,
  })
  const init = initOf(useWorker)
  // wrapped（函数体形态）文本在这里一次构造，主线程与 worker 共用同一份（worker 走 workerData）：
  // 在 WORKER_SRC 里再拼一遍等于养第二份，两处转义口径不同（worker 字符串里要写 `\\n`），改一处漏一处。
  const wrapped = wrappedFormOf(code)
  if (useWorker) {
    return evalJsInWorker({
      bootstrap: BOOTSTRAP, init, code, wrapped, jsLib: jsLibCode, timeout,
      scriptForm: opts?.scriptForm ?? true, call, logs, loc, facet,
    })
  }
  // 主线程整段包一层哨兵捕获：四个可能冒出哨兵的位置（BOOTSTRAP init / jsLib / 同步执行 /
  // await 到的完成值——`await` 形态下哨兵是 rejection）都要能兜住，故包在最外层而不是逐处判定。
  try {
    const context = vm.createContext(
      { __host_call__: call, __init__: init } as unknown as vm.Context,
      { codeGeneration: { strings: false, wasm: false } },
    )

    try {
      vm.runInContext(BOOTSTRAP, context, { timeout })
    } catch (e) {
      throw jsErr(e, code, loc, facet, '沙箱初始化失败')
    }

    // jsLib（源级全局函数库）：先于用户代码在同一上下文执行——函数定义落全局，用户 @js 里直接
    // 调用。它本身不是求值目标：抛错如实上报（jsLib 坏了整源的 js 都不可信）。用**已解析**的库
    // 文本（URL 字典在 evalJs 顶部下载拼好）——两条路必须同一份，否则同一源在两路少一层库。
    const jsLib = jsLibCode
    if (jsLib.trim() !== '') {
      try {
        vm.runInContext(jsLib, context, { timeout })
      } catch (e) {
        if (isVmTimeout(e)) throw jsTimeoutErr(timeout, jsLib.slice(0, 200), loc, facet)
        throw jsErr(e, jsLib.slice(0, 200), loc, facet, 'jsLib 执行失败')
      }
    }

    // key/page/result/baseUrl/source/src/book/chapter 已由 bootstrap 注入为全局——wrapper 不再声明
    // 同名参数（真源有 `let page = java.get("page")` 的重声明形态，参数位会撞 Identifier already declared）。
    // **非严格模式（钉死）**：书源脚本按 sloppy 语义执行，`next = []` 这类未声明赋值就是写全局，
    // 真实源大量依赖（现库 18/214 源某处规则串含 `next = [`，2026-09-28 按 raw 扫、判据不限首行）。
    // 逃逸防御不靠严格模式：vm realm 隔离 + codeGeneration 关闭 + 宿主入口锁死才是边界，见 BOOTSTRAP 顶注。
    // wrapped 文本在 evalJs 顶部构造（与 worker 共用同一份）。

    let started: unknown
    try {
      started = opts?.scriptForm === true
        // 完成值语义：代码是脚本，最后一个表达式的值即结果（顶层 return/await → SyntaxError → 回落函数体）
        ? runAsScript(code, wrapped, context, timeout)
        : vm.runInContext(wrapped, context, { timeout })
    } catch (e) {
      if (isVmTimeout(e)) throw jsTimeoutErr(timeout, code, loc, facet)
      throw jsErr(e, code, loc, facet, '脚本编译/同步执行失败')
    }

    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const ret = await Promise.race([
        started,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(TIMEOUT), timeout)
          timer?.unref?.()
        }),
      ])
      return { value: toEngineValue(ret), logs }
    } catch (e) {
      if (e === TIMEOUT || isVmTimeout(e)) throw jsTimeoutErr(timeout, code, loc, facet)
      if (e instanceof JsSandboxError) throw e
      throw jsErr(e, code, loc, facet, '脚本执行抛错')
    } finally {
      if (timer) clearTimeout(timer)
      // unhandledRejection 防线常驻（不再此处摘除）——见 ensureUnhandledGuard
    }
  } catch (e) {
    if (!needsSyncBridge(e)) throw e
    // 别名写法调 ajax（java["ajax"] / 解构 / 动态键）：主线程给不出同步语义，
    // 换 worker 重跑同一段。已产生的日志丢弃——否则同一段脚本的 console.log 会出现两遍。
    logs.length = 0
    return evalJsInWorker({
      bootstrap: BOOTSTRAP, init: initOf(true), code, wrapped, jsLib: jsLibCode, timeout,
      scriptForm: opts?.scriptForm ?? true, call, logs, loc, facet,
    })
  }
}

/** 脚本形态执行：完成值即结果；**编译期** SyntaxError（顶层 return/await）回落 async IIFE 函数体形态。
 *  判别必须在编译期（new vm.Script 只编译不执行）——曾按执行后的异常类名判，运行时 SyntaxError
 *  （JSON.parse 坏串等）被误判成顶层 return 形态静默回落 wrapped，表达式脚本恒 Miss（比报错更坏）。
 *  跨 realm `instanceof SyntaxError` 不成立，按 constructor.name 判定。
 *  **worker 里有这份的文本抄本**（WORKER_SRC 的 runAsScript，worker 代码以字符串交付够不到本函数）：
 *  改这里必须同时改那里，两路一致由 `tests/engine/json-parse-object-idempotent.test.ts` 钉住。 */
function runAsScript(code: string, wrapped: string, context: vm.Context, timeout: number): unknown {
  try {
    // 只编译不执行：SyntaxError = 语法层（含顶层 return/await）→ 回落 wrapped
    new vm.Script(code)
  } catch (e) {
    if ((e as { constructor?: { name?: string } })?.constructor?.name === 'SyntaxError') {
      return vm.runInContext(wrapped, context, { timeout })
    }
    throw e
  }
  return vm.runInContext(code, context, { timeout })
}

/** 函数体形态（wrapped）文本：把用户代码包进 async IIFE，`return` 有处可去。
 *  主线程与 worker 共用这一份构造（worker 经 workerData 拿成品串，见 evalJs）。 */
function wrappedFormOf(code: string): string {
  return `;(async function (result, baseUrl, source, java, cookie, console) {\n${code}\n}).apply(undefined, [__d__.result, __d__.baseUrl, __src__, java, cookie, console])`
}

// ── java.ajax 同步桥（worker + SharedArrayBuffer RPC）────────────────────
//
// `java.ajax` 的语义是同步返回响应 body；Node 主线程 vm 无法阻塞 await——语义由**桥**给
// （worker 同步返回 / 主线程抛哨兵），不由正则给。两条路：① SYNC_WORKER_RE 认出可能的 ajax 形态
// → evalJs 直接把整段路由进 worker（性能启发，省一趟白跑）；② 认不出的等价写法在主线程撞哨兵 →
// evalJs 捕获后换 worker 重跑同一段（见 needsSyncBridge，请求没发出去，不多打站点）。
// worker 里的 __host_call__ 把 (name, argsJson) 写进请求 SAB 后 Atomics.wait 阻塞，主线程经
// message 唤醒后用同一个 `call` 异步服务（fetch / 引擎递归 / console / 元素桥），响应回写 + notify。
// 逃逸防御不变：同一份 BOOTSTRAP + vm codeGeneration 锁死，SAB 上只有 JSON 字符串。超时双闸：
// worker 内 vm timeout 杀同步死循环，主线程 Promise.race（timeout + 5s）后 terminate。
// worker 代码以字符串交付（tsdown 打包后无独立文件可解析），BOOTSTRAP/init/code/wrapped 全走
// workerData，不产生第二份引导抄本；唯一无法共用的是 runAsScript（见 WORKER_SRC 内注释）。

/** 路由启发式（**只影响性能与稳健性，不影响语义**——语义由桥给）。刻意过近似而不求精确，三支：
 *  ① `\.ajax\s*\(` 认任何 `.ajax(`；② `downloadFile\s*\(`（与 ajax 同款的哨兵桥，见 js-protocol.ts）；
 *  ③ `java\s*\[` 认任何对 java 桥的下标访问。放宽的动机不只是省一趟白跑：哨兵靠「抛出」传递，
 *  脚本自己的 try/catch 会在 vm 内把它吞掉——现实的别名写法直接进 worker，压根走不到抛哨兵那步。
 *  仍漏的只有真正间接形态（解构、with）。口径与实测读数见 docs/design/engine.md。 */
const SYNC_WORKER_RE = /\.ajax\s*\(|downloadFile\s*\(|java\s*\[/
const SAB_REQ_BYTES = 4 * 1024 * 1024
const SAB_RESP_BYTES = 16 * 1024 * 1024

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
  const deadline = Date.now() + 300000
  while (Atomics.load(respFlag, 0) === 0) {
    if (Date.now() > deadline) throw new Error('宿主调用等待超时（300s）')
    Atomics.wait(respFlag, 0, 0, 1000)
  }
  const len = new DataView(respSab).getInt32(0, true)
  const json = td.decode(respView.subarray(4, 4 + len))
  Atomics.store(respFlag, 0, 0)
  const parsed = JSON.parse(json)
  if (parsed !== null && typeof parsed === 'object' && parsed.__error) throw new Error(String(parsed.__error))
  return json
}
function sanitize(v) {
  if (v === null || v === undefined) return null
  const t = Object.prototype.toString.call(v)
  if (t === '[object String]') return String(v)
  if (typeof v === 'function') return String(v)
  if (typeof v === 'object') {
    try { return JSON.parse(JSON.stringify(v)) } catch (e) { return String(v) }
  }
  return v
}
// 脚本形态判别：**编译期**判 SyntaxError，与主线程 runAsScript 同口径。这里是那份的文本抄本
// （worker 代码以字符串交付，够不到宿主函数）——改一处必须改两处，两路一致由
// tests/engine/json-parse-object-idempotent.test.ts 钉住。曾按执行后异常类名判，会把运行时
// SyntaxError 误当顶层 return 形态并重跑（ajax 重发、站点两趟，且可能静默 Miss）。
function runAsScript(code, wrapped, context, timeout) {
  try { new vm.Script(code) }
  catch (e) {
    if (e && e.constructor && e.constructor.name === 'SyntaxError') return vm.runInContext(wrapped, context, { timeout })
    throw e
  }
  return vm.runInContext(code, context, { timeout })
}
;(function () {
  const context = vm.createContext(
    { __host_call__: hostCall, __init__: init },
    { codeGeneration: { strings: false, wasm: false } },
  )
  try {
    vm.runInContext(bootstrap, context, { timeout })
    if (jsLib.trim() !== '') vm.runInContext(jsLib, context, { timeout })
    const started = scriptForm
      ? runAsScript(code, wrapped, context, timeout)
      : vm.runInContext(wrapped, context, { timeout })
    Promise.resolve(started).then(
      function (ret) { parentPort.postMessage({ ok: true, ret: sanitize(ret) }) },
      function (e) { parentPort.postMessage({ ok: false, message: e && e.message ? String(e.message) : String(e), stack: e && e.stack ? String(e.stack) : '' }) },
    )
  } catch (e) {
    parentPort.postMessage({ ok: false, message: e && e.message ? String(e.message) : String(e), stack: e && e.stack ? String(e.stack) : '' })
  }
})()
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
      reqSab, respSab, reqFlagSab, respFlagSab,
    },
  })
  const serviceRpc = async (): Promise<void> => {
    let out: string
    try {
      // 帧解析也在 try 内：畸形长度或非 JSON 帧必须以 {__error} 回包让 worker 从 Atomics.wait
      // 醒来，不能落在 `void serviceRpc()` 上变成 unhandled rejection——那样 worker 一直挂到
      // 外层 race（timeout + 5000）才被 terminate，用户看到的是整段 js 卡死。
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
    const result = await new Promise<{ ok: boolean; ret?: unknown; message?: string; stack?: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(TIMEOUT), a.timeout + 5000)
      timer.unref?.()
      worker.on('message', (m: { ok: boolean; ret?: unknown; message?: string; stack?: string; rpc?: boolean }) => {
        if (m?.rpc === true) { void serviceRpc(); return }
        clearTimeout(timer)
        resolve(m)
      })
      worker.on('error', (e) => { clearTimeout(timer); reject(e) })
      worker.on('exit', (code) => { clearTimeout(timer); reject(new Error(`js worker 提前退出（code ${code}）`)) })
    })
    if (!result.ok) {
      // worker 里 vm 的超时错误只有 message/stack 过得到边界（`ERR_SCRIPT_EXECUTION_TIMEOUT`
      // 这个 code 留在对端 realm）——在此映射回本仓口径「脚本超时（>Nms）」，否则同一条件
      // 在主线程与 worker 两条路上报两种错，用户与错误分类都看不出是超时（2026-09 审查）。
      if (/Script execution timed out/i.test(result.message ?? '')) {
        throw jsTimeoutErr(a.timeout, a.code, a.loc, a.facet)
      }
      throw jsErr({ message: result.message, stack: result.stack }, a.code, a.loc, a.facet, '脚本执行抛错')
    }
    return { value: toEngineValue(result.ret), logs: a.logs }
  } catch (e) {
    if (e === TIMEOUT) throw jsTimeoutErr(a.timeout, a.code, a.loc, a.facet)
    if (e instanceof JsSandboxError) throw e
    throw jsErr(e, a.code, a.loc, a.facet, '脚本执行抛错')
  } finally {
    void worker.terminate()
  }
}

function toEngineValue(ret: unknown): EngineValue {
  if (ret === null || ret === undefined || ret === '') return { kind: 'miss', detail: 'js 返回空' }
  // 元素包装对象（String 对象——脚本 `return result` 形态）按原文产出，不走 JSON.stringify 加引号
  if (Object.prototype.toString.call(ret) === '[object String]') {
    const s = String(ret)
    return s === '' ? { kind: 'miss', detail: 'js 返回空' } : { kind: 'value', text: s }
  }
  if (Array.isArray(ret)) return { kind: 'list', items: ret.map(serializeJsElement) }
  if (typeof ret === 'object') return { kind: 'value', text: JSON.stringify(ret) }
  return { kind: 'value', text: String(ret) }
}

/** js 数组产物的元素字符串化：字符串原样；元素包装对象（String 对象/带 html 字段）取原文/inner html；
 *  其余对象 JSON.stringify（与 jsonpath 元素口径一致——`java.getElements(...)` 产物经链尾
 *  序列化后，后继 `$.x` 规则能对条目 JSON 求值） */
function serializeJsElement(x: unknown): string {
  if (typeof x === 'string') return x
  if (Object.prototype.toString.call(x) === '[object String]') return String(x)
  if (x !== null && typeof x === 'object') {
    const html = (x as { html?: unknown }).html
    if (typeof html === 'string') return html
    return JSON.stringify(x)
  }
  return String(x)
}

/** 宿主侧唯一入口：与沙箱引导层约定 (name, argsJson) → JSON 字符串（ajax 为 Promise<string>）。
 *  方法分派查协议表（js-protocol.invokeJavaMethod），无逐案 switch；console.* 是引导层日志
 *  通道、不属 java 协议，在此特判（收集进 logs，可选透传宿主 console）。 */
function makeHostCall(
  deps: BridgeDeps,
  logs: string[],
  hostConsole?: JsHost['console'],
): (name: string, argsJson: string) => string | Promise<string> {
  return (name: string, argsJson: string): string | Promise<string> => {
    if (name === 'console.log' || name === 'console.error') {
      const arr: unknown[] = JSON.parse(argsJson)
      logs.push(arr.join(' '))
      if (name === 'console.log') hostConsole?.log(...arr)
      else hostConsole?.error(...arr)
      return 'null'
    }
    // 元素包装对象的宿主侧求值（__elem.*）：cheerio 在宿主 realm 求值，返回纯 JSON——
    // 不进协议表（它不是 java.* 面，是沙箱包装对象的内部桥），与 console.* 同为特判通道
    if (name.startsWith('__elem.')) {
      return JSON.stringify(elemHostOp(name.slice('__elem.'.length), JSON.parse(argsJson))) ?? 'null'
    }
    // Packages.* 的宿主重活（__pkg.*）：PNG 解码 / AES-CBC / HMAC / 字节→串——同 __elem 纪律，
    // 不进协议表（它是 Packages 包路径面，不是 java.* 方法），返回纯 JSON
    if (name.startsWith('__pkg.')) {
      return JSON.stringify(pkgHostOp(name.slice('__pkg.'.length), JSON.parse(argsJson))) ?? 'null'
    }
    const args: unknown[] = JSON.parse(argsJson)
    const out = invokeJavaMethod(deps, name, args)
    if (out instanceof Promise) return out.then((v) => JSON.stringify(v))
    // undefined（java.get 未命中 / void 方法）→ 'null'：与旧逐案分派的 `?? null` / `'null'` 口径一致
    return JSON.stringify(out) ?? 'null'
  }
}

/** `__elem.*` 的 cheerio 解析**单条缓存**：一条 `els.get(i).text()` / `.attr(x).html()` 链会对
 *  同一段片段发起多次宿主操作，每次都重跑 `loadHtml` 等于把整段 HTML 全量解析 N 遍（片段大小
 *  由站点决定，且解析跑在主线程）。只做单条、不做 Map：键是攻击者可控的 HTML 串，留清单
 *  就是留内存增长口；RPC 同步进出，同一次调用内不存在交错。 */
let lastElemHtml = ''
let lastElemApi: ReturnType<typeof loadHtml> | null = null

/** __elem.* 宿主实现：入参 {html, name?/rule?}（js 段上游序列化/条目片段），出参纯 JSON */
function elemHostOp(op: string, payload: { html?: unknown; name?: unknown; rule?: unknown }): unknown {
  const html = typeof payload.html === 'string' ? payload.html : ''
  let api = lastElemApi
  if (api === null || html !== lastElemHtml) {
    api = loadHtml(html)
    lastElemApi = api
    lastElemHtml = html
  }
  const $ = api
  const firstEl = (): Element | null => {
    for (const n of $('*').toArray()) if (isTag(n)) return n as Element
    return null
  }
  switch (op) {
    case 'attr': {
      const name = String(payload.name ?? '')
      const el = firstEl()
      if (el === null || name === '') return ''
      const own = el.attribs?.[name] ?? ''
      if (own !== '') return own
      return $(el).find(`[${name}]`).first().attr(name) ?? ''
    }
    case 'text': {
      const root = $.root().get(0)
      return root === undefined ? '' : nodeText(root)
    }
    case 'html': {
      const el = firstEl()
      return el === null ? '' : $(el).html() ?? ''
    }
    case 'select': {
      const rule = String(payload.rule ?? '')
      if (rule === '') return []
      try {
        return $(rule).toArray().map((n) => $.html(n) ?? '')
      } catch (e) {
        throw new Error(`选择器无法解析：${rule}（${(e as Error).message}）`)
      }
    }
    case 'split': {
      // 片段的顶层元素集（Elements.toArray 口径）。parse5 把片段挂进 body，直接取
      // root().children() 只会得到一个 html——那会让真源 toc 模板的 result.toArray() 恒为 1 个
      // 「元素」，其 text() 反而是整段拼接（size/get/each 全错位）。
      const body = $('body')
      const kids = body.length > 0 ? body.children() : $.root().children()
      return kids.toArray().filter((n) => isTag(n)).map((n) => $.html(n) ?? '')
    }
    case 'remove': {
      // 元素桥的摘除回写：remove() 只把节点从**父**上摘掉、子树跟着节点走——el.select(...).remove()
      // 把 el 自己摘走后，el.html() 仍要读到没被命中的内容。做法：先按原形状记下顶层节点，摘完再
      // 串化它们（节点还在，串化即为净化后的片段）。文档级片段串化整份文档，其余串化 body 顶层子节点。
      const rule = String(payload.rule ?? '')
      const isDoc = /^\s*(?:<!doctype\s|<html[\s>])/i.test(html)
      const top = (isDoc ? $.root().contents() : $('body').contents()).toArray()
      if (rule !== '') {
        try {
          $(rule).remove()
        } catch (e) {
          throw new Error(`选择器无法解析：${rule}（${(e as Error).message}）`)
        }
      }
      return isDoc ? ($.html() ?? '') : top.map((n) => $(n).toString()).join('')
    }
    default:
      throw new Error(`未知元素桥操作：${op}`)
  }
}

/** `__pkg.*` 宿主实现（Packages.* 的重活）：入参/出参纯 JSON（字节 = number[]，0-255）。
 *  png → decodePngToArgb（node:zlib）；aes → AES-CBC 解密（DECRYPT 单向——v1 只做正文解密）；
 *  hmac → HmacSHA*；b2s → 字节按 charset 解码。未知操作与非法输入一律抛错（宁炸不猜）。 */

/** PNG 像素上限（400 万）：策略值住宿主这层，解码器只提供闸口——**在 IHDR 处判**而不是解完再判，
 *  否则挡不住它守的那次分配（膨胀 + `height × rowBytes` 的图像缓冲 + 逐像素 ARGB 数组）。 */
const MAX_PNG_PIXELS = 4_000_000

function pkgHostOp(op: string, payload: Record<string, unknown>): unknown {
  const toBytes = (v: unknown): Uint8Array => {
    if (!Array.isArray(v)) throw new Error('字节载荷需为 number[]')
    return Uint8Array.from(v.map((n) => (Number(n) || 0) & 0xff))
  }
  switch (op) {
    case 'png': {
      return decodePngToArgb(toBytes(payload.bytes), MAX_PNG_PIXELS)
    }
    case 'aes': {
      const key = toBytes(payload.key)
      const iv = toBytes(payload.iv)
      const data = toBytes(payload.data)
      if (![16, 24, 32].includes(key.length)) throw new Error(`AES 密钥长度不合法（${key.length} 字节）`)
      if (iv.length !== 16) throw new Error(`AES-CBC IV 长度不合法（${iv.length} 字节，需 16）`)
      try {
        const d = crypto.createDecipheriv(`aes-${key.length * 8}-cbc`, Buffer.from(key), Buffer.from(iv))
        return Array.from(Buffer.concat([d.update(Buffer.from(data)), d.final()])) // PKCS7 自动校验（=PKCS5）
      } catch (e) {
        throw new Error(`AES-CBC 解密失败（${e instanceof Error ? e.message : String(e)}）`)
      }
    }
    case 'hmac': {
      const algoOf: Record<string, string> = { HmacSHA1: 'sha1', HmacSHA256: 'sha256', HmacSHA512: 'sha512' }
      const nodeAlgo = algoOf[String(payload.algo)]
      if (nodeAlgo === undefined) throw new Error(`不支持的 Mac 算法：${String(payload.algo)}`)
      return Array.from(crypto.createHmac(nodeAlgo, Buffer.from(toBytes(payload.key)))
        .update(Buffer.from(toBytes(payload.data))).digest())
    }
    case 'b2s':
      return javaDecode(toBytes(payload.bytes), typeof payload.charset === 'string' ? payload.charset : 'UTF-8')
    default:
      throw new Error(`未知 Packages 桥操作：${op}`)
  }
}

/** cookie 垫片存储：按源隔离（真实源 cookie.removeCookie(url) 后再 ajax 的形态——最小仿真，
 *  不做真实 CookieJar/域匹配——那是无头浏览器的活，我们如实只做脚本可见的键值）。
 *  存储本体归 SourceSession：这两个 Map 是进程级缺省实例的后仓。 */
const COOKIE_JARS = new Map<string, Map<string, string>>()

/** 源级状态的四张进程级表（本仓按源建档）：COOKIE_JARS（cookie 垫片）、SOURCE_VARS（source.put/get
 *  的键值表）、SOURCE_STRINGS（source.setVariable/getVariable 的单串槽）、CACHE_STORES（cache 垫片）。
 *  四者必须分开——曾把串槽与键值表塞同一张 Map，setVariable 顺手 clear() 整表（见 SourceSession 注释）。
 *  全部进程内仿真，不落盘（跨重启落盘登记在矩阵 h-source-variable）。 */
const SOURCE_VARS = new Map<string, Map<string, string>>()

/**
 * 源会话：脚本可见的按源状态——cookie 垫片与源变量。显式 interface 而非裸模块 Map（后者无 reset、
 * 跨服务实例永生，跨源污染用例写不出来）：生产缺省 processSession，测试注入 createSourceSession()。
 */
export interface SourceSession {
  /** 某源的 cookie 垫片（键值表，缺省建档） */
  cookieJar(sourceKey: string): Map<string, string>
  /** 某源的**键值变量表**（source.put/get 落这里） */
  sourceVars(sourceKey: string): Map<string, string>
  /** 某源键值表的非建档读口：从未碰过 → undefined（java.get 的 source 层要区分「从未设置」） */
  peekSourceVars(sourceKey: string): Map<string, string> | undefined
  /** 某源的**自定义变量单串槽**（source.setVariable/getVariable 落这里）。
   *  与键值表是两个存储：写串槽不许动键值表，反之亦然（曾塞同一张 Map，setVariable 顺手 clear()
   *  把 source.put 的键全清了，getVariable 还返回整表 JSON 壳）。 */
  sourceString(sourceKey: string): string
  setSourceString(sourceKey: string, value: string | null): void
  /** 某源的 cache 垫片表（缓存本是全局表；本仓按源隔离是在册裁决，见矩阵 h-cache-ttl）。
   *  独立于键值表——曾借 sourceVars 加 `cache:` 前缀，脚本用 `source.get('cache:x')` 就串味。 */
  cacheStore(sourceKey: string): Map<string, string>
}

/** 进程级三张表（生产）：按源建档、跨调用/跨服务实例存活——与旧实现同生命周期 */
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

/** 三张表的会话装配（进程级与隔离实例只差在取哪一组 Map） */
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

/** 进程级缺省会话（生产）：按源建档、跨调用/跨服务实例存活——与旧实现行为一致 */
export const processSession: SourceSession = sessionOf(COOKIE_JARS, SOURCE_VARS, SOURCE_STRINGS, CACHE_STORES)

/** 全新隔离会话（测试）：与进程级实例、与其他隔离实例互不可见——跨源污染用例的入口 */
export function createSourceSession(): SourceSession {
  return sessionOf(
    new Map<string, Map<string, string>>(), new Map<string, Map<string, string>>(),
    new Map<string, string>(), new Map<string, Map<string, string>>(),
  )
}

function jsErr(e: unknown, code: string, loc: SegmentLoc, facet: Facet, prefix: string): JsSandboxError {
  const msg = (e as Error)?.message ?? String(e)
  const line = parseLineFromStack((e as Error)?.stack ?? '')
  return new JsSandboxError(`${prefix}：${msg}`, { ...loc, facet, script: code, line })
}

function jsTimeoutErr(timeout: number, code: string, loc: SegmentLoc, facet: Facet): JsSandboxError {
  return new JsSandboxError(`脚本超时（>${timeout}ms）`, { ...loc, facet, script: code })
}

function isVmTimeout(e: unknown): boolean {
  return (e as NodeJS.ErrnoException | undefined)?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT'
}

/** 主线程 ajax 分支的哨兵（见 BOOTSTRAP）。内层 catch 会把它包成 JsSandboxError，
 *  但 jsErr 是 `${prefix}：${msg}` 拼接，原文仍在 message 里，故按子串判定即可。 */
const SYNC_AJAX_SENTINEL = '__dsh_sync_ajax_required__'
function needsSyncBridge(e: unknown): boolean {
  return String((e as { message?: unknown })?.message ?? '').includes(SYNC_AJAX_SENTINEL)
}

function parseLineFromStack(stack: string): number | undefined {
  // wrapper 首行偏移 1：从 <anonymous>:N:M 提取 N（vm 脚本名 evalmachine.<anonymous>）
  const withCol = stack.match(/<anonymous>:(\d+):\d+/)
  if (withCol) return Math.max(1, Number(withCol[1]) - 1)
  // 语法错误栈无列号形态（evalmachine.<anonymous>:N）
  const noCol = stack.match(/<anonymous>:(\d+)\b/)
  if (noCol) return Math.max(1, Number(noCol[1]) - 1)
  // 无行号信息 → undefined（此前返回 1 会**谎报「第 1 行」**；errors 侧 `loc.line ?` 判定据此省略行号）
  return undefined
}

// ── jsLib 两形态（裸文本 / URL 字典）───────────────────────────────
// 裸 JS 文本，或 `{"名字":"https://…/x.js"}` URL 字典（下载后按 URL 原文缓存）。解析发生在 evalJs
// 顶部——SYNC_WORKER_RE 因此能看到下载后的库代码，库里含 java.ajax 的源才会被正确送进 worker。
const JSLIB_URL_CACHE_MAX = 32
const jsLibUrlCache = new Map<string, string>()

/** 值是 URL 字典才返回清单；否则 null（裸 JS 文本里出现 `{` 开头对象字面量的形态不当字典解析） */
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
        // 下载失败如实抛（错误文案「下载jsLib-<url>失败」）：少一层库会让后面的脚本
        // 报「xxx is not a function」，把库缺失伪装成脚本错误
        throw new JsSandboxError(`jsLib 下载失败：${url}（${e instanceof Error ? e.message : String(e)}）`, { ...loc, facet, script: jsLib.slice(0, 200) })
      }
      if (jsLibUrlCache.size >= JSLIB_URL_CACHE_MAX) jsLibUrlCache.delete(jsLibUrlCache.keys().next().value as string)
      jsLibUrlCache.set(url, body)
    }
    parts.push(body)
  }
  return parts.join('\n')
}
