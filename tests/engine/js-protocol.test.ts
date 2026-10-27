import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { load } from 'cheerio'
import { JAVA_PROTOCOL, SANDBOX_MOUNTS, SYNC_AJAX_SENTINEL, asyncBridgeSource, asyncRouteProbes, invokeJavaMethod } from '../../src/engine/js-protocol.js'
import type { BridgeDeps, JavaBridge } from '../../src/engine/js-protocol.js'
import { SYNC_WORKER_RE, createSourceSession } from '../../src/engine/js-sandbox.js'
import { JsSandboxError } from '../../src/engine/errors.js'
import { engineContextOf } from '../../src/services/source-eval.js'
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

// 类型别名仅作编译期断言（tsc --noEmit 覆盖 tests；形状回归即在别名自己那一行红）。逐条 export：
// `noUnusedLocals` 只认导出面，不必再攒一张清单——那张清单本身没人消费，只多一处要人同步。
// 形参是 unknown 而非 string：脚本侧按字符串形参强制转换，脚本常把上一段的值
// （JSONPath 的单元素数组最常见）直接递给 ajax——桥侧统一 String()，空值点名（钉子见
// tests/engine/js-bindings.test.ts 的「java.ajax 参数规约」）。
export type _Ajax = Assert<Eq<JavaBridge['ajax'], (url: unknown) => Promise<string>>>
export type _Get = Assert<Eq<JavaBridge['get'], (key: string) => string>>
export type _Put = Assert<Eq<JavaBridge['put'], (key: string, value: unknown) => void>>
// getString 的三个位置各有语义（二参重载 + 三参形态）：第二参布尔 = unescape 开关，
// 非布尔 = mContent 基内容，第三参布尔 = isUrl 绝对化。**没有「取 URL 后再抓」这条**。
export type _GetString = Assert<Eq<JavaBridge['getString'], (rule: unknown, arg2?: unknown, isUrl?: unknown) => string>>
export type _GetElement = Assert<Eq<JavaBridge['getElement'], (rule: string) => { html: string; text: string } | null>>
export type _SetContent = Assert<Eq<JavaBridge['setContent'], (content: unknown) => void>>
export type _CookieGet = Assert<Eq<JavaBridge['cookieGet'], (name: string) => string | null>>
export type _SourceVarPut = Assert<Eq<JavaBridge['sourceVarPut'], (key: string, value: string) => string>>
export type _SourceVarGet = Assert<Eq<JavaBridge['sourceVarGet'], (key: string) => string>>

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
    // async 行（ajax / connect / post / downloadFile）由引导层生成特制包装，不进 sync 清单——差集必须恰为 async 集
    const asyncRows = JAVA_PROTOCOL.flatMap((r) => (r.mode === 'async' ? [r.name] : []))
    const syncRows = JAVA_PROTOCOL.flatMap((r) => (r.mode === 'async' ? [] : [r.name]))
    expect([...mounted].sort()).toEqual([...syncRows].sort())
    expect(new Set(mounted).size).toBe(syncRows.length)
    // 反向：不在任何清单里的行必须且只能是 async 行
    const unmounted = JAVA_PROTOCOL.map((r) => r.name).filter((n) => !mounted.includes(n))
    expect([...unmounted].sort()).toEqual([...asyncRows].sort())
  })

  it('async 行不进 javaSync 名单（它们走引导层特制包装，不是 `sync()` 转发）', () => {
    for (const name of JAVA_PROTOCOL.flatMap((r) => (r.mode === 'async' ? [r.name] : []))) {
      expect(SANDBOX_MOUNTS.javaSync).not.toContain(name)
    }
    expect(SANDBOX_MOUNTS.javaSync).toContain('get')
  })

  it('cookie/source 挂载键即脚本可见属性名（getCookie/getVariable/…）', () => {
    expect(SANDBOX_MOUNTS.cookie).toEqual([
      { name: 'cookieGet', key: 'getCookie' },
      { name: 'cookieSet', key: 'setCookie' },
      { name: 'cookieRemove', key: 'removeCookie' },
      { name: 'cookieReplace', key: 'replaceCookie' },
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

  it('get/put：ctx.vars 读写；未命中 → **空串**（对面 getVariable 的收口；返 undefined 会过桥变 null）', () => {
    const deps = depsOf()
    invokeJavaMethod(deps, 'put', ['k', 'v'])
    expect(deps.ctx.vars?.k).toBe('v')
    expect(invokeJavaMethod(deps, 'get', ['k'])).toBe('v')
    // 对面 `RuleDataInterface.getVariable` 是 `variableMap[key] ?: getBigVariable(key) ?: ""`：未设给空串。
    // 改这里注意：未设必须给空串，不能返 undefined——JSON 桥把 undefined 变成 **null**，
    // 脚本里 String(...) 得到字面量 "null"（移动阅读拼进 DES 密钥）、对 null 再调方法即抛（海棠搜书）。
    expect(invokeJavaMethod(deps, 'get', ['nope'])).toBe('')
    // 非字符串值按 String() 落位（各方法同一转换口径）
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

  it('getString 重载分派：二参布尔是 unescape（对面双参重载），不是 isUrl，也不再抛', () => {
    // `getString(ruleStr, unescape: Boolean)` 与 `getString(ruleStr, mContent, isUrl)`
    // 是两个不同形态，后者的 unescape **缺省 true**。改这里注意：二参布尔是 unescape，不是 isUrl——
    // 按 isUrl 读会把「不要反转义」的意图静默反做（本意要原文，却给解码后的值）；isUrl 在第三参。
    const fake = (): EngineValue => ({ kind: 'value', text: 'A&amp;B' })
    const deps = depsOf({ evaluateRef: fake })
    expect(invokeJavaMethod(deps, 'getString', ['tag.p@text', false])).toBe('A&amp;B')
    expect(invokeJavaMethod(deps, 'getString', ['tag.p@text', true])).toBe('A&B')
    // 缺省 = unescape=true（再解一次实体）
    expect(invokeJavaMethod(deps, 'getString', ['tag.p@text'])).toBe('A&B')
  })

  it('getString 三参 isUrl：基内容走 mContent、产物按 baseUrl 绝对化，**不发请求**', () => {
    // isUrl 分支只把产物按 base 绝对化，空白结果回退 baseUrl——
    // 「取到 URL 后再抓一次」这条语义不存在。
    // 本 deps 的 ctx 没有 fetch：实现若去抓站点会当场抛「网络能力」，用例即红 ⇒ 零抓取是断言出来的。
    const seen: unknown[] = []
    const fake = (sub: { rule: string }, data: unknown): EngineValue => {
      seen.push(data)
      return { kind: 'value', text: sub.rule === 'blank' ? '' : '/book/1' }
    }
    const deps = depsOf({
      ctx: { vars: {}, baseUrl: 'https://m.example.com/read/index.html' } satisfies EvalContext,
      result: 'ignored', evaluateRef: fake,
    })
    expect(invokeJavaMethod(deps, 'getString', ['tag.a@href', '<html>x</html>', true])).toBe('https://m.example.com/book/1')
    expect(seen).toEqual(['<html>x</html>'])           // mContent 接管基内容，不是脚本的上一段 result
    expect(invokeJavaMethod(deps, 'getString', ['blank', '<html>x</html>', true])).toBe('https://m.example.com/read/index.html')
  })

  it('getStringList 三参 isUrl：逐项绝对化 + 去重（对面 urlList 分支），空串按其口径变 base', () => {
    const fake = (): EngineValue => ({ kind: 'list', items: ['/b/1', '/b/1', 'https://x.test/b/2', ''] })
    const deps = depsOf({
      ctx: { vars: {}, baseUrl: 'https://m.example.com/read/index.html' } satisfies EvalContext,
      evaluateRef: fake,
    })
    // 逐项绝对化：空串走 `URL(base, "")` ⇒ 得到 base 本身（非空 ⇒ 收进列表）。
    // 这条不"顺手修正"成过滤空项——那会是另一种产出。
    expect(invokeJavaMethod(deps, 'getStringList', ['tag.a@href', null, true]))
      .toEqual(['https://m.example.com/b/1', 'https://x.test/b/2', 'https://m.example.com/read/index.html'])
  })

  it('getString/getStringList 经 evaluateRef 递归求值（基内容 = contentBase ?? result）', () => {
    const seen: unknown[] = []
    const fake = (sub: { rule: string }, data: unknown): EngineValue => { seen.push(data); return { kind: 'value', text: `${sub.rule}|${data}` } }
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

  it('子规则求值把用途交给引擎：显式取值尾 value、裸选择 list；getElements/getElement list', () => {
    const calls: Array<[string, string]> = []
    const deps = depsOf({
      evaluateRef: (sub, _data) => {
        calls.push([sub.rule, sub.usage])
        return { kind: 'miss', detail: 'x' }
      },
    })
    invokeJavaMethod(deps, 'getString', ['tag.a@href'])
    invokeJavaMethod(deps, 'getStringList', ['tag.a@href'])
    invokeJavaMethod(deps, 'getString', ['div.item'])
    invokeJavaMethod(deps, 'getStringList', ['div.item'])
    invokeJavaMethod(deps, 'getElements', ['tag.a'])
    invokeJavaMethod(deps, 'getElement', ['tag.a'])
    expect(calls).toEqual([
      ['tag.a@href', 'value'],
      ['tag.a@href', 'value'],
      ['div.item', 'list'],
      ['div.item', 'list'],
      ['tag.a', 'list'],
      ['tag.a', 'list'],
    ])
  })

  it('cookie 三件套：按源隔离会话内 set/get/remove', () => {
    const deps = depsOf()
    invokeJavaMethod(deps, 'cookieSet', ['token', 'abc'])
    expect(invokeJavaMethod(deps, 'cookieGet', ['token'])).toBe('abc')
    invokeJavaMethod(deps, 'cookieRemove', ['token'])
    expect(invokeJavaMethod(deps, 'cookieGet', ['token'])).toBeNull()
  })

  it('源状态三张表互不串味：单串槽 / 键值表 / 缓存（三处本可分开的存储）', () => {
    const deps = depsOf()
    // setVariable/getVariable 是**一个字符串槽**（直返那串、未设返 ""）；
    // put(key,value)/get(key) 是另一套命名空间（缺键返 ""）。
    expect(invokeJavaMethod(deps, 'sourceGetVariable', [])).toBe('')          // 从未设置 → ''
    invokeJavaMethod(deps, 'sourceSetVariable', ['abc'])
    expect(invokeJavaMethod(deps, 'sourceGetVariable', [])).toBe('abc')       // 直返原串，不是整表 JSON
    expect(invokeJavaMethod(deps, 'sourceVarGet', ['abc'])).toBe('')          // 串槽的**值**不是键值表的键
    invokeJavaMethod(deps, 'sourceVarPut', ['k', 'v'])
    invokeJavaMethod(deps, 'sourceSetVariable', ['第二次'])
    // 串槽与键值表分开存：写串槽不许清键值表（合成同一张 Map 时键值会被顺手清空）
    expect(invokeJavaMethod(deps, 'sourceVarGet', ['k'])).toBe('v')
    expect(invokeJavaMethod(deps, 'sourceGetVariable', [])).toBe('第二次')
    // cache 又是第三处：缓存本是全局表（本仓按源隔离是在册裁决），不许漏进键值表
    invokeJavaMethod(deps, 'cachePut', ['ck', 'cv'])
    expect(invokeJavaMethod(deps, 'cacheGet', ['ck'])).toBe('cv')
    expect(invokeJavaMethod(deps, 'sourceVarGet', ['cache:ck'])).toBe('')
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
 * 摘要 / HMAC 族（`digestHex(data, algorithm)` / `digestBase64Str(data, algorithm)` /
 * `HMacHex(data, algorithm, key)` / `HMacBase64(...)`——
 * **实参顺序是 data 在前、算法在后**，且入参按 UTF-8 取字节）。
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

describe('async 行的能力位闸（表行 ↔ 沙箱包装 ↔ 服务层装配）', () => {
  // 「加一个方法 = 表加一行」对 async 行同样成立：桥壳与 g.java 挂载都由表生成，测试逐行验
  // 「有壳 / 能到 / 被路由」。它读的能力位（`ctx.fetchPost` 这类）仍必须有人真的递进来：
  // 两处没有编译期联系，漏哪一处都只在真跑到那个方法的源上炸成「未接线」——所以这里用现读的源码当闸。
  const read = (rel: string): string =>
    readFileSync(new URL(rel, import.meta.url), 'utf8')
  const protocolSrc = read('../../src/engine/js-protocol.ts')
  const asyncRows = JAVA_PROTOCOL.filter((r) => r.mode === 'async').map((r) => r.name)
  const capabilityNames = [...new Set(
    [...protocolSrc.matchAll(/d\.ctx\.([a-zA-Z]+)/g)].map((m) => m[1]),
  )]

  it('bridge 只长在 async 行上（sync 行混进 bridge 会被 javaSync 名单静默收编成双挂载）', () => {
    // 表的类型只把 bridge 标成可选，挡不住「sync 行也带 bridge」：那一行会同时进 javaSync
    // （sync() 转发）与 javaAsyncMounts（生成桥壳），后者被前者覆盖、哨兵臂成死代码。
    // 正向（async 行必有 bridge）由上一条闸钉住，这里钉反向，两条合起来基数恰为 async 行数。
    for (const r of JAVA_PROTOCOL) {
      if (r.bridge !== undefined) expect(r.mode, `${r.name} 带 bridge 却不是 async 行`).toBe('async')
    }
    expect(JAVA_PROTOCOL.filter((r) => r.bridge !== undefined)).toHaveLength(asyncRows.length)
  })

  it('每条 async 行都：有桥壳、有可达入口、被路由启发式认出', () => {
    // ① 桥壳：生成器必须为每一行产出一段 `const <name> = d.syncAjax`
    //    （串由生成器出，这条只防漏行）
    const bridgeSrc = asyncBridgeSource()
    for (const r of JAVA_PROTOCOL.filter((x) => x.mode === 'async')) {
      expect(bridgeSrc).toContain(`const ${r.name} = d.syncAjax`)
    }
    // ② 可达：直接挂载的必须有挂载项；间接的必须写明它走哪个入口
    const mounted = new Set(SANDBOX_MOUNTS.javaAsyncMounts.map((m) => m.target))
    for (const r of JAVA_PROTOCOL.filter((x) => x.mode === 'async')) {
      expect(r.bridge, `${r.name} 缺 bridge 判别`).toBeDefined()
      if (r.bridge!.mountAs !== null) expect(mounted.has(r.bridge!.mountAs)).toBe(true)
      else expect(r.bridge!.routeProbe).toMatch(/java\s*\.\s*get\s*\(|openConnection\s*\(/)
    }
    // ③ 路由：每种可达写法都必须被 SYNC_WORKER_RE 认出——认不出时主线程抛哨兵，
    //    而脚本自己的 try/catch 会把哨兵吞掉（见 js-sandbox「同步桥」一节），
    //    catch 分支拿到 undefined = 空结果冒充失败。
    for (const { name, probe } of asyncRouteProbes()) {
      expect(SYNC_WORKER_RE.test(probe), `${name} 的写法不会被路由：${probe}`).toBe(true)
    }
    // 上面那条 for 在生成器漏行时会空转：基数与表的 async 行数对齐（分母是表，不是写死的数）
    expect(asyncRouteProbes()).toHaveLength(asyncRows.length)
    // 别名不在表行上（表里只有宿主方法名），只能经挂载清单钉：它同样在引导层抛哨兵。
    for (const m of SANDBOX_MOUNTS.javaAsyncMounts) {
      expect(SYNC_WORKER_RE.test(`java.${m.target}("https://m.example.com")`), `${m.target} 的挂载名不会被路由`).toBe(true)
    }
  })

  it('哨兵只有一个主人：生成的桥壳抛的就是路由认的那一个，两个模块里不许有第二份字面量', () => {
    // 字面量只有一份：抄第二份时值一改另一头认不出，脚本拿到的就是哨兵错误本身
    // （不换 worker 重跑），而这条路只在真跑同步网络桥的源上炸。
    expect(asyncBridgeSource()).toContain(SYNC_AJAX_SENTINEL)
    const sandboxSrc = read('../../src/engine/js-sandbox.ts')
    expect(`${protocolSrc}\n${sandboxSrc}`.match(/__dsh_sync_ajax_required__/g)).toHaveLength(1)
  })

  it('生成的桥源码可安全插进 BOOTSTRAP 模板串：无反引号、无 ${', () => {
    // 输出是**文本**插值（js-sandbox 的 BOOTSTRAP）：一个反引号提前结束模板串，一个 ${ 被当场求值——
    // 两种都只在真跑脚本的源上炸，且报错离生成器很远，所以钉在生成物上。
    const src = asyncBridgeSource()
    expect(src).not.toContain('`')
    expect(src).not.toContain('${')
  })

  it('async 挂载目标名唯一（同名双挂 ⇒ 后者静默覆盖前者）', () => {
    const targets = SANDBOX_MOUNTS.javaAsyncMounts.map((m) => m.target)
    expect(new Set(targets).size).toBe(targets.length)
  })

  it('表读到的每个能力位，源级上下文装配单点都供得出（漏装配＝运行时「未接线」）', () => {
    expect(capabilityNames.length).toBeGreaterThan(0)
    // 现造一份源级上下文来验「供得出」，而不是在 source-eval.ts 全文里 grep `name:`——后者会被注释、
    // `resolveHeaders` 乃至任何同名键满足，装配单点漏掉一格照样绿。
    const source = { name: '探针源', baseUrl: 'https://m.example.com', rules: {}, raw: {} }
    const ctx = engineContextOf({} as never, source as never, { baseUrl: source.baseUrl, vars: { key: 'k' } })
    for (const name of capabilityNames) {
      expect(name in ctx, `engineContextOf 没有产出 ctx.${name}`).toBe(true)
    }
  })

  it('async 行不进同步挂载表（它们走引导层特制包装，不是 `sync()` 转发）', () => {
    for (const name of asyncRows) expect(SANDBOX_MOUNTS.javaSync).not.toContain(name)
  })
})
