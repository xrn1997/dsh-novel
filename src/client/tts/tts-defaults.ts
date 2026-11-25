import { TTS_DEFAULTS } from '../../shared/wire.js'

/** 听书缺省四格：回退链用的活动缺省，内容的终端兜底在 wire 的 `TTS_DEFAULTS`。
 *  播放层回退链（显式入参 > 本书 listen 存档 > 本生效值）的第三环读它。 */
export interface TtsDefaults {
  engineId: string
  rate: number
  volume: number
  prefetchParagraphs: number
}

/** 一个听书缺省来源（跨 seam 的唯一协议）：宿主同步配置、设置面快照各自成 adapter 实现它。
 *  `read` 逐格交原样读数——判读（「什么算读得出」）归来源链；`watch` 缺席 = 只读一次的来源，
 *  有了 `refresh` 这类推动口的来源自己叫 `notify`。 */
export interface TtsDefaultsSource {
  read(): Partial<Record<keyof TtsDefaults, unknown>>
  /** 变更信号（无载荷）：链子收到后重算生效值。返回退订。 */
  watch?(notify: () => void): () => void
}

/** 来源链读面：生效值 + 变化通知。 */
export interface TtsDefaultsFace {
  /** 生效值：每格 = 按来源顺序第一个读得出的值，全链读不出落 wire 缺省。永不抛、四格总有值。 */
  effective(): TtsDefaults
  /** 生效值真变化时发整份新值（同值不发）；返回退订（幂等）。 */
  subscribe(onChange: (value: TtsDefaults) => void): () => void
  /** 断开全部来源信号与订阅者（接线卸载 / 测试收场）。 */
  dispose(): void
}

/** 「什么算读得出」的唯一判据：空白引擎 id、非有限数、非负整数之外的预取都算读不出——
 *  读不出不编值，只让那一格落到下一来源（失败半径 = 那一格）。值域不在此裁决（归 schema）。 */
const READABLE: { [K in keyof TtsDefaults]: (value: unknown) => boolean } = {
  engineId: (value) => typeof value === 'string' && value.trim() !== '',
  rate: (value) => typeof value === 'number' && Number.isFinite(value),
  volume: (value) => typeof value === 'number' && Number.isFinite(value),
  prefetchParagraphs: (value) => typeof value === 'number' && Number.isInteger(value) && value >= 0,
}

const KEYS = Object.keys(READABLE) as Array<keyof TtsDefaults>

function sameValue(a: TtsDefaults, b: TtsDefaults): boolean {
  return KEYS.every((key) => a[key] === b[key])
}

/**
 * 听书缺省来源链：**一条规则**——每格生效值 = 按 `sources` 顺序（前源胜后源）第一个读得出的值，
 * 读时求值。谁赢由声明的顺序决定，与接入 / 刷新 / 订阅的先后无关（三写者的 last-writer-wins
 * 由这条规则结构性取代）。`TTS_DEFAULTS` 是终端地板、不是来源；来源读失败整源缺席，一格读不出
 * 只落那一格。
 */
export function createTtsDefaults(sources: readonly TtsDefaultsSource[]): TtsDefaultsFace {
  const effective = (): TtsDefaults => {
    const out: TtsDefaults = { ...TTS_DEFAULTS }
    const claimed = new Set<keyof TtsDefaults>()
    for (const source of sources) {
      let reading: unknown
      try {
        reading = source.read()
      } catch {
        continue // 该源这一发缺席：不猜、不牵连他源
      }
      if (typeof reading !== 'object' || reading === null) continue
      const record = reading as Partial<Record<keyof TtsDefaults, unknown>>
      for (const key of KEYS) {
        if (claimed.has(key)) continue
        let raw: unknown
        try {
          if (!Object.hasOwn(record, key)) continue
          raw = record[key]
        } catch {
          continue // 该格读不出 = 该格缺席，不牵连同源其余格
        }
        if (READABLE[key](raw)) {
          out[key] = raw as never
          claimed.add(key)
        }
      }
      if (claimed.size === KEYS.length) break
    }
    return out
  }

  let last = effective()
  const listeners = new Set<(value: TtsDefaults) => void>()
  let disposed = false
  const signal = (): void => {
    if (disposed) return
    const next = effective()
    if (sameValue(last, next)) return
    last = next
    for (const listener of [...listeners]) listener(next)
  }
  const detachSources: Array<() => void> = []
  for (const source of sources) {
    if (typeof source.watch !== 'function') continue
    try {
      const detach = source.watch(signal)
      if (typeof detach === 'function') detachSources.push(detach)
    } catch {
      // 单源 watch 故障只落该源，不阻断其余来源订阅
    }
  }

  return {
    effective,
    subscribe(onChange) {
      if (disposed) return () => { /* 已断链：订阅即空 */ }
      listeners.add(onChange)
      return () => { listeners.delete(onChange) }
    },
    dispose() {
      if (disposed) return
      disposed = true
      listeners.clear()
      for (const detach of detachSources) {
        try { detach() } catch { /* 单源退订故障不阻断其余来源清理 */ }
      }
    },
  }
}
