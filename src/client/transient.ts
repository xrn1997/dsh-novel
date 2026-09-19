import { useSyncExternalStore } from 'react'
import { createStore, useStore } from './store.js'

/**
 * 全局瞬态状态层（「全局状态条」；口径详见 `docs/design/client.md`）：
 * 设置界面此前把「保存中/成功/失败」散在七个位置——行内插行、选中条旁 jobError、
 * 危险区旁 delError、导入区底部 submitError、登录面板 msg、顶部任务条、区块 meta，
 * 同一语义（失败）有三种长相。本层把瞬态统一收进一个有序条目队列，由全局状态条呈现：
 * - `pending` 进行中：settle 即移除，多条聚合计数展示；
 * - `ok` 成功：**少而淡**——单行开关翻转本身即成功反馈不进条，显式保存类才进条，
 *   TTL 自动退场；**批量写口例外**（2026-09）：列表 642 行带分页与过滤，被改的那几行
 *   可能在屏幕外，"看见开关翻了"这个前提不成立，故批量启停/删除要补一条确认；
 * - `error` 错误：sticky 手动 dismiss；携带 `anchor`（CSS 选择器）供条目「定位」跳转
 *   + 行内装饰标记（.row-err 红左边）——调和「点击位置即反馈位置」原则：
 *   行内从内容层降为装饰层，文案全部归条。
 * 模块级 store（routeStore 同款模式）：重开设置不丢错误。通用层：本次只接设置界面，
 * 书架/搜索的散落状态（delError/importError/searchError）服务于场景内重试，后续按需接入。
 */

export type TransientKind = 'pending' | 'ok' | 'error'

export interface TransientEntry {
  id: number
  kind: TransientKind
  label: string
  /** 出错对象锚点（CSS 选择器，如 `[data-novel-source-row="x"]`）：定位跳转 + 行内标记共用 */
  anchor?: string
}

const store = createStore<{ entries: TransientEntry[] }>({ entries: [] })
let nextId = 1

/** 成功条自动退场时长 */
const OK_TTL_MS = 2500
const timers = new Map<number, ReturnType<typeof setTimeout>>()

export function useTransient(): { entries: TransientEntry[]; dismiss: (id: number) => void } {
  const { entries } = useStore(store)
  return { entries, dismiss }
}

/** 行内装饰层用的布尔 selector：useSyncExternalStore 快照是原始值——条目变化只唤醒
 *  快照翻转的行（642 行列表逐条订阅，全量重渲染不可接受）。SSR 快照 false（无标记）。 */
export function useTransientFlag(match: (e: TransientEntry) => boolean): boolean {
  return useSyncExternalStore(store.subscribe, () => store.get().entries.some(match), () => false)
}

/** 非 React 读口（测试/调试） */
export function transientEntries(): TransientEntry[] { return store.get().entries }

function push(kind: TransientKind, label: string, anchor?: string): number {
  const id = nextId++
  store.set({ entries: [...store.get().entries, { id, kind, label, anchor }] })
  return id
}

function remove(id: number): void {
  const t = timers.get(id)
  if (t !== undefined) { clearTimeout(t); timers.delete(id) }
  const { entries } = store.get()
  if (entries.some((e) => e.id === id)) store.set({ entries: entries.filter((e) => e.id !== id) })
}

export function pushError(label: string, anchor?: string): number { return push('error', label, anchor) }

export function dismiss(id: number): void { remove(id) }

/** 显式保存类成功（少而淡策略）：TTL 自动退场 */
export function pushOk(label: string): number {
  const id = push('ok', label)
  timers.set(id, setTimeout(() => remove(id), OK_TTL_MS))
  return id
}

/** 进行中：返回结算句柄（幂等）。settle() 收工；settle(errText) 移除 pending 并转错误进条。
 *  **当前无生产消费者**（单源启停故意不进泳道，见 toggle-feedback.ts 头注）——保留为
 *  通用层能力（本层「本次只接设置界面，后续按需接入」，见文件头注），不是死码；直测在 transient.test.ts。 */
export function pushPending(label: string, anchor?: string): (errorText?: string) => void {
  const id = push('pending', label, anchor)
  let settled = false
  return (errorText) => {
    if (settled) return
    settled = true
    remove(id)
    if (errorText !== undefined) pushError(errorText, anchor)
  }
}

/** 测试专用：清空队列与定时器（模块级 store 会跨用例残留） */
export function resetTransient(): void {
  for (const t of timers.values()) clearTimeout(t)
  timers.clear()
  store.set({ entries: [] })
}
