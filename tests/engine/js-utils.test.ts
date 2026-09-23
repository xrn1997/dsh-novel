import { describe, expect, it } from 'vitest'
import { load } from 'cheerio'
import {
  absolutizeUrl,
  base64Decode,
  base64Encode,
  engineValueToString,
  engineValueToStrings,
  fmtTime,
  hexDecodeToString,
  md5Hex,
  md5Hex16,
  unescapeHtml4,
  uriEncode,
} from '../../src/engine/js-utils.js'

/** 纯工具直测（「纯工具出走」）：
 *  此前这些函数埋在 js-sandbox 模块私有，只能整体过 vm；现可不进沙箱直接钉行为。 */
describe('js-utils 纯工具', () => {
  it('md5Hex：标准向量（md5("abc")）', () => {
    expect(md5Hex('abc')).toBe('900150983cd24fb0d6963f7d28e17f72')
    expect(md5Hex('')).toBe('d41d8cd98f00b204e9800998ecf8427e')
  })

  it('md5Hex16：32 位 md5 取中 16 位（legado 语义）', () => {
    expect(md5Hex16('abc')).toBe('3cd24fb0d6963f7d')
    expect(md5Hex16('abc')).toBe(md5Hex('abc').slice(8, 24))
  })

  it('base64Encode/base64Decode 往返（含中文）', () => {
    expect(base64Encode('abc')).toBe('YWJj')
    expect(base64Decode('YWJj')).toBe('abc')
    expect(base64Decode(base64Encode('你好,世界'))).toBe('你好,世界')
    expect(base64Encode('')).toBe('')
  })

  it('uriEncode：encodeURIComponent 语义（中文/空格/斜杠全转义）', () => {
    expect(uriEncode('书')).toBe('%E4%B9%A6')
    expect(uriEncode('a b/c')).toBe('a%20b%2Fc')
  })

  it('hexDecodeToString：合法 hex → UTF-8；空/奇数长/非 hex → 空串（宁空不猜）', () => {
    expect(hexDecodeToString('e4bda0')).toBe('你')
    expect(hexDecodeToString('  E4BDA0  ')).toBe('你') // trim + 大小写不敏感
    expect(hexDecodeToString('')).toBe('')
    expect(hexDecodeToString('abc')).toBe('') // 奇数长
    expect(hexDecodeToString('zz')).toBe('') // 非 hex 字符
    expect(hexDecodeToString('0x12')).toBe('') // 前缀形态不支持 → 空串（与旧实现一致）
  })

  it('fmtTime：utc=true 钉死 UTC 分量', () => {
    expect(fmtTime(0, true)).toBe('1970/01/01 00:00')
    expect(fmtTime(1700000000000, true)).toBe('2023/11/14 22:13')
    expect(fmtTime('1700000000000', true)).toBe('2023/11/14 22:13') // 字符串时间戳同样接受
  })

  it('fmtTime：utc=false 取本地分量（与环境时区一致）', () => {
    const ts = 1700000000000
    const d = new Date(ts)
    const p2 = (n: number) => String(n).padStart(2, '0')
    const expected = `${d.getFullYear()}/${p2(d.getMonth() + 1)}/${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`
    expect(fmtTime(ts, false)).toBe(expected)
  })

  it('fmtTime：非法输入 → 空串', () => {
    expect(fmtTime('not-a-ts', false)).toBe('')
    expect(fmtTime(Number.NaN, true)).toBe('')
  })

  it('engineValueToString：五种 EngineValue 口径', () => {
    expect(engineValueToString({ kind: 'value', text: 'hi' })).toBe('hi')
    expect(engineValueToString({ kind: 'list', items: ['a', 'b'] })).toBe('a\nb')
    expect(engineValueToString({ kind: 'matches', rows: [['a', 'b'], ['c']] })).toBe('a\tb\nc')
    const $ = load('<h1>标题</h1>')
    // nodes 口径 = cheerio .html()（**内部** HTML，不含外层标签——与既有引擎行为一致）
    expect(engineValueToString({ kind: 'nodes', nodes: $('h1') })).toBe('标题')
    // 'outer' = @js host.result 口径（outerHTML）；同一实现在此显式分叉，不再两份抄本
    expect(engineValueToString({ kind: 'nodes', nodes: $('h1') }, 'outer')).toBe('<h1>标题</h1>')
    expect(engineValueToString({ kind: 'miss', detail: 'x' })).toBe('')
  })

  it('engineValueToStrings：五种 EngineValue 口径（value 按换行切分并滤空行）', () => {
    expect(engineValueToStrings({ kind: 'value', text: 'a\nb\n\nc' })).toEqual(['a', 'b', 'c'])
    expect(engineValueToStrings({ kind: 'list', items: ['a', 'b'] })).toEqual(['a', 'b'])
    expect(engineValueToStrings({ kind: 'matches', rows: [['a', 'b'], ['c']] })).toEqual(['a\tb', 'c'])
    const $ = load('<h1>标题</h1>')
    expect(engineValueToStrings({ kind: 'nodes', nodes: $('h1') })).toEqual(['标题']) // 内部 HTML
    const $empty = load('<div></div>')
    expect(engineValueToStrings({ kind: 'nodes', nodes: $empty('h1') })).toEqual([]) // 空选择集 → []
    expect(engineValueToStrings({ kind: 'miss', detail: 'x' })).toEqual([])
  })
})

describe('toNumChapter（legado JsExtensions.toNumChapter / StringUtils.chineseNumToInt 口径）', () => {
  it('第X章 的中文数字转阿拉伯数字；无匹配原样返回', async () => {
    const { toNumChapter } = await import('../../src/engine/js-utils.js')
    expect(toNumChapter('第一千零二十五章 离别')).toBe('第1025章') // 对面只回「第+数字+章」，标题尾部丢弃（源里它当 replace 的替换串用）
    expect(toNumChapter('第十二章 蜕变')).toBe('第12章')
    expect(toNumChapter('第两千章')).toBe('第2000章')
    expect(toNumChapter('第12章 已是数字')).toBe('第12章')
    expect(toNumChapter('没有章节号')).toBe('没有章节号')
  })
  it('中文数字的「补一位」边界：一千一 = 1100，一千二百 = 1200（照抄对面的算法，不是四则运算）', async () => {
    const { chineseNumToInt } = await import('../../src/engine/js-utils.js')
    expect(chineseNumToInt('一千一')).toBe(1100)
    expect(chineseNumToInt('一千二百')).toBe(1200)
    expect(chineseNumToInt('十二万三千四百五十六')).toBe(123456)
    expect(chineseNumToInt('认不出的字')).toBe(-1)
  })
  it('沙箱可见：java.toNumChapter（真实源用它规整正文/目录标题）', async () => {
    const { runScript, createSourceSession } = await import('../../src/engine/js-sandbox.js')
    const r = await runScript({
      code: 'java.toNumChapter("第五百章 起点")', loc: { segmentIndex: 0, segmentRaw: '@js' },
      facet: 'content', source: 'https://x.com', session: createSourceSession(),
    })
    expect(r.value).toEqual({ kind: 'value', text: '第500章' })
  })
})

describe('unescapeHtml4 / absolutizeUrl（getString 重载落地面）', () => {
  // 对面 unescape：`StringEscapeUtils.unescapeHtml4`（commons-text 全表）。本仓是**近似承接**：
  // 数字引用 + HTML4 常用命名集，**认不出的一律原样留**（不猜、也不解错）——差集是
  // 「对面能解、我们留原文」，与 engine/dom 的实体口径同一条纪律，登记在矩阵 g-unescape-html4。
  it('数字引用与命名集都解；二次转义串（JSON API 源常见）解一层', () => {
    expect(unescapeHtml4('&#65;|&#x41;|&amp;|&lt;|&nbsp;')).toBe('A|A|&|<| ')
    expect(unescapeHtml4('&amp;lt;')).toBe('&lt;')
  })
  it('认不出的实体与裸 & 原样留；无 & 直接返回同串（对面的短路条件）', () => {
    expect(unescapeHtml4('&notanentity;')).toBe('&notanentity;')
    expect(unescapeHtml4('Tom & Jerry')).toBe('Tom & Jerry')
    expect(unescapeHtml4('普通文本')).toBe('普通文本')
  })
  it('码点越界/落在代理区 → 原样留（不产出乱码字符冒充成功）', () => {
    expect(unescapeHtml4('&#xD800;')).toBe('&#xD800;')
    expect(unescapeHtml4('&#x110000;')).toBe('&#x110000;')
  })
  it('absolutizeUrl 五条约口径（对面 NetworkUtils.getAbsoluteURL）', () => {
    const base = 'https://b.test/read/index.html'
    expect(absolutizeUrl(base, '/b/1')).toBe('https://b.test/b/1')
    expect(absolutizeUrl(base, 'https://other.test/x')).toBe('https://other.test/x')
    expect(absolutizeUrl(base, 'data:text/plain,hi')).toBe('data:text/plain,hi')
    expect(absolutizeUrl(base, 'javascript:void(0)')).toBe('')       // 对面这里返回 ""，不是原样
    expect(absolutizeUrl('', ' /b/1 ')).toBe('/b/1')                  // base 空 → trim 原样，不猜站点
    expect(absolutizeUrl(base, '')).toBe(base)                        // URL(base,"") = base（对面同形）
    // base 带 `,{option}` 请求选项后缀时先剥（URL 即请求规格那条通用教训）
    expect(absolutizeUrl('https://b.test/api,{"method":"POST"}', '/b/1')).toBe('https://b.test/b/1')
  })
})
