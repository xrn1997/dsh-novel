import Schema from '@deepseek-ai/schemastery'
import { hostNameOf } from './api/wire.js'
import { DEFAULT_CACHE_MAX_BYTES } from './services/cache.js'
import { DEFAULT_EXPORT_DELAY_MS } from './services/export.js'
import { DEFAULT_TIMEOUT_MS } from './services/fetcher.js'
import { DEFAULT_MAX_IMPORT_BYTES } from './services/localbooks.js'
import { DEFAULT_JS_BUDGET_MS } from './services/source-eval.js'
import { DEFAULT_TTS_CACHE_MAX_BYTES } from './services/tts-cache.js'
import { TTS_DEFAULTS, TTS_RATE, TTS_VOLUME } from './shared/wire.js'

/**
 * 配置字段表（唯一主人）：一个字段一行，名字 × 缺省 × 值域 × 是否活值；`NovelConfig` / `ResolvedConfig` /
 * schema / 读数面全部由它派生——加字段只加一行。
 *
 * 缺省值一律引消费模块常量，本表只给「怎么校验」，不长出第二个字面量主人。default 的填充语义是确定的：
 * undefined / {} / 字段缺失 / 显式 null 都按 default 填（schemastery 平台语义，本仓不另造判据）。
 * `resolveConfig` 在生产路径近似幂等（cordis 装载期已用 `Config` 校验），但仍是本仓唯一被测试穿透的配置缝。
 * `CONFIG_FIELDS` 导出只为交叉校验（`tests/client/config-fields.test.ts`），生产消费面是 `Config` / `resolveConfig`。
 */
/** 聚合搜索并发缺省：schema 与直装回退同读这一格。 */
export const DEFAULT_SEARCH_PARALLEL = 5

export const CONFIG_FIELDS = {
  /** 书架 / 缓存 / 本地书的落盘根。刻意不做成活值：运行期换根会让新旧数据分家，改它等价于重启。 */
  dataDir: textField(),
  searchTimeoutMs: numberField(DEFAULT_TIMEOUT_MS, 1),
  /** js 沙箱预算：vm 同步闸与异步总时长共用；刻意宽于请求级缺省（库里有连打多个 java.ajax 算签名的脚本）。
   *  双闸见矩阵行 `h-timeout-double-gate`。 */
  jsTimeoutMs: numberField(DEFAULT_JS_BUDGET_MS, 1),
  searchParallel: numberField(DEFAULT_SEARCH_PARALLEL, 1),
  cacheMaxBytes: numberField(DEFAULT_CACHE_MAX_BYTES, 0),
  exportDelayMs: numberField(DEFAULT_EXPORT_DELAY_MS, 0),
  localImportMaxBytes: numberField(DEFAULT_MAX_IMPORT_BYTES, 1),
  /** 出站代理：'direct' = 强制直连；显式地址 = 用它；缺省 = 环境变量 → Windows 系统代理 → 直连 */
  proxyUrl: proxyField(),
  /** 听书全局缺省：回退链「显式 > 本书存档 > 这里」，全部 live。引擎标识是订阅数据身份，不是引擎对象
   *  （对象与凭据住数据根）。形状闸收空白，否则落盘后只会换来一次 TTS_ENGINE_MISSING。 */
  ttsDefaultEngine: volatileTextField(TTS_DEFAULTS.engineId, /^\S+$/),
  /** 语速按一位小数档（与配置页回读同一把尺）；范围取播放侧归一档 [0.5, 3]。 */
  ttsDefaultRate: decimalField(TTS_DEFAULTS.rate, TTS_RATE.min, TTS_RATE.max),
  /** 音量 [0, 1]，同样一位小数档。 */
  ttsDefaultVolume: decimalField(TTS_DEFAULTS.volume, TTS_VOLUME.min, TTS_VOLUME.max),
  /** 段音频缓存上限。真遇到单段就超上限时，淘汰跳过刚写入的那条（`services/size-ledger.ts` 的保留集）——
   *  宁可临时超限，也不让刚发出的合成回执指向 404。 */
  ttsCacheMaxBytes: numberField(DEFAULT_TTS_CACHE_MAX_BYTES, 1024 * 1024),
  /** 进入本章末尾时提前合成的下一章段数；0 = 不预取下一章（同章后 2 段不归这个开关）。 */
  ttsPrefetchParagraphs: numberField(TTS_DEFAULTS.prefetchParagraphs, 0),
  /** `/novel-api` 同源 fence 的本机名单追加项，只有自定义域名打开面板时才需要。刻意不做成活值（同 `dataDir`）：
   *  热改等于运行中让掉一个名字。 */
  apiAllowHosts: hostListField(),
} as const

/** 数值位：整数 + 下界。`.step(1)` 同时钉整数并挡掉 NaN/Infinity（`.min`/`.max` 对 NaN 比较为假）。 */
function numberField(defaultValue: number, min: number) {
  return {
    default: defaultValue, volatile: true as const,
    schema: () => Schema.number().default(defaultValue).min(min).step(1),
  }
}

/** 小数值（语速 / 音量）：上下界 + 一位小数档；步长同整数位，钉档位并挡 NaN。 */
function decimalField(defaultValue: number, min: number, max: number) {
  return {
    default: defaultValue, volatile: true as const,
    schema: () => Schema.number().default(defaultValue).min(min).max(max).step(0.1),
  }
}

/** 文本缺省位（活值）：值域钉非空；`pattern` 给需要形状闸的格，本表不抄引擎身份表。 */
function volatileTextField(defaultValue: string, pattern?: RegExp) {
  return {
    default: defaultValue, volatile: true as const,
    schema: () => {
      const base = Schema.string().default(defaultValue).min(1)
      return pattern === undefined ? base : base.pattern(pattern)
    },
  }
}

/** 文本位（非活值：改它等价于重启） */
function textField() {
  return {
    default: undefined as string | undefined, volatile: false as const,
    schema: () => Schema.string(),
  }
}

/** 代理地址位：形状闸只管空串 / direct / http(s) + 无空格主机；完整解析在 `parseProxyUrl`。 */
function proxyField() {
  return {
    default: undefined as string | undefined, volatile: true as const,
    schema: () => Schema.string().pattern(/^(?:|direct|(?:https?:\/\/)?(?!.*:\/\/)[^\s/]+(?::\d+)?(?:\/\S*)?)$/i),
  }
}

/** 本机别名列表位（非活值、可缺席）：每项 `host` 或 `host:port`，不许 scheme / 路径 / 空白，且须是 URL
 *  解析不改写的写法（`hostNameOf` 与 fence 同一把尺；会被静默丢弃的写法由 `resolveConfig` 加载期拒掉）。
 *  端口只做形状校验、不参与匹配；缺席 = 不追加。 */
function hostListField() {
  return {
    default: undefined as readonly string[] | undefined, volatile: false as const,
    schema: () => Schema.array(Schema.string().pattern(/^[A-Za-z0-9._-]+(?::\d+)?$/)),
  }
}

type ConfigTable = typeof CONFIG_FIELDS
export type ConfigFieldName = keyof ConfigTable
/** 表里默认值容得下 `undefined` 的那些格 = 可缺席（dataDir / proxyUrl）；其余必有值（缺省由表填）。 */
type OptionalFieldKey = { [K in ConfigFieldName]: undefined extends ConfigTable[K]['default'] ? K : never }[ConfigFieldName]
type MandatoryFieldKey = Exclude<ConfigFieldName, OptionalFieldKey>
/** 标 `volatile` 的那些格才是配置页可编辑的运行参数：其余改了要重启，不进表单。 */
export type VolatileConfigFieldName = { [K in ConfigFieldName]: ConfigTable[K]['volatile'] extends true ? K : never }[ConfigFieldName]

/** volatile 字段的消费桶：service-live = 每次用时读活值；composition-root = 只由组合根读并接线。
 *  键集由 `VolatileConfigFieldName` 钉死——漏归桶编译错，归错桶测试红。听书四格读者在浏览器半
 *  （播放层经宿主设置面取快照）；`ttsCacheMaxBytes` 是例外，容量账在 Node 半。 */
export const VOLATILE_CONSUMERS: Record<VolatileConfigFieldName, 'service-live' | 'composition-root'> = {
  searchTimeoutMs: 'service-live',
  searchParallel: 'service-live',
  jsTimeoutMs: 'service-live',
  cacheMaxBytes: 'service-live',
  localImportMaxBytes: 'service-live',
  exportDelayMs: 'composition-root',
  proxyUrl: 'composition-root',
  ttsDefaultEngine: 'service-live',
  ttsDefaultRate: 'service-live',
  ttsDefaultVolume: 'service-live',
  ttsCacheMaxBytes: 'service-live',
  ttsPrefetchParagraphs: 'service-live',
}

/** 用户写的原始配置（插件页 / profile / `cordis.patch.yml` 三处同源）：字段全部可选。 */
export type NovelConfig = { [K in ConfigFieldName]?: ConfigTable[K]['default'] }

/** 已解析配置的只读读数面：volatile 字段每次读当前 ref 快照。 */
export type ResolvedConfig =
  & { readonly [K in MandatoryFieldKey]: ConfigTable[K]['default'] }
  & { readonly [K in OptionalFieldKey]?: ConfigTable[K]['default'] }

const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')
type VolatileRef<T> = { get(): T }
type Field<T> = T | VolatileRef<T>
/** 配置收缝的输入形状：用户写的纯值或 Loader 解析出的活 ref，字段全部可选（两者都是稀疏的）。 */
type ConfigInput = { [K in ConfigFieldName]?: Field<ConfigTable[K]['default']> | null }

function isVolatileRef(value: unknown): value is VolatileRef<unknown> {
  return typeof value === 'object' && value !== null && VOLATILE_WRITE in value
}

/** 纯值是测试/直装路径；ref 是 Loader 解析后的活值。两种都收，对外统一成 getter。 */
function readField<T>(value: Field<T> | null | undefined): T | undefined {
  return isVolatileRef(value) ? value.get() : (value ?? undefined)
}

/** `.volatile()` 是能力位：宿主 schema 不支持时字段退化为普通值，插件仍能加载。 */
function maybeVolatile<T extends object>(schema: T): T {
  const method = (schema as T & { volatile?: () => unknown }).volatile
  return typeof method === 'function' ? (method.call(schema) as T) : schema
}

/** 表 → schema：标了 `volatile` 的行才挂 `.volatile()`，其余（dataDir / apiAllowHosts）一律静态。 */
export const Config = Schema.object(
  Object.fromEntries(Object.entries(CONFIG_FIELDS).map(([name, spec]) =>
    [name, spec.volatile ? maybeVolatile(spec.schema()) : spec.schema()])),
).default({})

/** 原始配置 → 合法配置的唯一缝：纯输入走 schema；Loader 已解析的 ref 输入整份跳过 schema（volatile ref 会被拒）。
 *  `searchParallel` 另有每轮重读的尺，见 `services/reading.ts` 的 `requireParallelStep`。 */
export function resolveConfig(raw?: NovelConfig | ConfigInput): ResolvedConfig {
  const input = raw as ConfigInput | undefined
  const names = Object.keys(CONFIG_FIELDS) as ConfigFieldName[]
  const resolved = input !== undefined && names.some((name) => isVolatileRef(input[name]))
  let out: ConfigInput
  if (resolved) {
    out = input
  } else {
    try {
      out = Config((input ?? {}) as Parameters<typeof Config>[0])
    } catch (e) {
      throw new Error(`[dsh-novel] 配置非法（见 README 配置表）：${e instanceof Error ? e.message : String(e)}`, { cause: e })
    }
  }
  // apiAllowHosts 还要过「URL 解析不改写」判据（`hostNameOf`，与 fence 同一把尺）：形状闸放行、构造期静默丢弃的写法在这里拒掉。
  // 放这里而不是 schema，是为了同时盖住 ref 快路径（整份跳过 schema）。
  const allowHosts = readField(out.apiAllowHosts) ?? []
  for (const entry of allowHosts) {
    if (typeof entry !== 'string' || hostNameOf(entry) === null) {
      throw new Error(`[dsh-novel] 配置非法（见 README 配置表）：apiAllowHosts 的条目 ${JSON.stringify(entry)} 不是「URL 解析不改写」的主机名写法（会被 URL 解析改写成 IP 的别名在 fence 侧等于无效，不收）`)
    }
  }
  // 读数面由表生成：每格一个 getter，读的就是 `out` 里那一格的**当前**值（ref 走 get()）
  const live: Record<string, unknown> = {}
  for (const name of names) {
    Object.defineProperty(live, name, {
      enumerable: true,
      get: () => readField(out[name]) ?? CONFIG_FIELDS[name].default,
    })
  }
  return live as ResolvedConfig
}
