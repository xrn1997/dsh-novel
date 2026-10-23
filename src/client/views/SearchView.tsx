import type { ReactNode } from 'react'
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { SEARCH_BOOKS_CAP } from '../../shared/wire.js'
import { describeError } from '../api.js'
import { plural, useCopy } from '../copy/index.js'
import type { Translate } from '../copy/index.js'
import { searchSummarySegments } from '../copy/search-summary.js'
import { prodJobViewDeps } from '../deps.js'
import type { JobViewDeps, RowActionDeps } from '../deps.js'
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

/** 搜索：提交一轮**后台任务**（Node 半跑完并持有整轮结果）+ 按游标轮询增量渲染 +
 *  默认按书一行、逐源那一档降级成页尾折叠（失败源折叠仍在它里面）。
 *  为什么两条轴都要在：500 多家逐源列要翻两千屏，而「源好坏各自可见」是这条链路的排查轴——
 *  降级不是删除，删掉它就是把排查轴换成猜测轴。
 *  呈现口径不变：进度一条线 + 灰字、组头=源名+状态徽标+灰字计数、命中行 hover 行式、
 *  失败源收一行 details。测试钉子：placeholder「书名 / 作者」、form aria-label「搜索书籍」
 *  （getByRole('form') 依赖）、空态两分支文案原文。
 *  在途循环的归属已搬走：本组件不再持有批请求，只 `POST search/job` + 读 `search/job-status`
 *  （接线在 `client/search-job.ts`）。为什么搬：宿主 `conversation.view` 一次只渲染一个视图，
 *  切 tab 即卸载——原先结果随组件清零、整轮重打（实测）。现在切走只是没人看，切回来从 `since=0`
 *  重拉一遍即可恢复（本轮真实参搜数、已完成数、命中分组全在快照里）。
 *  陈旧回调防线换了主人：轮次身份就是服务端 jobId，迟到的上一轮响应在 `search-job` 里按身份丢弃。
 *  轮级派生的住址也不在本文件：收口计数住 `shared/round-summary.ts`，两条轴的行身份与逐源回读
 *  住 `search-view-model.ts`。 */

export function SearchView({ deps = prodJobViewDeps }: { deps?: JobViewDeps }): ReactNode {
  const t = useCopy()
  const { route } = useStore(routeStore)
  const initialKeyword = route.name === 'search' ? route.keyword ?? '' : ''
  const [keyword, setKeyword] = useState(initialKeyword)
  const { round, error, submit, cancel } = useSearchJob(deps, t)
  /** mount 提交的一次性闸：ref 防 StrictMode 同实例二次 effect；防重挂载的防线不在这里，
   *  在下面提交后立刻把 route.keyword 摘掉。 */
  const consumed = useRef<string | null>(null)
  useEffect(() => {
    if (initialKeyword === '' || consumed.current === initialKeyword) return
    consumed.current = initialKeyword
    void submit(initialKeyword)
    // route.keyword 只消费一次，提交即摘除：routeStore 是跨卸载存活的现场（store.ts），
    // 不摘的话「退出小说界面再进（route 还带着关键词重新挂载）」与「从书架新鲜跳入」在
    // 挂载时不可分——重挂载会无条件重新提交，而服务端搜索读面是单槽（services/search-job.ts
    // 的 start：新提交即替换，旧轮在跑则被杀），整轮从头重搜（真机实测 bug）。摘除后重挂载
    // 只剩 search-job.ts 的「挂载即恢复」一条路：读 since=0 快照、零提交。
    navigate({ name: 'search' })
  }, [])   // eslint-disable-line react-hooks/exhaustive-deps
  /** 恢复轮次时回填搜索框（每挂载至多一次、只在框为空时）：重挂载 route 已无关键词，
   *  恢复出的结果若配一个空输入框，看起来像没搜过；不抢用户正在输入的内容。 */
  const filled = useRef(false)
  useEffect(() => {
    if (round === null || filled.current || keyword !== '') return
    filled.current = true
    setKeyword(round.keyword)
  }, [round])   // eslint-disable-line react-hooks/exhaustive-deps

  const running = round !== null && round.running
  const progress = round !== null && round.running ? { done: round.done, total: round.total } : null
  /** 一轮的现场：memo 身份 = (轮次 id, 关键词, 组数)——组按源只 emit 一次、本轮只增不减，
   *  三者不变现场就不变；换轮必换 id，不存在「同 id 少了几组还被当没变」的形状
   *  （累积器由 `client/search-job.ts` 单点持有）。派生本身在 `search-view-model.deriveRound`。 */
  const view = useMemo<RoundView | null>(() => (round === null ? null : deriveRound(round)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [round?.id, round?.keyword, round?.groups.length])
  /** 落架现场（哪些架位落过、哪一本的在途）与两条加架入口的排队住 `search-landing.ts`；
   *  写口仍是 `addShelfSeat`，视图只把它包成 `addSeat` 注入，并保留回执的措辞与通道。 */
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
          {/* 视野收过一条时收口必须两个数并报：只报 hits 与默认视野对不上号。
              三个读数各数各的——家=搜过的组数、条=逐源命中（一行一条，一家可能给两条）、
              本=归并后的书目（收口里「本」只许出现在并书读数上）；「并成 N 本」在按书成了
              默认视图后必须报，否则一轮并掉多少无人知道（工具面恒报 N 本，两边不许不对称）。
              单位律的唯一住址是 CONTEXT 的「作品视图（按书）」词条，这里只落字不复述判据。
              语法不在视图里拼：整句模板与子句键住 `copy/search.ts`，按模板组装成段的唯一实现是
              `copy/search-summary.ts` 的 `searchSummarySegments`；这里只把数字交给它。emphasis 段
              （搜过/命中/并成/未响应的数字）渲染成 b，其余段是纯文本节点（包 span 会让 getByText
              命中子元素，整句的父容器反而查不到）。 */}
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
              {/* 停止 = 不再往下搜，**已搜出来的全部留下**（服务端只进终态、不清结果）；
                  钮只在跑着时出现，收口行不留「再点一下」的死钮 */}
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
        {/* 按书在前：一本一行。整轮都被判 suspect 时这一档是空的（归并只收 kept），
            空视图不接管说话权——账由下面那一档与收口行报（收口的「并成 0 本」也在报这笔账），
            读起来不是「没有结果」。 */}
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

/** 命中行：行内双动作——主按钮 = 加架并直接阅读；「＋ 加书架」只加架。
 * 结构：容器 .novel-row + 主钮 .novel-row-main + 兄弟动作钮（**不嵌套**）。
 * apiSend 经 deps 透传（行内接线同样可被测试驱动）。
 * 入架态由调用方给的 `landing` 给（账住在行之上：这一行会随展开区收起而卸载，自己记的账
 * 活不过一次折叠；同一架位也可能从「都加架」进来，两处各记一份就会互相看不见）。
 * url 守卫：`null` 渲染不可点行（wire 给这一格的就是 `string | null`）；空串 `''` **产不出来**（命中行的 `url` 只出自服务端
 * 搜索链，空输入在那里就已落 `null`），于是「无身份」在浏览器半只有一种形状可认。 */
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
  /** 单行加架：落架记账归 `landing`，失败上报留在行上（这一发的措辞属于视图），两种结局都交回
   *  调用方（点行阅读要据此照走导航）。失败不静默：这是用户明确点出来的写操作，吞掉它等于让
   *  「＋ 加书架」看似没反应。 */
  const add = async (): Promise<ShelfAddOutcome> => {
    const outcome = await landing.add({ sourceId, hit })
    if (!outcome.ok) deps.pushError(t('search.shelf.addFailed', { detail: describeError(outcome.error, t) }))
    return outcome
  }
  /** 点行直接阅读：先加架（进度保存依赖书架条目）再进阅读器。导航是**两种结局**的收尾：
   *  加架失败的回执已由 `add` 报过；而 `add` 自己虽不抛（`addShelfSeat` 把成败收成返回值），
   *  它的记账/上报回调可能抛——拒绝分支不接住，导航就被一条回调挡在门外，rejection 还会逃成
   *  无人处理的一发。 */
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
      {/* 兄弟入口没有后续动作：回执回调自己抛错时这一发只许就地咽掉（add 的失败已上报过），
          不许像旧实现那样裸 `void add()` 漏成无人处理的 rejection。 */}
      <button className="novel-btn sm" disabled={landing.isLanded(hit)} onClick={() => { void add().catch(() => undefined) }}>
        {landing.isLanded(hit) ? t('search.shelf.added') : t('search.shelf.add')}
      </button>
    </div>
  )
}

/** 按源那一档（如今是页尾折叠里的内容）：逐源分组，默认视野只摆 kept（判据与档序的唯一住址在
 *  `shared/relevance`，这里只消费页面顶层算好的那一份分区），suspect 收进组内一行折叠——
 *  「一条都没被判掉」与「判掉了但还在」是两件事，后者写成前者就等于空结果冒充失败；
 *  折叠区里的行保留全部动作（HitRow 一字不动），判为疑似不夺走「读这本 / ＋架」。
 *  计数两个数都给、单位是**条**不是本（这一档数的是这一家给出的行，律见 CONTEXT 的「作品视图（按书）」）：
 *  只报相关数会让人以为这一家就给了这么多条。
 *  行与行 key 由轮级派生预计算（`search-view-model.ts` 的 `GroupView`，算式住 `rowKeys`）：档序会挪位，
 *  纯下标 key 在重排时把一行的本地入架态串到别的书上。
 *  失败组也留在 `groupViews` 里，由本函数按 `error` 挪进失败折叠——派生不替视图决定摆哪一档；
 *  失败源折叠的呈现口径（点名 code / message / statusDetail）原样保留，仅容器换简约版类。 */
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

/** 按书默认视图：一本一行；逐源那一档不删、降级到页尾折叠（见 `renderGroups`）。
 *  现场是页面顶层 memo 化的那一份（`RoundView.bookViews`）：逐源行、行 key 与架位全集都已随轮级派生
 *  算齐——这一档不在渲染路径里重算自己那趟，SSE 帧与击键才不会各付一遍整轮归并。
 *  空视图**不接管说话权**：整轮都被判 suspect 时归并给出 0 本，这里就一物不摆——
 *  「这一轮到底有没有结果」由空态分支按分组判，账目由按源那一档与收口行报（含收口的「并成 0 本」），
 *  把「判掉了」写成「没有结果」就是空结果冒充失败（本仓定的最高罪）。
 *  两条轴的数天生不等，且不许掰平：这一档数的是**本**（归并后的书目），按源那一档与收口行数的是
 *  **条**（逐源命中，一行一条）——差额正是每一行那个「N 家源」吃进去的东西。
 *  超限那一行报出全量本数（`total`）：只列前 SEARCH_BOOKS_CAP 而不说本轮共几本，
 *  就是把「还有更多」读成「到此为止」。 */
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

/** 按书视图的一行：行头主钮（书名 + 「N 家源」读数 + 尾巴上的「展开 N 条」）+ 兄弟「都加架」，
 *  展开区是这一行的第二块。
 *  为什么不用 `<details>`：它收起时不渲染非 summary 子元素——动作钮只能作为兄弟占掉行宽，
 *  展开区就少一条宽度，而整本逐源行还得先渲染进 DOM 再藏起来（默认视图上限 `SEARCH_BOOKS_CAP` 本）。
 *  换成主钮 + `aria-expanded`：展开区整幅铺开、收起时一物不摆，两颗钮在无障碍树里平级、
 *  名字互不污染（钮塞进 summary 的那条路，名字里会多出「都加架」要盖）。
 *  行形状沿用命中行那条口径（容器 + 主钮 + 兄弟动作钮，钮里不套钮），不给这一轴新造第三种。
 *  刻意不给「读这本」：本仓没有能判源好坏的读数（探针 verified 只证搜索面），书行替用户选一家
 *  就是把猜测写进界面——动作全在展开后的逐源行里（同一裁决见 `shared/merge-by-book.ts`）。
 *  无障碍名走内容拼接（不写 aria-label）：行上可见的就是「书名 + 作者 · N 家源 + 展开 N 条」，
 *  再抄一份进 aria-label 就是给同一批读数第二个主人——改了可见字忘了改名字即分叉。
 *  尾巴的字随状态翻（展开↔收起），可见标签因此恒含在名字里；箭头是同一状态的第二个读数。 */
function BookRow({ book, rows, keys, seats, deps, landing }: {
  book: MergedBook; rows: RowRef[]; keys: string[]; seats: Set<string>; deps: RowActionDeps
  landing: SearchLanding
}): ReactNode {
  const t = useCopy()
  const [open, setOpen] = useState(false)
  // 这一本的架位全集与「全落过了」的读数：钮的三态由后者决定，不另立一份 state
  // （架位全集由轮级派生给，`BookView.seats`；在途读数逐本记在 `landing.adding`）
  const allLanded = seats.size > 0 && [...seats].every((id) => landing.landed.has(id))
  const adding = landing.adding.has(bookRowKey(book))
  /** 只发**有地址**且**这一轮还没落过架**的行：无 url 的命中在行上本就不给动作（进不了架也
   *  进不了阅读器），替它发一发空架位 PUT 就是写进一条没有书面的架位，还要报「已加」；已落过的
   *  那条（多半是用户先单加过一条）再发一遍，就是把同一件事写成两次。选行、排队与在途读数住
   *  `search-landing`，三笔回执账（新落架 / 仍缺 / 无地址）的算式住 `search-view-model.addAllReceipt`；
   *  这里只接线与选通道：加成的报成功，没加成的报失败，没发出去的单独点名（没试过不是失败）。 */
  const addAll = (): void => {
    void (async () => {
      const receipt = await landing.addAll(bookRowKey(book), rows)
      // 零加成不许走成功通道：整行没有地址与全部 PUT 失败读出来都是 0，「已加 0 个架位：X」等于给
      // 一次没发生的写入报喜。没加成的交代由下面两条错误回执各说各的。
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
        {/* 「N 家源」读 sourceCount（去重后的源），不是行数：读行数会把一家撞两种写法的源报成两家。
            作者与家数是两段独立读数而非一条拼好的串：作者那一段会省略号，捆在一起就把家数也吃掉。 */}
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
