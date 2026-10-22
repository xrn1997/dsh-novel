// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { rememberedCitySelection, useCitySelection } from '../../src/client/city-selection.js'
import { cityStore } from '../../src/client/store.js'

beforeEach(() => { cityStore.set({ sourceId: null, kind: null }) })

describe('useCitySelection（书城选中态的唯一写口）', () => {
  it('select 同时写投影与 cityStore；asked 随挂载重置，cityStore 不重置', () => {
    const first = renderHook(() => useCitySelection())
    act(() => first.result.current.select({ sourceId: 's1', kind: '玄幻' }, { asked: true }))
    expect(first.result.current.selection).toEqual({ sourceId: 's1', kind: '玄幻' })
    expect(first.result.current.isAsked()).toBe(true)
    expect(rememberedCitySelection()).toEqual({ sourceId: 's1', kind: '玄幻' })
    first.unmount()

    const second = renderHook(() => useCitySelection())
    expect(second.result.current.selection).toBeNull()
    expect(second.result.current.isAsked()).toBe(false)
    expect(rememberedCitySelection()).toEqual({ sourceId: 's1', kind: '玄幻' })
  })

  it('不带 asked 的落位只改选中态，不消耗自动路径的 one-shot', () => {
    const h = renderHook(() => useCitySelection())
    act(() => h.result.current.select({ sourceId: 's2', kind: '都市' }))
    expect(h.result.current.isAsked()).toBe(false)
    expect(h.result.current.selection).toEqual({ sourceId: 's2', kind: '都市' })
  })
})
