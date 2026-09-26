import { describe, expect, it } from 'vitest'
import { evaluate } from '../../src/engine/index.js'
import type { SubRuleEval } from '../../src/services/bridge.js'
import {
  extractItems, absUrl, engineFetch, firstValue, formatWordCount, kindFieldOf, listValue, wordCountFieldOf,
} from '../../src/services/bridge.js'

describe('值规约', () => {
  it('miss → null（源没这条信息）', () => {
    expect(firstValue({ kind: 'miss', detail: 'x' })).toBeNull()
    expect(listValue({ kind: 'miss', detail: 'x' })).toBeNull()
  })
  it('value/list/matches 规约', () => {
    expect(firstValue({ kind: 'value', text: 'a' })).toBe('a')
    expect(firstValue({ kind: 'list', items: ['a', 'b'] })).toBe('a\nb')
    expect(firstValue({ kind: 'matches', rows: [['t1', 'x'], ['t2']] })).toBe('t1\nt2')
    expect(listValue({ kind: 'value', text: 'a' })).toEqual(['a'])
    expect(listValue({ kind: 'matches', rows: [['t1'], ['t2']] })).toEqual(['t1', 't2'])
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
    // `kind: "0"` / `kind: "k"` 是真库形态（现量见 docs/design/legado-compat.md 的需求量表）：
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
