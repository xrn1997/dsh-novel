import type { NovelSource } from './types.js'
import { exploreParticipates } from './participation.js'

/**
 * 发现面（书城）的**词表**：把「各参与源声明的分类入口」摊成一份可看的分类清单。
 *  「谁进城」的判据不在这里——单点是 `participation.exploreParticipates`（启用 ∧ 文本源 ∧
 *  声明了分类入口）；本模块只做**派生**，不复制那份启停 invariant。
 *
 *  分类是站点的自由文本，本仓**不造同义词表**：「玄幻」与「奇幻」是站点的真实分歧，
 *  替用户判它们是一回事就是发明数据。两个函数因此共用同一条匹配规则——**精确同名**。
 *
 *  纯函数：不碰网络、不看时钟、不留状态。逐源抓取与一轮归并的编排是本模块后续要长出来的部分。
 */

/** 分类词表：各参与源 `rules.ruleExploreKinds`（原生 `ruleFind.kinds`）的精确同名并集，
 *  `sources` 计的是**声明了这条分类的源数**——它就是最诚实的热度依据，不另发明评分。
 *  计数按声明**次数**逐条累加（归一化只映射、不去重），故同一源在同一个 `kinds` 里把同名
 *  声明两遍会记 2：这是源自己的冗余，读数如实反映它，不在这里替它去重。
 *  排序按源数降序，同数保持首次出现序（靠 `Array.prototype.sort` 的稳定性，不另记序号字段：
 *  序号是实现细节，留着只会诱使后来者按它排序）。
 *
 *  不判 `ruleExploreKinds` 是否在场：该键由归一化恒落位（消费者按 `.length` 读分类面），
 *  在这里补 `?? []` 就是把「缺键」与「没有分类」折叠，还会把归一化的漏落藏起来。 */
export function kindsOf(sources: NovelSource[]): Array<{ title: string; sources: number }> {
  const counts = new Map<string, number>()
  for (const s of sources) {
    if (!exploreParticipates(s)) continue
    for (const k of s.rules.ruleExploreKinds) counts.set(k.title, (counts.get(k.title) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([title, n]) => ({ title, sources: n }))
    .sort((a, b) => b.sources - a.sources)
}

/** 参与某个分类的源，附上**该源自己的**这一类 slug —— 同一个分类名在不同站上是不同的 url，
 *  词表里存不下唯一地址，所以地址只能跟源一起给：调用方（一轮分类抓取）拿它去发该源的请求。
 *  匹配与词表同一条规则（精确同名，不 trim、不折大小写）：在这里 trim 会让两边对不上——
 *  词表因某个源标题多一个尾空格而多出一条，这一侧却把它归到「玄幻」上。
 *  该源在 `ruleExploreKinds` 里对同一 title 声明多次时取**首次出现**那条（`find` 语义）；
 *  结果按输入的源清单顺序，不重排——这一串是要逐源发请求的，顺序归调用方。 */
export function sourcesOfKind(
  sources: NovelSource[], kind: string,
): Array<{ source: NovelSource; kindUrl: string }> {
  const out: Array<{ source: NovelSource; kindUrl: string }> = []
  for (const s of sources) {
    if (!exploreParticipates(s)) continue
    const hit = s.rules.ruleExploreKinds.find((k) => k.title === kind)
    if (hit !== undefined) out.push({ source: s, kindUrl: hit.url })
  }
  return out
}
