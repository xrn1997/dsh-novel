import type { ReactNode } from 'react'
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { SEARCH_BOOKS_CAP } from '../../shared/wire.js'
import { describeError } from '../api.js'
import { plural, useCopy } from '../copy/index.js'
import type { Translate } from '../copy/index.js'
import { searchSummarySegments } from '../copy/search-summary.js'
import { prodJobViewDeps } from '../deps.js'
import type { JobViewDeps, RowActionDeps } from '../deps.js'
import { ensurePanelShelf } from '../panel-shelf.js'
import { useSearchJob } from '../search-job.js'
import { useSearchLanding } from '../search-landing.js'
import type { SearchLanding } from '../search-landing.js'
import { bookRowKey, deriveRound, shortAuthor } from '../search-view-model.js'
import type { BookView, GroupView, RowRef, RoundView } from '../search-view-model.js'
import { addShelfSeat } from '../shelf-action.js'
import type { ShelfAddOutcome } from '../shelf-action.js'
import { navigate, routeStore, useStore } from '../store.js'
import { EmptyState, ProgressBar, SearchIcon, searchPct, StatusBadge } from './bits.js'
import type { MergedBook, SearchHit } from './types.js'

/** 搜索：提交一轮**后台任务** + 按游标轮询增量渲染 + 默认按书一行、逐源那一档降级成页尾折叠。
 *  两条轴都要在：整库逐源铺开翻不完，而「源好坏各自可见」是这条链路的排查轴——降级不是删除。
 *  在途循环归 `client/search-job.ts`：本组件不持有批请求，切 tab 卸载不丢整轮。
 *  陈旧回调防线在 `search-job`（轮次身份 = jobId）；轮级派生住 `shared/round-summary.ts`，
 *  两条轴的行身份与逐源回读住 `search-view-model.ts`。测试钉子：placeholder「书名 / 作者」、
 *  form aria-label「搜索书籍」、空态两分支文案。 */

export function SearchView({ deps = prodJobViewDeps }: { deps?: JobViewDeps }): ReactNode {
  const t = useCopy()
  const { route } = useStore(routeStore)
  const initialKeyword = route.name === 'search' ? route.keyword ?? '' : ''
  const [keyword, setKeyword] = useState(initialKeyword)
  const { round, error, submit, cancel } = useSearchJob(deps, t)
  /** mount 提交的一次性闸：ref 防 StrictMode 同实例二次 effect。 */
  const consumed = useRef<string | null>(null)
  useEffect(() => {
    if (initialKeyword === '' || consumed.current === initialKeyword) return
    consumed.current = initialKeyword
    void submit(initialKeyword)
    // route.keyword 只消费一次，提交即摘除：routeStore 跨卸载存活，不摘的话重挂载会重新提交，
    // 而服务端搜索读面是单槽（新提交即替换、旧轮被杀）。摘除后重挂载只剩 search-job 的「挂载即恢复」。
    navigate({ name: 'search' })
  }, [])   // eslint-disable-line react-hooks/exhaustive-deps
  /** 恢复轮次时回填搜索框（每挂载至多一次、只在框为空时）：结果配一个空输入框会像没搜过。 */
  const filled = useRef(false)
  useEffect(() => {
    if (round === null || filled.current || keyword !== '') return
    filled.current = true
    setKeyword(round.keyword)
  }, [round])   // eslint-disable-line react-hooks/exhaustive-deps
  /** 落架基线：投影随面板卸载清空，而 routeStore 跨卸载存活——面板重开时已在架的书会重写成
   *  「＋ 加书架」，故先读一次服务端书架（`ADR-0046`）；只为基线，不带 bookKey。 */
  useEffect(() => {
    void ensurePanelShelf({
      apiGet: deps.apiGet,
      describeError: (e: unknown): string => describeError(e, t),
    })
  }, [])   // eslint-disable-line react-hooks/exhaustive-deps

  const running = round !== null && round.running
  const progress = round !== null && round.running ? { done: round.done, total: round.total } : null
  /** 一轮的现场：memo 身份 = (轮次 id, 关键词, 组数)——组只增不减，三者不变现场就不变；
   *  累积器由 `client/search-job.ts` 单点持有，派生在 `search-view-model.deriveRound`。 */
  const view = useMemo<RoundView | null>(() => (round === null ? null : deriveRound(round)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [round?.id, round?.keyword, round?.groups.length])
  /** 落架账住 `panel-shelf.ts`，加架排队住 `search-landing.ts`；写口仍是 `addShelfSeat`，
   *  视图只把它包成 `addSeat` 注入并保留回执措辞。 */
  const landing = useSearchLanding({ addSeat: (input) => addShelfSeat(input, deps) })
  const summary = view !== null && !running ? view.summary : null
  // 空参与集与「搜了没命中」是两件事：前者 total=0（源全停用/未导入），后者有源但零分组
  const emptyPlan = progress === null && round !== null && round.total === 0

  // 进度算式的单点在 bits.searchPct（按源数算 + clamp；与任务式的 jobPct 不同口径，已裁各自具名不合并）
  const pct = searchPct(round === null ? null : { done: round.done, total: round.total })
  const live = progress !== null
    ? (progress.total === 0
      ? <>{t('search.starting')}</>
      : <>{t('search.progress.prefix')}<b>{progress.done}</b>{plural(t, progress.total, 'search.progress.suffix.one', 'search.progress.suffix.other', { total: progress.total })}</>)
    : summary === null || summary.searched === 0 || view === null
      ? null
      : <>
          {/* 视野收过一条时收口必须两个数并报：只报 hits 与默认视野对不上号。 */}
          {searchSummarySegments(t, {
            searched: summary.searched,
            hits: summary.hits,
            merged: view.merged.total,
            answered: summary.answered,
            relevant: summary.kept,
            failed: summary.failed,
            stopped: round?.cancelled === true,
          }).map((seg, i) => seg.emphasis
            ? <b key={i}>{seg.text}</b>
            : <Fragment key={i}>{seg.text}</Fragment>)}
        </>
  return (
    <div data-novel-view="search" className="novel-view">
      <div className="novel-wrap">
        <div className="novel-search-bar">
          <button className="novel-btn" onClick={() => navigate({ name: 'shelf' })}>{t('search.back')}</button>
          <form
            onSubmit={(e) => { e.preventDefault(); void submit(keyword) }}
            className="novel-search-form"
            aria-label={t('search.label')}
          >
            <label className="novel-searchbox">
              <SearchIcon />
              <input
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                placeholder={t('search.placeholder')}
                aria-label={t('search.label')}
              />
            </label>
            <button type="submit" className="novel-btn primary" disabled={running}>
              {running ? t('search.searching') : t('search.submit')}
            </button>
          </form>
        </div>
        <div data-novel-search-progress className="novel-search-prog">
          <ProgressBar pct={pct} />
          {live === null && !running ? null : (
            <div className="novel-prog-text">
              <span>{live}</span>
              {/* 停止 = 不再往下搜，**已搜出来的全部留下**（服务端只进终态、不清结果）。 */}
              {running ? <button type="button" className="novel-btn sm" onClick={cancel}>{t('search.cancel')}</button> : null}
            </div>
          )}
        </div>
        {error === null ? null : (
          <div className="novel-err novel-note-md">{t('search.interrupted', { detail: error })}</div>
        )}
        {view !== null && progress === null && view.parts.length === 0 && (
          emptyPlan
            ? <EmptyState title={t('search.empty.noSources.title')} hint={t('search.empty.noSources.hint')} />
            : <EmptyState title={t('search.empty.noHits.title')} hint={t('search.empty.noHits.hint')} />
        )}
        {/* 按书在前：一本一行；整轮都被判 suspect 时这一档是空的。 */}
        {view !== null && renderBooks(view.bookViews, view.merged.total, deps, landing, t)}
        {/* 逐源那一档不删、降级到页尾折叠：各家给了几条、哪一家未响应，仍是排查轴 */}
        {view !== null && view.parts.length !== 0 && (
          <details className="novel-fail" data-novel-per-source>
            <summary>{plural(t, view.parts.length, 'search.perSource.summary.one', 'search.perSource.summary.other', { n: view.parts.length })}</summary>
            {renderGroups(view.groupViews, deps, landing, t)}
          </details>
        )}
      </div>
    </div>
  )
}

/** 命中行：行内双动作——主按钮 = 加架并直接阅读；「＋ 加书架」只加架。结构：容器 .novel-row +
 *  主钮 .novel-row-main + 兄弟动作钮（**不嵌套**）。入架态由 `landing` 给（账在行之上，行会随折叠
 *  卸载）。url 为 null 渲染不可点行（空串产不出来）。 */
function HitRow({ sourceId, hit, deps, landing }: {
  sourceId: string; hit: SearchHit; deps: RowActionDeps; landing: SearchLanding
}): ReactNode {
  const t = useCopy()
  const sub = `${hit.author ?? ''}${hit.lastChapterName === null || hit.lastChapterName === '' ? '' : ` · ${hit.lastChapterName}`}`
  if (hit.url === null) {
    // 无 url：这条既进不了阅读器也加不了架——如实呈现为一行文字，不给假的可点态
    return (
      <div className="novel-row novel-row-dead">
        <span className="novel-hit-title">{hit.title}</span>
        <span className="novel-hit-sub">{sub}</span>
      </div>
    )
  }
  const url = hit.url
  /** 单行加架：落架记账归 `landing`，失败上报留在行上；两种结局都交回调用方。失败不静默。 */
  const add = async (): Promise<ShelfAddOutcome> => {
    const outcome = await landing.add({ sourceId, hit })
    if (!outcome.ok) deps.pushError(t('search.shelf.addFailed', { detail: describeError(outcome.error, t) }))
    return outcome
  }
  /** 点行直接阅读：先加架（进度保存依赖书架条目）再进阅读器。导航是两种结局的收尾——
   *  `add` 不抛，它的记账/上报回调可能抛；不接住，导航就被一条回调挡在门外。 */
  const read = (): void => {
    const goRead = (): void => { navigate({ name: 'reader', sourceId, bookKey: url, title: hit.title }) }
    void add().then(goRead, goRead)
  }
  return (
    <div className="novel-row">
      <button className="novel-row-main" onClick={read} aria-label={t('search.hit.read', { title: hit.title })}>
        <span className="novel-hit-title">{hit.title}</span>
        <span className="novel-hit-sub">{sub}</span>
      </button>
      {/* 兄弟入口没有后续动作：回执回调抛错时就地咽掉（add 的失败已上报过）。 */}
      <button className="novel-btn sm" disabled={landing.isLanded(hit)} onClick={() => { void add().catch(() => undefined) }}>
        {landing.isLanded(hit) ? t('search.shelf.added') : t('search.shelf.add')}
      </button>
    </div>
  )
}

/** 按源那一档（页尾折叠内容）：逐源分组，默认视野只摆 kept（判据与档序在 `shared/relevance`），
 *  suspect 收进组内折叠——「判掉了但还在」不是「一条都没判掉」。计数两个数都给、单位是**条**。
 *  行 key 由轮级派生预计算（`search-view-model` 的 `GroupView`），纯下标 key 会在重排时串行态。
 *  失败组也留在 `groupViews` 里，由本函数按 `error` 挪进失败折叠。 */
function renderGroups(groupViews: GroupView[], deps: RowActionDeps, landing: SearchLanding, t: Translate): ReactNode {
  const hits = groupViews.filter((gv) => gv.partition.group.error === undefined)
  const failed = groupViews.filter((gv) => gv.partition.group.error !== undefined)
  if (hits.length === 0 && failed.length === 0) return null
  return (
    <div className="novel-groups">
      {hits.map((gv) => {
        const g = gv.partition.group
        const { kept, suspect } = gv.partition.part
        return (
          <section key={g.sourceId} className="novel-group">
            <header className="novel-group-head">
              <strong>{g.sourceName}</strong>
              {/* 状态走 bits.StatusBadge（文案随当前语言，原始状态字不进 UI） */}
              <StatusBadge status={g.status} />
              <span className="novel-muted">
                {suspect.length === 0
                  ? plural(t, kept.length, 'search.group.hits.one', 'search.group.hits.other', { n: kept.length })
                  : t('search.group.relevant', { n: kept.length, total: g.hits.length })}
              </span>
            </header>
            <div className="novel-list">
              {gv.keptRows.map((r, i) => <HitRow key={gv.keptKeys[i]} sourceId={r.sourceId} hit={r.hit} deps={deps}
                landing={landing} />)}
            </div>
            {suspect.length === 0 ? null : (
              <details className="novel-fail">
                <summary>{plural(t, suspect.length, 'search.group.suspect.one', 'search.group.suspect.other', { n: suspect.length })}</summary>
                <div className="novel-list novel-fail-list">
                  {gv.suspectRows.map((r, i) => <HitRow key={gv.suspectKeys[i]} sourceId={r.sourceId} hit={r.hit} deps={deps}
                    landing={landing} />)}
                </div>
              </details>
            )}
          </section>
        )
      })}
      {failed.length === 0 ? null : (
        <details className="novel-fail">
          <summary>{plural(t, failed.length, 'search.group.failed.one', 'search.group.failed.other', { n: failed.length })}</summary>
          <div className="novel-group novel-fail-list">
            {failed.map((gv) => {
              const g = gv.partition.group
              return (
                <div key={g.sourceId}>
                  <span>{g.sourceName}</span>
                  <span className="novel-err"> · {g.error?.code}</span>
                  <div className="novel-note-sm">
                    {g.error?.message}
                    {g.statusDetail === undefined ? null : t('search.statusDetail', { detail: g.statusDetail })}
                  </div>
                </div>
              )
            })}
          </div>
        </details>
      )}
    </div>
  )
}

/** 按书默认视图：一本一行；逐源那一档不删、降级到页尾折叠（见 `renderGroups`）。现场是页面
 *  顶层 memo 的那一份（`RoundView.bookViews`），渲染路径不重算。空视图**不接管说话权**：整轮
 *  都被判 suspect 时这里一物不摆；两条轴的数天生不等（这档数**本**，按源档数**条**）。
 *  超限那行报出全量本数（`total`）——只列前 SEARCH_BOOKS_CAP 会把「还有更多」读成「到此为止」。 */
function renderBooks(bookViews: BookView[], total: number, deps: RowActionDeps, landing: SearchLanding, t: Translate): ReactNode {
  if (bookViews.length === 0) return null
  return (
    <div className="novel-groups" data-novel-books>
      {bookViews.map((bv) => <BookRow key={bookRowKey(bv.book)} book={bv.book} rows={bv.rows} keys={bv.keys} seats={bv.seats} deps={deps} landing={landing} />)}
      {total > bookViews.length ? (
        <div className="novel-note-sm">{plural(t, total, 'search.books.capped.one', 'search.books.capped.other', { n: total, cap: SEARCH_BOOKS_CAP })}</div>
      ) : null}
    </div>
  )
}

/** 按书视图的一行：行头主钮（书名 + 「N 家源」 + 「展开 N 条」）+ 兄弟「都加架」，展开区是第二块。
 *  不用 `<details>`：它收起时不渲染非 summary 子元素，动作钮只能占行宽，展开区还得先渲染再藏。
 *  改为主钮 + `aria-expanded`；行形状沿用命中行口径（容器 + 主钮 + 兄弟动作钮，钮里不套钮）。
 *  刻意不给「读这本」：本仓没有能判源好坏的读数，书行替用户选一家就是把猜测写进界面。
 *  无障碍名走内容拼接（不写 aria-label），改可见字时名字跟着变，不立第二个主人。 */
function BookRow({ book, rows, keys, seats, deps, landing }: {
  book: MergedBook; rows: RowRef[]; keys: string[]; seats: Set<string>; deps: RowActionDeps
  landing: SearchLanding
}): ReactNode {
  const t = useCopy()
  const [open, setOpen] = useState(false)
  // 这一本的架位全集与「全落过了」的读数：钮的三态由后者决定（架位由轮级派生给）。
  const allLanded = seats.size > 0 && [...seats].every((id) => landing.landed.has(id))
  const adding = landing.adding.has(bookRowKey(book))
  /** 只发**有地址**且**这一轮还没落过架**的行：无 url 的不给动作，已落过的不重复写。选行、排队与
   *  在途读数住 `search-landing`，三笔回执账住 `search-view-model.addAllReceipt`；这里只接线与选通道。 */
  const addAll = (): void => {
    void (async () => {
      const receipt = await landing.addAll(bookRowKey(book), rows)
      // 零加成不许走成功通道：没发生的写入不报喜，没加成的交代由下面两条错误回执各说各的。
      if (receipt.newly.length > 0) {
        deps.pushOk(plural(t, receipt.newly.length, 'search.book.added.one', 'search.book.added.other', { n: receipt.newly.length, title: book.title }))
      }
      if (receipt.stillMissing > 0) {
        deps.pushError(plural(t, receipt.stillMissing, 'search.book.addFailed.one', 'search.book.addFailed.other', { n: receipt.stillMissing, total: seats.size }))
      }
      if (receipt.noAddress > 0) {
        deps.pushError(plural(t, receipt.noAddress, 'search.book.noAddress.one', 'search.book.noAddress.other', { n: receipt.noAddress }))
      }
    })()
  }
  return (
    <div className="novel-book-row" data-novel-book>
      <button
        className="novel-row-main novel-book-main"
        aria-expanded={open}
        onClick={() => { setOpen(v => !v) }}
      >
        <strong title={book.title}>{book.title}</strong>
        {/* 「N 家源」读 sourceCount（去重后的源），不是行数。 */}
        <span className="novel-muted novel-book-author" title={book.author ?? undefined}>
          {shortAuthor(book.author ?? t('search.book.unknownAuthor'), t)}
        </span>
        <span className="novel-muted novel-book-sources">
          {plural(t, book.sourceCount, 'search.book.sources.one', 'search.book.sources.other', { n: book.sourceCount })}
        </span>
        {/* 尾巴承诺的是**行**（条），不是家：这里摊开的就是一行一条，一家给两条同键写法就是两条；
            家数那笔账由行头读数报一次（行与家是两条读数，单位律的住址见 CONTEXT 的「作品视图（按书）」）。 */}
        <span className="novel-book-tail">
          <span className="novel-book-tail-label">
            {open
              ? plural(t, rows.length, 'search.book.collapse.one', 'search.book.collapse.other', { n: rows.length })
              : plural(t, rows.length, 'search.book.expand.one', 'search.book.expand.other', { n: rows.length })}
          </span>
          <span className="novel-book-chev" aria-hidden="true">▶</span>
        </span>
      </button>
      {/* 动作钮三态：都加架 → 加架中…（在途禁点）→ 都在架（这一本的架位全落过，再点也无一发可发）。
          终态不是装饰：加完了界面什么都不变，用户就只能再点一次拿重复写当反馈。 */}
      <button className="novel-btn sm" disabled={adding || allLanded} onClick={addAll}>
        {adding ? t('search.book.adding') : allLanded ? t('search.book.allAdded') : t('search.book.addAll')}
      </button>
      {open ? (
        <div className="novel-list">
          {rows.map((r, i) => <HitRow key={keys[i]} sourceId={r.sourceId} hit={r.hit} deps={deps}
            landing={landing} />)}
        </div>
      ) : null}
    </div>
  )
}
