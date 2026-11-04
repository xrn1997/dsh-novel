import type { CopyKey } from './copy/index.js'

/** 阅读偏好档位常量：ReaderView 控制器与 Aa 面板的档位单点 */
export const FONT_STEPS = [12, 14, 16, 18, 20, 22, 24, 26, 28]
export const LINE_HEIGHTS = [1.4, 1.6, 1.8, 2.0]
/** 正文列宽档位（em），窄到宽四档：要「一屏装更多字」的用户往 44 走，
 *  觉得行太长往 28 走；默认取标准档 36em。 */
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
