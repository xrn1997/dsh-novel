import type { Context } from '@deepseek-ai/cordis'
import { useSyncExternalStore } from 'react'
import {
  SettingsForm,
  SettingsFormModel,
  settingsNumberField,
  settingsTextField,
  type SettingsFieldState,
  type SettingsFormActions,
  type SettingsFormState,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { VolatileConfigFieldName } from '../config.js'
import {
  CopyProvider, useCopy, zhTranslate, type CopyKey, type Translate,
} from './copy/index.js'
import { NovelStyles } from './styles.js'

/**
 * 插件页的「运行参数」表单：宿主 `plugins.bundle.config` 槽按包名找占用者，`configForms`
 * 服务（key = Loader 行 id）提供 volatile 配置的读写面——保存只改宿主持有的活配置，下一次读数
 * 即生效，不重启插件（服务侧经 `resolveConfig` 的 getter 消费同一份值）。
 *
 * 职责边界：壳归宿主、行归本仓。`SettingsForm` 继续独占只读 / 不可用 / 保存失败三条语义，
 * 以及「离开页面即丢弃草稿」的时机；七个字段**每一行的几何**由本文件画。这不是嫌宿主原语丑——
 * 宿主 `SettingsValueField` 的入参只有 label / hint 两个字符串，「单位落在框内」「209715200 要
 * 读得出 200 MB」「给九位数一个不用手敲的入口」这三件事在它的面上没有位置可放。行自绘之后
 * 那三条没了背书，故由 `tests/client/config-page.test.tsx` 逐条钉住。
 *
 * 值与值域仍以 schema 为唯一主人：本页不出现缺省值与 min/max 的数字（「已覆盖」标记 +
 * 宿主模型的 `resetField` 动作就是回出厂值的路，不需要页面再抄一份出厂值）。预设档是**入口**
 * 不是缺省：它们是给人点的整数 MB，不与 schema 的 `.default()` 构成同一事实。
 *
 * 存活性：旧宿主没有 `configForms` 服务时 `registerConfigPage` 静默返回，侧栏 / 面板 /
 * 状态层完全不受影响——配置页是可选能力，不是加载前提。
 */

/** 两个标识分属两条宿主契约，别合并：
 *  · `ENTRY_ID` 是 Loader 行 id（`cordis.patch.yml` 的 `id`），也是 settings 命名空间与
 *    `configForms.get` / `whileServed` 的键——宿主按它找我们的配置；
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

/** 分区按「你什么时候会来动它」切，不按实现模块切：七个字段等权排一条纵列时，
 *  第 7 项在首屏之外，而最常调的两个（超时、并发）和最不敢调的两个（字节数）占一样的地方。 */
const GROUPS: { titleKey: CopyKey; names: readonly FieldName[] }[] = [
  { titleKey: 'config.group.search', names: ['searchTimeoutMs', 'searchParallel'] },
  { titleKey: 'config.group.reading', names: ['jsTimeoutMs', 'exportDelayMs'] },
  { titleKey: 'config.group.storage', names: ['cacheMaxBytes', 'localImportMaxBytes'] },
  { titleKey: 'config.group.network', names: ['proxyUrl'] },
]

/** 字段状态与壳层状态都直接取宿主声明的窄镜像（`host-ui.d.ts`）：不可用 / 只读 / 保存失败的
 *  文案与禁用态由宿主的 `SettingsForm` 按这些键驱动，本仓不再抄一份同形类型。 */
type FieldState = SettingsFieldState

/** 页面读数面 = 宿主壳层状态 + 每个可编辑字段的宿主字段状态（键由 `FieldName` 钉，不再逐格抄名）。 */
type NovelConfigState = SettingsFormState & Record<FieldName, FieldState>

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
  if (spec.kind === 'text' || spec.kind === 'count' || text.trim() === '') return null
  const n = Number(text)
  if (!Number.isFinite(n)) return null
  return spec.kind === 'bytes' ? humanBytes(n) : humanMs(n, t)
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
              敲错了什么。「认不认得出」归宿主模型（settingsNumberField 的 parse）；值域
              （min / step）仍由 schema 在保存时把关——本页不重判。文本框 + inputMode
              让草稿原样可见。 */}
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

/** 纯呈现组件（导出以便测试直渲）：表单状态与动作都由调用方给，不碰宿主服务。 */
export function NovelConfigCardView({ state, actions }: { state: NovelConfigState; actions: SettingsFormActions }) {
  // 宿主此刻渲染的文案面：不可用 / 只读 / 保存被拒由模型状态驱动，措辞跟着当前语言。
  const t = useCopy()
  const labels = {
    unavailable: t('config.unavailable'),
    readOnly: t('config.readOnly'),
    saveFailed: t('config.saveFailed'),
    save: t('config.save'),
    saving: t('config.saving'),
  }
  const disabled = !state.writable || state.saving === true
  return (
    <section data-novel-scope className="novel-cfg">
      {/* 本页不在 NovelView 树下，拿不到它注入的样式层：与 SettingsSection 单飞同一口径，自带。 */}
      <NovelStyles />
      <div className="novel-cfg-title">
        <h3>{t('config.title')}</h3>
        <p>{t('config.subtitle')}</p>
      </div>
      <SettingsForm labels={labels} state={state} onSave={actions.save} onDiscard={actions.discard}>
        <div className="novel-cfg-groups">
          {GROUPS.map((group) => (
            <section key={group.titleKey} className="novel-cfg-group">
              <h4>{t(group.titleKey)}</h4>
              {group.names.map((name) => (
                <ConfigRow
                  key={name}
                  spec={FIELDS[name]}
                  field={state[name]}
                  disabled={disabled}
                  onEdit={(text) => actions.edit(name, text)}
                  onReset={() => actions.resetField(name)}
                />
              ))}
            </section>
          ))}
        </div>
      </SettingsForm>
      <p className="novel-cfg-foot">
        {t('config.footer.before')}<code>dataDir</code>{t('config.footer.between')}<code>cordis.patch.yml</code>{t('config.footer.after')}
      </p>
    </section>
  )
}

interface ConfigFormsLike {
  get(entryId: string): unknown
  whileServed(namespaces: string[], register: (served: Set<string>) => () => void): () => void
}

interface SlotsLike {
  inject(name: string, fn: () => () => void): () => void
  register(options: Record<string, unknown>, component: unknown): () => void
}

/** `t` 由浏览器半入口给；缺省 zhTranslate 让测试直渲与未接 locale 的老宿主保持中文。 */
export function registerConfigPage(ctx: Context, t: Translate = zhTranslate): void {
  const host = ctx as unknown as { configForms?: ConfigFormsLike; slots: SlotsLike }
  const forms = host.configForms
  if (forms === undefined || typeof forms.get !== 'function' || typeof forms.whileServed !== 'function') return
  // 原语缺席只在宿主跨代混装时发生：宁可少一页配置，也不能让 apply 炸掉整个客户端。
  // 守卫必须覆盖页面消费的每一个原语——包括字段工厂：它们的调用会把「缺导出」从渲染期
  // 提前到模块求值期，那正是整棵客户端树陪葬的形态。
  if (
    typeof SettingsForm !== 'function' ||
    typeof SettingsFormModel !== 'function' ||
    typeof settingsNumberField !== 'function' ||
    typeof settingsTextField !== 'function'
  ) return

  // 字段声明与宿主的写协议同源：名字只有一份——`FIELDS` 的键（类型由配置缝的活值字段钉死，
  // 加一格漏一行就编译不过）。建在这里而不是模块顶层：字段工厂是宿主运行时能力，确认在场之前不得触碰。
  const names = Object.keys(FIELDS) as FieldName[]
  const fields = names.map((name) => (FIELDS[name].kind === 'text' ? settingsTextField(name) : settingsNumberField(name)))

  const model = new SettingsFormModel(forms.get(ENTRY_ID), fields)
  // `Object.fromEntries` 只给出索引签名，故这里断言回读数面：键集与 NovelConfigState 的一致性由
  // `FIELDS: Record<FieldName, FieldSpec>` 把住（少一行 FIELDS 就编译不过），不是手工保证
  const store = model.bind((): NovelConfigState => ({
    ...model.shell(),
    ...Object.fromEntries(names.map((name) => [name, model.field(name)])),
  } as NovelConfigState))
  const actions = model.actions()
  // 页面只认「快照 + 订阅」这一份契约（useSyncExternalStore），不依赖宿主槽位未公开的 hooks 约定。
  const subscribe = (listener: () => void) => store.subscribe(listener)
  const getSnapshot = () => store.getSnapshot()

  function NovelConfigCard({ t = zhTranslate }: { t?: Translate }) {
    const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
    return <CopyProvider value={t}><NovelConfigCardView state={state} actions={actions} /></CopyProvider>
  }

  ctx.effect(() => () => model.dispose(), 'dsh-novel: config form')
  // `whileServed` 在插件本体未加载 / 被停用时撤下占用者——配置页只对活着的插件露面。
  ctx.effect(
    () => forms.whileServed([ENTRY_ID], () => host.slots.inject('plugins.bundle.config', () => host.slots.register({
      name: 'plugins.bundle.config',
      key: BUNDLE_NAME,
      inject: () => ({ t }),
    }, NovelConfigCard))),
    'dsh-novel: config page',
  )
}
