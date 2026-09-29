import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { DEFAULT_JSON_BODY_MAX_BYTES } from '../../src/api/wire.js'
import { DEFAULT_CACHE_MAX_BYTES } from '../../src/services/cache.js'
import { DEFAULT_EXPORT_DELAY_MS } from '../../src/services/export.js'
import { DEFAULT_TIMEOUT_MS } from '../../src/services/fetcher.js'
import { DEFAULT_MAX_IMPORT_BYTES } from '../../src/services/localbooks.js'
import { DEFAULT_JS_BUDGET_MS, DEFAULT_SEARCH_PARALLEL } from '../../src/services/reading.js'

/**
 * 可调参数的**缺省值单点化**（口径与病史见 `docs/design/services.md` 已知开口 9：同一批数字原先在
 * 四处各写一份，生产路径显式传值，所以改岔了不会当场报错，只会让「配置表看到的默认值」与「服务层
 * 实际回退值」悄悄分叉）。
 *
 * 两类钉子：
 * ① 值本身钉死——改缺省是一次有意的产品行为变更，应当在这里留下一笔；
 * ② 组合根 `index.ts` 的 DEFAULTS 块里**不许出现数字字面量**——它是配置表的装配处，不是第二个主人。
 */
describe('可调参数的缺省值单点化', () => {
  it('值钉死（改这些数 = 改产品默认行为）', () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(15_000)
    expect(DEFAULT_JS_BUDGET_MS).toBe(15_000)
    expect(DEFAULT_SEARCH_PARALLEL).toBe(5)
    expect(DEFAULT_CACHE_MAX_BYTES).toBe(200 * 1024 * 1024)
    expect(DEFAULT_EXPORT_DELAY_MS).toBe(300)
    expect(DEFAULT_MAX_IMPORT_BYTES).toBe(50 * 1024 * 1024)
    expect(DEFAULT_JSON_BODY_MAX_BYTES).toBe(1024 * 1024)
  })

  it('index.ts 的 DEFAULTS 只引常量：块内不许出现数字字面量', () => {
    const src = readFileSync(new URL('../../src/index.ts', import.meta.url), 'utf8')
    const block = /const DEFAULTS = \{[\s\S]*?\n\}/.exec(src)?.[0] ?? ''
    expect(block, 'DEFAULTS 块没匹配到（改名或改形状时同步这条守卫）').not.toBe('')
    expect(block, '缺省值的主人各自在消费模块（见 services.md 已知开口 9）——在这里写回数字就是第二个主人')
      .not.toMatch(/\d/)
  })
})
