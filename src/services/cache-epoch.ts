import { createHash } from 'node:crypto'
import type { Facet } from '../engine/index.js'
import { EXPLORE_FALLBACK_FIELDS, VACANT_RULE_FIELDS } from './rule-fields.js'
import type { NormalizedRules } from './types.js'

/**
 * 缓存代际：规则指纹是「这份缓存还有效吗」的唯一算式。本仓有**两种缓存**，各一份指纹——文件缓存（目录/正文，
 * `rulesEpoch`）与进程内分类快照（`exploreEpoch`），为何不能共用见 `exploreEpoch`。
 *
 * 为什么要它：同址替换复用 sourceId 保书架引用，于是「身份没变」被当成「内容仍有效」——换规则后目录/正文照旧
 * 命中旧代际，而全仓没有清缓存的出口，脏命中是永久的。
 *
 * 代际入键而不是删除式失效：在途请求写的是它起飞时那个代际的文件名，新规则的读永远看不见它——「旧在途写回」
 * 自动无害，不需要墓碑也不需要取消通道（删除式失效要额外挡回写，且 intake 两个调用方任一处忘了调就漏）。
 *
 * `Record<keyof NormalizedRules, …>` 只保证**每个字段都有一行**，但**归错行 tsc 抓不住**——给字段归类前先核对
 * `getTocInner` / `chapterText` / `followOrSingle` 是否真的消费它。刻意**不含** `NovelSource.auth`（登录态刷新会让
 * 整源缓存全灭）。
 */

/** 影响面：改一个规则字段会作废哪些**引擎面**的缓存。与「面（facet）」**不是同一条轴**——面是求值上下文（引擎 `Facet`），
 *  影响面是字段变更波及的缓存面集合。刻意换个词，避免给「面」长出第二个同义词。 */
export type EpochImpact = 'toc' | 'content' | 'both' | 'none'

/** 缓存有效性真正关心的引擎面：只有目录与正文有文件缓存（见 cache.ts），故从 `Facet` 收窄出这两值。 */
export type CacheFacet = Extract<Facet, 'toc' | 'content'>

export const RULE_EPOCH_IMPACT: Record<keyof NormalizedRules, EpochImpact> = {
  searchUrl: 'none', exploreUrl: 'none',
  // 发现面（书城）不落文件缓存：分类页结果由进程内快照持有，无目录/正文文件可作废
  ruleExploreUrl: 'none', ruleExploreKinds: 'none',
  ruleExploreList: 'none', ruleExploreName: 'none', ruleExploreAuthor: 'none',
  ruleExploreBookUrl: 'none', ruleExploreCoverUrl: 'none', ruleExploreIntro: 'none',
  ruleExploreKind: 'none', ruleExploreLastChapter: 'none', ruleExploreWordCount: 'none',
  // 探针关键词只影响「验证」这一步，不参与任何面的取值 → 不进缓存指纹
  probeKeyword: 'none',
  // 详情页嗅探只改搜索面「这条响应是不是详情页」，目录/正文取值与它无关
  bookUrlPattern: 'none',
  // 目录面在缺 ruleChapterList 时回退 ruleBookList（online-reading.getTocInner 的既有口径）
  ruleBookList: 'toc',
  ruleBookName: 'none', ruleAuthor: 'none', ruleBookUrl: 'none',
  ruleCoverUrl: 'none', ruleIntro: 'none', ruleLastChapter: 'none',
  ruleKind: 'none', ruleWordCount: 'none', ruleDetailKind: 'none', ruleDetailWordCount: 'none',
  ruleTocUrl: 'toc', ruleChapterList: 'toc', ruleChapterName: 'toc', ruleChapterUrl: 'toc',
  ruleChapterIsVip: 'toc', ruleChapterIsVolume: 'toc', ruleChapterIsPay: 'toc', ruleChapterUpdateTime: 'toc',
  ruleDetailName: 'none', ruleDetailAuthor: 'none', ruleDetailCoverUrl: 'none',
  ruleDetailIntro: 'none', ruleDetailLastChapter: 'none',
  // init 决定详情字段与 tocUrl 模板的求值上下文——改 init 即换目录地址的插值来源 → 目录代际必须失效；正文经 FACES_OF 连带
  ruleDetailInit: 'toc',
  ruleContent: 'content', ruleContentSubContent: 'content',
  nextTocUrl: 'toc', nextPageUrl: 'content',
  header: 'both', loginUrl: 'none', jsLib: 'both',
  // 动态头规则与静态 header 同影响面：换规则 = 换 device/UA/鉴权 → 站点返回可能整体不同
  headerRule: 'both',
}

/** 影响面 → 它作废哪些**引擎面**的缓存（`Record<EpochImpact, …>` 由编译器强制穷尽）。`toc` 同时作废**正文**代际：正文的输入是
 *  目录的产物，改了 ruleChapterUrl 章名可能不变而地址已换——旧正文是用旧地址抓的，槽位（代际 + 章名）挡不住，只有代际能挡。
 *  这与「槽位不含章节 url」不矛盾：那里排除的是站点侧 url 抖动，这里是规则侧 url 变更。 */
const FACES_OF: Record<EpochImpact, readonly CacheFacet[]> = {
  toc: ['toc', 'content'],
  content: ['content'],
  both: ['toc', 'content'],
  none: [],
}

/** 固定顺序取字面量插入序：跨重启、跨 normalize 路径都稳定（不用 JSON.stringify(rules) 赌键序） */
const ORDER = Object.keys(RULE_EPOCH_IMPACT) as Array<keyof NormalizedRules>

/** 规则值的真实域：签名收窄后，将来某个规则字段变成数组/嵌套对象会是 tsc 错，而不是被 `String(v)` 静默拍成 "[object Object]"。 */
type RuleValue = NormalizedRules[keyof NormalizedRules]

/** 值稳定化：header 是对象、ruleExploreKinds 是数组，都按排序键拼（同一份值的不同键序必须同指纹）。null 与 '' 必须分开：
 *  空串规则与缺规则在求值层行为不同。存量兼容：老 sources.json 的 rules 可能缺新增键（undefined）——按缺省（≡null）入指纹。 */
function stable(v: RuleValue | undefined): string {
  if (v === null || v === undefined) return '\u0001'
  if (typeof v === 'string') return v
  return Array.isArray(v) ? v.map(encodeOrdered).join('\u0002') : encodeOrdered(v)
}

/** 对象 → 键排序的 `k=v&…`（键序不入指纹）；值域是规则标量（字符串）。 */
function encodeOrdered(o: Record<string, string>): string {
  return Object.keys(o).sort().map((k) => `${k}=${o[k]}`).join('&')
}

function digest(parts: readonly string[]): string {
  return createHash('sha1').update(parts.join('\u0000')).digest('hex').slice(0, 10)
}

/** 某一面的规则代际（10 位十六进制；入缓存文件名） */
export function rulesEpoch(rules: NormalizedRules, baseUrl: string, facet: CacheFacet): string {
  const parts: string[] = [facet, baseUrl]
  for (const k of ORDER) {
    if (!FACES_OF[RULE_EPOCH_IMPACT[k]].includes(facet)) continue
    parts.push(k, stable(rules[k]))
  }
  return digest(parts)
}

/** 发现面指纹的字段表，分三组，**组即「它为什么在这里」**。前两组由规则字段表派生：① 发现面自有规则就是表里 `vacant` 档
 *  的键集；② **回落分支**读的九个通用书目字段由发现面行的配对列反推——「只声明了 ruleFind.kinds 的源」是常见形态，漏收这组，
 *  改书名/作者规则就不动缓存键。判据是「发现面求值真正经过谁」，不是按名字前缀自动收。`ruleExploreKinds`/`exploreUrl` 不在两组里。 */

/** ③ 请求修饰符：`header` 与 `headerRule` 定发出去的请求长什么样，`jsLib` 是 JS 规则库——任一变了，同一分类地址可拿回完全不同的页面。 */
const EXPLORE_REQUEST_FIELDS = [
  'header', 'headerRule', 'jsLib',
] as const satisfies readonly (keyof NormalizedRules)[]

/** 三组的并集即指纹字段集。`baseUrl` 不在此表内（它不是规则字段），由 `exploreEpoch` 入参带入。 */
const EXPLORE_FINGERPRINT: readonly (keyof NormalizedRules)[] = [
  ...VACANT_RULE_FIELDS, ...EXPLORE_FALLBACK_FIELDS, ...EXPLORE_REQUEST_FIELDS,
]

/**
 * 发现面（书城）快照的规则代际：**两个缓存、两份指纹、同一个主人**。`rulesEpoch` 管**文件**缓存（目录/正文），
 * `exploreEpoch` 管**进程内**分类快照。
 *
 * 为什么不能共用一份：`RULE_EPOCH_IMPACT` 的影响面是「字段变更波及哪些**引擎面**」，而引擎面只有目录与正文——
 * 分类页不落文件缓存，所以那十行归 `'none'` 是**对的，不是漏填**；反过来把发现面字段归进引擎面，会让目录/正文
 * 代际跟着探索规则抖，凭空作废整源文件缓存。发现面要的「换规则自然失效」由这份指纹独立兑现，不必等 TTL。
 *
 * 收谁：**一次发现面请求 + 解析读到的全部输入**——上面三组规则字段 + baseUrl。为什么收这么宽：快照存的是
 * 「一次请求 + 解析的结果」，它有没有效取决于这次请求的全部输入；**过度失效是免费的，漏失效是陈旧谎**。
 *
 * 刻意不含 `exploreUrl` 与 `ruleExploreKinds`：这两者只产出**分类入口地址**，而地址本身就是快照键的一半
 * （`KindCacheKey.kind`）——地址一变键就变，收进指纹是对同一件事作废两次。
 */
export function exploreEpoch(rules: NormalizedRules, baseUrl: string): string {
  const parts: string[] = [baseUrl]
  for (const k of EXPLORE_FINGERPRINT) parts.push(k, stable(rules[k]))
  return digest(parts)
}

/**
 * 正文槽位：代际 + 章名。为什么带章名：正文按 chIndex 存，站点在前面插一章 → 全体 index 位移 → 旧文件端给读者的是
 * **另一章**。刻意**不含章节 url**：带时效 token 的站点每次刷目录都换 url，入键等于正文缓存永不命中；章名 + index
 * 稳定即命中，且串配照样挡住（index 与章名同时对上而内容不同 = 同一位置同一标题的另一篇，不成立）。
 */
export function contentSlot(epoch: string, chapterName: string): string {
  return digest([epoch, chapterName])
}
