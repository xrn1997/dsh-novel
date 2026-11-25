/**
 * 摸鱼流的纯判据集：揭示步进、贴尾判定、相位推进、段落投影、节奏行分派与文件名派生。
 * 本文件不 import React——组件只接线与渲染，测试不需要 DOM。
 */

/** 流式揭示的拍长（毫秒）；配合 MOYU_TICK_CHARS 约 86 字/秒——宿主回答实测 113 tokens/s，
 * 中文 1 token ≈ 0.75 字，113 × 0.75 ≈ 85 字/秒，摸鱼流对齐这个出字速度。 */
export const MOYU_TICK_MS = 70

/** 每拍揭示的字符数（按 code point 计，切不断代理对）；速率固定，不再分档。 */
export const MOYU_TICK_CHARS = 6

/** 距尾不越过这个距离仍算「贴尾」，回底钮据此隐显；越过即脱离。 */
export const MOYU_PIN_RELEASE_PX = 40

/** 滚动几何 → 是否仍贴尾（程序置底与用户滚动都经这一处判定，阈值同源）。 */
export function isPinnedToTail(
  box: { readonly scrollTop: number; readonly scrollHeight: number; readonly clientHeight: number },
): boolean {
  return box.scrollHeight - box.scrollTop - box.clientHeight <= MOYU_PIN_RELEASE_PX
}

export type MoyuPhase = 'streaming' | 'chapter-done' | 'end'

/**
 * 揭示进度 → 流相位。total 为 0（章未到 / 空章）恒为 streaming：tick 不推进，
 * 也不许当成「章完成」去翻页——空档必须等章正文到货。
 */
export function nextPhase(revealed: number, total: number, isLastChapter: boolean): MoyuPhase {
  if (total === 0 || revealed < total) return 'streaming'
  return isLastChapter ? 'end' : 'chapter-done'
}

export interface MoyuParagraph {
  readonly text: string
  /** false = 正在揭示中的截断段。 */
  readonly done: boolean
}

/**
 * 段落行清单按已揭示字符数投影：全量段原串直出，流式段按 code point 截断
 * （emoji 等代理对不切断），空行不渲染也不计数。
 */
export function projectLines(lines: readonly string[], revealed: number): MoyuParagraph[] {
  const out: MoyuParagraph[] = []
  let used = 0
  for (const line of lines) {
    if (used >= revealed) break
    if (line === '') continue
    const remaining = revealed - used
    const units = Array.from(line)
    if (remaining >= units.length) {
      out.push({ text: line, done: true })
      used += units.length
    } else {
      out.push({ text: units.slice(0, remaining).join(''), done: false })
      used += remaining
    }
  }
  return out
}

/**
 * 摸鱼流的「执行日志」节奏规则（辉哥哥拍板的简单规则）：每 4 行的第 1 行是**正常行**
 * ——内容字号、主题主色、无任何标记；跟着的 3 行是**小字行**——小一号、浅色、行首带
 * 动作标记。标记从动作池（运行命令 / 思考 / 读取 / 编辑）确定性轮换：同一章每次打开
 * 序列一致，不闪变；周期间也在池里往前滚动，避免每个周期看起来一模一样。
 */
export function isMainLine(i: number): boolean {
  return i % 4 === 0
}

/** 小字行的动作标记池（装饰字形，不上屏文案）：运行命令 ▸、思考 »、读取 ⇣、编辑 ✎。 */
export const MOYU_ACTION_MARKS = ['▸', '»', '⇣', '✎'] as const

/** 小字行（isMainLine 为 false 的行）的动作标记：按「第几条小字行」在池里轮换；误传正常行序号时回退池首。 */
export function actionMarkFor(i: number): string {
  const nthSmall = Math.floor(i / 4) * 3 + (i % 4 - 1)
  const mark = MOYU_ACTION_MARKS[nthSmall % MOYU_ACTION_MARKS.length]
  return mark ?? MOYU_ACTION_MARKS[0]
}

/**
 * 章序（0 基）+ 章名 → 侧栏文件名：四位零垫序号 + 消毒章名 + `.ts` 后缀。
 * Windows 非法文件名字符（含换行 / 制表）折成下划线、首尾下划线剪掉，空名回退
 * `chapter`；超长按 code point 截到 32，保侧栏单行不爆。
 */
export function chapterFileName(index: number, title: string): string {
  const cleaned = title
    .trim()
    .replace(/[\\/:*?"<>|\r\n\t]+/g, '_')
    .replace(/^_+/, '')
    .replace(/_+$/, '')
  const base = cleaned === '' ? 'chapter' : cleaned
  const clipped = Array.from(base).slice(0, 32).join('')
  return `${String(index + 1).padStart(4, '0')}_${clipped}.ts`
}
