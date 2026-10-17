import { describe, expect, it } from 'vitest'
import { log, setLogSink, type LogSink } from '../../src/services/log.js'

describe('日志缝', () => {
  it('三级出口都经 setLogSink 装入的 sink，首参恒为 [dsh-novel] 前缀', () => {
    const seen: Array<{ level: string; args: unknown[] }> = []
    const capture: LogSink = {
      info: (...args) => { seen.push({ level: 'info', args }) },
      warn: (...args) => { seen.push({ level: 'warn', args }) },
      error: (...args) => { seen.push({ level: 'error', args }) },
    }
    setLogSink(capture)
    try {
      log.warn('动态头规则求值失败，回退静态头')
      log.error('sources.json 落盘失败')
      log.info('出站代理: http://127.0.0.1:7890')
    } finally { setLogSink(console) }
    expect(seen).toEqual([
      { level: 'warn', args: ['[dsh-novel]', '动态头规则求值失败，回退静态头'] },
      { level: 'error', args: ['[dsh-novel]', 'sources.json 落盘失败'] },
      { level: 'info', args: ['[dsh-novel]', '出站代理: http://127.0.0.1:7890'] },
    ])
  })
})
