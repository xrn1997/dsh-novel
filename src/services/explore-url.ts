/**
 * legado 书源的 `exploreUrl` → 分类入口（`{title,url}[]`）的**唯一实现**。
 *
 * 为什么另起一个模块：形态判据（js / JSON / `标题::URL`）必须有唯一主人。它一旦被两处各写一遍，
 * 就会在「什么算 JSON」上分叉，而分叉的后果是同一个源在两条路径上「进城 / 不进城」不一致——
 * 这种差异只表现为某个源的分类时有时无，从任何一边的日志里都查不到原因。
 *
 * 本模块只解**声明式两档**。`@js:` / `<js>` 那档要跑沙箱才拿得到条目，而「什么时候重算分类」
 * 与本仓「刻意不设清缓存出口」是直接冲突项（见矩阵行 `h-source-refresh-explore`），
 * 不在本模块里顺手定：它如实返回空 + `form:'js'`，由调用方留痕。
 *
 * 对象形态 `{标题: URL}` **不认**：对面那条分支的出处未读到，本仓不猜结构——
 * 认不出/读不出时怎么落地，见 `parseJsonKinds` 那条两档共用的尺。
 */
export type ExploreKindsForm = 'empty' | 'js' | 'json' | 'text' | 'unknown'

/** 这个正则为什么放过大小写：`@JS:` / `<JS>` 是书源作者手写的大小写。判据若只认小写字面量就是
 *  把自己写得比对面窄——同一形态被判成 `unknown`，代价是那个源的分类整块缺席。
 *  前导空白**不在这里**容忍：整份值常带模板换行与缩进，归一只做一处，由 `exploreKindsFormOf`
 *  进来先 trim 负责（这里再留一条 `\s*` 是给同一次归一写第二份，且永远命中不到）。
 *
 *  与 `engine/grammar.ts` 的 `isJsForm` 是**刻意的宽窄差**，不是这里有两个主人：那边是规则文法侧
 *  三形态的登记处（多认串首裸 `js:`），这里只认 `@js:` 与 `<js>` 两式——对面读发现入口那处剥的就
 *  是这两式（逐条对读在册矩阵行 `d-explore-three-forms`）。顺手「合并成同一个判定」会把这一档
 *  放宽成「裸 `js:` 的 exploreUrl 也算 js 档」，而那形态在发现入口上没有任何出处。 */
const JS_FORM = /^(@js:|<js>)/i

/** 形态判定的优先级是**写死的**：js → JSON → 含 `::` 的文本。次序是「三档互斥」的前提——
 *  js 那档先判，否则 `@js:` 里产出一段 JSON 的源会被读成 JSON 档；JSON 档先于文本档，
 *  否则标题含 `::` 的 JSON 条目会被读成文本。普查面（`tests/engine/parse-census.test.ts` 的
 *  `exploreForm*`）的三条分档谓词**以本函数为准**，不得在那里内联第二份判据。
 *
 *  「在场但认不出」一律 `unknown`，其中包含**非串的值**：调用方 `normalize.flattenDialect` 从
 *  `{ ...raw }` 起步，`exploreUrl` 要到 `RULE_FIELDS` 那一圈才被字符串化，所以传进来的完全可能是
 *  数组 / 对象 / 数字这种脏形状。把它折成 `empty` 等于替源主宣布「这个源没有分类」——而它只是
 *  本模块读不懂；`empty` 只留给真的没写（缺席）与写了空白这两种。 */
export function exploreKindsFormOf(v: unknown): ExploreKindsForm {
  if (typeof v !== 'string') return v === undefined || v === null ? 'empty' : 'unknown'
  const t = v.trim()
  if (t === '') return 'empty'
  if (JS_FORM.test(t)) return 'js'
  if (t.startsWith('[') || t.startsWith('{')) return 'json'
  return t.includes('::') ? 'text' : 'unknown'
}

/** 对面文本档口径（出处与逐条对读在册矩阵行 `d-explore-three-forms`）：条目分隔是
 *  `(&&|\n)+`（两种可混用可连续），每条按 `::` 切后**只取前两段**——第三段及之后直接丢弃，
 *  不报错也不参与；标题或地址为空的条目不收（一个没有地址的入口在抓取链上只会变成一次失败）。
 *  一条都不认时交回 `undefined`（尺与裁决的主人在 `parseJsonKinds`）：文本档没有「老老实实的
 *  空集合」这一值——含 `::` 就是声明了至少一个入口，读不出只能是坏语法。 */
function parseTextKinds(t: string): Array<{ title: string; url: string }> | undefined {
  const out: Array<{ title: string; url: string }> = []
  for (const seg of t.split(/(?:&&|\n)+/)) {
    const parts = seg.split('::')
    if (parts.length < 2) continue
    const title = parts[0].trim()
    const url = parts[1].trim()
    if (title !== '' && url !== '') out.push({ title, url })
  }
  return out.length === 0 ? undefined : out
}

/** JSON 档：只认「对象数组且每项 `title`+`url` 都是去空白后非空的串」，存的即去空白后的值——
 *  判空的尺与文本档同一把（口径见 `parseTextKinds`）：两档对「空」不一致，词表里就会躺着取不到
 *  东西的入口，而它只在抓取链上炸。`style` 是对面发现页的排版字段（本仓词表不排版），
 *  照收不误地忽略掉——它不构成「认不出的形状」。
 *
 *  读不出任何条目即回 `undefined`（调用方落成 `unknown`）：**声明了形状却一条都不认**，与
 *  「老老实实的空数组」是两种值——前者要调用方点名，后者是空集合。把前者折进后者，就是拿
 *  空结果冒充「这个源没有分类」，本仓最高罪。这条尺是**两档共用的**（`parseTextKinds` 同形），
 *  否则文本档的坏语法既不进城也不被点名，只有 JSON 档被捞出来。 */
function parseJsonKinds(t: string): Array<{ title: string; url: string }> | undefined {
  let parsed: unknown
  try { parsed = JSON.parse(t) } catch { return undefined }
  if (!Array.isArray(parsed)) return undefined
  const out: Array<{ title: string; url: string }> = []
  for (const e of parsed) {
    if (typeof e !== 'object' || e === null || Array.isArray(e)) continue
    const o = e as Record<string, unknown>
    if (typeof o.title !== 'string' || typeof o.url !== 'string') continue
    const title = o.title.trim()
    const url = o.url.trim()
    if (title === '' || url === '') continue
    out.push({ title, url })
  }
  return out.length === 0 && parsed.length > 0 ? undefined : out
}

/** 两档解析的出口，`form` 随条目一起给回调用方。
 *
 *  本模块两个导出函数答的是**两个不同的问题**，别把它们的差读成分叉：`exploreKindsFormOf` 答
 *  「这段值**声明成**哪种形态」（普查面按它分档，看的是书源写下的形状）；这里的 `form` 答
 *  「**读出了**什么、调用方要不要点名」（导入侧按它留痕）。所以同一段值可以声明为 JSON 却一条都
 *  读不出——那边给 `json`、这里给 `unknown`（`'["纯字符串"]'` 就是这一对）。两边各有职责：
 *  把它们对齐成同一个数，就等于同时丢掉「这源写了什么形状」与「这条得点名」两个读数。 */
export function parseExploreKinds(v: unknown): { kinds: Array<{ title: string; url: string }>; form: ExploreKindsForm } {
  const form = exploreKindsFormOf(v)
  if (form === 'empty' || form === 'js' || form === 'unknown') return { kinds: [], form }
  // 非串在上面已全部归入 empty / unknown，json 与 text 只在串上成立；这一行只为过类型检查，
  // 不重新判一次形状（判两次的两处迟早分叉）。
  const t = typeof v === 'string' ? v.trim() : ''
  const kinds = form === 'text' ? parseTextKinds(t) : parseJsonKinds(t)
  return kinds === undefined ? { kinds: [], form: 'unknown' } : { kinds, form }
}
