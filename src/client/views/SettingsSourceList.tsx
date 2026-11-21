import type { ReactNode } from 'react'
import { Fragment, useEffect, useRef, useState } from 'react'
import { bodies, paramOps, ROUTES } from '../../shared/wire.js'
import { describeError } from '../api.js'
import { plural, useCopy, type CopyKey } from '../copy/index.js'
import { prodDeps } from '../deps.js'
import type { RowActionDeps, SettingsDeps } from '../deps.js'
import { startSourceVerification } from '../jobs.js'
import { useOptimisticCell } from '../optimistic-cell.js'
import { clearSelection, groupIcon, selectMany, setEditMode, sourceListUi, toggleSelect, UNGROUPED } from '../source-list.js'
import type { StatusFilter } from '../source-list.js'
import { deriveSourceListView, filterWrites } from '../source-list-view.js'
import { findScrollport } from '../scrollport.js'
import { useStore } from '../store.js'
import { useTransientFlag } from '../transient.js'
import { StatusBadge } from './bits.js'
import { Dialog } from './dialog.js'
import { SourceAuthPane } from './SourceAuthPane.js'
import type { JobState, SourcePublic } from './types.js'

/**
 * 源列表（书源管理 tab 的资产清单）：列表头（标题 + **状态带** + 文本/状态与 AI/分组过滤 +
 * 编辑切换 + ＋导入书源）+ 编辑态批量条 + 七列表格 + 前端分页。
 *
 * 交互口径：状态下拉只过滤不总览；删除走**统一模态二次确认**（失败即收模态、错误进全局条）；
 * 启停与 AI 搜索勾选常驻右侧，其余行内动作收进「⋯」菜单。
 * 现场（query/过滤/勾选/编辑态）在模块级 sourceListUi store；派生计算归 `source-list-view.ts`。
 */

const PAGE_SIZE = 100

/** 单源行的错误锚点：全局条「定位 →」与行内红边共用同一个选择器，与行渲染的 `data-novel-source-row` 同源。 */
export function rowAnchorOf(id: string): string {
  return `[data-novel-source-row="${id}"]`
}

/** 源列表壳层与行的依赖面：行内写口三件套 + 提交一轮验证（编排归 `jobs.ts` 的 `startSourceVerification`）。 */
type SourceListDeps = RowActionDeps & Pick<SettingsDeps, 'startBatchProbeJob'>

/** 批量写口的命令表：启停 / AI 标记 / 删除的差异只在路由、body、回执措辞与成功后收尾。
 *  计数取服务端回包的生效数——报「我勾了几个」会说谎。 */
type BatchCommand = {
  /** 提交写请求并按命令读回生效计数（`on` 是方向：启用/停用、加入/移出） */
  send: (deps: SourceListDeps, ids: string[], on: boolean) => Promise<number>
  /** 成功回执的单/复数文案键，由 `on` 选方向 */
  okKeys: (on: boolean) => readonly [CopyKey, CopyKey]
  /** 失败回执键，detail 由驱动器填 */
  failKey: CopyKey
  /** 成功后清空勾选：删除的 id 已不存在，留着是幽灵勾选；启停/标记的源还在列表里，勾选是它们的现场 */
  clearsSelection?: true
}

const BATCH_COMMANDS = {
  enabled: {
    send: (deps, ids, on) => deps.apiSend<{ updated: number }>(
      ROUTES.sourcesBatchEnabled, bodies.batchEnabled(ids, on)).then((r) => r.updated),
    okKeys: (on) => (on
      ? ['sources.batch.enabled.one', 'sources.batch.enabled.other']
      : ['sources.batch.disabled.one', 'sources.batch.disabled.other']),
    failKey: 'sources.batch.failed',
  },
  aiSearch: {
    send: (deps, ids, on) => deps.apiSend<{ updated: number }>(
      ROUTES.sourcesBatchAiSearch, bodies.batchAiSearch(ids, on)).then((r) => r.updated),
    okKeys: (on) => (on
      ? ['sources.batch.aiEnabled.one', 'sources.batch.aiEnabled.other']
      : ['sources.batch.aiDisabled.one', 'sources.batch.aiDisabled.other']),
    failKey: 'sources.batch.failed',
  },
  delete: {
    send: (deps, ids) => deps.apiSend<{ removed: number }>(
      ROUTES.sourcesBatchDelete, bodies.ids(ids)).then((r) => r.removed),
    okKeys: () => ['sources.delete.removed.one', 'sources.delete.removed.other'],
    failKey: 'sources.delete.failed',
    clearsSelection: true,
  },
} satisfies Record<string, BatchCommand>

/** 状态下拉：六维单选（'disabled' 维是 enabled 布尔、'ai' 维是 AI 标记，两者与 status 正交）。
 *  不带计数：全库读数唯一住址是列表头**状态带**，下拉只过滤。 */
const STATUS_OPTIONS: Array<{ key: StatusFilter; labelKey: CopyKey }> = [
  { key: 'all', labelKey: 'sources.filter.all' },
  { key: 'verified', labelKey: 'sources.filter.available' },
  { key: 'unverified', labelKey: 'sources.filter.unverified' },
  { key: 'broken', labelKey: 'sources.filter.broken' },
  { key: 'disabled', labelKey: 'sources.filter.disabled' },
  { key: 'ai', labelKey: 'sources.filter.ai' },
]

export function SourceList({ sources, job, onChanged, onProbe, onImport, loadError = null, deps = prodDeps }: {
  sources: SourcePublic[] | null; job: JobState | null
  onChanged: () => void; onProbe: (id: string) => void
  /** 打开导入弹层（壳层持有弹层现场） */
  onImport: () => void
  /** 上层取数失败信息：有错时既不渲染空态也不渲染表格——失败由壳层红字统一说一遍（三态见下方表体注释） */
  loadError?: string | null
  /** 依赖束：缺省生产实现；测试注入假 adapter 驱动接线层 */
  deps?: SourceListDeps
}): ReactNode {
  const t = useCopy()
  const ui = useStore(sourceListUi)
  const [limit, setLimit] = useState(PAGE_SIZE)
  // 筛选的唯一写口：换筛选就是换一批结果，页码跟着回第一页（规则归 source-list-view.ts）。
  const filters = filterWrites(() => setLimit(PAGE_SIZE))
  // opener = 触发件：模态关闭后焦点还给它。不能靠 document.activeElement——菜单项在模态挂载前已随菜单卸载。
  const [pending, setPending] = useState<{ ids: string[]; title: string; opener: HTMLElement | null } | null>(null)
  const [delBusy, setDelBusy] = useState(false)     // 删除提交在途：确认钮禁用 + 重入口拒绝（与书架 delBusy 同款）
  // 0 源与取数失败**不换掉列表头**：整块 early-return 会让提示指向被跳过的表头里那颗钮。
  // 表头是工具条（导入与源数无关），只有表体换内容。
  const all = sources ?? []
  const loaded = sources !== null
  /** 空态成立的唯一条件：**确实取到了** 0 个源。加载中与取数失败都不算——后者会把失败伪装成
   *  「还没有书源」这条确定结论（宁炸不猜）。 */
  const showEmpty = loaded && all.length === 0 && loadError === null
  // 派生计算归纯函数 module（过滤管线/分组选项集/选中态/登录态计数）——语义在那边单测钉死
  const vm = deriveSourceListView(all, ui, limit)
  const { filtered, shown, selected: selection } = vm
  const { groupCounts, groupLegend, authCountOf, allFilteredSelected, ungroupedCount, stats } = vm
  // 任务在途 → 三个批量写口禁用：服务端是**单任务槽**。删除所选不禁：删除不是任务，
  // 且服务端明确支持验证途中删源，模态确认即是二次确认。
  const probing = job?.phase === 'running'
  /** 批量写口的唯一驱动器：成功后重取源列表；验证起的是后台任务，不走这里。`settle` 两路都跑——
   *  删除的模态两路都要收。 */
  const runBatch = (cmd: BatchCommand, ids: string[], on: boolean, settle: () => void = () => {}): void => {
    void cmd.send(deps, ids, on).then((n) => {
      settle()
      if (cmd.clearsSelection === true) clearSelection()   // 已删的 id 留在选择集里是幽灵勾选
      deps.pushOk(plural(t, n, ...cmd.okKeys(on)))
      onChanged()
    }, (e: unknown) => {
      settle()
      deps.pushError(t(cmd.failKey, { detail: describeError(e, t) }))
    })
  }
  /** 选中动作条的写口：ids 点击时快照，不随列表变化重算。 */
  const runSelectionBatch = (cmd: BatchCommand, on: boolean): void => { runBatch(cmd, [...ui.selection], on) }
  /** 删除确认：ids 是开模时的快照；在途防重（双击确认会双 POST）。成功/失败都收模态。 */
  const confirmDelete = (): void => {
    if (pending === null || delBusy) return
    setDelBusy(true)
    runBatch(BATCH_COMMANDS.delete, pending.ids, true, () => {
      setPending(null)
      setDelBusy(false)
    })
  }
  /** 行内启停开关：单击即切——乐观更新在行内组件。**秒级操作不进瞬态泳道**（闪烁回归锁）：
   *  反馈若占布局位置会把设置区顶下去再弹回；在途只留行内「保存中」，成功静默，失败才挂行锚点。 */
  const toggleEnabled = (s: SourcePublic, next: boolean): Promise<boolean> => {
    return deps.apiSend(paramOps.sourceEnabled.at(s.id), bodies.enabled(next)).then(() => {
      onChanged()
      return true
    }, (e: unknown) => {
      deps.pushError(
        t('sources.toggle.failedNamed', { name: s.name, detail: describeError(e, t) }), rowAnchorOf(s.id))
      onChanged()                                        // 服务端为准的二次校准（行内已即刻回滚）
      return false
    })
  }
  /** 行内 AI 搜索勾选：与启停同一条失败口径；只改 AI 工具面的参与集，不碰启停与界面搜索。 */
  const toggleAiSearch = (s: SourcePublic, next: boolean): Promise<boolean> => {
    return deps.apiSend(paramOps.sourceAiSearch.at(s.id), bodies.aiSearch(next)).then(() => {
      onChanged()
      return true
    }, (e: unknown) => {
      deps.pushError(
        t('sources.ai.failedNamed', { name: s.name, detail: describeError(e, t) }), rowAnchorOf(s.id))
      onChanged()
      return false
    })
  }
  return (
    <div data-novel-source-list className="novel-group">
      <div className="novel-list-head">
        <strong>{t('sources.list.title')}</strong>
        {/* 状态带：全库读数的**唯一**住址。0 也显示读数；**只在真有数据可报时在场**——加载中不报，
            0 源不报（空态已说同一件事）。 */}
        {loaded && all.length > 0 && (
          <span className="novel-src-stats" data-novel-src-stats>
            <span>{plural(t, stats.total, 'sources.stats.total.one', 'sources.stats.total.other')}</span>
            <span>{t('sources.stats.enabled', { n: stats.enabled })}</span>
            <span className="slim">{t('sources.stats.disabled', { n: stats.disabled })}</span>
            <span className="slim">{t('sources.stats.ai', { n: stats.ai })}</span>
            <span className={stats.unverified > 0 ? 'slim warn' : 'slim'}>{t('sources.stats.unverified', { n: stats.unverified })}</span>
            <span className={stats.broken > 0 ? 'slim err' : 'slim'}>{t('sources.stats.broken', { n: stats.broken })}</span>
            {filtered.length === stats.total ? null : <span>{t('sources.stats.filtered', { n: filtered.length })}</span>}
          </span>
        )}
        <span className="novel-grow" />
        <input
          data-novel-source-filter
          className="novel-input novel-source-query"
          value={ui.query}
          onChange={(e) => filters.query(e.target.value)}
          placeholder={t('sources.filter.placeholder')}
          aria-label={t('sources.filter.label')}
        />
        <select
          data-novel-status-filter
          className="novel-input"
          value={ui.statusFilter}
          aria-label={t('sources.filter.statusLabel')}
          onChange={(e) => filters.status(e.target.value as StatusFilter)}
        >
          {STATUS_OPTIONS.map((o) => <option key={o.key} value={o.key}>{t(o.labelKey)}</option>)}
        </select>
        {/* 分组下拉：组名是用户数据、不可枚举，不配 chips——下拉单选收敛宽度，与状态/文本过滤叠加；
            选项集按**全库**聚合计数，不随状态/文本过滤缩水（可组合过滤，语义钉在 view-model） */}
        <select
          data-novel-group-filter
          className="novel-input novel-group-filter"
          value={ui.groupFilter}
          aria-label={t('sources.filter.groupLabel')}
          onChange={(e) => filters.group(e.target.value)}
        >
          <option value="">{t('sources.group.all')}</option>
          {/* 「未分组」伪选项：无分组源不属于任何真实组——单独入口才定位得到（批量补分组）；
              哨兵值 UNGROUPED 防与真实组名撞名；计数 0 时不渲染（不添噪声选项） */}
          {ungroupedCount > 0 && <option value={UNGROUPED}>{t('sources.group.ungrouped', { n: ungroupedCount })}</option>}
          {/* 分组名是用户数据（中文）；排序按中文 collation，界面语言切换不改变选项顺序 */}
          {[...groupCounts.entries()].sort(([a], [b]) => a.localeCompare(b, 'zh')).map(([g, n]) => (
            <option key={g} value={g}>{t('sources.group.option', { name: g, n })}</option>
          ))}
        </select>
        <button className={ui.editMode ? 'novel-btn sm on' : 'novel-btn sm'}
          data-novel-edit-toggle
          onClick={() => setEditMode(!ui.editMode)}>
          {ui.editMode ? t('sources.done') : t('sources.edit')}
        </button>
        {/* 单任务槽：任何任务在跑时不允许再开导入（与待办动作、导入面板的 busy 同一判据） */}
        <button className="novel-btn primary" data-novel-import-open disabled={probing} onClick={onImport}>{t('sources.import.open')}</button>
      </div>

      <div className="novel-list-body">
        {/* 选中动作条：操作与作用对象同框（编辑态才有意义） */}
        {ui.selection.length > 0 && (
          <div data-novel-selbar className="novel-selbar">
            <strong>{t('sources.batch.selected', { n: ui.selection.length })}</strong>
            <button className="novel-btn sm" disabled={probing} onClick={() => runSelectionBatch(BATCH_COMMANDS.enabled, true)}>
              {t('sources.batch.enable')}
            </button>
            <button className="novel-btn sm" disabled={probing} onClick={() => runSelectionBatch(BATCH_COMMANDS.enabled, false)}>
              {t('sources.batch.disable')}
            </button>
            <button className="novel-btn sm" disabled={probing} onClick={() => runSelectionBatch(BATCH_COMMANDS.aiSearch, true)}>
              {t('sources.batch.aiEnable')}
            </button>
            <button className="novel-btn sm" disabled={probing} onClick={() => runSelectionBatch(BATCH_COMMANDS.aiSearch, false)}>
              {t('sources.batch.aiDisable')}
            </button>
            <button className="novel-btn sm primary" disabled={probing}
              onClick={() => void startSourceVerification(ui.selection, deps, t)}>
              {t('sources.batch.verify')}
            </button>
            <button className="novel-btn sm danger"
              onClick={(e) => setPending({ ids: [...ui.selection], title: plural(t, ui.selection.length, 'sources.delete.confirm.count.one', 'sources.delete.confirm.count.other'), opener: e.currentTarget })}>
              {t('sources.batch.delete')}
            </button>
            <span className="novel-grow" />
            <button className="novel-btn sm" onClick={clearSelection}>{t('sources.batch.clear')}</button>
          </div>
        )}

        {/* 删除二次确认（统一模态口径）：ids 点击时快照 → 模态点名后果 → 确认提交。 */}
        {pending === null ? null : (() => {
          const authCount = authCountOf(pending.ids)
          const cancel = (): void => { setPending(null) }
          return (
            <Dialog title={pending.title} opener={pending.opener} onClose={cancel}
              actions={<>
                <button className="novel-btn sm" onClick={cancel} disabled={delBusy}>{t('common.cancel')}</button>
                <button className="novel-btn sm danger solid" onClick={confirmDelete} disabled={delBusy}>{t('sources.delete.confirm')}</button>
              </>}>
              <div className="novel-modal-body">
                {authCount > 0 && (
                  <div className="novel-modal-warn">{plural(t, authCount, 'sources.delete.authWarning.one', 'sources.delete.authWarning.other')}</div>
                )}
                {t('sources.delete.irreversible')}
                {delBusy ? <div className="novel-modal-body">{t('sources.delete.deleting')}</div> : null}
              </div>
            </Dialog>
          )
        })()}

        {/* 表体三态：0 源 → 空态引导；取数失败 → 壳层红字；否则表格。 */}
        {loadError !== null ? null : showEmpty ? (
          <div className="novel-muted">{t('sources.empty')}</div>
        ) : (
          <>
            {/* 表格：列宽归 .novel-tr.src（样式层单点），窄表由 @container 收掉地址列 */}
            <div className="novel-table">
              <div className="novel-tr src head">
                <span>
                  {ui.editMode && (
                    <input type="checkbox" checked={allFilteredSelected} aria-label={t('sources.selectAll')}
                      onChange={() => { if (!allFilteredSelected) selectMany(filtered.map((s) => s.id)) }} />
                  )} {t('sources.col.name')}
                </span>
                <span>{t('sources.col.status')}</span>
                <span>
                  {t('sources.col.groups')}
                  {/* 「?」图例：分组列只显示图标，悬停解释每个图标对应哪个组 */}
                  {groupLegend === '' ? null : (
                    <span data-novel-group-legend className="novel-muted novel-group-legend" title={groupLegend}
                      aria-label={t('sources.legend')}>?</span>
                  )}
                </span>
                <span className="col-url">{t('sources.col.url')}</span>
                <span className="novel-cell-end">{t('sources.col.actions')}</span>
                <span className="novel-ai-head" title={t('sources.col.aiTitle')}>{t('sources.col.ai')}</span>
                <span className="novel-cell-right">{t('sources.col.enabled')}</span>
              </div>
              {shown.map((s) => (
                <SourceRow key={s.id} source={s} editMode={ui.editMode} selected={selection.has(s.id)}
                  probing={probing} onChanged={onChanged} onProbe={onProbe} onToggleEnabled={toggleEnabled}
                  onToggleAiSearch={toggleAiSearch}
                  onDelete={(src, opener) => setPending({ ids: [src.id], title: t('sources.delete.confirm.named', { name: src.name }), opener })}
                  deps={deps} />
              ))}
            </div>
            {filtered.length > shown.length && (
              <button className="novel-btn" onClick={() => setLimit(limit + PAGE_SIZE)}>
                {plural(t, filtered.length - shown.length, 'sources.loadMore.one', 'sources.loadMore.other')}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}

/** 「⋯」菜单的固定项数（验证/重验、试跑、登录态…、删除）——**加减菜单项改这里**。
 *  空间预算按它推导，测试钉「渲染出的 menuitem 数 = 此数」。 */
export const MENU_ITEM_COUNT = 4

/** 行：「⋯」菜单向下展开所需的最小可用高度 = 项数 × 单项行高（40px）+ 盒体余量 40px。
 *  判据是「下方够不够」而非「是不是最后一行」。 */
const MENU_SPACE_MIN = MENU_ITEM_COUNT * 40 + 40

/** 行：状态/分组/地址常驻；低配动作全部收进「⋯」溢出菜单；右侧常驻 AI 搜索勾选 + 启停开关。 */
function SourceRow({ source: s, editMode, selected, probing, onChanged, onProbe, onToggleEnabled, onToggleAiSearch, onDelete, deps = prodDeps }: {
  source: SourcePublic; editMode: boolean; selected: boolean; probing: boolean
  onChanged: () => void; onProbe: (id: string) => void
  onToggleEnabled: (s: SourcePublic, next: boolean) => Promise<boolean>
  onToggleAiSearch: (s: SourcePublic, next: boolean) => Promise<boolean>
  onDelete: (s: SourcePublic, opener: HTMLElement | null) => void
  deps?: SourceListDeps
}): ReactNode {
  const t = useCopy()
  const [authOpen, setAuthOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  /** 菜单开合方向：false = 向下（默认），true = 向上。 */
  const [menuUp, setMenuUp] = useState(false)
  // ⋯ 钮本体：作为删除模态的焦点归还对象——菜单项点完即卸载，触发件是这颗钮不是菜单项
  const menuRef = useRef<HTMLButtonElement | null>(null)
  /** 开菜单前定一次方向：判据用**真正会裁它的滚动口**而不是视口（宿主面板比视口小），
   *  量不到触发件时不翻转——默认方向就是原行为。 */
  const toggleMenu = (): void => {
    if (menuOpen) { setMenuOpen(false); return }
    const trigger = menuRef.current
    const port = findScrollport(trigger)
    const box = (port ?? document.documentElement).getBoundingClientRect()
    const rect = trigger?.getBoundingClientRect()
    if (rect !== undefined) {
      const below = box.bottom - rect.bottom
      const above = rect.top - box.top
      setMenuUp(below < MENU_SPACE_MIN && above > below)
    }
    setMenuOpen(true)
  }
  // 菜单开着时点页面任意处收起（行内菜单是浮层，不设「点两次才关」的谜题）
  useEffect(() => {
    if (!menuOpen) return
    const close = (): void => setMenuOpen(false)
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [menuOpen])
  // 启停与 AI 搜索两格共用同一份乐观格：点击即翻、失败回滚、服务端值落地即让位。
  const enabledCell = useOptimisticCell(s.enabled, (next) => onToggleEnabled(s, next))
  const aiCell = useOptimisticCell(s.aiSearch, (next) => onToggleAiSearch(s, next))
  const rowAnchor = rowAnchorOf(s.id)
  // 失败标记来自全局瞬态层（sticky 到条目被 dismiss）：行留红边，错误条目「定位 →」跳到这里
  const failed = useTransientFlag((e) => e.kind === 'error' && e.anchor === rowAnchor)
  const enabled = enabledCell.value
  const aiSearch = aiCell.value
  /** 已标记但源停用：勾保留，整格灰化；仍可预标记（启用后生效），不另加感叹号/圆点。 */
  const aiInactive = aiSearch && !enabled
  const saving = enabledCell.saving
  const savingAi = aiCell.saving
  /** 行内「验证/重验」：与待办箱、批量条同一条领域动作；提交后的编排归 `jobs.ts`，源列表随任务终态整体刷新。 */
  const verifyThis = (): void => {
    void startSourceVerification([s.id], deps, t)
  }
  return (
    <Fragment>
      <div data-novel-source-row={s.id}
        className={`novel-tr src${failed ? ' row-err' : ''}${enabled ? '' : ' off'}`}>
        <span className="novel-td name" title={s.name}>
          {editMode && <input type="checkbox" checked={selected} onChange={() => toggleSelect(s.id)} aria-label={t('sources.row.select', { name: s.name })} />}
          <strong>{s.name}</strong>
        </span>
        {/* 状态列只放验证状态：不要用类型徽标（bookSourceType）顶掉验证位，会造成误读 */}
        <span><StatusBadge status={s.status} /></span>
        {/* 分组格：只留图标——图标即组的视觉身份，hover 出全名；无图标组回退全名（不造图标） */}
        <span className="novel-cell-groups" title={s.groups.length > 0 ? s.groups.join(' / ') : undefined}>
          {s.groups.length > 0
            ? s.groups.map((g) => {
              const icon = groupIcon(g)
              return <span key={g} className="novel-grouppill" title={g}>{icon ?? g}</span>
            })
            : <span className="novel-muted">—</span>}
        </span>
        <span className="novel-td novel-muted col-url" title={s.statusDetail ?? s.baseUrl}>
          {s.baseUrl}
          {s.hasAuth && <span> · {s.authExpired ? t('sources.row.authExpired') : t('sources.row.loggedIn')}</span>}
        </span>
        <span className="novel-actions">
          {/* 低配动作全收进「⋯」：验证/重验、试跑、登录态、删除。菜单项数固定（MENU_ITEM_COUNT）。 */}
          <button className="novel-btn sm" aria-label={t('sources.row.more', { name: s.name })} aria-haspopup="menu" ref={menuRef}
            onClick={(e) => { e.stopPropagation(); toggleMenu() }}>⋯</button>
          {menuOpen && (
            <div className={menuUp ? 'novel-menu up' : 'novel-menu'} role="menu">
              <button role="menuitem" disabled={probing} onClick={() => { setMenuOpen(false); verifyThis() }}>
                {s.status === 'unverified' ? t('sources.row.verify') : t('sources.row.reverify')}
              </button>
              <button role="menuitem" onClick={() => { setMenuOpen(false); onProbe(s.id) }}>{t('sources.menu.trace')}</button>
              <button role="menuitem" onClick={() => { setMenuOpen(false); setAuthOpen(!authOpen) }}>{t('sources.menu.auth')}</button>
              <button role="menuitem" className="danger" onClick={() => { setMenuOpen(false); onDelete(s, menuRef.current) }}>
                {s.hasAuth ? t('sources.menu.deleteAuth') : t('sources.menu.delete')}
              </button>
            </div>
          )}
        </span>
        {/* AI 搜索勾选：与启停正交，只影响 AI 工具面的参与集。方形勾 + 火花与右侧圆形开关
            不同形、不同列；停用源仍可预标记（启用后才生效），勾保留但整格灰化、不加额外标记。 */}
        <span className="novel-ai-cell">
          <label className={`novel-ai-check${aiInactive ? ' inactive' : ''}`} title={savingAi
            ? t('sources.toggle.saving')
            : aiInactive ? t('sources.row.aiOnInactiveTitle')
              : aiSearch ? t('sources.row.aiOnTitle') : t('sources.row.aiOffTitle')}
            data-novel-ai-toggle data-busy={savingAi}>
            <span className="novel-ai-box">
              <input type="checkbox" className="novel-ai-input" checked={aiSearch} disabled={savingAi}
                onChange={(e) => aiCell.toggle(e.target.checked)}
                aria-label={aiInactive
                  ? `${t('sources.row.aiOnInactive')} ${s.name}`
                  : `${aiSearch ? t('sources.row.aiOn') : t('sources.row.aiOff')} ${s.name}`} />
              <svg className="novel-ai-mark" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path d="M12 2c.4 5.7 3.9 9.2 9.6 9.6-5.7.4-9.2 3.9-9.6 9.6-.4-5.7-3.9-9.2-9.6-9.6C8.1 11.2 11.6 7.7 12 2Z" />
              </svg>
            </span>
          </label>
        </span>
        {/* 启停开关：右对齐常驻（两态都渲染——启停是高频决策，不进编辑模式）。
            外观与位移归 .novel-switch（状态靠 aria-checked 选样式），行内只剩 data-busy。 */}
        <span className="novel-cell-end">
          <button className="novel-switch" data-novel-switch role="switch" aria-checked={enabled}
            aria-label={`${enabled ? t('sources.toggle.disable') : t('sources.toggle.enable')} ${s.name}`}
            title={saving ? t('sources.toggle.saving')
              : enabled ? t('sources.toggle.titleDisable') : t('sources.toggle.titleEnable')}
            data-busy={saving}
            onClick={() => enabledCell.toggle(!enabled)}>
            <i />
          </button>
        </span>
      </div>
      {authOpen && (
        <div className="novel-tr one">
          <SourceAuthPane source={s} anchor={rowAnchor} onDone={() => { setAuthOpen(false); onChanged() }} deps={deps} />
        </div>
      )}
    </Fragment>
  )
}

/** 兼容既有 import 路径（运行卡测试从这里取件）；组件本体住 ProbeRunCard.tsx。 */
export { ProbeRunCard } from './ProbeRunCard.js'
