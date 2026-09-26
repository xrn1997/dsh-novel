// @vitest-environment jsdom
/**
 * 浮层落位的唯一实现：`centerInScroller`。
 *
 * 它存在的理由是**不用** `scrollIntoView`：后者会一路向上滚完所有可滚祖先，于是「打开一个只读
 * 浮层」（目录抽屉 / 注释面板）改写了主阅读位置并落盘——真浏览器实测的两条缺陷同一根因，读数与
 * 记录见 docs/design/client.md「已知开口」。这里钉算式与「只碰这一个容器」；真排版几何的判据在
 * tests/browser/epub-reader.test.ts。
 */
import { describe, expect, it } from 'vitest'
import { centerInScroller } from '../../src/client/util.js'
import { rect, stubLayout } from './scroll-stub.js'

describe('centerInScroller：只滚给定那一个容器', () => {
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
    // 脚注锚点常常是一个装着好几段的容器：3066px 的目标居中在 771px 的面板里，开头被藏到视口上方
    // 一千多像素——「打开脚注」变成了「从脚注中段开始读」。装不下时露头，不露腹。
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
