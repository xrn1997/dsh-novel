import { describe, expect, it } from 'vitest'
import { paperInk } from '../../src/client/util.js'

/**
 * 正文层字色择选：纸张色由 prefs 固定、永不接宿主 token，故字色必须**由纸张色算**
 * ——写死深色字在自选深色纸上等于隐形。按感知亮度（WCAG 线性化 + Rec.709 权重）择一，
  * 阈值 0.35 两侧都够对比。住 util.ts 纯函数，改阈值先看这里的四款预设纸。
 */
describe('paperInk：纸张色 → 字色（感知亮度）', () => {
  it('深纸 → 浅字（#e8e8ea）', () => {
    expect(paperInk('#1a1a1a')).toBe('#e8e8ea')
    expect(paperInk('#000000')).toBe('#e8e8ea')
  })

  it('浅纸 → 深字（#222）——四款预设纸全在深字侧', () => {
    expect(paperInk('#ffffff')).toBe('#222')
    expect(paperInk('#f7f3e8')).toBe('#222')   // 米黄（默认纸）
    expect(paperInk('#e8f0e8')).toBe('#222')   // 淡绿
    expect(paperInk('#f0e8e8')).toBe('#222')   // 淡粉
  })

  it('3 位 hex 展开后按同一公式判定（#fff / #000）', () => {
    expect(paperInk('#fff')).toBe('#222')
    expect(paperInk('#000')).toBe('#e8e8ea')
    expect(paperInk('#123')).toBe('#e8e8ea')   // #112233：深蓝 → 浅字
  })

  it('非 hex（color input 也可能给 rgb()）→ 回退 #222（原行为）', () => {
    expect(paperInk('rgb(10, 10, 10)')).toBe('#222')
    expect(paperInk('')).toBe('#222')
    expect(paperInk('#12345')).toBe('#222')    // 非法长度不硬猜
  })

  it('灰度阈值边界：L=0.35 是分水岭——#a0a0a0 恰在上、#9f9f9f 恰在下', () => {
    // 手算：lin(160/255)≈0.3515 > 0.35 → 深字；lin(159/255)≈0.3467 < 0.35 → 浅字
    expect(paperInk('#a0a0a0')).toBe('#222')
    expect(paperInk('#9f9f9f')).toBe('#e8e8ea')
  })

  it('大小写与首尾空白容错', () => {
    expect(paperInk('  #FFF  ')).toBe('#222')
    expect(paperInk('#F7F3E8')).toBe('#222')
  })
})
