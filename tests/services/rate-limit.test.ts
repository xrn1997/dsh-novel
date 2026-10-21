import { describe, expect, it } from 'vitest'
import { parseConcurrentRate, RateLimiter } from '../../src/services/rate-limit.js'

describe('parseConcurrentRate', () => {
  it('parses a/b and bare numbers like upstream', () => {
    expect(parseConcurrentRate('3/1000')).toEqual({ limit: 3, intervalMs: 1000 })
    expect(parseConcurrentRate('1000')).toEqual({ limit: 1, intervalMs: 1000 })
    expect(parseConcurrentRate(' 50/60000 ')).toEqual({ limit: 50, intervalMs: 60000 })
  })

  it('treats empty/invalid/non-positive as unlimited', () => {
    expect(parseConcurrentRate('')).toBeNull()
    expect(parseConcurrentRate('abc')).toBeNull()
    expect(parseConcurrentRate('0')).toBeNull()
    expect(parseConcurrentRate('-1/100')).toBeNull()
    expect(parseConcurrentRate('0.5/1000')).toBeNull()   // 取整后为 0，不能退化成不限速
    expect(parseConcurrentRate(undefined)).toBeNull()
  })
})

describe('RateLimiter', () => {
  it('waits until the oldest request leaves the window', async () => {
    let now = 0
    const sleeps: number[] = []
    const limiter = new RateLimiter({ limit: 2, intervalMs: 100 }, {
      now: () => now,
      sleep: async (ms) => { sleeps.push(ms); now += ms },
    })
    await limiter.acquire()
    await limiter.acquire()
    await limiter.acquire()
    expect(sleeps).toEqual([100])
  })

  it('keeps limiting after an idle gap longer than the window', async () => {
    let now = 0
    const sleeps: number[] = []
    const limiter = new RateLimiter({ limit: 1, intervalMs: 100 }, {
      now: () => now,
      sleep: async (ms) => { sleeps.push(ms); now += ms },
    })
    await limiter.acquire()
    now = 1000                    // 空闲 1s：旧实现不会清掉 0 那一笔，之后永久放行
    await limiter.acquire()
    await limiter.acquire()
    expect(sleeps).toEqual([100])
  })

  it('serializes concurrent acquires (a burst cannot exceed the window)', async () => {
    let now = 0
    const sleeps: number[] = []
    const limiter = new RateLimiter({ limit: 1, intervalMs: 100 }, {
      now: () => now,
      sleep: async (ms) => { sleeps.push(ms); now += ms },
    })
    await Promise.all([
      limiter.acquire(), limiter.acquire(), limiter.acquire(),
    ])
    expect(sleeps).toEqual([100, 100])
  })

  it('does nothing when rule is null', async () => {
    const limiter = new RateLimiter(null)
    await limiter.acquire()
    await limiter.acquire()
  })
})
