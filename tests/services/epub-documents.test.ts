/**
 * 文档层测试：XHTML → 白名单图文树，以及文档内的锚点/链接映射。
 *
 * 这一层的判据都在**值**上：元素按 wire 白名单映射、只按种类保留明确字段（不传播 raw attributes）、
 * 原书 id 只进锚点映射不回填节点、活动内容剥除后必须有告警。本用例不碰文件系统、不认识 EPUB 包，
 * 输入是直接解析出来的 XHTML 树——把「规范化规则」与「归档/包结构」分开测。
 */
import type { Element } from 'domhandler'
import { describe, expect, it } from 'vitest'
import type { ContentNode, ReadingTarget } from '../../src/shared/wire.js'
import {
  convertXhtml, documentTitle, scanXhtml,
  type ConvertedXhtml, type XhtmlConvertOptions,
} from '../../src/services/epub/documents.js'
import { EpubWarningLog } from '../../src/services/epub/warnings.js'
import { EpubImportError } from '../../src/services/epub/errors.js'
import { parseXml, xmlBudget } from '../../src/services/epub/xml.js'

const LIMITS = { depth: 128, nodes: 200_000 }

/** 造一份 XHTML 树（与生产同一条解析路径：XML 只读门 + 单文档预算） */
function xhtml(body: string, head = ''): Element {
  const text = '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>文档标题</title>' + head + '</head><body>' + body + '</body></html>'
  return parseXml(text, xmlBudget('OEBPS/ch1.xhtml', LIMITS))
}

/** 顺序 ID（生产里由导入编排铸造；这里只为断言「ID 是 opaque 串」而固定下来） */
function seq(prefix: string): () => string {
  let i = 0
  return () => `${prefix}${i++}`
}

/** 转换一份文档：默认「没有链接、图片给固定资源」，按需覆盖 */
function convert(body: string, opts: Partial<XhtmlConvertOptions> = {}): ConvertedXhtml & { warnings: ReturnType<EpubWarningLog['list']> } {
  const root = xhtml(body)
  const anchors = scanXhtml(root, xmlBudget('OEBPS/ch1.xhtml', LIMITS), seq('a')).anchors
  const warnings = new EpubWarningLog()
  return {
    ...convertXhtml(root, {
      budget: xmlBudget('OEBPS/ch1.xhtml', LIMITS),
      anchors,
      resolveLink: () => null,
      resolveImage: () => ({ resourceId: 'r0', width: 4, height: 5 }),
      nextNodeId: seq('n'),
      warnings,
      ...opts,
    }),
    warnings: warnings.list(),
  }
}

function convertRejection(body: string): Error {
  try {
    convert(body)
  } catch (e) {
    return e as Error
  }
  throw new Error(`预期拒绝，实际成功——认不出的正文不按半途结果读（正文：${body}）`)
}

/** 只留结构（去掉 id/alt 这类每次都变的字段），便于整树断言 */
function shape(nodes: readonly ContentNode[]): unknown[] {
  return nodes.map((n) => {
    switch (n.kind) {
      case 'text': return n.text
      case 'break': return 'br'
      case 'rule': return 'hr'
      case 'image': return `img:${n.resourceId}:${n.alt}:${n.width}x${n.height}`
      case 'link': return { link: n.role, target: n.target, children: shape(n.children) }
      case 'element': return {
        tag: n.tag, start: n.start, value: n.value, rowSpan: n.rowSpan, colSpan: n.colSpan, children: shape(n.children),
      }
    }
  })
}

describe('元素白名单映射', () => {
  it('b/i 规范成 strong/em，结构容器规范成 div，未知无害容器保留子内容', () => {
    const { nodes } = convert('<p><b>粗</b><i>斜</i><strong>粗二</strong><em>斜二</em></p>'
      + '<section>段<figure>图</figure></section><div>未知吗？<u>下划线</u></div>')
    expect(shape(nodes)).toEqual([
      { tag: 'p', start: null, value: null, rowSpan: null, colSpan: null, children: [
        { tag: 'strong', start: null, value: null, rowSpan: null, colSpan: null, children: ['粗'] },
        { tag: 'em', start: null, value: null, rowSpan: null, colSpan: null, children: ['斜'] },
        { tag: 'strong', start: null, value: null, rowSpan: null, colSpan: null, children: ['粗二'] },
        { tag: 'em', start: null, value: null, rowSpan: null, colSpan: null, children: ['斜二'] },
      ] },
      // section / figure 是结构容器（规范成 div）；u 不是白名单元素，子内容直接上提
      { tag: 'div', start: null, value: null, rowSpan: null, colSpan: null, children: [
        '段', { tag: 'div', start: null, value: null, rowSpan: null, colSpan: null, children: ['图'] },
      ] },
      { tag: 'div', start: null, value: null, rowSpan: null, colSpan: null, children: ['未知吗？', '下划线'] },
    ])
  })

  it('s/strike 按未知元素处理：保留子内容，不别名成 em（删除线不是强调）', () => {
    const { nodes } = convert('<p>前<s>删</s>中<strike>删二</strike>后</p>')
    expect(shape(nodes)).toEqual([
      { tag: 'p', start: null, value: null, rowSpan: null, colSpan: null, children: ['前', '删', '中', '删二', '后'] },
    ])
    expect(JSON.stringify(nodes)).not.toMatch(/"em"/)
  })

  it('块级白名单全覆盖：标题、引用、行内、上下标、代码块', () => {
    const { nodes } = convert('<h1>一</h1><h6>六</h6><blockquote><p>引</p></blockquote>'
      + '<p><span>跨</span><code>码</code>x<sup>2</sup>H<sub>2</sub>O<pre>  原样\n  换行</pre></p>')
    expect(shape(nodes)).toEqual([
      { tag: 'h1', start: null, value: null, rowSpan: null, colSpan: null, children: ['一'] },
      { tag: 'h6', start: null, value: null, rowSpan: null, colSpan: null, children: ['六'] },
      { tag: 'blockquote', start: null, value: null, rowSpan: null, colSpan: null, children: [
        { tag: 'p', start: null, value: null, rowSpan: null, colSpan: null, children: ['引'] },
      ] },
      { tag: 'p', start: null, value: null, rowSpan: null, colSpan: null, children: [
        { tag: 'span', start: null, value: null, rowSpan: null, colSpan: null, children: ['跨'] },
        { tag: 'code', start: null, value: null, rowSpan: null, colSpan: null, children: ['码'] },
        'x',
        { tag: 'sup', start: null, value: null, rowSpan: null, colSpan: null, children: ['2'] },
        'H',
        { tag: 'sub', start: null, value: null, rowSpan: null, colSpan: null, children: ['2'] },
        'O',
        // pre 里的换行与缩进是渲染事实，逐字保留（文字面的行规约会绕过 pre）
        { tag: 'pre', start: null, value: null, rowSpan: null, colSpan: null, children: ['  原样\n  换行'] },
      ] },
    ])
  })

  it('br 是换行、hr 是分隔线（各自独立节点种类，不折进元素）', () => {
    const { nodes } = convert('<p>上<br/>下</p><hr/><p>后</p>')
    expect(shape(nodes)).toEqual([
      { tag: 'p', start: null, value: null, rowSpan: null, colSpan: null, children: ['上', 'br', '下'] },
      'hr',
      { tag: 'p', start: null, value: null, rowSpan: null, colSpan: null, children: ['后'] },
    ])
  })

  it('列表编号：start 只落 ol、value 只落 li，其余位置恒为 null', () => {
    const { nodes } = convert('<ol start="3"><li value="7">七</li><li>八</li></ol><ul><li>点</li></ul>')
    expect(shape(nodes)).toEqual([
      { tag: 'ol', start: 3, value: null, rowSpan: null, colSpan: null, children: [
        { tag: 'li', start: null, value: 7, rowSpan: null, colSpan: null, children: ['七'] },
        { tag: 'li', start: null, value: null, rowSpan: null, colSpan: null, children: ['八'] },
      ] },
      { tag: 'ul', start: null, value: null, rowSpan: null, colSpan: null, children: [
        { tag: 'li', start: null, value: null, rowSpan: null, colSpan: null, children: ['点'] },
      ] },
    ])
  })

  it('数字属性只认合法整数：坏的按缺席处理，不被猜成别的值', () => {
    const { nodes } = convert('<ol start="abc"><li value="2.7">甲</li><li value="-3">乙</li></ol>')
    expect(shape(nodes)).toEqual([
      { tag: 'ol', start: null, value: null, rowSpan: null, colSpan: null, children: [
        { tag: 'li', start: null, value: null, rowSpan: null, colSpan: null, children: ['甲'] },
        // 负整数是合法整数（HTML 的 value 允许），照收
        { tag: 'li', start: null, value: -3, rowSpan: null, colSpan: null, children: ['乙'] },
      ] },
    ])
  })

  it('表格跨行跨列：rowSpan/colSpan 只落单元格，其余位置恒 null', () => {
    const { nodes } = convert('<table><caption>表</caption><thead><tr><th rowspan="2">竖</th></tr></thead>'
      + '<tbody><tr><td colspan="3">横</td><td colspan="0">坏值</td></tr></tbody></table>')
    const [table] = nodes
    expect(table.kind).toBe('element')
    const cells = shape(nodes)[0] as { tag: string; children: Array<{ tag: string; children: unknown[] }> }
    expect(cells.tag).toBe('table')
    expect(cells.children[0]).toEqual({ tag: 'caption', start: null, value: null, rowSpan: null, colSpan: null, children: ['表'] })
    const thead = cells.children[1] as { children: Array<{ children: Array<Record<string, unknown>> }> }
    expect(thead.children[0].children[0]).toMatchObject({ tag: 'th', rowSpan: 2, colSpan: null })
    const tbody = cells.children[2] as { children: Array<{ children: Array<Record<string, unknown>> }> }
    expect(tbody.children[0].children[0]).toMatchObject({ tag: 'td', colSpan: 3, rowSpan: null })
    // colspan="0" 不是合法列跨度（0 在 HTML 里是「到本节末尾」的古怪写法）：按缺席，不猜
    expect(tbody.children[0].children[1]).toMatchObject({ tag: 'td', colSpan: null })
  })

  it('实体只解一次：`&amp;` → `&`，`&amp;amp;` → 字面 `&amp;`，数值引用按字符取', () => {
    const { nodes } = convert('<p>a &amp; b &amp;amp; c &#65; d &#x42;</p>')
    expect(shape(nodes)).toEqual([
      { tag: 'p', start: null, value: null, rowSpan: null, colSpan: null, children: ['a & b &amp; c A d B'] },
    ])
  })

  it('CDATA 是字面文本（不当实体解），注释与指令不上树', () => {
    const { nodes } = convert('<p><![CDATA[字面 &amp; 与 <b>标签</b>]]><!-- 注释 --></p>')
    expect(shape(nodes)).toEqual([
      { tag: 'p', start: null, value: null, rowSpan: null, colSpan: null, children: ['字面 &amp; 与 <b>标签</b>'] },
    ])
  })

  it('注释里的实体字样不是引用：合法注释不许把整本书拒掉', () => {
    // 实测缺陷：静态闸门排除了 CDATA 却没排除注释，`<!-- 删掉的段落 &nbsp; -->` 被当成
    // 「引用了未声明的实体」——而 XML 规范允许注释里出现任何文本。注释本来就该整条摘掉再判。
    const { nodes } = convert('<p>正文</p><!-- 删掉的段落 &nbsp; 与 <!DOCTYPE 字样 -->')
    expect(shape(nodes)).toEqual([
      { tag: 'p', start: null, value: null, rowSpan: null, colSpan: null, children: ['正文'] },
    ])
    // 真引用（不在注释里）该拒还是拒：闸门没被顺手关掉
    expect(() => convert('<p>正文 &nbsp;</p>')).toThrow(/实体/)
  })

  it('多根元素：畸形 XML 不按半途结果读（只取第一个会静默丢掉后面的内容）', () => {
    // 实测缺陷：两份 <html> 拼接的文件被接受，且只有前半留下——「静默丢内容」比报错坏得多
    const two = '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>前</title></head><body><p>前半</p></body></html>'
      + '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>后</title></head><body><p>后半</p></body></html>'
    expect(() => parseXml(two, xmlBudget('OEBPS/ch1.xhtml', LIMITS))).toThrow(EpubImportError)
    expect(() => parseXml(two, xmlBudget('OEBPS/ch1.xhtml', LIMITS))).toThrow(/多个根元素/)
    // 注释与 PI 不算根：一份正常文档不该被这条误伤
    expect(convert('<p>正文</p>').nodes.length).toBe(1)
  })

  it('宽文档（未知容器上提出十几万节点）逐项追加：不撞函数参数上限', () => {
    // `<dl>` 不在白名单里 → 子内容上提。实测一棵七万项的 dl（140k 节点，**在**节点预算内）
    // 会让 `push(...nodes)` 抛裸 RangeError——那是宿主异常，服务层按类分流时会把它漏成 500。
    const pairs = 70_000
    const { nodes } = convert('<dl>' + '<dt>a</dt><dd>b</dd>'.repeat(pairs) + '</dl>')
    expect(nodes).toHaveLength(pairs * 2)
  })

  it('节点只带明确字段：raw attributes 一律不传播（class/title/data-*/style 都不上树）', () => {
    const { nodes } = convert('<p class="x" title="提示" data-role="note" dir="rtl" style="color:red">文字</p>')
    const [p] = nodes
    expect(p.kind).toBe('element')
    expect(Object.keys(p).sort()).toEqual(['children', 'colSpan', 'id', 'kind', 'rowSpan', 'start', 'tag', 'value'])
    expect(shape(nodes)).toEqual([
      { tag: 'p', start: null, value: null, rowSpan: null, colSpan: null, children: ['文字'] },
    ])
  })

  it('标题取 head 的 title（无目录时章名的兜底来源）；空白 title 按「没有标题」处理', () => {
    expect(convert('<p>x</p>').title).toBe('文档标题')
    const blank = parseXml('<html><head><title>  </title></head><body><p>x</p></body></html>', xmlBudget('OEBPS/x.xhtml', LIMITS))
    expect(documentTitle(blank, xmlBudget('OEBPS/x.xhtml', LIMITS))).toBeNull()
    const noTitle = parseXml('<html><body><p>x</p></body></html>', xmlBudget('OEBPS/x.xhtml', LIMITS))
    const empty = convertXhtml(noTitle, {
      budget: xmlBudget('OEBPS/x.xhtml', LIMITS), anchors: new Map(),
      resolveLink: () => null, resolveImage: () => ({ resourceId: 'r0', width: 1, height: 1 }),
      nextNodeId: seq('n'), warnings: new EpubWarningLog(),
    })
    expect(empty.title).toBeNull()
    // documentTitle 单独可用（第一遍要拿它当章名，不必等转换）
    expect(documentTitle(noTitle, xmlBudget('OEBPS/x.xhtml', LIMITS))).toBeNull()
  })
})

describe('锚点：原书 id 只进映射，节点 ID 一律 opaque', () => {
  it('带 id 的元素拿到映射里的锚点 ID；节点里绝不出现原书 id 字面', () => {
    const root = xhtml('<p id="a">甲</p><p id="b">乙</p>')
    const budget = xmlBudget('OEBPS/ch1.xhtml', LIMITS)
    const { anchors } = scanXhtml(root, budget, seq('a'))
    expect([...anchors.keys()]).toEqual(['a', 'b'])
    expect([...anchors.values()]).toEqual(['a0', 'a1'])
    const { nodes } = convertXhtml(root, {
      budget, anchors, resolveLink: () => null,
      resolveImage: () => ({ resourceId: 'r0', width: 1, height: 1 }),
      nextNodeId: seq('n'), warnings: new EpubWarningLog(),
    })
    expect(nodes.map((n) => (n.kind === 'element' ? n.id : '?'))).toEqual(['a0', 'a1'])
    // 不铸锚点的节点用另一个序列（n*），与锚点 ID 分列：两种 ID 的含义不同，不混用
    expect(nodes.every((n) => !JSON.stringify(n).includes('"a"'))).toBe(true)
  })

  it('没有 href 的 a 只是锚点载体：保留成一个 span 包住子内容（脚注目标常这么写）', () => {
    const root = xhtml('<p><a id="fn1"></a>尾</p>')
    const budget = xmlBudget('OEBPS/ch1.xhtml', LIMITS)
    const { anchors } = scanXhtml(root, budget, seq('a'))
    const { nodes } = convertXhtml(root, {
      budget, anchors, resolveLink: () => null,
      resolveImage: () => ({ resourceId: 'r0', width: 1, height: 1 }),
      nextNodeId: seq('n'), warnings: new EpubWarningLog(),
    })
    expect(shape(nodes)).toEqual([
      { tag: 'p', start: null, value: null, rowSpan: null, colSpan: null, children: [
        { tag: 'span', start: null, value: null, rowSpan: null, colSpan: null, children: [] },
        '尾',
      ] },
    ])
    expect((nodes[0] as Extract<ContentNode, { kind: 'element' }>).children[0]).toMatchObject({ id: 'a0' })
  })

  it('未知容器只要带 id 也保留一个 span 载体（锚点不许丢）', () => {
    const root = xhtml('<p><u id="mark">重点</u></p>')
    const budget = xmlBudget('OEBPS/ch1.xhtml', LIMITS)
    const { anchors } = scanXhtml(root, budget, seq('a'))
    const { nodes } = convertXhtml(root, {
      budget, anchors, resolveLink: () => null,
      resolveImage: () => ({ resourceId: 'r0', width: 1, height: 1 }),
      nextNodeId: seq('n'), warnings: new EpubWarningLog(),
    })
    expect(shape(nodes)).toEqual([
      { tag: 'p', start: null, value: null, rowSpan: null, colSpan: null, children: [
        { tag: 'span', start: null, value: null, rowSpan: null, colSpan: null, children: ['重点'] },
      ] },
    ])
  })

  it('同一份文档里重复 id：报错并点名（锚点目标有歧义不许猜）', () => {
    const root = xhtml('<p id="a">甲</p><p id="a">又一个甲</p>')
    expect(() => scanXhtml(root, xmlBudget('OEBPS/ch1.xhtml', LIMITS), seq('a'))).toThrow(EpubImportError)
    expect(() => scanXhtml(root, xmlBudget('OEBPS/ch1.xhtml', LIMITS), seq('a'))).toThrow(/重复/)
    expect(() => scanXhtml(root, xmlBudget('OEBPS/ch1.xhtml', LIMITS), seq('a'))).toThrow(/OEBPS\/ch1\.xhtml/)
  })

  it('被移除的活动内容里的 id 不进锚点表，但记入 strippedAnchors（那不是一个能落到的位置）', () => {
    const root = xhtml('<p id="a">甲</p><script id="s">1</script>'
      + '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect id="v" width="1" height="1"/></svg>')
    const { anchors, strippedAnchors } = scanXhtml(root, xmlBudget('OEBPS/ch1.xhtml', LIMITS), seq('a'))
    expect([...anchors.keys()]).toEqual(['a'])
    // 被剥离的锚点只留名字（不铸 ID、不占锚点序列）：那段内容不在树上，但「它存在过」是绑定期
    // 把目标降级而不是拒整本所依据的事实——两件事必须分得开
    expect([...strippedAnchors].sort()).toEqual(['s', 'v'])
    expect([...anchors.values()]).toEqual(['a0'])
  })

  it('被剥离的内容里自己撞名不是歧义（那段内容不在树上）：不拒', () => {
    const root = xhtml('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect id="q" width="1" height="1"/><rect id="q" width="1" height="1"/></svg><p id="a">甲</p>')
    const { anchors, strippedAnchors } = scanXhtml(root, xmlBudget('OEBPS/ch1.xhtml', LIMITS), seq('a'))
    expect([...anchors.keys()]).toEqual(['a'])
    expect([...strippedAnchors]).toEqual(['q'])
  })

  it('同一个名字在正文与内联 SVG 里各出现一次：树上那个赢（被剥离的那份不算重复锚点）', () => {
    const root = xhtml('<p id="x">甲</p><p><svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect id="x" width="1" height="1"/></svg></p>')
    const budget = xmlBudget('OEBPS/ch1.xhtml', LIMITS)
    const { anchors, strippedAnchors } = scanXhtml(root, budget, seq('a'))
    expect(anchors.get('x')).toBe('a0')
    expect([...strippedAnchors]).toEqual(['x'])
    const { nodes } = convertXhtml(root, {
      budget, anchors, resolveLink: () => null,
      resolveImage: () => ({ resourceId: 'r0', width: 1, height: 1 }),
      nextNodeId: seq('n'), warnings: new EpubWarningLog(),
    })
    // 树上只留一个承载锚点的节点：绑定期先查 anchors ⇒ 落到真锚点，既不降级也不报重复
    expect(nodes.map((n) => (n.kind === 'element' ? n.id : '?'))).toEqual(['a0', 'n0'])
  })

  it('EPUB2 旧式命名锚点 <a name>：与 id 走同一条铸造路径', () => {
    const root = xhtml('<p><a name="legacy"></a>甲</p><p><a name="both" id="both"></a>乙</p><p><a id="alpha" name="beta"></a>丙</p>')
    const budget = xmlBudget('OEBPS/ch1.xhtml', LIMITS)
    const { anchors } = scanXhtml(root, budget, seq('a'))
    expect([...anchors.keys()]).toEqual(['legacy', 'both', 'alpha', 'beta'])
    // 一个元素上的多个名字指向**同一个**节点 ID（各铸一个会让其中一个名字指不到树上）
    expect([...anchors.values()]).toEqual(['a0', 'a1', 'a2', 'a2'])
    const { nodes } = convertXhtml(root, {
      budget, anchors, resolveLink: () => null,
      resolveImage: () => ({ resourceId: 'r0', width: 1, height: 1 }),
      nextNodeId: seq('n'), warnings: new EpubWarningLog(),
    })
    // 命名锚点也要在树上留一个可落的位置（目录指到它时才有节点 ID 可绑）
    expect(nodes.map((n) => (n.kind === 'element' ? n.children[0] : null))).toEqual([
      expect.objectContaining({ kind: 'element', tag: 'span', id: 'a0' }),
      expect.objectContaining({ kind: 'element', tag: 'span', id: 'a1' }),
      expect.objectContaining({ kind: 'element', tag: 'span', id: 'a2' }),
    ])
  })

  it('name 与 id 撞名（不同元素）：按既有「重复锚点即拒」处理，不猜哪个才算', () => {
    const root = xhtml('<p id="x">甲</p><p><a name="x">乙</a></p>')
    expect(() => scanXhtml(root, xmlBudget('OEBPS/ch1.xhtml', LIMITS), seq('a'))).toThrow(EpubImportError)
    expect(() => scanXhtml(root, xmlBudget('OEBPS/ch1.xhtml', LIMITS), seq('a'))).toThrow(/重复/)
  })

  it('带 name 的 a 作为链接时同时承载锚点（href 与 name 同在一个元素上）', () => {
    const target: ReadingTarget = { kind: 'chapter', index: 1, anchorId: 'a9' }
    const root = xhtml('<p><a name="x" href="ch2.xhtml#c">去</a></p>')
    const budget = xmlBudget('OEBPS/ch1.xhtml', LIMITS)
    const { anchors } = scanXhtml(root, budget, seq('a'))
    const { nodes } = convertXhtml(root, {
      budget, anchors, resolveLink: () => target,
      resolveImage: () => ({ resourceId: 'r0', width: 1, height: 1 }),
      nextNodeId: seq('n'), warnings: new EpubWarningLog(),
    })
    const [p] = nodes
    expect(p.kind).toBe('element')
    expect((p as Extract<ContentNode, { kind: 'element' }>).children[0])
      .toMatchObject({ kind: 'link', id: anchors.get('x'), role: 'normal', target })
  })
})

describe('链接绑定', () => {
  const target: ReadingTarget = { kind: 'chapter', index: 0, anchorId: 'a0' }

  it('内部链接落成 link 节点，角色按 epub:type 判定', () => {
    const { nodes } = convert('<p><a href="ch2.xhtml#c">正</a><a href="notes.xhtml#n1" epub:type="noteref">注</a>'
      + '<a href="ch1.xhtml#a" epub:type="backlink">返</a></p>', { resolveLink: () => target })
    expect(shape(nodes)).toEqual([
      { tag: 'p', start: null, value: null, rowSpan: null, colSpan: null, children: [
        { link: 'normal', target, children: ['正'] },
        { link: 'noteref', target, children: ['注'] },
        { link: 'backlink', target, children: ['返'] },
      ] },
    ])
  })

  it('保留文字、取消可点击性：绑定不了的目标落成纯子内容（由调用方记告警）', () => {
    const { nodes } = convert('<p>前<a href="https://example.invalid/x">外站</a>后</p>')
    expect(shape(nodes)).toEqual([
      { tag: 'p', start: null, value: null, rowSpan: null, colSpan: null, children: ['前', '外站', '后'] },
    ])
  })

  it('带 id 的外站链接：文字保留、不生成 link，但锚点仍要在树上（有人在指它）', () => {
    const root = xhtml('<p><a id="k" href="https://example.invalid/x">外站</a></p>')
    const budget = xmlBudget('OEBPS/ch1.xhtml', LIMITS)
    const { anchors } = scanXhtml(root, budget, seq('a'))
    const { nodes } = convertXhtml(root, {
      budget, anchors, resolveLink: () => null,
      resolveImage: () => ({ resourceId: 'r0', width: 1, height: 1 }),
      nextNodeId: seq('n'), warnings: new EpubWarningLog(),
    })
    const p = nodes[0] as Extract<ContentNode, { kind: 'element' }>
    expect(p.children).toHaveLength(1)
    expect(p.children[0]).toMatchObject({ kind: 'element', tag: 'span', id: 'a0' })
  })
})

describe('图片节点', () => {
  it('图片绑定资源 ID 与显示宽高；alt 缺席是空串（不是丢掉这个字段）', () => {
    const { nodes } = convert('<p><img src="pics/a.png" alt="说明"/><img src="pics/b.png"/></p>')
    expect(shape(nodes)).toEqual([
      { tag: 'p', start: null, value: null, rowSpan: null, colSpan: null, children: ['img:r0:说明:4x5', 'img:r0::4x5'] },
    ])
  })

  it('图片没有 src：报错并点名文档（图片位置无法确定，不静默丢）', () => {
    expect(convertRejection('<p><img alt="无名"/></p>')).toBeInstanceOf(EpubImportError)
    expect(() => convert('<p><img alt="无名"/></p>')).toThrow(/src/)
    expect(() => convert('<p><img alt="无名"/></p>')).toThrow(/OEBPS\/ch1\.xhtml/)
  })

  it('纯插图文档：正文只有图片也是有效内容', () => {
    const { nodes } = convert('<img src="pics/full.png" alt="整页"/>')
    expect(shape(nodes)).toEqual(['img:r0:整页:4x5'])
  })
})

describe('活动内容与可见图形的处置', () => {
  it('script/iframe/object/form/style 剥除并记告警，正文文字一个不丢', () => {
    const { nodes, warnings } = convert('<p>前</p><script>alert(1)</script><iframe src="x"></iframe>'
      + '<object data="x"></object><form><input/></form><style>p{}</style><p>后</p>')
    expect(shape(nodes)).toEqual([
      { tag: 'p', start: null, value: null, rowSpan: null, colSpan: null, children: ['前'] },
      { tag: 'p', start: null, value: null, rowSpan: null, colSpan: null, children: ['后'] },
    ])
    expect(warnings.map((w) => w.code)).toEqual(['epub-removed-active-content'])
    // 告警点名文档，并说清移除了什么（读者要能判断自己丢了什么）
    expect(warnings[0].resource).toBe('OEBPS/ch1.xhtml')
    expect(warnings[0].message).toMatch(/script/)
    expect(warnings[0].message).toMatch(/iframe/)
  })

  it('事件属性与 style 属性剥除；同类多处合并成一条计数告警（不刷屏）', () => {
    const { nodes, warnings } = convert('<p onclick="a()">甲</p><p onmouseover="b()" style="color:red">乙</p>')
    expect(shape(nodes)).toEqual([
      { tag: 'p', start: null, value: null, rowSpan: null, colSpan: null, children: ['甲'] },
      { tag: 'p', start: null, value: null, rowSpan: null, colSpan: null, children: ['乙'] },
    ])
    expect(warnings.map((w) => w.code).sort()).toEqual(['epub-active-attribute', 'epub-css-attribute'])
    // 同类两条合并：message 前缀带处数
    const byCode = new Map(warnings.map((w) => [w.code, w.message]))
    expect(byCode.get('epub-active-attribute')).toMatch(/2 处/)
    expect(byCode.get('epub-active-attribute')).toMatch(/onclick/)
  })

  it('内联 SVG：剥离整棵子树并记告警（点名文档），正文其余内容保留', () => {
    const { nodes, warnings } = convert('<p>前<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>后</p>')
    expect(shape(nodes)).toEqual([
      { tag: 'p', start: null, value: null, rowSpan: null, colSpan: null, children: ['前', '后'] },
    ])
    expect(warnings.map((w) => w.code)).toEqual(['epub-removed-inline-svg'])
    // 告警要点名文档（读者才知道去翻哪一份），并说清移除了什么
    expect(warnings[0].resource).toBe('OEBPS/ch1.xhtml')
    expect(warnings[0].message).toMatch(/svg/)
    // 同类多处合并成一条计数告警，不刷屏
    const many = convert('<p>前<svg xmlns="http://www.w3.org/2000/svg"/><svg xmlns="http://www.w3.org/2000/svg"/>后</p>')
    expect(many.warnings.map((w) => w.code)).toEqual(['epub-removed-inline-svg'])
    expect(many.warnings[0].message).toMatch(/2 处/)
  })

  it('内联 SVG 是文档唯一内容（真书的整页封面形状）：本层交回 svgOnly 候选，不认识图', () => {
    // 拒绝与降级都不在这一层定：只有编排层知道那张图能不能落到书内资源里（`import.ts`）。
    // 判据从「文档层直接报错」挪到这里，是因为真书里这个形状**有内容**——一张书内封面图，
    // 直接拒整本会把 Gutenberg 那类标准封面写法当坏书（2026-09-26 真书反例）。
    const rectOnly = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4"/></svg>'
    const out = convert(rectOnly)
    expect(out.nodes).toEqual([])
    expect(out.svgOnly?.element.name).toBe('svg')
    // 只有空白文本 + 内联 SVG 也是「唯一内容」（空白不是可显示的正文）
    expect(convert('\n  ' + rectOnly + '\n').svgOnly?.element.name).toBe('svg')
    // 候选期不带「移除了内联 SVG」那条告警：它要么变成一张图，要么整本被拒，两种都不是「丢了装饰」
    expect(out.warnings.map((w) => w.code)).toEqual([])
  })

  it('svgOnly 候选只认「恰好一棵」内联 SVG：两棵就不是整页图形，仍按唯一内容报错', () => {
    const one = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>'
    expect(() => convert(`<p>${one}</p><div>${one}</div>`)).toThrow(/唯一/)
    // 真矢量图形（没有 image）也照样是候选——「这张图落不落得下」由编排层回答
    expect(convert('<svg xmlns="http://www.w3.org/2000/svg"><rect width="4" height="4"/></svg>').svgOnly).not.toBeNull()
  })

  it('整页是一张书内图的 SVG 封面页：候选带那棵 svg，容器层不拦它', () => {
    const out = convert('<div class="cover"><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"'
      + ' width="100%" height="100%" viewBox="0 0 2 3"><image width="2" height="3" xlink:href="images/cover.png"/></svg></div>')
    expect(out.nodes).toEqual([])
    expect(out.svgOnly?.element.name).toBe('svg')
  })

  it('正文没有可显示内容（body 空、只有被移除的活动内容、只有空白）：报错', () => {
    expect(() => convert('')).toThrow(/正文/)
    expect(() => convert('<script>alert(1)</script>')).toThrow(/正文/)
    expect(() => convert('   \n  ')).toThrow(/正文/)
  })

  it('空壳容器不算内容：包一层就冒充成功是判据被绕过', () => {
    // 判据只认「这棵树里有没有会渲染出东西的叶子」，不看容器本身存在与否
    // （`<p>` 里只剩一棵 SVG 走 svgOnly 候选——拒绝由编排层给，那里有资源事实；见上一组用例）
    expect(convert('<p><svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/></p>').svgOnly?.element.name).toBe('svg')
    expect(() => convert('<div><section><script>alert(1)</script></section></div>')).toThrow(/正文/)
    expect(() => convert('<div><p><span></span></p></div>')).toThrow(/正文/)
    expect(() => convert('<blockquote><p>   \n  </p></blockquote>')).toThrow(/正文/)
    // 孤立换行/分隔线本身不是正文（没有可读的字，也没有图）
    expect(() => convert('<p><br/></p>')).toThrow(/正文/)
    expect(() => convert('<hr/>')).toThrow(/正文/)
  })

  it('递归判据不误伤：深层里真有的文字与图照样算内容', () => {
    expect(() => convert('<div><section><p>深处<span>的字</span></p></section></div>')).not.toThrow()
    expect(() => convert('<figure><img src="pics/deep.png" alt="深处的图"/></figure>')).not.toThrow()
    // 空兄弟不拖累：一个壳是空的、另一个有货 → 整份文档成立
    expect(() => convert('<div><p></p><p>有货</p></div>')).not.toThrow()
  })

  it('没有 body 的文档：不是可读的 XHTML，报错点名文档', () => {
    const noBody = parseXml('<html><head><title>x</title></head></html>', xmlBudget('OEBPS/ch1.xhtml', LIMITS))
    expect(() => convertXhtml(noBody, {
      budget: xmlBudget('OEBPS/ch1.xhtml', LIMITS), anchors: new Map(),
      resolveLink: () => null, resolveImage: () => ({ resourceId: 'r0', width: 1, height: 1 }),
      nextNodeId: seq('n'), warnings: new EpubWarningLog(),
    })).toThrow(/body/)
  })
})

describe('链接与图片清点（第一遍扫描的口径）', () => {
  it('只收链接与图片引用；被移除子树里的不算（那段内容不在树上）', () => {
    const root = xhtml('<p><a href="ch2.xhtml#c">正</a><img src="pics/a.png"/></p>'
      + '<script><a href="evil.xhtml#x">不存在的链接</a><img src="evil.png"/></script><a href="#same">同页</a>')
    const budget = xmlBudget('OEBPS/ch1.xhtml', LIMITS)
    const { links, images } = scanXhtml(root, budget, seq('a'))
    expect(links).toEqual(['ch2.xhtml#c', '#same'])
    expect(images).toEqual(['pics/a.png'])
  })
})
