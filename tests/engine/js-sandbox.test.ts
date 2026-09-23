import { describe, expect, it } from 'vitest'
import { load } from 'cheerio'
import { createSourceSession, evalJs, runScript } from '../../src/engine/js-sandbox.js'
import type { JsHost } from '../../src/engine/js-sandbox.js'
import { JsSandboxError } from '../../src/engine/errors.js'
import type { EngineValue, EvalContext } from '../../src/engine/types.js'

const ctxOf = (over: Partial<EvalContext> = {}): EvalContext => ({
  baseUrl: 'https://m.example.com/read/1',
  source: 'https://m.example.com',
  vars: {},
  ...over,
})
const hostOf = (over: Partial<JsHost> = {}): JsHost => ({
  result: '',
  baseUrl: 'https://m.example.com/read/1',
  source: 'https://m.example.com',
  ...over,
})
const L = { segmentIndex: 0, segmentRaw: '@js:test' }
const run = (
  code: string,
  host: JsHost = hostOf(),
  ctx: EvalContext = ctxOf(),
  evaluateRef?: (rule: string, data: unknown, baseUrl?: string) => EngineValue,
) => evalJs(code, host, ctx, L, 'content', evaluateRef)

describe('@js 沙箱', () => {
  it('基本求值：字符串/数组/空值/对象 → 四种 EngineValue', async () => {
    expect((await run('return "hi"')).value).toEqual({ kind: 'value', text: 'hi' })
    expect((await run('return ["a","b"]')).value).toEqual({ kind: 'list', items: ['a', 'b'] })
    expect((await run('return null')).value.kind).toBe('miss')
    expect((await run('return undefined')).value.kind).toBe('miss')
    expect((await run('return ""')).value.kind).toBe('miss')
    expect((await run('return {x:1}')).value).toEqual({ kind: 'value', text: '{"x":1}' })
    expect((await run('return 42')).value).toEqual({ kind: 'value', text: '42' })
    expect((await run('return 1 + 1')).value).toEqual({ kind: 'value', text: '2' })
  })

  it('顶层 await 生效（async IIFE）', async () => {
    const v = await run('const x = await Promise.resolve(5); return x * 2')
    expect(v.value).toEqual({ kind: 'value', text: '10' })
  })

  it('宿主变量注入：result/baseUrl/source', async () => {
    const v = await run('return baseUrl + "|" + source')
    expect(v.value).toEqual({ kind: 'value', text: 'https://m.example.com/read/1|https://m.example.com' })
    const v2 = await run('return result.length', hostOf({ result: 'prev-segment-text' }))
    expect(v2.value).toEqual({ kind: 'value', text: '17' })
  })

  it('console 收集进 logs，不外泄', async () => {
    const v = await run('console.log("dbg", 1); console.error("warn: x"); return "ok"')
    expect(v.value).toEqual({ kind: 'value', text: 'ok' })
    expect(v.logs).toEqual(['dbg 1', 'warn: x'])
  })

  it('同步死循环超时熔断 → JsSandboxError（脚本超时）', async () => {
    await expect(run('while(true){}', hostOf(), ctxOf({ jsTimeoutMs: 200 }))).rejects.toThrow(/脚本超时/)
    await expect(run('while(true){}', hostOf(), ctxOf({ jsTimeoutMs: 200 }))).rejects.toThrow(JsSandboxError)
  })

  it('异步永不 settle 也被 jsTimeoutMs 约束（外层硬超时）', async () => {
    const err = await run('await new Promise(() => {}); return 1', hostOf(), ctxOf({ jsTimeoutMs: 150 }))
      .then(() => null, (e) => e)
    expect(err).toBeInstanceOf(JsSandboxError)
    expect(String(err.message)).toMatch(/脚本超时（>150ms）/)
  })

  it('沙箱逃逸：require/process/global 不可见（typeof 返回字符串 undefined）', async () => {
    // 钉死（controller ruling）：typeof 探测未声明全局返回字符串 'undefined'（合法 Value），不是 Miss
    expect((await run('return typeof require')).value).toEqual({ kind: 'value', text: 'undefined' })
    expect((await run('return typeof process')).value).toEqual({ kind: 'value', text: 'undefined' })
    expect((await run('return typeof global')).value).toEqual({ kind: 'value', text: 'undefined' })
    expect((await run('return typeof globalThis.require')).value).toEqual({ kind: 'value', text: 'undefined' })
  })

  it('沙箱逃逸：代码生成被禁（Function 构造器 / eval 均 EvalError）', async () => {
    const v1 = await run('try { Function("return 1"); return "escaped" } catch (e) { return "blocked:" + e.name }')
    expect(v1.value).toEqual({ kind: 'value', text: 'blocked:EvalError' })
    const v2 = await run('try { eval("1+1"); return "escaped" } catch (e) { return "blocked:" + e.name }')
    expect(v2.value).toEqual({ kind: 'value', text: 'blocked:EvalError' })
  })

  it('沙箱逃逸：宿主 realm 不可达（构造器链 / 错误对象 / 返回的 Promise / 引导入口）', async () => {
    // 宿主函数的 .constructor（跨 realm Function）：console/java 均为 vm realm 包装 → EvalError
    const v3 = await run('try { return "escaped:" + console.log.constructor("return 1")() } catch (e) { return "blocked:" + e.name }')
    expect(v3.value).toEqual({ kind: 'value', text: 'blocked:EvalError' })
    const v3b = await run('try { return "escaped:" + java.get.constructor("return 1")() } catch (e) { return "blocked:" + e.name }')
    expect(v3b.value).toEqual({ kind: 'value', text: 'blocked:EvalError' })
    // 宿主抛出的错误（如守门 JsSandboxError）跨 realm 后须为 vm Error，其构造器链同样被禁
    const v4 = await run(
      'try { await java.ajax("u") } catch (e) { try { return "escaped:" + e.constructor.constructor("return 1")() } catch (x) { return "blocked:" + x.name + "|" + e.message.includes("网络能力") } }',
      hostOf(),
      ctxOf(),
    )
    expect(v4.value).toEqual({ kind: 'value', text: 'blocked:EvalError|true' })
    // ajax 返回的 Promise 为 vm realm Promise，构造器链被禁
    const v5 = await run('try { return "escaped:" + java.ajax.constructor("return 1")() } catch (e) { return "blocked:" + e.name }')
    expect(v5.value).toEqual({ kind: 'value', text: 'blocked:EvalError' })
    // 引导入口 __host_call__ 已从全局锁死，不可恢复
    const v6 = await run('return [typeof __host_call__, typeof __init__].join(",")')
    expect(v6.value).toEqual({ kind: 'value', text: 'number,number' })
  })

  it('java.get/put 读写 ctx.vars', async () => {
    const ctx = ctxOf()
    await run('java.put("k","v"); return "x"', hostOf(), ctx)
    expect(ctx.vars!.k).toBe('v')
    expect((await run('return java.get("k")', hostOf(), ctxOf({ vars: { k: 'vv' } }))).value).toEqual({ kind: 'value', text: 'vv' })
    expect((await run('return java.get("nope")')).value.kind).toBe('miss')
  })

  it('摘要 / HMAC 族**经沙箱可达**（回归钉子：它们曾同时躺在协议表与宿主桩名单里，桩后挂覆盖真实现）', async () => {
    // 期望值是 "abc" 的公开 MD5 / 与协议表用例同源（openssl 独立算出）
    const md5 = await run('return java.digestHex("abc", "MD5")')
    expect(md5.value).toEqual({ kind: 'value', text: '900150983cd24fb0d6963f7d28e17f72' })
    const b64 = await run('return java.digestBase64Str("abc", "MD5")')
    expect(b64.value.kind).toBe('value')
    const hmac = await run('return java.HMacHex("Hi There", "HmacSHA256", String.fromCharCode(11).repeat(20))')
    expect(hmac.value).toEqual({ kind: 'value', text: 'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7' })
    // 真没有实现的仍须点名抛，不许被这条改动顺手放宽
    await expect(run('return java.replaceFont("a", "b")')).rejects.toThrow(/需要安卓宿主环境/)
  })

  it('java.getWebViewUA：取 ctx.userAgent 给的**出站 UA**（近似口径）；未接线则点名，不编值', async () => {
    const withUa = await run('return java.getWebViewUA()', hostOf(), ctxOf({ userAgent: () => 'UA-from-fetch' }))
    expect(withUa.value).toEqual({ kind: 'value', text: 'UA-from-fetch' })
    await expect(run('return java.getWebViewUA()')).rejects.toThrow(/取不到出站 UA/)
    // androidId 现在也是点名桩（不是 TypeError: is not a function）——脚本能看懂差在哪
    await expect(run('return java.androidId()')).rejects.toThrow(/需要安卓宿主环境/)
  })
  it('java.connect(url) → 对面 StrResponse 形态（对象 {url, body}，不是串）', async () => {
    const ctx = ctxOf({ fetch: async (u) => ({ body: 'B:' + u }) })
    const v = await run(
      'const r = await java.connect("https://m.example.com/a"); return r.url + "|" + r.body',
      hostOf(), ctx,
    )
    expect(v.value).toEqual({ kind: 'value', text: 'https://m.example.com/a|B:https://m.example.com/a' })
  })
  it('java.connect 的第二实参（对面是 header JSON）本仓无请求头通道 → 点名，不静默丢掉', async () => {
    const ctx = ctxOf({ fetch: async () => ({ body: 'z' }) })
    await expect(run('return (await java.connect("https://m.example.com/a", "{\\"Referer\\":\\"https://r\\"}")).body', hostOf(), ctx))
      .rejects.toThrow(/header|请求头/)
  })
  it('java.post(url, body, headers) → 对面 Jsoup Response 的**方法壳**（res.body() / res.cookies()）', async () => {
    const seen: Array<[string, string, Record<string, string> | undefined]> = []
    const ctx = ctxOf({
      fetchPost: async (u, b, h) => {
        seen.push([u, b, h])
        return { url: 'https://m.example.com/final', body: 'BODY', contentType: 'application/json', statusCode: 200, cookies: { sid: 'abc' } }
      },
    })
    const v = await run(
      'const r = await java.post("https://m.example.com/a", "k=1", { \'Content-Type\': \'application/x-www-form-urlencoded\' })' +
      '; return r.body() + "|" + r.statusCode() + "|" + r.url() + "|" + r.cookies().sid',
      hostOf(), ctx,
    )
    expect(v.value).toEqual({ kind: 'value', text: 'BODY|200|https://m.example.com/final|abc' })
    // 第三参：对面形参是 Map<String,String>——脚本内联给 JS 对象（独立合集里的真形态），
    // 也接受 JSON 串（Rhino 侧由 Gson 转）；两种都要落到同一份头表
    expect(seen[0][0]).toBe('https://m.example.com/a')
    expect(seen[0][1]).toBe('k=1')
    expect(seen[0][2]).toEqual({ 'Content-Type': 'application/x-www-form-urlencoded' })
    const viaJson = await run(
      'return (await java.post("https://m.example.com/b", "x", "{\\"a\\":\\"b\\"}")).body()', hostOf(), ctx,
    )
    expect(viaJson.value).toEqual({ kind: 'value', text: 'BODY' })
    expect(seen[1][2]).toEqual({ a: 'b' })
  })
  it('java.post 的 header 不是 JSON → 点名（不静默丢脚本的请求头）；未接 fetchPost → 点名', async () => {
    const ctx = ctxOf({ fetchPost: async () => ({ url: 'u', body: '', statusCode: 200, cookies: {} }) })
    await expect(run('return (await java.post("https://m.example.com/a", "b", "{oops")).body()', hostOf(), ctx))
      .rejects.toThrow(/不是 JSON/)
    await expect(run('return (await java.post("https://m.example.com/a", "b")).body()'))
      .rejects.toThrow(/ctx.fetchPost 缺失/)
  })
  it('java.ajax 走注入 fetch（守门），返回 Promise 可 await', async () => {
    const calls: string[] = []
    const ctx = ctxOf({
      fetch: async (u) => {
        calls.push(u)
        return { body: '<p>ok</p>' }
      },
    })
    const v = await run(
      'const h = await java.ajax("https://m.example.com/x"); return h.length > 0 ? "有内容" : "空"',
      hostOf(),
      ctx,
    )
    expect(calls).toEqual(['https://m.example.com/x'])
    expect(v.value).toEqual({ kind: 'value', text: '有内容' })
  })

  it('java.ajax 无 ctx.fetch → JsSandboxError（该源未提供网络能力）', async () => {
    const err = await run('await java.ajax("https://m.example.com/x")', hostOf(), ctxOf()).then(() => null, (e) => e)
    expect(err).toBeInstanceOf(JsSandboxError)
    expect(String(err.message)).toMatch(/网络能力/)
  })

  it('脚本抛错 → JsSandboxError 带脚本原文与行号', async () => {
    const err = await run('null.x').then(() => null, (e) => e)
    expect(err).toBeInstanceOf(JsSandboxError)
    expect(err.script).toBe('null.x')
    expect(String(err.message)).toMatch(/脚本/)
    // 多行脚本：错误在用户脚本第 2 行（wrapper 首行偏移 1）
    const err2 = await run('const a = 1\nnull.x').then(() => null, (e) => e)
    expect(err2.line).toBe(2)
  })

  it('语法错误 → JsSandboxError（编译失败）', async () => {
    const err = await run('return )').then(() => null, (e) => e)
    expect(err).toBeInstanceOf(JsSandboxError)
    expect(String(err.message)).toMatch(/编译|同步执行失败/)
  })

  it('md5/base64 往返', async () => {
    expect((await run('return java.base64Encode("abc")')).value).toEqual({ kind: 'value', text: 'YWJj' })
    expect((await run('return java.base64Decode("YWJj")')).value).toEqual({ kind: 'value', text: 'abc' })
    expect((await run('return java.md5Encode("abc")')).value)
      .toEqual({ kind: 'value', text: '900150983cd24fb0d6963f7d28e17f72' }) // md5("abc") 标准向量
    expect((await run('return java.md5Encode16("abc")')).value)
      .toEqual({ kind: 'value', text: '3cd24fb0d6963f7d' }) // 32 位 md5 取中 16 位（legado 语义）
  })

  it('java.timeFormat：yyyy/MM/dd HH:mm（本地时区手排）', async () => {
    const ts = 1700000000000
    const d = new Date(ts)
    const p2 = (n: number) => String(n).padStart(2, '0')
    const expected = `${d.getFullYear()}/${p2(d.getMonth() + 1)}/${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`
    expect((await run(`return java.timeFormat(${ts})`)).value).toEqual({ kind: 'value', text: expected })
  })

  it('evaluateRef 未注入：getString* 抛清晰 JsSandboxError（接线）', async () => {
    const err = await run('return java.getString("@css:h1")').then(() => null, (e) => e)
    expect(err).toBeInstanceOf(JsSandboxError)
    expect(String(err.message)).toMatch(/evaluateRef/)
    const err2 = await run('return java.getStringList("@css:p")').then(() => null, (e) => e)
    expect(err2).toBeInstanceOf(JsSandboxError)
    const err3 = await run('return java.getElements("@css:p")').then(() => null, (e) => e)
    expect(err3).toBeInstanceOf(JsSandboxError)
  })

  it('evaluateRef 注入后：getString/getStringList 经其递归求值并对 result 序列化', async () => {
    const fake = (rule: string, data: unknown): EngineValue => ({ kind: 'value', text: `X(${rule}|${data})` })
    const v = await run('return java.getString("@css:h1")', hostOf({ result: 'prev' }), ctxOf(), fake)
    expect(v.value).toEqual({ kind: 'value', text: 'X(@css:h1|prev)' })
    const fakeList = (): EngineValue => ({ kind: 'list', items: ['a', 'b'] })
    const v2 = await run('return java.getStringList("@css:p")', hostOf(), ctxOf(), fakeList)
    expect(v2.value).toEqual({ kind: 'list', items: ['a', 'b'] })
    // miss → getString 返回 ''（脚本里再 return '' → Miss）
    const fakeMiss = (): EngineValue => ({ kind: 'miss', detail: 'no hit' })
    const v3 = await run('return java.getString("@css:none")', hostOf(), ctxOf(), fakeMiss)
    expect(v3.value.kind).toBe('miss')
  })

  it('getElements：evaluateRef 返回 nodes → 元素包装对象（.text()/.attr()/String()——legado 方法面）', async () => {
    const $ = load('<h1 class="t">标题</h1><p>正文</p>')
    const fake = (): EngineValue => ({ kind: 'nodes', nodes: $('h1') })
    const v = await run(
      'const els = java.getElements("@css:h1"); return els.length + "|" + els[0].text() + "|" + String(els[0]) + "|" + els[0].attr("class") + "|" + els[0].attr("href")',
      hostOf(),
      ctxOf(),
      fake,
    )
    expect(v.value).toEqual({ kind: 'value', text: '1|标题|<h1 class="t">标题</h1>|t|' })
  })

  it('getString 二参布尔 = unescape 开关（对面双参重载），不再被当 isUrl 抛错', async () => {
    // 本行原先钉的是「isUrl=true 守门必炸」——那条守门建在误读上：对面第二参是 unescape，
    // isUrl 在第三参，且 isUrl 也**不抓取**（只绝对化）。见 matrix h-get-string-is-url。
    const fake = (): EngineValue => ({ kind: 'value', text: 'X' })
    const unescapeOn = await run('return java.getString("@css:h1", true)', hostOf(), ctxOf(), fake)
    expect(unescapeOn.value).toEqual({ kind: 'value', text: 'X' })
    // 第三参才是 isUrl：产物按 base 绝对化（相对段落在 base 的目录下——对面同样是 `URL(base, rel)`），
    // 全程不碰网络：这条路径没有任何 fetch 通道，实现若去抓取会当场抛「该源未提供网络能力」
    const isUrl = await run('return java.getString("@css:h1", null, true)', hostOf(), ctxOf(), fake)
    expect(isUrl.value).toEqual({ kind: 'value', text: 'https://m.example.com/read/X' })
    // unescape=false 与缺省同样走递归求值（对面缺省是 true：本例文本不含实体，两种取值同形）
    expect((await run('return java.getString("@css:h1", false)', hostOf(), ctxOf(), fake)).value)
      .toEqual({ kind: 'value', text: 'X' })
    expect((await run('return java.getString("@css:h1")', hostOf(), ctxOf(), fake)).value)
      .toEqual({ kind: 'value', text: 'X' })
  })
})

// ── 宿主垫片扩展（616 broken 归因：真实源 @js 依赖这些 API）────────────────

describe('宿主垫片（真实源用到的缺失 API）', () => {
  it('java.log ≡ console.log（53 处使用——缺它整个脚本炸）', async () => {
    const v = await run('java.log("dbg", 2); return "ok"')
    expect(v.value).toEqual({ kind: 'value', text: 'ok' })
    expect(v.logs).toEqual(['dbg 2'])
  })
  it('java.encodeURI → encodeURIComponent 语义（中文/空格/斜杠）', async () => {
    expect((await run('return java.encodeURI("书")')).value).toEqual({ kind: 'value', text: '%E4%B9%A6' })
    expect((await run('return java.encodeURI("a b/c")')).value).toEqual({ kind: 'value', text: 'a%20b%2Fc' })
  })
  it('java.getElement → 首个元素包装（无命中 → null）', async () => {
    const $ = load('<h1>标题</h1><p>正文</p>')
    const fake = (): EngineValue => ({ kind: 'nodes', nodes: $('h1') })
    const v = await run('const e = java.getElement("@css:h1"); return e === null ? "null" : e.text()', hostOf(), ctxOf(), fake)
    expect(v.value).toEqual({ kind: 'value', text: '标题' })
    const miss = (): EngineValue => ({ kind: 'miss', detail: 'x' })
    const v2 = await run('return java.getElement("@css:none") === null ? "null" : "x"', hostOf(), ctxOf(), miss)
    expect(v2.value).toEqual({ kind: 'value', text: 'null' })
  })
  it('java.setContent：后续 getString 以设定内容为基（而非上一段 result）', async () => {
    const seen: unknown[] = []
    const fake = (_rule: string, data: unknown): EngineValue => { seen.push(data); return { kind: 'value', text: String(data) } }
    const v = await run('java.setContent("<h1>新基</h1>"); return java.getString("@css:h1")', hostOf({ result: '旧result' }), ctxOf(), fake)
    expect(seen[0]).toBe('<h1>新基</h1>')
    expect(v.value).toEqual({ kind: 'value', text: '<h1>新基</h1>' })
  })
  it('source 对象化：source.getKey()/source.key = baseUrl，字符串拼接语义保留', async () => {
    expect((await run('return source.getKey()')).value).toEqual({ kind: 'value', text: 'https://m.example.com' })
    expect((await run('return source.key')).value).toEqual({ kind: 'value', text: 'https://m.example.com' })
    expect((await run('return "" + source')).value).toEqual({ kind: 'value', text: 'https://m.example.com' })
    expect((await run('return source.key + "/api/search"')).value)
      .toEqual({ kind: 'value', text: 'https://m.example.com/api/search' })
  })
  it('cookie 垫片：set/get/remove 往返（按源隔离——最小仿真）', async () => {
    const ctx = ctxOf()
    await run('cookie.setCookie("token", "abc"); return "x"', hostOf(), ctx)
    expect((await run('return cookie.getCookie("token")', hostOf(), ctx)).value).toEqual({ kind: 'value', text: 'abc' })
    await run('cookie.removeCookie("token"); return "x"', hostOf(), ctx)
    expect((await run('return cookie.getCookie("token")')).value.kind).toBe('miss')
  })
  it('纯 UI 副作用方法（toast/copyText/startBrowser/open/openUrl）→ no-op 不炸脚本', async () => {
    const v = await run('java.toast("hi"); java.longToast("hi"); java.copyText("t"); java.startBrowser("https://a.com"); java.open("x"); java.openUrl("https://a.com"); return "ok"')
    expect(v.value).toEqual({ kind: 'value', text: 'ok' })
  })
  it('timeFormatUTC / hexDecodeToString', async () => {
    expect((await run('return java.timeFormatUTC(0)')).value).toEqual({ kind: 'value', text: '1970/01/01 00:00' })
    expect((await run('return java.hexDecodeToString("e4bda0")')).value).toEqual({ kind: 'value', text: '你' })
  })
  it('无法仿真的安卓宿主 API（webView/android.*）→ 如实报不支持（不静默 no-op）', async () => {
    const err = await run('return java.webView("<p/>", "https://a.com", "")').then(() => null, (e) => e)
    expect(String(err.message)).toMatch(/不支持|未知/)
  })
  it('AES 解密桥（legado createSymmetricCrypto().decryptStr / aesBase64DecodeToString——Node crypto 实现）', async () => {
    const crypto = await import('node:crypto')
    const key = '0123456789abcdef'
    const cipher = crypto.createCipheriv('aes-128-cbc', Buffer.from(key, 'utf8'), Buffer.from(key, 'utf8'))
    const b64 = Buffer.concat([cipher.update(Buffer.from('你好章节', 'utf8')), cipher.final()]).toString('base64')
    const v = await run(
      `return java.createSymmetricCrypto("AES/CBC/PKCS5Padding","${key}","${key}").decryptStr("${b64}")`,
    )
    expect(v.value).toEqual({ kind: 'value', text: '你好章节' })
    const v2 = await run(`return java.aesBase64DecodeToString("${b64}","${key}","AES/CBC/PKCS5Padding","${key}")`)
    expect(v2.value).toEqual({ kind: 'value', text: '你好章节' })
    // 密文/密钥不对 → 如实报 AES 解密失败（宁炸，不返回假明文）；encryptStr v1 不支持
    const err = await run('return java.aesBase64DecodeToString("AAAA","0123456789abcdef","AES/CBC/PKCS5Padding","0123456789abcdef")').then(() => null, (e) => e)
    expect(String(err.message)).toMatch(/AES 解密失败/)
    const err2 = await run(`return java.createSymmetricCrypto("AES/CBC/PKCS5Padding","${key}","${key}").encryptStr("x")`).then(() => null, (e) => e)
    expect(String(err2.message)).toMatch(/不支持/)
  })
  it('source.getVariable/setVariable 是**单串槽**（对面 BaseSource 的 sourceVariable_<key>）', async () => {
    const ctx = ctxOf()
    expect((await run('return source.getVariable() || "(空)"', hostOf(), ctx)).value).toEqual({ kind: 'value', text: '(空)' })
    // 对面 getVariable 直返那串——本仓曾把它做成「整表 JSON.stringify」，脚本按字符串用就拿到
    // 一层 JSON 壳（存自定义域名的源正是直接把这串拼进 URL 的写法）
    await run('source.setVariable("x.com"); return "ok"', hostOf(), ctx)
    expect((await run('return source.getVariable()', hostOf(), ctx)).value).toEqual({ kind: 'value', text: 'x.com' })
    await run('source.setVariable(JSON.stringify({host:"y.com"})); return "ok"', hostOf(), ctx)
    expect((await run('return JSON.parse(source.getVariable()).host', hostOf(), ctx)).value)
      .toEqual({ kind: 'value', text: 'y.com' })
  })
  it('source.get/put 键值表：与串槽、cache 各自一处（对面是三个不同前缀）', async () => {
    const ctx = ctxOf()
    await run('source.put("token", "t123"); source.put("searchMode", "author"); return "ok"', hostOf(), ctx)
    expect((await run('return source.get("token")', hostOf(), ctx)).value).toEqual({ kind: 'value', text: 't123' })
    // 对面 get 缺键返 ""（不是 null）；脚本 `source.get("x") || "def"` 两种形状同结果，
    // 但 `source.get("x") === ""` 这类判等只有对面形状才对
    expect((await run('return source.get("missing") === "" ? "空串" : String(source.get("missing"))', hostOf(), ctx)).value)
      .toEqual({ kind: 'value', text: '空串' })
    // 写串槽**不清**键值表（旧实现同一张 Map，setVariable 顺手 clear()）
    await run('source.setVariable("S"); return "ok"', hostOf(), ctx)
    expect((await run('return source.get("searchMode")', hostOf(), ctx)).value).toEqual({ kind: 'value', text: 'author' })
    expect((await run('return source.getVariable()', hostOf(), ctx)).value).toEqual({ kind: 'value', text: 'S' })
    // cache 与键值表也不互通
    await run('cache.put("ck","CV"); return "ok"', hostOf(), ctx)
    expect((await run('return cache.get("ck") + "|" + (source.get("ck") === "" ? "未串" : source.get("ck"))', hostOf(), ctx)).value)
      .toEqual({ kind: 'value', text: 'CV|未串' })
  })
  it('source.header / source.bookSourceName 可读（JSON.parse(source.header) 形态）', async () => {
    const host = hostOf({ header: '{"User-Agent":"Bot"}' })
    expect((await run('return JSON.parse(source.header)["User-Agent"]', host)).value)
      .toEqual({ kind: 'value', text: 'Bot' })
  })
})

describe('scriptForm（legado @js 口径：完成值即结果）', () => {
  const runScript = (code: string, host: JsHost = hostOf(), ctx: EvalContext = ctxOf()) =>
    evalJs(code, host, ctx, L, 'search', undefined, { scriptForm: true })

  it('裸表达式结尾（无 return）→ 最后一个表达式的值即结果', async () => {
    const v = await runScript('"https://a.com/s?key=" + encodeURIComponent(key) + "&p=" + page',
      hostOf({ key: '剑来', page: 3 }))
    expect(v.value).toEqual({ kind: 'value', text: 'https://a.com/s?key=%E5%89%91%E6%9D%A5&p=3' })
  })
  it('var 声明 + 多语句 → 完成值', async () => {
    const v = await runScript('var enc = encodeURIComponent(key);\nvar url = "https://a.com/" + enc;\nurl + "?p=" + page',
      hostOf({ key: 'x', page: 2 }))
    expect(v.value).toEqual({ kind: 'value', text: 'https://a.com/x?p=2' })
  })
  it('顶层 return → SyntaxError 回落函数体形态', async () => {
    const v = await runScript('return "https://ret/" + key', hostOf({ key: 'k' }))
    expect(v.value).toEqual({ kind: 'value', text: 'https://ret/k' })
  })
  it('顶层 await → 同样回落函数体形态', async () => {
    const v = await runScript('return await Promise.resolve("ok")')
    expect(v.value).toEqual({ kind: 'value', text: 'ok' })
  })
  it('result / baseUrl / source 全局可读（脚本形态）', async () => {
    const v = await runScript('result + "|" + baseUrl + "|" + source', hostOf({ result: 'R' }))
    expect(v.value).toEqual({ kind: 'value', text: 'R|https://m.example.com/read/1|https://m.example.com' })
  })
  it('空串结果 → Miss（如实，不产假值）', async () => {
    expect((await runScript('""')).value.kind).toBe('miss')
  })
  it('jsLib 先于用户代码执行：函数定义全局可见（legado 源级函数库口径）', async () => {
    const ctx = ctxOf({ jsLib: 'function host() { return "https://lib.example.com" }\nvar CONST_X = 42;' })
    const v = await evalJs('host() + "/" + key', hostOf({ key: 'k' }), ctx, L, 'search', undefined, { scriptForm: true })
    expect(v.value).toEqual({ kind: 'value', text: 'https://lib.example.com/k' })
    // 常量同样可见（qmSearchUrl.call(this, key, page) 类形态）
    const v2 = await evalJs('String(CONST_X)', hostOf(), ctx, L, 'search', undefined, { scriptForm: true })
    expect(v2.value).toEqual({ kind: 'value', text: '42' })
  })
  it('jsLib 抛错 → JsSandboxError 点名 jsLib（不吞不混）', async () => {
    const ctx = ctxOf({ jsLib: 'null.boom()' })
    await expect(evalJs('return "x"', hostOf(), ctx, L, 'search')).rejects.toThrow(/jsLib/)
  })
})

describe('jsLib 的 URL 字典形态（legado SharedJsScope：{"名":"https://…/x.js"}）', () => {
  const LIB = 'function signIt(x){ return "S:"+x }'
  const opts = (code: string, url: string, n: { v: number }, fail = false) => ({
    code, loc: { segmentIndex: 0, segmentRaw: '@js' }, facet: 'toc' as const,
    source: 'https://jslib.example.com',
    jsLib: `{"crypto":"${url}"}`,
    fetch: async () => {
      if (fail) throw new Error('404 not found')
      n.v++
      return { body: LIB }
    },
  })
  it('下载下来当库代码执行；同 URL 第二次不再下载（对面按 md5(url) 缓存）', async () => {
    const n = { v: 0 }
    const url = 'https://cdn.example/lib-a.js'
    expect((await runScript(opts('signIt("a")', url, n))).value).toEqual({ kind: 'value', text: 'S:a' })
    expect((await runScript(opts('signIt("b")', url, n))).value).toEqual({ kind: 'value', text: 'S:b' })
    expect(n.v).toBe(1)
  })
  it('下载失败 → 如实抛（jsLib 缺一段比整源脚本炸更好定位，不静默少一层库）', async () => {
    await expect(runScript(opts('signIt("a")', 'https://cdn.example/lib-b.js', { v: 0 }, true)))
      .rejects.toThrow(/jsLib 下载失败/)
  })
  it('有 URL 字典但没有网络能力 → 点名 ctx.fetch 缺失，不降级成空库', async () => {
    const o = opts('signIt("a")', 'https://cdn.example/lib-c.js', { v: 0 }) as Record<string, unknown>
    delete o.fetch
    await expect(runScript(o as never)).rejects.toThrow(/ctx\.fetch 缺失/)
  })
})

describe('链上 result 绑定的空集形态（真源 toc 模板：class.X@li<js>result.toArray()…）', () => {
  const HTML = '<div class="other"><li><a href="/1">第一章</a></li></div>'
  it('列表用途下前段零命中 → result 仍是空元素集（对面 Java Elements 空集合仍带方法）', async () => {
    const { evaluate } = await import('../../src/engine/index.js')
    const v = await evaluate('class.BCsectionTwo-top-chapter@li\n<js>result.toArray().length + "|" + result.size()</js>', { html: HTML }, 'toc', 'list')
    expect(v).toEqual({ kind: 'value', text: '0|0' })
  })
  it('取值用途下 miss 仍是字符串（不把标量链包成元素集）', async () => {
    const { evaluate } = await import('../../src/engine/index.js')
    const v = await evaluate('text.没有的东西\n<js>typeof result</js>', { html: HTML }, 'content', 'value')
    expect(v).toEqual({ kind: 'value', text: 'string' })
  })
})

describe('nodes 结果的元素集表面（对面 result 是 org.jsoup Elements，不是单个 Element）', () => {
  const HTML = '<ul class="c"><li><a href="/1">一</a></li><li><a href="/2">二</a></li><li><a href="/3">三</a></li></ul>'
  const runJs = async (code: string) => {
    const { evaluate } = await import('../../src/engine/index.js')
    const v: any = await evaluate(`class.c@li\n<js>${code}</js>`, { html: HTML }, 'toc', 'list')
    return v.text ?? v.items
  }
  it('size() = 顶层元素数（3 个 li），toArray() 同数', async () => {
    expect(await runJs('result.size() + "|" + result.toArray().length')).toBe('3|3')
  })
  it('get(i)/eq(i) 取位元素，first() 取首个', async () => {
    expect(await runJs('result.get(1).text() + "|" + result.eq(2).attr("class") + "|" + result.first().text()')).toBe('二||一')
  })
  it('each() 遍历成员（Elements.each 口径）', async () => {
    expect(await runJs('var o=""; result.each(function(e){ o += e.text() }); o')).toBe('一二三')
  })
})

describe('列表上下文的 result 是元素集（对面 result = java List/Elements，不是 String）', () => {
  const HTML = '<ul class="c"><li><a href="/1">一</a></li><li><a href="/2">二</a></li><li><a href="/3">三</a></li></ul>'
  const runJs = async (code: string, usage: 'list' | 'value' = 'list') => {
    const { evaluate } = await import('../../src/engine/index.js')
    const v: any = await evaluate(`class.c@li\n<js>${code}</js>`, { html: HTML }, 'toc', usage)
    return v.items ?? v.text
  }
  it('forEach 遍历成员（西瓜书屋 ruleChapterList 形态）', async () => {
    expect(await runJs("var o=[];result.forEach(function(e){o.push(e.text())});o.join(',')")).toBe('一,二,三')
  })
  it('length = 成员数、[i] 取位（穿越小说 r.length-v 形态）', async () => {
    expect(await runJs('result.length')).toBe('3')
    expect(await runJs('result[1].text()')).toBe('二')
  })
  it('String(result) = 各元素 outerHtml 无分隔拼接（对面 Elements.toString 口径）', async () => {
    expect(await runJs('String(result)')).toBe('<li><a href="/1">一</a></li><li><a href="/2">二</a></li><li><a href="/3">三</a></li>')
  })
  it('取值上下文仍是字符串对象：length 是字符数、没有集合方法（对面 getString 路径给 String）', async () => {
    expect(await runJs('(result.length === String(result).length) + "|" + typeof result.forEach', 'value')).toBe('true|undefined')
  })
})

describe('对面 Rhino 面：Packages.org.jsoup 与 book 实体方法（真机各 1-2 源）', () => {
  const opts = (code: string, over: Record<string, unknown> = {}) => ({
    code, loc: { segmentIndex: 0, segmentRaw: code }, facet: 'content' as const,
    source: 'https://x.com', baseUrl: 'https://x.com', html: '<html></html>',
    session: undefined as unknown as undefined, ...over,
  }) as never
  it('Packages.org.jsoup.Jsoup.parse 与 org.jsoup.Jsoup.parse 同一份实现（金银小说网 ruleContent）', async () => {
    const { runScript, createSourceSession } = await import('../../src/engine/js-sandbox.js')
    const o = opts(
      "var doc=Packages.org.jsoup.Jsoup.parse('<div id=htmlContent><p>甲</p><p>乙</p></div>');" +
      'var ps=doc.select("#htmlContent p");var out=[];' +
      'for(var i=0;i<ps.size();i++){out.push(ps.get(i).text())}out.join("|")',
      { session: createSourceSession() },
    )
    const v = await runScript(o)
    expect(v.value).toEqual({ kind: 'value', text: '甲|乙' })
  })
  it('book.setType/getType 与 getVariable/putVariable 可调（终极全栖、穿越小说形态）', async () => {
    const { evaluate } = await import('../../src/engine/index.js')
    const v: any = await evaluate(
      '<js>book.setType(4);var t=book.getType();var v=book.getVariable("custom");' +
      'book.putVariable("custom","X");t+"|"+v+"|"+book.getVariable("custom")+"|"+book.getName()+"|"+book.getOrigin()</js>',
      { html: '<p>x</p>', book: { name: '书甲', origin: 'https://x.com' } }, 'toc', 'value',
    )
    expect(v.text).toBe('4||X|书甲|https://x.com')
  })
  it('Book 变量表与 source 变量表互不串味（对面 Book.variables 与 BookSource.variables 是两个存储）', async () => {
    const { evaluate } = await import('../../src/engine/index.js')
    const v: any = await evaluate(
      '<js>source.put("k","S");book.putVariable("k","B");book.getVariable("k")+"/"+source.get("k")+"/"+book.getVariable("nope")</js>',
      { html: '<p>x</p>', book: {}, source: 'https://x.com' }, 'toc', 'value',
    )
    expect(v.text).toBe('B/S/')
  })
})

describe('元素桥 remove()：对面在活文档树上摘节点，摘完再读要看见', () => {
  // 两条真源 ruleContent 形态（全库 158 源中恰这 2 源用 .remove）：
  // 悦读小说 `doc=org.jsoup.Jsoup.parse(result); doc.select(".articleHide").remove(); doc`
  // 环安小说网 `result=java.getElement(".read_chapterDetail"); result.select("p,script,div").remove(); String(result.html())…`
  const ART = '<div class="art"><p>正文一</p><script>var x=1</script><em class="n_3">丙</em><div class="hide">广告</div></div>'
  const runJs = async (code: string) => {
    const { evaluate } = await import('../../src/engine/index.js')
    const v: any = await evaluate(`<js>${code}</js>`, { html: ART }, 'content', 'value')
    return v.text
  }
  it('Jsoup.parse 后 select().remove()：整棵树串化时已不含被摘节点（悦读小说形态）', async () => {
    const t = await runJs('var doc=org.jsoup.Jsoup.parse(result);doc.select(".hide").remove();String(doc)')
    expect(t).not.toContain('广告')
    expect(t).toContain('正文一')
  })
  it('元素上 select().remove() 后 html() 看见净化结果（环安小说网形态）', async () => {
    const t = await runJs('var el=java.getElement(".art");el.select("p,script,div").remove();String(el.html())')
    // 对面 Element.remove() 只把节点从父上摘掉、不删子树：div.art 自己也被这条 select 命中，
    // 摘走之后 el 仍持有没被命中的 <em>——净化后只剩它
    expect(t).toContain('丙')
    expect(t).not.toContain('正文一')
    expect(t).not.toContain('广告')
  })
  it('没有可回写的宿主片段时 remove() 如实抛错（静默 no-op 会让脏节点冒充已净化）', async () => {
    await expect(runJs("java.getElements('.art').remove();'x'")).rejects.toThrow(/remove/)
  })
})

describe('java.get 的 source 层兜底（对面四级读链；跨调用可见）', () => {
  const url = 'https://scope.example.com/read/1'
  const mk = (session: unknown) => ({
    code: '', loc: { segmentIndex: 0, segmentRaw: '@js:scope' }, facet: 'content' as const,
    baseUrl: url, source: 'https://scope.example.com', vars: {}, session,
  })
  it('source.put 写进去的变量，下一次调用的 java.get 读得到（对面 source 层落 BookSource.variable）', async () => {
    const session = createSourceSession()
    await evalJs('source.put("tok","T1"); return "ok"', { result: '', baseUrl: url, source: 'https://scope.example.com' },
      { baseUrl: url, source: 'https://scope.example.com', vars: {} },
      { segmentIndex: 0, segmentRaw: '@js:scope' }, 'content', undefined, { session })
    const v = await evalJs('return java.get("tok")', { result: '', baseUrl: url, source: 'https://scope.example.com' },
      { baseUrl: url, source: 'https://scope.example.com', vars: {} },
      { segmentIndex: 0, segmentRaw: '@js:scope' }, 'content', undefined, { session })
    expect(v.value).toEqual({ kind: 'value', text: 'T1' })
  })
  it('本次 java.put 的键仍在最上层优先（读链顺序不许反）', async () => {
    const session = createSourceSession()
    const opts = mk(session)
    await evalJs('source.put("k","源层"); return 1', { result: '', baseUrl: url, source: opts.source },
      { baseUrl: url, source: opts.source, vars: {} }, { segmentIndex: 0, segmentRaw: '@js' }, 'content', undefined, { session })
    const v = await evalJs('java.put("k","本层"); return java.get("k")', { result: '', baseUrl: url, source: opts.source },
      { baseUrl: url, source: opts.source, vars: {} }, { segmentIndex: 0, segmentRaw: '@js' }, 'content', undefined, { session })
    expect(v.value).toEqual({ kind: 'value', text: '本层' })
  })
})
