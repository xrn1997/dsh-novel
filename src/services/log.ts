/** 日志缝：`[dsh-novel]` 前缀与级别出口的唯一家。
 *
 *  立缝前，每个留痕点各自手写前缀、一律 console、不带级别——宿主日志面一条都收不到，前缀口径
 *  还散成多处抄本（改一次措辞要追所有调用点）。这里只留一个出口，配两个 adapter：
 *  - **缺省 console**：离线、测试、以及组合根尚未装 adapter 的那段窗口，日志照样看得见；
 *  - **运行时复合 adapter**（组合根经 `setLogSink` 装上）：console 腿保本机可见性，宿主
 *    `ctx.logger` 腿进 ring buffer 供启动诊断。但宿主 exporter 的缺省级别阈值
 *    （`LoggerLevel.INFO = 1`）只放行 error/info——warn/debug 被滤掉（要让 warn 进得去得另设
 *    levels/level），而 logger 只进 ring buffer、stdout 要另挂 console exporter 插件才出得来。
 *    所以只走 logger 那条腿会吞掉本批的 warn 级留痕、又把本机 stdout 做暗——console 腿保可见性、
 *    不是冗余，各管一个去向。组合根 dispose 时把 sink 复位回 console（模块级单点不能指向
 *    已卸载实例的 logger）。
 *
 *  引擎层不 import 本模块（依赖方向：engine 不认识 services）：沙箱那条未处理 rejection 防线
 *  拿注入 sink，前缀归注入方；缺省 sink 自己缀一次，保证离线直用引擎时读数仍认得出是谁家的日志。 */
export interface LogSink {
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

let sink: LogSink = console

export function setLogSink(next: LogSink): void { sink = next }

export const log = {
  info: (...args: unknown[]): void => { sink.info('[dsh-novel]', ...args) },
  warn: (...args: unknown[]): void => { sink.warn('[dsh-novel]', ...args) },
  error: (...args: unknown[]): void => { sink.error('[dsh-novel]', ...args) },
}
