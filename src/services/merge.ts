import type { ExploreBook, ExploreOrigin, SearchGroup, SearchHit } from '../shared/wire.js'

/** 归并键：书名 + 作者，各自 trim 后比较。**任一为空即返回 null（不归并）**——
 *  作者缺失时把两本不同的书焊成一本是本仓最高罪，宁可列表里多一条。
 *  分隔符用 NUL 而不是可见字符：`('a b','c')` 与 `('a','b c')` 必须是两个键，
 *  拿空格/换行拼键会让两本不同的书撞成一本。 */
function keyOf(hit: SearchHit): string | null {
  const name = hit.title.trim()
  const author = (hit.author ?? '').trim()
  if (name === '' || author === '') return null
  return `${name}\u0000${author}`
}

/** 命中 → 某源上的入口。可空字段缺席而不是写 null：wire 上 origin 的可选面表示
 *  「这个源没说」，与「说了个空串」不是一回事。 */
function originOf(hit: SearchHit, g: SearchGroup): ExploreOrigin {
  return {
    sourceId: g.sourceId, sourceName: g.sourceName, bookUrl: hit.url,
    ...(hit.lastChapterName === null ? {} : { lastChapter: hit.lastChapterName }),
  }
}

/** 书目取**首次出现那一份**，不做字段级择优、更不拼串：多源各说一句简介，
 *  按源排序拼起来是发明数据。可选字段同理缺席而非 null（源没给 ≠ 空串）。
 *  `bookUrl: null` 的命中照样成书——它是书目，只是暂时没有可读入口。 */
function bookOf(hit: SearchHit, origin: ExploreOrigin): ExploreBook {
  return {
    name: hit.title.trim(), author: hit.author,
    ...(hit.coverUrl === null ? {} : { coverUrl: hit.coverUrl }),
    ...(hit.kind === null ? {} : { kind: hit.kind }),
    ...(hit.lastChapterName === null ? {} : { lastChapter: hit.lastChapterName }),
    ...(hit.intro === null ? {} : { intro: hit.intro }),
    ...(hit.wordCount === null ? {} : { wordCount: hit.wordCount }),
    sourceCount: 1, origins: [origin],
  }
}

/** 把逐源结果归并成书单。纯函数：不碰网络、不看规则，输入输出都是 wire 形状。
 *  排序按来源数降序——N 个源都收录本身就是最诚实的热度代理，不发明评分；
 *  同数保持首次出现序（Array.prototype.sort 稳定，依赖它而不是另记序号）。 */
export function mergeBooks(groups: SearchGroup[]): ExploreBook[] {
  const byKey = new Map<string, ExploreBook>()
  const out: ExploreBook[] = []
  for (const g of groups) {
    for (const h of g.hits) {
      const origin = originOf(h, g)
      const key = keyOf(h)
      if (key === null) { out.push(bookOf(h, origin)); continue }
      const found = byKey.get(key)
      if (found === undefined) {
        const b = bookOf(h, origin)
        byKey.set(key, b)
        out.push(b)
      } else {
        found.origins.push(origin)
        found.sourceCount = found.origins.length
      }
    }
  }
  return [...out].sort((a, b) => b.sourceCount - a.sourceCount)
}
