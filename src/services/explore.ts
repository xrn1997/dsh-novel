import { fetchKindPage } from './explore-face.js'
import type { KindCache } from './explore-cache.js'
import type { Fetcher } from './fetcher.js'
import { exploreParticipates } from './participation.js'
import { searchErrorCodeOf } from './search-face.js'
import type { ExploreSources, SearchGroup, SearchHit } from '../shared/wire.js'
import type { NovelSource } from './types.js'

/**
 * 发现面（书城）的两面：`deriveExploreSources` 派生「哪个源自己声明了哪些分类标题」，
 *  `fetchExploreGroup` 执行「单源一页」。分工照旧成立且更窄了——派生是**纯函数**
 *  （不碰网络、不看时钟、不留状态），网络与时钟只活在执行体那一条链上，派生侧不必跟着变毒。
 *
 *  「谁进城」的判据不在这里——单点是 `participation.exploreParticipates`（启用 ∧ 文本源 ∧
 *  声明了分类入口 ∧ 没把发现关掉）；本模块只做派生与执行，不复制那份启停 invariant。
 *
 *  分类标题是站点的自由文本，本仓**不造同义词表**：「玄幻」与「玄幻奇幻」是站点的真实分歧，
 *  替用户合并就是发明数据。浏览轴改成「点名一个源」（`docs/adr/0028`）之后，跨源摊平那份
 *  并集连同它的计数与热度序一起失去对象：清单按源列，一个源写了什么就摆什么。
 *
 *  不判 `ruleExploreKinds` 是否在场：该键由归一化恒落位（消费者按 `.length` 读分类面），
 *  在这里补一个兜底就是把「缺键」与「没有分类」折叠，还会把归一化的漏落藏起来。
 */

/** 发现面的**按源**清单（派生，不碰网络）：参与判据是 `exploreParticipates` 一处，本函数不复制它。
 *  标题**按该源声明的原样顺序**给出、同源内去重——源作者写的顺序就是他的意图顺序，
 *  而旧版那个「按收录源数降序」在单源下没有读数可排。跨源合并同名词表也不做：
 *  「玄幻」与「玄幻奇幻」是站点的真实分歧，替用户合并就是发明数据。
 *  去重留在这里而不是留到取数那一步：客户端提交的是**分类名**，一个源把同一个名字声明两条不同地址时
 *  这份契约答不出要哪一条——被丢掉的那条入口因此不可达（代价如实记在这里）。`pickEntry` 取的也是
 *  第一条同名，两边同序，界面上摆出来的名字与点下去的地址因此始终是同一条。 */
export function deriveExploreSources(sources: NovelSource[]): ExploreSources['sources'] {
  const out: ExploreSources['sources'] = []
  for (const s of sources) {
    if (!exploreParticipates(s)) continue
    const titles: string[] = []
    for (const k of s.rules.ruleExploreKinds) if (!titles.includes(k.title)) titles.push(k.title)
    out.push({ id: s.id, name: s.name, groups: s.groups, status: s.status, kinds: titles })
  }
  return out
}

/** 单源一页：查进程内快照 → 命中即零请求 → 未命中才抓 → 只有成功才写回缓存 → 出一个组。
 *  旧版这里是一层 `parallel` 批循环 + 一个 `skip` 集合（跨源编排）；浏览轴收成单源后，
 *  「哪些源该打」在提交时就点完名了，批循环与 skip 一并失去对象。
 *  缓存键含 `page`：第 2 页与第 1 页是两份不同的快照。代际由**调用方**算好传进来且**必填**
 *  （`exploreEpoch` 的消费者在服务层，这一层不认识规则形状）：给它一个缺省就是给未来的调用方
 *  一个永不变代的槽位——作者改了发现规则而快照键不动，陈旧书目会一直撑到 TTL 结束，
 *  而那正是这份代际存在的理由。必填让「没接代际」在编译期就没有第二种写法。
 *  **本函数从不抛错**：抓取失败与规则缺失都以带 `error` 的组交回——`ExploreSnapshot` 的
 *  「这一页没问到」全靠这条 error 落到 `error` 泳道上，别改成抛。 */
export async function fetchExploreGroup(
  source: NovelSource, kindUrl: string, fetcher: Fetcher,
  cfg: { timeoutMs: number; jsTimeoutMs?: number; page?: number; cache?: KindCache; epoch: string | number; now?: () => number },
): Promise<SearchGroup> {
  const now = cfg.now ?? Date.now
  const base = {
    sourceId: source.id, sourceName: source.name, status: source.status,
    statusDetail: source.statusDetail, hits: [] as SearchHit[],
  }
  const page = cfg.page ?? 1
  const key = { sourceId: source.id, kind: kindUrl, epoch: cfg.epoch, page }
  const cached = cfg.cache?.get(key, now())
  if (cached !== undefined && cached !== null) return cached
  try {
    const fetched = await fetchKindPage(source, kindUrl, fetcher, cfg.timeoutMs, cfg.jsTimeoutMs, page)
    if (!fetched.ok) return { ...base, error: { code: fetched.code, message: fetched.message } }
    const group = { ...base, hits: fetched.hits }
    // 只写成功结果：把失败也缓存住，等于把一次偶发故障钉死到 TTL 结束
    cfg.cache?.put(key, group, now())
    return group
  } catch (e) {
    return { ...base, error: { code: searchErrorCodeOf(e), message: e instanceof Error ? e.message : String(e) } }
  }
}
