import path from 'node:path'
import type { ShelfBook } from './types.js'
import { SHELF_META, type ShelfMetaField, type ShelfMetaPatch } from '../shared/wire.js'
import { createDebouncedWriter, readJson } from './storage.js'

/** 加书入参（书架只存元数据 + 进度，正文/目录归缓存）：身份两键必填，元数据字段集派生自 SHELF_META */
export type AddBookInput = { bookKey: string; sourceId: string; title: string }
  & Omit<ShelfMetaPatch, 'sourceId' | 'title'>

/** patch 写口入参：**null/undefined 键 = 保值**——
 *  这条语义在 interface 上，不再是调用方各自筛键的民俗（此前三处复读同一纪律）。
 *  wire 上可空字段本就是 null；调用方可以直接透传未知形状。
 *  字段集本身归 SHELF_META，此处只保留名字以贴合 module 语境。 */
export type BookPatch = ShelfMetaPatch

/** patch 应用单点：遍历 SHELF_META——缺席/空值键跳过（保值），带值键覆盖。
 *  加书目字段只改表，此处零改动。 */
function applyPatch(book: ShelfBook, patch: BookPatch): void {
  const put = <K extends ShelfMetaField>(k: K, v: BookPatch[K]): void => {
    if (v !== null && v !== undefined) book[k] = v
  }
  for (const k of Object.keys(SHELF_META) as ShelfMetaField[]) put(k, patch[k])
}

/**
 * 书架：shelf.json 常驻内存镜像，写盘走防抖合并（进度高频更新只落最后一次）。
 * 两种元数据写口各司其职：add = 不在架才插入（已有书 = patch 语义）；
 * update = 对在架书打补丁（缺席键保值）——merge 规则住在本 module，调用方不再各自筛键。
 * updateProgress 对不在架的书静默不写。
 */
export class Shelf {
  private constructor(
    private readonly dir: string,
    private books: ShelfBook[],
    private readonly writer: ReturnType<typeof createDebouncedWriter>,
  ) {}

  /** dir = novel 根；读 shelf.json（不存在/坏文件按空架起步） */
  static async load(dir: string): Promise<Shelf> {
    const books = await readJson<ShelfBook[]>(path.join(dir, 'shelf.json'), [])
    return new Shelf(dir, books, createDebouncedWriter(100))
  }

  list(): ShelfBook[] {
    return this.books
  }

  get(bookKey: string): ShelfBook | undefined {
    return this.books.find((b) => b.bookKey === bookKey)
  }

  /** 加书；不在架 → 插入；已在架 → patch 语义（null/undefined 键保值——旧 {...existing,...input}
   *  下 `: undefined` 自有键会抹掉已有元数据的雷已拆）。立即 schedule 防抖落盘。
   *  新书构造也走 applyPatch：可选元数据缺席/null 一律不落键（与 patch 同一纪律） */
  add(input: AddBookInput): ShelfBook {
    const existing = this.get(input.bookKey)
    if (existing !== undefined) {
      applyPatch(existing, input)
      this.writer.schedule(this.file, this.books)
      return existing
    }
    const book: ShelfBook = {
      sourceId: input.sourceId,
      bookKey: input.bookKey,
      title: input.title,
      addedAt: Date.now(),
      progress: { chapterIndex: 0, offsetRatio: 0, updatedAt: Date.now() },
    }
    applyPatch(book, input)
    this.books.push(book)
    this.writer.schedule(this.file, this.books)
    return book
  }

  /** patch 写口：对在架书打补丁（null/undefined 键 = 保值）；不在架 → null（不静默造书） */
  update(bookKey: string, patch: BookPatch): ShelfBook | null {
    const book = this.get(bookKey)
    if (book === undefined) return null
    applyPatch(book, patch)
    this.writer.schedule(this.file, this.books)
    return book
  }

  /** 更新阅读进度并防抖落盘；bookKey 不在架 → 静默不写（进度只跟已加书走） */
  updateProgress(bookKey: string, chapterIndex: number, offsetRatio: number): void {
    const book = this.get(bookKey)
    if (!book) return
    book.progress = { chapterIndex, offsetRatio, updatedAt: Date.now() }
    this.writer.schedule(this.file, this.books)
  }

  /** 移除并防抖落盘；返回是否命中 */
  remove(bookKey: string): boolean {
    return this.removeMany([bookKey]).length === 1
  }

  /** 批量移除（书架多选删除的写口）：一趟扫描裁掉全部命中项，**返回被删条目**（调用方据此
   *  处理连带副作用——本地书副本连删只该对本就在架的键做，与单删的 `removed && isLocal` 同一条）；
   *  未知键静默跳过、重复键幂等，只 schedule 一次落盘。 */
  removeMany(bookKeys: readonly string[]): ShelfBook[] {
    const want = new Set(bookKeys)
    if (want.size === 0) return []
    const gone: ShelfBook[] = []
    this.books = this.books.filter((b) => {
      if (!want.has(b.bookKey)) return true
      gone.push(b)
      return false
    })
    if (gone.length === 0) return gone
    this.writer.schedule(this.file, this.books)
    return gone
  }

  /** 等待防抖写落地（测试/进程退出前调用） */
  flush(): Promise<void> {
    return this.writer.flush(this.file)
  }

  private get file(): string {
    return path.join(this.dir, 'shelf.json')
  }
}
