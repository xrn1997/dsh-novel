import type { CSSProperties, MutableRefObject, ReactNode } from 'react'
import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { LOCAL_SOURCE_ID, bodies, paramOps, queries } from '../../shared/wire.js'
import { describeError } from '../api.js'
import { plural, useCopy } from '../copy/index.js'
import { prodReaderDeps } from '../deps.js'
import { markPanelShelfLanded, readPanelShelf } from '../panel-shelf.js'
import type { ReaderDeps } from '../deps.js'
import { applyPreset, createExportRun, draftOf, IDLE_EXPORT, validRangeOf } from '../export-run.js'
import type { ExportDraft, ExportRunState } from '../export-run.js'
import { navigate, prefsStore, useStore } from '../store.js'
import { ReaderScene } from '../reader-scene.js'
import { ReaderSession } from '../reader-session.js'
import type { ReaderRevealTarget } from '../reader-session.js'
import { createReaderBinding } from '../reader-binding.js'
import { nextChapterIndex } from '../reader-load.js'
import { addShelfSeat } from '../shelf-action.js'
import { pauseListening, resumeListening, startFromReadingPosition, takeReaderRelocation, ttsPlayer } from '../tts/player.js'
import { enterReader } from '../tts/reader-presence.js'
import { createFollowController } from '../tts/follow-controller.js'
import type { FollowController } from '../tts/follow-controller.js'
import { setReadingProbe } from '../tts/reading-position.js'
import { useListenScope } from '../tts/use-listen-scope.js'
import { TtsBar } from '../tts/TtsBar.js'
import { ttsErrorMessage } from '../tts/tts-error.js'
import { chapterBodyProjection, displayChapterTitle, paperInk, paperLiveInk, centerInScroller } from '../util.js'
import { ErrorBanner } from './bits.js'
import { BookStage } from './BookStage.js'
import { ChapterBody } from './ChapterBody.js'
import { ExportPanel } from './ExportPanel.js'
import { ImportNotesPanel } from './ImportNotesPanel.js'
import { PrefsPanel } from './PrefsPanel.js'
import { useListenFromSelection } from './listen-from-selection.js'
import { claimKeyLayer, Dialog } from './dialog.js'
import { ReaderNavigation } from './ReaderNavigation.js'
import { ReaderNotes } from './ReaderNotes.js'
import type { BookNavigation, ChapterContent, LinkRole, LocalImportWarning, ReadingTarget } from './types.js'
import { MoyuToggle } from './MoyuToggle.js'
import { MoyuStage } from './MoyuStage.js'

// 以下三件是**兼容既有 import 路径**的再导出（实现住在各自面板文件；tests/client 仍从本模块取件，别当死代码清掉）
export { ExportPanel } from './ExportPanel.js'
export { ImportNotesPanel } from './ImportNotesPanel.js'
export { PrefsPanel } from './PrefsPanel.js'


/** 控制器层 z 序（不变量：**工具栏 > 遮罩**，面板在工具栏内）：sticky 工具栏自成 stacking
 *  context，工具栏若 ≤ 遮罩，透明遮罩反压整层：面板看得见但点不了。守卫见
 *  tests/client/reader-ctrl-z.test.ts；目录抽屉同用 panel 值。 */
export const CTRL_Z = { toolbar: 12, mask: 10, panel: 11 } as const

/** 已载章块：memo 以 (content, name, bookKey, onNavigate) 为界，父视图的 loading/currentChapter
 *  变化不再重渲历史章节。章身份写在 `data-chapter` 上，选区起播由阅读器一处监听按它归属。 */
const ChapterShell = memo(function ChapterShell(props: {
  index: number
  content: ChapterContent
  name: string
  bookKey: string
  onNavigate: (target: ReadingTarget, role: LinkRole) => void
  chapterRefs: MutableRefObject<Array<HTMLDivElement | null>>
  listenParagraph: number | null
}): ReactNode {
  const { index, content, name, bookKey, onNavigate, chapterRefs, listenParagraph } = props
  const body = useMemo(() => chapterBodyProjection(content, name), [content, name])
  return (
    <div ref={(el) => { chapterRefs.current[index] = el }} data-chapter={index}>
      {/* h2 不是 h3：阅读器这一屏没有更高的标题占位，从 h3 起等于给读屏一份断了头的大纲 */}
      <h2 className="novel-rdr-mark">{name}</h2>
      {/* 正文两种形态都在 ChapterBody；送渲染前剥一次重复章名——只这一处剥 */}
      <ChapterBody
        content={body.content}
        bookKey={bookKey}
        onNavigate={onNavigate}
        paragraphBase={body.paragraphBase}
        listenParagraph={listenParagraph}
      />
    </div>
  )
})

/**
 * 阅读器：连续滚动流（章章首尾相接）。三块各有主人——阅读时序归阅读会话，浮层/注释载荷/Esc/
 * 离开一问/入架写入归阅读场景，DOM 侧（拍点触发、帧泵、滚动容器刷新、监听装摘、探针）归阅读器
 * DOM 绑定。本视图只渲染状态、交 refs、摆纯 UI 策略；每次渲染后只调一个无条件的门
 * （`binding.rendered`），不再枚举「哪些状态变化要拍点」。
 *
 * 图文（EPUB）三个组件只做呈现与接线；prefs 色/字号/行距行内（正文层永不接宿主 token），
 * z 序归 CTRL_Z。deps 走 ReaderDeps，导出编排归 export-run.ts。
 */
export function ReaderView({ sourceId, bookKey, title, deps = prodReaderDeps }: {
  sourceId: string; bookKey: string; title: string; deps?: ReaderDeps
}): ReactNode {
  const t = useCopy()
  const prefs = useStore(prefsStore)
  const isPaged = prefs.readingMode === 'page'
  /** 回调里读模式但保持回调身份稳定：`takeOverReading` 进 binding 的依赖，身份一变就会重建
   *  binding → 会话 → 重开书；模式切换只能走 ref。 */
  const isPagedRef = useRef(isPaged)
  isPagedRef.current = isPaged
  /** 排版三量的指纹：模式切换也会让 effect 重跑，但模式切换不归 `applyTypesetRelocation`。 */
  const typesetKey = `${prefs.fontSize}:${prefs.lineHeight}:${prefs.measure}`
  const typesetKeyRef = useRef(typesetKey)
  /** 听书范围按原语窄订阅一次算完（`tts/use-listen-scope`）：整店订阅会让每段推进都重渲顶层。
   *  `showing` = 本书就是正在听的会话——听书条挂载条件，也是「从阅读位置起播」的闸门。 */
  const listen = useListenScope(bookKey)
  const bodyRef = useRef<HTMLDivElement | null>(null)                  // 正文层：锚点测量基准
  const sentinelRef = useRef<HTMLDivElement | null>(null)              // 未载边界哨兵：进预取区 → 加载下一章
  const chapterRefs = useRef<Array<HTMLDivElement | null>>([])
  /** 「回阅读器」的重定位现场（按书记）：模块级现场一次性，而本 mount 的 effect 可能连跑两趟
   *  （StrictMode），第一趟取走的现场必须留给第二趟，否则双挂载会丢掉听书位置。 */
  const relocationRef = useRef<{ sourceId: string; bookKey: string; target: ReaderRevealTarget | null } | null>(null)
  /** 跟读策略 module（零 React）：跟随开关、relocation 待办与 reveal 决策都住它。 */
  const followControllerRef = useRef<FollowController | null>(null)
  /** 听书条根：跟随的可视底界要扣掉它的高度（条贴视口底，目标段不许藏在它下面）。 */
  const ttsBarRef = useRef<HTMLDivElement | null>(null)
  /** 翻页模式下是否处于「用户已接管」状态（与滚动模式的 followController 同口径：翻页让位、定位/新会话恢复）。 */
  const [pagedFollowYielded, setPagedFollowYielded] = useState<boolean>(false)
  /** 听书条内设置弹层是否打开：打开时让出翻页快捷键。 */
  const [ttsSettingsOpen, setTtsSettingsOpen] = useState<boolean>(false)
  /** 翻页模式下「定位到正在念的段」脉冲计数：即便当前已在跟随态，点击定位仍触发一次校准。 */
  const [pagedLocateTick, setPagedLocateTick] = useState<number>(0)
  /** 翻页模式阅读位置探针：取当前可见页左上角第一段号，避免从任意页点「听书」退回章首第 0 段。 */
  const pagedProbeParagraphRef = useRef<(() => number) | null>(null)
  /** 翻页模式下记录上一次听书章段，用于区分自然顺序推进（+1）与用户主动跳段/拖滑杆/切章。 */
  const lastPagedListenRef = useRef<{ chapterIndex: number; paragraphIndex: number } | null>(null)
  /** 选区「从本段听」浮钮收起句柄：翻页模式靠 transform 切页不触发 scroll，翻页/跳章时一起收起。 */
  const listenFromClearRef = useRef<(() => void) | null>(null)
  /** 上一帧是否翻页模式：从翻页切回滚动时，绑定首帧喂视口前先把页内比例摆成滚动位。 */
  const wasPagedRef = useRef(isPaged)
  /** 用户把视口带走：跟随即让位，挂起的自动定位与在途落位一并作废。
   *  翻页模式的让位由 `pagedFollowYielded` 自己管；`follow.onUserIntent` 会走
   *  `session.cancelJump()` 按滚动锚点重记位置，那里没有翻页视口可读。 */
  const takeOverReading = useCallback((): void => {
    setPagedFollowYielded(true)
    listenFromClearRef.current?.()
    if (!isPagedRef.current) followControllerRef.current?.onUserIntent()
  }, [])
  /** 顶条（sticky）：它的高度就是滚动视口顶的固定遮挡，阅读位置一律按「条下方第一行」算。 */
  const barRef = useRef<HTMLDivElement | null>(null)
  const topInset = useCallback((): number => barRef.current?.getBoundingClientRect().height ?? 0, [])

  /** 阅读器的 DOM 侧绑定：拍点触发、帧泵、端口刷新、监听装摘、探针与回调次序全归它。 */
  const binding = useMemo(() => createReaderBinding({
    source: {
      body: () => bodyRef.current,
      sentinel: () => sentinelRef.current,
      chapters: () => chapterRefs.current,
    },
    topInset,
    // 正文上的滚轮 / 触摸 / 滚动键 / 滚动条拖动 = 读者接管视口；程序跟随的 scrollTop 不经过这里
    onUserIntent: takeOverReading,
  }), [topInset, takeOverReading])

  /** 会话依赖束：网络 + 帧调度（rAF 双帧 = 等布局落定再测量；视口喂入与端口重取经 `viewport`
   *  注入）。目录走 navigation 读面，正文一律 ChapterContent。`t` 只进构造：错误快照的语言
   *  在生成时定，语言切换不重开会话（重开会丢目录与阅读位置）。 */
  const session = useMemo(() => new ReaderSession({
    fetchNavigation: (s, b) => deps.apiGet<BookNavigation>(queries.navigation({ sourceId: s, url: b })),
    fetchChapter: (s, b, i) => deps.apiGet<ChapterContent>(queries.chapter({ sourceId: s, url: b, index: i })),
    fetchShelf: () => readPanelShelf({
      apiGet: deps.apiGet,
      describeError: (e: unknown): string => describeError(e, t),
    }, bookKey),
    saveProgress: (chapterIndex, offsetRatio) => {
      void deps.apiSend(paramOps.shelfPut.at(bookKey), bodies.shelfProgress(chapterIndex, offsetRatio)).catch(() => undefined)
    },
    saveTotalChapters: (total) => {
      // 幂等补数据：缺 totalChapters 才回写；patch 只发这一个字段（保值语义在 Shelf.update）
      void deps.apiSend(paramOps.shelfPut.at(bookKey),
        bodies.shelfPatch({ totalChapters: total })).catch(() => undefined)
    },
    afterFrames: (cb) => { requestAnimationFrame(() => requestAnimationFrame(cb)) },
    // 顶条遮挡：位置读数与恢复落位吃同一个值（见 ReaderSessionDeps.topInset）
    topInset,
    // 视口喂入的帧调度缝由绑定给（合帧/布局标记合并/帧取消仍归会话；rAF 与端口刷新住绑定）
    viewport: binding.viewport,
    // bookKey 必须留在这格：两枚闭包捕的就是它，摘掉会让进度一路写给第一本书的地址。
  }, binding.port, deps.saveDebounceMs, t), [binding, deps, bookKey, t, topInset])

  /** 跟读策略：落位与撤销都接到当前会话；视图只保留 refs 与呈现。 */
  const follow = useMemo(() => createFollowController({
    bookKey,
    reveal: (target, opts) => { session.reveal(target, opts) },
    cancel: () => { session.cancelJump() },
  }), [bookKey, session])
  useEffect(() => {
    followControllerRef.current = follow
    return () => { followControllerRef.current = null }
  }, [follow])

  // 第三参 = getServerSnapshot：renderToString（smoke/SSR）必需，缺了直接抛
  const st = useSyncExternalStore(session.subscribe, () => session.state, () => session.state)
  const { toc, navigation, chapters, loadingIdx, error, currentChapter, returnDepth } = st

  /** 听书起播的唯一入口：位置由调用方给，引擎/音色/语速/音量一律不传（回退链归播放层）。
   *  位置来源恒为 `position`：`archive` 档是会话侧留给显式续听的入口（`ADR-0078`），视图不透传。 */
  const startListeningAt = useCallback((target?: { chapterIndex: number; paragraphIndex: number }): void => {
    setPagedFollowYielded(false)
    setPagedLocateTick((n) => n + 1)
    void startFromReadingPosition({
      sourceId, bookKey, title,
      ...(target === undefined ? { fallbackChapter: currentChapter } : { target }),
    }).catch((cause: unknown) => { deps.pushError(ttsErrorMessage(t, cause)) })
  }, [sourceId, bookKey, title, currentChapter, deps, t])
  const onListenFrom = useCallback((chapterIndex: number, paragraphIndex: number): void => {
    startListeningAt({ chapterIndex, paragraphIndex })
  }, [startListeningAt])
  /** 选区起播的落点：document 监听只有阅读器一份（3 条，不随已载章数长），按段号 + 章身份归属。 */
  const listenFrom = useListenFromSelection(bodyRef)
  listenFromClearRef.current = listenFrom.clear
  /** 顶条 pill：没有会话时起播——位置来源链归播放层，视图只交当前章兜底；本书正在听时就是
   *  继续/暂停，再按一次不该把位置重置回去。 */
  const onListenPill = (): void => {
    if (listen.showing) {
      if (listen.busy) pauseListening()
      else resumeListening()
      return
    }
    startListeningAt()
  }
  /** 听书条贴视口底：跟随时正文的可见底界要扣掉它，目标段不能藏在条后面。 */
  const followBottomInset = useCallback((): number =>
    ttsBarRef.current?.getBoundingClientRect().height ?? 0, [])

  /** 「定位到正在念的段」：用户按了才滚/翻，并重新接上自动跟随；翻页模式下若已跨章先切回播放章。 */
  const locateListen = useCallback((): void => {
    setPagedFollowYielded(false)
    setPagedLocateTick((n) => n + 1)
    const live = ttsPlayer.get()
    if (isPaged) {
      if (live.active && live.bookKey === bookKey && live.chapterIndex !== currentChapter) {
        session.requestJump(live.chapterIndex)
      }
      return
    }
    follow.onLocate({
      active: live.active,
      bookKey: live.bookKey,
      chapterIndex: live.chapterIndex,
      paragraphIndex: live.paragraphIndex,
    }, followBottomInset())
  }, [isPaged, bookKey, currentChapter, session, follow, followBottomInset])
  /** 听书会话开始 / 结束 / 换书：跟随回到默认开启；会话不在时清掉残留的重定位待办。 */
  useEffect(() => {
    setPagedFollowYielded(false)
    follow.onSessionChange(listen.showing)
  }, [follow, listen.showing, bookKey])

  /** 阅读器子树在场信号（迷你条的可见性判据）：挂载记一笔、卸载撤一笔。不看路由——宿主切走
   *  面板时路由仍停在 `reader`（`ADR-0022`），那正是迷你条要回到常驻层的场合。 */
  useEffect(() => enterReader(bookKey), [bookKey])

  /** 角落浮层、注释载荷、Esc 归属、离开一问与入架写入归 `client/reader-scene.ts`；视图只持它的
   *  投影与命令，外加一份导出范围草稿（缺省/档位/校验归 `export-run`）。 */
  const [expDraft, setExpDraft] = useState<ExportDraft>(() => draftOf(0))
  const scene = useMemo(() => new ReaderScene({
    session, sourceId, bookKey, title,
    // 目录总章数现读（场景只在「加入书架」那一刻取一次）：目录未到 = null
    tocLength: () => session.state.toc?.length ?? null,
    navigate,
    addSeat: async (input) => {
      const outcome = await addShelfSeat(input, deps)
      if (outcome.ok) markPanelShelfLanded([input.url])
      return outcome
    },
    pushOk: deps.pushOk, t,
  }), [session, sourceId, bookKey, title, deps, t])
  /** 正文内链回调：scene 稳定，回调身份不能每次渲染都换（ChapterShell 的 memo 依赖它）。 */
  const onBodyNavigate = useCallback((target: ReadingTarget, role: LinkRole): void => {
    takeOverReading()
    scene.bodyLink(target, role)
  }, [scene, takeOverReading])
  // 第三参 = getServerSnapshot：renderToString（smoke/SSR）必需，缺了直接抛
  const sceneState = useSyncExternalStore(scene.subscribe, () => scene.state, () => scene.state)
  /** 收场（Esc 与面板「关闭」钮同一条路）：内链打开的回到引用处——位置提交与返回栈仍归会话 */
  const closeCurrent = (): void => { scene.close() }
  /** 「关闭即回引用处」也是一次显式导航：只有这次关闭真的会返回时才让位；目录直接打开的关闭只收浮层。 */
  const takeOverOnReturn = useCallback((): void => {
    if (sceneState.surface === 'supplement' && scene.willReturnOnClose()) takeOverReading()
  }, [scene, sceneState.surface, takeOverReading])
  const closeSurface = useCallback((): void => { takeOverOnReturn(); scene.close() },
    [scene, takeOverOnReturn])
  const dismissSurface = useCallback((): void => { takeOverOnReturn(); scene.handleEsc() },
    [scene, takeOverOnReturn])
  /** 持久导入说明（本地书专属）：null = 还没问到 / 没有。入口只在**真有告警**时出现。 */
  const [importNotes, setImportNotes] = useState<LocalImportWarning[] | null>(null)
  const drawerRef = useRef<HTMLDivElement | null>(null)
  /** 目录当前项：会话按「当前章内最近的已登记导航锚点」裁决，视图只负责在被问到时取一次 */
  const [navActive, setNavActive] = useState<string | null>(null)
  // 浮层共用一条 Esc：归属读场景的 `escOwner` 投影（模态在场时这条监听不装，Esc 归 dialog 的模态
  // 契约）。`escOwner` 必须在依赖里，否则模态上场时这条监听撤不下来。装监听时认领一层键盘现场：
  // 全局听书浮窗的设置卡是同场另一层，一次 Esc 只该收最上面那一层。
  useEffect(() => {
    if (sceneState.escOwner !== 'surface') return
    const layer = claimKeyLayer()
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape' && layer.isTop()) dismissSurface() }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey); layer.release() }
  }, [dismissSurface, sceneState.escOwner])
  /** 目录高亮取一次读数（一次 DOM 测量，不在滚动路径上）：只在抽屉开着时调；**章块逐章到货**时
   *  由拍点后回调调——必须排在绑定测量与 `settleJump` 落位之后，否则量到落位前的几何。 */
  const recomputeNavActive = useCallback((): void => {
    if (sceneState.surface !== 'toc') return
    setNavActive(session.activeNavId())
  }, [sceneState.surface, session])
  useEffect(() => {
    recomputeNavActive()
  }, [recomputeNavActive, currentChapter, navigation])
  /** 打开抽屉即把当前项摆到视野中间——**只滚抽屉自己**，不借 `scrollIntoView`（见 util.ts）。 */
  useEffect(() => {
    const drawerEl = drawerRef.current
    if (sceneState.surface !== 'toc' || drawerEl === null) return
    centerInScroller(drawerEl, drawerEl.querySelector('[aria-current="true"]'))
  }, [sceneState.surface, navActive])
  // 范围导出：编排归 export-run.ts（start/cancel/三态 + 卸载 abort，可单测）；本视图只接线：
  // ⤓ 钮开范围面板、面板确认才 start。导出失败单独一条（会话 error 归阅读链路）。
  const [exportState, setExportState] = useState<ExportRunState>(IDLE_EXPORT)
  const exportRun = useMemo(() => createExportRun({
    sourceId, bookKey, title, deps, t, onChange: setExportState,
  }), [deps, sourceId, bookKey, title, t])
  useEffect(() => () => exportRun.dispose(), [exportRun])   // 卸载即取消——不许孤儿抓取
  const expTotal = toc?.length ?? 0
  /** 开导出面板：缺省整本（缺省口径归 draftOf）。互斥不在这里抄一遍——判据在 `reader-surfaces` */
  const openExport = (): void => {
    setExpDraft(draftOf(expTotal))
    scene.toggle('export')
  }

  /** 持久导入说明：**只有本地书有这份东西**，按书取一次。取不到就不出入口（不拿未知当「有」），
   *  但**不静默**：入口不出现是降级，失败仍上报。 */
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

  // 模式开关先于开会话：翻页模式没有滚动视口，会话里的恢复/跳章/预取必须走无 pendingJump 的路径。
  // effect 声明次序即执行次序（这个在下面 open 之前），首帧也不会让 open 走错模式。
  useEffect(() => {
    session.setPaged(isPaged)
  }, [session, isPaged])

  // 进入：开会话；卸载：关会话。「回阅读器」的一次性重定位在这里**按书键**取走（消费即摘）：
  // 章号先按不写进度的恢复路径站定，精确段由随后的 `session.reveal` 落位（write:false）。
  useEffect(() => {
    chapterRefs.current = []
    const held = relocationRef.current
    const target = held !== null && held.sourceId === sourceId && held.bookKey === bookKey
      ? held.target
      : takeReaderRelocation(sourceId, bookKey)
    relocationRef.current = { sourceId, bookKey, target }
    if (target !== null) follow.onRelocation(target)
    void session.open(sourceId, bookKey,
      target === null ? null : { chapterIndex: target.index, offsetRatio: 0 })
    return () => session.dispose()
  }, [follow, session, sourceId, bookKey])

  /** DOM 侧接线：滚动模式下由 binding 接管监听、探针与帧拍点；翻页模式下由 BookStage 接管进度与
   *  当前页段号探针（被「听书 / 从阅读位置起播」消费时同时恢复自动跟翻）。 */
  useEffect(() => {
    if (isPaged) {
      wasPagedRef.current = true
      setReadingProbe(() => {
        setPagedFollowYielded(false)
        setPagedLocateTick((n) => n + 1)
        return {
          chapterIndex: session.currentPosition.chapterIndex,
          paragraphIndex: pagedProbeParagraphRef.current?.() ?? 0,
        }
      })
      return () => { setReadingProbe(null) }
    }
    // 切回滚动：滚动 DOM 刚提交，先把会话里的页内比例摆成 scrollTop，再让绑定喂首帧；
    // 否则首帧会把「正文从章首开始」当成读者位置写回去。
    if (wasPagedRef.current) session.scrollToSavedPosition()
    wasPagedRef.current = false
    binding.mount(session)
    return () => { binding.unmount() }
  }, [binding, session, isPaged])

  /** 翻页模式预取下一章：本章正文到位后静默拉取下一章，末页翻章无等待。 */
  const currentChapterContent = chapters[currentChapter] ?? null
  useEffect(() => {
    if (!isPaged || toc === null || currentChapterContent === null) return
    if (currentChapter + 1 < toc.length) {
      session.prefetchChapter(currentChapter + 1)
    }
  }, [isPaged, toc, currentChapter, currentChapterContent, session])

  /** 翻页模式听书进度同步：
   *  - 用户在听书条上主动拖滑杆、点上一段/上一章/下一章（非自然 +1 推进）时自动恢复跟随并校准；
   *  - 跟随态下若听书章号与当前章不同（含已预取的下一章），立即切章并由 BookStage 对齐高亮段落。 */
  useEffect(() => {
    if (!isPaged || !listen.showing) {
      lastPagedListenRef.current = null
      return
    }
    const prev = lastPagedListenRef.current
    lastPagedListenRef.current = { chapterIndex: listen.chapterIndex, paragraphIndex: listen.paragraphIndex }
    const unchanged = prev !== null && prev.chapterIndex === listen.chapterIndex
      && prev.paragraphIndex === listen.paragraphIndex
    const naturalNextPara = prev !== null && prev.chapterIndex === listen.chapterIndex
      && listen.paragraphIndex === prev.paragraphIndex + 1
    const naturalNextChap = prev !== null && listen.chapterIndex === prev.chapterIndex + 1
      && listen.paragraphIndex === 0
    const explicitTtsSeek = prev !== null && !unchanged && !naturalNextPara && !naturalNextChap
    const shouldFollow = !pagedFollowYielded || explicitTtsSeek
    if (explicitTtsSeek) {
      setPagedFollowYielded(false)
      setPagedLocateTick((n) => n + 1)
    }
    if (!shouldFollow || toc === null) return
    if (listen.chapterIndex < 0 || listen.chapterIndex >= toc.length) return
    if (listen.chapterIndex !== currentChapter) {
      session.requestJump(listen.chapterIndex)
    }
  }, [isPaged, listen.showing, listen.chapterIndex, listen.paragraphIndex, pagedFollowYielded, toc, currentChapter, session])

  /** 播放推进时自动跟随。滚动模式由 follow-controller 驱动 session.reveal；翻页模式由上方跨章 effect +
   *  BookStage 页内同步接管，避免在会话里留下挂起的纵向 pendingReveal。 */
  useEffect(() => {
    if (isPaged) return
    const live = ttsPlayer.get()
    follow.onPlayback({
      active: live.active,
      bookKey: live.bookKey,
      chapterIndex: live.chapterIndex,
      paragraphIndex: live.paragraphIndex,
    }, followBottomInset())
  }, [isPaged, follow, listen.showing, listen.chapterIndex, listen.paragraphIndex, followBottomInset])

  /** 拍点后回调：目录高亮重算（章块到货后 DOM 才可测）；精确落位归会话的 `afterRender`，视图不另记账。 */
  const afterBeat = (): void => {
    recomputeNavActive()
  }
  /** 每次渲染后的**唯一一道门**（无条件调用）：这一帧要不要测量由绑定按会话的 DOM 版本裁，
   *  「只改了 currentChapter」这类渲染自然不拍，新加影响布局的来源也不用回来改视图。 */
  useEffect(() => {
    if (isPaged) return
    binding.rendered(st.domRevision, afterBeat)
  })

  /** 字号/行距/栏宽变化 → 排版复位：触发归视图（提交后的 effect 知道新排版落定），采点、复位算式
   *  与 miss/重采分支归会话的 `applyTypesetRelocation`。effect 只依赖三个排版量、不写 prefs。 */
  useEffect(() => {
    // 模式切换不是排版变化：翻页期间记下指纹但不走滚动复位；切回滚动的位置由
    // `scrollToSavedPosition` 负责，避免两套落位互相拉扯。
    if (isPaged) { typesetKeyRef.current = typesetKey; return }
    if (typesetKeyRef.current === typesetKey) return
    typesetKeyRef.current = typesetKey
    session.applyTypesetRelocation()
  }, [isPaged, typesetKey, session])

  const onPagedChangeChapter = useCallback((nextChapter: number): void => {
    session.requestJump(nextChapter)
  }, [session])

  const onPagedReportRatio = useCallback((ratio: number): void => {
    session.reportPosition(currentChapter, ratio)
  }, [session, currentChapter])

  const shownError = error ?? exportState.error
  /** 纸与墨：条底、控件、进度槽、跟读高亮都由这几个值槽派生（规则住样式层，行内只给值）。
   *  写在 .novel-rdr 根上而非 main 上——条是 main 的兄弟，写在 main 里条够不着。
   *  `paperLiveInk` 按纸色 memo：每推进一段都会重渲本组件，只在用户换纸色时重算。 */
  const paper = useMemo(() => ({
    '--novel-paper': prefs.paperColor,
    '--novel-paper-ink': paperInk(prefs.paperColor),
    '--novel-live-ink': paperLiveInk(prefs.paperColor),
  } as CSSProperties), [prefs.paperColor])
  return (
    <div data-novel-view="reader" className={isPaged ? 'novel-rdr is-paged' : 'novel-rdr'} style={paper}>
      {/* 偏好/导出面板遮罩：挂 reader 根容器盖满阅读区；遮罩在不在场读阅读场景的 `mask` 投影。 */}
      {sceneState.mask && (
        <div data-novel-ctrl-mask onClick={closeCurrent}
          style={{ position: 'absolute', inset: 0, zIndex: CTRL_Z.mask }} />
      )}
      {/* 控制器层 sticky：滚动容器是 .novel-main，不 sticky 会随正文滚走；布局与配色归 .novel-rdr-bar，行内只留 sticky 与 z。 */}
      <div ref={barRef} className={prefs.darkController ? 'novel-dark novel-rdr-bar' : 'novel-rdr-bar'}
        style={{ position: 'sticky', top: 0, zIndex: CTRL_Z.toolbar }}>
        <button className="novel-rdr-ctl" onClick={() => { scene.exitToShelf() }}>
          <svg aria-hidden="true" viewBox="0 0 16 16"><path d="M10 3 5 8l5 5" /></svg>{t('reader.shelf')}
        </button>
        {/* 正文内链的返回入口：**一次返回一条**；没押返回项时不渲染——不给点了没反应的按钮。 */}
        {returnDepth > 0 && (
          <button className="novel-rdr-ctl" onClick={() => { takeOverReading(); session.goBack() }}
            title={t('reader.backToOriginTitle')}>{t('reader.backToOrigin')}</button>
        )}
        <span className="novel-rdr-sep" aria-hidden="true" />
        {/* 读数：当前章在主位，书名退副位；目录未到时唯一诚实的话是「目录加载中」。 */}
        <div className="novel-rdr-title">
          {toc === null ? <span className="novel-rdr-chap">{t('reader.tocLoading')}</span> : (
            <>
              <span className="novel-rdr-chap">
                {toc[currentChapter] === undefined ? '' : displayChapterTitle(toc[currentChapter].name, currentChapter, t)}
              </span>
              <span className="novel-rdr-pos">{currentChapter + 1} / {toc.length}</span>
            </>
          )}
          <span className="novel-rdr-book">{title}</span>
        </div>
        <div className="novel-rdr-acts">
          {/* 导入说明入口：**只在真有持久告警的本地书上出现**；面板只读，不重复取数、不写进度。 */}
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
              draft={expDraft}
              // 章数是活的：每次调用现给，草稿里不存副本——目录迟到时预设与校验一起自愈
              valid={validRangeOf(expDraft, expTotal)}
              total={expTotal}
              running={exportState.running}
              kb={exportState.kb}
              totalChapters={exportState.total}
              onFrom={(v) => setExpDraft((d) => ({ ...d, from: v }))}
              onTo={(v) => setExpDraft((d) => ({ ...d, to: v }))}
              onPreset={(kind) => setExpDraft(applyPreset(kind, currentChapter, expTotal))}
              onConfirm={() => {
                const v = validRangeOf(expDraft, expTotal)
                if (!v.ok) return                                    // 校验单点：倒置/越界不发废包
                exportRun.start({ from: v.from, to: v.to, total: expTotal })
              }}
              onClose={closeCurrent}
              onCancel={() => exportRun.cancel()}
              darkController={prefs.darkController}
              zIndex={CTRL_Z.panel}
            />
          )}
          {/* 互斥与「再点同一颗就收场」判据在 `reader-surfaces`；工具栏在遮罩之上，各面自己的钮负责收场。 */}
          <button className="novel-rdr-ctl" aria-expanded={sceneState.surface === 'prefs'} aria-label={t('reader.settings')}
            onClick={() => { scene.toggle('prefs') }} title={t('reader.settings')}>Aa</button>
          <button className="novel-rdr-ctl" aria-expanded={sceneState.surface === 'toc'} aria-label={t('reader.contents')}
            onClick={() => { scene.toggle('toc') }}
            title={toc === null ? t('reader.contents') : t('reader.contentsWithCount', { n: toc.length })}>
            {t('reader.contents')}
          </button>
          {/* 听书 pill：起播入口与本书播放中的暂停/继续；选中态才用 brand。 */}
          <button
            className={listen.showing ? 'novel-rdr-ctl novel-tts-on' : 'novel-rdr-ctl'}
            aria-pressed={listen.showing} aria-label={t('tts.listen')} title={t('tts.listen')}
            onClick={onListenPill}
          >
            <svg aria-hidden="true" viewBox="0 0 16 16">
              <path d="M3 9a5 5 0 0 1 10 0" />
              <rect x="2" y="9" width="2.6" height="4.6" rx="1.3" />
              <rect x="11.4" y="9" width="2.6" height="4.6" rx="1.3" />
            </svg>
            {t('tts.listen')}
          </button>
          {/* 摸鱼模式入口：只管开关；舞台与在场位都在别处，本视图零逻辑。 */}
          <MoyuToggle />
          {sceneState.surface === 'prefs' && <PrefsPanel zIndex={CTRL_Z.panel} />}
        </div>
        {/* 章进度：跨章才动；章内百分比刻意不做——那是每帧量，会让整棵阅读器每帧重渲染。 */}
        <i className="novel-rdr-trail" aria-hidden="true"
          style={{ '--novel-pct': String(toc === null ? 0 : (currentChapter + 1) / toc.length) } as CSSProperties} />
      </div>
      {/* 错误重试要真的重拉：会话错误走 session.retry，导出错误才复位导出态。 */}
      {shownError !== null && (
        <ErrorBanner error={shownError} onRetry={() => {
          if (error !== null) session.retry()
          else setExportState(IDLE_EXPORT)
        }} />
      )}
      {/* 离开前那一问：共用模态契约（遮罩 + 居中框 + Tab 圈内、关后还焦）。「先不加入」是**离开**，不再造第二次。 */}
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
      {/* 阅读区：纸铺满这一层；翻页模式走 BookStage，滚动模式走连续正文列；0 宽 sticky 抽屉槽同行。 */}
      <div className="novel-rdr-main">
        {isPaged ? (
          <BookStage
            chapterIndex={currentChapter}
            totalChapters={toc?.length ?? 0}
            chapterName={displayChapterTitle(toc?.[currentChapter]?.name, currentChapter, t)}
            content={currentChapterContent}
            loading={loadingIdx !== null}
            tocReady={toc !== null}
            bookKey={bookKey}
            fontSize={prefs.fontSize}
            lineHeight={prefs.lineHeight}
            measure={prefs.measure}
            animation={prefs.pageAnimation}
            initialRatio={session.currentPosition.chapterIndex === currentChapter ? session.currentPosition.offsetRatio : 0}
            listenParagraph={listen.chapterIndex === currentChapter ? listen.paragraphIndex : null}
            listenFollowing={listen.showing && !pagedFollowYielded}
            locateTick={pagedLocateTick}
            keyboardBlocked={sceneState.surface !== null || sceneState.askShelf || (listen.showing && ttsSettingsOpen)}
            onNavigate={onBodyNavigate}
            onChangeChapter={onPagedChangeChapter}
            onReportRatio={onPagedReportRatio}
            onUserIntent={takeOverReading}
            chapterRefs={chapterRefs}
            bodyRef={bodyRef}
            probeParagraphRef={pagedProbeParagraphRef}
          />
        ) : (
          /* 正文层：字号/行距/栏宽由 prefs 行内固定——永不接宿主 token；字色走 --novel-paper-ink */
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
                <ChapterShell
                  key={i}
                  index={i}
                  content={content}
                  name={displayChapterTitle(toc?.[i]?.name, i, t)}
                  bookKey={bookKey}
                  onNavigate={onBodyNavigate}
                  chapterRefs={chapterRefs}
                  listenParagraph={listen.chapterIndex === i ? listen.paragraphIndex : null}
                />
              ))}
            {toc !== null && (
              <div ref={sentinelRef} data-novel-sentinel className="novel-sentinel">
                {loadingIdx !== null
                  ? t('common.loading')
                  : nextChapterIndex(chapters, currentChapter) === -1 ? t('reader.endOfBook') : '…'}
              </div>
            )}
          </div>
        )}
        {/* 抽屉：0 宽 sticky 槽 + absolute 本体（锚视口、不切走正文宽度）。 */}
        {sceneState.surface === 'toc' && (
          <div className="novel-drawer-slot">
            <div ref={drawerRef} className="novel-drawer" role="dialog" aria-label={t('reader.contents')}>
              <ReaderNavigation
                items={navigation ?? []}
                activeId={navActive}
                // 目录点击是纯导航：先收抽屉，再由场景分流目标
                onNavigate={(target) => { takeOverReading(); scene.close(); scene.openTarget(target) }}
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
            onNavigate={(target, role) => { takeOverReading(); scene.panelLink(target, role) }}
            onClose={closeSurface}
          />
        )}
      </div>
      {/* 「从本段听」浮钮：选区归属由阅读器一处判定；按下时不撤选区（撤了按钮来不及响应就失去上下文）。 */}
      {listenFrom.at !== null && (
        <button
          type="button"
          className="novel-tts-from-here"
          style={{ left: listenFrom.at.x, top: listenFrom.at.y }}
          onMouseDown={(event) => { event.preventDefault() }}
          onClick={() => {
            const at = listenFrom.at
            listenFrom.clear()
            if (at !== null) onListenFrom(at.chapterIndex, at.paragraphIndex)
          }}
        >
          {t('tts.startAt')}
        </button>
      )}
      {/* 听书条：**只在本会话是这本书时挂载**——它也是「从阅读位置起播」的闸门。 */}
      {listen.showing && (
        <TtsBar darkController={prefs.darkController} apiGet={deps.apiGet} pushError={deps.pushError}
          onLocate={locateListen} rootRef={ttsBarRef} onPanelOpenChange={setTtsSettingsOpen} />
      )}
      {/* 摸鱼舞台：无条件挂载、传 session 与书名；在场位在 moyu-store，Esc 走模态契约。 */}
      <MoyuStage session={session} title={title} />
    </div>
  )
}
