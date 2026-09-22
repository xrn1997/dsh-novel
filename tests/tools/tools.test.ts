import { describe, expect, it } from 'vitest'
import { ReadingService } from '../../src/services/reading.js'
import { buildTools, registerTools } from '../../src/tools/tools.js'
import { makeTempDir, trackService } from '../temp-dir.js'

const SEARCH_HTML = '<html><body><div class="b"><a href="/book/1/">斗罗</a><span>唐家</span></div><div class="b"><a href="/book/2/">无名书</a></div></body></html>'
const TOC_HTML = '<html><body><div class="b ch"><a href="/c/1.html">第一章</a></div></body></html>'
const CONTENT_HTML = '<html><body><div id="content">正文内容</div></body></html>'
const rawSource = {
  bookSourceName: 'S', bookSourceUrl: 'https://s.com', searchUrl: 'https://s.com/search?q={{key}}',
  ruleBookList: '@css:.b', ruleBookName: 'tag.a@text', ruleAuthor: 'tag.span@text', ruleBookUrl: 'tag.a@href',
  ruleChapterName: 'tag.a@text', ruleChapterUrl: 'tag.a@href', ruleContent: '@css:#content@textNodes',
}
const exec = { signal: new AbortController().signal } as any

/** lossless JSON 兜底：值为 undefined 的属性键会让 harness 拒收整个工具输出
 *（"value is not lossless JSON"——真实结果被吞）。递归断言输出里没有任何 undefined。 */
const hasUndefined = (x: unknown): boolean => typeof x === 'undefined'
  || (Array.isArray(x) ? x.some(hasUndefined)
    : typeof x === 'object' && x !== null && Object.values(x).some(hasUndefined))

let sourceId = ''   // 门面已无清单读口（凭据红线）——id 由 importOne 返回值接住
async function svc(): Promise<ReadingService> {
  const dir = await makeTempDir('novel-tools-')
  const s = trackService(await ReadingService.create({
    dir,
    fetchImpl: (async (input: any) => {
      const u = String(input)
      const body = u.includes('/search') ? SEARCH_HTML
        : u.includes('/c/1.html') ? CONTENT_HTML
          : u.includes('/book/1') ? TOC_HTML : null
      return body === null
        ? new Response('', { status: 404 })
        : new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } })
    }) as any,
  }))
  sourceId = (await s.importOne(rawSource)).sourceId!
  await s.probe(sourceId)   // 导入不探针——搜索用例要 verified 态，显式探一次
  return s
}
const run = async (s: ReadingService, name: string, args: unknown): Promise<any> => {
  const tool = buildTools(s).find((t) => t.name === name)!
  return tool.execute(args, exec)
}

describe('agent 工具六件套', () => {
  it('工具名齐 6 个且全部带 dshnovel_ 前缀（防生态撞名——宿主重名直接抛错）；dshnovel_search 结构化分组', async () => {
    const s = await svc()
    const names = buildTools(s).map((t) => t.name).sort()
    expect(names).toEqual(
      ['dshnovel_import_source', 'dshnovel_read', 'dshnovel_search', 'dshnovel_shelf', 'dshnovel_source', 'dshnovel_toc'])
    // 名字集合是占位锁：新增/改名工具必须显式过这条——前缀是与生态其他插件的硬边界
    for (const n of names) expect(n.startsWith('dshnovel_'), `${n} 缺 dshnovel_ 前缀`).toBe(true)
    const v = await run(s, 'dshnovel_search', { keyword: '斗罗' })
    expect(v.groups[0]).toMatchObject({ sourceName: 'S', status: 'verified' })
    expect(v.groups[0].hits[0]).toMatchObject({ title: '斗罗', author: '唐家', url: 'https://s.com/book/1/' })
    expect(JSON.stringify(v)).not.toContain('raw')     // 凭据/原文红线
    // lossless：缺作者的书目缺键而非 author:undefined（undefined 属性值会被 harness 拒收）
    expect(v.groups[0].hits[1]).toMatchObject({ title: '无名书' })
    expect('author' in v.groups[0].hits[1]).toBe(false)
    expect(hasUndefined(v)).toBe(false)
  })
  it('dshnovel_read：按 index 取正文', async () => {
    const s = await svc()
    const v = await run(s, 'dshnovel_read', { sourceId: sourceId, bookKey: 'https://s.com/book/1/', chapterIndex: 0 })
    expect(v).toMatchObject({ chapterIndex: 0, chapterName: '第一章', text: '正文内容' })
  })
  it('dshnovel_toc：章名→0 起下标（跳章流的地基——dshnovel_read 的 chapterIndex 从这里查）', async () => {
    const s = await svc()
    const v = await run(s, 'dshnovel_toc', { sourceId, bookKey: 'https://s.com/book/1/' })
    expect(v).toMatchObject({ sourceId, bookKey: 'https://s.com/book/1/', total: 1 })
    expect(v.chapters[0]).toMatchObject({ chapterIndex: 0, name: '第一章', url: 'https://s.com/c/1.html' })
    expect(hasUndefined(v)).toBe(false)
  })
  it('dshnovel_import_source：好/坏 JSON 文本各走其道（导入不含探针——outcome 无 probe 键）', async () => {
    const s = await svc()
    const v = await run(s, 'dshnovel_import_source', { sourceJson: '[{"bookSourceName":"B","bookSourceUrl":"https://b","ruleContent":"x"}]' })
    expect(v.outcomes[0]).toMatchObject({ ok: true })
    expect('probe' in v.outcomes[0]).toBe(false)     // 导入不探针：好条目也不带 probe 键
    expect(hasUndefined(v)).toBe(false)
    const bad = await run(s, 'dshnovel_import_source', { sourceJson: '{oops' })
    expect(bad.outcomes[0].ok).toBe(false)
    expect(bad.outcomes[0].missing[0].field).toBe('sourceJson')
  })
  it('dshnovel_import_source：规范化失败的 outcome 缺键而非 undefined（失败原因能报出来，不被 harness 吞掉）', async () => {
    const s = await svc()
    // Native 判别边界外的残缺源：既无 bookSource* 也无 name+url → legado 路径报三件套缺失
    const bad = await run(s, 'dshnovel_import_source', { sourceJson: '[{"name":"X"}]' })
    expect(bad.outcomes[0].ok).toBe(false)
    expect(bad.outcomes[0].missing.length).toBeGreaterThan(0)
    expect('sourceId' in bad.outcomes[0]).toBe(false)
    expect('probe' in bad.outcomes[0]).toBe(false)
    expect(hasUndefined(bad)).toBe(false)
  })
  it('dshnovel_shelf：list/add/save_progress/remove 全 action 走通', async () => {
    const s = await svc()
    const added = await run(s, 'dshnovel_shelf', { action: 'add', bookKey: 'https://s.com/book/2/', title: 'T2', sourceId })
    expect(added).toMatchObject({ action: 'add', book: { title: 'T2', sourceId } })
    expect(hasUndefined(added)).toBe(false)
    const saved = await run(s, 'dshnovel_shelf', { action: 'save_progress', bookKey: 'https://s.com/book/2/', chapterIndex: 3, offsetRatio: 0.5 })
    expect(saved).toMatchObject({ action: 'save_progress', book: { progress: { chapterIndex: 3, offsetRatio: 0.5 } } })
    const shelf = await run(s, 'dshnovel_shelf', { action: 'list' })
    expect(shelf.books.some((b: { title: string }) => b.title === 'T2')).toBe(true)
    expect(hasUndefined(shelf)).toBe(false)
    const removed = await run(s, 'dshnovel_shelf', { action: 'remove', bookKey: 'https://s.com/book/2/' })
    expect(removed).toMatchObject({ action: 'remove', removed: true })
    const after = await run(s, 'dshnovel_shelf', { action: 'list' })
    expect(after.books.some((b: { title: string }) => b.title === 'T2')).toBe(false)
  })
  it('dshnovel_shelf：action 缺该 action 的必填参数时抛清楚的错（宁炸不猜）', async () => {
    const s = await svc()
    await expect(run(s, 'dshnovel_shelf', { action: 'add', title: '无bookKey' }))
      .rejects.toThrow(/缺少参数/)
  })
  it('dshnovel_shelf：值域门在门面动词上，工具面写不进非法值（与 HTTP 面同一道门）', async () => {
    const s = await svc()
    const key = 'https://s.com/book/3/'
    // 空 sourceId 此前只在路由拦——工具面直穿，落一条永远读不了的书（getToc('') 才炸）
    await expect(run(s, 'dshnovel_shelf', { action: 'add', bookKey: key, title: 'T3', sourceId: '' }))
      .rejects.toThrow(/非空 sourceId/)
    await expect(run(s, 'dshnovel_shelf', { action: 'add', bookKey: key, title: '', sourceId }))
      .rejects.toThrow(/非空 title/)
    await run(s, 'dshnovel_shelf', { action: 'add', bookKey: key, title: 'T3', sourceId })
    // Infinity 是这条路最危险的值：JSON.stringify(Infinity) === 'null' → 落盘成 null 的静默数据损坏
    await expect(run(s, 'dshnovel_shelf', { action: 'save_progress', bookKey: key, chapterIndex: 0, offsetRatio: Infinity }))
      .rejects.toThrow(/offsetRatio/)
    await expect(run(s, 'dshnovel_shelf', { action: 'save_progress', bookKey: key, chapterIndex: 1.5, offsetRatio: 0 }))
      .rejects.toThrow(/chapterIndex/)
    const shelf = await run(s, 'dshnovel_shelf', { action: 'list' })
    const b = shelf.books.find((x: { title: string }) => x.title === 'T3')
    expect(b.progress).toMatchObject({ chapterIndex: 0, offsetRatio: 0 })
  })
  it('dshnovel_source：list/probe/enable/disable/remove 走通', async () => {
    const s = await svc()
    const id = sourceId
    const list = await run(s, 'dshnovel_source', { action: 'list' })
    expect(list.sources[0]).toMatchObject({ sourceId: id, name: 'S', enabled: true, status: 'verified' })
    expect(hasUndefined(list)).toBe(false)
    // 探针成功：error 键不存在而非 error:undefined（同款 lossless 雷）
    const p = await run(s, 'dshnovel_source', { action: 'probe', sourceId: id })
    expect(p).toMatchObject({ action: 'probe', sourceId: id, ok: true, itemCount: 2 })
    expect('error' in p).toBe(false)
    expect(hasUndefined(p)).toBe(false)
    const off = await run(s, 'dshnovel_source', { action: 'disable', sourceId: id })
    expect(off).toMatchObject({ action: 'disable', sourceId: id, enabled: false })
    const on = await run(s, 'dshnovel_source', { action: 'enable', sourceId: id })
    expect(on).toMatchObject({ action: 'enable', sourceId: id, enabled: true })
    const rm = await run(s, 'dshnovel_source', { action: 'remove', sourceId: id })
    expect(rm).toMatchObject({ action: 'remove', sourceId: id, removed: true })
    const empty = await run(s, 'dshnovel_source', { action: 'list' })
    expect(empty.sources).toHaveLength(0)
  })
  it('dshnovel_source：id 类 action 缺 sourceId 时抛清楚的错', async () => {
    const s = await svc()
    await expect(run(s, 'dshnovel_source', { action: 'probe' })).rejects.toThrow(/缺少参数/)
  })
  it('registerTools：6 次注册 + disposer 聚合全触发', () => {
    const calls: string[] = []
    const ctxLike = { tools: { register: (t: any) => { calls.push(t.name); return () => calls.push(`off:${t.name}`) } } }
    const off = registerTools(ctxLike, {} as ReadingService)
    expect(calls.filter((c) => !c.startsWith('off:'))).toHaveLength(6)
    off()
    expect(calls.filter((c) => c.startsWith('off:'))).toHaveLength(6)
  })
  it('Native 源端到端：导入 → 探针走裁剪后的首页 URL（带 /1 直接 404 的站点）', async () => {
    const dir = await makeTempDir('novel-native-')
    const s = trackService(await ReadingService.create({
      dir,
      fetchImpl: (async (input: any) => {
        const u = String(input)
        // 站点首页路径不带页码：/so/书/1 → 404；/so/书 → 搜索结果页
        if (u === 'https://n.com/so/%E4%B9%A6/1') return new Response('nf', { status: 404 })
        if (u === 'https://n.com/so/%E4%B9%A6') {
          return new Response(SEARCH_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } })
        }
        return new Response('', { status: 404 })
      }) as any,
    }))
    const outcome = await s.importOne({
      name: 'N', url: 'https://n.com', searchUrl: '/so/{{keyword}}/{{page}}',
      ruleSearch: { list: '.b', name: 'tag.a@text' },
      ruleContent: { content: '#c' },
    })
    expect(outcome.ok).toBe(true)
    // 导入不探针——显式探一次验证 Native 分页语义：首页裁掉 /{{page}} 页码段
    const probe = await s.probe(outcome.sourceId!)
    expect(probe.ok).toBe(true)
  })
})
