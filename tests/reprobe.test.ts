import { describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ReadingService } from '../src/services/reading.js'
import { makeTempDir, trackService } from './temp-dir.js'

// 真机重探（DSH_REPROBE=1 门控——全量真打网络，几分钟量级；不进常规集）
// 用途：引擎/请求形态改动后实测 verified 率变化（compat 跑通率就是验收标准本身）
//
// 读数口径：`导入失败` 桶 = **入库闸拒**（非文本源/未知类型，与矩阵 j-audio-image-file 同源），
// 不是缺陷也不参探针；其余是真打网络的结果（FetchError/超时=站点或链路脸色）。
// 引擎类失败（RuleEval/JsSandbox/UnsupportedRule）**逐条点名**——只有这几类可能归因到本仓；
// 2026-09-28 那三条逐条落地核过，全是站点侧（人机验证页 / JS 反爬壳 / 镜像站页面），如实报 0 命中
// 不冒充 verified 即正确行为。
// 跨版本别比聚合数：分母随用户增删漂，站点可用率整体波动。

describe.skipIf(process.env.DSH_REPROBE !== '1')('真机重探（全量 probe 统计）', () => {
  it('sources.json 全量重探 → verified 率 + 失败分布', { timeout: 1_800_000 }, async () => {
    const sj = path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'novel', 'sources.json')
    const sources = JSON.parse(await fs.readFile(sj, 'utf8')) as Array<{ raw: unknown }>
    const dir = await makeTempDir('novel-reprobe-')
    const svc = trackService(await ReadingService.create({ dir }))
    let verified = 0
    const reasons = new Map<string, number>()
    /** 引擎类失败逐条点名：桶计数看不出是谁，而只有这几类是本仓可归因的 */
    const engineFails: Array<{ name: string; code: string; msg: string }> = []
    const queue = [...sources]
    const workers = Array.from({ length: 8 }, async () => {
      for (;;) {
        const item = queue.shift()
        if (item === undefined) return
        try {
          const out = await svc.importOne(item.raw)
          // 导入不探针——重探统计口径：导入后显式探一次
          const probe = out.sourceId === null || out.sourceId === undefined ? null : await svc.probe(out.sourceId)
          if (probe?.ok === true) verified++
          else {
            const code = probe?.error?.code ?? (out.ok ? '(无探针)' : '导入失败')
            reasons.set(code, (reasons.get(code) ?? 0) + 1)
            if (code !== '导入失败' && code !== '(无探针)') {
              const raw = item.raw as { bookSourceName?: string } | null
              engineFails.push({
                name: String(raw?.bookSourceName ?? '(未命名)'),
                code,
                msg: String(probe?.error?.message ?? '').replace(/\s+/g, ' ').slice(0, 140),
              })
            }
          }
        } catch { reasons.set('异常', (reasons.get('异常') ?? 0) + 1) }
      }
    })
    await Promise.all(workers)
    await svc.flush()
    const dist = [...reasons].sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `[${v}] ${k}`).join('; ')
    console.log(`\n=== 重探结果 ===\n总计 ${sources.length}；verified ${verified}（${(verified / sources.length * 100).toFixed(1)}%）\n失败分布：${dist}\n`)
    // 引擎类失败逐条点名（RuleEval/JsSandbox 可能归因本仓；Fetch/网络不是——口径见文件头）
    const engineOnly = engineFails.filter((f) => /RuleEvalError|UnsupportedRuleError|JsSandboxError/.test(f.code))
    if (engineOnly.length > 0) {
      console.log(`引擎类失败 ${engineOnly.length} 条：`)
      for (const f of engineOnly) console.log(`  [${f.code}] ${f.name}: ${f.msg}`)
    }
    expect(sources.length).toBeGreaterThan(0)
  })
})
