import type { ReactNode } from 'react'
import { useState } from 'react'
import { partitionByRelevance } from '../../shared/relevance.js'
import type { ExploreBook, SearchGroup, SearchHit } from '../../shared/wire.js'
import { describeError } from '../api.js'
import { cityMeta, sheetKeyword } from '../city-view-model.js'
import { plural, useCopy, zhTranslate } from '../copy/index.js'
import type { Translate } from '../copy/index.js'
import type { JobViewDeps, RowActionDeps } from '../deps.js'
import { useSearchJob } from '../search-job.js'
import { markPanelShelfLanded } from '../panel-shelf.js'
import { addShelfSeat } from '../shelf-action.js'
import { navigate } from '../store.js'
import { Dialog } from './dialog.js'

/**
 * 书籍详情浮层：一本**已经点名的源上的书**的落点——读这本、加入书架、跨源找这本。
 * 源不在这层点名：浏览轴按源，源在左栏第一层就点完名了。
 *
 * 四条口径：
 * ① 该源上的书地址缺席 ⇒ 一个按钮都不给（读与架共用这条守卫），那一行照样列出。
 * ② **跨源是用户主动发起的**：走搜索面既有链（`useSearchJob` + `sheetKeyword`），不新造第二条
 *    跨源遍历；搜索面只有一个槽，故还多一条身份守卫：只认本层 POST 回来的 jobId。
 * ③ 跨源结果**不替用户判是不是同一本书**（`ADR-0027` 同族纪律），按源一行行列出来；
 *    判据与档序在 `shared/relevance`，判掉的只换位置不消失。这一层一家只给一行。
 * ④ 四种说法各说各的：进行中 / 零命中 / 有源没响应 / 本源可读。停止不是失败；一家没被问到
 *    不是「搜了没命中」；答了零条不是「没响应」。零命中那句只在真有答复时才说。
 *
 * 浮层是覆盖层：遮罩、Esc、入场焦点、Tab 圈与关后还焦都是**模态契约**的落点（`views/dialog.tsx`）。
 * **一次跨源会换掉搜索面的那一轮**（单槽，`ADR-0046` / `ADR-0028` 的既有裁决，不是缺陷）。
 */
export function CityBookSheet({ book, sourceId, sourceName, deps, onClose }: {
  book: ExploreBook; sourceId: string; sourceName: string; deps: JobViewDeps; onClose: () => void
}): ReactNode {
  const t = useCopy()
  // 恢复读只落快照、不开观察通道：本层只认自己 POST 回来的 ownId，恢复读到的那轮一条都展示不了。
  const search = useSearchJob(deps, t, { resume: false })
  /** 按过那颗钮才算「要跨源」：在那之前搜索面持有的轮次不是本浮层的读数，一条都不列 */
  const [asked, setAsked] = useState(false)
  /** 本浮层最近一次成功 POST 回来的轮次 id（同关键词的别人那轮不认）。 */
  const [ownId, setOwnId] = useState<string | null>(null)

  /** 跨源那一次的关键词，本层只在这里向 `sheetKeyword` 取一次；本轮身份认 `ownId`，不是这个串。 */
  const keyword = sheetKeyword(book)
  /** 本轮身份守卫：服务端只有一个槽、观察者跟随最近一轮（`ADR-0046`），本层只认自己 POST 回来的
   *  jobId——关键词相同也不是身份。**不顺手 cancel**：那是别人正在看的轮次。 */
  const round = search.round
  const ownRound = round !== null && ownId !== null && round.id === ownId ? round : null
  const groups = ownRound?.groups ?? []
  const start = (): void => {
    setAsked(true)
    // 迟到回包由 `useSearchJob` 的起跑序号挡住；这里拿到非 null 即本轮，`ownRound` 再比一次 id。
    void search.submit(keyword).then((id) => { if (id !== null) setOwnId(id) })
  }
  /** 零命中判据：**至少一家干净答了**，且答了的那些家全都零条命中——否则「没有一家搜到」
   *  会与一整屏未响应同屏，把「没答」念成「没搜到」。 */
  const answered = groups.filter((g) => g.error === undefined)
  const zeroHits = answered.length > 0 && answered.every((g) => g.hits.length === 0)
  const meta = cityMeta(book)
  return (
    <Dialog title={book.name} label={t('city.details', { title: book.name })} variant="drawer" onClose={onClose}>
      <div className="novel-city-bookhead">
        {/* 元信息与卡片同源（`cityMeta`）：同一本书在两个地方写法不一致就是两份抄本 */}
        {meta === '' ? null : <div className="novel-city-bookhead-meta">{meta}</div>}
        {/* 整段简介在这里给（卡片那一行只夹一行）：文字是分类页那一条命中带来的，本层不另发详情面请求 */}
        {book.intro === null || book.intro === '' ? null : (
          <div className="novel-city-bookhead-meta">{book.intro}</div>
        )}
        <div className="novel-city-tags">
          {/* 源名不在这里重复：本源那一行已经点了它的名，同一层浮层里说两遍就是抄本 */}
          {book.lastChapter === null || book.lastChapter === '' ? null : <span className="novel-city-tag">{t('city.sheet.latestTag', { chapter: book.lastChapter })}</span>}
        </div>
      </div>
      {/* 本源那一行：与跨源那些行走同一个渲染器、同一对动作、同一条地址守卫。
          「最新」不在这里重复——头部那颗 tag 已经把这本书的最新章整句说过了（同一层浮层里说两遍
          就是抄本，源名同理，见上面那条）。372px 的一行装不下「源名 + 整句最新 + 两颗钮」，
          该退让的次序是：先让重复的那句，再让长补充，源名与两颗钮都不许动。 */}
      <div className="novel-city-srclist">
        <SheetRow row={ownRow(book, sourceId, sourceName)} deps={deps} showLast={false} />
      </div>
      <button className="novel-btn" onClick={start}>
        {asked && ownRound?.running === true ? t('city.findElsewhere.running') : t('city.findElsewhere')}
      </button>
      {asked ? (
        <>
          {ownRound !== null && ownRound.running ? (
            <div className="novel-city-progress">
              <span className="novel-muted">
                {/* 参搜家数由服务端 searchPlan 说了算：首帧之前手上还没有这个数。 */}
                {ownRound.total === 0
                  ? t('city.cross.starting')
                  : plural(t, ownRound.total, 'city.cross.progress.one', 'city.cross.progress.other', { done: ownRound.done, n: ownRound.total })}
              </span>
              <button className="novel-btn sm" onClick={() => { search.cancel() }}>{t('city.cross.stop')}</button>
            </div>
          ) : null}
          {search.error === null ? null : (
            <div className="novel-err novel-note-sm">{t('city.cross.interrupted', { detail: search.error })}</div>
          )}
          {/* 收口的三种说法互不冒充：被停止 ≠ 问完了没货，一家没被问到 ≠ 搜了没命中。 */}
          {ownRound !== null && !ownRound.running && ownRound.cancelled ? (
            <div className="novel-muted novel-note-sm">{t('city.cross.stopped')}</div>
          ) : null}
          {ownRound !== null && !ownRound.running && !ownRound.cancelled && ownRound.total === 0 ? (
            <div className="novel-muted novel-note-sm">{t('city.cross.noSources')}</div>
          ) : null}
          {ownRound !== null && !ownRound.running && !ownRound.cancelled && ownRound.total > 0 && zeroHits ? (
            <div className="novel-muted novel-note-sm">{t('city.cross.zeroHits')}</div>
          ) : null}
          {/* 各源命中就地长在同一列：一行一个源，不并成一条、不给源排序、不标「推荐这一本」。 */}
          {groups.length === 0 ? null : (
            <div className="novel-city-srclist">
              {groups.map((g) => <GroupRow key={g.sourceId} group={g} keyword={keyword} deps={deps} />)}
            </div>
          )}
        </>
      ) : null}
    </Dialog>
  )
}

/** 浮层里的一行 = 「某个源上的这一本」。本源那行与各源命中行共用这一个形状、这一对动作，
 *  于是地址守卫只有一处落点。 */
interface SheetRowData {
  sourceId: string
  sourceName: string
  /** 行上替用户补的那句话：本源那行不补（头部已报书名）；跨源那行补「这一家把它叫作什么」。 */
  listed: string | null
  title: string
  author: string | null
  /** 该源上的书地址：书籍身份 + 阅读入口；缺席即两个动作都不给 */
  url: string | null
  /** 行名与 `SearchHit` / `ShelfMetaPatch` 同字（`lastChapterName`）：与命中同一个形状，入架时不必再列字段位。 */
  lastChapterName: string | null
  coverUrl: string | null
  intro: string | null
  kind: string | null
  wordCount: string | null
}

function ownRow(book: ExploreBook, sourceId: string, sourceName: string): SheetRowData {
  return {
    sourceId, sourceName, listed: null, title: book.name, author: book.author, url: book.bookUrl,
    lastChapterName: book.lastChapter, coverUrl: book.coverUrl, intro: book.intro,
    kind: book.kind, wordCount: book.wordCount,
  }
}

function hitRow(g: SearchGroup, h: SearchHit): SheetRowData {
  const listed = [h.title, h.author ?? ''].filter((x) => x !== '').join(' · ')
  return {
    sourceId: g.sourceId, sourceName: g.sourceName, listed, title: h.title, author: h.author, url: h.url,
    lastChapterName: h.lastChapterName, coverUrl: h.coverUrl, intro: h.intro, kind: h.kind, wordCount: h.wordCount,
  }
}

/** 入架走整仓唯一那一发（`shelf-action.addShelfSeat`）。**不先读书架判「已在书架」**：那是多出来
 *  的请求换按钮文案；重复点按由幂等覆盖。成功才报名，失败进错误泳道——静默失败比失败更糟。 */
function addToShelf(row: SheetRowData & { url: string }, deps: RowActionDeps, t: Translate = zhTranslate): void {
  // 书目字段不在这里列：pickShelfMeta / SHELF_META 是唯一过滤点；sourceName/listed 会被整键丢
  void addShelfSeat(row, deps).then((outcome) => {
    if (outcome.ok) {
      markPanelShelfLanded([row.url])          // 与搜索行共用面板期落架账，重挂后不再写「加书架」
      deps.pushOk(t('city.sheet.added', { title: row.title }))
    } else {
      deps.pushError(t('city.sheet.addFailed', { detail: describeError(outcome.error, t) }))
    }
  })
}

/** `showLast` 关掉「最新」那半句（本源那行的最新归头部 tag 说）；`showSource` 关掉源名
 *  （折叠区里的家门由折叠摘要说一次）。 */
function SheetRow({ row, deps, showLast = true, showSource = true }: {
  row: SheetRowData; deps: RowActionDeps; showLast?: boolean; showSource?: boolean
}): ReactNode {
  const t = useCopy()
  const url = row.url
  return (
    <div className="novel-city-srcrow">
      {showSource ? <span className="novel-city-srcrow-who">{row.sourceName}</span> : null}
      {row.listed === null ? null : <span className="novel-city-srcrow-last">{row.listed}</span>}
      {!showLast || row.lastChapterName === null ? null : (
        <span className="novel-city-srcrow-last">{t('city.latest', { chapter: row.lastChapterName })}</span>
      )}
      {/* 各源一律同款按钮、没有排序：把第一条刷成主色就是替用户排序。入架排在「读这本」前面，
          主色（读）留在行尾的既有位置。 */}
      {url === null ? null : (
        <>
          <button className="novel-btn sm novel-city-srcrow-add" onClick={() => { addToShelf({ ...row, url }, deps, t) }}>{t('city.sheet.add')}</button>
          <button
            className="novel-btn sm primary novel-city-srcrow-go"
            onClick={() => navigate({ name: 'reader', sourceId: row.sourceId, bookKey: url, title: row.title })}
          >
            {t('city.sheet.read')}
          </button>
        </>
      )}
    </div>
  )
}

/** 一个源在这一轮的三种来路：有命中（一行动作）／答了但零条／没答上来（点名源与错误码）。
 *  代表行取哪条由相关性判据说了算（`shared/relevance`）；这一层一家只给一行，判据决定**谁上
 *  这一行**，疑似无关的不删、收进组末尾折叠，仍可点。三条来路按答复长，不按默认视野长。 */
function GroupRow({ group, keyword, deps }: {
  group: SearchGroup; keyword: string; deps: RowActionDeps
}): ReactNode {
  const t = useCopy()
  if (group.error !== undefined) {
    return (
      <details className="novel-city-fail">
        <summary>
          <b className="novel-city-fail-who">{group.sourceName}</b>
          <span>{t('city.cross.unresponsive', { code: group.error.code })}</span>
          <span className="novel-city-fail-more">{t('city.cross.expandReason')}</span>
        </summary>
        <div className="novel-city-fail-msgs">
          <span>{group.error.message}</span>
          {group.statusDetail === undefined ? null : <span>{group.statusDetail}</span>}
        </div>
      </details>
    )
  }
  if (group.hits.length === 0) {
    return (
      <div className="novel-city-srcrow">
        <span className="novel-city-srcrow-who">{group.sourceName}</span>
        <span className="novel-city-srcrow-last">{t('city.cross.notFound')}</span>
      </div>
    )
  }
  const { kept, suspect } = partitionByRelevance(keyword, group.hits)
  const best = kept[0]
  return (
    <>
      {best === undefined ? null : <SheetRow row={hitRow(group, best.hit)} deps={deps} />}
      {suspect.length === 0 ? null : (
        <details className="novel-city-fail" data-novel-city-suspect>
          <summary>
            <span>{plural(t, suspect.length, 'city.cross.suspect.one', 'city.cross.suspect.other', { n: suspect.length, source: group.sourceName })}</span>
            <span className="novel-city-fail-more">{t('city.cross.suspectHint')}</span>
          </summary>
          <div className="novel-city-srclist">
            {suspect.map((m, i) => <SheetRow key={`s#${i}`} row={hitRow(group, m.hit)} deps={deps} showSource={false} />)}
          </div>
        </details>
      )}
    </>
  )
}
