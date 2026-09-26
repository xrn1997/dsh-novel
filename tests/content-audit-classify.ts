/**
 * 正文链路审计的**失败归因**单点（判据②的可机读形式）。
 *
 * 判据原文是「UnsupportedRuleError / RuleEvalError / JsSandboxError 三类引擎侧失败清零
 * （站点与网络侧失败不计）」。问题是：这三种 error name 里既装着「本仓不认这条语法」，
 * 也装着「站点页面上没有这个结构」和「源脚本自己的正则没匹配上」——只按 error name 计数
 * 会把三类成因混成一个数字，读它的人无法判断还剩多少欠账。
 *
 * 归因按**消息锚点**判，锚点全部是本仓自己写下的抛错措辞（改措辞会让这里失配，
 * 由 `tests/content-audit-classify.test.ts` 钉住）：
 *  - `host-gap`：本仓宿主面/语法缺口——点名缺方法、缺段形态、未接的选项。这是要被清零的那一栏。
 *  - `guard`：本仓**刻意闸口**（宁炸不猜）——本可静默取空或整本回退的场合，我们明确失败。
 *  - `site-side`：站点/脚本侧——同一规则在同源其它章能出值、页面上没这结构、站点自己的
 *    脚本正则取到 null。换任何 JS 引擎 + 同一份页面同样读不出。
 *  - `network`：请求失败/超时/解码失败（站点侧的一种，单列以便与「站点没这结构」区分）。
 *  - `unattributed`：以上都不匹配——**这一栏必须逐条人判并按判例补锚点**，不许长期非零。
 */

export type Attribution = 'host-gap' | 'guard' | 'site-side' | 'network' | 'unattributed'

export interface ClassifiableErr {
  name?: string
  message?: string
}

/** 本仓宿主面缺口的消息锚点（每条都是代码里真实存在的措辞片段） */
const HOST_GAP = [
  'is not a function',                       // 沙箱里缺某个 jsoup/宿主方法（如曾经的 Elements.remove）
  '无法识别的段类型',                         // 解析期不认的段形态
  '未知 java 方法',                           // js-protocol：脚本调了没登记的 java.*
  '未知 Packages 桥操作',                     // Packages.* 未登记的路径
  '未知元素桥操作',                           // 元素桥未实现的操作
  'XPath 步骤不支持',                         // 求值层未实现的 XPath 形态
  'XPath 轴不支持',                           // 轴子集之外
  '谓词无法识别',                             // XPath 谓词形态未实现
  '谓词路径起步不支持',                       // 谓词内 //（文档根绝对轴）——未实现的那一形态
  '子规则内不支持 js 段',                     // 同步子环路未接线
  '调用方未接线子规则求值口',                 // 同上（@put 值形态）
  '结果不是取值而是节点集',                   // 服务层规约误用到链终点
  '脚本编译/同步执行失败：Unexpected token',  // 本仓解析器接不住的写法（人判后归档）
]

/** 本仓刻意闸口（本可静默、我们明确失败）的消息锚点 */
const GUARD = [
  '目录 URL 规则未取到任何章节地址',          // reading.ts：逐条回退目录页即判定整体失效
  '无法解码 charset',                         // 声明了非法 charset 时不猜
  '需要安卓宿主环境',                         // java.webView 等——见 legado-compat.md 不适用表
  '缺目录规则',                               // RuleMissingError
]

/** 站点/脚本侧：页面上没这结构、源脚本自己的匹配取到 null */
const SITE_SIDE = [
  'Cannot read properties of null',           // 源脚本 match(...) 取到 null（任何 JS 引擎同炸）
  'Cannot read property',                     // 同上（不同引擎措辞）
  'is not defined',                           // 源脚本引用了页面里不存在的变量
  '正文规则零命中',                           // 选择器在页面上没有落点
  '正文规则没取到内容',                       // 同上（链上取空）
  '无法按 JSON 求值',                         // 站点返回的不是 JSON
  '详情初始化规则未取到上下文',               // init 段在页面上零命中
]

const NETWORK = [
  '网络错误', '请求超时', '请求失败', 'fetch failed', 'Failed to parse URL', 'ETIMEDOUT', 'ECONNREFUSED',
  // js 段超时是**策略闸口**（jsTimeoutMs 上限），同一条脚本在同一慢链路上同样会超——
  // 真机实证：脚本首行就是 java.ajax(登录页) 的那一类。代价是死循环也走这条文案，
  // 所以读数时这一栏要人看一眼：只有当某源在提速后仍超时，才可能是本仓问题。
  '脚本超时',
]

const matches = (msg: string, anchors: string[]): boolean => anchors.some((a) => msg.includes(a))

/** 归因顺序：error name 先粗筛，消息锚点再细分（同一 name 下三种成因都要能分开） */
export function attributeError(err: ClassifiableErr | undefined): Attribution {
  // 没有错误对象可判 → 如实落**待判**那一栏：把「没东西可归因」静默算进 site-side 是给自己放水
  // （本文件的口径是 site-side 须有页面/脚本侧的证据；调用方 `classifyAudits` 已经先滤掉这种条目，
  // 所以这条只在函数边界上成立——不变量写在这里，不靠调用方记得）
  if (err === undefined) return 'unattributed'
  const name = err.name ?? ''
  const msg = err.message ?? ''
  // 网络/站点错里嵌着的脚本错（`java.ajax` 打不通）同样归网络，不算本仓缺口——所以这一跳同时按
  // error name 与消息锚点判，不再重复一次锚点判断（那次重复曾是不可达代码）
  if (name === 'FetchError' || matches(msg, NETWORK)) return 'network'
  if (name === 'RuleMissingError') return 'guard'
  if (matches(msg, HOST_GAP)) return 'host-gap'
  if (matches(msg, GUARD)) return 'guard'
  if (matches(msg, SITE_SIDE)) return 'site-side'
  return 'unattributed'
}

export interface ClassifiedReport {
  total: number
  byAttribution: Record<Attribution, number>
  /** host-gap + unattributed 之和——判据②的复算口径 */
  residual: number
  /** 逐条明细（源名 / error name / 归因 / 消息骨架），人判时用 */
  items: Array<{ name: string; stage: string; errName: string; attribution: Attribution; message: string }>
}

interface AuditLike {
  name: string
  stage: string
  error?: ClassifiableErr
}

/** 引擎类 error name（判据②只管这三种；FetchError/RuleMissingError 等另有归属） */
const ENGINE_KINDS = new Set(['UnsupportedRuleError', 'RuleEvalError', 'JsSandboxError'])

export function isEngineKind(err: ClassifiableErr | undefined): boolean {
  return ENGINE_KINDS.has(err?.name ?? '')
}

/** 对整份审计报告归因（`stage !== 'ok'` 的每条源都进明细，非引擎类也记着以便对账） */
export function classifyAudits(audits: AuditLike[]): ClassifiedReport {
  const byAttribution: Record<Attribution, number> = {
    'host-gap': 0, guard: 0, 'site-side': 0, network: 0, unattributed: 0,
  }
  const items: ClassifiedReport['items'] = []
  for (const a of audits) {
    if (a.stage === 'ok' || a.error === undefined) continue
    // 明细只收**引擎类**失败：非引擎类（EmptyToc、RuleMissingError、FetchError…）在
    // 报告的 buckets/stageCount 里已有位置，混进这份清单会让人把「目录 0 章」读成 residual
    if (!isEngineKind(a.error)) continue
    const attribution = attributeError(a.error)
    items.push({
      name: a.name, stage: a.stage, errName: a.error.name ?? 'Unknown',
      attribution, message: (a.error.message ?? '').slice(0, 160),
    })
    byAttribution[attribution] += 1
  }
  return {
    total: audits.length,
    byAttribution,
    residual: byAttribution['host-gap'] + byAttribution.unattributed,
    items,
  }
}

/** 消息骨架（分桶展示用，与 content-audit 的 bucketKey 同口径） */
export function messageSkeleton(msg: string): string {
  return msg
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/\d+/g, '#')
    .replace(/"[^"]{8,}"/g, '"…"')
    .slice(0, 120)
}

/**
 * 锚点里两类东西要分开：
 *  - `RUNTIME_ANCHORS`：JS/Node 运行时自己的措辞（`is not a function`、
 *    `Cannot read properties of null`、`fetch failed`…），源码里搜不到，也不该搜。
 *  - 其余全部是本仓**写下的抛错文案**——它们若与源码失配，归因就会静默跑偏（把本仓缺口
 *    读成站点侧，等于给自己放水），所以由 `tests/content-audit-classify.test.ts` 逐条
 *    要求在 `src/` 里真实存在。
 */
export const RUNTIME_ANCHORS = new Set<string>([
  'is not a function',
  'Cannot read properties of null',
  'Cannot read property',
  'is not defined',
  'fetch failed',
  'Failed to parse URL',
  'ETIMEDOUT',
  'ECONNREFUSED',
  '脚本编译/同步执行失败：Unexpected token',
])

/** 待验锚点（按栏分组，测试逐条查源码存活） */
export const CODE_ANCHORS: Record<'host-gap' | 'guard' | 'site-side' | 'network', string[]> = {
  'host-gap': HOST_GAP.filter((a) => !RUNTIME_ANCHORS.has(a)),
  guard: GUARD.filter((a) => !RUNTIME_ANCHORS.has(a)),
  'site-side': SITE_SIDE.filter((a) => !RUNTIME_ANCHORS.has(a)),
  network: NETWORK.filter((a) => !RUNTIME_ANCHORS.has(a)),
}

/** 由多处文案拼成、整体不以任何一条字面量出现在源码里的锚点——豁免存活校验，
 *  但**必须逐条写清是哪些片段拼的**，否则这栏就成了放水口。 */
export const ANCHOR_FREE_TEXT: string[] = []


