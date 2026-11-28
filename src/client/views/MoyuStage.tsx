import type { CSSProperties, ReactNode } from 'react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useCopy } from '../copy/index.js'
import type { Translate } from '../copy/index.js'
import { rangePercent } from '../util.js'
import {
  MOYU_README_NAME,
  MOYU_TICK_CHARS,
  MOYU_TICK_MS,
  actionMarkFor,
  chapterFileName,
  extractMoyuTurnBlocks,
  isMainLine,
  isPinnedToTail,
  moyuChapterPath,
  nextPhase,
} from '../moyu-stream.js'
import type { MoyuTurnBlock } from '../moyu-stream.js'
import { MoyuClock, formatMessageClock } from '../moyu-clock.js'
import { cacheHitPercentOf, errorCodeOf, tokOf, tokensPerSecondOf } from '../moyu-metrics.js'
import {
  bindMoyuWorkspace,
  moyuHostStore,
  moyuWorkspaceStore,
  openMoyuWorkspaceSession,
  openPluginList,
  refreshMoyuWorkspaces,
} from '../moyu-host.js'
import type { MoyuWorkspaceOption } from '../moyu-host.js'
import { moyuMirrorStore } from '../moyu-mirror.js'
import type { MoyuMirrorRow, MoyuMirrorTurn } from '../moyu-mirror.js'
import { moyuReadmeMarkdown } from '../moyu-markdown.js'
import type { ReaderScene } from '../reader-scene.js'
import type { ReaderSceneState } from '../reader-scene.js'
import type { ReaderSession } from '../reader-session.js'
import type { ReaderSessionState } from '../reader-session.js'
import { setPref, useStore } from '../store.js'
import type { Prefs } from '../store.js'
import type { ListenScope } from '../tts/listen-scope.js'
import { paragraphSlotOf } from '../tts/reading-position.js'
import {
  pauseListening,
  playFromReadingPosition,
  resumeListening,
  seekParagraph,
  setListenRate,
  setListenTimer,
  skipChapter,
  skipParagraph,
  stopListening,
  ttsPlayer,
  ttsProgress,
} from '../tts/player.js'
import type { TtsPlayerState } from '../tts/player.js'
import {
  chapterProgressOf, lineOf, listenFaceOf, rateLabel, timerChoiceLabel,
} from '../tts/listen-readout.js'
import { useTimerReadout } from '../tts/use-timer-readout.js'
import { SETTINGS_ICON, TtsSettingsNote, TtsSettingsPanel, TtsSettingsRows, nextTimerChoice } from '../tts/TtsSettings.js'
import { cycleRate } from '../tts/TtsBar.js'
import { useTtsSources } from '../tts/use-tts-sources.js'
import { MoyuPreviewPane } from './moyu-preview.js'
import { MoyuTrajectory, MoyuTrajectoryDetail } from './moyu-trajectory.js'
import type { MoyuTrajectoryEvent, MoyuTrajectoryTurn } from './moyu-trajectory.js'
import { useDialogContract } from './dialog.js'
import type { LinkRole, ReadingTarget } from './types.js'
import { MoyuTooltip } from './moyu-tooltip.js'
import { resourceUrl } from '../../shared/wire.js'
import type { ChapterContent } from '../../shared/wire.js'

const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

export interface MoyuStageProps {
  session: ReaderSession
  sourceId: string
  bookKey: string
  title: string
  state: ReaderSessionState
  prefs: Prefs
  scene: ReaderScene
  sceneState: ReaderSceneState
  listen: ListenScope
  importNotesCount: number
  onOpenExport: () => void
  onListen: () => void
  onClose: () => void
  onNavigate: (target: ReadingTarget, role: LinkRole) => void
  onTtsError: (cause: unknown) => void
  /** 听书设置卡的引擎清单读面（宿主 /novel-api；与阅读器听书条同一束）。 */
  apiGet: <T>(path: string) => Promise<T>
  overlays?: ReactNode
  defaultDockOpen?: boolean
}

export interface MoyuStageRect {
  left: number
  top: number
  width: number
  height: number
}

interface TurnProjection {
  blocks: MoyuTurnBlock[]
  lengths: Array<number | null>
  paragraphCount: number
  total: number
}

const EMPTY_PROJECTION: TurnProjection = { blocks: [], lengths: [], paragraphCount: 0, total: 0 }

/** 舞台盒只量插件主内容区（宿主左侧栏与顶栏不归本插件）；测量结果由视图写回行内样式。 */
export function measureMoyuStageRect(root: Element): MoyuStageRect | null {
  const port = root.closest<HTMLElement>('[data-novel-main]')
  if (port === null) return null
  const rect = port.getBoundingClientRect()
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
}

/* ── 键盘层序（D20 / I12 共用一张表）────────────────────────────────────────
   单击 Esc 逐层收起：菜单 → 事件详情浮层 → 文档预览 tab（回「文件」tab）→ 文件搜索
   （先清词、再收框）→ 退舞台。
   双击 Esc＝停止生成（补完当前章）只在流式中认，且不打乱单击层序。 */

export interface MoyuEscState {
  menuOpen: boolean
  detailOpen: boolean
  previewOpen: boolean
  searchOpen: boolean
  filter: string
}

export type MoyuEscAction = 'menu' | 'detail' | 'preview' | 'search-clear' | 'search-close' | 'exit'

export function escLayerOf(state: MoyuEscState): MoyuEscAction {
  if (state.menuOpen) return 'menu'
  if (state.detailOpen) return 'detail'
  if (state.previewOpen) return 'preview'
  if (state.searchOpen && state.filter !== '') return 'search-clear'
  if (state.searchOpen) return 'search-close'
  return 'exit'
}

/** 两次独立 Esc 的 500ms 窗口（宿主 stopSequenceMs 缺省）；只在流式中命中。 */
export class EscStopSequence {
  private deadline = 0

  press(now: number, streaming: boolean): boolean {
    if (!streaming) {
      this.deadline = 0
      return false
    }
    const hit = now <= this.deadline
    this.deadline = now + 500
    return hit
  }

  reset(): void {
    this.deadline = 0
  }
}

/* ── 计时（宿主 message-chrome `formatRunDuration` 的进位口径）：X 分 X 秒 ── */

interface DurationPart {
  text: string
  numeric: boolean
}

function durationParts(totalSeconds: number, t: Translate): DurationPart[] {
  const total = Math.max(0, Math.floor(totalSeconds))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor(total / 60) % 60
  const seconds = total % 60
  const parts: DurationPart[] = []
  if (hours > 0) parts.push({ text: String(hours), numeric: true }, { text: t('reader.moyu.duration.hour'), numeric: false })
  if (total >= 60) parts.push({ text: String(minutes), numeric: true }, { text: t('reader.moyu.duration.minute'), numeric: false })
  parts.push({ text: String(seconds), numeric: true }, { text: t('reader.moyu.duration.second'), numeric: false })
  return parts
}

function DurationText({ parts, className }: { parts: DurationPart[]; className: string }): ReactNode {
  return (
    <>
      {parts.map((part, index) => (
        <span key={index} className={part.numeric ? className : undefined}>{part.text}</span>
      ))}
    </>
  )
}

/* ── 过程组摘要（宿主 ChatGroupSeat `processTitle` 的口径）：收起＝动词短语连缀，
      运行＝「正在X · 摘要」。 ── */

function processTitleOf(
  kinds: readonly ('think' | 'read' | 'search')[],
  t: Translate,
): string {
  const labels = kinds.slice(0, 3).map((kind) => t(`reader.moyu.step.${kind}.done`))
  const first = labels[0]
  if (first === undefined) return t('reader.moyu.step.think.done')
  const shared = t('reader.moyu.step.sharedPrefix')
  const continuation = (label: string): string =>
    shared !== '' && label.startsWith(shared) ? label.slice(shared.length) : label
  const second = labels[1]
  if (second === undefined) return first
  if (labels.length === 2) return t('reader.moyu.step.joinTwo', { first, second: continuation(second) })
  const title = [first, ...labels.slice(1).map(continuation)].join(t('reader.moyu.step.comma'))
  return kinds.length > 3 ? t('reader.moyu.step.more', { title }) : title
}

/* ── 真轮次镜像的行摘要（思考行）：正文首行截断，不编语义 ── */

function firstLineOf(text: string): string {
  const line = text.split('\n', 1)[0] ?? ''
  return Array.from(line).slice(0, 60).join('')
}

/* ── 图标：宿主图标册（product artwork）的真实画法，regular 档 stroke 1。
      发送/停止按宿主输入条的实心笔形内联画法。 ── */

function MoreIcon(): ReactNode {
  return (
    <svg className="novel-moyu-svg-fill" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3 9C3.55228 9 4 8.55228 4 8C4 7.44772 3.55228 7 3 7C2.44772 7 2 7.44772 2 8C2 8.55228 2.44772 9 3 9Z" />
      <path d="M8 9C8.55228 9 9 8.55228 9 8C9 7.44772 8.55228 7 8 7C7.44772 7 7 7.44772 7 8C7 8.55228 7.44772 9 8 9Z" />
      <path d="M13 9C13.5523 9 14 8.55228 14 8C14 7.44772 13.5523 7 13 7C12.4477 7 12 7.44772 12 8C12 8.55228 12.4477 9 13 9Z" />
    </svg>
  )
}

function CloseIcon(): ReactNode {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3.5 3.5L12.5 12.5" /><path d="M12.5 3.5L3.5 12.5" />
    </svg>
  )
}

function SearchIcon(): ReactNode {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M6.58727 11.8586C9.55061 11.8586 11.9529 9.45637 11.9529 6.49304C11.9529 3.5297 9.55061 1.12744 6.58727 1.12744C3.62394 1.12744 1.22168 3.5297 1.22168 6.49304C1.22168 9.45637 3.62394 11.8586 6.58727 11.8586Z" />
      <path d="M10.2991 10.3933L14.7783 14.8725" />
    </svg>
  )
}

function RefreshIcon(): ReactNode {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M14.5001 8C14.5 9.28552 14.1188 10.5422 13.4045 11.611C12.6903 12.6799 11.6752 13.5129 10.4875 14.0049C9.29982 14.4968 7.99295 14.6255 6.73212 14.3747C5.4713 14.124 4.31314 13.505 3.4041 12.596C2.49514 11.687 1.87614 10.5288 1.62537 9.26798C1.37459 8.00716 1.50331 6.70028 1.99525 5.51261C2.48719 4.32494 3.32025 3.30981 4.3891 2.59557C5.45795 1.88134 6.71458 1.50008 8.0001 1.5C9.9001 1.5 11.7001 2.3 13.0001 3.6L14.5001 5.1" />
      <path d="M14.4999 1.5V5.1H10.8999" />
    </svg>
  )
}

/** 宿主 sidebar-right ExpandButton 的画法：左栏面板图标镜像。 */
function PanelIcon({ mirrored = false }: { mirrored?: boolean }): ReactNode {  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" style={mirrored ? { transform: 'scaleX(-1)' } : undefined}>
      <path d="M13.5 1.5H2.5C1.94772 1.5 1.5 1.94772 1.5 2.5V13.5C1.5 14.0523 1.94772 14.5 2.5 14.5H13.5C14.0523 14.5 14.5 14.0523 14.5 13.5V2.5C14.5 1.94772 14.0523 1.5 13.5 1.5Z" />
      <path d="M5.5 1.5V14.5" />
    </svg>
  )
}

/** 「浏览更多插件」的 pinwheel 线稿（宿主 PluginPinwheelOutline 的替代画法）。 */
function PinwheelIcon(): ReactNode {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="1.4" />
      <path d="M8 6.6C8 4.4 8.9 2.2 10.6 1.6C11.3 3.5 10.6 5.6 8 6.6Z" />
      <path d="M9.4 8C11.6 8 13.8 7.1 14.4 5.4C12.5 4.7 10.4 5.4 9.4 8Z" />
      <path d="M8 9.4C8 11.6 7.1 13.8 5.4 14.4C4.7 12.5 5.4 10.4 8 9.4Z" />
      <path d="M6.6 8C4.4 8 2.2 8.9 1.6 10.6C3.5 11.3 5.6 10.6 6.6 8Z" />
    </svg>
  )
}

function FolderIcon({ open }: { open: boolean }): ReactNode {
  return open
    ? (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M12.3994 13.5986H2.04956C1.49728 13.5986 1.04956 13.1509 1.04956 12.5986V3.40137C1.04956 2.84908 1.49728 2.40137 2.04956 2.40137H4.76632C5.01016 2.40137 5.24561 2.49046 5.42836 2.6519L6.94088 3.98799C7.12364 4.14943 7.35908 4.23852 7.60293 4.23852H12.3994C12.9517 4.23852 13.3994 4.68624 13.3994 5.23852V7.16991" />
        <path d="M2.55911 7.93683C2.67584 7.49906 3.07229 7.19446 3.52536 7.19446H13.6491C14.3061 7.19446 14.7846 7.81725 14.6153 8.45209L13.4411 12.856C13.3244 13.2938 12.9279 13.5984 12.4748 13.5984H2.35113C1.69411 13.5984 1.21562 12.9756 1.38489 12.3407L2.55911 7.93683Z" />
      </svg>
    )
    : (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M1.50439 3.11059C1.50439 2.55831 1.95211 2.1106 2.50439 2.1106H5.43389C5.67773 2.1106 5.91318 2.19969 6.09593 2.36113L7.71649 3.79265C7.89924 3.95409 8.1347 4.04319 8.3785 4.04319H13.4958C14.0481 4.04319 14.4958 4.4909 14.4958 5.04319V12.8894C14.4958 13.4417 14.0481 13.8894 13.4958 13.8894H2.50439C1.95211 13.8894 1.50439 13.4417 1.50439 12.8894V4.04319V3.11059Z" />
        <path d="M3.63501 7.66614H12.3647" />
      </svg>
    )
}

function PlusIcon(): ReactNode {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 2V14" /><path d="M2 8H14" />
    </svg>
  )
}

/** 宿主输入条的实心粗箭（发送）。 */
function SendIcon(): ReactNode {
  return (
    <svg className="novel-moyu-svg-fill" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8.3125 0.980183C8.66767 1.0531 8.97902 1.20418 9.2627 1.43233C9.48724 1.61297 9.73029 1.85793 9.97949 2.10714L14.707 6.83468L13.293 8.24874L9 3.95577V15.0417H7V3.95577L2.70703 8.24874L1.29297 6.83468L6.02051 2.10714C6.26971 1.85793 6.51277 1.61297 6.7373 1.43233C6.97662 1.23986 7.28445 1.04402 7.6875 0.980183C7.8973 0.947006 8.1031 0.95516 8.3125 0.980183Z" />
    </svg>
  )
}

/** 宿主输入条的停止方块（10×10 rx3 实心）。 */
function StopIcon(): ReactNode {
  return (
    <svg className="novel-moyu-svg-fill" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="3" y="3" width="10" height="10" rx="3" />
    </svg>
  )
}

function ChevronDownIcon({ up = false }: { up?: boolean }): ReactNode {
  return up
    ? (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M12 10L8.70711 6.70711C8.31658 6.31658 7.68342 6.31658 7.29289 6.70711L4 10" />
      </svg>
    )
    : (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M4 6L7.29289 9.29289C7.68342 9.68342 8.31658 9.68342 8.70711 9.29289L12 6" />
      </svg>
    )
}

function ChevronLeftIcon(): ReactNode {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M10 4L6.70711 7.29289C6.31658 7.68342 6.31658 8.31658 6.70711 8.70711L10 12" />
    </svg>
  )
}

function ChevronRightIcon(): ReactNode {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M6 12L9.29289 8.70711C9.68342 8.31658 9.68342 7.68342 9.29289 7.29289L6 4" />
    </svg>
  )
}

/** 宿主图标册 pause-outline / play-outline 的真画法（圆框 + 实心笔形）。 */
function PlayIcon({ pause }: { pause: boolean }): ReactNode {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 14.5C11.5899 14.5 14.5 11.5899 14.5 8C14.5 4.41015 11.5899 1.5 8 1.5C4.41015 1.5 1.5 4.41015 1.5 8C1.5 11.5899 4.41015 14.5 8 14.5Z" />
      {pause
        ? <><path d="M6.5 5V11" /><path d="M9.5 5V11" /></>
        : <path d="M10.3329 7.91346C10.3996 7.95195 10.3996 8.04818 10.3329 8.08667L6.78304 10.1362C6.71638 10.1747 6.63304 10.1266 6.63304 10.0496L6.63304 5.95055C6.63304 5.87357 6.71638 5.82546 6.78304 5.86395L10.3329 7.91346Z" stroke="none" fill="currentColor" />}
    </svg>
  )
}

/** 运行鲸（宿主 RunningWhaleTail 的静帧画法，stroke 1）。 */
function WhaleIcon(): ReactNode {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8.844 13.742C8.967 12.328 8.45 10.4 8.45 9.65C8.45 8.94 8.88 8.43 9.6 8.43C11.285 8.43 12.106 8.281 12.685 8.104C13.71 7.791 14.585 6.768 15.055 5.945C15.137 5.803 14.99 5.641 14.829 5.671C13.829 5.86 12.828 5.376 11.827 4.978C10.659 4.514 9.491 4.707 8.935 4.876C8.805 4.915 8.658 4.819 8.636 4.686C8.468 3.643 7.405 2.615 5.498 2.238C4.54 2.048 3.748 1.574 3.347 1.202C3.252 1.113 3.088 1.125 3.03 1.242C2.628 2.059 2.168 3.82 5.248 6.115C5.82 6.494 6.31 6.785 6.574 7.637C6.72 8.104 6.157 9.168 6.061 9.368C5.157 11.27 5.089 12.19 4.926 13.742" />
    </svg>
  )
}

function CopyIcon(): ReactNode {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <rect x="1.52075" y="4.07373" width="10.3932" height="10.3932" rx="2" />
      <path d="M11.9792 1.53296C13.36 1.53296 14.4792 2.65225 14.4792 4.03296V9.42847C14.4792 10.3756 13.9521 11.1987 13.1755 11.6228V10.3298C13.3652 10.0787 13.4792 9.7674 13.4792 9.42847V4.03296C13.4792 3.20453 12.8077 2.53296 11.9792 2.53296H6.58374C6.27966 2.53301 5.99684 2.6235 5.7605 2.77905H4.42358C4.85652 2.03463 5.66056 1.53304 6.58374 1.53296H11.9792Z" />
    </svg>
  )
}

function CheckIcon(): ReactNode {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2.25 8.5L5.49732 11.7473C5.90519 12.1552 6.57263 12.1344 6.95426 11.7018L13.75 4" />
    </svg>
  )
}

function ForkIcon(): ReactNode {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M1.01503 8.0001L5.6964 8.0001C6.41913 8.0001 6.78049 8.0001 7.12115 7.91951C7.4232 7.84804 7.71233 7.73014 7.97821 7.57C8.27809 7.38939 8.5364 7.13669 9.05303 6.63129L11.3281 4.40564" />
      <path d="M1.01221 7.9999L5.6964 7.9999C6.41913 7.9999 6.78049 7.9999 7.12115 8.08049C7.4232 8.15196 7.71233 8.26986 7.97821 8.43C8.27809 8.61061 8.5364 8.86331 9.05303 9.36871L11.3281 11.5944" />
      <circle cx="12.4502" cy="3.3079" r="1.56962" />
      <circle cx="12.4502" cy="12.6921" r="1.56962" />
    </svg>
  )
}

function DownIcon(): ReactNode {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10m0 0-3-3m3 3 3-3" /></svg>
}

/** 统计坞 gauge 图标（宿主图标册 gauge-outline 的真画法）。 */
function GaugeIcon(): ReactNode {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3.4041 13.096C2.49514 12.187 1.87614 11.0288 1.62537 9.76798C1.37459 8.50716 1.50331 7.20028 1.99525 6.01261C2.48719 4.82494 3.32025 3.80981 4.3891 3.09557C5.45795 2.38134 6.71458 2.00008 8.0001 2C9.28563 2.00008 10.5423 2.38134 11.6111 3.09557C12.68 3.80981 13.513 4.82494 14.005 6.01261C14.4969 7.20028 14.6256 8.50716 14.3748 9.76798C14.1241 11.0288 13.5051 12.187 12.5961 13.096" />
      <path d="M8 8.49994L11.6114 4.88855" />
      <path d="M8 9.75C8.69036 9.75 9.25 9.19036 9.25 8.5C9.25 7.80964 8.69036 7.25 8 7.25C7.30964 7.25 6.75 7.80964 6.75 8.5C6.75 9.19036 7.30964 9.75 8 9.75Z" fill="currentColor" stroke="none" />
    </svg>
  )
}

/** UsagePill 的数据库图标（宿主图标册 database-outline 的真画法）。 */
function DatabaseIcon(): ReactNode {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M13.1967 5.1869C13.7232 4.77378 14.0003 4.30517 14.0001 3.82819C14.0003 3.3512 13.7232 2.88259 13.1967 2.46947C12.6702 2.05635 11.9128 1.71328 11.0006 1.47475C10.0885 1.23621 9.05371 1.11062 8.00039 1.1106C6.94707 1.11057 5.9123 1.23612 5.00009 1.47461C4.08742 1.71301 3.32948 2.05604 2.80249 2.46919C2.2755 2.88235 1.99805 3.35106 1.99805 3.82819C1.99805 4.30531 2.2755 4.77402 2.80249 5.18718C3.32948 5.60033 4.08742 5.94336 5.00009 6.18176C5.9123 6.42025 6.94707 6.5458 8.00039 6.54578C9.05371 6.54575 10.0885 6.42016 11.0006 6.18163C11.9128 5.94309 12.6702 5.60002 13.1967 5.1869Z" />
      <path d="M2 3.80371V11.7848" />
      <path d="M14 3.80371V11.7848" />
      <path d="M2 7.81396C2 8.60524 2.63214 9.36411 3.75736 9.92363C4.88258 10.4832 6.4087 10.7975 8 10.7975C9.5913 10.7975 11.1174 10.4832 12.2426 9.92363C13.3679 9.36411 14 8.60524 14 7.81396" />
      <path d="M2 11.7847C2 12.6081 2.63214 13.3977 3.75736 13.98C4.88258 14.5622 6.4087 14.8893 8 14.8893C9.5913 14.8893 11.1174 14.5622 12.2426 13.98C13.3679 13.3977 14 12.6081 14 11.7847" />
    </svg>
  )
}

/** 听书任务条的队列图标（宿主图标册 queue-outline 的真画法，QueueDock lead 位）。 */
function QueueIcon(): ReactNode {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M5 6.75H11" />
      <path d="M5 9H8" />
      <path d="M2.37067 11.2497C1.5872 9.89252 1.32042 8.29798 1.61945 6.7597C1.91847 5.22141 2.76317 3.84293 3.99801 2.87809C5.23285 1.91325 6.7747 1.427 8.33964 1.50888C9.90458 1.59076 11.3873 2.23526 12.5147 3.32369C13.6422 4.41232 14.3384 5.8717 14.4751 7.43304C14.6118 8.99438 14.1797 10.5525 13.2585 11.8205C12.3372 13.0885 10.9889 13.9809 9.4617 14.3334C8.18666 14.6277 6.8587 14.529 5.64964 14.0601C5.17095 13.8745 4.76937 13.4929 4.26509 13.3963C3.67389 13.2832 2.95232 13.5595 2.0377 14.3334" />
    </svg>
  )
}

function ThinkIcon(): ReactNode {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M10.2854 5.71481C12.9673 8.39663 14.1182 11.5938 12.8562 12.8559C11.5942 14.1179 8.39706 12.9669 5.71518 10.2851C3.03333 7.60323 1.88236 4.40608 3.14441 3.14403C4.40644 1.882 7.6036 3.03297 10.2854 5.71481Z" />
      <path d="M10.2854 10.2851C7.6036 12.9669 4.40644 14.1179 3.14441 12.8559C1.88236 11.5938 3.03333 8.39663 5.71518 5.71481C8.39706 3.03297 11.5942 1.882 12.8562 3.14403C14.1182 4.40608 12.9673 7.60323 10.2854 10.2851Z" />
      <path d="M8.86291 8.0002C8.86291 8.47549 8.47762 8.86087 8.00224 8.86087C7.52694 8.86087 7.1416 8.47549 7.1416 8.0002C7.1416 7.52485 7.52694 7.13953 8.00224 7.13953C8.47762 7.13953 8.86291 7.52485 8.86291 8.0002Z" />
    </svg>
  )
}

function FileReadIcon(): ReactNode {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3.5 2.5h6l3 3v8a1 1 0 0 1-1 1h-8a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1z" />
      <path d="M9.5 2.5v3h3" />
      <path d="M5.5 8.5h5M5.5 11h3.5" />
    </svg>
  )
}

/** 真工具行的中性工具徽（照 ToolRow 形态；宿主工具行是逐工具具名图标，取不到语义就用中性齿轮，不猜）。 */
function ToolIcon(): ReactNode {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="2.4" />
      <path d="M8 2.2v2M8 11.8v2M2.2 8h2M11.8 8h2M3.9 3.9l1.4 1.4M10.7 10.7l1.4 1.4M12.1 3.9l-1.4 1.4M5.3 10.7l-1.4 1.4" />
    </svg>
  )
}

/** 宿主图标册 sliders-two-outline 的真画法（搜索设置钮）。 */
function SlidersIcon(): ReactNode {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2.3 5h5.85M12.05 5h1.65" />
      <circle cx="9.95" cy="5" r="1.45" />
      <path d="M2.3 11h1.65M7.85 11h5.85" />
      <circle cx="5.75" cy="11" r="1.45" />
    </svg>
  )
}

/** 宿主图标册 download-outline 的真画法（regular 档 stroke 1）。 */
function DownloadIcon(): ReactNode {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 1.95317V10.0469" />
      <path d="M4.25 6.29688L8 10.0469L11.75 6.29688" />
      <path d="M1.5 10.0469V13.158C1.5 13.3937 1.60536 13.6198 1.79289 13.7865C1.98043 13.9532 2.23478 14.0469 2.5 14.0469H13.5C13.7652 14.0469 14.0196 13.9532 14.2071 13.7865C14.3946 13.6198 14.5 13.3937 14.5 13.158V10.0469" />
    </svg>
  )
}

/** 宿主图标册 info-outline 的真画法（整枚实心面，走 fill 档）。 */
function InfoIcon(): ReactNode {
  return (
    <svg className="novel-moyu-svg-fill" viewBox="0 0 14 14" aria-hidden="true">
      <path d="M12.5757 7.00012C12.5757 3.92085 10.0794 1.42463 7.00012 1.42456C3.9208 1.42456 1.42456 3.9208 1.42456 7.00012C1.42463 10.0794 3.92085 12.5757 7.00012 12.5757C10.0793 12.5756 12.5756 10.0793 12.5757 7.00012ZM13.8002 7.00012C13.8001 10.7559 10.7559 13.8001 7.00012 13.8002C3.2443 13.8002 0.199291 10.7559 0.199219 7.00012C0.199219 3.24426 3.24426 0.199219 7.00012 0.199219C10.7559 0.199291 13.8002 3.2443 13.8002 7.00012Z" />
      <path d="M7.6127 3.18921V4.55986H6.38735V3.18921H7.6127Z" />
      <path d="M7.6127 5.68921V10.8109H6.38735V5.68921H7.6127Z" />
    </svg>
  )
}

function SpeakerIcon(): ReactNode {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3 6.2h2.3L8 3.6v8.8L5.3 9.8H3z" />
      <path d="M10.4 6a2.7 2.7 0 0 1 0 4M12.2 4.2a5.2 5.2 0 0 1 0 7.6" />
    </svg>
  )
}

function MdFileIcon(): ReactNode {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <rect x="2.2" y="2" width="11.6" height="12" rx="2" />
      <path d="M5 10.5V6l1.6 2L8.2 6v4.5M10 6v4.5" />
    </svg>
  )
}

function TsFileIcon(): ReactNode {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <rect x="2.2" y="2" width="11.6" height="12" rx="2" />
      <path d="M5.2 6.2h3M6.7 6.2v4.3M9.2 9.9c.3.4.8.6 1.3.6.7 0 1.2-.4 1.2-.9 0-1.4-2.4-.8-2.4-2.2 0-.6.5-1 1.2-1 .4 0 .8.1 1.1.4" />
    </svg>
  )
}

/** 全屏切换（宿主 SidebarRight FullscreenGlyph / ExitFullscreenGlyph 的原样画法）。 */
function FullscreenIcon({ exit }: { exit: boolean }): ReactNode {
  return exit
    ? (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M9 2.5V6C9 6.26522 9.10536 6.51957 9.29289 6.70711C9.48043 6.89464 9.73478 7 10 7H13.5" />
        <path d="M7 13.5V10C7 9.73478 6.89464 9.48043 6.70711 9.29289C6.51957 9.10536 6.26522 9 6 9H2.5" />
      </svg>
    )
    : (
      <svg className="novel-moyu-svg-fill" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M2.33203 10.4054V13.1681C2.33229 13.444 2.55605 13.6681 2.83203 13.6681H5.49512V14.6681H2.83203C2.00376 14.6681 1.33229 13.9963 1.33203 13.1681V10.4054H2.33203ZM14.6689 13.1681C14.6687 13.996 13.9968 14.6676 13.1689 14.6681H10.4951V13.6681H13.1689C13.4445 13.6676 13.6687 13.4437 13.6689 13.1681V10.4054H14.6689V13.1681ZM13.1689 1.33118C13.9969 1.33163 14.6688 2.00315 14.6689 2.83118V5.4054H13.6689V2.83118C13.6688 2.55544 13.4446 2.33162 13.1689 2.33118H10.4951V1.33118H13.1689ZM5.49512 2.33118H2.83203C2.55598 2.33118 2.33218 2.55516 2.33203 2.83118V5.4054H1.33203V2.83118C1.33218 2.00288 1.55598 1.33118 2.83203 1.33118H5.49512Z" />
      </svg>
    )
}

function ContextRing({ pct }: { pct: number }): ReactNode {
  const circumference = 37.7
  const offset = circumference * (1 - Math.min(100, Math.max(0, pct)) / 100)
  return (
    <svg viewBox="0 0 14 14" aria-hidden="true">
      <circle className="novel-moyu-context-track" cx="7" cy="7" r="6" />
      <circle
        className="novel-moyu-context-fill"
        cx="7"
        cy="7"
        r="6"
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        transform="rotate(-90 7 7)"
      />
    </svg>
  )
}

function MoyuIllustration({ block, bookKey, t }: {
  block: Extract<MoyuTurnBlock, { kind: 'image' }>
  bookKey: string
  t: Translate
}): ReactNode {
  const [open, setOpen] = useState(false)
  const [failed, setFailed] = useState(false)
  const name = block.alt === '' ? block.resourceId : block.alt
  return (
    <div className="novel-moyu-illust-wrap">
      <button
        type="button"
        className="novel-moyu-illust-card"
        aria-expanded={open}
        aria-label={t('reader.moyu.image.folded', { name: block.resourceId })}
        onClick={() => setOpen((value) => !value)}
      >
        <span aria-hidden="true">📎</span>
        <span className="novel-moyu-illust-name">{name}</span>
        <span className="novel-moyu-illust-meta">
          {t('reader.moyu.image.meta', { w: block.width, h: block.height })}
          {' · '}
          {open ? t('reader.moyu.image.collapse') : t('reader.moyu.image.expand')}
        </span>
      </button>
      {open && (
        <div className="novel-moyu-illust-preview">
          {failed
            ? <span role="img" aria-label={t('reader.moyu.image.failed')}>{t('reader.moyu.image.failed')}</span>
            : <img src={resourceUrl(bookKey, block.resourceId)} alt={block.alt} onError={() => setFailed(true)} />}
          <div className="novel-moyu-illust-foot">
            <span>{block.alt}</span>
            <button type="button" className="novel-moyu-mini-btn" onClick={() => setOpen(false)}>
              {t('reader.moyu.image.collapse')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/** 复制动作（宿主 MessageIconActions 反馈口径：点后换对勾 + tooltip「复制成功」）。 */
function CopyActionButton({ label, copiedLabel, onCopy, className }: {
  label: string
  copiedLabel: string
  onCopy: () => void
  className: string
}): ReactNode {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1600)
    return () => window.clearTimeout(timer)
  }, [copied])
  return (
    <MoyuTooltip label={copied ? copiedLabel : label}>
      <button
        type="button"
        className={className}
        aria-label={copied ? copiedLabel : label}
        onClick={() => { onCopy(); setCopied(true) }}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </button>
    </MoyuTooltip>
  )
}

/** 过程披露行（宿主 ReasoningRow / ToolRow 的 24px 边框无线稿）。
 *  摘要带 fileLink（独立可点件）时外层只能是容器：交互控件互套既违反 DOM 内容模型，
 *  也让屏幕阅读器把两个动作读成一枚按钮。 */
function ProcessRow({ icon, title, summary, streaming = false, expandable = false, expanded = false, onToggle, onActivate, body, summaryAction, result }: {
  icon: ReactNode
  title: string
  summary: string
  streaming?: boolean
  expandable?: boolean
  expanded?: boolean
  onToggle?: () => void
  onActivate?: () => void
  body?: string
  /** 摘要走宿主 fileLink 形态（虚线下划线、独立按钮）；缺省即纯文本。 */
  summaryAction?: { label: string; onClick: () => void }
  /** 工具结果卡（整行点击展开/收起）。 */
  result?: ReactNode
}): ReactNode {
  const interactive = expandable || result !== undefined || onActivate !== undefined
  const activate = result !== undefined ? onToggle : expandable ? onToggle : onActivate
  const expandedAttr = expandable || result !== undefined ? expanded : undefined
  const leading = (
    <span className="novel-moyu-disclosure-leading">
      {expandable || result !== undefined ? (
        <>
          <span className="novel-moyu-disclosure-icon">{icon}</span>
          <span className="novel-moyu-disclosure-chevron"><ChevronDownIcon up={expanded} /></span>
        </>
      ) : icon}
    </span>
  )
  const titleNode = (
    <span
      className={streaming ? 'novel-moyu-disclosure-title novel-moyu-shimmer' : 'novel-moyu-disclosure-title'}
      data-active={streaming ? 'true' : 'false'}
    >
      {title}
    </span>
  )
  const summaryNode = summary === '' && summaryAction === undefined ? null : (
    <>
      <span className="novel-moyu-disclosure-sep" aria-hidden="true" />
      {summaryAction === undefined ? (
        <span
          className={`novel-moyu-disclosure-summary${streaming ? ' is-streaming' : ''}${streaming ? ' novel-moyu-shimmer' : ''}`}
          data-active={streaming ? 'true' : 'false'}
        >
          {summary}
        </span>
      ) : (
        <span className={`novel-moyu-disclosure-summary${streaming ? ' is-streaming' : ''}`}>
          <button type="button" className="novel-moyu-file-link" onClick={summaryAction.onClick}>
            {summaryAction.label}
          </button>
        </span>
      )}
    </>
  )
  return (
    <div className="novel-moyu-disclosure" data-open={expanded && (result !== undefined || body !== undefined) ? '' : undefined}>
      {summaryAction !== undefined || !interactive ? (
        <div className="novel-moyu-disclosure-line" data-expandable={summaryAction !== undefined ? 'true' : 'false'} data-expanded={expanded ? 'true' : 'false'}>
          {interactive ? (
            <button
              type="button"
              className="novel-moyu-disclosure-toggle"
              aria-expanded={expandedAttr}
              onClick={activate}
            >
              {leading}
              {titleNode}
            </button>
          ) : (
            <>
              {leading}
              {titleNode}
            </>
          )}
          {summaryNode}
        </div>
      ) : (
        <button
          type="button"
          className="novel-moyu-disclosure-line"
          data-expandable={expandable || result !== undefined ? 'true' : 'false'}
          data-expanded={expanded ? 'true' : 'false'}
          aria-expanded={expandedAttr}
          onClick={activate}
        >
          {leading}
          {titleNode}
          {summaryNode}
        </button>
      )}
      {result !== undefined && expanded && result}
      {expandable && expanded && body !== undefined && <div className="novel-moyu-think-body">{body}</div>}
    </div>
  )
}

interface VisibleBlock {
  block: MoyuTurnBlock
  text: string
}

/** 按揭示预算切块：段落可半截、图片/链接只在已揭示到它位置时出现（与旧链路口径一致）。 */
function visibleBlocksOf(blocks: readonly MoyuTurnBlock[], lengths: readonly (number | null)[], revealed: number, full: boolean): VisibleBlock[] {
  if (full) return blocks.map((block) => ({ block, text: block.kind === 'paragraph' ? block.text : '' }))
  const out: VisibleBlock[] = []
  let consumed = 0
  for (const [index, block] of blocks.entries()) {
    if (block.kind === 'paragraph') {
      if (revealed <= consumed) break
      const length = lengths[index] ?? 0
      const remaining = revealed - consumed
      const text = remaining >= length ? block.text : Array.from(block.text).slice(0, remaining).join('')
      out.push({ block, text })
      consumed += remaining >= length ? length : remaining
      if (remaining < length) break
      continue
    }
    if (revealed <= consumed) break
    out.push({ block, text: '' })
  }
  return out
}

const INTERLEAVED_STEPS = ['search', 'think', 'read'] as const

/** 固定定位的菜单面（宿主菜单面形态：锚下 4px、左锚、z1100、方向键 + Esc 还焦）。 */
function MoyuMenu({ open, anchor, placement = 'below', role = 'menu', ariaLabel, onClose, children }: {
  open: boolean
  anchor: { left: number; top: number; bottom: number } | null
  placement?: 'below' | 'above'
  role?: 'menu' | 'listbox'
  ariaLabel: string
  onClose: () => void
  children: ReactNode
}): ReactNode {
  const surfaceRef = useRef<HTMLDivElement | null>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    if (!open) return
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const onPointerDown = (event: MouseEvent): void => {
      const target = event.target
      if (target instanceof Node && surfaceRef.current?.contains(target) === true) return
      onCloseRef.current()
    }
    document.addEventListener('mousedown', onPointerDown)
    const first = surfaceRef.current?.querySelector<HTMLButtonElement>('button:not([disabled])')
    first?.focus()
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      returnFocusRef.current?.focus()
    }
  }, [open])

  if (!open || anchor === null) return null
  /** below：从锚底向下铺；above：以锚顶为底边向上铺——不预量高度，`bottom` 让盒自己往上长。 */
  const viewportHeight = typeof window === 'undefined' ? 0 : window.innerHeight
  const style = placement === 'below'
    ? { left: Math.round(anchor.left), top: Math.round(anchor.bottom + 4) }
    : { left: Math.round(anchor.left), bottom: Math.round(viewportHeight - anchor.top + 4) }
  return (
    <div
      ref={surfaceRef}
      className="novel-moyu-menu-surface"
      role={role}
      aria-label={ariaLabel}
      style={style}
      onKeyDown={(event) => {
        const items = [...(surfaceRef.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? [])]
        const index = items.indexOf(document.activeElement as HTMLButtonElement)
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          items[(index + 1) % items.length]?.focus()
        } else if (event.key === 'ArrowUp') {
          event.preventDefault()
          items[(index - 1 + items.length) % items.length]?.focus()
        } else if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          onClose()
        } else if (event.key === 'Home') {
          event.preventDefault()
          items[0]?.focus()
        } else if (event.key === 'End') {
          event.preventDefault()
          items.at(-1)?.focus()
        }
      }}
    >
      {children}
    </div>
  )
}

function anchorRectOf(element: HTMLElement | null): { left: number; top: number; bottom: number } | null {
  if (element === null) return null
  const rect = element.getBoundingClientRect()
  return { left: rect.left, top: rect.top, bottom: rect.bottom }
}

/** 千/万缩写（带 ~ 的估算读数；「万」档按万进位、k/M 档按百万进位，档位跟着单位符号走）。 */
function formatTok(value: number, t: Translate): string {
  const scaled = (candidate: number): string =>
    candidate >= 100 ? String(Math.round(candidate)) : String(Math.round(candidate * 10) / 10)
  if (value < 1_000) return String(value)
  const scale = Number(t('reader.moyu.unit.wScale'))
  const big = Number.isFinite(scale) && scale > 0 ? scale : 10_000
  if (value < big) return `${scaled(value / 1_000)}${t('reader.moyu.unit.k')}`
  return `${scaled(value / big)}${t('reader.moyu.unit.w')}`
}

interface MoyuChip {
  id: string
  kind: 'command' | 'reference'
  label: string
}

/** 一枚文档预览 tab：README.md 或某一章的伪装文件（D1+D2 的 tab 体系）。 */
interface PreviewTab {
  id: string
  kind: 'readme' | 'chapter'
  chapterIndex: number
}

/** 坞宽（D9）：min 300、初始 320，拖拽/键盘调完落 localStorage。 */
const DOCK_WIDTH_MIN = 300
const DOCK_WIDTH_DEFAULT = 320
const DOCK_WIDTH_STEP = 20
const DOCK_WIDTH_KEY = 'novel.moyu.dockWidth'

function initialDockWidth(): number {
  try {
    const stored = Number(globalThis.localStorage.getItem(DOCK_WIDTH_KEY))
    return Number.isFinite(stored) && stored >= DOCK_WIDTH_MIN ? stored : DOCK_WIDTH_DEFAULT
  } catch {
    return DOCK_WIDTH_DEFAULT
  }
}

interface MoyuNotice {
  id: string
  text: string
}

export function MoyuStage(props: MoyuStageProps): ReactNode {
  const {
    session, bookKey, title, state, prefs, scene, sceneState, listen,
    importNotesCount, onOpenExport, onListen, onClose, onNavigate, onTtsError, apiGet, overlays, defaultDockOpen,
  } = props
  const t = useCopy()
  const tts = useStore(ttsPlayer)
  const currentChapter = state.currentChapter
  const toc = state.toc
  const currentContent = state.chapters[currentChapter] ?? null
  /** 章轮投影成品（每章只提取一次）：阅读会话的滚动窗口会把视口后方的章裁成 null，
   *  对话流是「读过的轮次」不能因裁章退化——按内容对象缓存，被裁的格留最后一次投影。
   *  换书时两本缓存都清空（不串书）。 */
  const projectionCacheRef = useRef(new Map<number, TurnProjection>())
  const projectionByContentRef = useRef<WeakMap<ChapterContent, TurnProjection>>(new WeakMap())
  const projectionBookRef = useRef(bookKey)
  const turnProjections = useMemo<TurnProjection[]>(() => {
    if (projectionBookRef.current !== bookKey) {
      projectionBookRef.current = bookKey
      projectionCacheRef.current.clear()
      projectionByContentRef.current = new WeakMap()
    }
    return state.chapters.map((content, index) => {
      if (content === null) return projectionCacheRef.current.get(index) ?? EMPTY_PROJECTION
      const cached = projectionByContentRef.current.get(content)
      if (cached !== undefined) {
        projectionCacheRef.current.set(index, cached)
        return cached
      }
      const projected = extractMoyuTurnBlocks(content)
      let total = 0
      let paragraphCount = 0
      const lengths = projected.map((block) => {
        if (block.kind !== 'paragraph') return null
        paragraphCount += 1
        const length = Array.from(block.text).length
        total += length
        return length
      })
      const projection = { blocks: projected, lengths, paragraphCount, total }
      projectionByContentRef.current.set(content, projection)
      projectionCacheRef.current.set(index, projection)
      return projection
    })
  }, [state.chapters, bookKey])
  const currentProjection = turnProjections[currentChapter] ?? EMPTY_PROJECTION
  const totalChars = currentProjection.total
  const [turns, setTurns] = useState<number[]>([])
  /** 章轮次进入会话流的真实时刻（交错键：镜像轮用宿主真时刻、章轮用入场时刻，同轴按时间归并）。 */
  const turnEntryRef = useRef(new Map<number, number>())
  const [visited, setVisited] = useState<Set<number>>(() => new Set())
  const [historyBookKey, setHistoryBookKey] = useState<string | null>(null)
  const [revealed, setRevealed] = useState(0)
  const [streaming, setStreaming] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [menu, setMenu] = useState<'more' | 'views' | 'command' | 'reference' | 'model' | 'context' | 'workspace' | null>(null)
  /** 文档预览 tab（D1+D2）：README 与章节文件各开一枚；'files' 是「文件」tab 本体。 */
  const [previewTabs, setPreviewTabs] = useState<PreviewTab[]>([])
  const [activeDockTab, setActiveDockTab] = useState<string>('files')
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchSettingsOpen, setSearchSettingsOpen] = useState(false)
  const [searchScope, setSearchScope] = useState<'name' | 'nameBody'>('name')
  const [hideVisited, setHideVisited] = useState(false)
  const [filter, setFilter] = useState('')
  const [dockOpen, setDockOpen] = useState(() => defaultDockOpen ?? (typeof window === 'undefined' || window.innerWidth >= 768))
  const [dockFullscreen, setDockFullscreen] = useState(false)
  const [dockWidth, setDockWidth] = useState(initialDockWidth)
  const [chaptersOpen, setChaptersOpen] = useState(true)
  const [activeTab, setActiveTab] = useState<'chat' | 'trajectory'>('chat')
  const [trajQuery, setTrajQuery] = useState('')
  const [trajFolded, setTrajFolded] = useState<Set<number>>(() => new Set())
  const [trajSelected, setTrajSelected] = useState<number | null>(null)
  const [listenPanelOpen, setListenPanelOpen] = useState(false)
  const [showToBottom, setShowToBottom] = useState(false)
  const [treeRevision, setTreeRevision] = useState(0)
  const [foldedTurns, setFoldedTurns] = useState<Set<number>>(() => new Set())
  const [expandedThinking, setExpandedThinking] = useState<Set<number>>(() => new Set())
  const [openResults, setOpenResults] = useState<Set<number>>(() => new Set())
  /** 镜像轮的思考行展开态（按行 key 寻址；镜像行没有章序）。 */
  const [openMirrorRows, setOpenMirrorRows] = useState<Set<string>>(() => new Set())
  const [collapsedGroups, setCollapsedGroups] = useState<Set<number>>(() => new Set())
  const [draft, setDraft] = useState('')
  const [promptOverrides, setPromptOverrides] = useState<ReadonlyMap<number, string>>(() => new Map())
  const [chips, setChips] = useState<MoyuChip[]>([])
  const [notices, setNotices] = useState<MoyuNotice[]>([])
  const [toast, setToast] = useState<string | null>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const [stageRect, setStageRect] = useState<MoyuStageRect | null>(null)
  const conversationRef = useRef<HTMLDivElement | null>(null)
  const treeRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const moreBtnRef = useRef<HTMLButtonElement | null>(null)
  const viewsBtnRef = useRef<HTMLButtonElement | null>(null)
  const commandBtnRef = useRef<HTMLButtonElement | null>(null)
  const modelBtnRef = useRef<HTMLButtonElement | null>(null)
  const searchSettingsBtnRef = useRef<HTMLButtonElement | null>(null)
  const contextBtnRef = useRef<HTMLButtonElement | null>(null)
  const workspaceBtnRef = useRef<HTMLButtonElement | null>(null)
  const streamStartRef = useRef(Date.now())
  /** 假时钟（③a）：屏幕上的时刻全从这里出，不读系统真钟——理由见 moyu-clock.ts。 */
  const clockRef = useRef(new MoyuClock())
  /** 各轮真实揭示耗时（秒）：完成即记，供轨迹指标 / tps / 轮尾消息时刻取数。 */
  const revealSecondsRef = useRef(new Map<number, number>())
  /** 坞宽拖拽现场（D9）。 */
  const dockDragRef = useRef<{ x: number; width: number } | null>(null)
  const lastListenChapterRef = useRef<number | null>(null)
  const pendingScrollTurnRef = useRef<number | null>(null)
  const escStopRef = useRef(new EscStopSequence())
  const uiRef = useRef({ menu, detailOpen: false, previewOpen: false, searchOpen, filter, streaming, sceneState })
  uiRef.current = {
    menu,
    detailOpen: trajSelected !== null && activeTab === 'trajectory',
    previewOpen: dockOpen && activeDockTab !== 'files',
    searchOpen, filter, streaming, sceneState,
  }

  // 听书条读数全走 listen-readout 的成品（I13 功能全留：段读数 / 语速 / 定时 / 段滑杆）。
  const listenFace = listenFaceOf(tts)
  const listenTimer = useTimerReadout(tts, t)
  const listenSources = useTtsSources(listenPanelOpen, apiGet, (message: string) => onTtsError(new Error(message)))
  // 工作区入口的服务层：宿主公开面缺席＝整组功能隐藏，不炸面板（降级留痕见 moyu-host.ts 各分支）。
  // 活口对象按引用变（useStoreValue 只收原语），整店订阅即可——这店极少写。
  const hostPort = useStore(moyuHostStore).port
  const workspace = useStore(moyuWorkspaceStore)
  /** 真轮次镜像（只读）：宿主真会话的轮次投影，与章轮次按真实进入时刻交错（见 renderMirrorTurn）。 */
  const mirror = useStore(moyuMirrorStore)
  useEffect(() => {
    if (hostPort === null) return
    return refreshMoyuWorkspaces(hostPort)
  }, [hostPort])

  const setStageNode = useCallback((node: HTMLDivElement | null): void => {
    stageRef.current = node
    setStageRect(node === null ? null : measureMoyuStageRect(node))
  }, [])

  useEffect(() => {
    const update = (): void => setStageRect(stageRef.current === null ? null : measureMoyuStageRect(stageRef.current))
    const port = stageRef.current?.closest<HTMLElement>('[data-novel-main]') ?? null
    const observer = typeof ResizeObserver === 'undefined' || port === null ? null : new ResizeObserver(update)
    if (port !== null) observer?.observe(port)
    window.addEventListener('resize', update)
    return () => {
      window.removeEventListener('resize', update)
      observer?.disconnect()
    }
  }, [])

  /** 一层 Esc 只收一层；层序表见 escLayerOf（菜单 → 事件详情 → 预览 tab → 文件搜索 → 退舞台）。 */
  const handleStageEsc = (): void => {
    const ui = uiRef.current
    if (ui.sceneState.surface !== null || ui.sceneState.askShelf) return
    const action = escLayerOf({
      menuOpen: ui.menu !== null,
      detailOpen: ui.detailOpen,
      previewOpen: ui.previewOpen,
      searchOpen: ui.searchOpen,
      filter: ui.filter,
    })
    if (action === 'menu') {
      setMenu(null)
      return
    }
    if (action === 'detail') {
      setTrajSelected(null)
      return
    }
    if (action === 'preview') {
      setActiveDockTab('files')
      return
    }
    if (action === 'search-clear') {
      setFilter('')
      return
    }
    if (action === 'search-close') {
      setSearchOpen(false)
      treeRef.current?.focus()
      return
    }
    onClose()
  }
  useDialogContract({ panelRef: stageRef, onClose: handleStageEsc })

  useEffect(() => {
    if (historyBookKey !== null && historyBookKey !== bookKey) {
      setTurns([])
      turnEntryRef.current = new Map()
      setVisited(new Set())
      setFoldedTurns(new Set())
      setExpandedThinking(new Set())
      setOpenResults(new Set())
      setPromptOverrides(new Map())
      setHistoryBookKey(null)
      return
    }
    if (toc === null || (currentContent === null && state.error === null)) return
    if (historyBookKey !== bookKey) {
      setTurns([currentChapter])
      turnEntryRef.current = new Map([[currentChapter, Date.now()]])
      setVisited(new Set([currentChapter]))
      setHistoryBookKey(bookKey)
      return
    }
    if (!turnEntryRef.current.has(currentChapter)) turnEntryRef.current.set(currentChapter, Date.now())
    setVisited((prev) => prev.has(currentChapter) ? prev : new Set(prev).add(currentChapter))
    setTurns((prev) => prev.includes(currentChapter) ? prev : [...prev, currentChapter])
  }, [bookKey, currentChapter, toc, currentContent, state.error, historyBookKey])

  useIsomorphicLayoutEffect(() => {
    streamStartRef.current = Date.now()
    setElapsed(0)
    setRevealed(0)
    setStreaming(prefs.moyuReveal === 'stream' && totalChars > 0)
    if (prefs.moyuReveal === 'instant') setRevealed(totalChars)
  }, [currentChapter, totalChars, prefs.moyuReveal])

  useEffect(() => {
    if (!streaming) return
    const timer = window.setInterval(() => {
      setRevealed((value) => Math.min(totalChars, value + MOYU_TICK_CHARS))
    }, MOYU_TICK_MS)
    return () => window.clearInterval(timer)
  }, [streaming, totalChars])

  useEffect(() => {
    if (streaming && revealed >= totalChars) setStreaming(false)
  }, [streaming, revealed, totalChars])

  useEffect(() => {
    if (!streaming) return
    const timer = window.setInterval(() => {
      setElapsed(Math.max(1, Math.floor((Date.now() - streamStartRef.current) / 1000)))
    }, 500)
    return () => window.clearInterval(timer)
  }, [streaming])

  useEffect(() => {
    if (streaming) return
    if (revealed < totalChars) return
    // 揭示完成即把真实耗时记进台账（轨迹指标 / tps / 轮尾消息时刻共用这一份读数）。
    revealSecondsRef.current.set(currentChapter, Math.max(1, Math.round((Date.now() - streamStartRef.current) / 1000)))
    setElapsed((value) => value > 0 ? value : Math.max(1, Math.round((Date.now() - streamStartRef.current) / 1000)))
  }, [streaming, revealed, totalChars, currentChapter])

  useEffect(() => {
    if (!listen.showing) {
      lastListenChapterRef.current = null
      return
    }
    const previous = lastListenChapterRef.current
    lastListenChapterRef.current = listen.chapterIndex
    if (previous !== null && previous !== listen.chapterIndex && listen.chapterIndex !== currentChapter) {
      pendingScrollTurnRef.current = listen.chapterIndex
      session.requestJump(listen.chapterIndex)
    }
  }, [listen.showing, listen.chapterIndex, currentChapter, session])

  const completeReveal = useCallback(() => {
    setRevealed(totalChars)
    setStreaming(false)
    const seconds = Math.max(1, Math.round((Date.now() - streamStartRef.current) / 1000))
    revealSecondsRef.current.set(currentChapter, seconds)
    setElapsed(seconds)
  }, [totalChars, currentChapter])

  /** Space 补完（保留、不上屏）。 */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== ' ' || !uiRef.current.streaming) return
      const target = event.target
      const tag = target instanceof HTMLElement ? target.tagName : ''
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'BUTTON' || tag === 'SELECT') return
      event.preventDefault()
      event.stopPropagation()
      completeReveal()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [completeReveal])

  /** I12 双轨：双击 Esc＝停止生成（补完当前章），仅流式中认；单击仍走逐层收起。 */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.repeat) return
      if (escStopRef.current.press(performance.now(), uiRef.current.streaming)) completeReveal()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [completeReveal])

  useEffect(() => {
    if (toast === null) return
    const timer = window.setTimeout(() => setToast(null), 4000)
    return () => window.clearTimeout(timer)
  }, [toast])

  const jump = useCallback((index: number): void => {
    if (toc === null || index < 0 || index >= toc.length || index === currentChapter) return
    pendingScrollTurnRef.current = index
    session.requestJump(index)
    setActiveTab('chat')
  }, [toc, currentChapter, session])

  /** 开（或聚焦）一枚文档预览 tab（D1+D2）：文件行 / M12 fileLink / 「＋」都走这一个入口。 */
  const openPreviewTab = (kind: 'readme' | 'chapter', chapterIndex: number): void => {
    setDockOpen(true)
    const id = kind === 'readme' ? 'readme' : `c-${chapterIndex}`
    setPreviewTabs((prev) => prev.some((tab) => tab.id === id) ? prev : [...prev, { id, kind, chapterIndex }])
    setActiveDockTab(id)
  }

  /** 预览 tab 的 ×＝关该 tab（激活回「文件」tab）；「文件」tab 的 ×＝收起文件坞。 */
  const closePreviewTab = (id: string): void => {
    setPreviewTabs((prev) => prev.filter((tab) => tab.id !== id))
    setActiveDockTab((current) => (current === id ? 'files' : current))
  }

  /** 预览内的「在阅读器打开」＝D12 拍板的 open-in-app 映射：在正常阅读视图打开该章（离开摸鱼台）。 */
  const openInReader = (index: number): void => {
    session.requestJump(index)
    onClose()
  }

  useEffect(() => {
    const target = pendingScrollTurnRef.current
    if (target === null) return
    const frame = window.requestAnimationFrame(() => {
      const container = conversationRef.current
      const node = container?.querySelector<HTMLElement>(`[data-turn-index="${target}"]`) ?? null
      if (container !== null && node !== null) {
        const top = node.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop
        container.scrollTop = top
        setShowToBottom(!isPinnedToTail(container))
      }
      pendingScrollTurnRef.current = null
    })
    return () => window.cancelAnimationFrame(frame)
  }, [turns, currentChapter, activeTab])

  useEffect(() => {
    const node = conversationRef.current
    if (node !== null) setShowToBottom(!isPinnedToTail(node))
  }, [revealed, turns, currentChapter, activeTab])

  /** 切章时树自动滚到当前行（D13④ 的自动跟随；原「定位当前章」钮已移除）。 */
  useEffect(() => {
    if (!dockOpen) return
    const frame = window.requestAnimationFrame(() => {
      const tree = treeRef.current
      const row = tree?.querySelector<HTMLElement>(`[data-chapter-file="${currentChapter}"]`)
      if (tree !== null && row !== null && row !== undefined) {
        const top = row.getBoundingClientRect().top - tree.getBoundingClientRect().top + tree.scrollTop
        tree.scrollTop = Math.max(0, top - tree.clientHeight / 2)
      }
    })
    return () => window.cancelAnimationFrame(frame)
  }, [currentChapter, dockOpen, treeRevision])

  const locateCurrent = (): void => {
    const tree = treeRef.current
    const row = tree?.querySelector<HTMLElement>(`[data-chapter-file="${currentChapter}"]`)
    if (tree !== null && row !== null && row !== undefined) {
      const top = row.getBoundingClientRect().top - tree.getBoundingClientRect().top + tree.scrollTop
      tree.scrollTop = Math.max(0, top - tree.clientHeight / 2)
    }
  }

  const onConversationScroll = (): void => {
    const node = conversationRef.current
    if (node !== null) setShowToBottom(!isPinnedToTail(node))
  }

  const scrollToBottom = (): void => {
    const node = conversationRef.current
    if (node === null) return
    node.scrollTop = node.scrollHeight
    setShowToBottom(false)
  }

  /** 「定位到正在念的段」：滚到跟读高亮的那段（摸鱼台里正文即对话流）。 */
  const locateLiveParagraph = (): void => {
    const node = conversationRef.current?.querySelector<HTMLElement>('.novel-moyu-p.is-tts-live')
    if (node === null || node === undefined) return
    if (typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'center' })
    else node.parentElement?.scrollIntoView({ block: 'center' })
  }

  /** 听书错误既上报又落 Toast（I18 的 Toast 形态挂真实产者）。 */
  const reportTtsError = (cause: unknown): void => {
    onTtsError(cause)
    setToast(cause instanceof Error ? cause.message : String(cause))
  }

  /** 唯一提交点：草稿提交＝沉成本轮用户气泡并进下一章（摸鱼原语义）。
   *  **不代发宿主任务**：工作区入口在 chip 菜单里（`openWorkspaceSession`），输入框的
   *  Enter 在任何状态下都只做阅读动作——插件不替用户产生宿主轮次（`ADR-0108`）。 */
  const submitComposer = (): void => {
    if (streaming) {
      completeReveal()
      return
    }
    const text = draft.trim()
    if (text !== '') {
      const override = text
      setPromptOverrides((prev) => new Map(prev).set(currentChapter, override))
      setDraft('')
    }
    jump(currentChapter + 1)
  }

  /** 工作区入口：在宿主里开/切一个会话并带到前台；此后由用户自己在宿主界面里使用。
   *  失败只留一条 Toast（宿主原文），不改阅读现场。 */
  const openWorkspaceSession = (option: MoyuWorkspaceOption): void => {
    if (hostPort === null) return
    bindMoyuWorkspace(option.workspaceId)
    setMenu(null)
    void openMoyuWorkspaceSession(hostPort, { bookKey, workspaceId: option.workspaceId }, t)
      .then((outcome) => {
        setToast(outcome.message !== null
          ? t('reader.moyu.workspace.openFailed', { message: outcome.message })
          : t('reader.moyu.workspace.opened', { title: option.title }))
      })
      .catch((cause: unknown) => {
        setToast(t('reader.moyu.workspace.openFailed', { message: cause instanceof Error ? cause.message : String(cause) }))
      })
  }

  const phase = nextPhase(revealed, totalChars, toc !== null && currentChapter === toc.length - 1)
  const turnsCount = turns.length
  const stepsCount = turnsCount * 3
  /* ③b/c 统计读数：tok＝字数×~0.65、缓存％按章序 45%→75%、tps＝tok÷揭示真实耗时——
     全部从真阅读数据折算（详见 moyu-metrics.ts），不读墙钟。 */
  const revealSeconds = revealSecondsRef.current.get(currentChapter) ?? Math.max(1, elapsed)
  const usageTok = tokOf(totalChars)
  const tps = tokensPerSecondOf(usageTok, revealSeconds)
  const cacheHit = cacheHitPercentOf(currentChapter, Math.max(1, toc?.length ?? 1))
  const chapterChars = turnProjections.map((projection) => projection.total)
  const contextUsed = chapterChars[currentChapter] ?? 0
  const contextHistory = [...visited].reduce((sum, index) => index === currentChapter ? sum : sum + (chapterChars[index] ?? 0), 0)
  const contextToc = (toc?.length ?? 0) * 20
  const contextBody = Math.ceil(contextUsed / 2)
  const contextHistoryTok = Math.ceil(contextHistory / 2)
  const contextTotalTok = Math.ceil(chapterChars.reduce((sum, value) => sum + value, 0) / 2) + contextToc
  const contextUsedTok = contextBody + contextHistoryTok + contextToc
  const pct = contextTotalTok === 0 ? 0 : Math.min(100, Math.round((contextUsedTok / contextTotalTok) * 100))

  const filteredChapters = useMemo(() => {
    const query = filter.trim().toLowerCase()
    return toc?.map((entry, index) => ({ entry, index })).filter(({ entry, index }) => {
      if (hideVisited && visited.has(index) && index !== currentChapter) return false
      if (query === '') return true
      const name = chapterFileName(index, entry.name)
      if (name.toLowerCase().includes(query) || entry.name.includes(filter.trim())) return true
      if (searchScope === 'nameBody') {
        // 读缓存投影而不是 raw chapters：裁章后旧章正文仍可搜（与对话流同一份成品）。
        const text = (turnProjections[index]?.blocks ?? [])
          .flatMap((block) => block.kind === 'paragraph' ? [block.text] : [])
          .join('\n')
        return text.toLowerCase().includes(query)
      }
      return false
    }) ?? []
  }, [toc, filter, hideVisited, visited, currentChapter, searchScope, turnProjections])

  const toggleFolded = (turnIndex: number): void => {
    setFoldedTurns((prev) => {
      const next = new Set(prev)
      if (next.has(turnIndex)) next.delete(turnIndex)
      else next.add(turnIndex)
      return next
    })
  }

  const toggleGroup = (turnIndex: number): void => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(turnIndex)) next.delete(turnIndex)
      else next.add(turnIndex)
      return next
    })
  }

  const toggleThinking = (turnIndex: number): void => {
    setExpandedThinking((prev) => {
      const next = new Set(prev)
      if (next.has(turnIndex)) next.delete(turnIndex)
      else next.add(turnIndex)
      return next
    })
  }

  const toggleResult = (turnIndex: number): void => {
    setOpenResults((prev) => {
      const next = new Set(prev)
      if (next.has(turnIndex)) next.delete(turnIndex)
      else next.add(turnIndex)
      return next
    })
  }

  const toggleMirrorRow = (key: string): void => {
    setOpenMirrorRows((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const renderBlock = (block: MoyuTurnBlock, text: string, paragraphOrdinal: number, live: boolean, ttsLive: boolean): ReactNode => {
    if (block.kind === 'paragraph') {
      const compact = prefs.moyuStyle === 'compact' && !isMainLine(paragraphOrdinal)
      let remaining = Array.from(text).length
      const content = block.segments === undefined ? text : block.segments.map((segment, index) => {
        const units = Array.from(segment.text)
        const shown = remaining <= 0 ? '' : remaining >= units.length ? segment.text : units.slice(0, remaining).join('')
        remaining -= Math.min(remaining, units.length)
        if (shown === '') return null
        if (segment.kind === 'text') return <span key={`s-${index}`}>{shown}</span>
        if (shown !== segment.text) return <span key={`s-${index}`}>{shown}</span>
        return (
          <button key={`s-${index}`} type="button" className="novel-moyu-link" onClick={() => onNavigate(segment.target, segment.role)}>
            {shown}
          </button>
        )
      })
      return (
        <p
          key={`p-${block.nodeId ?? block.paragraphIndex}`}
          className={[
            'novel-moyu-p',
            compact ? 'is-small' : '',
            live ? 'is-live' : '',
            ttsLive ? 'is-tts-live' : '',
          ].filter(Boolean).join(' ')}
          data-pidx={block.paragraphIndex}
        >
          {compact && <span className="novel-moyu-mark" aria-hidden="true">{actionMarkFor(paragraphOrdinal)}</span>}
          {content}
        </p>
      )
    }
    if (block.kind === 'image') return <MoyuIllustration key={`i-${block.nodeId}`} block={block} bookKey={bookKey} t={t} />
    return (
      <button key={`l-${block.nodeId}`} type="button" className="novel-moyu-link" onClick={() => onNavigate(block.target, block.role)}>
        {block.text}
      </button>
    )
  }

  const renderTurn = (turnIndex: number): ReactNode => {
    const content = state.chapters[turnIndex]
    const isCurrent = turnIndex === currentChapter
    const turnError = isCurrent ? state.error : null
    const errored = turnError !== null
    const live = isCurrent && streaming && !errored
    const closed = !live
    const folded = foldedTurns.has(turnIndex)
    const groupOpen = !collapsedGroups.has(turnIndex)
    const openThinking = expandedThinking.has(turnIndex)
    const openResult = openResults.has(turnIndex)
    const tocName = toc?.[turnIndex]?.name ?? ''
    const file = moyuChapterPath(turnIndex, tocName)
    const projection = turnProjections[turnIndex] ?? EMPTY_PROJECTION
    const chars = projection.total
    const seconds = isCurrent ? Math.max(1, elapsed) : Math.max(1, Math.round(chars / 86))
    const paragraphStarts = projection.blocks.flatMap((block) => block.kind === 'paragraph' ? [block.paragraphIndex] : [])
    const liveOrdinal = listen.showing && listen.chapterIndex === turnIndex
      ? paragraphSlotOf(paragraphStarts, listen.paragraphIndex)
      : -1
    const prompt = promptOverrides.get(turnIndex) ?? t('reader.moyu.userPrompt', { file })
    const copyPrompt = (): void => copyText(prompt)
    // 假时钟读数（③a）：用户行 = 该轮提示时刻，轮尾 = 消息时刻（提示 + 揭示耗时）。
    const clockMark = clockRef.current.mark(turnIndex, Date.now(), Math.max(1, seconds) * 1000)
    const turnLabel = errored
      ? { text: t('reader.moyu.turn.failed'), parts: [] as DurationPart[] }
      : chars === 0
        ? { text: t('reader.moyu.turn.worked'), parts: [] as DurationPart[] }
        : { text: t('reader.moyu.turn.took'), parts: durationParts(seconds, t) }
    // M4：第三列是 `<code>` 错误码芯片（宿主 turnErrorRow 口径），「重试」钮删除。
    const errorRow = turnError !== null ? (
      <div className="novel-moyu-error-row" role="status">
        <span className="novel-moyu-error-dot" aria-hidden="true" />
        <div className="novel-moyu-error-copy">
          <span className="novel-moyu-error-title">{t('reader.moyu.error.title')}</span>
          <span className="novel-moyu-error-msg">{turnError.message}</span>
        </div>
        <code className="novel-moyu-error-code">{errorCodeOf(turnError.code)}</code>
      </div>
    ) : null

    if (projection.blocks.length === 0 && (content === null || content === undefined)) {
      return (
        <section className="novel-moyu-turn" key={turnIndex} data-turn-index={turnIndex}>
          <div className="novel-moyu-user-row">
            <div className="novel-moyu-user-stack">
              <div className="novel-moyu-user-bubble">{prompt}</div>
            </div>
            <div className="novel-moyu-user-actions">
              <span className="novel-moyu-user-time">{clockRef.current.format(clockMark.promptAt, t)}</span>
              <CopyActionButton
                className="novel-moyu-msg-action"
                label={t('reader.moyu.copy')}
                copiedLabel={t('reader.moyu.copied')}
                onCopy={copyPrompt}
              />
            </div>
          </div>
          {errorRow}
        </section>
      )
    }

    const full = turnIndex !== currentChapter || prefs.moyuReveal === 'instant' || !streaming
    const visible = visibleBlocksOf(projection.blocks, projection.lengths, full ? chars : revealed, full)
    const lastParagraph = visible.map((entry, index) => entry.block.kind === 'paragraph' ? index : -1)
      .filter((index) => index >= 0).at(-1) ?? -1
    const body: ReactNode[] = []
    let paragraphOrdinal = 0
    for (const [blockIndex, entry] of visible.entries()) {
      const block = entry.block
      if (block.kind !== 'paragraph') {
        body.push(renderBlock(block, '', paragraphOrdinal, false, false))
        continue
      }
      if (prefs.moyuStyle === 'dsh' && paragraphOrdinal > 0 && paragraphOrdinal % 5 === 0) {
        const step = INTERLEAVED_STEPS[(Math.floor(paragraphOrdinal / 5) - 1) % INTERLEAVED_STEPS.length] ?? 'search'
        const lineStart = paragraphOrdinal * 24 + 1
        const stepRow = step === 'search'
          ? { icon: <SearchIcon />, title: t('reader.moyu.process.search'), summary: t('reader.moyu.process.searchSummary') }
          : step === 'think'
            ? { icon: <ThinkIcon />, title: t('reader.moyu.process.think'), summary: t('reader.moyu.process.thinkSummary') }
            : { icon: <FileReadIcon />, title: t('reader.moyu.process.read'), summary: `${file} · ${t('reader.moyu.process.readSummary', { from: lineStart, to: lineStart + 23 })}` }
        body.push(
          <ProcessRow
            key={`mid-${turnIndex}-${paragraphOrdinal}`}
            icon={stepRow.icon}
            title={stepRow.title}
            summary={stepRow.summary}
          />,
        )
      }
      if (prefs.moyuStyle === 'clean' && paragraphOrdinal % 4 === 0) {
        const section = Math.floor(paragraphOrdinal / 4) + 1
        body.push(
          <div className="novel-moyu-h4" key={`clean-${turnIndex}-${paragraphOrdinal}`}>
            <span>{t('reader.moyu.clean.heading', { n: section })}</span>
            <span className="novel-moyu-inline-code">{t('reader.moyu.clean.segment', { n: section })}</span>
          </div>,
        )
      }
      body.push(renderBlock(block, entry.text, paragraphOrdinal, live && blockIndex === lastParagraph, liveOrdinal === paragraphOrdinal))
      paragraphOrdinal += 1
    }

    const copyChapter = (): void => {
      copyText(projection.blocks.flatMap((block) => block.kind === 'paragraph' ? [block.text] : []).join('\n\n'))
    }
    const groupLabel = live
      ? `${t('reader.moyu.step.read.running')}${t('reader.moyu.step.separator')}${file}`
      : processTitleOf(['think', 'read'], t)
    return (
      <section className="novel-moyu-turn" key={turnIndex} data-turn-index={turnIndex}>
        <div className="novel-moyu-user-row">
          <div className="novel-moyu-user-stack">
            <div className="novel-moyu-user-bubble">{prompt}</div>
          </div>
          <div className="novel-moyu-user-actions">
            <span className="novel-moyu-user-time">{clockRef.current.format(clockMark.promptAt, t)}</span>
            <CopyActionButton
              className="novel-moyu-msg-action"
              label={t('reader.moyu.copy')}
              copiedLabel={t('reader.moyu.copied')}
              onCopy={copyPrompt}
            />
          </div>
        </div>

        {closed && (
          <button
            type="button"
            className="novel-moyu-process-hdr"
            aria-expanded={!folded}
            onClick={() => toggleFolded(turnIndex)}
          >
            <span>
              {turnLabel.text}
              <DurationText parts={turnLabel.parts} className="novel-moyu-process-dur" />
            </span>
            <span className="novel-moyu-process-chevron"><ChevronDownIcon up={!folded} /></span>
          </button>
        )}

        {(live || !folded) && (
          <div className="novel-moyu-process-group">
            <ProcessRow
              icon={live ? <WhaleIcon /> : <ThinkIcon />}
              title={groupLabel}
              summary=""
              streaming={live}
              expandable
              expanded={groupOpen}
              onToggle={() => toggleGroup(turnIndex)}
            />
            {groupOpen && (
              <>
                <ProcessRow
                  icon={<ThinkIcon />}
                  title={t('reader.moyu.process.think')}
                  summary={tocName === '' ? t('reader.chapterFallback', { n: turnIndex + 1 }) : tocName}
                  streaming={live}
                  expandable
                  expanded={openThinking}
                  onToggle={() => toggleThinking(turnIndex)}
                  body={t('reader.moyu.think.body', { title, paragraphs: projection.paragraphCount, chars })}
                />
                <ProcessRow
                  icon={<FileReadIcon />}
                  title={t('reader.moyu.process.read')}
                  summary={file}
                  /* M12 落点切换（二批）：fileLink 从「定位+跳章」改为开该文件的文档预览 tab。 */
                  summaryAction={{ label: file, onClick: () => openPreviewTab('chapter', turnIndex) }}
                  expandable={false}
                  expanded={openResult}
                  onToggle={() => toggleResult(turnIndex)}
                  result={(
                    <div className="novel-moyu-result-card">
                      <span className="novel-moyu-result-range">
                        {t('reader.moyu.process.readSummary', {
                          from: (turnIndex * 24) + 1,
                          to: (turnIndex * 24) + 24,
                        })}
                      </span>
                      <span className="novel-moyu-result-body">{t('reader.moyu.process.result')}：{tocName}</span>
                    </div>
                  )}
                />
              </>
            )}
          </div>
        )}

        {projection.blocks.length > 0 && <div className="novel-moyu-assistant-body">{body}</div>}
        {errorRow}
        {live && (
          <div className="novel-moyu-running" data-has-output={projection.blocks.length > 0 ? '' : undefined}>
            <span className="novel-moyu-running-divider" aria-hidden="true" />
            <span className="novel-moyu-running-content">
              <span className="novel-moyu-running-icon"><WhaleIcon /></span>
              <span className="novel-moyu-running-text is-shimmer">{t('reader.moyu.turn.running', { duration: durationParts(elapsed, t).map((part) => part.text).join('') })}</span>
            </span>
          </div>
        )}
        {closed && chars > 0 && (
          <div className="novel-moyu-tail-actions">
            <CopyActionButton
              className="novel-moyu-msg-action"
              label={t('reader.moyu.copy')}
              copiedLabel={t('reader.moyu.copied')}
              onCopy={copyChapter}
            />
            <MoyuTooltip label={t('reader.moyu.fork')}>
              <button type="button" className="novel-moyu-msg-action" aria-label={t('reader.moyu.fork')} disabled>
                <ForkIcon />
              </button>
            </MoyuTooltip>
            {/* M1：轮尾尾注＝消息时刻（宿主 MessageIconActions 的 endInfo＝用量胶囊 + 时刻）。 */}
            <span className="novel-moyu-tail-info">
              <span className="novel-moyu-tail-usage">{t('reader.moyu.tail.usage', { value: tokOf(chars) })}</span>
              <span className="novel-moyu-tail-time">{clockRef.current.format(clockMark.messageAt, t)}</span>
            </span>
          </div>
        )}
      </section>
    )
  }

  /* 真轮次镜像轮：宿主真会话的轮次用**同一套舞台组件**渲染——用户气泡（真 prompt 文本）/
     思考行（真 reasoning）/ 工具行（真工具名 · 摘要，照 ToolRow 形态）/ 助手正文（真文本）/
     轮尾（真时刻 + 真用量，不走假时钟、不折算 ~tok）。未映射的节点种类＝中性占位行（宁降勿猜）；
     形状漂移＝该轮降级只剩占位行（失败半径＝那一轮），不炸整条流。 */
  /** 本书的真轮次镜像（跨书不串场：任务账可以跨面板存活，但对话流只进起任务的那本书）。 */
  const mirrorTurns = mirror.turns.filter((turn) => turn.bookKey === bookKey)
  const renderMirrorTurn = (turn: MoyuMirrorTurn): ReactNode => {
    // 参照日取本书镜像轮里**最晚**的时刻：更早的日子才带日期（宿主消息时刻口径）。
    const anchorAt = mirrorTurns.reduce((max, item) => Math.max(max, item.startedAt), turn.startedAt)
    const copySource = turn.rows.flatMap((row) => {
      if (row.kind === 'think') return [row.body]
      if (row.kind === 'user' || row.kind === 'text') return [row.text]
      return []
    })
    const copyAll = (): void => copyText(copySource.join('\n\n'))
    const children: ReactNode[] = []
    let textRun: Array<Extract<MoyuMirrorRow, { kind: 'text' }>> = []
    const flushText = (): void => {
      if (textRun.length === 0) return
      const run = textRun
      textRun = []
      children.push(
        <div className="novel-moyu-assistant-body" key={`body-${run[0]?.key ?? ''}`}>
          {run.map((row) => row.text.split(/\n{2,}/).filter((para) => para !== '').map((para, index) => (
            <p key={`${row.key}:${index}`} className="novel-moyu-p">{para}</p>
          )))}
        </div>,
      )
    }
    for (const row of turn.rows) {
      if (row.kind === 'text') {
        textRun.push(row)
        continue
      }
      flushText()
      if (row.kind === 'user') {
        children.push(
          <div className="novel-moyu-user-row" key={row.key}>
            <div className="novel-moyu-user-stack">
              <div className="novel-moyu-user-bubble">{row.text}</div>
            </div>
            <div className="novel-moyu-user-actions">
              {row.time !== null && (
                <span className="novel-moyu-user-time">{formatMessageClock(row.time, anchorAt, t)}</span>
              )}
              <CopyActionButton
                className="novel-moyu-msg-action"
                label={t('reader.moyu.copy')}
                copiedLabel={t('reader.moyu.copied')}
                onCopy={() => copyText(row.text)}
              />
            </div>
          </div>,
        )
        continue
      }
      if (row.kind === 'think') {
        children.push(
          <ProcessRow
            key={row.key}
            icon={<ThinkIcon />}
            title={t('reader.moyu.process.think')}
            summary={firstLineOf(row.body)}
            expandable
            expanded={openMirrorRows.has(row.key)}
            onToggle={() => toggleMirrorRow(row.key)}
            body={row.body}
          />,
        )
        continue
      }
      if (row.kind === 'tool') {
        children.push(
          <ProcessRow key={row.key} icon={<ToolIcon />} title={row.name} summary={row.summary} streaming={row.running} />,
        )
        continue
      }
      if (row.kind === 'tail') {
        children.push(
          <div className="novel-moyu-tail-actions" key={row.key}>
            <CopyActionButton
              className="novel-moyu-msg-action"
              label={t('reader.moyu.copy')}
              copiedLabel={t('reader.moyu.copied')}
              onCopy={copyAll}
            />
            <MoyuTooltip label={t('reader.moyu.fork')}>
              <button type="button" className="novel-moyu-msg-action" aria-label={t('reader.moyu.fork')} disabled>
                <ForkIcon />
              </button>
            </MoyuTooltip>
            {/* 轮尾（真值轮）：真时刻 + 真用量。 */}
            <span className="novel-moyu-tail-info">
              {row.usage !== null && (
                <span className="novel-moyu-tail-usage">{t('reader.moyu.tail.usageReal', { value: row.usage })}</span>
              )}
              <span className="novel-moyu-tail-time">{formatMessageClock(row.time, anchorAt, t)}</span>
            </span>
          </div>,
        )
        continue
      }
      if (row.kind === 'error') {
        // M4 错误行（拍板）：镜像的 turn-error 走舞台既有的错误行形态——「本轮运行失败」+ 真失败消息
        // + 错误码 `<code>` 芯片（档位沿 M4 真因映射 `errorCodeOf`：有 code 就用、判不出 INTERNAL）。
        children.push(
          <div className="novel-moyu-error-row" role="status" key={row.key}>
            <span className="novel-moyu-error-dot" aria-hidden="true" />
            <div className="novel-moyu-error-copy">
              <span className="novel-moyu-error-title">{t('reader.moyu.error.title')}</span>
              <span className="novel-moyu-error-msg">{row.message}</span>
            </div>
            <code className="novel-moyu-error-code">{errorCodeOf(row.code)}</code>
          </div>,
        )
        continue
      }
      children.push(<div className="novel-moyu-mirror-skip" key={row.key}>{t('reader.moyu.mirror.placeholder')}</div>)
    }
    flushText()
    return (
      <section className="novel-moyu-turn" key={turn.key} data-mirror-turn={turn.key}>
        {turn.degraded
          ? <div className="novel-moyu-mirror-skip">{t('reader.moyu.mirror.placeholder')}</div>
          : children}
      </section>
    )
  }

  /** 入口是否可用：工作区枚举面与打开会话面都在场，chip 才出现（缺一＝整枚隐藏）。 */
  const entryReady = hostPort !== null && hostPort.uiWorkspace !== undefined && workspace.available
  /** 选中的工作区必须**当前有效**：枚举面里没有它＝没选（陈旧选择不画在 chip 上）。 */
  const boundWorkspace = entryReady
    ? workspace.options.find((option) => option.workspaceId === workspace.boundId) ?? null
    : null
  const sendButtonLabel = streaming ? t('reader.moyu.composer.stop') : t('reader.moyu.composer.send')
  /** 发送钮可用性：流式＝停止恒可按；其余照 I4-B（空草稿灰态；末章也灰）。 */
  const sendDisabled = streaming
    ? false
    : draft === '' || toc === null || currentChapter >= toc.length - 1

  const styleLabel = prefs.moyuStyle === 'dsh'
    ? t('reader.moyu.model.style.dsh')
    : prefs.moyuStyle === 'compact'
      ? t('reader.moyu.model.style.compact')
      : t('reader.moyu.model.style.clean')
  const effortLabel = prefs.moyuReveal === 'stream'
    ? t('reader.moyu.model.effort.stream')
    : t('reader.moyu.model.effort.instant')

  const runCommand = (id: string, label: string): void => {
    setMenu(null)
    setChips((prev) => [...prev, { id: `${id}-${Date.now()}`, kind: 'command', label: `/${label}` }])
    if (draft.trim().startsWith('/')) setDraft('')
    if (id === 'next') jump(currentChapter + 1)
    else if (id === 'prev') jump(currentChapter - 1)
    else if (id === 'locate') {
      setDockOpen(true)
      window.requestAnimationFrame(locateCurrent)
    } else if (id === 'style') {
      setPref({ moyuStyle: prefs.moyuStyle === 'dsh' ? 'compact' : prefs.moyuStyle === 'compact' ? 'clean' : 'dsh' })
    } else if (id === 'reveal') {
      setPref({ moyuReveal: prefs.moyuReveal === 'stream' ? 'instant' : 'stream' })
    } else if (id === 'listen') onListen()
    else if (id === 'exit') onClose()
  }

  const commandEntries: Array<{ id: string; label: string }> = [
    { id: 'next', label: t('reader.moyu.command.next') },
    { id: 'prev', label: t('reader.moyu.command.prev') },
    { id: 'locate', label: t('reader.moyu.command.locate') },
    { id: 'style', label: t('reader.moyu.command.style') },
    { id: 'reveal', label: t('reader.moyu.command.reveal') },
    { id: 'listen', label: t('reader.moyu.command.listen') },
    { id: 'exit', label: t('reader.moyu.command.exit') },
  ]

  const draftToken = draft.trim()
  const slashOpen = menu === 'command' || (draftToken.startsWith('/') && !draftToken.includes(' '))
  const commandEntriesShown = slashOpen
    ? commandEntries.filter(({ label }) => {
      const token = draftToken.replace(/^\//, '')
      return token === '' || label.toLowerCase().includes(token.toLowerCase())
    })
    : []

  const referenceEntries: Array<{ id: string; name: string; run: () => void }> = [
    { id: 'readme', name: MOYU_README_NAME, run: () => openPreviewTab('readme', 0) },
    ...(toc ?? []).map((entry, index) => ({
      id: `c-${index}`,
      name: chapterFileName(index, entry.name),
      run: () => jump(index),
    })),
  ]

  /* 轨迹台账的事件投影（T5 / ③口径）：每轮 3 行（用户 / 工具 / 消息），四列指标＝真阅读数据映射
     ——字数→输入/输出列、段数→思考列、揭示耗时→时间列。揭示耗时取真实读数（揭示完成即记进台账），
     没记到的轮回落「字数/86」的合成时长（估读，报告记档）；时刻读数走假时钟，不读系统真钟。 */
  const trajQueryTrimmed = trajQuery.trim().toLowerCase()
  const trajTurns: MoyuTrajectoryTurn[] = turns.map((chapterIndex, order) => {
    const projection = turnProjections[chapterIndex] ?? EMPTY_PROJECTION
    const tocName = toc?.[chapterIndex]?.name ?? ''
    const file = moyuChapterPath(chapterIndex, tocName)
    const name = tocName === '' ? t('reader.chapterFallback', { n: chapterIndex + 1 }) : tocName
    const chars = projection.total
    const seconds = revealSecondsRef.current.get(chapterIndex) ?? Math.max(1, Math.round(chars / 86))
    const duration = durationParts(seconds, t).map((part) => part.text).join('')
    const tokInput = t('reader.moyu.unit.tokApprox', { value: tokOf(chars) })
    const revealedChars = chapterIndex === currentChapter && streaming ? revealed : chars
    const tokOutput = t('reader.moyu.unit.tokApprox', { value: tokOf(revealedChars) })
    const think = t('reader.moyu.unit.paragraphs', { n: projection.paragraphCount })
    const events: MoyuTrajectoryEvent[] = [
      {
        key: `u-${chapterIndex}`, kind: 'user', index: 0,
        summary: promptOverrides.get(chapterIndex) ?? t('reader.moyu.userPrompt', { file }),
        input: null, output: null, think: null, time: null,
      },
      { key: `t-${chapterIndex}`, kind: 'tool', index: 0, summary: file, input: tokInput, output: null, think: null, time: duration },
      { key: `m-${chapterIndex}`, kind: 'message', index: 0, summary: name, input: tokInput, output: tokOutput, think, time: duration },
    ]
    return {
      turn: order + 1,
      chapterIndex,
      name,
      events,
      detail: {
        paragraphs: think,
        chars: t('reader.moyu.unit.chars', { n: chars }),
        reveal: duration,
        tok: tokInput,
      },
    }
  }).filter((turn) => trajQueryTrimmed === '' || turn.name.toLowerCase().includes(trajQueryTrimmed))
  let trajSeq = 0
  for (const turn of trajTurns) for (const event of turn.events) event.index = ++trajSeq

  const activePreview = previewTabs.find((tab) => tab.id === activeDockTab) ?? null
  const activeTrajTurn = trajTurns.find((turn) => turn.chapterIndex === trajSelected) ?? null
  /** 坞宽上限＝舞台宽一半（拖/键都夹在 min..max 之间，Home/End 走两端）。 */
  const dockWidthMax = Math.max(DOCK_WIDTH_MIN + DOCK_WIDTH_STEP, Math.round((stageRect?.width ?? 1280) / 2))
  const commitDockWidth = (width: number): void => {
    const next = Math.min(dockWidthMax, Math.max(DOCK_WIDTH_MIN, Math.round(width)))
    setDockWidth(next)
    try {
      globalThis.localStorage.setItem(DOCK_WIDTH_KEY, String(next))
    } catch {
      // 存不进 localStorage 就只在本会话记住宽度（无痕/配额场景），不打扰使用。
    }
  }

  const commandAnchor = anchorRectOf(inputRef.current)
  const commandMenuOpen = menu === 'command' || (slashOpen && commandEntriesShown.length > 0)

  /* 对话流的交错：章轮次（假数据）与镜像轮（真轮次）按**真实进入时刻**归并进同一条流——
     镜像轮＝用户行的宿主真时刻、章轮次＝该轮进入舞台的时刻，同一时刻章轮在前（稳定排序保先到先渲染）。
     两种轮次共用同一套舞台组件，不加「这是真的」标记；屏上时刻各走各的口径（假时间线 / 真值）。 */
  const flowItems = [
    ...turns.map((chapterIndex) => ({
      at: turnEntryRef.current.get(chapterIndex) ?? 0,
      node: renderTurn(chapterIndex),
    })),
    ...mirrorTurns.map((mirrorTurn) => ({
      at: mirrorTurn.startedAt,
      node: renderMirrorTurn(mirrorTurn),
    })),
  ].sort((a, b) => a.at - b.at)

  return (
    <div
      ref={setStageNode}
      className={[
        'novel-moyu-stage',
        prefs.moyuStyle === 'compact' ? 'is-compact' : '',
        dockOpen ? 'has-dock is-dock-open' : '',
        dockFullscreen ? 'is-dock-fullscreen' : '',
      ].filter(Boolean).join(' ')}
      data-novel-moyu
      role="dialog"
      aria-modal="true"
      aria-label={t('reader.moyu.chatTab')}
      style={{
        ...(stageRect === null ? {} : {
          left: stageRect.left,
          top: stageRect.top,
          width: stageRect.width,
          height: stageRect.height,
        }),
        // D9 坞宽值槽挂在舞台根：坞本体与事件详情浮层读同一份宽度。
        '--novel-moyu-dock-w': `${dockWidth}px`,
      } as CSSProperties}
    >
      <div className="novel-moyu-shell">
        <main className="novel-moyu-main">
          <header className="novel-moyu-header">
            <div className="novel-moyu-header-leading" />
            <div className="novel-moyu-title-row">
              <div className="novel-moyu-title-cluster">
                {/* H4：宿主 deriveAncestry 的父子两段链——{书名} / {会话标题}，父段点击回书架。 */}
                <nav className="novel-moyu-crumbs" aria-label={t('reader.moyu.sessionHierarchy')}>
                  <button type="button" className="novel-moyu-crumb" onClick={() => scene.exitToShelf()}>{title}</button>
                  <span className="novel-moyu-crumb-sep" aria-hidden="true">/</span>
                  <span className="novel-moyu-crumb is-current">{t('reader.moyu.sessionTitle')}</span>
                </nav>
              </div>
              <div className="novel-moyu-header-utilities">
                <div className="novel-moyu-menu-wrap">
                  <MoyuTooltip label={t('reader.moyu.more')}>
                    <button
                      ref={moreBtnRef}
                      type="button"
                      className="novel-moyu-icon-btn"
                      aria-label={t('reader.moyu.more')}
                      aria-haspopup="menu"
                      aria-expanded={menu === 'more'}
                      onClick={() => setMenu((value) => value === 'more' ? null : 'more')}
                    >
                      <MoreIcon />
                    </button>
                  </MoyuTooltip>
                </div>
              </div>
              <div className="novel-moyu-header-corner">
                {!dockOpen && (
                  <MoyuTooltip label={t('reader.moyu.openSidebar')}>
                    <button
                      type="button"
                      className="novel-moyu-icon-btn"
                      aria-label={t('reader.moyu.openSidebarAria')}
                      onClick={() => setDockOpen(true)}
                    >
                      <PanelIcon mirrored />
                    </button>
                  </MoyuTooltip>
                )}
              </div>
            </div>
            <div className="novel-moyu-tabs-row">
              <div className="novel-moyu-view-tabs" role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeTab === 'chat'}
                  className={`novel-moyu-tab${activeTab === 'chat' ? ' is-on' : ''}`}
                  onClick={() => setActiveTab('chat')}
                >
                  <TabLabel label={t('reader.moyu.chatTab')} />
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeTab === 'trajectory'}
                  className={`novel-moyu-tab${activeTab === 'trajectory' ? ' is-on' : ''}`}
                  onClick={() => setActiveTab('trajectory')}
                >
                  <TabLabel label={t('reader.moyu.trajectoryTab')} />
                </button>
              </div>
              <div className="novel-moyu-menu-wrap">
                <MoyuTooltip label={t('reader.moyu.moreViews')}>
                  <button
                    ref={viewsBtnRef}
                    type="button"
                    className="novel-moyu-tabs-more"
                    aria-label={t('reader.moyu.moreViews')}
                    aria-haspopup="menu"
                    aria-expanded={menu === 'views'}
                    onClick={() => setMenu((value) => value === 'views' ? null : 'views')}
                  >
                    <MoreIcon />
                  </button>
                </MoyuTooltip>
              </div>
            </div>
          </header>

          <div className="novel-moyu-body">
            <div
              ref={conversationRef}
              className="novel-moyu-scroll"
              data-dialog-initial
              tabIndex={-1}
              onScroll={onConversationScroll}
            >
              <div className="novel-moyu-view-area">
                {activeTab === 'chat' ? (
                  <div className="novel-moyu-flow-wrap">
                    <div className="novel-moyu-column">
                      {toc === null ? <div className="novel-moyu-p">{t('reader.tocLoading')}</div> : flowItems.map((item) => item.node)}
                      {currentContent !== null && totalChars === 0 && <div className="novel-moyu-p">{t('reader.moyu.empty')}</div>}
                      {state.loadingIdx !== null && <div className="novel-moyu-running">{t('common.loading')}</div>}
                      {phase === 'complete' && <div className="novel-moyu-running">{t('reader.endOfBook')}</div>}
                    </div>
                  </div>
                ) : (
                  <MoyuTrajectory
                    turns={trajTurns}
                    folded={trajFolded}
                    allFolded={trajTurns.length > 0 && trajTurns.every((turn) => trajFolded.has(turn.chapterIndex))}
                    selected={trajSelected}
                    query={trajQuery}
                    onQueryChange={setTrajQuery}
                    onToggleFold={(chapterIndex) => {
                      setTrajFolded((prev) => {
                        const next = new Set(prev)
                        if (next.has(chapterIndex)) next.delete(chapterIndex)
                        else next.add(chapterIndex)
                        return next
                      })
                    }}
                    onToggleAll={() => {
                      setTrajFolded((prev) => {
                        const all = trajTurns.every((turn) => prev.has(turn.chapterIndex))
                        return all ? new Set<number>() : new Set(trajTurns.map((turn) => turn.chapterIndex))
                      })
                    }}
                    onSelect={setTrajSelected}
                  />
                )}
              </div>

              {showToBottom && (
                <div className="novel-moyu-to-bottom-slot">
                  <MoyuTooltip label={t('reader.moyu.toBottom')} side="top">
                    <button type="button" className="novel-moyu-to-bottom" aria-label={t('reader.moyu.toBottom')} onClick={scrollToBottom}>
                      <DownIcon />
                    </button>
                  </MoyuTooltip>
                </div>
              )}

              <div className="novel-moyu-composer-seat">
                <div className="novel-moyu-composer-root">
                  {listen.showing && (
                    /* I13+I14：听书条换 QueueDock 的衣服（16px 圆角、menu 材质 + 毛玻璃、13px 文、
                       36px 行、行间发丝线、28px 圆钮、预览行 ellipsis），功能面照 ui-spec 不减。 */
                    <div className="novel-moyu-queue-dock">
                      {listenPanelOpen && (
                        <TtsSettingsPanel label={t('tts.settings')} onClose={() => { setListenPanelOpen(false) }}>
                          <TtsSettingsRows sources={listenSources} surface="bar" />
                          <div className="novel-tts-group">
                            <div className="novel-tts-actions">
                              <button type="button" className="novel-chip" onClick={() => { void playFromReadingPosition().catch(reportTtsError) }}>{t('tts.fromReading')}</button>
                              <button type="button" className="novel-chip" onClick={() => { void skipChapter(-1).catch(reportTtsError) }}>{t('tts.prevChapter')}</button>
                              <button type="button" className="novel-chip" onClick={() => { void skipChapter(1).catch(reportTtsError) }}>{t('tts.nextChapter')}</button>
                            </div>
                            <TtsSettingsNote />
                          </div>
                        </TtsSettingsPanel>
                      )}
                      <div className="novel-moyu-queue-panel">
                        <div className="novel-moyu-queue-row">
                          <span className="novel-moyu-queue-lead" aria-hidden="true"><QueueIcon /></span>
                          <span className="novel-moyu-queue-label">
                            {t('reader.moyu.tts.label', { chapter: tts.chapterIndex + 1, paragraph: tts.paragraphIndex + 1, total: tts.paragraphCount })}
                          </span>
                          <span className="novel-moyu-queue-preview">{lineOf(tts) ?? ''}</span>
                        </div>
                        <div className="novel-moyu-queue-row novel-moyu-queue-controls">
                          <button type="button" className="novel-moyu-queue-btn" aria-label={t('tts.prevParagraph')} onClick={() => { void skipParagraph(-1).catch(reportTtsError) }}><ChevronLeftIcon /></button>
                          <button type="button" className="novel-moyu-queue-btn" aria-label={listenFace.busy ? t('tts.pause') : t('tts.play')} onClick={() => { if (listenFace.busy) pauseListening(); else resumeListening() }}><PlayIcon pause={listenFace.busy} /></button>
                          <button type="button" className="novel-moyu-queue-btn" aria-label={t('tts.nextParagraph')} onClick={() => { void skipParagraph(1).catch(reportTtsError) }}><ChevronRightIcon /></button>
                          <button type="button" className="novel-moyu-queue-btn" aria-label={t('tts.rateCycle', { rate: rateLabel(tts, t) })} onClick={() => setListenRate(cycleRate(tts.rate))}>{rateLabel(tts, t)}</button>
                          <button type="button" className="novel-moyu-queue-btn" aria-label={t('tts.timerCycle', { timer: timerChoiceLabel(tts.timerChoice, t) })} onClick={() => setListenTimer(nextTimerChoice(tts.timerChoice))}>{listenTimer.label}</button>
                          <button type="button" className="novel-moyu-queue-btn" aria-label={t('tts.locate')} onClick={locateLiveParagraph}>
                            <svg aria-hidden="true" viewBox="0 0 16 16"><circle cx="8" cy="8" r="3.2" /><path d="M8 1.5v2.3M8 12.2v2.3M1.5 8h2.3M12.2 8h2.3" /></svg>
                          </button>
                          <button
                            type="button"
                            className={`novel-moyu-queue-btn${listenPanelOpen ? ' is-on' : ''}`}
                            aria-label={t('tts.settings')}
                            aria-expanded={listenPanelOpen}
                            onClick={() => { setListenPanelOpen((open) => !open) }}
                          >
                            {SETTINGS_ICON}
                          </button>
                          <button type="button" className="novel-moyu-queue-btn" aria-label={t('tts.stop')} onClick={stopListening}><CloseIcon /></button>
                        </div>
                        {listenFace.failedHint !== null && (
                          <div className="novel-moyu-queue-fail" role="status">{t('tts.failedHint', { n: listenFace.failedHint })}</div>
                        )}
                        <QueueSeekRow st={tts} hasSegments={listenFace.hasSegments} />
                      </div>
                    </div>
                  )}
                  {notices.map((notice) => (
                    <div key={notice.id} className="novel-moyu-notice-row">
                      {notice.text}
                      <button
                        type="button"
                        className="novel-moyu-mini-btn"
                        aria-label={t('common.close')}
                        onClick={() => setNotices((prev) => prev.filter((item) => item.id !== notice.id))}
                      >
                        <CloseIcon />
                      </button>
                    </div>
                  ))}
                  {chips.length > 0 && (
                    <div className="novel-moyu-chip-row">
                      {chips.map((chip) => (
                        <button
                          key={chip.id}
                          type="button"
                          className={chip.kind === 'command' ? 'novel-moyu-cmd-chip' : 'novel-moyu-ref-chip'}
                          onClick={() => setChips((prev) => prev.filter((item) => item.id !== chip.id))}
                        >
                          <span className="novel-moyu-cmd-chip-label">{chip.label}</span>
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="novel-moyu-composer-card">
                    <div className="novel-moyu-composer-scroll">
                      <textarea
                        ref={inputRef}
                        className="novel-moyu-input"
                        aria-label={t('reader.moyu.composer.placeholder')}
                        placeholder={t('reader.moyu.composer.placeholder')}
                        rows={1}
                        value={draft}
                        onChange={(event) => {
                          setDraft(event.target.value)
                          event.target.style.height = 'auto'
                          event.target.style.height = `${Math.min(event.target.scrollHeight, 336)}px`
                        }}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' && !event.shiftKey) {
                            event.preventDefault()
                            if (commandMenuOpen && commandEntriesShown.length > 0) {
                              const first = commandEntriesShown[0]
                              if (first !== undefined) runCommand(first.id, first.label)
                              return
                            }
                            submitComposer()
                          } else if (event.key === '@' && draft === '') {
                            setMenu('reference')
                          } else if (event.key === 'Escape') {
                            if (menu !== null) {
                              event.stopPropagation()
                              setMenu(null)
                            }
                          }
                        }}
                      />
                    </div>
                    <div className="novel-moyu-composer-row">
                      <div className="novel-moyu-composer-tools">
                        <MoyuTooltip label={t('reader.moyu.composer.add')} side="top">
                          <button
                            ref={commandBtnRef}
                            type="button"
                            className="novel-moyu-composer-add"
                            aria-label={t('reader.moyu.composer.add')}
                            aria-haspopup="listbox"
                            aria-expanded={menu === 'command'}
                            onClick={() => setMenu((value) => value === 'command' ? null : 'command')}
                          >
                            <PlusIcon />
                          </button>
                        </MoyuTooltip>
                        {/* 工作区 chip（入口，不是投递点）：点开选一个工作区，在宿主里开/切会话并带到前台。
                            工作区面或打开面缺席＝整枚隐藏，不画空座。 */}
                        <span className="novel-moyu-select-seat">
                          {entryReady && (
                            <MoyuTooltip label={t('reader.moyu.workspace.menuAria')} side="top">
                              <button
                                ref={workspaceBtnRef}
                                type="button"
                                className="novel-moyu-select"
                                aria-haspopup="menu"
                                aria-expanded={menu === 'workspace'}
                                onClick={() => setMenu((value) => value === 'workspace' ? null : 'workspace')}
                              >
                                {boundWorkspace?.title ?? t('reader.moyu.workspace.choose')}
                              </button>
                            </MoyuTooltip>
                          )}
                        </span>
                      </div>
                      <div className="novel-moyu-composer-trailing">
                        <MoyuTooltip label={t('reader.moyu.model.group.model')} side="top">
                          <button
                            ref={modelBtnRef}
                            type="button"
                            className="novel-moyu-model-chip"
                            aria-label={t('reader.moyu.model.aria', { model: styleLabel, effort: effortLabel })}
                            aria-haspopup="menu"
                            aria-expanded={menu === 'model'}
                            onClick={() => setMenu((value) => value === 'model' ? null : 'model')}
                          >
                            <span className="novel-moyu-model-name">{styleLabel}</span>
                            <span className="novel-moyu-model-effort">{effortLabel}</span>
                          </button>
                        </MoyuTooltip>
                        {/* 发送钮两态：流式＝停止方块（补完当前章）；其余＝进下一章。 */}
                        <MoyuTooltip
                          label={sendButtonLabel}
                          keys={streaming ? [t('reader.moyu.shortcut.esc'), t('reader.moyu.shortcut.esc')] : []}
                          side="top"
                        >
                          <button
                            type="button"
                            className="novel-moyu-send"
                            aria-label={sendButtonLabel}
                            disabled={sendDisabled}
                            onClick={submitComposer}
                          >
                            {streaming ? <StopIcon /> : <SendIcon />}
                          </button>
                        </MoyuTooltip>
                      </div>
                    </div>
                    <div className="novel-moyu-composer-dock">
                      {/* I2：ActivityPill 补 gauge 图标 + 「· X tok/s」（tps＝本章 tok ÷ 揭示真实耗时）。 */}
                      <span className="novel-moyu-stat-pill" data-composer-stat="activity">
                        <GaugeIcon />
                        <span>{t('reader.moyu.stats', { turns: turnsCount, steps: stepsCount })}</span>
                        <span className="novel-moyu-stat-sep" aria-hidden="true">·</span>
                        <span>{t('reader.moyu.activity.speed', { tps })}</span>
                      </span>
                      {/* I1：UsagePill 整枚（database 图标 + ~tok + 缓存命中，宿主三件套补全）。 */}
                      <span className="novel-moyu-stat-pill" data-composer-stat="usage">
                        <DatabaseIcon />
                        <span>{t('reader.moyu.unit.tokApprox', { value: usageTok })}</span>
                        <span className="novel-moyu-stat-sep" aria-hidden="true">·</span>
                        <span>{t('reader.moyu.usage.cacheHit', { percent: cacheHit })}</span>
                      </span>
                      <MoyuTooltip label={t('reader.moyu.context.aria', { percent: `${pct}%` })} side="top" delayMs={200}>
                        <button
                          ref={contextBtnRef}
                          type="button"
                          className="novel-moyu-context-pill"
                          aria-haspopup="dialog"
                          aria-label={t('reader.moyu.context.aria', { percent: `${pct}%` })}
                          onClick={() => setMenu((value) => value === 'context' ? null : 'context')}
                        >
                          <ContextRing pct={pct} />
                          <span>{t('reader.moyu.context.value', { percent: `${pct}%` })}</span>
                        </button>
                      </MoyuTooltip>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </main>

        {dockOpen && (
          <>
            {/* D9：坞宽分隔条（8px、col-resize、←/→/Home/End，照 FileNavigator separator 口径）。 */}
            <div
              className="novel-moyu-dock-sep"
              role="separator"
              aria-orientation="vertical"
              aria-label={t('reader.moyu.dockResize')}
              aria-valuemin={DOCK_WIDTH_MIN}
              aria-valuemax={dockWidthMax}
              aria-valuenow={dockWidth}
              tabIndex={0}
              onKeyDown={(event) => {
                const next = event.key === 'ArrowLeft' ? dockWidth + DOCK_WIDTH_STEP
                  : event.key === 'ArrowRight' ? dockWidth - DOCK_WIDTH_STEP
                    : event.key === 'Home' ? DOCK_WIDTH_MIN
                      : event.key === 'End' ? dockWidthMax
                        : undefined
                if (next === undefined) return
                event.preventDefault()
                commitDockWidth(next)
              }}
              onPointerDown={(event) => {
                if (event.button !== 0) return
                event.preventDefault()
                event.currentTarget.setPointerCapture(event.pointerId)
                dockDragRef.current = { x: event.clientX, width: dockWidth }
              }}
              onPointerMove={(event) => {
                const origin = dockDragRef.current
                if (origin === null) return
                commitDockWidth(origin.width + origin.x - event.clientX)
              }}
              onPointerUp={(event) => { event.currentTarget.releasePointerCapture(event.pointerId) }}
              onLostPointerCapture={() => { dockDragRef.current = null }}
            />
            <aside
              className="novel-moyu-dock"
              aria-label={t('reader.moyu.files')}
            >
              <div className="novel-moyu-dock-strip">
                {/* D1+D2 tab 体系：「文件」tab + 预览 tab（min/max 80/170、每枚自带 ×）；
                    「文件」tab 的 ×＝收起文件坞，预览 tab 的 ×＝关该 tab（激活回「文件」）。 */}
                <div className={`novel-moyu-dock-tab${activeDockTab === 'files' ? ' is-on' : ''}`}>
                  <button type="button" className="novel-moyu-dock-tab-main" onClick={() => setActiveDockTab('files')}>
                    <span className="novel-moyu-dock-tab-icon" aria-hidden="true"><FolderIcon open={false} /></span>
                    <span className="novel-moyu-dock-tab-title">{t('reader.moyu.files')}</span>
                  </button>
                  <button
                    type="button"
                    className="novel-moyu-dock-tab-close"
                    aria-label={t('reader.moyu.collapseSidebar')}
                    onClick={() => setDockOpen(false)}
                  >
                    <CloseIcon />
                  </button>
                </div>
                {previewTabs.map((tab) => (
                  <div key={tab.id} className={`novel-moyu-dock-tab${activeDockTab === tab.id ? ' is-on' : ''}`}>
                    <button type="button" className="novel-moyu-dock-tab-main" onClick={() => setActiveDockTab(tab.id)}>
                      <span className="novel-moyu-dock-tab-icon" aria-hidden="true">
                        {tab.kind === 'readme' ? <MdFileIcon /> : <TsFileIcon />}
                      </span>
                      <span className="novel-moyu-dock-tab-title">{tab.kind === 'readme' ? MOYU_README_NAME : chapterFileName(tab.chapterIndex, toc?.[tab.chapterIndex]?.name ?? '')}</span>
                    </button>
                    <button
                      type="button"
                      className="novel-moyu-dock-tab-close"
                      aria-label={t('reader.moyu.tabClose')}
                      onClick={() => closePreviewTab(tab.id)}
                    >
                      <CloseIcon />
                    </button>
                  </div>
                ))}
                <button type="button" className="novel-moyu-dock-addtab" aria-label={t('reader.moyu.newTab')} onClick={() => openPreviewTab('readme', 0)}>
                  <PlusIcon />
                </button>
                <div className="novel-moyu-dock-strip-fill" />
                <div className="novel-moyu-dock-strip-chrome">
                  <MoyuTooltip label={dockFullscreen ? t('reader.moyu.exitFullscreen') : t('reader.moyu.fullscreen')}>
                    <button
                      type="button"
                      className="novel-moyu-icon-btn"
                      aria-label={dockFullscreen ? t('reader.moyu.exitFullscreen') : t('reader.moyu.fullscreen')}
                      onClick={() => setDockFullscreen((value) => !value)}
                    >
                      <FullscreenIcon exit={dockFullscreen} />
                    </button>
                  </MoyuTooltip>
                  <MoyuTooltip label={t('reader.moyu.collapseSidebar')}>
                    <button
                      type="button"
                      className="novel-moyu-icon-btn"
                      aria-label={t('reader.moyu.collapseSidebarAria')}
                      onClick={() => setDockOpen(false)}
                    >
                      <PanelIcon mirrored />
                    </button>
                  </MoyuTooltip>
                </div>
              </div>
              {activeDockTab !== 'files' && activePreview !== null ? (
                <MoyuPreviewPane
                  path={activePreview.kind === 'readme' ? MOYU_README_NAME : moyuChapterPath(activePreview.chapterIndex, toc?.[activePreview.chapterIndex]?.name ?? '')}
                  {...(activePreview.kind === 'readme'
                    ? { markdown: moyuReadmeMarkdown(t, title, toc?.length ?? 0, importNotesCount) }
                    : { text: (turnProjections[activePreview.chapterIndex] ?? EMPTY_PROJECTION).blocks.flatMap((block) => block.kind === 'paragraph' ? [block.text] : []).join('\n\n') })}
                  onOpenInReader={() => openInReader(activePreview.chapterIndex)}
                />
              ) : (
                <>
                  <div className="novel-moyu-files-header">
                    <MoyuTooltip label={title}>
                      <span className="novel-moyu-path">
                        <span className="novel-moyu-path-seg is-file">{title}</span>
                      </span>
                    </MoyuTooltip>
                    <div className="novel-moyu-files-actions">
                      <MoyuTooltip label={t('reader.moyu.refresh')}>
                        <button
                          type="button"
                          className="novel-moyu-tool"
                          aria-label={t('reader.moyu.refresh')}
                          onClick={() => { setTreeRevision((value) => value + 1); setFilter('') }}
                        >
                          <RefreshIcon />
                        </button>
                      </MoyuTooltip>
                      <MoyuTooltip label={t('reader.moyu.search')}>
                        <button
                          type="button"
                          className="novel-moyu-tool"
                          aria-label={t('reader.moyu.search')}
                          aria-expanded={searchOpen}
                          onClick={() => setSearchOpen((value) => !value)}
                        >
                          <SearchIcon />
                        </button>
                      </MoyuTooltip>
                      <MoyuTooltip label={t('reader.moyu.openInApp')}>
                        <button
                          type="button"
                          className="novel-moyu-tool"
                          aria-label={t('reader.moyu.openInApp')}
                          onClick={() => openInReader(currentChapter)}
                        >
                          <DownloadIcon />
                        </button>
                      </MoyuTooltip>
                    </div>
                  </div>
                  {searchOpen && (
                    <div className="novel-moyu-files-search">
                      <div className="novel-moyu-files-search-field">
                        <MoyuTooltip label={t('reader.moyu.search.settings')}>
                          <button
                            ref={searchSettingsBtnRef}
                            type="button"
                            className="novel-moyu-tool"
                            aria-label={t('reader.moyu.search.settings')}
                            aria-haspopup="menu"
                            aria-expanded={searchSettingsOpen}
                            onClick={() => setSearchSettingsOpen((value) => !value)}
                          >
                            <SlidersIcon />
                          </button>
                        </MoyuTooltip>
                        <input
                          type="search"
                          value={filter}
                          placeholder={t('reader.moyu.searchPlaceholder')}
                          aria-label={t('reader.moyu.searchPlaceholder')}
                          onChange={(event) => setFilter(event.target.value)}
                        />
                        <MoyuTooltip label={hideVisited ? t('reader.moyu.search.showVisited') : t('reader.moyu.search.hideVisited')}>
                          <button
                            type="button"
                            className="novel-moyu-tool"
                            aria-pressed={hideVisited}
                            aria-label={hideVisited ? t('reader.moyu.search.showVisited') : t('reader.moyu.search.hideVisited')}
                            onClick={() => setHideVisited((value) => !value)}
                          >
                            <InfoIcon />
                          </button>
                        </MoyuTooltip>
                        {filter !== '' && (
                          <button type="button" className="novel-moyu-files-clear" aria-label={t('reader.moyu.clearSearch')} onClick={() => setFilter('')}>
                            <CloseIcon />
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                  <div className="novel-moyu-search-status">
                    {searchOpen && filter !== '' && (
                      <span className="novel-moyu-search-status-line">
                        {filteredChapters.length === 0
                          ? t('reader.moyu.search.empty')
                          : t('reader.moyu.search.results', { count: filteredChapters.length })}
                      </span>
                    )}
                  </div>
                  <div ref={treeRef} className="novel-moyu-files-tree" data-tree-revision={treeRevision} tabIndex={-1}>
                    <ul className="novel-moyu-tree-level">
                      <li className="novel-moyu-tree-item">
                        <div className="novel-moyu-tree-row">
                          <button
                            type="button"
                            className="novel-moyu-tree-action"
                            aria-expanded={chaptersOpen}
                            onClick={() => setChaptersOpen((value) => !value)}
                          >
                            <span className="novel-moyu-tree-folder"><FolderIcon open={chaptersOpen} /></span>
                            <span className="novel-moyu-tree-name">chapters</span>
                          </button>
                        </div>
                        {chaptersOpen && (
                          <ul className="novel-moyu-tree-level">
                            {filteredChapters.map(({ entry, index }) => (
                              <li key={index} className="novel-moyu-tree-item">
                                <div className={`novel-moyu-tree-row${index === currentChapter ? ' is-current' : ''}`}>
                                  <button
                                    type="button"
                                    className="novel-moyu-tree-action"
                                    data-chapter-file={index}
                                    data-visited={visited.has(index) ? 'true' : 'false'}
                                    aria-current={index === currentChapter ? 'true' : undefined}
                                    onClick={() => openPreviewTab('chapter', index)}
                                  >
                                    <span className="novel-moyu-tree-file ts"><TsFileIcon /></span>
                                    <span className="novel-moyu-tree-name">{highlightName(chapterFileName(index, entry.name), filter)}</span>
                                  </button>
                                  {visited.has(index) && (
                                    <span className="novel-moyu-tree-dot" role="img" aria-label={t('reader.moyu.visited')} />
                                  )}
                                </div>
                              </li>
                            ))}
                          </ul>
                        )}
                      </li>
                      <li className="novel-moyu-tree-item">
                        <div className="novel-moyu-tree-row">
                          <button type="button" className="novel-moyu-tree-action" onClick={() => openPreviewTab('readme', 0)}>
                            <span className="novel-moyu-tree-file md"><MdFileIcon /></span>
                            <span className="novel-moyu-tree-name">{MOYU_README_NAME}</span>
                          </button>
                        </div>
                      </li>
                    </ul>
                  </div>
                </>
              )}
            </aside>
          </>
        )}
      </div>

      {activeTab === 'trajectory' && activeTrajTurn !== null && (
        <MoyuTrajectoryDetail turn={activeTrajTurn} onClose={() => setTrajSelected(null)} onOpenInReader={openInReader} />
      )}

      {overlays}

      <MoyuMenu
        open={menu === 'more'}
        anchor={anchorRectOf(moreBtnRef.current)}
        ariaLabel={t('reader.moyu.more')}
        onClose={() => setMenu(null)}
      >
        <button type="button" role="menuitem" className="novel-moyu-menu-item" onClick={() => { setMenu(null); onClose() }}>
          <span className="novel-moyu-menu-item-left"><span>{t('reader.moyu.close')}</span></span>
          <span className="novel-moyu-menu-shortcut">{t('reader.moyu.shortcut.esc')}</span>
        </button>
        <div className="novel-moyu-menu-sep" role="separator" />
        <button type="button" role="menuitem" className="novel-moyu-menu-item" onClick={() => { setMenu(null); scene.toggle('prefs') }}>
          <span className="novel-moyu-menu-item-left"><SlidersIcon /><span>{t('reader.moyu.menu.prefs')}</span></span>
          <span className="novel-moyu-menu-shortcut">{t('reader.moyu.shortcut.aa')}</span>
        </button>
        <button type="button" role="menuitem" className="novel-moyu-menu-item" onClick={() => { setMenu(null); onOpenExport() }}>
          <span className="novel-moyu-menu-item-left"><DownloadIcon /><span>{t('reader.moyu.menu.export')}</span></span>
        </button>
        {importNotesCount > 0 && (
          <button type="button" role="menuitem" className="novel-moyu-menu-item" onClick={() => { setMenu(null); scene.toggle('importNotes') }}>
            <span className="novel-moyu-menu-item-left"><InfoIcon /><span>{t('reader.moyu.menu.importNotes', { n: importNotesCount })}</span></span>
            <span className="novel-moyu-menu-badge">{importNotesCount}</span>
          </button>
        )}
        <button type="button" role="menuitem" className="novel-moyu-menu-item" onClick={() => { setMenu(null); onListen() }}>
          <span className="novel-moyu-menu-item-left"><SpeakerIcon /><span>{t('reader.moyu.menu.listen')}</span></span>
          {listen.showing && <span className="novel-moyu-menu-badge">{t('reader.moyu.menu.ttsOn')}</span>}
        </button>
      </MoyuMenu>

      <MoyuMenu
        open={menu === 'views'}
        anchor={anchorRectOf(viewsBtnRef.current)}
        ariaLabel={t('reader.moyu.moreViews')}
        onClose={() => setMenu(null)}
      >
        <button type="button" role="menuitem" className="novel-moyu-menu-item" onClick={() => { setMenu(null); setActiveTab('chat') }}>
          <span className="novel-moyu-menu-item-left"><span>{t('reader.moyu.chatTab')}</span></span>
        </button>
        <button type="button" role="menuitem" className="novel-moyu-menu-item" onClick={() => { setMenu(null); setActiveTab('trajectory') }}>
          <span className="novel-moyu-menu-item-left"><span>{t('reader.moyu.trajectoryTab')}</span></span>
        </button>
        {/* 宿主真导航入口：服务缺席该行就不画。 */}
        {hostPort?.pluginNavigation !== undefined && (
          <>
            <div className="novel-moyu-menu-sep" role="separator" />
            <button
              type="button"
              role="menuitem"
              className="novel-moyu-menu-item"
              onClick={() => { setMenu(null); openPluginList(hostPort) }}
            >
              <span className="novel-moyu-menu-item-left"><PinwheelIcon /><span>{t('reader.moyu.moreViews.browsePlugins')}</span></span>
            </button>
          </>
        )}
      </MoyuMenu>

      {/* 工作区 chip 的菜单（宿主 select 形态的展开面）：每行＝「在宿主打开会话」这个入口动作，
          不在这里投递任何消息；选中的工作区记下来，下次 chip 上显示它。 */}
      <MoyuMenu
        open={menu === 'workspace'}
        anchor={anchorRectOf(workspaceBtnRef.current)}
        placement="above"
        ariaLabel={t('reader.moyu.workspace.menuAria')}
        onClose={() => setMenu(null)}
      >
        {workspace.options.map((option) => (
          <button
            key={option.workspaceId}
            type="button"
            role="menuitem"
            className="novel-moyu-menu-item"
            aria-label={t('reader.moyu.workspace.openHint', { title: option.title })}
            onClick={() => openWorkspaceSession(option)}
          >
            <span className="novel-moyu-menu-item-left"><span>{option.title}</span></span>
            {workspace.boundId === option.workspaceId && <CheckIcon />}
          </button>
        ))}
      </MoyuMenu>

      <MoyuMenu
        open={commandMenuOpen}
        anchor={commandAnchor}
        placement="above"
        role="listbox"
        ariaLabel={t('reader.moyu.command.menuAria')}
        onClose={() => setMenu(null)}
      >
        {commandEntriesShown.map(({ id, label }) => (
          <button key={id} type="button" role="option" className="novel-moyu-menu-item" onClick={() => runCommand(id, label)}>
            <span className="novel-moyu-menu-item-left"><span>/{label}</span></span>
          </button>
        ))}
      </MoyuMenu>

      <MoyuMenu
        open={menu === 'reference'}
        anchor={commandAnchor}
        placement="above"
        role="listbox"
        ariaLabel={t('reader.moyu.ref.menuAria')}
        onClose={() => setMenu(null)}
      >
        {referenceEntries.slice(0, 24).map(({ id, name, run }) => (
          <button
            key={id}
            type="button"
            role="option"
            className="novel-moyu-menu-item"
            onClick={() => {
              setMenu(null)
              setChips((prev) => [...prev, { id: `r-${Date.now()}`, kind: 'reference', label: name }])
              run()
            }}
          >
            <span className="novel-moyu-menu-item-left"><span>{name}</span></span>
          </button>
        ))}
      </MoyuMenu>

      <MoyuMenu
        open={menu === 'model'}
        anchor={anchorRectOf(modelBtnRef.current)}
        placement="above"
        ariaLabel={t('reader.moyu.model.group.model')}
        onClose={() => setMenu(null)}
      >
        <div className="novel-moyu-menu-group">{t('reader.moyu.model.group.model')}</div>
        {(['dsh', 'compact', 'clean'] as const).map((style) => (
          <button
            key={style}
            type="button"
            role="menuitemradio"
            aria-checked={prefs.moyuStyle === style}
            className="novel-moyu-menu-item"
            onClick={() => { setMenu(null); setPref({ moyuStyle: style }) }}
          >
            <span className="novel-moyu-menu-item-left">
              <span>{style === 'dsh' ? t('reader.moyu.model.style.dsh') : style === 'compact' ? t('reader.moyu.model.style.compact') : t('reader.moyu.model.style.clean')}</span>
            </span>
            {prefs.moyuStyle === style && <CheckIcon />}
          </button>
        ))}
        <div className="novel-moyu-menu-sep" role="separator" />
        <div className="novel-moyu-menu-group">{t('reader.moyu.model.group.effort')}</div>
        {(['stream', 'instant'] as const).map((effort) => (
          <button
            key={effort}
            type="button"
            role="menuitemradio"
            aria-checked={prefs.moyuReveal === effort}
            className="novel-moyu-menu-item"
            onClick={() => { setMenu(null); setPref({ moyuReveal: effort }) }}
          >
            <span className="novel-moyu-menu-item-left">
              <span>{effort === 'stream' ? t('reader.moyu.model.effort.stream') : t('reader.moyu.model.effort.instant')}</span>
            </span>
            {prefs.moyuReveal === effort && <CheckIcon />}
          </button>
        ))}
      </MoyuMenu>

      <MoyuMenu
        open={menu === 'context'}
        anchor={anchorRectOf(contextBtnRef.current)}
        placement="above"
        ariaLabel={t('reader.moyu.context.aria', { percent: `${pct}%` })}
        onClose={() => setMenu(null)}
      >
        <div className="novel-moyu-context-panel">
          <span className="novel-moyu-context-total">
            {t('reader.moyu.context.usedTotal', { used: formatTok(contextUsedTok, t), total: formatTok(contextTotalTok, t) })}
          </span>
          <div className="novel-moyu-context-bar">
            <span className="novel-moyu-context-seg" style={{ width: `${Math.round((contextBody / Math.max(1, contextUsedTok)) * 100)}%`, background: 'var(--novel-business)' }} />
            <span className="novel-moyu-context-seg" style={{ width: `${Math.round((contextToc / Math.max(1, contextUsedTok)) * 100)}%`, background: 'var(--novel-text-3)' }} />
            <span className="novel-moyu-context-seg" style={{ width: `${Math.round((contextHistoryTok / Math.max(1, contextUsedTok)) * 100)}%`, background: 'var(--novel-caption)' }} />
          </div>
          <ul className="novel-moyu-context-legend">
            <li>
              <span className="novel-moyu-context-swatch" style={{ background: 'var(--novel-business)' }} />
              <span className="novel-moyu-context-legend-label">{t('reader.moyu.context.legend.body')}</span>
              <span className="novel-moyu-context-legend-value">{t('reader.moyu.unit.tokApprox', { value: formatTok(contextBody, t) })}</span>
            </li>
            <li>
              <span className="novel-moyu-context-swatch" style={{ background: 'var(--novel-text-3)' }} />
              <span className="novel-moyu-context-legend-label">{t('reader.moyu.context.legend.toc')}</span>
              <span className="novel-moyu-context-legend-value">{t('reader.moyu.unit.tokApprox', { value: formatTok(contextToc, t) })}</span>
            </li>
            <li>
              <span className="novel-moyu-context-swatch" style={{ background: 'var(--novel-caption)' }} />
              <span className="novel-moyu-context-legend-label">{t('reader.moyu.context.legend.history')}</span>
              <span className="novel-moyu-context-legend-value">{t('reader.moyu.unit.tokApprox', { value: formatTok(contextHistoryTok, t) })}</span>
            </li>
          </ul>
        </div>
      </MoyuMenu>

      <MoyuMenu
        open={searchSettingsOpen}
        anchor={anchorRectOf(searchSettingsBtnRef.current)}
        ariaLabel={t('reader.moyu.search.settings')}
        onClose={() => setSearchSettingsOpen(false)}
      >
        <div className="novel-moyu-menu-group">{t('reader.moyu.search.scope')}</div>
        <button
          type="button"
          role="menuitemradio"
          aria-checked={searchScope === 'name'}
          className="novel-moyu-menu-item"
          onClick={() => { setSearchScope('name'); setSearchSettingsOpen(false) }}
        >
          <span className="novel-moyu-menu-item-left"><span>{t('reader.moyu.search.scopeName')}</span></span>
          {searchScope === 'name' && <CheckIcon />}
        </button>
        <button
          type="button"
          role="menuitemradio"
          aria-checked={searchScope === 'nameBody'}
          className="novel-moyu-menu-item"
          onClick={() => { setSearchScope('nameBody'); setSearchSettingsOpen(false) }}
        >
          <span className="novel-moyu-menu-item-left"><span>{t('reader.moyu.search.scopeNameBody')}</span></span>
          {searchScope === 'nameBody' && <CheckIcon />}
        </button>
      </MoyuMenu>

      {toast !== null && <div className="novel-moyu-toast" role="status">{toast}</div>}
    </div>
  )
}

/** 标签文字：88px 截断 + 超宽才给 tooltip（宿主 ViewTabLabel 口径）。 */
function TabLabel({ label }: { label: string }): ReactNode {
  let width = 0
  for (const glyph of label) width += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/u.test(glyph) ? 13 : 7
  return (
    <MoyuTooltip label={label} disabled={width <= 88}>
      <span className="novel-moyu-tab-label">{label}</span>
    </MoyuTooltip>
  )
}

/** 命中片段 <mark> 高亮（宿主 FileTree `.match` 口径）。 */
function highlightName(name: string, filter: string): ReactNode {
  const query = filter.trim()
  if (query === '') return name
  const at = name.toLowerCase().indexOf(query.toLowerCase())
  if (at < 0) return name
  return (
    <>
      {name.slice(0, at)}
      <mark>{name.slice(at, at + query.length)}</mark>
      {name.slice(at + query.length)}
    </>
  )
}

export function MoyuOverlayLayer({ children, onClose }: { children: ReactNode; onClose: () => void }): ReactNode {
  const panelRef = useRef<HTMLDivElement | null>(null)
  useDialogContract({ panelRef, onClose })
  return <div ref={panelRef} className="novel-moyu-overlay-layer">{children}</div>
}

/** 章内段滑杆（I13 末行整宽）：只让这一小块订阅段进度；算式与读数归 listen-readout。 */
function QueueSeekRow({ st, hasSegments }: { st: TtsPlayerState; hasSegments: boolean }): ReactNode {
  const t = useCopy()
  const progress = useStore(ttsProgress)
  if (!hasSegments) return null
  const chapter = chapterProgressOf(st, progress, t)
  // 连续 value 在末段念到段尾时会到 count，而滑杆 domain 是 0..count-1：不夹这下受控值就超出 max。
  const value = Math.min(chapter.count - 1, Math.max(0, Math.floor(chapter.value)))
  return (
    <div className="novel-moyu-queue-seek">
      <input
        className="novel-tts-range"
        type="range"
        min={0}
        max={Math.max(0, chapter.count - 1)}
        step={1}
        aria-label={t('tts.seekChapter')}
        value={value}
        aria-valuetext={chapter.readout}
        title={chapter.readout}
        style={{ '--novel-range-fill': chapter.count <= 1 ? '100%' : rangePercent(value, 0, chapter.count - 1) } as CSSProperties}
        onChange={(event) => { seekParagraph(Number(event.target.value)) }}
      />
    </div>
  )
}

function copyText(text: string): void {
  const clipboard = (navigator as unknown as { clipboard?: { writeText: (value: string) => Promise<void> } }).clipboard
  if (clipboard === undefined) return
  try {
    void clipboard.writeText(text).catch(() => undefined)
  } catch {
    return
  }
}
