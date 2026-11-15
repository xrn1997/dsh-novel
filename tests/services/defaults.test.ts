import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { DEFAULT_JSON_BODY_MAX_BYTES } from '../../src/api/wire.js'
import { resolveConfig } from '../../src/config.js'
import { DEFAULT_CACHE_MAX_BYTES } from '../../src/services/cache.js'
import { DEFAULT_EXPORT_DELAY_MS } from '../../src/services/export.js'
import { DEFAULT_TIMEOUT_MS } from '../../src/services/fetcher.js'
import { DEFAULT_MAX_IMPORT_BYTES } from '../../src/services/localbooks.js'
import { DEFAULT_SEARCH_PARALLEL, staticLiveConfig } from '../../src/services/reading.js'
import { DEFAULT_JS_BUDGET_MS } from '../../src/services/source-eval.js'
import { DEFAULT_TTS_CACHE_MAX_BYTES } from '../../src/services/tts-cache.js'
import { TTS_DEFAULTS } from '../../src/shared/wire.js'
import { DEFAULT_JS_TIMEOUT_MS } from '../../src/engine/types.js'

/**
 * 可调参数的**缺省值单点化**：每个数字只有一个主人（消费模块的 `DEFAULT_*` 常量）。
 * 生产路径显式传值，所以缺省改岔不会当场报错，只会让「配置表看到的默认值」与「服务层
 * 实际回退值」悄悄分叉——这两条钉子守的就是这个分叉。
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
    // 听书缺省：内置百度口 + 语速 1 + 音量 0.8 + 下章预取 10 段（缓存上限 128 MiB 由 tts-cache 的用例钉住）
    expect(TTS_DEFAULTS.engineId).toBe('builtin:baidu')
    expect(TTS_DEFAULTS.rate).toBe(1)
    expect(TTS_DEFAULTS.volume).toBe(0.8)
    expect(TTS_DEFAULTS.prefetchParagraphs).toBe(10)
  })

  it('引擎缺省与配置缺省同值（单一缺省主人）', () => {
    expect(DEFAULT_JS_TIMEOUT_MS).toBe(DEFAULT_JS_BUDGET_MS)   // 15_000
  })

  it('staticLiveConfig 服务恰为十一格活值缺省，缺省逐格 === resolveConfig(undefined)', () => {
    const served = staticLiveConfig({})
    const names = [
      'searchTimeoutMs', 'searchParallel', 'jsTimeoutMs',
      'cacheMaxBytes', 'exportDelayMs', 'localImportMaxBytes',
      'ttsDefaultEngine', 'ttsDefaultRate', 'ttsDefaultVolume',
      'ttsCacheMaxBytes', 'ttsPrefetchParagraphs',
    ] as const
    expect(Object.keys(served).sort()).toEqual([...names].sort())
    const resolved = resolveConfig(undefined)
    for (const name of names) {
      expect(served[name], name).toBe(resolved[name])
    }
  })

  it('served 读数含听书五字段：缺省与消费模块常量同值', () => {
    const served = staticLiveConfig({})
    expect(served.ttsDefaultEngine).toBe(TTS_DEFAULTS.engineId)
    expect(served.ttsDefaultRate).toBe(TTS_DEFAULTS.rate)
    expect(served.ttsDefaultVolume).toBe(TTS_DEFAULTS.volume)
    expect(served.ttsCacheMaxBytes).toBe(DEFAULT_TTS_CACHE_MAX_BYTES)
    expect(served.ttsPrefetchParagraphs).toBe(TTS_DEFAULTS.prefetchParagraphs)
  })

  it('config.ts 的字段表缺省只引常量：枚举每个字段构造调用，逐个断言首参是导入常量', () => {
    const src = readFileSync(new URL('../../src/config.ts', import.meta.url), 'utf8')
    // 先剥注释：注释里出现 `.default(0)` 不是 schema 缺省，不该把守卫弄红。
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
    /** 表里每一行对某个字段构造器的实参清单：构造器**定义**本身不算调用（`function numberField(`）。 */
    const rowArgs = (ctor: string): string[][] =>
      [...code.matchAll(new RegExp(`(?<!function )\\b${ctor}\\(([^)]*)\\)`, 'g'))]
        .map((m) => (m[1] ?? '').split(',').map((part) => part.trim()))
    const CONST = /^(DEFAULT_[A-Z0-9_]+|TTS_DEFAULTS\.[a-zA-Z]+)$/
    /** 结构闸：枚举的是**所有**调用，不是「首参恰好是常量的那些调用」——新增一行把数字 / 字面量
     *  写进缺省位，不会从名单里消失，只会在逐行断言这里红（旧判据扫不到这种行）。 */
    const constantFirstArgs = (ctor: string): string[] => {
      const rows = rowArgs(ctor)
      for (const args of rows) {
        expect(args[0] ?? '', `${ctor} 的缺省必须是导入常量，不能写字面量`).toMatch(CONST)
      }
      return rows.map((args) => args[0] ?? '').sort()
    }
    expect(constantFirstArgs('numberField'), 'numberField 的缺省常量名单').toEqual([
      'DEFAULT_CACHE_MAX_BYTES', 'DEFAULT_EXPORT_DELAY_MS', 'DEFAULT_JS_BUDGET_MS',
      'DEFAULT_MAX_IMPORT_BYTES', 'DEFAULT_SEARCH_PARALLEL', 'DEFAULT_TIMEOUT_MS',
      'DEFAULT_TTS_CACHE_MAX_BYTES', 'TTS_DEFAULTS.prefetchParagraphs',
    ])
    expect(constantFirstArgs('decimalField')).toEqual(['TTS_DEFAULTS.rate', 'TTS_DEFAULTS.volume'])
    // 第二参允许一枚正则字面量（形状闸，如引擎标识不许含空白）：它不是缺省值的主人，
    // 缺省仍必须是常量——写成字面量串同样在逐行断言那里红。
    expect(constantFirstArgs('volatileTextField')).toEqual(['TTS_DEFAULTS.engineId'])
    // schema 的 `.default(...)` 参数（表里只剩装配那一条）不许掺数字字面量——缺省的主人各自在消费模块
    for (const arg of [...code.matchAll(/\.default\(([^)]*)\)/g)].map((m) => m[1])) {
      expect(arg, '缺省值的主人各自在消费模块——在 schema 写回数字就是第二个主人').not.toMatch(/\d/)
    }
  })
})
