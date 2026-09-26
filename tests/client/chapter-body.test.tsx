// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ChapterBody } from '../../src/client/views/ChapterBody.js'
import type { ChapterContent, ContentNode, ContentTag, ReadingTarget } from '../../src/client/views/types.js'

/**
 * 图文正文渲染器（ChapterBody）的结构钉子。
 *
 * jsdom 没有排版引擎：本文件能证明的只有**结构**（白名单映射、属性面、跳转载荷、失败占位在场）。
 * 「图片预留宽高比不收缩」「表格在栏内横向滚动」「图片不撑破栏宽」这三条尺寸行为只断言到
 * 「值/类在场」这一层，真实读数留 Task 9 的浏览器门——不在这里谎报量过布局。
 */

const bookKey = 'local:b1'

const text = (t: string): ContentNode => ({ kind: 'text', text: t })
const doc = (nodes: ContentNode[], documentId = 'd0'): ChapterContent => ({ kind: 'rich', documentId, nodes })

/** 白名单元素夹具：字段逐个写全（rowSpan/colSpan/start/value 的缺省是 null，不是缺席） */
function element(
  id: string,
  tag: ContentTag,
  children: ContentNode[],
  over: { rowSpan?: number; colSpan?: number; start?: number; value?: number } = {},
): ContentNode {
  return {
    kind: 'element', id, tag, children,
    rowSpan: over.rowSpan ?? null, colSpan: over.colSpan ?? null,
    start: over.start ?? null, value: over.value ?? null,
  }
}

const link = (id: string, target: ReadingTarget, role: 'normal' | 'noteref' | 'backlink', label: string): ContentNode =>
  ({ kind: 'link', id, target, role, children: [text(label)] })

afterEach(cleanup)

describe('文字面（kind:text）', () => {
  it('按行成段，逐字原样（与现阅读器同一切分：换模型不换读感）', () => {
    const { container } = render(
      <ChapterBody content={{ kind: 'text', text: '第一段\n第二段' }} bookKey={bookKey} onNavigate={() => {}} />,
    )
    const ps = [...container.querySelectorAll('p')].map((p) => p.textContent)
    expect(ps).toEqual(['第一段', '第二段'])
  })

  it('书内文本里的 HTML 只是字面量：不解析、不注入', () => {
    const raw = '<img src=x onerror="alert(1)"><script>bad()</script>'
    const { container } = render(<ChapterBody content={{ kind: 'text', text: raw }} bookKey={bookKey} onNavigate={() => {}} />)
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('script')).toBeNull()
    expect(container.textContent).toBe(raw)
  })
})

describe('图文面（kind:rich）：白名单 React 映射', () => {
  it('元素照名字映射（p/strong/em/h*/blockquote/pre/code/sup/sub/ul/ol/li）', () => {
    const { container } = render(
      <ChapterBody
        content={doc([
          element('p1', 'p', [
            text('段落'),
            element('st1', 'strong', [text('粗')]),
            element('em1', 'em', [text('斜')]),
          ]),
          element('h2a', 'h2', [text('小节标题')]),
          element('bq1', 'blockquote', [text('引文')]),
          element('pre1', 'pre', [text('  两空格\n    四空格')]),
          element('cd1', 'code', [text('代码')]),
          element('sp1', 'sup', [text('上标')]),
          element('sb1', 'sub', [text('下标')]),
          element('ul1', 'ul', [element('li1', 'li', [text('无序项')])]),
          element('ol1', 'ol', [element('li2', 'li', [text('有序项')])], { start: 3 }),
        ])}
        bookKey={bookKey}
        onNavigate={() => {}}
      />,
    )
    expect(screen.getByText('段落').tagName).toBe('P')
    expect(container.querySelector('strong')?.textContent).toBe('粗')
    expect(container.querySelector('em')?.textContent).toBe('斜')
    expect(container.querySelector('h2')?.textContent).toBe('小节标题')
    expect(container.querySelector('blockquote')?.textContent).toBe('引文')
    // pre 的空白是内容不是排版：原样留在文本节点里
    expect(container.querySelector('pre')?.textContent).toBe('  两空格\n    四空格')
    expect(container.querySelector('code')?.textContent).toBe('代码')
    expect(container.querySelector('sup')?.textContent).toBe('上标')
    expect(container.querySelector('sub')?.textContent).toBe('下标')
    expect(container.querySelector('ul li')?.textContent).toBe('无序项')
    expect(container.querySelector('ol')?.getAttribute('start')).toBe('3')
  })

  it('有序列表：li 的 value 只在有值时落地，ol 的 start 不落到别的标签上', () => {
    const { container } = render(
      <ChapterBody
        content={doc([
          element('ol1', 'ol', [element('li1', 'li', [text('甲')], { value: 7 }), element('li2', 'li', [text('乙')])]),
          // 伪造载荷：start 只对 ol 有效（wire 口径），别的标签不发明这个属性
          element('p1', 'p', [text('普通段')], { start: 9 }),
        ])}
        bookKey={bookKey}
        onNavigate={() => {}}
      />,
    )
    const items = [...container.querySelectorAll('li')]
    expect(items[0].getAttribute('value')).toBe('7')
    expect(items[1].getAttribute('value')).toBeNull()
    expect(container.querySelector('p')?.getAttribute('start')).toBeNull()
  })

  it('表格：单元格 rowSpan/colSpan 落地，非单元格不接这两个属性，且套横向滚动容器', () => {
    const { container } = render(
      <ChapterBody
        content={doc([
          element('tb1', 'table', [
            // 行组按真实书源结构给（EPUB 常见 thead+tbody）：组件只映射 wire 的树，不自己补行组
            element('thd', 'thead', [
              element('tr1', 'tr', [
                element('th1', 'th', [text('头')], { rowSpan: 2, colSpan: 3 }),
                element('td1', 'td', [text('格')], { colSpan: 2 }),
              ]),
            ]),
            element('tbd', 'tbody', [element('tr2', 'tr', [element('td2', 'td', [text('体')])])]),
          ]),
          element('p1', 'p', [text('普通段')], { rowSpan: 2, colSpan: 3 }),
        ])}
        bookKey={bookKey}
        onNavigate={() => {}}
      />,
    )
    const th = container.querySelector('th')
    expect(th?.getAttribute('rowspan')).toBe('2')
    expect(th?.getAttribute('colspan')).toBe('3')
    expect(container.querySelector('td')?.getAttribute('colspan')).toBe('2')
    const p = container.querySelector('p')
    expect(p?.getAttribute('rowspan')).toBeNull()
    expect(p?.getAttribute('colspan')).toBeNull()
    // 宽表滚动的结构前提（滚动行为本身归样式层，实测留 Task 9）
    expect(container.querySelector('.novel-table-wrap > table')).not.toBeNull()
  })

  it('br / hr 各有对应元素', () => {
    const { container } = render(
      <ChapterBody
        content={doc([
          element('p1', 'p', [text('上'), { kind: 'break', id: 'br1' }, text('下')]),
          { kind: 'rule', id: 'hr1' },
        ])}
        bookKey={bookKey}
        onNavigate={() => {}}
      />,
    )
    expect(container.querySelector('br')).not.toBeNull()
    expect(container.querySelector('hr')).not.toBeNull()
  })
})

describe('元素属性面（明确赋值，不展开外部对象）', () => {
  it('元素只带 id 与 data-novel-node 两个属性', () => {
    const { container } = render(
      <ChapterBody content={doc([element('n1', 'p', [text('段')])])} bookKey={bookKey} onNavigate={() => {}} />,
    )
    const p = container.querySelector('p')
    expect([...(p?.getAttributeNames() ?? [])].sort()).toEqual(['data-novel-node', 'id'])
    expect(p?.getAttribute('data-novel-node')).toBe('n1')
  })

  it('DOM id = 书身份 + 文档 ID + 节点 ID（宿主 DOM 的 id 命名空间不与裸锚点相撞）', () => {
    const { container } = render(
      <ChapterBody content={doc([element('a1', 'p', [text('锚点段')])], 'd7')} bookKey={bookKey} onNavigate={() => {}} />,
    )
    const p = container.querySelector('p')
    expect(p?.id.startsWith('novel-')).toBe(true)
    expect(p?.id).toContain('local-b1')
    expect(p?.id).toContain('d7')
    expect(p?.id).toContain('a1')
  })

  it('书身份里的空白/斜线不进 id（id 属性里出现空白就是非法值）', () => {
    const { container } = render(
      <ChapterBody content={doc([element('a1', 'p', [text('段')])])} bookKey={'https://s.com/b/1 x'} onNavigate={() => {}} />,
    )
    expect(container.querySelector('p')?.id ?? '').not.toMatch(/\s/)
  })
})

describe('插图', () => {
  it('src 只由 wire 资源路径生成（前缀 + 资源路由 + 编码后的不透明 id）', () => {
    render(
      <ChapterBody
        content={doc([{ kind: 'image', id: 'im1', resourceId: 'r0', alt: '插图', width: 600, height: 900 }])}
        bookKey={bookKey}
        onNavigate={() => {}}
      />,
    )
    expect(screen.getByRole('img', { name: '插图' }).getAttribute('src'))
      .toBe('/novel-api/local/resource?id=local%3Ab1&resourceId=r0')
  })

  it('书内的资源标识当查询参数编码：拼不出第二个参数、换不来协议', () => {
    render(
      <ChapterBody
        content={doc([{ kind: 'image', id: 'im1', resourceId: 'x&id=other/../x', alt: '图', width: 10, height: 10 }])}
        bookKey={bookKey}
        onNavigate={() => {}}
      />,
    )
    const src = screen.getByRole('img', { name: '图' }).getAttribute('src') ?? ''
    expect(src.startsWith('/novel-api/local/resource?')).toBe(true)
    expect(src).toContain('resourceId=x%26id%3Dother%2F..%2Fx')
    expect(src).not.toContain('javascript:')
  })

  it('图片失败仍保留预留宽高比（brief 原用例）', () => {
    const content: ChapterContent = {
      kind: 'rich',
      documentId: 'd0',
      nodes: [{ kind: 'image', id: 'n0', resourceId: 'r0', alt: '插图', width: 600, height: 900 }],
    }
    render(<ChapterBody content={content} bookKey={bookKey} onNavigate={() => {}} />)
    fireEvent.error(screen.getByRole('img', { name: '插图' }))
    expect(screen.getByText('图片加载失败')).toBeTruthy()
    expect(document.querySelector('[data-resource-id="r0"]')).not.toBeNull()
    // 框还在，且比值取自可信宽高（尺寸稳定本身是 Task 9 的浏览器读数）
    const box = document.querySelector('[data-resource-id="r0"]') as HTMLElement
    expect(box.style.getPropertyValue('--novel-fig-ratio')).toBe('600 / 900')
    expect(box.querySelector('img')).toBeNull()                        // 不留一个破图图标冒充内容
    expect(screen.getByRole('img', { name: '图片加载失败：插图' })).toBeTruthy()   // 替代文字没丢
  })

  it('空 alt 合法：装饰图不制造「无名 img」，失败后仍有可见说明', () => {
    render(
      <ChapterBody
        content={doc([{ kind: 'image', id: 'n0', resourceId: 'r0', alt: '', width: 1, height: 1 }])}
        bookKey={bookKey}
        onNavigate={() => {}}
      />,
    )
    const img = document.querySelector('img')
    expect(img?.getAttribute('alt')).toBe('')
    expect(screen.queryByRole('img')).toBeNull()                       // alt="" = 装饰图，不该进无障碍树
    fireEvent.error(img as HTMLImageElement)
    expect(screen.getByText('图片加载失败')).toBeTruthy()
  })
})

describe('内部跳转（不是 <a>，不走 raw href）', () => {
  it('链接渲染成按钮：无 href、无 <a>，onNavigate 带目标与角色', () => {
    const onNavigate = vi.fn()
    const { container } = render(
      <ChapterBody
        content={doc([
          element('p1', 'p', [
            link('l1', { kind: 'supplement', documentId: 'd9', anchorId: 'a2' }, 'noteref', '[1]'),
            link('l2', { kind: 'chapter', index: 3, anchorId: 'x1' }, 'backlink', '回正文'),
          ]),
        ])}
        bookKey={bookKey}
        onNavigate={onNavigate}
      />,
    )
    expect(container.querySelector('a')).toBeNull()
    const note = screen.getByRole('button', { name: '[1]' })
    expect(note.getAttribute('href')).toBeNull()
    expect(note.getAttribute('data-novel-role')).toBe('noteref')
    fireEvent.click(note)
    expect(onNavigate).toHaveBeenLastCalledWith({ kind: 'supplement', documentId: 'd9', anchorId: 'a2' }, 'noteref')
    fireEvent.click(screen.getByRole('button', { name: '回正文' }))
    expect(onNavigate).toHaveBeenLastCalledWith({ kind: 'chapter', index: 3, anchorId: 'x1' }, 'backlink')
  })

  it('链接里套块级子节点：按钮内不出现流级元素，文字与跳转一个不丢', () => {
    // XHTML 允许 `<a><div>…</div></a>`（源书合法），HTML 内容模型不许 `<button>` 装流级元素——
    // 浏览器会替我们重排 DOM，节点位置就不由我们说了，门的 React 警告白名单也会被绊到。
    // 所以链接上下文里块级标签降级成 span（块状观感由 .novel-ref-part 用 CSS 拿回）。
    const onNavigate = vi.fn()
    const blocky: ContentNode = {
      kind: 'link', id: 'l9', target: { kind: 'chapter', index: 2, anchorId: null }, role: 'normal',
      children: [
        element('b1', 'div', [text('段一')]),
        { kind: 'rule', id: 'b2' },
        element('b3', 'p', [text('段二')]),
        element('b4', 'em', [text('行内')]),
      ],
    }
    const { container } = render(
      <ChapterBody content={doc([element('p1', 'p', [blocky])])} bookKey={bookKey} onNavigate={onNavigate} />,
    )
    const btn = container.querySelector('.novel-ref') as HTMLElement
    expect(btn.tagName).toBe('BUTTON')
    for (const sel of ['div', 'p', 'hr', 'ul', 'li', 'table', 'h2', 'blockquote', 'pre']) {
      expect(btn.querySelector(sel), `按钮里出现了 <${sel}>：非法嵌套`).toBeNull()
    }
    expect(btn.querySelector('em'), '行内元素不必降级').not.toBeNull()
    expect(btn.textContent).toContain('段一')
    expect(btn.textContent).toContain('段二')
    expect(btn.textContent).toContain('行内')
    expect(container.querySelectorAll('[data-novel-node="l9"]')).toHaveLength(1)   // 锚点身份不拆成两份
    fireEvent.click(btn)
    expect(onNavigate).toHaveBeenLastCalledWith({ kind: 'chapter', index: 2, anchorId: null }, 'normal')
  })

  it('链接含块级内容时链接自己是块级容器（收缩包裹会让插图占位塌成 0）', () => {
    // `<button>` 缺省按内容收缩包裹，里面的 `width: 100%` 插图框于是解析成 auto——图未解码时没有
    // 内在尺寸，框塌成 0，图一到手正文整段位移（真浏览器实测 0×0 → 600×900）。含块内容的链接本来
    // 就是块级（XHTML5 的透明内容模型），这里把它显式化。
    const image: ContentNode = { kind: 'image', id: 'i1', resourceId: 'r1', alt: '图', width: 600, height: 900 }
    const withImage: ContentNode = {
      kind: 'link', id: 'l1', target: { kind: 'chapter', index: 1, anchorId: null }, role: 'normal', children: [image],
    }
    const onlyText = link('l2', { kind: 'chapter', index: 2, anchorId: null }, 'normal', '纯文字')
    const { container } = render(
      <ChapterBody
        content={doc([element('p1', 'p', [withImage]), element('p2', 'p', [onlyText])])}
        bookKey={bookKey}
        onNavigate={() => {}}
      />,
    )
    expect(container.querySelectorAll('[data-novel-node="l1"]')[0].classList.contains('novel-ref-block')).toBe(true)
    expect(container.querySelectorAll('[data-novel-node="l2"]')[0].classList.contains('novel-ref-block')).toBe(false)
  })
})

describe('白名单逐标签渲染（编译期挡得住删标签，挡不住渲染成空）', () => {
  /** 每个 ContentTag 都要在这里出现：`Record<ContentTag, …>` 让漏项在 `pnpm typecheck` 就红
   *  （白名单加/删标签时这里必须跟上），运行期再逐个量「元素在场 + 文字非空」。 */
  const RENDER_CASES: Record<ContentTag, unknown> = {
    p: 1, div: 1, span: 1, h1: 1, h2: 1, h3: 1, h4: 1, h5: 1, h6: 1,
    strong: 1, em: 1, ul: 1, ol: 1, li: 1, blockquote: 1, pre: 1, code: 1,
    sup: 1, sub: 1, table: 1, caption: 1, thead: 1, tbody: 1, tfoot: 1,
    tr: 1, th: 1, td: 1,
  }

  it('白名单标签逐个渲染出自己的元素，子内容一字不丢', () => {
    const tags = Object.keys(RENDER_CASES) as ContentTag[]
    expect(tags, '夹具自己得真遍历到标签（空表会让下面全绿却什么都没测）').toHaveLength(27)
    for (const tag of tags) {
      const { container, unmount } = render(
        <ChapterBody content={doc([element(`e-${tag}`, tag, [text(`甲-${tag}`)])])} bookKey={bookKey} onNavigate={() => {}} />,
      )
      // 按锚点钩子找，不按标签名 querySelector：正文外壳自己就是 div，裸查 div 先命中壳
      const hits = container.querySelectorAll(`[data-novel-node="e-${tag}"]`)
      expect(hits, `<${tag}> 的锚点应当恰好一个（重复 = 目录落位会挑错节点）`).toHaveLength(1)
      const el = hits[0]
      expect(el, `<${tag}> 没渲染出元素（锚点钩子不在）`).not.toBeNull()
      expect(el?.tagName, `锚点落在了别的元素上（不是 <${tag}>）`).toBe(tag.toUpperCase())
      expect(el?.textContent, `<${tag}> 渲染成空`).toContain(`甲-${tag}`)
      unmount()
    }
  })
})

describe('源码守卫（三个组件里最容易被绕过的那条路）', () => {
  // 剥注释再扫：注释里正写着「不碰 dangerouslySetInnerHTML」这类话（那正是文档的价值），照扫即误报
  const src = readFileSync(path.join(process.cwd(), 'src', 'client', 'views', 'ChapterBody.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

  it('没有 HTML 注入入口，也不展开外部对象/拼选择器', () => {
    expect(src).not.toContain('dangerouslySetInnerHTML')
    expect(src, '书内 URL 不得变成 raw href').not.toMatch(/href/)
    expect(src, '属性逐个明确赋值，不展开载荷').not.toMatch(/\{\.\.\.(node|n|props|attrs)\b/)
    expect(src, '外部 id 不进选择器（查找走 data 属性遍历）').not.toContain('querySelector')
  })
})
