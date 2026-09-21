import { describe, expect, it } from 'vitest'
import { assembleRequest, buildSearchRequest, fetchInitOf, parseUrlOption, stripUrlOption } from '../../src/services/request.js'
import { isJsSearchUrl, preEvaluateUrlJs, resolveJsSearchTemplate } from '../../src/services/search-template.js'
import type { Fetcher } from '../../src/services/fetcher.js'
import type { NovelSource } from '../../src/services/types.js'

/** legado URL 模板请求形态（官方文档钉死）：纯 URL / url,{json} 选项 / 相对 URL 按 baseUrl 解析 */
describe('assembleRequest + fetchInitOf（选项语义唯一主人）', () => {
  it('baseUrl=null 不做绝对化（@js ajax 形态：URL 由脚本自己拼）', () => {
    expect(assembleRequest('/rel?a={{key}}', { key: '书' }, null).url).toBe('/rel?a=%E4%B9%A6')
    expect(assembleRequest('/rel?a={{key}}', { key: '书' }, 'https://s.com').url).toBe('https://s.com/rel?a=%E4%B9%A6')
  })
  it('GET 姿态：不带 method/body 键（fetch 缺省即 GET）', () => {
    const init = fetchInitOf(assembleRequest('https://s.com/s?q={{key}}', { key: 'x' }, null), { Cookie: 'a=1' })
    expect(init).toEqual({ headers: { Cookie: 'a=1' } })
    expect('method' in init).toBe(false)
  })
  it('POST：method/body + 表单默认 urlencoded；计划 headers 覆盖 baseHeaders 同名', () => {
    const plan = assembleRequest('https://s.com/s,{"method":"POST","body":"s={{key}}","headers":{"X-A":"1"}}', { key: '书' }, null)
    const init = fetchInitOf(plan, { 'X-A': 'base', Cookie: 'c=1' })
    expect(init.method).toBe('POST')
    expect(init.body).toBe('s=%E4%B9%A6')
    expect(init.headers).toMatchObject({ 'X-A': '1', Cookie: 'c=1', 'Content-Type': 'application/x-www-form-urlencoded' })
    expect(plan.charset).toBeUndefined()
  })
  it('charset 透传到计划（解码优先级交给 fetchTextPage）', () => {
    expect(assembleRequest('https://s.com/x,{"charset":"gbk"}', {}, null).charset).toBe('gbk')
  })
  it('buildSearchRequest 仍是薄壳（历史名字不改语义）', () => {
    expect(buildSearchRequest('/so/{{key}}/{{page}}', { key: 'a', page: 1 }, 'https://s.com', { trimFirstPage: true }).url)
      .toBe('https://s.com/so/a')
  })
})

describe('parseUrlOption', () => {
  it('纯 URL：无 ,{ → 选项 undefined', () => {
    expect(parseUrlOption('/search?q={{key}}')).toEqual({ urlPart: '/search?q={{key}}', option: undefined })
  })
  it('POST 选项形态：URL 与 JSON 分离，method/body/charset 提取', () => {
    const r = parseUrlOption('/search.html,{"method":"POST","body":"searchkey={{key}}","charset":"gbk"}')
    expect(r.urlPart).toBe('/search.html')
    expect(r.option).toMatchObject({ method: 'POST', body: 'searchkey={{key}}', charset: 'gbk' })
  })
  it('单引号 JSON 形态：宽容解析（真实源大量存在）', () => {
    const r = parseUrlOption("/s.php,{'charset':'utf-8','method':'POST','body':'s={{key}}'}")
    expect(r.option).toMatchObject({ method: 'POST', body: 's={{key}}' })
  })
  it('headers 双重编码（JSON 字符串）→ 解析成对象；非法 → undefined', () => {
    const r = parseUrlOption('/x,{"headers":"{\\"User-Agent\\":\\"UA\\"}"}')
    expect(r.option?.headers).toEqual({ 'User-Agent': 'UA' })
    const bad = parseUrlOption('/x,{"headers":"not json"}')
    expect(bad.option?.headers).toBeUndefined()
  })
  it('webView 标志透传（我们不支持，调用方 warning）', () => {
    expect(parseUrlOption('/x,{"webView":true}').option?.webView).toBe(true)
  })
  it('选项 JSON 非法 → URL 仍无条件切分，只是没有选项（legado analyzeUrl 口径）', () => {
    // legado 在解析选项**之前**就把 URL 切干净——解析失败只意味着「没有选项」，不意味着
    // 「整串是 URL」。旧行为把 `,{…}` 留在 URL 里 → 站点 404（年代小说弯引号选项实证）。
    const r = parseUrlOption('/x,{not json at all}')
    expect(r.urlPart).toBe('/x')
    expect(r.option).toBeUndefined()
    const curly = parseUrlOption('/c/1.html,{webView:“true”}')
    expect(curly.urlPart).toBe('/c/1.html')
    expect(curly.option).toBeUndefined()
  })
  // legado paramPattern = \s*,\s*(?=\{)——逗号两侧允许空白（165 条源写 `, {...}` 带空格）
  it('逗号两侧空白的选项形态（legado paramPattern 考证）', () => {
    const r = parseUrlOption('/s.php, {   "charset": "gbk",   "method": "POST",   "body": "s={{key}}" }')
    expect(r.urlPart).toBe('/s.php')
    expect(r.option).toMatchObject({ method: 'POST', body: 's={{key}}', charset: 'gbk' })
  })
})

describe('buildSearchRequest', () => {
  it('相对 URL 按 baseUrl 解析成绝对 URL（148 条失败的根因）', () => {
    const r = buildSearchRequest('/search.php?q={{key}}', { key: '书' }, 'https://m.biqu.com')
    expect(r.url).toBe('https://m.biqu.com/search.php?q=%E4%B9%A6')
    expect(r.method).toBe('GET')
  })
  it('POST 组装：body 插值 + 选项 headers + charset 透传；无显式 Content-Type → 默认 urlencoded', () => {
    const r = buildSearchRequest(
      '/s.php,{"method":"POST","body":"s={{key}}&t=1","charset":"gbk","headers":{"User-Agent":"UA"}}',
      { key: '书' }, 'https://b.com',
    )
    expect(r).toMatchObject({
      url: 'https://b.com/s.php', method: 'POST',
      body: 's=%E4%B9%A6&t=1', charset: 'gbk',
      headers: { 'User-Agent': 'UA', 'Content-Type': 'application/x-www-form-urlencoded' },
    })
  })
  it('POST Content-Type：显式声明（任意大小写）不被默认值覆盖', () => {
    const explicit = buildSearchRequest(
      '/s,{"method":"POST","body":"a=1","headers":{"content-type":"application/json"}}',
      { key: 'x' }, 'https://b.com',
    )
    expect(explicit.headers).toEqual({ 'content-type': 'application/json' })
    const none = buildSearchRequest('/s,{"method":"POST","body":"a=1"}', { key: 'x' }, 'https://b.com')
    expect(none.headers).toEqual({ 'Content-Type': 'application/x-www-form-urlencoded' })
    const get = buildSearchRequest('/s?q={{key}}', { key: 'x' }, 'https://b.com')
    expect(get.headers).toEqual({}) // GET 无 body 不加
  })
  it('绝对 URL 原样保留', () => {
    const r = buildSearchRequest('https://api.example.com/s?k={{key}}', { key: 'x' }, 'https://other.com')
    expect(r.url).toBe('https://api.example.com/s?k=x')
  })
  it('trimFirstPage（Native 语义）：模板以 /{{page}} 结尾且首页 → 裁掉页码段', () => {
    const first = buildSearchRequest('/so/{{key}}/{{page}}', { key: '斗罗', page: 1 }, 'https://bq.com',
      { trimFirstPage: true })
    expect(first.url).toBe('https://bq.com/so/%E6%96%97%E7%BD%97')
    const second = buildSearchRequest('/so/{{key}}/{{page}}', { key: '斗罗', page: 2 }, 'https://bq.com',
      { trimFirstPage: true })
    expect(second.url).toBe('https://bq.com/so/%E6%96%97%E7%BD%97/2')
  })
  it('trimFirstPage 不越界：缺省关闭（legado 行为不变）、模板不以 /{{page}} 结尾不裁', () => {
    const legado = buildSearchRequest('/so/{{key}}/{{page}}', { key: '斗罗', page: 1 }, 'https://bq.com')
    expect(legado.url).toBe('https://bq.com/so/%E6%96%97%E7%BD%97/1')
    const query = buildSearchRequest('/s?kw={{key}}&p={{page}}', { key: 'x', page: 1 }, 'https://bq.com',
      { trimFirstPage: true })
    expect(query.url).toBe('https://bq.com/s?kw=x&p=1')
  })
})

describe('stripUrlOption', () => {
  it('章节 URL 尾部的 ,{"webView":true} 后缀剥离', () => {
    expect(stripUrlOption('https://a.com/ch/1.html,{"webView":true}')).toBe('https://a.com/ch/1.html')
    expect(stripUrlOption('https://a.com/ch/1.html')).toBe('https://a.com/ch/1.html')
  })
  it('正文中的逗号+花括号不误剥（只认尾部完整 JSON 形态）', () => {
    expect(stripUrlOption('https://a.com/s?q={a,b}')).toBe('https://a.com/s?q={a,b}')
  })
})

// ── searchUrl 的 JS 形态（642 源重探：61 条失败源的 searchUrl 是 @js 脚本）──────────

describe('isJsSearchUrl', () => {
  it('@js: / js: / <js> 开头判定（容前导空白）', () => {
    expect(isJsSearchUrl('@js:key+"x"')).toBe(true)
    expect(isJsSearchUrl('  <js>key</js>')).toBe(true)
    expect(isJsSearchUrl('/search?q={{key}}')).toBe(false)
    expect(isJsSearchUrl('$.data.list')).toBe(false)
  })
})

describe('resolveJsSearchTemplate', () => {
  const mkSource = (header: Record<string, string> | null = null): NovelSource => ({
    id: 'i', name: 'n', baseUrl: 'https://a.com', enabled: true, groups: [], type: 'text', raw: {},
    rules: { searchUrl: null, exploreUrl: null, ruleBookList: null, ruleBookName: null, ruleAuthor: null,
      ruleBookUrl: null, ruleCoverUrl: null, ruleIntro: null, ruleLastChapter: null, ruleTocUrl: null,
      ruleChapterList: null, ruleChapterName: null, ruleChapterUrl: null,
      ruleDetailName: null, ruleDetailAuthor: null, ruleDetailCoverUrl: null,
      ruleDetailIntro: null, ruleDetailLastChapter: null, ruleDetailInit: null,
      ruleContent: 'x', nextTocUrl: null, nextPageUrl: null, header, loginUrl: null, jsLib: null, headerRule: null },
    status: 'unverified', importedAt: 0,
  })
  // 探针只需网络能力占位：@js 不发请求时 fetch 不会被调用
  const fetcher: Fetcher = { fetchPage: async () => { throw new Error('不应触网') } }

  it('完成值语义：裸表达式结尾（无 return）→ 最后一个表达式的值即 URL', async () => {
    const t = await resolveJsSearchTemplate(mkSource(),
      '@js:var enc = encodeURIComponent(key);\n"https://a.com/s?k=" + enc + "&p=" + page', '剑来', 2, fetcher)
    expect(t).toBe('https://a.com/s?k=%E5%89%91%E6%9D%A5&p=2')
  })
  it('顶层 return 形态 → SyntaxError 回落函数体，返回值生效', async () => {
    const t = await resolveJsSearchTemplate(mkSource(),
      '@js:if (key) { return "https://a.com/ret/" + key; }', 'x', 1, fetcher)
    expect(t).toBe('https://a.com/ret/x')
  })
  it('<js>…</js> 形态 + url,{json} 选项产出（模板交给 buildSearchRequest 统一收口）', async () => {
    const t = await resolveJsSearchTemplate(mkSource(),
      '<js>"https://a.com/api/search," + JSON.stringify({method:"POST",body:"wd="+key})</js>', 'abc', 1, fetcher)
    expect(t).toBe('https://a.com/api/search,{"method":"POST","body":"wd=abc"}')
  })
  it('source.getVariable/setVariable 垫片按源隔离', async () => {
    const src = mkSource()
    await resolveJsSearchTemplate(src, '@js:source.setVariable(JSON.stringify({host:"x.com"}));"ok"', '', 1, fetcher)
    const t = await resolveJsSearchTemplate(src, '@js:JSON.parse(source.getVariable()).host', '', 1, fetcher)
    expect(t).toBe('x.com')
  })
  it('脚本未产出 URL（空结果）→ RuleEvalError 如实报错', async () => {
    await expect(resolveJsSearchTemplate(mkSource(), '@js:""', 'x', 1, fetcher)).rejects.toThrow(/求值结果为空/)
  })
  it('脚本运行期抛错 → JsSandboxError 上抛（不吞错）', async () => {
    await expect(resolveJsSearchTemplate(mkSource(), '@js:null.x', 'x', 1, fetcher)).rejects.toThrow()
  })
})

// ── {{...}} JS 表达式预求值（legado replaceKeyPageJs 口径：URL 模板内 {{...}} 全按 JS 执行）──

describe('preEvaluateUrlJs', () => {
  const mkSource = (): NovelSource => ({
    id: 'i', name: 'n', baseUrl: 'https://a.com', enabled: true, groups: [], type: 'text', raw: {},
    rules: { searchUrl: null, exploreUrl: null, ruleBookList: null, ruleBookName: null, ruleAuthor: null,
      ruleBookUrl: null, ruleCoverUrl: null, ruleIntro: null, ruleLastChapter: null, ruleTocUrl: null,
      ruleChapterList: null, ruleChapterName: null, ruleChapterUrl: null,
      ruleDetailName: null, ruleDetailAuthor: null, ruleDetailCoverUrl: null,
      ruleDetailIntro: null, ruleDetailLastChapter: null, ruleDetailInit: null,
      ruleContent: 'x', nextTocUrl: null, nextPageUrl: null, header: null, loginUrl: null, jsLib: null, headerRule: null },
    status: 'unverified', importedAt: 0,
  })
  const fetcher: Fetcher = { fetchPage: async () => { throw new Error('不应触网') } }

  it('JS 表达式求值（{{java.encodeURI(key)}} 等——此前原样拼进 URL 必炸）', async () => {
    const t = await preEvaluateUrlJs(mkSource(), '/s?k={{java.encodeURI(key)}}&p={{page*2}}', '剑来', 3, fetcher)
    expect(t).toBe('/s?k=%E5%89%91%E6%9D%A5&p=6')
  })
  it('纯变量占位 {{key}}/{{page}} 原样保留（交给后续 interpolateUrl 保持编码口径）', async () => {
    const t = await preEvaluateUrlJs(mkSource(), '/s?q={{key}}&p={{page}}', 'x', 1, fetcher)
    expect(t).toBe('/s?q={{key}}&p={{page}}')
  })
  it('无 {{}} → 原样返回（零开销快路径）', async () => {
    expect(await preEvaluateUrlJs(mkSource(), '/s?q=abc', 'x', 1, fetcher)).toBe('/s?q=abc')
  })
  it('求值结果拼回原位（混合纯变量与 JS 表达式）', async () => {
    const t = await preEvaluateUrlJs(mkSource(), '/s?q={{key}}&n={{1+2}}', 'x', 1, fetcher)
    expect(t).toBe('/s?q={{key}}&n=3')
  })
})
