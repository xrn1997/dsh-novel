import { hasProgress, LOCAL_SOURCE_ID } from '../shared/wire.js'
import type { LocalImportResponse, ShelfBook, ShelfEntry } from './views/types.js'

/** 书架视图派生（纯函数、零 React）：筛选与卡片元信息的唯一口径。
 *
 *  pct 是书架卡片百分比的**唯一算式**（client.md 已知开口「百分比算式已收敛一处、剩两处」
 *  原记三处各算一份，shelf 分量已收敛到此）。口径：
 *   - reading = 有实质阅读进度（判据单点 `wire.hasProgress`，与阅读器的存档恢复同源）；
 *     unread = 其补集；
 *   - local = sourceId === LOCAL_SOURCE_ID——**正交维度**：本地书是要做文件级操作
 *     （连删磁盘 txt）的对象，与读没读过无关；
 *   - 未读书 pct 归 null：简约版呈现口径「未读不出进度条」，卡片元信息只留文字。 */
export type ShelfFilterKey = 'all' | 'reading' | 'unread' | 'local'

export const SHELF_FILTERS: Array<{ key: ShelfFilterKey; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'reading', label: '在读' },
  { key: 'unread', label: '未读' },
  { key: 'local', label: '本地' },
]

/** 筛选：泛型保住入参的具体条目类型（ShelfEntry 的来源投影不许被这里擦成 ShelfBook——
 *  「筛选后的书还要拿去渲染来源 chip」是常态用法，擦掉就得在视图里再断言一次）。 */
export function filterShelfBooks<T extends ShelfBook>(books: readonly T[], key: ShelfFilterKey): T[] {
  if (key === 'all') return [...books]
  if (key === 'local') return books.filter((b) => b.sourceId === LOCAL_SOURCE_ID)
  return books.filter((b) => (key === 'reading' ? hasProgress(b.progress) : !hasProgress(b.progress)))
}

/** 卡片元信息：text = 卡片下的灰色一行；pct = 进度条百分比（null = 不渲染进度条）。
 *  chapterIndex 是 0 基（存档口径），展示转 1 基「读至第 N 章」。
 *
 *  本地书只说「本地」，**不点名格式**：本地书现在有 TXT 与 EPUB 两种，而格式刻意不是书目字段
 *  （`SHELF_META` 里没有它——加进去就等于多一个能被 PUT 随意 patch、与磁盘真相脱节的字段），
 *  所以这里没有可从「唯一真相」推出来的格式可写；真实格式由服务端 `LocalImportResponse.format`
 *  交代（导入回执与阅读器的导入说明），卡片不猜（按书名猜格式是另一种造假）。 */
export function shelfCardMeta(b: ShelfBook): { text: string; pct: number | null } {
  const total = typeof b.totalChapters === 'number' ? b.totalChapters : 0
  const isLocal = b.sourceId === LOCAL_SOURCE_ID
  if (!hasProgress(b.progress)) {
    return { text: isLocal ? '本地' : total > 0 ? `未开始 · ${total} 章` : '未开始', pct: null }
  }
  const pct = total > 0
    ? Math.min(100, Math.round(((b.progress.chapterIndex + b.progress.offsetRatio) / total) * 100))
    : null
  if (isLocal) return { text: pct === null ? '本地' : `本地 · ${pct}%`, pct }
  if (pct === null) return { text: `读至第 ${b.progress.chapterIndex + 1} 章`, pct }
  return { text: `${b.progress.chapterIndex + 1}/${total} 章 · ${pct}%`, pct }
}

/** 来源 chip 的展示口径（卡片封面左下那枚）：
 *   - 本地书 → null：本地身份已由封面「本地」与角标承担，同一事实不出第三个说法；
 *   - 源名可用 → 直出源名；
 *   - 服务端 join 不到（源已被删/从未存在，`sourceName === null`）→ 灰字「来源已删除」，
 *     `deleted` 供样式降调（宁如实说来源没了，也不拿空串或旧名糊过去）。 */
export function shelfSourceTag(b: ShelfEntry): { text: string; deleted: boolean } | null {
  if (b.sourceId === LOCAL_SOURCE_ID) return null
  const name = b.sourceName
  return typeof name === 'string' && name !== ''
    ? { text: name, deleted: false }
    : { text: '来源已删除', deleted: true }
}

/** 导入回执的格式标签（**从服务端回执的 `format` 字段来**，不按书名 / 后缀猜）：TXT 与 EPUB 是
 *  本仓本地书的两支，章数口径一致（EPUB 按阅读单元计章）。卡片文案那边刻意不说格式（格式不是
 *  书目字段，见 `shelfCardMeta`）——真实格式只有这条回执与阅读器的导入说明说得出，所以它认的是
 *  **服务端那次导入的元数据**，不是书架上这本书当下的样子。 */
export function localImportLabel(b: LocalImportResponse): string {
  return `${b.format === 'epub' ? 'EPUB' : 'TXT'} · ${b.chapterCount} 章`
}

/** 切走半场（瞬态成功通知）的一句补充：有导入说明时点名条数，用户回来点进这本书就能重看
 *  （导入回执只在书架页在场时摆得出来，切走后至少别让「有几条说明」这件事只剩回忆）。 */
export function localImportNote(b: LocalImportResponse): string {
  return b.warnings.length === 0 ? '' : `，有 ${b.warnings.length} 条导入说明`
}
