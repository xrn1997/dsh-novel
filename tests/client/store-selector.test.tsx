// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { createStore, useStore, useStoreValue } from '../../src/client/store.js'

/**
 * 窄订阅（`ADR-0055` 的读法那一格）：高频写的 store 上，整店订阅会把无关子树一起拖进重渲染。
 * 这里钉两件事——投影只对**自己那格**变化唤醒；选择器返回原语，不自旋。
 */

interface Player { playing: boolean; paragraphIndex: number; title: string }

describe('useStoreValue', () => {
  it('只在自己那格变了时唤醒；别格改动不动本订阅', () => {
    const store = createStore<Player>({ playing: true, paragraphIndex: 0, title: '甲' })
    let renders = 0
    const h = renderHook(() => { renders += 1; return useStoreValue(store, (s) => (s.playing ? s.title : null)) })
    expect(h.result.current).toBe('甲')
    const afterMount = renders

    act(() => { store.set({ paragraphIndex: 7 }) })
    expect(h.result.current, '段号与投影无关').toBe('甲')
    expect(renders, '无关格不该唤醒').toBe(afterMount)

    act(() => { store.set({ playing: false }) })
    expect(h.result.current).toBeNull()
    expect(renders, '自己那格变了要唤醒').toBeGreaterThan(afterMount)
  })

  it('整店订阅仍照旧每写必醒（对照：窄订阅省下的正是这一份）', () => {
    const store = createStore<Player>({ playing: true, paragraphIndex: 0, title: '甲' })
    let renders = 0
    const h = renderHook(() => { renders += 1; return useStore(store).paragraphIndex })
    const afterMount = renders
    act(() => { store.set({ title: '乙' }) })
    expect(renders, '整店订阅按引用比快照，任何写都唤醒').toBeGreaterThan(afterMount)
    expect(h.result.current).toBe(0)
  })
})
