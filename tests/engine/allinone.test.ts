import { describe, expect, it } from 'vitest'
import { evalAllInOne } from '../../src/engine/allinone.js'
import { engineValueToString, engineValueToStrings } from '../../src/engine/js-utils.js'
import { RuleEvalError } from '../../src/engine/errors.js'

const L = { segmentIndex: 0, segmentRaw: ':pattern' }

const tocHtml = `<a href="/read/30394_20940996.html">第一章 初入江湖</a>
<a href="/read/30394_20940997.html">第二章 风云再起</a>`

describe('AllInOne 整页正则（二维产物不压平）', () => {
  it('二维捕获：条目×(group 0 + 组 1..n)，不压平', () => {
    const v = evalAllInOne({ kind: 'allinone', pattern: 'href="(/read[^"]*html)">([^<]*)', flags: '' },
      tocHtml, L, 'toc')
    expect(v).toEqual({ kind: 'matches', rows: [
      ['href="/read/30394_20940996.html">第一章 初入江湖', '/read/30394_20940996.html', '第一章 初入江湖'],
      ['href="/read/30394_20940997.html">第二章 风云再起', '/read/30394_20940997.html', '第二章 风云再起'],
    ] })
  })

  it('未参与的捕获组落空串（不是 undefined）——`$n` 绑定要拿到可拼接的串', () => {
    // 可选组 `(isvip)?` 第二行不参与：JS 给 undefined，Kotlin groupValues 给 ""
    const v = evalAllInOne({ kind: 'allinone', pattern: '(\\d+)" class="(isvip)?[^"]*name[^>]*>([^<]*)', flags: '' },
      '7" class="isvip name">第一章< 8" class=" name">第二章<', L, 'toc')
    expect((v as any).rows).toEqual([
      ['7" class="isvip name">第一章', '7', 'isvip', '第一章'],
      ['8" class=" name">第二章', '8', '', '第二章'],
    ])
  })

  it('零匹配 → 空 list（不是 miss）', () => {
    const v = evalAllInOne({ kind: 'allinone', pattern: 'href="(/zzz[^"]*)">([^<]*)', flags: '' }, tocHtml, L, 'toc')
    expect(v).toEqual({ kind: 'list', items: [] })
  })

  // 正则必须用 \d+_\d+ 才拿到完整 id：\d{4}_\d+ 只匹配到 '0394_20940996'（前半截断）
  // 本用例保留原意（无捕获组 → 单元素行 [full]）
  it('无捕获组 → 单元素行', () => {
    const v = evalAllInOne({ kind: 'allinone', pattern: '\\d+_\\d+', flags: '' }, tocHtml, L, 'toc')
    expect((v as any).rows).toEqual([['30394_20940996'], ['30394_20940997']])
  })

  it('AllInOne 值走 js 宿主面：整段（group 0）排在每行最前——第三读侧的现状钉子', () => {
    // 行含 group 0 之后，沙箱的串化读侧会把整段一起序列化；服务面的条目取值走 rowParts 剥掉
    // （`tests/services/toc-allinone.test.ts` 钉着那一半）。两侧不同形是有意的：整段只供字段规则
    // 的 `$n` 绑定。**但这条不声称对面也这么给**——js 面该不该剥没有对面证据，改它之前先做
    // `getAll` 返回值形状的对读（口径与病史住矩阵行 a-allinone-group-zero）。
    const v = evalAllInOne({ kind: 'allinone', pattern: 'href="(/read[^"]*html)">([^<]*)', flags: '' }, tocHtml, L, 'toc')
    expect(engineValueToString(v)).toBe([
      'href="/read/30394_20940996.html">第一章 初入江湖\t/read/30394_20940996.html\t第一章 初入江湖',
      'href="/read/30394_20940997.html">第二章 风云再起\t/read/30394_20940997.html\t第二章 风云再起',
    ].join('\n'))
    const lines = engineValueToStrings(v)
    expect(lines).toHaveLength(2)
    expect(lines[0].startsWith('href="'), '整段没排在最前——读侧形状变了，先回矩阵行改口径再动代码').toBe(true)
  })

  it('零长度匹配强制前进，不死循环', () => {
    const v = evalAllInOne({ kind: 'allinone', pattern: 'x*', flags: '' }, 'axb', L, 'content')
    expect((v as any).rows).toEqual([[''], ['x'], [''], ['']])
  })

  it('非法正则 → RuleEvalError（hits=0，段级定位，消息含坏 pattern）', () => {
    expect(() => evalAllInOne({ kind: 'allinone', pattern: '(', flags: '' }, tocHtml, L, 'toc')).toThrow(RuleEvalError)
    try {
      evalAllInOne({ kind: 'allinone', pattern: '(', flags: '' }, tocHtml, L, 'toc')
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(RuleEvalError)
      expect((e as RuleEvalError).hits).toBe(0)
      expect((e as Error).message).toContain('(')
    }
  })
})
