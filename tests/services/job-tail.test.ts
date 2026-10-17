import { describe, expect, it } from 'vitest'
import { JobTail } from '../../src/services/job-tail.js'

describe('JobTail（宿主 job 输出面的拉模型缓冲）', () => {
  it('超帽从头丢，丢掉的行如实报出来（不许静默）', () => {
    const t = new JobTail(16)
    t.push('aaaaaaaa')
    t.push('bbbbbbbb')
    t.push('cccccccc')
    const out = t.read()
    expect(out).toContain('cccccccc')
    expect(out).not.toContain('aaaaaaaa')
    expect(out).toContain('丢弃 1 行')
  })
  it('丢弃横幅只在新增丢弃的那批出现（数字是累计，不是每批重复）', () => {
    const t = new JobTail(20)
    t.push('aaaaaaaa')
    t.push('bbbbbbbb')
    t.push('cccccccc')                         // 24 > 20 → 丢 a
    expect(t.read()).toContain('丢弃 1 行')
    t.push('dd')                               // 18 ≤ 20，无新丢弃
    const out = t.read()
    expect(out).not.toContain('丢弃')
    expect(out).toBe('dd')
  })
  it('单行本身超帽时保留最后一行：帽是保留缓冲的帽，不是输出严格上界', () => {
    const t = new JobTail(4)
    t.push('abcdefgh')
    expect(t.read()).toContain('abcdefgh')
  })
  it('read 是消费式：同一批增量不重复交付', () => {
    const t = new JobTail(64)
    t.push('x')
    expect(t.read()).toContain('x')
    expect(t.read()).toBe('')
  })
  it('帽按 UTF-8 字节算，不按字符数', () => {
    const t = new JobTail(12)
    t.push('中文中文')      // 12 字节，正好装下
    expect(t.read()).toContain('中文中文')
    t.push('再一行')
    expect(t.read()).toMatch(/丢弃/)
  })
})
