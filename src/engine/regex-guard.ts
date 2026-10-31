import vm from 'node:vm'

/**
 * 用户正则的死线执行：合法而病态的模式（灾难性回溯）会把主线程钉死数秒到分钟级，殃及全部
 * `/novel-api` 请求。这里不为正则做静态黑名单——嵌套量词启发式会误杀正常源——改用 V8 的
 * 终止中断兜底：`vm` 的 timeout 会在 irregexp 的回溯循环里被检查，超时即抛。
 *
 * 代价如实记：每趟求值多一次 vm 脚本执行（十微秒级）。换来的是「最坏是一次规则错误」，
 * 而不是「宿主事件循环假死」。跨 realm 的 RegExp 与字符串照常可用，返回值是最小 JSON 值。
 */

/** 单条正则求值的死线。够正常规则跑完（毫秒级），又远低于用户可感知的卡顿。 */
const DEADLINE_MS = 200

export class RegexDeadlineError extends Error {
  readonly pattern: string
  constructor(pattern: string) {
    super(`正则求值超时（${DEADLINE_MS}ms，疑似灾难性回溯）: ${pattern}`)
    this.name = 'RegexDeadlineError'
    this.pattern = pattern
  }
}

const sandbox: Record<string, unknown> = {}
const context = vm.createContext(sandbox)

/** 脚本与口径一一对应；全部在同一个 context 里跑，避免每次重建上下文的开销。 */
const testScript = new vm.Script('__re.test(__text)')
const replaceScript = new vm.Script('__text.replace(__re, __repl)')
// OnlyOne 口径：先取首个匹配、再在该匹配内替换（与 replace.ts 的注释同一口径）
const onlyOneScript = new vm.Script(`(() => {
  const m = __re.exec(__text)
  return m === null ? '' : m[0].replace(__re, __repl)
})()`)
// 整页扫描：行 = group 0 + 捕获组；零长度匹配强制前进（与 allinone 原循环同一口径）
const matchAllScript = new vm.Script(`(() => {
  const rows = []
  let m
  while ((m = __re.exec(__text)) !== null) {
    rows.push(Array.from(m, (v) => (v === undefined ? '' : v)))
    if (m[0] === '') __re.lastIndex++
  }
  return rows
})()`)
// 批量属性过滤：一趟脚本服务整批条目（逐条一趟会把千元素列表变成千次脚本执行）
const filterScript = new vm.Script(`(() => {
  const out = []
  for (const item of __items) {
    const value = __attrOf(item)
    if (value !== undefined && __re.test(value)) out.push(item)
  }
  return out
})()`)

function run<T>(script: vm.Script, re: RegExp, text: string, repl = ''): T {
  sandbox.__re = re
  sandbox.__text = text
  sandbox.__repl = repl
  try {
    return script.runInContext(context, { timeout: DEADLINE_MS }) as T
  } catch (e) {
    // vm 的超时错误来自另一个 realm：不能靠 instanceof Error，认 code
    if ((e as { code?: unknown } | null)?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
      throw new RegexDeadlineError(re.source)
    }
    throw e
  } finally {
    sandbox.__re = undefined
    sandbox.__text = undefined
    sandbox.__repl = undefined
  }
}

/** `re.test(text)`；超时抛 `RegexDeadlineError` */
export function guardedTest(re: RegExp, text: string): boolean {
  return run<boolean>(testScript, re, text)
}

/** 全局 `text.replace(re, replacement)`；超时抛 `RegexDeadlineError` */
export function guardedReplace(re: RegExp, text: string, replacement: string): string {
  return run<string>(replaceScript, re, text, replacement)
}

/** OnlyOne 口径（先 exec 再段内 replace）；超时抛 `RegexDeadlineError` */
export function guardedOnlyOneReplace(re: RegExp, text: string, replacement: string): string {
  return run<string>(onlyOneScript, re, text, replacement)
}

/** 整页全局扫描，返回每行的 group 数组；超时抛 `RegexDeadlineError` */
export function guardedMatchAll(re: RegExp, text: string): string[][] {
  return run<string[][]>(matchAllScript, re, text)
}

/** 批量过滤：在一条死线内按 `re.test(attrOf(item))` 筛 item（CSS `[attr~=正则]` 用）。
 *  一批一次 vm 往返；超时抛 `RegexDeadlineError`。 */
export function guardedFilter<T>(items: readonly T[], re: RegExp, attrOf: (item: T) => string | undefined): T[] {
  if (items.length === 0) return []
  sandbox.__re = re
  sandbox.__items = items
  sandbox.__attrOf = attrOf
  try {
    return filterScript.runInContext(context, { timeout: DEADLINE_MS }) as T[]
  } catch (e) {
    if ((e as { code?: unknown } | null)?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
      throw new RegexDeadlineError(re.source)
    }
    throw e
  } finally {
    sandbox.__re = undefined
    sandbox.__items = undefined
    sandbox.__attrOf = undefined
  }
}
