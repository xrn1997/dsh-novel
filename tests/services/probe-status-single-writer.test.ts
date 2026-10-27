import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * 探针 verdict → status 的**唯一写口**：`probe.applyProbeResult`。
 *
 * 为什么要有机器门：这条 invariant 只能靠机器守——任何新调用方（任务重试、工具面、将来的自动复检）
 * 都能悄悄写出第三处
 * `registry.edit(setStatus)`，而 detail 清空 / probedAt 盖章的口径不会跟着改。
 * 门只认调用点：`setStatus(` 只许出现在 applyProbeResult 与注册表自己的 `SourceEdit` 实现里。
 */

const SRC = fileURLToPath(new URL('../../src', import.meta.url))

/** 允许出现 `setStatus(` 的两个文件（`src/` 相对路径、`/` 分隔）。 */
const OWNERS = new Set(['services/probe.ts', 'services/sources.ts'])

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    if (e.isDirectory()) return tsFiles(p)
    return e.name.endsWith('.ts') ? [p] : []
  })
}

/** 生产文件的 `src/` 相对路径（`/` 分隔），与 OWNERS 同形。 */
function relativeFiles(): string[] {
  return tsFiles(SRC).map((abs) => relative(SRC, abs).split(sep).join('/'))
}

describe('探针 verdict → status 单写者', () => {
  it('`setStatus(` 只出现在 probe.applyProbeResult 与注册表自身', () => {
    const stray = relativeFiles()
      .filter((rel) => !OWNERS.has(rel))
      .filter((rel) => readFileSync(join(SRC, rel), 'utf8').includes('setStatus('))
    expect(stray).toEqual([])
  })

  it('两个写口都还在（防空转门）', () => {
    // 写口被改名/删除时上一条会因全仓一次也不出现而假绿；这条让「门本身失效」也红。
    expect(readFileSync(join(SRC, 'services', 'probe.ts'), 'utf8')).toContain('setStatus(')
    expect(readFileSync(join(SRC, 'services', 'sources.ts'), 'utf8')).toContain('setStatus(')
  })
})
