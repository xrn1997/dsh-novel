import { describe, expect, it } from 'vitest'
import { closeAll, dismissSurface, escOwner, maskFor, openSurface } from '../../src/client/reader-surfaces.js'

/**
 * 阅读浮层在场判据的钉子：「至多一角在场」与「换角时注释面板怎么退场」这两条以前散在四个
 * opener 的 `setX(false)` 抄写里，抄写一漏就让两面叠住（底下那面看得见点不动）。
 * 为什么互斥、为什么遮罩只跟两面，都写在 `src/client/reader-surfaces.ts` 头上。
 */

describe('openSurface：至多一角，同一角再点是收场', () => {
  it('开某一角时前一面退场', () => {
    expect(openSurface('toc', 'prefs')).toEqual({ surface: 'prefs', supplement: 'keep' })
  })
  it('Aa／目录／导入说明是自开关（再点同一颗就收场）', () => {
    for (const s of ['prefs', 'toc', 'importNotes'] as const) {
      expect(openSurface(s, s).surface).toBeNull()
    }
  })
  it('导出与注释面板不吃「再点收场」：它们各自的收场长在面板里', () => {
    expect(openSurface('export', 'export').surface).toBe('export')
    expect(openSurface('supplement', 'supplement').surface).toBe('supplement')
  })
  it('注释面板在同一角上换目标是换载荷，不是收场', () => {
    expect(openSurface('supplement', 'supplement').supplement).toBe('keep')
  })
})

describe('注释面板的退场语义（hide 与 consume 不是一件事）', () => {
  it('开另一角 = 只收面板：「我要看目录」不是对阅读位置的表态，不许把正文跳回引用处', () => {
    expect(openSurface('supplement', 'toc').supplement).toBe('hide')
    expect(openSurface('supplement', 'prefs').supplement).toBe('hide')
  })
  it('Esc 全收 = 走「关闭」那条语义（内链打开的会回引用处），与面板上的关闭钮同一条路', () => {
    expect(closeAll('supplement')).toEqual({ surface: null, supplement: 'consume' })
  })
  it('面板里点到主序列 = 退场但不消费返回项（那条返回项归这次跟随，由会话采与消费）', () => {
    expect(dismissSurface()).toEqual({ surface: null, supplement: 'hide' })
  })
  it('换角时不消费，Esc 时消费——两条入口不许分叉成两种「关闭」', () => {
    expect(openSurface('supplement', 'export').supplement).not.toBe(closeAll('supplement').supplement)
  })
})

describe('遮罩只跟需要「点外面关掉它」的两面', () => {
  it('Aa 与导出带遮罩；目录／注释／导入说明由自己的钮收场', () => {
    expect(maskFor('prefs')).toBe(true)
    expect(maskFor('export')).toBe(true)
    for (const s of ['toc', 'supplement', 'importNotes'] as const) expect(maskFor(s)).toBe(false)
  })
  it('无角在场就没有遮罩（不许留一层吃不掉的透明遮罩）', () => {
    expect(maskFor(null)).toBe(false)
    expect(closeAll(null)).toEqual({ surface: null, supplement: 'keep' })
  })
})

describe('escOwner：同场时 Esc 归谁', () => {
  it('模态优先；无模态时浮层；两者皆无', () => {
    expect(escOwner('toc', true)).toBe('modal')
    expect(escOwner('supplement', true)).toBe('modal')
    expect(escOwner(null, true)).toBe('modal')
    expect(escOwner('toc', false)).toBe('surface')
    expect(escOwner(null, false)).toBe('none')
  })
})
