import vm from 'node:vm'
import { RegexDeadlineError } from './errors.js'

/**
 * 用户正则的死线执行：合法而病态的模式（灾难性回溯）会把主线程钉死数秒到分钟级，殃及全部 `/novel-api`
 * 请求。不做静态黑名单（嵌套量词启发式会误杀正常源），改用 V8 的终止中断兜底：`vm` 的 timeout 会在
 * irregexp 的回溯循环里被检查，超时即抛（裁决见 `ADR-0050`）。代价是每趟多一次 vm 脚本执行（十微秒级），
 * 换来「最坏是一次规则错误」而不是「宿主事件循环假死」。
 *
 * **返回值跨 realm**：test / replace / OnlyOne 给原生布尔与字符串；matchAll 与 filter 的数组在 vm realm 里
 * 构造，`instanceof Array` 不成立（`Array.isArray` 成立）。**求值窗口内不回调宿主**：批量过滤的属性值先在
 * 宿主侧取齐再交给脚本，timeout 只管正则本身，下面那把重入闸也因此成立。
 */

/** 一次求值的基础预算：够正常规则跑完（毫秒级），又远低于用户可感知的卡顿。 */
export const REGEX_DEADLINE_BASE_MS = 200
/** 每多一 MB 工作量追加的预算——没有它，几 MB 整页上的正常全局扫描会被判成病态。 */
export const REGEX_DEADLINE_PER_MB_MS = 100
/** 封顶：超过它，「慢但成功」就不再是可接受的代价（主线程被钉住的面积已经够大）。 */
export const REGEX_DEADLINE_MAX_MS = 1_200

const MB = 1024 * 1024

/**
 * 死线 = 基础预算 + **每满一 MB** 追加一档，封顶。工作量按 **UTF-16 码元**计（页面文本与属性串的天然
 * 尺度），不是字节。取整用「满」而不是「有」：不到一 MB 的规模只该花基础预算，白送病态正则钉主线程的
 * 时间。判据只在这里一次，调用点不再各自解释「这趟预算为什么是这么多」。
 */
export function deadlineFor(volume: number): number {
  const extra = Math.floor(Math.max(0, volume) / MB) * REGEX_DEADLINE_PER_MB_MS
  return Math.min(REGEX_DEADLINE_MAX_MS, REGEX_DEADLINE_BASE_MS + extra)
}

const sandbox: Record<string, unknown> = {}
const context = vm.createContext(sandbox)

const testScript = new vm.Script('__re.test(__text)')
const replaceScript = new vm.Script('__text.replace(__re, __repl)')
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
// 批量属性过滤：一趟脚本服务整批条目（逐条一趟会把千元素列表变成千次脚本执行）。属性值由宿主在
// 调用前取齐成 __values，脚本只看数据、不再回调宿主
const filterScript = new vm.Script(`(() => {
  const out = []
  for (let i = 0; i < __items.length; i++) {
    const value = __values[i]
    // 每条独立求值：全局/粘滞正则的 lastIndex 不许跨条目推进——复用游标会把第二、四条读成「不命中」的静默
    // 错值。逐条归零后，y 正则等价于逐条新建，g 正则等价于逐条 find。
    __re.lastIndex = 0
    if (value !== undefined && __re.test(value)) out.push(__items[i])
  }
  return out
})()`)

/**
 * 在途闸。求值窗口里全是同步代码且不含宿主回调，交错本不可能；这把闸把「不可能」写成断言——将来谁
 * 把一次嵌套求值请进这个窗口，当场炸，而不是留下一份偶发错值让人回头查数据。
 */
let inGuard = false

interface GuardedEval {
  script: vm.Script
  re: RegExp
  /** 工作量（UTF-16 码元），决定这一趟的时间预算 */
  volume: number
  slots: Record<string, unknown>
}

function evaluateIn({ script, re, volume, slots }: GuardedEval): unknown {
  if (inGuard) {
    throw new Error('regex-guard 重入：上一次求值未结束就起了第二次（求值窗口内不得回调宿主或嵌套守卫）')
  }
  inGuard = true
  const deadlineMs = deadlineFor(volume)
  sandbox.__re = re
  Object.assign(sandbox, slots)
  try {
    return script.runInContext(context, { timeout: deadlineMs })
  } catch (e) {
    // vm 的超时错误来自另一个 realm：不能靠 instanceof Error，认 code
    if ((e as { code?: unknown } | null)?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
      // 炸掉的那趟把 lastIndex 停在中间：留着它，下一次同正则会从半截位置起步（读出来是错值而不是错误）。
      // 求值已判死，归零比留半截诚实。
      try { re.lastIndex = 0 } catch { /* 只读 RegExp 子类：归不掉也不该改判 */ }
      throw new RegexDeadlineError(re.source, deadlineMs)
    }
    throw e
  } finally {
    Reflect.deleteProperty(sandbox, '__re')
    for (const key of Object.keys(slots)) Reflect.deleteProperty(sandbox, key)
    inGuard = false
  }
}

/** 守卫脚本返回值判形：来自另一个 realm（约束见文件顶注），对不上就抛——这是「不认识的返回值」，不能断言掉。 */
function shapeFail(what: string, v: unknown): never {
  throw new TypeError(`regex 守卫的脚本返回值不是 ${what}（实际 ${typeof v}）`)
}

function boolOf(v: unknown): boolean {
  if (typeof v !== 'boolean') shapeFail('boolean', v)
  return v
}

function stringOf(v: unknown): string {
  if (typeof v !== 'string') shapeFail('string', v)
  return v
}

/** matchAll 的行 = group 0 + 捕获组，每格都是串 */
function stringRowsOf(v: unknown): string[][] {
  if (!Array.isArray(v)) shapeFail('string[][]', v)
  const rows: unknown[] = v
  return rows.map((row) => {
    if (!Array.isArray(row)) shapeFail('string[]（行）', row)
    const cells: unknown[] = row
    return cells.map(stringOf)
  })
}

export function guardedTest(re: RegExp, text: string): boolean {
  return boolOf(evaluateIn({ script: testScript, re, volume: text.length, slots: { __text: text } }))
}

export function guardedReplace(re: RegExp, text: string, replacement: string): string {
  return stringOf(evaluateIn({
    script: replaceScript, re, volume: text.length, slots: { __text: text, __repl: replacement },
  }))
}

export function guardedOnlyOneReplace(re: RegExp, text: string, replacement: string): string {
  return stringOf(evaluateIn({
    script: onlyOneScript, re, volume: text.length, slots: { __text: text, __repl: replacement },
  }))
}

/** 整页全局扫描，返回每行的 group 数组；超时抛 `RegexDeadlineError`。入口断言钉在守卫、不留给调用点
 *  纪律：非全局正则的 `exec` 不推进游标，脚本的 `while` 会打满死线——那会把「用错了正则」误诊成
 *  「疑似灾难性回溯」（错诊比漏诊坏：照着错诊断去改模式，改的不是病因）。粘滞正则同样推进游标，
 *  故放宽到 g|y。 */
export function guardedMatchAll(re: RegExp, text: string): string[][] {
  if (!re.global && !re.sticky) {
    throw new TypeError('guardedMatchAll 只收全局（g）或粘滞（y）正则：非全局正则的 exec 不推进 lastIndex，会打满死线并被误诊成灾难性回溯')
  }
  return stringRowsOf(evaluateIn({ script: matchAllScript, re, volume: text.length, slots: { __text: text } }))
}

/**
 * 批量过滤：在一条死线内按 `re.test(attrOf(item))` 筛 item（CSS `[attr~=正则]` 用）。一批一次 vm
 * 往返；`attrOf` 在宿主侧、守卫窗口之外执行（一次取齐，正则只见数据）；超时抛 `RegexDeadlineError`。
 * 预算随整批属性值总长放宽——批大小本身不是病态信号，一条正则炸在批里才是，故条目数不进 volume。
 *
 * **每条目独立**：脚本在每次 test 前把 `lastIndex` 归零，`g` / `y` 正则不会跨条目吃匹配；成功交回时
 * 恢复调用前的 `lastIndex`（批量抽象不替调用方推进游标），超时那趟由守卫归零（同 ADR-0050 的第 3 条）。
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
  const kept = evaluateIn({ script: filterScript, re, volume, slots: { __items: items, __values: values } })
  re.lastIndex = savedLastIndex
  if (!Array.isArray(kept)) shapeFail('数组', kept)
  // 脚本只把 __items 的原物推进结果（跨 realm 约定见文件顶注）。不按值重建：值相等的不同条目会被折叠。
  return kept as T[]
}
