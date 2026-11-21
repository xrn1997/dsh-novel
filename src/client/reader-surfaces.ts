/** 阅读器角落浮层的**在场与互斥**判据（纯函数、零 React、零 DOM）。这些面同住右上角、互为遮挡，
 * 所以判据是「至多一角在场」而不是「各钮各记各的开合」；各 opener 不再各抄一份「先关别人」。
 * 分工：位置、时序与返回栈归 `reader-session.ts`；带遮罩的模态归 `views/dialog.tsx`。本文件只答
 * 「哪一角在场」「换角时那一面怎么退场」与「模态同场时 Esc 归谁」。 */

/** 角落浮层的五个面。`supplement` = 注释面板（脚注/附录），它带一份载荷，载荷本身住阅读场景（`client/reader-scene.ts`） */
export type ReaderSurface = 'prefs' | 'toc' | 'export' | 'supplement' | 'importNotes'

/** 换面时注释面板的退场：`keep` 不动；`hide` 只收面板、**不消费返回项**（开目录不是对阅读位置表态）；
 *  `consume` 走「关闭」语义（内链打开的会回引用处）——Esc 与关闭钮同一条路。 */
export type SupplementExit = 'keep' | 'hide' | 'consume'

export interface SurfaceChange { surface: ReaderSurface | null; supplement: SupplementExit }

/** 这三颗钮自己就是开关；导出面板与注释面板只有「开」这条路，各自的收起长在面板里。 */
const TOGGLES: readonly ReaderSurface[] = ['prefs', 'toc', 'importNotes']

/** 点某一角：至多一角在场；同一角的第二次点击是收场。 */
export function openSurface(current: ReaderSurface | null, opening: ReaderSurface): SurfaceChange {
  const next = current === opening && TOGGLES.includes(opening) ? null : opening
  return { surface: next, supplement: exitOf(current, next) }
}

/** Esc 归浮层时：全收，注释面板按「关闭」那条语义退场（两条入口不许分叉）。模态在场时调用方根本不装这条监听。 */
export function closeAll(current: ReaderSurface | null): SurfaceChange {
  return { surface: null, supplement: exitOf(current, null) }
}

/** 面板自己退场而不表态阅读位置：注释面板里点到主序列就是这条——返回项归这次跟随，面板不许再消费一次。 */
export const dismissSurface = (): SurfaceChange => ({ surface: null, supplement: 'hide' })

/** Esc 的归属：同场时模态先吃；只有浮层在场时是浮层的；都不在场就没人管。 */
export type EscOwner = 'modal' | 'surface' | 'none'

/** 同场时模态先吃 Esc；浮层的监听在模态在场时不安装。两条 document 监听同场时一次 Esc 会既关模态又
 *  走 `closeAll`——注释面板那条还会消费返回项，把正文跳回引用处并落一笔进度。 */
export function escOwner(surface: ReaderSurface | null, modalOpen: boolean): EscOwner {
  if (modalOpen) return 'modal'
  return surface === null ? 'none' : 'surface'
}

function exitOf(from: ReaderSurface | null, to: ReaderSurface | null): SupplementExit {
  if (from !== 'supplement' || to === 'supplement') return 'keep'
  return to === null ? 'consume' : 'hide'
}

/** 遮罩只在「点外面关掉它」那两面出现：目录抽屉自成一层，注释面板与导入说明由自己的钮负责收场。 */
export function maskFor(surface: ReaderSurface | null): boolean {
  return surface === 'prefs' || surface === 'export'
}
