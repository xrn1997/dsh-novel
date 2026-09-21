import { describe, expect, it } from 'vitest'
import { deleteBookCopy, deleteBooksCopy } from '../../src/client/shelf-delete.js'

describe('deleteBookCopy（删除书籍确认文案）', () => {
  it('在线书：确认行含书名，无文件警告', () => {
    const r = deleteBookCopy('斗破苍穹', false)
    expect(r.confirm).toBe('删除《斗破苍穹》？')
    expect(r.warn).toBeNull()
  })
  it('本地书：点名删的是 DSH 数据目录副本，并明示原始文件不受影响', () => {
    const r = deleteBookCopy('我的书', true)
    expect(r.confirm).toBe('删除《我的书》？')
    // 服务端真相：删 dataDir/local/ 下的 uuid 副本（导入时落盘），插件不知道原始文件路径。
    // 文案不点名这个区分，用户会误以为动了自己硬盘上的原件。
    expect(r.warn).toContain('副本')
    expect(r.warn).toContain('原始文件不受影响')
  })
})

describe('deleteBooksCopy（批量删除确认文案）', () => {
  const online = { title: '斗破苍穹', sourceId: 's1' }
  const local = { title: '我的书', sourceId: '__local__' }

  it('纯在线书：点名本数，无文件警告（正文走与单本相同的「进度一并删除」那行）', () => {
    const r = deleteBooksCopy([online, { title: '剑来', sourceId: 's2' }])
    expect(r.confirm).toBe('删除选中的 2 本书？')
    expect(r.warn).toBeNull()
  })
  it('含本地书：点名本数与副本连删说明，仍明示原始文件不受影响', () => {
    const r = deleteBooksCopy([online, local])
    expect(r.confirm).toBe('删除选中的 2 本书？')
    expect(r.warn).toContain('1 本为本地书')
    expect(r.warn).toContain('副本')
    expect(r.warn).toContain('原始文件不受影响')
  })
  it('清一色本地书：本数如实（0 本在线书不许冒充「都在线」）', () => {
    const r = deleteBooksCopy([local, { title: '我的书二', sourceId: '__local__' }])
    expect(r.confirm).toBe('删除选中的 2 本书？')
    expect(r.warn).toContain('2 本为本地书')
  })
})
