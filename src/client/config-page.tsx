import type { Context } from '@deepseek-ai/cordis'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { dirtyCountOf, useConfigDraft, type FieldState } from './config-draft.js'
import { FIELDS, parseField, type FieldName, type FieldSpec } from './config-fields.js'
import type { JsonValue, RemoteSettingsLike } from './config-settings.js'
import { useConfigIndex } from './config-index.js'
import {
  CopyProvider,
  plural,
  useCopy,
  zhTranslate,
  type Translate,
} from './copy/index.js'
import { GROUPS } from './config-groups.js'
import { NovelStyles } from './styles.js'
import { EngineManager } from './tts/EngineManager.js'

/** 配置页读到生效值（初始 / 保存 / 恢复默认 / 冲突重读）时的回调：生效值由此跨 seam
 *  （生产接设置面快照 adapter 的 `refresh`）。草稿不走这里——只有生效值过 seam。 */
export type OnEffectiveValue = (value: Record<string, JsonValue>) => void


/**
 * 插件页的「运行参数」表单：宿主 `plugins.bundle.config` 槽按包名找占用者，值走宿主设置面
 * （`ctx.remote.settings` 的 `describe` / `mutate`，宿主 `settingsController` 的编目契约）。
 *
 * 为什么不是宿主表单原语：宿主页面校验清单不许页面/面板 import 任何宿主 client 包；本仓的
 * 跨插件协作一律走 cordis 服务（见 `ADR-0067`）。原语只是这层服务之上的表单状态包装，所以本页
 * 自己持有字段表（`config-fields`）、草稿（`config-draft`）与索引现场（`config-index`），写协议仍归宿主。
 *
 * 本页只拥有：字段清单的呈现（哪个字段、叫什么、单位与人话换算）与卡片版式。**值域归 schema**：
 * 本地只判「是不是合法数字」这类类型错；上下界、代理形状由宿主在写入时裁决，拒绝即原样显示
 * 宿主给的失败原因，草稿保留。
 *
 * 职责边界：宿主壳（标题、可用/只读、保存中/失败）由本页自绘；`dataDir` 等非活值不进表单
 * （改它等价于重启，见 `ADR-0035`）。宿主没有设置面（`remote.settings` 缺席）时不注册这一页，
 * 侧栏 / 面板 / 状态层完全不受影响。
 */

/** 两个标识分属两条宿主契约，别合并：
 *  · `ENTRY_ID` 是 Loader 行 id（`cordis.patch.yml` 的 `id`），也是设置面命名空间的键；
 *  · `BUNDLE_NAME` 是 npm 包名，`plugins.bundle.config` 槽按它把表单挂到 bundle 详情页。 */
export const ENTRY_ID = 'dsh-novel'
const BUNDLE_NAME = '@xrn1997/dsh-novel'

/** 宿主槽位与 remote 的窄镜像（`ADR-0020`）：只声明本页用到的成员。 */
interface RemoteLike {
  settings?: RemoteSettingsLike
}

interface SlotsLike {
  inject(name: string, fn: () => () => void): () => void
  register(options: Record<string, unknown>, component: unknown): () => void
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
function NovelConfigCardBody(
  { remote, onEffectiveValue }: { remote: RemoteSettingsLike; onEffectiveValue: OnEffectiveValue },
): ReactNode {
  const t = useCopy()
  const { state, edit, reset, save, discard } = useConfigDraft({
    ns: ENTRY_ID,
    remote,
    translate: t,
    onEffectiveValue,
  })

  if (state.status === 'loading') {
    return (
      <section data-novel-scope className="novel-cfg">
        <NovelStyles />
        <p className="novel-cfg-note" role="status">{t('common.loading')}</p>
      </section>
    )
  }
  if (state.status === 'unavailable') return <Unavailable reason={state.reason} />

  return (
    <NovelConfigPageView
      t={t}
      writable={state.writable}
      fields={state.fields}
      dirty={state.dirty}
      invalid={state.invalid}
      saving={state.saving}
      failure={state.failure}
      onEdit={edit}
      onReset={reset}
      onSave={save}
      onDiscard={discard}
      engineManager={<EngineManager writable={state.writable} />}
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
  const index = useConfigIndex({ t, fields, onSave })
  const { cardRef, filterRef, filterBoxRef } = index
  const savebarRef = useRef<HTMLDivElement | null>(null)
  const changed = dirtyCountOf(fields)

  // 保存条吸住时补掉宿主滚动区的底部留白（吸到真正的可视底边；判据与量法见 watchSavebarPin）。
  useEffect(() => {
    const bar = savebarRef.current
    const card = cardRef.current
    if (bar === null || card === null) return
    return watchSavebarPin(bar, card)
  }, [cardRef])

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
                value={index.query}
                placeholder={t('config.filter.placeholder')}
                // 标准 combobox 三件套：输入框是组合框本体，弹出层是 listbox，
                // 键盘高亮靠 aria-activedescendant 而不是把 DOM 焦点搬进选项。
                role="combobox"
                aria-expanded={index.resultsOpen && index.q !== ''}
                aria-controls={index.resultsId}
                aria-autocomplete="list"
                {...(index.resultsOpen && index.q !== '' && index.activeOptionId !== undefined
                  ? { 'aria-activedescendant': index.activeOptionId }
                  : {})}
                aria-label={t('config.filter.placeholder')}
                onChange={(event) => { index.search(event.target.value) }}
                onFocus={index.focusSearch}
                onKeyDown={index.onFilterKey}
              />
              {index.query === '' ? <kbd className="novel-cfg-kbd">{t('config.filter.shortcut')}</kbd> : (
                <button type="button" className="novel-cfg-clear" aria-label={t('config.filter.clear')}
                  onClick={index.clearSearch}>×</button>
              )}
              <button
                type="button" className="novel-cfg-section" disabled={disabled}
                aria-haspopup="menu" aria-expanded={index.secOpen} aria-label={t('config.filter.sections')}
                onClick={index.toggleSections}
              >
                {index.section === 'all' ? t('config.filter.all') : t(index.section)}
                <span className="novel-cfg-caret" aria-hidden="true">▾</span>
              </button>
              {index.secOpen ? (
                <div className="novel-cfg-menu novel-cfg-menu-section" role="menu">
                  {index.sectionItems.map((item) => (
                    <button
                      key={item.key} type="button" role="menuitem"
                      className={`novel-cfg-menu-item${index.section === item.key ? ' on' : ''}`}
                      onClick={() => { index.selectSection(item.key) }}
                    >
                      <span>{item.label}</span>
                      <span className="novel-cfg-menu-count">{item.count}</span>
                    </button>
                  ))}
                </div>
              ) : null}
              {index.resultsOpen && index.q !== '' ? (
                <div className="novel-cfg-menu novel-cfg-menu-results" role="listbox" id={index.resultsId}
                  aria-label={t('config.filter.placeholder')}>
                  {index.results.length === 0
                    ? <div className="novel-cfg-menu-note">{t('config.filter.noMatch')}</div>
                    : index.results.map((name, position) => (
                      <button
                        key={name} type="button" role="option" aria-selected={position === index.activeResult}
                        id={`${index.resultsId}-opt-${position}`}
                        className={`novel-cfg-menu-item${position === index.activeResult ? ' on' : ''}`}
                        onMouseDown={(event) => { event.preventDefault() }}
                        onClick={() => { index.jumpTo(name) }}
                      >
                        <span className="novel-cfg-menu-label">{index.labelOf(name)}</span>
                        <span className="novel-cfg-menu-count">{index.sectionLabelOf(name)}</span>
                        <span className="novel-cfg-menu-value">{fields[name].text}</span>
                      </button>
                    ))}
                  <div className="novel-cfg-menu-note">
                    {t('config.filter.jump')}
                    <span>{plural(t, index.results.length, 'config.filter.hits.one', 'config.filter.hits.other')}</span>
                  </div>
                </div>
              ) : null}
            </div>
            <button type="button" className={`novel-cfg-only${index.onlyChanged ? ' on' : ''}`}
              aria-pressed={index.onlyChanged} onClick={index.toggleOnlyChanged}>
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
              const shown = group.names.filter(index.visibleOf)
              if (shown.length === 0) return null
              // 筛选期间一律展开：收起的组里藏着命中的行，等于把搜索结果又藏起来。
              const isCollapsed = index.collapsedOf(group.titleKey)
              return (
                <section key={group.titleKey} className="novel-cfg-group" data-novel-cfg-group={group.titleKey}>
                  <button type="button" className="novel-cfg-grouphead" aria-expanded={!isCollapsed}
                    onClick={() => { index.toggleGroup(group.titleKey) }}>
                    <span className="novel-cfg-chev" aria-hidden="true">{isCollapsed ? '▸' : '▾'}</span>
                    <span className="novel-cfg-groupname">{t(group.titleKey)}</span>
                  </button>
                  {isCollapsed ? null : (
                    <div className="novel-cfg-cols">
                      {shown.map((name, position) => (
                        <ConfigRow
                          key={name}
                          spec={FIELDS[name]}
                          field={fields[name]}
                          disabled={disabled}
                          onEdit={(text) => onEdit(name, text)}
                          onReset={() => onReset(name)}
                          span={shown.length % 2 === 1 && position === shown.length - 1}
                        />
                      ))}
                    </div>
                  )}
                  {/* 听书段多一块对象数据管理区：默认收成一行，展开才取数（引擎清单是网络读面）。 */}
                  {group.wide === true && !isCollapsed && engineManager !== undefined ? (
                    <div className="novel-cfg-manager">
                      <button type="button" className="novel-cfg-grouphead novel-cfg-managerhead"
                        aria-expanded={index.managerOpen} onClick={index.toggleManager}>
                        <span className="novel-cfg-chev" aria-hidden="true">{index.managerOpen ? '▾' : '▸'}</span>
                        <span className="novel-cfg-groupname">{t('config.engines')}</span>
                      </button>
                      {index.managerOpen ? engineManager : null}
                    </div>
                  ) : null}
                </section>
              )
            })}
            {index.anyVisible ? null : <p className="novel-cfg-note novel-cfg-empty">{t('config.filter.noMatch')}</p>}
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

/** 槽位入口：`t`、远程设置面与生效值回调由注册时的 `inject` 递进来（`remote` 或 `onEffectiveValue` 缺席时页面报不可用）。 */
export function NovelConfigCard(
  { t = zhTranslate, remote, onEffectiveValue }: {
    t?: Translate; remote?: RemoteSettingsLike; onEffectiveValue?: OnEffectiveValue
  },
): ReactNode {
  if (remote === undefined || onEffectiveValue === undefined) {
    return <CopyProvider value={t}><Unavailable /></CopyProvider>
  }
  return <CopyProvider value={t}><NovelConfigCardBody remote={remote} onEffectiveValue={onEffectiveValue} /></CopyProvider>
}

/** `t` 由浏览器半入口给；缺省 zhTranslate 让测试直渲与未接 locale 的宿主保持中文。
 *  `onEffectiveValue` 为必填回调（生产接设置面快照 adapter）；仅 `remote.settings` 缺席或无 `describe`/`mutate` 时按「不注册」处理。 */
export function registerConfigPage(
  ctx: Context, onEffectiveValue: OnEffectiveValue, t: Translate = zhTranslate,
): void {
  const host = ctx as unknown as { remote?: RemoteLike; slots: SlotsLike }
  const remote = host.remote?.settings
  if (remote === undefined || typeof remote.describe !== 'function' || typeof remote.mutate !== 'function') return
  ctx.effect(() => host.slots.inject('plugins.bundle.config', () => host.slots.register({
    name: 'plugins.bundle.config',
    key: BUNDLE_NAME,
    inject: () => ({ t, remote, onEffectiveValue }),
  }, NovelConfigCard)), 'dsh-novel: config page')
}
