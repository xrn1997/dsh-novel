import type {
  CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode,
} from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { apiGet } from '../api.js'
import { useCopy } from '../copy/index.js'
import { navigate, useStore } from '../store.js'
import { NovelStyles } from '../styles.js'
import { pushError } from '../transient.js'
import {
  isPlayBusy, lineOf, listenFaceOf, miniSegmentLabel, segmentLabel,
} from './listen-readout.js'
import {
  CAPSULE_SIZE, clampMiniBarIntoViewport, followFlushEdgesOnResize, frameFromDrag, miniBarCenterOf,
  miniBarLayout, miniBarPopoverFlip, miniBarPopoverRoom, miniBarStore, persistMiniBarState, resetMiniBarPosition,
  resolveFormSize, resolvedMiniBarSize, setMiniBarCenter, setMiniBarCollapsed, setMiniBarFrame,
  snapMiniBarToEdge,
} from './mini-bar-state.js'
import type { MiniBarEdge, MiniBarFrame } from './mini-bar-state.js'
import type { Size, Viewport } from './mini-bar-state.js'
import { MiniProgressLine, RingPlay } from './mini-parts.js'
import {
  pauseListening, requestReaderRelocation, resumeListening, skipParagraph, ttsPlayer,
} from './player.js'
import { readerPresence } from './reader-presence.js'
import { TtsMiniPanel } from './TtsMiniPanel.js'
import { ttsErrorMessage } from './tts-error.js'
import { useTtsSources } from './use-tts-sources.js'
import { keyLayerActive } from '../views/dialog.js'

/**
 * 全局听书浮窗：宿主 `shell.overlay` 常驻层上的两个**完整**形态，位置自由落位（`ADR-0073`）。
 *
 * 缺省是贴边的 208×44 身份条（进度环 / 小字书名与段号，收起态不再显示当前句）；点击展开为
 * 整段可读的边栏（缺省 320×200，宽高可拖，范围见 `ADR-0080`：身份 / 整段 / 运输行 / 底行）。
 * 两个形态各自完整，不做 idle 半隐、不做同一颗胶囊藏一半的 hover 抽屉：收起态自身完整可读可播，
 * 展开态是另一块完整控制面。设置面与阅读器条共读 `TtsSettings.tsx` 同一份行清单。
 *
 * 现场只有「块中心 + 收起态」：拖动两轴跟手，松手时离视口边够近（≤ 24px）的边才贴齐，否则
 * 停在原地；方向键四向移动（Shift 三档）、Home 复位；位置与收起态落 localStorage，视口变化后
 * 贴着的边继续贴、自由位置只夹不漂。两个形态共用同一个中心，展开 / 收起时按新尺寸重新夹取。
 * 落位样式由 `miniBarLayout` 一次给全（缺省轴也在读数里解析成像素），根节点不再分
 * 「落过位 / 没落过位」两种写法，样式层也不给缺省定位。
 *
 * 在场判据（`ADR-0072`）：会话在 ∧ 阅读器在场书键集合里**没有**会话本书。阅读器里听本书时由
 * 就地条（`TtsBar`）接管；阅读器开着**另一本**时迷你条照常在场。判据读 `reader-presence` 的
 * 子树信号与书键，**不看插件内路由**（`ADR-0022`）。
 *
 * 快捷键只在**没有阅读器子树**时装（Space 播放/暂停、Shift+←/→ 跳段、Esc 收起）：阅读器在场时
 * Space 归滚动、Shift+方向键归选区、Esc 归阅读器浮层契约，浮窗不抢。
 *
 * 「回阅读器」只做两件事：记一次性重定位现场（带书键）+ 切路由（再把面板带到前台）。恢复目标
 * 归 ReaderSession 的开书恢复路（`restore` 站定不写）；这里绝不走会提交阅读进度的跳章。
 */
export interface TtsMiniBarProps {
  /** 把「小说」面板带到前台：宿主可能停在任何面板上，只切插件内路由等于点了没反应 */
  focusPanel: () => void
  /** 是否自带样式层。缺省 true（单独渲染时自足）；与状态层同树挂载时传 false——
   *  同一份 `NOVEL_CSS` 不必进 DOM 两遍，宿主 overlay 树里状态层已经注入。 */
  withStyles?: boolean
}

/** 键盘移动一档的像素数（Shift 走三档）：与样式层的间距标度同尺，方向键才不像在乱跳。 */
const KEY_STEP = 16

/** 位移超过这么多像素才算拖动，不算点击（同一次指针序列里两者互斥）。
 *  8px 是手抖与真拖的分界：3px 会把「按一下播放环」判成拖走，点谁都在挪块。 */
const DRAG_THRESHOLD = 8

interface DragSession {
  id: number
  startX: number
  startY: number
  /** 起手那一刻的块中心（缺省轴已解析成数字） */
  startCx: number
  startCy: number
  size: Size
}

interface ResizeSession {
  id: number
  edge: MiniBarEdge
  startX: number
  startY: number
  start: MiniBarFrame
}

function hostWindow(): Window | null {
  const host = globalThis as { window?: Window }
  return host.window ?? null
}

export function TtsMiniBar({ focusPanel, withStyles = true }: TtsMiniBarProps): ReactNode {
  const t = useCopy()
  const st = useStore(ttsPlayer)
  // 阅读器在场书键里有会话本书 = 就地条接管；开着另一本时迷你条照常在场（ADR-0072）
  const reader = useStore(readerPresence)
  const bar = useStore(miniBarStore)
  const hiddenByReader = st.bookKey !== null && reader.bookKeys.includes(st.bookKey)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<DragSession | null>(null)
  const resizeRef = useRef<ResizeSession | null>(null)
  const movedRef = useRef(false)
  const [dragging, setDragging] = useState(false)
  const [resizing, setResizing] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  /** 设置弹层的内容实测高（`null` = 量不到 → 翻转判据回退常量）。 */
  const [settingsHeight, setSettingsHeight] = useState<number | null>(null)
  const sources = useTtsSources(settingsOpen, apiGet, pushError)
  const [viewport, setViewport] = useState<Viewport>(() => {
    const win = hostWindow()
    return { width: win?.innerWidth ?? 1024, height: win?.innerHeight ?? 768 }
  })

  /**
   * 当前形态的实际尺寸：量得到就用量到的（展开态内容变化 / 用户拖边都会改尺寸，拿常量算贴底
   * 会留一条缝），量不到回现场解析。拖拽、键盘、夹取、吸附共用这一份。
   */
  const formSize = useCallback((): Size => {
    const rect = rootRef.current?.getBoundingClientRect() ?? null
    const win = hostWindow()
    const view: Viewport = { width: win?.innerWidth ?? 1024, height: win?.innerHeight ?? 768 }
    const state = miniBarStore.get()
    return resolveFormSize(state.collapsed, rect, state, view)
  }, [])

  // 视口变化：上一帧贴齐的边继续贴新视口，自由位置只夹不漂；派生 side 随视口宽一起重算
  useEffect(() => {
    const win = hostWindow()
    if (win === null) return
    let prev: Viewport = { width: win.innerWidth, height: win.innerHeight }
    const onResize = (): void => {
      const size = formSize()
      const next: Viewport = { width: win.innerWidth, height: win.innerHeight }
      followFlushEdgesOnResize(size, prev, next)
      prev = next
      setViewport(next)
    }
    win.addEventListener('resize', onResize)
    return () => { win.removeEventListener('resize', onResize) }
  }, [formSize])

  /**
   * 边栏高度会随内容变化（空章没有底行时整块变矮）。贴底落位的块在变高后会溢出视口，
   * 所以尺寸一变就按新尺寸重夹一次；**拖边期间不跑**——拖边自己就是尺寸的主人，二次夹取会把
   * 对边锚定拽偏。
   */
  useEffect(() => {
    if (resizing) return
    const el = rootRef.current
    if (el === null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      const win = hostWindow()
      if (win === null) return
      clampMiniBarIntoViewport(formSize(), { width: win.innerWidth, height: win.innerHeight })
    })
    observer.observe(el)
    return () => { observer.disconnect() }
    // 浮窗是会话开始后才挂上来的：活跃状态变了才轮到这块 DOM 出现，effect 要跟着重跑
  }, [formSize, st.active, hiddenByReader, resizing])

  // 展开/收起换形态后，按新尺寸把已落位的中心夹回界内；缺省轴保持缺省
  useEffect(() => {
    const win = hostWindow()
    if (win === null) return
    clampMiniBarIntoViewport(formSize(), { width: win.innerWidth, height: win.innerHeight })
  }, [bar.collapsed, formSize])

  // 会话结束 / 被阅读器就地条接管时，别把设置弹层留到下一轮再冒出来
  useEffect(() => {
    if (!st.active || hiddenByReader) setSettingsOpen(false)
  }, [st.active, hiddenByReader])

  /**
   * 拖动期间把 move/up 挂到 window：指针滑出这块也继续跟手，且不依赖 `setPointerCapture`
   * （宿主浏览器有，jsdom 没有——行为网要能量到同一条径）。
   * 两轴都实时跟手；松手时才按接近程度吸附（见 `snapMiniBarToEdge`），远离边缘就停在原地。
   */
  useEffect(() => {
    if (!dragging) return
    const win = hostWindow()
    if (win === null) return
    const view = (): Viewport => ({ width: win.innerWidth, height: win.innerHeight })
    const stop = (event: PointerEvent): void => {
      const drag = dragRef.current
      if (drag !== null && drag.id !== event.pointerId) return
      if (drag !== null && movedRef.current) {
        snapMiniBarToEdge(formSize(), view())
        persistMiniBarState()
      }
      dragRef.current = null
      setDragging(false)
    }
    const move = (event: PointerEvent): void => {
      const drag = dragRef.current
      if (drag === null || drag.id !== event.pointerId) return
      // 指针移出窗口后松手时 `pointerup` 不再投递：按位掩码归零就是「键已经松了」的实情，
      // 不补这一判，收场就永远等不到，块会在之后的每一次悬停移动里继续跟手（幽灵拖动）。
      if (event.buttons === 0) {
        stop(event)
        return
      }
      const dx = event.clientX - drag.startX
      const dy = event.clientY - drag.startY
      if (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD) movedRef.current = true
      if (!movedRef.current) return
      // 拖动帧不落 localStorage（同步 I/O × 60fps）；松手时统一落盘
      setMiniBarCenter(drag.startCx + dx, drag.startCy + dy, drag.size, view(), false)
    }
    win.addEventListener('pointermove', move)
    win.addEventListener('pointerup', stop)
    win.addEventListener('pointercancel', stop)
    return () => {
      win.removeEventListener('pointermove', move)
      win.removeEventListener('pointerup', stop)
      win.removeEventListener('pointercancel', stop)
    }
  }, [dragging, formSize])

  /**
   * 拖边：左 / 右 / 下三条边 + 右下角（顶边不做把手——顶行是移动 / 收起面）。对边锚定由
   * `frameFromDrag` 算好，这里只负责跟手与落盘节拍；松手不吸附，只保留夹取后的尺寸与中心。
   */
  useEffect(() => {
    if (!resizing) return
    const win = hostWindow()
    if (win === null) return
    const view = (): Viewport => ({ width: win.innerWidth, height: win.innerHeight })
    const stop = (event: PointerEvent): void => {
      const session = resizeRef.current
      if (session !== null && session.id !== event.pointerId) return
      if (session !== null) persistMiniBarState()
      resizeRef.current = null
      setResizing(false)
    }
    const move = (event: PointerEvent): void => {
      const session = resizeRef.current
      if (session === null || session.id !== event.pointerId) return
      // 同拖动：窗口外松手没有 pointerup，按位掩码归零就是收场信号
      if (event.buttons === 0) {
        stop(event)
        return
      }
      const state = miniBarStore.get()
      const dragged = frameFromDrag(
        session.edge, session.start,
        event.clientX - session.startX, event.clientY - session.startY, view(),
      )
      // 没拖的那一轴保留**意图**：呈现尺寸可能被视口夹小了，拿它回写会把用户定的大尺寸悄悄改小。
      const frame: MiniBarFrame = {
        ...dragged,
        width: session.edge === 'bottom' ? (state.w ?? dragged.width) : dragged.width,
        height: session.edge === 'left' || session.edge === 'right' ? (state.h ?? dragged.height) : dragged.height,
      }
      setMiniBarFrame(frame, view(), false)
    }
    win.addEventListener('pointermove', move)
    win.addEventListener('pointerup', stop)
    win.addEventListener('pointercancel', stop)
    return () => {
      win.removeEventListener('pointermove', move)
      win.removeEventListener('pointerup', stop)
      win.removeEventListener('pointercancel', stop)
    }
  }, [resizing])

  // 快捷键只在**画面里真有这颗浮窗**时装：组件常驻在 shell.overlay，没有会话 / 被就地条接管时
// 渲染返回 null，但 effect 仍会跑——不 gate 就会在书架 / 书城 / 源管理里劫走 Space 与
// Shift+方向键（前者翻页、后者选区）。阅读器在场时同样归它自己的契约。
  useEffect(() => {
    if (!st.active || hiddenByReader) return
    if (reader.depth > 0) return
    const win = hostWindow()
    if (win === null) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.ctrlKey || event.metaKey || event.altKey) return
      // 事件可能落在 window / document 上（没有焦点控件的那一档）：那时 `el` 为 null，快捷键照常生效
      const el = event.target instanceof HTMLElement ? event.target : null
      if (el !== null && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return
      // 同场有模态 / 浮层卡片（含本浮窗自己的设置弹层）认领了键盘层：全局快捷键让位给最上面那层，
      // 与 Esc 同一判据——否则焦点落在遮罩 / body 上时会在模态背后偷放 / 偷跳段。
      if (keyLayerActive()) return
      if (event.key === ' ') {
        // Space 归手上那颗控件：焦点在按钮（含胶囊这枚 role=button）上时它是原生激活，
        // 不是全局播放/暂停——否则「定时」「设置」「收起」每一颗都会被这颗快捷键吃掉。
        if (el !== null && el.closest('button, a[href], [role="button"]')) return
        // 按住不放的自动重复不算一次次「播放 / 暂停」意图（否则长按 Space 来回抖）。
        if (event.repeat) return
        event.preventDefault()
        // 判据与浮窗播放环共用 `isPlayBusy`（在放 ∨ 起播在途）：只认 playing 会让 loading
        // 里的 Space 去调被 loading 挡回的 resume——屏幕上的环能暂停，键盘却按不动。
        if (isPlayBusy(ttsPlayer.get())) pauseListening()
        else resumeListening()
        return
      }
      if (event.shiftKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
        event.preventDefault()
        void skipParagraph(event.key === 'ArrowLeft' ? -1 : 1).catch((error: unknown) => { pushError(ttsErrorMessage(t, error)) })
        return
      }
      // 同场有模态 / 浮层卡片认领了键盘层（如配置页的引擎编辑）：Esc 只归最上面那层，
      // 浮窗不跟着收起。层序判据住 `views/dialog.tsx` 的 `claimKeyLayer`。
      // 上面那道 `keyLayerActive()` 早退已经把这一档挡掉了；设置弹层开着时它自己也认领了
      // 键盘层——所以这里不再重复判「有没有层」与「设置开没开」，只判浮窗自己的形态。
      if (event.key === 'Escape' && !miniBarStore.get().collapsed) {
        setMiniBarCollapsed(true)
      }
    }
    win.addEventListener('keydown', onKey)
    return () => { win.removeEventListener('keydown', onKey) }
  }, [reader.depth, st.active, hiddenByReader, t])

  if (!st.active) return null
  if (hiddenByReader) return null

  const face = listenFaceOf(st)
  const position = segmentLabel(st, t)
  // 空章不摆徽标（摆「0/0」或空章句都不是段号）；有段才给紧凑段号。
  const badge = face.hasSegments ? miniSegmentLabel(st, t) : null
  const line = lineOf(st)
  // 连败到阈值且没在放 = 会话已收口成暂停：展开态挂一行可见读数，收起态用 title / data-failed
  // 给同一读数（胶囊没有放正文的位置，但「为什么停了」不能只活在展开后才看得见的地方）。
  const failureCount = face.failedHint
  const failed = failureCount !== null
  const failedHint = failureCount === null ? '' : t('tts.failedHint', { n: failureCount })
  /** 宽度与高度由现场给（样式层读 `--novel-tts-panel-w/-h` 值槽），形态尺寸按呈现尺寸算。 */
  const form = bar.collapsed ? CAPSULE_SIZE : resolvedMiniBarSize(bar, viewport)
  /** 落位样式与两个派生读数一次给全（缺省轴在这里解析成像素，样式层不给缺省定位）：
   *  `flush` 只管贴边形态（收哪一条边框、哪两侧改直角），`side` 只管设置弹层往哪边开。
   *  两者在贴边时同向，块悬在屏内时必须分家——按 `side` 收边框等于在一条悬空的边上留敞口。 */
  const layout = miniBarLayout(bar, viewport, form)
  // 翻转判据吃**实测**内容高（量不到回退常量）：内容高与 60vh 取小，固定档在六行卡与一行卡之间都会算错方向。
  const flip = miniBarPopoverFlip(bar, viewport, form, settingsHeight ?? undefined)
  /** 选中那一侧的余量：弹层 max-height 的上界（值槽写进 dock）。只判方向不收高度，卡片会
   *  整块探出视口——浮层挂在 fixed 的 dock 上、页面不滚，探出去的那几行既看不见也滚不到。 */
  const popoverRoom = miniBarPopoverRoom(bar, viewport, form, settingsHeight ?? undefined)

  /** 回阅读器：读**调用那一刻**的会话读数（渲染快照可能已落后一段），记现场再切路由。 */
  const backToReader = (): void => {
    const live = ttsPlayer.get()
    if (!live.active || live.bookKey === null || live.sourceId === null) return
    requestReaderRelocation(live.sourceId, live.bookKey, live.chapterIndex, live.paragraphIndex)
    navigate({ name: 'reader', sourceId: live.sourceId, bookKey: live.bookKey, title: live.title })
    focusPanel()
  }

  const collapse = (): void => {
    setSettingsOpen(false)
    setMiniBarCollapsed(true)
  }

  /** 弹层开着时 Esc 只收弹层（dialog 契约自己会收并还焦；这里挡的是浮窗别跟着收起）。 */
  const closeSettings = (): void => { setSettingsOpen(false) }

  const toggleSettings = (): void => {
    if (settingsOpen) {
      closeSettings()
      return
    }
    setSettingsOpen(true)
  }

  /** 胶囊上的点击 / Enter：只落「展开」。
   *  拖动本身不触发展开——松手后补发的那一次 click 由胶囊的捕获层吞掉（见 `onClickCapture`），
   *  键盘激活（click 的 detail 为 0）不会被吞，所以这里不再读拖动历史：读它会把「拖过」变成
   *  键盘用户之后每一次 Enter 都失败、且没有任何反馈。设置弹层也没有「先收弹层」这一档：
   *  它只在展开态可开，而收起的那几条路（收起钮 / 头行双击 / 会话结束）都先清 `settingsOpen`。 */
  const expand = (): void => { setMiniBarCollapsed(false) }

  const beginDrag = (event: ReactPointerEvent<HTMLElement>): void => {
    // 指定拖面（`data-drag="1"`：两个形态的身份钮、展开态正文区）才起手；嵌在拖面里的真控件（如「看全文」）不算。
    // 胶囊容器与面板不再整块接 pointerdown——「点哪都能拖」就是从那里来的。
    const target = event.target as HTMLElement
    const handle = target.closest<HTMLElement>('[data-drag="1"]')
    if (handle === null) return
    const control = target.closest<HTMLElement>('button, input, [role="button"], a[href]')
    if (control !== null && control !== handle) return
    const win = hostWindow()
    if (win === null) return
    const size = formSize()
    const view: Viewport = { width: win.innerWidth, height: win.innerHeight }
    // 起手基准取实际中心：缺省轴在这里解析成数字，拖动的每一帧才跟得上手
    const center = miniBarCenterOf(miniBarStore.get(), size, view)
    dragRef.current = {
      id: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startCx: center.x,
      startCy: center.y,
      size,
    }
    movedRef.current = false
    setDragging(true)
  }

  /** 拖边起手：拿当前呈现尺寸与实际中心当基准，后续帧只在它上面加位移。 */
  const beginResize = (edge: MiniBarEdge, event: ReactPointerEvent<HTMLElement>): void => {
    const win = hostWindow()
    if (win === null) return
    const view: Viewport = { width: win.innerWidth, height: win.innerHeight }
    const size = formSize()
    const center = miniBarCenterOf(miniBarStore.get(), size, view)
    resizeRef.current = {
      id: event.pointerId,
      edge,
      startX: event.clientX,
      startY: event.clientY,
      start: { width: size.width, height: size.height, cx: center.x, cy: center.y },
    }
    setResizing(true)
  }

  /** 四向移动：缺省轴先解析成当前实际中心，再按方向与档位落位（Shift 走三档）。 */  const moveByKey = (event: ReactKeyboardEvent<HTMLElement>): void => {
    if (event.key === 'Home') {
      event.preventDefault()
      event.stopPropagation()
      resetMiniBarPosition()
      return
    }
    const step: [number, number] | null = event.key === 'ArrowUp' ? [0, -1]
      : event.key === 'ArrowDown' ? [0, 1]
      : event.key === 'ArrowLeft' ? [-1, 0]
      : event.key === 'ArrowRight' ? [1, 0]
      : null
    if (step === null) return
    const win = hostWindow()
    if (win === null) return
    event.preventDefault()
    event.stopPropagation()
    const size = formSize()
    const view: Viewport = { width: win.innerWidth, height: win.innerHeight }
    const center = miniBarCenterOf(miniBarStore.get(), size, view)
    const delta = KEY_STEP * (event.shiftKey ? 3 : 1)
    setMiniBarCenter(center.x + step[0] * delta, center.y + step[1] * delta, size, view)
  }

  const onCapsuleKeyDown = (event: ReactKeyboardEvent<HTMLElement>): void => {
    // Enter / Space 归胶囊里那两颗真按钮（播放环与展开钮），这里只管方向键挪位与 Home 复位
    moveByKey(event)
  }

  return (
    <div
      ref={rootRef}
      data-novel-tts-mini
      data-novel-tts-mini-collapsed={bar.collapsed}
      data-novel-scope
      data-side={layout.side}
      data-flush={layout.flush}
      data-dragging={dragging}
      data-resizing={resizing}
      data-flip={flip}
      data-failed={failed ? 'true' : 'false'}
      className="novel-tts-mini-dock"
      style={{ ...layout.style, '--novel-tts-popover-room': `${popoverRoom}px` } as CSSProperties}
      // 新一轮指针序列开始：上一次拖动若在浮窗外松手、没有补发 click 经过这里，
      // 脏标记会留到下一次点击并把那颗控件吞掉——按下即清零，只让同一次序列里的补发 click 生效。
      onPointerDownCapture={() => { movedRef.current = false }}
      // 拖动松手后浏览器还会补发一次 click（指针落在按钮上时尤其明显）：那不是用户点击，
      // 在根上统一吞掉，胶囊与边栏共用一份。只吞指针点击（detail > 0），键盘激活照常。
      onClickCapture={(event) => {
        if (!movedRef.current || event.detail === 0) return
        // 被吞掉的这一发就是脏标记的消费点：它只服务于「拖动后的补发 click」，落地清零，
        // 不留给下一次键盘激活背锅。
        movedRef.current = false
        event.preventDefault()
        event.stopPropagation()
      }}
    >
      {withStyles ? <NovelStyles /> : null}
      {bar.collapsed ? (
        // 胶囊是两颗并列的真按钮（播放环 + 身份钮）的容器：按钮套按钮会让读屏报出两层控件。
        <div
          className="novel-tts-mini-capsule"
          title={`${st.title} · ${position}${line === null ? '' : ` · ${line}`}${failed ? ` · ${failedHint}` : ''}`}
        >
          <RingPlay />
          {/* 身份区既是展开钮也是移动拖面（ADR-0080）：拖过阈值算移动，点击才算展开。
              收起态只给身份与段号，句子只在展开态出现（ADR-0079）。 */}
          <button
            type="button"
            className="novel-tts-mini-expand"
            data-drag="1"
            aria-label={`${t('tts.mini.expand')} · ${st.title} · ${position}`}
            onPointerDown={beginDrag}
            onKeyDown={onCapsuleKeyDown}
            onClick={expand}
          >
            <span className="novel-tts-mini-row">
              <span className="novel-tts-mini-title">{st.title}</span>
              {badge === null ? null : <span className="novel-tts-mini-badge">{badge}</span>}
            </span>
          </button>
          <MiniProgressLine />
        </div>
      ) : (
        <TtsMiniPanel
          sources={sources}
          settingsOpen={settingsOpen}
          onToggleSettings={toggleSettings}
          onCloseSettings={closeSettings}
          onCollapse={collapse}
          onBackToReader={backToReader}
          onDragPointerDown={beginDrag}
          onHeaderKeyDown={moveByKey}
          onSettingsContentHeight={setSettingsHeight}
        />
      )}
      {/* resize 命中带画在面板 padding 圈里（左右 12 / 底 10 ≥ 8）：任何尺寸下都不压控件 */}
      {bar.collapsed
        ? null
        : (
          <>
            {(['left', 'right', 'bottom', 'corner'] as const).map((edge) => (
              <span
                key={edge}
                className="novel-tts-mini-edge"
                data-edge={edge}
                aria-hidden="true"
                onPointerDown={(event) => { beginResize(edge, event) }}
              />
            ))}
          </>
        )}
    </div>
  )
}
