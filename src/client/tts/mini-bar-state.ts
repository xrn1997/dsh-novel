import { createStore } from '../store.js'
import { ls } from '../util.js'

/**
 * 浮窗现场（`ADR-0073`）：两个完整形态共享同一块位置，位置是**块中心坐标**。
 *
 * 现场只有三件事：横向中心 `cx`、纵向中心 `cy`（各自 `null` = 用缺省，横向贴右缘 / 纵向居中）
 * 与当前是否收起。拖动两轴跟手，松手时离视口边够近（≤ 24px）的边才贴齐；不再有「永远贴边」
 * 这个约束——用户可以把浮窗停在正文中间，只在想要贴边时贴边。
 *
 * 记中心而不记左上角，是为了同一锚点切换形态时视觉中心不跳：收起 208×44、展开缺省 320×200
 * （可拖，范围见 `ADR-0080`），夹取与吸附都只需减半个尺寸。`side` 不是现场字段，而是按 `cx` 与视口宽**派生**出来的
 * 呈现方向（设置弹层展开方向），由 `deriveMiniBarSide` 一处定义。
 *
 * 落位的几何判据也住这里：`miniBarCenterOf` 是缺省轴解析的唯一住址，`miniBarLayout` 一次给全
 * 行内落位样式与 `side` / `flush` 两个派生——视图只消费读数，不再自己拼缺省值，样式层不给缺省定位。
 */
export type MiniBarSide = 'left' | 'right'

export interface Size { width: number; height: number }

export interface Viewport { width: number; height: number }

/** 块中心的实际读数：缺省轴已解析成数字。几何原语内部都用它，避免各处重复写 `?? 缺省`。 */
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

export const DEFAULT_MINI_BAR: MiniBarState = {
  cx: null, cy: null, w: null, h: null, collapsed: true,
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function collapsedOf(value: unknown): boolean {
  return typeof value === 'boolean' ? value : DEFAULT_MINI_BAR.collapsed
}

/**
 * 读一份落盘现场：只认当前形状（`cx`/`cy`/`w`/`h`/`collapsed`）。认不出的一律回缺省，不猜；
 * 两轴尺寸各认各的——单轴非法只丢那一轴。
 * 键由听书面引入，没有已发布版本写过旧形状——不为从未存在的落盘格式保留迁移分支。
 */
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

/** 贴上那条边的容差（px）：吸附落位写的是精确的 `halfW` / `view.width - halfW`，
 *  夹取与视口变化可能留下不到半像素的缝——缝比它小就算贴上，样式层才不会被亚像素抖动切掉边框。 */
const FLUSH_EPS = 0.5

/**
 * 块**真的**贴着哪一条竖边（`ADR-0073` 的自由落位之后，这件事不能再由 `side` 代答）：
 * `side` 按中心在左右半屏派生，说的是「朝向哪边」；贴边形态（收掉靠屏幕那一条边框、那两侧改直角）
 * 说的是「有没有碰上屏幕」。两者只在 docked 时同向——块停在正文中间时按 `side` 收边框，
 * 就是在一条悬空的边上留下敞口：没有描边、两个直角，阴影从缺口漏出去，展开态整块读起来像坏了。
 * 缺省的那一轴（没落过位）由 `miniBarCenterOf` 解析成贴右缘，因此算 `right`。
 */
export function deriveMiniBarFlush(state: MiniBarState, size: Size, view: Viewport): MiniBarFlush {
  const cx = miniBarCenterOf(state, size, view).x
  const leftGap = cx - size.width / 2
  const rightGap = view.width - (cx + size.width / 2)
  if (leftGap <= FLUSH_EPS && leftGap <= rightGap) return 'left'
  if (rightGap <= FLUSH_EPS) return 'right'
  return 'none'
}

/**
 * 当前形态的实际尺寸：量得到就用量到的（展开态内容变化 / 用户拖边都会改尺寸，拿常量算贴底
 * 会留一条缝），量不到回现场解析：收起回胶囊常量，展开回带夹取的呈现尺寸。
 */
export function resolveFormSize(
  collapsed: boolean, rect: { width: number; height: number } | null, state: MiniBarState, view: Viewport,
): Size {
  if (rect !== null && rect.width > 0 && rect.height > 0) {
    return { width: rect.width, height: rect.height }
  }
  return collapsed ? CAPSULE_SIZE : resolvedMiniBarSize(state, view)
}

/** 一次给全的落位派生：行内样式（恒写解析后的像素值，缺省轴也算在内）+ 两个各管一事的读数。
 *  尺寸走**值槽**进样式层（`--novel-tts-panel-w/-h`）：样式层只读变量，尺寸的判据不落第二处。 */
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
 * 根节点的落位样式与派生读数，一次给全。为什么缺省轴也在这里解析成像素：
 * 缺省的贴右缘与落过位的 `left` 是两套坐标系，同一轴两个主人在换形态、换视口时会互相打架；
 * 解析成同一组像素后，视图不分「有没有落过位」，样式层也不再需要一条缺省定位规则。
 *
 * 像素基准是 `window.innerWidth` / `innerHeight`（与 `useViewport` 的读数同源，吸附与夹取也吃它）：
 * 有经典滚动条的根文档里它与包含块差一条滚动条宽。基准只此一条——别把 CSS 包含块基准混进来
 * 当第二把尺（样式层已不再定位浮窗）。
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
      // 收起态的固定尺寸也走值槽：胶囊与边栏的尺寸来源因此对称（都从这份读数进 CSS），
      // 样式层不再写死 208×44 的第二份抄本（`ADR-0080`）。
      '--novel-tts-capsule-w': `${CAPSULE_SIZE.width}px`,
      '--novel-tts-capsule-h': `${CAPSULE_SIZE.height}px`,
    },
    side: deriveMiniBarSide(state, view.width),
    flush: deriveMiniBarFlush(state, size, view),
  }
}

/** 设置弹层内容高的回退档（六行设置 ≈ 320px）：量不到实测高（无布局宿主 / 弹层还没挂上）
 *  才用它。真判据是「内容实测高与 60vh 取小」——实测值由组件经 `ResizeObserver` 量出来传给
 *  `miniBarPopoverFlip` / `miniBarPopoverRoom`，这个常量只是没有几何可量时的降级。 */
const POPOVER_CONTENT_MAX = 320

/** 弹层与边栏之间的那条间距（样式层的 `--novel-sp-2`）：够不够地方要把它一起算。 */
const POPOVER_GAP = 6

/** 弹层与视口边之间的留白（样式层的 `--novel-sp-3`）：卡片收到现量余量时贴到屏幕上沿 / 下沿，
 *  没有这条缝，裁切处读作「卡片坏了」；留一条缝才读作「卡片到边了，里面可滚」。 */
const POPOVER_VIEWPORT_GAP = 8

/**
 * 弹层落位的唯一算式：往哪边开（`below`）与那一侧的可用余量（`room`）。
 *
 * 方向判据：上方优先（设置卡在条上方展开）；上方放不下才翻到下方；**下方得真的更有地方
 * 才翻**——只写「上方放不下就翻下方」会在块贴近底部时翻进一条更窄、甚至为负的缝里
 * （上方 500、下方 0，翻下去等于把卡片藏起来）。两侧一样大（缺省纵向居中）时留在上方。
 *
 * 余量也要一起给：只判方向不收高度，卡片会整块探出视口——浮层挂在 fixed 的 dock 上，页面
 * 不滚，探出去的那几行既看不见也滚不到。`room` 就是弹层 `max-height` 的上界（值槽
 * `--novel-tts-popover-room`，已扣掉与视口边的那条留白），放不下时卡片自己内部滚动。
 *
 * `contentHeight` 是组件实测的内容高（`null` / 缺席 = 量不到，回退 `POPOVER_CONTENT_MAX`）；
 * 弹层自身还有 `max-height: 60vh`，所以真占位是它和 60vh 里小的那一档。判据跟着现场走而不是
 * 开层那一刻算一次——弹层开着仍可拖头行、按方向键挪块、缩窗口，而视口夹取只管浮窗本体、
 * 不管它的次要浮层，快照会把弹层永远留在屏外。
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
  // 相等时留在上方：缺省纵向位置居中，两侧一样大，而设置卡是「在条上方展开」的那一档；
  // 只有下方真的更大才值得翻过去（翻进更窄的一侧只会让卡片更矮、更该滚）。
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

/** 拖边可拖的四条边：顶边不做把手——顶行是移动 / 收起面（`ADR-0080`）。边名 union 由这份清单
 *  推导，样式带的渲染、光标分叉与几何门读数都从这一份起手，不写第二份。 */
export const MINI_BAR_EDGES = ['left', 'right', 'bottom', 'corner'] as const
export type MiniBarEdge = (typeof MINI_BAR_EDGES)[number]

/** 一次拖边会话的起手框：尺寸 + 中心，后续帧只在它上面加位移。 */
export interface MiniBarFrame { width: number; height: number; cx: number; cy: number }

function clampSize(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * 拖边一帧：**对边（对角）锚定**——拖右边时左缘不动，拖下边时顶缘不动，角上两轴同时；
 * 每轴夹进范围，最后把中心夹回视口。返回值即新框，不发动作（落位由调用方 `setMiniBarFrame`）。
 */
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

/** 写一帧拖边结果：宽高进现场（意图），中心按**呈现尺寸**夹取；拖动帧传 `persist = false`。
 *  中心用呈现尺寸而不是意图尺寸：意图可能暂时大于视口，拿它夹取会把块推出屏幕。 */
export function setMiniBarFrame(frame: MiniBarFrame, view: Viewport, persist = true): void {
  const width = clampSize(frame.width, MIN_MINI_BAR_SIZE.width, MAX_MINI_BAR_SIZE.width)
  const height = clampSize(frame.height, MIN_MINI_BAR_SIZE.height, MAX_MINI_BAR_SIZE.height)
  const current = miniBarStore.get()
  const rendered = resolvedMiniBarSize({ ...current, w: width, h: height }, view)
  const center = clampCenter({ x: frame.cx, y: frame.cy }, rendered, view)
  commit({ cx: center.x, cy: center.y, w: width, h: height, collapsed: current.collapsed }, persist)
}

/** 拖动中的每一帧只更新现场（`setMiniBarCenter` 的 `persist=false`），松手时才落盘：
 *  localStorage 是同步 I/O，60fps 逐帧写会把拖动拖成掉帧。键盘移动等低频动作照旧即时落盘。 */
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
 * 拖动起手、键盘移动、吸附、夹取、落位样式与弹层翻转都从这里取实际中心——判据散到第二处，
 * 就是两份各写各的缺省值，换形态或换视口时两边对不上。
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

/** 拖到哪里落哪里：双轴夹在视口内，拖动中的每一帧都走这里（缺省轴由调用方解析成数字）。
 *  `persist=false` = 拖动中的帧，松手时由调用方调 `persistMiniBarState` 落盘。 */
export function setMiniBarCenter(x: number, y: number, size: Size, view: Viewport, persist = true): void {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return
  const center = clampCenter({ x, y }, size, view)
  const current = miniBarStore.get()
  commit({ cx: center.x, cy: center.y, w: current.w, h: current.h, collapsed: current.collapsed }, persist)
}

/**
 * 夹取后写回现场：缺省轴（`null`）在夹取前后都等于缺省位置时不写坐标，
 * 让「没拖过」这个事实一直成立——`miniBarLayout` 才能继续按缺省解析它，视口变化也不会被钉死成旧数字。
 */
function commitCenter(center: Center, size: Size, view: Viewport, state: MiniBarState): void {
  const clamped = clampCenter(center, size, view)
  // 缺省轴的比较基准也走缺省轴的住址：夹取后仍停在缺省位置就保持 null
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

/**
 * 视口变化：上一帧贴齐的边继续贴新视口（贴右缘的浮窗拉大窗口后不该悬在原地），
 * 自由位置只夹不漂。缺省轴（`null`）不参与——它本来就跟着视口走，写死成数字反而会钉在旧中心。
 */
export function followFlushEdgesOnResize(size: Size, prev: Viewport, view: Viewport): void {
  const state = miniBarStore.get()
  if (state.cx === null && state.cy === null) return
  const halfW = size.width / 2
  const halfH = size.height / 2
  // 贴边判据与 `deriveMiniBarFlush` 同一把尺（FLUSH_EPS 容差）：吸附写的是精确像素，但夹取、
  // 亚像素缩放与浮点运算都可能留下不到半像素的缝，拿 `=== 0` 判会让贴着的边不再跟视口走。
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