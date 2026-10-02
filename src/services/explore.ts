import { fetchKindPage } from './explore-face.js'
import type { KindCache } from './explore-cache.js'
import type { Fetcher } from './fetcher.js'
import { exploreParticipates } from './participation.js'
import { searchErrorCodeOf } from './search-face.js'
import type { SearchGroup, SearchHit } from '../shared/wire.js'
import type { NovelSource } from './types.js'

/**
 * 发现面（书城）的**词表**：把「各参与源声明的分类入口」摊成一份可看的分类清单。
 *  「谁进城」的判据不在这里——单点是 `participation.exploreParticipates`（启用 ∧ 文本源 ∧
 *  声明了分类入口）；本模块只做**派生**，不复制那份启停 invariant。
 *
 *  分类是站点的自由文本，本仓**不造同义词表**：「玄幻」与「奇幻」是站点的真实分歧，
 *  替用户判它们是一回事就是发明数据。两个函数因此共用同一条匹配规则——**精确同名**。
 *
 *  分工：两个词表函数是**纯函数**（不碰网络、不看时钟、不留状态）；一轮分类抓取的编排是
 *  同文件的 `runExploreKind`——网络与时钟只活在它那一条链上，词表两侧不必跟着它们变毒。
 */

/** 分类词表：各参与源 `rules.ruleExploreKinds`（原生 `ruleFind.kinds`）的精确同名并集，
 *  `sources` 计的是**声明了这条分类的源数**——它就是最诚实的热度依据，不另发明评分。
 *  计数按源内去重（首条胜）：这个读数会被界面当成「N **源**收录」的角标，而同一个源把同一
 *  标题声明两遍并不构成第二个源，多算一次就是对一个用户可见事实说谎；取源侧一个源在一个
 *  分类上也只发一次请求，两侧同口径。跨源合并仍然逐源各计一次——不同源是真·不同来源。
 *  排序按源数降序，同数保持首次出现序（靠 `Array.prototype.sort` 的稳定性，不另记序号字段：
 *  序号是实现细节，留着只会诱使后来者按它排序）。
 *
 *  不判 `ruleExploreKinds` 是否在场：该键由归一化恒落位（消费者按 `.length` 读分类面），
 *  在这里补 `?? []` 就是把「缺键」与「没有分类」折叠，还会把归一化的漏落藏起来。 */
export function kindsOf(sources: NovelSource[]): Array<{ title: string; sources: number }> {
  const counts = new Map<string, number>()
  for (const s of sources) {
    if (!exploreParticipates(s)) continue
    const seen = new Set<string>()
    for (const k of s.rules.ruleExploreKinds) {
      if (seen.has(k.title)) continue
      seen.add(k.title)
      counts.set(k.title, (counts.get(k.title) ?? 0) + 1)
    }
  }
  return [...counts.entries()]
    .map(([title, n]) => ({ title, sources: n }))
    .sort((a, b) => b.sources - a.sources)
}

/** 一轮分类抓取的一个目标：**一个源 + 它自己那一类的地址**。
 *  分类词表存不下唯一地址（同一个分类名在不同站上是不同 url），地址只能跟源一起走。
 *  这个形状由 `sourcesOfKind` 与 `runExploreKind` 共用——两处各写一遍匿名结构就会长成两份口径。 */
export interface ExploreTarget {
  source: NovelSource
  kindUrl: string
}

/** 参与某个分类的源，附上**该源自己的**这一类 slug —— 同一个分类名在不同站上是不同的 url，
 *  词表里存不下唯一地址，所以地址只能跟源一起给：调用方（一轮分类抓取）拿它去发该源的请求。
 *  匹配与词表同一条规则（精确同名，不 trim、不折大小写）：在这里 trim 会让两边对不上——
 *  词表因某个源标题多一个尾空格而多出一条，这一侧却把它归到「玄幻」上。
 *  一个源在这个分类下只产出一条目标——该源若把同一 title 声明多次，取**首次出现**那条的地址
 *  （后续那条没有独立入口，重复产出只会让同一个源被抓两遍）。结果按输入的源清单顺序，不重排
 *  ——这一串是要逐源发请求的，顺序归调用方。 */
export function sourcesOfKind(
  sources: NovelSource[], kind: string,
): ExploreTarget[] {
  const out: ExploreTarget[] = []
  for (const s of sources) {
    if (!exploreParticipates(s)) continue
    const hit = s.rules.ruleExploreKinds.find((k) => k.title === kind)
    if (hit !== undefined) out.push({ source: s, kindUrl: hit.url })
  }
  return out
}

/**
 * 一轮分类抓取：按批并行走完参与源，逐源把结果**按完成序**交出去（谁先抓完谁先可见，
 *  用户看的第一条因此是最先到的那一源，而不是清单里排第一的那个）。
 *
 *  逐源快照（`cfg.cache`）：命中即**零请求**——重复进同一个分类不该重打站点，这是缓存存在的全部理由。
 *  只写成功结果：把失败也缓存住等于把一次偶发故障钉死到 TTL 结束。代际值由**调用方**算好
 *  （`cfg.epochOf`）——`rulesEpoch` 的消费者是服务层，编排层不认识它，也就不必跟着规则面演化。
 *
 *  两种失败分列：规则缺失与抓取失败都是 `fetchKindPage` 的**结果**（该源这一类的 error 组，
 *  整轮不因此失败）；而它上抛的传输/求值异常由这里 catch 并交给 `searchErrorCodeOf` 归类
 *  ——错误码投影的单一主人是搜索面，本模块不另写一份映射。
 *
 *  `shouldStop` 只挡**还未开抓**的源，在途请求不撤回（协作式取消，与聚合搜索同口径）；
 *  它由持有者按轮次状态回答，本模块不持有任何轮次状态。
 *  `cfg.now` 可注入：快照的时效判据要能被测试推到边界之外。
 */
export async function runExploreKind(
  targets: ExploreTarget[], fetcher: Fetcher,
  cfg: {
    parallel: number; timeoutMs: number; jsTimeoutMs?: number
    /** 逐源缓存；缺省即不缓存（单测直调与无缓存组合走这条） */
    cache?: KindCache
    /** 该源的规则代际（调用方算好——`rulesEpoch` 的消费者在服务层，编排层不认识它） */
    epochOf?: (s: NovelSource) => string | number
    now?: () => number
  },
  emit: (group: SearchGroup) => void, shouldStop: () => boolean,
): Promise<void> {
  const now = cfg.now ?? Date.now
  for (let i = 0; i < targets.length; i += cfg.parallel) {
    if (shouldStop()) return
    const batch = targets.slice(i, i + cfg.parallel)
    await Promise.all(batch.map(async ({ source, kindUrl }) => {
      if (shouldStop()) return
      const base = { sourceId: source.id, sourceName: source.name, status: source.status, statusDetail: source.statusDetail, hits: [] as SearchHit[] }
      const cacheKey = { sourceId: source.id, kind: kindUrl, epoch: cfg.epochOf?.(source) ?? 0 }
      const cached = cfg.cache?.get(cacheKey, now())
      if (cached !== undefined && cached !== null) { emit(cached); return }   // 命中即零请求
      try {
        const page = await fetchKindPage(source, kindUrl, fetcher, cfg.timeoutMs, cfg.jsTimeoutMs)
        const group = page.ok ? { ...base, hits: page.hits } : { ...base, error: { code: page.code, message: page.message } }
        if (page.ok) cfg.cache?.put(cacheKey, group, now())                    // 只有成功才写缓存：把失败也缓存住等于把偶发故障钉死
        emit(group)
      } catch (e) {
        emit({ ...base, error: { code: searchErrorCodeOf(e), message: e instanceof Error ? e.message : String(e) } })
      }
    }))
  }
}
