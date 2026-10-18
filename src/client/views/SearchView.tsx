import type { ReactNode } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { mergeBooks } from '../../shared/merge-by-book.js'
import type { MergedRound } from '../../shared/merge-by-book.js'
import { partitionByRelevance } from '../../shared/relevance.js'
import type { RelevancePartition } from '../../shared/relevance.js'
import { SEARCH_BOOKS_CAP, paramRoutes, shelfBody } from '../../shared/wire.js'
import { prodJobViewDeps } from '../deps.js'
import type { JobViewDeps } from '../deps.js'
import { useSearchJob } from '../search-job.js'
import { navigate, routeStore, useStore } from '../store.js'
import { EmptyState, ProgressBar, SearchIcon, searchPct, StatusBadge } from './bits.js'
import type { MergedBook, MergedSource, SearchGroup, SearchHit } from './types.js'

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
 *  陈旧回调防线换了主人：轮次身份就是服务端 jobId，迟到的上一轮响应在 `search-job` 里按身份丢弃。 */

/** 一轮搜索的收口数字（进度条退场后仍在） */
interface SearchSummary { sources: number; hits: number; found: number; failed: number; relevant: number }

/** 一组命中的相关性分区（每组只算一次的现场） */
interface PartitionedGroup { group: SearchGroup; part: RelevancePartition }

/** 一轮结果的现场：分组本体 + 按组分区，另有轮级派生两份（归并结果与行元数据索引），
 *  全部 memo 在轮次身份上，只有轮真变才重算。为什么要 memo：SSE 每帧都发新的 round 对象
 *  （累积器只增不减、组按源只 emit 一次），打字也走同一棵重渲——不 memo 就是每帧每击键重付
 *  整轮派生（2026-10-13 实测：520 源 × 40 条的轮约 38 ms）。重算时各付几趟如实记：分区一趟、归并一趟
 *  （归并面自带逐组分区——`mergeBooks` 签名被工具面同吃，不在这吃这份现场）、行元数据索引一趟。
 *  归并面自带分区不是分叉：判据只有一处住址（`shared/relevance.ts`）且同入参同结果的纯函数，
 *  两条轴读到的「相关」因此不会分叉；收口行的「相关 x 条」与组头的「相关 x · 共 y」则读
 *  同一份分区，把「两个数对不上」从源头堵死。 */
interface RoundView { keyword: string; groups: SearchGroup[]; parts: PartitionedGroup[] }

/** 收口算式：sources = **真搜完并回来的组数**（不是本轮计划家数——停止的轮次里两者不等，
 *  报计划数就是谎报）；命中条数 = 各命中组之和；found = 有命中的源数；failed = 带 error 的组数；
 *  relevant = 默认视野会摆的条数——判据不在这里写第二份，只汇总分区结果
 *  （hits 与 relevant 两个数不一致时收口行必须并报，否则读成「结果又少了一批」）。
 *  与 `views/bits.tsx` 的 `jobPct` / `searchPct` 百分比算式不同源——
 *  这是**计数**不是百分比，只此一处。 */
function sumRound(parts: PartitionedGroup[]): SearchSummary {
  let hits = 0
  let found = 0
  let failed = 0
  let relevant = 0
  for (const { group, part } of parts) {
    if (group.error === undefined) {
      hits += group.hits.length
      found += 1
      relevant += part.kept.length
    } else failed += 1
  }
  return { sources: parts.length, hits, found, failed, relevant }
}

export function SearchView({ deps = prodJobViewDeps }: { deps?: JobViewDeps }): ReactNode {
  const { route } = useStore(routeStore)
  const initialKeyword = route.name === 'search' ? route.keyword ?? '' : ''
  const [keyword, setKeyword] = useState(initialKeyword)
  const { round, error, submit, cancel } = useSearchJob(deps)
  /** mount 提交的一次性闸：ref 防 StrictMode 同实例二次 effect；防重挂载的防线不在这里，
   *  在下面提交后立刻把 route.keyword 摘掉。 */
  const consumed = useRef<string | null>(null)
  useEffect(() => {
    if (initialKeyword === '' || consumed.current === initialKeyword) return
    consumed.current = initialKeyword
    submit(initialKeyword)
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
  /** 一轮的现场：分组 + 每组只算一次分区，两条轴与收口行都读这一份。
   *  memo 身份 = (轮次 id, 关键词, 组数)：组按源只 emit 一次、本轮只增不减，三者不变现场就不变；
   *  换轮必换 id，不存在「同 id 少了几组还被当没变」的形状（累积器由 `client/search-job.ts` 单点持有）。 */
  const view = useMemo<RoundView | null>(() => {
    if (round === null) return null
    return {
      keyword: round.keyword,
      groups: round.groups,
      parts: round.groups.map((g) => ({ group: g, part: partitionByRelevance(round.keyword, g.hits) })),
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [round?.id, round?.keyword, round?.groups.length])
  const merged = useMemo(() => (view === null ? null : mergeBooks(view.keyword, view.groups)), [view])
  const meta = useMemo(() => (view === null ? new Map<string, SearchHit>() : rowMeta(view.groups)), [view])
  /** 本轮挂载里已经落过架的架位（身份 = `rowId`，与行 key、回执计数同一个算式）。
   *  为什么住在视图这一层、而不是逐行自己记：① 展开区收起时整块离开 DOM（那是这一行的性能账），
   *  行自己的 state 会被卸载洗掉；② 「都加架」与「＋ 加书架」是同一件事的两个入口，各记一份就会
   *  出现批量加完、行上还写着「＋ 加书架」，按钮也就无从知道自己该退休。
   *  它只是**会话内读数**，不是书架真相：真相在 `Shelf`；本视图不预读它（SearchHit 没带在架标记），
   *  所以「这一发 PUT 我们发成功过」才是这份账的确切语义，写口幂等兜住其余。 */
  const [landed, setLanded] = useState<ReadonlySet<string>>(() => new Set())
  const markLanded = (id: string): void => {
    setLanded((prev) => (prev.has(id) ? prev : new Set(prev).add(id)))
  }
  const summary = view !== null && !running ? sumRound(view.parts) : null
  // 空参与集与「搜了没命中」是两件事：前者 total=0（源全停用/未导入），后者有源但零分组
  const emptyPlan = progress === null && round !== null && round.total === 0

  // 进度算式的单点在 bits.searchPct（按源数算 + clamp；与任务式的 jobPct 不同口径，已裁各自具名不合并）
  const pct = searchPct(round === null ? null : { done: round.done, total: round.total })
  const live = progress !== null
    ? (progress.total === 0
      ? <>正在启动搜索…</>
      : <>已搜 <b>{progress.done}</b>/{progress.total} 家书源 · 命中源会陆续出现在下方</>)
    : summary === null || summary.sources === 0 || merged === null
      ? null
      : <>
          {/* 视野收过一条时收口必须两个数并报：只报 hits 与默认视野对不上号。
              三个读数各数各的——家=搜过的组数、条=逐源命中（一行一条，一家可能给两条）、
              本=归并后的书目（收口里「本」只许出现在并书读数上）；「并成 N 本」在按书成了
              默认视图后必须报，否则一轮并掉多少无人知道（工具面恒报 N 本，两边不许不对称）。
              单位律的唯一住址是 CONTEXT 的「作品视图（按书）」词条，这里只落字不复述判据。 */}
          {round?.cancelled === true ? '已停止 · ' : ''}本轮搜过 <b>{summary.sources}</b> 家 · 命中 <b>{summary.hits}</b> 条 · 并成 <b>{merged.total}</b> 本
          {`（来自 ${summary.found} 家${summary.relevant < summary.hits ? `，其中相关 ${summary.relevant} 条、其余折叠可展开` : ''}）`} · <b>{summary.failed}</b> 家未响应
        </>
  return (
    <div data-novel-view="search" className="novel-view">
      <div className="novel-wrap">
        <div className="novel-search-bar">
          <button className="novel-btn" onClick={() => navigate({ name: 'shelf' })}>‹ 书架</button>
          <form
            onSubmit={(e) => { e.preventDefault(); submit(keyword) }}
            className="novel-search-form"
            aria-label="搜索书籍"
          >
            <label className="novel-searchbox">
              <SearchIcon />
              <input
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                placeholder="书名 / 作者"
                aria-label="搜索书籍"
              />
            </label>
            <button type="submit" className="novel-btn primary" disabled={running}>
              {running ? '搜索中…' : '搜索'}
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
              {running ? <button type="button" className="novel-btn sm" onClick={cancel}>停止搜索</button> : null}
            </div>
          )}
        </div>
        {error === null ? null : (
          <div className="novel-err novel-note-md">搜索中断：{error}</div>
        )}
        {view !== null && progress === null && view.groups.length === 0 && (
          emptyPlan
            ? <EmptyState title="没有参与搜索的书源" hint="全部书源都已停用，或尚未导入——书源在「小说 → 书源管理」中导入" />
            : <EmptyState title="没有结果" hint="换个关键词，或在「小说 → 书源管理」中导入更多书源" />
        )}
        {/* 按书在前：一本一行。整轮都被判 suspect 时这一档是空的（归并只收 kept），
            空视图不接管说话权——账由下面那一档与收口行报（收口的「并成 0 本」也在报这笔账），
            读起来不是「没有结果」。 */}
        {view !== null && merged !== null && renderBooks(merged, meta, deps, landed, markLanded)}
        {/* 逐源那一档不删、降级到页尾折叠：各家给了几条、哪一家未响应，仍是排查轴 */}
        {view !== null && view.parts.length !== 0 && (
          <details className="novel-fail" data-novel-per-source>
            <summary>按源看（{view.parts.length} 家 · 折叠）</summary>
            {renderGroups(view, deps, landed, markLanded)}
          </details>
        )}
      </div>
    </div>
  )
}

/** 加架的接线只此一份：路径与 body 都由 wire 的构造器给（行上「＋ 加书架」与书行「都加架」
 *  走同一条 PUT，服务端那一份 patch 语义因此不会长出第二种形状）。 */
function addBookToShelf(sourceId: string, hit: SearchHit, deps: JobViewDeps): Promise<unknown> {
  return deps.apiSend('PUT', paramRoutes.shelfKey(hit.url ?? ''), shelfBody.addBook({
    sourceId, title: hit.title, author: hit.author, coverUrl: hit.coverUrl,
    intro: hit.intro, lastChapterName: hit.lastChapterName, kind: hit.kind, wordCount: hit.wordCount,
  }))
}

/** 命中行：行内双动作——主按钮 = 加架并直接阅读；「＋ 加书架」只加架。
 * 结构：容器 .novel-row + 主钮 .novel-row-main + 兄弟动作钮（**不嵌套**）。
 * apiSend 经 deps 透传（行内接线同样可被测试驱动）。
 * 入架态由调用方给（`added` / `onLanded`，账住在 `SearchView` 那一层）：这一行会随展开区收起而
 * 卸载，自己记的账活不过一次折叠；而同一架位可能从「＋ 加书架」进来、也可能从「都加架」进来，
 * 两处各记一份就会互相看不见。
 * url 守卫：`null` 渲染不可点行（wire 给这一格的就是 `string | null`）；空串 `''` **产不出来**（命中行的 `url` 只出自服务端
 * 搜索链，空输入在那里就已落 `null`），于是「无身份」在浏览器半只有一种形状可认。 */
function HitRow({ sourceId, hit, deps, added, onLanded }: {
  sourceId: string; hit: SearchHit; deps: JobViewDeps; added: boolean; onLanded: (id: string) => void
}): ReactNode {
  const add = (): Promise<unknown> => addBookToShelf(sourceId, hit, deps).then(() => { onLanded(rowId(sourceId, hit.url)) })
  const read = (): void => {
    // 点行直接阅读：先加架（进度保存依赖书架条目）再进阅读器；已加过则幂等
    void add().catch(() => undefined).then(() => navigate({ name: 'reader', sourceId, bookKey: hit.url ?? '', title: hit.title }))
  }
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
  return (
    <div className="novel-row">
      <button className="novel-row-main" onClick={read} aria-label={`阅读 ${hit.title}`}>
        <span className="novel-hit-title">{hit.title}</span>
        <span className="novel-hit-sub">{sub}</span>
      </button>
      <button className="novel-btn sm" disabled={added} onClick={() => { void add().catch(() => undefined) }}>
        {added ? '已在书架' : '＋ 加书架'}
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
 *  行的 key 与按书轴展开区读同一个身份算式（`rowKeys`，身份 (源, 地址)，同身份重复才垫位次）：
 *  档序会挪位，纯下标 key 在重排时把一行的本地入架态串到别的书上。
 *  失败源折叠的呈现口径（点名 code / message / statusDetail）原样保留，仅容器换简约版类。 */
function renderGroups(view: RoundView, deps: JobViewDeps, landed: ReadonlySet<string>, onLanded: (id: string) => void): ReactNode {
  const hits = view.parts.filter((p) => p.group.error === undefined)
  const failed = view.parts.filter((p) => p.group.error !== undefined)
  if (hits.length === 0 && failed.length === 0) return null
  return (
    <div className="novel-groups">
      {hits.map(({ group: g, part }) => {
        const { kept, suspect } = part
        const keptKeys = rowKeys(kept.map((m) => ({ sourceId: g.sourceId, hit: m.hit })))
        const suspectKeys = rowKeys(suspect.map((m) => ({ sourceId: g.sourceId, hit: m.hit })))
        return (
          <section key={g.sourceId} className="novel-group">
            <header className="novel-group-head">
              <strong>{g.sourceName}</strong>
              {/* 状态走 bits.StatusBadge 的中文映射（verified→「可用」）——原始状态字不进 UI */}
              <StatusBadge status={g.status} />
              <span className="novel-muted">
                {suspect.length === 0 ? `${kept.length} 条` : `相关 ${kept.length} · 共 ${g.hits.length}`}
              </span>
            </header>
            <div className="novel-list">
              {kept.map((m, i) => <HitRow key={keptKeys[i]} sourceId={g.sourceId} hit={m.hit} deps={deps}
                added={landed.has(rowId(g.sourceId, m.hit.url))} onLanded={onLanded} />)}
            </div>
            {suspect.length === 0 ? null : (
              <details className="novel-fail">
                <summary>另有 {suspect.length} 条疑似无关（书名／作者／分类都不含关键词，展开照旧可点）</summary>
                <div className="novel-list novel-fail-list">
                  {suspect.map((m, i) => <HitRow key={suspectKeys[i]} sourceId={g.sourceId} hit={m.hit} deps={deps}
                    added={landed.has(rowId(g.sourceId, m.hit.url))} onLanded={onLanded} />)}
                </div>
              </details>
            )}
          </section>
        )
      })}
      {failed.length === 0 ? null : (
        <details className="novel-fail">
          <summary>{failed.length} 家书源未响应（多为站点不可达，展开看原因）</summary>
          <div className="novel-group novel-fail-list">
            {failed.map(({ group: g }) => (
              <div key={g.sourceId}>
                <span>{g.sourceName}</span>
                <span className="novel-err"> · {g.error?.code}</span>
                <div className="novel-note-sm">{g.error?.message}{g.statusDetail === undefined ? '' : `（${g.statusDetail}）`}</div>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  )
}

/** 按书默认视图：一本一行；逐源那一档不删、降级到页尾折叠（见 `renderGroups`）。
 *  入参是页面顶层 memo 化的两份轮级派生（归并结果与行元数据索引）——这一档不在渲染路径里
 *  重算自己那趟，SSE 帧与击键才不会各付一遍整轮归并。
 *  空视图**不接管说话权**：整轮都被判 suspect 时归并给出 0 本，这里就一物不摆——
 *  「这一轮到底有没有结果」由空态分支按分组判，账目由按源那一档与收口行报（含收口的「并成 0 本」），
 *  把「判掉了」写成「没有结果」就是空结果冒充失败（本仓定的最高罪）。
 *  两条轴的数天生不等，且不许掰平：这一档数的是**本**（归并后的书目），按源那一档与收口行数的是
 *  **条**（逐源命中，一行一条）——差额正是每一行那个「N 家源」吃进去的东西。
 *  超限那一行报出全量本数：只列前 SEARCH_BOOKS_CAP 而不说本轮共几本，
 *  就是把「还有更多」读成「到此为止」。 */
function renderBooks(merged: MergedRound, meta: Map<string, SearchHit>, deps: JobViewDeps,
  landed: ReadonlySet<string>, onLanded: (id: string) => void): ReactNode {
  if (merged.total === 0) return null
  return (
    <div className="novel-groups" data-novel-books>
      {merged.books.map((b) => <BookRow key={bookRowKey(b)} book={b} rows={bookRows(b, meta)} deps={deps} landed={landed} onLanded={onLanded} />)}
      {merged.total > merged.books.length ? (
        <div className="novel-note-sm">本轮共 {merged.total} 本，只列前 {SEARCH_BOOKS_CAP}（按相关性档 → 家数降序）</div>
      ) : null}
    </div>
  )
}

/** 按书行的 key：认那一本的名字对（书名, 作者），不认它排在第几。
 *  为什么：流式轮次里同档会按家数降序重排，位置 key 把展开态与入架态串到别的书上
 *  （用户展开的是甲，下一帧开着的成了乙）。归并键本就是规范化后的这对名字，两本不同的书
 *  不可能带同一对原样名字（规范化多对一，同原样必同键），因此无须再垫下标。 */
function bookRowKey(book: MergedBook): string {
  return JSON.stringify([book.title, book.author])
}

/** 一行的身份：(源, 地址)。建索引那一侧、取用那一侧、逐源行的 React key 都读这一个算式，
 *  两处各写一遍就等于给「哪一行属于哪一本」两个主人。 */
const rowId = (sourceId: string, url: string | null): string => JSON.stringify([sourceId, url])

/** 逐源行的 React key：身份走 `rowId`，只在同一身份于本行里重复出现时垫位次。
 *  地址为什么必须在 key 里：换一轮搜同一本书，同一家、同一下标可能给了另一个地址——
 *  不含地址的 key 认不出这是新行，于是它顶用上一行的「已在书架」，看着已架而那一发从未存在。
 *  为什么垫的是同身份内的位次、不是整行列号：一家给同一地址两种写法是既有形状
 *  （`rowMeta` 的「同址两行」口径），列号既会让两行撞同一个 key，也会因旁行挪位
 *  把自己那行的入架态洗成未加。 */
function rowKeys(rows: Array<{ sourceId: string; hit: SearchHit }>): string[] {
  const seen = new Map<string, number>()
  return rows.map((r) => {
    const id = rowId(r.sourceId, r.hit.url)
    const dup = seen.get(id) ?? 0
    seen.set(id, dup + 1)
    return dup === 0 ? id : `${id}#${dup}`
  })
}

/** 一本的逐源行 = 归并给的行身份 ＋ 从本轮命中回读的元数据；顺序跟着归并的到达序。
 *  回读而非抄一份：封面／简介／最新章这些**书架要存的字段**仍住在命中本身，
 *  把它们焊进 `MergedSource` 就是给同一份元数据第二个主人（归并面只答「这一家把它叫作什么」）。 */
function bookRows(book: MergedBook, meta: Map<string, SearchHit>): Array<{ sourceId: string; hit: SearchHit }> {
  return book.sources.map((s) => ({ sourceId: s.sourceId, hit: rowHit(s, meta.get(rowId(s.sourceId, s.url))) }))
}

/** (源, 地址) → 该条命中。同址两行取第一条的元数据：同一地址的封面本就是一份，
 *  而行上摆的名字仍按各自己那一条给。 */
function rowMeta(groups: SearchGroup[]): Map<string, SearchHit> {
  const by = new Map<string, SearchHit>()
  for (const g of groups) {
    for (const h of g.hits) {
      const id = rowId(g.sourceId, h.url)
      if (!by.has(id)) by.set(id, h)
    }
  }
  return by
}

/** 逐源行那张命中：名字一律用归并带来的那一份（两边的写法都要看得见），
 *  其余字段按 wire 的可空口径给——回读不到就是 null，不发明「缺键」这第三种形状。
 *  露在最上面那一行由首个到达的源定（取首条的裁决住在 `shared/merge-by-book.ts`），
 *  换一轮搜同一本书可能换个写法出现在书行上；逐源行各家写法都在，这里不抹平名字。 */
function rowHit(s: MergedSource, meta: SearchHit | undefined): SearchHit {
  return {
    title: s.title, author: s.author, url: s.url,
    coverUrl: meta?.coverUrl ?? null, intro: meta?.intro ?? null,
    lastChapterName: meta?.lastChapterName ?? null, kind: meta?.kind ?? null, wordCount: meta?.wordCount ?? null,
  }
}

/** 行上的作者读数：逗号级名单只留前两位，其余由「等」承担。
 *  为什么收：有的源把整张配音表塞进 `author`，而这一段住在主钮的内容里、也就是它的
 *  无障碍名——不收，读屏每本念一遍名单，视觉上还把尾巴与「都加架」顶下两行。收的不是信息：
 *  全串在 `title` 与展开后的逐源行里原样都在（那种长度的名单由
 *  `tests/client/views-wiring.test.tsx` 的「作者串是整张配音表那种长度」那条用例钉住）。
 *  只在逗号处切：「萧炎：锦鲤 药老：北炎」那种空格分隔的角色表切不出「第二位」，整串交给 CSS 省略号。 */
const shortAuthor = (author: string): string => {
  const head = /^\s*[^,，、]+\s*[,，、]\s*[^,，、]+/.exec(author)
  if (head === null || !/[,，、]/.test(author.slice(head[0].length))) return author
  return `${head[0].trimEnd()} 等`
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
function BookRow({ book, rows, deps, landed, onLanded }: {
  book: MergedBook; rows: Array<{ sourceId: string; hit: SearchHit }>; deps: JobViewDeps
  landed: ReadonlySet<string>; onLanded: (id: string) => void
}): ReactNode {
  const [adding, setAdding] = useState(false)
  const [open, setOpen] = useState(false)
  const keys = rowKeys(rows)
  // 这一本的架位全集（有地址的那些）与「全落过了」的读数：钮的三态由后者决定，不另立一份 state
  const shelfIds = new Set(rows
    .filter((r) => r.hit.url !== null)
    .map((r) => rowId(r.sourceId, r.hit.url)))
  const allLanded = shelfIds.size > 0 && [...shelfIds].every((id) => landed.has(id))
  /** 都加架逐条走既有 PUT：书架写口本就幂等，为这个动作开一条批量路由等于给「加架」第二个主人。
   *  只发**有地址**且**这一轮还没落过架**的那些行：无 url 的命中在行上本就不给动作（进不了架也
   *  进不了阅读器），替它发一发空架位 PUT 就是写进一条没有书面的架位，还要报「已加」；已落过的
   *  那条（多半是用户先单加过一条）再发一遍，就是把同一件事写成两次。
   *  没发出去的那几条不并入「失败」——没试过不是失败，点名说它没有地址。 */
  const addAll = (): void => {
    void (async () => {
      const addable = rows.filter((r) => r.hit.url !== null)
      const noAddress = rows.length - addable.length
      const todo = addable.filter((r) => !landed.has(rowId(r.sourceId, r.hit.url)))
      setAdding(true)
      const results = await Promise.allSettled(todo.map((r) => addBookToShelf(r.sourceId, r.hit, deps)))
      setAdding(false)
      // 回执数的是**这次新落架的架位**（身份走 `rowId`，与行 key 同一个算式）：一家两条同址写法
      // 发两发幂等 PUT 也只落一个架位——按成功 PUT 计数会把一个架位报成「已加 2 条」，虚报架上的账。
      // 行数那一笔账归「展开 N 条」与行头报（条＝行），这里不重复数行、只数落架。
      // 零加成不许走成功通道：整行没有地址与全部 PUT 失败读出来都是 0，「已加 0 条：X」等于给
      // 一次没发生的写入报喜，还把两种结局挤进同一句话。没加成的交代由另两条错误回执各说各的。
      const newly = new Set<string>()
      results.forEach((res, i) => {
        if (res.status === 'fulfilled') newly.add(rowId(todo[i].sourceId, todo[i].hit.url))
      })
      newly.forEach((id) => { onLanded(id) })
      if (newly.size > 0) deps.pushOk(`已加 ${newly.size} 条：${book.title}`)
      const stillMissing = [...shelfIds].filter((id) => !landed.has(id) && !newly.has(id)).length
      if (stillMissing > 0) deps.pushError(`加入失败 ${stillMissing} 条（共 ${shelfIds.size}）`)
      if (noAddress > 0) deps.pushError(`${noAddress} 条没有地址，加不了架`)
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
          {shortAuthor(book.author ?? '作者未给')}
        </span>
        <span className="novel-muted novel-book-sources">· {book.sourceCount} 家源</span>
        {/* 尾巴承诺的是**行**（条），不是家：这里摊开的就是一行一条，一家给两条同键写法就是两条；
            家数那笔账由行头读数报一次（行与家是两条读数，单位律的住址见 CONTEXT 的「作品视图（按书）」）。 */}
        <span className="novel-book-tail">
          <span className="novel-book-tail-label">{open ? '收起' : '展开'} {rows.length} 条</span>
          <span className="novel-book-chev" aria-hidden="true">▶</span>
        </span>
      </button>
      {/* 动作钮三态：都加架 → 加架中…（在途禁点）→ 都在架（这一本的架位全落过，再点也无一发可发）。
          终态不是装饰：加完了界面什么都不变，用户就只能再点一次拿重复写当反馈。 */}
      <button className="novel-btn sm" disabled={adding || allLanded} onClick={addAll}>
        {adding ? '加架中…' : allLanded ? '都在架' : '都加架'}
      </button>
      {open ? (
        <div className="novel-list">
          {rows.map((r, i) => <HitRow key={keys[i]} sourceId={r.sourceId} hit={r.hit} deps={deps}
            added={landed.has(rowId(r.sourceId, r.hit.url))} onLanded={onLanded} />)}
        </div>
      ) : null}
    </div>
  )
}
