import type { ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { paramRoutes, ROUTES } from '../../shared/wire.js'
import { prodDeps } from '../deps.js'
import type { ClientCoreDeps, SettingsDeps } from '../deps.js'
import { refreshJob, startSourceVerification, takeJobOpen, useJobOpenRequest, useJobSurface } from '../jobs.js'
import { inboxCards, inboxIds, sourceInbox, visibleInboxCards } from '../source-inbox.js'
import type { InboxKind, SourceInbox } from '../source-inbox.js'
import { inboxUi, muteInboxCard, pruneInboxMuted, unmuteAllInboxCards } from '../source-inbox-ui.js'
import { useStore } from '../store.js'
import { NovelStyles } from '../styles.js'
import { ImportPane } from './SettingsImportPane.js'
import { ProbeRunCard, SourceList } from './SettingsSourceList.js'
import { ErrorBanner, StatusBadge } from './bits.js'
import { Dialog } from './dialog.js'
import type { JobState, ProbeResult, SourcePublic } from './types.js'

/**
 * 书源管理 tab 壳（2026 调度台 IA，用户拍板）：**待办收件箱 + 任务槽 + 源列表 + 导入弹层**——
 * 按「用户带什么任务来」组织：① 待办反常置顶（坏源/未验证成任务卡）② 源列表（朴素资产表）
 * ③ 导入收纳为弹层，完成事项回流待办。手风琴与危险区专区随改版退役，删除统一模态二次确认。
 *
 * 组件职责边界：本文件只做接线与现场——sources 每次挂载经 api 拉取、组件内 useState（业务数据
 * 不进 store）；任务轮询单实例**不在本视图**（`useJobPolling` 住 `NovelStatusOverlay`，本区只读
 * `jobSurface` 镜像）；deps 整壳注入向下透传。派生逻辑归纯函数：待办 → source-inbox.ts，
 * 列表 → source-list-view.ts。
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
      // 忽略记录随源清单变化作废——这一步跟着**清单落地的这一处**，不另开 effect：清单只有这一个
      // 写入点，作废就挂在它后面，读代码的人不会漏。留着一条遮不住任何东西的记录，会在
      // 「删光这批再导入同一批 id」时把提示再次吞掉——那是一次用户没做过的「已看过」（判据在
      // `source-inbox-ui.ts`）。**取数失败那一支不作废**：加载失败是「不知道」，不是「这批没了」，
      // 拿它清掉用户的忽略现场就是把未知当结论。
      pruneInboxMuted(sourceInbox(list))
    }, (e) => {
      setSources([])
      setLoadError(e instanceof Error ? e.message : String(e))
    })
  }
  useEffect(reload, [])
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

  // 待办集合唯一派生口在 source-inbox.ts：一次派生同时喂待办区与导入弹层的「去验证」，
  // 视图不另抄一份按状态筛（同一份源清单也不在同一轮渲染里筛两遍）
  const inbox = sources === null ? null : sourceInbox(sources)
  const unverifiedIds = inbox === null ? [] : inboxIds(inbox, 'unverified')
  /** 待办处置动作（批量重验/一键验证/导入后「去验证」）的统一提交口：ids 点击时快照；
   *  提交后的编排归 `jobs.ts` 的 `startSourceVerification`（三个验证入口同一条路）——
   *  此处曾是 `() => undefined` 吞掉 rejection，「去验证」点了没反应还留 unhandled。 */
  const verifyIds = (ids: string[]): void => {
    void startSourceVerification(ids, deps)
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
      <InboxSection inbox={inbox} loadError={loadError} job={job} onVerify={verifyIds} />
      {/* ② 任务槽：验证类任务的运行卡归位于此（导入任务的运行卡在导入弹层内——kind 分家） */}
      {job !== null && job.kind !== 'import' && job.phase === 'running' && (
        <div data-novel-job-slot><ProbeRunCard job={job} /></div>
      )}
      {/* ③ 源列表（资产清单）：过滤/编辑/批量/删除模态/行内动作全在其内 */}
      <SourceList
        sources={sources}
        job={job}
        onChanged={reload}
        onProbe={(id) => setSub({ name: 'probe', sourceId: id })}
        onImport={() => setImportOpen(true)}
        loadError={loadError}
        deps={deps}
      />
      {/* ④ 导入弹层：低频任务收纳；提交后自动关闭，完成事项经待办收件箱回流（闭环）。
          焦点闭环与 Esc 归 `views/dialog.tsx`（宽档几何 = `.novel-modal.wide`，主人仍是样式层）。
          入场焦点按契约落面板内第一颗未禁用钮：缺省态是动作行「关闭」（更早的「导入粘贴内容」
          在无有效 JSON 时禁用），有完成回执时是回执里的「查看明细」。
          回归钉在 views-wiring「导入弹层焦点不被壳层重渲染劫持」。 */}
      {importOpen && (
        <Dialog title="导入书源" variant="wide" onClose={() => { setImportOpen(false) }}
          actions={<button className="novel-btn sm" onClick={() => { setImportOpen(false) }}>关闭</button>}>
          <ImportPane
            job={job}
            refresh={refreshJob}
            unverifiedCount={unverifiedIds.length}
            onVerifyUnverified={() => { setImportOpen(false); verifyIds(unverifiedIds) }}
            onSubmitted={() => setImportOpen(false)}
            deps={deps}
          />
        </Dialog>
      )}
    </div>
  )
}

/** 待办收件箱（2026-09 状态化，用户裁定）：坏源/未验证两张任务卡——它是**提示**，不是台账。
 *  ① 卡标题**不印计数**：读数唯一住址是列表头状态带（`source-list-view.ts` 的 `stats`），卡可
 *    忽略后读数不能跟着提示消失。② 每卡「✕ 忽略」按成员签名记账，成员集一变提示自动复现
 *    （签名口径在 `source-inbox.ts`）；忽略的卡折成「已忽略 N 张 · 重新显示」，不留黑洞。
 *  ③ **零待办整块不渲染**（全健康 / 全部被忽略 / 0 源）：「查过了且没事」由状态带的
 *    `未验证 0 · 坏源 0` 承担，0 源引导归列表自己的空态（不抄第二份）。
 *  不变的口径：加载中 / 加载失败**不渲染**（不拿未知当「全部良好」，宁炸不猜）；每卡只留处置
 *  动作，逐源排查在列表行内「试跑」（待办是任务摘要，不放重复入口，用户裁定）。
 *  `inbox` 由壳层一次派生后传下来（同一份源清单不在一轮渲染里筛两遍，弹层的「去验证」读同一份）。 */
function InboxSection({ inbox, loadError, job, onVerify }: {
  inbox: SourceInbox | null; loadError: string | null; job: JobState | null
  onVerify: (ids: string[]) => void
}): ReactNode {
  const { muted } = useStore(inboxUi)
  if (inbox === null || loadError !== null) return null
  const { shown, hidden } = visibleInboxCards(inboxCards(inbox), muted)
  if (shown.length === 0 && hidden.length === 0) return null
  // 在途禁用面 = 任何任务（不限 probe kind）：服务端**单任务槽**——import-job.begin 运行中
  // 抛 JobRunningError，import 在途时提交探针同样无处可去（被否决的方案：按 kind 收窄——
  // 那只会把一个必然失败的请求放行到点击之后，判据是服务端契约不是任务种类）。
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

// ── 试跑器（单源排查下钻）：段级 trace 结果卡 ────────────────────────────

/**
 * 试跑器：deps 注入（与兄弟 panes 同款 seam）。
 * 历史 bug 钉死：`apiSend(...).then(setResult)` 无 rejection handler——请求失败即
 * 永久停在「探针执行中…」并留下 unhandled rejection。失败显式呈现是接线的一部分。
 */
export function ProbePane({ sourceId, onBack, deps = prodDeps }: {
  /** 试跑只发一次探针请求：读面与任务面都由壳层管，这里不吃整束 */
  sourceId: string; onBack: () => void; deps?: Pick<ClientCoreDeps, 'apiSend'>
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
