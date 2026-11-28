import type { CopyKey } from './copy/index.js'
import type { MoyuReveal, MoyuStyle, PageAnimation, PageColumns, ReadingMode } from './store.js'

/** 阅读偏好档位常量：ReaderView 控制器与 Aa 面板的档位单点 */
export const FONT_STEPS = [12, 14, 16, 18, 20, 22, 24, 26, 28]
export const LINE_HEIGHT_RANGE = { min: 1.4, max: 2.2, step: 0.1 } as const
export const READING_MODES: Array<{ value: ReadingMode; labelKey: CopyKey }> = [
  { value: 'scroll', labelKey: 'prefs.readingMode.scroll' },
  { value: 'page', labelKey: 'prefs.readingMode.page' },
  { value: 'moyu', labelKey: 'prefs.readingMode.moyu' },
]
export const MOYU_STYLES: Array<{ value: MoyuStyle; labelKey: CopyKey }> = [
  { value: 'dsh', labelKey: 'prefs.moyuStyle.dsh' },
  { value: 'compact', labelKey: 'prefs.moyuStyle.compact' },
  { value: 'clean', labelKey: 'prefs.moyuStyle.clean' },
]
export const MOYU_REVEALS: Array<{ value: MoyuReveal; labelKey: CopyKey }> = [
  { value: 'stream', labelKey: 'prefs.moyuReveal.stream' },
  { value: 'instant', labelKey: 'prefs.moyuReveal.instant' },
]
export const PAGE_COLUMNS: Array<{ value: PageColumns; labelKey: CopyKey }> = [
  { value: 'auto', labelKey: 'prefs.pageColumns.auto' },
  { value: 'single', labelKey: 'prefs.pageColumns.single' },
  { value: 'double', labelKey: 'prefs.pageColumns.double' },
]
export const PAGE_ANIMATIONS: Array<{ value: PageAnimation; labelKey: CopyKey }> = [
  { value: 'flip', labelKey: 'prefs.pageAnimation.flip' },
  { value: 'slide', labelKey: 'prefs.pageAnimation.slide' },
  { value: 'none', labelKey: 'prefs.pageAnimation.none' },
]
/** 正文列宽档位（固定 px，与字号解耦），窄到宽四档；默认取标准档 680px。 */
export const MEASURES: Array<{ px: number; labelKey: CopyKey }> = [
  { px: 520, labelKey: 'prefs.measure.narrow' },
  { px: 600, labelKey: 'prefs.measure.medium' },
  { px: 680, labelKey: 'prefs.measure.standard' },
  { px: 820, labelKey: 'prefs.measure.wide' },
]
export const PAPER_PRESETS: Array<{ nameKey: CopyKey; color: string }> = [
  { nameKey: 'prefs.paper.cream', color: '#f7f3e8' },
  { nameKey: 'prefs.paper.white', color: '#ffffff' },
  { nameKey: 'prefs.paper.green', color: '#e8f0e8' },
  { nameKey: 'prefs.paper.pink', color: '#f0e8e8' },
  { nameKey: 'prefs.paper.night', color: '#111315' },
]
