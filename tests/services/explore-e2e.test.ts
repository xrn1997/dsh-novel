import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { normalizeSource } from '../../src/services/normalize.js'
import { ReadingService } from '../../src/services/reading.js'
import { makeTempDir, trackService } from '../temp-dir.js'
import { settleExploreRound } from '../explore-settle.js'

/**
 * 发现面的**离线全链路钉子**：一份原生方言书源 JSON 从盘上进来，书城轮次快照里的书单出去——
 * 中间不碰站点，也不碰宿主。
 *
 * 为什么值得一份端到端：这条链的五段（原生方言 → 归一化落位 → 按源派生分类标题 → 单源抓取 →
 * 整轮累积成快照）各有自己的单测，但**接缝**——源自己声明的分类入口有没有真的走到请求里、抓到的
 * 条目能不能落成快照里带书地址的书目——只有串起来才看得见。样例同时是原生方言的形状见证：
 * 它被改坏，这条链的前两段就得跟着改口径。
 */
const raw: unknown = JSON.parse(readFileSync(new URL('../fixtures/native-bqquge.json', import.meta.url), 'utf8'))

/** 钉子页按样例源**回落**的那套通用搜索规则来造（`ruleFind` 没带自己的 `ruleSearch`）——
 *  这正是本仓「整套切换、不逐字段回落」里回落那一侧的取条目路径。 */
const LIST_HTML = `
<div class="item"><h3><a href="/book/1">剑起长安</a></h3><p><a href="/zuozhe/a">青衫客</a><span>玄幻</span></p></div>
<div class="item"><h3><a href="/book/2">万古天河</a></h3><p><a href="/zuozhe/b">孤舟</a><span>玄幻</span></p></div>`
const HTML = { headers: { 'content-type': 'text/html; charset=utf-8' } }

describe('书城发现面：离线全链路', () => {
  it('原生源 → 按源分类清单 → 一轮单源浏览 → 快照书单', async () => {
    const n = normalizeSource(raw)
    if (!n.ok || n.source === undefined) throw new Error(`样本应能规范化：${JSON.stringify(n.missing)}`)

    const seen: string[] = []
    const dir = await makeTempDir('novel-explore-e2e-')
    const svc = trackService(await ReadingService.create({
      dir,
      fetchImpl: (async (input: RequestInfo | URL) => {
        seen.push(String(input))
        return new Response(LIST_HTML, HTML)
      }) as never,
    }))
    await svc.importOne(raw)

    const listed = svc.exploreSources().sources[0]
    const id = svc.listPublicSources()[0].id
    expect(listed.id).toBe(id)
    // 分类标题从派生面自取（夹具自己声明的第一类）：硬编标题的话，夹具一改这条就假红
    const kind = listed.kinds[0]

    svc.startExploreJob(id, kind)
    await settleExploreRound(svc)
    const snap = svc.exploreJobSnapshot()
    expect(snap?.phase).toBe('done')
    expect(snap?.sourceId).toBe(id)
    expect(snap?.kind).toBe(kind)
    expect(snap?.books.map((b) => b.name)).toEqual(['剑起长安', '万古天河'])
    // 书地址落在书目这条本身上：浏览轴是单源，一条命中就是一本书，不再有「来源入口」那一层
    expect(snap?.books[0].bookUrl).toBe('https://www.bqquge.com/book/1')

    // 这条请求地址才是「派生用的分类入口真进了请求」的唯一读数：
    // 钉子页的相对书地址对任何分类路径都解析成同一个绝对地址，光看快照里的书目分不出请求打到哪去了。
    // 入口地址不跨半、也不从派生面出，故从夹具的归一化结果里按标题找回，不硬编 slug。
    const entry = n.source.rules.ruleExploreKinds.find((k) => k.title === kind)
    expect(seen).toContain(`https://www.bqquge.com/${entry?.url}`)
  })
})
