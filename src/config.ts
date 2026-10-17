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

export const Config = Schema.object({
  dataDir: Schema.string(),
  // 六个数值位的单位都是整数（毫秒 / 字节 / 并发数）：.step(1) 同时钉整数并挡掉
  // NaN/Infinity——.min/.max 对 NaN 的比较为假，挡不住（宁炸不猜）。
  searchTimeoutMs: Schema.number().default(DEFAULT_TIMEOUT_MS).min(1).step(1),
  searchParallel: Schema.number().default(DEFAULT_SEARCH_PARALLEL).min(1).step(1),
  jsTimeoutMs: Schema.number().default(DEFAULT_JS_BUDGET_MS).min(1).step(1),
  cacheMaxBytes: Schema.number().default(DEFAULT_CACHE_MAX_BYTES).min(0).step(1),
  exportDelayMs: Schema.number().default(DEFAULT_EXPORT_DELAY_MS).min(0).step(1),
  localImportMaxBytes: Schema.number().default(DEFAULT_MAX_IMPORT_BYTES).min(1).step(1),
  proxyUrl: Schema.string(),
}).default({} as any)

/** 缺省已填、值域已验的配置：六个数值位必填，dataDir/proxyUrl 仍可选 */
export type ResolvedConfig = Omit<Required<NovelConfig>, 'dataDir' | 'proxyUrl'>
  & Pick<NovelConfig, 'dataDir' | 'proxyUrl'>

/** schema 对无 default 的可选键会把显式 null 原样带出；先按真实运行形状接住，再归一。 */
type SchemaConfig = Omit<Required<NovelConfig>, 'dataDir' | 'proxyUrl'>
  & { dataDir?: string | null; proxyUrl?: string | null }

/** 原始配置 → 合法配置的唯一缝：填充 + 类型 + 值域一步到位，非法值加载期响亮失败。
 *  数值位的整数 / 有限性由 schema 的 `.step(1)` 把住（`.min`/`.max` 挡不住 NaN）；
 *  dataDir/proxyUrl 的 null 在这里归一成 undefined（ResolvedConfig 的类型不含 null）。 */
export function resolveConfig(raw?: NovelConfig): ResolvedConfig {
  try {
    const out = Config(raw ?? {}) as SchemaConfig
    return { ...out, dataDir: out.dataDir ?? undefined, proxyUrl: out.proxyUrl ?? undefined }
  } catch (e) {
    throw new Error(`[dsh-novel] 配置非法（见 README 配置表）：${e instanceof Error ? e.message : String(e)}`)
  }
}
