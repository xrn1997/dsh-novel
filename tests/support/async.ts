/**
 * 异步用例的两种最小等待：手动落定的 promise 与让事件循环走一圈。
 *
 * 收成一份的理由是两份都被抄过多次：`deferred` 在阅读会话与注释面板各有一份（一份多 reject、
 * 一份少），`tick` 在后台上限套件里各写一遍且 0ms / 5ms 混用——同名 helper 只差一个数，
 * 读的人却得逐份确认没别的差别。
 */

/** 手动落定的 promise：竞态用例用它把「响应还在途」变成一个可编程的时点。 */
export interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

/** 造一个可手动 resolve / reject 的 promise。 */
export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

/** 让出事件循环一轮；0ms 只等已排队的定时器与 promise 链落定，需要让真实 I/O 跑完的套件显式给毫秒。 */
export function tick(ms = 0): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}
