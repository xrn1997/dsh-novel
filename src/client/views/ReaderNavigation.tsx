import type { ReactNode } from 'react'
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

export function ReaderNavigation({ items, activeId, onNavigate }: {
  items: NavigationItem[]
  activeId: string | null
  onNavigate: (target: ReadingTarget) => void
}): ReactNode {
  if (items.length === 0) return null
  const current = firstActive(items, activeId)
  return <NavList items={items} current={current} onNavigate={onNavigate} />
}

function NavList({ items, current, onNavigate }: {
  items: NavigationItem[]
  current: NavigationItem | null
  onNavigate: (target: ReadingTarget) => void
}): ReactNode {
  return (
    <ul className="novel-nav">
      {/* key 用下标而不是条目 id：id 由导入期生成、理应唯一，但「两个条目同 id」正是下面
          「至多一条 aria-current」要兜的形态——重复 React key 会静默丢条目/串身份。
          这份列表每次取数整份替换、条目自身无状态，下标是稳的。 */}
      {items.map((item, i) => (
        <NavItem key={i} item={item} current={current} onNavigate={onNavigate} />
      ))}
    </ul>
  )
}

function NavItem({ item, current, onNavigate }: {
  item: NavigationItem
  current: NavigationItem | null
  onNavigate: (target: ReadingTarget) => void
}): ReactNode {
  const target = item.target
  // 叶项复用抽屉既有按钮类：高亮、焦点环、省略号截断全与旧目录同一个源
  const leaf = target === null ? null : (
    <button
      type="button"
      className="novel-drawer-item"
      aria-current={item === current ? 'true' : undefined}
      onClick={() => onNavigate(target)}
    >
      {item.label}
    </button>
  )
  return (
    <li>
      {leaf ?? <div className="novel-nav-group">{item.label}</div>}
      {item.children.length === 0 ? null : (
        <NavList items={item.children} current={current} onNavigate={onNavigate} />
      )}
    </li>
  )
}
