import { describe, expect, it } from 'vitest'
import { must } from '../support/fixture.js'
import { createTtsDefaults } from '../../src/client/tts/tts-defaults.js'
import type { TtsDefaultsSource } from '../../src/client/tts/tts-defaults.js'
import {
  createLiveRefSource, createSettingsSnapshotSource, TTS_DEFAULT_KEYS,
} from '../../src/client/tts/tts-defaults-host.js'

/** 假 live ref（宿主 volatile ref 窄镜像）：get / subscribe 两成员。 */
function fakeRef(value: unknown) {
  let current = value
  const listeners = new Set<() => void>()
  return {
    ref: {
      get: () => current,
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
    set(next: unknown): void {
      current = next
      for (const listener of listeners) listener()
    },
    listenerCount: (): number => listeners.size,
  }
}

function readOf(source: TtsDefaultsSource | null): Record<string, unknown> | null {
  return source === null ? null : source.read()
}

describe('听书缺省宿主 adapter', () => {
  describe('createLiveRefSource（宿主同步配置 live ref）', () => {
    it('逐格翻译：ref.get() 原样透出，键翻成 TtsDefaults 键', () => {
      const engine = fakeRef('http:live')
      const rate = fakeRef(1.5)
      const volume = fakeRef(0.4)
      const prefetch = fakeRef(6)
      const source = createLiveRefSource({
        [TTS_DEFAULT_KEYS.engineId]: engine.ref,
        [TTS_DEFAULT_KEYS.rate]: rate.ref,
        [TTS_DEFAULT_KEYS.volume]: volume.ref,
        [TTS_DEFAULT_KEYS.prefetchParagraphs]: prefetch.ref,
      })
      expect(source).not.toBeNull()
      expect(readOf(source)).toEqual({
        engineId: 'http:live', rate: 1.5, volume: 0.4, prefetchParagraphs: 6,
      })
    })

    it('半到场逐格接管：坏形状的格缺席、其余格照常；config 非对象 / 零格可认 = null', () => {
      const rate = fakeRef(1.5)
      // volume 是坏形状（不是 ref），prefetch 缺席：只有 rate 可认
      const partial = createLiveRefSource({ [TTS_DEFAULT_KEYS.rate]: rate.ref, [TTS_DEFAULT_KEYS.volume]: 'not-a-ref' })
      expect(readOf(partial)).toEqual({ rate: 1.5 })

      expect(createLiveRefSource({ [TTS_DEFAULT_KEYS.rate]: 'not-a-ref' })).toBeNull()
      expect(createLiveRefSource(null)).toBeNull()
      expect(createLiveRefSource(undefined)).toBeNull()
    })

    it('watch：任一 ref 变更叫一声（read 现读，晚出现的 ref 下一读即见）；退订摘干净', () => {
      const engine = fakeRef('http:live')
      const config: Record<string, unknown> = { [TTS_DEFAULT_KEYS.engineId]: engine.ref }
      const source = must(createLiveRefSource(config), 'live 源在场')
      let signals = 0
      const unwatch = source.watch?.(() => { signals += 1 })
      engine.set('http:changed')
      expect(signals).toBe(1)
      expect(source.read()).toMatchObject({ engineId: 'http:changed' })

      // 晚出现的 ref：下一次 read 现读到（出现型晚到不等信号）
      const rate = fakeRef(1.8)
      config[TTS_DEFAULT_KEYS.rate] = rate.ref
      expect(source.read()).toMatchObject({ rate: 1.8 })

      engine.set('http:again')
      expect(signals).toBe(2)
      unwatch?.()
      engine.set('http:muted')
      expect(signals).toBe(2)
      expect(engine.listenerCount(), '退订后 ref 订阅必须摘干净').toBe(0)
    })

    it('构造期不调用 get()；单格 get()/subscribe()/detach() 抛错只落那一格', () => {
      let ctorGetCalls = 0
      const throwingAtCtor = {
        get: () => { ctorGetCalls += 1; throw new Error('get 坏了') },
        subscribe: () => () => {},
      }
      const goodRate = fakeRef(1.6)
      const throwingSubscribe = {
        get: () => 0.4,
        subscribe: () => { throw new Error('subscribe 坏了') },
      }
      const throwingDetach = {
        get: () => 5,
        subscribe: () => () => { throw new Error('detach 坏了') },
      }
      const source = must(createLiveRefSource({
        [TTS_DEFAULT_KEYS.engineId]: throwingAtCtor,
        [TTS_DEFAULT_KEYS.rate]: goodRate.ref,
        [TTS_DEFAULT_KEYS.volume]: throwingSubscribe,
        [TTS_DEFAULT_KEYS.prefetchParagraphs]: throwingDetach,
      }), '构造期应仅看 ref 形状')
      expect(ctorGetCalls, 'createLiveRefSource 构造期不应调用 get()').toBe(0)

      // read() 时 engineId 单格抛错只丢该格，其余三格照常读出
      expect(source.read()).toEqual({ rate: 1.6, volume: 0.4, prefetchParagraphs: 5 })

      let signals = 0
      const unwatch = source.watch?.(() => { signals += 1 })
      goodRate.set(1.9)
      expect(signals).toBe(1)
      expect(() => { unwatch?.() }).not.toThrow()
      expect(goodRate.listenerCount(), '前面格退订抛错不得阻断其余格退订').toBe(0)
    })
  })

  describe('createSettingsSnapshotSource（设置面快照）', () => {
    it('refresh 后 read 翻名透值、触发信号；未 refresh 前整源缺席；整源替换且隔离外部变更', () => {
      const settings = createSettingsSnapshotSource()
      expect(settings.read(), '首屏快照未到 = 整源缺席').toEqual({})
      let signals = 0
      const unwatch = settings.watch?.(() => { signals += 1 })
      const first: Record<string, unknown> = {
        [TTS_DEFAULT_KEYS.engineId]: 'http:served',
        [TTS_DEFAULT_KEYS.rate]: 1.25,
        [TTS_DEFAULT_KEYS.volume]: 0.45,
        [TTS_DEFAULT_KEYS.prefetchParagraphs]: 4,
      }
      settings.refresh(first)
      // 外部原地改写原对象不应穿透进已存快照
      first[TTS_DEFAULT_KEYS.rate] = 9.9
      expect(signals).toBe(1)
      expect(settings.read()).toEqual({
        engineId: 'http:served', rate: 1.25, volume: 0.45, prefetchParagraphs: 4,
      })

      // 第二发缺席 engineId：整源替换，旧值退出而非残留
      settings.refresh({ [TTS_DEFAULT_KEYS.rate]: 1.4 })
      expect(signals).toBe(2)
      expect(settings.read()).toEqual({ rate: 1.4 })

      unwatch?.()
      settings.refresh({ [TTS_DEFAULT_KEYS.rate]: 1.3 })
      expect(signals).toBe(2)
    })
  })

  it('链上合流：live ref 逐格胜设置面快照，缺格落快照', () => {
    const rate = fakeRef(1.5)
    const live = createLiveRefSource({ [TTS_DEFAULT_KEYS.rate]: rate.ref })
    const settings = createSettingsSnapshotSource()
    settings.refresh({
      [TTS_DEFAULT_KEYS.engineId]: 'http:served',
      [TTS_DEFAULT_KEYS.rate]: 1.25,
    })
    const face = createTtsDefaults([must(live, 'live 源在场'), settings])
    expect(face.effective()).toMatchObject({ engineId: 'http:served', rate: 1.5 })
    face.dispose()
  })
})
