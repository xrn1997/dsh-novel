/**
 * 事实通道的三条边界：**半径由名字决定**（调用点填不了）、**处数如实累加**（不受例子上限影响）
 * 与**例子有界**。
 *
 * 有界这条是硬约束：计数与例子分开——处数无上限，例子到上限就不再收集（也不再去重查找）。
 * 原因：一部含三万条互不相同外链的正文（79 KB，远在各项字节预算内）若对每个新细节做一次去重
 * 并把它们全留着，会在那里同步阻塞十几秒，而那期间宿主线程什么都不干。
 * `warningListOf` 只展示前三，留更多没人读。
 *
 * 半径与严重度来自 `FINDING_RADII`：同一句动作发生在不同半径上（一处元素 vs 一份文档）是两件
 * 不同的事，折叠成一条会把「这本书缺什么」的读数说错；而表里没有 `book` + `fatal` 那一格，
 * 所以这条通道发不出「整本书读不出」那种痕（整本拒走 `errors.ts` 的 `rejectBook`）。
 */
import { describe, expect, it } from 'vitest'
import { FINDING_RADII, FindingLog, warningListOf, type FindingScope, type FindingSeverity } from '../../src/services/epub/findings.js'
import { must, pick } from '../support/fixture.js'

const CODE = 'epub-external-link'
const RES = 'OEBPS/ch1.xhtml'
const ACTION = '取消了书外链接的可点击性'

/** 从合并后的 message 里取「例：…」那一段的例子（没写就是空表） */
function examplesOf(message: string): string[] {
  const m = /例：([^）]*)）/.exec(message)
  if (m === null) return []
  const joined = must(m[1], 'm[1]')
  return joined === '' ? [] : joined.split('、')
}

describe('FindingLog：半径、合并、计数与例子上限', () => {
  it('半径由名字决定：发出的那条自带表里登记的 scope 与 severity；投影形状不变', () => {
    const log = new FindingLog()
    log.add('documentDegraded', 'epub-removed-inline-svg', 'text/a.xhtml', '移除了内联 SVG', '<svg>')
    const entry = must(log.entries()[0], 'entries()[0]')
    expect(entry.scope).toBe(FINDING_RADII.documentDegraded.scope)
    expect(entry.severity).toBe(FINDING_RADII.documentDegraded.severity)
    expect(entry.count).toBe(1)
    expect(warningListOf(log.entries())).toEqual([{ code: 'epub-removed-inline-svg', resource: 'text/a.xhtml', message: '移除了内联 SVG：<svg>' }])
  })

  it('这条通道发不出整本拒：半径表里没有任何一格是 book + fatal', () => {
    // 按声明类型读这张表（不是按字面量窄化后的类型）：表要是添了一格 book+fatal，这里就红
    const pairs: Array<{ scope: FindingScope; severity: FindingSeverity }> = Object.values(FINDING_RADII)
    expect(pairs.filter((r) => r.scope === 'book' && r.severity === 'fatal')).toEqual([])
  })

  it('同码同半径 + 同资源 + 同动作合并成一条，处数写在开头', () => {
    const log = new FindingLog()
    log.add('elementRemoved', CODE, RES, ACTION, 'https://a.invalid/1')
    log.add('elementRemoved', CODE, RES, ACTION, 'https://a.invalid/2')
    expect(warningListOf(log.entries())).toEqual([{ code: CODE, resource: RES, message: `2 处：${ACTION}（例：https://a.invalid/1、https://a.invalid/2）` }])
  })

  it('同码同资源同动作但**半径不同**：各成一条（两件不同的事不折叠）', () => {
    const log = new FindingLog()
    log.add('elementRemoved', CODE, RES, ACTION, 'x')
    log.add('documentDegraded', CODE, RES, ACTION, 'x')
    expect(log.entries()).toHaveLength(2)
    expect(warningListOf(log.entries())).toHaveLength(2)
  })

  it('单处且带细节：不写处数前缀，细节直接跟在动作后', () => {
    const log = new FindingLog()
    log.add('elementRemoved', CODE, RES, ACTION, 'https://a.invalid/1')
    expect(pick(warningListOf(log.entries()), 0).message).toBe(`${ACTION}：https://a.invalid/1`)
  })

  it('例子最多留三个，处数**不受**上限影响', () => {
    const log = new FindingLog()
    const total = 10_000
    for (let i = 0; i < total; i += 1) log.add('elementRemoved', CODE, RES, ACTION, `https://example.invalid/${i}`)
    const list = warningListOf(log.entries())
    expect(list).toHaveLength(1)
    const only = pick(list, 0)
    expect(only.message).toMatch(new RegExp(`^${total} 处`))          // 处数一个不少
    const examples = examplesOf(only.message)
    expect(examples).toHaveLength(3)                                     // 例子被上限截住
    for (const e of examples) expect(e).toMatch(/^https:\/\/example\.invalid\/\d+$/)
  })

  it('重复出现的同一条细节：计数照加，不重复占例子位', () => {
    const log = new FindingLog()
    log.add('elementRemoved', CODE, RES, ACTION, 'https://a.invalid/1')
    log.add('elementRemoved', CODE, RES, ACTION, 'https://a.invalid/1')
    log.add('elementRemoved', CODE, RES, ACTION, 'https://a.invalid/2')
    const m = pick(warningListOf(log.entries()), 0).message
    expect(m).toMatch(/^3 处/)
    expect(examplesOf(m)).toEqual(['https://a.invalid/1', 'https://a.invalid/2'])
  })

  it('不同资源或不同动作各成一条（合并只按那五个键）', () => {
    const log = new FindingLog()
    log.add('elementRemoved', CODE, RES, ACTION, 'x')
    log.add('elementRemoved', CODE, 'OEBPS/ch2.xhtml', ACTION, 'x')
    log.add('elementRemoved', CODE, RES, '另一件事', 'x')
    expect(warningListOf(log.entries())).toHaveLength(3)
  })

  it('addEntry 并入低层交回的事实：同键处数相加，两边的例子都不丢', () => {
    const pkg = new FindingLog()
    pkg.add('itemNoted', 'epub-navigation-unordered-list', 'OEBPS/nav.xhtml', 'toc 列表用 ul', 'ul')
    pkg.add('itemNoted', 'epub-navigation-unordered-list', 'OEBPS/nav.xhtml', 'toc 列表用 ul', 'ul')
    const log = new FindingLog()
    log.add('itemNoted', 'epub-navigation-unordered-list', 'OEBPS/nav.xhtml', 'toc 列表用 ul', 'ol')
    for (const entry of pkg.entries()) log.addEntry(entry)
    const entries = log.entries()
    expect(entries).toHaveLength(1)
    const merged = pick(entries, 0)
    expect(merged.count).toBe(3)
    // 按处数重放会把并入那一本的例子折掉；合并事实就不该丢例子
    expect(merged.details).toContain('ol')
    expect(merged.details).toContain('ul')
    expect(warningListOf(log.entries())).toHaveLength(1)
  })
})
