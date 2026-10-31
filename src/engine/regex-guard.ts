import vm from 'node:vm'
import { RegexDeadlineError } from './errors.js'

/**
 * 用户正则的死线执行：合法而病态的模式（灾难性回溯）会把主线程钉死数秒到分钟级，殃及全部
 * `/novel-api` 请求。这里不为正则做静态黑名单——嵌套量词启发式会误杀正常源——改用 V8 的
 * 终止中断兜底：`vm` 的 timeout 会在 irregexp 的回溯循环里被检查，超时即抛（取舍的裁决见
 * `ADR-0050`）。
 *
 * 代价如实记：每趟求值多一次 vm 脚本执行（十微秒级）。换来的是「最坏是一次规则错误」，
 * 而不是「宿主事件循环假死」。批量口径（一次属性过滤一趟）住在 `guardedFilter`。
 *
 * **返回值跨 realm 的实情**（照实写，别当契约读反）：test / replace / OnlyOne 给出的是原生布尔与
 * 字符串；matchAll 与 filter 的数组在 vm realm 里构造，`instanceof Array` 对它不成立（`Array.isArray`
 * 成立），filter 数组里装的仍是宿主原物（按对象同一性可辨）。消费点因此不许用 realm 相关判据。
 *
 * **求值窗口内不回调宿主**：批量过滤的属性值先在宿主侧取齐再交给脚本，所以 timeout 只管正则本身
 * （宿主函数若被请进沙箱就不归它管了，那正是这里绕开的坑），也让下面那把重入闸成立。
 */

/** 一次求值的基础预算：够正常规则跑完（毫秒级），又远低于用户可感知的卡顿。 */
export const REGEX_DEADLINE_BASE_MS = 200
/** 每多一 MB 工作量追加的预算——没有它，几 MB 整页上的正常全局扫描会被判成病态。 */
export const REGEX_DEADLINE_PER_MB_MS = 100
/** 封顶：超过它，「慢但成功」就不再是可接受的代价（主线程被钉住的面积已经够大）。 */
export const REGEX_DEADLINE_MAX_MS = 1_200

const MB = 1024 * 1024

/**
 * 死线 = 基础预算 + **每满一 MB** 追加一档，封顶。工作量按 **UTF-16 码元**计（页面文本与属性串的
 * 天然尺度），不是字节——中文页一个码元一个字，按字节算会给它双倍预算。取整用「满」而不是「有」：
 * 一条几十字符的规则就该花基础预算，给不到一 MB 的东西加钱只是让病态正则多钉主线程一百毫秒。
 * 判据只在这里一次：调用点不再各自解释「为什么这趟给了 500ms」。
 */
export function deadlineFor(volume: number): number {
  const extra = Math.floor(Math.max(0, volume) / MB) * REGEX_DEADLINE_PER_MB_MS
  return Math.min(REGEX_DEADLINE_MAX_MS, REGEX_DEADLINE_BASE_MS + extra)
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
// 批量属性过滤：一趟脚本服务整批条目（逐条一趟会把千元素列表变成千次脚本执行）。
// 属性值由宿主在调用前取齐成 __values，脚本只看数据、不再回调宿主
const filterScript = new vm.Script(`(() => {
  const out = []
  for (let i = 0; i < __items.length; i++) {
    const value = __values[i]
    // 每条独立求值：全局/粘滞正则的 lastIndex 不许跨条目推进——复用游标会把第二、四条读成
    // 「不命中」的静默错值。逐条归零后，y 正则等价于逐条新建（锚在串首），g 正则等价于逐条 find。
    __re.lastIndex = 0
    if (value !== undefined && __re.test(value)) out.push(__items[i])
  }
  return out
})()`)

/**
 * 在途闸。求值窗口里全是同步代码且不含宿主回调，交错本不可能；这把闸把「不可能」写成断言——
 * 将来谁把一次嵌套求值请进这个窗口，当场炸，而不是留下一份偶发错值让人回头查数据。
 */
let inGuard = false

interface GuardedEval {
  script: vm.Script
  re: RegExp
  /** 工作量（UTF-16 码元），决定这一趟的时间预算 */
  volume: number
  /** 脚本读到的槽位；用完即删，不留在沙箱上 */
  slots: Record<string, unknown>
}

function evaluateIn<T>({ script, re, volume, slots }: GuardedEval): T {
  if (inGuard) {
    throw new Error('regex-guard 重入：上一次求值未结束就起了第二次（求值窗口内不得回调宿主或嵌套守卫）')
  }
  inGuard = true
  const deadlineMs = deadlineFor(volume)
  sandbox.__re = re
  Object.assign(sandbox, slots)
  try {
    return script.runInContext(context, { timeout: deadlineMs }) as T
  } catch (e) {
    // vm 的超时错误来自另一个 realm：不能靠 instanceof Error，认 code
    if ((e as { code?: unknown } | null)?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
      // 炸掉的那趟把 lastIndex 停在中间：留着它，下一次同正则会从半截位置起步（读出来是错值而不是
      // 错误）。求值已判死，归零比留半截诚实。非全局正则没有可写的 lastIndex，无所谓。
      try { re.lastIndex = 0 } catch { /* 只读 RegExp 子类：归不掉也不该改判 */ }
      throw new RegexDeadlineError(re.source, deadlineMs)
    }
    throw e
  } finally {
    delete sandbox.__re
    for (const key of Object.keys(slots)) delete sandbox[key]
    inGuard = false
  }
}

/** `re.test(text)`；超时抛 `RegexDeadlineError` */
export function guardedTest(re: RegExp, text: string): boolean {
  return evaluateIn<boolean>({ script: testScript, re, volume: text.length, slots: { __text: text } })
}

/** 全局 `text.replace(re, replacement)`；超时抛 `RegexDeadlineError` */
export function guardedReplace(re: RegExp, text: string, replacement: string): string {
  return evaluateIn<string>({
    script: replaceScript, re, volume: text.length, slots: { __text: text, __repl: replacement },
  })
}

/** OnlyOne 口径（先 exec 再段内 replace）；超时抛 `RegexDeadlineError` */
export function guardedOnlyOneReplace(re: RegExp, text: string, replacement: string): string {
  return evaluateIn<string>({
    script: onlyOneScript, re, volume: text.length, slots: { __text: text, __repl: replacement },
  })
}

/** 整页全局扫描，返回每行的 group 数组；超时抛 `RegexDeadlineError`。
 *  入口断言钉在守卫、不留给调用点纪律：非全局正则的 `exec` 不推进游标，脚本的 `while` 会打满
 *  死线——那会把「用错了正则」误诊成「疑似灾难性回溯」（错诊比漏诊坏：照着错诊断去改模式，
 *  改的不是病因）。粘滞正则的 `exec` 同样推进游标，不进这条断言（原生 `matchAll` 只收全局，
 *  这里放宽到 g|y 是因为脚本循环就是按游标推进写的）。 */
export function guardedMatchAll(re: RegExp, text: string): string[][] {
  if (!re.global && !re.sticky) {
    throw new TypeError('guardedMatchAll 只收全局（g）或粘滞（y）正则：非全局正则的 exec 不推进 lastIndex，会打满死线并被误诊成灾难性回溯')
  }
  return evaluateIn<string[][]>({ script: matchAllScript, re, volume: text.length, slots: { __text: text } })
}

/**
 * 批量过滤：在一条死线内按 `re.test(attrOf(item))` 筛 item（CSS `[attr~=正则]` 用）。一批一次 vm
 * 往返；`attrOf` 在宿主侧、守卫窗口之外执行（一次取齐，正则只见数据）；超时抛 `RegexDeadlineError`。
 * 预算随整批属性值总长放宽——批大小本身不是病态信号，一条正则炸在批里才是。条目数因此不进
 * volume：逐条开销是常数，真正可能指数爆炸的是「某一条值 × 这条模式」。
 *
 * **每条目独立**：脚本在每次 test 前把 `lastIndex` 归零，所以 `g` / `y` 正则不会跨条目吃匹配；
 * 成功交回时恢复调用前的 `lastIndex`（批量抽象不替调用方推进游标），超时那趟由守卫归零
 * （同 ADR-0050 的第 3 条）。
 */
export function guardedFilter<T>(
  items: readonly T[], re: RegExp, attrOf: (item: T) => string | undefined,
): T[] {
  if (items.length === 0) return []
  const values: (string | undefined)[] = []
  let volume = 0
  for (const item of items) {
    const value = attrOf(item)
    values.push(value)
    if (value !== undefined) volume += value.length
  }
  const savedLastIndex = re.lastIndex
  const kept = evaluateIn<T[]>({ script: filterScript, re, volume, slots: { __items: items, __values: values } })
  re.lastIndex = savedLastIndex
  return kept
}
