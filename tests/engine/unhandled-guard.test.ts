import { describe, expect, it, vi } from 'vitest'
import { pick } from '../support/fixture.js'

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
      expect(String(pick(warn.mock.calls, 0)[0])).toContain('未处理的 rejection')
      expect(pick(warn.mock.calls, 0)[1]).toBe('boom')
    } finally {
      consoleSpy.mockRestore()
      detach()
    }
  })

  it('引擎错误类的 rejection 升级到 error：真 bug 不与脚本噪声同档', async () => {
    vi.resetModules()
    const mod = await import('../../src/engine/js-sandbox.js')
    const { RuleEvalError } = await import('../../src/engine/errors.js')
    const warn = vi.fn()
    const error = vi.fn()
    const detach = mod.ensureUnhandledGuard({ warn, error })
    try {
      process.emit('unhandledRejection', new RuleEvalError('炸了', {
        facet: 'content', segmentIndex: 0, segmentRaw: 'x', hits: 0,
      }), Promise.resolve())
      expect(error).toHaveBeenCalledTimes(1)
      expect(String(pick(error.mock.calls, 0)[0]), '读数要说清是谁家的错').toContain('插件内部错误')
      expect(warn, '同一条不该两档都出声').not.toHaveBeenCalled()
    } finally {
      detach()
    }
  })

  it('只注入 warn 的旧 sink 仍走 warn（没 error 通道时不硬造一条）', async () => {
    vi.resetModules()
    const mod = await import('../../src/engine/js-sandbox.js')
    const { JsSandboxError } = await import('../../src/engine/errors.js')
    const warn = vi.fn()
    const detach = mod.ensureUnhandledGuard({ warn })
    try {
      process.emit('unhandledRejection', new JsSandboxError('脚本炸了', {
        facet: 'content', segmentIndex: 0, segmentRaw: '@js:1', script: '1',
      }), Promise.resolve())
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      detach()
    }
  })

  it('泄漏的 RegexDeadlineError 按插件内部错误升档：调用点漏转的中继错误不许顶「沙箱脚本产生」的标签', async () => {
    vi.resetModules()
    const mod = await import('../../src/engine/js-sandbox.js')
    const { RegexDeadlineError } = await import('../../src/engine/errors.js')
    const warn = vi.fn()
    const error = vi.fn()
    const detach = mod.ensureUnhandledGuard({ warn, error })
    try {
      process.emit('unhandledRejection', new RegexDeadlineError('(?:a+)+$', 200), Promise.resolve())
      expect(error, '漏转 = 插件 bug：升档不降档').toHaveBeenCalledTimes(1)
      expect(String(pick(error.mock.calls, 0)[0]), '读数要认得出是插件内部的错').toContain('插件内部错误')
      expect(warn, '不许以「沙箱脚本产生」的标签混进脚本噪声').not.toHaveBeenCalled()
    } finally {
      detach()
    }
  })

  it('warn-only 旧 sink 对插件内部错误保留诚实标签（没有 error 通道也不改口「沙箱脚本产生」）', async () => {
    vi.resetModules()
    const mod = await import('../../src/engine/js-sandbox.js')
    const { RegexDeadlineError } = await import('../../src/engine/errors.js')
    const warn = vi.fn()
    const detach = mod.ensureUnhandledGuard({ warn })
    try {
      process.emit('unhandledRejection', new RegexDeadlineError('(?:a+)+$', 200), Promise.resolve())
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(pick(warn.mock.calls, 0)[0]), '退 warn 可以，改口说「沙箱脚本产生」不行').toContain('插件内部错误')
    } finally {
      detach()
    }
  })

  it('缺省 sink 也带 error 腿：离线直用引擎时，引擎错误不落进「沙箱脚本产生的」那条标签', async () => {
    vi.resetModules()
    const mod = await import('../../src/engine/js-sandbox.js')
    const { UnsupportedRuleError } = await import('../../src/engine/errors.js')
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const detach = mod.ensureUnhandledGuard()
    try {
      process.emit('unhandledRejection', new UnsupportedRuleError('认不出这语法', {
        facet: 'content', segmentIndex: 0, segmentRaw: '???',
      }), Promise.resolve())
      expect(errorSpy).toHaveBeenCalledTimes(1)
      expect(pick(errorSpy.mock.calls, 0)[0], '缺省 sink 自己缀前缀（注入方的前缀归那条腿）').toBe('[dsh-novel]')
      expect(String(pick(errorSpy.mock.calls, 0)[1])).toContain('插件内部错误')
      expect(warnSpy, '标签说「脚本产生」而它来自插件自己的代码——谎报要红').not.toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
      warnSpy.mockRestore()
      detach()
    }
  })
})
