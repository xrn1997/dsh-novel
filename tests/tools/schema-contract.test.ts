import { describe, expect, it } from 'vitest'
import { assertSupportedJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import type { JsonSchemaNode } from '@deepseek-ai/dsh-tools'
import { ReadingService } from '../../src/services/reading.js'
import { buildTools } from '../../src/tools/tools.js'
import { SHELF_META } from '../../src/shared/wire.js'
import type { ChapterEntry, SearchGroup, SearchHit, ShelfBook } from '../../src/shared/wire.js'
import { makeTempDir, trackService } from '../temp-dir.js'

/**
 * 工具 schema 契约测试：
 * 六份手写 schema 是工具对 harness 的 interface（additionalProperties:false——execute 多吐一个键、
 * wire 类型加一个字段，整个工具调用被 lossless-JSON 校验拒收）。此前 project.ts 声称
 * 「schema 侧的一致性由 tools 的用例钉住」但并不存在——本文件把声明证成：
 * ① 每工具 execute 输出过 harness 同款校验（validateJsonSchemaValue）；
 * ② **从 wire 派生的字段清单是三面钉死**（2026-09-28 收紧）：`SearchGroup`/`SearchHit`、`ChapterEntry`、
 *    `ShelfBook` 的字段清单住在 `*_FIELDS` 常量里——**运行时**拿它与 schema 的属性集比、
 *    **编译期**再用 `Assert<Eq<keyof Wire, …>>` 把同一份清单绑回 wire 类型；于是 wire 加/改字段会让
 *    `pnpm typecheck` 红（此前只有字面快照，wire 改名要人工记得同步——`services.md` #7 那条缺口）。
 *    另三份（`dshnovel_read`/`dshnovel_import_source`/`dshnovel_source`）是**工具自己的**投影形状，
 *    没有对应 wire 类型可绑，仍是字面清单（照旧由 ① 的校验兜底）；
 * ③ schema 本体在 harness 的强制子集内（assertSupportedJsonSchema）。
 */

/** 编译期等值断言（与 `tests/engine/js-protocol.test.ts` 的 `_Ajax`/`_Get` 同一手法） */
type Eq<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
type Assert<T extends true> = T

/** 下面这份清单是**唯一**一份：运行时比 schema，编译期比 wire 类型 */
const GROUP_FIELDS = ['sourceId', 'sourceName', 'status', 'statusDetail', 'hits', 'error'] as const
const HIT_FIELDS = ['title', 'author', 'url', 'coverUrl', 'intro', 'lastChapterName', 'kind', 'wordCount'] as const
const CHAPTER_FIELDS = ['chapterIndex', 'name', 'url'] as const
/** 工具刻意**不投影**的书目元数据（超集会被 harness 拒） */
const SHELF_EXCLUDED = ['coverUrl', 'intro', 'totalChapters'] as const
const SHELF_FIELDS = ['sourceId', 'bookKey', 'title', 'author', 'lastChapterName', 'kind', 'wordCount', 'progress', 'addedAt'] as const

type _GroupWire = Assert<Eq<keyof SearchGroup, typeof GROUP_FIELDS[number]>>
type _HitWire = Assert<Eq<keyof SearchHit, typeof HIT_FIELDS[number]>>
type _ChapterWire = Assert<Eq<keyof ChapterEntry, Extract<typeof CHAPTER_FIELDS[number], 'name' | 'url'>>>
type _ShelfWire = Assert<Eq<keyof ShelfBook, typeof SHELF_FIELDS[number] | typeof SHELF_EXCLUDED[number]>>

const SEARCH_HTML = '<html><body><div class="b"><a href="/book/1/" title="120万字">斗罗</a><span class="z">唐家</span></div><div class="b"><a href="/book/2/">无名书</a></div></body></html>'
const TOC_HTML = '<html><body><div class="b ch"><a href="/c/1.html">第一章</a></div></body></html>'
const CONTENT_HTML = '<html><body><div id="content">正文内容</div></body></html>'
const rawSource = {
  bookSourceName: 'S', bookSourceUrl: 'https://s.com', searchUrl: 'https://s.com/search?q={{key}}',
  ruleBookList: '@css:.b', ruleBookName: 'tag.a@text', ruleAuthor: 'tag.span@text', ruleBookUrl: 'tag.a@href',
  ruleKind: 'tag.span@class', ruleWordCount: 'tag.a@title',
  ruleChapterName: 'tag.a@text', ruleChapterUrl: 'tag.a@href', ruleContent: '@css:#content@textNodes',
}
const exec = { signal: new AbortController().signal } as never

let sourceId = ''   // 门面已无清单读口（凭据红线）——id 由 importOne 返回值接住
async function svc(): Promise<ReadingService> {
  const dir = await makeTempDir('novel-schema-')
  const s = trackService(await ReadingService.create({
    dir,
    fetchImpl: (async (input: RequestInfo | URL) => {
      const u = String(input)
      const body = u.includes('/search') ? SEARCH_HTML
        : u.includes('/c/1.html') ? CONTENT_HTML
          : u.includes('/book/1') ? TOC_HTML : null
      return body === null
        ? new Response('', { status: 404 })
        : new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } })
    }) as never,
  }))
  sourceId = (await s.importOne(rawSource)).sourceId!
  await s.probe(sourceId)
  return s
}

const toolsOf = (s: ReadingService): ReturnType<typeof buildTools> => buildTools(s)
const schemaOf = (s: ReadingService, name: string): JsonSchemaNode =>
  toolsOf(s).find((t) => t.name === name)!.output.schema

/** 对象节点的属性名集（契约表断言用）：路径段=属性名，'[]'=穿数组 items（编译后 required 是兄弟数组） */
const propsOf = (node: JsonSchemaNode, ...path: string[]): Set<string> => {
  let cur: JsonSchemaNode = node
  for (const p of path) cur = p === '[]' ? cur.items! : cur.properties![p]
  return new Set(Object.keys(cur.properties ?? {}))
}
const requiredOf = (node: JsonSchemaNode, ...path: string[]): string[] => {
  let cur: JsonSchemaNode = node
  for (const p of path) cur = p === '[]' ? cur.items! : cur.properties![p]
  return [...(cur.required ?? [])].sort()
}

describe('工具 schema 契约（execute 输出 ≡ 声明 schema；schema ≡ wire 字段）', () => {
  it('① 每个工具的 execute 输出都通过 harness 同款 schema 校验', async () => {
    const s = await svc()
    // 带 kind 入库：让 books/book 投影真的吐出该键（缺键投影会把 null 抹掉，声明了却没值 = 钉不住 schema）
    s.shelfAdd('https://s.com/book/1/', { sourceId, title: '斗罗', kind: '玄幻', wordCount: '120万字' })
    const calls: Array<[string, unknown]> = [
      ['dshnovel_search', { keyword: '斗罗' }],
      ['dshnovel_read', { sourceId, bookKey: 'https://s.com/book/1/', chapterIndex: 0 }],
      ['dshnovel_toc', { sourceId, bookKey: 'https://s.com/book/1/' }],
      ['dshnovel_import_source', { sourceJson: '[{"bookSourceName":"B","bookSourceUrl":"https://b","ruleContent":"x"}]' }],
      ['dshnovel_import_source', { sourceJson: JSON.stringify(rawSource) }],                 // 同址重复 → dupSkipped 分支也要过 schema
      ['dshnovel_import_source', { sourceJson: '{oops' }],                                  // 坏 JSON 分支也要过 schema
      ['dshnovel_source', { action: 'list' }],
      ['dshnovel_source', { action: 'probe', sourceId }],
      ['dshnovel_source', { action: 'disable', sourceId }],
      ['dshnovel_source', { action: 'enable', sourceId }],
      ['dshnovel_shelf', { action: 'list' }],
      ['dshnovel_shelf', { action: 'add', bookKey: 'https://s.com/book/9/', title: 'X', sourceId }],
      ['dshnovel_shelf', { action: 'save_progress', bookKey: 'https://s.com/book/9/', chapterIndex: 1, offsetRatio: 0.25 }],
      ['dshnovel_shelf', { action: 'remove', bookKey: 'https://s.com/book/9/' }],
    ]
    for (const [name, args] of calls) {
      const tool = toolsOf(s).find((t) => t.name === name)!
      const value = await tool.execute(args, exec)
      const violations = validateJsonSchemaValue(tool.output.schema, value, name)
      expect(violations, `${name} 输出违反自身声明 schema：${violations.join('；')}`).toEqual([])
    }
  })

  it('② schema 属性集 ≡ wire 类型字段集（表钉死；缺键投影差集=nullable→缺席）', async () => {
    const s = await svc()
    const search = schemaOf(s, 'dshnovel_search')
    // ── dshnovel_search ≡ SearchGroup/SearchHit（`shared/wire.ts` 的两个 interface）──
    // 清单住在 GROUP_FIELDS/HIT_FIELDS：运行时比 schema、编译期比 wire 类型（见文件头 ② ）
    expect(propsOf(search, 'groups', '[]'))
      .toEqual(new Set(GROUP_FIELDS))
    expect(propsOf(search, 'groups', '[]', 'hits', '[]'))
      .toEqual(new Set(HIT_FIELDS))
    // 必填差集：wire 上 nullable 的字段（author/url/coverUrl/intro/lastChapterName）经缺键投影后可缺席
    expect(requiredOf(search, 'groups', '[]')).toEqual(['hits', 'sourceId', 'sourceName', 'status'])
    expect(requiredOf(search, 'groups', '[]', 'hits', '[]')).toEqual(['title'])

    // ── dshnovel_read：随读工具自己的规范值（sourceId/bookKey/chapterIndex/chapterName/text）──
    expect(propsOf(schemaOf(s, 'dshnovel_read')))
      .toEqual(new Set(['sourceId', 'bookKey', 'chapterIndex', 'chapterName', 'text']))

    // ── dshnovel_toc：ChapterEntry 加 0 起下标（章名→index 的映射是本工具的存在理由）──
    expect(propsOf(schemaOf(s, 'dshnovel_toc')))
      .toEqual(new Set(['sourceId', 'bookKey', 'total', 'chapters']))
    expect(propsOf(schemaOf(s, 'dshnovel_toc'), 'chapters', '[]'))
      .toEqual(new Set(CHAPTER_FIELDS))
    expect(requiredOf(schemaOf(s, 'dshnovel_toc'), 'chapters', '[]')).toEqual(['chapterIndex', 'name', 'url'])

    // ── dshnovel_import_source ≡ ImportOutcome 投影（name/ok/sourceId/missing/warnings + 按址去重 dupSkipped）──
    expect(propsOf(schemaOf(s, 'dshnovel_import_source'), 'outcomes', '[]'))
      .toEqual(new Set(['sourceId', 'name', 'ok', 'dupSkipped', 'missing', 'warnings']))

    // ── dshnovel_source：action 分支共用一份出参 schema（action/回执字段 + probe 分支的 ProbeResult 投影）──
    expect(propsOf(schemaOf(s, 'dshnovel_source')))
      .toEqual(new Set(['action', 'sources', 'sourceId', 'enabled', 'removed', 'status', 'ok', 'itemCount', 'firstTitle', 'error', 'probedAt']))
    expect(propsOf(schemaOf(s, 'dshnovel_source'), 'sources', '[]'))
      .toEqual(new Set(['sourceId', 'name', 'baseUrl', 'enabled', 'type', 'status', 'statusDetail']))

    // ── dshnovel_shelf ≡ ShelfBook 投影（`shared/wire.ts` 的 ShelfBook；coverUrl/intro/totalChapters 刻意不投影——超集会被拒）──
    // 两层都钉住：`SHELF_FIELDS` ⊆ `SHELF_META`（写面孔径，表里改键名/加键这里跟着动）
    // ＋ `SHELF_FIELDS ∪ SHELF_EXCLUDED ≡ keyof ShelfBook`（编译期类型钉，见文件头 ②）
    const shelfMeta = new Set(Object.keys(SHELF_META))
    const shelfItem = new Set<string>(SHELF_FIELDS)
    expect(shelfItem, 'SHELF_FIELDS 必须与「SHELF_META 减去刻意不投影的三项」逐键相等')
      .toEqual(new Set([...[...shelfMeta].filter((k) => !(SHELF_EXCLUDED as readonly string[]).includes(k)), 'bookKey', 'progress', 'addedAt']))
    expect(propsOf(schemaOf(s, 'dshnovel_shelf'), 'books', '[]')).toEqual(shelfItem)
    // add/save_progress 的单本回执与 list 的条目同形（同一投影，不长第二份）
    expect(propsOf(schemaOf(s, 'dshnovel_shelf'), 'book')).toEqual(shelfItem)
    expect(propsOf(schemaOf(s, 'dshnovel_shelf'))).toEqual(new Set(['action', 'books', 'book', 'removed']))
  })

  it('③ 六份 schema 本体都在 harness 强制子集内（assertSupportedJsonSchema 不抛）', async () => {
    const s = await svc()
    for (const t of toolsOf(s)) expect(() => assertSupportedJsonSchema(t.output.schema), t.name).not.toThrow()
  })
})
