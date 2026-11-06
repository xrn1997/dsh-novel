import type { Context } from '@deepseek-ai/cordis'
import { useEffect, useState, type ReactNode } from 'react'
import type { VolatileConfigFieldName } from '../config.js'
import {
  CopyProvider,
  useCopy,
  zhTranslate,
  type CopyKey,
  type Translate,
} from './copy/index.js'
import { GROUPS } from './config-groups.js'
import { NovelStyles } from './styles.js'

/**
 * 插件页的「运行参数」表单：宿主 `plugins.bundle.config` 槽按包名找占用者，值走宿主设置面
 * （`ctx.remote.settings` 的 `describe` / `mutate`，宿主 `settingsController` 的编目契约）。
 *
 * 为什么不是宿主表单原语：宿主页面校验清单不许页面/面板 import 任何宿主 client 包；本仓的
 * 跨插件协作一律走 cordis 服务（见 `ADR-0067`）。原语只是这层服务之上的表单状态包装，所以本页
 * 自己持有草稿、脏标记与保存态，写协议仍归宿主。
 *
 * 本页只拥有：字段清单（哪个字段、叫什么、单位与人话换算）与呈现。**值域归 schema**：
 * 本地只判「是不是非负整数」这类类型错；上下界、代理形状由宿主在写入时裁决，拒绝即原样显示
 * 宿主给的失败原因，草稿保留。
 *
 * 职责边界：宿主壳（标题、可用/只读、保存中/失败）由本页自绘；`dataDir` 等非活值不进表单
 * （改它等价于重启，见 `ADR-0035`）。宿主没有设置面（`remote.settings` 缺席）时不注册这一页，
 * 侧栏 / 面板 / 状态层完全不受影响。
 */

/** 与宿主设置面同一条 wire 语义的窄镜像（`ADR-0020`）：只声明本页用到的成员。 */
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

interface SettingsNamespaceView {
  ns: string
  value: JsonValue
  user?: JsonValue
  revision: number
}

interface SettingsDescribeValue {
  writable: boolean
  namespaces: SettingsNamespaceView[]
}

type SettingsPathOp =
  | { op: 'set'; path: string[]; value: JsonValue }
  | { op: 'unset'; path: string[] }

type RemoteResult<T> = { ok: true; value: T } | { ok: false; error: { message: string; code?: string } }

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
const ENTRY_ID = 'dsh-novel'
const BUNDLE_NAME = '@xrn1997/dsh-novel'

/** 可编辑字段的名字表由配置缝给（type-only import，运行时擦除、不过纯度门）：这里只写读者要看的
 *  文案键与单位，名字与值域不归本文件管——`FIELDS` 是 `Record<FieldName, …>`，少一行就编译不过。 */
type FieldName = VolatileConfigFieldName

/** 换算口径决定这一行长什么样，故与字段清单同处一表。 */
type Kind = 'ms' | 'bytes' | 'count' | 'text'

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
}

/** 字段状态：当前文本、是否与宿主存的值不同、是否类型非法。 */
interface FieldState {
  text: string
  overridden: boolean
  invalid: boolean
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
 * 文本框 → 写入操作。**只判类型错**（数字位必须是非负整数；文本位首尾空白归一，内部空白拒绝），
 * 值域由宿主在 `mutate` 时按 schema 裁决——本页不抄 schema 的上下界与代理正则，拒绝时原样显示
 * 宿主的理由。文本位清空 = `unset`（回出厂值），而不是写一个空串盖掉用户层。
 */
function parseField(spec: FieldSpec, text: string): Parsed {
  const trimmed = text.trim()
  if (spec.kind === 'text') {
    if (trimmed === '') return { ok: true, op: { op: 'unset', path: [spec.name] } }
    // 代理位只挡「连形状都不像」的输入（含空白）；完整形状归 schema，宿主拒绝时如实显示。
    if (/\s/.test(trimmed)) return { ok: false }
    return { ok: true, op: { op: 'set', path: [spec.name], value: trimmed } }
  }
  if (!/^\d+$/.test(trimmed)) return { ok: false }
  const n = Number(trimmed)
  if (!Number.isSafeInteger(n)) return { ok: false }
  return { ok: true, op: { op: 'set', path: [spec.name], value: n } }
}

function ConfigRow({ spec, field, disabled, onEdit, onReset }: {
  spec: FieldSpec
  field: FieldState
  disabled: boolean
  onEdit: (text: string) => void
  onReset: () => void
}) {
  // 每行跟着当前语言换文案：取词在行内，随父级重渲。
  const t = useCopy()
  const id = `novel-config-${spec.name}`
  const read = readbackOf(spec, field.text, t)
  const numeric = spec.kind !== 'text'
  const current = numeric && field.text.trim() !== '' ? Number(field.text) : NaN
  const unitKey = current === 1 && spec.unitOneKey !== undefined ? spec.unitOneKey : spec.unitKey
  return (
    <div className="novel-cfg-row">
      <div>
        <span className="novel-cfg-head">
          <label htmlFor={id}>{t(spec.labelKey)}</label>
          {field.overridden ? (
            <>
              <span className="novel-cfg-tag">{t('config.overridden')}</span>
              <button type="button" className="novel-cfg-reset" onClick={onReset} disabled={disabled}>
                {t('config.reset')}
              </button>
            </>
          ) : null}
        </span>
        <p className="novel-cfg-meaning" id={`${id}-meaning`}>{t(spec.meaningKey)}</p>
      </div>
      <div className="novel-cfg-side">
        <span className="novel-cfg-box">
          {/* 数值位**不用** type=number：浏览器会把认不出的输入静默清成空串，用户看不到自己
              敲错了什么。「认不认得出」归本页的 parseField；值域（min / step）仍由 schema 在
              保存时把关——本页不重判。文本框 + inputMode 让草稿原样可见。 */}
          <input
            id={id}
            className="novel-input novel-cfg-input"
            type="text"
            inputMode={numeric ? 'numeric' : undefined}
            value={field.text}
            placeholder={spec.placeholderKey === undefined ? undefined : t(spec.placeholderKey)}
            disabled={disabled}
            aria-invalid={field.invalid ? 'true' : undefined}
            // 单位与报错都是这一格的含义：读屏用户听不到框内的后缀，也不该只靠 aria-invalid 猜原因。
            aria-describedby={[`${id}-meaning`, unitKey === undefined ? null : `${id}-unit`, field.invalid ? `${id}-err` : null]
              .filter(Boolean).join(' ')}
            onChange={(event) => onEdit(event.target.value)}
          />
          {unitKey === undefined
            ? null
            : <span className="novel-cfg-unit" id={`${id}-unit`} data-novel-cfg-unit={spec.name}>{t(unitKey)}</span>}
        </span>
        {read ? <span className="novel-cfg-read" data-novel-cfg-read={spec.name}>{read}</span> : null}
        {spec.presets ? (
          <span className="novel-chips">
            {spec.presets.map((preset) => (
              <button
                key={preset.label}
                type="button"
                className={`novel-chip novel-cfg-preset${current === preset.value ? ' on' : ''}`}
                aria-pressed={current === preset.value}
                disabled={disabled}
                onClick={() => onEdit(String(preset.value))}
              >
                {preset.label}
              </button>
            ))}
          </span>
        ) : null}
        {field.invalid ? <p className="novel-cfg-err" id={`${id}-err`}>{t(spec.invalidKey)}</p> : null}
      </div>
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
}

/** 纯呈现层（导出以便几何门静态渲染）：状态与动作都由调用方给，不碰宿主服务。 */
export function NovelConfigPageView({
  t, writable, fields, dirty, invalid, saving, failure, onEdit, onReset, onSave, onDiscard,
}: ConfigPageViewProps): ReactNode {
  const disabled = !writable || saving
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
        <div className="novel-cfg-groups">
          {GROUPS.map((group) => (
            <section key={group.titleKey} className="novel-cfg-group">
              <h4>{t(group.titleKey)}</h4>
              {group.names.map((name) => (
                <ConfigRow
                  key={name}
                  spec={FIELDS[name]}
                  field={fields[name]}
                  disabled={disabled}
                  onEdit={(text) => onEdit(name, text)}
                  onReset={() => onReset(name)}
                />
              ))}
            </section>
          ))}
        </div>
        <p className="novel-cfg-foot">
          {t('config.footer.before')}<code>dataDir</code>{t('config.footer.between')}<code>cordis.patch.yml</code>{t('config.footer.after')}
        </p>
        {failure === null ? null : <p className="novel-cfg-note" role="alert">{t('config.saveFailed')}<span className="novel-cfg-mono">{failure}</span></p>}
        <div className="novel-cfg-bar">
          <button type="button" className="novel-btn primary" disabled={disabled || !dirty || invalid} onClick={onSave}>
            {saving ? t('config.saving') : t('config.save')}
          </button>
          <button type="button" className="novel-btn" disabled={disabled || !dirty} onClick={onDiscard}>
            {t('config.discard')}
          </button>
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
