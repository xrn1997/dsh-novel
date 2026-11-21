import type { VolatileConfigFieldName } from '../config.js'
import type { CopyKey } from './copy/index.js'
import type { SettingsPathOp } from './config-settings.js'

/** 可编辑字段的名字表由配置缝给（type-only import，运行时擦除、不过纯度门）。 */
export type FieldName = VolatileConfigFieldName

/** 换算口径决定字段行长什么样，故与字段清单同处一表。`number` = 非负小数位（语速 / 音量）。 */
type Kind = 'ms' | 'bytes' | 'count' | 'number' | 'text'

export interface FieldSpec {
  name: FieldName
  labelKey: CopyKey
  kind: Kind
  /** 落在框内的后缀键；`text` 位没有单位。 */
  unitKey?: CopyKey
  /** 框内数值为 1 时换用的单数量词（英文 `1 source` 而非 `1 sources`）；中文两侧同字，故中文输出不变。 */
  unitOneKey?: CopyKey
  /** 「这个数管什么、调到哪会坏」——原 hint 只报了单位，没报后果。 */
  meaningKey: CopyKey
  presets?: readonly { label: string; value: number }[]
  placeholderKey?: CopyKey
  invalidKey: CopyKey
}

const MB = 1024 * 1024

/** 预设档的 label 是纯量纲（`50 MB`），两种语言同形，故不走字典——它们是值不是文案。 */
export const FIELDS: Record<FieldName, FieldSpec> = {
  searchTimeoutMs: {
    name: 'searchTimeoutMs', labelKey: 'config.field.searchTimeoutMs.label', kind: 'ms',
    unitKey: 'config.unit.ms', meaningKey: 'config.field.searchTimeoutMs.meaning',
    invalidKey: 'config.invalid.number',
  },
  searchParallel: {
    name: 'searchParallel', labelKey: 'config.field.searchParallel.label', kind: 'count',
    unitKey: 'config.unit.sources', unitOneKey: 'config.unit.sources.one',
    meaningKey: 'config.field.searchParallel.meaning',
    invalidKey: 'config.invalid.number',
  },
  jsTimeoutMs: {
    name: 'jsTimeoutMs', labelKey: 'config.field.jsTimeoutMs.label', kind: 'ms',
    unitKey: 'config.unit.ms', meaningKey: 'config.field.jsTimeoutMs.meaning',
    invalidKey: 'config.invalid.number',
  },
  exportDelayMs: {
    name: 'exportDelayMs', labelKey: 'config.field.exportDelayMs.label', kind: 'ms',
    unitKey: 'config.unit.ms', meaningKey: 'config.field.exportDelayMs.meaning',
    invalidKey: 'config.invalid.number',
  },
  cacheMaxBytes: {
    name: 'cacheMaxBytes', labelKey: 'config.field.cacheMaxBytes.label', kind: 'bytes',
    unitKey: 'config.unit.bytes', unitOneKey: 'config.unit.bytes.one',
    meaningKey: 'config.field.cacheMaxBytes.meaning',
    presets: [{ label: '50 MB', value: 50 * MB }, { label: '100 MB', value: 100 * MB },
      { label: '200 MB', value: 200 * MB }, { label: '500 MB', value: 500 * MB }],
    invalidKey: 'config.invalid.number',
  },
  localImportMaxBytes: {
    name: 'localImportMaxBytes', labelKey: 'config.field.localImportMaxBytes.label', kind: 'bytes',
    unitKey: 'config.unit.bytes', unitOneKey: 'config.unit.bytes.one',
    meaningKey: 'config.field.localImportMaxBytes.meaning',
    presets: [{ label: '20 MB', value: 20 * MB }, { label: '50 MB', value: 50 * MB },
      { label: '100 MB', value: 100 * MB }, { label: '200 MB', value: 200 * MB }],
    invalidKey: 'config.invalid.number',
  },
  proxyUrl: {
    name: 'proxyUrl', labelKey: 'config.field.proxyUrl.label', kind: 'text',
    meaningKey: 'config.field.proxyUrl.meaning',
    placeholderKey: 'config.field.proxyUrl.placeholder',
    invalidKey: 'config.field.proxyUrl.invalid',
  },
  ttsDefaultEngine: {
    name: 'ttsDefaultEngine', labelKey: 'config.field.ttsDefaultEngine.label', kind: 'text',
    meaningKey: 'config.field.ttsDefaultEngine.meaning',
    invalidKey: 'config.field.ttsDefaultEngine.invalid',
  },
  ttsDefaultRate: {
    name: 'ttsDefaultRate', labelKey: 'config.field.ttsDefaultRate.label', kind: 'number',
    meaningKey: 'config.field.ttsDefaultRate.meaning',
    presets: [{ label: '0.8', value: 0.8 }, { label: '1.0', value: 1 }, { label: '1.2', value: 1.2 },
      { label: '1.5', value: 1.5 }, { label: '2.0', value: 2 }],
    invalidKey: 'config.invalid.number',
  },
  ttsDefaultVolume: {
    name: 'ttsDefaultVolume', labelKey: 'config.field.ttsDefaultVolume.label', kind: 'number',
    meaningKey: 'config.field.ttsDefaultVolume.meaning',
    presets: [{ label: '0.6', value: 0.6 }, { label: '0.8', value: 0.8 }, { label: '1.0', value: 1 }],
    invalidKey: 'config.invalid.number',
  },
  ttsCacheMaxBytes: {
    name: 'ttsCacheMaxBytes', labelKey: 'config.field.ttsCacheMaxBytes.label', kind: 'bytes',
    unitKey: 'config.unit.bytes', unitOneKey: 'config.unit.bytes.one',
    meaningKey: 'config.field.ttsCacheMaxBytes.meaning',
    presets: [{ label: '64 MB', value: 64 * MB }, { label: '128 MB', value: 128 * MB },
      { label: '256 MB', value: 256 * MB }, { label: '512 MB', value: 512 * MB }],
    invalidKey: 'config.invalid.number',
  },
  ttsPrefetchParagraphs: {
    name: 'ttsPrefetchParagraphs', labelKey: 'config.field.ttsPrefetchParagraphs.label', kind: 'count',
    unitKey: 'config.unit.paragraphs', unitOneKey: 'config.unit.paragraphs.one',
    meaningKey: 'config.field.ttsPrefetchParagraphs.meaning',
    invalidKey: 'config.invalid.number',
  },
}

/** 字段序即分区、保存批次的遍历序：一份表，不在各处再抄 `Object.keys`。 */
export const FIELD_NAMES = Object.keys(FIELDS) as FieldName[]

type Parsed =
  | { ok: true; op: SettingsPathOp }
  | { ok: false }

/**
 * 文本框 → 写入操作。**只判类型错**（整数位必须是非负安全整数；小数位必须是非负有限小数；
 * 文本位首尾空白归一，内部空白拒绝），值域由宿主在 `mutate` 时按 schema 裁决——本页不抄
 * schema 的上下界与代理正则，拒绝时原样显示宿主的理由。文本位清空 = `unset`（回出厂值），
 * 而不是写一个空串盖掉用户层；数字位与其他数值位一致，空框按类型错止住保存。
 */
export function parseField(spec: FieldSpec, text: string): Parsed {
  const trimmed = text.trim()
  if (spec.kind === 'text') {
    if (trimmed === '') return { ok: true, op: { op: 'unset', path: [spec.name] } }
    // 代理位只挡「连形状都不像」的输入（含空白）；完整形状归 schema，宿主拒绝时如实显示。
    if (/\s/.test(trimmed)) return { ok: false }
    return { ok: true, op: { op: 'set', path: [spec.name], value: trimmed } }
  }
  if (spec.kind === 'number') {
    // 只认十进制小数：`1e3` / `.5` / `1.` / 负数都不算这一页的数字。有限性由语法保证，
    // 再判一次是防未来把语法放宽时静默放进 NaN/Infinity。
    if (!/^\d+(?:\.\d+)?$/.test(trimmed)) return { ok: false }
    const n = Number.parseFloat(trimmed)
    if (!Number.isFinite(n) || n < 0) return { ok: false }
    return { ok: true, op: { op: 'set', path: [spec.name], value: n } }
  }
  if (!/^\d+$/.test(trimmed)) return { ok: false }
  const n = Number(trimmed)
  if (!Number.isSafeInteger(n)) return { ok: false }
  return { ok: true, op: { op: 'set', path: [spec.name], value: n } }
}
