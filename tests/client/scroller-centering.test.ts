// @vitest-environment jsdom
/**
 * 浮层落位的唯一实现：`centerInScroller` 与跟读跟随的 `revealInScroller`。
 *
 * 它存在的理由是**不用** `scrollIntoView`：后者会一路向上滚完所有可滚祖先，于是「打开一个只读
 * 浮层」（目录抽屉 / 注释面板）会改写主阅读位置并落盘。
 * 这里钉算式与「只碰这一个容器」；真排版几何的判据在
 * tests/browser/epub-reader.test.ts。
 */
import { describe, expect, it } from 'vitest'
import { centerInScroller, revealInScroller } from '../../src/client/util.js'
import { rect, stubLayout } from './scroll-stub.js'

/** 一个容器 + 里面一个目标；geometry 只给这两个元素的视口盒 */
function scene(boxTop: number, boxHeight: number, itemTop: number, itemHeight: number) {
  const scroller = document.createElement('div')
  const ancestor = document.createElement('div')
  const item = document.createElement('p')
  scroller.appendChild(item)
  ancestor.appendChild(scroller)
  const stub = stubLayout((el) => el === scroller ? rect(boxTop, boxHeight)
    : el === item ? rect(itemTop, itemHeight) : null)
  return { scroller, ancestor, item, stub }
}

describe('centerInScroller：只滚给定那一个容器', () => {
  it('位移 = 目标中心与容器中心之差（正值 = 往下滚）', () => {
    const { scroller, item, stub } = scene(0, 400, 500, 20)                        // 510 − 200
    centerInScroller(scroller, item)
    expect(stub.scrolls).toEqual([{ el: scroller, to: 310 }])
    stub.restore()
  })

  it('目标在容器中心之上 → 负增量（往回滚，不夹成 0）', () => {
    const { scroller, item, stub } = scene(0, 400, -1000, 20)                      // −990 − 200
    centerInScroller(scroller, item)
    expect(stub.scrolls).toEqual([{ el: scroller, to: -1190 }])
    stub.restore()
  })

  it('目标已经居中：一次写入都不发（不制造无谓的 scroll 事件）', () => {
    const { scroller, item, stub } = scene(0, 400, 190, 20)                        // 中心同为 200
    centerInScroller(scroller, item)
    expect(stub.scrolls).toEqual([])
    stub.restore()
  })

  it('目标比容器还高：顶对齐（居中会把它的开头推到视口上方）', () => {
    // 脚注锚点常常是一个装着好几段的容器：目标比容器高时居中会把开头推到视口上方——「打开脚注」
    // 变成了「从脚注中段开始读」。装不下时露头，不露腹。
    const { scroller, item, stub } = scene(0, 400, 1200, 3000)
    centerInScroller(scroller, item)
    expect(stub.scrolls).toEqual([{ el: scroller, to: 1200 }])
    stub.restore()
  })

  it('目标缺席（锚点还没渲染出来）：什么都不做', () => {
    const { scroller, stub } = scene(0, 400, 500, 20)
    centerInScroller(scroller, null)
    expect(stub.scrolls).toEqual([])
    stub.restore()
  })

  it('祖先容器一次都不被写，且全程不调 scrollIntoView', () => {
    const { scroller, ancestor, item, stub } = scene(0, 400, 900, 20)
    centerInScroller(scroller, item)
    expect(stub.scrolls).toEqual([{ el: scroller, to: 710 }])
    expect(stub.scrolls.some((w) => w.el === ancestor), '只读浮层不得改写主阅读位置——祖先被滚就是那条缺陷')
      .toBe(false)
    expect(stub.into, 'scrollIntoView 会连可滚祖先一起滚，落位不该用它').toEqual([])
    stub.restore()
  })
})

describe('revealInScroller：跟随只在目标离开可视带时补一次', () => {
  it('目标已在带内：一次都不滚', () => {
    const { scroller, item, stub } = scene(0, 600, 100, 20)
    revealInScroller(scroller, item, 40, 100)                                       // 带 = 40..500
    expect(stub.scrolls).toEqual([])
    stub.restore()
  })

  it('目标在带下方 / 上方：居中，只写给定容器', () => {
    const below = scene(0, 600, 520, 20)
    revealInScroller(below.scroller, below.item, 40, 100)                           // 带中心 270
    expect(below.stub.scrolls).toEqual([{ el: below.scroller, to: 260 }])
    below.stub.restore()

    const above = scene(0, 600, -100, 20)
    revealInScroller(above.scroller, above.item, 40, 100)
    expect(above.stub.scrolls).toEqual([{ el: above.scroller, to: -360 }])
    above.stub.restore()
  })

  it('底界按听书条高度扣掉：条形高度内的目标也算离开带', () => {
    const { scroller, item, stub } = scene(0, 600, 480, 30)                       // 480..510，带底 500
    revealInScroller(scroller, item, 40, 100)
    expect(stub.scrolls).toEqual([{ el: scroller, to: 225 }])
    stub.restore()
  })

  it('目标比带还高：露头（不把开头推到带上方）', () => {
    const { scroller, item, stub } = scene(0, 600, 100, 700)
    revealInScroller(scroller, item, 40, 100)                                       // 带高 460，目标 700
    expect(stub.scrolls).toEqual([{ el: scroller, to: 60 }])                      // 100 − 40
    stub.restore()
  })

  it('目标缺席：什么都不做', () => {
    const { scroller, stub } = scene(0, 600, 100, 20)
    revealInScroller(scroller, null, 40, 100)
    expect(stub.scrolls).toEqual([])
    stub.restore()
  })
})
