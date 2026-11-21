import type { SourcePublic } from './views/types.js'

/**
 * 书源待办（source inbox）的纯派生：全库源清单 →「需要你处理的事」两集合 + 两集合 → 待办卡。
 * 反常状态（坏源/未验证）置顶成任务卡，健康源退居列表；卡上是**成员名单 + 处置动作**，读数不印在
 * 卡上（归列表头状态带）——卡可以被忽略，读数不能跟着消失。逐源排查归列表行内「试跑」。
 * 用户现场（哪张卡被忽略）不在此处，住 `source-inbox-ui.ts`。
 */

export interface SourceInbox {
  /** 坏源（status=broken）：处置 = 批量重验（探针重测）；逐源排查在列表行内 */
  broken: SourcePublic[]
  /** 未验证（status=unverified）：处置 = 一键验证；新导入的源自动汇入此处 */
  unverified: SourcePublic[]
}

/** 纯派生：只看 `status`、不看 `enabled`——停用只摘掉「参与聚合搜索」，坏源/未验证的异常还在。 */
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

// 口径：待办是**提示**，不是工单分派。关掉一张卡 = 这批成员我不再需要被提醒；成员集一变提示就
// 该回来——忽略按**成员签名**记账，而不是「这个源永久静音」。读数不住在卡上。

export type InboxKind = 'broken' | 'unverified'

/** 一张待办卡 = 一种反常状态的非空成员集 + 该成员集的签名 */
export interface InboxCard { kind: InboxKind; sources: SourcePublic[]; signature: string }

/** 忽略记录：kind → 点「忽略」那一刻该卡的成员签名；无键 = 未忽略 */
export type InboxMuted = Partial<Record<InboxKind, string>>

/** 成员签名：id 排序后拼接——勾选顺序与服务端回包序都不该让同一批源长出两个签名；空集 = 空串。 */
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
