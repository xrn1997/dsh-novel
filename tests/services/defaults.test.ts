import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { DEFAULT_JSON_BODY_MAX_BYTES } from '../../src/api/wire.js'
import { DEFAULT_CACHE_MAX_BYTES } from '../../src/services/cache.js'
import { DEFAULT_EXPORT_DELAY_MS } from '../../src/services/export.js'
import { DEFAULT_TIMEOUT_MS } from '../../src/services/fetcher.js'
import { DEFAULT_MAX_IMPORT_BYTES } from '../../src/services/localbooks.js'
import { DEFAULT_JS_BUDGET_MS, DEFAULT_SEARCH_PARALLEL } from '../../src/services/reading.js'

/**
 * 可调参数的**缺省值单点化**（病史：同一批数字原先在
 * 四处各写一份，生产路径显式传值，所以改岔了不会当场报错，只会让「配置表看到的默认值」与「服务层
 * 实际回退值」悄悄分叉）。
 *
 * 两类钉子：
 * ① 值本身钉死——改缺省是一次有意的产品行为变更，应当在这里留下一笔；
 * ② 配置缝 `config.ts` 的 schema 缺省只引常量——它是缺省值的装配处，不是第二个主人。
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

  it('config.ts 的字段表缺省只引常量：数值位一律 numberField(DEFAULT_*, 下界)', () => {
    const src = readFileSync(new URL('../../src/config.ts', import.meta.url), 'utf8')
    // 先剥注释：注释里出现 `.default(0)` 不是 schema 缺省，不该把守卫弄红。
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
    // 六个数值位各引一个消费模块常量作缺省：少一个就是有人把某项缺省挪走或在表里写死数字
    const rowConstants = [...code.matchAll(/numberField\((DEFAULT_[A-Z0-9_]+),/g)].map((m) => m[1]).sort()
    expect(rowConstants).toEqual([
      'DEFAULT_CACHE_MAX_BYTES', 'DEFAULT_EXPORT_DELAY_MS', 'DEFAULT_JS_BUDGET_MS',
      'DEFAULT_MAX_IMPORT_BYTES', 'DEFAULT_SEARCH_PARALLEL', 'DEFAULT_TIMEOUT_MS',
    ])
    // schema 的 `.default(...)` 参数（表里只剩装配那一条）不许掺数字字面量——缺省的主人各自在消费模块
    for (const arg of [...code.matchAll(/\.default\(([^)]*)\)/g)].map((m) => m[1])) {
      expect(arg, '缺省值的主人各自在消费模块——在 schema 写回数字就是第二个主人').not.toMatch(/\d/)
    }
  })
})
