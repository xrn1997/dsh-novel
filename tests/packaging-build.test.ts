import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

// 构建产物自检（先 pnpm build 或 pnpm test:pack）——常规集已排除本文件
const hasLib = existsSync('lib/index.js') && existsSync('lib/client.js')

/** 在 vm 里真跑一遍注册壳：拿 `load` 行、调一次 factory，交回 exports 与它**实际请求**的模块表。
 *  为什么不扫文本：压缩后 `require("x")` 的形态没了（factory 的参数名与调用点一起短化），
 *  静态扫文本会扫出零条 require——那等于门自己睡着了。参数用最小模块表：react 给模块求值期
 *  真会用的成员（createContext 等），其余给可调用的万能桩。 */
function runClientBundle(js: string): {
  id: string
  exportsObj: Record<string, unknown>
  required: string[]
} {
  const rows: Array<{ id: string; factory: (req: (spec: string) => unknown) => Record<string, unknown> }> = []
  const loader = { load: (row: (typeof rows)[number]) => { rows.push(row) } }
  runInNewContext(js, { window: { __ModuleLoader__: loader } })
  if (rows.length !== 1) throw new Error(`注册壳应登记一行，实际 ${String(rows.length)} 行`)
  const row = rows[0]
  if (row === undefined) throw new Error('注册壳没登记任何行')
  const reactStub = {
    createContext: () => ({ Provider: () => null, Consumer: () => null }),
    createElement: () => null,
    useEffect: () => undefined,
    useState: () => [undefined, () => undefined],
    useRef: () => ({ current: null }),
    useMemo: (f: () => unknown) => f(),
    useCallback: (f: unknown) => f,
    memo: (c: unknown) => c,
    useSyncExternalStore: () => undefined,
  }
  const required: string[] = []
  const req = (spec: string): unknown => {
    required.push(spec)
    return spec === 'react' ? reactStub : new Proxy({}, { get: () => () => null })
  }
  return { id: row.id, exportsObj: row.factory(req), required }
}

describe.skipIf(!hasLib)('构建产物（先跑 pnpm build 或 pnpm test:pack）', () => {
  it('host 半：ESM、含插件身份与 API 前缀、无 ModuleLoader 泄染', () => {
    const js = readFileSync('lib/index.js', 'utf8')
    expect(js).toContain('@xrn1997/dsh-novel')
    expect(js).toContain('/novel-api')
    expect(js).not.toContain('__ModuleLoader__')
  })
  it('client 半：三段式工厂包裹（load(id) 注册、factory 交回 exports）', () => {
    const js = readFileSync('lib/client.js', 'utf8')
    expect(js.trimStart().startsWith('window.__ModuleLoader__.load({')).toBe(true)
    // footer 形态会被压缩器重写（`return module.exports` 会与导出赋值合并成逗号表达式、标识符也短化），
    // 所以这里钉**行为**而不是文本：真跑一遍注册壳，拿到 factory 调一次，交回的对象必须像一份插件。
    const { id, exportsObj } = runClientBundle(js)
    expect(id).toBe('@xrn1997/dsh-novel')
    expect(typeof exportsObj.apply).toBe('function')
    expect(Array.isArray(exportsObj.inject)).toBe(true)
    expect(exportsObj.name).toBe('@xrn1997/dsh-novel/client')
    const mapIdx = js.indexOf('//# sourceMappingURL=')
    expect(mapIdx, 'sourcemap 尾注丢了：压缩后仍要可调试').toBeGreaterThan(js.lastIndexOf('window.__ModuleLoader__.load'))
    expect(js).toContain('sidebar.panellist')           // 全局面板入口进了 bundle
    expect(js).toContain('@xrn1997/dsh-novel.status')    // 常驻状态层注册仍在（id 带插件前缀）
    // 断言编译后的调用形状，而不是裸字符串：源文件 JSDoc 里也抄着同一个槽名，注册被删而注释还在时
    // 裸串断言照样绿（最终评审钉出的假绿面）。压缩器会把引号统一成反引号，三种都收。
    expect(js).toMatch(/name:\s*["'`]plugins\.bundle\.config["'`]/)
  })
  it('client 半纯度：require 集合恰为约定两条', () => {
    const js = readFileSync('lib/client.js', 'utf8')
    // 分母用 factory 真的请求到的模块（压缩后文本形态已不可扫）。先钉分母非空：
    // 记账没接上时下面的「集合相等」是恒真，纯度门就退化成一条永远绿的断言。
    const { required } = runClientBundle(js)
    expect(required.length, '一条 require 都没抓到：记账的 require 没接上（纯度门变成空断言）').toBeGreaterThan(0)
    // 这份清单是**独立抄本**（不 import tsdown.config.ts 的 PLATFORM_MODULES），否则「配置写宽了」
    // 会连同测试一起变宽，守卫退化成回声。判据取**集合相等**而不是「白名单外为空」：白名单只约束
    // 「没多要」，集合相等把「没少记」也钉住——多一条 require 与漏记一条都会红。
    // 宿主 client 包一条都不许出现在这里：配置页走 `ctx.remote.settings`（ADR-0067），不引原语。
    expect([...new Set(required)].sort()).toEqual([
      'react',
      'react/jsx-runtime',
    ])
  })
  it('dts 存在且导出入口签名', () => {
    const dts = readFileSync('lib/types/index.d.ts', 'utf8')
    expect(dts).toContain('apply')
    expect(dts).toContain('Config')
  })
})
