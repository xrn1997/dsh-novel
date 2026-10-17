import { describe, expect, it } from 'vitest'
import { Config, resolveConfig } from '../src/config.js'
import { DEFAULT_CACHE_MAX_BYTES } from '../src/services/cache.js'
import { DEFAULT_EXPORT_DELAY_MS } from '../src/services/export.js'
import { DEFAULT_TIMEOUT_MS } from '../src/services/fetcher.js'
import { DEFAULT_MAX_IMPORT_BYTES } from '../src/services/localbooks.js'
import { DEFAULT_JS_BUDGET_MS, DEFAULT_SEARCH_PARALLEL } from '../src/services/reading.js'

describe('配置收缝', () => {
  it('默认值与值域都住 schema：undefined / {} / 字段缺失都按默认填（3.18.4 实测语义）', () => {
    expect(Config(undefined as any)).toMatchObject({ searchTimeoutMs: DEFAULT_TIMEOUT_MS })
    expect(Config({} as any)).toMatchObject({ searchParallel: DEFAULT_SEARCH_PARALLEL })
    expect(Config({ searchTimeoutMs: 1000 } as any)).toMatchObject({
      searchTimeoutMs: 1000, searchParallel: DEFAULT_SEARCH_PARALLEL,
    })
    expect(resolveConfig(undefined)).toMatchObject({ searchTimeoutMs: DEFAULT_TIMEOUT_MS })
    expect(resolveConfig({}).dataDir).toBeUndefined()     // 无默认的键不硬造
  })
  it('六项缺省各自引消费模块常量（映射不许写反）', () => {
    expect(resolveConfig(undefined)).toMatchObject({
      searchTimeoutMs: DEFAULT_TIMEOUT_MS,
      searchParallel: DEFAULT_SEARCH_PARALLEL,
      jsTimeoutMs: DEFAULT_JS_BUDGET_MS,
      cacheMaxBytes: DEFAULT_CACHE_MAX_BYTES,
      exportDelayMs: DEFAULT_EXPORT_DELAY_MS,
      localImportMaxBytes: DEFAULT_MAX_IMPORT_BYTES,
    })
  })
  it('值域非法在加载期响亮失败，不静默夹紧（searchParallel ≤ 0 批循环 i+=0 会永久挂起）', () => {
    expect(() => resolveConfig({ searchParallel: 0 })).toThrow(/配置非法/)
    expect(() => resolveConfig({ searchParallel: -1 })).toThrow(/配置非法/)
    expect(() => resolveConfig({ searchParallel: 1.5 })).toThrow(/配置非法/)
    expect(() => resolveConfig({ searchTimeoutMs: 0 })).toThrow(/配置非法/)
    expect(() => resolveConfig({ jsTimeoutMs: 0 })).toThrow(/配置非法/)
    expect(() => resolveConfig({ cacheMaxBytes: -1 })).toThrow(/配置非法/)
    expect(() => resolveConfig({ exportDelayMs: -1 })).toThrow(/配置非法/)
    expect(() => resolveConfig({ localImportMaxBytes: 0 })).toThrow(/配置非法/)
  })
  it('NaN / Infinity 也在加载期拒绝（.min/.max 对 NaN 为假，.step(1) 才挡得住）', () => {
    const keys = [
      'searchTimeoutMs', 'searchParallel', 'jsTimeoutMs',
      'cacheMaxBytes', 'exportDelayMs', 'localImportMaxBytes',
    ] as const
    for (const key of keys) {
      for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
        expect(() => resolveConfig({ [key]: bad } as never), `${key} ${String(bad)}`).toThrow(/配置非法/)
      }
    }
  })
  it('显式 null 按平台 default 语义填缺省（不是非法值；旧 assertConfig 会拒绝）', () => {
    expect(resolveConfig({ searchTimeoutMs: null as any }).searchTimeoutMs).toBe(DEFAULT_TIMEOUT_MS)
    expect(resolveConfig({ searchParallel: null as any }).searchParallel).toBe(DEFAULT_SEARCH_PARALLEL)
    // 无 default 的可选键：schema 原样给 null，配置缝归一成 undefined，类型与运行时一致
    expect(resolveConfig({ dataDir: null as any }).dataDir).toBeUndefined()
    expect(resolveConfig({ proxyUrl: null as any }).proxyUrl).toBeUndefined()
  })
  it('值域正边界：0 是合法缺省（cacheMaxBytes / exportDelayMs 允许 0）', () => {
    expect(resolveConfig({ cacheMaxBytes: 0 }).cacheMaxBytes).toBe(0)
    expect(resolveConfig({ exportDelayMs: 0 }).exportDelayMs).toBe(0)
  })
  it('类型错在加载期响亮（schema 只认类型不猜）', () => {
    expect(() => resolveConfig({ dataDir: 1 } as any)).toThrow(/配置非法/)
  })
})
