import type { CSSProperties, ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { LOCAL_SOURCE_ID, bodies, paramRoutes, queries, ROUTES } from '../../shared/wire.js'
import { describeError } from '../api.js'
import { plural, useCopy } from '../copy/index.js'
import { prodReaderDeps } from '../deps.js'
import type { ReaderDeps } from '../deps.js'
import { createExportRun, IDLE_EXPORT, parseRange } from '../export-run.js'
import type { ExportRunState } from '../export-run.js'
import { navigate, prefsStore, setPref, useStore } from '../store.js'
import { FONT_STEPS, LINE_HEIGHTS, MEASURES, PAPER_PRESETS } from '../prefs-ui.js'
import type { ChapterAnchor } from '../progress.js'
import { ReaderScene } from '../reader-scene.js'
import { ReaderSession } from '../reader-session.js'
import type { ReaderPort, VisibleNode } from '../reader-session.js'
import { escOwner, maskFor } from '../reader-surfaces.js'
import { nextChapterIndex } from '../reader-load.js'
import {
  contentOriginTop, findScrollport, portScrollHeight, portScrollTop, portViewHeight, portViewTop, setPortScrollTop,
} from '../scrollport.js'
import { addShelfSeat } from '../shelf-action.js'
import { paperInk, findNovelNode, novelNodes, centerInScroller, stripLeadingTitle } from '../util.js'
import { ErrorBanner, WarningList } from './bits.js'
import { ChapterBody } from './ChapterBody.js'
import { Dialog } from './dialog.js'
import { ReaderNavigation } from './ReaderNavigation.js'
import { ReaderNotes } from './ReaderNotes.js'
import type { BookNavigation, ChapterContent, LocalImportWarning, ShelfBook } from './types.js'

/** 正文层字色由纸张色算：纯函数住址在 util.ts，此处只接线。 */

/** 控制器层 z 序（不变量：**工具栏 > 遮罩**，面板在工具栏内）：
 *  面板嵌在 sticky 工具栏里，而 sticky + z-index 的工具栏**自成 stacking context**——面板自己的
 *  z-index 只在工具栏内部有效。工具栏若 ≤ 遮罩，透明遮罩反压整层：面板看得见但点不了（「Aa 能
 *  弹出但点不了」）。守卫见 tests/client/reader-ctrl-z.test.ts；目录抽屉同用 panel 值
 *  （哪一面带遮罩由 `reader-surfaces.maskFor` 判：只有 Aa 与导出面板要「点外面关掉它」）。 */
export const CTRL_Z = { toolbar: 12, mask: 10, panel: 11 } as const

/** 阅读控制器面板：挂 sticky 工具栏内（定位与滚动锚在工具栏上；z 序见 CTRL_Z），点遮罩关闭。
 *  chip 式控件，布局归样式类 .novel-prefs，行内只留定位与 z；role=dialog + aria-label
 *  （能开能关的浮层，Esc 关，共用 ReaderView 的一条 Esc）。 */
export function PrefsPanel(): ReactNode {
  const t = useCopy()
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
      aria-label={t('reader.settings')}
      className={prefs.darkController ? 'novel-dark novel-prefs' : 'novel-prefs'}
      style={{ position: 'absolute', right: 12, top: 40, zIndex: CTRL_Z.panel }}
    >
      <div>
        <div className="novel-prefs-label">{t('reader.fontSizeCurrent', { size: prefs.fontSize })}</div>
        <div className="novel-chips">
          <button className="novel-chip" onClick={() => step(-1)} aria-label={t('reader.fontSizeDown')}>A−</button>
          <button className="novel-chip" onClick={() => step(1)} aria-label={t('reader.fontSizeUp')}>A＋</button>
        </div>
      </div>
      <div>
        <div className="novel-prefs-label">{t('reader.lineHeight')}</div>
        <div className="novel-chips">
          {LINE_HEIGHTS.map((lh) => (
            <button key={lh} className={prefs.lineHeight === lh ? 'novel-chip on' : 'novel-chip'}
              aria-pressed={prefs.lineHeight === lh}
              onClick={() => setPref({ lineHeight: lh })}>{lh}</button>
          ))}
        </div>
      </div>
      <div>
        <div className="novel-prefs-label">{t('reader.measureCurrent', { n: prefs.measure })}</div>
        <div className="novel-chips">
          {MEASURES.map((m) => (
            <button key={m.em} className={prefs.measure === m.em ? 'novel-chip on' : 'novel-chip'}
              aria-pressed={prefs.measure === m.em}
              onClick={() => setPref({ measure: m.em })}>{t(m.labelKey)}</button>
          ))}
        </div>
      </div>
      <div>
        <div className="novel-prefs-label">{t('reader.paper')}</div>
        <div className="novel-chips">
          {PAPER_PRESETS.map((p) => (
            <button key={p.color} title={t(p.nameKey)} aria-label={t(p.nameKey)} aria-pressed={prefs.paperColor === p.color}
              className={prefs.paperColor === p.color ? 'novel-chip novel-paper-swatch on' : 'novel-chip novel-paper-swatch'}
              style={{ background: p.color, color: paperInk(p.color) }}
              onClick={() => setPref({ paperColor: p.color })} />
          ))}
          {/* 正文层的唯一取色入口：行内只有值本身，外观归 .novel-prefs-color
              （原生 color 控件不套标度会在面板里显得突兀） */}
          <input type="color" className="novel-prefs-color" aria-label={t('reader.paperCustom')}
            value={prefs.paperColor} onChange={(e) => setPref({ paperColor: e.target.value })} />
        </div>
      </div>
      <label>
        <input type="checkbox" checked={prefs.darkController} onChange={(e) => setPref({ darkController: e.target.checked })} />
        {t('reader.darkController')}
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
  const t = useCopy()
  const valid = parseRange(props.from, props.to, props.total)
  return (
    <div
      data-novel-ctrl
      role="dialog"
      aria-label={t('reader.export.range')}
      className={props.darkController ? 'novel-dark novel-prefs' : 'novel-prefs'}
      style={{ position: 'absolute', right: 12, top: 40, zIndex: CTRL_Z.panel }}
    >
      {props.running ? (
        <>
          <div className="novel-prefs-label">
            {props.totalChapters === ''
              ? t('reader.export.runningBytes', { kb: props.kb })
              : plural(t, Number(props.totalChapters), 'reader.export.running.one', 'reader.export.running.other',
                { total: props.totalChapters, kb: props.kb })}
          </div>
          <div className="novel-chips">
            <button className="novel-chip" onClick={props.onCancel}>{t('reader.export.cancel')}</button>
            <button className="novel-chip" onClick={props.onClose}>{t('reader.export.collapse')}</button>
          </div>
        </>
      ) : (
        <>
          <div className="novel-prefs-label">
            {plural(t, props.total, 'reader.export.rangeTotal.one', 'reader.export.rangeTotal.other', { total: props.total })}
          </div>
          <label>
            {t('reader.export.fromPrefix')}
            <input className="novel-input" type="number" min={1} max={props.total}
              value={props.from} onChange={(e) => props.onFrom(e.target.value)} aria-label={t('reader.export.startChapter')} />
            {t('reader.export.between')}
            <input className="novel-input" type="number" min={1} max={props.total}
              value={props.to} onChange={(e) => props.onTo(e.target.value)} aria-label={t('reader.export.endChapter')} />
            {t('reader.export.toSuffix')}
          </label>
          <div className="novel-chips">
            <button className="novel-chip" onClick={() => props.onPreset('all')}>{t('reader.export.all')}</button>
            <button className="novel-chip" onClick={() => props.onPreset('rest')}>{t('reader.export.rest')}</button>
          </div>
          {!valid.ok && <div className="novel-prefs-label" role="status">{t(valid.reason, { total: props.total })}</div>}
          {/* 导出面只有文字：图文书的插图在投影里是占位文字（`chapterContentToText`），
              这句话必须在下手之前说，而不是等用户对着下载到的文件发现插图没了。 */}
          <div className="novel-prefs-label">{t('reader.export.textOnly')}</div>
          <div className="novel-chips">
            <button className="novel-chip" disabled={!valid.ok} onClick={props.onConfirm}>{t('reader.export.download')}</button>
            <button className="novel-chip" onClick={props.onClose}>{t('common.cancel')}</button>
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
  const t = useCopy()
  return (
    <div className="novel-notes-slot">
      <div className="novel-notes" role="dialog" aria-label={t('reader.importNotes')}>
        <div className="novel-toolbar novel-notes-head">
          <span className="novel-notes-title">
            {plural(t, warnings.length, 'reader.importNotesTitle.one', 'reader.importNotesTitle.other')}
          </span>
          <button type="button" className="novel-btn sm" onClick={onClose}>{t('common.close')}</button>
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
 * 阅读器：连续滚动流（章章首尾相接）。两块状态各有主人——阅读时序归「阅读会话」
 * （reader-session.ts），浮层/注释载荷/Esc/离开一问/入架写入归「阅读场景」（reader-scene.ts）；
 * 本视图只做三件事：渲染这两份状态、把 DOM 测量实现成 ReaderPort、把 scroll/resize 喂给会话。
 * 滚动容器由 findScrollport 向上探测（现即 .novel-main 自己），滚动、进度、回跳一律按探测
 * 结果算；只渲染已载章节，预取自限。
 *
 * 图文（EPUB）三个组件只做呈现、只**接线**：正文 ChapterBody、目录树 ReaderNavigation、
 * 脚注/附录 ReaderNotes——去哪一章哪个锚点、进度何时落盘仍是会话的事，浮层开合与返回句柄
 * 仍是场景的事。
 *
 * 呈现层：细工具栏 + 正文居中窄列（布局归样式类；prefs 色/字号/行距行内——正文层永不接宿主
 * token），z 序归 CTRL_Z。deps 走 ReaderDeps（与 ShelfView/SearchView 齐平），导出编排归
 * export-run.ts（场景只管开面板那一下）。
 */
export function ReaderView({ sourceId, bookKey, title, deps = prodReaderDeps }: {
  sourceId: string; bookKey: string; title: string; deps?: ReaderDeps
}): ReactNode {
  const t = useCopy()
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
   *  目录走 navigation 读面（线性 chapters + 展示树 items 同一份响应），正文一律 ChapterContent。
   *  `t` 只进构造：会话的错误快照在生成时定语言（与 job store 同一条已知限制），
   *  语言切换不重开会话——重开会丢目录与阅读位置，代价远大于旧错误条仍说旧语言。 */
  const session = useMemo(() => new ReaderSession({
    fetchNavigation: (s, b) => deps.apiGet<BookNavigation>(queries.navigation({ sourceId: s, url: b })),
    fetchChapter: (s, b, i) => deps.apiGet<ChapterContent>(queries.chapter({ sourceId: s, url: b, index: i })),
    fetchShelf: () => deps.apiGet<ShelfBook[]>(ROUTES.shelf.path),
    saveProgress: (chapterIndex, offsetRatio) => {
      void deps.apiSend('PUT', paramRoutes.shelfKey(bookKey), bodies.shelfProgress(chapterIndex, offsetRatio)).catch(() => undefined)
    },
    saveTotalChapters: (total) => {
      // 幂等补数据：缺 totalChapters 才回写；patch 形态只发这一个字段——
      // 保值语义在 Shelf.update 的 interface 上，不再被迫重发 sourceId+title
      void deps.apiSend('PUT', paramRoutes.shelfKey(bookKey),
        bodies.shelfPatch({ totalChapters: total })).catch(() => undefined)
    },
    afterFrames: (cb) => { requestAnimationFrame(() => requestAnimationFrame(cb)) },
    // bookKey 必须留在这格：saveProgress 与 saveTotalChapters 两枚闭包捕的就是它，摘掉会让进度
    // 一路写给第一本书的地址。sourceId 与 title 不在本工厂里被读——换源走下面那条 open() 的 effect。
  }, readerPort, deps.saveDebounceMs, t), [readerPort, deps, bookKey, t])

  // 第三参 = getServerSnapshot：renderToString（smoke/SSR）必需，缺了直接抛
  const st = useSyncExternalStore(session.subscribe, () => session.state, () => session.state)
  const { toc, navigation, chapters, loadingIdx, error, currentChapter, returnDepth } = st

  /** 角落浮层、注释面板载荷、Esc 归属、离开一问与入架写入归 `client/reader-scene.ts`：
   *  这几条律互相咬合（谁先退场、谁消费返回项、写完能不能被打断），证明它们不该靠整页渲染。
   *  视图只持它的投影与命令，另加导出范围的输入态（字符串，校验单点在 parseRange）。 */
  const [expFrom, setExpFrom] = useState('1')
  const [expTo, setExpTo] = useState('')
  /** 目录总章数：场景只在「加入书架」那一刻读一次。目录未到 = 不知道（null），
   *  不许落成 0——0 会被写成架位上的真读数，并挡住会话的幂等补数。 */
  const tocLenRef = useRef<number | null>(null)
  useEffect(() => { tocLenRef.current = toc?.length ?? null }, [toc])
  const scene = useMemo(() => new ReaderScene({
    session, sourceId, bookKey, title,
    tocLength: () => tocLenRef.current,
    navigate,
    addSeat: (input) => addShelfSeat(input, deps),
    pushOk: deps.pushOk, t,
  }), [session, sourceId, bookKey, title, deps, t])
  // 第三参 = getServerSnapshot：renderToString（smoke/SSR）必需，缺了直接抛
  const sceneState = useSyncExternalStore(scene.subscribe, () => scene.state, () => scene.state)
  /** 收场（Esc 与面板「关闭」钮同一条路）：内链打开的回到引用处——位置提交与返回栈仍归会话 */
  const closeCurrent = (): void => { scene.close() }
  /** 持久导入说明（本地书专属）与它的面板现场：null = 还没问到 / 这本书没有这份东西。
   *  入口只在**真有告警**时出现（正常无警告不新增干扰），面板只展示已取到的清单。 */
  const [importNotes, setImportNotes] = useState<LocalImportWarning[] | null>(null)
  const drawerRef = useRef<HTMLDivElement | null>(null)
  /** 排版变化前的可见节点采点（字号/行距/栏宽变化 → 复位用） */
  const visibleRef = useRef<VisibleNode | null>(null)
  /** 目录当前项：会话按「当前章内最近的已登记导航锚点」裁决，视图只负责在被问到时取一次 */
  const [navActive, setNavActive] = useState<string | null>(null)
  // 浮层共用一条 Esc：归属由 `escOwner` 裁——模态（入架一问）在场时浮层这条不装，Esc 只归
  // `views/dialog.tsx` 的模态契约（收回那一问走场景的 `dismissAsk`）。`askShelf` 必须在依赖里，
  // 否则模态上场时这条监听撤不下来（一次 Esc 会既关模态又收浮层）。归属裁决本身仍归场景命令。
  useEffect(() => {
    if (escOwner(sceneState.surface, sceneState.askShelf) !== 'surface') return
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') scene.handleEsc() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [scene, sceneState.surface, sceneState.askShelf])
  /** 目录高亮：只在抽屉开着时取（一次 DOM 测量，不在滚动路径上）；只在**跨章**与换书时重算
   *  （`currentChapter` 变才醒）——同章内滚动是每帧的量，不值得为一条 aria-current 按帧唤醒。 */
  useEffect(() => {
    if (sceneState.surface !== 'toc') return
    setNavActive(session.activeNavId())
  }, [sceneState.surface, currentChapter, navigation, session])
  /** 打开抽屉即把当前项摆到视野中间——**只滚抽屉自己**，不借 `scrollIntoView`（它连可滚祖先一起
   *  滚，会改写主阅读位置）。口径与被否决方案见 util.ts 的 `centerInScroller`。 */
  useEffect(() => {
    const drawerEl = drawerRef.current
    if (sceneState.surface !== 'toc' || drawerEl === null) return
    centerInScroller(drawerEl, drawerEl.querySelector('[aria-current="true"]'))
  }, [sceneState.surface, navActive])
  // 范围导出：编排归 export-run.ts——start(范围)/cancel/状态三态 + 卸载 abort
  // 在那边可单测；本视图只接线：状态经 onChange 进 state，⤓ 钮开范围面板、面板确认才 start。
  // 导出失败单独一条（会话 error 归阅读链路）
  const [exportState, setExportState] = useState<ExportRunState>(IDLE_EXPORT)
  const exportRun = useMemo(() => createExportRun({
    sourceId, bookKey, title, deps, t, onChange: setExportState,
  }), [deps, sourceId, bookKey, title, t])
  useEffect(() => () => exportRun.dispose(), [exportRun])   // 卸载即取消——不许孤儿抓取
  const expTotal = toc?.length ?? 0
  /** 开导出面板：默认整本（1..N）。互斥不在这里抄一遍——判据在 `reader-surfaces` */
  const openExport = (): void => {
    setExpFrom('1')
    setExpTo(String(expTotal))
    scene.toggle('export')
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
        deps.pushError(t('reader.importNotesFailed', { detail: describeError(e, t) }))
      },
    )
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 取数只随书变；错误文案的语言取发起时那一次
  }, [deps, sourceId, bookKey])
  const hasImportNotes = importNotes !== null && importNotes.length > 0

  /** 刷新滚动容器缓存（内容变化/视口变化时） */
  const refreshPort = useCallback((): void => { portRef.current = findScrollport(bodyRef.current) }, [])

  // 进入：开会话（目录→恢复→懒加载）；卸载：关会话（清防抖定时器）
  useEffect(() => {
    chapterRefs.current = []
    refreshPort()
    void session.open(sourceId, bookKey)
    return () => session.dispose()
  }, [session, sourceId, bookKey, refreshPort])

  // 已载表 / 待跳目标变化：刷新滚动容器后交会话一个渲染后拍点——锚点、落位、预取的次序归会话
  useEffect(() => {
    refreshPort()
    session.afterRender(sourceId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapters, st.pendingJump])

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
  }, [prefs.fontSize, prefs.lineHeight, prefs.measure, readerPort, session, sourceId])

  const shownError = error ?? exportState.error
  /** 纸与墨：条底、条上控件、进度槽全由这两个值槽派生（规则住样式层，行内只给值）。
   *  写在 .novel-rdr 根上而非 .novel-rdr-main 上——条是 main 的兄弟，写在 main 里条够不着。 */
  const paper = { '--novel-paper': prefs.paperColor, '--novel-paper-ink': paperInk(prefs.paperColor) } as CSSProperties
  return (
    <div data-novel-view="reader" className="novel-rdr" style={paper}>
      {/* 偏好/导出面板遮罩：挂 reader 根容器盖满整个阅读区——只盖工具栏条时点正文关不掉面板；
          哪些面带遮罩由 `maskFor` 说了算（目录/注释/导入说明自带收场的钮，不借遮罩顺手关）。 */}
      {maskFor(sceneState.surface) && (
        <div data-novel-ctrl-mask onClick={closeCurrent}
          style={{ position: 'absolute', inset: 0, zIndex: CTRL_Z.mask }} />
      )}
      {/* 控制器层——sticky：滚动容器是 .novel-main，工具栏不 sticky 会随正文一起滚走（目录/Aa 够不着）。
          布局与配色归 .novel-rdr-bar（条底由 --novel-paper 派生；darkController 那一档在
          .novel-rdr-bar.novel-dark 里让回宿主暗底），行内只留 sticky 定位与 z（CTRL_Z 常量，
          ctrl-z 守卫断言）。图标一律 aria-hidden：它们是装饰，可访问名由文案给。 */}
      <div className={prefs.darkController ? 'novel-dark novel-rdr-bar' : 'novel-rdr-bar'}
        style={{ position: 'sticky', top: 0, zIndex: CTRL_Z.toolbar }}>
        <button className="novel-rdr-ctl" onClick={() => { scene.exitToShelf() }}>
          <svg aria-hidden="true" viewBox="0 0 16 16"><path d="M10 3 5 8l5 5" /></svg>{t('reader.shelf')}
        </button>
        {/* 正文内链的返回入口：**一次返回一条**（重复跟随链接才有多层）。栈在会话里、只活在窗口内；
            没押返回项时不渲染——不给一个点了没反应的按钮。位置在「书架」之后，左侧主次分明。 */}
        {returnDepth > 0 && (
          <button className="novel-rdr-ctl" onClick={() => session.goBack(sourceId)}
            title={t('reader.backToOriginTitle')}>{t('reader.backToOrigin')}</button>
        )}
        <span className="novel-rdr-sep" aria-hidden="true" />
        {/* 读数：当前章在主位（这一屏唯一在变的量），书名退副位、总章数交给分母。
            目录未到时不给一个空主位——那时唯一诚实的话就是「目录加载中」。 */}
        <div className="novel-rdr-title">
          {toc === null ? <span className="novel-rdr-chap">{t('reader.tocLoading')}</span> : (
            <>
              <span className="novel-rdr-chap">{toc[currentChapter]?.name ?? ''}</span>
              <span className="novel-rdr-pos">{currentChapter + 1} / {toc.length}</span>
            </>
          )}
          <span className="novel-rdr-book">{title}</span>
        </div>
        <div className="novel-rdr-acts">
          {/* 导入说明入口：**只在真有持久告警的本地书上出现**（没告警一个字都不多说）。
              点开是只读面板——重看入口，不重复取数、不写进度。 */}
          {hasImportNotes && (
            <button className="novel-rdr-ctl" aria-expanded={sceneState.surface === 'importNotes'} aria-label={t('reader.importNotes')}
              onClick={() => { scene.toggle('importNotes') }}
              title={plural(t, importNotes.length, 'reader.importNotesTitle.one', 'reader.importNotesTitle.other')}>
              {t('reader.importNotes')}
            </button>
          )}
          <button
            className="novel-rdr-ctl"
            onClick={() => { if (exportState.running) exportRun.cancel(); else openExport() }}
            title={exportState.running
              ? (exportState.range === null
                ? (exportState.total === ''
                  ? t('reader.export.whole')
                  : plural(t, Number(exportState.total), 'reader.export.whole.one', 'reader.export.whole.other',
                    { total: exportState.total }))
                : t('reader.export.rangeToolbar', { from: exportState.range.from, to: exportState.range.to }))
              : t('reader.export.open')}
          >
            {exportState.running
              ? t('reader.export.toolbarRunning', { kb: exportState.kb })
              : <><svg aria-hidden="true" viewBox="0 0 16 16"><path d="M8 2.5v8m0 0L5 7.5M8 10.5l3-3M3 13h10" /></svg>{t('reader.download')}</>}
          </button>
          {/* 导出面板与 Aa／目录／注释／导入说明永不同场：互斥判据在 `reader-surfaces`，这里只摆当场面 */}
          {sceneState.surface === 'export' && (
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
              onClose={closeCurrent}
              running={exportState.running}
              kb={exportState.kb}
              totalChapters={exportState.total}
              onCancel={() => exportRun.cancel()}
              darkController={prefs.darkController}
            />
          )}
          {/* 互斥、以及「再点同一颗就收场」都不在这两行抄：判据在 `reader-surfaces`。
              工具栏已在遮罩之上（CTRL_Z），所以这些面各自的钮负责收场，不靠遮罩顺手关。 */}
          <button className="novel-rdr-ctl" aria-expanded={sceneState.surface === 'prefs'} aria-label={t('reader.settings')}
            onClick={() => { scene.toggle('prefs') }} title={t('reader.settings')}>Aa</button>
          <button className="novel-rdr-ctl" aria-expanded={sceneState.surface === 'toc'} aria-label={t('reader.contents')}
            onClick={() => { scene.toggle('toc') }}
            title={toc === null ? t('reader.contents') : t('reader.contentsWithCount', { n: toc.length })}>
            {t('reader.contents')}
          </button>
          {sceneState.surface === 'prefs' && <PrefsPanel />}
        </div>
        {/* 章进度：跨章才动（会话只在 chapterIndex 变化时写 currentChapter）。章内百分比刻意不做——
            那是每帧量，会让整棵阅读器每帧重渲染。值槽在轨道本体上，实心那一档由样式层的 ::after 读它。 */}
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
      {/* 离开前那一问（口径见场景的 `exitToShelf`）：共用模态契约（遮罩 + 居中框 + 动作行 + Tab
          圈内、关后还焦——见 `views/dialog.tsx`）。
          「先不加入」是**离开**（用户本来就要走，问过了就不再造第二次），按钮措辞各自说清自己那件事。 */}
      {sceneState.askShelf && (
        <Dialog title={t('reader.join.title')} onClose={() => { scene.dismissAsk() }}
          actions={<>
            <button className="novel-btn sm" onClick={() => navigate({ name: 'shelf' })} disabled={sceneState.joinBusy}>
              {t('reader.join.skip')}
            </button>
            <button className="novel-btn sm primary" onClick={() => { void scene.joinAndBack() }} disabled={sceneState.joinBusy}>
              {sceneState.joinBusy ? t('reader.join.joining') : t('reader.join.confirm')}
            </button>
          </>}>
          <div className="novel-modal-body">{t('reader.join.body')}</div>
          {sceneState.joinError === null ? null : <div className="novel-err novel-note-sm">{t('reader.join.failed', { detail: sceneState.joinError })}</div>}
        </Dialog>
      )}
      {/* 阅读区（full-bleed：纸铺满这一层）：正文列 + 0 宽 sticky 抽屉槽同在此行。
          纸色走值槽（.novel-rdr 根上行内写、样式层读），条与正文因此读的是同一张纸。
          抽屉三版死法与现方案的理由见样式层 .novel-drawer-slot 注释。 */}
      <div className="novel-rdr-main">
        {/* 正文层：字号/行距/栏宽由 prefs 行内固定——永不接宿主 token；字色走 --novel-paper-ink */}
        <div
          ref={bodyRef}
          className="novel-rdr-body"
          style={{
            fontSize: prefs.fontSize, lineHeight: prefs.lineHeight,
            '--novel-measure': `${prefs.measure}em`,
          } as CSSProperties}
        >
          {toc === null && <div className="novel-rdr-loading">{t('reader.tocLoading')}</div>}
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
                <h2 className="novel-rdr-mark">{toc?.[i]?.name ?? t('reader.chapterFallback', { n: i + 1 })}</h2>
                {/* 正文两种形态都在 ChapterBody 里（文字章逐行成段、图文章按白名单映射）：
                    会话把 ChapterContent 原样搬进来，形态分支只在这一处。
                    送进渲染前剥一次重复章名——**只这一处剥**，导出与工具读的是原样正文。 */}
                <ChapterBody content={stripLeadingTitle(content, toc?.[i]?.name ?? t('reader.chapterFallback', { n: i + 1 }))}
                  bookKey={bookKey} onNavigate={(target, role) => { scene.bodyLink(target, role) }} />
              </div>
            ))}
          {toc !== null && (
            <div ref={sentinelRef} data-novel-sentinel className="novel-sentinel">
              {loadingIdx !== null
                ? t('common.loading')
                : nextChapterIndex(chapters, currentChapter) === -1 ? t('reader.endOfBook') : '…'}
            </div>
          )}
        </div>
        {/* 抽屉：0 宽 sticky 槽 + absolute 本体（锚视口、且不切走正文宽度；三版死法见样式层注释）。
            内容 = 目录树（分组标题不可点；同一章可以有多条锚点条目）。 */}
        {sceneState.surface === 'toc' && (
          <div className="novel-drawer-slot">
            <div ref={drawerRef} className="novel-drawer" role="dialog" aria-label={t('reader.contents')}>
              <ReaderNavigation
                items={navigation ?? []}
                activeId={navActive}
                // 目录点击是纯导航：先收抽屉（开抽屉那一步已收掉面板，这里不该有注释载荷可消费），
                // 再由场景分流目标
                onNavigate={(target) => { scene.close(); scene.openTarget(target) }}
              />
            </div>
          </div>
        )}
        {/* 导入说明面板（本地书持久告警）：与注释面板同几何、同 z、互斥——只读，不写任何进度 */}
        {sceneState.surface === 'importNotes' && hasImportNotes && (
          <ImportNotesPanel warnings={importNotes} onClose={closeCurrent} />
        )}
        {/* 注释面板（脚注/附录）：面板是浮层，主阅读位置不受它影响；内链打开的关闭即回引用处 */}
        {sceneState.surface === 'supplement' && sceneState.note !== null && (
          <ReaderNotes
            bookKey={bookKey}
            target={sceneState.note.target}
            requestSeq={sceneState.note.seq}
            deps={deps}
            onNavigate={(target, role) => { scene.panelLink(target, role) }}
            onClose={closeCurrent}
          />
        )}
      </div>
    </div>
  )
}
