import { createStore } from '../store.js'
import { ls } from '../util.js'

/**
 * 浮窗现场（`ADR-0073`）：两个形态共享同一块位置，位置是**块中心坐标**（`cx`/`cy`，null = 缺省）。
 * 记中心而不记左上角，同一锚点切换形态时视觉中心不跳；`side` 按 `cx` 与视口宽派生。
 * 拖动两轴跟手，松手时离视口边 ≤ 24px 才贴齐；落在正文中间是允许的。
 *
 * 落位几何判据住这里：`miniBarCenterOf` 是缺省轴解析的唯一住址，`miniBarLayout` 一次给全
 * 行内落位样式与 `side`/`flush`；视图只消费读数。
 */
export type MiniBarSide = 'left' | 'right'

export interface Size { width: number; height: number }

export interface Viewport { width: number; height: number }

interface Center { x: number; y: number }

export interface MiniBarState {
  cx: number | null
  cy: number | null
  /** 展开态宽高（`ADR-0080`）：null = 没调过，用缺省。盘上记**意图**，呈现时才夹取。 */
  w: number | null
  h: number | null
  collapsed: boolean
}

/** 两个形态的固定尺寸：量不到实际几何（jsdom / 无布局宿主）时用它，夹取与吸附不靠真排版。 */
export const CAPSULE_SIZE: Size = { width: 208, height: 44 }

/** 展开态的缺省与可调范围（`ADR-0080`）：最小高 162 = 骨架 + 恰好一行正文。 */
export const DEFAULT_MINI_BAR_SIZE: Size = { width: 320, height: 200 }
export const MIN_MINI_BAR_SIZE: Size = { width: 260, height: 162 }
export const MAX_MINI_BAR_SIZE: Size = { width: 520, height: 420 }

/** 视口与浮窗之间留的边距：呈现尺寸最多占到「视口 − 这一条」。 */
const VIEWPORT_MARGIN = 16

/** 设置弹层里的三档（`ADR-0080`）：不拖边的人也能到同样的三个位置，复位也有落点。 */
export const SIZE_PRESETS = [
  { id: 'small', width: MIN_MINI_BAR_SIZE.width, height: MIN_MINI_BAR_SIZE.height },
  { id: 'medium', width: DEFAULT_MINI_BAR_SIZE.width, height: DEFAULT_MINI_BAR_SIZE.height },
  { id: 'large', width: 380, height: 280 },
] as const

export type SizePreset = (typeof SIZE_PRESETS)[number]['id']

const MINI_BAR_KEY = 'dsh-novel.tts-mini'

/** 松手吸附带：离视口边这么近才贴齐。比它远的距离一律算用户要的自由落位。 */
const SNAP = 24

/** 位移超过这么多像素才算拖动，不算点击：8px 是手抖与真拖的分界。 */
const DRAG_THRESHOLD = 8

export const DEFAULT_MINI_BAR: MiniBarState = {
  cx: null, cy: null, w: null, h: null, collapsed: true,
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function collapsedOf(value: unknown): boolean {
  return typeof value === 'boolean' ? value : DEFAULT_MINI_BAR.collapsed
}

/** 读一份落盘现场：只认当前形状，认不出回缺省；两轴尺寸各认各的（单轴非法只丢那一轴）。
 *  没有已发布版本写过旧形状，不为从未存在的格式保留迁移分支。 */
export function parseMiniBarState(raw: string | null): MiniBarState {
  if (raw === null) return DEFAULT_MINI_BAR
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return DEFAULT_MINI_BAR
  }
  if (typeof parsed !== 'object' || parsed === null) return DEFAULT_MINI_BAR
  const record = parsed as Record<string, unknown>
  return {
    cx: finite(record['cx']),
    cy: finite(record['cy']),
    w: finite(record['w']),
    h: finite(record['h']),
    collapsed: collapsedOf(record['collapsed']),
  }
}

export const miniBarStore = createStore<MiniBarState>(parseMiniBarState(ls.getItem(MINI_BAR_KEY)))

/** side 是呈现方向而非位置：缺省横向（null）按贴右算——缺省落位贴右缘，见 `miniBarCenterOf`；右边的一半算右。 */
export function deriveMiniBarSide(state: MiniBarState, viewportWidth: number): MiniBarSide {
  return state.cx === null || state.cx >= viewportWidth / 2 ? 'right' : 'left'
}

/** 贴边读数：`none` = 块悬在屏内，两侧都没碰上视口边。 */
export type MiniBarFlush = MiniBarSide | 'none'

/** 贴上那条边的容差（px）：吸附写精确像素，夹取与视口变化可能留下不到半像素的缝。 */
const FLUSH_EPS = 0.5

/**
 * 块**真的**贴着哪一条竖边：`side` 说的是「朝向哪边」，贴边形态说的是「有没有碰上屏幕」——
 * 块停在正文中间时按 `side` 收边框，会在悬空的边上留下敞口（没描边、两个直角）。
 * 缺省轴由 `miniBarCenterOf` 解析成贴右缘，因此算 `right`。
 */
export function deriveMiniBarFlush(state: MiniBarState, size: Size, view: Viewport): MiniBarFlush {
  const cx = miniBarCenterOf(state, size, view).x
  const leftGap = cx - size.width / 2
  const rightGap = view.width - (cx + size.width / 2)
  if (leftGap <= FLUSH_EPS && leftGap <= rightGap) return 'left'
  if (rightGap <= FLUSH_EPS) return 'right'
  return 'none'
}

/** 当前形态的实际尺寸：量得到就用量到的（内容变化/拖边会改尺寸，常量算贴底会留缝），量不到回现场解析。 */
export function resolveFormSize(
  collapsed: boolean, rect: { width: number; height: number } | null, state: MiniBarState, view: Viewport,
): Size {
  if (rect !== null && rect.width > 0 && rect.height > 0) {
    return { width: rect.width, height: rect.height }
  }
  return collapsed ? CAPSULE_SIZE : resolvedMiniBarSize(state, view)
}

/** 一次给全的落位派生：行内样式（恒写解析后像素，含缺省轴）+ `side`/`flush` 两个读数。 */
interface MiniBarLayout {
  style: {
    transform: string
    left: string
    top: string
    '--novel-tts-panel-w': string
    '--novel-tts-panel-h': string
    '--novel-tts-capsule-w': string
    '--novel-tts-capsule-h': string
  }
  side: MiniBarSide
  flush: MiniBarFlush
}

/**
 * 根节点的落位样式与派生读数，一次给全。缺省轴也在这里解析成像素：缺省的贴右缘与落过位的
 * `left` 是两套坐标系，解析后视图不分「有没有落过位」，样式层也不再需要缺省定位规则。
 * 基准是控制器持有的视口读数（`readViewport` 是 `window.innerWidth/innerHeight` 的唯一读处）。
 */
export function miniBarLayout(state: MiniBarState, view: Viewport, size: Size): MiniBarLayout {
  const center = miniBarCenterOf(state, size, view)
  return {
    style: {
      transform: 'translate(-50%,-50%)',
      left: `${center.x}px`,
      top: `${center.y}px`,
      '--novel-tts-panel-w': `${size.width}px`,
      '--novel-tts-panel-h': `${size.height}px`,
      // 收起态尺寸也走值槽：胶囊与边栏的尺寸来源对称，样式层不写死第二份抄本（`ADR-0080`）。
      '--novel-tts-capsule-w': `${CAPSULE_SIZE.width}px`,
      '--novel-tts-capsule-h': `${CAPSULE_SIZE.height}px`,
    },
    side: deriveMiniBarSide(state, view.width),
    flush: deriveMiniBarFlush(state, size, view),
  }
}

/** 设置弹层内容高的回退档（无布局宿主 / 弹层还没挂上）：真判据是「实测高与 60vh 取小」。 */
const POPOVER_CONTENT_MAX = 320

/** 弹层与边栏之间的那条间距（样式层的 `--novel-sp-2`）：够不够地方要把它一起算。 */
const POPOVER_GAP = 6

/** 弹层与视口边的留白：留一条缝才读作「卡片到边了，里面可滚」。 */
const POPOVER_VIEWPORT_GAP = 8

/**
 * 弹层落位的唯一算式：往哪边开（`below`）与那一侧的可用余量（`room`）。
 *
 * 方向判据：上方优先；上方放不下才翻下方，且**下方得真的更有地方才翻**——只写「放不下就翻」
 * 会在块贴近底部时翻进更窄甚至为负的缝。两侧一样大时留在上方。
 *
 * 余量是弹层 `max-height` 的上界（值槽已扣与视口边的留白），放不下时卡片内部滚动；
 * `contentHeight` 是实测高，真占位取它与 60vh 的较小者，判据跟着现场走而不是开层那一刻算一次。
 */
function popoverPlacement(
  state: MiniBarState, view: Viewport, size: Size, contentHeight?: number,
): { below: boolean; room: number } {
  const center = miniBarCenterOf(state, size, view)
  const above = Math.max(0, center.y - size.height / 2 - POPOVER_GAP)
  const below = Math.max(0, view.height - center.y - size.height / 2 - POPOVER_GAP)
  const measured = contentHeight !== undefined && Number.isFinite(contentHeight) && contentHeight > 0
    ? contentHeight
    : POPOVER_CONTENT_MAX
  const needed = Math.min(measured, view.height * 0.6)
  // 相等时留在上方（缺省纵向居中）：只有下方真的更大才值得翻过去。
  const flip = needed > above && below > above
  const band = flip ? below : above
  return { below: flip, room: Math.max(0, band - POPOVER_VIEWPORT_GAP) }
}

/** 设置弹层往哪边开：`true` = 翻到下方（`data-flip`）。 */
export function miniBarPopoverFlip(
  state: MiniBarState, view: Viewport, size: Size, contentHeight?: number,
): boolean {
  return popoverPlacement(state, view, size, contentHeight).below
}

/** 选中那一侧的可用余量（px，已扣间距）：设置弹层 `max-height` 的上界，由视图写进 dock 的值槽。 */
export function miniBarPopoverRoom(
  state: MiniBarState, view: Viewport, size: Size, contentHeight?: number,
): number {
  return popoverPlacement(state, view, size, contentHeight).room
}

function commit(next: MiniBarState, persist = true): void {
  const current = miniBarStore.get()
  if (current.cx === next.cx && current.cy === next.cy && current.w === next.w
    && current.h === next.h && current.collapsed === next.collapsed) return
  miniBarStore.set(next)
  if (persist) ls.setItem(MINI_BAR_KEY, JSON.stringify(next))
}

/** 单轴呈现尺寸：先夹范围、再夹视口−边距；视口比下限还小就取下限（块可溢出，不崩）。 */
function resolveAxis(value: number | null, fallback: number, min: number, max: number, extent: number): number {
  const upper = Math.max(min, Math.min(max, extent - VIEWPORT_MARGIN))
  return Math.min(upper, Math.max(min, value ?? fallback))
}

/** 展开态的**呈现**尺寸：盘上记的是意图（可超范围），这里夹成实际可画的一版；不回写现场。 */
export function resolvedMiniBarSize(state: MiniBarState, view: Viewport): Size {
  return {
    width: resolveAxis(state.w, DEFAULT_MINI_BAR_SIZE.width, MIN_MINI_BAR_SIZE.width, MAX_MINI_BAR_SIZE.width, view.width),
    height: resolveAxis(
      state.h, DEFAULT_MINI_BAR_SIZE.height, MIN_MINI_BAR_SIZE.height, MAX_MINI_BAR_SIZE.height, view.height,
    ),
  }
}

/** 写尺寸意图：数值或 null（null = 回缺省）。 */
export function setMiniBarSize(width: number | null, height: number | null, persist = true): void {
  const current = miniBarStore.get()
  commit({
    cx: current.cx,
    cy: current.cy,
    w: typeof width === 'number' && Number.isFinite(width) ? width : null,
    h: typeof height === 'number' && Number.isFinite(height) ? height : null,
    collapsed: current.collapsed,
  }, persist)
}

/** 尺寸复位 = 写回 null（回缺省），不动位置与收起态。 */
export function resetMiniBarSize(): void {
  setMiniBarSize(null, null)
}

/** 拖边可拖的四条边：顶边不做把手（顶行是移动 / 收起面）。union 由这份清单推导。 */
export const MINI_BAR_EDGES = ['left', 'right', 'bottom', 'corner'] as const
export type MiniBarEdge = (typeof MINI_BAR_EDGES)[number]

/** 一次拖边会话的起手框：尺寸 + 中心，后续帧只在它上面加位移。 */
export interface MiniBarFrame { width: number; height: number; cx: number; cy: number }

function clampSize(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** 拖边一帧：**对边（对角）锚定**——拖右边时左缘不动，拖下边时顶缘不动，角上两轴同时；
 *  每轴夹进范围，最后把中心夹回视口。返回值即新框，不发动作。 */
export function frameFromDrag(
  edge: MiniBarEdge, start: MiniBarFrame, dx: number, dy: number, view: Viewport,
): MiniBarFrame {
  const width = edge === 'left'
    ? clampSize(start.width - dx, MIN_MINI_BAR_SIZE.width, MAX_MINI_BAR_SIZE.width)
    : edge === 'right' || edge === 'corner'
      ? clampSize(start.width + dx, MIN_MINI_BAR_SIZE.width, MAX_MINI_BAR_SIZE.width)
      : start.width
  const height = edge === 'bottom' || edge === 'corner'
    ? clampSize(start.height + dy, MIN_MINI_BAR_SIZE.height, MAX_MINI_BAR_SIZE.height)
    : start.height
  const cx = edge === 'left' ? start.cx + start.width / 2 - width / 2
    : edge === 'right' || edge === 'corner' ? start.cx - start.width / 2 + width / 2
    : start.cx
  const cy = edge === 'bottom' || edge === 'corner' ? start.cy - start.height / 2 + height / 2 : start.cy
  const center = clampCenter({ x: cx, y: cy }, { width, height }, view)
  return { width, height, cx: center.x, cy: center.y }
}

/** 写一帧拖边结果：宽高进现场（意图），中心按**呈现尺寸**夹取；拖动帧传 persist=false。 */
export function setMiniBarFrame(frame: MiniBarFrame, view: Viewport, persist = true): void {
  const width = clampSize(frame.width, MIN_MINI_BAR_SIZE.width, MAX_MINI_BAR_SIZE.width)
  const height = clampSize(frame.height, MIN_MINI_BAR_SIZE.height, MAX_MINI_BAR_SIZE.height)
  const current = miniBarStore.get()
  const rendered = resolvedMiniBarSize({ ...current, w: width, h: height }, view)
  const center = clampCenter({ x: frame.cx, y: frame.cy }, rendered, view)
  commit({ cx: center.x, cy: center.y, w: width, h: height, collapsed: current.collapsed }, persist)
}

/** 拖动帧只更新现场、松手才落盘：localStorage 是同步 I/O，60fps 逐帧写会拖成掉帧。 */
export function persistMiniBarState(): void {
  ls.setItem(MINI_BAR_KEY, JSON.stringify(miniBarStore.get()))
}

/** 单轴夹取：块整体留在视口内，贴边即端点（视口比块还小时贴住起点）。 */
function clampAxis(value: number, extent: number, half: number): number {
  const { low, high } = axisRange(extent, half)
  return Math.min(Math.max(value, low), high)
}

/** 中心在某一轴上的可落区间：整块留在视口内，贴边即端点。 */
function axisRange(extent: number, half: number): { low: number; high: number } {
  const low = half
  return { low, high: Math.max(low, extent - half) }
}

/**
 * 缺省轴解析的唯一住址：横向缺省贴右缘，纵向缺省视口中心，落过位的轴原样给。
 * 拖动起手、键盘移动、吸附、夹取、落位样式与弹层翻转都从这里取实际中心。
 */
export function miniBarCenterOf(state: MiniBarState, size: Size, view: Viewport): Center {
  return {
    x: state.cx ?? view.width - size.width / 2,
    y: state.cy ?? view.height / 2,
  }
}

function clampCenter(center: Center, size: Size, view: Viewport): Center {
  const x = axisRange(view.width, size.width / 2)
  const y = axisRange(view.height, size.height / 2)
  return {
    x: Math.min(Math.max(center.x, x.low), x.high),
    y: Math.min(Math.max(center.y, y.low), y.high),
  }
}

/** 拖到哪里落哪里：双轴夹在视口内，拖动中的每一帧都走这里；persist=false 由调用方松手时落盘。 */
export function setMiniBarCenter(x: number, y: number, size: Size, view: Viewport, persist = true): void {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return
  const center = clampCenter({ x, y }, size, view)
  const current = miniBarStore.get()
  commit({ cx: center.x, cy: center.y, w: current.w, h: current.h, collapsed: current.collapsed }, persist)
}

/** 夹取后写回现场：缺省轴夹取前后都在缺省位置时不写坐标，让「没拖过」这个事实一直成立。 */
function commitCenter(center: Center, size: Size, view: Viewport, state: MiniBarState): void {
  const clamped = clampCenter(center, size, view)
  const resolved = miniBarCenterOf(state, size, view)
  commit({
    cx: state.cx === null && clamped.x === resolved.x ? null : clamped.x,
    cy: state.cy === null && clamped.y === resolved.y ? null : clamped.y,
    w: state.w,
    h: state.h,
    collapsed: state.collapsed,
  })
}

/** 松手吸附：四边各自算 gap，≤ 24px 就贴齐那条边；两轴独立，所以能落在边角。 */
export function snapMiniBarToEdge(size: Size, view: Viewport): void {
  const state = miniBarStore.get()
  const center = miniBarCenterOf(state, size, view)
  const halfW = size.width / 2
  const halfH = size.height / 2
  const leftGap = center.x - halfW
  const rightGap = view.width - (center.x + halfW)
  const topGap = center.y - halfH
  const bottomGap = view.height - (center.y + halfH)
  const x = leftGap <= SNAP && leftGap <= rightGap ? halfW
    : rightGap <= SNAP ? view.width - halfW
    : center.x
  const y = topGap <= SNAP && topGap <= bottomGap ? halfH
    : bottomGap <= SNAP ? view.height - halfH
    : center.y
  commitCenter({ x, y }, size, view, state)
}

/** 换形态后按新尺寸重夹：已落位的轴夹回界内，缺省轴保持缺省。 */
export function clampMiniBarIntoViewport(size: Size, view: Viewport): void {
  const state = miniBarStore.get()
  commitCenter(miniBarCenterOf(state, size, view), size, view, state)
}

/** 视口变化：上一帧贴齐的边继续贴新视口，自由位置只夹不漂；缺省轴不参与（它本来就跟着视口走）。 */
export function followFlushEdgesOnResize(size: Size, prev: Viewport, view: Viewport): void {
  const state = miniBarStore.get()
  if (state.cx === null && state.cy === null) return
  const halfW = size.width / 2
  const halfH = size.height / 2
  // 贴边判据与 `deriveMiniBarFlush` 同一把尺（FLUSH_EPS）：亚像素缝不能靠 `=== 0` 判。
  const flushLeft = state.cx !== null && Math.abs(state.cx - halfW) <= FLUSH_EPS
  const flushRight = state.cx !== null && Math.abs(prev.width - (state.cx + halfW)) <= FLUSH_EPS
  const flushTop = state.cy !== null && Math.abs(state.cy - halfH) <= FLUSH_EPS
  const flushBottom = state.cy !== null && Math.abs(prev.height - (state.cy + halfH)) <= FLUSH_EPS
  const x = state.cx === null ? null
    : flushLeft ? halfW
    : flushRight ? view.width - halfW
    : state.cx
  const y = state.cy === null ? null
    : flushTop ? halfH
    : flushBottom ? view.height - halfH
    : state.cy
  commit({
    cx: x === null ? null : clampAxis(x, view.width, halfW),
    cy: y === null ? null : clampAxis(y, view.height, halfH),
    w: state.w,
    h: state.h,
    collapsed: state.collapsed,
  })
}

/** 回到「右缘 + 垂直居中」的缺省位置（键盘 Home 与「复位」同一条出口），收起态与尺寸不动。 */
export function resetMiniBarPosition(): void {
  const current = miniBarStore.get()
  commit({ cx: null, cy: null, w: current.w, h: current.h, collapsed: current.collapsed })
}

export function setMiniBarCollapsed(collapsed: boolean): void {
  const current = miniBarStore.get()
  commit({ cx: current.cx, cy: current.cy, w: current.w, h: current.h, collapsed })
}

/** 宿主窗口可能缺席（无窗口宿主 / SSR）：窗口读数与指针监听据此退化为缺省值 / 空转。 */
function hostWindow(): Window | null {
  const host = globalThis as { window?: Window }
  return host.window ?? null
}

/** `window.innerWidth` / `innerHeight` 的唯一读处：控制器构造时读一次，resize 时再读一次。 */
function readViewport(): Viewport {
  const win = hostWindow()
  return { width: win?.innerWidth ?? 1024, height: win?.innerHeight ?? 768 }
}

/** 渲染快照：视口与指针会话的当前读数；只在变化时换引用，供 `useSyncExternalStore` 比身份。 */
export interface MiniBarSnapshot {
  viewport: Viewport
  dragging: boolean
  resizing: MiniBarEdge | null
}

/**
 * 浮窗指针与几何控制器：拖动与拖边共用一套 pointer 生命周期（开始 / 移动 / 取消 / 结束落盘），
 * 差异只是「改中心」还是「改框」。窗口尺寸只在这里读，视口变化后在这里重算一次再通知渲染；
 * 视图只交手柄、边名与 pointerdown 事件。
 */
export interface MiniBarController {
  /** 渲染快照：视口与指针会话，值一变就换引用。 */
  snapshot: () => MiniBarSnapshot
  subscribe: (listener: () => void) => () => void
  /** 绑根节点：几何测量取它，`connect` 也观察它。 */
  attach: (root: HTMLElement | null) => void
  /** 建立窗口 resize 监听与根节点尺寸观察；返回清理函数，视图 effect 直接返回它。 */
  connect: () => () => void
  /** 指针起手：只认手柄内、且不落在真控件上的那一次按下。 */
  beginDrag: (handle: HTMLElement, event: PointerEvent) => void
  /** 指针起手：按边改框。 */
  beginResize: (edge: MiniBarEdge, event: PointerEvent) => void
  /** 新一次按压 / 脏标记的消费点：清掉上一次拖动留下的「吞 click」标记。 */
  clearMoved: () => void
  /** 这一次按压是否已构成拖动（松手后仍保留，供补发 click 判脏）。 */
  moved: () => boolean
  /** 换形态 / 内容尺寸后按新尺寸重夹一次。 */
  reconcile: () => void
  /** 键盘挪位：缺省轴先解析成实际中心，再加像素位移。 */
  moveCenterBy: (dx: number, dy: number) => void
}

interface DragPointer {
  kind: 'drag'
  id: number
  startX: number
  startY: number
  /** 起手那一刻的块中心（缺省轴已解析成数字） */
  startCx: number
  startCy: number
  size: Size
}

interface ResizePointer {
  kind: 'resize'
  id: number
  edge: MiniBarEdge
  startX: number
  startY: number
  start: MiniBarFrame
}

type PointerSession = DragPointer | ResizePointer

export function createMiniBarController(): MiniBarController {
  let viewport = readViewport()
  let root: HTMLElement | null = null
  let observer: ResizeObserver | null = null
  let session: PointerSession | null = null
  let moved = false
  const listeners = new Set<() => void>()
  let snap: MiniBarSnapshot = { viewport, dragging: false, resizing: null }

  const publish = (): void => {
    snap = {
      viewport,
      dragging: session?.kind === 'drag',
      resizing: session?.kind === 'resize' ? session.edge : null,
    }
    for (const listener of [...listeners]) listener()
  }

  /** 当前形态的实际尺寸：量得到就用量到的（内容变化 / 拖边会改尺寸），量不到回现场解析。 */
  const formSize = (view: Viewport): Size => {
    const rect = root?.getBoundingClientRect() ?? null
    const state = miniBarStore.get()
    return resolveFormSize(state.collapsed, rect, state, view)
  }

  const attachPointer = (win: Window): void => {
    win.addEventListener('pointermove', onPointerMove)
    win.addEventListener('pointerup', onPointerUp)
    win.addEventListener('pointercancel', onPointerUp)
  }

  const detachPointer = (win: Window): void => {
    win.removeEventListener('pointermove', onPointerMove)
    win.removeEventListener('pointerup', onPointerUp)
    win.removeEventListener('pointercancel', onPointerUp)
  }

  /** 一次指针会话收场：拖动松手才吸附 + 落盘；拖边松手只落盘，不吸附。 */
  const finishSession = (): void => {
    const active = session
    if (active === null) return
    const win = hostWindow()
    if (win !== null) detachPointer(win)
    session = null
    if (active.kind === 'drag') {
      if (moved) {
        snapMiniBarToEdge(formSize(viewport), viewport)
        persistMiniBarState()
      }
    } else {
      persistMiniBarState()
      // 拖边期间 ResizeObserver 让位：松手后按实际尺寸补一次对账，内容高度变了也不溢出。
      clampMiniBarIntoViewport(formSize(viewport), viewport)
    }
    publish()
  }

  function onPointerUp(event: PointerEvent): void {
    const active = session
    if (active !== null && active.id !== event.pointerId) return
    finishSession()
  }

  function onPointerMove(event: PointerEvent): void {
    const active = session
    if (active === null || active.id !== event.pointerId) return
    // 指针移出窗口后松手时 `pointerup` 不再投递：按位掩码归零就是「键已经松了」。
    if (event.buttons === 0) {
      onPointerUp(event)
      return
    }
    if (active.kind === 'drag') {
      const dx = event.clientX - active.startX
      const dy = event.clientY - active.startY
      if (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD) moved = true
      if (!moved) return
      // 拖动帧不落 localStorage（同步 I/O × 60fps）；松手时统一落盘。
      setMiniBarCenter(active.startCx + dx, active.startCy + dy, active.size, viewport, false)
      return
    }
    const state = miniBarStore.get()
    const dragged = frameFromDrag(
      active.edge, active.start,
      event.clientX - active.startX, event.clientY - active.startY, viewport,
    )
    // 没拖的那一轴保留**意图**：呈现尺寸可能被视口夹小了，拿它回写会把用户定的大尺寸悄悄改小。
    const frame: MiniBarFrame = {
      ...dragged,
      width: active.edge === 'bottom' ? (state.w ?? dragged.width) : dragged.width,
      height: active.edge === 'left' || active.edge === 'right' ? (state.h ?? dragged.height) : dragged.height,
    }
    setMiniBarFrame(frame, viewport, false)
  }

  const startSession = (next: PointerSession): void => {
    const win = hostWindow()
    if (win === null) return
    if (session !== null) detachPointer(win)
    session = next
    if (next.kind === 'drag') moved = false
    attachPointer(win)
    publish()
  }

  return {
    snapshot: () => snap,

    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },

    attach: (el) => {
      if (el === root) return
      root = el
      observer?.disconnect()
      observer = null
    },

    connect: () => {
      const win = hostWindow()
      if (win === null) return () => {}
      const onResize = (): void => {
        const next = readViewport()
        // 上一帧贴齐的边继续贴新视口，自由位置只夹不漂。
        followFlushEdgesOnResize(formSize(next), viewport, next)
        viewport = next
        publish()
      }
      win.addEventListener('resize', onResize)
      // 观察对象是根节点：浮窗随会话出现 / 退场，根换了就要换观察者。
      if (root !== null && typeof ResizeObserver !== 'undefined') {
        observer = new ResizeObserver(() => {
          // 拖边期间尺寸的主人是那次指针会话：二次夹取会把对边锚定拽偏。
          if (session?.kind === 'resize') return
          clampMiniBarIntoViewport(formSize(viewport), viewport)
        })
        observer.observe(root)
      }
      // 会话可能跨过这条 effect 的重跑（活跃状态变了）：重新接上指针监听，别让拖到一半的手势失聪。
      if (session !== null) attachPointer(win)
      return () => {
        win.removeEventListener('resize', onResize)
        observer?.disconnect()
        observer = null
        detachPointer(win)
      }
    },

    beginDrag: (handle, event) => {
      const target = event.target instanceof Element ? event.target : null
      if (target === null) return
      // 只在指定拖面（`data-drag="1"`）上起手；嵌在拖面里的真控件（如「看全文」）不算。
      // `handle` 必须就是挂 `data-drag` 的那个元素（调用点交 `event.currentTarget`）：拿外层容器当
      // handle 会因「最近的拖面不是自己」不起手——刻意的，嵌套拖面归内层。
      if (target.closest('[data-drag="1"]') !== handle) return
      const control = target.closest<HTMLElement>('button, input, [role="button"], a[href]')
      if (control !== null && control !== handle) return
      // 起手基准取实际中心：缺省轴在这里解析成数字，拖动的每一帧才跟得上手。
      const size = formSize(viewport)
      const center = miniBarCenterOf(miniBarStore.get(), size, viewport)
      startSession({
        kind: 'drag',
        id: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startCx: center.x,
        startCy: center.y,
        size,
      })
    },

    beginResize: (edge, event) => {
      const size = formSize(viewport)
      const center = miniBarCenterOf(miniBarStore.get(), size, viewport)
      startSession({
        kind: 'resize',
        id: event.pointerId,
        edge,
        startX: event.clientX,
        startY: event.clientY,
        start: { width: size.width, height: size.height, cx: center.x, cy: center.y },
      })
    },

    clearMoved: () => { moved = false },
    moved: () => moved,
    reconcile: () => { clampMiniBarIntoViewport(formSize(viewport), viewport) },
    moveCenterBy: (dx, dy) => {
      const size = formSize(viewport)
      const center = miniBarCenterOf(miniBarStore.get(), size, viewport)
      setMiniBarCenter(center.x + dx, center.y + dy, size, viewport)
    },
  }
}
