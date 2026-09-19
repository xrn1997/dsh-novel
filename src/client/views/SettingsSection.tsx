import type { ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { paramRoutes, ROUTES } from '../../shared/wire.js'
import { prodDeps } from '../deps.js'
import type { SettingsDeps } from '../deps.js'
import { refreshJob, takeJobOpen, useJobOpenRequest, useJobSurface } from '../jobs.js'
import { inboxCards, inboxIds, sourceInbox, visibleInboxCards } from '../source-inbox.js'
import type { InboxKind } from '../source-inbox.js'
import { inboxUi, muteInboxCard, pruneInboxMuted, unmuteAllInboxCards } from '../source-inbox-ui.js'
import { useStore } from '../store.js'
import { NovelStyles } from '../styles.js'
import { ImportPane } from './SettingsImportPane.js'
import { ProbeRunCard, SourceList } from './SettingsSourceList.js'
import { ErrorBanner, StatusBadge } from './bits.js'
import type { JobState, ProbeResult, SourcePublic } from './types.js'

/**
 * 书源管理 tab 壳（2026 调度台 IA，用户拍板）：**待办收件箱 + 任务槽 + 源列表 + 导入弹层**。
 * 演进史：曾是宿主设置页的手风琴两区（导入区/源列表区竖栏叠放）→ 2026 搬入小说视图顶部
 * tab（settings.section 注册撤除，单一归属）→ 打碎重组为调度台：按「用户带什么任务来」组织——
 * ① 待办（反常置顶：坏源/未验证成任务卡，处置动作贴着成员名单；2026-09 起卡可忽略、
 *    读数迁列表头状态带，口径见该组件自己的注释）② 源列表（朴素资产表）
 * ③ 导入（低频任务收纳为弹层，完成事项回流待办，闭环）。
 * 手风琴（sections.ts）与危险区专区随改版退役；删除统一模态二次确认（与书架删书同款口径）。
 *
 * 组件职责边界（未变的口径）：本文件只做接线与现场——sources 每次挂载经 api 拉取、
 * 组件内 useState（业务数据不进 store）；任务轮询单实例在此（useJobStatus，job 经 props
 * 下发给子组件，避免双轮询）；deps 整壳注入（SettingsDeps）向下透传。派生逻辑归纯函数
 * module：待办集合 → source-inbox.ts；列表派生 → source-list-view.ts。
 * 口径详见 `docs/design/client.md`「书源管理 tab 的 IA」。
 */
export function SettingsSection({ deps = prodDeps, withStyles = true }: {
  /** 注入的 deps seam（缺省走生产实现） */
  deps?: SettingsDeps
  /** 样式层是否自带：宿主（`NovelView`）已在其根上注入时传 false，避免同一棵树里两份 NOVEL_CSS */
  withStyles?: boolean
}): ReactNode {
  type Sub = { name: 'list' } | { name: 'probe'; sourceId: string }
  const [sub, setSub] = useState<Sub>({ name: 'list' })
  const [sources, setSources] = useState<SourcePublic[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  // 失败不许伪装成空列表/空架（宁炸不猜的呈现半场）：网络失败 → 显式错误，
  // 待办收件箱随之不渲染（不拿未知当「✓ 全部源状态良好」）
  const reload = (): void => {
    void deps.apiGet<SourcePublic[]>(ROUTES.sources.path).then((list) => {
      setSources(list)
      setLoadError(null)
    }, (e) => {
      setSources([])
      setLoadError(e instanceof Error ? e.message : String(e))
    })
  }
  useEffect(reload, [])
  // 忽略记录随源清单变化作废（判据在 `source-inbox-ui.ts`）：留着一条遮不住任何东西的记录，
  // 会在「删光这批再导入同一批 id」时把提示再次吞掉——那是一次用户没做过的「已看过」。
  useEffect(() => { if (sources !== null) pruneInboxMuted(sourceInbox(sources)) }, [sources])
  // 任务现场只读常驻状态层的镜像（轮询单实例住 `NovelStatusOverlay`，不在本视图内）：
  // 切走 tab 轮询照跑、回到本区读数即刻是最新的。refresh = 让驱动立刻重拉一次。
  const { job } = useJobSurface()
  // 任务收尾 → 刷新源列表（按 job.id 记账一次，不重复 reload）——待办读数随任务结果自动收敛
  const [reloadedJob, setReloadedJob] = useState<string | null>(null)
  useEffect(() => {
    if (job !== null && job.phase !== 'running' && job.id !== reloadedJob) {
      setReloadedJob(job.id)
      reload()
    }
  }, [job, reloadedJob])
  /** 常驻状态层点击 → 跨子树意图：本区在场就消费（开弹层 / 回列表并滚到任务卡）。
   *  消费即清空，所以同一意图不重放；试跑子视图也先退回列表——原先在试跑页里点「点此查看」
   *  是个 no-op（querySelector 找不到目标，见本文件历史口径），现在改成「带回现场」。 */
  const openRequest = useJobOpenRequest()
  useEffect(() => {
    if (openRequest === null) return
    setSub({ name: 'list' })
    if (openRequest === 'import') setImportOpen(true)
    else setTimeout(() => document.querySelector('[data-novel-run-card]')?.scrollIntoView({ block: 'center' }), 0)
    takeJobOpen()
  }, [openRequest])

  // 待办集合唯一派生口在 source-inbox.ts：导入弹层的「去验证」也走它，视图不另抄一份按状态筛
  const unverifiedIds = sources === null ? [] : inboxIds(sourceInbox(sources), 'unverified')
  /** 待办处置动作（批量重验/一键验证/导入后「去验证」）的统一提交口：
   *  ids 点击时快照；失败走 pushError 显式呈现（历史 bug：此处曾是 () => undefined 吞掉
   *  rejection，「去验证」点了没反应还留 unhandled） */
  const verifyIds = (ids: string[]): void => {
    void deps.startBatchProbeJob(ids).then(refreshJob, (e: unknown) => {
      deps.pushError(`启动验证失败：${e instanceof Error ? e.message : String(e)}`)
    })
  }

  if (sub.name === 'probe') {
    return (
      <div data-novel-view="sources" data-novel-scope className="novel-view">
        {/* 样式层自带 + data-novel-scope token 锚点：单飞渲染（测试、未来任何新挂载点）都自足；
            NovelView 已在其根上注入时经 withStyles=false 让位，不在同一棵树里注两遍 NOVEL_CSS。
            状态条不在这里——它住 shell.overlay 的常驻层（NovelStatusOverlay），本视图只读它的镜像。 */}
        {withStyles ? <NovelStyles /> : null}
        <ProbePane sourceId={sub.sourceId} onBack={() => setSub({ name: 'list' })} deps={deps} />
      </div>
    )
  }

  return (
    <div data-novel-view="sources" data-novel-scope className="novel-view">
      {withStyles ? <NovelStyles /> : null}
      {loadError === null ? null : (
        <div className="novel-err novel-note-md">源列表加载失败：{loadError}（稍后重试或检查 DSH 服务端）</div>
      )}
      {/* ① 待办收件箱：反常置顶；加载中/加载失败不渲染 */}
      <SourceInbox sources={sources} loadError={loadError} job={job} onVerify={verifyIds} />
      {/* ② 任务槽：验证类任务的运行卡归位于此（导入任务的运行卡在导入弹层内——kind 分家） */}
      {job !== null && job.kind !== 'import' && job.phase === 'running' && (
        <div data-novel-job-slot><ProbeRunCard job={job} /></div>
      )}
      {/* ③ 源列表（资产清单）：过滤/编辑/批量/删除模态/行内动作全在其内 */}
      <SourceList
        sources={sources}
        job={job}
        refresh={refreshJob}
        onChanged={reload}
        onProbe={(id) => setSub({ name: 'probe', sourceId: id })}
        onImport={() => setImportOpen(true)}
        loadError={loadError}
        deps={deps}
      />
      {/* ④ 导入弹层：低频任务收纳；提交后自动关闭，完成事项经待办收件箱回流（闭环） */}
      {importOpen && (
        <ImportModal onClose={() => setImportOpen(false)}>
          <ImportPane
            job={job}
            refresh={refreshJob}
            unverifiedCount={unverifiedIds.length}
            onVerifyUnverified={() => { setImportOpen(false); verifyIds(unverifiedIds) }}
            onSubmitted={() => setImportOpen(false)}
            deps={deps}
          />
        </ImportModal>
      )}
    </div>
  )
}

/** 待办收件箱（2026-09 状态化，用户裁定）：坏源/未验证两张任务卡——它是**提示**，不是台账。
 *  三条口径变化：
 *  ① 卡标题**不印计数**（`✗ 坏源` 而非 `✗ 坏源 3`）：读数的唯一住址是列表头状态带
 *    （`source-list-view.ts` 的 `stats`），同一条数不印第二遍；且卡可忽略后，读数不能跟着
 *    提示一起消失。
 *  ② 每卡「✕ 忽略」= 这批成员我不再需要被提醒；成员集一变（新坏源 / 新导入未验证）签名
 *    不再命中 → 提示自动复现（签名口径在 `source-inbox.ts`）。被忽略的卡折成头行一句
 *    「已忽略 N 张 · 重新显示」，能关就能开回来，不留黑洞。
 *  ③ **零待办整块不渲染**（全健康 / 全部被忽略 / 0 源）：原先常驻的「✓ 全部源状态良好」是
 *    一块永远正确的区域，而「查过了且没事」这条结论现在由状态带的 `未验证 0 · 坏源 0` 承担；
 *    0 源时的引导也归列表自己的空态（不在此抄第二份）。
 *  不变的口径：加载中 / 加载失败**不渲染**（不拿未知当「全部良好」，宁炸不猜的呈现半场）；
 *  每卡只留处置动作，逐源排查在列表行内「试跑」（待办是任务摘要，不放重复入口，用户裁定）。 */
function SourceInbox({ sources, loadError, job, onVerify }: {
  sources: SourcePublic[] | null; loadError: string | null; job: JobState | null
  onVerify: (ids: string[]) => void
}): ReactNode {
  const { muted } = useStore(inboxUi)
  if (sources === null || loadError !== null) return null
  const inbox = sourceInbox(sources)
  const { shown, hidden } = visibleInboxCards(inboxCards(inbox), muted)
  if (shown.length === 0 && hidden.length === 0) return null
  // 在途禁用面 = 任何任务（不限 probe kind）：服务端**单任务槽**——import-job.begin 运行中
  // 抛 JobRunningError，import 在途时提交探针同样无处可去（审查建议按 kind 收窄，拿服务端
  // 契约驳回：那只会把一个必然失败的请求放行到点击之后）。
  const probing = job?.phase === 'running'
  return (
    <div data-novel-inbox className="novel-inbox">
      <div className="novel-inbox-head">
        <strong>待办</strong>
        {/* 忽略态必须看得见才有出路：只剩隐藏行时网格不渲染，但「重新显示」一直在 */}
        {hidden.length === 0 ? null : (
          <span className="novel-muted" data-novel-inbox-hidden>已忽略 {hidden.length} 张
            <button className="novel-btn sm" onClick={unmuteAllInboxCards}>重新显示</button>
          </span>
        )}
      </div>
      {shown.length === 0 ? null : (
        <div className="novel-inbox-grid">
          {shown.map((c) => {
            const copy = TODO_CARD[c.kind]
            return (
              <div key={c.kind} className={`novel-todo-card ${copy.tone}`} data-novel-todo={c.kind}>
                <div className="novel-todo-head">
                  <span className={`novel-todo-label ${copy.tone}`}>{copy.icon} {copy.label}</span>
                  <span className="novel-grow" />
                  <button className="novel-btn sm" aria-label={`忽略 ${copy.label} 提示`} title={copy.muteTitle}
                    onClick={() => muteInboxCard(c.kind, c.signature)}>✕ 忽略</button>
                </div>
                <span className="novel-todo-names">{c.sources.map((s) => s.name).join(' · ')}</span>
                <button className="novel-btn sm primary" disabled={probing}
                  onClick={() => onVerify(inboxIds(inbox, c.kind))}>{copy.action}</button>
                <span className="novel-muted">{copy.hint}</span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** 两类待办的卡面文案：表驱动——两分支各写一份 JSX 是近逐字双胞胎，改一处即漂移 */
const TODO_CARD: Record<InboxKind, { icon: string; label: string; tone: 'err' | 'warn'; action: string; hint: string; muteTitle: string }> = {
  broken: {
    icon: '✗', label: '坏源', tone: 'err', action: '批量重验',
    hint: '逐源排查在列表行内「试跑」', muteTitle: '本轮不再提醒；有新的坏源出现会自动回来',
  },
  unverified: {
    icon: '?', label: '未验证', tone: 'warn', action: '一键验证',
    hint: '新导入的源也汇入此处', muteTitle: '本轮不再提醒；新导入的未验证源会自动回来',
  },
}

/** 导入弹层：遮罩 + 宽档模态（`.novel-modal.wide`）；Esc / 点遮罩 /「关闭」退出。
 *  入场焦点在关闭钮（轻量焦点口径；删除确认模态另有完整 Tab 圈闭包，在 SourceList 侧）。
 *  焦点/Esc effect **挂载作用域**（空依赖 + onClose 走 ref）：壳层 useJobStatus 每 1s
 *  setJob 新对象 → 每 render 新闭包，进依赖数组会每秒把用户焦点劫回关闭钮（审查 2026
 *  发现的真缺陷）；弹层条件渲染 = 每次打开都是新挂载，入场焦点语义不受影响。
 *  回归钉在 views-wiring「导入弹层焦点不被壳层重渲染劫持」用例。 */
function ImportModal({ onClose, children }: { onClose: () => void; children: ReactNode }): ReactNode {
  const closeRef = useRef<HTMLButtonElement | null>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose                      // 每 render 刷新 ref：effect 内永远调到最新闭包
  useEffect(() => {
    closeRef.current?.focus()
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onCloseRef.current() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])
  return (
    <div className="novel-modal-mask" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="novel-modal wide" role="dialog" aria-modal="true" aria-label="导入书源">
        <div className="novel-modal-title">导入书源</div>
        {children}
        <div className="novel-modal-actions">
          <button ref={closeRef} className="novel-btn sm" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  )
}

// ── 试跑器（单源排查下钻）：段级 trace 结果卡 ────────────────────────────

/**
 * 试跑器：deps 注入（与兄弟 panes 同款 seam）。
 * 历史 bug 钉死：`apiSend(...).then(setResult)` 无 rejection handler——请求失败即
 * 永久停在「探针执行中…」并留下 unhandled rejection。失败显式呈现是接线的一部分。
 */
export function ProbePane({ sourceId, onBack, deps = prodDeps }: {
  sourceId: string; onBack: () => void; deps?: SettingsDeps
}): ReactNode {
  const [result, setResult] = useState<ProbeResult | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const run = (): void => {
    setFailed(null)
    void deps.apiSend<ProbeResult>('POST', paramRoutes.sourceProbe(sourceId))
      .then(setResult, (e: unknown) => setFailed(e instanceof Error ? e.message : String(e)))
  }
  useEffect(run, [sourceId])
  return (
    <div className="novel-group">
      <div className="novel-toolbar">
        <button className="novel-btn" onClick={onBack}>← 返回源列表</button>
        <button className="novel-btn" onClick={run}>重跑</button>
        <span className="novel-muted">单源试跑：真实搜索请求 + 规则求值 trace</span>
      </div>
      {failed !== null
        ? <div className="novel-err novel-note-md">探针请求失败：{failed}</div>
        : result === null
          ? <div className="novel-muted">探针执行中…</div>
          : (
            <div className="novel-panel novel-group">
              <div>
                <StatusBadge status={result.ok ? 'verified' : 'broken'} />
                {' '}{result.ok ? `命中 ${result.itemCount} 条，首条「${result.firstTitle ?? ''}」` : '不可用'}
              </div>
              {result.error === undefined ? null : <ErrorBanner error={{ code: result.error.code, message: result.error.message }} />}
            </div>
          )}
    </div>
  )
}
