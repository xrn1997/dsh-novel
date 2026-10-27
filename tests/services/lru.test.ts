import { describe, expect, it } from 'vitest'
import { lruGet, lruSet } from '../../src/services/lru.js'

describe('有界 LRU', () => {
  it('命中提升：读过的键不再是最旧，超限时淘汰另一条', () => {
    const map = new Map<string, number>()
    lruSet(map, 'a', 1, 2)
    lruSet(map, 'b', 2, 2)
    expect(lruGet(map, 'a')).toBe(1)
    lruSet(map, 'c', 3, 2)
    expect([...map.keys()]).toEqual(['a', 'c'])
    expect(map.has('b')).toBe(false)
  })

  it('未命中不改顺序', () => {
    const map = new Map([['a', 1], ['b', 2]])
    expect(lruGet(map, 'x')).toBeUndefined()
    expect([...map.keys()]).toEqual(['a', 'b'])
  })

  it('覆盖已有键回到最新位、不新增条目（被淘汰的是另一条）', () => {
    const map = new Map<string, number>()
    lruSet(map, 'a', 1, 2)
    lruSet(map, 'b', 2, 2)
    lruSet(map, 'a', 9, 2)
    expect([...map.keys()]).toEqual(['b', 'a'])
    expect(map.get('a')).toBe(9)
    lruSet(map, 'c', 3, 2)
    expect(map.has('b')).toBe(false)
  })
})
