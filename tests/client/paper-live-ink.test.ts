import { describe, expect, it } from 'vitest'
import { paperInk, paperLiveInk } from '../../src/client/util.js'
import { TOKENS_CSS } from '../../src/client/styles/tokens.js'

/**
 * 跟读高亮的字色由纸色现算（`ADR-0076`）：纸色是用户自选的，固定一个 hex 会在某些纸上
 * 跟正文墨色糊在一起。这里的断言只量两件可量的事——**读得清**（与纸面对比度）与
 * **分得出**（与正文墨色的 CIE76 色差）；具体色相归实现，不进断言。
 */

type Rgb = [number, number, number]

function rgbOf(hex: string): Rgb {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex)
  if (m === null || m[1] === undefined) throw new Error(`不是 hex：${hex}`)
  const digits = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1]
  const n = parseInt(digits, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function linear(v: number): number {
  const c = v / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

function luminance(hex: string): number {
  const [r, g, b] = rgbOf(hex)
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05)
}

function lab(hex: string): [number, number, number] {
  const [r, g, b] = rgbOf(hex).map(linear) as Rgb
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b
  const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883
  const f = (t: number): number => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116)
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))]
}

function deltaE(a: string, b: string): number {
  const [l1, a1, b1] = lab(a)
  const [l2, a2, b2] = lab(b)
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2)
}

const PRESETS = ['#f7f3e8', '#ffffff', '#e8f0e8', '#f0e8e8']
const DARKS = ['#1e1e1e', '#111', '#333333']
const READABLE = 5.5

describe('paperLiveInk：纸色 → 跟读字色（离墨最远且够读）', () => {
  it('四款预设纸：与纸面对比度 ≥ 5.5:1，与正文墨色色差 ≥ 30', () => {
    for (const paper of PRESETS) {
      const live = paperLiveInk(paper)
      expect(contrast(live, paper), `${paper} 上的跟读色读得清`).toBeGreaterThanOrEqual(READABLE - 0.01)
      expect(deltaE(live, paperInk(paper)), `${paper} 上跟读色与正文分得出`).toBeGreaterThanOrEqual(30)
      expect(live, `${paper} 上跟读色不是正文墨色`).not.toBe(paperInk(paper))
    }
  })

  it('深纸：跟读色落在浅色一侧，对比度 ≥ 5.5:1，色差 ≥ 30', () => {
    for (const paper of DARKS) {
      const live = paperLiveInk(paper)
      expect(luminance(live), `${paper} 上跟读色比纸亮`).toBeGreaterThan(luminance(paper))
      expect(contrast(live, paper), `${paper} 上的跟读色读得清`).toBeGreaterThanOrEqual(READABLE - 0.01)
      expect(deltaE(live, paperInk(paper)), `${paper} 上跟读色与正文分得出`).toBeGreaterThanOrEqual(30)
    }
  })

  it('颜色跟着纸走：预设纸与深纸不是同一个 hex（不是钉死的固定色）', () => {
    const colors = new Set([...PRESETS, ...DARKS].map((paper) => paperLiveInk(paper)))
    expect(colors.size, '每款纸都算出各自的跟读色').toBeGreaterThanOrEqual(4)
    expect(paperLiveInk('#f7f3e8')).not.toBe(paperLiveInk('#1e1e1e'))
  })

  it('3 位 hex / 大小写 / 首尾空白与展开后一致；非 hex 按默认纸算', () => {
    expect(paperLiveInk(' #FFF ')).toBe(paperLiveInk('#ffffff'))
    expect(paperLiveInk('#123')).toBe(paperLiveInk('#112233'))
    expect(paperLiveInk('rgb(10, 10, 10)')).toBe(paperLiveInk('#f7f3e8'))
    expect(paperLiveInk('')).toBe(paperLiveInk('#f7f3e8'))
  })

  it('token 缺省值与默认纸同源：CSS 兜底不会跟函数漂开', () => {
    const m = /--novel-live-ink:\s*(#[0-9a-f]{6})/i.exec(TOKENS_CSS)
    expect(m?.[1], 'token 里写出缺省跟读色').toBeDefined()
    expect(m?.[1]).toBe(paperLiveInk('#f7f3e8'))
  })

  it('网格：任何纸色下都不低于正文自己的对比度，且不把正文反色', () => {
    const papers: string[] = []
    for (const r of [0x00, 0x55, 0xaa, 0xff]) {
      for (const g of [0x00, 0x55, 0xaa, 0xff]) {
        for (const b of [0x00, 0x55, 0xaa, 0xff]) {
          papers.push(`#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`)
        }
      }
    }
    // 中灰与深色饱和纸是这套规则最难的角落：正文自己的对比度就掉到 5.5 以下，下限跟着正文走。
    // 这里只断言「读得清、不反色、不撞正文墨色」三件可量的事；色差在这些角落会窄到个位数，
    // 「一眼认得出」不在色差这条腿上——归段首三角补位（ADR-0076），不在本网格的断言里。
    papers.push('#777777', '#808080', '#9a9a9a', '#a03030', '#5a4a20', '#204030')
    for (const paper of papers) {
      const live = paperLiveInk(paper)
      expect(live, `${paper} 算出一个 hex`).toMatch(/^#[0-9a-f]{6}$/)
      const body = contrast(paperInk(paper), paper)
      expect(contrast(live, paper), `${paper} 上不比正文更弱`)
        .toBeGreaterThanOrEqual(Math.min(READABLE, body) - 0.01)
      const side = (luminance(live) - luminance(paper)) * (luminance(paperInk(paper)) - luminance(paper))
      expect(side, `${paper} 上与正文同一侧（不反色）`).toBeGreaterThan(0)
      expect(live, `${paper} 上不是正文墨色`).not.toBe(paperInk(paper))
    }
  })
})