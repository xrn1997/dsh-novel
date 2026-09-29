import { pushError } from './transient.js'

/** 启停反馈只需要错误入口——依赖束的最小投影（测试注入假 pushError 即可断言进条语义） */
export interface ToggleFeedbackDeps {
  pushError: typeof pushError
}

/**
 * 单源启停的瞬态反馈策略。
 *
 * 病根：状态条原是**流内**元素，挂上就把下面内容顶下去再弹回（逐帧实测 +35px / 每次启停 2 条
 * layout-shift），而单源启停往返只 13~20ms ≈ 1 帧——用户看到的就是「一帧下沉回弹」的闪烁。
 *
 * 策略：**秒级乐观操作不进泳道**。行内已有在途装饰（开关降透明 + wait + title「保存中…」），
 * 只有**失败**才进 error 泳道（带行锚点 = 全局条「定位 →」+ 行内红边）。这与瞬态层「ok 少而淡
 * ——开关翻转本身即反馈」是同一条原则的延伸。配套第二半修复在 styles.tsx：状态条改成不吃布局的
 * 浮层。抽成纯函数是 client 惯例：策略可单测，视图只做接线。口径详见 `docs/design/client.md`。
 */
export interface ToggleFeedback {
  /** 请求在途：**零占用**（不进泳道——挂载即顶动布局，秒级操作会闪） */
  inFlight(): void
  /** 收工：成功静默（开关已翻转即反馈）；失败进 error 泳道并挂行锚点 */
  settle(ok: boolean, failureText?: string): void
}

/** 单源启停的行锚点（error 条目「定位 →」与行内红边共用同一个选择器） */
export function rowAnchorOf(id: string): string {
  return `[data-novel-source-row="${id}"]`
}

export function toggleFeedback(anchor: string, deps: ToggleFeedbackDeps = { pushError }): ToggleFeedback {
  return {
    inFlight(): void {
      // 故意留空：这里**不许** pushPending（挂上就顶动设置区布局 → 闪烁，见文件头注）
    },
    settle(ok: boolean, failureText?: string): void {
      if (ok) return
      deps.pushError(failureText ?? '启停失败', anchor)
    },
  }
}
