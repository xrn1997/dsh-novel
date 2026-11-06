import type { LocalImportWarning } from '../../shared/wire.js'

/**
 * 导入过程中的**事实**通道：谁坏了（半径）、坏到什么程度（严重度）、编排层因此落哪一格后果、
 * 以及怎么合并成给用户看的一条话。
 *
 * 为什么半径不写在调用点、而按名字从下面的表里取：这一层的每一条事实最终要由编排层决定「影响一本书还是
 * 影响一处」。「要不要整本拒」若由发出方各自判断，同一个判据就会在两半各写一遍，而新加的判据
 * 只会重复这个错误——所以发出方只回答「我说的这件事叫什么」，半径与后果由 `FINDING_RADII` 登记
 * （裁决见 `ADR-0061` / `ADR-0063`）。
 *
 * 为什么与告警合并器合成一份：两者都是「同码同资源合并 + 细节有界」的账。留两本账就会出现
 * 同一件事在两个地方各记一次、处数互不相认——那正是「降级看不见」的形态。
 */

/** 事实的主语有多大：整本书 / 一份内容文档 / 一条声明或引用 / 正文里的一处元素 */
export type FindingScope = 'book' | 'document' | 'item' | 'element'

/** 这件事坏到什么程度：整本读不出 / 内容在但表达降级 / 只值得留一笔 */
export type FindingSeverity = 'fatal' | 'degraded' | 'notice'

/** 合并后的一条事实：`count` 是处数，`details` 是给人看的例子（有界） */
export interface FindingEntry {
  readonly scope: FindingScope
  readonly severity: FindingSeverity
  readonly code: string
  readonly resource: string | null
  readonly action: string
  readonly count: number
  readonly details: readonly string[]
}

/**
 * **半径表**（唯一主人）：每一种发法说多大的主语、坏到什么程度，以及编排层必须落的那一格后果。
 * `ADR-0061` / `ADR-0063` 说的就是这张表——规则只在这里说一次，各层头注与文档只指这里，别处不再抄一遍判据。
 * `consequence` 是给人读的规则口径；执行在编排层（`import.ts`），本表不是运行期分派器。
 *
 * 刻意**没有** `book` + `fatal` 这一格：「整本书读不出」不是一条可以留痕的事实，它是导入的终止，
 * 只能走 `services/epub/errors.ts` 的 `rejectBook`（整本拒只有一条路）。半径门按本表现实检这一格，
 * 想加它要先过名册与 ADR。
 */
export const FINDING_RADII = {
  blankDocument: {
    scope: 'document', severity: 'fatal',
    consequence: '这一页留空：照旧进阅读序列、照旧占章号、目录照有名，读出来是空白页',
  },
  documentDegraded: {
    scope: 'document', severity: 'degraded',
    consequence: '这一页照读，但表达降级（版式或图形与源不一致）',
  },
  itemPruned: {
    scope: 'item', severity: 'fatal',
    consequence: '剪那一条声明或引用：主序列往前挪不留洞、目录子条目上提、正文链接取消可点击性而文字一个字不丢',
  },
  itemNoted: {
    scope: 'item', severity: 'notice',
    consequence: '照读，只把这一条声明或资源的异常之处留一笔（读法不变）',
  },
  itemDegraded: {
    scope: 'item', severity: 'degraded',
    consequence: '那一条声明照留，但它的落点降级（导航条目跳到文档开头）',
  },
  bookVariant: {
    scope: 'book', severity: 'notice',
    consequence: '整本照读，只把包级形状（目录来源这类）留一笔',
  },
  elementDropped: {
    scope: 'element', severity: 'fatal',
    consequence: '该处不留：图与解不开的引用空出位置，但 alt 文字、链接文字与该元素承载的锚点位置照留',
  },
  elementRemoved: {
    scope: 'element', severity: 'degraded',
    consequence: '内容照读，这一处表达不全（活动内容与样式被剥除，或链接失去可点击性）',
  },
  elementNoted: {
    scope: 'element', severity: 'notice',
    consequence: '照读，只把「这里有过两件事」留一笔（同名锚点取文档序第一个）',
  },
} as const satisfies Record<string, { scope: FindingScope; severity: FindingSeverity; consequence: string }>

/** 发出事实时唯一可交的名字：半径由表决定，调用点填不了，也填不出整本拒 */
export type FindingRadius = keyof typeof FINDING_RADII

/**
 * 每个键最多留几条**细节例子**：`warningListOf` 只展示前三，留更多既没人读，也把 `add` 拖成 O(n²)——
 * 细节互不相同的大部头会把这里拖成十几秒的同步阻塞，而那期间宿主线程什么都不干。
 */
const MAX_DETAILS = 3

/**
 * 同类事实合并器：**同半径 + 同严重度 + 同码 + 同资源 + 同动作**合并计数，
 * 细节（元素名/href/属性名）只留前三个当例子。
 *
 * 为什么合并键要收半径与严重度：同一句动作发生在元素上与发生在文档上是两件不同的事——
 * 折叠成一条会把「这本书缺什么」的读数说错。
 *
 * 计数与例子**分开有界**：处数（`count`）按发生次数如实累加、不设上限；例子到 `MAX_DETAILS`
 * 就不再收集（既不追加也不去重查找）。于是「有多少处」永远准确，而内存与耗时与内容规模无关。
 */
export class FindingLog {
  private readonly entriesMap = new Map<string, { scope: FindingScope; severity: FindingSeverity; code: string; resource: string | null; action: string; count: number; details: string[] }>()

  add(radius: FindingRadius, code: string, resource: string | null, action: string, detail?: string): void {
    const pair = FINDING_RADII[radius]
    this.merge(pair.scope, pair.severity, code, resource, action, 1, detail === undefined ? [] : [detail])
  }

  /**
   * 并入低层交回的一条事实：同键处数相加、例子照旧有界。
   *
   * 收**事实清单**而不是收另一个 `FindingLog` 实例——低层交出的是不可变事实，不是可以再往里写的账本；
   * 可变的那本账只住编排层。也不按处数重放 `add`：重放会把超过例子上限的那些笔折掉，而合并本来
   * 要做的就是「处数照加、例子各留前三」。
   *
   * 低层的事实清单只由各自的 `FindingLog.entries()`（或空清单）产生；这是合并口，不是第二个发痕口
   * （按名字发、由 `FINDING_RADII` 定半径的是 `add`）。
   */
  addEntry(entry: FindingEntry): void {
    this.merge(entry.scope, entry.severity, entry.code, entry.resource, entry.action, entry.count, entry.details)
  }

  private merge(
    scope: FindingScope, severity: FindingSeverity, code: string,
    resource: string | null, action: string, count: number, details: readonly string[],
  ): void {
    const key = `${scope}\u0000${severity}\u0000${code}\u0000${resource ?? ''}\u0000${action}`
    const hit = this.entriesMap.get(key)
    if (hit === undefined) {
      this.entriesMap.set(key, { scope, severity, code, resource, action, count, details: [...details] })
      return
    }
    hit.count += count
    for (const one of details) {
      if (hit.details.length >= MAX_DETAILS) break
      if (!hit.details.includes(one)) hit.details.push(one)
    }
  }

  /** 合并后事实清单（后果按 `FINDING_RADII` 落，测试按它断言半径） */
  entries(): readonly FindingEntry[] {
    return [...this.entriesMap.values()]
  }
}

/**
 * 事实 → 给用户看的一条话（**投影**，不是落盘的形状）：只说「丢了什么」，半径与严重度不外泄
 * （跨半契约不变，`ADR` 的半径条目把它挡在 Node 半）。
 *
 * 为什么单独成函数：落盘的是拆开的事实（码、资源、动作句、处数、例子），读面按当下口径重新合并
 * 与拼句——改合并键、处数前缀、例子列表都作用到旧书。**动作句本身是发出方在导入时写下的**
 * （里面带着那一次的具体数值与原文，不能从码重造），改它的措辞或换语言仍只对重新导入的书生效。
 */
export function warningListOf(entries: readonly FindingEntry[]): LocalImportWarning[] {
  return entries.map((e) => ({
    code: e.code,
    resource: e.resource,
    message: e.count === 1
      ? (e.details.length === 0 ? e.action : `${e.action}：${e.details[0]}`)
      : `${e.count} 处：${e.action}${e.details.length === 0 ? '' : `（例：${e.details.slice(0, MAX_DETAILS).join('、')}）`}`,
  }))
}

/** 告警码（稳定标识，服务层原样持久化并展示）：用户看到 message，程序按 code 分流 */
export const WARN_REMOVED = 'epub-removed-active-content'
export const WARN_ACTIVE_ATTR = 'epub-active-attribute'
export const WARN_CSS_ATTR = 'epub-css-attribute'
export const WARN_INLINE_SVG = 'epub-removed-inline-svg'
/**
 * 一条声明读不出（spine 条目、目录条目、正文链接的目标）：剪的是**那一条**。
 * 包层与编排层都会说这件事，所以它是共享码——同一件事不许有两个名字。
 */
export const WARN_ITEM_PRUNED = 'epub-item-pruned'
