import type { CopyKey } from './copy/index.js'

/** 阅读偏好 UI 常量（自 SettingsView 迁出，供阅读控制器复用） */
export const FONT_STEPS = [12, 14, 16, 18, 20, 22, 24, 26, 28]
export const LINE_HEIGHTS = [1.4, 1.6, 1.8, 2.0]
/** 正文栏宽档位（em）：中文一行约 28–44 字。默认 36em 在舒适区上沿；
 *  要「一屏装更多字」的用户往 44 走，觉得行太长往 28 走。 */
export const MEASURES: Array<{ em: number; labelKey: CopyKey }> = [
  { em: 28, labelKey: 'prefs.measure.narrow' },
  { em: 32, labelKey: 'prefs.measure.medium' },
  { em: 36, labelKey: 'prefs.measure.standard' },
  { em: 44, labelKey: 'prefs.measure.wide' },
]
export const PAPER_PRESETS: Array<{ nameKey: CopyKey; color: string }> = [
  { nameKey: 'prefs.paper.cream', color: '#f7f3e8' },
  { nameKey: 'prefs.paper.white', color: '#ffffff' },
  { nameKey: 'prefs.paper.green', color: '#e8f0e8' },
  { nameKey: 'prefs.paper.pink', color: '#f0e8e8' },
]
