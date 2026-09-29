import { describe, expect, it } from 'vitest'
import { ReadingService } from '../../src/services/reading.js'
import { makeTempDir, trackService } from '../temp-dir.js'
import { createFetcher } from '../../src/services/fetcher.js'
import { PageCache } from '../../src/services/cache.js'
import { Shelf } from '../../src/services/shelf.js'
import { SourceRegistry } from '../../src/services/sources.js'

/**
 * AllInOne 目录的 `$n` 字段映射（库内实证源 若夏）：目录规则是整页正则形态，
 * `chapterName = $2$3`（行组引用）。此前引擎只有 group 1..n 的行、没有 `$n` 绑定——`$2$3` 被当
 * JSONPath 求值当场抛「意外字符 "2"」，整条目录不可用（宁炸不猜如实炸，不静默）。
 *
 * fixture 与原文的一处差异：站点响应体是异步接口返回的 HTML 片段，这里用等价形状的静态页代替
 * （正则拿的是 `数字" class="…name…>文本<` 这段形状，与来源无关）。
 */

const SOURCE_URL = 'https://a.heiyan.com'
const BOOK_URL = 'https://a.heiyan.com/book/30394'
const TOC_URL = 'https://a.heiyan.com/book/30394/chapter'
const ALLINONE = ':(?s)(\\d+)" class="(isvip)?[^"]*name[^>]*>([^<]*)'

const RAW = {
  bookSourceName: '若夏型源',
  bookSourceUrl: SOURCE_URL,
  searchUrl: 'http://search.ruoxia.com/web/search?queryString={{key}}&page={{page}}',
  ruleSearch: { bookList: '$[*]', name: '$.name', bookUrl: '$.id@js:result' },
  ruleBookInfo: { name: 'tag.h1@text', tocUrl: TOC_URL },
  ruleToc: {
    chapterList: ALLINONE,
    chapterName: '$2$3',
    chapterUrl: 'https://a.heiyan.com/ajax/chapter/content/$1',
  },
  ruleContent: 'class.text@text',
}

// 第二行带 isvip——`$2$3` 按行原样拼接，故第二行书名前面会带上组 2 的字面值
const TOC_HTML = '<div>30394" class=" book name="ch">第一章 初入江湖<</div>\n'
  + '<div>30395" class="isvip book name="ch">第二章 风云再起<</div>'

async function makeSvc(): Promise<{ svc: ReadingService; registry: SourceRegistry }> {
  const dir = await makeTempDir('novel-toc-allinone-')
  const registry = trackService(await SourceRegistry.load(dir))
  const shelf = trackService(await Shelf.load(dir))
  const svc = trackService(await ReadingService.from({
    registry,
    shelf,
    cache: new PageCache(dir),
    fetcher: createFetcher({
      fetchImpl: (async (input: RequestInfo | URL) => {
        const u = String(input)
        if (u === TOC_URL) return new Response(TOC_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } })
        return new Response('', { status: 404 })
      }) as never,
    }),
  }))
  await svc.importOne(RAW)
  return { svc, registry }
}

describe('AllInOne 目录的 $n 字段映射', () => {
  it('$1/$2$3 按行组取值：目录书名与章节地址都取到真值', async () => {
    const { svc, registry } = await makeSvc()
    const src = registry.list().find((s) => s.name === '若夏型源')!
    const toc = await svc.getToc(src.id, BOOK_URL)
    expect(toc).toEqual([
      { name: '第一章 初入江湖', url: 'https://a.heiyan.com/ajax/chapter/content/30394' },
      // 组 2（isvip）参与时原样拼进书名——源自己的规则如此，本仓按行组引用原样拼接，不加判断
      { name: 'isvip第二章 风云再起', url: 'https://a.heiyan.com/ajax/chapter/content/30395' },
    ])
  })
})
