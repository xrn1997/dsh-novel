/** 本仓的客户端本地 store 只要 get/set(patch)/subscribe 三原语与稳定通知时机，自己持表而不是接宿主的
 *  store 引擎（`ADR-0055`）。 */
import { useCallback, useRef, useSyncExternalStore } from 'react'
import { ls, normalizeHex } from './util.js'

/** 轻量 store：只承担**跨卸载要活下来**的现场——视图内路由、偏好、列表筛选与勾选、任务镜像、瞬态队列。
 *  业务真相仍在服务端；唯一例外是书架的读取面与落架账升格成面板期投影（`panel-shelf.ts`，`ADR-0046`）。 */
export interface Store<T> {
  // 三格写成属性而非方法简写：它们是**可拆开传递**的裸函数，方法简写会带一个隐式 this。
  get: () => T
  set: (patch: Partial<T>) => void
  subscribe: (cb: () => void) => () => void
}

export function createStore<T extends object>(initial: T): Store<T> {
  let state = initial
  const listeners = new Set<() => void>()
  return {
    get: () => state,
    set: (patch) => { state = { ...state, ...patch }; for (const cb of [...listeners]) cb() },
    subscribe: (cb) => { listeners.add(cb); return () => { listeners.delete(cb) } },
  }
}

export function useStore<T extends object>(store: Store<T>): T {
  // 第三参 = getServerSnapshot：renderToString（smoke/SSR）必需，缺了直接抛
  return useSyncExternalStore(store.subscribe, store.get, store.get)
}

/** 窄订阅：只把一格原语投影出来（`ADR-0055`）。高频写的 store 整店订阅会拖无关子树一起重渲；选择器
 *  只认原语——`useSyncExternalStore` 按引用比快照，每次新建对象或数组就是自旋。 */
export function useStoreValue<T extends object, V extends string | number | boolean | null>(
  store: Store<T>,
  select: (state: T) => V,
): V {
  // 选择器每次渲染都是新闭包：用 ref 跟进最新闭包、用 useCallback 稳定 getSnapshot 身份，否则每次退订重订。
  const selectRef = useRef(select)
  selectRef.current = select
  const read = useCallback(() => selectRef.current(store.get()), [store])
  return useSyncExternalStore(store.subscribe, read, read)
}

// 五成员：书架/书城/书源管理是小说视图内**并列 tab**；书源管理 = 宿主设置「小说」区块整体。
// reader/search 是 tab 之下的沉浸内容流：顶部 tab 不随行，返回固定落书架。
export type ViewRoute =
  | { name: 'shelf' }
  | { name: 'city' }
  | { name: 'sources' }
  | { name: 'reader'; sourceId: string; bookKey: string; title: string }
  | { name: 'search'; keyword?: string }

export const routeStore = createStore<{ route: ViewRoute }>({ route: { name: 'shelf' } })
export function navigate(route: ViewRoute): void { routeStore.set({ route }) }

// ── 阅读偏好（localStorage 持久；进度不进 prefs——进度归服务端 shelf）──────

export type ReadingMode = 'scroll' | 'page' | 'moyu'
export type MoyuStyle = 'dsh' | 'compact' | 'clean'
export type MoyuReveal = 'stream' | 'instant'
export type PageAnimation = 'flip' | 'slide' | 'none'
export type PageColumns = 'auto' | 'single' | 'double'

export interface Prefs {
  fontSize: number
  lineHeight: number
  measure: number
  paperColor: string
  customPaperColor: string | null
  darkController: boolean
  readingMode: ReadingMode
  lastNormalMode: 'scroll' | 'page'
  moyuStyle: MoyuStyle
  moyuReveal: MoyuReveal
  pageAnimation: PageAnimation
  pageColumns: PageColumns
}
/** measure = 正文列宽（固定 px，与字号解耦）：行内只写 --novel-measure，规则住样式层。 */
export const DEFAULT_PREFS: Prefs = {
  fontSize: 18,
  lineHeight: 1.8,
  measure: 680,
  paperColor: '#f7f3e8',
  customPaperColor: null,
  darkController: false,
  readingMode: 'scroll',
  lastNormalMode: 'scroll',
  moyuStyle: 'dsh',
  moyuReveal: 'stream',
  pageAnimation: 'flip',
  pageColumns: 'auto',
}
const PREFS_KEY = 'dsh-novel.prefs'

const LEGACY_MEASURE_EM_TO_PX: Record<number, number> = {
  28: 520,
  32: 600,
  36: 680,
  44: 820,
}
const MIN_MEASURE_PX = 320
const MAX_MEASURE_PX = 1400

/** 规范化并迁移栏宽偏好：旧版 em 档位（28/32/36/44）与其余小数值按 18px 基准换算成固定 px，并夹在合法区间内。 */
export function normalizeMeasure(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return DEFAULT_PREFS.measure
  const rounded = Math.round(v)
  const legacy = LEGACY_MEASURE_EM_TO_PX[rounded]
  if (legacy !== undefined && v === rounded) return legacy
  const px = v <= 100 ? Math.round(v * 18) : rounded
  return Math.max(MIN_MEASURE_PX, Math.min(MAX_MEASURE_PX, px))
}

function isReadingMode(v: unknown): v is ReadingMode {
  return v === 'scroll' || v === 'page' || v === 'moyu'
}

function isNormalMode(v: unknown): v is 'scroll' | 'page' {
  return v === 'scroll' || v === 'page'
}

function isMoyuStyle(v: unknown): v is MoyuStyle {
  return v === 'dsh' || v === 'compact' || v === 'clean'
}

function isMoyuReveal(v: unknown): v is MoyuReveal {
  return v === 'stream' || v === 'instant'
}

function isPageAnimation(v: unknown): v is PageAnimation {
  return v === 'flip' || v === 'slide' || v === 'none'
}

function isPageColumns(v: unknown): v is PageColumns {
  return v === 'auto' || v === 'single' || v === 'double'
}

function parseCustomPaperColor(v: unknown): string | null {
  return typeof v === 'string' ? normalizeHex(v) : null
}

function loadPrefs(): Prefs {
  try {
    const raw = ls.getItem(PREFS_KEY)
    if (raw === null) return DEFAULT_PREFS
    const parsed = JSON.parse(raw) as Partial<Prefs>
    const readingMode = isReadingMode(parsed.readingMode) ? parsed.readingMode : DEFAULT_PREFS.readingMode
    const lastNormalMode = readingMode === 'moyu'
      ? (isNormalMode(parsed.lastNormalMode) ? parsed.lastNormalMode : DEFAULT_PREFS.lastNormalMode)
      : readingMode
    return {
      ...DEFAULT_PREFS,
      ...parsed,
      measure: normalizeMeasure(parsed.measure),
      customPaperColor: parseCustomPaperColor(parsed.customPaperColor),
      readingMode,
      lastNormalMode,
      moyuStyle: isMoyuStyle(parsed.moyuStyle) ? parsed.moyuStyle : DEFAULT_PREFS.moyuStyle,
      moyuReveal: isMoyuReveal(parsed.moyuReveal) ? parsed.moyuReveal : DEFAULT_PREFS.moyuReveal,
      pageAnimation: isPageAnimation(parsed.pageAnimation) ? parsed.pageAnimation : DEFAULT_PREFS.pageAnimation,
      pageColumns: isPageColumns(parsed.pageColumns) ? parsed.pageColumns : DEFAULT_PREFS.pageColumns,
    }
  } catch {
    return DEFAULT_PREFS
  }
}

export const prefsStore = createStore<Prefs>(loadPrefs())
export function setPref(patch: Partial<Prefs>): void {
  const current = prefsStore.get()
  const next = { ...current, ...patch }
  if (patch.readingMode === 'scroll' || patch.readingMode === 'page') next.lastNormalMode = patch.readingMode
  if (patch.readingMode === 'moyu') next.lastNormalMode = current.lastNormalMode
  prefsStore.set(next)
  ls.setItem(PREFS_KEY, JSON.stringify(next))
}

// ── 书城现场（会话内；不落盘）────────────────────────────────────

/** 书城的会话内现场：记住上次逛的源与分类（**不落盘**——交互现场不是用户偏好）。空 = 还没选过，
 *  由视图回落第一项；源失效时视图回落第一项并改写这里，不留指向不存在源的选中态。 */
export const cityStore = createStore<{ sourceId: string | null; kind: string | null }>({ sourceId: null, kind: null })
