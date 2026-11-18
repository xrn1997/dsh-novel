/**
 * Packages 影子宿主面（`__pkg.*`）：`Packages.*` 包路径仿真里需要宿主能力的重活
 * （PNG 解码 / AES-CBC / HMAC / 字节按 charset 解码 / HTTP cookie jar 读写）。
 *
 * 为什么单独成 module：与元素面同款——op 名若分散在 BOOTSTRAP 串与宿主 switch 里，就没有名册。
 * op 名册、宿主实现与沙箱侧 wrapper 源片段同住这里；轻活（流/数组/包装/包路径代理）仍在
 * vm realm 的 wrapper 片段里，界线见 `ADR-0004`。
 *
 * 接口只有「op 名 + JSON → JSON」；外部依赖窄成一格 `httpCookies`（登录面脚本读请求层同一张 jar），
 * 不把整个 `BridgeDeps` 带进来。字节载荷 = number[]（0-255），返回同样纯 JSON。
 */
import crypto from 'node:crypto'
import type { EvalContext } from './types.js'
import { decodePngToArgb, javaDecode, textOf } from './js-utils.js'

/** op 名册：**唯一来源**。宿主分派按它收窄（漏分支 = 编译错），沙箱侧 wrapper 片段里的
 *  op 字面量由测试与它逐一对表（`tests/engine/host-surface-pkg.test.ts`）。 */
export const PKG_OPS = ['png', 'aes', 'hmac', 'b2s', 'cookieGet', 'cookieSet', 'cookieRemoveSession'] as const
export type PkgOp = (typeof PKG_OPS)[number]

const PKG_OP_SET: ReadonlySet<string> = new Set(PKG_OPS)

/** 线上来的 op 名先过名册（认得才收窄）；认不出一律点名，不落到 `switch` 的兜底当未知分支。 */
function pkgOpOf(op: string): PkgOp {
  if (PKG_OP_SET.has(op)) return op as PkgOp
  throw new Error(`未知 Packages 桥操作：${op}`)
}

/** 包面唯一的外部依赖：请求层 cookie jar（域/路径感知那张；缺席 = 该源未接线）。 */
export type PkgHostDeps = Pick<EvalContext, 'httpCookies'>

/** PNG 像素上限（400 万）：策略值住宿主这层，解码器只提供闸口——**在 IHDR 处判**而不是解完再判，
 *  否则挡不住它守的那次分配（膨胀 + `height × rowBytes` 的图像缓冲 + 逐像素 ARGB 数组）。 */
const MAX_PNG_PIXELS = 4_000_000

/** `__pkg.*` 宿主实现（Packages.* 的重活）：入参/出参纯 JSON（字节 = number[]，0-255）。
 *  png → decodePngToArgb（node:zlib）；aes → AES-CBC 解密（DECRYPT 单向——v1 只做正文解密）；
 *  hmac → HmacSHA*；b2s → 字节按 charset 解码。未知操作与非法输入一律抛错（宁炸不猜）。 */
export function pkgHostOp(op: string, payload: Record<string, unknown>, deps: PkgHostDeps): unknown {
  const known = pkgOpOf(op)
  const toBytes = (v: unknown): Uint8Array => {
    if (!Array.isArray(v)) throw new Error('字节载荷需为 number[]')
    return Uint8Array.from(v.map((n) => (Number(n) || 0) & 0xff))
  }
  switch (known) {
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
        throw new Error(`AES-CBC 解密失败（${e instanceof Error ? e.message : textOf(e)}）`, { cause: e })
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
    case 'cookieGet': {
      const jar = deps.httpCookies
      if (jar === undefined) throw new Error('cookie jar 未接线：该源未提供 HTTP cookie jar')
      return jar.headerFor(textOf(payload.url ?? ''))
    }
    case 'cookieSet': {
      const jar = deps.httpCookies
      if (jar === undefined) throw new Error('cookie jar 未接线：该源未提供 HTTP cookie jar')
      jar.setCookie(textOf(payload.url ?? ''), textOf(payload.cookie ?? ''))
      return null
    }
    case 'cookieRemoveSession': {
      const jar = deps.httpCookies
      if (jar === undefined) throw new Error('cookie jar 未接线：该源未提供 HTTP cookie jar')
      jar.removeSessionCookies()
      return null
    }
    default: {
      // 名册与分派互为闭包：名册加一个 op 而这里没跟上，编译期就红（known 收窄不完）。
      const exhaustive: never = known
      throw new Error(`未知 Packages 桥操作：${String(exhaustive)}`)
    }
  }
}

/** 沙箱侧 wrapper 源片段：插进同一个 BOOTSTRAP 模板串，定义 Packages 包路径仿真（`pkgCall` /
 *  轻活包装 / 惰性未挂路径代理 / `JavaImporter` 作用域）。
 *
 *  插入位置与次序：**后于** `host-surface-elem.ts` 的片段（`mkElem` 由它供出），**先于** 引导层
 *  末尾的 `g.java` 挂载段。生成文本被当**文本**插值进模板串，故不得含反引号或美元花括号（钉子：
 *  `tests/engine/host-surface-pkg.test.ts`）。
 *
 *  片段可以自由引用的标识符只限 BOOTSTRAP 作用域供出的名字：`g`（全局对象）、`call`（唯一跨界
 *  入口）、`callHost`（错误换 realm）、`ser`（JSON 序列化）、`msg`（错误取消息）、`materialize`
 *  （响应描述符物化）、`mkElem`（元素包装，来自 elem 片段）、`sync`（同步桥包装），以及
 *  `js-protocol.asyncBridgeSource()` 生成的同步桥壳（本片段用到的 `urlConn` 就是其一）。
 *  多引一个名字就是脚本运行期 ReferenceError。 */
export function pkgWrapperSource(): string {
  return `
  // ── Packages.*（书源脚本里的 Java 包路径仿真）─────────────────────
  // 重活（PNG 解码、AES、HMAC、charset 解码）走宿主
  // 调用 __pkg.*（JSON 序列化边界，与 __elem.* 同款纪律）；轻活（流/数组/包装）留在 vm realm 纯 JS。
  // 未知路径 → 如实报「不支持」。
  const pkgCall = function (op, payload) {
    try { return JSON.parse(call('__pkg.' + op, ser(payload))) } catch (e) { throw new Error(msg(e)) }
  }
  // CookieManager/CookieStore 读的是**请求层同一张 jar**（域/路径感知、Set-Cookie 自动落库）——
  // 不是上面按源隔离的 cookie 垫片；这两个包路径在沙箱里挂的也是引擎的 CookieStore。
  const cookieJarGet = function (u) {
    var v = pkgCall('cookieGet', { url: String(u) })
    return v === '' ? null : v
  }
  const cookieJarSet = function (u, c) {
    pkgCall('cookieSet', { url: String(u), cookie: String(c) })
  }
  const cookieManager = {
    getCookie: cookieJarGet,
    setCookie: cookieJarSet,
    removeSessionCookies: function () { pkgCall('cookieRemoveSession', {}) },
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
      close: function () {},
      toString: function () { return '[ByteArrayInputStream len=' + buf.length + ' pos=' + pos + ']' },
    }
  }
  // java.net.URL.openConnection 的最小连接对象：同步桥走 urlConn（worker SAB），
  // 请求仍经注入的 ctx.fetchConn（同一守门 fetcher），不开裸 socket。
  const mkUrlConnection = function (rawUrl) {
    var method = 'GET'
    var headers = {}
    var body
    var outBytes = null
    var loaded = null
    var load = function () {
      if (loaded === null) loaded = urlConn({ url: String(rawUrl), method: method, headers: headers, body: body })
      return loaded
    }
    return {
      setRequestMethod: function (m) { method = String(m).toUpperCase() },
      setRequestProperty: function (k, v) { headers[String(k)] = String(v) },
      addRequestProperty: function (k, v) { headers[String(k)] = String(v) },
      setConnectTimeout: function () {},
      setReadTimeout: function () {},
      setDoOutput: function (v) { if (v) outBytes = [] },
      getOutputStream: function () {
        outBytes = []
        return {
          write: function (x) {
            if (Array.isArray(x)) { for (var i = 0; i < x.length; i++) outBytes.push(x[i] & 255) }
            else outBytes.push((+x) & 255)
          },
          flush: function () {}, close: function () {},
        }
      },
      getInputStream: function () {
        if (outBytes !== null) {
          var s = ''
          for (var i = 0; i < outBytes.length; i++) s += String.fromCharCode(outBytes[i])
          body = s
          outBytes = null
        }
        return mkBytesStream(load().bytes || [])
      },
      getResponseCode: function () { return load().statusCode },
      getHeaderField: function (n) {
        var h = load().headers || {}
        var k = String(n).toLowerCase()
        for (var key in h) if (key.toLowerCase() === k) return h[key]
        return null
      },
      getContent: function () { return load().bytes || [] },
      getURL: function () { return String(rawUrl) },
      disconnect: function () {}, close: function () {},
    }
  }
  g.Packages = {
    // Packages.org.jsoup.Jsoup.parse(html)：脚本里的 Java 包路径写法，与下方 g.org.jsoup.Jsoup.parse
    // 同一份实现（脚本两种写法在输入里都有；BOOTSTRAP 是模板字符串，注释里不能出现反引号）。
    org: { jsoup: { Jsoup: { parse: function (html) { return mkElem(String(html)) } } } },
    java: {
      net: {
        URL: function (u) {
          this._url = String(u)
          this.openConnection = function () { return mkUrlConnection(this._url) }
          this.toString = function () { return this._url }
          this.valueOf = function () { return this._url }
        },
      },
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
          const s = JSON.parse(callHost('__pkg.b2s', ser({ bytes: bytes, charset: charset || 'UTF-8' })))
          return { toString: function () { return s }, valueOf: function () { return s } }
        },
        // 登录面脚本的延迟检测形态用它取时间戳；vm 内 Date 与宿主时钟同源
        System: { currentTimeMillis: function () { return Date.now() } },
      },
      util: {
        Arrays: {
          // copyOfRange 语义（负索引从尾数、越长补 0）——脚本用 (0,48)/(48,len) 两形态
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
            // 注意：BOOTSTRAP 是模板字符串，正则字面量里的斜杠转义会被模板层吃掉成 / 截断正则——
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
                return JSON.parse(callHost('__pkg.aes', ser({ key: st.key, iv: st.iv, data: data })))
              },
            }
          },
        },
        Mac: {
          getInstance: function (algo) {
            const a = String(algo)
            if (!/^HmacSHA(1|256|512)$/.test(a)) throw new Error('不支持的 Mac 算法：' + algo)
            const st = { key: null, parts: [] }
            // Mac 契约：update(byte[]) 累加、update(byte) 追加单字节、doFinal() 结算后复位、
            // doFinal(input) ≡ update(input) + doFinal()。认不出的字节载荷形态如实抛，不静默丢弃
            // 不要静默丢弃：丢弃会产出零字节签名，站点拒给空/乱正文，是静默错值而不是报错。
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
                return JSON.parse(callHost('__pkg.hmac', ser({ algo: a, key: st.key, data: data })))
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
          // ARGB int 用 32 位有符号位移语义（脚本 (rgb>>16)&0xFF 取 R 通道成立）
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
      // base64DecodeToByteArray（单一实现）。flags 在这里不构成可观测分支；偏离与判据见
      // tests/engine/legado-gaps.test.ts 的 E-4，别在这儿再写一份判据。
      util: {
        Base64: { decode: sync('base64DecodeToByteArray') },
      },
      // 登录面脚本：CookieManager.getInstance().getCookie(u) 与
      // CookieStore.setCookie(u, ck)——同一张 HTTP jar（见上面 cookieJarGet/Set）。
      webkit: {
        CookieManager: { getInstance: function () { return cookieManager } },
      },
    },
    io: {
      legado: {
        app: {
          help: {
            http: {
              CookieStore: {
                getCookie: cookieJarGet,
                setCookie: cookieJarSet,
              },
              // 登录校验脚本的响应替换形态：new Packages.io.legado.app.help.http.StrResponse(url, body)
              // （输入脚本有这一写法）。两端契约是 login-check 认的 __host:'response' + __data。
              StrResponse: function (url, body) {
                this.__host = 'response'
                this.__data = {
                  url: String(url === null || url === undefined ? '' : url),
                  body: body === null || body === undefined ? '' : String(body),
                  statusCode: 200, headers: {}, cookies: {}, contentType: '', charset: '',
                }
                var self = this
                this.url = function () { return self.__data.url }
                this.body = function () { return self.__data.body }
                this.code = function () { return 200 }
                this.statusCode = function () { return 200 }
                this.headers = function () { return materialize({ __host: 'map', entries: {} }) }
                this.header = function () { return '' }
                this.cookies = function () { return materialize({ __host: 'map', entries: {} }) }
              },
            },
          },
        },
      },
    },
  }
  // 未知包路径**如实点名**（Packages 是惰性命名空间：取到名字不炸、用到才炸——本代理按此口径同语义）。
  // 未实现路径必须点名到包路径：普通对象字面量会取到 undefined → 抛裸 TypeError，既说不清是哪条
  // 包路径，也不在审计归因的任何锚点里。
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
        if (k === '__pkgPath') return path
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
  // pkgWrap 只包对象；String/URL/流这几个函数类拿不到 __pkgPath。把已挂载的函数类路径钉成
  // 一张小表，importClass 才能按简单名绑定（对象类由 pkgWrap 的 __pkgPath 自报）。
  ;[
    ['java.lang.String', g.Packages.java.lang.String],
    ['java.net.URL', g.Packages.java.net.URL],
    ['java.io.ByteArrayInputStream', g.Packages.java.io.ByteArrayInputStream],
    ['java.io.ByteArrayOutputStream', g.Packages.java.io.ByteArrayOutputStream],
  ].forEach(function (pair) {
    if (pair[1] !== null && pair[1] !== undefined) pair[1].__pkgPath = pair[0]
  })
  // JavaImporter / importPackage / loadClass：只注入已挂载的 Packages 路径。
  // with (Importer) 依赖 sloppy 作用域（书源脚本按 sloppy 执行），作用域对象就是本函数返回的普通对象。
  const pkgAt = function (path) {
    var obj = g.Packages
    for (var i = 0; i < path.length; i++) {
      if (obj === null || obj === undefined) return undefined
      obj = obj[path[i]]
    }
    return obj
  }
  const JavaImporter = function () {
    var scope = {}
    for (var i = 0; i < arguments.length; i++) {
      var p = arguments[i]
      var path = p && p.__pkgPath
      if (path === undefined) continue
      var pkg = pkgAt(path === '' ? [] : String(path).split('.'))
      if (pkg === null || pkg === undefined) continue
      var keys = Object.keys(pkg)
      for (var j = 0; j < keys.length; j++) scope[keys[j]] = pkg[keys[j]]
    }
    return scope
  }
  g.JavaImporter = JavaImporter
  g.importPackage = function (p) {
    var s = JavaImporter(p)
    for (var k in s) g[k] = s[k]
  }
  // importClass 把类绑到当前作用域的简单名（不是只把类原样返回）。Packages 里的类名首字母
  // 大写、包名不是——这里只收已挂载的类；包路径与未挂载路径如实拒绝/留给惰性代理点名。
  g.importClass = function (cls) {
    var path = cls && cls.__pkgPath
    if (typeof path !== 'string' || path === '') return cls
    var parts = path.split('.')
    var name = parts[parts.length - 1]
    if (!/^[A-Z]/.test(name)) throw new Error('importClass 需要已挂载的类：' + path)
    var resolved = pkgAt(parts)
    if (resolved === null || resolved === undefined) return cls
    g[name] = resolved
    return cls
  }
  g.loadClass = function (path) { return pkgAt(String(path).split('.')) }
`
}
