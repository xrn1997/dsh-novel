/**
 * 翻页模式纯几何与页码计算：零 DOM、零 React，方便单测钉死所有边界。
 *
 * 布局规则（自适应单/双页）：
 * - 容器可用宽度 ≥ DOUBLE_PAGE_MIN_WIDTH（860px）→ 双页摊开（2 栏 + 书脊中缝）
 * - 容器可用宽度 < 860px → 单页翻页（1 栏）
 *
 * CSS multi-column 坐标系：
 * - 单栏宽 `columnWidth`，栏间距 `columnGap`，每栏步进 `columnStep = columnWidth + columnGap`
 * - 每屏展示 `columnsPerSpread` 栏，每屏翻页步进 `stride = columnsPerSpread * columnStep`
 * - 第 s 屏（0 基）对应水平位移 `translateX(-s * stride)`
 */

export const DOUBLE_PAGE_MIN_WIDTH = 860
export const SINGLE_PAGE_GAP = 32
export const DOUBLE_PAGE_GAP = 64

export interface SpreadLayout {
  columnsPerSpread: 1 | 2
  columnWidth: number
  columnGap: number
  contentWidth: number
  stride: number
}

export interface PageCount {
  totalColumns: number
  totalSpreads: number
}

export type ClickZone = 'prev' | 'center' | 'next'

export interface ParagraphHorizontalSpan {
  paragraphIndex: number
  left: number
  right: number
}

/** 按当前舞台可用宽度与排版参数（栏宽 em、字号 px）计算单/双页几何。 */
export function computeSpreadLayout(stageWidth: number, measureEm: number, fontSize: number): SpreadLayout {
  const safeStage = Math.max(240, Math.floor(stageWidth))
  const safeEm = Math.max(16, measureEm)
  const safeFont = Math.max(10, fontSize)
  const isDouble = safeStage >= DOUBLE_PAGE_MIN_WIDTH
  if (isDouble) {
    const columnGap = DOUBLE_PAGE_GAP
    // 双页上限按「两栏 measure + 书脊中缝」收住，避免超宽屏把行拉得过长
    const maxBookWidth = Math.round(safeEm * safeFont * 2 + columnGap)
    const contentWidth = Math.max(480, Math.min(safeStage, maxBookWidth))
    const columnWidth = Math.max(200, Math.floor((contentWidth - columnGap) / 2))
    const alignedContent = columnWidth * 2 + columnGap
    const stride = (columnWidth + columnGap) * 2
    return { columnsPerSpread: 2, columnWidth, columnGap, contentWidth: alignedContent, stride }
  }
  const columnGap = SINGLE_PAGE_GAP
  const maxSingleWidth = Math.round(safeEm * safeFont)
  const contentWidth = Math.max(240, Math.min(safeStage, maxSingleWidth))
  const columnWidth = contentWidth
  const stride = columnWidth + columnGap
  return { columnsPerSpread: 1, columnWidth, columnGap, contentWidth, stride }
}

/** 按多栏轨道的 scrollWidth 推算总栏数与总屏数（至少 1 页）。 */
export function computePageCount(
  scrollWidth: number,
  columnWidth: number,
  columnGap: number,
  columnsPerSpread: 1 | 2,
): PageCount {
  const step = columnWidth + columnGap
  if (step <= 0 || scrollWidth <= columnWidth + 2) {
    return { totalColumns: 1, totalSpreads: 1 }
  }
  // 留 2px 亚像素容差，避免浏览器舍入误差凭空多出一页空白
  const totalColumns = Math.max(1, Math.round((scrollWidth + columnGap - 2) / step))
  const totalSpreads = Math.max(1, Math.ceil(totalColumns / columnsPerSpread))
  return { totalColumns, totalSpreads }
}

/** 把章内比例（0..1）映射到合法屏号（0..totalSpreads-1）。 */
export function spreadForRatio(ratio: number, totalSpreads: number): number {
  if (totalSpreads <= 1 || !Number.isFinite(ratio)) return 0
  const clamped = Math.max(0, Math.min(0.999999, ratio))
  return Math.min(totalSpreads - 1, Math.floor(clamped * totalSpreads))
}

/** 把当前屏号折算回章内比例（0..1，严格 < 1，与服务端 progress 口径兼容）。 */
export function ratioForSpread(spreadIndex: number, totalSpreads: number): number {
  if (totalSpreads <= 1) return 0
  const clamped = Math.max(0, Math.min(totalSpreads - 1, spreadIndex))
  return clamped / totalSpreads
}

/** 把目标元素在多栏轨道中的左偏移（px）折算成所在屏号。 */
export function spreadForElementLeft(elementLeftInTrack: number, stride: number, totalSpreads: number): number {
  if (totalSpreads <= 1 || stride <= 0 || !Number.isFinite(elementLeftInTrack)) return 0
  // 加 4px 容差防止元素恰落在栏边缘因亚像素抖动被判到前一屏
  const idx = Math.floor(Math.max(0, elementLeftInTrack + 4) / stride)
  return Math.max(0, Math.min(totalSpreads - 1, idx))
}

/** 把用户点击的横向坐标分成三区：左 30% 上一页、右 30% 下一页、中 40% 留给阅读/选词/点链接。 */
export function classifyClickZone(clientX: number, rectLeft: number, rectWidth: number): ClickZone {
  if (rectWidth <= 0) return 'center'
  const ratio = (clientX - rectLeft) / rectWidth
  if (ratio < 0.3) return 'prev'
  if (ratio > 0.7) return 'next'
  return 'center'
}

/** 当前屏对应的 1 基页码范围（单页为 single，双页且本屏有两栏时为 range）。 */
export function pageRangeOfSpread(
  spreadIndex: number,
  columnsPerSpread: 1 | 2,
  totalColumns: number,
): { from: number; to: number; total: number } {
  const safeTotal = Math.max(1, totalColumns)
  const first = Math.min(safeTotal, Math.max(0, spreadIndex) * columnsPerSpread + 1)
  const last = Math.min(safeTotal, first + columnsPerSpread - 1)
  return { from: first, to: last, total: safeTotal }
}

/** 找出当前屏可见水平窗口 `[viewLeft, viewRight]` 内的第一段（供翻页模式下「从当前页起播」使用）。 */
export function firstParagraphInSpread(
  spans: ReadonlyArray<ParagraphHorizontalSpan>,
  spreadIndex: number,
  stride: number,
  contentWidth: number,
): number {
  if (spans.length === 0 || stride <= 0 || contentWidth <= 0) return 0
  const viewLeft = Math.max(0, spreadIndex) * stride
  const viewRight = viewLeft + contentWidth
  let best: number | null = null
  let fallback: number | null = null
  for (const s of spans) {
    if (s.right > viewLeft + 4 && s.left < viewRight - 4) {
      if (best === null || s.paragraphIndex < best) best = s.paragraphIndex
    } else if (s.left <= viewLeft + 4) {
      if (fallback === null || s.paragraphIndex > fallback) fallback = s.paragraphIndex
    }
  }
  return best ?? fallback ?? spans[0]?.paragraphIndex ?? 0
}
