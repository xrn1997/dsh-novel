import type { SourcePublic } from './views/types.js'

/**
 * 书源待办（source inbox）的纯派生：全库源清单 →「需要你处理的事」两集合 + 两集合 → 待办卡。
 * IA 口径（2026 调度台改版 + 2026-09 状态化，用户拍板）：待办收件箱是书源管理 tab 的首屏——
 * 反常状态（坏源/未验证）置顶成任务卡，健康源退居列表；卡上是**成员名单 + 处置动作**
 * （批量重验/一键验证），**读数不印在卡上**（归列表头状态带，见 `source-list-view.ts` 的 `stats`）——
 * 卡是可以被忽略的提示，提示能关，读数不能跟着一起消失。逐源排查归列表行内「试跑」。
 *
 * 抽纯函数的理由与 source-list-view.ts 同：派生逻辑可单测，视图只做接线；
 * 用户现场（哪张卡被忽略）不在此处，住 `source-inbox-ui.ts`。
 * 口径详见 `docs/design/client.md`「书源管理 tab 的 IA」。
 */

export interface SourceInbox {
  /** 坏源（status=broken）：处置 = 批量重验（探针重测）；逐源排查在列表行内 */
  broken: SourcePublic[]
  /** 未验证（status=unverified）：处置 = 一键验证；新导入的源自动汇入此处 */
  unverified: SourcePublic[]
}

/** 纯派生：零副作用。只看 `status`、不看 `enabled`——停用只摘掉「参与聚合搜索」这一件事，
 *  坏源/未验证的异常还在（2026-09 裁定：停用 ≠ 免验）。 */
export function sourceInbox(sources: SourcePublic[]): SourceInbox {
  return {
    broken: sources.filter((s) => s.status === 'broken'),
    unverified: sources.filter((s) => s.status === 'unverified'),
  }
}

/** 待办处置动作的作用对象 id 集（点击时快照，交由任务提交口）——集合已由 sourceInbox 裁过，这里只取 id */
export function inboxIds(inbox: SourceInbox, kind: 'broken' | 'unverified'): string[] {
  return inbox[kind].map((s) => s.id)
}

// ── 待办卡与「忽略」──────────────────────────────────────────
// 口径（2026-09 用户裁定）：待办是**提示**，不是工单分派。关掉一张卡 = 这批成员我不再需要
// 被提醒；但成员集一变（新坏源 / 新导入未验证）提示就该回来——所以忽略按**成员签名**记账，
// 而不是按「这个源永久静音」。读数也不住在卡上（卡标题不印计数），一律归列表头状态带。

export type InboxKind = 'broken' | 'unverified'

/** 一张待办卡 = 一种反常状态的非空成员集 + 该成员集的签名 */
export interface InboxCard { kind: InboxKind; sources: SourcePublic[]; signature: string }

/** 忽略记录：kind → 点「忽略」那一刻该卡的成员签名；无键 = 未忽略 */
export type InboxMuted = Partial<Record<InboxKind, string>>

/** 成员签名：id 排序后拼接。排序是必要的——勾选顺序、服务端回包序都不该让同一批源长出
 *  两个签名（否则卡会无故从"已忽略"里复现）。空集 = 空串而非 undefined：判据要能区分
 *  「这一类现在没有成员」。 */
export function signatureOf(ids: string[]): string { return [...ids].sort().join('|') }

/** 两类待办的当前签名（含空集）——忽略记录的存活判据 */
export function signaturesOf(inbox: SourceInbox): Record<InboxKind, string> {
  return { broken: signatureOf(inboxIds(inbox, 'broken')), unverified: signatureOf(inboxIds(inbox, 'unverified')) }
}

/** 派生成卡：成员为空的 kind 不出卡（没有处置对象的提示是噪声） */
export function inboxCards(inbox: SourceInbox): InboxCard[] {
  return (['broken', 'unverified'] as const)
    .map((kind) => ({ kind, sources: inbox[kind], signature: signatureOf(inboxIds(inbox, kind)) }))
    .filter((c) => c.sources.length > 0)
}

/** 按忽略记录切分可见卡。签名不命中即复现——这正是「提示」而非「永久静音」的落点。 */
export function visibleInboxCards(cards: InboxCard[], muted: InboxMuted): { shown: InboxCard[]; hidden: InboxCard[] } {
  const isMuted = (c: InboxCard): boolean => muted[c.kind] === c.signature
  return { shown: cards.filter((c) => !isMuted(c)), hidden: cards.filter((c) => isMuted(c)) }
}
