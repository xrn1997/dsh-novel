import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import type { AddBookInput } from '../../src/services/shelf.js'
import { LocalNotMountedError } from '../../src/services/errors.js'
import { LocalLifecycle } from '../../src/services/local-lifecycle.js'
import type { LocalLifecycleCopies, LocalLifecycleShelf } from '../../src/services/local-lifecycle.js'
import type { LocalImportResult, LocalResource } from '../../src/services/localbooks.js'
import type { ChapterContent, LocalImportWarning, ShelfBook, ShelfMetaField, ShelfMetaPatch } from '../../src/shared/wire.js'
import { LOCAL_SOURCE_ID } from '../../src/shared/wire.js'
import { must } from '../support/fixture.js'

/**
 * 本地书生命周期的直测：**假 adapter** 驱动，失败注入就是让假副本库的 `remove` 拒绝。
 * 这里钉的是「副本 ⇄ 架位」的联合不变量，不是 `LocalBooks` / `Shelf` 各自的实现
 * （那两个的钉子住 `tests/services/localbooks.test.ts` 与 `tests/services/shelf.test.ts`）。
 */

/** 假架位：语义照 `Shelf` 的合同，但不落盘——本用例只看生命周期怎么调它。 */
class FakeShelf implements LocalLifecycleShelf {
  books: ShelfBook[] = []
  readonly added: AddBookInput[] = []
  /** 入架失败注入：导入用例要证「发布成功、入架失败 → 回收本次副本」 */
  failAdd = false

  add(input: AddBookInput): ShelfBook {
    this.added.push(input)
    if (this.failAdd) throw new Error('模拟入架失败')
    const existing = this.get(input.bookKey)
    if (existing !== undefined) {
      this.books = this.books.map((b) => (b.bookKey === input.bookKey ? mergeMeta(b, input) : b))
      return must(this.get(input.bookKey), '假架位里刚更新的条目')
    }
    const book: ShelfBook = {
      sourceId: input.sourceId,
      bookKey: input.bookKey,
      title: input.title,
      addedAt: 1,
      progress: { chapterIndex: 0, offsetRatio: 0, updatedAt: 1 },
    }
    this.books.push(mergeMeta(book, input))
    return must(this.get(input.bookKey), '假架位里刚插入的条目')
  }

  get(bookKey: string): ShelfBook | undefined {
    return this.books.find((b) => b.bookKey === bookKey)
  }

  list(): ShelfBook[] {
    return this.books
  }

  update(bookKey: string, patch: ShelfMetaPatch): ShelfBook | null {
    const book = this.get(bookKey)
    if (book === undefined) return null
    this.books = this.books.map((b) => (b.bookKey === bookKey ? mergeMeta(b, patch) : b))
    return must(this.get(bookKey), '假架位里刚打补丁的条目')
  }

  remove(bookKey: string): boolean {
    return this.removeMany([bookKey]).length === 1
  }

  removeMany(bookKeys: readonly string[]): ShelfBook[] {
    const want = new Set(bookKeys)
    const gone = this.books.filter((b) => want.has(b.bookKey))
    this.books = this.books.filter((b) => !want.has(b.bookKey))
    return gone
  }
}

/** 把一份元数据 patch 的**带值键**并进书架条目（缺席/null = 保值，与 Shelf 同一口径）。 */
function mergeMeta(book: ShelfBook, patch: ShelfMetaPatch): ShelfBook {
  const next: ShelfBook = { ...book }
  for (const key of Object.keys(patch) as ShelfMetaField[]) {
    const value = patch[key]
    if (value === null || value === undefined) continue
    Object.assign(next, { [key]: value })
  }
  return next
}

interface FakeCopiesOptions {
  /** 副本删失败注入：三个删入口都要证「失败即抛、架位保留」 */
  removeFails?: boolean
  /** 每本书的章数读面：给数字 = 读得到，给 Error = 读不到（补数跳过那条） */
  chapterCounts?: Record<string, number | Error>
  importResult?: Partial<LocalImportResult>
}

/** 假副本库：只实现生命周期用到的六个动词，调用面留痕供断言。 */
function makeCopies(opts: FakeCopiesOptions = {}): { copies: LocalLifecycleCopies; removed: string[] } {
  const removed: string[] = []
  const copies: LocalLifecycleCopies = {
    async import(): Promise<LocalImportResult> {
      return {
        bookKey: 'local:11111111-1111-4111-8111-111111111111',
        title: '导入书',
        chapterCount: 2,
        format: 'epub',
        encoding: null,
        warnings: [],
        book: { author: '作者', coverUrl: '/novel-api/local/resource?id=x&resourceId=r0' },
        ...opts.importResult,
      }
    },
    async remove(bookKey: string): Promise<boolean> {
      removed.push(bookKey)
      if (opts.removeFails === true) throw new Error('模拟副本删失败')
      return true
    },
    async chapterCount(bookKey: string): Promise<number> {
      const count = opts.chapterCounts?.[bookKey]
      if (count === undefined) throw new Error('本地 meta 读不到')
      if (count instanceof Error) throw count
      return count
    },
    async getSupplement(_bookKey: string, documentId: string): Promise<ChapterContent> {
      return { kind: 'text', text: `补充文档:${documentId}` }
    },
    async getResource(): Promise<LocalResource> {
      return { mediaType: 'image/png', bytes: 3, stream: Readable.from([Buffer.alloc(3)]) }
    },
    async getImportWarnings(): Promise<LocalImportWarning[]> {
      return [{ code: 'epub-degraded-anchor', resource: null, message: '导入说明' }]
    },
  }
  return { copies, removed }
}

/** 架位上的一条本地书（补数用例的起点）：故意可以缺 totalChapters，模拟旧版本落下的条目。 */
function localRow(bookKey: string, extra: Partial<ShelfBook> = {}): ShelfBook {
  return {
    sourceId: LOCAL_SOURCE_ID, bookKey, title: '本地书', addedAt: 1,
    progress: { chapterIndex: 0, offsetRatio: 0, updatedAt: 1 },
    ...extra,
  }
}

describe('LocalLifecycle · 导入即落架', () => {
  it('副本发布成功后入架：书目字段走既有 SHELF_META，章数由 chapterCount 投影；回执带格式/编码/告警', async () => {
    const shelf = new FakeShelf()
    const { copies } = makeCopies()
    const lifecycle = new LocalLifecycle({ copies, shelf })

    const receipt = await lifecycle.importBook(Buffer.from('x'), '样本.epub')

    expect(shelf.added).toEqual([{
      sourceId: LOCAL_SOURCE_ID,
      bookKey: 'local:11111111-1111-4111-8111-111111111111',
      title: '导入书',
      author: '作者',
      coverUrl: '/novel-api/local/resource?id=x&resourceId=r0',
      totalChapters: 2,
    }])
    expect(receipt).toMatchObject({
      sourceId: LOCAL_SOURCE_ID, bookKey: 'local:11111111-1111-4111-8111-111111111111',
      title: '导入书', author: '作者', totalChapters: 2,
      chapterCount: 2, format: 'epub', encoding: null, warnings: [],
    })
  })

  it('副本发布失败：架位不动、不触发回收（发布失败的清理归副本库，本层没有副本可收）', async () => {
    const shelf = new FakeShelf()
    const fake = makeCopies()
    const failing: LocalLifecycleCopies = {
      ...fake.copies,
      async import(): Promise<LocalImportResult> {
        throw new Error('模拟发布失败')
      },
    }
    const lifecycle = new LocalLifecycle({ copies: failing, shelf })

    await expect(lifecycle.importBook(Buffer.from('x'), '样本.epub')).rejects.toThrow('模拟发布失败')
    expect(shelf.added).toEqual([])
    expect(shelf.list()).toEqual([])
    expect(fake.removed).toEqual([])
  })

  it('入架失败：回收本次副本后原样抛错（不留「长得像书但没人认识」的副本）', async () => {
    const shelf = new FakeShelf()
    shelf.failAdd = true
    const { copies, removed } = makeCopies()
    const lifecycle = new LocalLifecycle({ copies, shelf })

    await expect(lifecycle.importBook(Buffer.from('x'), '样本.epub')).rejects.toThrow('模拟入架失败')
    expect(removed).toEqual(['local:11111111-1111-4111-8111-111111111111'])
    expect(shelf.list()).toEqual([])
  })
})

describe('LocalLifecycle · 三个删入口共用「先副本、失败则架位保留」', () => {
  it('副本删失败：单删 / 批删 / 本地删三个入口各自抛出，架位都还在、可重试', async () => {
    const shelf = new FakeShelf()
    shelf.books = [localRow('local:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), localRow('local:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')]
    const { copies, removed } = makeCopies({ removeFails: true })
    const lifecycle = new LocalLifecycle({ copies, shelf })

    await expect(lifecycle.removeBook('local:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')).rejects.toThrow('模拟副本删失败')
    await expect(lifecycle.removeBooks(['local:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'])).rejects.toThrow('模拟副本删失败')
    await expect(lifecycle.removeLocalBook('local:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')).rejects.toThrow('模拟副本删失败')
    // 三条入口各试过一次；反过来（先移架位再删副本）会留下任何入口都找不到的磁盘孤儿
    expect(removed).toEqual([
      'local:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'local:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      'local:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    ])
    expect(shelf.list().map((b) => b.bookKey)).toEqual([
      'local:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'local:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    ])
  })

  it('副本删成功后移架位；重试一次即删干净（架位与副本同一份判断，不靠第二次猜）', async () => {
    const shelf = new FakeShelf()
    shelf.books = [localRow('local:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')]
    const { copies } = makeCopies({ removeFails: true })
    const lifecycle = new LocalLifecycle({ copies, shelf })
    await expect(lifecycle.removeBook('local:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')).rejects.toThrow()

    const retry = makeCopies()
    const retrying = new LocalLifecycle({ copies: retry.copies, shelf })
    expect(await retrying.removeBook('local:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')).toEqual({ removed: true })
    expect(retry.removed).toEqual(['local:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'])
    expect(shelf.list()).toEqual([])
  })

  it('只对本地键与真在架的键动磁盘：幽灵本地键、在线键都跳过；本地删点名磁盘，不在架也清副本', async () => {
    const shelf = new FakeShelf()
    shelf.books = [localRow('local:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), {
      sourceId: 's1', bookKey: 'https://s.com/book/1', title: '在线书', addedAt: 1,
      progress: { chapterIndex: 0, offsetRatio: 0, updatedAt: 1 },
    }]
    const { copies, removed } = makeCopies()
    const lifecycle = new LocalLifecycle({ copies, shelf })

    // 幽灵本地键（不在架）不该去动磁盘；在线键不是本地书
    expect(await lifecycle.removeBook('local:cccccccc-cccc-4ccc-8ccc-cccccccccccc')).toEqual({ removed: false })
    expect(await lifecycle.removeBook('https://s.com/book/1')).toEqual({ removed: true })
    expect(removed).toEqual([])
    expect(shelf.list().map((b) => b.bookKey)).toEqual(['local:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'])

    // 本地删：即使不在架也清副本（它点名的是磁盘上的书），架位有就一起移走
    const offShelf = 'local:dddddddd-dddd-4ddd-8ddd-dddddddddddd'
    expect(await lifecycle.removeLocalBook(offShelf)).toEqual({ removed: true })
    expect(removed).toEqual([offShelf])
  })
})

describe('LocalLifecycle · 启动补章数', () => {
  it('只补缺 totalChapters 的本地条目：已有值不覆盖，副本读不到跳过，非本地条目不动', async () => {
    const shelf = new FakeShelf()
    shelf.books = [
      localRow('local:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
      localRow('local:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', { totalChapters: 99 }),
      localRow('local:cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
      {
        sourceId: 's1', bookKey: 'https://s.com/book/1', title: '在线书', addedAt: 1,
        progress: { chapterIndex: 0, offsetRatio: 0, updatedAt: 1 },
      },
    ]
    const { copies } = makeCopies({
      chapterCounts: {
        'local:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa': 7,
        'local:cccccccc-cccc-4ccc-8ccc-cccccccccccc': new Error('元数据损坏'),
      },
    })
    const lifecycle = new LocalLifecycle({ copies, shelf })

    await lifecycle.backfillChapterCounts()

    const totalOf = (key: string): number | undefined => shelf.get(key)?.totalChapters
    expect(totalOf('local:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')).toBe(7)
    expect(totalOf('local:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')).toBe(99)
    // 补数不是校验：读不到副本就跳过，不替书架判那份副本还在不在
    expect(totalOf('local:cccccccc-cccc-4ccc-8ccc-cccccccccccc')).toBeUndefined()
    expect(totalOf('https://s.com/book/1')).toBeUndefined()
  })
})

describe('LocalLifecycle · 三个本地读口与缺席语义', () => {
  it('补充文档 / 资源 / 导入告警只委托副本适配器', async () => {
    const lifecycle = new LocalLifecycle({ copies: makeCopies().copies, shelf: new FakeShelf() })
    expect(await lifecycle.getSupplement('local:x', 'd2')).toEqual({ kind: 'text', text: '补充文档:d2' })
    const resource = await lifecycle.getResource('local:x', 'r0')
    expect(resource.mediaType).toBe('image/png')
    expect(resource.bytes).toBe(3)
    expect((await lifecycle.getImportWarnings('local:x')).map((w) => w.code)).toEqual(['epub-degraded-anchor'])
  })

  it('副本库缺席：本地书动词按既有错误语义落 LocalNotMountedError；删在线书照旧', async () => {
    const shelf = new FakeShelf()
    shelf.books = [{
      sourceId: 's1', bookKey: 'https://s.com/book/1', title: '在线书', addedAt: 1,
      progress: { chapterIndex: 0, offsetRatio: 0, updatedAt: 1 },
    }]
    const lifecycle = new LocalLifecycle({ copies: null, shelf })

    await expect(lifecycle.importBook(Buffer.from('x'), 'x.txt')).rejects.toBeInstanceOf(LocalNotMountedError)
    // 三个读口是同步委托（与既有门面签名一致）：缺席在调用点同步抛出，路由层仍按 async 臂兜住
    expect(() => lifecycle.getSupplement('local:x', 'd0')).toThrow(LocalNotMountedError)
    expect(() => lifecycle.getResource('local:x', 'r0')).toThrow(LocalNotMountedError)
    expect(() => lifecycle.getImportWarnings('local:x')).toThrow(LocalNotMountedError)
    await expect(lifecycle.removeLocalBook('local:x')).rejects.toBeInstanceOf(LocalNotMountedError)
    // 没有副本库不影响删在线书（副本连删只是本地键那一段）
    expect(await lifecycle.removeBook('https://s.com/book/1')).toEqual({ removed: true })
  })
})
