import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { PKG_OPS, pkgHostOp, pkgWrapperSource } from '../../src/engine/host-surface-pkg.js'
import { must } from '../support/fixture.js'

/**
 * Packages 影子宿主面（`__pkg.*`）的直测：op 名册 / host 分派 / 沙箱侧 wrapper 片段。
 * 重活的真实算法（PNG/AES/HMAC/b2s）已有整页集成与 `legado-gaps` 用例覆盖；这里钉的是
 * 「名册与两边对得上」「片段能独立编译运行」「未接线与未知项如实点名」。
 */

/** 引导层载荷的 JSON 形态：`call('__pkg.<op>', JSON.stringify(payload))` 的实参。 */
const asRecord = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {}

/** 片段可以自由引用的引导层标识符——与模块顶注的清单逐字一致。测试故意用最小桩供出它们：
 *  多引/漏引一个名字，片段级 vm 会当场 ReferenceError（而不是等到某个真脚本才炸）。 */
interface FragmentScope {
  call: (name: string, argsJson: string) => string
  callHost: (name: string, payloadJson: string) => string
  ser: (v: unknown) => string | undefined
  msg: (e: unknown) => string
  materialize: (v: unknown) => unknown
  mkElem: (raw: unknown) => unknown
  sync: (name: string) => (...args: unknown[]) => unknown
}

function scopeOf(): (code: string) => unknown {
  const calls: string[] = []
  const deps = {}
  const scope: FragmentScope = {
    call: (name, argsJson) => {
      calls.push(name)
      if (!name.startsWith('__pkg.')) throw new Error(`非 __pkg 通道：${name}`)
      return JSON.stringify(pkgHostOp(name.slice('__pkg.'.length), asRecord(JSON.parse(argsJson) as unknown), deps))
    },
    callHost: () => 'null',
    ser: (v) => JSON.stringify(v),
    msg: (e) => (e !== null && typeof e === 'object' && 'message' in e ? String(e.message) : String(e)),
    materialize: (v) => v,
    mkElem: (raw) => String(raw),
    sync: () => () => 'null',
  }
  const context = vm.createContext({ ...scope })
  // g 必须是 vm realm 的 globalThis（真实引导里它就是 `})(globalThis)` 那个对象）：片段把
  // Packages / JavaImporter / importClass 挂到 g 上，探针脚本才按脚本可见的全局名读得到。
  vm.runInContext('globalThis.g = globalThis', context)
  vm.runInContext(`(function (g, call, callHost, ser, msg, materialize, mkElem, sync) {\n${pkgWrapperSource()}\n})(
    g, call, callHost, ser, msg, materialize, mkElem, sync)`, context)
  return (code: string): unknown => {
    const raw: unknown = vm.runInContext(code, context)
    return raw
  }
}

describe('包面的 op 名册与沙箱侧 wrapper 同源', () => {
  it('wrapper 片段里出现的 __pkg op 名恰好就是名册', () => {
    const src = pkgWrapperSource()
    const viaCall = [...src.matchAll(/pkgCall\(\s*'([^']+)'/g)].map((m) => must(m[1], 'op 名'))
    const viaHost = [...src.matchAll(/callHost\('__pkg\.([^']+)'/g)].map((m) => must(m[1], 'op 名'))
    expect([...new Set([...viaCall, ...viaHost])].sort(), 'wrapper 与名册各写一份 op 名').toEqual([...PKG_OPS].sort())
  })

  it('片段可安全插进 BOOTSTRAP 模板串：无反引号、无插值记号', () => {
    const src = pkgWrapperSource()
    expect(src).not.toContain('`')
    expect(src).not.toContain('${')
    expect(src).toContain('g.loadClass')
  })

  it('片段已搬出 js-sandbox：BOOTSTRAP 只在加载时插一次，求值文件里不再有第二份', () => {
    const sandboxSrc = readFileSync(fileURLToPath(new URL('../../src/engine/js-sandbox.ts', import.meta.url)), 'utf8')
    expect(sandboxSrc.match(/\$\{pkgWrapperSource\(\)\}/g), 'BOOTSTRAP 必须恰好插一次').toHaveLength(1)
    expect(sandboxSrc, '片段本体还留在求值文件里').not.toContain('g.loadClass = function')
  })
})

describe('包面宿主分派（op 名 + JSON → JSON）', () => {
  it('名册里的每个 op 都真的可达（不落到「未知 Packages 桥操作」）', () => {
    for (const op of PKG_OPS) {
      // 载荷故意给空：合法 op 应当走到自己的校验（未接线/长度不合法…），而不是被当未知 op 拒掉
      expect(() => pkgHostOp(op, {}, {}), `名册有 ${op} 而分派不认`).not.toThrow(/未知 Packages 桥操作/)
    }
  })

  it('名册外的 op 如实点名（宁炸不猜，不静默回空）', () => {
    expect(() => pkgHostOp('no-such-op', {}, {})).toThrow(/未知 Packages 桥操作：no-such-op/)
  })

  it('未接线 cookie jar 如实点名，不返假数据', () => {
    expect(() => pkgHostOp('cookieGet', { url: 'https://a/' }, {})).toThrow(/cookie jar 未接线/)
    expect(() => pkgHostOp('cookieSet', { url: 'https://a/', cookie: 'a=1' }, {})).toThrow(/cookie jar 未接线/)
  })

  it('非法输入与不支持算法各自点名（长度闸 / JCA 名映射不静默降级）', () => {
    expect(() => pkgHostOp('aes', { key: [], iv: [], data: [] }, {})).toThrow(/AES 密钥长度不合法/)
    expect(() => pkgHostOp('hmac', { algo: 'HmacMD5', key: [], data: [] }, {})).toThrow(/不支持的 Mac 算法/)
    expect(() => pkgHostOp('b2s', { bytes: 'not-array' }, {})).toThrow(/字节载荷需为 number\[\]/)
  })

  it('b2s 字节按 charset 解码（UTF-8 中文往返）', () => {
    const bytes = Array.from(Buffer.from('章节', 'utf8'))
    expect(pkgHostOp('b2s', { bytes, charset: 'UTF-8' }, {})).toBe('章节')
  })
})

describe('包面 wrapper 片段的 vm 级行为（逐函数可测，不再只靠整页集成）', () => {
  it('纯 vm 内的轻活：Arrays.copyOfRange / URL / 未知路径惰性点名', () => {
    const runIn = scopeOf()
    expect(JSON.parse(String(runIn('JSON.stringify(Packages.java.util.Arrays.copyOfRange([1,2,3,4], 1, 3))'))))
      .toEqual([2, 3])
    expect(String(runIn("String(new Packages.java.net.URL('https://x.test/a'))"))).toBe('https://x.test/a')
    expect(() => runIn('new Packages.com.example.Foo()')).toThrow(/未知 Packages 包路径：com\.example\.Foo/)
  })

  it('JavaImporter 只枚举已挂载的包路径（with 作用域里拿得到类）', () => {
    const runIn = scopeOf()
    expect(String(runIn("(function () { var ji = new JavaImporter(Packages.java.util); with (ji) { return typeof Arrays } })()")))
      .toBe('object')
  })

  it('Jsoup.parse 经 mkElem 承接（Packages 前缀与裸 org.* 同一份实现）', () => {
    const runIn = scopeOf()
    expect(String(runIn("String(Packages.org.jsoup.Jsoup.parse('<p>甲</p>'))"))).toBe('<p>甲</p>')
  })

  it('包路径进宿主的那几处（Base64.decode / CookieManager）经 __pkg 通道，不自己造数据', () => {
    const runIn = scopeOf()
    // Base64 复用协议表的同步桥（这里 sync 是桩，验证的是「走通道」而不是解码值）
    expect(String(runIn("String(Packages.android.util.Base64.decode('QQ==', 0))"))).toBe('null')
    // cookie jar 未接线：宿主侧如实抛，片段把消息带回脚本侧
    expect(() => runIn("Packages.android.webkit.CookieManager.getInstance().getCookie('https://a/')"))
      .toThrow(/cookie jar 未接线/)
  })
})
