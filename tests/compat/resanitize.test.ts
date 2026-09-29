import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { sanitize } from './sanitize.js'

/**
 * 已采 fixture 的**再脱敏**（`COMPAT_RESANITIZE=1` 门控；默认 skip，不进常规集）。
 * 脱敏规则会演进（2026-09-28 修过一次），而 fixture 一旦入库字节就该稳定（回放断言钉在它上面），
 * 不能靠「重新采集」来洗——那要赌站点脸色。本工具就地重放新规则：只改真的变了字节，跑完核对
 * 「再跑一遍零改动」（幂等）。
 * 用法：`COMPAT_RESANITIZE=1 pnpm vitest run --config vitest.compat.config.ts tests/compat/resanitize.test.ts`
 */
describe.skipIf(process.env.COMPAT_RESANITIZE !== '1')('fixture 再脱敏（规则改了就重洗一遍）', () => {
  it('就地重洗每个 case 的 pages，且幂等', () => {
    const fixtures = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'compat', 'fixtures')
    if (!existsSync(fixtures)) return
    let touched = 0
    let files = 0
    for (const entry of readdirSync(fixtures, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const pages = join(fixtures, entry.name, 'pages')
      if (!existsSync(pages)) continue
      for (const f of readdirSync(pages)) {
        if (!/\.html$/.test(f)) continue
        const p = join(pages, f)
        const before = readFileSync(p, 'utf8')
        const after = sanitize(before)
        files++
        if (after !== before) { writeFileSync(p, after, 'utf8'); touched++ }
      }
    }
    // 幂等自检：同一批再洗一遍应零改动
    let again = 0
    for (const entry of readdirSync(fixtures, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const pages = join(fixtures, entry.name, 'pages')
      if (!existsSync(pages)) continue
      for (const f of readdirSync(pages)) {
        if (!/\.html$/.test(f)) continue
        const p = join(pages, f)
        if (sanitize(readFileSync(p, 'utf8')) !== readFileSync(p, 'utf8')) again++
      }
    }
    console.log(`[compat] 再脱敏：${files} 个页面，改动 ${touched} 个；幂等复检残留 ${again} 个`)
    expect(again).toBe(0)
  })
})
