import { describe, expect, it } from 'vitest'
import { Config, resolveConfig, VOLATILE_CONSUMERS } from '../src/config.js'
import { DEFAULT_CACHE_MAX_BYTES } from '../src/services/cache.js'
import { DEFAULT_EXPORT_DELAY_MS } from '../src/services/export.js'
import { DEFAULT_TIMEOUT_MS } from '../src/services/fetcher.js'
import { DEFAULT_MAX_IMPORT_BYTES } from '../src/services/localbooks.js'
import { DEFAULT_SEARCH_PARALLEL } from '../src/services/reading.js'
import { DEFAULT_JS_BUDGET_MS } from '../src/services/source-eval.js'

/** 宿主 Loader 写活值的符号口（唯一名字来源是 `src/config.ts`；测试只做「写一次、读一次」） */
const VOLATILE_WRITE: unique symbol = Symbol.for('cosmokit.volatile.write')

function ref<T>(value: T): { get(): T; [VOLATILE_WRITE]: (next: T) => void } {
  let current = value
  return {
    get: () => current,
    [VOLATILE_WRITE]: (next: T) => { current = next },
  }
}

/** `Config` 是 schemastery 的**可调用**实例：输入档由 schema 派生，输出档在库里是 `Dict`
 *  （索引签名即 any）。测试要读的是「这一格是不是 ref」，故按判形收窄一次——读到的是 unknown，
 *  形状不符即响亮抛（schema 掉档意味着配置页那半失配）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isRef(value: unknown): value is { get(): unknown } {
  return isRecord(value) && 'get' in value && typeof value.get === 'function'
}

/** 一格 volatile 字段的读数：不是 ref 就是 schema 与用例脱节 */
function volatileOf(cfg: unknown, field: string): unknown {
  const value = isRecord(cfg) ? cfg[field] : undefined
  if (!isRef(value)) throw new Error(`Config.${field} 不是 volatile ref`)
  return value.get()
}

/** 一格静态字段的读数（纯值，可能是 undefined） */
function staticOf(cfg: unknown, field: string): unknown {
  return isRecord(cfg) ? cfg[field] : undefined
}

/** 静态格上的成员读（只用于「静态位不该长 ref 方法」这条反向断言） */
function memberOf(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined
}

describe('配置收缝', () => {
  it('volatile 字段是 ref；resolveConfig 仍是普通值', () => {
    const cfg = Config(undefined)
    expect(volatileOf(cfg, 'searchTimeoutMs')).toBe(DEFAULT_TIMEOUT_MS)
    expect(volatileOf(cfg, 'searchParallel')).toBe(DEFAULT_SEARCH_PARALLEL)
    expect(volatileOf(cfg, 'proxyUrl')).toBeUndefined()
    expect(resolveConfig(undefined)).toMatchObject({ searchTimeoutMs: DEFAULT_TIMEOUT_MS })
    expect(resolveConfig({}).dataDir).toBeUndefined()
  })
  it('已解析 ref 输入不二次校验，getter 读当前快照', () => {
    const searchTimeoutMs = ref(1000)
    const live = resolveConfig({ searchTimeoutMs })
    expect(live.searchTimeoutMs).toBe(1000)
    searchTimeoutMs[VOLATILE_WRITE](2000)
    expect(live.searchTimeoutMs).toBe(2000)
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
  it('volatile 字段的消费桶恰为现状地图（service-live 五格 / composition-root 两格）', () => {
    expect(VOLATILE_CONSUMERS).toEqual({
      searchTimeoutMs: 'service-live',
      searchParallel: 'service-live',
      jsTimeoutMs: 'service-live',
      cacheMaxBytes: 'service-live',
      localImportMaxBytes: 'service-live',
      exportDelayMs: 'composition-root',
      proxyUrl: 'composition-root',
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
        expect(() => resolveConfig({ [key]: bad }), `${key} ${String(bad)}`).toThrow(/配置非法/)
      }
    }
  })
  it('显式 null 按平台 default 语义填缺省（不是非法值；旧 assertConfig 会拒绝）', () => {
    expect(resolveConfig({ searchTimeoutMs: null }).searchTimeoutMs).toBe(DEFAULT_TIMEOUT_MS)
    expect(resolveConfig({ searchParallel: null }).searchParallel).toBe(DEFAULT_SEARCH_PARALLEL)
    // 无 default 的可选键：schema 原样给 null，配置缝归一成 undefined，类型与运行时一致
    expect(resolveConfig({ dataDir: null }).dataDir).toBeUndefined()
    expect(resolveConfig({ proxyUrl: null }).proxyUrl).toBeUndefined()
  })
  it('值域正边界：0 是合法缺省（cacheMaxBytes / exportDelayMs 允许 0）', () => {
    expect(resolveConfig({ cacheMaxBytes: 0 }).cacheMaxBytes).toBe(0)
    expect(resolveConfig({ exportDelayMs: 0 }).exportDelayMs).toBe(0)
  })
  it('类型错在加载期响亮（schema 只认类型不猜）', () => {
    expect(() => resolveConfig({ dataDir: 1 } as never)).toThrow(/配置非法/)
  })
  it('proxyUrl 形状闸：direct/空/裸主机/http(s) 接受，坏串拒绝', () => {
    expect(resolveConfig({ proxyUrl: 'direct' }).proxyUrl).toBe('direct')
    expect(resolveConfig({ proxyUrl: '' }).proxyUrl).toBe('')
    expect(resolveConfig({ proxyUrl: '127.0.0.1:7897' }).proxyUrl).toBe('127.0.0.1:7897')
    expect(resolveConfig({ proxyUrl: 'http://127.0.0.1:7897' }).proxyUrl).toBe('http://127.0.0.1:7897')
    expect(() => resolveConfig({ proxyUrl: 'http://bad host' })).toThrow(/配置非法/)
    expect(() => resolveConfig({ proxyUrl: 'ftp://127.0.0.1' })).toThrow(/配置非法/)
  })
  it('apiAllowHosts：形状闸只收 host / host:port，且它是静态位（fence 的名单不做热更）', () => {
    expect(resolveConfig({ apiAllowHosts: ['dsh.local'] }).apiAllowHosts).toEqual(['dsh.local'])
    expect(resolveConfig({ apiAllowHosts: ['dsh.local:8080'] }).apiAllowHosts).toEqual(['dsh.local:8080'])
    expect(resolveConfig({}).apiAllowHosts, '缺席 = 不追加任何名字').toEqual([])
    expect(resolveConfig({ apiAllowHosts: null }).apiAllowHosts).toEqual([])
    for (const bad of [['http://dsh.local'], ['dsh local'], ['dsh.local/path'], [''], [1]]) {
      expect(() => resolveConfig({ apiAllowHosts: bad as never }), JSON.stringify(bad)).toThrow(/配置非法/)
    }
    // 静态位：宿主声明里不是活 ref（改了要重启），与 dataDir 同档
    const cfg = Config(undefined)
    expect(typeof staticOf(cfg, 'apiAllowHosts'), '静态位不该是 ref').not.toBe('function')
    expect(memberOf(staticOf(cfg, 'apiAllowHosts'), 'get')).toBeUndefined()
  })
  it('apiAllowHosts：URL 解析会改写的主机名写法加载期拒绝（fence 侧静默丢弃 = 配置合法却毫无效果）', () => {
    for (const bad of [['2130706433'], ['0x7f000001'], ['0177.0.0.1'], ['2130706433:8080']]) {
      expect(() => resolveConfig({ apiAllowHosts: bad }), JSON.stringify(bad)).toThrow(/配置非法/)
    }
    // 只认「URL 解析不改写」的写法：自定义域名照收（大小写归一与端口剥除在 fence 侧做，配置原样留）
    expect(resolveConfig({ apiAllowHosts: ['dsh.local', 'DSH.LOCAL:8080'] }).apiAllowHosts)
      .toEqual(['dsh.local', 'DSH.LOCAL:8080'])
    expect(resolveConfig({ apiAllowHosts: ['127.0.0.1', 'localhost'] }).apiAllowHosts,
      '本机三值本身解析不改写').toEqual(['127.0.0.1', 'localhost'])
  })
})
