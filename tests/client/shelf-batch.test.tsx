// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { ShelfView } from '../../src/client/views/ShelfView.js'
import { routeStore } from '../../src/client/store.js'
import { ROUTES } from '../../src/shared/wire.js'
import { makeCoreDeps } from './fake-deps.js'
import type { FakeCoreDeps } from './fake-deps.js'
import type { ShelfEntry } from '../../src/client/views/types.js'

/**
 * 书架多选批量删除的接线测试（2026 新需求：一次删一批）。
 *
 * 口径（与书源管理 tab 的批量删除同款，词汇也照抄——「已选 N / 清空选择 / 删除所选」）：
 * - 勾选是**现场**：点卡片只切选择，不发任何请求、不进阅读器；
 * - 删除是**一次**批请求（POST shelf/batch-delete，keys 点击时快照），不是循环 DELETE；
 * - 「全选」= 当前筛选下可见的书，不是整架（筛选簇进多选态即让位，故筛选在入场时定格）；
 * - 失败留框内可就地重试（与书架单本删除一致），成功才清选择并退出多选态；
 * - 单本 ✕ 路径一字不动（views-wiring 的那批钉子继续管它）。
 */

const entry = (over: Partial<ShelfEntry> & { bookKey: string }): ShelfEntry => ({
  sourceId: 's1', title: over.bookKey, addedAt: 1, sourceName: '源一',
  progress: { chapterIndex: 0, offsetRatio: 0, updatedAt: 1 },
  ...over,
})

/** 在读（有实质进度）/ 未读 / 本地，三种都进用例：全选与批量文案的判别样本 */
const A = entry({ bookKey: 'k-a', title: '斗罗', progress: { chapterIndex: 3, offsetRatio: 0, updatedAt: 1 } })
const B = entry({ bookKey: 'k-b', title: '剑来', sourceId: 's2', sourceName: '源二' })
const L = entry({ bookKey: 'local:u1', title: '本地书', sourceId: '__local__', sourceName: null })

async function mount(books: ShelfEntry[], apiSend?: unknown): Promise<FakeCoreDeps> {
  const deps = makeCoreDeps({ apiGet: vi.fn(async () => books), ...(apiSend === undefined ? {} : { apiSend }) })
  render(createElement(ShelfView, { deps }))
  await waitFor(() => expect(screen.getByText(books[0].title)).toBeTruthy())
  return deps
}

const selbar = (): HTMLElement => {
  const bar = document.querySelector<HTMLElement>('[data-novel-selbar]')
  expect(bar, '批量条未出现').not.toBeNull()
  return bar as HTMLElement
}
const barButton = (label: string): HTMLElement => {
  const btn = [...selbar().querySelectorAll('button')].find((b) => b.textContent?.trim() === label)
  expect(btn, `批量条上没有「${label}」`).toBeDefined()
  return btn as HTMLElement
}
/** 卡片主钮按书名取（多选态它的 aria-label 换成「选择/取消选择《书名》」） */
const card = (title: string): HTMLElement => {
  const el = [...document.querySelectorAll<HTMLElement>('.novel-card')].find((c) => c.textContent?.includes(title))
  expect(el, `卡片「${title}」不在场`).toBeDefined()
  return el as HTMLElement
}
const enterSelect = (): void => { fireEvent.click(screen.getByText('选择')) }

/** 单本 ✕（多本书时不止一个，取第一张卡片的） */
const firstX = (): HTMLElement => screen.getAllByTitle('删除本书')[0]

afterEach(cleanup)

describe('书架多选态：进态与勾选只动现场，不发请求', () => {
  it('「选择」进多选态：批量条在场、单本 ✕ 与引导卡让位；「退出」零请求回到常态', async () => {
    const deps = await mount([A, B])
    expect(firstX()).toBeTruthy()
    expect(screen.getByText('导入本地书籍')).toBeTruthy()

    enterSelect()
    expect(selbar()).toBeTruthy()
    expect(screen.getByText('已选 0')).toBeTruthy()
    // 同一职责不留第二个入口：多选态里单本 ✕ 与导入引导卡都退场
    expect(screen.queryByTitle('删除本书')).toBeNull()
    expect(screen.queryByText('导入本地书籍')).toBeNull()

    fireEvent.click(barButton('退出'))
    expect(document.querySelector('[data-novel-selbar]')).toBeNull()
    expect(firstX()).toBeTruthy()
    expect(deps.apiSend).not.toHaveBeenCalled()
  })

  it('点卡片 = 勾选/取消勾选：不进阅读器、零请求，aria-pressed 如实', async () => {
    const deps = await mount([A, B])
    routeStore.set({ route: { name: 'shelf' } })
    enterSelect()

    fireEvent.click(card('斗罗'))
    expect(screen.getByText('已选 1')).toBeTruthy()
    expect(card('斗罗').getAttribute('aria-pressed')).toBe('true')
    expect(card('斗罗').getAttribute('aria-label')).toBe('取消选择《斗罗》')
    expect(routeStore.get().route.name).toBe('shelf')      // 点卡片不再跳阅读器

    fireEvent.click(card('斗罗'))
    expect(screen.getByText('已选 0')).toBeTruthy()
    expect(card('斗罗').getAttribute('aria-pressed')).toBe('false')
    expect(deps.apiSend).not.toHaveBeenCalled()
  })

  it('「全选」只认当前筛选可见的书；「清空选择」清零', async () => {
    await mount([A, B, L])
    fireEvent.click(screen.getByText('在读'))              // 筛选：只有 A 有实质进度
    enterSelect()
    // 筛选簇在多选态让位（筛选在入场时定格——全选的口径才有唯一答案）
    expect(screen.queryByText('在读')).toBeNull()

    fireEvent.click(barButton('全选'))
    expect(screen.getByText('已选 1')).toBeTruthy()
    fireEvent.click(barButton('清空选择'))
    expect(screen.getByText('已选 0')).toBeTruthy()
  })

  it('「全部」筛选下全选 = 整架（含本地书）', async () => {
    await mount([A, B, L])
    enterSelect()
    fireEvent.click(barButton('全选'))
    expect(screen.getByText('已选 3')).toBeTruthy()
  })
})

describe('删除所选：一次批请求 + 模态口径 + 失败留框内', () => {
  it('模态点名本数 → 恰一次 POST shelf/batch-delete（keys = 点击时快照）→ 成功清选择并退出多选态', async () => {
    const apiSend = vi.fn(async () => ({ removed: 2 }))
    const deps = await mount([A, B, L], apiSend)
    enterSelect()
    fireEvent.click(card('斗罗'))
    fireEvent.click(card('剑来'))

    fireEvent.click(barButton('删除所选'))
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByText('删除选中的 2 本书？')).toBeTruthy()
    expect(screen.getByText('将从书架移除，阅读进度记录一并删除。')).toBeTruthy()

    fireEvent.click(screen.getByText('确认删除'))
    await waitFor(() => expect(deps.apiSend).toHaveBeenCalledTimes(1))
    expect(deps.apiSend).toHaveBeenCalledWith('POST', ROUTES.shelfBatchDelete.path, { keys: ['k-a', 'k-b'] })
    // 成功：被删的两张卡片消失、未点名的本地书还在、选择清零并退出多选态
    await waitFor(() => expect(screen.queryByText('斗罗')).toBeNull())
    expect(screen.queryByText('剑来')).toBeNull()
    expect(screen.getByText('本地书')).toBeTruthy()
    expect(document.querySelector('[data-novel-selbar]')).toBeNull()
    expect(firstX()).toBeTruthy()
  })

  it('含本地书 → 模态点名副本连删与原始文件不受影响', async () => {
    await mount([A, L])
    enterSelect()
    fireEvent.click(card('斗罗'))
    fireEvent.click(card('本地书'))
    fireEvent.click(barButton('删除所选'))
    expect(screen.getByText('删除选中的 2 本书？')).toBeTruthy()
    expect(screen.getByText(/1 本为本地书/)).toBeTruthy()
    expect(screen.getByText(/原始文件不受影响/)).toBeTruthy()
  })

  it('批量失败 → 留在框内可就地重试；卡片与选择都保留', async () => {
    const apiSend = vi.fn()
      .mockRejectedValueOnce(new Error('删不动'))
      .mockResolvedValueOnce({ removed: 2 })
    const deps = await mount([A, B], apiSend)
    enterSelect()
    fireEvent.click(card('斗罗'))
    fireEvent.click(card('剑来'))
    fireEvent.click(barButton('删除所选'))
    fireEvent.click(screen.getByText('确认删除'))

    await waitFor(() => expect(screen.getByText(/删除失败/)).toBeTruthy())
    expect(deps.apiSend).toHaveBeenCalledTimes(1)
    expect(screen.getByText('斗罗')).toBeTruthy()          // 失败不清卡片
    expect(screen.getByRole('dialog')).toBeTruthy()        // 也不收模态

    fireEvent.click(screen.getByText('确认删除'))            // 就地重试
    await waitFor(() => expect(deps.apiSend).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByText('斗罗')).toBeNull())
    expect(document.querySelector('[data-novel-selbar]')).toBeNull()
  })

  it('Esc 取消批量确认 → 零请求，选择与多选态都留着（现场不清）', async () => {
    const deps = await mount([A, B])
    enterSelect()
    fireEvent.click(card('斗罗'))
    fireEvent.click(card('剑来'))
    fireEvent.click(barButton('删除所选'))
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(deps.apiSend).not.toHaveBeenCalled()
    expect(screen.getByText('已选 2')).toBeTruthy()
    expect(screen.getByText('斗罗')).toBeTruthy()
  })

  it('单本 ✕ 仍走单删路由且不弹批量文案（两条入口各自的路径不串）', async () => {
    const deps = await mount([A, B])
    fireEvent.click(firstX())
    expect(screen.getByText('删除《斗罗》？')).toBeTruthy()
    fireEvent.click(screen.getByText('确认删除'))
    await waitFor(() => expect(deps.apiSend).toHaveBeenCalledTimes(1))
    expect(deps.apiSend.mock.calls[0][0]).toBe('DELETE')
    expect(String(deps.apiSend.mock.calls[0][1])).toContain('shelf/')
  })
})
