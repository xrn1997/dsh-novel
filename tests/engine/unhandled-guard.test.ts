import { describe, expect, it, vi } from 'vitest'

/** 防线 sink 注入：引擎不认识 services，前缀/去向由组合根递进来；这里钉「注入的 sink 真收到
 *  告警」这一条（默认 console sink 的离线行为另由 log 缝的缺省路径覆盖）。 */
describe('unhandledRejection guard 的注入 sink', () => {
  it('注入 sink 收到告警与 reason 文本', async () => {
    vi.resetModules()
    const mod = await import('../../src/engine/js-sandbox.js')
    const warn = vi.fn()
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const detach = mod.ensureUnhandledGuard({ warn })
    try {
      process.emit('unhandledRejection', new Error('boom'), Promise.resolve())
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0][0])).toContain('未处理的 rejection')
      expect(warn.mock.calls[0][1]).toBe('boom')
    } finally {
      consoleSpy.mockRestore()
      detach()
    }
  })
})
