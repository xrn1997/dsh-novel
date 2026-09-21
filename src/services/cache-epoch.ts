import { createHash } from 'node:crypto'
import type { Facet } from '../engine/index.js'
import type { NormalizedRules } from './types.js'

/**
 * 缓存代际：规则指纹是「这份缓存还有效吗」的唯一算式。
 *
 * 为什么要它（详见 docs/design/services.md §「缓存有效性」）：同址替换复用 sourceId 保书架引用
 * （既有裁决），于是「身份没变」被当成了「内容仍有效」——换规则后目录/正文照旧命中旧代际，
 * 而全仓没有清缓存的出口、阅读器也从不发 refresh=1，脏命中是永久的。
 *
 * 代际入键而不是删除式失效：在途请求写的是它起飞时那个代际的文件名，新规则的读永远
 * 看不见它——「旧在途写回」自动无害，不需要墓碑也不需要取消通道。删除式失效要额外挡
 * 回写，且 intake 有两个调用方（importOne / import-job 批量），任一处忘了调就漏。
 *
 * `Record<keyof NormalizedRules, …>` 只保证**每个字段都有一行**（往 NormalizedRules 加字段
 * 而没在此归类 → `pnpm typecheck` 红）；但**把字段归错行 tsc 抓不住**。所以给一个字段归类前，
 * 先核对 `getTocInner` / `getChapter` / `followOrSingle` 是否真的消费它（`ruleBookList` 行的
 * 注释就是这条自查的范例）。
 *
 * 刻意**不含** `NovelSource.auth`：登录态刷新会让指纹变，整源缓存每次登录后全灭。
 */

/** 影响面：改一个规则字段会作废哪些**引擎面**的缓存。与 CONTEXT.md 的「面（facet）」**不是同一条轴**——
 *  「面」是规则求值的上下文（引擎 `Facet`，六值），「影响面」是一个字段变更波及的缓存面集合（四值）。
 *  刻意换个词，避免给「面」长出第二个同义词。 */
export type EpochImpact = 'toc' | 'content' | 'both' | 'none'

/** 缓存有效性真正关心的引擎面：只有目录与正文有文件缓存（见 cache.ts），故从 `Facet` 收窄出这两值。 */
export type CacheFacet = Extract<Facet, 'toc' | 'content'>

export const RULE_EPOCH_IMPACT: Record<keyof NormalizedRules, EpochImpact> = {
  searchUrl: 'none', exploreUrl: 'none',
  // 目录面在缺 ruleChapterList 时回退 ruleBookList（reading.getTocInner 的既有口径）
  ruleBookList: 'toc',
  ruleBookName: 'none', ruleAuthor: 'none', ruleBookUrl: 'none',
  ruleCoverUrl: 'none', ruleIntro: 'none', ruleLastChapter: 'none',
  ruleTocUrl: 'toc', ruleChapterList: 'toc', ruleChapterName: 'toc', ruleChapterUrl: 'toc',
  ruleDetailName: 'none', ruleDetailAuthor: 'none', ruleDetailCoverUrl: 'none',
  ruleDetailIntro: 'none', ruleDetailLastChapter: 'none',
  // init 决定详情字段与 tocUrl 模板 `{{$.…}}` 的求值上下文（legado BookInfo.init 换根）——
  // 改 init 即换目录地址的插值来源 → 目录代际必须失效；正文经 FACES_OF 的 toc 行连带
  ruleDetailInit: 'toc',
  ruleContent: 'content', nextTocUrl: 'toc', nextPageUrl: 'content',
  header: 'both', loginUrl: 'none', jsLib: 'both',
  // 动态头规则与静态 header 同影响面：换规则 = 换 device/UA/鉴权 → 站点返回可能整体不同
  headerRule: 'both',
}

/** 影响面 → 它作废哪些**引擎面**的缓存。`Record<EpochImpact, …>` 同样由编译器强制穷尽：
 *  新加一个影响面而忘了给它配面集 → tsc 红。否则那个面会静默退化成「谁都不作废」，
 *  而这类退化没有任何测试能抓到（见 tests/services/cache-epoch.test.ts 的逐字段翻转钉子）。
 *
 *  `toc` 同时作废**正文**代际：正文的输入是目录的产物。改了 ruleChapterUrl 这类规则，
 *  章名可能一字不变而章节地址已换——旧正文是用旧地址抓的，槽位（代际 + 章名）挡不住，
 *  只有代际能挡。这与「槽位刻意不含章节 url」不矛盾：那里排除的是**站点侧**的 url 抖动
 *  （时效 token，每次刷目录都换，入键等于正文缓存永不命中），这里是**规则侧**的 url 变更。 */
const FACES_OF: Record<EpochImpact, readonly CacheFacet[]> = {
  toc: ['toc', 'content'],
  content: ['content'],
  both: ['toc', 'content'],
  none: [],
}

/** 固定顺序取字面量插入序：跨重启、跨 normalize 路径都稳定（不用 JSON.stringify(rules) 赌键序） */
const ORDER = Object.keys(RULE_EPOCH_IMPACT) as Array<keyof NormalizedRules>

/** 规则值的真实域（`NormalizedRules` 的全体值类型）：签名收窄后，将来某个规则字段变成
 *  数组/嵌套对象会是 tsc 错，而不是被 `String(v)` 静默拍成 "[object Object]" 共用一个指纹。 */
type RuleValue = NormalizedRules[keyof NormalizedRules]

/** 值稳定化：header 是对象，按排序键拼（同一份 header 的不同键序必须同指纹）。
 *  null 与 '' 必须分开：空串规则与缺规则在求值层行为不同（见 reading.getTocInner 的订正注）。
 *  存量兼容：老 sources.json 的 rules 可能缺新增字段的键（undefined）——按缺省（≡null）入指纹，
 *  与显式 null 同代际；SourceRegistry.load 的存量归一会补键落盘收敛，此处是读旧数据的运行时防线。 */
function stable(v: RuleValue | undefined): string {
  if (v === null || v === undefined) return '\u0001'
  if (typeof v === 'string') return v
  return Object.keys(v).sort().map((k) => `${k}=${v[k]}`).join('&')
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

/**
 * 正文槽位：代际 + 章名。
 *
 * 为什么带章名（详见 docs/design/services.md §「缓存有效性」）：正文按 chIndex 存，
 * 站点在前面插一章 → 全体 index 位移 → 旧文件端给读者的是**另一章**。代际管「规则变了」，
 * 章名管「站点侧目录变了」，两者正交、都需要。刻意**不含章节 url**：带时效 token 的
 * 站点每次刷目录都换 url，入键等于正文缓存永不命中；章名 + index 稳定即命中，
 * 且串配照样挡住（index 与章名同时对上而内容不同 = 同一位置同一标题的另一篇，不成立）。
 */
export function contentSlot(epoch: string, chapterName: string): string {
  return digest([epoch, chapterName])
}
