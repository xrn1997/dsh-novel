import type { CSSProperties, ReactNode } from 'react'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { LOCAL_SOURCE_ID, paramRoutes, queries, ROUTES, shelfBody } from '../../shared/wire.js'
import { prodReaderDeps } from '../deps.js'
import type { ReaderDeps } from '../deps.js'
import { createExportRun, IDLE_EXPORT, parseRange } from '../export-run.js'
import type { ExportRunState } from '../export-run.js'
import { navigate, prefsStore, setPref, useStore } from '../store.js'
import { FONT_STEPS, LINE_HEIGHTS, MEASURES, PAPER_PRESETS } from '../prefs-ui.js'
import type { ChapterAnchor } from '../progress.js'
import { ReaderSession } from '../reader-session.js'
import type { ReaderPort, VisibleNode } from '../reader-session.js'
import { nextChapterIndex } from '../reader-load.js'
import {
  contentOriginTop, findScrollport, portScrollHeight, portScrollTop, portViewHeight, portViewTop, setPortScrollTop,
} from '../scrollport.js'
import { paperInk, findNovelNode, novelNodes, centerInScroller } from '../util.js'
import { ErrorBanner, WarningList } from './bits.js'
import { ChapterBody } from './ChapterBody.js'
import { ReaderNavigation } from './ReaderNavigation.js'
import { ReaderNotes } from './ReaderNotes.js'
import type { SupplementTarget } from './ReaderNotes.js'
import type { BookNavigation, ChapterContent, LinkRole, LocalImportWarning, ReadingTarget, ShelfBook } from './types.js'

/** 正文层字色由纸张色算：纯函数住址在 util.ts，此处只接线。 */

/** 控制器层 z 序（不变量：**工具栏 > 遮罩**，面板在工具栏内）：
 *  面板嵌在 sticky 工具栏里，而 sticky + z-index 的工具栏**自成 stacking context**——面板自己的
 *  z-index 只在工具栏内部有效。工具栏若 ≤ 遮罩，透明遮罩反压整层：面板看得见但点不了（「Aa 能
 *  弹出但点不了」）。守卫见 tests/client/reader-ctrl-z.test.ts；目录抽屉同用 panel 值
 *  （抽屉与 Aa/导出面板互斥、永不同场，遮罩由 `ctrlOpen` 与 `expOpen` 同候渲染）。 */
export const CTRL_Z = { toolbar: 12, mask: 10, panel: 11 } as const

/** 阅读控制器面板：挂 sticky 工具栏内（定位与滚动锚在工具栏上；z 序见 CTRL_Z），点遮罩关闭。
 *  chip 式控件，布局归样式类 .novel-prefs，行内只留定位与 z；role=dialog + aria-label
 *  （能开能关的浮层，Esc 关，共用 ReaderView 的一条 Esc）。 */
export function PrefsPanel(): ReactNode {
  const prefs = useStore(prefsStore)
  const step = (delta: number): void => {
    const i = FONT_STEPS.indexOf(prefs.fontSize)
    const next = FONT_STEPS[Math.min(FONT_STEPS.length - 1, Math.max(0, (i === -1 ? 3 : i) + delta))]
    setPref({ fontSize: next })
  }
  return (
    <div
      data-novel-ctrl
      role="dialog"
      aria-label="阅读设置"
      className={prefs.darkController ? 'novel-dark novel-prefs' : 'novel-prefs'}
      style={{ position: 'absolute', right: 12, top: 40, zIndex: CTRL_Z.panel }}
    >
      <div>
        <div className="novel-prefs-label">字号（当前 {prefs.fontSize}px）</div>
        <div className="novel-chips">
          <button className="novel-chip" onClick={() => step(-1)} aria-label="减小字号">A−</button>
          <button className="novel-chip" onClick={() => step(1)} aria-label="增大字号">A＋</button>
        </div>
      </div>
      <div>
        <div className="novel-prefs-label">行距</div>
        <div className="novel-chips">
          {LINE_HEIGHTS.map((lh) => (
            <button key={lh} className={prefs.lineHeight === lh ? 'novel-chip on' : 'novel-chip'}
              aria-pressed={prefs.lineHeight === lh}
              onClick={() => setPref({ lineHeight: lh })}>{lh}</button>
          ))}
        </div>
      </div>
      <div>
        <div className="novel-prefs-label">栏宽（每行约 {prefs.measure} 字）</div>
        <div className="novel-chips">
          {MEASURES.map((m) => (
            <button key={m.em} className={prefs.measure === m.em ? 'novel-chip on' : 'novel-chip'}
              aria-pressed={prefs.measure === m.em}
              onClick={() => setPref({ measure: m.em })}>{m.label}</button>
          ))}
        </div>
      </div>
      <div>
        <div className="novel-prefs-label">纸张色（正文层，不随深色主题）</div>
        <div className="novel-chips">
          {PAPER_PRESETS.map((p) => (
            <button key={p.color} title={p.name} aria-label={p.name} aria-pressed={prefs.paperColor === p.color}
              className={prefs.paperColor === p.color ? 'novel-chip novel-paper-swatch on' : 'novel-chip novel-paper-swatch'}
              style={{ background: p.color, color: paperInk(p.color) }}
              onClick={() => setPref({ paperColor: p.color })} />
          ))}
          {/* 正文层的唯一取色入口：行内只有值本身，外观归 .novel-prefs-color
              （原生 color 控件不套标度会在面板里显得突兀） */}
          <input type="color" className="novel-prefs-color" aria-label="自定义纸张色"
            value={prefs.paperColor} onChange={(e) => setPref({ paperColor: e.target.value })} />
        </div>
      </div>
      <label>
        <input type="checkbox" checked={prefs.darkController} onChange={(e) => setPref({ darkController: e.target.checked })} />
        控制器层跟随深色
      </label>
    </div>
  )
}

/**
 * 导出范围面板（⤓ 钮的第一步）：起止章输入 + 快捷预设 + 确认/取消。
 * 口径：点⤓不再直接全下——本面板是唯一开下入口（确认前零请求）；校验单点在
 * export-run.parseRange（倒置/越界/非整数/目录未就绪一律禁确认，宁可不发不发废包）。
 * 挂工具栏内（与 PrefsPanel 同款绝对定位 + CTRL_Z.panel，z 序不变量见 CTRL_Z 头注）；
 * 运行中换进度视图（沿用 ExportRunState），仍在场可取消。role=dialog + aria-label=导出范围。
 */
export function ExportPanel(props: {
  total: number
  from: string
  to: string
  onFrom: (v: string) => void
  onTo: (v: string) => void
  onPreset: (kind: 'all' | 'rest') => void
  onConfirm: () => void
  onClose: () => void
  running: boolean
  kb: number
  /** 运行中章数标题（x-novel-total-chapters 头；未给为空串） */
  totalChapters: string
  onCancel: () => void
  darkController: boolean
}): ReactNode {
  const valid = parseRange(props.from, props.to, props.total)
  return (
    <div
      data-novel-ctrl
      role="dialog"
      aria-label="导出范围"
      className={props.darkController ? 'novel-dark novel-prefs' : 'novel-prefs'}
      style={{ position: 'absolute', right: 12, top: 40, zIndex: CTRL_Z.panel }}
    >
      {props.running ? (
        <>
          <div className="novel-prefs-label">
            {props.totalChapters === '' ? '导出中…' : `导出中 · 共 ${props.totalChapters} 章`}{` · ${props.kb} KB`}
          </div>
          <div className="novel-chips">
            <button className="novel-chip" onClick={props.onCancel}>取消导出</button>
            <button className="novel-chip" onClick={props.onClose}>收起</button>
          </div>
        </>
      ) : (
        <>
          <div className="novel-prefs-label">导出范围（1 基含端，共 {props.total} 章）</div>
          <label>
            从第
            <input className="novel-input" type="number" min={1} max={props.total}
              value={props.from} onChange={(e) => props.onFrom(e.target.value)} aria-label="起始章" />
            章 到第
            <input className="novel-input" type="number" min={1} max={props.total}
              value={props.to} onChange={(e) => props.onTo(e.target.value)} aria-label="结束章" />
            章
          </label>
          <div className="novel-chips">
            <button className="novel-chip" onClick={() => props.onPreset('all')}>整本</button>
            <button className="novel-chip" onClick={() => props.onPreset('rest')}>当前章起</button>
          </div>
          {!valid.ok && <div className="novel-prefs-label" role="status">{valid.reason}</div>}
          {/* 导出面只有文字：图文书的插图在投影里是占位文字（`chapterContentToText`），
              这句话必须在下手之前说，而不是等用户对着下载到的文件发现插图没了。 */}
          <div className="novel-prefs-label">TXT 文字导出，不包含图片</div>
          <div className="novel-chips">
            <button className="novel-chip" disabled={!valid.ok} onClick={props.onConfirm}>⤓ 下载</button>
            <button className="novel-chip" onClick={props.onClose}>取消</button>
          </div>
        </>
      )}
    </div>
  )
}

/**
 * 导入说明面板（EPUB 有损导入的持久交代）：复用注释面板的浮层几何
 * （`.novel-notes`：右上、视口封顶、正文区内滚），与它同属阅读器浮层家族（互斥、Esc 可关）。
 *
 * 内容只有一件事——**服务端持久化的 warnings**：code（程序判据）+ 资源（哪份文档 / 哪张图）+
 * message（人读的交代）。面板**不发请求**：告警在进入阅读器时按书取一次（`GET local/warnings`
 * 刻意不随每次取章重复携带），这里是重看入口而不是第二次读盘。它**不碰主阅读进度**：
 * 没有一处 apiSend，与脚注面板同一条纪律。
 */
export function ImportNotesPanel({ warnings, onClose }: {
  warnings: LocalImportWarning[]
  onClose: () => void
}): ReactNode {
  return (
    <div className="novel-notes-slot">
      <div className="novel-notes" role="dialog" aria-label="导入说明">
        <div className="novel-toolbar novel-notes-head">
          <span className="novel-notes-title">导入说明（{warnings.length} 条）</span>
          <button type="button" className="novel-btn sm" onClick={onClose}>关闭</button>
        </div>
        <div className="novel-notes-body">
          <WarningList warnings={warnings} />
        </div>
      </div>
    </div>
  )
}

/** 视口顶所在的正文节点：取「视口顶已越过」的节点里最靠下的那个（视口顶就在它内部或它之后）；
 *  一个都没越过（视口还在第一个节点之上）→ 取文档顺序里第一个。没有可定位节点（文字章）→ null。 */
function currentNodeOf(blocks: Array<HTMLDivElement | null>, viewTop: number): VisibleNode | null {
  let best: { index: number; nodeId: string; top: number } | undefined
  let first: { index: number; nodeId: string; top: number } | undefined
  blocks.forEach((block, index) => {
    for (const el of novelNodes(block)) {
      const nodeId = el.getAttribute('data-novel-node')
      if (nodeId === null) continue
      const cand = { index, nodeId, top: el.getBoundingClientRect().top - viewTop }
      if (first === undefined) first = cand
      if (cand.top <= 0 && (best === undefined || cand.top > best.top)) best = cand
    }
  })
  const hit = best ?? first
  return hit === undefined ? null : { index: hit.index, nodeId: hit.nodeId, offsetWithinNode: -hit.top }
}

/**
 * 阅读器：连续滚动流（章章首尾相接）。时序编排归「阅读会话」（reader-session.ts）——
 * 本视图只做三件事：渲染会话状态、把 DOM 测量实现成 ReaderPort、把 scroll/resize 喂给会话。
 * 滚动容器由 findScrollport 向上探测（现即 .novel-main 自己），滚动、进度、回跳一律按探测
 * 结果算；只渲染已载章节，预取自限。
 *
 * 图文（EPUB）三个组件只做呈现、只**接线**：正文 ChapterBody、目录树 ReaderNavigation、
 * 脚注/附录 ReaderNotes——去哪一章哪个锚点、进度何时落盘仍是会话的事。
 *
 * 呈现层：细工具栏 + 正文居中窄列（布局归样式类；prefs 色/字号/行距行内——正文层永不接宿主
 * token），z 序归 CTRL_Z。deps 走 ReaderDeps（与 ShelfView/SearchView 齐平），导出编排归
 * export-run.ts。口径详见 `docs/design/client.md`。
 */
export function ReaderView({ sourceId, bookKey, title, deps = prodReaderDeps }: {
  sourceId: string; bookKey: string; title: string; deps?: ReaderDeps
}): ReactNode {
  const prefs = useStore(prefsStore)
  const bodyRef = useRef<HTMLDivElement | null>(null)                  // 正文层：锚点测量基准
  const sentinelRef = useRef<HTMLDivElement | null>(null)              // 未载边界哨兵：进预取区 → 加载下一章
  const portRef = useRef<HTMLElement | null>(null)                     // 真实滚动容器缓存（内容变化时刷新）
  const chapterRefs = useRef<Array<HTMLDivElement | null>>([])

  /** DOM 测量口：会话只读不碰 DOM——测量语义（两套坐标系不许混用）全在这一个对象里 */
  const readerPort = useMemo<ReaderPort>(() => ({
    measureAnchors: (): ChapterAnchor[] => {
      // 锚点 = 章块相对「滚动内容原点」的偏移 + **该章渲染高度**（跨度的唯一来源：存与取
      // 都用它，两个方向才互逆）。不能用 offsetTop：宿主的滚动容器在阅读器之外，
      // 两套坐标系混用会让 locateChapter 恒判第 0 章（进度不落地）
      const origin = contentOriginTop(portRef.current)
      const list: ChapterAnchor[] = []
      chapterRefs.current.forEach((el, i) => {
        if (el !== null && el !== undefined) {
          const rect = el.getBoundingClientRect()
          list.push({ index: i, start: rect.top - origin, height: rect.height })
        }
      })
      return list
    },
    scrollTop: () => portScrollTop(portRef.current),
    setScrollTop: (px) => setPortScrollTop(portRef.current, px),
    viewHeight: () => portViewHeight(portRef.current),
    scrollHeight: () => portScrollHeight(portRef.current),
    sentinelOffset: () => {
      const sentinel = sentinelRef.current
      if (sentinel === null) return null
      return sentinel.getBoundingClientRect().top - portViewTop(portRef.current)
    },
    /** 目标 = 章块顶（anchorId null）或章内那个锚点节点；两者相对**滚动视口顶**。
     *  章块/节点不在 DOM → null（会话据此不落位、等下一轮）。 */
    targetOffset: (index, anchorId) => {
      const block = chapterRefs.current[index]
      if (block === null || block === undefined) return null
      const target = anchorId === null ? block : findNovelNode(block, anchorId)
      if (target === null) return null
      return target.getBoundingClientRect().top - portViewTop(portRef.current)
    },
    currentNode: () => currentNodeOf(chapterRefs.current, portViewTop(portRef.current)),
  }), [])

  /** 会话依赖束：网络 + 帧调度（rAF 双帧 = 等布局落定再测量）；网络走注入 deps。
   *  目录走 navigation 读面（线性 chapters + 展示树 items 同一份响应），正文一律 ChapterContent。 */
  const session = useMemo(() => new ReaderSession({
    fetchNavigation: (s, b) => deps.apiGet<BookNavigation>(queries.navigation({ sourceId: s, url: b })),
    fetchChapter: (s, b, i) => deps.apiGet<ChapterContent>(queries.chapter({ sourceId: s, url: b, index: i })),
    fetchShelf: () => deps.apiGet<ShelfBook[]>(ROUTES.shelf.path),
    saveProgress: (chapterIndex, offsetRatio) => {
      void deps.apiSend('PUT', paramRoutes.shelfKey(bookKey), shelfBody.progress(chapterIndex, offsetRatio)).catch(() => undefined)
    },
    saveTotalChapters: (total) => {
      // 幂等补数据：缺 totalChapters 才回写；patch 形态只发这一个字段——
      // 保值语义在 Shelf.update 的 interface 上，不再被迫重发 sourceId+title
      void deps.apiSend('PUT', paramRoutes.shelfKey(bookKey),
        shelfBody.patch({ totalChapters: total })).catch(() => undefined)
    },
    afterFrames: (cb) => { requestAnimationFrame(() => requestAnimationFrame(cb)) },
  }, readerPort, deps.saveDebounceMs), [readerPort, deps, sourceId, bookKey, title])

  // 第三参 = getServerSnapshot：renderToString（smoke/SSR）必需，缺了直接抛
  const st = useSyncExternalStore(session.subscribe, () => session.state, () => session.state)
  const { toc, navigation, chapters, loadingIdx, error, currentChapter, returnDepth } = st

  const [drawer, setDrawer] = useState(false)
  const [ctrlOpen, setCtrlOpen] = useState(false)
  // 导出范围面板现场（纯视图状态）：开合 + 起止章字符串（输入态保字符串，校验单点在 parseRange）。
  // 声明在 Esc effect 之前——浮层五兄弟（ctrlOpen/drawer/expOpen/note/notesOpen）共用一条 Esc，顺序即 TDZ 边界
  const [expOpen, setExpOpen] = useState(false)
  const [expFrom, setExpFrom] = useState('1')
  const [expTo, setExpTo] = useState('')
  /** 注释面板现场（脚注/附录）：目标 + **开面板时压入的那条返回项**（会话给的句柄）+ 打开意图序号。
   *  `entry` 决定关闭语义：非 null = 内链打开（关闭即回引用处）；null = 目录直接点进来（只关面板）。
   *  句柄交回会话时只有栈顶仍是它才被消费——期间跟了别的链接，那条记的是别人的原处。
   *  `seq` 每次「外层重新指向」都 +1，面板内部栈按它重置（只比目标值会漏：同一脚注被点第二次时
   *  目标值不变，但期间用户可能已在面板里跟到别的文档）。 */
  const [note, setNote] = useState<{ target: SupplementTarget; entry: VisibleNode | null; seq: number } | null>(null)
  const noteSeqRef = useRef(0)
  /** 打开注释面板：序号自增（面板按它重置内部栈），目标与返回项句柄一起记下 */
  const openNote = (target: SupplementTarget, entry: VisibleNode | null): void => {
    noteSeqRef.current += 1
    setNote({ target, entry, seq: noteSeqRef.current })
  }
  /** 只收**面板这一层浮层**，不消费返回栈条目——开另一个角落浮层（目录/Aa/导出/导入说明）时的
   *  互斥用它，不走 `closeNote`：「我要开目录」不是对阅读位置的表态，借关闭语义收面板等于开个
   *  抽屉把正文跳走。返回项留在栈里由「↩ 返回原处」承接（同口径见 toggleImportNotes）。 */
  const hideNoteSurface = (): void => {
    if (note !== null) setNote(null)
  }
  /** 持久导入说明（本地书专属）与它的面板现场：null = 还没问到 / 这本书没有这份东西。
   *  入口只在**真有告警**时出现（正常无警告不新增干扰），面板只展示已取到的清单。 */
  const [importNotes, setImportNotes] = useState<LocalImportWarning[] | null>(null)
  const [notesOpen, setNotesOpen] = useState(false)
  const drawerRef = useRef<HTMLDivElement | null>(null)
  /** 排版变化前的可见节点采点（字号/行距/栏宽变化 → 复位用） */
  const visibleRef = useRef<VisibleNode | null>(null)
  /** 目录当前项：会话按「当前章内最近的已登记导航锚点」裁决，视图只负责在被问到时取一次 */
  const [navActive, setNavActive] = useState<string | null>(null)
  /** 关闭注释面板：内链打开的回到引用处（位置提交与返回栈都归会话） */
  const closeNote = (): void => {
    if (note !== null) session.closeSupplement(sourceId, note.entry)
    setNote(null)
  }
  // 浮层（Aa 面板 / 目录抽屉 / 导出面板 / 注释面板 / 导入说明面板）共用一条 Esc：任一在场就装监听。
  // Esc 关闭面板与「关闭」钮同一条语义（内链打开的会回引用处）——两条入口不许分叉。
  useEffect(() => {
    if (!ctrlOpen && !drawer && !expOpen && note === null && !notesOpen) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      setCtrlOpen(false)
      setDrawer(false)
      setExpOpen(false)
      setNotesOpen(false)
      closeNote()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctrlOpen, drawer, expOpen, note, notesOpen, session, sourceId])
  /** 目录高亮：只在抽屉开着时取（一次 DOM 测量，不在滚动路径上）；只在**跨章**与换书时重算
   *  （`currentChapter` 变才醒）——同章内滚动是每帧的量，不值得为一条 aria-current 按帧唤醒。 */
  useEffect(() => {
    if (!drawer) return
    setNavActive(session.activeNavId())
  }, [drawer, currentChapter, navigation, session])
  /** 打开抽屉即把当前项摆到视野中间——**只滚抽屉自己**，不借 `scrollIntoView`（它连可滚祖先一起
   *  滚，会改写主阅读位置）。口径与被否决方案见 util.ts 的 centerInScroller，读数见
   *  docs/design/client.md「只读浮层的落位只滚自己」。 */
  useEffect(() => {
    const drawerEl = drawerRef.current
    if (!drawer || drawerEl === null) return
    centerInScroller(drawerEl, drawerEl.querySelector('[aria-current="true"]'))
  }, [drawer, navActive])
  // 范围导出：编排归 export-run.ts——start(范围)/cancel/状态三态 + 卸载 abort
  // 在那边可单测；本视图只接线：状态经 onChange 进 state，⤓ 钮开范围面板、面板确认才 start。
  // 导出失败单独一条（会话 error 归阅读链路）
  const [exportState, setExportState] = useState<ExportRunState>(IDLE_EXPORT)
  const exportRun = useMemo(() => createExportRun({
    sourceId, bookKey, title, deps, onChange: setExportState,
  }), [deps, sourceId, bookKey, title])
  useEffect(() => () => exportRun.dispose(), [exportRun])   // 卸载即取消——不许孤儿抓取
  const expTotal = toc?.length ?? 0
  /** 开面板：默认整本（1..N），并收掉互斥浮层（Aa / 目录 / 导入说明与面板永不同场） */
  const openExport = (): void => {
    setCtrlOpen(false)
    setDrawer(false)
    setNotesOpen(false)
    hideNoteSurface()
    setExpFrom('1')
    setExpTo(String(expTotal))
    setExpOpen(true)
  }

  /** 持久导入说明：**只有本地书有这份东西**，按书取一次（`local/warnings` 刻意不随取章携带）。
   *  取不到就不出入口（不拿未知当「有」），但**不静默**：入口不出现是降级，失败仍上报（两个
   *  半场都不许静默）。 */
  useEffect(() => {
    if (sourceId !== LOCAL_SOURCE_ID) { setImportNotes(null); return }
    let alive = true
    void deps.apiGet<LocalImportWarning[]>(queries.localWarnings({ id: bookKey })).then(
      (list) => { if (alive) setImportNotes(list) },
      (e: unknown) => {
        if (!alive) return
        setImportNotes(null)
        deps.pushError(`导入说明读取失败：${e instanceof Error ? e.message : String(e)}`)
      },
    )
    return () => { alive = false }
  }, [deps, sourceId, bookKey])
  const hasImportNotes = importNotes !== null && importNotes.length > 0
  /** 导入说明面板与别的浮层互斥（同住右上角，与目录/Aa/导出同一条纪律）。脚注面板在这里
   *  **只收面板、不消费返回项**（不调 `closeNote`）：「看一眼导入说明」是只读动作，按关闭语义走
   *  会把主序列跳回引用处、还落一笔存档（口径同 hideNoteSurface）。 */
  const toggleImportNotes = (): void => {
    setCtrlOpen(false)
    setDrawer(false)
    setExpOpen(false)
    hideNoteSurface()
    setNotesOpen((open) => !open)
  }

  /** 刷新滚动容器缓存（内容变化/视口变化时） */
  const refreshPort = (): void => { portRef.current = findScrollport(bodyRef.current) }

  /** 目标分发：主序列目标走会话跳章（含章内锚点），补充文档开注释面板。
   *  **目录点击是纯导航**（不押返回项）——只有正文内链才建立「返回原处」。 */
  const openTarget = (target: ReadingTarget): void => {
    if (target.kind === 'chapter') { session.requestJump(sourceId, target.index, target.anchorId); return }
    setNotesOpen(false)                                  // 注释面板与导入说明同处一层浮层
    openNote(target, null)                               // 目录进来：没有引用处可回
  }

  /** 正文内链（ChapterBody 的链接节点）：先由会话采点/消费返回项，再按目标分流。
   *  角色必须带过去——`backlink` 本身就是「回正文」，会话据此不压新栈；
   *  采点返回的那条要随面板一起记下来：关闭面板时只说「消费我打开面板时压的那条」。 */
  const bodyLink = (target: ReadingTarget, role: LinkRole): void => {
    const entry = session.followLink(sourceId, target, role)
    if (target.kind === 'supplement') { setNotesOpen(false); openNote(target, entry) }
  }

  /** 注释面板里点到主序列：面板退场、由会话跳（返回项归那次采点，不新押一条） */
  const panelLink = (target: ReadingTarget, role: LinkRole): void => {
    setNote(null)
    session.followLink(sourceId, target, role)
  }

  // 进入：开会话（目录→恢复→懒加载）；卸载：关会话（清防抖定时器）
  useEffect(() => {
    chapterRefs.current = []
    refreshPort()
    void session.open(sourceId, bookKey)
    return () => session.dispose()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session])

  // 已载表变化：刷新滚动容器与锚点 → 补足预取（哨兵出区即自限，不会全书风暴）
  useEffect(() => {
    refreshPort()
    session.recalcAnchors()
    session.checkPreload(sourceId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapters])

  // 视口变化：capture 阶段收「任意容器」的 scroll（scroll 不冒泡，但捕获阶段会经过 document——
  // 滚动容器（.novel-main 或更外层）的滚动因此都收得到）；rAF 合帧
  useEffect(() => {
    let raf = 0
    const schedule = (): void => {
      if (raf !== 0) return
      raf = requestAnimationFrame(() => {
        raf = 0
        refreshPort()
        session.handleViewportChange(sourceId)
      })
    }
    document.addEventListener('scroll', schedule, { capture: true, passive: true })
    window.addEventListener('resize', schedule)
    schedule()
    return () => {
      document.removeEventListener('scroll', schedule, { capture: true })
      window.removeEventListener('resize', schedule)
      if (raf !== 0) cancelAnimationFrame(raf)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session])

  // 目录直达：目标章渲染落地后定位（未落地：会话保有 pendingJump，下轮 chapters 变化再试）
  useEffect(() => {
    session.settleJump()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapters, st.pendingJump])

  /** 排版变化前的采点：prefsStore 的订阅者在 `setPref` 的同步调用栈里执行——那一刻 React 还没重渲染、
   *  DOM 还是旧排版，这是唯一能拿到「变化前位置」的时刻（任何 effect 都在新排版落定之后才跑）。 */
  useEffect(() => prefsStore.subscribe(() => { visibleRef.current = readerPort.currentNode() }), [readerPort])

  /** 字号/行距/栏宽变化 → 重排：把「变化前视口顶所在的那个节点」拉回同一视口相对位置。
   *  插图框已按可信宽高预留（ChapterBody），所以这里不必等图片下载完；这里也不轮询图片。
   *  自限：effect 只依赖三个排版量、自己不写 prefs，所以不可能自我触发成重定位环。
   *  位置提交仍归会话——复位后喂一次视口读数，由会话按真实读数修正比例（此处不写进度）。 */
  useEffect(() => {
    const snap = visibleRef.current
    if (snap === null) return
    const off = readerPort.targetOffset(snap.index, snap.nodeId)
    if (off === null) return
    readerPort.setScrollTop(readerPort.scrollTop() + off + snap.offsetWithinNode)
    visibleRef.current = readerPort.currentNode()        // 复位后重采：连调两次排版也各有正确锚
    session.handleViewportChange(sourceId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefs.fontSize, prefs.lineHeight, prefs.measure, readerPort, session, sourceId])

  const shownError = error ?? exportState.error
  return (
    <div data-novel-view="reader" className="novel-rdr">
      {/* 偏好/导出面板遮罩：挂 reader 根容器盖满整个阅读区——只盖工具栏条时点正文关不掉面板；
          导出面板同用（互斥浮层同一把 Esc + 同一层遮罩） */}
      {(ctrlOpen || expOpen) && (
        <div data-novel-ctrl-mask onClick={() => { setCtrlOpen(false); setExpOpen(false) }}
          style={{ position: 'absolute', inset: 0, zIndex: CTRL_Z.mask }} />
      )}
      {/* 控制器层（主题变量；darkController 决定是否跟随深色）——sticky：滚动容器是 .novel-main，
          工具栏不 sticky 会随正文一起滚走（目录/Aa 够不着）。布局归 .novel-rdr-bar（样式层），
          行内只留 sticky 定位与 z（CTRL_Z 常量，ctrl-z 守卫断言）；novel-dark 挂工具栏根。 */}
      <div className={prefs.darkController ? 'novel-dark novel-rdr-bar' : 'novel-rdr-bar'}
        style={{ position: 'sticky', top: 0, zIndex: CTRL_Z.toolbar }}>
        <button className="novel-btn sm" onClick={() => navigate({ name: 'shelf' })}>‹ 书架</button>
        {/* 正文内链的返回入口：**一次返回一条**（重复跟随链接才有多层）。栈在会话里、只活在窗口内；
            没押返回项时不渲染——不给一个点了没反应的按钮。位置在「‹ 书架」之后，左侧主次分明。 */}
        {returnDepth > 0 && (
          <button className="novel-btn sm" onClick={() => session.goBack(sourceId)}
            title="回到跟随链接前的位置">↩ 返回原处</button>
        )}
        <div className="novel-rdr-title">
          <span className="novel-rdr-book">{title}</span>{toc === null ? '' : ` · 共 ${toc.length} 章`}
        </div>
        <div className="novel-rdr-acts">
          {/* 导入说明入口：**只在真有持久告警的本地书上出现**（没告警一个字都不多说）。
              点开是只读面板——重看入口，不重复取数、不写进度。 */}
          {hasImportNotes && (
            <button className="novel-btn sm" aria-expanded={notesOpen} aria-label="导入说明"
              onClick={toggleImportNotes} title={`导入说明（${importNotes.length} 条）`}>导入说明</button>
          )}
          <button
            className="novel-btn sm"
            onClick={() => { if (exportState.running) exportRun.cancel(); else openExport() }}
            title={exportState.running
              ? (exportState.range === null
                ? (exportState.total === '' ? '整本导出' : `整本导出（共 ${exportState.total} 章）`)
                : `范围导出（第 ${exportState.range.from}–${exportState.range.to} 章）`)
              : '导出（选择章节范围）'}
          >
            {exportState.running ? `⤓ ${exportState.kb} KB · 取消导出` : '⤓ 下载'}
          </button>
          {/* 面板与 Aa 互斥：开任一先关另一（openExport / 下方 onClick 各自收口） */}
          {expOpen && (
            <ExportPanel
              total={expTotal}
              from={expFrom}
              to={expTo}
              onFrom={setExpFrom}
              onTo={setExpTo}
              onPreset={(kind) => {
                if (kind === 'all') { setExpFrom('1'); setExpTo(String(expTotal)) }
                else { setExpFrom(String(currentChapter + 1)); setExpTo(String(expTotal)) }
              }}
              onConfirm={() => {
                const v = parseRange(expFrom, expTo, expTotal)
                if (!v.ok) return                                    // 校验单点：倒置/越界不发废包
                exportRun.start({ from: v.from, to: v.to, total: expTotal })
              }}
              onClose={() => setExpOpen(false)}
              running={exportState.running}
              kb={exportState.kb}
              totalChapters={exportState.total}
              onCancel={() => exportRun.cancel()}
              darkController={prefs.darkController}
            />
          )}
          <button className="novel-btn sm" aria-expanded={ctrlOpen} aria-label="阅读设置"
            onClick={() => { setExpOpen(false); setNotesOpen(false); hideNoteSurface(); setCtrlOpen(!ctrlOpen) }}
            title="阅读设置">Aa</button>
          {/* 目录与 Aa/导出/注释面板互斥：工具栏已在遮罩之上（CTRL_Z），点目录不再被遮罩顺手关面板——自己关。
              注释面板同住右上角且更宽，叠着会让目录**点不动**（命中测试打到面板头）。 */}
          <button className="novel-btn sm" aria-expanded={drawer} aria-label="目录"
            onClick={() => { setCtrlOpen(false); setExpOpen(false); setNotesOpen(false); hideNoteSurface(); setDrawer(!drawer) }}
            title={toc === null ? '目录' : `目录（${toc.length}）`}>目录</button>
          {ctrlOpen && <PrefsPanel />}
        </div>
        {/* 章进度细线：跨章才动（会话只在 chapterIndex 变化时写 currentChapter）。
            章内百分比刻意不做——那是每帧量，会让整棵阅读器每帧重渲染。 */}
        <i className="novel-rdr-trail" aria-hidden="true"
          style={{ '--novel-pct': String(toc === null ? 0 : (currentChapter + 1) / toc.length) } as CSSProperties} />
      </div>
      {/* 会话错误的重试必须真的重拉（接到导出态复位对会话错误是空操作、红条会永久粘屏）；
          导出错误才走导出态复位。 */}
      {shownError !== null && (
        <ErrorBanner error={shownError} onRetry={() => {
          if (error !== null) session.retry()
          else setExportState(IDLE_EXPORT)
        }} />
      )}
      {/* 阅读区（纸张色铺满这一层 = full-bleed）：正文列 + 0 宽 sticky 抽屉槽同在此行。
          抽屉三版死法与现方案的理由见样式层 .novel-drawer-slot 注释。 */}
      <div className="novel-rdr-main" style={{ background: prefs.paperColor }}>
        {/* 正文层：字色/字号/行距/栏宽由 prefs 行内固定——永不接宿主 token；纸张色在**外层
            .novel-rdr-main** 上（full-bleed：纸铺满阅读区，正文列只管文字排到哪儿为止） */}
        <div
          ref={bodyRef}
          className="novel-rdr-body"
          style={{
            color: paperInk(prefs.paperColor),
            fontSize: prefs.fontSize, lineHeight: prefs.lineHeight,
            '--novel-measure': `${prefs.measure}em`,
          } as CSSProperties}
        >
          {toc === null && <div className="novel-rdr-loading">目录加载中…</div>}
          {/* 只渲染已载章节：未载章节不进 DOM——scrollHeight 才等于「已读内容高」，预取判据才成立 */}
          {chapters.map((content, i) => content === null
            ? null
            : (
              <div
                key={i}
                ref={(el) => { chapterRefs.current[i] = el }}
                data-chapter={i}
              >
                {/* h2 不是 h3：阅读器这一屏没有更高的标题占位，从 h3 起等于给读屏一份断了头的大纲 */}
                <h2>{toc?.[i]?.name ?? `第 ${i + 1} 章`}</h2>
                {/* 正文两种形态都在 ChapterBody 里（文字章逐行成段、图文章按白名单映射）：
                    会话把 ChapterContent 原样搬进来，形态分支只在这一处 */}
                <ChapterBody content={content} bookKey={bookKey} onNavigate={bodyLink} />
              </div>
            ))}
          {toc !== null && (
            <div ref={sentinelRef} data-novel-sentinel className="novel-sentinel">
              {loadingIdx !== null ? '加载中…' : nextChapterIndex(chapters, currentChapter) === -1 ? '— 全书完 —' : '…'}
            </div>
          )}
        </div>
        {/* 抽屉：0 宽 sticky 槽 + absolute 本体（锚视口、且不切走正文宽度；三版死法见样式层注释）。
            内容 = 目录树（分组标题不可点；同一章可以有多条锚点条目）。 */}
        {drawer && (
          <div className="novel-drawer-slot">
            <div ref={drawerRef} className="novel-drawer" role="dialog" aria-label="目录">
              <ReaderNavigation
                items={navigation ?? []}
                activeId={navActive}
                onNavigate={(target) => { setDrawer(false); openTarget(target) }}
              />
            </div>
          </div>
        )}
        {/* 导入说明面板（本地书持久告警）：与注释面板同几何、同 z、互斥——只读，不写任何进度 */}
        {notesOpen && hasImportNotes && (
          <ImportNotesPanel warnings={importNotes} onClose={() => setNotesOpen(false)} />
        )}
        {/* 注释面板（脚注/附录）：面板是浮层，主阅读位置不受它影响；内链打开的关闭即回引用处 */}
        {note !== null && (
          <ReaderNotes
            bookKey={bookKey}
            target={note.target}
            requestSeq={note.seq}
            deps={deps}
            onNavigate={panelLink}
            onClose={closeNote}
          />
        )}
      </div>
    </div>
  )
}
