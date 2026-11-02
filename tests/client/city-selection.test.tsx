// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { rememberedCitySelection, useCitySelection } from '../../src/client/city-selection.js'
import { cityStore } from '../../src/client/store.js'

beforeEach(() => { cityStore.set({ sourceId: null, kind: null }) })

describe('useCitySelection（书城选中态：唯一写口只写 store，本挂载读投影）', () => {
  it('select 只写 cityStore；本挂载投影与 store 同值，asked 仍由 select 置位', () => {
    const h = renderHook(() => useCitySelection())
    act(() => h.result.current.select({ sourceId: 's1', kind: '玄幻' }, { asked: true }))
    expect(cityStore.get()).toEqual({ sourceId: 's1', kind: '玄幻' })
    expect(h.result.current.selection).toEqual({ sourceId: 's1', kind: '玄幻' })
    expect(h.result.current.isAsked()).toBe(true)
  })

  it('外部写 store 也驱动 hook：投影就是 store 投影，没有第二份 React state', () => {
    const h = renderHook(() => useCitySelection())
    act(() => cityStore.set({ sourceId: 's9', kind: '玄幻' }))
    expect(h.result.current.selection).toEqual({ sourceId: 's9', kind: '玄幻' })
    // 半格不投影：记住的源与分类俱在才算「落位」（进入判据读的就是这一个形状）
    act(() => cityStore.set({ sourceId: null }))
    expect(h.result.current.selection).toBeNull()
  })

  it('重挂载即投影记住的选中；asked 随挂载重置，cityStore 不重置', () => {
    const first = renderHook(() => useCitySelection())
    act(() => first.result.current.select({ sourceId: 's1', kind: '玄幻' }, { asked: true }))
    expect(first.result.current.isAsked()).toBe(true)
    first.unmount()
    expect(rememberedCitySelection()).toEqual({ sourceId: 's1', kind: '玄幻' })

    const second = renderHook(() => useCitySelection())
    expect(second.result.current.selection).toEqual({ sourceId: 's1', kind: '玄幻' })
    expect(second.result.current.isAsked()).toBe(false)
  })

  it('不带 asked 的落位只改选中态，不消耗自动路径的 one-shot', () => {
    const h = renderHook(() => useCitySelection())
    act(() => h.result.current.select({ sourceId: 's2', kind: '都市' }))
    expect(h.result.current.isAsked()).toBe(false)
    expect(h.result.current.selection).toEqual({ sourceId: 's2', kind: '都市' })
  })
})
