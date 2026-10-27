// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetPanelShelf } from '../../src/client/panel-shelf.js'
import { useSearchLanding } from '../../src/client/search-landing.js'
import type { AddAllReceipt, RowRef } from '../../src/client/search-view-model.js'
import type { ShelfAddOutcome, ShelfSeatInput } from '../../src/client/shelf-action.js'
import type { SearchHit } from '../../src/shared/wire.js'

/**
 * 搜索落架缝：落架现场与两条加架入口的排队从 `SearchView` 搬到 `useSearchLanding`。
 * 写口是注入的 `addSeat`（生产是 `addShelfSeat`），因此这里不起 DOM、不碰 HTTP，
 * 只钉状态与顺序：落成的架位进本轮账、整本只补没落过的行、零加成不报成功、在途读数逐本记。
 * 「账住在行之上、收起再展开不洗掉」与回执的措辞/通道都不在这一层——那要真的整页折叠才证得出，
 * 归 `tests/client/views-wiring.test.tsx`（「收起再展开：已在架的行仍显示已在书架」那一条）。
 */

function hit(partial: Partial<SearchHit> & { title: string }): SearchHit {
  return { author: null, url: null, coverUrl: null, intro: null, lastChapterName: null, kind: null, wordCount: null, ...partial }
}
const row = (url: string | null, sourceId = 's1'): RowRef => ({ sourceId, hit: hit({ title: 'a', url }) })

beforeEach(resetPanelShelf)

describe('useSearchLanding', () => {
  it('落成的架位进本轮账：同址两条 hit 都认得，写口只发过一发', async () => {
    const addSeat = vi.fn(async () => ({ ok: true as const, bookKey: 'u1' }))
    const { result } = renderHook(() => useSearchLanding({ addSeat }))
    await act(async () => { await result.current.add(row('u1')) })
    expect(result.current.isLanded(hit({ title: 'a', url: 'u1' }))).toBe(true)
    expect(result.current.isLanded(hit({ title: '同一本', url: 'u1' }))).toBe(true)
    expect(addSeat).toHaveBeenCalledTimes(1)
  })

  it('整本一发一行：逐行幂等 PUT，回执按架位分三笔（新落 / 仍缺 / 无地址）', async () => {
    const addSeat = vi.fn(async (input: ShelfSeatInput) => input.url === 'u2'
      ? { ok: false as const, error: new Error('nope') }
      : { ok: true as const, bookKey: input.url })
    const rows = [row('u1'), row('u1', 's2'), row('u2'), row(null)]
    const { result } = renderHook(() => useSearchLanding({ addSeat }))
    let receipt: AddAllReceipt | undefined
    await act(async () => { receipt = await result.current.addAll('b1', rows) })
    expect(receipt).toEqual({ newly: ['u1'], stillMissing: 1, noAddress: 1 })
    // 同址两行各发一发幂等 PUT（旧 `BookRow` 即如此，`views-wiring` 的「同一家同一地址」
    // 与「两家源给同一个地址」两条都钉着两发）；`newly` 按架位去重，不数 PUT。
    expect(addSeat).toHaveBeenCalledTimes(3)
  })

  it('先单加一条再点都加架：只补本轮没落过的那条，落过的不再发一遍', async () => {
    const addSeat = vi.fn(async (input: ShelfSeatInput) => ({ ok: true as const, bookKey: input.url }))
    const { result } = renderHook(() => useSearchLanding({ addSeat }))
    await act(async () => { await result.current.add(row('u1')) })
    let receipt: AddAllReceipt | undefined
    await act(async () => { receipt = await result.current.addAll('b1', [row('u1'), row('u2')]) })
    expect(addSeat.mock.calls.map((c) => c[0].url)).toEqual(['u1', 'u2'])
    expect(receipt).toEqual({ newly: ['u2'], stillMissing: 0, noAddress: 0 })
  })

  it('零加成不给成功回执：整行都没落成时 newly 空、仍缺照数', async () => {
    const addSeat = vi.fn(async () => ({ ok: false as const, error: new Error('nope') }))
    const { result } = renderHook(() => useSearchLanding({ addSeat }))
    let receipt: AddAllReceipt | undefined
    await act(async () => { receipt = await result.current.addAll('b1', [row('u1')]) })
    expect(receipt?.newly).toEqual([])
    expect(receipt?.stillMissing).toBe(1)
  })

  it('在途读数逐本记，不是一把全局闸：没点过的行照样能点', async () => {
    let release!: (outcome: ShelfAddOutcome) => void
    const addSeat = vi.fn(() => new Promise<ShelfAddOutcome>((resolve) => { release = resolve }))
    const { result } = renderHook(() => useSearchLanding({ addSeat }))
    let pending!: Promise<AddAllReceipt>
    act(() => { pending = result.current.addAll('b1', [row('u1')]) })
    expect(result.current.adding.has('b1')).toBe(true)
    expect(result.current.adding.has('b2')).toBe(false)
    await act(async () => { release({ ok: true, bookKey: 'u1' }); await pending })
    expect(result.current.adding.has('b1')).toBe(false)
  })

  it('落架账跨挂载保留：卸载重挂后仍认得已落的架位（面板期投影）', async () => {
    const addSeat = vi.fn(async () => ({ ok: true as const, bookKey: 'u1' }))
    const first = renderHook(() => useSearchLanding({ addSeat }))
    await act(async () => { await first.result.current.add(row('u1')) })
    first.unmount()
    const second = renderHook(() => useSearchLanding({ addSeat }))
    expect(second.result.current.isLanded(hit({ title: 'a', url: 'u1' }))).toBe(true)
  })
})
