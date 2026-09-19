import { signaturesOf } from './source-inbox.js'
import { createStore } from './store.js'
import type { InboxKind, InboxMuted, SourceInbox } from './source-inbox.js'

/**
 * 待办区的**用户现场**：被忽略的卡（按成员签名记账，语义与判据在 `source-inbox.ts`）。
 *
 * 模块级 store（`sourceListUi` / `transient` 同款）：试跑下钻返回、重开视图都不丢——
 * 忽略是「我这几分钟的处理姿态」，卸载即清零会让人反复关同一张卡。
 *
 * **不落盘**（对照：`prefsStore` 走 localStorage）：待办是提示，用户明确不要求
 * 「关掉就再也不出来」，而跨重启的静音要落到源实体上（wire 字段 + 服务端读写 + 迁移），
 * 那是另一档改动。真要持久，这个 store 是唯一住址，改一处即可。
 */

export const inboxUi = createStore<{ muted: InboxMuted }>({ muted: {} })

export function muteInboxCard(kind: InboxKind, signature: string): void {
  inboxUi.set({ muted: { ...inboxUi.get().muted, [kind]: signature } })
}

/** 「重新显示」：一次清掉全部忽略，不做逐张恢复（能关就能全开，不留黑洞） */
export function unmuteAllInboxCards(): void { inboxUi.set({ muted: {} }) }

/** 只保留「仍能遮住当前这张卡」的记录。
 *  遮不住的记录留着是幽灵：它指向的成员集已经不在了，却会在**同一批 id 重新出现**时
 *  （删光坏源再导入同一份书源）把提示再次吞掉——那才是用户没做过的"已看过"。
 *  每次源清单变化时调用（SettingsSection 取数后），无变化则不写 store（避免无谓重渲染）。 */
export function pruneInboxMuted(inbox: SourceInbox): void {
  const sigs = signaturesOf(inbox)
  const cur = inboxUi.get().muted
  const kept: InboxMuted = {}
  for (const kind of ['broken', 'unverified'] as const) {
    if (cur[kind] !== undefined && cur[kind] === sigs[kind]) kept[kind] = sigs[kind]
  }
  if (Object.keys(kept).length !== Object.keys(cur).length) inboxUi.set({ muted: kept })
}

/** 测试专用：复位现场（模块级 store 跨用例残留，先例 resetSourceListUi / resetTransient） */
export function resetSourceInboxUi(): void { inboxUi.set({ muted: {} }) }
