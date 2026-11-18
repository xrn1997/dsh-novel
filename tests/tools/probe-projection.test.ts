import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * 探针 verdict → status 的**唯一判定**住 `services/probe.ts` 的 `applyProbeResult`：它交出
 * `ProbeOutcome`（wire 读数 + 已写回的 status），HTTP 面只写 `result`、工具面只投影 `status`。
 * 工具面若再自己推一遍 `r.ok ? 'verified' : 'broken'`，同一判据就有了两个表达——这条门禁住它。
 *
 * 只扫 `src/tools/`：浏览器半从 HTTP 拿到的是 wire 的 `ProbeResult`（契约里没有 status），
 * 徽章那一处判定走的是另一条读面，不在本判据下（wire 冻结，服务端也不替它补字段）。
 * 持久状态只有一个写口那条门在 `tests/services/probe-status-single-writer.test.ts`。
 */

const TOOLS = fileURLToPath(new URL('../../src/tools', import.meta.url))

/** `ok ? 'verified' : 'broken'` 这一族的算式（单双引号都算）。 */
const VERDICT_FORMULA = /['"]verified['"]\s*:\s*['"]broken['"]/

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    if (e.isDirectory()) return tsFiles(p)
    return e.name.endsWith('.ts') ? [p] : []
  })
}

describe('工具面只投影探针 outcome', () => {
  it('tools/ 下没有 `ok ? verified : broken` 这条第二算式', () => {
    const offenders = tsFiles(TOOLS)
      .filter((abs) => VERDICT_FORMULA.test(readFileSync(abs, 'utf8')))
      .map((abs) => relative(TOOLS, abs).split(sep).join('/'))
    expect(offenders, `工具面又自己推了一遍 verdict→status：${offenders.join(', ')}`).toEqual([])
  })

  it('判据认得出算式（正控）', () => {
    // 门空转时上面那条会因全仓一次也不出现而假绿；这条让「判据本身失效」也红。
    expect(VERDICT_FORMULA.test("status: r.ok ? 'verified' : 'broken'")).toBe(true)
    expect(VERDICT_FORMULA.test('status: { verified: true, broken: false }')).toBe(false)
  })
})
