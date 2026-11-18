import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { ELEM_OPS, elemHostOp, elemWrapperSource } from '../../src/engine/host-surface-elem.js'
import { must } from '../support/fixture.js'

/**
 * 元素影子宿主面（`__elem.*`）的直测：op 名册 / host 分派 / 沙箱侧 wrapper 片段三层各钉一条。
 * 整页集成仍住 `js-sandbox.test.ts`（BOOTSTRAP 真跑）——这里测的是 module 自己的边界，
 * 不再把整条引导串当唯一测试台。
 */

/** 引导层载荷的 JSON 形态：`call('__elem.<op>', JSON.stringify(payload))` 的实参。 */
const asRecord = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {}

/** 按真实宿主步法执行引导层调用：解析实参 → 本 module 的 op 分派 → JSON 串回包。 */
function hostCall(name: string, argsJson: string): string {
  if (!name.startsWith('__elem.')) throw new Error(`非 __elem 通道：${name}`)
  return JSON.stringify(elemHostOp(name.slice('__elem.'.length), asRecord(JSON.parse(argsJson))))
}

/** 片段级 vm：按 BOOTSTRAP 的步法把片段包成函数执行，自由标识符由入参供出（真实引导里由
 *  BOOTSTRAP 作用域供出同一组名字）。返回一个在**同一 context** 里跑探针脚本的入口。 */
function scopeOf(): (code: string) => unknown {
  const context = vm.createContext({
    call: hostCall,
    ser: (v: unknown): string => JSON.stringify(v),
    msg: (e: unknown): string => (e !== null && typeof e === 'object' && 'message' in e ? String(e.message) : String(e)),
  })
  // g 必须是 vm realm 的 globalThis（真实引导里它就是 `})(globalThis)` 那个对象）：片段把
  // `__mkElem__` 挂到 g 上，探针脚本才能按脚本可见的形状读到它。
  vm.runInContext('globalThis.g = globalThis', context)
  const boot = `(function (g, call, ser, msg) {\n${elemWrapperSource()}\n})(g, call, ser, msg)`
  vm.runInContext(boot, context)
  return (code: string): unknown => vm.runInContext(code, context)
}

describe('元素面的 op 名册与沙箱侧 wrapper 同源', () => {
  it('wrapper 片段里出现的 elemOps op 名恰好就是名册', () => {
    const names = [...elemWrapperSource().matchAll(/elemOps\(\s*'([^']+)'/g)].map((m) => must(m[1], 'op 名'))
    expect([...new Set(names)].sort(), 'wrapper 里多写/漏写 op 名 = 名册与片段各一份').toEqual([...ELEM_OPS].sort())
  })

  it('片段可安全插进 BOOTSTRAP 模板串：无反引号、无插值记号', () => {
    // 输出是**文本**插值：一个反引号提前结束模板串，一个 ${ 被当场求值——都只在真跑脚本时报错，
    // 且报错离生成处很远，所以钉在生成物上（与 js-protocol.asyncBridgeSource 同款）。
    const src = elemWrapperSource()
    expect(src).not.toContain('`')
    expect(src).not.toContain('${')
    expect(src).toContain('g.__mkElem__ = mkElem')
  })

  it('片段已搬出 js-sandbox：BOOTSTRAP 只在加载时插一次，不再有第二份抄本', () => {
    const sandboxSrc = readFileSync(fileURLToPath(new URL('../../src/engine/js-sandbox.ts', import.meta.url)), 'utf8')
    expect(sandboxSrc.match(/\$\{elemWrapperSource\(\)\}/g), 'BOOTSTRAP 必须恰好插一次').toHaveLength(1)
    expect(sandboxSrc, '片段本体还留在求值文件里').not.toContain('g.__wrapElems__ = wrapElems')
  })
})

describe('元素面宿主分派（op 名 + JSON → JSON）', () => {
  it('名册里的每个 op 都真的可达（不落到「未知元素桥操作」）', () => {
    for (const op of ELEM_OPS) {
      expect(() => elemHostOp(op, { html: '', rule: '', name: '' }), `名册有 ${op} 而分派不认`).not.toThrow(/未知元素桥操作/)
    }
  })

  it('名册外的 op 如实点名（宁炸不猜，不静默回空）', () => {
    expect(() => elemHostOp('no-such-op', { html: '' })).toThrow(/未知元素桥操作：no-such-op/)
  })

  it('同片段连发多 op 命中共用片段缓存：attr / text / select 各自读对', () => {
    const html = '<div class="box"><i>甲</i><i>乙</i></div>'
    expect(elemHostOp('attr', { html, name: 'class' })).toBe('box')
    expect(elemHostOp('text', { html })).toBe('甲乙')
    expect(elemHostOp('select', { html, rule: 'i' })).toHaveLength(2)
  })

  it('未知选择器如实报「选择器无法解析」，不静默空集', () => {
    expect(() => elemHostOp('select', { html: '<p>甲</p>', rule: 'p<<' })).toThrow(/选择器无法解析/)
  })

  it('remove 回写净化的片段：被摘的子树不再出现，顶层元素照旧（摘的是父上的子树）', () => {
    // 顶层元素自己被摘掉时仍会串化自己（宿主先按原形状记下顶层节点再摘）——观察点是它
    // **父级**的串化：父节点还在，被摘的子树从它的活树上消失。
    const html = '<div id="root"><p id="gone">y</p></div>'
    const out = elemHostOp('remove', { html, rule: '#gone' })
    expect(typeof out).toBe('string')
    expect(String(out)).toContain('id="root"')
    expect(String(out), '被摘的子树还留在父节点的串化结果里').not.toContain('id="gone"')
  })
})

describe('元素面 wrapper 片段的 vm 级行为（逐函数可测，不再只靠整页集成）', () => {
  it('mkElem 的 attr/text/select 经真实宿主分派读回', () => {
    const runIn = scopeOf()
    const out = runIn(`JSON.stringify((function () {
      var el = g.__mkElem__('<div class="box"><i>甲</i><i>乙</i></div>')
      return [String(el.attr('class')), el.text(), el.select('i').size(), el.html().length > 0]
    })())`)
    expect(JSON.parse(String(out))).toEqual(['box', '甲乙', 2, true])
  })

  it('集合面 size / toArray / each 按顶层元素数算，且 for-in 只遍历下标', () => {
    const runIn = scopeOf()
    const out = runIn(`JSON.stringify((function () {
      var list = g.__mkElem__('<i>a</i><i>b</i><i>c</i>').toArray()
      var seen = []
      for (var i in list) seen.push(i)
      return [list.length, list.size(), seen]
    })())`)
    expect(JSON.parse(String(out))).toEqual([3, 3, ['0', '1', '2']])
  })

  it('元素集的 remove() 没有可回写宿主片段时如实抛错（静默 no-op 会把脏节点当已净化）', () => {
    const runIn = scopeOf()
    expect(() => runIn(`g.__mkElem__('<p>x</p>').toArray().remove()`)).toThrow(/需要可回写的宿主片段/)
  })
})
