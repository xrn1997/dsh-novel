import { describe, expect, it } from 'vitest'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import type { ToolOutputDefinition } from '@deepseek-ai/dsh-tools'
import { ReadingService } from '../../src/services/reading.js'
import { SEARCH_BOOKS_CAP } from '../../src/shared/wire.js'
import { buildTools, registerTools } from '../../src/tools/tools.js'
import { TOC_CHAPTERS_CAP } from '../../src/tools/render.js'
import { makeTempDir, trackService } from '../temp-dir.js'

/** 三条 .b：① 含关键词且带作者、② 与关键词无涉、③ 含关键词而无作者 span。
 *  ②③ 分工：② 钉「疑似无关整条不进输出」、③ 让「kept 内」与「缺键投影」两条判据同处可钉。 */
const SEARCH_HTML = '<html><body>'
  + '<div class="b"><a href="/book/1/">斗罗</a><span>唐家</span></div>'
  + '<div class="b"><a href="/book/2/">无名书</a></div>'
  + '<div class="b"><a href="/book/3/">斗罗外传</a></div>'
  + '</body></html>'
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
/** render 的产物是 content 块数组，拼回一句文本才是模型读到的那一份——文案断言只能量这里。
 *  入参类型取自 harness 的 ToolOutputDefinition，不在测试里放宽成 any：render 只认规范 JSON 值 */
const asText = (blocks: unknown): string => (blocks as Array<{ type: 'text'; text: string }>).map((c) => c.text).join('')
const renderOf = (s: ReadingService, name: string, args: unknown,
  value: Parameters<ToolOutputDefinition['render']>[1]): string =>
  asText(buildTools(s).find((t) => t.name === name)!.output.render(args, value))

describe('agent 工具六件套', () => {
  it('工具名齐 6 个且全部带 dshnovel_ 前缀（防生态撞名——宿主重名直接抛错）；dshnovel_search 按书返回且不摆疑似无关', async () => {
    const s = await svc()
    const names = buildTools(s).map((t) => t.name).sort()
    expect(names).toEqual(
      ['dshnovel_import_source', 'dshnovel_read', 'dshnovel_search', 'dshnovel_shelf', 'dshnovel_source', 'dshnovel_toc'])
    // 名字集合是占位锁：新增/改名工具必须显式过这条——前缀是与生态其他插件的硬边界
    for (const n of names) expect(n.startsWith('dshnovel_'), `${n} 缺 dshnovel_ 前缀`).toBe(true)
    const v = await run(s, 'dshnovel_search', { keyword: '斗罗' })
    // 按书视图：档序在前（exact 的斗罗先于 contains 的斗罗外传）；无名书与关键词无涉 ⇒ 整行不进输出
    //（与用户看到的默认视野同一份，模型不该多看见一条）。列表式 toEqual 同时钉住「谁不进」与档序。
    expect(v.books.map((b: { title: string }) => b.title)).toEqual(['斗罗', '斗罗外传'])
    expect(v.books[0]).toMatchObject({ title: '斗罗', author: '唐家', relevance: 'exact', sourceCount: 1 })
    // 逐源行的 sourceId 必须留在册——bookKey 单独不够，其他工具调用要行自己那一家的 id
    expect(v.books[0].sources[0]).toMatchObject({ sourceId, sourceName: 'S', title: '斗罗', url: 'https://s.com/book/1/' })
    expect(v.books[1].relevance).toBe('contains')
    expect(v.failed).toEqual([])
    expect(JSON.stringify(v)).not.toContain('raw')     // 凭据/原文红线
    // 覆盖面三读数：跑了几家、几家干净答话、几条因不相关被移出默认视野——
    // 「没人答话」与「答了但全不相关」是两个可区分的事实，空 books 不许冒充「没找到」。
    expect({ searched: v.searched, answered: v.answered, filtered: v.filtered }).toEqual({ searched: 1, answered: 1, filtered: 1 })
    expect('truncated' in v).toBe(false)               // 缺席=没截断：上限读数不许常驻
    // 工具面真实输出整键缺席（project() 自身的形状纪律由 tests/tools/project.test.ts 钉住）——
    // 这里是唯一证明 execute 真走了 project() 而非绕过的地方；hasUndefined 只管值不许是 undefined，管不到键。
    expect('author' in v.books[1]).toBe(false)
    expect('author' in v.books[1].sources[0]).toBe(false)
    expect(hasUndefined(v)).toBe(false)
  })
  it('dshnovel_search：books 为空时分得开「没人答话」「答了但全不相关」「答了但 0 条」（三读数 + failed 逐家点名）', async () => {
    const dir = await makeTempDir('novel-disclose-')
    const s = trackService(await ReadingService.create({
      dir,
      fetchImpl: (async (input: any) => {
        const u = String(input)
        // A 家答话但唯一一条与关键词无涉；B 家直接 404（本轮没答话）
        if (u.includes('/searchA')) {
          return new Response('<html><body><div class="b"><a href="/a/1/">射雕</a></div></body></html>',
            { headers: { 'content-type': 'text/html; charset=utf-8' } })
        }
        // C 家的搜索页是空列表：干净答话、0 命中——本仓口径「0 命中是结果不是失败」，
        // 所以 answered 认的是有没有 error，不是有没有货。按命中数计会让「答了但全不相关」与
        // 「答了但这本没有」重新焊成一团，三读数存在的理由就没了。
        if (u.includes('/searchC')) {
          return new Response('<html><body></body></html>', { headers: { 'content-type': 'text/html; charset=utf-8' } })
        }
        return new Response('', { status: 404 })
      }) as any,
    }))
    await s.importOne({ ...rawSource, bookSourceName: 'A', bookSourceUrl: 'https://a.com', searchUrl: 'https://a.com/searchA?q={{key}}' })
    const idB = (await s.importOne({ ...rawSource, bookSourceName: 'B', bookSourceUrl: 'https://b.com', searchUrl: 'https://b.com/searchB?q={{key}}' })).sourceId!
    await s.importOne({ ...rawSource, bookSourceName: 'C', bookSourceUrl: 'https://c.com', searchUrl: 'https://c.com/searchC?q={{key}}' })
    const v = await run(s, 'dshnovel_search', { keyword: '斗罗' })
    expect(v.books).toEqual([])
    // 界面上这一轮是「相关 0 · 共 1」外加折叠；工具面没有折叠，只能靠读数分开几回事——
    // C 家计入 answered 却不给 filtered 添一笔
    expect({ searched: v.searched, answered: v.answered, filtered: v.filtered }).toEqual({ searched: 3, answered: 2, filtered: 1 })
    expect(v.failed).toEqual([expect.objectContaining({ sourceId: idB, sourceName: 'B' })])
    expect(typeof v.failed[0].code).toBe('string')
    expect(hasUndefined(v)).toBe(false)
    // 三读数进了结构字段还不算交付：模型读的是文案里「答话 N 家」那一分句，它得在场上
    const say = renderOf(s, 'dshnovel_search', { keyword: '斗罗' }, v)
    expect(say).toContain('0 本（跑了 3 家、答话 2 家、滤去 1 条不相关）')
    // books 为空时摘要行直接接「未答话」那一行——那里多出来的空行是一条不存在的分隔
    expect(say).not.toContain('\n\n')
  })
  it('dshnovel_search：本数超过返回上限时 truncated 如实报数，且那一支的输出过自身 schema', async () => {
    const dir = await makeTempDir('novel-truncated-')
    // 上限之上的那一支只有 cap+1 本才走得到；夹具按常量生成，改上限不用回来改这里的数字
    const many = Array.from({ length: SEARCH_BOOKS_CAP + 1 }, (_, i) =>
      `<div class="b"><a href="/book/${i}/">斗罗第${i}部</a><span>唐家</span></div>`).join('')
    const s = trackService(await ReadingService.create({
      dir,
      fetchImpl: (async () => new Response(`<html><body>${many}</body></html>`,
        { headers: { 'content-type': 'text/html; charset=utf-8' } })) as any,
    }))
    await s.importOne(rawSource)
    const v = await run(s, 'dshnovel_search', { keyword: '斗罗' })
    expect(v.books.length).toBe(SEARCH_BOOKS_CAP)
    // 两个数各指各的：共几本说全量、只返回前几本说返回量——调换了模型就会以为没丢东西
    expect(v.truncated).toBe(`本轮共 ${SEARCH_BOOKS_CAP + 1} 本，只返回前 ${SEARCH_BOOKS_CAP} 本`)
    expect('truncated' in v).toBe(true)
    // 声明了却没值的键钉不住 schema（tests/tools/schema-contract.test.ts 的口径）——
    // 截断那一支也过一次 harness 同款校验，不靠字面量独自作证
    const tool = buildTools(s).find((t) => t.name === 'dshnovel_search')!
    expect(validateJsonSchemaValue(tool.output.schema, v, 'dshnovel_search')).toEqual([])
  })
  it('dshnovel_search 的 render：逐书一行、缺作者不印幽灵、行超 3 才标 …、覆盖面与未答话点名', async () => {
    const s = await svc()
    const body = renderOf(s, 'dshnovel_search', { keyword: '斗罗' }, await run(s, 'dshnovel_search', { keyword: '斗罗' }))
    expect(body).toContain('《斗罗》 / 唐家 · 1 家源：S(https://s.com/book/1/)')
    // 缺作者是整键不在（规范值经缺键投影）——按 null 哨兵比对的老写法会在这里印出「 / undefined」的幽灵作者
    expect(body).toContain('《斗罗外传》 · 1 家源：S(https://s.com/book/3/)')
    expect(body).not.toContain('undefined')
    expect(body).toContain('2 本（跑了 1 家、答话 1 家、滤去 1 条不相关）')
    // 行与家是两条读数：一家两行仍标 2 家（家数按去重）；省略号按**行数**超 3 判——按家数判会把 4 行截成
    // 3 行还不吭声。缺 url 的行给「无地址」，不能印成空串冒充「没有地址这件事」。
    const wide = renderOf(s, 'dshnovel_search', { keyword: '甲' }, {
      books: [{ title: '甲', relevance: 'exact', sourceCount: 2, sources: [
        { sourceId: 'x', sourceName: 'X', title: '甲', url: 'https://x/1' },
        { sourceId: 'x', sourceName: 'X', title: '甲' },
        { sourceId: 'y', sourceName: 'Y', title: '甲', url: 'https://y/1' },
        { sourceId: 'y', sourceName: 'Y', title: '甲', url: 'https://y/2' },
      ] }],
      failed: [{ sourceId: 'z', sourceName: 'Z', code: 'Timeout', message: '等超时' }],
      searched: 3, answered: 2, filtered: 5, truncated: '本轮共 9 本，只返回前 8 本',
    })
    expect(wide).toContain('《甲》 · 2 家源：X(https://x/1)；X(无地址)；Y(https://y/1)…')
    expect(wide).toContain('1 本（跑了 3 家、答话 2 家、滤去 5 条不相关）')
    expect(wide).toContain('1 家未答话：Z：Timeout')
    expect(wide).toContain('本轮共 9 本，只返回前 8 本')
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
  it('dshnovel_toc：规范值超过章数上限时截断，total 仍报全书章数（读取不因此受限）', async () => {
    const many = Array.from({ length: TOC_CHAPTERS_CAP + 1 }, (_, i) => ({ name: `第${i}章`, url: `https://s.com/c/${i}` }))
    const stub = { getToc: async () => many } as unknown as ReadingService
    const v = await run(stub, 'dshnovel_toc', { sourceId: 's', bookKey: 'k' })
    expect(v.total).toBe(TOC_CHAPTERS_CAP + 1)                 // total 是全书章数
    expect(v.chapters).toHaveLength(TOC_CHAPTERS_CAP)          // 规范值本身有上限
    expect(v.chapters[TOC_CHAPTERS_CAP - 1].chapterIndex).toBe(TOC_CHAPTERS_CAP - 1)
    expect(renderOf(stub, 'dshnovel_toc', { sourceId: 's', bookKey: 'k' }, v))
      .toContain(`规范值只含前 ${TOC_CHAPTERS_CAP} 章`)
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
    // Native 判别边界外的残缺源：既无 bookSource* 也无 name+url → 书源路径报三件套缺失
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
    // 值域门在门面动词上：只在路由拦时工具面会直穿，落一条永远读不了的书（getToc('') 才炸）
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
    // itemCount 是**搜索面解析到的条数**，与相关性视野无关（探针答的是「这一家能不能搜出东西」，
    // 不是「这一家有几本相关」）——夹具三条 .b 就是三条。
    const p = await run(s, 'dshnovel_source', { action: 'probe', sourceId: id })
    expect(p).toMatchObject({ action: 'probe', sourceId: id, ok: true, itemCount: 3 })
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
  it('dshnovel_source：enable 未知 id 必抛错（不静默回「已启用」）', async () => {
    const s = await svc()
    await expect(run(s, 'dshnovel_source', { action: 'enable', sourceId: 'nope' }))
      .rejects.toThrow(/源不存在/)
  })
  it('dshnovel_source：id 类 action 缺 sourceId 时抛清楚的错', async () => {
    const s = await svc()
    await expect(run(s, 'dshnovel_source', { action: 'probe' })).rejects.toThrow(/缺少参数/)
  })
  it('六个工具各至少一条 render：规范值经各自 render 成模型读到的文案', async () => {
    const s = await svc()
    const bookKey = 'https://s.com/book/1/'
    const read = await run(s, 'dshnovel_read', { sourceId, bookKey, chapterIndex: 0 })
    expect(renderOf(s, 'dshnovel_read', { sourceId, bookKey, chapterIndex: 0 }, read)).toContain('第一章')
    const toc = await run(s, 'dshnovel_toc', { sourceId, bookKey })
    expect(renderOf(s, 'dshnovel_toc', { sourceId, bookKey }, toc)).toContain('共 1 章')
    const added = await run(s, 'dshnovel_shelf', { action: 'add', bookKey, title: 'T', sourceId })
    expect(renderOf(s, 'dshnovel_shelf', { action: 'add' }, added)).toContain('已加书：《T》')
    const sources = await run(s, 'dshnovel_source', { action: 'list' })
    expect(renderOf(s, 'dshnovel_source', { action: 'list' }, sources)).toContain('共 1 个源')
    const imported = await run(s, 'dshnovel_import_source', { sourceJson: '[{"bookSourceName":"B","bookSourceUrl":"https://b","ruleContent":"x"}]' })
    expect(renderOf(s, 'dshnovel_import_source', {}, imported)).toContain('✓ B')
    const searched = await run(s, 'dshnovel_search', { keyword: '斗罗' })
    expect(renderOf(s, 'dshnovel_search', { keyword: '斗罗' }, searched)).toContain('本（跑了')
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
