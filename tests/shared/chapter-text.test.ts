import { describe, expect, it } from 'vitest'
import {
  PLAY_UNIT_MAX,
  chapterContentLines,
  chapterContentToText,
  playUnitStarts,
  playUnitStartsByNode,
  splitParagraphs,
} from '../../src/shared/chapter-text.js'
import type { ChapterContent, ContentNode, ContentTag } from '../../src/shared/wire.js'

/** 造一个元素节点：投影只看 tag/children（id 与四类结构参数不参与文字，这里恒 null——
 *  它们的取值语义由导入期测试钉，本文件不复述）；列表起始数与条目值只在列表用例里显式给。 */
function el(tag: ContentTag, children: ContentNode[], extra: {
  start?: number; value?: number; rowSpan?: number; colSpan?: number
} = {}): ContentNode {
  return {
    kind: 'element', id: tag, tag, children,
    rowSpan: extra.rowSpan ?? null, colSpan: extra.colSpan ?? null,
    start: extra.start ?? null, value: extra.value ?? null,
  }
}

/** 同上，但节点 id 显式给——行清单的「起行块」靠它回查 */
function node(id: string, tag: ContentTag, children: ContentNode[]): ContentNode {
  return {
    kind: 'element', id, tag, children,
    rowSpan: null, colSpan: null, start: null, value: null,
  }
}

const t = (text: string): ContentNode => ({ kind: 'text', text })

/** 内部链接（目标无关紧要：投影只看子内容，不追链接去哪里） */
const link = (children: ContentNode[]): ContentNode =>
  ({ kind: 'link', id: 'l0', role: 'normal', target: { kind: 'chapter', index: 1, anchorId: null }, children })

const rich = (nodes: ContentNode[]): string =>
  chapterContentToText({ kind: 'rich', documentId: 'd0', nodes })

describe('chapterContentToText（投影搬家后行为不变）', () => {
  it('text 分支逐字通过，不重新解释尖括号与实体', () => {
    // 分支判据只看 kind：形如标签的正文是合法文字，再解释一遍会把 <p> 吃掉、把 &amp; 解成 &
    expect(chapterContentToText({ kind: 'text', text: '<p>正文 &amp;</p>' })).toBe('<p>正文 &amp;</p>')
  })

  it('text 分支只做空白行规约：CRLF / 首尾空白 / 相邻空行收口，行内空白保留', () => {
    expect(chapterContentToText({ kind: 'text', text: '  甲 \r\n\r\n 乙 \n' })).toBe('甲\n\n乙')
    expect(chapterContentToText({ kind: 'text', text: '甲  乙' })).toBe('甲  乙')
    expect(chapterContentToText({ kind: 'text', text: '<p>正文 &amp;</p>\n\n' })).toBe('<p>正文 &amp;</p>')
  })

  it('rich 分支的结构映射照旧：块级成行、图片占位、表格制表符分列、链接只留文字', () => {
    expect(rich([
      el('h2', [t('目标')]),
      el('p', [t('先看'), { kind: 'image', id: 'n1', resourceId: 'res-9', alt: '地图', width: 600, height: 400 }, t('再走')]),
      el('table', [el('tr', [el('td', [t('一')]), el('td', [t('二')])])]),
      el('p', [t('上'), { kind: 'rule', id: 'hr0' }, t('下')]),
      el('p', [t('见'), {
        kind: 'link', id: 'l0', role: 'noteref',
        target: { kind: 'supplement', documentId: 'notes-1', anchorId: 'fn1' },
        children: [el('sup', [t('1')])],
      }]),
    ])).toBe('目标\n先看[图片：地图]再走\n一\t二\n上\n下\n见1')
  })
})

describe('chapterContentToText（结构映射细目）', () => {
  it('图片投影为说明，不泄露资源标识', () => {
    expect(rich([
      { kind: 'image', id: 'n0', resourceId: 'r0', alt: '人物插画', width: 10, height: 20 },
    ])).toBe('[图片：人物插画]')
  })

  it('图片无替代文字时只留占位符', () => {
    expect(rich([
      { kind: 'image', id: 'n0', resourceId: 'resources/r0.png', alt: '   ', width: 10, height: 20 },
    ])).toBe('[图片]')
  })

  it('图片说明两侧的排版空白不进输出', () => {
    expect(rich([
      { kind: 'image', id: 'n0', resourceId: 'r0', alt: ' 地图 ', width: 10, height: 20 },
    ])).toBe('[图片：地图]')
  })

  it('源码排版的缩进与空行都被规约，正文不带首空行', () => {
    // 真实 EPUB 的漂亮排版 XHTML：段落文字自带缩进与首尾换行，缩进不是正文
    expect(rich([
      el('p', [t('\n    正文第一行\n  ')]),
      el('div', [t('\n  '), el('p', [t('\n  第二段\n')]), t('\n')]),
      el('p', [t('\n  末段\n')]),
    ])).toBe('正文第一行\n第二段\n末段')
  })

  it('块内连续换行不留空白行', () => {
    expect(rich([
      el('p', [t('上'), { kind: 'break', id: 'b0' }, { kind: 'break', id: 'b1' }, t('下')]),
    ])).toBe('上\n下')
  })

  it('行内元素边缘的空格不由行规约吃掉', () => {
    // 片段不是行：在片段上 trim 会吃掉渲染上真实存在的空格（说<em> 话 </em>吧 → 说话吧）
    expect(rich([
      el('p', [t('说'), el('em', [t(' 话 ')]), t('吧')]),
    ])).toBe('说 话 吧')
  })

  it('行内元素里的源码换行折叠成空格，渲染上的一行在文字面仍是一行', () => {
    // 漂亮排版把行内元素的空白摊在源码里，浏览器渲染成 `say hi there` 一行；
    // 按源码换行断句会让文字面凭空多出两行——文字面（getChapter / AI / TXT 导出）与渲染必须一致
    expect(rich([
      el('p', [t('say'), el('em', [t('\n  hi\n')]), t(' there')]),
    ])).toBe('say hi there')
  })

  it('源码文字节点里的制表符与多空格也折叠成单空格', () => {
    expect(rich([el('p', [t('甲\t\t乙  丙')])])).toBe('甲 乙 丙')
  })

  it('源码空白折叠后，块内的 break 仍断行', () => {
    // 折叠只吃**源码**空白；break 是渲染上的硬断行，不是源码排版
    expect(rich([
      el('p', [t('say'), el('em', [t('\n  hi'), { kind: 'break', id: 'b0' }, t('there\n')]), t(' 再见')]),
    ])).toBe('say hi\nthere 再见')
  })

  it('pre 子树里的同样形状逐字保留，不被空白折叠', () => {
    expect(rich([
      el('pre', [t('say'), el('em', [t('\n  hi\n')]), t(' there')]),
    ])).toBe('say\n  hi\n there')
  })

  it('表格行内单元格的制表符分界不被空白折叠吃掉', () => {
    // 制表符是投影自己发明的列分界，不是源码排版空白：折叠只发生在单元格内部，
    // 制表符拼好的整行不再过行规约（否则 tab 会被折成空格，列关系丢失）
    expect(rich([
      el('table', [el('tr', [el('td', [t('\n  甲\n')]), el('td', [t('乙  丙')])])]),
    ])).toBe('甲\t乙 丙')
  })

  it('表格行内的排版空白不成列', () => {
    expect(rich([
      el('tr', [t('\n    '), el('td', [t('甲')]), t('\n    '), el('td', [t('乙')]), t('\n  ')]),
    ])).toBe('甲\t乙')
  })

  it('表格行内的非单元格文本不成列，整体并入末列而非丢弃', () => {
    // 非规范 XHTML：文字落在单元格之外。它没有别的落点，静默丢弃等于丢正文；
    // 出现在首个单元格之前也一样归末列（不为它猜列序）
    expect(rich([el('tr', [t('前言'), el('td', [t('甲')])])])).toBe('甲\t前言')
    expect(rich([el('tr', [el('td', [t('甲')]), t('尾注')])])).toBe('甲\t尾注')
  })

  it('pre 子树整棵绕过行规约，其外的排版缩进照收', () => {
    expect(rich([
      el('p', [t('\n  正文\n')]),
      el('pre', [t('  if (a) {\n    b\n  }')]),
      el('p', [t('\n  尾\n')]),
    ])).toBe('正文\n  if (a) {\n    b\n  }\n尾')
  })

  it('段落与标题：块级边界落成换行，行内标记只留文字', () => {
    expect(rich([
      el('h1', [t('第一章')]),
      el('p', [t('正文'), el('strong', [t('加粗')]), t('与'), el('em', [t('斜体')]), t('脚注'), el('sup', [t('1')])]),
      el('p', [t('第二段')]),
    ])).toBe('第一章\n正文加粗与斜体脚注1\n第二段')
  })

  it('列表项各占一行，有序列表的起始数与条目值不进文字', () => {
    expect(rich([
      el('ol', [el('li', [t('甲')], { value: 7 }), el('li', [t('乙')])], { start: 3 }),
      el('ul', [el('li', [t('丙')])]),
    ])).toBe('甲\n乙\n丙')
  })

  it('表格：行换行、单元格制表符分界（th 与 td 同列规则）', () => {
    expect(rich([
      el('table', [
        el('tr', [el('td', [t('甲')]), el('td', [t('乙')])]),
        el('tr', [el('th', [t('丙')]), el('td', [t('丁')])]),
      ]),
    ])).toBe('甲\t乙\n丙\t丁')
  })

  it('链接只留文字，不追目标也不泄露文档与锚点', () => {
    expect(rich([
      el('p', [t('见'), {
        kind: 'link', id: 'l0', role: 'noteref',
        target: { kind: 'supplement', documentId: 'notes-1', anchorId: 'fn1' },
        children: [el('sup', [t('1')])],
      }]),
    ])).toBe('见1')
  })

  it('换行节点在块内落成换行', () => {
    expect(rich([
      el('p', [t('第一行'), { kind: 'break', id: 'b0' }, t('第二行')]),
    ])).toBe('第一行\n第二行')
  })

  it('预格式文本内部空白逐字保留', () => {
    expect(rich([
      el('pre', [t('  a   b\n    缩进 c')]),
    ])).toBe('  a   b\n    缩进 c')
  })

  it('链接里套 pre：逐字空白照样保留（块级内容在行内上下文也按块自己的投影取值）', () => {
    // XHTML5 的 `<a>` 是透明内容模型，块级子节点是**合法书写**；把子树当行内片段摊平会把 pre 的
    // 缩进与换行折成一行，而导出与 AI 读章读的
    // 正是这条投影——文字面与渲染必须一致。
    expect(rich([
      el('p', [t('见'), link([el('pre', [t('  if (a) {\n    b\n  }')])])]),
    ])).toBe('见\n  if (a) {\n    b\n  }')
  })

  it('链接里套表格行：制表符分列不丢', () => {
    // 制表符是纯文本里唯一表达列关系的东西：分列若被折成相邻字，表格就读不回来了
    expect(rich([
      el('p', [t('前'), link([el('table', [el('tr', [el('td', [t('甲')]), el('td', [t('乙')])])])]), t('后')]),
    ])).toBe('前\n甲\t乙\n后')
  })

  it('链接里套分隔线：与块级边界一样收行，两侧文本不并成一段', () => {
    expect(rich([
      el('p', [t('上'), link([{ kind: 'rule', id: 'hr0' }]), t('下')]),
    ])).toBe('上\n下')
  })

  it('组合样本：标题/段落/引文/列表/表格/链接/图片/分隔线', () => {
    expect(rich([
      el('h2', [t('目标')]),
      el('p', [t('先看'), { kind: 'image', id: 'n1', resourceId: 'res-9', alt: '地图', width: 600, height: 400 }, t('再走')]),
      el('blockquote', [el('p', [t('引文')])]),
      el('ul', [el('li', [t('甲')]), el('li', [t('乙')])]),
      el('table', [el('tr', [el('td', [t('一')]), el('td', [t('二')])])]),
      { kind: 'rule', id: 'hr0' },
      el('p', [t('结束'), {
        kind: 'link', id: 'l1', role: 'normal',
        target: { kind: 'chapter', index: 1, anchorId: 'sec2' },
        children: [t('下一章')],
      }]),
    ])).toBe('目标\n先看[图片：地图]再走\n引文\n甲\n乙\n一\t二\n结束下一章')
  })
})

describe('chapterContentLines（行清单：文本 + 起行块）', () => {
  it('每行带上起始它的块节点 id；行内内容 / 硬断行起的行没有块身份', () => {
    const lines = chapterContentLines({
      kind: 'rich',
      documentId: 'd0',
      nodes: [
        node('h1', 'h1', [t('第一章')]),
        node('p1', 'p', [t('第一行'), { kind: 'break', id: 'b1' }, t('硬断行的第二行')]),
        node('ul1', 'ul', [node('li1', 'li', [t('列表一')]), node('li2', 'li', [t('列表二')])]),
        node('tb1', 'table', [node('tr1', 'tr', [node('td1', 'td', [t('甲')]), node('td2', 'td', [t('乙')])])]),
      ],
    })
    expect(lines).toEqual([
      { text: '第一章', nodeId: 'h1' },
      { text: '第一行', nodeId: 'p1' },
      { text: '硬断行的第二行', nodeId: null },
      { text: '列表一', nodeId: 'li1' },
      { text: '列表二', nodeId: 'li2' },
      { text: '甲\t乙', nodeId: 'tr1' },
    ])
  })

  it('嵌套块共用一行时归最内层块（DOM 里真正承载段号的是内层元素）', () => {
    const lines = chapterContentLines({
      kind: 'rich',
      documentId: 'd0',
      nodes: [node('bq1', 'blockquote', [node('p1', 'p', [t('引文')])])],
    })
    expect(lines).toEqual([{ text: '引文', nodeId: 'p1' }])
  })

  it('行清单的文本 join 等于 chapterContentToText（同一趟遍历，投影输出不变）', () => {
    const content: ChapterContent = {
      kind: 'rich',
      documentId: 'd0',
      nodes: [
        node('h2', 'h2', [t('目标')]),
        node('p1', 'p', [t('先看'), { kind: 'image', id: 'n1', resourceId: 'res-9', alt: '地图', width: 600, height: 400 }, t('再走')]),
        node('bq1', 'blockquote', [node('p2', 'p', [t('引文')])]),
        node('ul1', 'ul', [node('li1', 'li', [t('甲')]), node('li2', 'li', [t('乙')])]),
        node('tb1', 'table', [node('tr1', 'tr', [node('td1', 'td', [t('一')]), node('td2', 'td', [t('二')])])]),
        { kind: 'rule', id: 'hr1' },
        node('p3', 'p', [t('上'), { kind: 'rule', id: 'hr2' }, t('下')]),
      ],
    }
    expect(chapterContentLines(content).map((line) => line.text).join('\n')).toBe(chapterContentToText(content))
    expect(chapterContentToText(content)).toBe('目标\n先看[图片：地图]再走\n引文\n甲\n乙\n一\t二\n上\n下')
  })

  it('text 分支按行规约后的行给清单，行没有块身份', () => {
    expect(chapterContentLines({ kind: 'text', text: '  甲 \r\n\r\n 乙 \n' })).toEqual([
      { text: '甲', nodeId: null },
      { text: '', nodeId: null },
      { text: '乙', nodeId: null },
    ])
    expect(chapterContentLines({ kind: 'text', text: '' })).toEqual([])
  })
})

describe('splitParagraphs（播放单元切分）', () => {
  it('按 \\n 切段、逐段 trim，滤掉空段与纯标点段', () => {
    const text = '\n  第一段  \n\n 。！？ \n \t\n第二段。\n……\n第三段\n'
    expect(splitParagraphs(text)).toEqual(['第一段', '第二段。', '第三段'])
  })

  it('只有空白 / 控制 / 标点 / 符号的段不读（legado notReadAloudRegex 口径）', () => {
    // 分隔线、装饰符与排版空行不是正文：送进引擎只会读出标点名字或制造静音
    expect(splitParagraphs('。！？；…\n***\n—\n☺\n\u200b\n\u3000\n')).toEqual([])
  })

  it('长串歧义空白后接正文不卡死（字符类而非交替，杜绝内容触发的 ReDoS）', () => {
    // `\s` 与 `\p{Z}` 成员重叠：旧交替式 `(?:\s|\p{C}|…)+` 对「长串空白 + 一个正文 char」的
    // 近匹配串指数回溯——一行就能冻住进程 / UI（60 个空格旧式跑分钟级，本用例超时即红）。
    // 字符类是单次集合成员判定，线性。零宽空格（\p{C}）trim 不掉，留在段首。
    const near = '\u200b' + ' '.repeat(60) + 'A'
    expect(splitParagraphs(near)).toEqual([near]) // 有正文 'A'，整段保留
    // 防 ReDoS 不改判定口径：纯标点 / 空白的长串照样滤掉
    expect(splitParagraphs('。' + ' '.repeat(60) + '！')).toEqual([])
  })

  it('普通段落不拆，段内空白与段内标点原样保留', () => {
    expect(splitParagraphs('甲  乙\n丙。丁')).toEqual(['甲  乙', '丙。丁'])
  })

  it('PLAY_UNIT_MAX = 300（按 code point 计）', () => {
    expect(PLAY_UNIT_MAX).toBe(300)
  })

  it('超长段按句二次切分且每单元 ≤ PLAY_UNIT_MAX', () => {
    const long = '句子。'.repeat(200) // 600 字
    const units = splitParagraphs(long)
    expect(units.length).toBeGreaterThan(1)
    for (const u of units) expect(Array.from(u).length).toBeLessThanOrEqual(PLAY_UNIT_MAX)
    expect(units.join('')).toBe(long)
  })

  it('句界留在前一个单元末尾，不甩到下一个单元开头', () => {
    const para = '甲'.repeat(299) + '。' + '乙'.repeat(100)
    expect(splitParagraphs(para)).toEqual(['甲'.repeat(299) + '。', '乙'.repeat(100)])
  })

  it('无句界的超长段硬切不丢字', () => {
    const text = '字'.repeat(700)
    const units = splitParagraphs(text)
    expect(units.join('')).toBe(text)
    for (const u of units) expect(Array.from(u).length).toBeLessThanOrEqual(PLAY_UNIT_MAX)
  })

  it('硬切不动段内字符（含段内空白），切点按 code point 算不劈开代理对', () => {
    const spaced = '甲 '.repeat(350).trim()
    expect(splitParagraphs(spaced).join('')).toBe(spaced)
    // 400 个 code point / 600 个 UTF-16 码元：按码元切会把 😀 劈成两个孤立代理项
    const mixed = '字😀'.repeat(200)
    const units = splitParagraphs(mixed)
    expect(units.join('')).toBe(mixed)
    expect(units.every((unit) => unit.isWellFormed())).toBe(true)
    for (const u of units) expect(Array.from(u).length).toBeLessThanOrEqual(PLAY_UNIT_MAX)
  })
})

describe('playUnitStarts（起段号：行清单 → 各行之前已占的播放单元数）', () => {
  it('第 i 项 = 第 i 行之前已占的单元数：起点 0、项数等于行数', () => {
    expect(playUnitStarts([])).toEqual([])
    expect(playUnitStarts([{ text: '甲' }, { text: '乙' }, { text: '丙' }])).toEqual([0, 1, 2])
  })

  it('空行 / 纯标点行占 0 单元：后面的行不因它们挪号', () => {
    // 分隔线、装饰符与排版空行不是正文（splitParagraphs 的 notReadAloud 口径），但它们仍在清单里占行
    const lines = ['', '   ', '……', '***', '正文一', '\t', '正文二'].map((text) => ({ text }))
    expect(playUnitStarts(lines)).toEqual([0, 0, 0, 0, 0, 1, 1])
  })

  it('超长段二次切分后的起段号：一行占多格，后续行按切出的单元数走', () => {
    const long = '句子。'.repeat(200) // 600 字，必过 PLAY_UNIT_MAX 二次切分
    const units = splitParagraphs(long)
    expect(units.length).toBeGreaterThan(1)
    expect(playUnitStarts([{ text: '前' }, { text: long }, { text: '后' }]))
      .toEqual([0, 1, 1 + units.length])
  })

  it('剥前 k 行取第 k 项 = 前 k 行占的单元数；从 k 行起重新数与它同一把尺（等价）', () => {
    // ReaderView 剥章名算 paragraphBase、ChapterBody 在剥后的清单上重新数：两套号必须对得上，
    // 否则「从本段听」与探针起播会系统性偏移
    const lines = ['甲', '', '……', '乙', '句子。'.repeat(200), '丙', '***', '丁'].map((text) => ({ text }))
    const all = playUnitStarts(lines)
    expect(all.length).toBe(lines.length)
    for (let k = 0; k < lines.length; k += 1) {
      const base = all[k] ?? 0
      // 「剥前 k 行取第 k 项」与「前缀整段切」同数：逐行累计与整段切分是同一把尺
      const prefix = lines.slice(0, k).map((line) => line.text).join('\n')
      expect(base).toBe(splitParagraphs(prefix).length)
      // 「从 k 行起重新数」平移同一个基数：重新数的第 i 项加基数等于原清单第 k 加 i 项
      for (const [i, start] of playUnitStarts(lines.slice(k)).entries()) {
        expect(all[k + i]).toBe(base + start)
      }
    }
  })
})

describe('playUnitStartsByNode（起段号按起行块归位）', () => {
  it('图文章块首指向首个可读单元：块开头的纯标点行占 0 单元，段号落到它后面第一个可读单元', () => {
    const lines = chapterContentLines({
      kind: 'rich',
      documentId: 'd0',
      nodes: [
        node('h', 'h2', [t('标题')]),
        node('lead', 'p', [t('……'), { kind: 'break', id: 'b0' }, t('正文')]),
        node('next', 'p', [t('下一段')]),
      ],
    })
    expect(lines.map((line) => line.text)).toEqual(['标题', '……', '正文', '下一段'])
    // 标题占 1 格；「……」行不产单元，lead 的起段号因此指向它自己的正文那一格
    expect([...playUnitStartsByNode(lines)]).toEqual([['h', 0], ['lead', 1], ['next', 2]])
  })

  it('同一 nodeId 只收首次出现行的起段号；行内内容起的行（null）不收', () => {
    const starts = playUnitStartsByNode([
      { text: '甲', nodeId: null },
      { text: '乙', nodeId: 'a' },
      { text: '丙', nodeId: 'a' },
      { text: '丁', nodeId: 'b' },
    ])
    expect([...starts]).toEqual([['a', 1], ['b', 3]])
  })

  it('与 playUnitStarts 同一把计数尺：块起段号就是该行在清单里的起段号', () => {
    const lines = chapterContentLines({
      kind: 'rich',
      documentId: 'd0',
      nodes: [
        node('p1', 'p', [t('甲')]),
        node('p2', 'p', [t('乙'), { kind: 'break', id: 'b1' }, t('丙')]),
        node('p3', 'p', [t('丁')]),
      ],
    })
    const byNode = playUnitStartsByNode(lines)
    const starts = playUnitStarts(lines)
    for (const [index, line] of lines.entries()) {
      if (line.nodeId === null) continue
      expect(byNode.get(line.nodeId)).toBe(starts[index])
    }
    expect([...byNode.values()]).toEqual([0, 1, 3])
  })
})
