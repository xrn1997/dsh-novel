import type { CSSProperties, MutableRefObject, ReactNode } from 'react'
import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { LOCAL_SOURCE_ID, bodies, paramOps, queries } from '../../shared/wire.js'
import { playUnitStarts, splitParagraphs } from '../../shared/chapter-text.js'
import { describeError } from '../api.js'
import { plural, useCopy } from '../copy/index.js'
import { prodReaderDeps } from '../deps.js'
import { markPanelShelfLanded, readPanelShelf } from '../panel-shelf.js'
import type { ReaderDeps } from '../deps.js'
import { applyPreset, createExportRun, draftOf, IDLE_EXPORT, validRangeOf } from '../export-run.js'
import type { ExportDraft, ExportRunState, RangeParse } from '../export-run.js'
import { navigate, prefsStore, setPref, useStore, useStoreValue } from '../store.js'
import { FONT_STEPS, LINE_HEIGHTS, MEASURES, PAPER_PRESETS } from '../prefs-ui.js'
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
import { TtsBar } from '../tts/TtsBar.js'
import { isPlayBusy } from '../tts/listen-readout.js'
import { ttsErrorMessage } from '../tts/tts-error.js'
import { paperInk, paperLiveInk, centerInScroller, stripLeadingTitle } from '../util.js'
import { ErrorBanner, WarningList } from './bits.js'
import { ChapterBody } from './ChapterBody.js'
import { useListenFromSelection } from './listen-from-selection.js'
import { claimKeyLayer, Dialog } from './dialog.js'
import { ReaderNavigation } from './ReaderNavigation.js'
import { ReaderNotes } from './ReaderNotes.js'
import type { BookNavigation, ChapterContent, LinkRole, LocalImportWarning, ReadingTarget } from './types.js'

/** 正文层字色由纸张色算：纯函数住址在 util.ts，此处只接线。 */

/** 控制器层 z 序（不变量：**工具栏 > 遮罩**，面板在工具栏内）：
 *  面板嵌在 sticky 工具栏里，而 sticky + z-index 的工具栏**自成 stacking context**——面板自己的
 *  z-index 只在工具栏内部有效。工具栏若 ≤ 遮罩，透明遮罩反压整层：面板看得见但点不了（「Aa 能
 *  弹出但点不了」）。守卫见 tests/client/reader-ctrl-z.test.ts；目录抽屉同用 panel 值
 *  （哪一面带遮罩由阅读场景的 `mask` 投影给，判据仍住 `reader-surfaces`：只有 Aa 与导出面板
 *  要「点外面关掉它」）。 */
export const CTRL_Z = { toolbar: 12, mask: 10, panel: 11 } as const

/** 阅读控制器面板：挂 sticky 工具栏内（定位与滚动锚在工具栏上；z 序见 CTRL_Z），点遮罩关闭。
 *  chip 式控件，布局归样式类 .novel-prefs，行内只留定位与 z；role=dialog + aria-label
 *  （能开能关的浮层，Esc 关，共用 ReaderView 的一条 Esc）。 */
export function PrefsPanel(): ReactNode {
  const t = useCopy()
  const prefs = useStore(prefsStore)
  const step = (delta: number): void => {
    const i = FONT_STEPS.indexOf(prefs.fontSize)
    const at = Math.min(FONT_STEPS.length - 1, Math.max(0, (i === -1 ? 3 : i) + delta))
    // 下标已夹在表内：取不到这一步在构造上不成立，夹取证明就在上一行
    const next = FONT_STEPS.at(at)
    if (next !== undefined) setPref({ fontSize: next })
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
 * 口径：点⤓不再直接全下——本面板是唯一开下入口（确认前零请求）；草稿（缺省/档位/校验）
 * 归 export-run 的 draftOf / applyPreset / validRangeOf（倒置/越界/非整数/目录未就绪一律禁
 * 确认，宁可不发不发废包），本面板**只渲染**裁决与透传编辑，不自己判。
 * 挂工具栏内（与 PrefsPanel 同款绝对定位 + CTRL_Z.panel，z 序不变量见 CTRL_Z 头注）；
 * 运行中换进度视图（沿用 ExportRunState），仍在场可取消。role=dialog + aria-label=导出范围。
 */
export function ExportPanel(props: {
  /** 范围草稿：两个输入框里用户的编辑，由视图持有、编辑经回调回去 */
  draft: ExportDraft
  /** 草稿的校验裁决（唯一判据 validRangeOf，按活章数算出）；失败臂的 reason 由本面板翻译上屏 */
  valid: RangeParse
  /** 当前目录章数：面板上「共 N 章」读数与输入框上限的活值——不是草稿的一部分，每次渲染由视图现给 */
  total: number
  running: boolean
  kb: number
  /** 运行中章数标题（x-novel-total-chapters 头；未给为空串） */
  totalChapters: string
  onFrom: (v: string) => void
  onTo: (v: string) => void
  onPreset: (kind: 'all' | 'rest') => void
  onConfirm: () => void
  onClose: () => void
  onCancel: () => void
  darkController: boolean
}): ReactNode {
  const t = useCopy()
  const valid = props.valid
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
            {plural(t, props.total, 'reader.export.rangeTotal.one', 'reader.export.rangeTotal.other',
              { total: props.total })}
          </div>
          <label>
            {t('reader.export.fromPrefix')}
            <input className="novel-input" type="number" min={1} max={props.total}
              value={props.draft.from} onChange={(e) => props.onFrom(e.target.value)} aria-label={t('reader.export.startChapter')} />
            {t('reader.export.between')}
            <input className="novel-input" type="number" min={1} max={props.total}
              value={props.draft.to} onChange={(e) => props.onTo(e.target.value)} aria-label={t('reader.export.endChapter')} />
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

/** 正文投影（ChapterShell 的正文只经这一处剥与折算）：剥掉与章名重复的首行，并给出被剥掉的
 *  行占掉的播放单元数（`paragraphBase`）。
 *
 *  为什么不能只看「剥掉几行」：播放单元逐行切、空行与纯标点行占 0 格，被剥的空白行因此不产生
 *  偏移；基数是「剥后第一行」的起段号，播放层读原样正文、屏上少了这些行，不补偏移「从本段听」
 *  与探针起播会系统性早一段。图文章不剥（`stripLeadingTitle`），基数为 0；整章只剩章名时基数
 *  落到整篇占掉的单元数。
 *
 *  导出只给测试直接驱动：整页 ReaderView 的挂载成本会掩盖这条纯算式，而它错了的表现是
 *  「从本段听」整体偏移一段，肉眼归因不到这一段加法。 */
export function chapterBodyProjection(content: ChapterContent, chapterName: string): {
  content: ChapterContent
  paragraphBase: number
} {
  const stripped = stripLeadingTitle(content, chapterName)
  if (stripped === content || content.kind !== 'text' || stripped.kind !== 'text') {
    return { content: stripped, paragraphBase: 0 }
  }
  const lines = content.text.split('\n').map((text) => ({ text }))
  const removed = lines.length - stripped.text.split('\n').length
  const starts = playUnitStarts(lines)
  // 越界（整段剥完）落全量单元数：累加到头就是整篇占掉的单元数
  return { content: stripped, paragraphBase: starts[removed] ?? splitParagraphs(content.text).length }
}

/** 已载章块：memo 以 (content, name, bookKey, onNavigate) 为界——父视图的 loading/currentChapter
 *  变化不再重渲染全部历史章节；stripLeadingTitle 也只随本章内容/章名重算。
 *  章身份写在 `data-chapter` 上：选区起播由阅读器**一处**监听按它归属（`listen-from-selection`）。 */
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
 * 阅读器：连续滚动流（章章首尾相接）。三块各有主人——阅读时序归「阅读会话」
 * （reader-session.ts），浮层/注释载荷/Esc/离开一问/入架写入归「阅读场景」（reader-scene.ts），
 * DOM 侧（渲染后拍点的触发判据、帧泵、滚动容器刷新、scroll/resize/ResizeObserver 装摘、
 * 阅读探针、拍点后回调）归「阅读器 DOM 绑定」（reader-binding.ts）。
 * 本视图只做三件事：渲染这三份状态、交出元素来源（refs）、摆纯 UI 策略；每次渲染后只调
 * 一个**无条件的门**（`binding.rendered`），不再自己枚举「哪些状态变化要拍点」的依赖数组。
 * 只渲染已载章节，预取自限。
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
  /** 听书会话的读数按原语窄订阅：整店订阅会让每段推进 / 每档音量都重渲整个阅读器顶层；
   *  章节块本身已由 `ChapterShell` 的 memo 挡住，这里只把顶层需要的几格取出来。
   *  `listenActive` = 本书是否就是正在听的会话：听书条的挂载条件，也是「从阅读位置起播」的闸门
   *  ——探针量的永远是当前打开的书，只有这时它才与播放层的书是同一本。 */
  const listenActive = useStoreValue(ttsPlayer, (s) => s.active && s.bookKey === bookKey)
  /** 「可暂停」= 在放 ∨ 起播在途（`isPlayBusy`，与条上 / 浮窗同一算式）：只认 `playing` 会让
   *  合成 / 章正文在途时按 pill 没反应。暂停后 resume 的守卫在会话里，这里只决定按哪一下。 */
  const listenBusy = useStoreValue(ttsPlayer, (s) => s.active && s.bookKey === bookKey && isPlayBusy(s))
  const listenChapter = useStoreValue(ttsPlayer, (s) => (s.active ? s.chapterIndex : -1))
  const listenParagraphIndex = useStoreValue(ttsPlayer, (s) => (s.active ? s.paragraphIndex : -1))
  const bodyRef = useRef<HTMLDivElement | null>(null)                  // 正文层：锚点测量基准
  const sentinelRef = useRef<HTMLDivElement | null>(null)              // 未载边界哨兵：进预取区 → 加载下一章
  const chapterRefs = useRef<Array<HTMLDivElement | null>>([])
  /** 「回阅读器」取走的重定位现场（按书记）：模块级现场是**一次性的**，但本 mount 的 effect
   *  可能连跑两趟（StrictMode 的 mount → cleanup → mount），第一趟取走的现场必须留给第二趟，
   *  否则开发期双挂载会把听书位置丢掉、退回存档 progress。换书不复用（键变了就重新取）。 */
  const relocationRef = useRef<{ sourceId: string; bookKey: string; target: ReaderRevealTarget | null } | null>(null)
  /** 跟读策略 module（零 React）：跟随开关、relocation 待办与 reveal 决策都住它。
   *  绑定早于会话构造，接管动作经这只 ref 转交；挂载后由下面的 effect 接上。 */
  const followControllerRef = useRef<FollowController | null>(null)
  /** 听书条根：跟随的可视底界要扣掉它的高度（条贴视口底，目标段不许藏在它下面）。 */
  const ttsBarRef = useRef<HTMLDivElement | null>(null)
  /** 用户把视口带走：跟随即让位，挂起的自动定位与在途落位一并作废
   *  （最后一次显式动作是用户这一下）。 */
  const takeOverReading = useCallback((): void => {
    followControllerRef.current?.onUserIntent()
  }, [])
  /** 顶条（sticky）：它的高度就是滚动视口顶的固定遮挡。阅读位置（恢复 / 跳转 / 读数 / 探针）
   *  一律按「条下方第一行」算——按裸 scrollTop 算，听书恢复的段首会正好藏在条后。 */
  const barRef = useRef<HTMLDivElement | null>(null)
  const topInset = useCallback((): number => barRef.current?.getBoundingClientRect().height ?? 0, [])

  /** 阅读器的 DOM 侧绑定：拍点触发判据、帧泵、端口刷新、监听装摘、探针与拍点后回调的次序
   *  全归它（`client/reader-binding.ts`）。视图只交元素来源，不再枚举依赖数组。 */
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

  /** 会话依赖束：网络 + 帧调度（rAF 双帧 = 等布局落定再测量；视口喂入的合帧状态机住会话，
   *  帧调度与滚动容器重取经 `viewport` 注入）；网络走注入 deps。
   *  目录走 navigation 读面（线性 chapters + 展示树 items 同一份响应），正文一律 ChapterContent。
   *  `t` 只进构造：会话的错误快照在生成时定语言（与 job store 同一条已知限制），
   *  语言切换不重开会话——重开会丢目录与阅读位置，代价远大于旧错误条仍说旧语言。 */
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
      // 幂等补数据：缺 totalChapters 才回写；patch 形态只发这一个字段——
      // 保值语义在 Shelf.update 的 interface 上，不再被迫重发 sourceId+title
      void deps.apiSend(paramOps.shelfPut.at(bookKey),
        bodies.shelfPatch({ totalChapters: total })).catch(() => undefined)
    },
    afterFrames: (cb) => { requestAnimationFrame(() => requestAnimationFrame(cb)) },
    // 顶条遮挡：位置读数与恢复落位吃同一个值（见 ReaderSessionDeps.topInset）
    topInset,
    // 视口喂入的帧调度缝由绑定给（合帧/布局标记合并/帧取消仍归会话；rAF 与端口刷新住绑定）
    viewport: binding.viewport,
    // bookKey 必须留在这格：saveProgress 与 saveTotalChapters 两枚闭包捕的就是它，摘掉会让进度
    // 一路写给第一本书的地址。sourceId 与 title 不在本工厂里被读——换源走下面那条 open() 的 effect。
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

  /** 听书起播的唯一入口：位置由调用方给（pill 的实时探针、选区各有各的来源），
   *  引擎/音色/语速/音量一律不传——回退链归播放层（本书 listen 存档 → 活动缺省）。
   *  位置来源恒为 `position`：视图不透传 `resume`——`archive` 档是会话侧留给「显式从存档续听」
   *  的入口（`ADR-0078`），眼下没有界面调用点，视图这层转一道只会多一个永远取缺省值的死参数。 */
  const startListeningAt = useCallback((target?: { chapterIndex: number; paragraphIndex: number }): void => {
    void startFromReadingPosition({
      sourceId, bookKey, title,
      ...(target === undefined ? { fallbackChapter: currentChapter } : { target }),
    }).catch((cause: unknown) => { deps.pushError(ttsErrorMessage(t, cause)) })
  }, [sourceId, bookKey, title, currentChapter, deps, t])
  const onListenFrom = useCallback((chapterIndex: number, paragraphIndex: number): void => {
    startListeningAt({ chapterIndex, paragraphIndex })
  }, [startListeningAt])
  /** 选区起播的落点：document 监听只有**阅读器一份**（3 条，不随已载章数长），按段号 + 章身份
   *  归属；选中即出浮钮，点了才起播。 */
  const listenFrom = useListenFromSelection(bodyRef)
  /** 顶条 pill：没有会话时起播——位置来源链归播放层（探针 → 当前章 → 书架 progress），
   *  视图只交当前章作兜底；本书正在听时就是继续/暂停——再按一次不该把位置重置回去。
   *  听书存档只提供音色/语速/音量与段级续听现场，不决定起播位置：读者看到第 N 章时按听书，
   *  不该被一份更早的听书存档拽回前面。 */
  const onListenPill = (): void => {
    if (listenActive) {
      if (listenBusy) pauseListening()
      else resumeListening()
      return
    }
    startListeningAt()
  }
  /** 听书条贴视口底：跟随时正文的可见底界要扣掉它，目标段不能藏在条后面。 */
  const followBottomInset = useCallback((): number =>
    ttsBarRef.current?.getBoundingClientRect().height ?? 0, [])
  /** 「定位到正在念的段」：用户按了才滚，并重新接上自动跟随；只滚阅读滚动容器自己。 */
  const locateListen = useCallback((): void => {
    const live = ttsPlayer.get()
    follow.onLocate({
      active: live.active,
      bookKey: live.bookKey,
      chapterIndex: live.chapterIndex,
      paragraphIndex: live.paragraphIndex,
    }, followBottomInset())
  }, [follow, followBottomInset])
  /** 听书会话开始 / 结束 / 换书：跟随回到默认开启（上手即跟，用户滚动后才让位）。
   *  会话不在时清掉可能残留的重定位待办——它只服务「正在听的书回阅读器」。 */
  useEffect(() => {
    follow.onSessionChange(listenActive)
  }, [follow, listenActive, bookKey])

  /** 阅读器子树在场信号：迷你条的可见性判据（挂载记一笔、卸载撤一笔）。不看路由——
   *  宿主切走面板时路由仍停在 `reader`，而面板子树已被卸载（`ADR-0022`），那正是迷你条
   *  必须回到常驻层的场合。effect 随 bookKey 重跑（撤旧书键、记新书键），子树本身不重挂：
   *  在场信号按书键对齐，换书时迷你条的接管判据跟着走，而不是整棵子树重挂抖动。 */
  useEffect(() => enterReader(bookKey), [bookKey])

  /** 角落浮层、注释面板载荷、Esc 归属、离开一问与入架写入归 `client/reader-scene.ts`：
   *  这几条律互相咬合（谁先退场、谁消费返回项、写完能不能被打断），证明它们不该靠整页渲染。
   *  视图只持它的投影与命令，外加一份导出范围草稿——缺省/档位/校验归 `export-run` 的
   *  draftOf / applyPreset / validRangeOf，这里只持值并转发编辑；章数不进草稿，调用时现读目录。 */
  const [expDraft, setExpDraft] = useState<ExportDraft>(() => draftOf(0))
  const scene = useMemo(() => new ReaderScene({
    session, sourceId, bookKey, title,
    // 目录总章数现读会话状态（场景只在「加入书架」那一刻取一次）：目录未到 = 不知道（null），
    // 口径见 ReaderSceneDeps 的 tocLength。
    tocLength: () => session.state.toc?.length ?? null,
    navigate,
    addSeat: async (input) => {
      const outcome = await addShelfSeat(input, deps)
      if (outcome.ok) markPanelShelfLanded([input.url])
      return outcome
    },
    pushOk: deps.pushOk, t,
  }), [session, sourceId, bookKey, title, deps, t])
  /** 正文内链回调：scene 稳定，回调身份不能每次渲染都换（ChapterShell 的 memo 依赖它）。
   *  读者点了内链 = 自己接管视口，跟读让位到下次定位。 */
  const onBodyNavigate = useCallback((target: ReadingTarget, role: LinkRole): void => {
    takeOverReading()
    scene.bodyLink(target, role)
  }, [scene, takeOverReading])
  // 第三参 = getServerSnapshot：renderToString（smoke/SSR）必需，缺了直接抛
  const sceneState = useSyncExternalStore(scene.subscribe, () => scene.state, () => scene.state)
  /** 收场（Esc 与面板「关闭」钮同一条路）：内链打开的回到引用处——位置提交与返回栈仍归会话 */
  const closeCurrent = (): void => { scene.close() }
  /** 「关闭即回引用处」也是一次显式导航：只有这次关闭真的会返回时才让位；目录直接打开的
   *  补充文档没有返回项，关闭只是收浮层，不该把跟随关掉（也不该取消在途跳章）。 */
  const takeOverOnReturn = useCallback((): void => {
    if (sceneState.surface === 'supplement' && scene.willReturnOnClose()) takeOverReading()
  }, [scene, sceneState.surface, takeOverReading])
  const closeSurface = useCallback((): void => { takeOverOnReturn(); scene.close() },
    [scene, takeOverOnReturn])
  const dismissSurface = useCallback((): void => { takeOverOnReturn(); scene.handleEsc() },
    [scene, takeOverOnReturn])
  /** 持久导入说明（本地书专属）与它的面板现场：null = 还没问到 / 这本书没有这份东西。
   *  入口只在**真有告警**时出现（正常无警告不新增干扰），面板只展示已取到的清单。 */
  const [importNotes, setImportNotes] = useState<LocalImportWarning[] | null>(null)
  const drawerRef = useRef<HTMLDivElement | null>(null)
  /** 目录当前项：会话按「当前章内最近的已登记导航锚点」裁决，视图只负责在被问到时取一次 */
  const [navActive, setNavActive] = useState<string | null>(null)
  // 浮层共用一条 Esc：归属读场景的 `escOwner` 投影（模态在场时它是 'modal'，这条监听不装——
  // Esc 只归 `views/dialog.tsx` 的模态契约，收回那一问走场景的 `dismissAsk`）。`escOwner` 必须在
  // 依赖里，否则模态上场时这条监听撤不下来（一次 Esc 会既关模态又收浮层）。判据仍住 `reader-surfaces`。
  // 装监听时认领一层键盘现场（层序住址在 `views/dialog.tsx` 的 `claimKeyLayer`）：全局听书浮窗的
  // 设置卡是同场另一层，一次 Esc 只该收最上面那一层。
  useEffect(() => {
    if (sceneState.escOwner !== 'surface') return
    const layer = claimKeyLayer()
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape' && layer.isTop()) dismissSurface() }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey); layer.release() }
  }, [dismissSurface, sceneState.escOwner])
  /** 目录高亮取一次读数（一次 DOM 测量，不在滚动路径上）：只在抽屉开着时调。
   *  调用点有两处——抽屉/目录/跨章变化时直接调；**章块逐章到货**时由拍点后回调调（见下面的
   *  `afterBeat`）：它必须排在绑定测量与 `settleJump` 落位之后，否则量到的是落位前的几何。
   *  同章内滚动只是每帧的量，它改的是滚动位置不是这份 DOM，不值得为一条 aria-current 按帧唤醒。 */
  const recomputeNavActive = useCallback((): void => {
    if (sceneState.surface !== 'toc') return
    setNavActive(session.activeNavId())
  }, [sceneState.surface, session])
  useEffect(() => {
    recomputeNavActive()
  }, [recomputeNavActive, currentChapter, navigation])
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
  /** 开导出面板：缺省整本（缺省口径归 draftOf）。互斥不在这里抄一遍——判据在 `reader-surfaces` */
  const openExport = (): void => {
    setExpDraft(draftOf(expTotal))
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

  // 进入：开会话（目录→恢复→懒加载）；卸载：关会话（清防抖定时器）。
  // 「回阅读器」的一次性重定位在这里**按书键**取走（消费即摘，别人的现场不动）：
  // 章号先按不写进度的恢复路径站定；精确段由随后的 `session.reveal` 落位（write:false）。
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

  /** DOM 侧接线：装监听、注册探针、首帧喂视口、挂载即拍第一帧；卸载全摘。
   *  装摘归绑定（`client/reader-binding.ts`），视图不再自己按 ref 拼 scroll/resize/ResizeObserver。 */
  useEffect(() => {
    binding.mount(session)
    return () => { binding.unmount() }
  }, [binding, session])

  /** 播放推进（段 / 章变化）时自动跟随。策略归 `follow-controller`：读者接管后它保持让位，
   *  直到定位按钮或下一次听书会话重新接上。effect 必须排在绑定挂载之后：首帧跟随时端口已刷新
   *  （回到阅读器且会话已在播的那一路不会因为 port 还是 null 而漏掉第一次跟随）。 */
  useEffect(() => {
    const live = ttsPlayer.get()
    follow.onPlayback({
      active: live.active,
      bookKey: live.bookKey,
      chapterIndex: live.chapterIndex,
      paragraphIndex: live.paragraphIndex,
    }, followBottomInset())
  }, [follow, listenActive, listenChapter, listenParagraphIndex, followBottomInset])

  /** 拍点后回调：目录高亮重算（章块到货后 DOM 才可测）。精确落位已归会话的 `afterRender`，
   *  视图不再维护「章到货后居中」的第二份 pending 账。 */
  const afterBeat = (): void => {
    recomputeNavActive()
  }
  /** 每次渲染后的**唯一一道门**（无条件调用，没有依赖数组可忘）：这一帧要不要测量由绑定按会话的
   *  DOM 版本裁——「只改了 currentChapter」这类不影响布局的渲染自然不拍，新加一条影响布局的来源
   *  也不用回来改视图。 */
  useEffect(() => {
    binding.rendered(st.domRevision, afterBeat)
  })

  /** 字号/行距/栏宽变化 → 排版复位：触发仍归视图（只有提交后的 effect 知道新排版已落定），
   *  采点时刻（`setPref` 同步栈）、复位算式与 miss/重采分支归会话的 `applyTypesetRelocation`。
   *  自限：effect 只依赖三个排版量、自己不写 prefs，所以不可能自我触发成重定位环。 */
  useEffect(() => {
    session.applyTypesetRelocation()
  }, [prefs.fontSize, prefs.lineHeight, prefs.measure, session])

  const shownError = error ?? exportState.error
  /** 纸与墨：条底、条上控件、进度槽、跟读高亮全由这几个值槽派生（规则住样式层，行内只给值）。
   *  跟读字色由纸色现算（暖赭带里离墨最远又够读的一档），跟着纸色一起换。
   *  写在 .novel-rdr 根上而非 .novel-rdr-main 上——条是 main 的兄弟，写在 main 里条够不着。
   *  `paperLiveInk` 在候选色里逐档量对比度：听书每推进一段都会重渲本组件，按纸色 memo，
   *  只在用户换纸色时重算一次。 */
  const paper = useMemo(() => ({
    '--novel-paper': prefs.paperColor,
    '--novel-paper-ink': paperInk(prefs.paperColor),
    '--novel-live-ink': paperLiveInk(prefs.paperColor),
  } as CSSProperties), [prefs.paperColor])
  return (
    <div data-novel-view="reader" className="novel-rdr" style={paper}>
      {/* 偏好/导出面板遮罩：挂 reader 根容器盖满整个阅读区——只盖工具栏条时点正文关不掉面板；
          遮罩在不在场读阅读场景的 `mask` 投影（判据仍住 `reader-surfaces`：目录/注释/导入说明
          自带收场的钮，不借遮罩顺手关）。 */}
      {sceneState.mask && (
        <div data-novel-ctrl-mask onClick={closeCurrent}
          style={{ position: 'absolute', inset: 0, zIndex: CTRL_Z.mask }} />
      )}
      {/* 控制器层——sticky：滚动容器是 .novel-main，工具栏不 sticky 会随正文一起滚走（目录/Aa 够不着）。
          布局与配色归 .novel-rdr-bar（条底由 --novel-paper 派生；darkController 那一档在
          .novel-rdr-bar.novel-dark 里让回宿主暗底），行内只留 sticky 定位与 z（CTRL_Z 常量，
          ctrl-z 守卫断言）。图标一律 aria-hidden：它们是装饰，可访问名由文案给。 */}
      <div ref={barRef} className={prefs.darkController ? 'novel-dark novel-rdr-bar' : 'novel-rdr-bar'}
        style={{ position: 'sticky', top: 0, zIndex: CTRL_Z.toolbar }}>
        <button className="novel-rdr-ctl" onClick={() => { scene.exitToShelf() }}>
          <svg aria-hidden="true" viewBox="0 0 16 16"><path d="M10 3 5 8l5 5" /></svg>{t('reader.shelf')}
        </button>
        {/* 正文内链的返回入口：**一次返回一条**（重复跟随链接才有多层）。栈在会话里、只活在窗口内；
            没押返回项时不渲染——不给一个点了没反应的按钮。位置在「书架」之后，左侧主次分明。 */}
        {returnDepth > 0 && (
          <button className="novel-rdr-ctl" onClick={() => { takeOverReading(); session.goBack() }}
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
          {/* 听书 pill：起播入口（位置取阅读探针，量不到才退当前章首段）与本书播放中的暂停/继续。
              选中态才用 brand（条上其余控件维持纸墨派生）。 */}
          <button
            className={listenActive ? 'novel-rdr-ctl novel-tts-on' : 'novel-rdr-ctl'}
            aria-pressed={listenActive} aria-label={t('tts.listen')} title={t('tts.listen')}
            onClick={onListenPill}
          >
            <svg aria-hidden="true" viewBox="0 0 16 16">
              <path d="M3 9a5 5 0 0 1 10 0" />
              <rect x="2" y="9" width="2.6" height="4.6" rx="1.3" />
              <rect x="11.4" y="9" width="2.6" height="4.6" rx="1.3" />
            </svg>
            {t('tts.listen')}
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
          抽屉被否形状与现方案的理由见样式层 .novel-drawer-slot 注释。 */}
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
              <ChapterShell
                key={i}
                index={i}
                content={content}
                name={toc?.[i]?.name ?? t('reader.chapterFallback', { n: i + 1 })}
                bookKey={bookKey}
                onNavigate={onBodyNavigate}
                chapterRefs={chapterRefs}
                listenParagraph={listenActive && listenChapter === i ? listenParagraphIndex : null}
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
        {/* 抽屉：0 宽 sticky 槽 + absolute 本体（锚视口、且不切走正文宽度；被否形状见样式层注释）。
            内容 = 目录树（分组标题不可点；同一章可以有多条锚点条目）。 */}
        {sceneState.surface === 'toc' && (
          <div className="novel-drawer-slot">
            <div ref={drawerRef} className="novel-drawer" role="dialog" aria-label={t('reader.contents')}>
              <ReaderNavigation
                items={navigation ?? []}
                activeId={navActive}
                // 目录点击是纯导航：先收抽屉（开抽屉那一步已收掉面板，这里不该有注释载荷可消费），
                // 再由场景分流目标
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
      {/* 「从本段听」浮钮：选区归属由阅读器一处判定（监听住 listen-from-selection.ts）。
          按下时不撤选区：撤了选区，按钮还来不及响应点击就失去「从哪一段听」的上下文。 */}
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
      {/* 听书条：**只在本会话是这本书时挂载**——它也是「从阅读位置起播」的闸门（探针量的永远
          是当前打开的书，只有这时它才与播放层的书是同一本）。播放会话跨阅读器常驻，条本身
          随「本书是否正在听」来去。 */}
      {listenActive && (
        <TtsBar darkController={prefs.darkController} apiGet={deps.apiGet} pushError={deps.pushError}
          onLocate={locateListen} rootRef={ttsBarRef} />
      )}
    </div>
  )
}
