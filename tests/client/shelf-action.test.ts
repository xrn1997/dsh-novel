import { describe, expect, it, vi } from 'vitest'
import { paramOps } from '../../src/shared/wire.js'
import { addShelfSeat } from '../../src/client/shelf-action.js'

describe('addShelfSeat', () => {
  it('成功：走 shelfPut + shelfAdd，返回书身份', async () => {
    const apiSend = vi.fn(async () => ({}))
    const r = await addShelfSeat({ sourceId: 's1', title: '书', url: 'k1', author: 'a' }, { apiSend } as never)
    expect(r).toEqual({ ok: true, bookKey: 'k1' })
    expect(apiSend).toHaveBeenCalledWith(paramOps.shelfPut.at('k1'), {
      sourceId: 's1', title: '书', author: 'a',
    })
  })
  it('失败：返回 outcome，不抛', async () => {
    const error = new Error('disk')
    const apiSend = vi.fn(async () => { throw error })
    await expect(addShelfSeat({ sourceId: 's1', title: '书', url: 'k1' }, { apiSend } as never))
      .resolves.toEqual({ ok: false, error })
  })
})
