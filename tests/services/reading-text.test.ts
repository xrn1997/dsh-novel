import { describe, expect, it } from 'vitest'
import { normalizeChapterText } from '../../src/services/reading.js'

/**
 * `normalizeChapterText` 的三条口径（`reading.ts` 的注释也这么写）此前**没有直接钉子**——
 * 它只被 `getChapter` 间接走到，而它塑造的是**每一章**的文字输出（正文/导出/工具三面同源）。
 * 早前的登记笔记把它记成「注释自称供测试/复用但无测试 import」，本文件把那句话兑现。
 */
describe('normalizeChapterText（逐行 trim → 去首尾空行 → 相邻空行折叠一个）', () => {
  it('逐行 trim：行首行尾空白（含 CRLF 的 \\r）都去掉，行内空白保留', () => {
    expect(normalizeChapterText('  甲  \r\n\t乙\t\n丙')).toBe('甲\n乙\n丙')
    expect(normalizeChapterText('甲  乙')).toBe('甲  乙')          // 行内空白不动
  })

  it('去首尾空行（纯空白行也算空）', () => {
    expect(normalizeChapterText('\n\n  \n甲\n乙\n \n\n')).toBe('甲\n乙')
  })

  it('相邻空行折叠成**一个**（段间空行保留，不是全删）', () => {
    expect(normalizeChapterText('甲\n\n\n\n乙')).toBe('甲\n\n乙')
    expect(normalizeChapterText('甲\n\n乙')).toBe('甲\n\n乙')       // 本来就一个 → 不动
  })

  it('全空白 / 空串 → 空串（不吐换行残渣）', () => {
    expect(normalizeChapterText('')).toBe('')
    expect(normalizeChapterText('   \n\n\r\n  ')).toBe('')
  })

  it('幂等：再过一遍零改动（导出/TXT 链路会重复过手）', () => {
    const once = normalizeChapterText('\n 甲 \n\n\n 乙\t\n\n')
    expect(normalizeChapterText(once)).toBe(once)
  })
})
