import type { ReactNode } from 'react'
import { Fragment, useEffect, useRef, useState } from 'react'
import { parseCookieString } from '../../shared/cookies.js'
import { bodies, paramRoutes, ROUTES } from '../../shared/wire.js'
import { describeError } from '../api.js'
import { plural, useCopy, type CopyKey } from '../copy/index.js'
import { prodDeps } from '../deps.js'
import type { RowActionDeps, SettingsDeps } from '../deps.js'
import { jobKindLabel, startSourceVerification } from '../jobs.js'
import { clearSelection, groupIcon, selectMany, setEditMode, setGroupFilter, setQuery, setStatusFilter, sourceListUi, toggleSelect, UNGROUPED } from '../source-list.js'
import type { StatusFilter } from '../source-list.js'
import { deriveSourceListView } from '../source-list-view.js'
import { findScrollport } from '../scrollport.js'
import { useStore } from '../store.js'
import { useTransientFlag } from '../transient.js'
import { jobPct, RunCard, StatusBadge } from './bits.js'
import { Dialog } from './dialog.js'
import type { JobState, SourcePublic } from './types.js'

/**
 * 源列表（书源管理 tab 的资产清单，2026 调度台 IA）：
 * 列表头（标题 + **状态带**（全库读数唯一住址，窄列退化见样式层）+ 文本/状态/分组过滤 +
 * 编辑切换 + ＋导入书源）+ 编辑态批量条 + 六列表格 + 前端分页。
 *
 * 与旧版的差异（用户逐项裁定）：状态下拉只过滤不总览（读数归状态带）；删除走**统一模态二次确认**
 * （点名后果 + Esc/遮罩零写口 + 焦点闭环 + 在途防重 + ids 点击时快照；失败即收模态、错误进全局
 * 条——与书架「失败留在框内」是刻意差异：删源失败必须停在模态里等人处置，不能像搜索失败那样
 * 留在结果框里被忽略）；行内动作浏览态常驻
 * （验证/重验按状态 + 试跑 +「⋯」菜单），启停唯一入口 = 最右开关，「验证全部未验证」上移待办箱。
 *
 * 现场（query/过滤/勾选/编辑态）在模块级 sourceListUi store（试跑下钻/重开不丢）；派生计算归
 * source-list-view.ts 纯函数；任务经 props 注入。
 */

const PAGE_SIZE = 100

/** 单源行的错误锚点：全局条「定位 →」与行内红边共用同一个选择器，且与行渲染的
 *  `data-novel-source-row` 同源。启停失败与鉴权三条失败路径都挂它。 */
export function rowAnchorOf(id: string): string {
  return `[data-novel-source-row="${id}"]`
}

/** 源列表壳层与行的依赖面：行内写口三件套 + 提交一轮验证（验证的编排归 `jobs.ts` 的
 *  `startSourceVerification`，这里只多要那一格提交口，不整束照抄 `SettingsDeps`——任务读面
 *  由常驻状态层持有，本层连 `fetchJobStatus` 都不该声明）。壳层收到的整束结构上满足这一份。 */
type SourceListDeps = RowActionDeps & Pick<SettingsDeps, 'startBatchProbeJob'>
/** 状态下拉：五维单选（'disabled' 维是 enabled 布尔，与 status 正交——口径归 source-list.ts）。
 *  不带计数：全库读数唯一住址是列表头**状态带**（`source-list-view.ts` 的 `stats`），下拉只过滤。 */
const STATUS_OPTIONS: Array<{ key: StatusFilter; labelKey: CopyKey }> = [
  { key: 'all', labelKey: 'sources.filter.all' },
  { key: 'verified', labelKey: 'sources.filter.available' },
  { key: 'unverified', labelKey: 'sources.filter.unverified' },
  { key: 'broken', labelKey: 'sources.filter.broken' },
  { key: 'disabled', labelKey: 'sources.filter.disabled' },
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
  // opener = 触发件（批量条钮 / 该行 ⋯ 钮）：模态关闭后焦点还给它。不能靠
  // document.activeElement——⋯ 菜单项在模态挂载前就随菜单卸载了，activeElement 已是 body
  const [pending, setPending] = useState<{ ids: string[]; title: string; opener: HTMLElement | null } | null>(null)
  const [delBusy, setDelBusy] = useState(false)     // 删除提交在途：确认钮禁用 + 重入口拒绝（与书架 delBusy 同款）
  // 0 源与取数失败**不换掉列表头**（2026-09 实机 bug：这里曾整块 early-return 一句
  // 「点右上『＋ 导入书源』」，而那颗钮就在被跳过的表头里——提示指向一个不存在的控件）。
  // 表头是工具条（导入是与源数无关的顶层动作），只有表体换内容。
  const all = sources ?? []
  const loaded = sources !== null
  /** 空态成立的唯一条件：**确实取到了** 0 个源。加载中（sources 仍 null）与取数失败都不是空
   *  ——前者没有真相，后者会把失败伪装成「还没有书源」这条确定结论（宁炸不猜）。 */
  const showEmpty = loaded && all.length === 0 && loadError === null
  // 派生计算归纯函数 module（过滤管线/分组选项集/选中态/登录态计数）——语义在那边单测钉死
  const vm = deriveSourceListView(all, ui, limit)
  const { filtered, shown, selected: selection } = vm
  const { groupCounts, groupLegend, authCountOf, allFilteredSelected, ungroupedCount, stats } = vm
  // 任务在途 → 三个批量写口禁用：服务端是**单任务槽**，在途再提交无处可去。删除所选不禁：
  // 删除不是任务，且服务端明确支持验证途中删源，模态确认即是二次确认。
  const probing = job?.phase === 'running'
  /** 批量写口提交：成功后**重读哪一面由调用点指定**，两者不可互换——
   *  启停改的是源本身 → `onChanged`（重新 GET sources）；验证起的是后台任务 → **不走本
   *  helper**：归 `jobs.ts` 的 `startSourceVerification`（提交 → 催任务读面 / 失败一处反馈）。
   *  启停若走错出口，写完没人重取源列表，行开关与计数全停在点之前的值（2026-09 实机报）。 */
  const submit = <T,>(fn: () => Promise<T>, after: (res: T) => void): void => {
    void fn().then(after, (e) => deps.pushError(t('sources.batch.failed', { detail: describeError(e, t) })))
  }
  /** 批量启停：ids 点击时快照；成功只重取源列表，**留在编辑态且勾选保留**（2026-09 用户裁定：
   *  这批源还在列表里，勾选是它们的现场）。清勾选只在「删除所选」成功后做——对象已不存在。
   *  成功进反馈条：分页 + 过滤下被改的行可能在屏幕外，批量必须有一条与视口无关的确认。
   *  计数用服务端回包的 `updated`（未知 id 会被静默跳过，报「我勾了几个」会说谎）。 */
  const batchEnabled = (enabled: boolean): void => {
    const ids = [...ui.selection]
    submit(() => deps.apiSend<{ updated: number }>('POST', ROUTES.sourcesBatchEnabled.path, bodies.batchEnabled(ids, enabled)), (r) => {
      deps.pushOk(enabled
        ? plural(t, r.updated, 'sources.batch.enabled.one', 'sources.batch.enabled.other')
        : plural(t, r.updated, 'sources.batch.disabled.one', 'sources.batch.disabled.other'))
      onChanged()
    })
  }
  const confirmDelete = (): void => {
    if (pending === null || delBusy) return          // 在途防重：双击「确认删除」不许双 POST（修过的真双写窗口）
    const ids = pending.ids                          // 点击时快照，不随列表变化重算
    setDelBusy(true)
    void deps.apiSend<{ removed: number }>('POST', ROUTES.sourcesBatchDelete.path, bodies.ids(ids)).then((r) => {
      setPending(null)
      setDelBusy(false)
      clearSelection()                               // 已删的 id 留在选择集里是幽灵勾选（动作条计数虚高、后续批量动作带死 id）
      deps.pushOk(plural(t, r.removed, 'sources.delete.removed.one', 'sources.delete.removed.other'))
      onChanged()
    }, (e) => {
      setPending(null)
      setDelBusy(false)
      deps.pushError(t('sources.delete.failed', { detail: describeError(e, t) }))
    })
  }
  /** 行内启停开关：单击即切——乐观更新在行内组件。
   *
   *  **秒级操作不进瞬态泳道**（闪烁回归锁）：单源启停往返 13~20ms ≈ 1 帧，而状态条**原先**
   *  是流内元素、挂上就把设置区顶下去再弹回（真机逐帧实测 +35px layout-shift；现状态条已改为浮层，
   *  这条具体读数不再复现，口径保留：秒级操作的反馈不占布局位置）。在途只留行内
   *  `savingN` 装饰（开关降透明 + wait + title「保存中…」）；成功静默（开关翻转本身即反馈），
   *  只有失败才进 error 泳道并挂行锚点（全局条「定位 →」+ 行内红边）。 */
  const toggleEnabled = (s: SourcePublic, next: boolean): Promise<boolean> => {
    return deps.apiSend('POST', paramRoutes.sourceEnabled(s.id), bodies.enabled(next)).then(() => {
      onChanged()
      return true
    }, (e) => {
      deps.pushError(
        t('sources.toggle.failedNamed', { name: s.name, detail: describeError(e, t) }), rowAnchorOf(s.id))
      onChanged()                                        // 服务端为准的二次校准（行内已即刻回滚）
      return false
    })
  }
  return (
    <div data-novel-source-list className="novel-group">
      <div className="novel-list-head">
        <strong>{t('sources.list.title')}</strong>
        {/* 状态带：全库读数的**唯一**住址（待办卡可忽略，读数不能跟着提示消失）。0 也显示
            （「坏源 0」是结论）；纯读数不可点——过滤归同一行的下拉与文本框，「带计数的状态
            chips」是 2026 已否决的设计。窄列退化规则在样式层（@container）。
            **只在真有数据可报时在场**：加载中不报 = 不拿未知冒充结论；0 源不报 = 空态已说同一件事。 */}
        {loaded && all.length > 0 && (
          <span className="novel-src-stats" data-novel-src-stats>
            <span>{plural(t, stats.total, 'sources.stats.total.one', 'sources.stats.total.other')}</span>
            <span>{t('sources.stats.enabled', { n: stats.enabled })}</span>
            <span className="slim">{t('sources.stats.disabled', { n: stats.disabled })}</span>
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
          onChange={(e) => { setQuery(e.target.value); setLimit(PAGE_SIZE) }}
          placeholder={t('sources.filter.placeholder')}
          aria-label={t('sources.filter.label')}
        />
        <select
          data-novel-status-filter
          className="novel-input"
          value={ui.statusFilter}
          aria-label={t('sources.filter.statusLabel')}
          onChange={(e) => { setStatusFilter(e.target.value as StatusFilter); setLimit(PAGE_SIZE) }}
        >
          {STATUS_OPTIONS.map((o) => <option key={o.key} value={o.key}>{t(o.labelKey)}</option>)}
        </select>
        {/* 分组下拉：分组名五花八门不配 chips——下拉单选收敛宽度，与状态/文本过滤叠加；
            选项集按**全库**聚合计数，不随状态/文本过滤缩水（可组合过滤，语义钉在 view-model） */}
        <select
          data-novel-group-filter
          className="novel-input novel-group-filter"
          value={ui.groupFilter}
          aria-label={t('sources.filter.groupLabel')}
          onChange={(e) => { setGroupFilter(e.target.value); setLimit(PAGE_SIZE) }}
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
            <button className="novel-btn sm" disabled={probing} onClick={() => batchEnabled(true)}>
              {t('sources.batch.enable')}
            </button>
            <button className="novel-btn sm" disabled={probing} onClick={() => batchEnabled(false)}>
              {t('sources.batch.disable')}
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

        {/* 删除二次确认（统一模态口径，2026 改版）：ids 点击时快照 → 模态点名后果 → 确认提交。
            危险性由文案与确认动作表达，不设「危险区」专区（用户裁定）。
            焦点闭环与 Esc 归 `views/dialog.tsx`；opener 仍由这里显式传——⋯ 菜单项在模态挂载前已随
            菜单卸载，那一刻读 `document.activeElement` 只会读到 body。 */}
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

        {/* 表体三态：0 源 → 空态引导（它指的「＋ 导入书源」就在上面的表头里——曾整块 early-return
            把表头一起跳过 = 提示指向不存在的控件）；取数失败 → 这里不出声，壳层红字更全（同一
            失败不抄两遍，也不许伪装成「还没有书源」）；其余（含加载中）→ 表格。 */}
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
                <span className="novel-cell-right">{t('sources.col.enabled')}</span>
              </div>
              {shown.map((s) => (
                <SourceRow key={s.id} source={s} editMode={ui.editMode} selected={selection.has(s.id)}
                  probing={probing} onChanged={onChanged} onProbe={onProbe} onToggleEnabled={toggleEnabled}
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

/** 「⋯」菜单的固定项数（登录态… / 试跑 trace / 删除）——**加减菜单项改这里**。
 *  空间预算按它推导（见下），测试钉「渲染出的 menuitem 数 = 此数」（source-list-batch 的项数守卫）：
 *  加一项而没改这个数会当场红，不会让翻转预算静默过期、末行菜单再被滚动口裁掉。 */
export const MENU_ITEM_COUNT = 3

/** 行：「⋯」菜单向下展开所需的最小可用高度 = 项数 × 单项行高（真 Edge 实测 3 项 ≈ 120px ⇒
 *  单项 ≈ 40px）+ 盒体余量 40px。判据是「下方够不够」而非「是不是最后一行」——够不够只跟
 *  剩余空间有关，行在不在末尾只是最常见的那种不够。 */
const MENU_SPACE_MIN = MENU_ITEM_COUNT * 40 + 40

/** 行：状态/分组/地址常驻；操作列按状态给当下要用的动作（验证/重验按状态出现 + 试跑；
 *  无「启用」文字钮——启停唯一入口 = 最右开关）+「⋯」溢出菜单（登录态/试跑 trace/删除
 *  ——低频动作收纳）；编辑态加复选框；启停开关右对齐常驻（高频决策不进编辑态）。 */
function SourceRow({ source: s, editMode, selected, probing, onChanged, onProbe, onToggleEnabled, onDelete, deps = prodDeps }: {
  source: SourcePublic; editMode: boolean; selected: boolean; probing: boolean
  onChanged: () => void; onProbe: (id: string) => void
  onToggleEnabled: (s: SourcePublic, next: boolean) => Promise<boolean>
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
  /**
   * 开菜单前定一次方向：长列表滚到滚动口底时，末行菜单向下展开会越过滚动口的可见底——是它
   * 伸到了容器外面。判据用「真正会裁它的盒子」= 滚动口而不是视口（宿主面板比视口小，拿视口
   * 判会把「其实放不下」算成放得下）。量不到触发件时不翻转——默认方向就是原行为
   * （病史：这一档原先拿视口判，用户实机两次才发现菜单伸出滚动口外）。
   */
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
  // 乐观态：点击即翻转本地展示——642 行列表的全量 reload 有一拍延迟，没有乐观反馈用户会
  // 以为「点不动」。失败即刻清零回滚，不等 reload。
  const [optimistic, setOptimistic] = useState<boolean | null>(null)
  // 服务端值落地即让位（s.enabled 变化 = reload 结果到达 → 清残余乐观值）：只在失败时清的话，
  // 另一入口（批量停用 / AI 工具）改了服务端后残留值会永久顶住真相（修过的真缺陷）。
  // 「ok = 服务端已应用」是本仓契约，故同值 reload 无需清（清了会在落地前闪回旧态）。
  useEffect(() => { setOptimistic(null) }, [s.enabled])
  const [savingN, setSavingN] = useState(0)             // 在途请求数：「保存中」装饰的精确生命周期
  const rowAnchor = rowAnchorOf(s.id)
  // 失败标记来自全局瞬态层（sticky 到条目被 dismiss）：行留红边，错误条目「定位 →」跳到这里
  const failed = useTransientFlag((e) => e.kind === 'error' && e.anchor === rowAnchor)
  const enabled = optimistic ?? s.enabled
  const saving = savingN > 0
  const toggle = (next: boolean): void => {
    setOptimistic(next)
    setSavingN((n) => n + 1)
    void onToggleEnabled(s, next).then((ok) => {
      setSavingN((n) => n - 1)
      if (!ok) setOptimistic(null)                    // 失败即刻回滚（历史 bug：乐观态无人清零 → 开关永久停错态）
    })
  }
  /** 行内「验证/重验」：与待办箱、批量条同一条领域动作——本入口只表达「验证这一源」，提交后的
   *  编排归 `jobs.ts` 的 `startSourceVerification`；源列表随任务终态整体刷新，不就地 `onChanged`。 */
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
        {/* 状态列只放验证状态：曾用类型徽标（bookSourceType）顶掉验证位，实测造成误读——已撤 */}
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
          {/* 操作列：浏览态常驻（试跑是排查主路径）；异常态多一个状态动作钮（验证/重验）。
              **不渲染「启用」文字钮**：启停唯一入口 = 最右开关——重复入口曾让列宽随状态漂移、
              右缘按钮组不对齐（用户实机反馈）。列轨道定宽右锚在 styles.tsx `.novel-tr.src`。
              批量任务在途时禁验证类动作（防重复提交），试跑不受影响（独立请求）。
              验证钮**不看 enabled**（2026-09 裁定）：停用 ≠ 免验——曾挂过的 `!enabled` 门造成
              「批量能验、单点不能验」，与待办箱入口自相矛盾。 */}
          {s.status === 'unverified'
            ? <button className="novel-btn sm" disabled={probing} onClick={verifyThis}>{t('sources.row.verify')}</button>
            : s.status === 'broken'
              ? <button className="novel-btn sm" disabled={probing} onClick={verifyThis}>{t('sources.row.reverify')}</button>
              : null}
          <button className="novel-btn sm" onClick={() => onProbe(s.id)}>{t('sources.row.probe')}</button>
          <button className="novel-btn sm" aria-label={t('sources.row.more', { name: s.name })} aria-haspopup="menu" ref={menuRef}
            onClick={(e) => { e.stopPropagation(); toggleMenu() }}>⋯</button>
          {menuOpen && (
            <div className={menuUp ? 'novel-menu up' : 'novel-menu'} role="menu">
              <button role="menuitem" onClick={() => { setMenuOpen(false); setAuthOpen(!authOpen) }}>{t('sources.menu.auth')}</button>
              <button role="menuitem" onClick={() => { setMenuOpen(false); onProbe(s.id) }}>{t('sources.menu.trace')}</button>
              <button role="menuitem" className="danger" onClick={() => { setMenuOpen(false); onDelete(s, menuRef.current) }}>
                {s.hasAuth ? t('sources.menu.deleteAuth') : t('sources.menu.delete')}
              </button>
            </div>
          )}
        </span>
        {/* 启停开关：右对齐常驻（两态都渲染——启停是高频决策，不进编辑模式）。
            外观与位移归 .novel-switch（状态靠 aria-checked 选样式），行内只剩 data-busy。 */}
        <span className="novel-cell-end">
          <button className="novel-switch" data-novel-switch role="switch" aria-checked={enabled}
            aria-label={`${enabled ? t('sources.toggle.disable') : t('sources.toggle.enable')} ${s.name}`}
            title={saving ? t('sources.toggle.saving')
              : enabled ? t('sources.toggle.titleDisable') : t('sources.toggle.titleEnable')}
            data-busy={saving}
            onClick={() => toggle(!enabled)}>
            <i />
          </button>
        </span>
      </div>
      {authOpen && (
        <div className="novel-tr one">
          <SourceAuthPane source={s} onDone={() => { setAuthOpen(false); onChanged() }} deps={deps} />
        </div>
      )}
    </Fragment>
  )
}

/** 登录表单的初值：只有 text/password 行进 loginInfo；button 行不是键。 */
function initLoginInfo(rows: NonNullable<SourcePublic['loginUi']>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of rows) if (f.type !== 'button') out[f.name] = f.default ?? ''
  return out
}

/** 登录配置：cookie 录入（输入值不进 store，直接 POST）+ 去登录。
 *  反馈全走全局状态条——成功条自动退场。 */
function SourceAuthPane({ source, onDone, deps = prodDeps }: {
  source: SourcePublic; onDone: () => void; deps?: RowActionDeps
}): ReactNode {
  const t = useCopy()
  const [cookie, setCookie] = useState('')
  const [loginInfo, setLoginInfo] = useState<Record<string, string>>(() =>
    initLoginInfo(source.loginUi ?? []))
  /** 「去登录」按源是否有登录脚本分岔（`hasLoginUrl` 是服务端投影的事实，不在客户端猜分支）：
   *  ① 声明了 loginUrl：问服务端要计划——URL 形态开那个 URL，JS 形态服务端沙箱跑完存登录态，
   *     这里只报成功并刷新；② 未声明：站点的登录页就是它自己，直接开 baseUrl（本按钮原行为）。 */
  const goLogin = (): void => {
    if (!source.hasLoginUrl) {
      window.open(source.baseUrl, '_blank', 'noopener,noreferrer')
      return
    }
    void deps.apiSend<{ mode?: string; loginUrl?: string }>('POST', paramRoutes.sourceAuth(source.id), bodies.runLogin()).then((r) => {
      if (r.mode === 'manual' && typeof r.loginUrl === 'string' && r.loginUrl !== '') {
        window.open(r.loginUrl, '_blank', 'noopener,noreferrer')
        return
      }
      deps.pushOk(t('sources.auth.scriptDone'))
      onDone()
    }, (e) => deps.pushError(t('sources.auth.goFailed', { detail: describeError(e, t) }), rowAnchorOf(source.id)))
  }
  const save = (): void => {
    if (source.loginUi !== undefined) {
      void (async () => {
        await deps.apiSend('POST', paramRoutes.sourceAuth(source.id), bodies.authLoginInfo(loginInfo))
        if (source.hasLoginUrl) await deps.apiSend('POST', paramRoutes.sourceAuth(source.id), bodies.runLogin())
        deps.pushOk(t('sources.auth.saved'))
        onDone()
      })().catch((e) => deps.pushError(t('sources.auth.saveFailed', { detail: describeError(e, t) }), rowAnchorOf(source.id)))
      return
    }
    void deps.apiSend('POST', paramRoutes.sourceAuth(source.id), bodies.authCookies(parseCookieString(cookie))).then(() => {
      setCookie('')                      // 输入值即刻清空
      deps.pushOk(t('sources.auth.saved'))
      onDone()
    }, (e) => deps.pushError(t('sources.auth.saveFailed', { detail: describeError(e, t) }), rowAnchorOf(source.id)))
  }
  /** RowUi button：先落当前 text/password 的 loginInfo，再按行名跑服务端动作。
   *  外链只开新页；脚本动作成功后刷新源列表（动作可能改了登录态）。 */
  const runRowAction = (name: string): void => {
    void (async () => {
      if ((source.loginUi ?? []).some((f) => f.type !== 'button')) {
        await deps.apiSend('POST', paramRoutes.sourceAuth(source.id), bodies.authLoginInfo(loginInfo))
      }
      const r = await deps.apiSend<{ mode?: string; url?: string }>(
        'POST', paramRoutes.sourceAuth(source.id), bodies.loginAction(name),
      )
      if (r.mode === 'external' && typeof r.url === 'string') {
        window.open(r.url, '_blank', 'noopener,noreferrer')
        return
      }
      deps.pushOk(t('sources.auth.actionDone'))
      onDone()
    })().catch((e) => deps.pushError(t('sources.auth.actionFailed', { detail: describeError(e, t) }), rowAnchorOf(source.id)))
  }
  return (
    <span className="novel-auth-pane" onClick={(e) => e.stopPropagation()}>
      {/* 书源是任意第三方站点：显式 noopener,noreferrer 关掉新页对 DSH GUI tab 的反向
          tabnabbing（Chromium ≥88 对 _blank 已隐式 noopener，显式写是零成本保险） */}
      <button className="novel-btn sm" onClick={goLogin}>{t('sources.auth.go')}</button>
      {source.loginUi === undefined
        ? <input
            className="novel-input"
            value={cookie}
            onChange={(e) => setCookie(e.target.value)}
            placeholder={t('sources.auth.cookiePlaceholder')}
            aria-label={t('sources.auth.cookieLabel', { name: source.name })}
          />
        : source.loginUi.map((f, i) => f.type === 'button'
          ? (
              <button key={`${f.type}:${i}:${f.name}`} className="novel-btn sm" onClick={() => { runRowAction(f.name) }}>
                {f.name}
              </button>
            )
          : (
              <input
                key={`${f.type}:${i}:${f.name}`}
                className="novel-input"
                type={f.type}
                value={loginInfo[f.name] ?? ''}
                onChange={(e) => setLoginInfo((prev) => ({ ...prev, [f.name]: e.target.value }))}
                placeholder={f.name}
                aria-label={f.name}
              />
            ))}
      {/* 纯按钮源没有可保存的 loginInfo：不摆「保存登录」，否则会落一张空 auth 把 hasAuth 点亮 */}
      {(source.loginUi === undefined || source.loginUi.some((f) => f.type !== 'button')) && (
        <button className="novel-btn sm" onClick={save}>{t('sources.auth.save')}</button>
      )}
    </span>
  )
}

/** 批量验证运行卡：kind 分家的「验证」侧——渲染在壳层任务槽（待办箱下方）。
 * 外壳归 bits.RunCard（与 ImportRunCard 曾是近逐字同构的双胞胎），此处只供文案与 counts。 */
export function ProbeRunCard({ job }: { job: JobState }): ReactNode {
  const t = useCopy()
  const pct = jobPct(job)
  return (
    <RunCard
      kind="probe"
      label={t('job.progress', { kind: jobKindLabel(job.kind, t) })}
      meta={<>{t('job.counts', { done: job.done, total: job.total, pct })}{t('sources.probe.concurrency')}</>}
      pct={pct}
      counts={<>
        <span className="novel-ok">{t('sources.probe.ok', { n: job.counts.ok })}</span>
        <span className="novel-muted">{t('sources.probe.failed', { n: job.counts.failed })}</span>
      </>}
    />
  )
}
