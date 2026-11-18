// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PROD_HOST } from '../../src/client/reader-binding.js'

/**
 * 生产 DOM 平台缝的接线（`PROD_HOST`）：三个视口来源（scroll / resize / 内容尺寸变化）各归其位，
 * 卸载会真的摘干净。绑定的**判据**在 `reader-binding.test.ts` 用注入的假 host 钉，不起 DOM；
 * 这一条只钉「真 document / window / ResizeObserver 上装的是哪些监听」——把 capture 去掉、把
 * ResizeObserver 的观察点删掉，别处不会红，这里会。
 */

/** 假 ResizeObserver：记观察点、留回调；`disconnect` 之后的触发不再回调（与真实现同口径）。 */
function fakeResizeObserver(): { observed: Element[]; trigger: () => void } {
  const observed: Element[] = []
  let notify: () => void = () => {}
  let alive = true
  class FakeResizeObserver {
    constructor(cb: () => void) { notify = cb }
    observe(target: Element): void { observed.push(target) }
    disconnect(): void { alive = false }
  }
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  return {
    observed,
    trigger: () => { if (alive) notify() },
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('ReaderBindingHost 的生产实现（真 DOM 上的接线）', () => {
  it('三来源各归其位：scroll 按捕获收、resize 与内容尺寸变化都按「布局变了」', () => {
    const body = document.createElement('div')
    const inner = document.createElement('span')
    body.appendChild(inner)
    document.body.appendChild(body)
    const ro = fakeResizeObserver()
    const scroll = vi.fn()
    const layout = vi.fn()

    const off = PROD_HOST.listenViewport({ scroll, layout }, body)
    // 滚动不冒泡：只有 document 上的捕获监听才收得到子元素发出的 scroll
    inner.dispatchEvent(new Event('scroll'))
    expect(scroll).toHaveBeenCalledTimes(1)
    expect(layout).not.toHaveBeenCalled()

    window.dispatchEvent(new Event('resize'))
    expect(layout).toHaveBeenCalledTimes(1)
    ro.trigger()                                   // 内容尺寸变化不经 window resize
    expect(layout).toHaveBeenCalledTimes(2)
    expect(ro.observed, '观察点是正文层容器：它变高才代表布局变了').toEqual([body])

    off()                                          // 卸载即摘：三个来源一起摘
    inner.dispatchEvent(new Event('scroll'))
    window.dispatchEvent(new Event('resize'))
    ro.trigger()
    expect(scroll).toHaveBeenCalledTimes(1)
    expect(layout).toHaveBeenCalledTimes(2)
  })

  it('没有正文层容器时不起观察：不构造 ResizeObserver', () => {
    const constructed = vi.fn()
    vi.stubGlobal('ResizeObserver', class {
      constructor() { constructed() }
      observe(): void { /* 不该被调到 */ }
      disconnect(): void { /* 同上 */ }
    })
    const off = PROD_HOST.listenViewport({ scroll: () => {}, layout: () => {} }, null)
    expect(constructed).not.toHaveBeenCalled()
    off()
  })
})