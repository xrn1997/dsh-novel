import type { ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { paramRoutes, shelfBody } from '../../shared/wire.js'
import { prodCoreDeps } from '../deps.js'
import type { ClientCoreDeps } from '../deps.js'
import { useSearchJob } from '../search-job.js'
import { navigate, routeStore, useStore } from '../store.js'
import { EmptyState, ProgressBar, SearchIcon, StatusBadge } from './bits.js'
import type { SearchGroup, SearchHit } from './types.js'

/** 搜索：提交一轮**后台任务**（Node 半跑完并持有整轮结果）+ 按游标轮询增量渲染 + 逐源分组（失败组折叠）。
 *  呈现口径不变：进度一条线 + 灰字、组头=源名+状态徽标+灰字计数、命中行 hover 行式、
 *  失败源收一行 details。测试钉子：placeholder「书名 / 作者」、form aria-label「搜索书籍」
 *  （getByRole('form') 依赖）、空态两分支文案原文。
 *  在途循环的归属已搬走：本组件不再持有批请求，只 `POST search/job` + 读 `search/job-status`
 *  （接线在 `client/search-job.ts`）。为什么搬：宿主 `conversation.view` 一次只渲染一个视图，
 *  切 tab 即卸载——原先结果随组件清零、整轮重打（实测）。现在切走只是没人看，切回来从 `since=0`
 *  重拉一遍即可恢复（本轮真实参搜数、已完成数、命中分组全在快照里）。
 *  陈旧回调防线换了主人：轮次身份就是服务端 jobId，迟到的上一轮响应在 `search-job` 里按身份丢弃。 */

/** 一轮搜索的收口数字（进度条退场后仍在） */
interface SearchSummary { sources: number; hits: number; found: number; failed: number }

/** 收口算式：sources = **真搜完并回来的组数**（不是本轮计划家数——停止的轮次里两者不等，
 *  报计划数就是谎报）；命中本数 = 各命中组之和；found = 有命中的源数；failed = 带 error 的组数。
 *  与 known-开口 #4 的「三处百分比各算一份」不同源——这是**计数**不是百分比，只此一处。 */
function sumRound(groups: SearchGroup[]): SearchSummary {
  let hits = 0
  let found = 0
  let failed = 0
  for (const g of groups) {
    if (g.error === undefined) { hits += g.hits.length; found += 1 } else failed += 1
  }
  return { sources: groups.length, hits, found, failed }
}

export function SearchView({ deps = prodCoreDeps }: { deps?: ClientCoreDeps }): ReactNode {
  const { route } = useStore(routeStore)
  const initialKeyword = route.name === 'search' ? route.keyword ?? '' : ''
  const [keyword, setKeyword] = useState(initialKeyword)
  const { round, error, submit, cancel } = useSearchJob(deps)
  useEffect(() => { if (initialKeyword !== '') submit(initialKeyword) }, [])   // eslint-disable-line react-hooks/exhaustive-deps

  const running = round !== null && round.running
  const progress = round !== null && round.running ? { done: round.done, total: round.total } : null
  const summary = round !== null && !running ? sumRound(round.groups) : null
  const groups = round?.groups ?? null
  // 空参与集与「搜了没命中」是两件事：前者 total=0（源全停用/未导入），后者有源但零分组
  const emptyPlan = progress === null && round !== null && round.total === 0

  // 进度只此一个算式：自然收尾时 done==total，满格是**算出来的**而不是写死的；
  // 被停止的轮次于是照实停在它真正走到的位置（曾写死收尾态 100%，29/431 也显示满格）
  const pct = round === null || round.total === 0
    ? 0
    : Math.min(100, Math.round((round.done / round.total) * 100))
  const live = progress !== null
    ? (progress.total === 0
      ? <>正在启动搜索…</>
      : <>已搜 <b>{progress.done}</b>/{progress.total} 家书源 · 命中源会陆续出现在下方</>)
    : summary === null || summary.sources === 0
      ? null
      : <>{round?.cancelled === true ? '已停止 · ' : ''}本轮搜过 <b>{summary.sources}</b> 家 · 命中 <b>{summary.hits}</b> 本（来自 {summary.found} 家）· <b>{summary.failed}</b> 家未响应</>
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
        {groups !== null && progress === null && groups.length === 0 && (
          emptyPlan
            ? <EmptyState title="没有参与搜索的书源" hint="全部书源都已停用，或尚未导入——书源在「小说 → 书源管理」中导入" />
            : <EmptyState title="没有结果" hint="换个关键词，或在「小说 → 书源管理」中导入更多书源" />
        )}
        {groups !== null && renderGroups(groups, deps)}
      </div>
    </div>
  )
}

/** 命中行：行内双动作——主按钮 = 加架并直接阅读；「＋ 加书架」只加架。
 * 结构：容器 .novel-row + 主钮 .novel-row-main + 兄弟动作钮（**不嵌套**）。
 * apiSend 经 deps 透传（行内接线同样可被测试驱动）。
 * url 守卫口径现状：undefined/null 渲染不可点行；空串 '' 的问题是 client.md 已知开口
 * 「`hit.url` 是空串时会用空 bookKey 加书」，本轮呈现层重构不改该口径（修法需 wire/守卫二选一拍板）。 */
function HitRow({ sourceId, hit, deps }: { sourceId: string; hit: SearchHit; deps: ClientCoreDeps }): ReactNode {
  const [added, setAdded] = useState(false)
  const add = (): Promise<void> => {
    const bookKey = hit.url ?? ''
    return deps.apiSend('PUT', paramRoutes.shelfKey(bookKey), shelfBody.addBook({
      sourceId, title: hit.title, author: hit.author, coverUrl: hit.coverUrl,
      intro: hit.intro, lastChapterName: hit.lastChapterName,
    })).then(() => { setAdded(true) })
  }
  const read = (): void => {
    // 点行直接阅读：先加架（进度保存依赖书架条目）再进阅读器；已加过则幂等
    void add().catch(() => undefined).then(() => navigate({ name: 'reader', sourceId, bookKey: hit.url ?? '', title: hit.title }))
  }
  const sub = `${hit.author ?? ''}${hit.lastChapterName === undefined ? '' : ` · ${hit.lastChapterName}`}`
  if (hit.url === undefined || hit.url === null) {
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

/** 分组渲染：有命中的源成组（组头=源名+状态徽标+灰字计数）；失败源折叠一行 details——
 *  失败折叠的呈现口径（点名 code / message / statusDetail）原样保留，仅容器换简约版类。
 *  组头原先「绿点 + 带点的状态徽标」双重点：点不携带徽标之外的信息，去掉。 */
function renderGroups(groups: SearchGroup[], deps: ClientCoreDeps): ReactNode {
  const hits = groups.filter((g) => g.error === undefined)
  const failed = groups.filter((g) => g.error !== undefined)
  if (hits.length === 0 && failed.length === 0) return null
  return (
    <div className="novel-groups">
      {hits.map((g) => (
        <section key={g.sourceId} className="novel-group">
          <header className="novel-group-head">
            <strong>{g.sourceName}</strong>
            {/* 状态走 bits.StatusBadge 的中文映射（verified→「可用」）——原始状态字不进 UI */}
            <StatusBadge status={g.status} />
            <span className="novel-muted">{g.hits.length} 本</span>
          </header>
          <div className="novel-list">
            {g.hits.map((h, i) => <HitRow key={i} sourceId={g.sourceId} hit={h} deps={deps} />)}
          </div>
        </section>
      ))}
      {failed.length === 0 ? null : (
        <details className="novel-fail">
          <summary>{failed.length} 家书源未响应（多为站点不可达，展开看原因）</summary>
          <div className="novel-group novel-fail-list">
            {failed.map((g) => (
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
