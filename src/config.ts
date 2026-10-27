import Schema from '@deepseek-ai/schemastery'
import { DEFAULT_CACHE_MAX_BYTES } from './services/cache.js'
import { DEFAULT_EXPORT_DELAY_MS } from './services/export.js'
import { DEFAULT_TIMEOUT_MS } from './services/fetcher.js'
import { DEFAULT_MAX_IMPORT_BYTES } from './services/localbooks.js'
import { DEFAULT_JS_BUDGET_MS, DEFAULT_SEARCH_PARALLEL } from './services/reading.js'

/**
 * 配置字段表（唯一主人）：一个字段一行，名字 × 缺省 × 值域（schema 同时声明类型）× 是否活值全在这一行上。
 * `NovelConfig` / `ResolvedConfig` / 输入形状 / schema / 读数面全部由它派生——加一个字段 = 加一行，
 * 而不是在六份清单上各抄一次（抄本迟早分叉，而分叉的表现是「改了 schema 忘了改读数面」）。
 *
 * 缺省值一律引各消费模块的常量：本表只给「怎么校验」，不长出第二个字面量主人（「缺省值五个各自主人」
 * 这条纪律不破）。
 *
 * default 的填充语义是确定的（undefined / {} / 字段缺失都按 default 填）；
 * `.default({})` 只作 cordis 缺省 config 行（undefined 输入）的兜底。显式 `null` 也按「未设置」填
 * 缺省——这是 schemastery 的平台语义，本仓不另造一道 null 判据。
 * cordis 装载期会自己用导出的 `Config` 校验并填充 patch 行的 config，所以 resolveConfig 在生产路径上
 * 近似幂等——但它仍是本仓唯一被测试穿透的配置缝（官方 config 页「加载时校验、错则失败」与本仓
 * 「宁炸不猜」都挂在这一个 interface 上），这一步不可省。
 */
const CONFIG_FIELDS = {
  /** 书架 / 缓存 / 本地书的落盘根。刻意不做成活值：运行期换根会让新旧数据分家，改它等价于重启。 */
  dataDir: textField(),
  searchTimeoutMs: numberField(DEFAULT_TIMEOUT_MS, 1),
  /** js 沙箱预算（vm 同步闸与异步总时长共用）。缺省 15000：真实源的多请求目录脚本
   *  （java.ajax×2 + md5 签名，txs12 源实测）2s 预算必炸——探针 verified 只证明搜索面。 */
  jsTimeoutMs: numberField(DEFAULT_JS_BUDGET_MS, 1),
  searchParallel: numberField(DEFAULT_SEARCH_PARALLEL, 1),
  cacheMaxBytes: numberField(DEFAULT_CACHE_MAX_BYTES, 0),
  exportDelayMs: numberField(DEFAULT_EXPORT_DELAY_MS, 0),
  localImportMaxBytes: numberField(DEFAULT_MAX_IMPORT_BYTES, 1),
  /** 出站代理：'direct' = 强制直连；显式地址 = 用它；缺省 = 环境变量 → Windows 系统代理 → 直连 */
  proxyUrl: proxyField(),
} as const

/** 数值位：整数 + 下界。六个数值位的单位都是整数（毫秒 / 字节 / 并发数），`.step(1)` 同时钉整数并
 *  挡掉 NaN/Infinity——`.min`/`.max` 对 NaN 的比较为假，挡不住（宁炸不猜）。 */
function numberField(defaultValue: number, min: number) {
  return {
    default: defaultValue, volatile: true as const,
    schema: () => Schema.number().default(defaultValue).min(min).step(1),
  }
}

/** 文本位（非活值：改它等价于重启） */
function textField() {
  return {
    default: undefined as string | undefined, volatile: false as const,
    schema: () => Schema.string(),
  }
}

/** 代理地址位：形状闸只管空串 / direct / 可选 http(s) scheme + 无空格主机；完整解析在
 *  createFetcher 建 dispatcher 前由 parseProxyUrl 再做一次。 */
function proxyField() {
  return {
    default: undefined as string | undefined, volatile: true as const,
    schema: () => Schema.string().pattern(/^(?:|direct|(?:https?:\/\/)?(?!.*:\/\/)[^\s/]+(?::\d+)?(?:\/\S*)?)$/i),
  }
}

type ConfigTable = typeof CONFIG_FIELDS
export type ConfigFieldName = keyof ConfigTable
/** 表里默认值容得下 `undefined` 的那些格 = 可缺席（dataDir / proxyUrl）；其余必有值（缺省由表填）。 */
type OptionalFieldKey = { [K in ConfigFieldName]: undefined extends ConfigTable[K]['default'] ? K : never }[ConfigFieldName]
type MandatoryFieldKey = Exclude<ConfigFieldName, OptionalFieldKey>
/** 标 `volatile` 的那些格才是配置页可编辑的运行参数：其余改了要重启，不进表单。 */
export type VolatileConfigFieldName = { [K in ConfigFieldName]: ConfigTable[K]['volatile'] extends true ? K : never }[ConfigFieldName]

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
  return isVolatileRef(value) ? (value.get() as T) : (value ?? undefined)
}

/** 旧 schemastery 没有 .volatile()：字段退化为普通值，插件仍能加载；配置页由 configForms 能力闸另判。 */
function maybeVolatile<T extends object>(schema: T): T {
  const method = (schema as T & { volatile?: () => unknown }).volatile
  return typeof method === 'function' ? (method.call(schema) as T) : schema
}

/** 表 → schema：标了 `volatile` 的行才挂 `.volatile()`，其余（dataDir）一律静态。 */
export const Config = Schema.object(
  Object.fromEntries(Object.entries(CONFIG_FIELDS).map(([name, spec]) =>
    [name, spec.volatile ? maybeVolatile(spec.schema()) : spec.schema()])),
).default({} as any)

/** 原始配置 → 合法配置的唯一缝：纯输入走 schema 校验；Loader 已解析的 ref 输入不重跑 schema
 *  （volatile ref 会被 `expected number but got [object Object]` 拒绝）。
 *  这条快路径是**整份**跳过：任一格是 ref，其余纯值也不再过值域——Loader 交出来的对象里，没标
 *  volatile 的那几格仍是纯值，值域由宿主写入时的校验负责。本仓对「值非法会挂死而不只是报错」的那一格
 *  （`searchParallel`）另有一把每轮重读的尺，见 `services/reading.ts` 的 `requireParallelStep`。 */
export function resolveConfig(raw?: NovelConfig | ConfigInput): ResolvedConfig {
  const input = raw as ConfigInput | undefined
  const names = Object.keys(CONFIG_FIELDS) as ConfigFieldName[]
  const resolved = input !== undefined && names.some((name) => isVolatileRef(input[name]))
  let out: ConfigInput
  if (resolved && input !== undefined) {
    out = input
  } else {
    try {
      out = Config((input ?? {}) as any) as unknown as ConfigInput
    } catch (e) {
      throw new Error(`[dsh-novel] 配置非法（见 README 配置表）：${e instanceof Error ? e.message : String(e)}`)
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
