import { useCallback } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { useCopy } from '../copy/index.js'
import { setRunCard } from '../run-card.js'
import type { RunCardKind } from '../run-card.js'
import type { JobState, LocalImportWarning } from './types.js'

/** 小组件集：状态徽标 / 错误横幅（带段级定位徽标）/ 空态 / 运行卡与进度段——六视图共用。
 *  颜色一律走 `--novel-*` 局部 token（由 NovelStyles 的 token 层定义，见 styles.tsx 头注）：
 *  写死 hex 等于钉死一套主题观感，暗态下与宿主调色板不一致。 */

/** 源状态徽标：原始状态字不进 UI，文案住 `copy/sources.ts` 的 `sources.status.*`（书源列表与
 *  搜索结果共用）；取色走 data-status 属性选择器——颜色的主人是样式层的 --novel-status-*，
 *  这里不该再行内挑色。状态点是纯装饰：读屏念「● 可用」是噪声，颜色之外没有任何信息。 */
export function StatusBadge({ status }: { status: string }): ReactNode {
  const t = useCopy()
  const key = status === 'verified' ? 'verified' : status === 'broken' ? 'broken' : 'unverified'
  const labelKey = key === 'verified' ? 'sources.status.verified'
    : key === 'broken' ? 'sources.status.broken' : 'sources.status.unverified'
  return (
    <span data-novel="badge" data-status={key} className="novel-badge">
      <span aria-hidden="true">● </span>{t(labelKey)}
    </span>
  )
}

/** 搜索图标（放大镜）：书架头与搜索页的 `.novel-searchbox` 同款（bits = 视图共用小件）。
 *  aria-hidden：输入框自有 aria-label/placeholder，图标纯装饰不重复播报。 */
export function SearchIcon(): ReactNode {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </svg>
  )
}

export interface ApiErrorLike {
  code?: string
  message?: string
  segment?: { facet: string; segmentIndex: number; segmentRaw?: string }
}

/** 错误横幅：message 红字 + segment 存在时「面#段N」徽标（底/字/徽标全走 token）。
 *  `error.code` 与 segment 的 facet 是服务端数据，原样呈现；骨架词（段 / 未知错误 / 重试）走字典。 */
export function ErrorBanner({ error, onRetry }: { error: ApiErrorLike; onRetry?: () => void }): ReactNode {
  const t = useCopy()
  return (
    <div data-novel="error" className="novel-panel novel-error-banner">
      {error.segment !== undefined && (
        <span className="novel-badge-pill">
          {t('common.segmentBadge', { facet: error.segment.facet, n: error.segment.segmentIndex })}
        </span>
      )}
      <span className="novel-err">{error.code ?? 'Error'}: {error.message ?? t('common.unknownError')}</span>
      {onRetry !== undefined && (
        <button className="novel-btn sm novel-retry" onClick={onRetry}>{t('common.retry')}</button>
      )}
    </div>
  )
}

/** 空态：标题 + 动作按钮组。字色走 --novel-text-2（旧实现写 opacity:.75 = 主动削弱对比度，
 *  浅色底上会掉到 4.5:1 以下） */
export function EmptyState({ title, hint, actions }: { title: string; hint?: string; actions?: ReactNode }): ReactNode {
  return (
    <div data-novel="empty" className="novel-empty">
      <div className="novel-empty-title">{title}</div>
      {hint === undefined ? null : <div className="novel-empty-hint">{hint}</div>}
      {actions}
    </div>
  )
}

/** 封面降级首字（无封面/加载失败 → 书名首字色块）；空标题回退「书」 */
export function coverFallbackChar(title: string): string {
  const t = title.trim()
  return t === '' ? '书' : t.slice(0, 1)
}

// ── 后台任务呈现（运行卡双胞胎 + 迷你进度条同源）─────────────────────

/** 任务百分比（total=0 防除零）：运行卡与状态条共用同一算法——三处进度各算是 bug 苗床 */
export function jobPct(job: Pick<JobState, 'done' | 'total'>): number {
  return job.total === 0 ? 0 : Math.round((job.done / job.total) * 100)
}

/**
 * 搜索轮次的完成百分比（**搜索面的唯一算式**）。按**源数**算：满格是算出来的而不是写死的——
 * 被停止的轮次照实停在它真正走到的位置。clamp 到 100 是因为 done 可能超过 total（跑到一半源被
 * 停用/删掉，分母缩了、分子没缩）。
 *
 * **与 `jobPct` 不是同一口径**（那个按任务条目、不 clamp），已裁各自具名不合并——两式分母
 * 语义不同（任务条目 vs 参搜源数），折叠成一个算式必有一面谎报进度。
 */
export function searchPct(round: { done: number; total: number } | null): number {
  if (round === null || round.total === 0) return 0
  return Math.min(100, Math.round((round.done / round.total) * 100))
}

/** 进度段（.novel-progress）：运行卡、状态条迷你条与书架卡片同源——role/aria 三件套只写这一份。
 *  推进走 `--novel-pct` → 样式层 `transform: scaleX()`：改 width 每次触发布局，
 *  一屏几十张卡 + 搜索条 + 运行卡同时在途就是逐帧重排（合成层只改 transform）。
 *  元素用 span 而非 div：书架卡片现在是真 <button>，div 不是合法的按钮内容。 */
export function ProgressBar({ pct, style }: { pct: number; style?: CSSProperties }): ReactNode {
  return (
    <span className="novel-progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} style={style}>
      <i style={{ '--novel-pct': String(pct / 100) } as CSSProperties} />
    </span>
  )
}

/** 运行卡外壳：导入/批量验证两卡此前近逐字同构——浮层底 + 标题行 + 进度段
 *  + counts 尾行 + 「可以关掉设置页，任务在服务端继续」全同，差异仅 label/meta 文案与
 *  dupSkipped 等条件行。本组件持公共外壳（brand 派生色走 --novel-brand-* token），
 *  两卡收薄为调用、差异插槽化（meta/counts）。
 *  根节点同时是「任务去现场」的登记点（`run-card.ts`）：按 `kind` 分桶登记——两张运行卡
 *  可以同时在树上，去现场只该滚自己那一种。 */
export function RunCard({ kind, label, meta, pct, counts }: {
  /** 现场分桶：导入卡与验证卡可同时在场（见 `run-card.ts` 文件头） */
  kind: RunCardKind
  /** 「导入中…」/「验证中…」 */
  label: string
  /** done/total（pct%）· 并发 5 路 之类 */
  meta: ReactNode
  pct: number
  /** 尾行 counts（已新增/已验证/未通过/重复跳过……）——两卡形态不同，插槽化 */
  counts: ReactNode
}): ReactNode {
  const t = useCopy()
  /** ref 身份钉在 kind 上：内联回调每轮渲染换身份，React 会以 null 重调旧 ref——等于每轮
   *  渲染都把现场短暂清空，在途的去现场意图可能撞上这个空窗。 */
  const register = useCallback((el: HTMLElement | null) => { setRunCard(kind, el) }, [kind])
  return (
    <div data-novel-run-card className="novel-group novel-run-card" ref={register}>
      <div className="novel-toolbar novel-run-card-head">
        <strong>{label}</strong>
        <span className="novel-muted">{meta}</span>
        <span className="novel-grow" />
        <span className="novel-muted">{t('sources.run.canClose')}</span>
      </div>
      <ProgressBar pct={pct} />
      <div className="novel-toolbar">{counts}</div>
    </div>
  )
}

/** 导入告警清单：一条 = 码 + 资源 + 人读的交代。**标记的唯一住址**在这里——
 *  阅读器的导入说明面板与书架的导入回执原先各抄一份 JSX（CSS 共享而标记不共享，改一条口径必漏
 *  另一处），现在两处都渲染这一个组件；样式仍住样式层（.novel-warn-list / -code）。 */
export function WarningList({ warnings }: { warnings: readonly LocalImportWarning[] }): ReactNode {
  return (
    <ul className="novel-warn-list">
      {warnings.map((w, i) => (
        <li key={`${w.code}-${String(i)}`}>
          <span className="novel-warn-code">{w.code}</span>
          {w.resource === null ? null : <span className="novel-muted novel-note-sm"> · {w.resource}</span>}
          <div className="novel-muted novel-note-sm">{w.message}</div>
        </li>
      ))}
    </ul>
  )
}
