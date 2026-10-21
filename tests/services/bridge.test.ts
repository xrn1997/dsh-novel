import { describe, expect, it } from 'vitest'
import { evaluate } from '../../src/engine/index.js'
import type { EngineValue } from '../../src/engine/index.js'
import type { SubRuleEval } from '../../src/services/bridge.js'
import {
  detailFieldsOf, detailReadOf, engineContextOf, extractItems, absUrl, engineFetch, firstUrlValue, firstValue,
  formatWordCount, hitFieldsOf, kindFieldOf, listValue, makeSubEval, wordCountFieldOf,
} from '../../src/services/bridge.js'
import { CookieJar } from '../../src/services/cookies.js'
import type { Fetcher } from '../../src/services/fetcher.js'
import { normalizeSource } from '../../src/services/normalize.js'
import { tocUrlOf } from '../../src/services/reading.js'
import type { NovelSource } from '../../src/services/types.js'
import { stripUrlOption } from '../../src/services/url.js'

describe('值规约', () => {
  it('miss → null（源没这条信息）', () => {
    expect(firstValue({ kind: 'miss', detail: 'x' })).toBeNull()
    expect(listValue({ kind: 'miss', detail: 'x' })).toBeNull()
  })
  it('value/list/matches 规约（matches 行 = [整段, 组 1..n]，条目取组 1..n）', () => {
    expect(firstValue({ kind: 'value', text: 'a' })).toBe('a')
    expect(firstValue({ kind: 'list', items: ['a', 'b'] })).toBe('a\nb')
    expect(firstValue({ kind: 'matches', rows: [['m1', 't1', 'x'], ['m2', 't2']] })).toBe('t1\nt2')
    // 无捕获组 → 单元素行，整段即条目
    expect(firstValue({ kind: 'matches', rows: [['only']] })).toBe('only')
    expect(listValue({ kind: 'value', text: 'a' })).toEqual(['a'])
    expect(listValue({ kind: 'matches', rows: [['m1', 't1'], ['m2', 't2']] })).toEqual(['t1', 't2'])
  })
  it('URL 位的值规约：list 取首项（join 出来的多行串会被 absUrl 的换行守卫判死）', () => {
    // 与 firstValue 的**唯一**差别。多命中取首项 = 对面的 URL 取值口径
    // （URL 位一律 `list[0]`，join 只服务非 URL 取值——见矩阵行 b-url-value-first-item）。
    expect(firstUrlValue({ kind: 'list', items: ['/book/1/', '/book/1/9.html'] })).toBe('/book/1/')
    // 其余四态与 firstValue 同口径：单值直通、miss→null、空列表→''（同 join 空态）、nodes 抛
    expect(firstUrlValue({ kind: 'value', text: '/a' })).toBe('/a')
    expect(firstUrlValue({ kind: 'miss', detail: 'x' })).toBeNull()
    expect(firstUrlValue({ kind: 'list', items: [] })).toBe('')
    expect(() => firstUrlValue({ kind: 'nodes', nodes: [] } as never, 'search')).toThrow(/节点集/)
  })
})

describe('engineContextOf 的 HTTP cookie 桥', () => {
  it('setCookie 收 cookie 串的多对，并把 Path/Secure 当属性跳过', () => {
    const jar = new CookieJar()
    const fetcher: Fetcher = {
      fetchPage: async () => { throw new Error('本用例不发请求') },
      cookieJar: jar,
    }
    const normalized = normalizeSource({
      bookSourceName: 'Cookie源', bookSourceUrl: 'https://a.test',
      ruleBookList: '@css:.b', ruleBookName: 'tag.a@text', ruleBookUrl: 'tag.a@href',
      ruleContent: '@css:#c@text',
    })
    const source: NovelSource = { ...normalized.source!, id: 'cookie-src', status: 'unverified', importedAt: 0 }
    const ctx = engineContextOf(fetcher, source, { baseUrl: source.baseUrl })
    ctx.httpCookies!.setCookie('https://a.test/x', 'a=1; b=2; Path=/; Secure')
    expect(jar.entries().map((e) => `${e.name}=${e.value}`)).toEqual(['a=1', 'b=2'])
    expect(jar.headerFor('https://a.test/x')).toBe('a=1; b=2')
  })
})

describe('extractItems（列表页条目）', () => {
  it('nodes → 逐节点 HTML 片段（条目数不压平）', async () => {
    const { evaluate } = await import('../../src/engine/index.js')
    const html = '<ul><li class="item"><a>甲</a></li><li class="item"><a>乙</a></li></ul>'
    const v = await evaluate('@css:li.item', { html }, 'search')
    const items = extractItems(v)
    expect(items).toHaveLength(2)
    expect(items[0]).toContain('甲')
    expect(items[1]).toContain('乙')
  })
  it('miss → 空数组（搜索零结果合法）', () => {
    expect(extractItems({ kind: 'miss', detail: 'x' })).toEqual([])
  })
})

describe('absUrl', () => {
  const base = 'https://m.a.com/book/1/'
  it('相对/绝对/协议相对', () => {
    expect(absUrl('/2/3.html', base)).toBe('https://m.a.com/2/3.html')
    expect(absUrl('4.html', base)).toBe('https://m.a.com/book/1/4.html')
    expect(absUrl('https://x.com/a', base)).toBe('https://x.com/a')
    expect(absUrl('//cdn.com/c.png', base)).toBe('https://cdn.com/c.png')
  })
  it('javascript:/空 → null（不猜）', () => {
    expect(absUrl('javascript:void(0)', base)).toBeNull()
    expect(absUrl(null, base)).toBeNull()
    expect(absUrl('', base)).toBeNull()
  })
})

describe('engineFetch（java.ajax 出口）', () => {
  // java.ajax 的 URL 可带 `url,{json}` 请求选项。
  // 此前不解析选项、整串当 URL 发出 → 站点 403/404（真实崩溃案例：@js 脚本拼
  // `search.php,{'body':...}` 传给 java.ajax）。
  const mkFetcher = () => {
    const seen: Array<{ url: string; init?: { method?: string; headers?: Record<string, string>; body?: string } }> = []
    return {
      seen,
      fetcher: {
        fetchPage: async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
          seen.push({ url, init })
          return { raw: Buffer.from('{"ok":true}'), finalUrl: url, contentType: 'application/json', charset: 'utf-8' }
        },
      } as never,
    }
  }

  it('URL 带 url,{json} 选项（单引号 JSON）→ 剥离选项、按 POST 发正确端点', async () => {
    const { seen, fetcher } = mkFetcher()
    const f = engineFetch(fetcher, { 'User-Agent': 'DEFAULT' })
    await f("https://m.a.com/search.php,{'body':'k={{key}}','method':'POST','headers':{'User-Agent':'UA-TEST'}}")
    expect(seen[0].url).toBe('https://m.a.com/search.php')
    expect(seen[0].init?.method).toBe('POST')
    expect(seen[0].init?.headers?.['User-Agent']).toBe('UA-TEST')
    expect(seen[0].init?.headers?.['Content-Type']).toBe('application/x-www-form-urlencoded')
  })

  it('body 内 {{key}} 经 vars 插值（encodeURIComponent 口径）', async () => {
    const { seen, fetcher } = mkFetcher()
    const f = engineFetch(fetcher, {}, { key: '凡人' })
    await f("https://m.a.com/s,{'body':'k={{key}}','method':'POST'}")
    expect(seen[0].init?.body).toBe('k=%E5%87%A1%E4%BA%BA')
  })

  it('无选项的纯 URL → 直接 GET（行为不变）', async () => {
    const { seen, fetcher } = mkFetcher()
    const f = engineFetch(fetcher, { 'User-Agent': 'UA' })
    await f('https://m.a.com/plain.json')
    expect(seen[0].url).toBe('https://m.a.com/plain.json')
    expect(seen[0].init?.method).toBeUndefined()
  })
})

/**
 * 分类 / 字数两个字段的取值口径（搜索面与详情面各一处）。三条都不是本仓可以自行简化的：
 * kind 是 **逗号串**（不是首值——多命中取首值等于换一个值）、
 * wordCount 在**解析层**就格式化（存进书目的已是「1.2万字」这种串），
 * 且这一族的读取包在 try/catch 里（一条坏分类规则不许带走整页书目）。
 */
describe('分类字段 kindFieldOf（对面 getStringList → joinToString(",") → take(1000)）', () => {
  /** 走真引擎的 subEval + 同一段片段上下文：字段语义的钉子要真求值，不造桩 */
  const at = (html: string) => ({
    sub: ((rule, ctx, facet, usage) =>
      evaluate(rule, { html: ctx.html, baseUrl: ctx.baseUrl }, facet, usage ?? 'value')) as SubRuleEval,
    ctx: { html, baseUrl: 'https://a.com/book/1/' },
  })
  const BASE = 'https://a.com/book/1/'

  it('多命中 → 逗号串（不是首值）', async () => {
    const f = at('<p><a>玄幻</a><a>都市</a><a>连载</a></p>')
    expect(await kindFieldOf(f.sub, 'tag.a@text', f.ctx, 'search')).toBe('玄幻,都市,连载')
  })
  it('单命中 / miss → 单值 / null', async () => {
    expect(await kindFieldOf(at('<p><a>玄幻</a></p>').sub, 'tag.a@text', { html: '<p><a>玄幻</a></p>', baseUrl: BASE }, 'search')).toBe('玄幻')
    const miss = at('<p><em>无</em></p>')
    expect(await kindFieldOf(miss.sub, 'tag.a@text', miss.ctx, 'search')).toBeNull()
    const any = at('<p></p>')
    expect(await kindFieldOf(any.sub, null, any.ctx, 'search')).toBeNull()   // 规则缺席
  })
  it('截断到 1000 个字符（对面 String.take(1000) 与 JS slice 同为 UTF-16 code unit）', async () => {
    const f = at(`<p>${Array.from({ length: 200 }, () => '<a>0123456789</a>').join('')}</p>`)
    const v = await kindFieldOf(f.sub, 'tag.a@text', f.ctx, 'search')
    expect(v).not.toBeNull()
    expect((v as string).length).toBe(1000)
  })
  it('对面 try/catch 那一半：本仓认不出的规则形态只让该字段留空，书目照收', async () => {
    const f = at('<p><a>玄幻</a></p>')
    // `kind: "0"` / `kind: "k"` 是真库形态（现量由 `DSH_PARSE_CENSUS` 读数表重算）：
    // 无 `@` 单段在解析期抛 UnsupportedRuleError——吞掉它才符合「坏字段不带走整页」，抛出即整组书目变 error。
    expect(await kindFieldOf(f.sub, '0', f.ctx, 'search')).toBeNull()
    // 求值期炸掉（这里是宿主桩抛「需要安卓宿主环境」）同样只让该字段留空
    expect(await kindFieldOf(f.sub, '@js:java.getVerificationCode("x")', f.ctx, 'search')).toBeNull()
  })
})

describe('字数字段 wordCountFieldOf（数字串 → x字 / x.x万字）', () => {
  const at = (html: string) => ({
    sub: ((rule, ctx, facet, usage) =>
      evaluate(rule, { html: ctx.html, baseUrl: ctx.baseUrl }, facet, usage ?? 'value')) as SubRuleEval,
    ctx: { html, baseUrl: 'https://a.com/book/1/' },
  })

  it('整串是整数才转换：≤10000 加「字」，>10000 除一万加「万字」', () => {
    expect(formatWordCount('8000')).toBe('8000字')
    expect(formatWordCount('10000')).toBe('10000字')       // 边界：不 >
    expect(formatWordCount('10001')).toBe('1万字')          // 保留一位小数、不补零
    expect(formatWordCount('12345')).toBe('1.2万字')
    expect(formatWordCount('198765')).toBe('19.9万字')
  })
  it('舍入是 HALF_EVEN（Java DecimalFormat 默认），不是四舍五入', () => {
    expect(formatWordCount('12500')).toBe('1.2万字')        // 1.25 → 偶数 1.2
    expect(formatWordCount('13500')).toBe('1.4万字')        // 1.35 → 1.4
  })
  it('非数字原样给回；≤0 变空串；null 仍是 null', () => {
    expect(formatWordCount('120万字')).toBe('120万字')
    expect(formatWordCount('连载中')).toBe('连载中')
    expect(formatWordCount('1,234')).toBe('1,234')         // 带千分位 = 不整串匹配 -?[0-9]+
    expect(formatWordCount('0')).toBe('')
    expect(formatWordCount('-5')).toBe('')                 // 数字但 ≤0
    expect(formatWordCount(null)).toBeNull()
  })
  it('取到值才格式化 + 取不出即留空（与 kind 同一条对面闸口）', async () => {
    const hit = at('<span>12345</span>')
    expect(await wordCountFieldOf(hit.sub, 'tag.span@text', hit.ctx, 'detail')).toBe('1.2万字')
    const empty = at('<span></span>')
    // 空元素取到的是空串而非 Miss：formatWordCount("") = ""（照赋值，不折成空值），
    // 详情面才用非空判定挡住——本仓两边都给空串，不折成 null（Miss 与空值是两种东西）
    expect(await wordCountFieldOf(empty.sub, 'tag.span@text', empty.ctx, 'detail')).toBe('')
    const bad = at('<span>123</span>')
    expect(await wordCountFieldOf(bad.sub, '0', bad.ctx, 'detail')).toBeNull()
  })
})

describe('hitFieldsOf（一条命中的装配单点）', () => {
  // 假 SubRuleEval 按键给回引擎值：装配的档位判据在这里测，不需要站点、也不需要整轮搜索
  const evalOf = (table: Record<string, EngineValue | Error>): SubRuleEval =>
    async (rule) => {
      const v = table[rule]
      if (v instanceof Error) throw v
      return v ?? { kind: 'miss', detail: `未登记的规则：${rule}` }
    }
  const ctx = { html: '<li>x</li>', baseUrl: 'https://b.example/list/1' }
  const rules = { name: 'N', author: 'A', url: 'U', cover: 'C', intro: 'I', last: 'L', kind: 'K', wordCount: 'W' }
  const val = (text: string): EngineValue => ({ kind: 'value', text })

  it('书名 Miss 或去空白后为空 → null（这一条不成书，不产出空标题书目冒充命中）', async () => {
    expect(await hitFieldsOf(rules, evalOf({}), ctx, 'https://b.example/list/1')).toBeNull()
    const blank = evalOf({ N: val('   ') })
    expect(await hitFieldsOf(rules, blank, ctx, 'https://b.example/list/1')).toBeNull()
  })

  it('坏规则只丢该字段：辅助五项各自炸，书目照收', async () => {
    const hit = await hitFieldsOf(
      rules,
      evalOf({ N: val('甲书'), A: val('作者'), U: val('/book/1'), I: new Error('坏简介规则'), L: new Error('坏章名规则'), K: new Error('坏分类规则'), W: new Error('坏字数规则') }),
      ctx, 'https://b.example/list/1',
    )
    expect(hit).not.toBeNull()
    expect(hit!.title).toBe('甲书')
    expect([hit!.intro, hit!.lastChapterName, hit!.kind, hit!.wordCount]).toEqual([null, null, null, null])
    expect(hit!.coverUrl).toBeNull()
  })

  it('作者与书地址是裸奔项：读不出来抛穿，归类由调用方决定（装配层不自立第二套吞错口径）', async () => {
    await expect(hitFieldsOf(rules, evalOf({ N: val('甲'), A: new Error('坏作者') }), ctx, 'https://b.example/'))
      .rejects.toThrow('坏作者')
  })

  it('书地址保留 `,{option}` 后缀，封面按落地地址绝对化（URL 即请求规格）', async () => {
    const hit = await hitFieldsOf(
      rules,
      evalOf({ N: val('甲'), U: val('/book/1,{"method":"POST"}'), C: val('/cover.jpg') }),
      ctx, 'https://b.example/search?q=x',
    )
    expect(hit!.url).toBe('https://b.example/book/1,{"method":"POST"}')
    expect(hit!.coverUrl).toBe('https://b.example/cover.jpg')
  })

  it('简介走搜索面口径：渲染指令前缀不保留；字数在解析层就格式化', async () => {
    const hit = await hitFieldsOf(
      rules,
      evalOf({ N: val('甲'), I: val('<md>正文简介</md>'), W: val('12345') }),
      ctx, 'https://b.example/',
    )
    expect(hit!.intro).toBe('正文简介')
    expect(hit!.wordCount).toBe('1.2万字')
  })

  it('每一槽传的面恒为 search（面不进 interface，只进错误定位）', async () => {
    const facets: string[] = []
    const rec: SubRuleEval = async (rule, _ctx, facet) => {
      facets.push(facet)
      return rule === 'N' ? val('甲') : { kind: 'miss', detail: rule }
    }
    const hit = await hitFieldsOf(rules, rec, ctx, 'https://b.example/')
    expect(hit).not.toBeNull()
    expect(facets).toEqual(Array.from({ length: facets.length }, () => 'search'))
    expect(facets).toHaveLength(8)
  })
})

/** 详情面一次读取（`detailReadOf`）：字段与 tocUrl 必须共用**同一次** init 求值。
 *  计数 subEval 包住真实求值器（`makeSubEval`），读的是规则串的出现次数——
 *  旧组合 `detailFieldsOf` + `tocUrlOf` 各求一次 init 正是这条要收掉的重复。 */
describe('detailReadOf（详情 init 单次求值）', () => {
  const INIT = '$.data.bookInfo'
  const BOOK = 'https://detail.example.com/book/42'
  const HTML = JSON.stringify({
    data: { bookInfo: { resourceID: '42', resourceName: '甲书', author: '乙', summary: '简介' } },
  })
  const normalized = normalizeSource({
    bookSourceName: '详情源', bookSourceUrl: 'https://detail.example.com',
    ruleContent: '$.text',
    ruleBookInfo: {
      init: INIT,
      name: '$.resourceName', author: '$.author', intro: '$.summary',
      tocUrl: 'https://detail.example.com/toc?bookId={{$.resourceID}}',
    },
  })
  const source: NovelSource = {
    ...normalized.source!, id: 'detail-src', status: 'unverified', importedAt: 0,
  }
  // 本用例只求规则、不发请求：真 Fetcher 的 fetchPage 一旦被调用就是规则形态写错了
  const fetcher: Fetcher = { fetchPage: async () => { throw new Error('规则求值不该发请求') } }
  const counting = (seen: string[], src: NovelSource = source): SubRuleEval => {
    const real = makeSubEval(fetcher, src)
    return (rule, ctx, facet, usage) => {
      seen.push(rule)
      return real(rule, ctx, facet, usage)
    }
  }
  /** tocUrl 两分支的源：同一份 init/字段，只换 ruleTocUrl（null = 源没声明目录规则） */
  const sourceWithToc = (id: string, ruleTocUrl: string | null): NovelSource => {
    const n = normalizeSource({
      bookSourceName: `详情源-${id}`, bookSourceUrl: 'https://detail.example.com',
      ruleContent: '$.text',
      ruleBookInfo: {
        init: INIT,
        name: '$.resourceName', author: '$.author',
        ...(ruleTocUrl === null ? {} : { tocUrl: ruleTocUrl }),
      },
    })
    return { ...n.source!, id, status: 'unverified', importedAt: 0 }
  }

  it('init 只求值一次，fields/tocUrl 与旧组合（detailFieldsOf + tocUrlOf）逐值一致', async () => {
    const seen: string[] = []
    const read = await detailReadOf(source, counting(seen), HTML, BOOK)
    expect(seen.filter((r) => r === INIT)).toHaveLength(1)

    // 旧组合的读数作对照：同一份源、同一份 html，两条路径给出的值必须一致
    const oldSeen: string[] = []
    const oldEval = counting(oldSeen)
    const oldFields = await detailFieldsOf(source, oldEval, HTML, stripUrlOption(BOOK))
    const oldToc = await tocUrlOf(source.rules.ruleTocUrl, INIT, BOOK, async () => HTML, oldEval)
    expect(read.fields).toEqual(oldFields)
    expect(read.tocUrl).toBe(oldToc)

    expect(read.fields).toMatchObject({ title: '甲书', author: '乙', intro: '简介' })
    expect(read.tocUrl).toBe('https://detail.example.com/toc?bookId=42')
  })

  it('detailFieldsOf（info/探针路径）仍不付 tocUrl 求值——tocUrl 规则不进它的求值器', async () => {
    const seen: string[] = []
    const fields = await detailFieldsOf(source, counting(seen), HTML, stripUrlOption(BOOK))
    expect(fields.title).toBe('甲书')
    expect(seen).not.toContain(source.rules.ruleTocUrl)
  })

  it('静态 ruleTocUrl 短路：tocUrl 规则一次都不进求值器，返回按 bookUrl 绝对化的静态地址', async () => {
    const staticSource = sourceWithToc('static-src', '/toc/static.html')
    const seen: string[] = []
    const read = await detailReadOf(staticSource, counting(seen, staticSource), HTML, BOOK)
    expect(seen).toContain(INIT)                                // 字段仍走那次 init
    expect(seen).not.toContain(staticSource.rules.ruleTocUrl)   // 短路：tocUrl 规则不进引擎
    expect(read.tocUrl).toBe('https://detail.example.com/toc/static.html')
  })

  it('无插值段但带 ,{option} 的 tocUrl 走字面求值：选项后缀原样保留（短路判据不吃选项串）', async () => {
    const rule = 'https://detail.example.com/toc,{"method":"POST"}'
    const optSource = sourceWithToc('opt-src', rule)
    const seen: string[] = []
    const read = await detailReadOf(optSource, counting(seen, optSource), HTML, BOOK)
    // `{` 让它不满足静态短路，按字面模板求值；绝对化只作用 URL 部分，后缀接回
    expect(seen).toContain(rule)
    expect(read.tocUrl).toBe(rule)
  })

  it('ruleTocUrl 为 null → 返回 bookUrl 全串（含 ,{option} 后缀：抓取仍按选项发请求）', async () => {
    const nullSource = sourceWithToc('null-src', null)
    const seen: string[] = []
    const book = `${BOOK},{"webView":true}`
    const read = await detailReadOf(nullSource, counting(seen, nullSource), HTML, book)
    expect(read.tocUrl).toBe(book)
  })
})
