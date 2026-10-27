import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ensurePanelShelf, loadPanelShelf, markPanelShelfLanded, panelShelf, readPanelShelf,
  removePanelShelfBooks, resetPanelShelf, setPanelShelfFilter, setPanelShelfKeyword,
} from '../../src/client/panel-shelf.js'
import type { ShelfEntry } from '../../src/shared/wire.js'

const entry = (bookKey: string, title = bookKey): ShelfEntry => ({
  bookKey, sourceId: 's1', sourceName: null, title, addedAt: 1,
  progress: { chapterIndex: 0, offsetRatio: 0, updatedAt: 1 },
})

const deps = (apiGet: (path: string) => Promise<ShelfEntry[]>) => ({ apiGet, describeError: String })

beforeEach(resetPanelShelf)

describe('panelShelf（面板期书架投影）', () => {
  it('load：成功覆写书架读取面，并把在架书 seeded 进落架账', async () => {
    await loadPanelShelf(deps(async () => [entry('k1'), entry('k2')]))
    expect(panelShelf.get().books).toEqual([entry('k1'), entry('k2')])
    expect([...panelShelf.get().landed]).toEqual(['k1', 'k2'])
    expect(panelShelf.get().error).toBeNull()
  })

  it('load 失败：books=[] + error，不伪装成空架；落架账保留', async () => {
    markPanelShelfLanded(['u1'])
    await loadPanelShelf(deps(async () => { throw new Error('x') }))
    expect(panelShelf.get().books).toEqual([])
    expect(panelShelf.get().error).toBe('Error: x')
    expect(panelShelf.get().landed.has('u1')).toBe(true)
  })

  it('筛选与关键字跨挂载保留', () => {
    setPanelShelfFilter('local')
    setPanelShelfKeyword('斗罗')
    expect(panelShelf.get().filter).toBe('local')
    expect(panelShelf.get().keyword).toBe('斗罗')
  })

  it('markPanelShelfLanded 按地址去重', () => {
    markPanelShelfLanded(['u1', 'u1'])
    markPanelShelfLanded(['u1', 'u2'])
    expect([...panelShelf.get().landed]).toEqual(['u1', 'u2'])
  })

  it('removePanelShelfBooks 同时清书架与落架账（删掉再加不会被旧账误标）', async () => {
    await loadPanelShelf(deps(async () => [entry('k1'), entry('k2')]))
    removePanelShelfBooks(['k1'])
    expect(panelShelf.get().books).toEqual([entry('k2')])
    expect([...panelShelf.get().landed]).toEqual(['k2'])
  })

  it('删除作废在途读面：慢 GET 的删前快照不许把书带回来', async () => {
    await loadPanelShelf(deps(async () => [entry('k1'), entry('k2')]))
    let release!: (list: ShelfEntry[]) => void
    const apiGet = vi.fn(() => new Promise<ShelfEntry[]>((resolve) => { release = resolve }))
    const pending = loadPanelShelf(deps(apiGet))
    removePanelShelfBooks(['k1'])
    release([entry('k1'), entry('k2')])
    await pending
    expect(panelShelf.get().books).toEqual([entry('k2')])
    expect([...panelShelf.get().landed]).toEqual(['k2'])
  })

  it('加架成功作废在途读面：加架前的快照不许落地', async () => {
    let release!: (list: ShelfEntry[]) => void
    const apiGet = vi.fn(() => new Promise<ShelfEntry[]>((resolve) => { release = resolve }))
    const pending = loadPanelShelf(deps(apiGet))
    markPanelShelfLanded(['u1'])
    release([entry('k1')])
    await pending
    expect(panelShelf.get().books).toBeNull()
    expect([...panelShelf.get().landed]).toEqual(['u1'])
  })

  it('加架后的 ensure 重取：不拿加架前的在途快照答「不在架」', async () => {
    let release!: (list: ShelfEntry[]) => void
    const apiGet = vi.fn()
      .mockImplementationOnce(() => new Promise<ShelfEntry[]>((resolve) => { release = resolve }))
      .mockResolvedValueOnce([entry('k2')])
    const stale = loadPanelShelf(deps(apiGet))
    markPanelShelfLanded(['k2'])
    release([])
    await stale
    await ensurePanelShelf(deps(apiGet), 'k2')
    expect(panelShelf.get().books).toEqual([entry('k2')])
    expect(panelShelf.get().landed.has('k2')).toBe(true)
    expect(apiGet).toHaveBeenCalledTimes(2)
  })

  it('readPanelShelf：成功给当前列表，读面失败照实 reject（问不到 ≠ 不在架）', async () => {
    await loadPanelShelf(deps(async () => [entry('k1')]))
    expect(await readPanelShelf(deps(async () => [entry('k1')]), 'k1')).toEqual([entry('k1')])
    await expect(readPanelShelf(deps(async () => { throw new Error('x') }), 'k2'))
      .rejects.toThrow('Error: x')
  })

  it('ensure：已有投影且覆盖当前书时不再发请求；缺这本书则重取', async () => {
    const apiGet = vi.fn(async () => [entry('k1')])
    await ensurePanelShelf(deps(apiGet), 'k1')
    await ensurePanelShelf(deps(apiGet), 'k1')
    expect(apiGet).toHaveBeenCalledTimes(1)
    await ensurePanelShelf(deps(apiGet), 'k2')
    expect(apiGet).toHaveBeenCalledTimes(2)
  })

  it('ensure：上次读面失败时重取，不把失败当成最终答案', async () => {
    let fail = true
    const apiGet = vi.fn(async () => {
      if (fail) throw new Error('x')
      return [entry('k1')]
    })
    await ensurePanelShelf(deps(apiGet), 'k1')
    expect(panelShelf.get().error).toBe('Error: x')
    fail = false
    await ensurePanelShelf(deps(apiGet), 'k1')
    expect(panelShelf.get().error).toBeNull()
    expect(panelShelf.get().books).toEqual([entry('k1')])
    expect(apiGet).toHaveBeenCalledTimes(2)
  })

  it('ensure：有在途刷新时等它落地，不拿旧投影答复（阅读器恢复进度要读新列表）', async () => {
    await loadPanelShelf(deps(async () => [entry('k1')]))
    let release!: (list: ShelfEntry[]) => void
    const apiGet = vi.fn(() => new Promise<ShelfEntry[]>((resolve) => { release = resolve }))
    const pending = loadPanelShelf(deps(apiGet))
    let answeredWith: ShelfEntry[] | null | undefined
    const ensured = ensurePanelShelf(deps(apiGet), 'k1').then(() => { answeredWith = panelShelf.get().books })
    release([entry('k1'), entry('k2')])
    await Promise.all([pending, ensured])
    expect(answeredWith).toEqual([entry('k1'), entry('k2')])
    expect(apiGet).toHaveBeenCalledTimes(1)
  })

  it('ensure：在途刷新落地后仍缺当前书，重取一次再判', async () => {
    await loadPanelShelf(deps(async () => [entry('k1')]))
    let release!: (list: ShelfEntry[]) => void
    const apiGet = vi.fn()
      .mockImplementationOnce(() => new Promise<ShelfEntry[]>((resolve) => { release = resolve }))
      .mockResolvedValueOnce([entry('k2')])
    const pending = loadPanelShelf(deps(apiGet))
    const ensured = ensurePanelShelf(deps(apiGet), 'k2')
    release([entry('k1')])
    await Promise.all([pending, ensured])
    expect(panelShelf.get().books).toEqual([entry('k2')])
    expect(apiGet).toHaveBeenCalledTimes(2)
  })

  it('ensure 不带 bookKey：只问「这一面板读过书架吗」，读过就不付第二发（搜索页的落架基线）', async () => {
    const apiGet = vi.fn(async () => [entry('k1')])
    await ensurePanelShelf(deps(apiGet))
    expect(apiGet).toHaveBeenCalledTimes(1)
    expect([...panelShelf.get().landed]).toEqual(['k1'])
    await ensurePanelShelf(deps(apiGet))
    expect(apiGet).toHaveBeenCalledTimes(1)
  })

  it('ensure 不带 bookKey：上一次读面失败要重取（「没问到」不是基线）', async () => {
    let fail = true
    const apiGet = vi.fn(async () => {
      if (fail) throw new Error('x')
      return [entry('k1')]
    })
    await ensurePanelShelf(deps(apiGet))
    expect(panelShelf.get().error).toBe('Error: x')
    fail = false
    await ensurePanelShelf(deps(apiGet))
    expect(panelShelf.get().books).toEqual([entry('k1')])
    expect(apiGet).toHaveBeenCalledTimes(2)
  })

  it('readPanelShelf：读面在途时面板被卸载，reject 而不是拿空架答「不在架」', async () => {
    const releases: Array<(list: ShelfEntry[]) => void> = []
    const apiGet = vi.fn(() => new Promise<ShelfEntry[]>((resolve) => { releases.push(resolve) }))
    const read = readPanelShelf(deps(apiGet), 'k1')
    resetPanelShelf()
    releases[0]!([entry('k1')])
    await expect(read).rejects.toThrow('panel shelf projection unavailable')
  })

  it('并发 load：同一发在途，只发一次 GET', async () => {
    let release!: (list: ShelfEntry[]) => void
    const apiGet = vi.fn(() => new Promise<ShelfEntry[]>((resolve) => { release = resolve }))
    const p1 = loadPanelShelf(deps(apiGet))
    const p2 = loadPanelShelf(deps(apiGet))
    expect(apiGet).toHaveBeenCalledTimes(1)
    release([entry('k1')])
    await Promise.all([p1, p2])
    expect(panelShelf.get().books).toEqual([entry('k1')])
  })

  it('reset 丢弃在途响应：面板卸载后旧请求不许回写', async () => {
    let release!: (list: ShelfEntry[]) => void
    const apiGet = vi.fn(() => new Promise<ShelfEntry[]>((resolve) => { release = resolve }))
    const pending = loadPanelShelf(deps(apiGet))
    resetPanelShelf()
    release([entry('k1')])
    await pending
    expect(panelShelf.get().books).toBeNull()
    expect(panelShelf.get().landed.size).toBe(0)
  })
})
