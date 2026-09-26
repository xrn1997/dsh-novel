import { describe, expect, it } from 'vitest'
import { ReadingService } from '../../src/services/reading.js'
import { makeTempDir, trackService } from '../temp-dir.js'
import { createFetcher } from '../../src/services/fetcher.js'
import { PageCache } from '../../src/services/cache.js'
import { Shelf } from '../../src/services/shelf.js'
import { SourceRegistry } from '../../src/services/sources.js'

/**
 * `ruleBookInfo.tocUrl` 带 `,{option}` 后缀时的组装口径（真机实证 2 源：悦读小说、新小书亭）。
 *
 * 悦读小说的原文规则：一个绝对 URL 端点 + 换行写的选项 JSON（method POST、body 里带
 * 从 baseUrl 正则取出的 bookId 插值段）。正文链路审计里它的形态是
 * `toc | FetchError | 请求失败 400`，实际打出去的地址形如
 * `…/getChapterList,%7B%22method%22:%20%22POST%22,…` —— 选项串整个并进了 URL。
 *
 * 根因不在选项解析，而在**绝对化早于切分**：`tocUrlOf` 求值后用 `absUrl`（即 `new URL()`），
 * 而 WHATWG 解析器吃掉换行、把花括号百分号编码，于是 `,{` 形状先被破坏，抓取层的
 * `URL_OPTION_SPLIT` 再也切不到。搜索结果里的 bookUrl 与章节 URL 早已按同一口径
 * 走 `absUrlKeepOption`（URL 部分绝对化、`,{option}` 原样接回），
 * tocUrl 这条出口漏了同一层处理。
 *
 * fixture 与原文的一处差异：正则用数字字符类而不是转义写法——写文件的工具层会吃掉反斜杠，
 * 转义写法在这里等于静默改了规则语义（实测会退化成匹配字母 d）。
 */

const SOURCE_URL = 'https://hareading.com'
const BOOK_URL = 'https://m.hareading.com/book/47915.html'
const TOC_ENDPOINT = 'https://hareading.com/books/getChapterList'
const TOC_RULE = [
  'https://hareading.com/books/getChapterList,',
  '{',
  '"method": "POST",',
  '"body": "bookId={{baseUrl.match(/[0-9]+/)[0]}}"',
  '}',
].join('\n')

const RAW = {
  bookSourceName: '悦读型源',
  bookSourceUrl: SOURCE_URL,
  searchUrl: 'https://hareading.com/s?k={{key}}',
  ruleBookList: '@css:.b',
  ruleBookName: 'tag.a@text',
  ruleBookUrl: 'tag.a@href',
  ruleBookInfo: { name: 'tag.h1@text', tocUrl: TOC_RULE },
  ruleToc: { chapterList: '$.rows[*]', chapterName: '$.name', chapterUrl: '$.u' },
  ruleContent: '$.text',
}

const SEARCH_HTML = '<html><body><div class="b"><a href="https://m.hareading.com/book/47915.html">书甲</a><span>作者甲</span></div></body></html>'
const DETAIL_HTML = '<html><body><h1>书甲</h1></body></html>'
const TOC_JSON = JSON.stringify({ rows: [{ name: '第1章 起', u: 'https://hareading.com/c/1.html' }] })

interface Call { url: string; method: string; body?: string }

async function makeSvc(): Promise<{ svc: ReadingService; registry: SourceRegistry; calls: Call[] }> {
  const calls: Call[] = []
  const dir = await makeTempDir('novel-tocopt-')
  const registry = trackService(await SourceRegistry.load(dir))
  const shelf = trackService(await Shelf.load(dir))
  const svc = trackService(await ReadingService.from({
    registry,
    shelf,
    cache: new PageCache(dir),
    fetcher: createFetcher({
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const u = String(input)
        const method = init?.method ?? 'GET'
        const body = typeof init?.body === 'string' ? init.body : undefined
        calls.push({ url: u, method, ...(body === undefined ? {} : { body }) })
        if (u.includes('/s?')) {
          return new Response(SEARCH_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } })
        }
        if (u === BOOK_URL) return new Response(DETAIL_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } })
        if (u.startsWith('https://hareading.com/books/') && method === 'POST') {
          return new Response(TOC_JSON, { headers: { 'content-type': 'application/json' } })
        }
        return new Response('', { status: 404 })
      }) as never,
    }),
  }))
  await svc.importOne(RAW)
  return { svc, registry, calls }
}

describe('tocUrl 带 ,{option} 后缀', () => {
  it('目录请求打到干净端点并带 POST 选项（bookId 由 baseUrl 插值）', async () => {
    const { svc, registry, calls } = await makeSvc()
    const src = registry.list().find((s) => s.name === '悦读型源')!
    const toc = await svc.getToc(src.id, BOOK_URL)
    const tocCall = calls.find((c) => c.url === TOC_ENDPOINT)
    expect(tocCall, `目录端点没被打到，实际调用: ${JSON.stringify(calls)}`).toBeDefined()
    expect(tocCall?.method).toBe('POST')
    expect(tocCall?.body).toBe('bookId=47915')
    // 没有任何一次请求把选项串并进 URL（百分号编码的花括号或字面 ,{ 都是同一形状）
    expect(calls.some((c) => c.url.includes('%7B') || c.url.includes(',{'))).toBe(false)
    expect(toc).toHaveLength(1)
    expect(toc[0]).toMatchObject({ name: '第1章 起' })
  })

  it('无插值段的静态 tocUrl 带选项时同样保留后缀（选项活到抓取层：POST + body 真发出）', async () => {
    const { svc, registry, calls } = await makeSvc()
    // 走 ruleTocUrl 顶层字段的静态形态：URL + 单引号选项 JSON，无任何插值段
    const raw2 = { ...RAW, bookSourceName: '静态目录源', ruleBookInfo: {}, ruleTocUrl: [
      'https://hareading.com/books/staticList,',
      String.fromCharCode(123) + "'method':'POST','body':'id=9'" + String.fromCharCode(125),
    ].join('') }
    await svc.importOne(raw2)
    const src = registry.list().find((s) => s.name === '静态目录源')!
    const toc = await svc.getToc(src.id, BOOK_URL)
    const hit = calls.find((c) => c.url === 'https://hareading.com/books/staticList')
    expect(hit, `静态目录端点没被打到，实际调用: ${JSON.stringify(calls)}`).toBeDefined()
    expect(hit?.method).toBe('POST')
    expect(hit?.body).toBe('id=9')
    expect(toc).toHaveLength(1)
  })
})
