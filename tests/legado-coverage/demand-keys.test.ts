import { describe, expect, it } from 'vitest'
import { DEMAND_KEYS, DEMAND_KEY_NAMES, KITCHEN_SINK } from './demand-keys.js'
import { COVERAGE } from './matrix.js'
import { DATE_ANCHOR } from './matrix-source.js'

/**
 * 需求读数绑定的默认门：矩阵行上的键与日期锚不必等真实书源库才能核。
 * `java.<名>` 类键没有面 D 判据——它们的数只从普查面 B 的调用名集现算。
 */
const JAVA_KEY = /^java\.[A-Za-z_][A-Za-z0-9_]*$/

describe('需求读数绑定（默认门）', () => {
  const demandRows = COVERAGE.filter((row) => row.demand !== undefined)

  it('矩阵行上的需求键都在面 D 的表里', () => {
    const bad: string[] = []
    for (const row of demandRows) {
      for (const d of row.demand ?? []) {
        if (JAVA_KEY.test(d.key)) continue
        if (!DEMAND_KEY_NAMES.has(d.key)) bad.push(`${row.id} → ${d.key}`)
      }
    }
    expect(bad, `这些键在面 D 里没有判据：\n${bad.join('\n')}`).toEqual([])
  })

  it('每条需求读数都带日期锚', () => {
    const bad: string[] = []
    for (const row of demandRows) {
      for (const d of row.demand ?? []) {
        if (!DATE_ANCHOR.test(d.asOf)) bad.push(`${row.id} → ${d.key}: ${d.asOf}`)
      }
    }
    expect(bad, `这些读数没有可回查的日期锚：\n${bad.join('\n')}`).toEqual([])
  })

  it('记为 0 的读数在反空转样品上数得出（分不清「没人用」与「判据坏了」）', () => {
    const byKey = new Map(DEMAND_KEYS.map((d) => [d.key, d]))
    const bad: string[] = []
    for (const row of demandRows) {
      for (const d of row.demand ?? []) {
        if (d.n !== 0 || JAVA_KEY.test(d.key)) continue
        const demand = byKey.get(d.key)
        if (demand === undefined) continue // 上一道判据负责报它
        if (!demand.test(KITCHEN_SINK)) bad.push(`${row.id} → ${d.key}`)
      }
    }
    expect(bad, `这些 0 读数在样品上也数不出东西：\n${bad.join('\n')}`).toEqual([])
  })

  it('面 D 判据在合成样品上不抛错，键名唯一', () => {
    expect(DEMAND_KEY_NAMES.size).toBe(DEMAND_KEYS.length)
    const bad: string[] = []
    for (const d of DEMAND_KEYS) {
      try {
        d.test(KITCHEN_SINK)
      } catch (e) {
        bad.push(`${d.key}: ${String(e)}`)
      }
    }
    expect(bad, `这些判据在合成样品上抛错：\n${bad.join('\n')}`).toEqual([])
  })
})
