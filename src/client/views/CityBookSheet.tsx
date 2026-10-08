import type { ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { paramRoutes, shelfBody } from '../../shared/wire.js'
import type { ExploreBook, SearchGroup, SearchHit } from '../../shared/wire.js'
import { cityMeta, sheetKeyword } from '../city-view-model.js'
import type { ClientCoreDeps } from '../deps.js'
import { useSearchJob } from '../search-job.js'
import { navigate } from '../store.js'

/**
 * 书籍详情浮层：一本**已经点名的源上的书**的落点。三件事住这里——读这本、加入书架、跨源找这本。
 *
 * 为什么源不在这层点名：浏览轴改成按源之后，源在左栏第一层就点完名了，这一层拿到的书恒属于一个源。
 * 旧版这一层的职责就是替用户点源，职责走了名字也一起走——旧名字留着不改，就是两个名字指同一个东西
 * （词汇优先的反面教材）。
 *
 * 四条口径：
 * ① 该源上的书地址缺席 ⇒ 一个按钮都不给（读与架共用这一条守卫：书架身份就是这本书在该源上的
 *    地址，地址没有就既进不了阅读器也无从入架）。那一行照样列出——它是「这个源收录了它」的交代。
 * ② **跨源那一次是用户主动发起的**：服务端不问就不打搜索，所以这颗钮是真控件；点了之后走的
 *    是搜索面那条既有链（`useSearchJob` + `sheetKeyword`），**不新造第二条跨源遍历**。搜索面只有
 *    一个槽、观察者跟随最近一轮，故这一列还多一条身份守卫：只认「本轮关键词就是这本书」的那一轮
 *    （见下面 `ownRound`）。
 * ③ 跨源结果**不替用户判是不是同一本书**：按源一行行列出来，该源上的书名与最新章都在行上，
 *    他自己看——与「不造分类同义词表」（`docs/adr/0027`）同一族纪律。
 * ④ 四种说法各说各的，谁都不许冒充谁：**进行中**（进度 + 可停止）／**零命中**（没有一家按这个
 *    书名搜到，不挂红条）／**有源没响应**（点名源与错误码）／**本源可读**（正常那一行）。
 *    停止不是失败；一家都没被问到也不是「搜了没命中」；某一家答了而零条命中不是「那家没响应」
 *    （取值规约在呈现层的落点：空集合与取值失败是两种值）。零命中那句因此**只在真有答复时**才说：
 *    「全都答了而没搜到」与「全都没答」是两种事实，后者只能出未响应那些行。
 *
 * 浮层是覆盖层：书单留在原位（不卸载、不动滚动位置），退出路是遮罩与 Esc 两条，入场焦点落关闭钮
 * （焦点口径沿用 `ImportModal` 那条——同一仓里长两套焦点语言，会让「打开浮层后键盘在哪儿」变成
 * 要分情况背的东西）。Esc 挂 `document`（焦点可能落在浮层内任意处），effect 空依赖 + onClose 走
 * ref：浮层活着的期间父层随时会重渲染（轮次推送），闭包进依赖会把监听搬来搬去。
 *
 * **一次跨源会换掉搜索面的那一轮**：服务端搜索槽只有一个（`services/search-job.ts`），在书城发起
 * 的这轮同样会替换它——这是既有裁决「跟随最近一轮」（`docs/adr/0023`）的另一处落点，不是缺陷；
 * 代价写在 `docs/adr/0028`。
 *
 * `deps` 由父层（`CityView`）透传：行内写口同样要能被测试驱动（与 `SearchView` 的命中行同口径）。
 */
export function CityBookSheet({ book, sourceId, sourceName, deps, onClose }: {
  book: ExploreBook; sourceId: string; sourceName: string; deps: ClientCoreDeps; onClose: () => void
}): ReactNode {
  const search = useSearchJob(deps)
  /** 按过那颗钮才算「要跨源」：在那之前搜索面持有的轮次不是本浮层的读数，一条都不列 */
  const [asked, setAsked] = useState(false)
  const closeRef = useRef<HTMLButtonElement | null>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  useEffect(() => {
    const previous = document.activeElement
    closeRef.current?.focus()
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onCloseRef.current() }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      // 焦点归还给打开浮层的那张卡（书单还在场，那张卡没被卸载）。这是 nice-to-have，所以只在
      // 原元素仍挂在文档里时才还——别把焦点扔给一个已经不在文档里的节点。
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [])

  /** 本轮身份守卫（口径②的后半）：`asked` 在点击瞬间即真，而挂载恢复交回的是搜索面**最近那一轮**——
   *  服务端只有一个槽、观察者跟随最近一轮（`docs/adr/0023`），那一轮的关键词很可能属于**另一本书**
   *  （上一本在这里点过跨源，或搜索面正拿着别处的结果）。本次 POST 回包之前的窗口里，不认关键词就会
   *  把别的书的命中当成本书的结果念给用户。判据：关键词与 `sheetKeyword` 给的那一个一致才算本轮，
   *  不一致就当还没出结果。**不顺手 cancel**：那是别人正在看的轮次，浮层没有停它的权利。 */
  const round = search.round
  const ownRound = round !== null && round.keyword === sheetKeyword(book).trim() ? round : null
  const groups = ownRound?.groups ?? []
  /** 零命中判据（口径④）：**至少一家干净答了**，且答了的那些家全都零条命中。
   *  前半条不是多余的：只数「组里还有没有命中」时，这一列压根没有组、以及整列全是未响应——两种
   *  「一个答复都没有」的情形都满足它（未响应那组本来就是空列表，空集合上更是真空成立），
   *  于是「没有一家按这个书名搜到」会与一整屏未响应同屏。那是把「没答」念成「没搜到」，
   *  正是口径④立这四种说法要挡的那一件事。 */
  const answered = groups.filter((g) => g.error === undefined)
  const zeroHits = answered.length > 0 && answered.every((g) => g.hits.length === 0)
  const meta = cityMeta(book)
  return (
    <>
      <div className="novel-city-scrim" aria-hidden="true" onClick={onClose} />
      <div className="novel-city-drawer" role="dialog" aria-modal="true" aria-label={`书籍详情：${book.name}`}>
        <div className="novel-city-drawer-head">
          <strong className="novel-city-drawer-title">{book.name}</strong>
          <button ref={closeRef} className="novel-btn sm" onClick={onClose}>关闭</button>
        </div>
        <div className="novel-city-bookhead">
          {/* 元信息与卡片同源（`cityMeta`）：同一本书在两个地方写法不一致就是两份抄本 */}
          {meta === '' ? null : <div className="novel-city-bookhead-meta">{meta}</div>}
          {/* 整段简介在这里给（卡片那一行只夹一行）：文字是分类页那一条命中带来的，本层不另发详情面请求 */}
          {book.intro === null || book.intro === '' ? null : (
            <div className="novel-city-bookhead-meta">{book.intro}</div>
          )}
          <div className="novel-city-tags">
            {/* 源名不在这里重复：本源那一行已经点了它的名，同一层浮层里说两遍就是抄本 */}
            {book.lastChapter === null || book.lastChapter === '' ? null : <span className="novel-city-tag">最新 {book.lastChapter}</span>}
          </div>
        </div>
        {/* 本源那一行：与跨源那些行走同一个渲染器、同一对动作、同一条地址守卫。
            「最新」不在这里重复——头部那颗 tag 已经把这本书的最新章整句说过了（同一层浮层里说两遍
            就是抄本，源名同理，见上面那条）。372px 的一行装不下「源名 + 整句最新 + 两颗钮」，
            实测该退让的次序是：先让重复的那句，再让长补充，源名与两颗钮都不许动。 */}
        <div className="novel-city-srclist">
          <SheetRow row={ownRow(book, sourceId, sourceName)} deps={deps} showLast={false} />
        </div>
        <button className="novel-btn" onClick={() => { setAsked(true); search.submit(sheetKeyword(book)) }}>
          {asked && ownRound?.running === true ? '在其他源找这本 · 进行中' : '在其他源找这本'}
        </button>
        {asked ? (
          <>
            {ownRound !== null && ownRound.running ? (
              <div className="novel-city-progress">
                <span className="novel-muted">
                  {/* 参搜家数由服务端 searchPlan 说了算：首帧之前手上还没有这个数，说「已问到 0 / 0」
                      就是把「还没问到」念成「问过了、没人答」 */}
                  {ownRound.total === 0 ? '正在启动跨源搜索…' : `已问到 ${ownRound.done} / ${ownRound.total} 家`}
                </span>
                <button className="novel-btn sm" onClick={() => { search.cancel() }}>停止</button>
              </div>
            ) : null}
            {search.error === null ? null : (
              <div className="novel-err novel-note-sm">跨源搜索中断：{search.error}</div>
            )}
            {/* 收口的三种说法互不冒充：被停止 ≠ 问完了没货，一家没被问到 ≠ 搜了没命中。
                「被停止」排在最前，它优先于另两条——停止的那一轮没资格对结果下结论。 */}
            {ownRound !== null && !ownRound.running && ownRound.cancelled ? (
              <div className="novel-muted novel-note-sm">已停止：没问完的源不再往下问，已经答的留在上方。</div>
            ) : null}
            {ownRound !== null && !ownRound.running && !ownRound.cancelled && ownRound.total === 0 ? (
              <div className="novel-muted novel-note-sm">
                这一轮一家都没被问到：没有参与搜索的书源（都已停用，或还没导入）。
              </div>
            ) : null}
            {ownRound !== null && !ownRound.running && !ownRound.cancelled && ownRound.total > 0 && zeroHits ? (
              <div className="novel-muted novel-note-sm">
                没有一家按这个书名搜到——这既不是说这本书不存在，也不是搜索出了错。
              </div>
            ) : null}
            {/* 各源命中就地长在同一列：一行一个源，不并成一条、不排序、不标「推荐这一本」 */}
            {groups.length === 0 ? null : (
              <div className="novel-city-srclist">
                {groups.map((g) => <GroupRow key={g.sourceId} group={g} deps={deps} />)}
              </div>
            )}
          </>
        ) : null}
      </div>
    </>
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
  /** 该源上的书地址：书架身份 + 阅读入口；缺席即两个动作都不给 */
  url: string | null
  lastChapter: string | null
  coverUrl: string | null
  intro: string | null
  kind: string | null
  wordCount: string | null
}

function ownRow(book: ExploreBook, sourceId: string, sourceName: string): SheetRowData {
  return {
    sourceId, sourceName, listed: null, title: book.name, author: book.author, url: book.bookUrl,
    lastChapter: book.lastChapter, coverUrl: book.coverUrl, intro: book.intro,
    kind: book.kind, wordCount: book.wordCount,
  }
}

function hitRow(g: SearchGroup, h: SearchHit): SheetRowData {
  const listed = [h.title, h.author ?? ''].filter((x) => x !== '').join(' · ')
  return {
    sourceId: g.sourceId, sourceName: g.sourceName, listed, title: h.title, author: h.author, url: h.url,
    lastChapter: h.lastChapterName, coverUrl: h.coverUrl, intro: h.intro, kind: h.kind, wordCount: h.wordCount,
  }
}

/** 入架走**搜索面那条既有路**（`PUT paramRoutes.shelfKey` + `shelfBody.addBook`）：各条入架路共用
 *  一个路径构造器与一个 body 构造器，服务端那一份 patch 语义才不会长出第二种。
 *  **不先读一次书架判「已在书架」**：那是一个多出来的请求，换来的只是按钮文案；重复点按由幂等覆盖
 *  处理（同一 bookKey 再 PUT 一次，写进去的还是同一本书）。成功才报名，失败进错误泳道——点了一下
 *  必须有个交代，静默失败比失败更糟。 */
function addToShelf(row: SheetRowData, deps: ClientCoreDeps): void {
  void deps.apiSend('PUT', paramRoutes.shelfKey(row.url ?? ''), shelfBody.addBook({
    sourceId: row.sourceId, title: row.title, author: row.author, coverUrl: row.coverUrl,
    intro: row.intro, lastChapterName: row.lastChapter, kind: row.kind, wordCount: row.wordCount,
  })).then(
    () => deps.pushOk(`已加入书架：${row.title}`),
    (e: unknown) => deps.pushError(`加入书架失败：${e instanceof Error ? e.message : String(e)}`),
  )
}

/** `showLast` 关掉「最新」那半句：本源那一行的最新归头部那颗 tag 说（它装得下整句），
 *  跨源各行说的是各家的最新，默认带着。 */
function SheetRow({ row, deps, showLast = true }: {
  row: SheetRowData; deps: ClientCoreDeps; showLast?: boolean
}): ReactNode {
  return (
    <div className="novel-city-srcrow">
      <span className="novel-city-srcrow-who">{row.sourceName}</span>
      {row.listed === null ? null : <span className="novel-city-srcrow-last">{row.listed}</span>}
      {!showLast || row.lastChapter === null ? null : (
        <span className="novel-city-srcrow-last">最新：{row.lastChapter}</span>
      )}
      {/* 各源一律同款按钮、没有排序：把第一条刷成主色就是替用户排序。入架排在「读这本」前面，
          主色（读）留在行尾的既有位置。 */}
      {row.url === null ? null : (
        <>
          <button className="novel-btn sm novel-city-srcrow-add" onClick={() => { addToShelf(row, deps) }}>加入书架</button>
          <button
            className="novel-btn sm primary novel-city-srcrow-go"
            onClick={() => navigate({ name: 'reader', sourceId: row.sourceId, bookKey: row.url ?? '', title: row.title })}
          >
            读这本
          </button>
        </>
      )}
    </div>
  )
}

/** 一个源在这一轮的三种来路，各说各的：有命中（一行动作）／答了但零条（空集合，不是没响应）／
 *  没答上来（点名源与错误码——沿用搜索面失败条那套「如实摊开」的措辞与同类容器）。 */
function GroupRow({ group, deps }: { group: SearchGroup; deps: ClientCoreDeps }): ReactNode {
  if (group.error !== undefined) {
    return (
      <details className="novel-city-fail">
        <summary>
          <b className="novel-city-fail-who">{group.sourceName}</b>
          <span>未响应 · {group.error.code}</span>
          <span className="novel-city-fail-more">展开看原因</span>
        </summary>
        <div className="novel-city-fail-msgs">
          <span>{group.error.message}</span>
          {group.statusDetail === undefined ? null : <span>{group.statusDetail}</span>}
        </div>
      </details>
    )
  }
  const hit = group.hits[0]
  if (hit === undefined) {
    return (
      <div className="novel-city-srcrow">
        <span className="novel-city-srcrow-who">{group.sourceName}</span>
        <span className="novel-city-srcrow-last">这一家没有按这个书名搜到</span>
      </div>
    )
  }
  return <SheetRow row={hitRow(group, hit)} deps={deps} />
}
