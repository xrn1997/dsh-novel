import { hasProgress } from '../shared/reading-position.js'
import { LOCAL_SOURCE_ID } from '../shared/wire.js'
import { plural, zhTranslate } from './copy/index.js'
import type { CopyKey, Translate } from './copy/index.js'
import type { LocalImportResponse, ShelfBook, ShelfEntry } from './views/types.js'

/** 书架视图派生（纯函数、不持 React 状态）：筛选与卡片元信息的唯一口径。pct 是书架卡片百分比的
 * **唯一算式**，与 `jobPct` / `searchPct` 三分家——分母语义不同（已读章数 / 任务条目 / 参搜源数），
 * 折叠成一个必有一面谎报。reading 判据单点 `hasProgress`；local 是正交维度；未读书 pct 归 null。 */
export type ShelfFilterKey = 'all' | 'reading' | 'unread' | 'local'

export const SHELF_FILTERS: Array<{ key: ShelfFilterKey; labelKey: CopyKey }> = [
  { key: 'all', labelKey: 'shelf.filter.all' },
  { key: 'reading', labelKey: 'shelf.filter.reading' },
  { key: 'unread', labelKey: 'shelf.filter.unread' },
  { key: 'local', labelKey: 'shelf.filter.local' },
]

/** 筛选：泛型保住入参的具体条目类型——「筛选后的书还要拿去渲染来源 chip」是常态用法。 */
export function filterShelfBooks<T extends ShelfBook>(books: readonly T[], key: ShelfFilterKey): T[] {
  if (key === 'all') return [...books]
  if (key === 'local') return books.filter((b) => b.sourceId === LOCAL_SOURCE_ID)
  return books.filter((b) => (key === 'reading' ? hasProgress(b.progress) : !hasProgress(b.progress)))
}

/** 卡片元信息：text = 卡片下的灰色一行；pct = 进度条百分比（null = 不渲染进度条）；chapterIndex 是 0 基，
 *  展示转 1 基。本地书只说「本地」、**不点名格式**：格式不是书目字段（`SHELF_META` 里没有），
 *  真实格式由服务端导入回执交代，卡片不猜。 */
export function shelfCardMeta(b: ShelfBook, t: Translate = zhTranslate): { text: string; pct: number | null } {
  const total = typeof b.totalChapters === 'number' ? b.totalChapters : 0
  const isLocal = b.sourceId === LOCAL_SOURCE_ID
  if (!hasProgress(b.progress)) {
    const text = isLocal
      ? t('shelf.local')
      : total > 0
        ? plural(t, total, 'shelf.card.unreadTotal.one', 'shelf.card.unreadTotal.other', { n: total })
        : t('shelf.card.unread')
    return { text, pct: null }
  }
  const pct = total > 0
    ? Math.min(100, Math.round(((b.progress.chapterIndex + b.progress.offsetRatio) / total) * 100))
    : null
  if (isLocal) return { text: pct === null ? t('shelf.local') : t('shelf.card.localPct', { pct }), pct }
  if (pct === null) {
    const chapter = b.progress.chapterIndex + 1
    return { text: plural(t, chapter, 'shelf.card.reading.one', 'shelf.card.reading.other', { n: chapter }), pct }
  }
  return {
    text: plural(t, total, 'shelf.card.progress.one', 'shelf.card.progress.other', {
      i: b.progress.chapterIndex + 1, total, pct, n: total,
    }),
    pct,
  }
}

/** 来源 chip 的展示口径：本地书 → null（归同槽位的「本地」）；源名可用 → 直出源名；
 *  服务端 join 不到 → 灰字「来源已删除」并给 `deleted` 供样式降调。 */
export function shelfSourceTag(b: ShelfEntry, t: Translate = zhTranslate): { text: string; deleted: boolean } | null {
  if (b.sourceId === LOCAL_SOURCE_ID) return null
  const name = b.sourceName
  return typeof name === 'string' && name !== ''
    ? { text: name, deleted: false }
    : { text: t('shelf.sourceDeleted'), deleted: true }
}

/** 导入回执的格式标签（**从服务端回执的 `format` 来**，不按书名/后缀猜）：它认的是服务端那次导入的元数据。 */
export function localImportLabel(b: LocalImportResponse, t: Translate = zhTranslate): string {
  const format = b.format === 'epub' ? 'EPUB' : 'TXT'
  return plural(t, b.chapterCount, 'shelf.importFormat.one', 'shelf.importFormat.other', { format, n: b.chapterCount })
}

/** 切走半场的一句补充：有导入说明时点名条数，用户回来点进这本书就能重看。 */
export function localImportNote(b: LocalImportResponse, t: Translate = zhTranslate): string {
  const n = b.warnings.length
  return n === 0
    ? ''
    : plural(t, n, 'shelf.notice.importNote.one', 'shelf.notice.importNote.other', { n })
}
