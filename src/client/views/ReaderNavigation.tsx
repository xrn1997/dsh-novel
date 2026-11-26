import type { ReactNode } from 'react'
import { useCopy } from '../copy/index.js'
import type { Translate } from '../copy/index.js'
import { displayChapterTitle } from '../util.js'
import type { NavigationItem, ReadingTarget } from './types.js'

/**
 * 目录树（抽屉内容；浮层/几何/关闭都归阅读器，本组件只出条目）。
 *
 * 三条口径：
 *  ① **深度 = 结构**：缩进靠嵌套列表，不写行内像素——目录树是数据驱动的，行内值一多就没法对齐；
 *  ② **分组不伪造导航**：`target` 为 null 的条目（卷标题）渲染成不可点的组头，绝不发一个
 *     「点了没反应」的按钮；
 *  ③ **至多一条 aria-current**：当前项由会话给 id（多个条目指向同一目标时谁算当前是会话的裁决），
 *     这里只按 DFS 首个命中打标——重复 id 也不会标出第二条（现抽屉的 aria-current 是单点语义，
 *     样式 `.novel-drawer-item[aria-current="true"]` 与之同一个源）。
 */

/** 命中的**条目引用**（不是 id 字符串）：同 id 的两条里只认第一条 */
function firstActive(items: NavigationItem[], activeId: string | null): NavigationItem | null {
  if (activeId === null) return null
  for (const item of items) {
    if (item.id === activeId) return item
    const hit = firstActive(item.children, activeId)
    if (hit !== null) return hit
  }
  return null
}

/** 计算一条导航项最终展示到屏幕上的文案（与渲染严格同源，供目录搜索匹配复用）。 */
function itemLabelOf(item: NavigationItem, t: Translate, inheritedLabel: string | null): string {
  const trimmed = item.label.trim()
  const target = item.target
  if (target !== null && target.kind === 'chapter') {
    return displayChapterTitle(item.label, target.index, t)
  }
  if (trimmed !== '') return trimmed
  return target === null ? '' : (inheritedLabel ?? t('reader.notes'))
}

function countLeaves(items: NavigationItem[]): number {
  let total = 0
  for (const item of items) {
    if (item.target !== null) total += 1
    if (item.children.length > 0) total += countLeaves(item.children)
  }
  return total
}

/** 按关键词过滤目录树：保留命中章/补充文档及所需的祖先分组；空关键词原样返回并给出总条目数。 */
export function filterNavigationItems(
  items: NavigationItem[],
  query: string,
  t: Translate,
): { items: NavigationItem[]; matchedLeaves: number; totalLeaves: number } {
  const totalLeaves = countLeaves(items)
  const q = query.trim().toLowerCase()
  if (q === '') return { items, matchedLeaves: totalLeaves, totalLeaves }

  let matchedLeaves = 0
  const filterList = (list: NavigationItem[], inheritedLabel: string | null): NavigationItem[] => {
    const out: NavigationItem[] = []
    for (const item of list) {
      const label = itemLabelOf(item, t, inheritedLabel)
      const nextInherited = item.label.trim() !== '' ? item.label.trim() : inheritedLabel
      const selfMatches = label !== '' && label.toLowerCase().includes(q)
      if (item.target === null && selfMatches) {
        const leaves = countLeaves(item.children)
        if (leaves > 0) {
          matchedLeaves += leaves
          out.push(item)
        }
        continue
      }
      const filteredChildren = item.children.length > 0 ? filterList(item.children, nextInherited) : []
      if (item.target !== null && selfMatches) matchedLeaves += 1
      if ((item.target !== null && selfMatches) || filteredChildren.length > 0) {
        out.push({ ...item, children: filteredChildren })
      }
    }
    return out
  }

  const filtered = filterList(items, null)
  return { items: filtered, matchedLeaves, totalLeaves }
}

export function ReaderNavigation({ items, activeId, onNavigate, emptyText }: {
  items: NavigationItem[]
  activeId: string | null
  onNavigate: (target: ReadingTarget) => void
  emptyText?: string | undefined
}): ReactNode {
  const t = useCopy()
  if (items.length === 0) {
    return emptyText === undefined ? null : <div className="novel-toc-empty">{emptyText}</div>
  }
  const current = firstActive(items, activeId)
  return <NavList items={items} current={current} onNavigate={onNavigate} t={t} inheritedLabel={null} />
}

function NavList({ items, current, onNavigate, t, inheritedLabel }: {
  items: NavigationItem[]
  current: NavigationItem | null
  onNavigate: (target: ReadingTarget) => void
  t: Translate
  inheritedLabel: string | null
}): ReactNode {
  return (
    <ul className="novel-nav">
      {/* key 用下标而不是条目 id：id 由导入期生成、理应唯一，但「两个条目同 id」正是下面
          「至多一条 aria-current」要兜的形态——重复 React key 会静默丢条目/串身份。
          这份列表每次取数整份替换、条目自身无状态，下标是稳的。 */}
      {items.map((item, i) => (
        <NavItem key={i} item={item} current={current} onNavigate={onNavigate} t={t} inheritedLabel={inheritedLabel} />
      ))}
    </ul>
  )
}

function NavItem({ item, current, onNavigate, t, inheritedLabel }: {
  item: NavigationItem
  current: NavigationItem | null
  onNavigate: (target: ReadingTarget) => void
  t: Translate
  inheritedLabel: string | null
}): ReactNode {
  const target = item.target
  const trimmed = item.label.trim()
  const leafLabel = itemLabelOf(item, t, inheritedLabel)
  // 叶项复用抽屉既有按钮类：高亮、焦点环、省略号截断与目录同一个源
  const leaf = target === null ? null : (
    <button
      type="button"
      className="novel-drawer-item"
      aria-current={item === current ? 'true' : undefined}
      onClick={() => onNavigate(target)}
    >
      {leafLabel}
    </button>
  )
  return (
    <li>
      {leaf ?? (trimmed === '' ? null : <div className="novel-nav-group">{trimmed}</div>)}
      {item.children.length === 0 ? null : (
        <NavList
          items={item.children}
          current={current}
          onNavigate={onNavigate}
          t={t}
          inheritedLabel={trimmed !== '' ? trimmed : inheritedLabel}
        />
      )}
    </li>
  )
}
