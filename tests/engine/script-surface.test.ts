import { describe, expect, it } from 'vitest'
import { SCRIPT_FIELDS, scriptGlobals, scriptGlobalOf, scriptInitOf, scriptKeyOf } from '../../src/engine/script-surface.js'

describe('脚本可见性清单', () => {
  it('EvalContext 的每个字段都有归属（Record 完备性在编译期把守，这里抽运行期）', () => {
    for (const key of [
      'html', 'json', 'baseUrl', 'source', 'sourceComment', 'sourceName', 'book', 'chapter',
      'loginInfo', 'loginHeader', 'deviceId', 'vars', 'fetch', 'session', 'regexRow',
    ] as const) {
      expect(SCRIPT_FIELDS[key]).toBeDefined()
    }
  })

  it('普通字段从清单进 init，空值有稳定缺省', () => {
    const out = scriptInitOf({ html: '<p>x</p>', sourceComment: 'C', sourceName: 'S', book: { name: 'B' } })
    expect(out.src).toBe('<p>x</p>')
    expect(out.sourceComment).toBe('C')
    expect(out.sourceName).toBe('S')
    expect(out.book).toEqual({ name: 'B' })
    expect(out.baseUrl).toBe('')
    expect(out.loginInfo).toEqual({})
    expect(out.deviceId).toBe('')
  })

  it('src：html 优先；json 串原样；json 对象序列化', () => {
    expect(scriptInitOf({ html: '<p>x</p>', json: { a: 1 } }).src).toBe('<p>x</p>')
    expect(scriptInitOf({ json: '{"a":1}' }).src).toBe('{"a":1}')
    expect(scriptInitOf({ json: { a: 1 } }).src).toBe('{"a":1}')
  })

  it('物化字段的 init 键与全局名也从清单取', () => {
    expect(scriptKeyOf('book')).toBe('book')
    expect(scriptKeyOf('chapter')).toBe('chapter')
    expect(scriptKeyOf('source')).toBe('source')
    expect(scriptKeyOf('sourceName')).toBe('sourceName')
    expect(scriptKeyOf('sourceComment')).toBe('sourceComment')
    expect(scriptGlobalOf('book')).toBe('book')
    expect(scriptGlobalOf('chapter')).toBe('chapter')
    expect(scriptGlobalOf('source')).toBe('source')
    expect(() => scriptKeyOf('fetch')).toThrow('没有 init 键')
    expect(() => scriptGlobalOf('sourceName')).toThrow('没有全局名')
  })

  it('简单全局与清单同源：baseUrl / src；book/source 由 BOOTSTRAP 物化，不在此列', () => {
    expect(scriptGlobals()).toEqual(expect.arrayContaining([
      { name: 'baseUrl', key: 'baseUrl' },
      { name: 'src', key: 'src' },
    ]))
    expect(scriptGlobals().some((g) => g.name === 'book' || g.name === 'source')).toBe(false)
  })

  it('同一个 init 键只许由同一个取值函数产出（html/json 共用 src 是唯一合法重叠）', () => {
    const byKey = new Map<string, unknown>()
    for (const spec of Object.values(SCRIPT_FIELDS)) {
      if (spec.init !== 'visible') continue
      if (byKey.has(spec.key)) expect(spec.value, `init 键 ${spec.key} 的取值函数分叉`).toBe(byKey.get(spec.key))
      else byKey.set(spec.key, spec.value)
    }
    expect(byKey.has('src')).toBe(true)
  })
})
