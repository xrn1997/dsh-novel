import { describe, expect, it } from 'vitest'
import { stripLeadingTitle } from '../../src/client/util.js'
import type { ChapterContent, ContentNode, ContentTag } from '../../src/shared/wire.js'

/**
 * 章名在屏幕上连着打两遍的修法：h2 已经渲染 `toc[i].name`，而相当一部分在线源的正文里
 * **第一行就是同一句章名**（真机截图里「第1章 雪地遇袭」居中粗体下面紧跟一行左对齐的同样字）。
 *
 * 三条口径，逐条钉在下面：
 *  ① **相等才丢**——归一化只去空白（含全角），不做包含、不做前缀、不做大小写折叠。
 *     「第1章 雪地遇袭 完整版」不是章名，认不出一律留；
 *  ② **只作用在呈现层**——导出与 AI 工具读的是 `chapterContentToText` 的投影，那里必须仍是原样正文；
 *  ③ **章名前的空白行随章名一起走**——空白行不是内容，留着它等于在章顶挂一个空段。
 */

const text = (s: string): ChapterContent => ({ kind: 'text', text: s })
const t = (s: string): ContentNode => ({ kind: 'text', text: s })
const el = (id: string, tag: ContentTag, children: ContentNode[]): ContentNode =>
  ({ kind: 'element', id, tag, children, rowSpan: null, colSpan: null, start: null, value: null })
const img = (id: string): ContentNode =>
  ({ kind: 'image', id, resourceId: 'r1', alt: '', width: 400, height: 300 })
const rich = (...nodes: ContentNode[]): ChapterContent => ({ kind: 'rich', documentId: 'd1', nodes })

describe('stripLeadingTitle：正文首行等于章名才丢', () => {
  it('文字章：首行等于章名 → 丢掉那一行，其余按原序留', () => {
    expect(stripLeadingTitle(text('第1章 雪地遇袭\n午后，雪落下来。'), '第1章 雪地遇袭'))
      .toEqual(text('午后，雪落下来。'))
  })

  it('章名前的空白行随章名一起走（空白行不是内容）', () => {
    expect(stripLeadingTitle(text('\n\n  \n第1章 雪地遇袭\n第一段。'), '第1章 雪地遇袭'))
      .toEqual(text('第一段。'))
  })

  it('归一化只去空白：全角空格与无空格的变体算同一句章名', () => {
    expect(stripLeadingTitle(text('第1章雪地遇袭\n第一段。'), '第1章 雪地遇袭')).toEqual(text('第一段。'))
    expect(stripLeadingTitle(text('第1章　雪地遇袭\n第一段。'), '第1章 雪地遇袭')).toEqual(text('第一段。'))
  })

  it('相等才丢：首行比章名多一个字都不丢（「包含」不是判据）', () => {
    const longer = text('第1章 雪地遇袭（完整版）\n第一段。')
    expect(stripLeadingTitle(longer, '第1章 雪地遇袭')).toEqual(longer)
    const shorter = text('第1章\n第一段。')
    expect(stripLeadingTitle(shorter, '第1章 雪地遇袭')).toEqual(shorter)
  })

  it('首行不是章名 → 原样返回（同一引用，不重排正文）', () => {
    const c = text('夜里挑灯看剑\n第二段正文')
    expect(stripLeadingTitle(c, '第1章 夜航')).toBe(c)
  })

  it('整章只有章名一行 → 空正文，不是 null、也不是把章名留在屏上', () => {
    expect(stripLeadingTitle(text('第1章 雪地遇袭'), '第1章 雪地遇袭')).toEqual(text(''))
  })

  it('章名归一化后为空 → 一律不动（不拿空串去匹配空行）', () => {
    const c = text('\n第一段。')
    expect(stripLeadingTitle(c, '   ')).toBe(c)
    expect(stripLeadingTitle(c, '')).toBe(c)
  })

  it('幂等：剥过再剥一次不变', () => {
    const once = stripLeadingTitle(text('第1章 雪地遇袭\n第一段。'), '第1章 雪地遇袭')
    expect(stripLeadingTitle(once, '第1章 雪地遇袭')).toEqual(once)
  })

  it('图文章一律不动：首节点是带 id 的可寻址元素，剥掉等于让导航锚点凭空消失', () => {
    const dup = rich(el('n1', 'h1', [t('第一章')]), el('a', 'p', [t('甲')]))
    expect(stripLeadingTitle(dup, '第一章')).toBe(dup)
  })

  it('图文章：首节点是图 / 是链接 → 同样不动', () => {
    const withImage = rich(img('i1'), el('n2', 'p', [t('第一段。')]))
    expect(stripLeadingTitle(withImage, '第1章 雪地遇袭')).toBe(withImage)
    const link: ContentNode = {
      kind: 'link', id: 'l1', role: 'normal',
      target: { kind: 'chapter', index: 1, anchorId: null }, children: [t('第1章 雪地遇袭')],
    }
    const withLink = rich(link, el('n2', 'p', [t('第一段。')]))
    expect(stripLeadingTitle(withLink, '第1章 雪地遇袭')).toBe(withLink)
  })

  it('图文章即便章名重复出现在正文里也不剥——那是一整个元素，不是排版噪声', () => {
    const c = rich(el('n1', 'p', [t('第1章 雪地遇袭')]), el('n2', 'p', [t('第一段。')]))
    expect(stripLeadingTitle(c, '第1章 雪地遇袭')).toBe(c)
  })
})
