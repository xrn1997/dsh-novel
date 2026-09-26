/**
 * 落位类用例的共用替身：jsdom 无排版引擎，也**没有** `scrollIntoView`（生产代码对它做存在性守卫）。
 *
 * 这里把「谁被滚了」变成可读数：视口几何由用例按元素给（`geometry`，没给 = 零矩形 = 无位移），
 * 每一次 `scrollTop` 写入与每一次 `scrollIntoView` 调用都记录下来。浮层缺陷的根因恰是「调了那个
 * 会连可滚祖先一起滚的 API」，所以 API 选择在 jsdom 这一层就是可钉的；真排版几何与「主阅读位置
 * 有没有被改」的判据在 tests/browser/epub-reader.test.ts。
 */
import { vi } from 'vitest'

export interface ViewportRect { top: number; height: number }

/** 用例写几何用的构造器（DOMRect 的其余字段本仓的落位算式不读） */
export function rect(top: number, height: number): DOMRect {
  return { top, height, bottom: top + height, left: 0, right: 0, width: 10, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
}

export interface LayoutStub {
  /** 每次 scrollTop 写入（被谁、写到几） */
  scrolls: Array<{ el: Element; to: number }>
  /** 每次 scrollIntoView 调用（在哪个元素上）——浮层落位不该出现在这里 */
  into: Element[]
  restore: () => void
}

export function stubLayout(geometry: (el: Element) => DOMRect | null): LayoutStub {
  const scrolls: Array<{ el: Element; to: number }> = []
  const into: Element[] = []
  const proto = Element.prototype as unknown as { scrollIntoView?: (this: Element, arg?: unknown) => void }
  const hadInto = proto.scrollIntoView !== undefined
  const originalInto = proto.scrollIntoView
  proto.scrollIntoView = function (this: Element): void { into.push(this) }
  const rectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect')
    .mockImplementation(function (this: Element): DOMRect { return geometry(this) ?? rect(0, 0) })
  const topSpy = vi.spyOn(Element.prototype, 'scrollTop', 'set')
    .mockImplementation(function (this: Element, v: number): void { scrolls.push({ el: this, to: v }) })
  return {
    scrolls,
    into,
    restore: () => {
      topSpy.mockRestore()
      rectSpy.mockRestore()
      if (!hadInto) delete proto.scrollIntoView
      else proto.scrollIntoView = originalInto
    },
  }
}
