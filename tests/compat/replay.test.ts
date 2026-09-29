import { afterAll, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { loadCases, renderReport, runCase } from './harness.js'

// case 布局：compat/fixtures/<caseName>/（README 钉死）——loadCases 扫 root 子目录
const root = path.resolve('compat/fixtures')
const cases = loadCases(root)
const keywordOfFirst = cases[0]?.manifest.keyword

describe('compat 全链路回放', () => {
  if (cases.length === 0) {
    // 空分母不许当通过：`compat/fixtures/` 里那条手写基线是**入库内容**，它不见了就等于回放面
    // 整条不再验证任何东西——报红，不给「跑了一个空测试」的机会（skip-if-missing 是本仓删掉的旧失效模式）。
    it('compat case 为空——分母消失，回放面没在验证任何东西', () => {
      expect(cases.length, 'compat/fixtures 下数不到 case：手写基线被删/挪走？采集与入库口径见 compat/README.md').toBeGreaterThan(0)
    })
  }
  for (const c of cases) {
    it(`${c.caseName} 全链路`, async () => {
      const r = await runCase(c)
      const fail = r.steps.find((s) => !s.ok)
      if (fail !== undefined) throw new Error(`[${fail.face}] ${fail.error!.code}: ${fail.error!.message}`)
      expect(r.ok).toBe(true)
    })
  }
  afterAll(async () => {
    // afterAll 重跑一遍拿全量 CaseResult 写报告——case 少、纯离线，双跑钉死接受（>100 case 再优化共享缓存）
    const results = []
    for (const c of cases) results.push(await runCase(c))
    await fs.writeFile(path.resolve('compat/report.md'), renderReport(results, keywordOfFirst), 'utf8')
  })
})
