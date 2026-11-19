import { describe, expect, it } from 'vitest'
import { createReaderBinding } from '../../src/client/reader-binding.js'
import type {
  ReaderBindingHost, ReaderDomTarget, ReaderElementSource, ReaderFrameScheduler, ReaderViewportHandlers,
} from '../../src/client/reader-binding.js'
import type { ReadingPosition } from '../../src/client/tts/reading-position.js'

/**
 * 阅读器 DOM 绑定的判据与次序。**不起 jsdom**：元素来源、帧泵、DOM 平台缝全注入，会话用记录型
 * 替身——这一层钉的是 interface 事实（谁在什么时候被叫、叫几次、次序如何），不是布局读数。
 *
 * 四条主断言：一帧一次 afterRender / 只改 currentChapter 时不拍 / 测量前先刷新 ReaderPort /
 * 拍点后回调在落位之后。另钉装摘与探针注册（挂载作用域）以及视口事件的两类来源归一到会话。
 */

/** 手动帧泵：登记的帧按 flush 顺序跑；cancel 记账，用来钉卸载时挂起帧确实被取消 */
function manualFrames(): {
  scheduler: ReaderFrameScheduler
  pending: () => number
  cancelled: number[]
  flush: () => void
} {
  const queue = new Map<number, () => void>()
  const cancelled: number[] = []
  let nextHandle = 1
  return {
    scheduler: {
      schedule: (cb) => { const handle = nextHandle++; queue.set(handle, cb); return handle },
      cancel: (handle) => { cancelled.push(handle); queue.delete(handle) },
    },
    pending: () => queue.size,
    cancelled,
    flush: () => {
      const callbacks = [...queue.values()]
      queue.clear()
      for (const cb of callbacks) cb()
    },
  }
}

/** DOM 平台缝：记录装摘、探针与端口查找，并把视口事件握在手里（测试按需触发） */
function fakeHost(trace: string[]): {
  host: ReaderBindingHost
  handlers: () => ReaderViewportHandlers | null
  probe: () => (() => ReadingPosition | null) | null
  findPorts: () => number
  unlistened: () => number
} {
  let viewportHandlers: ReaderViewportHandlers | null = null
  let readingProbe: (() => ReadingPosition | null) | null = null
  let findPorts = 0
  let unlistened = 0
  const host: ReaderBindingHost = {
    findPort: () => { findPorts += 1; trace.push('findPort'); return null },
    listenViewport: (handlers) => {
      viewportHandlers = handlers
      trace.push('listen')
      return () => { unlistened += 1; viewportHandlers = null; trace.push('unlisten') }
    },
    setProbe: (probe) => { readingProbe = probe; trace.push(probe === null ? 'probe:off' : 'probe:on') },
  }
  return {
    host,
    handlers: () => viewportHandlers,
    probe: () => readingProbe,
    findPorts: () => findPorts,
    unlistened: () => unlistened,
  }
}

/** 记录型会话替身：只记被叫了什么、按什么次序（DOM 侧只该叫这两枚） */
function fakeTarget(trace: string[]): ReaderDomTarget & { afterRenders: number; feeds: Array<boolean | undefined> } {
  const target = {
    afterRenders: 0,
    feeds: [] as Array<boolean | undefined>,
    afterRender: (): void => { target.afterRenders += 1; trace.push('afterRender') },
    feedViewport: (layoutChanged?: boolean): void => { target.feeds.push(layoutChanged); trace.push('feed') },
  }
  return target
}

/** 元素来源：本测试只关心「绑定在什么时候取」，形状给空读数 */
const fakeSource = (): ReaderElementSource => ({
  body: () => null,
  sentinel: () => null,
  chapters: () => [],
})

function harness(onUserIntent?: () => void): {
  binding: ReturnType<typeof createReaderBinding>
  frames: ReturnType<typeof manualFrames>
  target: ReturnType<typeof fakeTarget>
  host: ReturnType<typeof fakeHost>
  trace: string[]
} {
  const trace: string[] = []
  const frames = manualFrames()
  const target = fakeTarget(trace)
  const host = fakeHost(trace)
  const binding = createReaderBinding({
    source: fakeSource(), frames: frames.scheduler, host: host.host,
    ...(onUserIntent === undefined ? {} : { onUserIntent }),
  })
  return { binding, frames, target, host, trace }
}

/** 挂载并跑掉挂载那第一拍（后续断言从干净的新一拍开始数） */
function mountAndSettle(h: ReturnType<typeof harness>): void {
  h.binding.mount(h.target)
  h.frames.flush()
  h.trace.length = 0
  h.target.afterRenders = 0
  h.target.feeds.length = 0
}

describe('ReaderBinding：提交判定与帧泵（一帧一次拍点）', () => {
  it('挂载即拍第一帧：装监听、注册探针、喂一次视口，然后拍一次', () => {
    const h = harness()
    h.binding.mount(h.target)
    expect(h.host.unlistened()).toBe(0)
    expect(h.host.handlers()).not.toBeNull()
    expect(h.host.probe(), '挂载时注册阅读探针').toBeTypeOf('function')
    expect(h.target.feeds, '挂载补一次初始视口读数').toEqual([undefined])
    expect(h.frames.pending(), '挂载排一帧测量（DOM 已提交，端口可能刚出现）').toBe(1)
    h.frames.flush()
    expect(h.target.afterRenders).toBe(1)
  })

  it('同一版的多次渲染只拍一次（一帧一次 afterRender）', () => {
    const h = harness()
    mountAndSettle(h)
    h.binding.rendered(1)
    h.binding.rendered(1)                       // 同一次提交后的第二次渲染
    h.binding.rendered(1)
    expect(h.frames.pending()).toBe(1)          // 合并成一帧
    h.frames.flush()
    expect(h.target.afterRenders).toBe(1)
  })

  it('版本变了但帧还没跑：同样只拍一次（合并到同一帧）', () => {
    const h = harness()
    mountAndSettle(h)
    h.binding.rendered(2)
    h.binding.rendered(3)                       // 帧未跑之前又换了一版
    expect(h.frames.pending()).toBe(1)
    h.frames.flush()
    expect(h.target.afterRenders).toBe(1)
  })

  it('只改 currentChapter / 其它非布局状态时不拍：版本没变的门不排帧', () => {
    const h = harness()
    mountAndSettle(h)
    h.binding.rendered(4)
    h.frames.flush()
    expect(h.target.afterRenders).toBe(1)
    h.binding.rendered(4)                       // 当前章变化触发的重渲染：DOM 版本没动
    h.binding.rendered(4)
    expect(h.frames.pending()).toBe(0)
    expect(h.target.afterRenders).toBe(1)
  })

  it('未挂载时的门不排帧（挂载那一步自己会拍第一帧，不靠两条 effect 的声明序）', () => {
    const h = harness()
    h.binding.rendered(1)
    expect(h.frames.pending()).toBe(0)
    h.binding.mount(h.target)
    h.frames.flush()
    expect(h.target.afterRenders).toBe(1)
  })
})

describe('ReaderBinding：测量次序（先刷新端口，拍点后回调在落位之后）', () => {
  it('测量前先刷新 ReaderPort，再叫会话拍点', () => {
    const h = harness()
    mountAndSettle(h)
    h.binding.rendered(2)
    h.frames.flush()
    expect(h.trace).toEqual(['findPort', 'afterRender'])
  })

  it('拍点后回调在会话拍点之后：落位先收口，再居中/消费', () => {
    const h = harness()
    mountAndSettle(h)
    h.binding.rendered(3, () => { h.trace.push('after') })
    h.frames.flush()
    expect(h.trace).toEqual(['findPort', 'afterRender', 'after'])
  })

  it('同一版的多帧渲染只保留最新那次给的拍点后回调', () => {
    const h = harness()
    mountAndSettle(h)
    const seen: string[] = []
    h.binding.rendered(4, () => { seen.push('旧') })
    h.binding.rendered(4, () => { seen.push('新') })
    h.frames.flush()
    expect(seen).toEqual(['新'])
  })
})

describe('ReaderBinding：装摘、探针与视口事件', () => {
  it('视口事件两类来源都归一到会话的 feedViewport（纯滚动 / 布局变了）', () => {
    const h = harness()
    mountAndSettle(h)
    const handlers = h.host.handlers()
    expect(handlers).not.toBeNull()
    handlers?.scroll()
    handlers?.layout()
    expect(h.target.feeds).toEqual([false, true])
  })

  it('用户滚动意图单独上报：不混进视口 feeds，卸载后不再上报', () => {
    let intents = 0
    const h = harness(() => { intents += 1 })
    mountAndSettle(h)
    h.host.handlers()?.intent?.()
    expect(intents).toBe(1)
    expect(h.target.feeds, '意图不是视口读数').toEqual([])
    h.binding.unmount()
    expect(h.host.handlers()).toBeNull()
  })

  it('卸载：摘监听、注销探针、取消挂起帧，此后的门不排帧', () => {
    const h = harness()
    mountAndSettle(h)
    h.binding.rendered(5)
    expect(h.frames.pending()).toBe(1)
    h.binding.unmount()
    expect(h.host.unlistened()).toBe(1)
    expect(h.host.probe()).toBeNull()
    expect(h.frames.cancelled).toHaveLength(1)
    expect(h.frames.pending()).toBe(0)
    h.binding.rendered(6)
    expect(h.frames.pending(), '卸载后不再拍点').toBe(0)
  })
})
