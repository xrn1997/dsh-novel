import type { SearchGroup } from '../shared/wire.js'

/** 工具面搜索回执的两条派生：未答话源逐家点名、超上限时的如实说明。二者都是纯投影，
 *  不碰归并与分区（那归 `shared/round-summary.ts` / `shared/merge-by-book.ts`）。 */
export interface FailedSourceRow {
  sourceId: string
  sourceName: string
  code: string
  message: string
}

export function failedSources(groups: readonly SearchGroup[]): FailedSourceRow[] {
  return groups.flatMap((g) => g.error === undefined ? [] : [{
    sourceId: g.sourceId,
    sourceName: g.sourceName,
    code: g.error.code,
    message: g.error.message,
  }])
}

export function truncationNotice(total: number, returned: number): string | undefined {
  return total > returned ? `本轮共 ${total} 本，只返回前 ${returned} 本` : undefined
}
