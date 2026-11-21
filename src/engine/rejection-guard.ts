/**
 * 进程级未处理 rejection 防线：**只收沙箱 realm 的 promise**，非沙箱来源交回宿主。单独成 module 因为它是进程
 * 全局生命周期（监听器装/摘、订阅计数、从 argv / NODE_OPTIONS 读宿主策略），与「脚本怎么求值」是两件关心。
 * 分档、订阅生命周期与边界是 `ADR-0059` 的裁决，这里只是它的家。
 */
import { RegexDeadlineError, isEngineError } from './errors.js'

/** 沙箱 realm 的 Promise 标：BOOTSTRAP 把它钉在 vm realm 的 `Promise.prototype` 上。宿主侧据此区分
 *  「脚本自建又 fire-and-forget 的悬空 promise」与「宿主/别的插件的真错误」——**按 promise 的来源认，
 *  不按 reason 猜**。两处必须是同一个 key（BOOTSTRAP 是模板串，不能 import），
 *  `tests/engine/unhandled-guard.test.ts` 钉住。 */
export const SANDBOX_REALM_MARK = Symbol.for('dsh-novel.sandbox-realm')

function isSandboxPromise(promise: unknown): boolean {
  if (typeof promise !== 'object' || promise === null) return false
  return (promise as { [SANDBOX_REALM_MARK]?: unknown })[SANDBOX_REALM_MARK] === true
}

export interface GuardSink { warn(...args: unknown[]): void; error?(...args: unknown[]): void }
/** 缺省 sink 仍走 console——离线直用时防线照样出声。前缀归 sink 的家：缺省这条自己缀一次，注入方（日志缝）
 *  已负责前缀，故守卫这条消息本身不带字面前缀。`error` 也要给：缺了它，引擎错误升级分支在离线直用时会把
 *  真 bug 降回 warn 档，读数说谎。 */
const consoleGuardSink: GuardSink = {
  warn: (...args) => { console.warn('[dsh-novel]', ...args) },
  error: (...args) => { console.error('[dsh-novel]', ...args) },
}

/** 每个**真** sink 一份订阅计数：先释放的那次不能让防线提前下庄，最后一份释放才摘监听器。 */
const guardSinks = new Map<GuardSink, number>()
/** 监听器是否已挂。**不能**拿 `guardSinks` 是否为空当唯一判据：兜底被真 sink 顶替时集合非空，但监听器
 *  早已在场上，再 `process.on` 就会挂两条。 */
let guardInstalled = false

function hasRealSink(): boolean {
  for (const sink of guardSinks.keys()) if (sink !== consoleGuardSink) return true
  return false
}

function reportSinks(level: 'warn' | 'error', ...args: unknown[]): void {
  for (const sink of guardSinks.keys()) {
    if (level === 'error' && sink.error !== undefined) sink.error(...args)
    else sink.warn(...args)
  }
}

/** 非沙箱来源：如实说「这不是沙箱的噪声」，并且不替宿主决定它的死活。走 error 档但**没有 error 通道的
 *  sink 退 warn**。 */
function reportForeign(reason: unknown): void {
  reportSinks('error', '宿主侧未处理的 rejection（非沙箱来源，本插件没有替它收场）:', reason)
}

/** 从一组参数里取 `--unhandled-rejections` 的最后一个值：等号与空格两种写法都收，后者覆盖前者。 */
function rejectionModeOf(tokens: readonly string[]): string | undefined {
  let mode: string | undefined
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (token === undefined) continue
    if (token === '--unhandled-rejections') {
      const value = tokens[i + 1]
      if (value !== undefined) {
        mode = value
        i += 1
      }
      continue
    }
    if (token.startsWith('--unhandled-rejections=')) {
      mode = token.slice('--unhandled-rejections='.length)
    }
  }
  return mode
}

/** NODE_OPTIONS 是 shell 风格字符串（引号内的空格不分词）；这里只需拆出 flag 级别，故一个最小分词器就够。 */
function nodeOptionTokens(raw: string | undefined): string[] {
  if (raw === undefined) return []
  const out: string[] = []
  let cur = ''
  let quote: '"' | "'" | null = null
  for (const ch of raw) {
    if (quote !== null) {
      if (ch === quote) quote = null
      else cur += ch
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; continue }
    if (/\s/.test(ch)) {
      if (cur !== '') { out.push(cur); cur = '' }
      continue
    }
    cur += ch
  }
  if (cur !== '') out.push(cur)
  return out
}

/** 宿主自己选的未处理 rejection 策略：`warn` / `none` 下不该由我们改回致命语义；`strict` 由 Node 自己
 *  崩。只有缺省（Node 15+ = throw）与显式 `throw` 才需要恢复默认——那两档下监听器一装上，Node 就把
 *  致命语义交给它了。等号与空格两种写法都认：只认一种会在「宿主选了 warn」时误判回致命。 */
export function hostWantsFatalRejections(
  argv: readonly string[] = process.execArgv,
  nodeOptions: string | undefined = process.env.NODE_OPTIONS,
): boolean {
  const mode = rejectionModeOf(argv) ?? rejectionModeOf(nodeOptionTokens(nodeOptions))
  return mode === undefined || mode === 'throw'
}

/** 恢复 Node 的默认致命语义——**只在唯一监听者是我们、且宿主没有自己选过策略的时候**：还有别的监听器时
 *  怎么处理是它们的决定，我们抢先 throw 等于替它们杀进程。装了监听器就等于把「未处理 rejection 会致命」
 *  这条进程级语义让掉了，那不是本插件有权替整个宿主做的决定。 */
function restoreDefault(reason: unknown): void {
  if (!hostWantsFatalRejections()) return
  if (process.listenerCount('unhandledRejection') > 1) return
  process.nextTick(() => { throw reason })
}

function unhandledGuardHandler(reason: unknown, promise?: unknown): void {
  // 引擎错误类与泄漏的正则死线中继错误都来自插件自己的代码：升级到 error。这条判定**先于**来源判定——
// 这些类的实例只由本仓代码创建；来源标判的是「脚本噪声 vs 宿主/别的插件」，不是「谁的 bug」。
  if (isEngineError(reason) || reason instanceof RegexDeadlineError) {
    reportSinks('error', '未处理的 rejection（插件内部错误，已捕获）:', reason)
    return
  }
  if (!isSandboxPromise(promise)) {
    reportForeign(reason)
    restoreDefault(reason)
    return
  }
  // 脚本侧的 rejection 仍是 warn。
  reportSinks('warn', '沙箱脚本产生未处理的 rejection（已捕获，不影响进程）:',
    reason instanceof Error ? reason.message : reason)
}

/** 挂上防线并交回「释放我这一份订阅」的幂等函数。**多订阅者共存**：谁先挂不再决定 sink，所有订阅者
 *  的 sink 都会收到；最后一份释放时才摘监听器。兜底两条规则：真 sink 在场时兜底是**空操作**（否则
 *  同一条 rejection 在 stderr 出现两遍）；真 sink 到场即**顶替**兜底（兜底没有释放点，留着它插件
 *  卸载后「最后一份释放」永远等不到，监听器与让掉的致命语义会一起残留）。 */
export function acquireRejectionGuard(sink: GuardSink = consoleGuardSink): () => void {
  if (sink === consoleGuardSink) {
    if (hasRealSink()) return () => undefined
  } else {
    guardSinks.delete(consoleGuardSink)
  }
  const count = guardSinks.get(sink) ?? 0
  guardSinks.set(sink, count + 1)
  if (!guardInstalled) {
    process.on('unhandledRejection', unhandledGuardHandler)
    guardInstalled = true
  }
  let released = false
  return () => {
    if (released) return
    released = true
    const current = guardSinks.get(sink)
    if (current === undefined) return      // 已被真 sink 顶替：这份订阅不再存在
    if (current <= 1) guardSinks.delete(sink)
    else guardSinks.set(sink, current - 1)
    if (guardSinks.size === 0 && guardInstalled) {
      process.off('unhandledRejection', unhandledGuardHandler)
      guardInstalled = false
    }
  }
}
