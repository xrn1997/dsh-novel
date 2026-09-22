import { describe, expect, it } from 'vitest'
import { load } from 'cheerio'
import { JAVA_PROTOCOL, SANDBOX_MOUNTS, invokeJavaMethod } from '../../src/engine/js-protocol.js'
import type { BridgeDeps, JavaBridge } from '../../src/engine/js-protocol.js'
import { createSourceSession } from '../../src/engine/js-sandbox.js'
import { JsSandboxError, UnsupportedRuleError } from '../../src/engine/errors.js'
import type { EngineValue, EvalContext, Facet, SegmentLoc } from '../../src/engine/types.js'

const L: SegmentLoc = { segmentIndex: 0, segmentRaw: '@js:test' }
const FACET: Facet = 'content'

/** 最小 deps：协议实现可脱离 vm 直测 */
const depsOf = (over: Partial<BridgeDeps> = {}): BridgeDeps => ({
  ctx: { vars: {} } satisfies EvalContext,
  code: 'test-script',
  loc: L,
  facet: FACET,
  result: '',
  session: createSourceSession(),
  sourceKey: 'https://m.example.com',
  evaluateRef: undefined,
  contentBase: null,
  ...over,
})

// ── 类型面：JavaBridge 从表推导，钉死与既有手写 interface 的形状一致 ─────────

type Eq<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
type Assert<T extends true> = T

// 类型别名仅作编译期断言（tsc --noEmit 覆盖 tests；形状回归即红）
// 形参是 unknown 而非 string：对面 Rhino 按 String 形参强制转换，脚本常把上一段的值
// （JSONPath 的单元素数组最常见）直接递给 ajax——桥侧统一 String()，空值点名（钉子见
// tests/engine/js-bindings.test.ts 的「java.ajax 参数规约」）。
type _Ajax = Assert<Eq<JavaBridge['ajax'], (url: unknown) => Promise<string>>>
type _Get = Assert<Eq<JavaBridge['get'], (key: string) => string | undefined>>
type _Put = Assert<Eq<JavaBridge['put'], (key: string, value: unknown) => void>>
type _GetString = Assert<Eq<JavaBridge['getString'], (rule: string, isUrl?: boolean) => string>>
type _GetElement = Assert<Eq<JavaBridge['getElement'], (rule: string) => { html: string; text: string } | null>>
type _SetContent = Assert<Eq<JavaBridge['setContent'], (content: unknown) => void>>
type _CookieGet = Assert<Eq<JavaBridge['cookieGet'], (name: string) => string | null>>
type _SourceVarPut = Assert<Eq<JavaBridge['sourceVarPut'], (key: string, value: string) => void>>

describe('JavaBridge 协议表（表驱动登记）', () => {
  it('方法名唯一（重复登记 → 红）', () => {
    const names = JAVA_PROTOCOL.map((r) => r.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('表 ↔ SANDBOX_MOUNTS 完备：每个同步行恰好挂进一个沙箱清单（漏挂/双挂 → 红）', () => {
    const mounted = [
      ...SANDBOX_MOUNTS.javaSync,
      ...SANDBOX_MOUNTS.cookie.map((p) => p.name),
      ...SANDBOX_MOUNTS.source.map((p) => p.name),
      ...SANDBOX_MOUNTS.cache.map((p) => p.name),
    ]
    // async 行（当前仅 ajax）在引导层手工挂特制包装，不进 sync 清单——差集必须恰为 async 集
    const asyncRows = JAVA_PROTOCOL.flatMap((r) => (r.mode === 'async' ? [r.name] : []))
    const syncRows = JAVA_PROTOCOL.flatMap((r) => (r.mode === 'async' ? [] : [r.name]))
    expect([...mounted].sort()).toEqual([...syncRows].sort())
    expect(new Set(mounted).size).toBe(syncRows.length)
    // 反向：不在任何清单里的行必须且只能是 async 行
    const unmounted = JAVA_PROTOCOL.map((r) => r.name).filter((n) => !mounted.includes(n))
    expect([...unmounted].sort()).toEqual([...asyncRows].sort())
  })

  it('async 行不进 javaSync 名单（ajax/downloadFile/connect/post 走引导层特制包装）', () => {
    const asyncNames = JAVA_PROTOCOL.flatMap((r) => (r.mode === 'async' ? [r.name] : []))
    expect(asyncNames).toEqual(['ajax', 'connect', 'post', 'downloadFile'])
    expect(SANDBOX_MOUNTS.javaSync).not.toContain('ajax')
    expect(SANDBOX_MOUNTS.javaSync).toContain('get')
  })

  it('cookie/source 挂载键即脚本可见属性名（getCookie/getVariable/…）', () => {
    expect(SANDBOX_MOUNTS.cookie).toEqual([
      { name: 'cookieGet', key: 'getCookie' },
      { name: 'cookieSet', key: 'setCookie' },
      { name: 'cookieRemove', key: 'removeCookie' },
    ])
    expect(SANDBOX_MOUNTS.source).toEqual([
      { name: 'sourceGetVariable', key: 'getVariable' },
      { name: 'sourceSetVariable', key: 'setVariable' },
      { name: 'sourceVarGet', key: 'get' },
      { name: 'sourceVarPut', key: 'put' },
    ])
  })
})

describe('invokeJavaMethod 分派（不进 vm 的直测）', () => {
  it('未知方法 → JsSandboxError（未知 java 方法）', () => {
    expect(() => invokeJavaMethod(depsOf(), 'noSuchMethod', [])).toThrow(JsSandboxError)
    expect(() => invokeJavaMethod(depsOf(), 'noSuchMethod', [])).toThrow(/未知 java 方法/)
  })

  it('get/put：ctx.vars 读写；未命中 → undefined（宿主层序列化为 null）', () => {
    const deps = depsOf()
    invokeJavaMethod(deps, 'put', ['k', 'v'])
    expect(deps.ctx.vars?.k).toBe('v')
    expect(invokeJavaMethod(deps, 'get', ['k'])).toBe('v')
    expect(invokeJavaMethod(deps, 'get', ['nope'])).toBeUndefined()
    // 非字符串值按 String() 落位（与旧分派逐案转换口径一致）
    invokeJavaMethod(deps, 'put', ['n', 42])
    expect(deps.ctx.vars?.n).toBe('42')
  })

  it('ajax：走注入 fetch，返回 Promise<body>', async () => {
    const calls: string[] = []
    const deps = depsOf({ ctx: { vars: {}, fetch: async (u) => { calls.push(u); return { body: '<p>ok</p>' } } } })
    const out = await Promise.resolve(invokeJavaMethod(deps, 'ajax', ['https://m.example.com/x']))
    expect(out).toBe('<p>ok</p>')
    expect(calls).toEqual(['https://m.example.com/x'])
  })

  it('ajax：无 ctx.fetch → 同步抛 JsSandboxError（该源未提供网络能力）', () => {
    expect(() => invokeJavaMethod(depsOf(), 'ajax', ['u'])).toThrow(/网络能力/)
  })

  it('getString/getStringList/getElements/getElement：无 evaluateRef → 宁炸不猜', () => {
    for (const name of ['getString', 'getStringList', 'getElements', 'getElement']) {
      expect(() => invokeJavaMethod(depsOf(), name, ['@css:h1'])).toThrow(/evaluateRef/)
    }
  })

  it('getString(isUrl=true) → UnsupportedRuleError（v1 守门）', () => {
    const fake = (): EngineValue => ({ kind: 'value', text: 'X' })
    expect(() => invokeJavaMethod(depsOf({ evaluateRef: fake }), 'getString', ['@css:h1', true]))
      .toThrow(UnsupportedRuleError)
  })

  it('getString/getStringList 经 evaluateRef 递归求值（基内容 = contentBase ?? result）', () => {
    const seen: unknown[] = []
    const fake = (rule: string, data: unknown): EngineValue => { seen.push(data); return { kind: 'value', text: `${rule}|${data}` } }
    const deps = depsOf({ result: 'prev', evaluateRef: fake })
    expect(invokeJavaMethod(deps, 'getString', ['@css:h1'])).toBe('@css:h1|prev')
    invokeJavaMethod(deps, 'setContent', ['<h1>新基</h1>'])
    expect(deps.contentBase).toBe('<h1>新基</h1>')
    expect(invokeJavaMethod(deps, 'getString', ['@css:h1'])).toBe('@css:h1|<h1>新基</h1>')
    expect(seen).toEqual(['prev', '<h1>新基</h1>'])
  })

  it('getElements/getElement：nodes → 纯数据元素；空选择集 → []/null', () => {
    const $ = load('<h1>标题</h1><p>正文</p>')
    const deps = depsOf({ evaluateRef: (): EngineValue => ({ kind: 'nodes', nodes: $('h1') }) })
    expect(invokeJavaMethod(deps, 'getElements', ['@css:h1'])).toEqual([{ html: '<h1>标题</h1>', text: '标题' }])
    expect(invokeJavaMethod(deps, 'getElement', ['@css:h1'])).toEqual({ html: '<h1>标题</h1>', text: '标题' })
    const empty = depsOf({ evaluateRef: (): EngineValue => ({ kind: 'nodes', nodes: $('h2') }) })
    expect(invokeJavaMethod(empty, 'getElements', ['@css:h2'])).toEqual([])
    expect(invokeJavaMethod(empty, 'getElement', ['@css:h2'])).toBeNull()
  })

  it('cookie 三件套：按源隔离会话内 set/get/remove', () => {
    const deps = depsOf()
    invokeJavaMethod(deps, 'cookieSet', ['token', 'abc'])
    expect(invokeJavaMethod(deps, 'cookieGet', ['token'])).toBe('abc')
    invokeJavaMethod(deps, 'cookieRemove', ['token'])
    expect(invokeJavaMethod(deps, 'cookieGet', ['token'])).toBeNull()
  })

  it('源变量四件套：getVariable/整表 JSON 与 get/put 同一存储', () => {
    const deps = depsOf()
    expect(invokeJavaMethod(deps, 'sourceGetVariable', [])).toBe('') // 从未设置 → ''
    invokeJavaMethod(deps, 'sourceSetVariable', [JSON.stringify({ host: 'x.com' })])
    expect(invokeJavaMethod(deps, 'sourceVarGet', ['host'])).toBe('x.com')
    expect(JSON.parse(String(invokeJavaMethod(deps, 'sourceGetVariable', [])))).toEqual({ host: 'x.com' })
    // 非 JSON 对象串 → 按单值表落位（键 ''，legado 同口径）
    invokeJavaMethod(deps, 'sourceSetVariable', ['raw-string'])
    expect(invokeJavaMethod(deps, 'sourceVarGet', [''])).toBe('raw-string')
  })

  it('纯工具行透传 js-utils（md5/timeFormatUTC/encodeURI）', () => {
    expect(invokeJavaMethod(depsOf(), 'md5Encode', ['abc'])).toBe('900150983cd24fb0d6963f7d28e17f72')
    expect(invokeJavaMethod(depsOf(), 'md5Encode16', ['abc'])).toBe('3cd24fb0d6963f7d')
    expect(invokeJavaMethod(depsOf(), 'timeFormatUTC', [0])).toBe('1970/01/01 00:00')
    expect(invokeJavaMethod(depsOf(), 'encodeURI', ['书'])).toBe('%E4%B9%A6')
    expect(invokeJavaMethod(depsOf(), 'base64Encode', ['abc'])).toBe('YWJj')
    expect(invokeJavaMethod(depsOf(), 'hexDecodeToString', ['e4bda0'])).toBe('你')
  })
})

/**
 * 摘要 / HMAC 族（对面 `help/JsEncodeUtils.kt`：`digestHex(data, algorithm)` /
 * `digestBase64Str(data, algorithm)` / `HMacHex(data, algorithm, key)` / `HMacBase64(...)`——
 * **实参顺序是 data 在前、算法在后**，且 `data.toByteArray()` 是 UTF-8）。
 *
 * 期望值全部由 **openssl 3.5.6 独立算出**（不是 node crypto——那等于拿实现自证）；
 * `HMacHex('Hi There', 'HmacSHA256', 0x0b×20)` 那一条同时是 RFC 4231 test case 2 的公开值，
 * 两条来路对得上，才敢说这不是「按实现反推的期望」。
 */
describe('摘要与 HMAC 族（java.digestHex / digestBase64Str / HMacHex / HMacBase64）', () => {
  it('digestHex：MD5 / SHA-256，与中文按 UTF-8 摘要的 SHA-512', () => {
    expect(invokeJavaMethod(depsOf(), 'digestHex', ['abc', 'MD5']))
      .toBe('900150983cd24fb0d6963f7d28e17f72')
    expect(invokeJavaMethod(depsOf(), 'digestHex', ['abc', 'SHA-256']))
      .toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(invokeJavaMethod(depsOf(), 'digestHex', ['中文测试', 'SHA-512']))
      .toBe('1fea9aee07bd0ab66604ef4f079d6b109a0e625c3bc38fe8f850111a9ee6b4a689f3cb454dfd8a16cbd35963382f4ca5d91cdcff2dd473028e6cfee256812eec')
  })
  it('digestBase64Str：标准 base64 单行（NO_WRAP），换行一个都不许多', () => {
    expect(invokeJavaMethod(depsOf(), 'digestBase64Str', ['abc', 'SHA-1']))
      .toBe('qZk+NkcGgWq6PiVxeFDCbJzQ2J0=')
    const b64 = String(invokeJavaMethod(depsOf(), 'digestBase64Str', ['中文测试', 'SHA-256']))
    expect(b64).toBe('41BUXRhzXF3S3sUNy5cfPrTN2iS5Wnm9trVT9qAc64c=')
    expect(b64).not.toContain('\n')
  })
  it('HMacHex / HMacBase64：算法名去掉 Hmac 前缀后当摘要算法，key 按 UTF-8 取字节', () => {
    const key = '\u000b'.repeat(20)   // RFC 4231 tc2：20 字节 0x0b
    expect(invokeJavaMethod(depsOf(), 'HMacHex', ['Hi There', 'HmacSHA256', key]))
      .toBe('b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7')
    expect(invokeJavaMethod(depsOf(), 'HMacBase64', ['Hi There', 'HmacSHA256', key]))
      .toBe('sDRMYdjbOFNcqK/OrwvxK4gdwgDJgz2nJuk3bC4yz/c=')
    expect(invokeJavaMethod(depsOf(), 'HMacHex',
      ['The quick brown fox jumps over the lazy dog', 'HmacSHA512', 'John']))
      .toBe('effb80facca98c2983c290ab650583605433dff09eed7e72edb189bbff35808e2a77e3010794021db77e4595c95a2571db2b6afc5c65b4efe3ad56b85c528572')
  })
  it('认不出的算法名 → 点名该算法（不静默换成 md5，也不拿原样喂给 node）', () => {
    const run = (args: unknown[]): unknown => invokeJavaMethod(depsOf(), 'digestHex', args)
    expect(() => run(['abc', 'WHIRLPOOL-9'])).toThrow(/WHIRLPOOL-9/)
  })
  it('digestHex 拿到 HMAC 算法名 → 同样报「不支持的算法」（对面 MessageDigest 也抛 NoSuchAlgorithmException，不许当成 HMAC 悄悄算）', () => {
    expect(() => invokeJavaMethod(depsOf(), 'digestHex', ['abc', 'HmacSHA256'])).toThrow(/HmacSHA256/)
  })
})
