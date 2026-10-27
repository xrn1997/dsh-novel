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
 * 书籍详情浮层：一本**已经点名的源上的书**的落点。三件事住这里——读这本、加入书架、跨源找这本。
 *
 * 为什么源不在这层点名：浏览轴按源，源在左栏第一层就点完名了，这一层拿到的书恒属于一个源。
 * 这一层的名字只指「详情浮层」，不承担「替用户点源」的职责（词汇优先）。
 *
 * 四条口径：
 * ① 该源上的书地址缺席 ⇒ 一个按钮都不给（读与架共用这一条守卫：那条地址就是这本书的书籍身份，没有
 *    它就既进不了阅读器也无从入架）。那一行照样列出——它是「这个源收录了它」的交代。
 * ② **跨源那一次是用户主动发起的**：服务端不问就不打搜索，所以这颗钮是真控件；点了之后走的
 *    是搜索面那条既有链（`useSearchJob` + `sheetKeyword`），**不新造第二条跨源遍历**。搜索面只有
 *    一个槽、观察者跟随最近一轮，故这一列还多一条身份守卫：只认本层 POST 回来的 jobId
 *    （见下面 `ownRound`；关键词不是身份）。
 * ③ 跨源结果**不替用户判是不是同一本书**：按源一行行列出来，该源上的书名与最新章都在行上，
 *    他自己看——与「不造分类同义词表」（`docs/adr/0027`）同一族纪律。这一行取该源哪一条命中由
 *    相关性判据说了算（判据与档序的家在 `shared/relevance`，搜索结果页调的也是它；落点见 `GroupRow`），
 *    判掉的条目只换位置不消失。**没当上代表的那几条在这一层哪儿都看不见**：这一层一家只给一行，
 *    落选的相关条目（含被档序换下的到达首条）不像疑似无关那样有折叠区可去——按书那笔账是搜索面的事
 *    （归并唯一实现 `shared/merge-by-book` 的 `mergePartitioned`，只进结果页与工具面，裁决见 `docs/adr/0033`），
 *    不在这里补一份；这一层维持逐源轴，三条读数（有命中／答了但零条／未响应）才不会被浓缩吞掉。
 * ④ 四种说法各说各的，谁都不许冒充谁：**进行中**（进度 + 可停止）／**零命中**（没有一家按这个
 *    书名搜到，不挂红条）／**有源没响应**（点名源与错误码）／**本源可读**（正常那一行）。
 *    停止不是失败；一家都没被问到也不是「搜了没命中」；某一家答了而零条命中不是「那家没响应」
 *    （取值规约在呈现层的落点：空集合与取值失败是两种值）。零命中那句因此**只在真有答复时**才说：
 *    「全都答了而没搜到」与「全都没答」是两种事实，后者只能出未响应那些行。
 *
 * 浮层是覆盖层：书单留在原位（不卸载、不动滚动位置）。遮罩、Esc、入场焦点、Tab 圈与关后还焦都不
 * 是本层的手写机械——它们是**模态契约**的一份落点（唯一住址 `views/dialog.tsx`，与删除确认、入架
 * 一问、导入弹层同一份）；抽屉档的几何仍归样式层（`.novel-city-scrim` / `.novel-city-drawer`）。
 *
 * **一次跨源会换掉搜索面的那一轮**：服务端搜索槽只有一个（`services/search-job.ts`），在书城发起
 * 的这轮同样会替换它——这是既有裁决「跟随最近一轮」（`docs/adr/0046`）的另一处落点，不是缺陷；
 * 代价写在 `docs/adr/0028`。
 *
 * `deps` 由父层（`CityView`）透传：行内写口同样要能被测试驱动（与 `SearchView` 的命中行同口径）。
 */
export function CityBookSheet({ book, sourceId, sourceName, deps, onClose }: {
  book: ExploreBook; sourceId: string; sourceName: string; deps: JobViewDeps; onClose: () => void
}): ReactNode {
  const t = useCopy()
  const search = useSearchJob(deps, t)
  /** 按过那颗钮才算「要跨源」：在那之前搜索面持有的轮次不是本浮层的读数，一条都不列 */
  const [asked, setAsked] = useState(false)
  /** 本浮层最近一次成功 POST 回来的轮次 id（同关键词的别人那轮不认）。 */
  const [ownId, setOwnId] = useState<string | null>(null)

  /** 跨源那一次的关键词，本层只在这里向 `sheetKeyword` 取一次：它只服务相关性与提交文本；
   *  本轮身份认 `ownId`，不是这个串。 */
  const keyword = sheetKeyword(book)
  /** 本轮身份守卫：服务端只有一个槽、观察者跟随最近一轮（`docs/adr/0046`），
   *  而挂载恢复交回的那一轮可能属于另一本书。本层只认自己 POST 回来的 jobId——
   *  关键词相同也不是身份。**不顺手 cancel**：那是别人正在看的轮次，浮层没有停它的权利。 */
  const round = search.round
  const ownRound = round !== null && ownId !== null && round.id === ownId ? round : null
  const groups = ownRound?.groups ?? []
  const start = (): void => {
    setAsked(true)
    // 迟到回包由 `useSearchJob` 的起跑序号挡住（只有最后一次 submit 会 begin 并交回 id）；
    // 这里拿到非 null 即本轮。认领还多一道自证：`ownRound` 比当前轮次 id，指错了就一条都不列。
    void search.submit(keyword).then((id) => { if (id !== null) setOwnId(id) })
  }
  /** 零命中判据（口径④）：**至少一家干净答了**，且答了的那些家全都零条命中。
   *  前半条不是多余的：只数「组里还有没有命中」时，这一列压根没有组、以及整列全是未响应——两种
   *  「一个答复都没有」的情形都满足它（未响应那组本来就是空列表，空集合上更是真空成立），
   *  于是「没有一家按这个书名搜到」会与一整屏未响应同屏。那是把「没答」念成「没搜到」，
   *  正是口径④立这四种说法要挡的那一件事。 */
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
          实测该退让的次序是：先让重复的那句，再让长补充，源名与两颗钮都不许动。 */}
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
                {/* 参搜家数由服务端 searchPlan 说了算：首帧之前手上还没有这个数，说「已问到 0 / 0」
                    就是把「还没问到」念成「问过了、没人答」 */}
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
          {/* 收口的三种说法互不冒充：被停止 ≠ 问完了没货，一家没被问到 ≠ 搜了没命中。
              「被停止」排在最前，它优先于另两条——停止的那一轮没资格对结果下结论。 */}
          {ownRound !== null && !ownRound.running && ownRound.cancelled ? (
            <div className="novel-muted novel-note-sm">{t('city.cross.stopped')}</div>
          ) : null}
          {ownRound !== null && !ownRound.running && !ownRound.cancelled && ownRound.total === 0 ? (
            <div className="novel-muted novel-note-sm">{t('city.cross.noSources')}</div>
          ) : null}
          {ownRound !== null && !ownRound.running && !ownRound.cancelled && ownRound.total > 0 && zeroHits ? (
            <div className="novel-muted novel-note-sm">{t('city.cross.zeroHits')}</div>
          ) : null}
          {/* 各源命中就地长在同一列：一行一个源，不并成一条、不给源排序、不标「推荐这一本」。
              源家数不变，变的只是这一行的**代表**由谁当——判据见 `GroupRow`。 */}
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
 *  于是 ① 那条地址守卫只有一处落点（两处各写一遍，改一处就漏一处）。 */
interface SheetRowData {
  sourceId: string
  sourceName: string
  /** 行上替用户补的那句话：本源那行不补（头部已经报了书名，重复一遍是抄本）；跨源那行补
   *  「这一家把它叫作什么」——不替他判同不同一本书，就得让两边的名字都看得见。 */
  listed: string | null
  title: string
  author: string | null
  /** 该源上的书地址：书籍身份 + 阅读入口；缺席即两个动作都不给 */
  url: string | null
  /** 行名与 `SearchHit` / `ShelfMetaPatch` 同字（`lastChapterName`）：这一层的行就是「某个源上的
   *  这一本」，与命中同一个形状，入架时才无须在这里再列一遍字段位。 */
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

/** 入架走整仓唯一那一发（`shelf-action.addShelfSeat`）：路径与 body 归 wire 单点，成败在这里
 *  才落成回执。**不先读一次书架判「已在书架」**：那是一个多出来的请求，换来的只是按钮文案；
 *  重复点按由幂等覆盖处理（同一 bookKey 再 PUT 一次，写进去的还是同一本书）。成功才报名，失败进
 *  错误泳道——点了一下必须有个交代，静默失败比失败更糟。 */
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

/** `showLast` 关掉「最新」那半句：本源那一行的最新归头部那颗 tag 说（它装得下整句），
 *  跨源各行说的是各家的最新，默认带着。
 *  `showSource` 关掉源名：折叠区里那些行的家门由它们所在那行折叠的摘要说一次（同一组里说两遍就是
 *  抄本），默认带着——本源那一行与各源的代表行都靠它自报家门。 */
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

/** 一个源在这一轮的三种来路，各说各的：有命中（一行动作）／答了但零条（空集合，不是没响应）／
 *  没答上来（点名源与错误码——沿用搜索面失败条那套「如实摊开」的措辞与同类容器）。
 *
 *  代表行取哪一条由相关性判据说了算（判据与档序的家在 `shared/relevance`，这里只消费；与搜索结果页
 *  调的是同一个函数，两处的「相关」不许分叉）。这一层一家只给一行，所以判据买到的不是行数而是
 *  **谁上这一行**：站点先回来的常常是推荐位，按到达序取就让无关条目占住这一源唯一的门面，
 *  而那条真结果压根不出现。疑似无关的那些不删——收进该组末尾一行折叠，展开后照旧是可点的普通行
 *  （判为疑似不夺走「读这本 / 加入书架」）。
 *  「只回了疑似无关」既不是「这一家没有按这个书名搜到」（那是**答了而零条**的说法），也不是未响应
 *  （它答了）——三条来路按答复长，不按默认视野长，所以这里只在真零条命中时才说那一句。 */
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
