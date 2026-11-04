import path from 'node:path'
import type { ShelfBook } from './types.js'
import { SHELF_META, type ShelfMetaField, type ShelfMetaPatch } from '../shared/wire.js'
import { createDebouncedWriter, readJson } from './storage.js'

/** 加书入参（书架只存元数据 + 进度，正文/目录归缓存）：`bookKey`（地址）认架位、源与书名是必填元数据，
 *  字段集派生自 SHELF_META（口径见 `Shelf` 的类注释） */
export type AddBookInput = { bookKey: string; sourceId: string; title: string }
  & Omit<ShelfMetaPatch, 'sourceId' | 'title'>

/** patch 写口入参：**null/undefined 键 = 保值**——
 *  这条语义在 interface 上，调用方不要各自筛键。
 *  wire 上可空字段本就是 null；调用方可以直接透传未知形状。
 *  字段集本身归 SHELF_META，此处只保留名字以贴合 module 语境。 */
export type BookPatch = ShelfMetaPatch

/** patch 应用单点：遍历 SHELF_META——缺席/空值键跳过（保值），带值键覆盖。
 *  数值位（表里标为 number 的键）在写值前归一化成非负整数（floor 后钳到 0 以上）：这是从 wire 的
 *  `pickShelfMeta` 搬来的**落盘归一化**，主人只剩这一处——客户端 body 与 agent 工具都只交形状，
 *  HTTP 输出与落盘值由本处在落地前收口。加书目字段只改表，此处零改动。 */
function applyPatch(book: ShelfBook, patch: BookPatch): void {
  // 值收 `undefined`：patch 的稀疏形态（缺席键）在运行时就是 undefined，类型面只写 `null` 是它在撒谎
  const put = <K extends ShelfMetaField>(k: K, v: BookPatch[K] | undefined): void => {
    if (v === null || v === undefined) return
    book[k] = SHELF_META[k] === 'number' ? Math.max(0, Math.floor(v as number)) as ShelfBook[K] : v
  }
  for (const k of Object.keys(SHELF_META) as ShelfMetaField[]) put(k, patch[k])
}

/**
 * 书架：shelf.json 常驻内存镜像，写盘走防抖合并（进度高频更新只落最后一次）。
 * 两种元数据写口各司其职：add = 不在架才插入（已有书 = patch 语义）；
 * update = 对在架书打补丁（缺席键保值）——merge 规则住在本 module，调用方不再各自筛键。
 * updateProgress 对不在架的书静默不写。
 * 所有写动词只经私有 `edit(recipe)` 排一次写：变更与排写不可分，没有变更的早退在进配方口前完成。
 *
 * **架位凭 `bookKey` 单键认**（词条见 CONTEXT 的「架位」；在线书的值就是那条命中行的 URL 原文，
 * 本地书另带 `local:` 前缀）。`sourceId` 与 `title` 是必填的**元数据字段**、不参与查找：同一个地址
 * 被两家源加进架，落的是同一个架位，`sourceId` 由后写覆盖、`addedAt` 与进度保留（钉子用例
 * 「同 bookKey 再加：更新元数据，保留 addedAt 与进度」）。别把「(源, 地址)」当架位的键抄进注释——
 * 那是**逐源行**的身份，算式在 `client/search-view-model.ts` 的 `rowId`；两件事混起来会让
 * 「一本书挂多源」的待裁问题看起来已解决。
 */
export class Shelf {
  private readonly dir: string
  private books: ShelfBook[]
  private readonly writer: ReturnType<typeof createDebouncedWriter>

  private constructor(dir: string, books: ShelfBook[], writer: ReturnType<typeof createDebouncedWriter>) {
    this.dir = dir
    this.books = books
    this.writer = writer
  }

  /** dir = novel 根；读 shelf.json（不存在 → 空架；存在但解析失败 → readJson 备份后抛
   *  CorruptJsonError，坏字节不许静默折成空架） */
  static async load(dir: string): Promise<Shelf> {
    const books = await readJson<ShelfBook[]>(path.join(dir, 'shelf.json'), [])
    return new Shelf(dir, books, createDebouncedWriter())
  }

  list(): ShelfBook[] {
    return this.books
  }

  get(bookKey: string): ShelfBook | undefined {
    return this.books.find((b) => b.bookKey === bookKey)
  }

  /** 加书；不在架 → 插入；已在架 → patch 语义（null/undefined 键保值——裸 spread 会把显式
   *  `: undefined` 的自有键当成「抹掉」，已有元数据就此丢失，所以合并必须走 applyPatch）。
   *  立即 schedule 防抖落盘。
   *  新书构造也走 applyPatch：可选元数据缺席/null 一律不落键（与 patch 同一纪律） */
  add(input: AddBookInput): ShelfBook {
    const existing = this.get(input.bookKey)
    if (existing !== undefined) {
      return this.edit(() => {
        applyPatch(existing, input)
        return existing
      })
    }
    return this.edit(() => {
      const book: ShelfBook = {
        sourceId: input.sourceId,
        bookKey: input.bookKey,
        title: input.title,
        addedAt: Date.now(),
        progress: { chapterIndex: 0, offsetRatio: 0, updatedAt: Date.now() },
      }
      applyPatch(book, input)
      this.books.push(book)
      return book
    })
  }

  /** patch 写口：对在架书打补丁（null/undefined 键 = 保值）；不在架 → null（不静默造书） */
  update(bookKey: string, patch: BookPatch): ShelfBook | null {
    const book = this.get(bookKey)
    if (book === undefined) return null
    return this.edit(() => {
      applyPatch(book, patch)
      return book
    })
  }

  /** 更新阅读进度并防抖落盘；bookKey 不在架 → 静默不写（进度只跟已加书走） */
  updateProgress(bookKey: string, chapterIndex: number, offsetRatio: number): void {
    const book = this.get(bookKey)
    if (!book) return
    this.edit(() => {
      book.progress = { chapterIndex, offsetRatio, updatedAt: Date.now() }
    })
  }

  /** 移除并防抖落盘；返回是否命中 */
  remove(bookKey: string): boolean {
    return this.removeMany([bookKey]).length === 1
  }

  /** 批量移除（书架多选删除的写口）：一趟扫描裁掉全部命中项，**返回被删条目**（调用方取条数当回执）；
   *  未知键静默跳过、重复键幂等，有命中才 schedule 一次落盘。本地书副本的连删不在这一层——门面在移除
   *  **之前**按「真在架的键」删副本（`services/reading.ts` 的 `removeShelfAndLocal` / `removeBooks`）。 */
  removeMany(bookKeys: readonly string[]): ShelfBook[] {
    const want = new Set(bookKeys)
    if (want.size === 0) return []
    const gone: ShelfBook[] = []
    const kept = this.books.filter((b) => {
      if (!want.has(b.bookKey)) return true
      gone.push(b)
      return false
    })
    if (gone.length === 0) return gone
    return this.edit(() => {
      this.books = kept
      return gone
    })
  }

  /** 写配方口：recipe 改内存 → 排一次防抖写 → 返回 recipe 值。公开写动词一律经它排写，
   *  「改了却没排写」与「没改也排写」都不在调用点手配——无变更的早退由各动词在进配方口前完成。
   *  同步执行是公开写动词保持同步签名的前提（排写只是 schedule，不 await 落地）。 */
  private edit<T>(recipe: () => T): T {
    const value = recipe()
    void this.writer.schedule(this.file, this.books)
    return value
  }

  /** 等待防抖写落地（测试/进程退出前调用） */
  flush(): Promise<void> {
    return this.writer.flush(this.file)
  }

  private get file(): string {
    return path.join(this.dir, 'shelf.json')
  }
}
