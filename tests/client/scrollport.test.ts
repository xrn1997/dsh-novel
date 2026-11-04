import { describe, expect, it } from 'vitest'
import { findScrollport, isScrollport } from '../../src/client/scrollport.js'

describe('isScrollport（「谁在滚」的判据）', () => {
  it('overflow-y 可滚 + 内容确实超出 → 是', () => {
    expect(isScrollport('auto', 2000, 500)).toBe(true)
    expect(isScrollport('scroll', 2000, 500)).toBe(true)
    expect(isScrollport('overlay', 2000, 500)).toBe(true)
  })
  it('内容没超出 → 不是（宿主内容撑高布局下容器自身不滚：可视高度等于内容高度）', () => {
    expect(isScrollport('auto', 97541, 97541)).toBe(false)
  })
  it('overflow 不可滚（visible/hidden/clip）→ 不是（定高层 overflow:hidden 会被误当滚动条）', () => {
    for (const overflowY of ['visible', 'hidden', 'clip']) {
      expect(isScrollport(overflowY, 2000, 500)).toBe(false)
    }
  })
})

describe('findScrollport（向上找真正在滚的容器）', () => {
  interface Fake { overflowY: string; scrollHeight: number; clientHeight: number; parentElement: Fake | null }
  const node = (o: Partial<Fake>): Fake => ({ overflowY: 'visible', scrollHeight: 0, clientHeight: 0, parentElement: null, ...o })
  const styleOf = (el: unknown): { overflowY: string } => ({ overflowY: (el as Fake).overflowY })
  const find = (n: Fake | null): unknown => findScrollport(n as unknown as Element | null, styleOf)

  it('自己就是滚动容器 → 返回自己（宿主是定高布局时正文层自带滚动条）', () => {
    const self = node({ overflowY: 'auto', scrollHeight: 2000, clientHeight: 500 })
    expect(find(self)).toBe(self)
  })
  it('自己不是 → 向上落到宿主常驻的滚动层（按宿主各层的职责搭出这条链）', () => {
    const host = node({ overflowY: 'auto', scrollHeight: 97579, clientHeight: 558 })          // 宿主常驻会话层：唯一在滚的那一个
    const viewArea = node({ parentElement: host })                                            // 视图区：内容撑高，无 overflow
    const root = node({ overflowY: 'hidden', parentElement: viewArea })                       // .novel-root
    const main = node({ overflowY: 'auto', scrollHeight: 97579, clientHeight: 97579, parentElement: root })   // 内容撑高 → 不滚
    const body = node({ overflowY: 'auto', scrollHeight: 97541, clientHeight: 97541, parentElement: main })   // 正文层 → 不滚
    expect(find(body)).toBe(host)
  })
  it('一路到文档根都没有滚动容器 → null（文档自身在滚）', () => {
    expect(find(node({ parentElement: node({}) }))).toBeNull()
  })
  it('起点 null → null', () => {
    expect(find(null)).toBeNull()
  })
})
