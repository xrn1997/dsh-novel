// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PROD_HOST } from '../../src/client/reader-binding.js'

/**
 * 生产 DOM 平台缝的接线（`PROD_HOST`）：视口来源（scroll / resize / 内容尺寸变化）各归其位，
 * 用户滚动意图单独上报，卸载会真的摘干净。绑定的**判据**在 `reader-binding.test.ts` 用注入的
 * 假 host 钉，不起 DOM；这一条只钉「真 document / window / ResizeObserver 上装的是哪些监听」——
 * 把 capture 去掉、把 ResizeObserver 的观察点删掉、把意图判据退回只看交互控件，别处不会红，这里会。
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
  it('视口来源各归其位，用户滚动意图单独上报：程序滚动不冒充用户意图', () => {
    const body = document.createElement('div')
    const inner = document.createElement('span')
    body.appendChild(inner)
    document.body.appendChild(body)
    const outside = document.createElement('div')
    const outsideItem = document.createElement('span')
    outside.appendChild(outsideItem)
    document.body.appendChild(outside)
    const ro = fakeResizeObserver()
    const scroll = vi.fn()
    const layout = vi.fn()
    const intent = vi.fn()

    const off = PROD_HOST.listenViewport({ scroll, layout, intent }, body)
    // 滚动不冒泡：只有 document 上的捕获监听才收得到子元素发出的 scroll
    inner.dispatchEvent(new Event('scroll'))
    expect(scroll).toHaveBeenCalledTimes(1)
    expect(layout).not.toHaveBeenCalled()
    expect(intent, 'scroll 本身不算用户意图（程序写入也会发 scroll）').not.toHaveBeenCalled()

    inner.dispatchEvent(new Event('wheel', { bubbles: true }))
    expect(intent).toHaveBeenCalledTimes(1)
    outsideItem.dispatchEvent(new Event('wheel', { bubbles: true }))
    expect(intent, '正文层外的滚轮不夺走跟随').toHaveBeenCalledTimes(1)
    inner.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
    expect(intent, '滚动键算用户意图').toHaveBeenCalledTimes(2)
    const button = document.createElement('button')
    body.appendChild(button)
    button.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
    expect(intent, '交互控件上的空格归控件，不算滚动').toHaveBeenCalledTimes(2)
    const link = document.createElement('a')
    link.href = '#note'
    body.appendChild(link)
    link.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true }))
    expect(intent, '链接上的 PageDown 仍滚正文，必须算接管').toHaveBeenCalledTimes(3)
    link.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
    expect(intent, '链接上的空格归链接').toHaveBeenCalledTimes(3)
    button.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true }))
    expect(intent, '按钮只消费空格 / Enter，PageDown 不归它').toHaveBeenCalledTimes(4)
    const panel = document.createElement('div')
    panel.style.overflowY = 'auto'
    Object.defineProperty(panel, 'clientHeight', { value: 50, configurable: true })
    Object.defineProperty(panel, 'scrollHeight', { value: 200, configurable: true })
    const chip = document.createElement('button')
    panel.appendChild(chip)
    body.appendChild(panel)
    chip.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true }))
    expect(intent, '面板自己的滚动不算阅读接管').toHaveBeenCalledTimes(4)
    inner.dispatchEvent(new Event('touchstart', { bubbles: true }))
    expect(intent, '触摸正文算用户意图').toHaveBeenCalledTimes(5)

    window.dispatchEvent(new Event('resize'))
    expect(layout).toHaveBeenCalledTimes(1)
    ro.trigger()                                   // 内容尺寸变化不经 window resize
    expect(layout).toHaveBeenCalledTimes(2)
    expect(ro.observed, '观察点是正文层容器：它变高才代表布局变了').toEqual([body])

    off()                                          // 卸载即摘：所有来源一起摘
    inner.dispatchEvent(new Event('scroll'))
    inner.dispatchEvent(new Event('wheel', { bubbles: true }))
    inner.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
    window.dispatchEvent(new Event('resize'))
    ro.trigger()
    expect(scroll).toHaveBeenCalledTimes(1)
    expect(intent).toHaveBeenCalledTimes(5)
    expect(layout).toHaveBeenCalledTimes(2)
  })

  it('滚动条拖动按事件时刻解析滚动容器：挂载时不滚、之后可滚也能认', () => {
    const body = document.createElement('div')
    body.style.overflowY = 'auto'
    Object.defineProperty(body, 'clientHeight', { value: 100, configurable: true })
    Object.defineProperty(body, 'clientWidth', { value: 100, configurable: true })
    Object.defineProperty(body, 'scrollHeight', { value: 100, configurable: true })
    document.body.appendChild(body)
    const intent = vi.fn()
    const off = PROD_HOST.listenViewport({ scroll: () => {}, layout: () => {}, intent }, body)

    // 挂载时内容还没有溢出（正文未到），此时若把 port 抓成闭包，这一路整场都是死的。
    Object.defineProperty(body, 'scrollHeight', { value: 500 })
    const down = (target: EventTarget, offsetX: number): void => {
      const event = new MouseEvent('pointerdown', { bubbles: true })
      Object.defineProperty(event, 'offsetX', { value: offsetX })
      target.dispatchEvent(event)
    }
    down(body, 150)
    expect(intent, '事件时刻正文已可滚：滚动条拖动算接管').toHaveBeenCalledTimes(1)
    down(body, 50)
    expect(intent, '正文内的 pointerdown 不算滚动条拖动').toHaveBeenCalledTimes(1)
    const inner = document.createElement('span')
    body.appendChild(inner)
    down(inner, 150)
    expect(intent, '正文子元素的 pointerdown 不算滚动条拖动').toHaveBeenCalledTimes(1)
    off()
    down(body, 150)
    expect(intent, '卸载后不再上报').toHaveBeenCalledTimes(1)
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