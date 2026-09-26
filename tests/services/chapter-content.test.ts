import { describe, expect, it } from 'vitest'
import { chapterContentToText } from '../../src/services/chapter-content.js'
import type { ContentNode, ContentTag } from '../../src/shared/wire.js'

/** 造一个元素节点：投影只看 tag/children（id 与四类结构参数不参与文字，这里恒 null——
 *  它们的取值语义由导入期测试钉，本文件不复述） */
function el(tag: ContentTag, children: ContentNode[], extra: {
  start?: number; value?: number; rowSpan?: number; colSpan?: number
} = {}): ContentNode {
  return {
    kind: 'element', id: tag, tag, children,
    rowSpan: extra.rowSpan ?? null, colSpan: extra.colSpan ?? null,
    start: extra.start ?? null, value: extra.value ?? null,
  }
}

const t = (text: string): ContentNode => ({ kind: 'text', text })

const rich = (nodes: ContentNode[]): string =>
  chapterContentToText({ kind: 'rich', documentId: 'd0', nodes })

/** 内部链接（目标无关紧要：投影只看子内容，不追链接去哪里） */
const link = (children: ContentNode[]): ContentNode =>
  ({ kind: 'link', id: 'l0', role: 'normal', target: { kind: 'chapter', index: 1, anchorId: null }, children })

describe('chapterContentToText', () => {
  it('旧文本逐字通过，不重新解释尖括号', () => {
    const text = '<系统提示>\n原文 &amp;'
    expect(chapterContentToText({ kind: 'text', text })).toBe(text)
  })

  it('形如标签的正文原样通过，不套用 HTML 判定', () => {
    // 服务层的文字已经规范化过一次（contentToText + normalizeChapterText）；再解释一遍
    // 会把正文里合法的尖括号当标签吃掉，并顺手把 &amp; 这类字面量解成实体
    const text = '<p>正文里的标签字样</p>'
    expect(chapterContentToText({ kind: 'text', text })).toBe(text)
  })

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

  it('分隔线与块级边界一样收行，两侧文本不并成一段', () => {
    expect(rich([
      el('p', [t('上'), { kind: 'rule', id: 'hr0' }, t('下')]),
    ])).toBe('上\n下')
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

  it('表格：行换行、单元格制表符分界', () => {
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
    // 缩进与换行折成一行（实测 `if (a) {\n    b\n  }` → `if (a) { b }`），而导出与 AI 读章读的
    // 正是这条投影——文字面与渲染必须一致。
    expect(rich([
      el('p', [t('见'), link([el('pre', [t('  if (a) {\n    b\n  }')])])]),
    ])).toBe('见\n  if (a) {\n    b\n  }')
  })

  it('链接里套表格行：制表符分列不丢', () => {
    // 实测缺陷：`甲\t乙` 变 `甲乙`（列关系在纯文本里只有制表符这一种表达）
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
