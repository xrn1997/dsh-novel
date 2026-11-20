// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { watchSavebarPin } from '../../src/client/config-page.js'

/**
 * 保存条吸底的量法：`watchSavebarPin` 只在保存条**被吸住**时量缝，把宿主滚动区底部的那段
 * 内边距补进吸附位移。jsdom 没有排版，所以 rect 与计算样式都按现场钉：
 *
 *  - 卡片内容盒底边 = 卡片 rect 底边 − 底部内边距 − 底边框（条是卡片最后一个子元素）；
 *  - 条的 rect 底边高于卡片内容盒底边 = 被上移 = 吸住；
 *  - 缝 = 滚动区 padding box 底边 − 条 rect 底边，补的量最多到滚动区的底部内边距。
 */

/** jsdom 没有 DOMRect 的构造现场：只填 watcher 会读的底边。 */
function rect(bottom: number): DOMRect {
  return { top: bottom, bottom, height: 0, left: 0, right: 0, width: 0, x: 0, y: bottom, toJSON: () => ({}) }
}

interface Scene {
  scroller: HTMLDivElement
  card: HTMLDivElement
  bar: HTMLDivElement
  /** 改条的位置：最后一次写进 rect 的底边。 */
  placeBar: (bottom: number) => void
}

/** 宿主插件详情页的现场：滚动区带底部内边距，里面是卡片，条是卡片最后一个子元素。 */
function scene(options: { paddingBottom: number; cardBottom: number; barBottom: number }): Scene {
  const scroller = document.createElement('div')
  scroller.style.overflowY = 'auto'
  scroller.style.paddingBottom = `${options.paddingBottom}px`
  // jsdom 把没写边框的 border-bottom-width 算成 16px（真浏览器算 0px）：显式钉成 0，别让噪声进缝
  scroller.style.borderBottom = '0px solid transparent'
  const card = document.createElement('div')
  card.style.borderBottom = '1px solid transparent'
  const bar = document.createElement('div')
  card.append(bar)
  scroller.append(card)
  document.body.append(scroller)

  vi.spyOn(scroller, 'getBoundingClientRect').mockReturnValue(rect(500))
  vi.spyOn(card, 'getBoundingClientRect').mockReturnValue(rect(options.cardBottom + 1))
  let barBottom = options.barBottom
  vi.spyOn(bar, 'getBoundingClientRect').mockImplementation(() => rect(barBottom))
  return {
    scroller,
    card,
    bar,
    placeBar: (bottom) => { barBottom = bottom },
  }
}

const pinValue = (bar: HTMLElement): string => bar.style.getPropertyValue('--novel-cfg-pin')

afterEach(() => {
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

describe('保存条吸底：补掉宿主滚动区底部的内边距', () => {
  it('吸住时写负 bottom：条离可视底边还差 48px，就补 48px', () => {
    // 卡片内容盒底边 600；条被上移到 452（吸住）；滚动区可视底边 500 → 缝 48
    const s = scene({ paddingBottom: 48, cardBottom: 600, barBottom: 452 })
    watchSavebarPin(s.bar, s.card)
    expect(pinValue(s.bar)).toBe('-48px')
  })

  it('静止在卡片末尾时不动；滚到吸住后才补', () => {
    const s = scene({ paddingBottom: 48, cardBottom: 600, barBottom: 600 })
    watchSavebarPin(s.bar, s.card)
    expect(pinValue(s.bar), '条还躺在卡片末尾，没吸住').toBe('')
    s.placeBar(452)
    s.scroller.dispatchEvent(new Event('scroll'))
    expect(pinValue(s.bar), '吸住后应补上这段缝').toBe('-48px')
  })

  it('按 padding box 吸底的引擎（缝是 0）不补', () => {
    // 条吸在滚动区 padding box 底边（500），缝为 0：再补就把条推出可视区了
    const s = scene({ paddingBottom: 48, cardBottom: 600, barBottom: 500 })
    watchSavebarPin(s.bar, s.card)
    expect(pinValue(s.bar)).toBe('')
    // 已结算：再动也不补
    s.placeBar(400)
    s.scroller.dispatchEvent(new Event('scroll'))
    expect(pinValue(s.bar)).toBe('')
  })

  it('没有滚动祖先（页面内嵌的静态渲染）时静默', () => {
    const card = document.createElement('div')
    const bar = document.createElement('div')
    card.append(bar)
    document.body.append(card)
    expect(() => watchSavebarPin(bar, card)).not.toThrow()
    expect(pinValue(bar)).toBe('')
  })
})