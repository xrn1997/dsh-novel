import { describe, expect, it } from 'vitest'
import { encodeQuery, LOCAL_SOURCE_ID, PARAMS, paramRoutes, pickShelfMeta, planarNavigation, queries, ROUTES, SHELF_META, shelfBody } from '../../src/shared/wire.js'
import { LOCAL_SOURCE_ID as NODE_LOCAL_SOURCE_ID } from '../../src/services/localbooks.js'

describe('LOCAL_SOURCE_ID（跨半契约常量的唯一主人）', () => {
  it('持久化值钉死：改它会让既有 sources.json/shelf.json 里的本地书静默失联', () => {
    expect(LOCAL_SOURCE_ID).toBe('__local__')
  })
  it('服务半 re-export 与 wire 同源（不得再出第二份声明）', () => {
    expect(NODE_LOCAL_SOURCE_ID).toBe(LOCAL_SOURCE_ID)
  })
})

describe('路由表计数钉死（「17 条路由」注释曾腐烂且无测试）', () => {
  it('静态路由 25 条、参数路由 5 条', () => {
    expect(Object.keys(ROUTES)).toHaveLength(25)
    expect(Object.keys(paramRoutes)).toHaveLength(5)
  })
  it('书架批量删除：path 与 segs 同源（复用 batch-delete 段，与书源批删同段名）', () => {
    expect(ROUTES.shelfBatchDelete).toEqual({ path: 'shelf/batch-delete', segs: ['shelf', 'batch-delete'] })
  })
  it('搜索任务两面：path 与 segs 同源（服务端段匹配读 segs）', () => {
    expect(ROUTES.searchJob).toEqual({ path: 'search/job', segs: ['search', 'job'] })
    expect(ROUTES.searchJobStatus).toEqual({ path: 'search/job-status', segs: ['search', 'job-status'] })
    expect(ROUTES.searchJobStream).toEqual({ path: 'search/job-stream', segs: ['search', 'job-stream'] })
    expect(ROUTES.searchJobCancel).toEqual({ path: 'search/job-cancel', segs: ['search', 'job-cancel'] })
  })
  it('导航与本地三读口：path 与 segs 同源（本地读口不用路径段——bookKey 里的 / 不必编码成段）', () => {
    expect(ROUTES.navigation).toEqual({ path: 'navigation', segs: ['navigation'] })
    expect(ROUTES.localDocument).toEqual({ path: 'local/document', segs: ['local', 'document'] })
    expect(ROUTES.localResource).toEqual({ path: 'local/resource', segs: ['local', 'resource'] })
    expect(ROUTES.localWarnings).toEqual({ path: 'local/warnings', segs: ['local', 'warnings'] })
  })
})

/**
 * wire 契约的构造器面：参数名与字段取舍只准活在 shared/wire.ts。
 * 这些用例同时是 dispatch 读取语义的镜像——builder 产出的参数名与 dispatch 的 PARAMS.* 读取同源。
 */
describe('encodeQuery', () => {
  it('编码 + 去 undefined/null（null = 键缺席，与 wire 可空口径一致）', () => {
    expect(encodeQuery({ a: '书', b: 2, c: true, d: undefined, e: null })).toBe('a=%E4%B9%A6&b=2&c=true')
  })
})

describe('queries（路径 + query 构造）', () => {
  it('search：sourceIds 逗号拼接', () => {
    expect(queries.search({ keyword: '斗罗', sourceIds: ['a', 'b'] })).toBe('search?keyword=%E6%96%97%E7%BD%97&sourceIds=a%2Cb')
  })
  it('searchJobStatus：缺省 = 全量快照（无 query），带 since = 增量游标', () => {
    expect(queries.searchJobStatus()).toBe('search/job-status')
    expect(queries.searchJobStatus(0)).toBe('search/job-status?since=0')
    expect(queries.searchJobStatus(37)).toBe('search/job-status?since=37')
  })
  it('searchJobStream：与快照查询同一游标口径（推送与查询共用一条游标，读数才不会分叉）', () => {
    expect(queries.searchJobStream()).toBe('search/job-stream')
    expect(queries.searchJobStream(0)).toBe('search/job-stream?since=0')
    expect(queries.searchJobStream(37)).toBe('search/job-stream?since=37')
  })
  it('search：不限源时 sourceIds 缺席', () => {
    expect(queries.search({ keyword: 'x' })).toBe('search?keyword=x')
  })
  it('toc/chapter：refresh 仅 true 时出现且为 1（dispatch === "1" 判定）', () => {
    expect(queries.toc({ sourceId: 's', url: 'https://a/1' })).toBe('toc?sourceId=s&url=https%3A%2F%2Fa%2F1')
    expect(queries.toc({ sourceId: 's', url: 'u', refresh: true })).toContain('refresh=1')
    expect(queries.chapter({ sourceId: 's', url: 'u', index: 3 })).toBe('chapter?sourceId=s&url=u&index=3')
    expect(queries.chapter({ sourceId: 's', url: 'u', index: 3, refresh: false })).not.toContain('refresh')
  })
  it('exportBook：from/to 只在传入时出现（缺省 = 全本，向后兼容零参数旧链接）', () => {
    expect(queries.exportBook({ sourceId: 's', url: 'u', title: 't' })).toBe('export?sourceId=s&url=u&title=t')
    expect(queries.exportBook({ sourceId: 's', url: 'u', title: 't', from: 5, to: 80 })).toBe('export?sourceId=s&url=u&title=t&from=5&to=80')
  })
  it('localImport / localDelete：参数名归 PARAMS', () => {
    expect(queries.localImport({ name: '我的书.txt' })).toBe(`local/import?${PARAMS.name}=${encodeURIComponent('我的书.txt')}`)
    expect(queries.localDelete({ id: 'x1' })).toBe('local?id=x1')
  })
  it('navigation / 本地三读口：参数名归 PARAMS，本地读口的 id 一律是 bookKey', () => {
    expect(queries.navigation({ sourceId: 's', url: 'https://a/1' })).toBe('navigation?sourceId=s&url=https%3A%2F%2Fa%2F1')
    expect(queries.localDocument({ id: 'local:x', documentId: 'd2' })).toBe('local/document?id=local%3Ax&documentId=d2')
    expect(queries.localResource({ id: 'local:x', resourceId: 'r0' })).toBe('local/resource?id=local%3Ax&resourceId=r0')
    expect(queries.localWarnings({ id: 'local:x' })).toBe('local/warnings?id=local%3Ax')
  })
})

describe('planarNavigation（线性目录 → 平面树，唯一实现）', () => {
  it('逐章一个叶、无分组层级；id 稳定、target 指整章（无锚点）', () => {
    expect(planarNavigation([{ name: '一', url: 'u#0' }, { name: '二', url: 'u#1' }])).toEqual([
      { id: 't0', label: '一', target: { kind: 'chapter', index: 0, anchorId: null }, children: [] },
      { id: 't1', label: '二', target: { kind: 'chapter', index: 1, anchorId: null }, children: [] },
    ])
    expect(planarNavigation([])).toEqual([])
  })
})

describe('SHELF_META 字段集（书目元数据的唯一主人）', () => {
  it('字段集与 wire 形状同源：表里每个键都是 ShelfBook 元数据键（bookKey/进度/时间戳除外）', () => {
    // 表 = 元数据写口可写的键全集；bookKey 是身份、progress/addedAt 是系统字段，不属于元数据写口
    expect(Object.keys(SHELF_META).sort()).toEqual(
      ['author', 'coverUrl', 'intro', 'kind', 'lastChapterName', 'sourceId', 'title', 'totalChapters', 'wordCount'],
    )
  })
})

describe('pickShelfMeta（任意 JSON body → 合法元数据字段，判别/归一化单点）', () => {
  it('类型判别：string 字段非 string 缺席、number 字段非 number 缺席、未知键缺席', () => {
    expect(pickShelfMeta({ author: 42, totalChapters: '300', hacker: true })).toEqual({})
  })
  it('null/undefined 键缺席（保值语义的缺席形态）', () => {
    expect(pickShelfMeta({ author: null, coverUrl: undefined, intro: 'x' })).toEqual({ intro: 'x' })
  })
  it('totalChapters 归一化：floor + 负数钳 0；非有限数缺席', () => {
    expect(pickShelfMeta({ totalChapters: 12.9 })).toEqual({ totalChapters: 12 })
    expect(pickShelfMeta({ totalChapters: -3 })).toEqual({ totalChapters: 0 })
    expect(pickShelfMeta({ totalChapters: Number.NaN })).toEqual({})
    expect(pickShelfMeta({ totalChapters: Infinity })).toEqual({})
  })
  it('空串保留——title 非空判别归调用方（shelfPut 的 add/patch 分叉语义）', () => {
    expect(pickShelfMeta({ title: '' })).toEqual({ title: '' })
  })
})

describe('shelfBody（PUT shelf/:key 的 body 形状纪律）', () => {
  it('addBook：null/undefined 字段一律缺键（{...existing,...input} 下 :undefined 会抹掉已有元数据）', () => {
    const body = shelfBody.addBook({
      sourceId: 's', title: '斗罗', author: '唐家', coverUrl: null, intro: undefined,
      lastChapterName: null, totalChapters: 300,
    })
    expect(body).toEqual({ sourceId: 's', title: '斗罗', author: '唐家', totalChapters: 300 })
    expect('coverUrl' in body).toBe(false)
    expect('intro' in body).toBe(false)
    expect('lastChapterName' in body).toBe(false)
  })
  it('addBook：走 pickShelfMeta 同一口径——totalChapters 客户端即归一化', () => {
    expect(shelfBody.addBook({ sourceId: 's', title: 'T', totalChapters: 12.9 }))
      .toEqual({ sourceId: 's', title: 'T', totalChapters: 12 })
  })
  it('progress：只带 progress 两字段（dispatch shelfPut 的 progress 分支口径）', () => {
    expect(shelfBody.progress(3, 0.42)).toEqual({ progress: { chapterIndex: 3, offsetRatio: 0.42 } })
  })
  it('patch：缺省/null 字段不出现在 body（与 Shelf.update 保值语义双保险；ReaderView 回写单字段形态）', () => {
    expect(shelfBody.patch({ totalChapters: 300 })).toEqual({ patch: { totalChapters: 300 } })
    expect(shelfBody.patch({ author: null, coverUrl: undefined, title: 'T' })).toEqual({ patch: { title: 'T' } })
  })
})

describe('漂移守卫', () => {
  it('命中行加书架的路径必须走 paramRoutes.shelfKey——手拼 shelf/… 曾是活漂移', () => {
    const bookKey = 'https://a.com/book/1/?x=1&y=2'
    expect(paramRoutes.shelfKey(bookKey)).toBe(`shelf/${encodeURIComponent(bookKey)}`)
    // 统一断言：任何 client 装配点产出的 shelf 路径都要能被这个构造器生成
    expect(paramRoutes.shelfKey('local:00000000-0000-0000-0000-000000000000')).toBe(`shelf/${encodeURIComponent('local:00000000-0000-0000-0000-000000000000')}`)
  })
})
