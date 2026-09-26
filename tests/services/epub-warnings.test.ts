/**
 * 告警合并器的两条边界：**处数如实累加**（不受例子上限影响）与**例子有界**。
 *
 * 有界这条不是优化：`add` 原先对每个新细节做一次 `includes` 去重并把它们**全留着**，于是
 * 一部含三万条互不相同外链的正文（79 KB，远在各项字节预算内）会在那里同步阻塞十几秒
 * （实测 13.3s + 十万字节字符串），而那期间宿主线程什么都不干。`list()` 只展示前三，
 * 留更多没人读——所以计数与例子分开：处数无上限，例子到上限就不再收集（也不再去重查找）。
 */
import { describe, expect, it } from 'vitest'
import { EpubWarningLog } from '../../src/services/epub/warnings.js'

const CODE = 'epub-external-link'
const RES = 'OEBPS/ch1.xhtml'
const ACTION = '取消了书外链接的可点击性'

/** 从合并后的 message 里取「例：…」那一段的例子（没写就是空表） */
function examplesOf(message: string): string[] {
  const m = /例：([^）]*)）/.exec(message)
  return m === null || m[1] === '' ? [] : m[1].split('、')
}

describe('EpubWarningLog：合并、计数与例子上限', () => {
  it('同码 + 同资源 + 同动作合并成一条，处数写在开头', () => {
    const log = new EpubWarningLog()
    log.add(CODE, RES, ACTION, 'https://a.invalid/1')
    log.add(CODE, RES, ACTION, 'https://a.invalid/2')
    expect(log.list()).toEqual([{ code: CODE, resource: RES, message: `2 处：${ACTION}（例：https://a.invalid/1、https://a.invalid/2）` }])
  })

  it('单处且带细节：不写处数前缀，细节直接跟在动作后', () => {
    const log = new EpubWarningLog()
    log.add(CODE, RES, ACTION, 'https://a.invalid/1')
    expect(log.list()[0].message).toBe(`${ACTION}：https://a.invalid/1`)
  })

  it('例子最多留三个，处数**不受**上限影响', () => {
    const log = new EpubWarningLog()
    const total = 10_000
    for (let i = 0; i < total; i += 1) log.add(CODE, RES, ACTION, `https://example.invalid/${i}`)
    const list = log.list()
    expect(list).toHaveLength(1)
    expect(list[0].message).toMatch(new RegExp(`^${total} 处`))          // 处数一个不少
    const examples = examplesOf(list[0].message)
    expect(examples).toHaveLength(3)                                     // 例子被上限截住
    for (const e of examples) expect(e).toMatch(/^https:\/\/example\.invalid\/\d+$/)
  })

  it('重复出现的同一条细节：计数照加，不重复占例子位', () => {
    const log = new EpubWarningLog()
    log.add(CODE, RES, ACTION, 'https://a.invalid/1')
    log.add(CODE, RES, ACTION, 'https://a.invalid/1')
    log.add(CODE, RES, ACTION, 'https://a.invalid/2')
    const m = log.list()[0].message
    expect(m).toMatch(/^3 处/)
    expect(examplesOf(m)).toEqual(['https://a.invalid/1', 'https://a.invalid/2'])
  })

  it('不同资源或不同动作各成一条（合并只按三个键）', () => {
    const log = new EpubWarningLog()
    log.add(CODE, RES, ACTION, 'x')
    log.add(CODE, 'OEBPS/ch2.xhtml', ACTION, 'x')
    log.add(CODE, RES, '另一件事', 'x')
    expect(log.list()).toHaveLength(3)
  })
})
