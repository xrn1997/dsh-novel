import type { VolatileConfigFieldName } from '../../config.js'
import type { TtsDefaults, TtsDefaultsSource } from './tts-defaults.js'

/** 听书缺省在宿主设置面 / 同步配置里的名字表：值由配置缝的类型逼出来——`ttsDefaultEngine` 之类
 *  改名时这里编译不过，而不是让接入层静默读出一格 undefined（读不出就落回下一来源，等于用户的
 *  设置被悄悄丢掉）。宿主词汇只住本 adapter 侧，来源链不认识它。 */
export const TTS_DEFAULT_KEYS = {
  engineId: 'ttsDefaultEngine',
  rate: 'ttsDefaultRate',
  volume: 'ttsDefaultVolume',
  prefetchParagraphs: 'ttsPrefetchParagraphs',
} as const satisfies Record<keyof TtsDefaults, VolatileConfigFieldName>

const ENTRIES = Object.entries(TTS_DEFAULT_KEYS) as Array<[keyof TtsDefaults, VolatileConfigFieldName]>

/** 宿主同步配置单格的窄镜像（`ADR-0020`）：只取 `get()`（与 Host 读 volatile ref 同形）与返回
 *  disposer 的 `subscribe()`；宿主那头的完整形状是「Volatile + 可观察快照」，本仓只依赖这两条。 */
interface SyncedConfigRefLike {
  get(): unknown
  subscribe(listener: () => void): () => void
}

function isSyncedConfigRef(value: unknown): value is SyncedConfigRefLike {
  if (typeof value !== 'object' || value === null) return false
  const ref = value as { get?: unknown; subscribe?: unknown }
  return typeof ref.get === 'function' && typeof ref.subscribe === 'function'
}

/** 构造期只检查形态，不调用 `get()`（避免初始化瞬间单个 ref getter 抛错炸穿组合根）。 */
function hasAnySyncedRef(record: Record<string, unknown>): boolean {
  for (const [, hostName] of ENTRIES) {
    try {
      if (isSyncedConfigRef(record[hostName])) return true
    } catch {
      // 单格属性读不出不牵连他格
    }
  }
  return false
}

/** live ref 侧的翻译：每格只认 ref 形状，现读 `get()` 原值；单格异常只落那一格。 */
function readingOfRefs(record: Record<string, unknown>): Partial<Record<keyof TtsDefaults, unknown>> {
  const out: Partial<Record<keyof TtsDefaults, unknown>> = {}
  for (const [field, hostName] of ENTRIES) {
    try {
      const candidate = record[hostName]
      if (isSyncedConfigRef(candidate)) out[field] = candidate.get()
    } catch {
      // 单格读不出只让这一格缺席（失败半径 = 判据的主语）
    }
  }
  return out
}

/** 设置面侧的翻译：装的是生效值原数（describe / mutate 回读），按名透出、不判形状。 */
function readingOfValues(record: Record<string, unknown>): Partial<Record<keyof TtsDefaults, unknown>> {
  const out: Partial<Record<keyof TtsDefaults, unknown>> = {}
  for (const [field, hostName] of ENTRIES) {
    if (Object.hasOwn(record, hostName)) out[field] = record[hostName]
  }
  return out
}

/**
 * adapter 1：宿主同步配置（live ref）。逐格接管——某格不是合法 ref 就那一格缺席，不牵连他格；
 * 零格可认时返回 `null`（这不是同步配置）。`read` 每次现扫 config（晚出现的 ref 下一读即见）；
 * `watch` 订阅调用时在场的 ref（宿主契约：ref 的 `subscribe` 在值提交**之后**发信号，回调里
 * `get()` 取到当前值）。
 */
export function createLiveRefSource(config: unknown): TtsDefaultsSource | null {
  if (typeof config !== 'object' || config === null) return null
  const record = config as Record<string, unknown>
  // 创建期判据：至少一格是合法 ref 才算同步配置（不触发 get()，零格 = 这不是同步配置）。
  if (!hasAnySyncedRef(record)) return null
  return {
    read: () => readingOfRefs(record),
    watch(notify) {
      const detachers: Array<() => void> = []
      for (const [, hostName] of ENTRIES) {
        try {
          const candidate = record[hostName]
          if (isSyncedConfigRef(candidate)) {
            const detach = candidate.subscribe(notify)
            if (typeof detach === 'function') detachers.push(detach)
          }
        } catch {
          // 单格订阅失败只落那一格，不泄漏其余已建退订或炸穿 effect
        }
      }
      return () => {
        for (const detach of detachers) {
          try { detach() } catch { /* 单格退订故障不阻断其余退订 */ }
        }
      }
    },
  }
}

/** adapter 2 的面：来源 + `refresh`（配置页每次读到生效值喂一发；宿主设置面没有变更订阅）。
 *  `refresh` 声明为函数属性（非方法）：它要被单独传给配置页当回调，不带 `this` 语义。 */
export interface SettingsSnapshotSource extends TtsDefaultsSource {
  /** 喂一份生效值记录（描述回读 / mutate 回执）：整源换新并叫一声信号。 */
  refresh: (value: Record<string, unknown>) => void
}

/**
 * adapter 2：宿主设置面快照。生效值经 `refresh` 喂进来（首屏 describe 一次 + 配置页每次读到
 * 生效值）；未喂过 = 整源缺席，链子落下一来源。
 */
export function createSettingsSnapshotSource(): SettingsSnapshotSource {
  let cache: Record<string, unknown> | null = null
  const listeners = new Set<() => void>()
  return {
    read: () => (cache === null ? {} : readingOfValues(cache)),
    refresh: (value) => {
      cache = { ...value }
      for (const listener of [...listeners]) listener()
    },
    watch(notify) {
      listeners.add(notify)
      return () => { listeners.delete(notify) }
    },
  }
}
