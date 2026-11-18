/**
 * 进程级未处理 rejection 防线：**只收沙箱 realm 的 promise**，非沙箱来源交回宿主。
 *
 * 为什么单独成 module：这是一个进程全局生命周期（监听器装/摘、按 sink 的订阅计数、从
 * argv / NODE_OPTIONS 读宿主策略），与「脚本怎么求值」是两件关心。住进求值文件时，组合根
 * 为了拿一个订阅口就得装载整个沙箱；它的测试也只能靠重装模块图来清守卫状态。
 *
 * 对外只有三件：`acquireRejectionGuard`（带 sink 订阅，返回幂等的释放）、
 * `hostWantsFatalRejections`（宿主策略谓词）、`SANDBOX_REALM_MARK`（realm 标常量，引导脚本
 * 里那个同 key 的串由测试钉住一致）。分档、订阅生命周期与边界（worker 不覆盖、非沙箱来源
 * 交回宿主）仍是 `ADR-0059` 的裁决，这里只是它的家。
 */
import { RegexDeadlineError, isEngineError } from './errors.js'

/** 沙箱 realm 的 Promise 标：BOOTSTRAP 把它钉在 vm realm 的 `Promise.prototype` 上（异步函数创建的
 *  intrinsic promise 也继承它）。宿主侧据此区分「脚本自建又 fire-and-forget 的悬空 promise」与
 *  「宿主/别的插件的真错误」——**按 promise 的来源认，不按 reason 猜**：脚本可以 reject 任何值。
 *  两处必须是同一个 key（BOOTSTRAP 是模板串，不能 import）；`tests/engine/unhandled-guard.test.ts`
 *  钉住 `Symbol.keyFor` 与识别行为。 */
export const SANDBOX_REALM_MARK = Symbol.for('dsh-novel.sandbox-realm')

function isSandboxPromise(promise: unknown): boolean {
  if (typeof promise !== 'object' || promise === null) return false
  return (promise as { [SANDBOX_REALM_MARK]?: unknown })[SANDBOX_REALM_MARK] === true
}

/** 注入 sink 的形状：引擎不认识 services（依赖方向红线），日志缝因此不进这里，由组合根递进来。 */
export interface GuardSink { warn(...args: unknown[]): void; error?(...args: unknown[]): void }
/** 缺省 sink 仍走 console——引擎离线直用（探针、普查、测试）时防线照样出声。
 *  前缀归 sink 的家：缺省这条自己缀一次（读数要认得出是谁家的日志），而注入方（日志缝）
 *  已经负责前缀，所以守卫这条**消息本身不带字面前缀**——两处各缀一次就是双前缀。
 *  `error` 也要给：缺了它，下面的引擎错误升级分支在离线直用时会把真 bug 降回 warn 档，
 *  标签说「沙箱脚本产生未处理的 rejection」而它其实来自插件自己的代码——读数说谎。 */
const consoleGuardSink: GuardSink = {
  warn: (...args) => { console.warn('[dsh-novel]', ...args) },
  error: (...args) => { console.error('[dsh-novel]', ...args) },
}

/** 每个**真** sink 一份订阅计数：两处都可以订（组合根的日志缝、测试与探针的直构），
 *  先释放的那次不能让防线提前下庄；最后一份释放才摘监听器。console 兜底不长期记账——
 *  它只在没有真 sink 时顶替，见 `acquireRejectionGuard`。 */
const guardSinks = new Map<GuardSink, number>()
/** 监听器是否已挂。**不能**拿 `guardSinks` 是否为空当唯一判据：兜底被真 sink 顶替时集合非空，
 *  但监听器早已在场上，再 `process.on` 就会挂两条。 */
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

/** 非沙箱来源：如实说「这不是沙箱的噪声」，并且不替宿主决定它的死活。
 *  走 error 档但**没有 error 通道的 sink 退 warn**（`reportSinks` 的同一条规则）——
 *  一个 sink 都不出声，比标签降档更坏。 */
function reportForeign(reason: unknown): void {
  reportSinks('error', '宿主侧未处理的 rejection（非沙箱来源，本插件没有替它收场）:', reason)
}

/** 从一组参数里取 `--unhandled-rejections` 的最后一个值：Node 的等号与空格两种写法都收，
 *  同一来源出现多次时后者覆盖前者（Node 的解析同序）。只认这一个 flag，不引通用 parser。 */
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

/** NODE_OPTIONS 是 shell 风格字符串（引号内的空格不分词，引号本身剥掉）；这里只需要拆出
 *  flag 级别，模式词不会含空格，所以一个最小分词器就够，不引通用 shell parser。 */
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

/** 宿主自己选的未处理 rejection 策略：`warn` / `none` 下不该由我们改回致命语义；`strict` 由
 *  Node 自己崩（它不调监听器，我们连日志都收不到）。只有缺省（Node 15+ = throw）与显式
 *  `throw` 才需要恢复默认——那两档下监听器一装上，Node 就把致命语义交给它了。
 *  `argv` / `nodeOptions` 默认取进程真值；显式入参只为测试能把各档策略各钉一行。
 *  等号与空格两种写法都认：Node 启动器两种都收，只认一种会在「宿主选了 warn」时误判回致命。 */
export function hostWantsFatalRejections(
  argv: readonly string[] = process.execArgv,
  nodeOptions: string | undefined = process.env.NODE_OPTIONS,
): boolean {
  const mode = rejectionModeOf(argv) ?? rejectionModeOf(nodeOptionTokens(nodeOptions))
  return mode === undefined || mode === 'throw'
}

/** 恢复 Node 的默认致命语义——**只在唯一监听者是我们、且宿主没有自己选过策略的时候**。
 *  还有别的监听器（宿主/别的插件）时，怎么处理是它们的决定；我们抢先 throw 等于替它们杀进程。
 *  为什么必须恢复：装了监听器就等于把「未处理 rejection 会致命」这条进程级语义让掉了，
 *  而这不是本插件有权替整个宿主做的决定——它会掩盖别人的真 bug。 */
function restoreDefault(reason: unknown): void {
  if (!hostWantsFatalRejections()) return
  if (process.listenerCount('unhandledRejection') > 1) return
  process.nextTick(() => { throw reason })
}

function unhandledGuardHandler(reason: unknown, promise?: unknown): void {
  // 引擎错误类与泄漏的正则死线中继错误都来自插件自己的代码（不是脚本的 fire-and-forget）：升级到
  // error，否则真 bug 与脚本噪声同档，进程级信号被 warn 淹没。RegexDeadlineError 本该被每个
  // 调用点就地转译（归属裁决见 engine/errors.ts），漏转到这里就是插件 bug——不许顶着
  // 「沙箱脚本产生」的标签混进 warn 档。没有 error 通道的 sink 退 warn 档，标签照实不改口。
  // 这条判定**先于**来源判定：这些类的实例只由本仓代码创建（桥接给脚本的是 realm 里新建的
  // Error，不是宿主对象），reason 命中它们时按插件内部错误记；来源标判的是「脚本噪声 vs
  // 宿主/别的插件」，不是「谁的 bug」——插件自己的 bug 不该顶着宿主标签把进程带走。
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

/** 挂上防线并交回「释放我这一份订阅」的幂等函数。
 *  组合根（插件 apply）在第一次跑脚本之前挂，日志因此进宿主日志面；引擎侧求值入口的兜底
 *  调用只是离线直用时的保险。**多订阅者共存**：谁先挂不再决定 sink，所有订阅者的 sink 都会收到
 *  （同一 sink 重复 acquire 只算一次订阅、需要同样次数的 release）。最后一份释放时才摘监听器。
 *  兜底的两条规则：
 *  - 真 sink 在场时兜底是**空操作**：组合根的日志缝自带 console 腿，兜底再收一份就是同一条
 *    rejection 在 stderr 上出现两遍；
 *  - 真 sink 到场即**顶替**兜底：兜底没有释放点（求值入口每次跑脚本都会 acquire 一次），
 *    留着它，插件卸载后「最后一份释放」永远等不到——监听器与本插件替宿主让掉的致命语义会一起残留。 */
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
