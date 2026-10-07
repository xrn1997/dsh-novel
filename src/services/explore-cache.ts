import type { SearchGroup } from '../shared/wire.js'

/** 分类浏览的内存有效期。**这是估值不是实测**——浏览面不需要秒级新鲜，但也不该让用户
 *  每次进同一个分类都重打一遍站点。真机观察重复进入的命中率后再调。 */
export const EXPLORE_CACHE_TTL_MS = 15 * 60_000

export interface KindCacheKey {
  sourceId: string
  /** 该源上这一类的**入口地址**（`fetchExploreGroup` 收的那个入参）：原生方言下它是填进 `{{kind}}` 的
   *  slug，legado 方言下它是整条模板——键这一侧不解释它是哪一种，两方言同形。
   *  **槽位按地址切、不按分类名切**（裁决主人 `explore.ts` 的 `fetchExploreGroup`：地址跟源一起走，
   *  按源列出的标题清单存不下唯一地址；键也由它自己组装）。后果如实：同一源把两个
   *  分类名声明成同一地址时它们**共用一个槽位**，第二次进入零请求。
   *  地址不另进规则代际（它已是键的一半，见 `cache-epoch.exploreEpoch`）。 */
  kind: string
  /** 该源的规则代际：换规则自然失效——复用 cache-epoch 的算式，不新造时效。
   *  收 `string | number` 是因为本仓的代际生产者 `rulesEpoch` 产出摘要串、而键这一侧无权替它发明
   *  一次摘要→数字的转换（转换会掩盖代际的来源，也让「换规则即失效」取决于转换是否无损）。 */
  epoch: string | number
  /** 第几页。**第 2 页与第 1 页是两份不同的快照**：站点上的页码就是不同的那份书单，共用一个槽位会让
   *  「继续加载」端出首页那一组，用户看到的是同一批书被当成新的一页。 */
  page: number
}

/** 逐源分类结果的内存快照。**只活在进程内**：落盘要连带代际、清理与删源连带，成本远大于收益。
 *  也**不做手动刷新出口**——与既有「没有清缓存出口是设计」同口径。 */
export class KindCache {
  private readonly map = new Map<string, { group: SearchGroup; at: number }>()

  /** 代际值的两种拼法（`7` 与 `'7'`）必须落在不同槽位：键里带上它的类型，否则一个数字代际的
   *  调用方与一个摘要串代际的调用方会静默共用槽位——而它们对「规则变了吗」的答案是两回事。 */
  private static keyOf(k: KindCacheKey): string {
    return `${k.sourceId}\u0000${k.kind}\u0000${typeof k.epoch}\u0000${k.epoch}\u0000${k.page}`
  }

  get(k: KindCacheKey, now: number): SearchGroup | null {
    const hit = this.map.get(KindCache.keyOf(k))
    if (hit === undefined) return null
    if (now - hit.at > EXPLORE_CACHE_TTL_MS) { this.map.delete(KindCache.keyOf(k)); return null }
    return hit.group
  }

  put(k: KindCacheKey, group: SearchGroup, now: number): void {
    this.map.set(KindCache.keyOf(k), { group, at: now })
  }
}
