import type { Context } from '@deepseek-ai/cordis'
import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import type { VolatileConfigFieldName } from '../config.js'
import {
  CopyProvider,
  plural,
  useCopy,
  zhTranslate,
  type CopyKey,
  type Translate,
} from './copy/index.js'
import { GROUPS } from './config-groups.js'
import { NovelStyles } from './styles.js'
import { pushError } from './transient.js'
import { EngineManager } from './tts/EngineManager.js'
import { setTtsDefaults } from './tts/player.js'
import type { TtsDefaults } from './tts/player.js'

/**
 * 插件页的「运行参数」表单：宿主 `plugins.bundle.config` 槽按包名找占用者，值走宿主设置面
 * （`ctx.remote.settings` 的 `describe` / `mutate`，宿主 `settingsController` 的编目契约）。
 *
 * 为什么不是宿主表单原语：宿主页面校验清单不许页面/面板 import 任何宿主 client 包；本仓的
 * 跨插件协作一律走 cordis 服务（见 `ADR-0067`）。原语只是这层服务之上的表单状态包装，所以本页
 * 自己持有草稿、脏标记与保存态，写协议仍归宿主。
 *
 * 本页只拥有：字段清单（哪个字段、叫什么、单位与人话换算）与呈现。**值域归 schema**：
 * 本地只判「是不是合法数字」这类类型错（整数位非负整数、小数位非负小数）；上下界、代理形状由
 * 宿主在写入时裁决，拒绝即原样显示宿主给的失败原因，草稿保留。
 *
 * 职责边界：宿主壳（标题、可用/只读、保存中/失败）由本页自绘；`dataDir` 等非活值不进表单
 * （改它等价于重启，见 `ADR-0035`）。宿主没有设置面（`remote.settings` 缺席）时不注册这一页，
 * 侧栏 / 面板 / 状态层完全不受影响。
 */

/** 与宿主设置面同一条 wire 语义的窄镜像（`ADR-0020`）：只声明本页用到的成员。 */
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

export interface SettingsNamespaceView {
  ns: string
  value: JsonValue
  user?: JsonValue
  revision: number
}

export interface SettingsDescribeValue {
  writable: boolean
  namespaces: SettingsNamespaceView[]
}

export type SettingsPathOp =
  | { op: 'set'; path: string[]; value: JsonValue }
  | { op: 'unset'; path: string[] }

export type RemoteResult<T> = { ok: true; value: T } | { ok: false; error: { message: string; code?: string } }

interface RemoteSettingsLike {
  describe(): Promise<RemoteResult<SettingsDescribeValue>>
  mutate(ns: string, ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<RemoteResult<SettingsNamespaceView>>
}

interface RemoteLike {
  settings?: RemoteSettingsLike
}

interface SlotsLike {
  inject(name: string, fn: () => () => void): () => void
  register(options: Record<string, unknown>, component: unknown): () => void
}

/** 两个标识分属两条宿主契约，别合并：
 *  · `ENTRY_ID` 是 Loader 行 id（`cordis.patch.yml` 的 `id`），也是设置面命名空间的键；
 *  · `BUNDLE_NAME` 是 npm 包名，`plugins.bundle.config` 槽按它把表单挂到 bundle 详情页。 */
export const ENTRY_ID = 'dsh-novel'
const BUNDLE_NAME = '@xrn1997/dsh-novel'

/** 听书缺省在设置面里的名字表：值由配置缝的类型逼出来——`ttsDefaultEngine` 之类改名时这里编译不过，
 *  而不是让接入层静默读出一格 undefined（读不出就退回 wire 缺省，等于用户的设置被悄悄丢掉）。 */
const TTS_DEFAULT_KEYS = {
  engineId: 'ttsDefaultEngine',
  rate: 'ttsDefaultRate',
  volume: 'ttsDefaultVolume',
  prefetchParagraphs: 'ttsPrefetchParagraphs',
} as const satisfies Record<keyof TtsDefaults, VolatileConfigFieldName>

/**
 * 设置面交回的**有效值**（用户覆盖叠加 schema 缺省）→ 播放层的回退链输入。
 * 只认类型对的那几格：缺席、null、空白引擎 id、非有限数都不写进结果，由播放层保持 wire 的
 * `TTS_DEFAULTS`——猜一个值等于把「读不出」冒充成「读到了」。
 */
export function ttsDefaultsFromSettings(value: Record<string, unknown>): Partial<TtsDefaults> {
  const out: Partial<TtsDefaults> = {}
  const engine = value[TTS_DEFAULT_KEYS.engineId]
  if (typeof engine === 'string' && engine.trim() !== '') out.engineId = engine
  const rate = value[TTS_DEFAULT_KEYS.rate]
  if (typeof rate === 'number' && Number.isFinite(rate)) out.rate = rate
  const volume = value[TTS_DEFAULT_KEYS.volume]
  if (typeof volume === 'number' && Number.isFinite(volume)) out.volume = volume
  const prefetch = value[TTS_DEFAULT_KEYS.prefetchParagraphs]
  if (typeof prefetch === 'number' && Number.isInteger(prefetch) && prefetch >= 0) {
    out.prefetchParagraphs = prefetch
  }
  return out
}

/** 可编辑字段的名字表由配置缝给（type-only import，运行时擦除、不过纯度门）：这里只写读者要看的
 *  文案键与单位，名字与值域不归本文件管——`FIELDS` 是 `Record<FieldName, …>`，少一行就编译不过。 */
type FieldName = VolatileConfigFieldName

/** 换算口径决定这一行长什么样，故与字段清单同处一表。`number` = 非负小数位（语速 / 音量）。 */
type Kind = 'ms' | 'bytes' | 'count' | 'number' | 'text'

interface FieldSpec {
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
const FIELDS: Record<FieldName, FieldSpec> = {
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

/** 字段状态：当前文本、是否与宿主存的值不同（草稿脏）、是否被用户层覆盖、是否类型非法。 */
interface FieldState {
  text: string
  overridden: boolean
  invalid: boolean
  /** 有未保存的草稿（与「已覆盖」不同：那是盘上的状态，这是这一屏的草稿）。 */
  dirty: boolean
}

/** 一位小数足够分辨档位，多一位就是假精度；整数不带小数点（200 MB 不写成 200.0 MB）。 */
function scale(n: number): string {
  const r = Math.round(n * 10) / 10
  return Number.isInteger(r) ? String(r) : r.toFixed(1)
}

/** 字节 → 人话。认 1024：本仓的字节数就是按 1024 算出来的（`200 * 1024 * 1024`），
 *  按 1000 换算会让「200 MB」这个框回读出 190.7 MB，回读就成了新的困惑源。 */
function humanBytes(n: number): string | null {
  if (!Number.isFinite(n) || n < 0) return null
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${scale(n / 1024)} KB`
  if (n < 1024 * 1024 * 1024) return `${scale(n / (1024 * 1024))} MB`
  return `${scale(n / (1024 * 1024 * 1024))} GB`
}

function humanMs(n: number, t: Translate): string | null {
  if (!Number.isFinite(n) || n < 0) return null
  if (n < 1000) return t('unit.ms', { n })
  const s = n / 1000
  if (s < 60) return t('unit.seconds', { n: scale(s) })
  const m = s / 60
  if (m < 60) return t('unit.minutes', { n: scale(m) })
  return t('unit.hours', { n: scale(m / 60) })
}

/** 空框与非法值都没有可回读的数——宁缺毋滥：把 `abc` 换算成 `NaN MB` 或把空框换算成
 *  `0 B`，都是拿一个编出来的数盖住真正该被看见的状态。 */
function readbackOf(spec: FieldSpec, text: string, t: Translate): string | null {
  if (spec.kind === 'text' || spec.kind === 'count') return null
  const parsed = parseField(spec, text)
  if (!parsed.ok || parsed.op.op !== 'set' || typeof parsed.op.value !== 'number') return null
  if (spec.kind === 'number') return scale(parsed.op.value)
  return spec.kind === 'bytes' ? humanBytes(parsed.op.value) : humanMs(parsed.op.value, t)
}

function isRecord(value: JsonValue | undefined): value is { [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 宿主值 → 框内文本。数字原样；字符串原样；缺席（未设置）给空串。 */
function textOf(value: JsonValue | undefined): string {
  if (typeof value === 'number') return String(value)
  if (typeof value === 'string') return value
  return ''
}

type Parsed =
  | { ok: true; op: SettingsPathOp }
  | { ok: false }

/**
 * 文本框 → 写入操作。**只判类型错**（整数位必须是非负安全整数；小数位必须是非负有限小数；
 * 文本位首尾空白归一，内部空白拒绝），值域由宿主在 `mutate` 时按 schema 裁决——本页不抄
 * schema 的上下界与代理正则，拒绝时原样显示宿主的理由。文本位清空 = `unset`（回出厂值），
 * 而不是写一个空串盖掉用户层；数字位与其他数值位一致，空框按类型错止住保存。
 */
function parseField(spec: FieldSpec, text: string): Parsed {
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

/**
 * 一个字段：`标签 | 输入框（值 + 框内后缀）`，说明与「恢复默认」按需展开。
 *
 * 框内后缀三态：单位（灰，`字节`）、人话回读（蓝，`≈ 15 秒`）、预设下拉（回读值 + 箭头）。
 * 预设**不铺一排 chip**：chip 占一整行高度、预设一多就换行，而这一页要的是密度；收进框内下拉后
 * 一行只有 30px，且「当前生效值」与「可选档位」是同一个入口。值仍是原始数（字节 / 倍），
 * 下拉只负责填值。
 */
function ConfigRow({ spec, field, disabled, span = false, onEdit, onReset }: {
  spec: FieldSpec
  field: FieldState
  disabled: boolean
  /** 这一行独占两列（该分组可见字段是奇数时，最后一个用它补位，不留半格空位）。 */
  span?: boolean
  onEdit: (text: string) => void
  onReset: () => void
}) {
  const t = useCopy()
  const [open, setOpen] = useState(false)
  const rowRef = useRef<HTMLDivElement | null>(null)
  const id = `novel-config-${spec.name}`
  const read = readbackOf(spec, field.text, t)
  const numeric = spec.kind !== 'text'
  const current = numeric && field.text.trim() !== '' ? Number(field.text) : NaN
  const unitKey = current === 1 && spec.unitOneKey !== undefined ? spec.unitOneKey : spec.unitKey
  const presets = spec.presets
  // 浮层要有统一的出口：点别处 / Esc 都收起来，而不是只能再点一次按钮。
  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent): void => {
      if (rowRef.current !== null && !rowRef.current.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  return (
    <div className={span ? "novel-cfg-row span2" : "novel-cfg-row"} data-novel-cfg-row={spec.name} ref={rowRef}>
      <div className="novel-cfg-label">
        <label className="novel-cfg-label-text" htmlFor={id}>{t(spec.labelKey)}</label>
        {/* 说明挂在问号上：悬浮 / 聚焦才浮出来。挂在行下方会撑开行高，把整页往下推一节。 */}
        <span className="novel-cfg-tipwrap">
          <button type="button" className="novel-cfg-q" aria-label={t('config.help')}
            aria-describedby={`${id}-meaning`}>?</button>
          <span className="novel-cfg-bubble" role="tooltip" id={`${id}-meaning`}>{t(spec.meaningKey)}</span>
        </span>
        {field.overridden ? (
          <span className="novel-cfg-od" role="img" data-novel-cfg-overridden={spec.name}
            title={t('config.overridden')} aria-label={t('config.overridden')} />
        ) : null}
        {field.dirty ? <span className="novel-cfg-dot" role="img" title={t('config.dirty')} aria-label={t('config.dirty')} /> : null}
        {field.overridden ? (
          <button type="button" className="novel-cfg-reset" onClick={onReset} disabled={disabled}
            title={t('config.reset')} aria-label={t('config.reset')}>↺</button>
        ) : null}
      </div>
      <div className="novel-cfg-field">
        {/* 数值位**不用** type=number：浏览器会把认不出的输入静默清成空串，用户看不到自己
            敲错了什么。「认不认得出」归本页的 parseField；值域（min / step）仍由 schema 在
            保存时把关——本页不重判。文本框 + inputMode 让草稿原样可见。 */}
        <input
          id={id}
          className="novel-cfg-input"
          type="text"
          // 小数位用 decimal：numeric 键盘在移动端不给小数点，0.8 这类值会没法敲。
          inputMode={numeric ? (spec.kind === 'number' ? 'decimal' : 'numeric') : undefined}
          value={field.text}
          placeholder={spec.placeholderKey === undefined ? undefined : t(spec.placeholderKey)}
          disabled={disabled}
          aria-invalid={field.invalid ? 'true' : undefined}
          // 单位、回读与报错都是这一格的含义：读屏用户看不到框内后缀，也不该只靠 aria-invalid 猜原因。
          aria-describedby={[`${id}-meaning`, unitKey === undefined ? null : `${id}-unit`, field.invalid ? `${id}-err` : null]
            .filter(Boolean).join(' ')}
          onChange={(event) => onEdit(event.target.value)}
        />
        {unitKey === undefined
          ? null
          : <span className="novel-cfg-unit" id={`${id}-unit`} data-novel-cfg-unit={spec.name}>{t(unitKey)}</span>}
        {presets === undefined ? (
          read === null ? null : (
            <span className="novel-cfg-hint">
              <span aria-hidden="true">≈ </span>
              <span className="novel-cfg-read" data-novel-cfg-read={spec.name}>{read}</span>
            </span>
          )
        ) : (
          <>
            <button
              type="button" className="novel-cfg-preset" disabled={disabled}
              aria-haspopup="menu" aria-expanded={open}
              aria-label={t('config.preset.aria', { value: read ?? t('config.preset.label') })}
              onClick={() => { setOpen((value) => !value) }}
            >
              <span className="novel-cfg-read" data-novel-cfg-read={read === null ? undefined : spec.name}>
                {read ?? t('config.preset.label')}
              </span>
              <span className="novel-cfg-caret" aria-hidden="true">▾</span>
            </button>
            {open ? (
              <div className="novel-cfg-menu novel-cfg-menu-preset" role="menu">
                {presets.map((preset) => (
                  <button
                    key={preset.label} type="button" role="menuitem"
                    className={`novel-cfg-menu-item${current === preset.value ? ' on' : ''}`}
                    onClick={() => { onEdit(String(preset.value)); setOpen(false) }}
                  >
                    <span>{preset.label}</span>
                    {current === preset.value ? <span className="novel-cfg-check" aria-hidden="true">✓</span> : null}
                  </button>
                ))}
                <div className="novel-cfg-menu-note">
                  {t('config.preset.custom')}<span>{t('config.preset.customHint')}</span>
                </div>
              </div>
            ) : null}
          </>
        )}
      </div>
      {field.invalid ? <p className="novel-cfg-err" id={`${id}-err`}>{t(spec.invalidKey)}</p> : null}
    </div>
  )
}

/** 页面读数面：`loading` 与 `unavailable` 是两种不同的「还没好」，不折叠成一个布尔。 */
type PageState =
  | { status: 'loading' }
  | { status: 'unavailable'; reason?: string }
  | {
    status: 'ready'
    writable: boolean
    revision: number
    value: Record<string, JsonValue>
    user: Record<string, JsonValue>
  }

function readyState(view: SettingsNamespaceView, writable: boolean): PageState {
  return {
    status: 'ready',
    writable,
    revision: view.revision,
    value: isRecord(view.value) ? view.value : {},
    user: isRecord(view.user) ? view.user : {},
  }
}

function Unavailable({ reason }: { reason?: string | undefined }) {
  const t = useCopy()
  return (
    <section data-novel-scope className="novel-cfg">
      <NovelStyles />
      {/* 有 reason = 设置面读失败；没有 = 条目不在 describe 的名单里（插件未加载）。 */}
      <p className="novel-cfg-note" role="status">{t(reason === undefined ? 'config.unavailable' : 'config.loadFailed')}</p>
      {reason === undefined ? null : <p className="novel-cfg-note novel-cfg-mono">{reason}</p>}
    </section>
  )
}

/**
 * 表单本体。所有写操作都走宿主设置面：
 *  · 保存 = 一次 `mutate`（脏字段合成一条原子写，带读到的 revision）；
 *  · 恢复默认 = 单字段 `unset`（撤的是用户层覆盖，不是把出厂值抄回去）。
 * 宿主拒绝（值域/冲突/未挂载）时返回 `{ ok: false }`，页面保留草稿并显示它给的理由。
 */
function NovelConfigCardBody({ remote }: { remote: RemoteSettingsLike }): ReactNode {
  const t = useCopy()
  const [page, setPage] = useState<PageState>({ status: 'loading' })
  const [drafts, setDrafts] = useState<Partial<Record<FieldName, string>>>({})
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setPage({ status: 'loading' })
    setFailure(null)
    const unavailable = (error: unknown): void => {
      if (cancelled) return
      setPage({ status: 'unavailable', reason: error instanceof Error ? error.message : String(error) })
    }
    try {
      void remote.describe().then((result) => {
        if (cancelled) return
        if (!result.ok) {
          setPage({ status: 'unavailable', reason: result.error.message })
          return
        }
        const view = result.value.namespaces.find((candidate) => candidate.ns === ENTRY_ID)
        if (view === undefined) {
          setPage({ status: 'unavailable' })
          return
        }
        setPage(readyState(view, result.value.writable))
        setDrafts({})
      }).catch(unavailable)
    } catch (error) {
      unavailable(error)
    }
    return () => { cancelled = true }
  }, [remote])

  /** 读到的有效值（用户层叠加 schema 缺省）同步推进播放层的回退链。宿主设置面没有变更订阅：
   *  只靠接入时那一发，配置页改完的听书缺省要等面板重载才生效；这里让保存 / 恢复默认后的
   *  读回也走同一份映射，下一次起播与预取当场用上新值。 */
  useEffect(() => {
    if (page.status !== 'ready') return
    setTtsDefaults(ttsDefaultsFromSettings(page.value))
  }, [page])

  // 脏草稿跟着这一屏走：宿主把这一页卸载掉（切走插件详情页）时，未保存的修改没有任何出口，
  // 静默丢掉等于让用户以为改了。卸载那一发进全局瞬态层（本仓唯一的错误出口），并且只报
  // 「丢了几项」——文案不让这一页再造第二个错误家。脏数每帧记进 ref，卸载时才读得到最新值。
  const dirtyCountRef = useRef(0)
  const copyRef = useRef(t)
  useEffect(() => { copyRef.current = t }, [t])
  useEffect(() => {
    if (page.status !== 'ready') { dirtyCountRef.current = 0; return }
    const stored = page.value
    dirtyCountRef.current = Object.keys(drafts).filter(
      (name) => drafts[name as FieldName] !== textOf(stored[name]),
    ).length
  })
  useEffect(() => () => {
    const lost = dirtyCountRef.current
    if (lost > 0) pushError(copyRef.current('config.droppedOnLeave', { n: lost }))
  }, [])

  if (page.status === 'loading') {
    return (
      <section data-novel-scope className="novel-cfg">
        <NovelStyles />
        <p className="novel-cfg-note" role="status">{t('common.loading')}</p>
      </section>
    )
  }
  if (page.status === 'unavailable') return <Unavailable reason={page.reason} />

  const disabled = !page.writable || saving
  const textOfField = (name: FieldName): string => drafts[name] ?? textOf(page.value[name])
  const parsedOf = (name: FieldName): Parsed => parseField(FIELDS[name], textOfField(name))
  const invalidOf = (name: FieldName): boolean => !parsedOf(name).ok
  const dirtyOf = (name: FieldName): boolean => drafts[name] !== undefined && textOfField(name) !== textOf(page.value[name])
  const overriddenOf = (name: FieldName): boolean => Object.hasOwn(page.user, name) || dirtyOf(name)
  const names = Object.keys(FIELDS) as FieldName[]
  const dirty = names.some(dirtyOf)
  // 只拦「这一笔草稿本身非法」：宿主交回的值若不合本页语法，不该连带锁死别的字段的保存。
  const invalid = names.some((name) => dirtyOf(name) && invalidOf(name))

  const edit = (name: FieldName, text: string): void => {
    setDrafts((current) => ({ ...current, [name]: text }))
    setFailure(null)
  }

  const applyView = (view: SettingsNamespaceView): void => {
    setPage(readyState(view, page.writable))
    setDrafts({})
  }

  const dropDraft = (name: FieldName): void => {
    setDrafts((current) => {
      const next = { ...current }
      Reflect.deleteProperty(next, name)
      return next
    })
  }

  /** 冲突后重读修订号但不碰草稿：用户刚敲的值仍在，下一笔写带新修订号即可继续。 */
  const refresh = async (): Promise<void> => {
    try {
      const result = await remote.describe()
      if (!result.ok) return
      const view = result.value.namespaces.find((candidate) => candidate.ns === ENTRY_ID)
      if (view !== undefined) setPage(readyState(view, result.value.writable))
    } catch {
      // 刷新也失败时保留原失败提示；旧修订号会让下一次写继续报冲突，不会静默覆盖。
    }
  }

  const fail = async (error: { message: string; code?: string }): Promise<void> => {
    setFailure(error.message)
    if (error.code === 'settings/conflict') await refresh()
  }

  const save = async (): Promise<void> => {
    if (disabled || !dirty || invalid) return
    const ops: SettingsPathOp[] = []
    for (const name of names) {
      if (!dirtyOf(name)) continue
      const parsed = parsedOf(name)
      if (parsed.ok) ops.push(parsed.op)
    }
    if (ops.length === 0) return
    setSaving(true)
    setFailure(null)
    try {
      const result = await remote.mutate(ENTRY_ID, ops, page.revision)
      if (!result.ok) { await fail(result.error); return }
      applyView(result.value)
    } catch (error: unknown) {
      setFailure(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  const resetField = async (name: FieldName): Promise<void> => {
    if (disabled) return
    setFailure(null)
    // 没有用户层覆盖：这一下只是撤本地草稿，不触远程。
    if (!Object.hasOwn(page.user, name)) {
      if (drafts[name] !== undefined) dropDraft(name)
      return
    }
    setSaving(true)
    try {
      const result = await remote.mutate(ENTRY_ID, [{ op: 'unset', path: [name] }], page.revision)
      // 草稿只在 unset 成功后丢：失败时用户刚敲的值仍在（与保存失败同一口径）。
      if (!result.ok) { await fail(result.error); return }
      setPage(readyState(result.value, page.writable))
      dropDraft(name)
    } catch (error: unknown) {
      setFailure(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  const discard = (): void => {
    setDrafts({})
    setFailure(null)
  }

  const fields = Object.fromEntries(names.map((name) => [name, {
    text: textOfField(name),
    overridden: overriddenOf(name),
    invalid: invalidOf(name),
    dirty: dirtyOf(name),
  }])) as Record<FieldName, FieldState>
  return (
    <NovelConfigPageView
      t={t}
      writable={page.writable}
      fields={fields}
      dirty={dirty}
      invalid={invalid}
      saving={saving}
      failure={failure}
      onEdit={edit}
      onReset={(name) => { void resetField(name) }}
      onSave={() => { void save() }}
      onDiscard={discard}
      engineManager={<EngineManager writable={page.writable} />}
    />
  )
}

export interface ConfigPageViewProps {
  t: Translate
  writable: boolean
  fields: Record<FieldName, FieldState>
  dirty: boolean
  invalid: boolean
  saving: boolean
  failure: string | null
  onEdit: (name: FieldName, text: string) => void
  onReset: (name: FieldName) => void
  onSave: () => void
  onDiscard: () => void
  /** 听书组的对象数据管理区（引擎清单）。静态渲染（几何门）不传：那一层不取数。 */
  engineManager?: ReactNode
}

/** 保存条吸底时，把宿主滚动区底部的那段留白补进吸附位移（返回清理函数）。
 *
 *  插件详情页的滚动区把页面底部留白做成 `padding-bottom`。Chromium 系
 *  引擎的 sticky 以**内容盒**为界：`bottom: 0` 吸住后保存条停在留白之上，条底下还会露出列表尾部——
 *  看起来像没贴底。这里在它第一次吸住时量出那条缝（条底边到滚动区可视底边的距离，最多量到
 *  底部内边距），以负 bottom 写回 `--novel-cfg-pin`，吸附位置就落到真正的可视底边。按规范以
 *  padding box 吸附的浏览器缝是 0，不写——同一条判据在两种引擎下各得其所。量一次就结算：
 *  滚动容器的内边距不随滚动变。
 *
 *  「吸住」的判据是条被上移：保存条是卡片最后一个子元素，流内底边就是卡片内容盒底边；
 *  rect 底边高于它才算吸住。只在吸住时量，卡片末尾的静止态不会被误补。
 *
 *  注：几何门把这个函数单独注入页面量吸附位置，所以它必须自足（只用 DOM API，不引本模块的
 *  其它助手）。 */
export function watchSavebarPin(bar: HTMLElement, card: HTMLElement): () => void {
  let scroller: HTMLElement | null = null
  for (let p = bar.parentElement; p !== null; p = p.parentElement) {
    const overflowY = getComputedStyle(p).overflowY
    if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') {
      scroller = p
      break
    }
  }
  if (scroller === null) return () => {}
  const port = scroller

  let settled = false
  const settle = (): void => {
    settled = true
    port.removeEventListener('scroll', measure)
  }
  const measure = (): void => {
    if (settled) return
    const barRect = bar.getBoundingClientRect()
    const cardStyle = getComputedStyle(card)
    const cardContentBottom = card.getBoundingClientRect().bottom
      - (parseFloat(cardStyle.paddingBottom) || 0)
      - (parseFloat(cardStyle.borderBottomWidth) || 0)
    if (barRect.bottom >= cardContentBottom - 1) return // 还躺在卡片末尾，没吸住
    const portStyle = getComputedStyle(port)
    const visibleBottom = port.getBoundingClientRect().bottom - (parseFloat(portStyle.borderBottomWidth) || 0)
    const gap = Math.max(0, visibleBottom - barRect.bottom)
    const inset = Math.min(gap, parseFloat(portStyle.paddingBottom) || 0)
    if (inset > 0) bar.style.setProperty('--novel-cfg-pin', `${-inset}px`)
    settle()
  }
  port.addEventListener('scroll', measure, { passive: true })
  measure()
  return () => { port.removeEventListener('scroll', measure) }
}

/** 纯呈现层（导出以便几何门静态渲染）：状态与动作都由调用方给，不碰宿主服务。
 *
 * 版式：一张卡、一条列表。工具条（筛选 + 分区下拉 + 仅看已改 + 改动计数）常驻顶部，保存条
 * **sticky 贴卡片底边**——一个保存钮不再意味着「必须滚回列表底部」。字段两列配对，每行只有一条
 * 30px 的框（值 + 框内单位/回读/预设下拉），说明在聚焦、已覆盖或非法时展开。
 *
 * 筛选与分区是同一个面的两个入口：分区分组粗筛，搜索词按名称/说明细筛；搜索框打字后它的下拉
 * 变成**命中的配置项**（带所属分区与当前值），回车直接跳到并聚焦那一行——配置项继续增长时，
 * 这是唯一还找得到东西的方式。
 */
export function NovelConfigPageView({
  t, writable, fields, dirty, invalid, saving, failure, onEdit, onReset, onSave, onDiscard,
  engineManager,
}: ConfigPageViewProps): ReactNode {
  const disabled = !writable || saving
  const [query, setQuery] = useState('')
  const [section, setSection] = useState<'all' | CopyKey>('all')
  const [onlyChanged, setOnlyChanged] = useState(false)
  const [secOpen, setSecOpen] = useState(false)
  const [resultsOpen, setResultsOpen] = useState(false)
  const [activeResult, setActiveResult] = useState(0)
  const [collapsed, setCollapsed] = useState<ReadonlySet<CopyKey>>(() => new Set())
  const [managerOpen, setManagerOpen] = useState(false)
  const filterRef = useRef<HTMLInputElement | null>(null)
  const filterBoxRef = useRef<HTMLDivElement | null>(null)
  const cardRef = useRef<HTMLDivElement | null>(null)
  const savebarRef = useRef<HTMLDivElement | null>(null)
  const resultsId = useId()
  const names = Object.keys(FIELDS) as FieldName[]
  const q = query.trim().toLowerCase()
  const labelOf = (name: FieldName): string => t(FIELDS[name].labelKey)
  const groupOf = (name: FieldName): (typeof GROUPS)[number] | undefined =>
    GROUPS.find((candidate) => candidate.names.includes(name))
  const sectionLabelOf = (name: FieldName): string => {
    const group = groupOf(name)
    return group === undefined ? '' : t(group.titleKey)
  }
  // 匹配面三处：显示名、说明，以及字段键本身（`ttsDefaultRate` 这类）——占位符承诺「名称」，
  // 而使用者手里最容易拿到的恰恰是键名（配置表 / 日志 / 文档里写的都是它）。
  const matchOf = (name: FieldName): boolean => q === ''
    || name.toLowerCase().includes(q)
    || labelOf(name).toLowerCase().includes(q)
    || t(FIELDS[name].meaningKey).toLowerCase().includes(q)
  const visibleOf = (name: FieldName): boolean =>
    (section === 'all' || groupOf(name)?.titleKey === section)
    && matchOf(name)
    && (!onlyChanged || fields[name].dirty)
  const results = q === '' ? [] : names.filter(visibleOf)
  /** 键盘高亮那一项（越界时回落到第一项）：combobox 的 aria-activedescendant 指向它。 */
  const activeName = results[activeResult] ?? results[0]
  const activeResultId = activeName === undefined ? undefined : `${resultsId}-opt-${results.indexOf(activeName)}`
  const changed = names.filter((name) => fields[name].dirty).length
  const anyVisible = names.some(visibleOf)

  const jumpTo = (name: FieldName): void => {
    // 跳过去之前先松开会藏住它的筛选（只看已改 / 分区）：目标已经在结果里，说明它过搜索这一关。
    setOnlyChanged(false)
    setSection('all')
    setResultsOpen(false)
    const target = document.getElementById(`novel-config-${name}`)
    if (target === null) return
    target.scrollIntoView({ block: 'center' })
    target.focus({ preventScroll: true })
  }

  // 筛选区的两枚浮层要有统一的出口：点别处收起来（Esc 走下面那条全局监听）。
  useEffect(() => {
    if (!secOpen && !resultsOpen) return
    const onDown = (event: MouseEvent): void => {
      if (filterBoxRef.current !== null && !filterBoxRef.current.contains(event.target as Node)) {
        setSecOpen(false)
        setResultsOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => { document.removeEventListener('mousedown', onDown) }
  }, [secOpen, resultsOpen])

  // 快捷键：⌘/Ctrl+K 聚焦筛选、⌘/Ctrl+S 保存、Esc 收浮层（输入法打开时 Esc 归输入法）。
  //  · K 是宿主也会用的全局命令（命令面板一类）：焦点不在本卡时一律不接管，否则等于替宿主
  //    改写同名键的语义。落在卡内任何位置（含筛选框自己）才把焦点交回筛选框。
  //  · S 先 preventDefault 再判条件：只在真保存时拦，浏览器「另存网页」就会在只读 / 非法 /
  //    无改动这三档里弹出来——那也是用户没要的意外。
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const meta = event.metaKey || event.ctrlKey
      const active = document.activeElement
      const inCard = cardRef.current !== null && active instanceof HTMLElement
        && cardRef.current.contains(active)
      if (meta && event.key.toLowerCase() === 'k') {
        if (!inCard) return
        event.preventDefault()
        filterRef.current?.focus()
        return
      }
      if (meta && event.key.toLowerCase() === 's') {
        event.preventDefault()
        if (disabled || !dirty || invalid) return
        onSave()
        return
      }
      if (event.key === 'Escape') {
        setSecOpen(false)
        setResultsOpen(false)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey) }
  }, [disabled, dirty, invalid, onSave])

  // 保存条吸住时补掉宿主滚动区的底部留白（吸到真正的可视底边；判据与量法见 watchSavebarPin）。
  useEffect(() => {
    const bar = savebarRef.current
    const card = cardRef.current
    if (bar === null || card === null) return
    return watchSavebarPin(bar, card)
  }, [])

  const onFilterKey = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown' && results.length > 0) {
      event.preventDefault()
      setResultsOpen(true)
      setActiveResult((index) => Math.min(index + 1, results.length - 1))
      return
    }
    if (event.key === 'ArrowUp' && results.length > 0) {
      event.preventDefault()
      setResultsOpen(true)
      setActiveResult((index) => Math.max(index - 1, 0))
      return
    }
    if (event.key === 'Enter') {
      const target = results[activeResult] ?? results[0]
      if (target !== undefined) {
        event.preventDefault()
        jumpTo(target)
      }
      return
    }
    if (event.key === 'Escape') {
      setResultsOpen(false)
      setSecOpen(false)
    }
  }

  const toggleGroup = (key: CopyKey): void => {
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  return (
    <CopyProvider value={t}>
      <section data-novel-scope className="novel-cfg">
        {/* 本页不在 NovelView 树下，拿不到它注入的样式层：与 SettingsSection 单飞同一口径，自带。 */}
        <NovelStyles />
        <div className="novel-cfg-title">
          <h3>{t('config.title')}</h3>
          <p>{t('config.subtitle')}</p>
        </div>
        {writable ? null : <p className="novel-cfg-note">{t('config.readOnly')}</p>}
        <div className="novel-cfg-card" ref={cardRef}>
          <div className="novel-cfg-toolbar">
            <div className="novel-cfg-filter" ref={filterBoxRef}>
              <span className="novel-cfg-search" aria-hidden="true">⌕</span>
              <input
                ref={filterRef}
                className="novel-cfg-searchinput"
                value={query}
                placeholder={t('config.filter.placeholder')}
                // 标准 combobox 三件套：输入框是组合框本体，弹出层是 listbox，
                // 键盘高亮靠 aria-activedescendant 而不是把 DOM 焦点搬进选项。
                role="combobox"
                aria-expanded={resultsOpen && q !== ''}
                aria-controls={resultsId}
                aria-autocomplete="list"
                {...(resultsOpen && q !== '' && activeResultId !== undefined
                  ? { 'aria-activedescendant': activeResultId }
                  : {})}
                aria-label={t('config.filter.placeholder')}
                onChange={(event) => {
                  setQuery(event.target.value)
                  setResultsOpen(true)
                  setSecOpen(false)
                  setActiveResult(0)
                }}
                onFocus={() => { setResultsOpen(query.trim() !== '') }}
                onKeyDown={onFilterKey}
              />
              {query === '' ? <kbd className="novel-cfg-kbd">{t('config.filter.shortcut')}</kbd> : (
                <button type="button" className="novel-cfg-clear" aria-label={t('config.filter.clear')}
                  onClick={() => { setQuery(''); setResultsOpen(false) }}>×</button>
              )}
              <button
                type="button" className="novel-cfg-section" disabled={disabled}
                aria-haspopup="menu" aria-expanded={secOpen} aria-label={t('config.filter.sections')}
                onClick={() => { setSecOpen((value) => !value); setResultsOpen(false) }}
              >
                {section === 'all' ? t('config.filter.all') : t(section)}
                <span className="novel-cfg-caret" aria-hidden="true">▾</span>
              </button>
              {secOpen ? (
                <div className="novel-cfg-menu novel-cfg-menu-section" role="menu">
                  {[{ key: 'all' as const, label: t('config.filter.all'), count: names.length },
                    ...GROUPS.map((group) => ({ key: group.titleKey, label: t(group.titleKey), count: group.names.length }))]
                    .map((item) => (
                      <button
                        key={item.key} type="button" role="menuitem"
                        className={`novel-cfg-menu-item${section === item.key ? ' on' : ''}`}
                        onClick={() => { setSection(item.key); setSecOpen(false) }}
                      >
                        <span>{item.label}</span>
                        <span className="novel-cfg-menu-count">{item.count}</span>
                      </button>
                    ))}
                </div>
              ) : null}
              {resultsOpen && q !== '' ? (
                <div className="novel-cfg-menu novel-cfg-menu-results" role="listbox" id={resultsId}
                  aria-label={t('config.filter.placeholder')}>
                  {results.length === 0
                    ? <div className="novel-cfg-menu-note">{t('config.filter.noMatch')}</div>
                    : results.map((name, index) => (
                      <button
                        key={name} type="button" role="option" aria-selected={index === activeResult}
                        id={`${resultsId}-opt-${index}`}
                        className={`novel-cfg-menu-item${index === activeResult ? ' on' : ''}`}
                        onMouseDown={(event) => { event.preventDefault() }}
                        onClick={() => { jumpTo(name) }}
                      >
                        <span className="novel-cfg-menu-label">{labelOf(name)}</span>
                        <span className="novel-cfg-menu-count">{sectionLabelOf(name)}</span>
                        <span className="novel-cfg-menu-value">{fields[name].text}</span>
                      </button>
                    ))}
                  <div className="novel-cfg-menu-note">
                    {t('config.filter.jump')}
                    <span>{plural(t, results.length, 'config.filter.hits.one', 'config.filter.hits.other')}</span>
                  </div>
                </div>
              ) : null}
            </div>
            <button type="button" className={`novel-cfg-only${onlyChanged ? ' on' : ''}`}
              aria-pressed={onlyChanged} onClick={() => { setOnlyChanged((value) => !value) }}>
              {t('config.filter.onlyChanged')}
            </button>
            <span className={`novel-cfg-changed${changed > 0 ? ' on' : ''}`}>
              {changed > 0
                ? plural(t, changed, 'config.filter.changed.one', 'config.filter.changed.other')
                : t('config.filter.noChanges')}
            </span>
          </div>
          <div className="novel-cfg-list">
            {GROUPS.map((group) => {
              const shown = group.names.filter(visibleOf)
              if (shown.length === 0) return null
              // 筛选期间一律展开：收起的组里藏着命中的行，等于把搜索结果又藏起来。
              const isCollapsed = q === '' && !onlyChanged && collapsed.has(group.titleKey)
              return (
                <section key={group.titleKey} className="novel-cfg-group" data-novel-cfg-group={group.titleKey}>
                  <button type="button" className="novel-cfg-grouphead" aria-expanded={!isCollapsed}
                    onClick={() => { toggleGroup(group.titleKey) }}>
                    <span className="novel-cfg-chev" aria-hidden="true">{isCollapsed ? '▸' : '▾'}</span>
                    <span className="novel-cfg-groupname">{t(group.titleKey)}</span>
                  </button>
                  {isCollapsed ? null : (
                    <div className="novel-cfg-cols">
                      {shown.map((name, index) => (
                        <ConfigRow
                          key={name}
                          spec={FIELDS[name]}
                          field={fields[name]}
                          disabled={disabled}
                          onEdit={(text) => onEdit(name, text)}
                          onReset={() => onReset(name)}
                          span={shown.length % 2 === 1 && index === shown.length - 1}
                        />
                      ))}
                    </div>
                  )}
                  {/* 听书段多一块对象数据管理区：默认收成一行，展开才取数（引擎清单是网络读面）。 */}
                  {group.wide === true && !isCollapsed && engineManager !== undefined ? (
                    <div className="novel-cfg-manager">
                      <button type="button" className="novel-cfg-grouphead novel-cfg-managerhead"
                        aria-expanded={managerOpen} onClick={() => { setManagerOpen((value) => !value) }}>
                        <span className="novel-cfg-chev" aria-hidden="true">{managerOpen ? '▾' : '▸'}</span>
                        <span className="novel-cfg-groupname">{t('config.engines')}</span>
                      </button>
                      {managerOpen ? engineManager : null}
                    </div>
                  ) : null}
                </section>
              )
            })}
            {anyVisible ? null : <p className="novel-cfg-note novel-cfg-empty">{t('config.filter.noMatch')}</p>}
          </div>
          <p className="novel-cfg-foot">
            {t('config.footer.before')}<code>dataDir</code>{t('config.footer.between')}<code>cordis.patch.yml</code>{t('config.footer.after')}
          </p>
          {failure === null ? null : <p className="novel-cfg-note" role="alert">{t('config.saveFailed')}<span className="novel-cfg-mono">{failure}</span></p>}
          <div className="novel-cfg-savebar" ref={savebarRef}>
            <span className={`novel-cfg-savedirty${changed > 0 ? ' on' : ''}`}>
              {changed > 0
                ? plural(t, changed, 'config.filter.changed.one', 'config.filter.changed.other')
                : t('config.filter.noChanges')}
            </span>
            <span className="novel-cfg-grow" />
            <kbd className="novel-cfg-kbd">{t('config.shortcut.save')}</kbd>
            <button type="button" className="novel-btn primary" disabled={disabled || !dirty || invalid} onClick={onSave}>
              {saving ? t('config.saving') : t('config.save')}
            </button>
            <button type="button" className="novel-btn" disabled={disabled || !dirty} onClick={onDiscard}>
              {t('config.discard')}
            </button>
          </div>
        </div>
      </section>
    </CopyProvider>
  )
}

/** 槽位入口：`t` 与远程设置面由注册时的 `inject` 递进来（两者都缺席时页面只报不可用）。 */
export function NovelConfigCard({ t = zhTranslate, remote }: { t?: Translate; remote?: RemoteSettingsLike }): ReactNode {
  if (remote === undefined) return <CopyProvider value={t}><Unavailable /></CopyProvider>
  return <CopyProvider value={t}><NovelConfigCardBody remote={remote} /></CopyProvider>
}

/** `t` 由浏览器半入口给；缺省 zhTranslate 让测试直渲与未接 locale 的宿主保持中文。 */
export function registerConfigPage(ctx: Context, t: Translate = zhTranslate): void {
  const host = ctx as unknown as { remote?: RemoteLike; slots: SlotsLike }
  const remote = host.remote?.settings
  if (remote === undefined || typeof remote.describe !== 'function' || typeof remote.mutate !== 'function') return
  ctx.effect(() => host.slots.inject('plugins.bundle.config', () => host.slots.register({
    name: 'plugins.bundle.config',
    key: BUNDLE_NAME,
    inject: () => ({ t, remote }),
  }, NovelConfigCard)), 'dsh-novel: config page')
}
