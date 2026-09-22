import { hasProgress, LOCAL_SOURCE_ID } from '../shared/wire.js'
import type { ShelfBook, ShelfEntry } from './views/types.js'

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
 *  chapterIndex 是 0 基（存档口径），展示转 1 基「读至第 N 章」。 */
export function shelfCardMeta(b: ShelfBook): { text: string; pct: number | null } {
  const total = typeof b.totalChapters === 'number' ? b.totalChapters : 0
  const isLocal = b.sourceId === LOCAL_SOURCE_ID
  if (!hasProgress(b.progress)) {
    return { text: isLocal ? '本地 TXT' : total > 0 ? `未开始 · ${total} 章` : '未开始', pct: null }
  }
  const pct = total > 0
    ? Math.min(100, Math.round(((b.progress.chapterIndex + b.progress.offsetRatio) / total) * 100))
    : null
  if (isLocal) return { text: pct === null ? '本地 TXT' : `本地 TXT · ${pct}%`, pct }
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
