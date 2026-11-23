import type {
  CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode,
} from 'react'
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { apiGet } from '../api.js'
import { useCopy } from '../copy/index.js'
import { navigate, useStore } from '../store.js'
import { NovelStyles } from '../styles.js'
import { pushError } from '../transient.js'
import {
  isPlayBusy, lineOf, listenFaceOf, miniSegmentLabel, segmentLabel,
} from './listen-readout.js'
import {
  CAPSULE_SIZE, createMiniBarController, MINI_BAR_EDGES, miniBarLayout, miniBarPopoverFlip,
  miniBarPopoverRoom, miniBarStore, resetMiniBarPosition, resolvedMiniBarSize, setMiniBarCollapsed,
} from './mini-bar-state.js'
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
 * 全局听书浮窗：宿主 `shell.overlay` 常驻层上的两个**完整**形态，位置自由落位（`ADR-0100`）。
 * 缺省是贴边的 208×44 身份条（进度环 / 书名与段号），点击展开为整段边栏（缺省 320×200，
 * 宽高可拖，`ADR-0080`）。不做 idle 半隐、不做同一颗胶囊藏一半的 hover 抽屉；设置面与阅读器条
 * 共读 `TtsSettings.tsx` 同一份行清单。
 *
 * 现场 = 块中心 + 收起态：拖动跟手，松手时离视口边 ≤ 24px 才贴齐；方向键四向移动（Shift 三档）、
 * Home 复位；位置与收起态落 localStorage，视口变化后贴着的边继续贴、自由位置只夹不漂。
 *
 * 在场判据（`ADR-0072`）：会话在 ∧ 阅读器在场书键集合里**没有**会话本书；阅读器里听本书时由
 * 就地条（`TtsBar`）接管，开着另一本时迷你条照常在场。快捷键只在**没有阅读器子树**时装
 * （Space / Shift+←→ / Esc 各归阅读器原主）。
 *
 * 「回阅读器」：记一次性重定位现场（带书键）+ 切路由；恢复目标归 ReaderSession 的 restore
 * （站定不写），绝不走会提交阅读进度的跳章。
 */
export interface TtsMiniBarProps {
  /** 把「小说」面板带到前台：宿主可能停在任何面板上，只切插件内路由等于点了没反应 */
  focusPanel: () => void
  /** 是否自带样式层。缺省 true；与状态层同树挂载时传 false——同一份 `NOVEL_CSS` 不必进 DOM 两遍。 */
  withStyles?: boolean
}

/** 键盘移动一档的像素数（Shift 走三档）：与样式层的间距标度同尺，方向键才不像在乱跳。 */
const KEY_STEP = 16

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
  // 拖动 / 拖边 / 视口读数 / 几何夹取都归控制器；视图只拿渲染快照。
  const [controller] = useState(createMiniBarController)
  const { viewport, dragging, resizing } = useSyncExternalStore(
    controller.subscribe, controller.snapshot, controller.snapshot,
  )
  const attachRoot = useCallback((el: HTMLDivElement | null) => { controller.attach(el) }, [controller])
  const [settingsOpen, setSettingsOpen] = useState(false)
  /** 设置弹层的内容实测高（`null` = 量不到 → 翻转判据回退常量）。 */
  const [settingsHeight, setSettingsHeight] = useState<number | null>(null)
  const sources = useTtsSources(settingsOpen, apiGet, pushError)

  // 视口监听、尺寸观察与换形态后的重夹共用一条生命周期：窗口尺寸只在控制器里读，
  // 根节点随会话出现 / 退场，形态变了要按新尺寸重夹；DOM 提交后跑，量到的是新形态。
  useEffect(() => {
    const disconnect = controller.connect()
    controller.reconcile()
    return disconnect
  }, [bar.collapsed, controller, hiddenByReader, st.active])

  // 会话结束 / 被阅读器就地条接管时，别把设置弹层留到下一轮再冒出来
  useEffect(() => {
    if (!st.active || hiddenByReader) setSettingsOpen(false)
  }, [st.active, hiddenByReader])

  // 快捷键只在**画面里真有这颗浮窗**时装：组件常驻 shell.overlay，渲染返回 null 时 effect 仍会跑——
  // 不 gate 就会在书架 / 书城 / 源管理里劫走 Space 与 Shift+方向键。
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
      // 同场有模态 / 浮层卡片认领了键盘层：全局快捷键让位给最上面那层。
      if (keyLayerActive()) return
      if (event.key === ' ') {
        // Space 归手上的控件：焦点在按钮上时它是原生激活，不是全局播放/暂停。
        if (el !== null && el.closest('button, a[href], [role="button"]')) return
        // 按住不放的自动重复不算一次次「播放 / 暂停」意图（否则长按 Space 来回抖）。
        if (event.repeat) return
        event.preventDefault()
        // 判据与播放环共用 `isPlayBusy`：只认 playing 会让 loading 里的 Space 调不动。
        if (isPlayBusy(ttsPlayer.get())) pauseListening()
        else resumeListening()
        return
      }
      if (event.shiftKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
        event.preventDefault()
        void skipParagraph(event.key === 'ArrowLeft' ? -1 : 1).catch((error: unknown) => { pushError(ttsErrorMessage(t, error)) })
        return
      }
      // 上面那道 `keyLayerActive()` 已挡掉有浮层的场；这里不再重复判「有没有层」与「设置开没开」。
      // 层序判据住 `views/dialog.tsx` 的 `claimKeyLayer`。
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
  // 连败到阈值且没在放 = 会话已收口成暂停：收起态用 title / data-failed 给同一读数。
  const failureCount = face.failedHint
  const failed = failureCount !== null
  const failedHint = failureCount === null ? '' : t('tts.failedHint', { n: failureCount })
  /** 宽度与高度由现场给（样式层读 `--novel-tts-panel-w/-h` 值槽），形态尺寸按呈现尺寸算。 */
  const form = bar.collapsed ? CAPSULE_SIZE : resolvedMiniBarSize(bar, viewport)
  /** 落位样式与两个派生读数一次给全：`flush` 只管贴边形态，`side` 只管设置弹层往哪边开；
   *  两者在贴边时同向，块悬在屏内时必须分家——按 `side` 收边框等于在悬空的边上留敞口。 */
  const layout = miniBarLayout(bar, viewport, form)
  // 翻转判据吃**实测**内容高（量不到回退常量）：内容高与 60vh 取小，固定档在六行卡与一行卡之间都会算错方向。
  const flip = miniBarPopoverFlip(bar, viewport, form, settingsHeight ?? undefined)
  /** 选中那一侧的余量：弹层 max-height 上界；只判方向不收高度，卡片会整块探出视口。 */
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

  /** 胶囊上的点击 / Enter：只落「展开」。拖动不触发展开（松手补发的 click 由捕获层吞掉）；
   *  键盘激活（click 的 detail 为 0）不会被吞，所以这里不读拖动历史。设置弹层没有「先收」档。 */
  const expand = (): void => { setMiniBarCollapsed(false) }

  /** 手柄与 pointerdown 交给控制器：起手判据与指针生命周期都不在视图里写第二遍。 */
  const beginDrag = (event: ReactPointerEvent<HTMLElement>): void => {
    controller.beginDrag(event.currentTarget, event.nativeEvent)
  }

  /** 四向移动：缺省轴先解析成当前实际中心，再按方向与档位落位（Shift 走三档）。 */
  const moveByKey = (event: ReactKeyboardEvent<HTMLElement>): void => {
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
    if (hostWindow() === null) return
    event.preventDefault()
    event.stopPropagation()
    const delta = KEY_STEP * (event.shiftKey ? 3 : 1)
    controller.moveCenterBy(step[0] * delta, step[1] * delta)
  }

  const onCapsuleKeyDown = (event: ReactKeyboardEvent<HTMLElement>): void => {
    // Enter / Space 归胶囊里那两颗真按钮（播放环与展开钮），这里只管方向键挪位与 Home 复位
    moveByKey(event)
  }

  return (
    <div
      ref={attachRoot}
      data-novel-tts-mini
      data-novel-tts-mini-collapsed={bar.collapsed}
      data-novel-scope
      data-side={layout.side}
      data-flush={layout.flush}
      data-dragging={dragging}
      data-resizing={resizing !== null}
      data-resize-edge={resizing ?? undefined}
      data-flip={flip}
      data-failed={failed ? 'true' : 'false'}
      className="novel-tts-mini-dock"
      style={{ ...layout.style, '--novel-tts-popover-room': `${popoverRoom}px` } as CSSProperties}
      // 按下即清零脏标记：只让同一次指针序列里的补发 click 生效。
      onPointerDownCapture={() => { controller.clearMoved() }}
      // 拖动松手后浏览器还会补发一次 click：在根上统一吞掉（detail > 0），键盘激活照常。
      onClickCapture={(event) => {
        if (!controller.moved() || event.detail === 0) return
        // 被吞的这一发就是脏标记的消费点，落地清零。
        controller.clearMoved()
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
          {/* 身份区既是展开钮也是移动拖面（ADR-0080）：拖过阈值算移动，点击才算展开。 */}
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
            {MINI_BAR_EDGES.map((edge) => (
              <span
                key={edge}
                className="novel-tts-mini-edge"
                data-edge={edge}
                aria-hidden="true"
                onPointerDown={(event) => { controller.beginResize(edge, event.nativeEvent) }}
              />
            ))}
          </>
        )}
    </div>
  )
}
