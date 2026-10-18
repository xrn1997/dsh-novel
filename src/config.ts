import Schema from '@deepseek-ai/schemastery'
import { DEFAULT_CACHE_MAX_BYTES } from './services/cache.js'
import { DEFAULT_EXPORT_DELAY_MS } from './services/export.js'
import { DEFAULT_TIMEOUT_MS } from './services/fetcher.js'
import { DEFAULT_MAX_IMPORT_BYTES } from './services/localbooks.js'
import { DEFAULT_JS_BUDGET_MS, DEFAULT_SEARCH_PARALLEL } from './services/reading.js'

/** 插件配置（官方 config 页规范形态：schemastery Standard Schema）。
 *  默认值与值域**都住 schema**：字面量只出现在各消费模块，这里全部引常量——
 *  「缺省值五个各自主人」的纪律不破，schema 是口径的家而不是字面量的第二个主人。
 *  偏离理由的更正（2026-10-17，钉版 3.18.5 实测）：inner/outer default 的填充语义
 *  是确定的（undefined / {} / 字段缺失都按 default 填），当年「随版本歧义」的顾虑
 *  在钉版上不成立；`.default({})` 只作 cordis 缺省 config 行（undefined 输入）的兜底。
 *  显式 `null` 也按「未设置」填缺省——这是 schemastery 的平台语义，本仓不再另造一道
 *  null 判据；旧 assertConfig 会拒绝数字 null，这条差异按平台口径接受并在此记录。
 *  cordis 装载期会自己用导出的 `Config` 校验并填充 patch 行的 config，所以 resolveConfig
 *  在生产路径上近似幂等——但它仍是本仓唯一被测试穿透的配置缝（官方 config 页「加载时校验、
 *  错则失败」与本仓「宁炸不猜」都挂在这一个 interface 上），这一步不可省。 */
export interface NovelConfig {
  dataDir?: string
  searchTimeoutMs?: number
  searchParallel?: number
  /** js 沙箱预算（vm 同步闸与异步总时长共用）。缺省 15000：真实源的多请求目录脚本
   *  （java.ajax×2 + md5 签名，txs12 源实测）2s 预算必炸——探针 verified 只证明搜索面。 */
  jsTimeoutMs?: number
  cacheMaxBytes?: number
  exportDelayMs?: number
  localImportMaxBytes?: number
  /** 出站代理：'direct' = 强制直连；显式地址 = 用它；缺省 = 环境变量 → Windows 系统代理 → 直连 */
  proxyUrl?: string
}

/** 已解析配置的只读读数面：volatile 字段每次读当前 ref 快照。 */
export interface ResolvedConfig {
  readonly dataDir?: string
  readonly searchTimeoutMs: number
  readonly searchParallel: number
  readonly jsTimeoutMs: number
  readonly cacheMaxBytes: number
  readonly exportDelayMs: number
  readonly localImportMaxBytes: number
  readonly proxyUrl?: string
}

const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')
type VolatileRef<T> = { get(): T }
type Field<T> = T | VolatileRef<T>
/** 配置收缝的输入形状：用户写的纯值或 Loader 解析出的活 ref，字段全部可选（两者都是稀疏的）。 */
type ConfigInput = {
  dataDir?: string | null
  searchTimeoutMs?: Field<number>
  searchParallel?: Field<number>
  jsTimeoutMs?: Field<number>
  cacheMaxBytes?: Field<number>
  exportDelayMs?: Field<number>
  localImportMaxBytes?: Field<number>
  proxyUrl?: Field<string | null | undefined> | null
}

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

/** string schema 的形状闸：空串 / direct / 可选的 http(s) scheme + 无空格主机。完整解析在
 *  createFetcher 建 dispatcher 前由 parseProxyUrl 再做一次。 */
function proxyUrlSchema() {
  return Schema.string().pattern(/^(?:|direct|(?:https?:\/\/)?(?!.*:\/\/)[^\s/]+(?::\d+)?(?:\/\S*)?)$/i)
}

export const Config = Schema.object({
  dataDir: Schema.string(),
  // 六个数值位的单位都是整数（毫秒 / 字节 / 并发数）：.step(1) 同时钉整数并挡掉
  // NaN/Infinity——.min/.max 对 NaN 的比较为假，挡不住（宁炸不猜）。
  searchTimeoutMs: maybeVolatile(Schema.number().default(DEFAULT_TIMEOUT_MS).min(1).step(1)),
  searchParallel: maybeVolatile(Schema.number().default(DEFAULT_SEARCH_PARALLEL).min(1).step(1)),
  jsTimeoutMs: maybeVolatile(Schema.number().default(DEFAULT_JS_BUDGET_MS).min(1).step(1)),
  cacheMaxBytes: maybeVolatile(Schema.number().default(DEFAULT_CACHE_MAX_BYTES).min(0).step(1)),
  exportDelayMs: maybeVolatile(Schema.number().default(DEFAULT_EXPORT_DELAY_MS).min(0).step(1)),
  localImportMaxBytes: maybeVolatile(Schema.number().default(DEFAULT_MAX_IMPORT_BYTES).min(1).step(1)),
  proxyUrl: maybeVolatile(proxyUrlSchema()),
}).default({} as any)

/** 原始配置 → 合法配置的唯一缝：纯输入走 schema 校验；Loader 已解析的 ref 输入不重跑 schema
 *  （volatile ref 会被 `expected number but got [object Object]` 拒绝）。 */
export function resolveConfig(raw?: NovelConfig | ConfigInput): ResolvedConfig {
  const input = raw as ConfigInput | undefined
  const resolved = input !== undefined && [
    input.searchTimeoutMs, input.searchParallel, input.jsTimeoutMs,
    input.cacheMaxBytes, input.exportDelayMs, input.localImportMaxBytes,
    input.proxyUrl,
  ].some(isVolatileRef)
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
  return {
    get dataDir() { return out.dataDir ?? undefined },
    get searchTimeoutMs() { return readField(out.searchTimeoutMs) ?? DEFAULT_TIMEOUT_MS },
    get searchParallel() { return readField(out.searchParallel) ?? DEFAULT_SEARCH_PARALLEL },
    get jsTimeoutMs() { return readField(out.jsTimeoutMs) ?? DEFAULT_JS_BUDGET_MS },
    get cacheMaxBytes() { return readField(out.cacheMaxBytes) ?? DEFAULT_CACHE_MAX_BYTES },
    get exportDelayMs() { return readField(out.exportDelayMs) ?? DEFAULT_EXPORT_DELAY_MS },
    get localImportMaxBytes() { return readField(out.localImportMaxBytes) ?? DEFAULT_MAX_IMPORT_BYTES },
    get proxyUrl() { return readField(out.proxyUrl) ?? undefined },
  }
}
