import type { ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { LOCAL_SOURCE_ID, paramRoutes, queries, ROUTES } from '../../shared/wire.js'
import { prodCoreDeps } from '../deps.js'
import type { ClientCoreDeps } from '../deps.js'
import { navigate } from '../store.js'
import type { ShelfBook } from './types.js'
import { coverFallbackChar, EmptyState, ProgressBar, SearchIcon } from './bits.js'
import { deleteBookCopy } from '../shelf-delete.js'
import { filterShelfBooks, SHELF_FILTERS, shelfCardMeta } from '../shelf-view-model.js'
import type { ShelfFilterKey } from '../shelf-view-model.js'
import { coverTintClass } from '../util.js'

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
 *  守卫在 tests/client/ui-system.test.tsx。布局与配色一律归样式类，本文件零行内 style。 */
export function ShelfView({ deps = prodCoreDeps }: { deps?: ClientCoreDeps }): ReactNode {
  const [books, setBooks] = useState<ShelfBook[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [keyword, setKeyword] = useState('')
  const [filter, setFilter] = useState<ShelfFilterKey>('all')
  const [imgFailed, setImgFailed] = useState<Record<string, boolean>>({})
  // 本地 TXT 导入：隐藏 file input + 上传后直进阅读器
  const [importError, setImportError] = useState<string | null>(null)
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
  const [pendingDel, setPendingDel] = useState<ShelfBook | null>(null)
  const [delError, setDelError] = useState<string | null>(null)
  const [delBusy, setDelBusy] = useState(false)
  const modalRef = useRef<HTMLDivElement | null>(null)
  const cancelDel = (): void => { setPendingDel(null); setDelError(null); setDelBusy(false) }
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
  const confirmDelete = (): void => {
    if (pendingDel === null || delBusy) return
    setDelBusy(true)
    void deps.apiSend('DELETE', paramRoutes.shelfKey(pendingDel.bookKey)).then(() => {
      // 成功才本地过滤（失败半场卡片保留——乐观删除的回滚半场归接线测试钉死）
      setBooks((prev) => (prev ?? []).filter((b) => b.bookKey !== pendingDel.bookKey))
      cancelDel()
    }, (e) => {
      // 失败留在模态内：错误就地呈现，可重试可取消（错误不再散落到页面流里粘屏）
      setDelError(e instanceof Error ? e.message : String(e))
      setDelBusy(false)
    })
  }
  useEffect(() => {
    // 失败不许伪装成空架（历史 bug：网络失败 setBooks([]) → 渲染「书架空空」误导）
    void deps.apiGet<ShelfBook[]>(ROUTES.shelf.path).then((list) => {
      setBooks(list)
      setLoadError(null)
    }, (e) => {
      setBooks([])
      setLoadError(e instanceof Error ? e.message : String(e))
    })
  }, [])   // eslint-disable-line react-hooks/exhaustive-deps
  const search = (): void => {
    if (keyword.trim() !== '') navigate({ name: 'search', keyword: keyword.trim() })
  }
  const importCard = (
    <button className="novel-card novel-card-ghost" aria-label="导入本地书籍"
      onClick={() => fileRef.current?.click()}>
      <span className="novel-ghost-cover">＋</span>
      <span className="novel-card-title">导入本地书籍</span>
      <span className="novel-card-meta">TXT 文件</span>
    </button>
  )
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
          {/* 行3：书架筛选簇（有书才渲染——空架/加载中没有可筛的东西）；排序灰字跟簇尾 */}
          {books === null || books.length === 0 ? null : (
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
              <span className="novel-shelf-sort">最近阅读排序 · 进度自动保存</span>
            </div>
          )}
          {/* 隐藏 file input（布局零参与）：触发方只有引导卡 */}
          <input ref={fileRef} type="file" accept=".txt,text/plain" className="novel-file-hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              e.target.value = ''
              if (f === undefined) return
              setImportError(null)
              void deps.apiUpload<{ bookKey: string; title: string; sourceId: string }>(
                queries.localImport({ name: f.name }), f,
              ).then((book) => {
                if (!aliveRef.current) { deps.pushOk(`《${book.title}》已导入，在书架可见`); return }
                navigate({ name: 'reader', sourceId: book.sourceId, bookKey: book.bookKey, title: book.title })
              }, (err) => {
                const text = err instanceof Error ? err.message : String(err)
                if (aliveRef.current) setImportError(text)
                else deps.pushError(`本地书籍导入失败：${text}`)
              })
            }} />
        </header>
        {/* 错误面：导入/加载两处场景内提示；删除错误在确认模态内就地呈现，不散落页面流 */}
        {importError === null ? null : <div className="novel-err novel-note-sm">{importError}</div>}
        {/* 删除确认模态：遮罩 + 居中对话框 + 危险色确认钮；Esc/点遮罩取消，失败留在框内重试。
            测试钉子：✕ 的 title「删除本书」、按钮文案「确认删除」、失败文案「删除失败：…」。 */}
        {pendingDel === null ? null : (() => {
          const copy = deleteBookCopy(pendingDel.title, pendingDel.sourceId === LOCAL_SOURCE_ID)
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
                {filterShelfBooks(books, filter).map((b) => {
                  const isLocal = b.sourceId === LOCAL_SOURCE_ID
                  const failed = imgFailed[b.bookKey] === true
                  const meta = shelfCardMeta(b)
                  return (
                    <div key={b.bookKey} className="novel-cell">
                      <button className="novel-card" aria-label={`阅读 ${b.title}`}
                        onClick={() => navigate({ name: 'reader', sourceId: b.sourceId, bookKey: b.bookKey, title: b.title })}>
                        {isLocal
                          // 本地书专属呈现：封面位直接写「本地」（源身份固定，与在线书区分）
                          ? <span className="novel-cover-fallback sm">本地</span>
                          : b.coverUrl !== undefined && !failed
                            ? <img className="novel-cover" src={b.coverUrl} alt="" loading="lazy"
                                onError={() => setImgFailed((m) => ({ ...m, [b.bookKey]: true }))} />
                            : <span className={`novel-cover-fallback ${coverTintClass(b.title)}`}>{coverFallbackChar(b.title)}</span>}
                        <span className="novel-card-title">{b.title}</span>
                        <span className="novel-card-meta">{meta.text}</span>
                        {meta.pct === null ? null : <ProgressBar pct={meta.pct} />}
                      </button>
                      {!isLocal ? null : <span className="novel-local-tag">本地</span>}
                      <button
                        className="novel-btn sm novel-card-x"
                        title="删除本书"
                        aria-label={`删除 ${b.title}`}
                        onClick={() => { setDelError(null); setPendingDel(b) }}
                      >✕</button>
                    </div>
                  )
                })}
                {/* 网格末位常驻引导卡 = 导入本地书籍（「搜一本书」退役：搜索已由行2搜索框显式承担） */}
                {importCard}
              </div>
            )}
      </div>
    </div>
  )
}
