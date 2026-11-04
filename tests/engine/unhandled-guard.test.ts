import { describe, expect, it, vi } from 'vitest'
import { pick } from '../support/fixture.js'

/** 沙箱 promise 的假体：只带 realm 标（识别判据就是它，见 `SANDBOX_REALM_MARK`）。
 *  真沙箱里的标由 BOOTSTRAP 打在 `Promise.prototype` 上，`Symbol.keyFor` 那条用例钉住 key 没漂。 */
const sandboxPromise = (mark: symbol): Promise<unknown> =>
  ({ [mark]: true }) as unknown as Promise<unknown>

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
      process.emit('unhandledRejection', new Error('boom'), sandboxPromise(mod.SANDBOX_REALM_MARK))
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
      }), sandboxPromise(mod.SANDBOX_REALM_MARK))
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
      }), sandboxPromise(mod.SANDBOX_REALM_MARK))
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
      process.emit('unhandledRejection', new RegexDeadlineError('(?:a+)+$', 200), sandboxPromise(mod.SANDBOX_REALM_MARK))
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
      process.emit('unhandledRejection', new RegexDeadlineError('(?:a+)+$', 200), sandboxPromise(mod.SANDBOX_REALM_MARK))
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
      }), sandboxPromise(mod.SANDBOX_REALM_MARK))
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

describe('unhandledRejection guard 的来源识别与订阅生命周期', () => {
  it('非沙箱来源：如实记「非沙箱来源」，且别的监听器在场时不抢着恢复致命语义', async () => {
    vi.resetModules()
    const mod = await import('../../src/engine/js-sandbox.js')
    const warn = vi.fn()
    const error = vi.fn()
    const other = vi.fn()
    process.on('unhandledRejection', other)
    const detach = mod.ensureUnhandledGuard({ warn, error })
    try {
      process.emit('unhandledRejection', new Error('别的插件的 bug'), Promise.resolve())
      expect(error).toHaveBeenCalledTimes(1)
      expect(String(pick(error.mock.calls, 0)[0])).toContain('非沙箱来源')
      expect(warn, '非沙箱来源不是「沙箱脚本产生」——不许套那条标签').not.toHaveBeenCalled()
      expect(other, '别的监听器照旧收到（我们不吞事件）').toHaveBeenCalledTimes(1)
    } finally {
      detach()
      process.off('unhandledRejection', other)
    }
  })

  it('多订阅者共存：各自的 sink 都收到；少一个订阅不摘监听器，最后一个释放才摘', async () => {
    vi.resetModules()
    const mod = await import('../../src/engine/js-sandbox.js')
    const a = vi.fn()
    const b = vi.fn()
    const baseline = process.listenerCount('unhandledRejection')
    const detachA = mod.ensureUnhandledGuard({ warn: a })
    const detachB = mod.ensureUnhandledGuard({ warn: b })
    const mark = mod.SANDBOX_REALM_MARK
    expect(process.listenerCount('unhandledRejection')).toBe(baseline + 1)
    try {
      process.emit('unhandledRejection', new Error('x'), sandboxPromise(mark))
      expect(a).toHaveBeenCalledTimes(1)
      expect(b, '后订阅的 sink 也要收到（先挂的不再独占）').toHaveBeenCalledTimes(1)
      detachA()
      process.emit('unhandledRejection', new Error('y'), sandboxPromise(mark))
      expect(a).toHaveBeenCalledTimes(1)
      expect(b).toHaveBeenCalledTimes(2)
      expect(process.listenerCount('unhandledRejection'), '还有一份订阅时不许摘').toBe(baseline + 1)
    } finally {
      detachA()
      detachB()
    }
    expect(process.listenerCount('unhandledRejection'), '最后一份释放后摘干净').toBe(baseline)
  })

  it('真 sink 在场时 console 兜底退场：同一条 rejection 不出两行', async () => {
    vi.resetModules()
    const mod = await import('../../src/engine/js-sandbox.js')
    const warn = vi.fn()
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const detach = mod.ensureUnhandledGuard({ warn })
    try {
      // 引擎每次跑脚本前的兜底调用：真 sink 已把兜底顶替，这份 acquire 必须是空操作
      // （否则一条 rejection 既由兜底直打 console，又经日志缝的 console 腿打一遍）
      mod.ensureUnhandledGuard()
      process.emit('unhandledRejection', new Error('x'), sandboxPromise(mod.SANDBOX_REALM_MARK))
      expect(warn).toHaveBeenCalledTimes(1)
      expect(consoleSpy, '兜底与真 sink 各打一遍 = stderr 两行').not.toHaveBeenCalled()
    } finally {
      detach()
      consoleSpy.mockRestore()
    }
  })

  it('兜底那份订阅不熬过真 sink 释放：监听器计数回到基线', async () => {
    vi.resetModules()
    const mod = await import('../../src/engine/js-sandbox.js')
    const baseline = process.listenerCount('unhandledRejection')
    // 引擎先挂兜底（离线直用形态；兜底没有释放点）
    mod.ensureUnhandledGuard()
    expect(process.listenerCount('unhandledRejection')).toBe(baseline + 1)
    // 真 sink 到场顶替兜底：不能因此再挂第二条监听器
    const detach = mod.ensureUnhandledGuard({ warn: vi.fn() })
    expect(process.listenerCount('unhandledRejection'), '顶替时又挂了一条监听器').toBe(baseline + 1)
    detach()
    expect(process.listenerCount('unhandledRejection'), '兜底残留把监听器留在进程里（插件卸载后还替宿主收场）').toBe(baseline)
  })

  it('realm 标的 key 与 BOOTSTRAP 里那个串一致（模板串不能 import，只能靠这条钉）', async () => {
    vi.resetModules()
    const mod = await import('../../src/engine/js-sandbox.js')
    expect(Symbol.keyFor(mod.SANDBOX_REALM_MARK)).toBe('dsh-novel.sandbox-realm')
  })
})

describe('宿主未处理 rejection 策略与致命语义恢复', () => {
  it('策略表：缺省/throw 恢复致命，warn/none 尊重宿主；execArgv 与 NODE_OPTIONS 同认', async () => {
    vi.resetModules()
    const mod = await import('../../src/engine/js-sandbox.js')
    expect(mod.hostWantsFatalRejections([], undefined), '缺省 = Node 15+ 的 throw').toBe(true)
    expect(mod.hostWantsFatalRejections(['--unhandled-rejections=throw'], undefined)).toBe(true)
    expect(mod.hostWantsFatalRejections(['--unhandled-rejections=warn'], undefined)).toBe(false)
    expect(mod.hostWantsFatalRejections(['--unhandled-rejections=none'], undefined)).toBe(false)
    expect(mod.hostWantsFatalRejections([], '--unhandled-rejections=warn')).toBe(false)
    expect(mod.hostWantsFatalRejections([], '--inspect --unhandled-rejections=throw')).toBe(true)
    expect(mod.hostWantsFatalRejections(['--unhandled-rejections=warn'], '--unhandled-rejections=throw'),
      'execArgv 优先于 NODE_OPTIONS（与 Node 的优先级一致）').toBe(false)
    // Node 启动器同时收空格写法；只认等号会把宿主显式选的 warn/none 误判回致命。
    expect(mod.hostWantsFatalRejections(['--unhandled-rejections', 'warn'], undefined), 'argv 空格写法').toBe(false)
    expect(mod.hostWantsFatalRejections(['--unhandled-rejections', 'throw'], undefined)).toBe(true)
    expect(mod.hostWantsFatalRejections([], '--unhandled-rejections warn'), 'NODE_OPTIONS 空格写法').toBe(false)
    expect(mod.hostWantsFatalRejections([], '--unhandled-rejections="warn"'), 'NODE_OPTIONS 引号写法').toBe(false)
    expect(mod.hostWantsFatalRejections(['--unhandled-rejections=warn', '--unhandled-rejections=throw'], undefined),
      '同一来源多次出现：后者覆盖前者（Node 同序）').toBe(true)
  })

  it('唯一监听者 + 缺省策略：原 reason 在 nextTick 抛出（恢复致命语义）', async () => {
    vi.resetModules()
    const mod = await import('../../src/engine/js-sandbox.js')
    const argv = process.execArgv
    process.execArgv = []
    vi.stubEnv('NODE_OPTIONS', '')
    const listeners = vi.spyOn(process, 'listenerCount').mockReturnValue(1)
    // 同步执行回调：把「抛在下一轮」变成「抛在当场」，测试进程不必真死一次
    const tick = vi.spyOn(process, 'nextTick')
      .mockImplementation(((fn: () => void) => { fn(); return process }) as typeof process.nextTick)
    try {
      expect(() => mod.restoreDefault(new Error('boom'))).toThrow('boom')
    } finally {
      tick.mockRestore()
      listeners.mockRestore()
      vi.unstubAllEnvs()
      process.execArgv = argv
    }
  })

  it('宿主 realm 的引擎错误类：按插件内部错误记 error，不被当成宿主来源致命化', async () => {
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
      expect(String(pick(error.mock.calls, 0)[0])).toContain('插件内部错误')
      expect(warn).not.toHaveBeenCalled()
      // 若误入「非沙箱来源 → restoreDefault」，nextTick 会把测试进程带走；等一轮事件循环证明它没发生
      await new Promise((resolve) => setImmediate(resolve))
    } finally {
      detach()
    }
  })
})

describe('真沙箱 promise 的来源识别（集成：脚本里悬空的 rejection）', () => {
  it('脚本自建又 fire-and-forget 的 rejection 走「沙箱脚本产生」那条，不被当成宿主错误', async () => {
    vi.resetModules()
    const mod = await import('../../src/engine/js-sandbox.js')
    const warn = vi.fn()
    const error = vi.fn()
    const detach = mod.ensureUnhandledGuard({ warn, error })
    try {
      // 脚本正常返回 1，另起一条链在稍后 reject：这是「悬空」的真实形态（不是在返回值里递错）
      const out = await mod.runScript({
        code: 'Promise.resolve().then(function () { throw new Error("悬空") }); 1',
        loc: { segmentIndex: -1, segmentRaw: '(test)' }, facet: 'search',
      })
      expect(out.value).toMatchObject({ kind: 'value' })
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(warn, '沙箱 promise 没被认出来（BOOTSTRAP 的 realm 标没生效？）').toHaveBeenCalled()
      expect(String(pick(warn.mock.calls, 0)[0])).toContain('沙箱脚本产生')
      expect(error, '真沙箱的噪声不许升成宿主错误').not.toHaveBeenCalled()
    } finally {
      detach()
    }
  })
})
