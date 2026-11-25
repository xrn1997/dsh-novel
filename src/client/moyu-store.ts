import { createStore } from './store.js'

/**
 * 摸鱼模式的在场位：一个布尔 store。工具条的摸鱼钮与全屏舞台（MoyuStage）共读共写，
 * 阅读器视图本身不感知它——Stage 内部读 store 决定渲染，挂接行零逻辑。
 * 离开阅读器（面板切走）不自动关：用户 Esc / 退出钮才关；重进阅读器恢复在场态。
 */
export interface MoyuState {
  readonly on: boolean
}

export const moyuStore = createStore<MoyuState>({ on: false })

export function openMoyu(): void {
  moyuStore.set({ on: true })
}

export function closeMoyu(): void {
  moyuStore.set({ on: false })
}

export function toggleMoyu(): void {
  moyuStore.set({ on: !moyuStore.get().on })
}
