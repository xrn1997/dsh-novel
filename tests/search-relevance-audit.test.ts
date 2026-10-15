import { describe, expect, it } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { ReadingService } from '../src/services/reading.js'
import { readJson } from '../src/services/storage.js'
import { mergeBooks } from '../src/shared/merge-by-book.js'
import { normalizeRelevance, partitionByRelevance } from '../src/shared/relevance.js'
import { SEARCH_BOOKS_CAP, SEARCH_HITS_CAP_PER_SOURCE } from '../src/shared/wire.js'
import { makeTempDir, trackService } from './temp-dir.js'

// 相关性分档与按书归并的真机审计（DSH_SEARCH_FILTER_AUDIT=1 才跑——全量真打网络，几分钟量级；不进常规集）。
// **审计报告**、不设通过率断言：分母随用户增删源与站点脸色漂，钉一个百分比就是把报告写成假绿（同 DSH_CONTENT_AUDIT）。
// 唯一的断言是判据自洽（分档不丢条）——它与站点给什么无关，红了就说明这次改造本身错了。
// 读数只出 stdout，不落盘：新增一份跑门产物就是再造一个「入库随批漂」的旧坑。
// 标签的单位照 CONTEXT.md「作品视图（按书）」那条单位律落字（条／本／家三种身份不许互读）——这份报告同屏摆
// 行数与本数家数，混标一次，归并那侧的读数就没法用。
// 每节一行小标题、每一行都带 `[relevance-audit]` 前缀：尾部那些列表裸挂在上一节后面时，读者判不出哪行属于哪一轴。

const KEYWORD = process.env.DSH_SEARCH_AUDIT_KEYWORD ?? '冰魔女的契约'

/** 待判样例的展示上限。真机一轮能给出成百上千条，人判读不了整张表——所以标题行报**全量计数**、
 *  列表只摆前这么多条；只报列表长度就是把「筛出 300 条」读成「只有 15 条」。 */
const SAMPLE_LIMIT = 15

const section = (title: string): void => {
  console.log(`[relevance-audit] ── ${title} ──`)
}

describe.skipIf(process.env.DSH_SEARCH_FILTER_AUDIT !== '1')('搜索相关性分档 + 按书归并审计', () => {
  it(`全量源搜「${KEYWORD}」→ 逐源 hits/kept/suspect、归并本数与家数分布、三组待判样例`, { timeout: 1_800_000 }, async () => {
    const sj = path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'novel', 'sources.json')
    // 名册的读法不另立第二份：走注册表那个读口（storage 的 readJson）——首启没有 sources.json 是常态，
    // 该报「名册 0」而不是让整扇门 ENOENT 变红；文件损坏照旧响亮失败，不许伪装成空名册。
    const sources = await readJson<Array<{ raw: unknown }>>(sj, [])
    const dir = await makeTempDir('novel-relevance-')
    const svc = trackService(await ReadingService.create({ dir }))
    // 逐条入库不许让一条畸形 raw 带走整轮：单对象入口没有批量入口那道逐条防线（主人是 reading.ts 的
    // importSource），一次抛出会让这扇门在打出任何一行读数之前终止——整份报告消失比缺一个读数更坏
    // （reprobe 门留着「导入失败」那格是同一条理由）。被拒的条数要现形：名册 与 参搜 之间那道缝，
    // 闸拒与抛出的那些就是它贡献的那一半（它们根本没进注册表）。计数，不断言。
    let rejected = 0
    for (const item of sources) {
      try {
        if (!(await svc.importOne(item.raw)).ok) rejected++
      } catch { rejected++ }
    }

    const groups = await svc.search(KEYWORD)                       // 跑的是聚合搜索那唯一一条路
    const rows = groups.map((g) => ({ g, p: partitionByRelevance(KEYWORD, g.hits) }))
    for (const { g, p } of rows) {
      expect(p.kept.length + p.suspect.length).toBe(g.hits.length)  // 判据自洽：一条不丢
    }

    const k = normalizeRelevance(KEYWORD)
    // 待判样例①的**排序键**：只决定先看哪几条，不是判据——判据只有三档、没有阈值可拧（自造相似度是 `docs/adr/0032` 明确否决的那条）。
    const overlap = (s: string): number => {
      const t = normalizeRelevance(s)
      let shared = 0
      for (const ch of new Set(t)) if (k.includes(ch)) shared++
      return t.length === 0 ? 0 : shared / Math.max(k.length, t.length)
    }
    const round = mergeBooks(KEYWORD, groups)          // 归并唯一实现：键、档、序都在它那里，本文件只读交回的形状

    section('本轮账目')
    // 名册、入库拒、参搜、答话是四条不同的数：被闸拒或抛出的 raw 进不了注册表，形态或停用不参搜的源进不了
    // 后两列——只报「参搜 N」就会被读成「覆盖了整个名册」，只报缝隙不报那一半就把「名册 − 参搜」归错了因。
    // 摊开四条而不为此加断言：门是报告。
    console.log(`[relevance-audit] 关键词「${KEYWORD}」· 名册 ${sources.length} · 入库拒 ${rejected} 条 · 答话源 ${rows.filter((r) => r.g.error === undefined).length} / 参搜 ${groups.length}`)
    // 三个数同一条行、同一个单位（条＝一行）：漏掉后两格的单位就会被读成「kept 是个比例／是本数」。
    console.log(`[relevance-audit] 命中合计 ${rows.reduce((n, r) => n + r.g.hits.length, 0)} 条 · kept ${rows.reduce((n, r) => n + r.p.kept.length, 0)} 条 · suspect ${rows.reduce((n, r) => n + r.p.suspect.length, 0)} 条`)

    section('逐源分桶')
    // 逐源行是这份报告的主轴：合计会把「单家在灌垃圾」摊平成全局比例，人判要的是能点名那一家。
    // 报错的源打错误码而不打分桶数——诊断轴（谁哑火、为什么）与分桶轴同在这一列里，不必回表。
    for (const { g, p } of rows) {
      console.log(g.error === undefined
        ? `[relevance-audit] ${g.sourceName}: hits ${g.hits.length} · kept ${p.kept.length} · suspect ${p.suspect.length}`
        : `[relevance-audit] ${g.sourceName}: error ${g.error.code}`)
    }

    section('按书归并')
    // 只截视图不截账目：全量本数与视图本数各报一次，上限读 shared/wire.ts 那一位主人（抄成字面量就是给它第二个主人）。
    console.log(`[relevance-audit] 本轮 ${round.total} 本 · 视图 ${round.books.length} 本（上限 ${SEARCH_BOOKS_CAP}${round.total > round.books.length ? ` · 视图外还有 ${round.total - round.books.length} 本` : ''}）`)
    const homes = round.books.map((b) => b.sourceCount)
    const hist = [...new Set(homes)].sort((a, b) => a - b)
      .map((n) => `${n} 家=${homes.filter((x) => x === n).length} 本`).join(' · ')
    console.log(`[relevance-audit] 视图内家数分布：${hist === '' ? '（视图为空：本轮没有 kept）' : hist}`)
    const maxHomes = homes.reduce((n, x) => Math.max(n, x), 0)
    // 这一行是本节的标题读数，也是最容易被抄进矩阵当真机读数的一行——所以范围写死在标签里：家数只算视图内
    // （mergeBooks 只交回视图）。视图外那批是排序落末的那些本，而 mergeBooks 在同档里把家少的排后面，
    // 于是被挤出视图的偏是单家本——拿视图这份当整轮会把浓缩说高，两边不是同一张表，不许互读。
    // 视图为空时「最多 0 家」是 reduce 的种子不是读数（无家可数），与上一行同形报空态。
    console.log(`[relevance-audit] 视图内 ≥2 家的本 ${homes.filter((n) => n >= 2).length} · ${homes.length === 0 ? '家数无（视图为空：本轮没有 kept）' : `最多 ${maxHomes} 家（换轴买到的浓缩就看这一行：全是 1 家即什么都没并）`}`)
    // 视图的「多大」是两条读数：收成几本、在册几条行——两者不许互读（单位律同上）。
    const rowTotal = round.books.reduce((n, b) => n + b.sources.length, 0)
    console.log(`[relevance-audit] 视图内 ${rowTotal} 条逐源行收成 ${round.books.length} 本 · 行数多于家数的本 ${round.books.filter((b) => b.sources.length > b.sourceCount).length}`)

    section('待判样例（人判，不作断言）')
    // 待判样例①：被判 suspect 但字面最接近关键词的——这一类就是「暂不预设的去虚字放行」该不该补的证据
    // 排序键沿结构化的书名走，不 join 成串再回切：`｜` 在抓取内容与流通书源名里都真实出现，
    // 回切会把「源名带该字符」的条目按半截书名打分，而打印行看着仍完整——错的是读数本身，人判无从察觉。
    const suspects = rows.flatMap((r) => r.p.suspect.map((m) => ({ src: r.g.sourceName, title: m.hit.title })))
    const nearMiss = suspects.map((s) => ({ src: s.src, title: s.title, o: overlap(s.title) })).sort((a, b) => b.o - a.o).slice(0, SAMPLE_LIMIT)
    console.log(`[relevance-audit] ① suspect 共 ${suspects.length} 条，列重合度最高的 ${nearMiss.length} 条（人判：是不是被误判的真结果）`)
    for (const x of nearMiss) console.log(`[relevance-audit]   ${x.o.toFixed(2)} ${x.src}｜${x.title}`)

    // 待判样例②：站点给量到达每源上限的源——真结果可能被截在视野外。本门量的是 `svc.search()` 交回的命中，
    // 那道截断发生在后台任务路径（`services/search-job.ts` 的 `capHits`），所以这里读到的是**截断前**的站点给量。
    // 标签因此按「站点给量到达上限」说话而不是「撞满」：这一读本就在 `capHits` 之前，给得比上限多的站会被
    // 说成刚好到线；而只有结果页那条链路真会截——工具面与 HTTP 面拿到的是整批，那里没有「被截掉的那部分」。
    const capped = rows.filter(({ g }) => g.error === undefined && g.hits.length >= SEARCH_HITS_CAP_PER_SOURCE)
    console.log(`[relevance-audit] ② 站点给量 ≥ 每源上限 ${SEARCH_HITS_CAP_PER_SOURCE} 条的源 ${capped.length} 家（只有结果页那条链路会截掉；人判：截掉的那部分里有没有要的）`)
    for (const { g } of capped) console.log(`[relevance-audit]   ${g.sourceName}`)

    // 待判样例③：同一本里**原样**作者字段互不相同的——那把键最可能焊错的地方。
    // 为什么拿原样比而不是规范化后的作者：归并键算的就是规范化那对名字，同本内规范化后按构造恒等，
    // 拿它比分永远得「零分歧」，等于把这一格读成「这把键从没焊错过」。
    const diverging = round.books
      .map((b) => ({ title: b.title, authors: [...new Set(b.sources.map((s) => s.author ?? ''))] }))
      .filter((x) => x.authors.length > 1)
    console.log(`[relevance-audit] ③ 视图内同一本里作者写法互不相同的本 ${diverging.length}，列前 ${Math.min(diverging.length, SAMPLE_LIMIT)} 本（待判：该不该算同一本）`)
    for (const x of diverging.slice(0, SAMPLE_LIMIT)) {
      // 书名按原样打：书行那个名字就是首个到达源的原样，源自己带书名号时再套一层就是报告造出来的假字面
      // （与 ① 同形——那里也打裸标题）。
      console.log(`[relevance-audit]   ${x.title} → ${x.authors.map((a) => a === '' ? '（空作者）' : a).join(' / ')}`)
    }
    await svc.flush()
  })
})
