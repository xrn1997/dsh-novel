/**
 * legado 书源的 `exploreUrl` → 分类入口（`{title,url}[]`）的**唯一实现**。形态判据（js / JSON / `标题::URL`）一旦被两处各写
 * 一遍，就会在「什么算 JSON」上分叉——后果是同一个源在两条路径上「进城 / 不进城」不一致，只表现为某源分类时有时无。
 *
 * 本模块只解**声明式两档**；`@js:` / `<js>` 档要跑沙箱才拿得到条目，而「什么时候重算分类」与「刻意不设清缓存出口」冲突
 * （矩阵 `h-source-refresh-explore`），故如实返回空 + `form:'js'`，由调用方留痕。对象形态 `{标题: URL}` **不认**。
 */
export type ExploreKindsForm = 'empty' | 'js' | 'json' | 'text' | 'unknown'

/** 正则放过大小写：`@JS:` / `<JS>` 是书源作者手写的大小写，只认小写字面量会把同一形态判成 `unknown`、整块分类缺席。前导空白
 *  不在这里容忍（归一由 `exploreKindsFormOf` 先 trim）。与 `engine/grammar.ts` 的 `isJsForm` 是**刻意的宽窄差**：那边是规则文法侧三形态
 *  的登记处（多认串首裸 `js:`），这里只认 `@js:` 与 `<js>` 两式（矩阵 `d-explore-three-forms`）。 */
const JS_FORM = /^(@js:|<js>)/i

/** 形态判定的优先级是**写死的**：js → JSON → 含 `::` 的文本。次序是「三档互斥」的前提——js 先判，否则 `@js:` 里产出 JSON 的源
 *  会被读成 JSON；JSON 先于文本，否则标题含 `::` 的 JSON 条目会被读成文本。普查面的三条分档谓词**以本函数为准**。
 *  「在场但认不出」一律 `unknown`（含非串值：字符串化发生在 normalizeSource 落位那一步之后）；折成 `empty` 等于替源主宣布
 *  「这个源没有分类」——`empty` 只留给真的没写与写了空白。 */
export function exploreKindsFormOf(v: unknown): ExploreKindsForm {
  if (typeof v !== 'string') return v === undefined || v === null ? 'empty' : 'unknown'
  const t = v.trim()
  if (t === '') return 'empty'
  if (JS_FORM.test(t)) return 'js'
  if (t.startsWith('[') || t.startsWith('{')) return 'json'
  return t.includes('::') ? 'text' : 'unknown'
}

/** 一条分类入口「可用」的唯一尺：**去空白后标题与地址都是非空串**，产出即去空白后的条目。四家读它（文本档切出的两段、JSON 档
 *  对象项、原生 `ruleFind.kinds`、平铺优先的数组尺）：任何一处只判容器，脏条目就钻进模型——一条 `{}` 被算成真分类，界面上多出
 *  空名入口。 */
export function usableText(title: unknown, url: unknown): { title: string; url: string } | null {
  if (typeof title !== 'string' || typeof url !== 'string') return null
  const t = title.trim(), u = url.trim()
  return t === '' || u === '' ? null : { title: t, url: u }
}

/** `usableText` 的对象位读法：非对象、数组、以及标题或地址缺失或非串，全按「这条不可用」同值处理。 */
export function usableKind(e: unknown): { title: string; url: string } | null {
  if (typeof e !== 'object' || e === null || Array.isArray(e)) return null
  const o = e as Record<string, unknown>
  return usableText(o.title, o.url)
}

/** 文本档口径（矩阵 `d-explore-three-forms`）：条目分隔是 `(&&|\n)+`，每条按 `::` 切后**只取前两段**；标题或地址为空的条目不收。
 *  一条都不认时交回 `undefined`：文本档没有「老实的空集合」这一值——含 `::` 就是声明了至少一个入口，读不出只能是坏语法。 */
function parseTextKinds(t: string): Array<{ title: string; url: string }> | undefined {
  const out: Array<{ title: string; url: string }> = []
  for (const seg of t.split(/(?:&&|\n)+/)) {
    const parts = seg.split('::')
    if (parts.length < 2) continue
    const k = usableText(parts[0], parts[1])
    if (k !== null) out.push(k)
  }
  return out.length === 0 ? undefined : out
}

/** JSON 档：只认「对象数组且每项都过 `usableKind`」，存去空白后的值；`style` 是发现页排版字段，照收不误地忽略。读不出任何条目即回
 *  `undefined`：**声明了形状却一条都不认**与「老实的空数组」是两种值——把前者折进后者就是拿空结果冒充「这个源没有分类」。这条尺
 *  两档共用（`parseTextKinds` 同形）。 */
function parseJsonKinds(t: string): Array<{ title: string; url: string }> | undefined {
  let parsed: unknown
  try { parsed = JSON.parse(t) } catch { return undefined }
  if (!Array.isArray(parsed)) return undefined
  const out: Array<{ title: string; url: string }> = []
  for (const e of parsed) {
    const k = usableKind(e)
    if (k === null) continue
    out.push(k)
  }
  return out.length === 0 && parsed.length > 0 ? undefined : out
}

/** 两档解析的出口。两个导出函数答的是**两个不同的问题**：`exploreKindsFormOf` 答「这段值**声明成**哪种形态」（普查面按它分档）；
 *  这里的 `form` 答「**读出了**什么、调用方要不要点名」（导入侧按它留痕）。所以同一段值可以声明为 JSON 却一条都读不出——
 *  那边给 `json`、这里给 `unknown`。对齐成同一个数，就等于同时丢掉「写了什么形状」与「这条得点名」。 */
export function parseExploreKinds(v: unknown): { kinds: Array<{ title: string; url: string }>; form: ExploreKindsForm } {
  const form = exploreKindsFormOf(v)
  if (form === 'empty' || form === 'js' || form === 'unknown') return { kinds: [], form }
  // 非串已归入 empty / unknown；这一行只为过类型检查，不重新判一次形状（判两次的两处迟早分叉）。
  const t = typeof v === 'string' ? v.trim() : ''
  const kinds = form === 'text' ? parseTextKinds(t) : parseJsonKinds(t)
  return kinds === undefined ? { kinds: [], form: 'unknown' } : { kinds, form }
}
