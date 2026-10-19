/** 导航面文案：侧栏行 / 常驻状态层 / 三 tab。键前缀 `nav.`。 */
export const NAVIGATION_ZH = {
  'nav.panel': '小说',
  'nav.overlay': '小说任务状态',
  'nav.tabs.shelf': '书架',
  'nav.tabs.city': '书城',
  'nav.tabs.sources': '书源管理',
  'nav.tabs.label': '小说视图导航',
} as const

export const NAVIGATION_EN: Record<keyof typeof NAVIGATION_ZH, string> = {
  'nav.panel': 'Novel',
  'nav.overlay': 'Novel task status',
  'nav.tabs.shelf': 'Shelf',
  'nav.tabs.city': 'Discover',
  'nav.tabs.sources': 'Sources',
  'nav.tabs.label': 'Novel view navigation',
}
