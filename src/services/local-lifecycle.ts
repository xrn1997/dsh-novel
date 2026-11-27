import { LOCAL_SOURCE_ID } from '../shared/wire.js'
import type { BatchRemoved, ChapterContent, LocalImportResponse, LocalImportWarning, RemoveReceipt, ShelfBook, ShelfMetaPatch } from '../shared/wire.js'
import { LocalNotMountedError } from './errors.js'
import { isLocalBookKey } from './localbooks.js'
import type { LocalImportResult, LocalResource } from './localbooks.js'
import type { AddBookInput } from './shelf.js'

/**
 * 本地书生命周期：把「一本本地书 = 磁盘副本 + 一个架位」这条联合不变量收在一处。
 *
 * 为什么需要它：「发布副本」归 `LocalBooks`、「架位」归 `Shelf`，而**两者合起来的次序**——导入即
 * 落架（入架失败回收本次副本）、三个删入口共用的「先副本、失败则架位保留可重试」、启动补章数——
 * 既不属于副本库也不属于书架。此前它只住在门面里，于是每加一个删入口都靠人记得复用门面的私有
 * helper，而检验它的失败注入要 patch 进程全局的文件系统。
 *
 * 形状照 `BookContent` 的先例：动词留在门面、判据搬进部件、两个**适配器可换**（`LocalBooks` /
 * `Shelf` 是生产 adapter，测试用假 adapter 制造任何一步失败）。本模块由门面在构造期持有，
 * HTTP / 工具 / 扩展三面依旧拿不到它。
 *
 * 三条口径：
 * ① 副本与架位之间**没有跨文件事务**（`ADR-0014`）：导入失败回收本次副本；强杀在两步之间会留一份
 *   完整但未入架的副本，这是已接受的窗口，不用自动扫描器掩盖。
 * ② 删书的顺序是**先副本、后架位**：副本删失败就抛出、架位留着可重试；反过来（先移架位再删副本）
 *   会留下没有架位、任何入口都找不到的磁盘孤儿。
 * ③ 启动补数不是校验（`ADR-0058`）：读不到副本的条目跳过，不替书架判那份副本还在不在。
 */

/** 副本库 adapter：动词与 `LocalBooks` 同名同义；测试替身可让 `remove` 拒绝来制造删失败。 */
export interface LocalLifecycleCopies {
  import(bytes: Buffer, name: string): Promise<LocalImportResult>
  remove(bookKey: string): Promise<boolean>
  /** 章数读口：补数只要一个数，不走会造整套展示条目的 `getToc` */
  chapterCount(bookKey: string): Promise<number>
  getSupplement(bookKey: string, documentId: string): Promise<ChapterContent>
  getResource(bookKey: string, resourceId: string): Promise<LocalResource>
  getImportWarnings(bookKey: string): Promise<LocalImportWarning[]>
}

/** 架位 adapter：只声明本生命周期用到的动词（书架的其余语义不在这条缝上）。 */
export interface LocalLifecycleShelf {
  add(input: AddBookInput): ShelfBook
  get(bookKey: string): ShelfBook | undefined
  list(): ShelfBook[]
  update(bookKey: string, patch: ShelfMetaPatch): ShelfBook | null
  remove(bookKey: string): boolean
  removeMany(bookKeys: readonly string[]): ShelfBook[]
}

export interface LocalLifecycleParts {
  /** 副本库缺席（门面直装缝没给 `LocalBooks`）时给 null：本地书动词按既有错误语义落 `LocalNotMountedError` */
  copies: LocalLifecycleCopies | null
  shelf: LocalLifecycleShelf
}

export class LocalLifecycle {
  private readonly parts: LocalLifecycleParts

  constructor(parts: LocalLifecycleParts) {
    this.parts = parts
  }

  /**
   * 导入即落架：副本发布成功后才入架；入架失败则回收**本次**副本再原样抛错。
   *
   * 回收的必要性：发布出去的 EPUB 是一整棵目录、TXT 是两件文件——不回滚就留一份「长得像书但没人
   * 认识」的副本（书架里没有它，用户既看不到也删不掉）。回收只碰本次 uuid 的路径（由副本库负责）。
   */
  async importBook(bytes: Buffer, name: string): Promise<LocalImportResponse> {
    const copies = this.requireCopies()
    const imported = await copies.import(bytes, name)
    let book: ShelfBook
    try {
      // 总章数由导入结果的 `chapterCount` 统一投影（ADR-0058）；作者/封面来自导入结果的 `book`
      book = this.parts.shelf.add({
        sourceId: LOCAL_SOURCE_ID, bookKey: imported.bookKey, title: imported.title,
        ...imported.book, totalChapters: imported.chapterCount,
      })
    } catch (e) {
      await copies.remove(imported.bookKey)
      throw e
    }
    return {
      ...book,
      chapterCount: imported.chapterCount,
      format: imported.format,
      encoding: imported.encoding,
      warnings: imported.warnings,
    }
  }

  /** 删一本：先副本、后架位（口径②）。本地键即使不在架也不去动磁盘——幽灵键不该删别人的文件。 */
  async removeBook(bookKey: string): Promise<RemoveReceipt> {
    return { removed: await this.removeShelfAndCopies(bookKey, false) }
  }

  /** 批量删：与单删同一条顺序；副本删失败即抛出、架位整批保留可重试，未知键静默跳过。 */
  async removeBooks(bookKeys: readonly string[]): Promise<BatchRemoved> {
    await this.removeCopies(bookKeys, false)
    return { removed: this.parts.shelf.removeMany(bookKeys).length }
  }

  /** 删本地书：点名的是磁盘上的本地书，**即使不在架也要清副本**；架位有就一并移走。 */
  async removeLocalBook(bookKey: string): Promise<RemoveReceipt> {
    this.requireCopies()
    return { removed: await this.removeShelfAndCopies(bookKey, true) }
  }

  /**
   * 启动补章数（`ADR-0058`）：只补缺 `totalChapters` 的本地条目，已有值不覆盖。
   * 读并行（meta 读口自带在途去重、无共享写），落账串行——书架的写路径按条排队，不并发落盘。
   * 并发度即缺字段条目数：只在启动跑这一轮，不设闸。
   */
  async backfillChapterCounts(): Promise<void> {
    const copies = this.parts.copies
    if (copies === null) return
    const missing = this.parts.shelf.list()
      .filter((b) => b.sourceId === LOCAL_SOURCE_ID && typeof b.totalChapters !== 'number')
    const pairs = await Promise.all(
      missing.map(async (book) => ({ book, count: await copies.chapterCount(book.bookKey).catch(() => null) })),
    )
    for (const { book, count } of pairs) {
      if (count !== null) this.parts.shelf.update(book.bookKey, { totalChapters: count })
    }
  }

  /** 补充文档（脚注/附录）图文正文：本地 EPUB 专有（「文档」这一层只有它有） */
  getSupplement(bookKey: string, documentId: string): Promise<ChapterContent> {
    return this.requireCopies().getSupplement(bookKey, documentId)
  }

  /** 本地资源读口（流 / MIME / 字节数；磁盘路径不出服务层） */
  getResource(bookKey: string, resourceId: string): Promise<LocalResource> {
    return this.requireCopies().getResource(bookKey, resourceId)
  }

  /** 本地导入告警（阅读器按需重看导入说明）：非 EPUB 恒空数组 */
  getImportWarnings(bookKey: string): Promise<LocalImportWarning[]> {
    return this.requireCopies().getImportWarnings(bookKey)
  }

  private requireCopies(): LocalLifecycleCopies {
    if (this.parts.copies === null) throw new LocalNotMountedError()
    return this.parts.copies
  }

  /**
   * 删副本：只对本地键做；`localEvenIfOffShelf` 只给 `removeLocalBook`（它点名的是磁盘上的书）。
   * 文件删失败即抛出（不吞、不继续移架位）；返回实际删掉的副本数。
   */
  private async removeCopies(keys: Iterable<string>, localEvenIfOffShelf: boolean): Promise<number> {
    const copies = this.parts.copies
    if (copies === null) return 0
    let removed = 0
    for (const key of new Set(keys)) {
      if (!isLocalBookKey(key)) continue
      if (!localEvenIfOffShelf && this.parts.shelf.get(key) === undefined) continue
      if (await copies.remove(key)) removed += 1
    }
    return removed
  }

  /** 单个删入口的合成：副本先走完，再移架位；任一命中即算删过（回执口径与单删/本地删一致）。 */
  private async removeShelfAndCopies(bookKey: string, localEvenIfOffShelf: boolean): Promise<boolean> {
    const localRemoved = await this.removeCopies([bookKey], localEvenIfOffShelf) > 0
    const shelfRemoved = this.parts.shelf.remove(bookKey)
    return shelfRemoved || localRemoved
  }
}
