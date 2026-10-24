import { describe, expect, it } from 'vitest'
import { createFileStore } from '../../src/engine/stores.js'

const bytes = (s: string) => new TextEncoder().encode(s)

describe('file store', () => {
  it('按插入序淘汰最旧，条数上限生效', () => {
    const s = createFileStore({ entries: 2, bytes: 1024 })
    s.put('a', bytes('1'))
    s.put('b', bytes('2'))
    s.put('c', bytes('3'))
    expect(s.get('a')).toBeUndefined()
    expect(s.get('b')).not.toBeUndefined()
    expect(s.get('c')).not.toBeUndefined()
  })
  it('单文件字节上限：超了抛错且不入表', () => {
    const s = createFileStore({ entries: 2, bytes: 4 })
    expect(() => s.put('big', bytes('12345'))).toThrow()
    expect(s.get('big')).toBeUndefined()
  })
  it('同键覆盖不挤掉另一条：两把键都还在表里', () => {
    const s = createFileStore({ entries: 2, bytes: 1024 })
    s.put('a', bytes('1'))
    s.put('b', bytes('2'))
    s.put('a', bytes('3'))
    expect(s.get('a')).not.toBeUndefined()
    expect(s.get('b')).not.toBeUndefined()
  })
  // 与旧 storeFile 的顺序等价：先判单文件字节上限（超限抛错不入表），再在条数满时淘汰最旧，
  // 最后 set（覆盖已有键也照样先淘汰）。
  // 加这条是因为前一条用例在「先删后插」的写法下同样会绿，钉不住顺序。
  it('满表时覆盖已有键也先按插入序淘汰最旧', () => {
    const s = createFileStore({ entries: 2, bytes: 1024 })
    s.put('a', bytes('1'))
    s.put('b', bytes('2'))
    s.put('b', bytes('3'))
    expect(s.get('a')).toBeUndefined()
    expect(s.get('b')).not.toBeUndefined()
  })
})
