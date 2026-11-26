// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { zhTranslate } from '../../src/client/copy/index.js'
import { CopyProvider, enTranslate } from '../../src/client/copy/index.js'
import { filterNavigationItems, ReaderNavigation } from '../../src/client/views/ReaderNavigation.js'
import type { NavigationItem } from '../../src/client/views/types.js'
import { pick } from '../support/fixture.js'

/**
 * 目录树（ReaderNavigation）的结构钉子：条目是**树**不是线性表（目录叶数可多于阅读单元，
 * 同一 XHTML 的多个锚点是各自跳转的条目），所以「点第二小节必须带 anchorId」这条在这里钉死。
 * 缩进、组头、当前项三条都在此：缩进靠嵌套列表（结构即层级），组头不可点，至多一条 aria-current。
 */

const items: NavigationItem[] = [
  {
    id: 'g1', label: '卷一 风起', target: null, children: [
      { id: 'c1', label: '第一章', target: { kind: 'chapter', index: 0, anchorId: null }, children: [] },
      {
        id: 'c2', label: '第二章', target: { kind: 'chapter', index: 1, anchorId: null }, children: [
          { id: 's1', label: '第二节', target: { kind: 'chapter', index: 1, anchorId: 'a2' }, children: [] },
        ],
      },
    ],
  },
  { id: 'c3', label: '第三章', target: { kind: 'chapter', index: 2, anchorId: null }, children: [] },
]

afterEach(cleanup)

describe('树结构', () => {
  it('嵌套即深度：子层级是嵌在条目里的列表，不靠行内缩进值', () => {
    const { container } = render(<ReaderNavigation items={items} activeId={null} onNavigate={() => {}} />)
    expect(container.querySelector('.novel-nav .novel-nav')).not.toBeNull()          // 卷二层
    expect(container.querySelector('.novel-nav .novel-nav .novel-nav')).not.toBeNull() // 第三层
  })

  it('分组（target 为 null）不是按钮：文字在场但点不动，不伪造导航', () => {
    render(<ReaderNavigation items={items} activeId={null} onNavigate={() => {}} />)
    expect(screen.getByText('卷一 风起')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '卷一 风起' })).toBeNull()
  })

  it('叶项复用现有抽屉按钮类（高亮/焦点环与抽屉按钮同一个源）', () => {
    const { container } = render(<ReaderNavigation items={items} activeId={null} onNavigate={() => {}} />)
    const first = container.querySelector('button')
    expect(first?.className).toContain('novel-drawer-item')
  })

  it('空目录不渲染任何条目', () => {
    const { container } = render(<ReaderNavigation items={[]} activeId={null} onNavigate={() => {}} />)
    expect(container.textContent).toBe('')
  })
})

describe('跳转载荷', () => {
  it('点嵌套的第二小节：带着 anchorId 走，不是只传章号', () => {
    const onNavigate = vi.fn()
    render(<ReaderNavigation items={items} activeId={null} onNavigate={onNavigate} />)
    fireEvent.click(screen.getByRole('button', { name: '第二节' }))
    expect(onNavigate).toHaveBeenCalledTimes(1)
    expect(onNavigate).toHaveBeenCalledWith({ kind: 'chapter', index: 1, anchorId: 'a2' })
  })

  it('分组标题不触发导航（点不到就没有「点了没反应」的按钮）', () => {
    const onNavigate = vi.fn()
    render(<ReaderNavigation items={items} activeId={null} onNavigate={onNavigate} />)
    fireEvent.click(screen.getByText('卷一 风起'))
    expect(onNavigate).not.toHaveBeenCalled()
  })
})

describe('当前项（会话给 id，组件只打标）', () => {
  it('activeId 命中时恰好一条 aria-current', () => {
    const { container } = render(<ReaderNavigation items={items} activeId="s1" onNavigate={() => {}} />)
    const marked = container.querySelectorAll('[aria-current="true"]')
    expect(marked).toHaveLength(1)
    expect(pick([...marked], 0).textContent).toBe('第二节')
  })

  it('activeId 不在目录里（或为 null）时零 aria-current', () => {
    const a = render(<ReaderNavigation items={items} activeId={null} onNavigate={() => {}} />)
    expect(a.container.querySelectorAll('[aria-current="true"]')).toHaveLength(0)
    cleanup()
    const b = render(<ReaderNavigation items={items} activeId="不存在" onNavigate={() => {}} />)
    expect(b.container.querySelectorAll('[aria-current="true"]')).toHaveLength(0)
  })

  it('重复 id 只标第一条（「至多一条 current」是组件自己的保证，不寄望上游唯一）', () => {
    const dup: NavigationItem[] = [
      { id: 'x', label: '甲', target: { kind: 'chapter', index: 0, anchorId: null }, children: [] },
      { id: 'x', label: '乙', target: { kind: 'chapter', index: 1, anchorId: null }, children: [] },
    ]
    const { container } = render(<ReaderNavigation items={dup} activeId="x" onNavigate={() => {}} />)
    const marked = container.querySelectorAll('[aria-current="true"]')
    expect(marked).toHaveLength(1)
    expect(pick([...marked], 0).textContent).toBe('甲')
  })
})

describe('空标题兜底（书源或本地目录产空串时目录仍可读可点）', () => {
  const blankItems: NavigationItem[] = [
    { id: 't0', label: '', target: { kind: 'chapter', index: 0, anchorId: null }, children: [] },
    { id: 't1', label: '   ', target: { kind: 'chapter', index: 1, anchorId: null }, children: [] },
    {
      id: 'g0', label: '  ', target: null, children: [
        { id: 't2', label: '', target: { kind: 'chapter', index: 2, anchorId: null }, children: [] },
      ],
    },
  ]

  it('章级叶项空串 / 纯空白回退到「第 N 章」，空分组头不留空白行但保留子项', () => {
    const onNavigate = vi.fn()
    const { container } = render(<ReaderNavigation items={blankItems} activeId="t1" onNavigate={onNavigate} />)
    expect(screen.getByRole('button', { name: '第 1 章' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '第 2 章' }).getAttribute('aria-current')).toBe('true')
    expect(screen.getByRole('button', { name: '第 3 章' })).toBeTruthy()
    expect(container.querySelector('.novel-nav-group')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '第 3 章' }))
    expect(onNavigate).toHaveBeenCalledWith({ kind: 'chapter', index: 2, anchorId: null })
  })

  it('补充文档叶项空标题回退到所属分组标题（不渲染空白按钮）', () => {
    const withSupplement: NavigationItem[] = [
      {
        id: 'g0', label: '第一卷', target: null, children: [
          {
            id: 's0', label: '   ',
            target: { kind: 'supplement', documentId: 'doc-1', anchorId: 'f1' }, children: [],
          },
        ],
      },
    ]
    const onNavigate = vi.fn()
    render(<ReaderNavigation items={withSupplement} activeId={null} onNavigate={onNavigate} />)
    fireEvent.click(screen.getByRole('button', { name: '第一卷' }))
    expect(onNavigate).toHaveBeenCalledWith({ kind: 'supplement', documentId: 'doc-1', anchorId: 'f1' })
  })

  it('顶层空标题补充文档叶项兜底到「注释」，不渲染空白按钮', () => {
    const topSupplement: NavigationItem[] = [
      {
        id: 's1', label: '   ',
        target: { kind: 'supplement', documentId: 'doc-2', anchorId: null }, children: [],
      },
    ]
    const onNavigate = vi.fn()
    render(<ReaderNavigation items={topSupplement} activeId={null} onNavigate={onNavigate} />)
    fireEvent.click(screen.getByRole('button', { name: '注释' }))
    expect(onNavigate).toHaveBeenCalledWith({ kind: 'supplement', documentId: 'doc-2', anchorId: null })
  })

  it('英文环境回退到 Chapter N', () => {
    render(
      <CopyProvider value={enTranslate}>
        <ReaderNavigation items={blankItems} activeId={null} onNavigate={() => {}} />
      </CopyProvider>,
    )
    expect(screen.getByRole('button', { name: 'Chapter 1' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Chapter 2' })).toBeTruthy()
  })

  it('目录搜索过滤保留命中的祖先分组，并统计匹配数与空态', () => {
    const res = filterNavigationItems(items, '第二节', zhTranslate)
    expect(res.totalLeaves).toBe(4)
    expect(res.matchedLeaves).toBe(1)
    expect(res.items[0]?.label).toBe('卷一 风起')
    expect(res.items[0]?.children[0]?.children[0]?.label).toBe('第二节')

    const empty = filterNavigationItems(items, '不存在的章', zhTranslate)
    expect(empty.matchedLeaves).toBe(0)
    expect(empty.items).toEqual([])
    render(<ReaderNavigation items={empty.items} activeId={null} onNavigate={() => {}} emptyText="未找到匹配章节" />)
    expect(screen.getByText('未找到匹配章节')).toBeTruthy()
  })

  it('空分组自命中关键词时不留下零叶项的孤立组头', () => {
    const withEmptyGroup: NavigationItem[] = [
      { id: 'empty-g', label: '空卷 风起', target: null, children: [] },
      ...items,
    ]
    const res = filterNavigationItems(withEmptyGroup, '空卷', zhTranslate)
    expect(res.matchedLeaves).toBe(0)
    expect(res.items).toEqual([])
  })
})
