import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { normalizeSource } from '../../src/services/normalize.js'
import { kindsOf, sourcesOfKind } from '../../src/services/explore.js'
import { fetchKindPage } from '../../src/services/explore-face.js'
import { mergeBooks } from '../../src/services/merge.js'
import { createFetcher } from '../../src/services/fetcher.js'
import type { NovelSource } from '../../src/services/types.js'

/**
 * 发现面的**离线全链路钉子**：一份原生方言书源 JSON 从盘上进来，归并后的书单出去——
 * 中间不碰站点，也不碰宿主。
 *
 * 为什么值得一份端到端：这条链的四段（原生方言 → 归一化落位 → 分类词表 → 单源抓取 → 归并）
 * 各有自己的单测，但**接缝**——词表派生的 slug 有没有真的走到请求里、抓到的条目能不能被归并成
 * 多条带入口的书——只有串起来才看得见。样例同时是原生方言的形状见证：它被改坏，这条链的
 * 前两段就得跟着改口径。
 */
const raw: unknown = JSON.parse(readFileSync(new URL('../fixtures/native-bqquge.json', import.meta.url), 'utf8'))

/** 钉子页按样例源**回落**的那套通用搜索规则来造（`ruleFind` 没带自己的 `ruleSearch`）——
 *  这正是本仓「整套切换、不逐字段回落」里回落那一侧的取条目路径。 */
const LIST_HTML = `
<div class="item"><h3><a href="/book/1">剑起长安</a></h3><p><a href="/zuozhe/a">青衫客</a><span>玄幻</span></p></div>
<div class="item"><h3><a href="/book/2">万古天河</a></h3><p><a href="/zuozhe/b">孤舟</a><span>玄幻</span></p></div>`

describe('书城发现面：离线全链路', () => {
  it('原生源 → 词表 → 分类抓取 → 归并', async () => {
    const n = normalizeSource(raw)
    if (!n.ok || n.source === undefined) throw new Error(`样本应能规范化：${JSON.stringify(n.missing)}`)
    const source = { id: 's1', status: 'verified', importedAt: 0, ...n.source } as NovelSource

    const kinds = kindsOf([source])
    expect(kinds.map((k) => k.title)).toContain('玄幻')

    const targets = sourcesOfKind([source], '玄幻')
    expect(targets).toHaveLength(1)

    const seen: string[] = []
    const fetcher = createFetcher({
      fetchImpl: async (input) => {
        seen.push(String(input))
        return new Response(LIST_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } })
      },
    })
    const page = await fetchKindPage(source, targets[0].kindUrl, fetcher)
    if (!page.ok) throw new Error('应能取到条目')
    // 这条地址才是「词表派生的 slug 真进了请求」的唯一读数：
    // 钉子页的相对书地址对任何分类路径都解析成同一个绝对地址，光看返回的书目分不出请求打到哪去了。
    expect(seen[0]).toBe('https://www.bqquge.com/xuanhuan')

    const books = mergeBooks([{
      sourceId: 's1', sourceName: source.name, status: 'verified', hits: page.hits,
    }])
    expect(books.map((b) => b.name)).toEqual(['剑起长安', '万古天河'])
    expect(books[0].origins[0].bookUrl).toBe('https://www.bqquge.com/book/1')
  })
})
