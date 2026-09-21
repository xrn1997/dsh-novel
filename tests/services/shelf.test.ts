import { describe, expect, it } from 'vitest'
import { Shelf } from '../../src/services/shelf.js'
import { makeTempDir, trackService } from '../temp-dir.js'

/** 测试自持 Shelf：trackService 登记写侧收尾——add/updateProgress 的 100ms 尾沿防抖写若晚于删目录，
 *  writeJsonAtomic 的 mkdir -p 会把删掉的目录建回来（实测复活）。dir 供「重载往返」用例。 */
async function tmpShelf(): Promise<{ s: Shelf; dir: string }> {
  const dir = await makeTempDir('novel-shelf-')
  const s = trackService(await Shelf.load(dir))
  return { s, dir }
}

describe('Shelf', () => {
  it('add → list → flush → 重载往返', async () => {
    const { s, dir } = await tmpShelf()
    s.add({ sourceId: 's1', bookKey: 'https://a.com/book/1', title: '斗罗大陆', author: '唐家三少' })
    await s.flush()
    const s2 = await Shelf.load(dir)
    expect(s2.list()).toHaveLength(1)
    expect(s2.get('https://a.com/book/1')).toMatchObject({ title: '斗罗大陆', progress: { chapterIndex: 0, offsetRatio: 0 } })
  })
  it('同 bookKey 再加：更新元数据，保留 addedAt 与进度', async () => {
    const { s } = await tmpShelf()
    const b1 = s.add({ sourceId: 's1', bookKey: 'k', title: '旧名' })
    s.updateProgress('k', 5, 0.5)
    await s.flush()
    const b2 = s.add({ sourceId: 's2', bookKey: 'k', title: '新名', lastChapterName: '第6章' })
    expect(b2.addedAt).toBe(b1.addedAt)
    expect(b2.sourceId).toBe('s2')
    expect(b2.progress.chapterIndex).toBe(5)
    expect(b2.lastChapterName).toBe('第6章')
  })
  it('updateProgress 连续调用防抖合并为最后一次落地', async () => {
    const { s, dir } = await tmpShelf()
    s.add({ sourceId: 's1', bookKey: 'k', title: 't' })
    s.updateProgress('k', 1, 0.1)
    s.updateProgress('k', 2, 0.2)
    s.updateProgress('k', 3, 0.9)
    await s.flush()
    expect((await Shelf.load(dir)).get('k')!.progress).toMatchObject({ chapterIndex: 3, offsetRatio: 0.9 })
  })
  it('totalChapters：add 携带 → 落架；再 add 不带 → 保留（合并语义）', async () => {
    const { s } = await tmpShelf()
    s.add({ sourceId: 'u', bookKey: 'k1', title: 'T', totalChapters: 100 })
    expect(s.get('k1')?.totalChapters).toBe(100)
    s.add({ sourceId: 'u', bookKey: 'k1', title: 'T2', author: 'A' })
    expect(s.get('k1')?.totalChapters).toBe(100)   // 不带不抹
    expect(s.get('k1')?.title).toBe('T2')
    s.add({ sourceId: 'u', bookKey: 'k1', title: 'T2', totalChapters: 120 })
    expect(s.get('k1')?.totalChapters).toBe(120)   // 带则更新
  })
  it('四兄弟（author/coverUrl/intro/lastChapterName）：add 不带键 → 保留（dispatch 条件展开同形）', async () => {
    const { s } = await tmpShelf()
    s.add({ sourceId: 'u', bookKey: 'k', title: 'T', author: 'A', coverUrl: 'https://a.com/c.jpg', intro: '简介', lastChapterName: '第9章' })
    // 模拟 shelfPut 条件展开后的输出对象：非字符串字段 → 键缺席（绝不出现 `: undefined` 自有键抹值）
    s.add({ sourceId: 'u', bookKey: 'k', title: 'T', totalChapters: 50 })
    expect(s.get('k')).toMatchObject({
      author: 'A', coverUrl: 'https://a.com/c.jpg', intro: '简介', lastChapterName: '第9章', totalChapters: 50,
    })
    s.add({ sourceId: 'u', bookKey: 'k', title: 'T', author: 'A2' })   // 带键才更新单个
    expect(s.get('k')?.author).toBe('A2')
    expect(s.get('k')?.coverUrl).toBe('https://a.com/c.jpg')
  })
  it('remove', async () => {
    const { s, dir } = await tmpShelf()
    s.add({ sourceId: 's1', bookKey: 'k', title: 't' })
    expect(s.remove('k')).toBe(true)
    expect(s.get('k')).toBeUndefined()
    await s.flush()
    expect((await Shelf.load(dir)).list()).toHaveLength(0)
  })

  // ── 批量删（书架多选删除的服务端写口；N 次 remove 的替身）──────────────────
  describe('removeMany（一趟删多本）', () => {
    it('返回被删条目（按架内序）、未点名的留着，落盘一次', async () => {
      const { s, dir } = await tmpShelf()
      for (const k of ['a', 'b', 'c']) s.add({ sourceId: 'u', bookKey: k, title: k.toUpperCase() })
      const gone = s.removeMany(['a', 'c'])
      expect(gone.map((b) => b.bookKey)).toEqual(['a', 'c'])
      expect(s.list().map((b) => b.bookKey)).toEqual(['b'])
      await s.flush()
      expect((await Shelf.load(dir)).list().map((b) => b.bookKey)).toEqual(['b'])
    })
    it('未知键静默跳过、重复键幂等（不产出重复条目）', async () => {
      const { s } = await tmpShelf()
      s.add({ sourceId: 'u', bookKey: 'a', title: 'A' })
      expect(s.removeMany(['a', 'a', 'nope']).map((b) => b.bookKey)).toEqual(['a'])
      expect(s.removeMany(['nope', 'nope'])).toEqual([])
      expect(s.list()).toHaveLength(0)
    })
  })

  // ── patch 写口：「null/undefined 键 = 保值」语义在 interface 上，
  //    不再是调用方民俗（此前三处复读同一纪律，该用例覆盖的两处已修缺陷）─────────────
  describe('update（patch 写口）', () => {
    it('只带 totalChapters：其余元数据全保（ReaderView 回写场景——此前被迫重发 sourceId+title）', async () => {
      const { s } = await tmpShelf()
      s.add({ sourceId: 's1', bookKey: 'k', title: 'T', author: 'A', coverUrl: 'https://c/x.jpg', intro: '简介' })
      const patched = s.update('k', { totalChapters: 300 })
      expect(patched).toMatchObject({ sourceId: 's1', title: 'T', author: 'A', coverUrl: 'https://c/x.jpg', intro: '简介', totalChapters: 300 })
    })
    it('显式 null/undefined 键同样保值（调用方可以直接透传未知形状，不必先筛键）', async () => {
      const { s } = await tmpShelf()
      s.add({ sourceId: 's1', bookKey: 'k', title: 'T', author: 'A' })
      s.update('k', { author: null, coverUrl: undefined, lastChapterName: '第3章' })
      expect(s.get('k')).toMatchObject({ author: 'A', lastChapterName: '第3章' })
      expect('coverUrl' in s.get('k')!).toBe(false)
    })
    it('带值则更新；不在架 → null（不静默造书）', async () => {
      const { s } = await tmpShelf()
      s.add({ sourceId: 's1', bookKey: 'k', title: 'T', author: 'A' })
      expect(s.update('k', { author: 'B' })?.author).toBe('B')
      expect(s.update('nope', { author: 'B' })).toBeNull()
    })
    it('add 对已有书 = patch 语义：显式 undefined 自有键不再抹值（旧 {...existing,...input} 的雷）', async () => {
      const { s } = await tmpShelf()
      s.add({ sourceId: 's1', bookKey: 'k', title: 'T', author: 'A' })
      // 模拟调用方构造的 input 带 `: undefined` 自有键——旧实现会把 author 抹掉
      s.add({ sourceId: 's1', bookKey: 'k', title: 'T2', author: undefined })
      expect(s.get('k')).toMatchObject({ title: 'T2', author: 'A' })
    })
  })
})
