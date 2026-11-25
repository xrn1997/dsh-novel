import { describe, expect, it } from 'vitest'
import { TTS_DEFAULTS } from '../../src/shared/wire.js'
import type { TtsDefaults, TtsDefaultsSource } from '../../src/client/tts/tts-defaults.js'
import { createTtsDefaults } from '../../src/client/tts/tts-defaults.js'

/** 可变来源夹具：`set` 换值并叫一声（模拟 live ref 的 subscribe / 设置面 refresh）。 */
function mutableSource(initial: Partial<Record<keyof TtsDefaults, unknown>> = {}) {
  let current: Record<string, unknown> = { ...initial }
  const listeners = new Set<() => void>()
  const source: TtsDefaultsSource = {
    read: () => ({ ...current }),
    watch: (notify: () => void) => {
      listeners.add(notify)
      return () => { listeners.delete(notify) }
    },
  }
  return {
    source,
    set(next: Partial<Record<keyof TtsDefaults, unknown>>): void {
      current = { ...current, ...next }
      for (const listener of listeners) listener()
    },
    listenerCount: (): number => listeners.size,
  }
}

describe('听书缺省取值链（createTtsDefaults）', () => {
  it('顺序链：每格取第一个读得出的来源（前源 > 后源 > wire 兜底）', () => {
    const near = mutableSource({ engineId: 'http:near', rate: 1.5, volume: 0.4, prefetchParagraphs: 6 })
    const far = mutableSource({ engineId: 'http:far', rate: 2, volume: 0.9, prefetchParagraphs: 3 })
    const face = createTtsDefaults([near.source, far.source])
    expect(face.effective()).toEqual({
      engineId: 'http:near', rate: 1.5, volume: 0.4, prefetchParagraphs: 6,
    })
    face.dispose()
  })

  it('逐格独立：一格缺席只让那一格落到下一来源，其余格照常', () => {
    const near = mutableSource({ rate: 1.5 })
    const far = mutableSource({ engineId: 'http:far', rate: 2, volume: 0.9 })
    const face = createTtsDefaults([near.source, far.source])
    // rate 有前源、engineId/volume 落后源、prefetch 两源皆缺 → wire 兜底
    expect(face.effective()).toEqual({
      engineId: 'http:far', rate: 1.5, volume: 0.9,
      prefetchParagraphs: TTS_DEFAULTS.prefetchParagraphs,
    })
    face.dispose()
  })

  it('无效读数 = 缺席：空白引擎 id / 非有限数 / 负数与小数预取 / 类型错 / null 都落到下一来源', () => {
    const near = mutableSource({
      engineId: '   ', rate: Number.NaN, volume: Number.POSITIVE_INFINITY, prefetchParagraphs: -1,
    })
    const far = mutableSource({ engineId: 'http:far', rate: 2, volume: 0.9, prefetchParagraphs: 3 })
    const face = createTtsDefaults([near.source, far.source])
    expect(face.effective()).toEqual({
      engineId: 'http:far', rate: 2, volume: 0.9, prefetchParagraphs: 3,
    })
    face.dispose()

    const typed = mutableSource({
      engineId: null, rate: 2, volume: 'loud', prefetchParagraphs: 2.5,
    })
    const face2 = createTtsDefaults([typed.source])
    // 读不出的格落 wire 兜底，不编值
    expect(face2.effective()).toEqual({ ...TTS_DEFAULTS, rate: 2 })
    face2.dispose()
  })

  it('读时求值：来源后来才发布值，下一次 effective() 就拿到（晚到即认领）', () => {
    const live = mutableSource({})
    const face = createTtsDefaults([live.source])
    expect(face.effective().rate).toBe(TTS_DEFAULTS.rate)
    live.set({ rate: 1.8 })
    expect(face.effective().rate).toBe(1.8)
    face.dispose()
  })

  it('来源 read 抛错 = 该源缺席：不抛、不牵连他源', () => {
    const broken: TtsDefaultsSource = { read: () => { throw new Error('源坏了') } }
    const far = mutableSource({ engineId: 'http:far' })
    const face = createTtsDefaults([broken, far.source])
    expect(face.effective().engineId).toBe('http:far')
    face.dispose()
  })

  it('空链 = 纯 wire 缺省', () => {
    const face = createTtsDefaults([])
    expect(face.effective()).toEqual({ ...TTS_DEFAULTS })
    face.dispose()
  })

  it('通知：信号触发重算，真变了才发整份新值；同值信号与退订后都不发', () => {
    const near = mutableSource({ rate: 1.5 })
    const face = createTtsDefaults([near.source])
    const seen: TtsDefaults[] = []
    const unwatch = face.subscribe((v) => { seen.push(v) })

    near.set({ rate: 1.5 })            // 同值信号
    expect(seen, '同值信号不惊动订阅者').toHaveLength(0)
    near.set({ rate: 1.9 })
    expect(seen).toHaveLength(1)
    expect(seen[0]?.rate).toBe(1.9)

    unwatch()
    near.set({ rate: 2.1 })
    expect(seen, '退订后不再发').toHaveLength(1)

    const seen2: TtsDefaults[] = []
    face.subscribe((v) => { seen2.push(v) })
    face.dispose()
    near.set({ rate: 2.3 })
    expect(seen2, 'dispose 后信号链整个断开').toHaveLength(0)
    expect(near.listenerCount(), 'dispose 后来源订阅未退订').toBe(0)
  })

  it('到达顺序无关：后源更新前源已占格不覆盖且不发多余通知；前源重推不覆写后源所占格', () => {
    const near = mutableSource({ engineId: 'http:near', rate: 1.5 })
    const far = mutableSource({ engineId: 'http:far', rate: 1.2, volume: 0.4 })
    const face = createTtsDefaults([near.source, far.source])
    const seen: TtsDefaults[] = []
    face.subscribe((v) => { seen.push(v) })

    // 后源在后更新前源已占住的 rate：前源仍胜，有效值未变 → 零通知
    far.set({ rate: 2.2 })
    expect(face.effective()).toMatchObject({ engineId: 'http:near', rate: 1.5, volume: 0.4 })
    expect(seen).toHaveLength(0)

    // 前源重推自己已占格的变动，后源所占的 volume 仍由后源保持
    near.set({ rate: 1.8 })
    expect(face.effective()).toMatchObject({ engineId: 'http:near', rate: 1.8, volume: 0.4 })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ rate: 1.8, volume: 0.4 })
    face.dispose()
  })

  it('动态回落：前源值变为无效或消失后回落到后源 / wire 并通知订阅者', () => {
    const near = mutableSource({ engineId: 'http:near', rate: 1.5, volume: 0.4 })
    const far = mutableSource({ engineId: 'http:far', rate: 1.2 })
    const face = createTtsDefaults([near.source, far.source])
    const seen: TtsDefaults[] = []
    face.subscribe((v) => { seen.push(v) })

    near.set({ engineId: '   ', rate: Number.NaN, volume: undefined })
    expect(face.effective()).toMatchObject({
      engineId: 'http:far', rate: 1.2, volume: TTS_DEFAULTS.volume,
    })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      engineId: 'http:far', rate: 1.2, volume: TTS_DEFAULTS.volume,
    })
    face.dispose()
  })

  it('永不抛与故障隔离：null 读数、单格抛错 getter、watch/detach 异常互不连坐', () => {
    const nullSource: TtsDefaultsSource = { read: () => null as unknown as Record<string, unknown> }
    const getterThrows: TtsDefaultsSource = {
      read: () => ({
        get engineId() { throw new Error('单格 getter 炸了') },
        rate: 1.7,
      }),
      watch: () => { throw new Error('watch 失败') },
    }
    const far = mutableSource({ engineId: 'http:far', rate: 1.1 })
    const badDetach: TtsDefaultsSource = {
      read: () => ({}),
      watch: () => () => { throw new Error('detach 失败') },
    }
    const face = createTtsDefaults([nullSource, getterThrows, badDetach, far.source])
    // getterThrows 只有 engineId 抛错，同源的 rate 照常胜出，engineId 落到 far
    expect(face.effective()).toMatchObject({ engineId: 'http:far', rate: 1.7 })

    const seen: TtsDefaults[] = []
    face.subscribe((v) => { seen.push(v) })
    far.set({ engineId: 'http:far2' })
    expect(seen).toHaveLength(1)
    expect(seen[0]?.engineId).toBe('http:far2')

    // badDetach 在前也不阻断 far 的退订
    expect(() => { face.dispose() }).not.toThrow()
    expect(far.listenerCount()).toBe(0)
  })
})
