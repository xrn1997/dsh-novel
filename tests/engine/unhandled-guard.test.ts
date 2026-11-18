import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  SANDBOX_REALM_MARK,
  acquireRejectionGuard,
  hostWantsFatalRejections,
} from '../../src/engine/rejection-guard.js'
import { JsSandboxError, RegexDeadlineError, RuleEvalError, UnsupportedRuleError } from '../../src/engine/errors.js'
import * as sandbox from '../../src/engine/js-sandbox.js'
import { runScript } from '../../src/engine/js-sandbox.js'
import { pick } from '../support/fixture.js'
import { withoutComments } from '../without-comments.js'

/**
 * 守卫 module 的直测：**直接 import 被测 module**，不再用 `vi.resetModules()` 重装整张模块图。
 * 守卫状态（订阅计数表、监听器已挂布尔）是模块级单点，本文件里每个用例都在 finally 里释放自己
 * 那一份订阅；console 兜底那份没有释放点（求值入口每次 acquire 一次），用到它的用例在结尾用
 * 「真 sink 到场顶替再释放」把它清掉，否则监听器会漏到下一个用例。
 *
 * 真沙箱集成用例留在本文件末尾：它们验证的是 BOOTSTRAP 打在 vm realm 上的标与求值入口的兜底，
 * 不是守卫自身的策略表。
 */

/** 沙箱 promise 的假体：只带 realm 标（识别判据就是它，见 `SANDBOX_REALM_MARK`）。
 *  真沙箱里的标由 BOOTSTRAP 打在 `Promise.prototype` 上，`Symbol.keyFor` 与源码字符串两条用例钉住没漂。 */
const sandboxPromise = (mark: symbol): Promise<unknown> =>
  ({ [mark]: true }) as unknown as Promise<unknown>

const noopSink = (): { warn: () => void } => ({ warn: () => undefined })

describe('unhandledRejection guard 的注入 sink', () => {
  it('注入 sink 收到告警与 reason 文本', () => {
    const warn = vi.fn()
    const detach = acquireRejectionGuard({ warn })
    try {
      process.emit('unhandledRejection', new Error('boom'), sandboxPromise(SANDBOX_REALM_MARK))
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(pick(warn.mock.calls, 0)[0])).toContain('未处理的 rejection')
      expect(pick(warn.mock.calls, 0)[1]).toBe('boom')
    } finally {
      detach()
    }
  })

  it('引擎错误类的 rejection 升级到 error：真 bug 不与脚本噪声同档', () => {
    const warn = vi.fn()
    const error = vi.fn()
    const detach = acquireRejectionGuard({ warn, error })
    try {
      process.emit('unhandledRejection', new RuleEvalError('炸了', {
        facet: 'content', segmentIndex: 0, segmentRaw: 'x', hits: 0,
      }), sandboxPromise(SANDBOX_REALM_MARK))
      expect(error).toHaveBeenCalledTimes(1)
      expect(String(pick(error.mock.calls, 0)[0]), '读数要说清是谁家的错').toContain('插件内部错误')
      expect(warn, '同一条不该两档都出声').not.toHaveBeenCalled()
    } finally {
      detach()
    }
  })

  it('只注入 warn 的旧 sink 仍走 warn（没 error 通道时不硬造一条）', () => {
    const warn = vi.fn()
    const detach = acquireRejectionGuard({ warn })
    try {
      process.emit('unhandledRejection', new JsSandboxError('脚本炸了', {
        facet: 'content', segmentIndex: 0, segmentRaw: '@js:1', script: '1',
      }), sandboxPromise(SANDBOX_REALM_MARK))
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      detach()
    }
  })

  it('泄漏的 RegexDeadlineError 按插件内部错误升档：调用点漏转的中继错误不许顶「沙箱脚本产生」的标签', () => {
    const warn = vi.fn()
    const error = vi.fn()
    const detach = acquireRejectionGuard({ warn, error })
    try {
      process.emit('unhandledRejection', new RegexDeadlineError('(?:a+)+$', 200), sandboxPromise(SANDBOX_REALM_MARK))
      expect(error, '漏转 = 插件 bug：升档不降档').toHaveBeenCalledTimes(1)
      expect(String(pick(error.mock.calls, 0)[0]), '读数要认得出是插件内部的错').toContain('插件内部错误')
      expect(warn, '不许以「沙箱脚本产生」的标签混进脚本噪声').not.toHaveBeenCalled()
    } finally {
      detach()
    }
  })

  it('warn-only 旧 sink 对插件内部错误保留诚实标签（没有 error 通道也不改口「沙箱脚本产生」）', () => {
    const warn = vi.fn()
    const detach = acquireRejectionGuard({ warn })
    try {
      process.emit('unhandledRejection', new RegexDeadlineError('(?:a+)+$', 200), sandboxPromise(SANDBOX_REALM_MARK))
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(pick(warn.mock.calls, 0)[0]), '退 warn 可以，改口说「沙箱脚本产生」不行').toContain('插件内部错误')
    } finally {
      detach()
    }
  })

  it('缺省 sink 也带 error 腿：离线直用引擎时，引擎错误不落进「沙箱脚本产生的」那条标签', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const detach = acquireRejectionGuard()
    try {
      process.emit('unhandledRejection', new UnsupportedRuleError('认不出这语法', {
        facet: 'content', segmentIndex: 0, segmentRaw: '???',
      }), sandboxPromise(SANDBOX_REALM_MARK))
      expect(errorSpy).toHaveBeenCalledTimes(1)
      expect(pick(errorSpy.mock.calls, 0)[0], '缺省 sink 自己缀前缀（注入方的前缀归那条腿）').toBe('[dsh-novel]')
      expect(String(pick(errorSpy.mock.calls, 0)[1])).toContain('插件内部错误')
      expect(warnSpy, '标签说「脚本产生」而它来自插件自己的代码——谎报要红').not.toHaveBeenCalled()
    } finally {
      detach()
      errorSpy.mockRestore()
      warnSpy.mockRestore()
    }
  })
})

describe('unhandledRejection guard 的来源识别与订阅生命周期', () => {
  it('非沙箱来源：如实记「非沙箱来源」，且别的监听器在场时不抢着恢复致命语义', () => {
    const warn = vi.fn()
    const error = vi.fn()
    const other = vi.fn()
    process.on('unhandledRejection', other)
    const detach = acquireRejectionGuard({ warn, error })
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

  it('多订阅者共存：各自的 sink 都收到；少一个订阅不摘监听器，最后一个释放才摘', () => {
    const a = vi.fn()
    const b = vi.fn()
    const baseline = process.listenerCount('unhandledRejection')
    const detachA = acquireRejectionGuard({ warn: a })
    const detachB = acquireRejectionGuard({ warn: b })
    expect(process.listenerCount('unhandledRejection')).toBe(baseline + 1)
    try {
      process.emit('unhandledRejection', new Error('x'), sandboxPromise(SANDBOX_REALM_MARK))
      expect(a).toHaveBeenCalledTimes(1)
      expect(b, '后订阅的 sink 也要收到（先挂的不再独占）').toHaveBeenCalledTimes(1)
      detachA()
      process.emit('unhandledRejection', new Error('y'), sandboxPromise(SANDBOX_REALM_MARK))
      expect(a).toHaveBeenCalledTimes(1)
      expect(b).toHaveBeenCalledTimes(2)
      expect(process.listenerCount('unhandledRejection'), '还有一份订阅时不许摘').toBe(baseline + 1)
    } finally {
      detachA()
      detachB()
    }
    expect(process.listenerCount('unhandledRejection'), '最后一份释放后摘干净').toBe(baseline)
  })

  it('真 sink 在场时 console 兜底退场：同一条 rejection 不出两行', () => {
    const warn = vi.fn()
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const detach = acquireRejectionGuard({ warn })
    try {
      // 求值入口每次跑脚本前的兜底调用：真 sink 已把兜底顶替，这份 acquire 必须是空操作
      // （否则一条 rejection 既由兜底直打 console，又经日志缝的 console 腿打一遍）
      acquireRejectionGuard()
      process.emit('unhandledRejection', new Error('x'), sandboxPromise(SANDBOX_REALM_MARK))
      expect(warn).toHaveBeenCalledTimes(1)
      expect(consoleSpy, '兜底与真 sink 各打一遍 = stderr 两行').not.toHaveBeenCalled()
    } finally {
      detach()
      consoleSpy.mockRestore()
    }
  })

  it('兜底那份订阅不熬过真 sink 释放：监听器计数回到基线', () => {
    const baseline = process.listenerCount('unhandledRejection')
    // 离线直用形态：求值入口先挂兜底（兜底没有释放点）
    acquireRejectionGuard()
    expect(process.listenerCount('unhandledRejection')).toBe(baseline + 1)
    // 真 sink 到场顶替兜底：不能因此再挂第二条监听器
    const detach = acquireRejectionGuard({ warn: vi.fn() })
    expect(process.listenerCount('unhandledRejection'), '顶替时又挂了一条监听器').toBe(baseline + 1)
    detach()
    expect(process.listenerCount('unhandledRejection'), '兜底残留把监听器留在进程里（插件卸载后还替宿主收场）').toBe(baseline)
  })
})

describe('宿主未处理 rejection 策略与致命语义恢复', () => {
  it('策略表：缺省/throw 恢复致命，warn/none 尊重宿主；execArgv 与 NODE_OPTIONS 同认', () => {
    expect(hostWantsFatalRejections([], undefined), '缺省 = Node 15+ 的 throw').toBe(true)
    expect(hostWantsFatalRejections(['--unhandled-rejections=throw'], undefined)).toBe(true)
    expect(hostWantsFatalRejections(['--unhandled-rejections=warn'], undefined)).toBe(false)
    expect(hostWantsFatalRejections(['--unhandled-rejections=none'], undefined)).toBe(false)
    expect(hostWantsFatalRejections([], '--unhandled-rejections=warn')).toBe(false)
    expect(hostWantsFatalRejections([], '--inspect --unhandled-rejections=throw')).toBe(true)
    expect(hostWantsFatalRejections(['--unhandled-rejections=warn'], '--unhandled-rejections=throw'),
      'execArgv 优先于 NODE_OPTIONS（与 Node 的优先级一致）').toBe(false)
    // Node 启动器同时收空格写法；只认等号会把宿主显式选的 warn/none 误判回致命。
    expect(hostWantsFatalRejections(['--unhandled-rejections', 'warn'], undefined), 'argv 空格写法').toBe(false)
    expect(hostWantsFatalRejections(['--unhandled-rejections', 'throw'], undefined)).toBe(true)
    expect(hostWantsFatalRejections([], '--unhandled-rejections warn'), 'NODE_OPTIONS 空格写法').toBe(false)
    expect(hostWantsFatalRejections([], '--unhandled-rejections="warn"'), 'NODE_OPTIONS 引号写法').toBe(false)
    expect(hostWantsFatalRejections(['--unhandled-rejections=warn', '--unhandled-rejections=throw'], undefined),
      '同一来源多次出现：后者覆盖前者（Node 同序）').toBe(true)
  })

  it('唯一监听者 + 缺省策略：原 reason 在 nextTick 抛出（恢复致命语义）', () => {
    const argv = process.execArgv
    process.execArgv = []
    vi.stubEnv('NODE_OPTIONS', '')
    const listeners = vi.spyOn(process, 'listenerCount').mockReturnValue(1)
    // 同步执行回调：把「抛在下一轮」变成「抛在当场」，测试进程不必真死一次
    const tick = vi.spyOn(process, 'nextTick')
      .mockImplementation(((fn: () => void) => { fn(); return process }) as typeof process.nextTick)
    const detach = acquireRejectionGuard(noopSink())
    try {
      expect(
        () => process.emit('unhandledRejection', new Error('boom'), Promise.resolve()),
        '非沙箱来源 + 唯一监听者 + 缺省策略 = 恢复 Node 的致命语义',
      ).toThrow('boom')
    } finally {
      tick.mockRestore()
      listeners.mockRestore()
      vi.unstubAllEnvs()
      process.execArgv = argv
      detach()
    }
  })

  it('宿主策略显式选 warn：非沙箱来源只留日志、不改回致命', () => {
    const argv = process.execArgv
    process.execArgv = ['--unhandled-rejections=warn']
    const listeners = vi.spyOn(process, 'listenerCount').mockReturnValue(1)
    // 同步执行的 nextTick：若防线误恢复致命语义，这一发 emit 会当场抛出来
    const tick = vi.spyOn(process, 'nextTick')
      .mockImplementation(((fn: () => void) => { fn(); return process }) as typeof process.nextTick)
    const error = vi.fn()
    const warn = vi.fn()
    const detach = acquireRejectionGuard({ warn, error })
    try {
      expect(
        () => process.emit('unhandledRejection', new Error('宿主自己的'), Promise.resolve()),
        '宿主选了 warn 就不许替它把进程带走',
      ).not.toThrow()
      expect(error).toHaveBeenCalledTimes(1)
    } finally {
      tick.mockRestore()
      listeners.mockRestore()
      process.execArgv = argv
      detach()
    }
  })

  it('宿主 realm 的引擎错误类：按插件内部错误记 error，不被当成宿主来源致命化', async () => {
    const warn = vi.fn()
    const error = vi.fn()
    const detach = acquireRejectionGuard({ warn, error })
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

describe('守卫不再是沙箱的导出面（组合根直接 import 守卫 module）', () => {
  it('js-sandbox 不再导出任何守卫符号', () => {
    for (const name of ['SANDBOX_REALM_MARK', 'GuardSink', 'hostWantsFatalRejections', 'restoreDefault', 'ensureUnhandledGuard', 'acquireRejectionGuard']) {
      expect(Object.keys(sandbox), `js-sandbox 又长出了守卫导出 ${name}`).not.toContain(name)
    }
  })

  it('realm 标的 key 与 BOOTSTRAP 源码里那个串一致（模板串不能 import，只能靠这条钉）', () => {
    const source = withoutComments(readFileSync(fileURLToPath(new URL('../../src/engine/js-sandbox.ts', import.meta.url)), 'utf8'))
    const keys = [...source.matchAll(/Symbol\.for\('([^']+)'\)/g)].map((m) => pick(m, 1))
    expect(keys, 'BOOTSTRAP 里应当恰好一个 realm 标 key（多一个是第二份抄本）').toEqual(['dsh-novel.sandbox-realm'])
    expect(Symbol.keyFor(SANDBOX_REALM_MARK)).toBe(pick(keys, 0))
  })
})

describe('真沙箱集成：守卫与求值入口的接线', () => {
  it('脚本自建又 fire-and-forget 的 rejection 走「沙箱脚本产生」那条，不被当成宿主错误', async () => {
    const warn = vi.fn()
    const error = vi.fn()
    const detach = acquireRejectionGuard({ warn, error })
    try {
      // 脚本正常返回 1，另起一条链在稍后 reject：这是「悬空」的真实形态（不是在返回值里递错）
      const out = await runScript({
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

  it('BOOTSTRAP 在 vm realm 的 Promise.prototype 上真的打上了标', async () => {
    const key = Symbol.keyFor(SANDBOX_REALM_MARK)
    const out = await runScript({
      code: `return String(Promise.prototype[Symbol.for(${JSON.stringify(key)})])`,
      loc: { segmentIndex: -1, segmentRaw: '(test)' }, facet: 'search',
    })
    expect(out.value).toMatchObject({ kind: 'value', text: 'true' })
  })

  it('async 函数创建的 intrinsic promise 也带 realm 标（标打 prototype 才盖得住它）', async () => {
    const key = Symbol.keyFor(SANDBOX_REALM_MARK)
    const out = await runScript({
      code: `return String((async function () {})()[Symbol.for(${JSON.stringify(key)})])`,
      loc: { segmentIndex: -1, segmentRaw: '(test)' }, facet: 'search',
    })
    expect(out.value, 'async 函数用的是 intrinsic %Promise%，给构造器打标会漏掉它').toMatchObject({ kind: 'value', text: 'true' })
  })

  it('求值入口的兜底：离线直用时悬空 rejection 经 console 兜底出声，不炸进程', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await runScript({
        code: 'Promise.resolve().then(function () { throw new Error("离线悬空") }); 1',
        loc: { segmentIndex: -1, segmentRaw: '(test)' }, facet: 'search',
      })
      await new Promise((resolve) => setTimeout(resolve, 50))
      const lines = warnSpy.mock.calls.map((call) => call.map(String).join(' '))
      expect(lines.some((line) => line.includes('沙箱脚本产生')), '求值入口没挂兜底（悬空 rejection 会落到宿主）').toBe(true)
    } finally {
      warnSpy.mockRestore()
      // 兜底那份订阅没有释放点（求值入口每次 acquire 一份）：真 sink 出场顶替它，再释放回基线
      acquireRejectionGuard(noopSink())()
    }
  })
})
