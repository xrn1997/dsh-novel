import { useSyncExternalStore } from 'react'
import { ls } from './util.js'

/** 轻量 store（useSyncExternalStore 驱动）：业务数据不进 store——每次挂载经 api 拉取，组件内 useState 持有。 */
export interface Store<T> {
  get(): T
  set(patch: Partial<T>): void
  subscribe(cb: () => void): () => void
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

// ── 路由（view 内路由，无 URL 路由）─────────────────────────────
// 五成员（2026 IA 变更，用户拍板）：书架/书城/书源管理是小说视图内**并列 tab**——
// 选择即切换下方内容；书源管理 = 原宿主设置「小说」区块整体（settings.section 注册已撤，
// 单一归属）。reader/search 是 tab 之下的沉浸内容流，各有自己的返回导航，顶部 tab 不随行。
export type Route =
  | { name: 'shelf' }
  | { name: 'city' }
  | { name: 'sources' }
  | { name: 'reader'; sourceId: string; bookKey: string; title: string }
  | { name: 'search'; keyword?: string }

export const routeStore = createStore<{ route: Route }>({ route: { name: 'shelf' } })
export function navigate(route: Route): void { routeStore.set({ route }) }

// ── 阅读偏好（localStorage 持久；进度不进 prefs——进度归服务端 shelf）──────

export interface Prefs { fontSize: number; lineHeight: number; measure: number; paperColor: string; darkController: boolean }
/** measure = 正文列宽（em，随字号缩放）——36em ≈ 中文 36 字/行，是舒适区上沿；
 *  它是「值槽」的实际值：行内只写 --novel-measure，规则住在样式层（同 --novel-pct 一路）。 */
export const DEFAULT_PREFS: Prefs = { fontSize: 18, lineHeight: 1.8, measure: 36, paperColor: '#f7f3e8', darkController: false }
const PREFS_KEY = 'dsh-novel.prefs'

// ls（localStorage guard）已迁 util.ts（它不是 store 的一部分）

function loadPrefs(): Prefs {
  try {
    const raw = ls.getItem(PREFS_KEY)
    if (raw === null) return DEFAULT_PREFS
    const parsed = JSON.parse(raw) as Partial<Prefs>
    return { ...DEFAULT_PREFS, ...parsed }
  } catch {
    return DEFAULT_PREFS
  }
}

export const prefsStore = createStore<Prefs>(loadPrefs())
export function setPref(patch: Partial<Prefs>): void {
  const next = { ...prefsStore.get(), ...patch }
  prefsStore.set(next)
  ls.setItem(PREFS_KEY, JSON.stringify(next))
}

// ── 书城现场（会话内；不落盘）────────────────────────────────────

/** 书城的会话内现场：记住上次逛的源与分类（**不落盘**——它是交互现场，不是用户偏好；落盘会引入
 *  一份新的持久状态面，收益不抵成本）。空 = 还没选过，由视图回落可选源的第一项与其第一个分类。
 *  浏览轴收成按源后现场多了一根轴：源失效（禁用/删掉）时视图回落第一项并改写这里，不留指向
 *  不存在源的选中态。 */
export const cityStore = createStore<{ sourceId: string | null; kind: string | null }>({ sourceId: null, kind: null })
