import { describe, expect, it } from 'vitest'
import { JobTail } from '../../src/services/job-tail.js'

/** 偏移读的语义全在这几条里：不消费（缓冲没长时同一 from 两次同文）、只增的 nextOffset、
 *  超帽如实 lossy。「消费式」那套（读一次清空）已经退役——宿主是按自己的游标来拉的，
 *  缓冲不能替读者记账。 */
describe('JobTail（宿主输出面的偏移可读缓冲）', () => {
  it('偏移读不消费：缓冲没长时同一个 from 读两次得到同一份；下一次从 nextOffset 读才是增量', () => {
    const t = new JobTail(64)
    t.push('甲')
    t.push('乙')
    const first = t.readFrom(0)
    expect(first.text).toContain('甲')
    expect(first.text).toContain('乙')
    expect(first.lossy).toBe(false)
    expect(first.nextOffset).toBeGreaterThan(0)
    expect(t.readFrom(0).text).toBe(first.text)          // 不是消费式：别的读者读不空我
    expect(t.readFrom(first.nextOffset).text).toBe('')   // 增量按游标
  })
  it('超帽从头丢：从 0 读只拿到保留段，lossy 为真并如实报丢弃行数', () => {
    const t = new JobTail(16)
    t.push('aaaaaaaa')
    t.push('bbbbbbbb')
    t.push('cccccccc')                                   // 27 字节 > 16 → 丢前两行
    const out = t.readFrom(0)
    expect(out.text).toContain('cccccccc')
    expect(out.text).not.toContain('aaaaaaaa')
    expect(out.text).toContain('丢弃 2 行')
    expect(out.lossy).toBe(true)
    expect(out.nextOffset).toBeGreaterThan(0)
  })
  it('丢弃横幅只在新增丢弃的那一批出现（数字是累计）', () => {
    const t = new JobTail(20)
    t.push('aaaaaaaa')
    t.push('bbbbbbbb')
    t.push('cccccccc')                                   // 24 > 20 → 丢 a
    const first = t.readFrom(0)
    expect(first.text).toContain('丢弃 1 行')
    t.push('dd')                                         // 30 - 9 = 21 > 20 → 再丢 b
    expect(t.readFrom(first.nextOffset).text).not.toContain('丢弃')    // 跟上进度的读者不再看到横幅
    expect(t.readFrom(0).text).toContain('丢弃 2 行')                  // 落后的新读者看到的是累计数
  })
  it('单行本身超帽时保留最后一行：帽是保留缓冲的帽，不是输出严格上界', () => {
    const t = new JobTail(4)
    t.push('abcdefgh')
    const out = t.readFrom(0)
    expect(out.text).toContain('abcdefgh')
    expect(out.lossy).toBe(false)
  })
  it('帽按 UTF-8 字节算，不按字符数', () => {
    const t = new JobTail(12)
    t.push('中文中文')                                    // 12 字节 + 换行 = 13 > 12，但只剩这一行 → 保留
    expect(t.readFrom(0).text).toContain('中文中文')
    t.push('再一行')
    expect(t.readFrom(0).lossy).toBe(true)                // 第一行被挤掉
  })
  it('游标越过尾部时 nextOffset 不回退（宿主侧不会因一次越界读把流重放一遍）', () => {
    const t = new JobTail(64)
    t.push('x')
    const out = t.readFrom(999)
    expect(out.text).toBe('')
    expect(out.nextOffset).toBeGreaterThanOrEqual(999)
  })
  it('from 落在行中间：从那一行的行首重发（重复几个字节好过丢字节）', () => {
    const t = new JobTail(64)
    t.push('aaaa')
    t.push('bbbb')
    const out = t.readFrom(2)      // 'aaaa\n' 的第二个字节：行中间
    expect(out.text).toBe('aaaa\nbbbb\n')
    expect(out.lossy).toBe(false)
  })
  it('第二个 lossy 读者仍拿得到保留段，但横幅只出现一次', () => {
    const t = new JobTail(16)
    t.push('aaaaaaaa')
    t.push('bbbbbbbb')
    t.push('cccccccc')             // 27 字节 > 16 → 丢前两行
    const first = t.readFrom(0)
    expect(first.text).toContain('丢弃 2 行')
    const second = t.readFrom(0)   // 另一个读者从同一旧游标读：仍是 lossy，但不重复报丢弃
    expect(second.lossy).toBe(true)
    expect(second.text).toContain('cccccccc')
    expect(second.text).not.toContain('丢弃')
    expect(second.nextOffset).toBe(first.nextOffset)
  })
})
