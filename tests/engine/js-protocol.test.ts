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
type _Ajax = Assert<Eq<JavaBridge['ajax'], (url: string) => Promise<string>>>
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

  it('async 行不进 javaSync 名单（ajax 走引导层特制包装）', () => {
    const asyncNames = JAVA_PROTOCOL.flatMap((r) => (r.mode === 'async' ? [r.name] : []))
    expect(asyncNames).toEqual(['ajax', 'downloadFile'])
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
