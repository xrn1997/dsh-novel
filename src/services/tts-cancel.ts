/**
 * 听书链的取消理由：**作废不是故障**，拒绝理由要原样交回调用方（`ADR-0082`）。
 *
 * `AbortSignal.reason` 是 `any`（规范允许任意值），而 Promise 的拒绝理由与本仓「原话借来看」
 * 都只认 `Error`：是 Error 就原样交回（调用方给的就是那个对象），不是也包成 `Error`——类型不泄、
 * 原话不丢。两支合成（HTTP 出站与宿主朗读服务）都从这一个出口取理由：三处各包一次的写法会让
 * 「取消时抛什么」长出第二个口径。
 */
export function abortReasonOf(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  return reason instanceof Error ? reason : new Error(String(reason))
}