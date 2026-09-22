import { describe, expect, it } from 'vitest'
import { runScript } from '../../src/engine/js-sandbox.js'
import { JsSandboxError } from '../../src/engine/errors.js'

const loc = { segmentIndex: 0, segmentRaw: '<js>test</js>' }

describe('沙箱 legado 绑定与作用域（本轮修复钉子）', () => {
  it('非严格模式：未声明赋值写全局（legado sloppy 语义——真实源 `next = []` 形态）', async () => {
    const out = await runScript({
      code: 'next = [];\nnext.push(1, 2);\nnext.length',
      loc, facet: 'toc', scriptForm: true,
    })
    expect(out.value).toEqual({ kind: 'value', text: '2' })
  })
  it('非严格模式：顶层 return 回落函数体形态后仍未声明赋值不炸', async () => {
    const out = await runScript({
      code: 'list = [1, 2, 3];\nreturn list.join("-");',
      loc, facet: 'toc', scriptForm: true,
    })
    expect(out.value).toEqual({ kind: 'value', text: '1-2-3' })
  })
  it('src 绑定 = 当前页面原文（JSON 页给序列化文本）', async () => {
    // ctx 未注入 html/json → src 为空串：''.length → 0（如实，不炸）
    const out = await runScript({
      code: 'src.length',
      loc, facet: 'toc', scriptForm: true,
      baseUrl: 'https://x.com/api', source: 'https://x.com',
    })
    expect(out.value).toEqual({ kind: 'value', text: '0' })
    // 空串完成值 → Miss（js 返回空口径）
    const out2 = await runScript({ code: 'src', result: '', loc, facet: 'content', scriptForm: true })
    expect(out2.value.kind).toBe('miss')
  })
  it('runScript 入口不注入 book/chapter（空对象——字段串成 "undefined"，注入归 evalJs 面）', async () => {
    const out = await runScript({
      code: 'book.bookUrl + "|" + chapter.title + "|" + chapter.index',
      loc, facet: 'content', scriptForm: true,
      baseUrl: 'https://x.com/b/1',
    })
    // 这条钉的是**边界**：book/chapter 只在服务层按面注入（下一条用例钉注入侧），
    // runScript 这条入口拿不到它们——断整串而非 toContain('|')，否则绑定悄悄变空也照绿。
    expect(out.value.kind).toBe('value')
    expect((out.value as { text: string }).text).toBe('undefined|undefined|undefined')
  })
  it('evalJs 直连：ctx.book/ctx.chapter 可见（沙箱全局注入）', async () => {
    const { evalJs } = await import('../../src/engine/js-sandbox.js')
    const out = await evalJs(
      'book.bookUrl + "|" + chapter.title',
      { result: '', baseUrl: 'https://x.com/b/1', source: 'https://x.com' },
      {
        baseUrl: 'https://x.com/b/1',
        book: { bookUrl: 'https://x.com/b/1', name: '诡秘' },
        chapter: { title: '第3章', index: 3, url: 'https://x.com/b/1/3' },
      },
      loc, 'content', undefined, { scriptForm: true },
    )
    expect(out.value).toEqual({ kind: 'value', text: 'https://x.com/b/1|第3章' })
  })
  it('evalJs 直连：src 取 ctx.html', async () => {
    const { evalJs } = await import('../../src/engine/js-sandbox.js')
    const out = await evalJs(
      'src.match(/id="([\\w-]+)"/)[1]',
      { result: '', baseUrl: 'https://x.com', source: 'https://x.com' },
      { baseUrl: 'https://x.com', html: '<div id="chapter-list">x</div>' },
      loc, 'toc', undefined, { scriptForm: true },
    )
    expect(out.value).toEqual({ kind: 'value', text: 'chapter-list' })
  })
  it('java.ajax 同步语义（worker + SAB RPC 桥——legado runBlocking 口径）', async () => {
    const fetchImpl = async (url: string): Promise<{ body: string }> => ({ body: `BODY:${url}` })
    const out = await runScript({
      code: 'var b = java.ajax("https://x.com/p"); b.indexOf("BODY") + "|" + b.length',
      loc, facet: 'content', scriptForm: true,
      baseUrl: 'https://x.com', source: 'https://x.com', fetch: fetchImpl,
    })
    expect(out.value).toEqual({ kind: 'value', text: '0|20' })
    // 链式同步消费形态（真实源主导写法）
    const out2 = await runScript({
      code: 'java.ajax("https://x.com/q").match(/^BODY:(.*)$/)[1]',
      loc, facet: 'content', scriptForm: true,
      baseUrl: 'https://x.com', source: 'https://x.com', fetch: fetchImpl,
    })
    expect(out2.value).toEqual({ kind: 'value', text: 'https://x.com/q' })
    // 抓取失败 → 如实抛（JsSandboxError 带定位），不静默
    const err = await runScript({
      code: 'java.ajax("https://x.com/boom").length',
      loc, facet: 'content', scriptForm: true,
      baseUrl: 'https://x.com', source: 'https://x.com',
      fetch: async () => { throw new Error('站点挂了') },
    }).then(() => null, (e) => e)
    expect(String(err.message)).toContain('站点挂了')
  })
  it('java.ajax 参数规约：非串按 String(值) 交下去（Rhino 的 String 形参转换），空值点名且不发请求', async () => {
    const seen: unknown[] = []
    const fetchImpl = async (url: string): Promise<{ body: string }> => { seen.push(url); return { body: 'OK' } }
    // 真源形态：上一段 JSONPath 产出 `['https://…']`，脚本直接 java.ajax(result)——
    // 对面（Rhino）按 String 形参转换，单元素数组的 toString 就是那条 URL；本仓此前把原值
    // 交给请求组装层，炸成 `template.replace is not a function`（灯读文学 init 段实证）。
    const out = await runScript({
      code: 'java.ajax(["https://x.com/one"]); java.ajax(42); "done"',
      loc, facet: 'content', scriptForm: true,
      baseUrl: 'https://x.com', source: 'https://x.com', fetch: fetchImpl,
    })
    expect(out.value).toEqual({ kind: 'value', text: 'done' })
    expect(seen).toEqual(['https://x.com/one', '42'])
    const err = await runScript({
      code: 'java.ajax(null)', loc, facet: 'content', scriptForm: true,
      baseUrl: 'https://x.com', source: 'https://x.com', fetch: fetchImpl,
    }).then(() => null, (e: unknown) => e)
    expect(String((err as Error).message)).toMatch(/java\.ajax 参数为空/)
    expect(seen).toHaveLength(2)   // 空值不拿 "null" 去打站点
  })
  it('worker 路线自身的逃逸防御与超时（不是主线程用例的复述）', async () => {    // 只有脚本提到 java.ajax( 才走 worker + SAB RPC（`SYNC_WORKER_RE`）——本用例靠 fetch 计数
    // 自证确实走了这条路：主线程路径不会调 fetch，计数为 0 即说明钉错了地方。
    let ajaxCalls = 0
    const fetchImpl = async (url: string): Promise<{ body: string }> => { ajaxCalls++; return { body: `BODY:${url}` } }
    const viaWorker = {
      loc, facet: 'content' as const, scriptForm: true,
      baseUrl: 'https://x.com', source: 'https://x.com', fetch: fetchImpl,
    }
    const out = await runScript({
      ...viaWorker,
      code: 'java.ajax("https://x.com/p"); typeof require + "|" + typeof process + "|" + typeof module',
    })
    expect(ajaxCalls).toBe(1)                                            // 证明走的是 worker RPC 桥
    expect(out.value).toEqual({ kind: 'value', text: 'undefined|undefined|undefined' })
    // worker 里的 vm 上下文同样 codeGeneration:false → Function 构造器不可用（拿不到宿主 realm）
    const err = await runScript({
      ...viaWorker,
      code: 'java.ajax("https://x.com/p"); return Function("return process")()',
    }).then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(JsSandboxError)
    // 同步死循环由 worker 内 vm timeout 熔断（外层 race 只是第二道闸）
    await expect(runScript({
      ...viaWorker, jsTimeoutMs: 300,
      code: 'java.ajax("https://x.com/p"); while(true){}',
    })).rejects.toThrow(/脚本超时/)
  })
  it('JSON 页 result 按对象绑定（legado isJSON 口径——result.chapterTitle 字段访问形态）', async () => {
    const { evalJs } = await import('../../src/engine/js-sandbox.js')
    const json = JSON.stringify({ chapterTitle: '第9章', chapterId: 77 })
    const out = await evalJs(
      'result.chapterTitle + "|" + result.chapterId',
      { result: json, resultKind: 'page', baseUrl: 'https://x.com/api', source: 'https://x.com' },
      { baseUrl: 'https://x.com/api', html: json },
      loc, 'toc', undefined, { scriptForm: true },
    )
    expect(out.value).toEqual({ kind: 'value', text: '第9章|77' })
    // HTML 页 result 仍是元素包装（字符串方法照常）
    const out2 = await evalJs(
      'result.replace(/x/g, "y")',
      { result: '<p>x页</p>', resultKind: 'page', baseUrl: 'https://x.com', source: 'https://x.com' },
      { baseUrl: 'https://x.com', html: '<p>x页</p>' },
      loc, 'toc', undefined, { scriptForm: true },
    )
    expect(out2.value).toEqual({ kind: 'value', text: '<p>y页</p>' })
  })
  it('org.jsoup.Jsoup.parse 最小仿真（select/size/get/text 链——白鹿书院形态）', async () => {
    const out = await runScript({
      code: 'var doc = org.jsoup.Jsoup.parse(result); var els = doc.select("a"); els.size() + "|" + els.get(0).text() + "|" + els.get(0).attr("href")',
      result: '<ol><li><a href="/c/1">第一章</a></li><li><a href="/c/2">第二章</a></li></ol>',
      loc, facet: 'toc', scriptForm: true,
      baseUrl: 'https://x.com', source: 'https://x.com',
    })
    expect(out.value).toEqual({ kind: 'value', text: '2|第一章|/c/1' })
  })
  it('等价写法同语义：java["ajax"] 与注释干扰都不再改变返回类型', async () => {
    let ajaxCalls = 0
    const fetchImpl = async (url: string): Promise<{ body: string }> => { ajaxCalls++; return { body: `BODY:${url}` } }
    const base = {
      loc, facet: 'content' as const, scriptForm: true,
      baseUrl: 'https://x.com', source: 'https://x.com', fetch: fetchImpl,
    }
    // 修复前这三条分别是 string / object / string——源码文本选择了语义。
    // 三种拼写现在都被放宽后的 SYNC_WORKER_RE 直接送进 worker（下标访问命中 `java[`）。
    const direct = await runScript({ ...base, code: 'typeof java.ajax("https://x.com/p")' })
    const bracket = await runScript({ ...base, code: 'typeof java["ajax"]("https://x.com/p")' })
    const commented = await runScript({ ...base, code: '/* java.ajax( */ typeof java["ajax"]("https://x.com/p")' })
    expect(direct.value).toEqual({ kind: 'value', text: 'string' })
    expect(bracket.value).toEqual({ kind: 'value', text: 'string' })
    expect(commented.value).toEqual({ kind: 'value', text: 'string' })
    expect(ajaxCalls).toBe(3)                                    // 每段各一次：不多打站点
    // 同步链式消费形态在别名写法下同样成立（真实源主导写法）
    const chained = await runScript({ ...base, code: 'java["ajax"]("https://x.com/q").match(/^BODY:(.*)$/)[1]' })
    expect(chained.value).toEqual({ kind: 'value', text: 'https://x.com/q' })
  })

  it('哨兵重跑不重复计日志、不多打站点，也不把哨兵当脚本错误上报', async () => {
    let ajaxCalls = 0
    const fetchImpl = async (url: string): Promise<{ body: string }> => { ajaxCalls++; return { body: `BODY:${url}` } }
    // 解构写法：SYNC_WORKER_RE 认不出（既无 `.ajax(` 也无 `java[`），故真走「主线程撞哨兵 →
    // worker 重跑」这条路——别名/下标写法已被放宽的正则直接送进 worker，钉不到哨兵。
    const out = await runScript({
      loc, facet: 'content', scriptForm: true,
      baseUrl: 'https://x.com', source: 'https://x.com', fetch: fetchImpl,
      code: 'console.log("只一次"); const { ajax } = java; ajax("https://x.com/p"); "done"',
    })
    expect(out.logs).toEqual(['只一次'])
    expect(out.value).toEqual({ kind: 'value', text: 'done' })
    // 哨兵在**发起宿主调用之前**抛：主线程那趟没打出请求，重跑才打——合计一次。
    // 哨兵若挪到宿主调用之后，这条即变 2。
    expect(ajaxCalls).toBe(1)
  })

  it('别名写法被脚本自己的 try/catch 包住也拿到同步语义（放宽正则后压根不抛哨兵）', async () => {
    const fetchImpl = async (url: string): Promise<{ body: string }> => ({ body: `BODY:${url}` })
    // 哨兵靠「抛出」传递，脚本自己的 catch 会在 vm 内吞掉它 → 那段脚本静默走 catch 分支。
    // 现实的别名写法（下标访问）被正则直接送进 worker，就走不到抛哨兵那一步；
    // 仍漏的是解构 / with 这类不含那三个字面量的间接形态；计算键 java[...] 字面含 java[，已被下标分支捞走。
    const out = await runScript({
      loc, facet: 'content', scriptForm: true,
      baseUrl: 'https://x.com', source: 'https://x.com', fetch: fetchImpl,
      code: 'try { java["ajax"]("https://x.com/p").match(/^BODY:(.*)$/)[1] } catch (e) { "caught:" + e.message }',
    })
    expect(out.value).toEqual({ kind: 'value', text: 'https://x.com/p' })
  })
})
