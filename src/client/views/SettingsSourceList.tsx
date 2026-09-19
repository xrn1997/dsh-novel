import type { ReactNode } from 'react'
import { Fragment, useEffect, useRef, useState } from 'react'
import { parseCookieString } from '../importer.js'
import { paramRoutes, ROUTES } from '../../shared/wire.js'
import { prodDeps } from '../deps.js'
import type { SettingsDeps } from '../deps.js'
import { clearSelection, groupIcon, selectMany, setEditMode, setGroupFilter, setQuery, setStatusFilter, sourceListUi, toggleSelect, UNGROUPED } from '../source-list.js'
import type { StatusFilter } from '../source-list.js'
import { deriveSourceListView } from '../source-list-view.js'
import { useStore } from '../store.js'
import { useTransientFlag } from '../transient.js'
import { rowAnchorOf, toggleFeedback } from '../toggle-feedback.js'
import { jobPct, RunCard, StatusBadge } from './bits.js'
import type { JobState, SourcePublic } from './types.js'

/**
 * 源列表（书源管理 tab 的资产清单，2026 调度台 IA）：
 * 列表头（标题 + **状态带**（全库读数唯一住址，窄列退化见样式层）+ 文本/状态/分组过滤 +
 * 编辑切换 + ＋导入书源）+ 编辑态批量条
 * + 六列表格（名称/状态/分组/地址/操作/启停）+ 前端分页。
 *
 * 与旧版的差异（用户逐项裁定）：状态 chips → **状态下拉**（下拉只过滤不总览；读数 2026-09 起
 * 只住本组件的状态带，待办箱改成可忽略后不再兼职读数）；
 * 危险区专区 + 手输「删除」→ **统一模态二次确认**（点名后果 + Esc/遮罩取消零写口 + 焦点闭环
 * + 确认在途防重（delBusy，双击只发一次 POST）+ ids 点击时快照；失败即收模态、错误进全局条
 * ——与书架「失败留在框内重试」的一处刻意差异，理由记 docs/design/client.md 调度台 IA 节）；
 * 行内动作浏览态常驻：验证/重验按状态出现 + 试跑 +「⋯」溢出菜单收纳低频动作（登录态/删除）；
 * 启停唯一入口 = 最右开关（不渲染重复的「启用」文字钮）；「验证全部未验证」上移待办箱。
 *
 * 现场口径不变：query/statusFilter/groupFilter/selection/editMode 在模块级 sourceListUi
 * store（试跑下钻/重开视图不丢）；派生计算归 source-list-view.ts 纯函数；任务经 props 注入。
 */

const PAGE_SIZE = 100
/** 状态下拉：五维单选（'disabled' 维是 enabled 布尔，与 status 正交——口径归 source-list.ts）。
 *  不带计数（2026 改版）：读数归待办收件箱与列表头部 meta。 */
const STATUS_OPTIONS: Array<{ key: StatusFilter; label: string }> = [
  { key: 'all', label: '全部状态' },
  { key: 'verified', label: '可用' },
  { key: 'unverified', label: '未验证' },
  { key: 'broken', label: '坏源' },
  { key: 'disabled', label: '停用' },
]

export function SourceList({ sources, job, refresh, onChanged, onProbe, onImport, loadError = null, deps = prodDeps }: {
  sources: SourcePublic[] | null; job: JobState | null; refresh: () => void
  onChanged: () => void; onProbe: (id: string) => void
  /** 打开导入弹层（壳层持有弹层现场） */
  onImport: () => void
  /** 上层取数失败信息：有错时既不渲染「还没有书源」空态（不许把失败伪装成确定结论），
   *  也不渲染表格——失败由壳层那条红字统一说一遍，本组件不再抄第二份（2026-09） */
  loadError?: string | null
  /** 依赖束：缺省生产实现；测试注入假 adapter 驱动接线层 */
  deps?: SettingsDeps
}): ReactNode {
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
  // 任务在途 → 三个批量写口禁用：服务端是**单任务槽**（import-job.begin 运行中抛
  // JobRunningError，import/probe 互斥），在途再提交本就无处可去。删除所选不禁：
  // 删除不是任务（同步 sourcesBatchDelete），且 runBatchProbe 对任务中被删的源点名
  // 跳过（「源不存在（运行中被删除，已跳过）」）——服务端明确支持验证途中删源；
  // 模态确认即是二次确认（实现裁定，2026 审查后补记，见 client.md 调度台 IA 节）。
  const probing = job?.phase === 'running'
  /** 批量写口提交：成功后**重读哪一面由调用点指定**，两者不可互换——
   *  启停改的是源本身 → `onChanged`（重新 GET sources）；验证起的是后台任务 → `refresh`
   *  （重启任务轮询）。此前统一走 `refresh`，于是批量启停写完没人重取源列表：行开关、
   *  「已启用 M」计数、「停用」过滤全停在点之前的值，只有重开视图才跟上（2026-09 实机报）。 */
  const submit = <T,>(fn: () => Promise<T>, after: (res: T) => void): void => {
    void fn().then(after, (e) => deps.pushError(`操作失败：${e instanceof Error ? e.message : String(e)}`))
  }
  /** 批量启停：ids 点击时快照；成功只重取源列表，**留在编辑态且勾选保留**——这批源做完
   *  启停仍在列表里，勾选就是它们的现场，接着点「验证所选」或改主意再停用都不必重勾
   *  （2026-09 用户裁定）。清勾选只在「删除所选」成功后做：对象已不存在，勾选留着是幽灵 id。
   *  成功进反馈条：`transient.ts` 的「开关翻转即反馈，不进条」只对单行成立——642 行分页 +
   *  过滤下被改的那几行可能在屏幕外，批量必须有一条与视口无关的确认（同一文件头注已补记）。
   *  计数用服务端回包的 `updated`（未知 id 会被静默跳过，报"我勾了几个"会说谎）。 */
  const batchEnabled = (enabled: boolean): void => {
    const ids = [...ui.selection]
    submit(() => deps.apiSend<{ updated: number }>('POST', ROUTES.sourcesBatchEnabled.path, { ids, enabled }), (r) => {
      deps.pushOk(`${enabled ? '已启用' : '已停用'} ${r.updated} 个源`)
      onChanged()
    })
  }
  const confirmDelete = (): void => {
    if (pending === null || delBusy) return          // 在途防重：双击「确认删除」不许双 POST（审查 2026 发现的双写窗口）
    const ids = pending.ids                          // 点击时快照，不随列表变化重算
    setDelBusy(true)
    void deps.apiSend<{ removed: number }>('POST', ROUTES.sourcesBatchDelete.path, { ids }).then((r) => {
      setPending(null)
      setDelBusy(false)
      clearSelection()                               // 已删的 id 留在选择集里是幽灵勾选（动作条计数虚高、后续批量动作带死 id）
      deps.pushOk(`已删除 ${r.removed} 个源`)
      onChanged()
    }, (e) => {
      setPending(null)
      setDelBusy(false)
      deps.pushError(`批量删除失败：${e instanceof Error ? e.message : String(e)}`)
    })
  }
  /** 行内启停开关：单击即切——乐观更新在行内组件；**在途不进泳道**（进条就顶动
   *  布局 → 秒级操作闪烁，见 toggle-feedback.ts 头注），失败才进 error 泳道并挂行锚点。 */
  const toggleEnabled = (s: SourcePublic, next: boolean): Promise<boolean> => {
    const fb = toggleFeedback(rowAnchorOf(s.id), deps)
    fb.inFlight()
    return deps.apiSend('POST', paramRoutes.sourceEnabled(s.id), { enabled: next }).then(() => {
      fb.settle(true)
      onChanged()
      return true
    }, (e) => {
      fb.settle(false, `「${s.name}」启停失败：${e instanceof Error ? e.message : String(e)}（若路由 404，请重启 DSH 服务端）`)
      onChanged()                                        // 服务端为准的二次校准（行内已即刻回滚）
      return false
    })
  }
  return (
    <div data-novel-source-list className="novel-group">
      <div className="novel-list-head">
        <strong>源列表</strong>
        {/* 状态带（2026-09）：全库读数的**唯一**住址——待办卡改成可忽略后，读数不能跟着
            提示一起消失。0 也显示（「坏源 0」是结论，且数字位忽隐忽现这条带子会一直抖）；
            非 0 的 未验证/坏源 吃 warn/err 色；纯读数不可点（过滤归同一行的三个下拉，
            「带计数的状态 chips」是 2026 已否决的设计，不复活）。
            窄列退化为「共 N · 已启用 M」，规则在样式层（@container 量这条带子自身宽度）。
            **只在真有数据可报时在场**：加载中（sources 仍 null）不报 = 不拿未知冒充结论；
            0 源不报 = 空态那句话已经把同一件事说了。 */}
        {loaded && all.length > 0 && (
          <span className="novel-src-stats" data-novel-src-stats>
            <span>共 {stats.total} 个源</span>
            <span>已启用 {stats.enabled}</span>
            <span className="slim">已停用 {stats.disabled}</span>
            <span className={stats.unverified > 0 ? 'slim warn' : 'slim'}>未验证 {stats.unverified}</span>
            <span className={stats.broken > 0 ? 'slim err' : 'slim'}>坏源 {stats.broken}</span>
            {filtered.length === stats.total ? null : <span>当前过滤 {filtered.length}</span>}
          </span>
        )}
        <span className="novel-grow" />
        <input
          data-novel-source-filter
          className="novel-input novel-source-query"
          value={ui.query}
          onChange={(e) => { setQuery(e.target.value); setLimit(PAGE_SIZE) }}
          placeholder="过滤名称 / 地址"
          aria-label="过滤源名称或地址"
        />
        <select
          data-novel-status-filter
          className="novel-input"
          value={ui.statusFilter}
          aria-label="按状态过滤"
          onChange={(e) => { setStatusFilter(e.target.value as StatusFilter); setLimit(PAGE_SIZE) }}
        >
          {STATUS_OPTIONS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
        </select>
        {/* 分组下拉：分组名五花八门不配 chips——下拉单选收敛宽度，与状态/文本过滤叠加；
            选项集按**全库**聚合计数，不随状态/文本过滤缩水（可组合过滤，语义钉在 view-model） */}
        <select
          data-novel-group-filter
          className="novel-input novel-group-filter"
          value={ui.groupFilter}
          aria-label="按分组过滤"
          onChange={(e) => { setGroupFilter(e.target.value); setLimit(PAGE_SIZE) }}
        >
          <option value="">全部分组</option>
          {/* 「未分组」伪选项：无分组源不属于任何真实组——单独入口才定位得到（批量补分组）；
              哨兵值 UNGROUPED 防与真实组名撞名；计数 0 时不渲染（不添噪声选项） */}
          {ungroupedCount > 0 && <option value={UNGROUPED}>未分组（{ungroupedCount}）</option>}
          {[...groupCounts.entries()].sort(([a], [b]) => a.localeCompare(b, 'zh')).map(([g, n]) => (
            <option key={g} value={g}>{g}（{n}）</option>
          ))}
        </select>
        <button className={ui.editMode ? 'novel-btn sm on' : 'novel-btn sm'}
          data-novel-edit-toggle
          onClick={() => setEditMode(!ui.editMode)}>
          {ui.editMode ? '完成' : '编辑'}
        </button>
        <button className="novel-btn primary" data-novel-import-open onClick={onImport}>＋ 导入书源</button>
      </div>

      <div className="novel-list-body">
        {/* 选中动作条：操作与作用对象同框（编辑态才有意义） */}
        {ui.selection.length > 0 && (
          <div data-novel-selbar className="novel-selbar">
            <strong>已选 {ui.selection.length}</strong>
            <button className="novel-btn sm" disabled={probing} onClick={() => batchEnabled(true)}>
              启用所选
            </button>
            <button className="novel-btn sm" disabled={probing} onClick={() => batchEnabled(false)}>
              停用所选
            </button>
            <button className="novel-btn sm primary" disabled={probing}
              onClick={() => submit(() => deps.startBatchProbeJob(ui.selection), refresh)}>
              验证所选
            </button>
            <button className="novel-btn sm danger"
              onClick={(e) => setPending({ ids: [...ui.selection], title: `删除所选 ${ui.selection.length} 个源？`, opener: e.currentTarget })}>
              删除所选
            </button>
            <span className="novel-grow" />
            <button className="novel-btn sm" onClick={clearSelection}>清空选择</button>
          </div>
        )}

        {/* 删除二次确认（统一模态口径，2026 改版）：ids 点击时快照 → 模态点名后果 → 确认提交 */}
        {pending === null ? null : (
          <DeleteModal
            title={pending.title}
            opener={pending.opener}
            authCount={authCountOf(pending.ids)}
            busy={delBusy}
            onConfirm={confirmDelete}
            onCancel={() => setPending(null)}
          />
        )}

        {/* 表体三态（2026-09 实机 bug 后定）：0 源 → 空态引导，而它指的「＋ 导入书源」就在
            上面的表头里（这里曾整块 early-return，把表头连同那颗钮一起跳过 = 提示指向一个
            不存在的控件）；取数失败 → 这里不出声，壳层那条红字更全（同一个失败不抄两遍，
            也不许把失败伪装成「还没有书源」）；其余（含加载中）→ 表格。 */}
        {loadError !== null ? null : showEmpty ? (
          <div className="novel-muted">还没有书源——点右上「＋ 导入书源」，或在对话里让 AI 助手帮你导入</div>
        ) : (
          <>
            {/* 表格：列宽归 .novel-tr.src（样式层单点），窄表由 @container 收掉地址列 */}
            <div className="novel-table">
              <div className="novel-tr src head">
                <span>
                  {ui.editMode && (
                    <input type="checkbox" checked={allFilteredSelected} aria-label="全选当前过滤结果"
                      onChange={() => { if (!allFilteredSelected) selectMany(filtered.map((s) => s.id)) }} />
                  )} 名称
                </span>
                <span>状态</span>
                <span>
                  分组
                  {/* 「?」图例：分组列只显示图标，悬停解释每个图标对应哪个组 */}
                  {groupLegend === '' ? null : (
                    <span data-novel-group-legend className="novel-muted novel-group-legend" title={groupLegend}
                      aria-label="图标图例">?</span>
                  )}
                </span>
                <span className="col-url">地址</span>
                <span className="novel-cell-end">操作</span>
                <span className="novel-cell-right">启用</span>
              </div>
              {shown.map((s) => (
                <SourceRow key={s.id} source={s} editMode={ui.editMode} selected={selection.has(s.id)}
                  probing={probing} onChanged={onChanged} onProbe={onProbe} onToggleEnabled={toggleEnabled}
                  onDelete={(src, opener) => setPending({ ids: [src.id], title: `删除《${src.name}》？`, opener })}
                  deps={deps} />
              ))}
            </div>
            {filtered.length > shown.length && (
              <button className="novel-btn" onClick={() => setLimit(limit + PAGE_SIZE)}>
                显示更多（还有 {filtered.length - shown.length} 个）
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}

/** 删除二次确认模态（与书架删书同款口径）：点名后果 + 危险色确认钮 + 焦点闭环
 *  （入场焦点在取消、Tab 圈在框内、关闭后焦点还给触发件）+ Esc / 点遮罩取消 + 在途禁双击。
 *  危险性由文案与确认动作表达，不再设「危险区」专区（2026 改版，用户裁定）。
 *  焦点 effect **挂载作用域**（空依赖 + 回调走 ref）：父层每个 render 都是新闭包
 *  （useJobStatus 轮询 1s 一次 setJob 新对象 → SourceList 重渲染），闭包进依赖数组会
 *  每秒重跑 effect——焦点被劫回「取消」、opener 被重捕获成模态内按钮（关闭后焦点落 body）。
 *  审查（2026）发现的真缺陷；回归钉在 source-list-batch「重渲染不扰焦点」用例。
 *  opener 由调用方显式传入而非挂载时读 `document.activeElement`：⋯ 菜单里那个触发项
 *  在模态挂载前就随菜单卸载了，读到的是 body（焦点闭环对「⋯ → 删除」这条路曾是空的）。 */
function DeleteModal({ title, opener, authCount, busy, onConfirm, onCancel }: {
  title: string; opener: HTMLElement | null; authCount: number; busy: boolean; onConfirm: () => void; onCancel: () => void
}): ReactNode {
  const modalRef = useRef<HTMLDivElement | null>(null)
  const onCancelRef = useRef(onCancel)
  onCancelRef.current = onCancel                     // 每 render 刷新 ref：effect 内永远调到最新闭包
  useEffect(() => {
    const focusables = (): HTMLElement[] => modalRef.current === null ? []
      : [...modalRef.current.querySelectorAll<HTMLElement>('button:not([disabled])')]
    focusables()[0]?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { onCancelRef.current(); return }
      if (e.key !== 'Tab') return
      const f = focusables()
      if (f.length === 0) return
      const first = f[0]
      const last = f[f.length - 1]
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      if (opener !== null && opener.isConnected) opener.focus()
    }
  }, [])   // 挂载一次：焦点闭环的三个动作都在模态生命周期边界上发生（口径见上方注释）
  return (
    <div className="novel-modal-mask" onClick={(e) => { if (e.target === e.currentTarget) onCancel() }}>
      <div ref={modalRef} className="novel-modal" role="dialog" aria-modal="true" aria-labelledby="novel-src-del-title">
        <div className="novel-modal-title" id="novel-src-del-title">{title}</div>
        <div className="novel-modal-body">
          {authCount > 0 && (
            <div className="novel-modal-warn">其中 {authCount} 个带登录态，删除后 cookie 失效，需重新录入登录。</div>
          )}
          删除不可恢复。只是暂时不想用？行内启停开关停用即可（停用 ≠ 删除，随时可开回）。
          {busy ? <div className="novel-modal-body">删除中…</div> : null}
        </div>
        <div className="novel-modal-actions">
          <button className="novel-btn sm" onClick={onCancel} disabled={busy}>取消</button>
          <button className="novel-btn sm danger solid" onClick={onConfirm} disabled={busy}>确认删除</button>
        </div>
      </div>
    </div>
  )
}

/** 行：状态/分组/地址常驻；操作列按状态给当下要用的动作（验证/重验按状态出现 + 试跑；
 *  无「启用」文字钮——启停唯一入口 = 最右开关）+「⋯」溢出菜单（登录态/试跑 trace/删除
 *  ——低频动作收纳）；编辑态加复选框；启停开关右对齐常驻（高频决策不进编辑态）。 */
function SourceRow({ source: s, editMode, selected, probing, onChanged, onProbe, onToggleEnabled, onDelete, deps = prodDeps }: {
  source: SourcePublic; editMode: boolean; selected: boolean; probing: boolean
  onChanged: () => void; onProbe: (id: string) => void
  onToggleEnabled: (s: SourcePublic, next: boolean) => Promise<boolean>
  onDelete: (s: SourcePublic, opener: HTMLElement | null) => void
  deps?: SettingsDeps
}): ReactNode {
  const [authOpen, setAuthOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  // ⋯ 钮本体：作为删除模态的焦点归还对象——菜单项点完即卸载，触发件是这颗钮不是菜单项
  const menuRef = useRef<HTMLButtonElement | null>(null)
  // 菜单开着时点页面任意处收起（行内菜单是浮层，不设「点两次才关」的谜题）
  useEffect(() => {
    if (!menuOpen) return
    const close = (): void => setMenuOpen(false)
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [menuOpen])
  // 乐观态：点击即翻转本地展示——642 行列表的全量 reload 有一拍延迟，没有乐观反馈
  // 用户会以为「点不动」。失败（resolve false）即刻清零回滚，不等 reload。
  const [optimistic, setOptimistic] = useState<boolean | null>(null)
  // 服务端值落地即让位（s.enabled 变化 = reload 结果到达 → 清残余乐观值）：此前乐观值
  // 只在失败时清——另一入口（selbar 批量停用 / AI 工具）改了服务端后，残留的 optimistic
  // 会永久顶住服务端真相（审查 2026 发现，注释承诺过「reload 后以服务端为准」但没实现）。
  // 「ok = 服务端已应用」是本仓契约（宁炸不猜的对偶），故同值 reload 无需清、也不该清
  // （清了会在 reload 落地前闪回旧态）。
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
  /** 行内验证/重验（单源批量探针口与待办箱同一条路）：失败 pushError 显式呈现 */
  const verifyThis = (): void => {
    void deps.startBatchProbeJob([s.id]).then(() => onChanged(), (e: unknown) => {
      deps.pushError(`启动验证失败：${e instanceof Error ? e.message : String(e)}`)
    })
  }
  return (
    <Fragment>
      <div data-novel-source-row={s.id}
        className={`novel-tr src${failed ? ' row-err' : ''}${enabled ? '' : ' off'}`}>
        <span className="novel-td name" title={s.name}>
          {editMode && <input type="checkbox" checked={selected} onChange={() => toggleSelect(s.id)} aria-label={`选择 ${s.name}`} />}
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
          {s.hasAuth && <span> · {s.authExpired ? '登录已过期' : '已登录'}</span>}
        </span>
        <span className="novel-actions">
          {/* 操作列：浏览态常驻（试跑是排查主路径）；异常态多一个状态动作钮（验证/重验）。
              **不渲染「启用」文字钮**：启停唯一入口 = 最右开关——重复入口曾让操作列内容宽
              随状态漂移、右缘按钮组不对齐（用户实机反馈）；列轨道定宽右锚（styles.tsx
              `.novel-tr.src` 第5轨）。批量任务在途时禁验证类动作（防重复提交），
              试跑不受影响（独立单源请求）。
              验证钮**不看 enabled**（2026-09 裁定）：停用只是不参与聚合搜索，源有效与否照旧
              要验。曾在此挂过 `!enabled` 门，而同样的停用源仍在待办箱的批量重验 id 集里——
              等于「批量能验、单点不能验」，两个入口自相矛盾。 */}
          {s.status === 'unverified'
            ? <button className="novel-btn sm" disabled={probing} onClick={verifyThis}>验证</button>
            : s.status === 'broken'
              ? <button className="novel-btn sm" disabled={probing} onClick={verifyThis}>重验</button>
              : null}
          <button className="novel-btn sm" onClick={() => onProbe(s.id)}>试跑</button>
          <button className="novel-btn sm" aria-label={`更多动作 ${s.name}`} aria-haspopup="menu" ref={menuRef}
            onClick={(e) => { e.stopPropagation(); setMenuOpen(!menuOpen) }}>⋯</button>
          {menuOpen && (
            <div className="novel-menu" role="menu">
              <button role="menuitem" onClick={() => { setMenuOpen(false); setAuthOpen(!authOpen) }}>登录态…</button>
              <button role="menuitem" onClick={() => { setMenuOpen(false); onProbe(s.id) }}>试跑 trace</button>
              <button role="menuitem" className="danger" onClick={() => { setMenuOpen(false); onDelete(s, menuRef.current) }}>
                {s.hasAuth ? '删除（含登录态）' : '删除'}
              </button>
            </div>
          )}
        </span>
        {/* 启停开关：右对齐常驻（两态都渲染——启停是高频决策，不进编辑模式）。
            外观与位移归 .novel-switch（状态靠 aria-checked 选样式），行内只剩 data-busy。 */}
        <span className="novel-cell-end">
          <button className="novel-switch" data-novel-switch role="switch" aria-checked={enabled} aria-label={`${enabled ? '停用' : '启用'} ${s.name}`}
            title={saving ? '保存中…' : enabled ? '点击停用（不参与聚合搜索，可随时开回）' : '点击启用'}
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

/** 登录配置：cookie 录入（输入值不进 store，直接 POST）+ 去登录新 tab。
 *  反馈全走全局状态条——成功条自动退场。 */
function SourceAuthPane({ source, onDone, deps = prodDeps }: {
  source: SourcePublic; onDone: () => void; deps?: SettingsDeps
}): ReactNode {
  const [cookie, setCookie] = useState('')
  const save = (): void => {
    void deps.apiSend('POST', paramRoutes.sourceAuth(source.id), { cookies: parseCookieString(cookie) }).then(() => {
      setCookie('')                      // 输入值即刻清空
      deps.pushOk('已保存登录态')
      onDone()
    }, (e) => deps.pushError(`保存登录失败：${e instanceof Error ? e.message : String(e)}`, rowAnchorOf(source.id)))
  }
  return (
    <span className="novel-auth-pane" onClick={(e) => e.stopPropagation()}>
      {/* 书源是任意第三方站点：显式 noopener,noreferrer 关掉新页对 DSH GUI tab 的反向
          tabnabbing（Chromium ≥88 对 _blank 已隐式 noopener，显式写是零成本保险） */}
      <button className="novel-btn sm" onClick={() => window.open(source.baseUrl, '_blank', 'noopener,noreferrer')}>去登录</button>
      <input
        className="novel-input"
        value={cookie}
        onChange={(e) => setCookie(e.target.value)}
        placeholder="cookie：token=abc; sid=def"
        aria-label={`${source.name} 的 cookie`}
      />
      <button className="novel-btn sm" onClick={save}>保存登录</button>
    </span>
  )
}

/** 批量验证运行卡：kind 分家的「验证」侧——渲染在壳层任务槽（待办箱下方）。
 * 外壳归 bits.RunCard（与 ImportRunCard 曾是近逐字同构的双胞胎），此处只供文案与 counts。 */
export function ProbeRunCard({ job }: { job: JobState }): ReactNode {
  const pct = jobPct(job)
  return (
    <RunCard
      label="验证中…"
      meta={<>{job.done}/{job.total}（{pct}%）· 并发 5 路</>}
      pct={pct}
      counts={<>
        <span className="novel-ok">已验证 {job.counts.ok}</span>
        <span className="novel-muted">· 未通过 {job.counts.failed}</span>
      </>}
    />
  )
}
