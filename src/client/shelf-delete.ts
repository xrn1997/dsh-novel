import { LOCAL_SOURCE_ID } from '../shared/wire.js'
import type { ShelfBook } from './views/types.js'

/**
 * 删除书籍的纯逻辑（书架卡片 ✕ 流程与多选「删除所选」流程）。
 * 本地书删除的服务端真相：shelf DELETE 对 local: 前缀连带删 dataDir/local/ 下**这份导入的全部落盘物**
 * （TXT 是原文 + 元数据；EPUB 是原文 + 派生的文档/资源整棵目录）——导入时落盘的拷贝，插件不持有
 * 用户原始文件的路径，原始文件永远不动。文案必须把这个区分说清：不点名「副本 + 原始文件不受影响」，
 * 用户会误以为删除动了自己硬盘上的原件（或反过来以为副本还在）。
 */

/** 删除确认文案：confirm=确认行（含书名）；warn=本地书的副本连删说明（在线书为 null）。
 *  文案刻意不说「txt」：本地书现在有 TXT 与 EPUB 两种，落盘形态不同，用户要认的是
 *  「数据目录里的那份副本」这件事本身（服务端删的是整个 uuid 副本，两种格式一致）。 */
export function deleteBookCopy(title: string, isLocal: boolean): { confirm: string; warn: string | null } {
  return {
    confirm: `删除《${title}》？`,
    warn: isLocal
      ? '本地书：将同时删除 DSH 数据目录中的副本与元数据（默认 ~/.dsh/novel/local/，随 dataDir 配置）；你自己的原始文件不受影响'
      : null,
  }
}

/** 批量删除确认文案（书架多选态的「删除所选」）：confirm 点名本数；warn 只在本批含本地书时出现——
 *  单本那份文案点名的是**这一本**，本批要如实报「其中 N 本为本地书」，否则用户以为只是在删在线书，
 *  而服务端连副本一起删（与单本同一条 invariant）。 */
export function deleteBooksCopy(
  books: ReadonlyArray<Pick<ShelfBook, 'title' | 'sourceId'>>,
): { confirm: string; warn: string | null } {
  const locals = books.filter((b) => b.sourceId === LOCAL_SOURCE_ID).length
  return {
    confirm: `删除选中的 ${books.length} 本书？`,
    warn: locals === 0
      ? null
      : `其中 ${locals} 本为本地书：将同时删除 DSH 数据目录中的副本与元数据（默认 ~/.dsh/novel/local/，随 dataDir 配置）；你自己的原始文件不受影响`,
  }
}
