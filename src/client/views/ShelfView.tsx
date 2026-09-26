import type { ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { LOCAL_SOURCE_ID, paramRoutes, queries, ROUTES } from '../../shared/wire.js'
import { prodCoreDeps } from '../deps.js'
import type { ClientCoreDeps } from '../deps.js'
import { navigate } from '../store.js'
import type { LocalImportResponse, ShelfEntry } from './types.js'
import { coverFallbackChar, EmptyState, ProgressBar, SearchIcon, WarningList } from './bits.js'
import { deleteBookCopy, deleteBooksCopy } from '../shelf-delete.js'
import { filterShelfBooks, localImportLabel, localImportNote, SHELF_FILTERS, shelfCardMeta, shelfSourceTag } from '../shelf-view-model.js'
import type { ShelfFilterKey } from '../shelf-view-model.js'
import { coverTintClass, sourceTintClass } from '../util.js'

/** 本地书保留源 id 归 wire 契约（第四轮卡「顺带」项）：此前此处手抄 '__local__'——
 *  服务端单主人在 src/services/localbooks.ts，client 纯度门禁拦跨半 import，字面量双份即漂移隐患。 */

/** 书架 tab 内容（IA：书架/书城/书源管理是 NovelView 顶部的并列 tab，2026 变更用户拍板）：
 *  行1 = 内容标题「书架」+ 灰字计数「N 本」（.novel-shelf-count span，与批准的交互 mock 同构）；
 *  行2 搜索框单独一行且整簇居中（聚合搜索 = 找新书入口）；
 *  行3 = 书架筛选簇（pills + 簇尾排序灰字，有书才渲染）。
 *  网格末位常驻引导卡 =「导入本地书籍」——工具栏导入钮移除后它是唯一导入入口，空书架以
 *  .novel-grid.solo 单卡兜底（EmptyState 分支不渲染整网格）。旧「搜一本书」引导卡退役：
 *  搜索职责已由行2搜索框显式承担，同一职责不留第二个入口。
 *  筛选与卡片元信息口径归 shelf-view-model（纯函数）；首字色块档位归 util.coverTintClass。
 * deps 注入：接线层可被测试驱动——加载失败/删除失败的半场此前不可达。
 *  测试钉子（不可动）：搜索框 placeholder「搜书名 / 作者」、删除 title「删除本书」、
 *  确认条文案与空态/错误文案原文（views-wiring + smoke）。
 *  承载元素口径：卡片与引导卡是真 <button>（Enter/Space 原生可用），删除钮是其
 *  **兄弟**而非后代——div[role=button] 只绑 onClick，键盘按不动且读屏念「按钮含按钮」。
 *  守卫在 tests/client/ui-system.test.tsx。布局与配色一律归样式类，本文件零行内 style。
 *
 * 多选态（批量删除，2026 新需求）：行3 的「选择」入态——筛选簇让位给批量条（复用书源管理
 *  同款 `.novel-selbar` 与同款词汇：已选 N / 清空选择 / 删除所选），卡片点击改为勾选、
 *  单本 ✕ 与导入引导卡退场（同一职责不留第二个入口）。「全选」= 当前筛选可见的书——
 *  筛选在多选态定格，这条口径才有唯一答案。选择态是**现场**（组件 state，不进 store）：
 *  切 tab 重挂载即清零，残留一批旧勾选去撞下一次删除比丢失现场危险得多。
 *  批量走一次 POST shelf/batch-delete（keys 点击时快照），不是循环 DELETE。
 *
 * 本地书导入（2026-09 扩到 EPUB）：引导卡收 `.txt,.epub`，分流按**内容**在服务端做（ZIP 魔数），
 * 客户端不判格式。回执是 wire 的 `LocalImportResponse`——书名/作者/封面/格式/章数/warnings 全在
 * 里面，本视图**原样消费**（不另猜书名、不按后缀推格式）。两种半场：无告警照旧直接进阅读器
 * （既有行为一字不动）；**有持久告警时不跳**，就地把回执摆出来（服务端真相 + 逐条说明 + 开始阅读），
 * 跳走等于把「这本书的有损事项」吞掉。海报性的成功/失败两半仍归 alive 闸与瞬态层。 */

export function ShelfView({ deps = prodCoreDeps }: { deps?: ClientCoreDeps }): ReactNode {
  const [books, setBooks] = useState<ShelfEntry[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [keyword, setKeyword] = useState('')
  const [filter, setFilter] = useState<ShelfFilterKey>('all')
  const [imgFailed, setImgFailed] = useState<Record<string, boolean>>({})
  // 本地书导入（TXT / EPUB 按内容分流，服务端说了算）：隐藏 file input + 上传后直进阅读器
  const [importError, setImportError] = useState<string | null>(null)
  /** 导入回执现场（**只在有持久警告时**）：服务端回执原样持有（书名/作者/封面/格式/章数/warnings），
   *  不复制成第二份形状。有警告时不自动进阅读器——跳进阅读器就把「这本书带着降级/剥除事项」这条
   *  交代吞了（用户看不到任何迹象）；无警告时一分钱不花，行为与从前一字不差。 */
  const [imported, setImported] = useState<LocalImportResponse | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)   // 导入入口的触发方 = 网格引导卡/空架兜底卡
  /** 本视图是否仍在场。`navigate` 是模块级 store 的动作、与组件存活无关，所以在卸载后的
   *  `.then` 里照样会执行——导入落地时用户若已切到别的 tab，就会被强行拽进阅读器（实测缺陷）。
   *  两个半场都不许静默：在场走场景内提示（可就地重试），切走走瞬态层。 */
  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    return () => { aliveRef.current = false }
  }, [])
  // 删除书籍（卡片 ✕ → 模态确认 → DELETE shelf/:key；本地书服务端连删磁盘文件）
  const [pendingDel, setPendingDel] = useState<{ books: ShelfEntry[]; batch: boolean } | null>(null)
  const [delError, setDelError] = useState<string | null>(null)
  const [delBusy, setDelBusy] = useState(false)
  // 多选现场：selectMode + 已勾选的 bookKey（勾选序只是集合的存法；批请求的 targets 由 books
  // 过滤得出 = 书架序，别指望它是点选顺序）
  const [selectMode, setSelectMode] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const modalRef = useRef<HTMLDivElement | null>(null)
  const cancelDel = (): void => { setPendingDel(null); setDelError(null); setDelBusy(false) }
  const exitSelect = (): void => { setSelectMode(false); setSelected([]) }
  const toggleSelect = (bookKey: string): void => {
    setSelected((prev) => prev.includes(bookKey) ? prev.filter((k) => k !== bookKey) : [...prev, bookKey])
  }
  /** 模态在场期间的键盘接管：Esc 取消 + Tab 圈在框内（焦点在关闭后还给触发它的那张卡片 ✕）。
   *  旧实现只有 Esc，Tab 一路走下去就走到遮罩背后的书架——对话框还在屏幕上，人已出去。 */
  useEffect(() => {
    if (pendingDel === null) return
    const opener = document.activeElement
    const focusables = (): HTMLElement[] => modalRef.current === null ? []
      : [...modalRef.current.querySelectorAll<HTMLElement>('button:not([disabled])')]
    focusables()[0]?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { cancelDel(); return }
      if (e.key !== 'Tab') return
      const f = focusables()
      if (f.length === 0) return
      const first = f[0]
      const last = f[f.length - 1]
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingDel])
  /** 确认删除：**入口决定路径**——单本 ✕ 走 DELETE shelf/:key，多选「删除所选」走一次
   *  POST shelf/batch-delete（哪怕只勾了 1 本：载荷与文案跟用户点的那个钮一致）。
   *  成功才本地过滤 + 清勾选（失败半场卡片保留——乐观删除的回滚半场归接线测试钉死）。 */
  const confirmDelete = (): void => {
    if (pendingDel === null || delBusy) return
    const { books: targets, batch } = pendingDel
    const targetKeys = new Set(targets.map((b) => b.bookKey))
    setDelBusy(true)
    void (batch
      ? deps.apiSend('POST', ROUTES.shelfBatchDelete.path, { keys: [...targetKeys] })
      : deps.apiSend('DELETE', paramRoutes.shelfKey(targets[0].bookKey))
    ).then(() => {
      setBooks((prev) => (prev ?? []).filter((b) => !targetKeys.has(b.bookKey)))
      setSelected((prev) => prev.filter((k) => !targetKeys.has(k)))
      if (batch) setSelectMode(false)          // 批量成功即收工（这一批现场已消费完）
      cancelDel()
    }, (e) => {
      // 失败留在模态内：错误就地呈现，可重试可取消（错误不再散落到页面流里粘屏）
      setDelError(e instanceof Error ? e.message : String(e))
      setDelBusy(false)
    })
  }
  /** 取书架（挂载一次 + 有警告的导入留在本页后一次）：
   *  失败不许伪装成空架（历史 bug：网络失败 setBooks([]) → 渲染「书架空空」误导） */
  const loadShelf = (): void => {
    void deps.apiGet<ShelfEntry[]>(ROUTES.shelf.path).then((list) => {
      setBooks(list)
      setLoadError(null)
    }, (e) => {
      setBooks([])
      setLoadError(e instanceof Error ? e.message : String(e))
    })
  }
  useEffect(() => { loadShelf() }, [])   // eslint-disable-line react-hooks/exhaustive-deps
  const search = (): void => {
    if (keyword.trim() !== '') navigate({ name: 'search', keyword: keyword.trim() })
  }
  /** 当前筛选下的可见条目（网格、全选、计数共用同一份派生） */
  const shown = books === null ? [] : filterShelfBooks(books, filter)
  /** 「全选」= 当前筛选可见的书（筛选在多选态定格，故这条口径有唯一答案） */
  const selectAllVisible = (): void => setSelected(shown.map((b) => b.bookKey))
  /** 「删除所选」→ 开模态：**点击时刻快照**选中项（模态在场期间书架怎么变都不改这批目标） */
  const openBatchConfirm = (): void => {
    const targets = (books ?? []).filter((b) => selected.includes(b.bookKey))
    if (targets.length === 0) return
    setDelError(null)
    setPendingDel({ books: targets, batch: true })
  }
  const importCard = (
    <button className="novel-card novel-card-ghost" aria-label="导入本地书籍"
      onClick={() => fileRef.current?.click()}>
      <span className="novel-ghost-cover">＋</span>
      <span className="novel-card-title">导入本地书籍</span>
      <span className="novel-card-meta">导入 TXT / EPUB</span>
    </button>
  )
  /** 有警告的导入留在本页：先把新书摆进网格（服务端真相，含来源投影），再让用户自己点进阅读器 */
  const openImported = (): void => {
    const b = imported
    if (b === null) return
    setImported(null)
    navigate({ name: 'reader', sourceId: b.sourceId, bookKey: b.bookKey, title: b.title })
  }
  return (
    <div data-novel-view="shelf" className="novel-view">
      <div className="novel-wrap">
        <header className="novel-shelf-head">
          <h1 className="novel-shelf-title">
            书架{books === null || books.length === 0 ? null : <span className="novel-shelf-count">{books.length} 本</span>}
          </h1>
          {/* 行1：内容标题。书架/书城/书源管理的并列导航在 NovelView 顶部 tab（IA 变更），
              原「书城预留位」占位 chip 随之退役——占位不如真导航。 */}
          {/* 行2：搜索框单独一行（聚合搜索 = 找新书入口，与书架筛选不是同一语义组）。
              「搜索」钮与搜索页同款（type=submit + novel-btn primary）：Enter 是隐藏交互，
              可见按钮才是显式入口（用户提议；搜索页早有同款先例，书架缺它是不一致） */}
          <div className="novel-shelf-search">
            <form onSubmit={(e) => { e.preventDefault(); search() }} aria-label="搜索书籍">
              <label className="novel-searchbox">
                <SearchIcon />
                <input
                  value={keyword}
                  onChange={(e) => setKeyword(e.target.value)}
                  placeholder="搜书名 / 作者"
                  aria-label="搜索书籍"
                />
              </label>
              <button type="submit" className="novel-btn primary">搜索</button>
            </form>
            <span className="novel-shelf-search-note">聚合全部书源</span>
          </div>
          {/* 行3：书架筛选簇（有书才渲染——空架/加载中没有可筛的东西）；排序灰字跟簇尾。
              多选态里这一行让位给批量条（复用书源管理的 .novel-selbar 与同款词汇）——筛选
              随入场定格，「全选」的口径才有唯一答案。 */}
          {books === null || books.length === 0 ? null : selectMode ? (
            <div data-novel-selbar className="novel-selbar">
              <strong>已选 {selected.length}</strong>
              <button className="novel-btn sm" onClick={selectAllVisible}>全选</button>
              <button className="novel-btn sm" onClick={() => setSelected([])}>清空选择</button>
              <button className="novel-btn sm danger" disabled={selected.length === 0}
                onClick={openBatchConfirm}>删除所选</button>
              <span className="novel-grow" />
              <button className="novel-btn sm" onClick={exitSelect}>退出</button>
            </div>
          ) : (
            <div className="novel-shelf-filter">
              <div className="novel-seg" role="group" aria-label="按阅读状态筛选">
                {SHELF_FILTERS.map((f) => (
                  <button
                    key={f.key}
                    className={filter === f.key ? 'on' : undefined}
                    aria-pressed={filter === f.key}
                    onClick={() => setFilter(f.key)}
                  >{f.label}</button>
                ))}
              </div>
              <button className="novel-btn sm" onClick={() => setSelectMode(true)}>选择</button>
              <span className="novel-shelf-sort">最近阅读排序 · 进度自动保存</span>
            </div>
          )}
          {/* 隐藏 file input（布局零参与）：触发方只有引导卡。accept 收 TXT 与 EPUB——分流按**内容**
              （ZIP 魔数）在服务端做，这里只负责让选择器别把 .epub 藏起来 */}
          <input ref={fileRef} type="file" accept=".txt,.epub" className="novel-file-hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              e.target.value = ''
              if (f === undefined) return
              setImportError(null)
              void deps.apiUpload<LocalImportResponse>(
                queries.localImport({ name: f.name }), f,
              ).then((book) => {
                if (!aliveRef.current) { deps.pushOk(`《${book.title}》已导入，在书架可见${localImportNote(book)}`); return }
                if (book.warnings.length > 0) {
                  setImported(book)               // 跳走就吞了交代：留在本页把它说完
                  loadShelf()
                  return
                }
                navigate({ name: 'reader', sourceId: book.sourceId, bookKey: book.bookKey, title: book.title })
              }, (err) => {
                // 导入失败的具体原因由服务端给（固定版式 / 加密条目 / 是 ZIP 魔数但读不成 EPUB 归档 /
                // 超限），这里原样透出——换成「导入失败」一句泛话，用户与我们都无从下手；
                // 非 ZIP 字节不走这条路（它照 TXT 解码链导入）
                const text = err instanceof Error ? err.message : String(err)
                if (aliveRef.current) setImportError(text)
                else deps.pushError(`本地书籍导入失败：${text}`)
              })
            }} />
        </header>
        {/* 错误面：导入/加载两处场景内提示；删除错误在确认模态内就地呈现，不散落页面流 */}
        {importError === null ? null : <div className="novel-err novel-note-sm">{importError}</div>}
        {/* 导入回执（只在有持久警告时）：书名/作者/封面直接用服务端回执（不是本地猜的），
            格式取回执的 format 字段；警告逐条点名 code 与资源，读完可以「开始阅读」或「稍后再看」。
            封面位与卡片同一条分支、共用同一份 `imgFailed`（键都是 `local:<uuid>` 这类 bookKey）：
            资源文件被清掉时落「本地」占位而不是破图。 */}
        {imported === null ? null : (
          <div className="novel-import-note" role="status">
            <div className="novel-import-head">
              {imported.coverUrl === undefined || imgFailed[imported.bookKey] === true
                ? <span className="novel-cover-fallback sm">本地</span>
                : <img className="novel-cover" src={imported.coverUrl} alt="" loading="lazy"
                    onError={() => setImgFailed((m) => ({ ...m, [imported.bookKey]: true }))} />}
              <div className="novel-import-who">
                <div className="novel-card-title">《{imported.title}》已导入</div>
                <div className="novel-muted novel-note-sm">
                  {imported.author === undefined ? localImportLabel(imported) : `${imported.author} · ${localImportLabel(imported)}`}
                </div>
              </div>
            </div>
            <div className="novel-prefs-label">导入说明（{imported.warnings.length} 条）</div>
            <WarningList warnings={imported.warnings} />
            <div className="novel-import-acts">
              <button className="novel-btn sm" onClick={() => setImported(null)}>稍后再看</button>
              <button className="novel-btn sm primary" onClick={openImported}>开始阅读</button>
            </div>
          </div>
        )}
        {/* 删除确认模态：遮罩 + 居中对话框 + 危险色确认钮；Esc/点遮罩取消，失败留在框内重试。
            文案两形态同住 shelf-delete.ts（纯函数）：单本点名书名，批量点名本数并在含本地书时
            点名副本连删。测试钉子：✕ 的 title「删除本书」、按钮文案「确认删除」、
            失败文案「删除失败：…」、批量标题「删除选中的 N 本书？」。 */}
        {pendingDel === null ? null : (() => {
          const copy = pendingDel.batch
            ? deleteBooksCopy(pendingDel.books)
            : deleteBookCopy(pendingDel.books[0].title, pendingDel.books[0].sourceId === LOCAL_SOURCE_ID)
          return (
            <div className="novel-modal-mask" onClick={(e) => { if (e.target === e.currentTarget) cancelDel() }}>
              <div ref={modalRef} className="novel-modal" role="dialog" aria-modal="true" aria-labelledby="novel-del-title">
                <div className="novel-modal-title" id="novel-del-title">{copy.confirm}</div>
                {copy.warn === null
                  ? <div className="novel-modal-body">将从书架移除，阅读进度记录一并删除。</div>
                  : <div className="novel-modal-warn">{copy.warn}</div>}
                {delBusy ? <div className="novel-modal-body">删除中…</div> : null}
                {delError === null ? null : <div className="novel-err novel-note-sm">删除失败：{delError}</div>}
                <div className="novel-modal-actions">
                  <button className="novel-btn sm" onClick={cancelDel} disabled={delBusy}>取消</button>
                  <button className="novel-btn sm danger solid" onClick={confirmDelete} disabled={delBusy}>确认删除</button>
                </div>
              </div>
            </div>
          )
        })()}
        {loadError === null ? null : (
          <div className="novel-err novel-note-md">书架加载失败：{loadError}（稍后重试或检查 DSH 服务端）</div>
        )}
        {books === null
          // 骨架按网格占位：文字→整屏网格的一跳会顶掉用户刚看清的位置
          ? <div className="novel-grid">{Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="novel-cell" aria-hidden="true">
              <div className="novel-sk novel-sk-cover" />
              <div className="novel-sk novel-sk-line" />
              <div className="novel-sk novel-sk-line sm" />
            </div>
          ))}</div>
          : books.length === 0
            ? (loadError === null
              // 真零本：空态文案（测试钉子原文）+ 单卡导入兜底——导入入口不能随工具栏钮一起消失
              ? (<>
                  <EmptyState title="书架空空——上方搜一本书开始阅读" hint="书源在「小说 → 书源管理」中导入" />
                  <div className="novel-grid solo">{importCard}</div>
                </>)
              : <EmptyState title="书架暂时不可用（见上方错误）" hint="书源在「小说 → 书源管理」中导入" />)
            : (
              <div className="novel-grid">
                {shown.map((b) => {
                  const isLocal = b.sourceId === LOCAL_SOURCE_ID
                  const failed = imgFailed[b.bookKey] === true
                  const meta = shelfCardMeta(b)
                  const srcTag = shelfSourceTag(b)
                  const picked = selected.includes(b.bookKey)
                  return (
                    <div key={b.bookKey} className={`novel-cell${selectMode ? ' sel' : ''}${picked ? ' on' : ''}`}>
                      <button className="novel-card"
                        // 多选态里卡片就是勾选件（aria-pressed 如实）；常态是「阅读」入口。
                        // 两种态下都是真 <button>——勾选标记是卡内装饰 span，不再嵌一个可交互控件。
                        aria-label={selectMode ? `${picked ? '取消选择' : '选择'}《${b.title}》` : `阅读 ${b.title}`}
                        aria-pressed={selectMode ? picked : undefined}
                        onClick={() => {
                          if (selectMode) { toggleSelect(b.bookKey); return }
                          navigate({ name: 'reader', sourceId: b.sourceId, bookKey: b.bookKey, title: b.title })
                        }}>
                        <span className="novel-cover-box">
                          {/* 封面只有**这一条** img 分支（在线书与本地书共用）：本地 EPUB 的封面就是
                              服务端落盘的封面资源 URL（SHELF_META 的 coverUrl），能显示就显示；
                              本地书没有封面（或图挂了）才落「本地」占位——不发明第二条封面路。 */}
                          {b.coverUrl !== undefined && !failed
                            ? <img className="novel-cover" src={b.coverUrl} alt="" loading="lazy"
                                onError={() => setImgFailed((m) => ({ ...m, [b.bookKey]: true }))} />
                            : isLocal
                              ? <span className="novel-cover-fallback sm">本地</span>
                              : <span className={`novel-cover-fallback ${coverTintClass(b.title)}`}>{coverFallbackChar(b.title)}</span>}
                          {/* 来源 chip：色点按 sourceId 派生四档（一眼分得出源不同）+ 源名（超长省略，
                              title 给全名）。本地书不出（本地身份归封面「本地」与角标）。 */}
                          {srcTag === null ? null : (
                            <span className={`novel-src-tag${srcTag.deleted ? ' gone' : ''}`} title={srcTag.text}>
                              <span className={`novel-src-dot ${sourceTintClass(b.sourceId)}`} />
                              {srcTag.text}
                            </span>
                          )}
                        </span>
                        <span className="novel-card-title">{b.title}</span>
                        <span className="novel-card-meta">{meta.text}</span>
                        {meta.pct === null ? null : <ProgressBar pct={meta.pct} />}
                      </button>
                      {/* 多选态：本地角标把左上让给勾选标记；单本 ✕ 退场（同一职责不留第二个入口） */}
                      {selectMode || !isLocal ? null : <span className="novel-local-tag">本地</span>}
                      {!selectMode ? null : <span className="novel-check" aria-hidden="true">{picked ? '✓' : ''}</span>}
                      {!selectMode ? (
                        <button
                          className="novel-btn sm novel-card-x"
                          title="删除本书"
                          aria-label={`删除 ${b.title}`}
                          onClick={() => { setDelError(null); setPendingDel({ books: [b], batch: false }) }}
                        >✕</button>
                      ) : null}
                    </div>
                  )
                })}
                {/* 网格末位常驻引导卡 = 导入本地书籍（「搜一本书」退役：搜索已由行2搜索框显式承担）。
                    多选态里它也退场：正在挑要删的书时，末位摆一张「导入」卡是纯粹误触面。 */}
                {selectMode ? null : importCard}
              </div>
            )}
      </div>
    </div>
  )
}
